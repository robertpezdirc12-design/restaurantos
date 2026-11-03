import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { Prisma } from '@prisma/client'
import {
  WASTE_REASONS,
  WASTE_TX_TYPE,
  isWasteReason,
  validateWasteInput,
  wasteReasonLabel,
  wasteStats,
  wasteTotalCents,
} from '@/lib/waste'
import { writeAudit } from '@/lib/audit-chain'
import { allocateBatchesTx, writeBatchAllocations, ExplicitBatchError } from '@/lib/batch-allocate'

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Odpad hrane — seznam + statistika (GitLab issue #1, triage ④).
 * Filtri: ?days=30 (1-365), ?reason=pokvarjeno. Zaposleni vidi samo svojo lokacijo.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30))
  const reasonRaw = String(url.searchParams.get('reason') || '')

  const where: Prisma.WasteRecordWhereInput = {
    createdAt: { gte: new Date(Date.now() - days * 86400_000) },
    ...(reasonRaw && isWasteReason(reasonRaw) ? { reason: reasonRaw } : {}),
    ...(await locationScope(user)),
  }

  const rows = await db.wasteRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: { InventoryItem: { select: { name: true, unit: true } } },
  })

  // v1.242.0: serijske alokacije odpada (ledger StockBatchAllocation → lot)
  const txIds = rows.map((r) => r.stockTransactionId).filter((t): t is string => !!t)
  const allocRows = txIds.length
    ? await db.stockBatchAllocation.findMany({
        where: { stockTransactionId: { in: txIds } },
        select: { stockTransactionId: true, batchId: true, quantity: true, InventoryBatch: { select: { lotNumber: true } } },
      })
    : []
  const allocsByTx = new Map<string, { batchId: string; lotNumber: string; quantity: number }[]>()
  for (const a of allocRows) {
    const list = allocsByTx.get(a.stockTransactionId) || []
    list.push({ batchId: a.batchId, lotNumber: a.InventoryBatch?.lotNumber ?? '', quantity: num(a.quantity) })
    allocsByTx.set(a.stockTransactionId, list)
  }

  const records = rows.map((r) => ({
    id: r.id,
    inventoryItemId: r.inventoryItemId,
    itemName: r.InventoryItem?.name ?? '(izbrisan artikel)',
    unit: r.unit || r.InventoryItem?.unit || '',
    quantity: num(r.quantity),
    reason: r.reason,
    reasonLabel: wasteReasonLabel(r.reason),
    note: r.note,
    costPerUnit: num(r.costPerUnit),
    totalCost: num(r.totalCost),
    reversedAt: r.reversedAt,
    recordedByUserId: r.recordedByUserId,
    createdAt: r.createdAt,
    // v1.242.0: iz katerega lot-a (lot-ov) je blago šlo v odpad
    allocations: r.stockTransactionId ? allocsByTx.get(r.stockTransactionId) ?? [] : [],
  }))

  return ok({
    records,
    stats: wasteStats(rows.map((r) => ({ reason: r.reason, totalCost: num(r.totalCost) }))),
    days,
  })
}

/**
 * Evidentiranje odpada — odšteje zalogo, zapiše StockTransaction type='WASTE'
 * in WasteRecord (idempotentno prek locationId+idempotencyKey).
 * Odpad nad razpoložljivo zalogo je zavrnjen (409) — razlike popravlja inventura.
 *
 * v1.242.0 (§16 I C — založni val): SERIJE. Odpad zdaj razporedi odjem po serijah
 * (InventoryBatch) — FEFO samodejno (isti vir kot prodajna pot) ali izrecno iz
 * ene serije (batchId: odpoklic/karantena potrebujejo VEDENJE, iz katerega lot-a
 * je blago šlo v odpad). Alokacije se zapišejo v StockBatchAllocation (ledger
 * serij ≡ agregat); brez serij ali ob izpadu CAS-a se količina izrecno zapiše
 * kot brez-serijska (vrzel VIDNA, ne skrita — vzorec Issue #52).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajoči ali neveljaven JSON.', 400)

  const itemId = String(body?.itemId || '')
  const idempotencyKey = String(body?.idempotencyKey || '').trim().slice(0, 100)
  // v1.242.0: izrecna serija (lot) za odpad — neobvezna; prazno = FEFO samodejno
  const batchId = typeof body?.batchId === 'string' ? body.batchId.trim().slice(0, 64) : ''
  if (!itemId) return fail('Artikel je obvezen.', 400)
  if (!idempotencyKey) return fail('Manjkajoči idempotencyKey (varnost pred dvojnim vnosom).', 400)

  const v = validateWasteInput({ quantity: body?.quantity, reason: body?.reason, note: body?.note })
  if (!v.ok) return fail(v.error, 400)

  const item = await db.inventoryItem.findUnique({ where: { id: itemId } })
  if (!item) return fail('Artikel zaloge ne obstaja.', 404)
  // Issue #4 §1 vzorec: odpad tujega artikla (druga lokacija) je zavrnjen (fail-closed)
  const locRes = await guardResource(user, item.locationId)
  if (locRes) return locRes

  // AUDIT-FIX v1.82.1: umaknjen findFirst() fallback — v nasprotju s §10 politiko
  // (api.ts requireUserLocation: "prepovedan je findFirst() fallback"). Centralna
  // vloga brez lokacije + legacy artikel brez lokacije bi sicer knjižila odpad
  // (in odštevala zalogo!) na NAKLJUČNO prvo lokacijo v DB — potencialno cross-org.
  // Lokacija artikla je varovana prek guardResource zgoraj; user.loc je eksplicitna
  // lokacija prijave centralne vloge. Brez obeh → fail-closed 400.
  const locationId = item.locationId || user.loc
  if (!locationId) {
    return fail(
      'Lokacija ni določljiva — artikel nima dodeljene lokacije, uporabnik pa ni prijavljen z lokacijo. Najprej dodelite lokacijo artiklu v Zalogah.',
      400,
    )
  }

  // Idempotentni replay: (locationId, idempotencyKey) že obstaja → vrni obstoječi zapis
  const existing = await db.wasteRecord.findUnique({
    where: { locationId_idempotencyKey: { locationId, idempotencyKey } },
  })
  if (existing) {
    return ok(
      { record: { id: existing.id, quantity: num(existing.quantity), totalCost: num(existing.totalCost), reversedAt: existing.reversedAt }, replayed: true },
      200,
    )
  }

  const qty = v.value.quantity
  const unitCost = num(item.costPerUnit)
  const totalCents = wasteTotalCents(qty, unitCost)
  const available = r3(num(item.quantity)) // r3: SQLite REAL ne sme pridet v sporočilo (npr. 22.001000000000005)
  if (qty > available) {
    return fail(
      `Na zalogi je samo ${available} ${item.unit || ''} — odpad ${qty} ni mogoče knjižiti. Razliko najprej popravi v Zalogah (Popravek zaloge).`,
      409,
    )
  }

  let created: { recordId: string; stockTransactionId: string; newQty: number; allocations: { batchId: string; lotNumber: string; quantity: number }[]; untracked: number } | null = null
  try {
    created = await db.$transaction(async (tx) => {
      // Race-safe pogojni odštevek: uspe samo, če je zaloga še vedno dovolj velika
      const upd = await tx.inventoryItem.updateMany({
        where: { id: item.id, quantity: { gte: qty } },
        data: { quantity: { decrement: qty } },
      })
      if (upd.count === 0) return null
      const fresh = await tx.inventoryItem.findUnique({ where: { id: item.id }, select: { quantity: true } })
      // r3 normalizacija: SQLite REAL decrementi nabirajo float drift (22.001000000000005) — shranimo čisto vrednost
      const rawQty = num(fresh?.quantity)
      const newQty = r3(rawQty)
      if (newQty !== rawQty) {
        await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: newQty } })
      }
      const prevQty = r3(newQty + qty) // konsistenten par (previous → new) kljub vzporednim odpadom

      // ── v1.242.0: SERIJSKA ALOKACIJA odjema (znotraj ISTE transakcije) ──
      // FEFO čez uporabne serije ali izrecna serija (celotna količina iz nje).
      // Alokacijske vrstice pišemo ŠELE PO StockTransaction (FK vrstni red).
      const allocRes = await allocateBatchesTx(tx, item.id, qty, batchId ? { onlyBatchId: batchId } : undefined)

      const noteParts: string[] = []
      if (v.value.note) noteParts.push(v.value.note)
      if (allocRes.allocations.length > 0) {
        noteParts.push(`Serije: ${r3(allocRes.allocations.reduce((s, a) => s + a.alloc, 0))} ${item.unit} na ${allocRes.allocations.length} lot-ih`)
      }
      if (allocRes.untracked > 0) {
        noteParts.push(`Brez serije: ${allocRes.untracked} ${item.unit} (ni aktivnih serij ali so se izčrpale) — odjem samo iz agregata`)
      }

      const stockTx = await tx.stockTransaction.create({
        data: {
          id: nid(),
          inventoryItemId: item.id,
          type: WASTE_TX_TYPE,
          quantity: -qty,
          previousQty: prevQty,
          newQty,
          costPerUnit: unitCost,
          totalCost: totalCents / 100,
          reason: wasteReasonLabel(v.value.reason),
          note: noteParts.join(' · '),
          employeeId: user.sub,
          employeeName: user.name,
        },
      })

      // FK-varni vrstni red: StockTransaction obstaja → zdaj so alokacije veljavne
      await writeBatchAllocations(tx, stockTx.id, item.id, allocRes.allocations)

      // lotNumbers za odgovor (zrcalni lookup — znotraj TX so sveži)
      const allocDetails: { batchId: string; lotNumber: string; quantity: number }[] = []
      for (const a of allocRes.allocations) {
        const b = await tx.inventoryBatch.findUnique({ where: { id: a.batchId }, select: { lotNumber: true } })
        allocDetails.push({ batchId: a.batchId, lotNumber: b?.lotNumber ?? '', quantity: a.alloc })
      }

      const rec = await tx.wasteRecord.create({
        data: {
          id: nid(),
          locationId,
          inventoryItemId: item.id,
          quantity: qty,
          unit: item.unit,
          reason: v.value.reason,
          note: v.value.note,
          costPerUnit: unitCost,
          totalCost: totalCents / 100,
          stockTransactionId: stockTx.id,
          idempotencyKey,
          recordedByUserId: user.sub,
        },
      })
      return { recordId: rec.id, stockTransactionId: stockTx.id, newQty, allocations: allocDetails, untracked: allocRes.untracked }
    })
  } catch (e: unknown) {
    // v1.242.0: izrecna serija — jasne napake iz alokacijskega motorja (404/409),
    // transakcija se je že povsem povrnila (rollback agregata + serij)
    if (e instanceof ExplicitBatchError) {
      return fail(e.message, e.status as 404 | 409)
    }
    const msg = e instanceof Error ? e.message : String(e)
    // Sočasni replay z istim (locationId, idempotencyKey) → unique ujame → obravnavaj kot replay
    if (msg.includes('Unique constraint') || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
      const replay = await db.wasteRecord.findUnique({
        where: { locationId_idempotencyKey: { locationId, idempotencyKey } },
      })
      if (replay) {
        return ok(
          { record: { id: replay.id, quantity: num(replay.quantity), totalCost: num(replay.totalCost), reversedAt: replay.reversedAt }, replayed: true },
          200,
        )
      }
    }
    return fail(`Evidentiranje odpada ni uspelo: ${msg}`, 500)
  }
  if (!created) return fail('Zaloga je bila sočasno spremenjena — količina ni več na voljo, osveži in poskusi znova.', 409)

  await writeAudit(db, { userId: user.sub, action: 'WASTE_RECORD', entityType: 'WasteRecord', entityId: created.recordId, details: jstr({ item: item.name, itemId: item.id, quantity: qty, unit: item.unit, reason: v.value.reason, note: v.value.note, totalCost: totalCents / 100, newQty: created.newQty, batchAllocations: created.allocations, untracked: created.untracked }) })
  await publishEvent('StockChanged', {
    entityType: 'InventoryItem',
    entityId: item.id,
    // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
    payload: { name: item.name, variance: -qty, newQty: created.newQty, by: user.name, cause: 'waste', locationId: item.locationId },
    // Issue #38: verifikovana lokacija artikla zaloge
    locationId: item.locationId,
  }).catch(() => undefined)

  return ok(
    {
      record: { id: created.recordId, stockTransactionId: created.stockTransactionId, quantity: qty, totalCost: totalCents / 100, newQty: created.newQty, allocations: created.allocations, untracked: created.untracked },
      replayed: false,
    },
    201,
  )
}
