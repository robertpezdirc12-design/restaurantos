import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { lotGovernanceColumnsReady, BATCH_STATUS } from '@/lib/lot-governance'
import { publishEvent } from '@/lib/events'

/**
 * Issue #15 (P1, v1.105.0) — IZRECNA sprostitev karantene (reverzibilna blokada).
 *
 * POST /api/inventory/batches/[id]/release { note }
 *  - samo QUARANTINE → ACTIVE (RECALLED je terminalen → 409);
 *  - razlog (note) ≥ 10 znakov OBVEZEN (kdo/kdaj/zakaj — izrecna odobritev,
 *    NIKOLI tiha razveljavitev blokade);
 *  - pravica: inventory.manage + lokacijska izolacija;
 *  - audit (hash-chain) z izhodiščno blokado + EventLog LOT_RELEASED;
 *  - pre-DDL: 503.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params

  if (!(await lotGovernanceColumnsReady())) {
    return fail('Lot governance shema še ni aplicirana — konzola Enterprise → Shema migracije → lot-governance.', 503)
  }

  const body = await req.json().catch(() => null)
  const b = (body || {}) as Record<string, unknown>
  const note = String(b.note || '').trim()
  if (note.length < 10) return fail('Razlog sprostitve je obvezen (vsaj 10 znakov).', 400)

  const batch = await db.inventoryBatch.findUnique({
    where: { id },
    select: { id: true, lotNumber: true, status: true, locationId: true, quantityRemaining: true, holdReason: true, holdAt: true, holdById: true, holdRef: true, InventoryItem: { select: { name: true } } },
  })
  if (!batch) return fail('Serija ne obstaja.', 404)
  if (batch.locationId && user.role !== 'ADMIN' && user.loc && batch.locationId !== user.loc) {
    return fail('Serija pripada drugi lokaciji.', 403)
  }
  const st = (batch.status || '').toUpperCase()
  if (st === BATCH_STATUS.RECALLED) {
    return fail('Odpoklic je terminalen — sprostitev ni mogoča (odstranitev skozi odpis).', 409)
  }
  if (st !== BATCH_STATUS.QUARANTINE) {
    return fail('Serija ni v karanteni — nič za sprostiti.', 409)
  }

  const now = new Date()
  await db.inventoryBatch.update({
    where: { id },
    data: {
      status: num(batch.quantityRemaining) <= 0.0005 ? BATCH_STATUS.EXHAUSTED : BATCH_STATUS.ACTIVE,
      releaseAt: now,
      releaseById: user.sub,
      releaseNote: note.slice(0, 500),
    },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'BATCH_RELEASED',
    entityType: 'InventoryBatch',
    entityId: id,
    details: JSON.stringify({
      lotNumber: batch.lotNumber,
      itemName: batch.InventoryItem?.name,
      quantityRemaining: num(batch.quantityRemaining),
      releaseNote: note.slice(0, 480),
      hold: { reason: batch.holdReason, at: batch.holdAt, by: batch.holdById, ref: batch.holdRef },
    }),
    locationId: batch.locationId,
  })

  await publishEvent('LOT_RELEASED', {
    entityType: 'InventoryBatch',
    entityId: id,
    payload: { lotNumber: batch.lotNumber, note: note.slice(0, 200), by: user.name || user.sub },
    locationId: batch.locationId,
  })

  return ok({ id, status: BATCH_STATUS.ACTIVE, releaseAt: now, releaseById: user.sub })
}
