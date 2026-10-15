import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { lotGovernanceColumnsReady, batchBucket, validateLotDates, BATCH_SELECT_FULL, BATCH_SELECT_LEGACY, type BatchBucket } from '@/lib/lot-governance'
import { publishEvent } from '@/lib/events'

/**
 * OPS-8 val 2 (v1.72.0) — Serije / rok uporabe (InventoryBatch FEFO seznam).
 * Issue #15 (P1, v1.105.0) — lot governance razširitev.
 *
 * GET /api/inventory/batches?take=50&filter=<bucket>
 *   → { batches: [{ id, itemName, itemUnit, lotNumber, expiryDate, alertDate,
 *        removalDate, quantityRemaining, quantityInitial, supplierName,
 *        supplierId, locationId, status, bucket, holdReason, holdAt, holdRef,
 *        releaseAt, releaseNote, receivedAt, note }] }
 *
 *   filter (neobvezno, privzeto 'usable'): ena izmed klasifikacij lot-governance
 *   ('expiring' = alert) — sezlami poteče kmalu / pretečeno / karantena /
 *   odpoklic / izčrpano / brez roka; brez filtra: uporabne serije (kot prej,
 *   zdaj VKLJUČNO tudi brez roka — vrzel je vidna, FEFO vrstni red).
 *
 * PATCH /api/inventory/batches { id, alertDate?, removalDate?, expiryDate?, note? }
 *   — ročno določanje opozorilnega/odstranitvenega roka (izrecna vrednost
 *     upravljavca — NI privzetih dni). Pravica: inventory.manage. Validacija:
 *     alertDate ≤ removalDate ≤ expiryDate. Audit + LOT_ALERT push, ko
 *     opozorilni datum že velja.
 *
 * Pre-DDL: GET pade na legacy projekcijo (brez novih polj), PATCH → 503.
 */
const FILTER_ALIASES: Record<string, string> = {
  usable: 'usable',
  all: 'all',
  expiring: 'alert',
  alert: 'alert',
  expired: 'expired',
  quarantine: 'quarantined',
  quarantined: 'quarantined',
  recalled: 'recalled',
  recall: 'recalled',
  exhausted: 'exhausted',
  unknown: 'unknown_expiry',
  unknown_expiry: 'unknown_expiry',
  removal_due: 'removal_due',
}

function parseDateField(v: unknown): { state: 'absent' | 'invalid' | 'value'; value: Date | null } {
  if (v === undefined || v === null || v === '') return { state: 'absent', value: null }
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? { state: 'invalid', value: null } : { state: 'value', value: d }
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const take = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('take') || '50', 10) || 50, 1), 200)
  const filterRaw = (req.nextUrl.searchParams.get('filter') || 'usable').toLowerCase()
  const filter = FILTER_ALIASES[filterRaw] || 'usable'
  const lotReady = await lotGovernanceColumnsReady()

  const rows = await db.inventoryBatch.findMany({
    where: {
      ...(await locationScope(user)),
      status: { in: ['ACTIVE', 'active', 'EXHAUSTED', 'QUARANTINE', 'RECALLED'] },
      ...(filter === 'usable' ? { quantityRemaining: { gt: 0 } } : {}),
    },
    orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
    // bucket filter se izvede v pomnilniku (DB ne pozna klasifikacije) → pridobi
    // širše in poreži po filtru (expiring/expired … so redkejši kot prvi take)
    take: filter === 'usable' || filter === 'all' ? take : Math.min(take * 4, 400),
    select: {
      id: true,
      lotNumber: true,
      supplierId: true,
      supplierName: true,
      locationId: true,
      receivedAt: true,
      expiryDate: true,
      quantityInitial: true,
      quantityRemaining: true,
      unit: true,
      unitCost: true,
      status: true,
      note: true,
      ...(lotReady ? { alertDate: true, removalDate: true, holdReason: true, holdAt: true, holdRef: true, releaseAt: true, releaseNote: true } : {}),
      InventoryItem: { select: { name: true, unit: true } },
    },
  })

  const now = new Date()
  const mapped = rows.map((b) => ({
    id: b.id,
    itemName: b.InventoryItem?.name || '',
    itemUnit: b.InventoryItem?.unit || b.unit,
    lotNumber: b.lotNumber,
    expiryDate: b.expiryDate,
    alertDate: lotReady ? b.alertDate : null,
    removalDate: lotReady ? b.removalDate : null,
    quantityRemaining: num(b.quantityRemaining),
    quantityInitial: num(b.quantityInitial),
    supplierName: b.supplierName,
    supplierId: b.supplierId,
    locationId: b.locationId,
    status: (b.status || '').toUpperCase(),
    bucket: batchBucket(
      {
        status: b.status,
        quantityRemaining: b.quantityRemaining,
        expiryDate: b.expiryDate,
        alertDate: lotReady ? b.alertDate : null,
        removalDate: lotReady ? b.removalDate : null,
      },
      now,
    ),
    holdReason: lotReady ? b.holdReason : '',
    holdAt: lotReady ? b.holdAt : null,
    holdRef: lotReady ? b.holdRef : '',
    releaseAt: lotReady ? b.releaseAt : null,
    releaseNote: lotReady ? b.releaseNote : '',
    receivedAt: b.receivedAt,
    note: b.note,
  }))

  // filter bucket velja po klasifikaciji (DB ne pozna bucket-ov); 'usable' =
  // staro obnašanje (samo uporabne, zdaj tudi brez roka — vrzel vidna) + 'all'.
  const filtered = filter === 'all' ? mapped : filter === 'usable'
    ? mapped.filter((b) => b.quantityRemaining > 0.0005 && !['recalled', 'quarantined', 'expired', 'removal_due'].includes(b.bucket))
    : mapped.filter((b) => b.bucket === (filter as BatchBucket))

  return ok({ batches: filtered.slice(0, take) })
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const lotReady = await lotGovernanceColumnsReady()
  if (!lotReady) {
    return fail('Lot governance shema (alertDate/removalDate) še ni aplicirana — uporabi konzolo Enterprise → Shema migracije → lot-governance.', 503)
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)
  const id = String((body as Record<string, unknown>).id || '').trim()
  if (!id) return fail('Manjka id serije.', 400)

  const batch = await db.inventoryBatch.findUnique({ where: { id }, select: { id: true, locationId: true, inventoryItemId: true, lotNumber: true, expiryDate: true, alertDate: true, removalDate: true, note: true, status: true } })
  if (!batch) return fail('Serija ne obstaja.', 404)
  if (batch.locationId && user.role !== 'ADMIN' && user.loc && batch.locationId !== user.loc) {
    return fail('Serija pripada drugi lokaciji.', 403)
  }

  const alert = parseDateField((body as Record<string, unknown>).alertDate)
  const removal = parseDateField((body as Record<string, unknown>).removalDate)
  const expiry = parseDateField((body as Record<string, unknown>).expiryDate)
  if (alert.state === 'invalid' || removal.state === 'invalid' || expiry.state === 'invalid') {
    return fail('Neveljaven datum (uporabi ISO 8601).', 400)
  }

  // združi s postoječimi vrednostmi (PATCH = delna posodobitev)
  const merged = {
    alertDate: alert.state === 'value' ? alert.value : alert.state === 'absent' ? batch.alertDate : null,
    removalDate: removal.state === 'value' ? removal.value : removal.state === 'absent' ? batch.removalDate : null,
    expiryDate: expiry.state === 'value' ? expiry.value : expiry.state === 'absent' ? batch.expiryDate : null,
  }
  const v = validateLotDates(merged)
  if (!v.ok) return fail(v.error || 'Datumi niso skladni.', 400)

  const noteRaw = (body as Record<string, unknown>).note
  const note = noteRaw === undefined ? batch.note : String(noteRaw).slice(0, 500)

  await db.inventoryBatch.update({
    where: { id },
    data: {
      alertDate: merged.alertDate,
      removalDate: merged.removalDate,
      expiryDate: merged.expiryDate,
      note,
    },
  })

  await publishEvent('LOT_DATES_SET', {
    entityType: 'InventoryBatch',
    entityId: id,
    payload: {
      lotNumber: batch.lotNumber,
      alertDate: merged.alertDate?.toISOString() || null,
      removalDate: merged.removalDate?.toISOString() || null,
      expiryDate: merged.expiryDate?.toISOString() || null,
    },
    locationId: batch.locationId,
  })

  return ok({ id, alertDate: merged.alertDate, removalDate: merged.removalDate, expiryDate: merged.expiryDate })
}
