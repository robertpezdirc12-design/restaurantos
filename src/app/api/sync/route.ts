import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'
import type { OrderItemStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, assertResourceLocation } from '@/lib/api'
import { nid, itemStatusToDB, ORDER_ACTIVE_DB, jstr } from '@/lib/map'
import { createOrderCore, OrderError } from '@/lib/ops'

/**
 * Issue #1 — offline/local-first sync (replay offline operacij).
 *
 * R7 (revizija §6): prej je potekalo `applyOp()` → `DeviceSyncOperation.upsert()` kot
 * DVE ločeni fazi brez transakcijske vezi. Crash med njima (ali vzporedna dvojna
 * zahteva z istim clientOperationId) je pomenil, da retry ni našel zapisa o operaciji
 * in je operacijo aplikiral ponovno → dvojne postavke.
 *
 * Popravek — glej applyOperation():
 *  - order.addItems + kitchen.status: claim (CAS 'processing') + aplikacija + zaključek
 *    ('applied') v ENI interaktivni transakciji — crash kjer koli → rollback, retry je čist.
 *  - order.create: createOrderCore odpira lastno $transaction (ops.ts) — Prisma ne
 *    podpira gnezdenja, zato velja vzorec "upsert-first-then-apply": CAS prevzem
 *    ('processing') → idempotentna aplikacija (Order.idempotencyKey unique + P2002
 *    twin-return v createOrderCore) → CAS zaključek ('applied'). Crash med aplikacijo
 *    in zaključkom → retry ponovi aplikacijo, jedro vrne OBSTOJEČE naročilo (replay) —
 *    brez dvojnikov in brez izgube.
 * Idempotentnost se ohranja: unique (deviceId, clientOperationId) + replay pot.
 */

interface SyncOp { clientOperationId?: string; kind?: string; payload?: Record<string, unknown> }

/** Klient za Prisma operacije — koren (db) ali transakcijski (tx) */
type SyncClient = Prisma.TransactionClient

type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'replayed'; orderId: string | null }
  | { kind: 'busy' }

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.slice(0, 64) : 'unknown'
  const ops: SyncOp[] = Array.isArray(body?.ops) ? body.ops.slice(0, 200) : []
  if (ops.length === 0) return fail('ops seznam je obvezen.')
  const kinds = new Set(ops.map((o) => String(o.kind || '')))
  if (kinds.has('order.create') || kinds.has('order.addItems')) {
    const gate = await requirePermission(req, 'orders.create'); if (isResponse(gate)) return gate
  }
  if (kinds.has('kitchen.status')) {
    const gate = await requirePermission(req, 'kitchen.update'); if (isResponse(gate)) return gate
  }
  if ([...kinds].some((k) => k && !['order.create', 'order.addItems', 'kitchen.status'].includes(k))) return fail('Neznana vrsta operacije v sync seriji.')

  const results: { clientOperationId: string; ok: boolean; error?: string; orderId?: string; replayed?: boolean }[] = []
  for (const op of ops) {
    const clientOperationId = typeof op.clientOperationId === 'string' ? op.clientOperationId.slice(0, 64) : ''
    if (!clientOperationId || !op.kind) { results.push({ clientOperationId: clientOperationId || '?', ok: false, error: 'Manjka clientOperationId ali kind.' }); continue }
    try {
      results.push(await applyOperation(user, deviceId, clientOperationId, op))
    } catch (e) {
      const message = e instanceof OrderError ? e.message : 'Operacija ni uspela.'
      try {
        const deviceLocation = user.loc || ''
        // R7: fail prek CAS ('processing' → 'failed'); če zapisa (več) ni — claim je bil
        // v rollbackani transakciji — ustvari 'failed' (obnašanje nespremenjeno).
        const marked = await db.deviceSyncOperation.updateMany({
          // (updateMany WhereInput ne podpira compound-unique filtra — plošččna enakost je ekvivalentna)
          where: { deviceId, clientOperationId, status: 'processing' },
          data: { status: 'failed', lastError: message, clientRetryCount: { increment: 1 } },
        })
        if (marked.count === 0) {
          await db.deviceSyncOperation.upsert({
            where: { deviceId_clientOperationId: { deviceId, clientOperationId } },
            create: { id: nid(), deviceId, locationId: deviceLocation, clientOperationId, operationType: op.kind || 'unknown', payload: jstr(op.payload ?? {}), status: 'failed', lastError: message, clientRetryCount: 1, employeeId: user.sub },
            update: { status: 'failed', lastError: message, clientRetryCount: { increment: 1 } },
          })
        }
      } catch {}
      results.push({ clientOperationId, ok: false, error: message })
    }
  }
  return ok({ results })
}

/**
 * R7: ENA operacija = claim (CAS 'processing') + aplikacija + zaključek ('applied').
 * - addItems / kitchen.status: vse tri faze v ENI interaktivni transakciji (atomarno).
 * - order.create: claim in zaključek sta ločena (createOrderCore ima lastno transakcijo,
 *   gnezdenje ni možno); aplikacija je idempotentna prek Order.idempotencyKey, zato je
 *   replay po crashu varen (jedro vrne obstoječe naročilo — brez dvojnikov).
 */
async function applyOperation(
  user: { sub: string; name: string; loc: string | null },
  deviceId: string,
  clientOperationId: string,
  op: SyncOp
): Promise<{ clientOperationId: string; ok: boolean; error?: string; orderId?: string; replayed?: boolean }> {
  if (!user.loc) throw new OrderError('Uporabnik nima dodeljene lokacije — operacija zavrnjena.', 403)
  const actor = { sub: user.sub, loc: user.loc }

  // hitra replay pot (obnašanje nespremenjeno): zapisa 'applied' → brez aplikacije
  const seen = await db.deviceSyncOperation.findUnique({ where: { deviceId_clientOperationId: { deviceId, clientOperationId } } })
  if (seen && seen.status === 'applied') {
    return { clientOperationId, ok: true, replayed: true, orderId: seen.orderId || undefined }
  }

  if (op.kind === 'order.create') {
    // "upsert-first-then-apply" — glej opombo modula (gnezdenje transakcij ni možno)
    const claim = await claimOperation(db, deviceId, clientOperationId, op, actor)
    if (claim.kind === 'replayed') {
      return { clientOperationId, ok: true, replayed: true, orderId: claim.orderId || undefined }
    }
    // 'claimed' ALI 'busy' → aplikacija sledi vseeno: jedro je idempotentno
    // (P2002 na idempotencyKey → vrni twin), crashed claim pa se varno ponovi.
    const orderId = await applyOp(db, actor, op)
    await finalizeOperation(db, deviceId, clientOperationId, orderId, actor)
    return { clientOperationId, ok: true, orderId: orderId || undefined }
  }

  // order.addItems + kitchen.status — claim + aplikacija + zaključek ATOMARNO
  return db.$transaction(async (tx) => {
    const claim = await claimOperation(tx, deviceId, clientOperationId, op, actor)
    if (claim.kind === 'replayed') {
      return { clientOperationId, ok: true, replayed: true, orderId: claim.orderId || undefined }
    }
    if (claim.kind === 'busy') {
      // obrambna pot: 'processing' zapis pri teh vrstah ne more preživeti crasha
      // (claim je v isti transakciji) — pomeni vzporednega zmagovalca v letu
      return { clientOperationId, ok: false, error: 'Operacija je še v obdelavi (nezaključen prejšnji poskus) — poskusite znova.' }
    }
    const orderId = await applyOp(tx, actor, op)
    await finalizeOperation(tx, deviceId, clientOperationId, orderId, actor)
    return { clientOperationId, ok: true, orderId: orderId || undefined }
  })
}

/**
 * R7: CAS prevzem operacije. Ustvari/zamenjaj zapis v status 'processing' SAMO, če:
 *  - zapisa še ni (create — unique (deviceId, clientOperationId) prepreči dvojne zapise;
 *    P2002 → vzporedni prevzem je zmagal) ALI
 *  - zapis je 'failed' (retry neuspele operacije je dovoljen — CAS updateMany).
 * 'applied' → replay; 'processing' → busy (vzpel si vzporedni poskus ali crashed zahtevek).
 */
async function claimOperation(
  client: SyncClient,
  deviceId: string,
  clientOperationId: string,
  op: SyncOp,
  user: { sub: string; loc: string }
): Promise<ClaimResult> {
  const where = { deviceId_clientOperationId: { deviceId, clientOperationId } } as const
  const existing = await client.deviceSyncOperation.findUnique({ where })
  if (existing?.status === 'applied') return { kind: 'replayed', orderId: existing.orderId }
  if (!existing) {
    try {
      await client.deviceSyncOperation.create({
        data: {
          id: nid(), deviceId, locationId: user.loc, clientOperationId,
          operationType: op.kind || 'unknown', payload: jstr(op.payload ?? {}),
          status: 'processing', employeeId: user.sub,
        },
      })
      return { kind: 'claimed' }
    } catch (e) {
      if ((e as { code?: string })?.code !== 'P2002') throw e
      // vzporedna zahteva je pravkar prevzela operacijo — preveri, ali je že dokončana
      const winner = await client.deviceSyncOperation.findUnique({ where })
      return winner?.status === 'applied' ? { kind: 'replayed', orderId: winner.orderId } : { kind: 'busy' }
    }
  }
  if (existing.status === 'failed') {
    const r = await client.deviceSyncOperation.updateMany({
      where: { ...where, status: 'failed' },
      data: { status: 'processing', receivedAt: new Date() },
    })
    return r.count === 1 ? { kind: 'claimed' } : { kind: 'busy' }
  }
  return { kind: 'busy' }
}

/** R7: zaključek operacije — CAS 'processing' → 'applied' (nikoli ne prevrišči 'failed'/'applied') */
async function finalizeOperation(
  client: SyncClient,
  deviceId: string,
  clientOperationId: string,
  orderId: string | null,
  user: { sub: string; loc: string }
): Promise<void> {
  await client.deviceSyncOperation.updateMany({
    // (updateMany WhereInput ne podpira compound-unique filtra — plošččna enakost je ekvivalentna)
    where: { deviceId, clientOperationId, status: 'processing' },
    data: { status: 'applied', orderId: orderId || null, ack: jstr({ ok: true }), employeeId: user.sub, processedAt: new Date() },
  })
}

/**
 * Aplikacija operacije. `client` je transakcijski klient (tx) za addItems/kitchen.status
 * ali koren (db) za order.create — createOrderCore odpira lastno $transaction (ops.ts),
 * zato order.create NE SME teči znotraj interaktivne transakcije (Prisma: brez gnezdenja).
 */
async function applyOp(client: SyncClient, user: { sub: string; loc: string | null }, op: SyncOp): Promise<string | null> {
  const payload = (op.payload || {}) as Record<string, unknown>
  if (!user.loc) throw new OrderError('Uporabnik nima dodeljene lokacije — operacija zavrnjena.', 403)
  switch (op.kind) {
    case 'order.create': {
      const { order } = await createOrderCore({
        employeeId: user.sub, locationId: user.loc,
        items: payload.items as { menuItemId: string; qty?: number; note?: string }[],
        tableId: (payload.tableId as string) || null, type: (payload.type as string) || 'DINE_IN',
        note: payload.note as string | undefined, guests: payload.guests as number | undefined,
        clientOperationId: (op.clientOperationId as string) || null,
      })
      return order.id
    }
    case 'order.addItems': {
      const orderId = String(payload.orderId || '')
      const addItems = (payload.addItems || payload.items) as { menuItemId: string; qty?: number; note?: string }[] | undefined
      if (!orderId || !Array.isArray(addItems) || addItems.length === 0) throw new OrderError('order.addItems: manjka orderId ali addItems.')
      const order = await client.order.findUnique({ where: { id: orderId } })
      if (!order) throw new OrderError('Naročilo ne obstaja več.', 404)
      const addGuard = assertResourceLocation(user as unknown as Parameters<typeof assertResourceLocation>[0], order.locationId)
      if (addGuard) throw new OrderError('Naročilo ne pripada vaši lokaciji.', 403)
      if (!ORDER_ACTIVE_DB.includes(order.status)) throw new OrderError('Naročilo ni več odprto.', 409)
      const menuItems = await client.menuItem.findMany({ where: { id: { in: addItems.map((i) => i.menuItemId) }, isAvailable: true, Category: { Menu: { locationId: order.locationId } } } })
      const rows: {
        id: string; orderId: string; menuItemId: string; quantity: number; price: number; vatRate: number; vatAmount: number;
        menuItemName: string; status: OrderItemStatus; notes: string
      }[] = addItems.map((i) => {
        const mi = menuItems.find((m) => m.id === i.menuItemId)
        if (!mi) throw new OrderError('Artikel ne obstaja ali ni na voljo na lokaciji naročila.')
        const qty = Math.max(1, Math.round(Number(i.qty) || 1))
        const price = Number(mi.price); const vatRate = Number(mi.vatRate) || 22
        return { id: nid(), orderId, menuItemId: mi.id, quantity: qty, price, vatRate, vatAmount: (price * qty * vatRate) / 100, menuItemName: mi.name, status: itemStatusToDB('PENDING') as OrderItemStatus, notes: i.note || '' }
      })
      await client.orderItem.createMany({ data: rows }); await recalcTotals(client, orderId); return orderId
    }
    case 'kitchen.status': {
      const itemId = String(payload.itemId || ''); const status = String(payload.status || '')
      if (!itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(status)) throw new OrderError('kitchen.status: manjka itemId ali veljaven status.')
      const item = await client.orderItem.findUnique({ where: { id: itemId }, include: { Order: { select: { locationId: true } } } })
      if (!item) throw new OrderError('Postavka ne obstaja.', 404)
      const ksGuard = assertResourceLocation(user as unknown as Parameters<typeof assertResourceLocation>[0], item.Order?.locationId)
      if (ksGuard) throw new OrderError('Postavka ne pripada vaši lokaciji.', 403)
      await client.orderItem.update({ where: { id: itemId }, data: { status: itemStatusToDB(status) as OrderItemStatus } })
      const remaining = await client.orderItem.count({ where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } } })
      if (remaining === 0) await client.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
      else await client.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
      return item.orderId
    }
    default: throw new OrderError(`Neznana vrsta operacije: ${op.kind}`)
  }
}

async function recalcTotals(client: SyncClient, orderId: string) {
  const items = await client.orderItem.findMany({ where: { orderId, voided: false } })
  let subtotal = 0; let tax = 0
  for (const it of items) { subtotal += Number(it.price) * (it.quantity || 0); tax += Number(it.vatAmount) }
  await client.order.update({ where: { id: orderId }, data: { subtotal: Math.round(subtotal * 100) / 100, tax: Math.round(tax * 100) / 100, total: Math.round((subtotal + tax) * 100) / 100 } })
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const deviceId = req.nextUrl.searchParams.get('deviceId') || 'unknown'
  const operations = await db.deviceSyncOperation.findMany({ where: { deviceId, ...locationScope(user) }, orderBy: { receivedAt: 'desc' }, take: 50 })
  return ok({ operations: operations.map((o) => ({
    clientOperationId: o.clientOperationId, kind: o.operationType, status: o.status, orderId: o.orderId,
    lastError: o.lastError, retryCount: o.clientRetryCount, createdAt: o.receivedAt,
  })) })
}
