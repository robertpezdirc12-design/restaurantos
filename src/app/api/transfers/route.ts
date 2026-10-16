import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource, assertOrgScope, isCrossTenantLocations } from '@/lib/tenant'
import { nid, num, jstr, r2 } from '@/lib/map'
import { Prisma } from '@prisma/client'
import { isBlockedStatus } from '@/lib/lot-governance'
import { writeAudit } from '@/lib/audit-chain'
import { transferTablesReady } from '@/lib/transfer-schema'
import { TRF_STATUSES, TransferError, transferDto, transferNumberFor, validateTransferInput, r3, type TrfRow } from '@/lib/stock-transfer'

/**
 * Issue #8 (P2, v1.116.0) — medlokacijski prenosi zalog: seznam + osnutek.
 *
 * POST /api/transfers
 *   { fromLocationId, toLocationId, note?, idempotencyKey?,
 *     lines: [{ inventoryItemId, requestedQty, batchId?, lotNumber?, expiryDate?, unitCost? }] }
 *   → DRAFT prenos (BREZ gibanja zaloge — odpremitev je ločena izrecna operacija).
 *   Varovanja: guardResource(from) + assertOrgScope(to) + isCrossTenantLocations
 *   (isti org dovoljen, tuja org → 403) + from≠to (400). Idempotentni replay
 *   (fromLocationId+idempotencyKey) je ZA varovalkami (GRN #54 lekcija — ključ
 *   NI poverilnica). TX: ANCHOR na vrstici IZVORNE lokacije (vzorec #63) +
 *   sveža preverba artiklov znotraj TX + snapshot imen/enot (zgodovina če
 *   artikel pobrišejo) + audit TRANSFER_CREATED.
 *
 * GET /api/transfers?status|fromLocationId|toLocationId|itemId|q|dateFrom|dateTo
 *   → prenosi, katerih IZVOR ALI CILJ je v uporabnikovem obsegu (locationScope
 *   + OR from/to). Filtri: status (TRF_STATUSES, sicer 400), itemId
 *   (items.some), q (transferNumber vsebuje / ime postavke vsebuje — plain
 *   contains, kot loyalty/giftcards iskanje), datumsko okno createdAt.
 *   take ≤ 100 (privzeto 50), orderBy createdAt desc.
 *
 * Pravica: inventory.manage. PRE-DDL: transferTablesReady → 503 (graceful).
 */

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }

  const body = await req.json().catch(() => null)
  const v = validateTransferInput(body)
  if ('error' in v) return fail(v.error, 400)
  const input = v.value

  // ── obe lokaciji obstajata (404 pred varovalkami — prijazne napake) ──
  const [fromLoc, toLoc] = await Promise.all([
    db.location.findUnique({ where: { id: input.fromLocationId }, select: { id: true, name: true } }),
    db.location.findUnique({ where: { id: input.toLocationId }, select: { id: true, name: true } }),
  ])
  if (!fromLoc) return fail('Izvorna lokacija ne obstaja.', 404)
  if (!toLoc) return fail('Ciljna lokacija ne obstaja.', 404)

  // ── obseg: izvor = guardResource (lokacijski sloj + org meja centralnim),
  //    cilj = assertOrgScope (prejemnik mora biti v isti org drevesni veji) ──
  const guarded = await guardResource(user, input.fromLocationId)
  if (guarded) return guarded
  const orgGuard = await assertOrgScope(user, input.toLocationId)
  if (orgGuard) return orgGuard
  // cross-tenant: OBÉ lokaciji zanesljivo povezani v drevo IN različni org → 403
  if (await isCrossTenantLocations(input.fromLocationId, input.toLocationId)) {
    return fail('Prenos med organizacijami ni dovoljen.', 403)
  }

  // ── idempotentni replay ZA varovalkami (ključ ni poverilnica — GRN lekcija) ──
  if (input.idempotencyKey) {
    const existing = await db.stockTransfer.findUnique({
      where: { fromLocationId_idempotencyKey: { fromLocationId: input.fromLocationId, idempotencyKey: input.idempotencyKey } },
      include: { items: true },
    })
    if (existing) {
      return ok({
        transfer: transferDto(existing as TrfRow, { from: fromLoc.name, to: toLoc.name }),
        idempotentReplay: true,
      })
    }
  }

  // ── validacija postavk (artikli + serije na izvorni lokaciji) ──
  const itemIds = input.lines.map((l) => l.inventoryItemId)
  const items = await db.inventoryItem.findMany({ where: { id: { in: itemIds } } })
  const itemById = new Map(items.map((i) => [i.id, i]))
  const batchIds = input.lines.map((l) => l.batchId).filter((b): b is string => b != null)
  const batches = batchIds.length ? await db.inventoryBatch.findMany({ where: { id: { in: batchIds } } }) : []
  const batchById = new Map(batches.map((b) => [b.id, b]))

  for (const l of input.lines) {
    const item = itemById.get(l.inventoryItemId)
    if (!item) return fail('Artikel ne obstaja.', 404)
    if (item.locationId !== input.fromLocationId) {
      return fail('Artikel ni na izvorni lokaciji.', 400)
    }
    if (l.batchId) {
      const batch = batchById.get(l.batchId)
      if (!batch) return fail('Serija ne obstaja.', 404)
      if (batch.inventoryItemId !== l.inventoryItemId) {
        return fail('Serija ne pripada artiklu postavke.', 400)
      }
      // skalar na izvorni lokaciji: null = neznan (migracijsko varen —
      // uporabljiv), tuja lokacija pa je izrecna napaka
      if (batch.locationId != null && batch.locationId !== input.fromLocationId) {
        return fail('Serija ni na izvorni lokaciji.', 400)
      }
      // lot-governance: karantena/odpoklic blokirata NOVO razknjižbo
      // (tolerantno na legacy male črke — isBlockedStatus)
      if (isBlockedStatus(batch.status)) {
        return fail('Serija je blokirana.', 409)
      }
    }
  }

  const now = new Date()
  const totalRequestedQty = r3(input.lines.reduce((s, l) => s + l.requestedQty, 0))
  const id = nid()
  const dayPrefix = transferNumberFor(now, 1).slice(0, 13) // TRF-YYYYMMDD-

  // številčenje znotraj dneva + retry ob sočasnem trčenju številke (≤3, kot AP)
  type TransferWithItems = Prisma.StockTransferGetPayload<{ include: { items: true } }>
  let created: TransferWithItems | null = null
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const seq = (await db.stockTransfer.count({ where: { transferNumber: { startsWith: dayPrefix } } })) + 1 + attempt
    const transferNumber = transferNumberFor(now, seq)
    try {
      created = await db.$transaction(async (tx) => {
        // ANCHOR na vrstici IZVORNE lokacije (vzorec #63): serializira sočasna
        // ustvarjanja prenosov/obdobij ZA ISTO lokacijo (SQLite pisljivi zaklep).
        const anchor = await tx.location.updateMany({ where: { id: input.fromLocationId }, data: { updatedAt: now } })
        if (anchor.count === 0) throw new TransferError('Izvorna lokacija ne obstaja.', 404)

        // sveža preverba artiklov ZNOTRAJ TX — artikel je med branjem in zapisom
        // lahko pobrisan/prenešen (rollback celote, osnutek se NE ustvari)
        for (const l of input.lines) {
          const fresh = await tx.inventoryItem.findUnique({
            where: { id: l.inventoryItemId },
            select: { id: true, locationId: true },
          })
          if (!fresh) throw new TransferError('Artikel ne obstaja.', 404)
          if (fresh.locationId !== input.fromLocationId) {
            throw new TransferError('Artikel ni več na izvorni lokaciji.', 400)
          }
        }

        const transfer = await tx.stockTransfer.create({
          data: {
            id,
            transferNumber,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            status: 'DRAFT',
            note: input.note,
            idempotencyKey: input.idempotencyKey,
            createdById: user.sub,
            items: {
              create: input.lines.map((l) => {
                const item = itemById.get(l.inventoryItemId)!
                const batch = l.batchId ? batchById.get(l.batchId) : undefined
                return {
                  id: nid(),
                  inventoryItemId: l.inventoryItemId,
                  // snapshot obdobja: zgodovina ostane berljiva če artikel pobrišejo
                  itemName: item.name,
                  unit: item.unit,
                  requestedQty: l.requestedQty,
                  dispatchedQty: 0,
                  receivedQty: 0,
                  damagedQty: 0,
                  // cena: vrstica (izrecna) ?? trenutna nabavna cena artikla
                  unitCost: l.unitCost != null ? l.unitCost : r2(num(item.costPerUnit)),
                  batchId: l.batchId,
                  // serija posnetek (sledljivost izvora)
                  lotNumber: l.lotNumber ?? batch?.lotNumber ?? null,
                  expiryDate: l.expiryDate ?? batch?.expiryDate ?? null,
                }
              }),
            },
          },
          include: { items: true },
        })

        await writeAudit(tx, {
          userId: user.sub,
          action: 'TRANSFER_CREATED',
          entityType: 'StockTransfer',
          entityId: id,
          details: jstr({
            transferNumber,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            lineCount: input.lines.length,
            totalRequestedQty,
            idempotencyKey: input.idempotencyKey,
          }),
          locationId: input.fromLocationId,
        })
        return transfer
      })
    } catch (e) {
      const msg = String((e as Error).message || '')
      // sočasno številčenje istega dne → retry z višjo zaporedno (max 3)
      if (msg.includes('transferNumber') && attempt < 2) continue
      if (e instanceof TransferError) return fail(e.message, e.status)
      // sočasni replay z istim (fromLocationId, idempotencyKey) → unique vrne
      // obstoječi prenos (isti vzorec kot waste)
      if (input.idempotencyKey && msg.includes('fromLocationId_idempotencyKey')) {
        const replay = await db.stockTransfer.findUnique({
          where: { fromLocationId_idempotencyKey: { fromLocationId: input.fromLocationId, idempotencyKey: input.idempotencyKey } },
          include: { items: true },
        })
        if (replay) {
          return ok({
            transfer: transferDto(replay as TrfRow, { from: fromLoc.name, to: toLoc.name }),
            idempotentReplay: true,
          })
        }
      }
      throw e
    }
  }

  if (!created) return fail('Prenos ni bil ustvarjen (sočasno številčenje — poskusite znova).', 500)
  return ok({ transfer: transferDto(created as TrfRow, { from: fromLoc.name, to: toLoc.name }) }, 201)
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }

  const url = new URL(req.url)
  const status = (url.searchParams.get('status') || '').trim().toUpperCase()
  if (status && !(TRF_STATUSES as readonly string[]).includes(status)) {
    return fail(`Neznan status prenosa: ${status.slice(0, 30)}.`, 400)
  }
  const fromLocationId = url.searchParams.get('fromLocationId')?.trim() || ''
  const toLocationId = url.searchParams.get('toLocationId')?.trim() || ''
  const itemId = url.searchParams.get('itemId')?.trim() || ''
  const q = url.searchParams.get('q')?.trim() || ''
  const dateFrom = url.searchParams.get('dateFrom')?.trim() || ''
  const dateTo = url.searchParams.get('dateTo')?.trim() || ''
  const take = Math.min(100, Math.max(1, Number(url.searchParams.get('take') || 50) || 50))

  // obseg uporabnika: prenos je viden, če je izvorna ALI ciljna lokacija v
  // obsegu (staff = lastna; centralne = org allow-lista; bootstrap = vse).
  // Vsi filti se ANDajo prek seznama (dva ločena OR ključa v istem objektu
  // bi se v JS prepisala — obseg NE sme biti nadomeščen z iskalnim OR).
  const scope = await locationScope(user)
  const and: Prisma.StockTransferWhereInput[] = []
  if (scope.locationId) {
    and.push({ OR: [{ fromLocationId: scope.locationId }, { toLocationId: scope.locationId }] })
  }
  if (status) and.push({ status })
  // tuja lokacija v filtru = prazen seznam (fail-closed where — ne 403,
  // seznam ne razkriva obstoja)
  if (fromLocationId) and.push({ fromLocationId })
  if (toLocationId) and.push({ toLocationId })
  if (itemId) and.push({ items: { some: { inventoryItemId: itemId } } })
  if (q) {
    and.push({ OR: [{ transferNumber: { contains: q } }, { items: { some: { itemName: { contains: q } } } }] })
  }
  const dateRange = buildDateRange(dateFrom, dateTo)
  if (dateRange.createdAt) and.push({ createdAt: dateRange.createdAt })
  const where: Prisma.StockTransferWhereInput = and.length ? { AND: and } : {}

  const rows = await db.stockTransfer.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  })

  // imena lokacij (skalarne vezave — batch poizvedba po strani, ne per vrstica)
  const locationIds = [...new Set(rows.flatMap((r) => [r.fromLocationId, r.toLocationId]))]
  const locations = locationIds.length
    ? await db.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true } })
    : []
  const names = new Map(locations.map((l) => [l.id, l.name]))

  return ok({
    transfers: rows.map((r) =>
      transferDto(r as TrfRow, { from: names.get(r.fromLocationId) ?? null, to: names.get(r.toLocationId) ?? null }),
    ),
  })
}

/** [dateFrom, dateTo] na createdAt (gte / lt — zgornja meja izključna). */
function buildDateRange(dateFrom: string, dateTo: string): { createdAt?: { gte?: Date; lt?: Date } } {
  const out: { createdAt?: { gte?: Date; lt?: Date } } = {}
  if (dateFrom) {
    const d = new Date(dateFrom)
    if (!isNaN(d.getTime())) out.createdAt = { ...out.createdAt, gte: d }
  }
  if (dateTo) {
    const d = new Date(dateTo)
    if (!isNaN(d.getTime())) out.createdAt = { ...out.createdAt, lt: d }
  }
  return out
}
