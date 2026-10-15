import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { lotGovernanceColumnsReady, BATCH_STATUS } from '@/lib/lot-governance'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'

/**
 * Issue #15 (P1, v1.105.0) — KARANTENA serije (blokada uporabe, reverzibilna
 * z IZRECNO sprostitvijo).
 *
 * POST /api/inventory/batches/[id]/hold { reason, note?, ref? }
 *  - status ACTIVE → QUARANTINE (EXHAUSTED ostane EXHAUSTED — ni količine
 *    za blokado, a zgodovina karantene se vseeno zapiše za sledljivost);
 *  - razlog ≥ 10 znakov OBVEZEN (kdo/kdaj/zakaj);
 *  - pravica: inventory.manage + lokacijska izolacija (tuja serija → 404);
 *  - audit (hash-chain) + EventLog LOT_BLOCKED + push opozorilo vodstvu;
 *  - pre-DDL: 503 (hold polja še ne obstajajo).
 * Rekurzivna blokada: QUARANTINE → QUARANTINE posodobi razlog (nova sled),
 * RECALLED → 409 (odpoklic je terminalen).
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
  const reason = String(b.reason || '').trim()
  if (reason.length < 10) return fail('Razlog karantene je obvezen (vsaj 10 znakov).', 400)
  const ref = String(b.ref || '').trim().slice(0, 120)
  const note = String(b.note || '').trim().slice(0, 500)

  const batch = await db.inventoryBatch.findUnique({
    where: { id },
    select: { id: true, lotNumber: true, status: true, locationId: true, inventoryItemId: true, quantityRemaining: true, holdReason: true, holdAt: true, holdById: true, holdRef: true, InventoryItem: { select: { name: true, unit: true } } },
  })
  if (!batch) return fail('Serija ne obstaja.', 404)
  if (batch.locationId && user.role !== 'ADMIN' && user.loc && batch.locationId !== user.loc) {
    return fail('Serija pripada drugi lokaciji.', 403)
  }
  if ((batch.status || '').toUpperCase() === BATCH_STATUS.RECALLED) {
    return fail('Serija je v odpoklicu (terminalen status) — karantena ni mogoča.', 409)
  }

  const now = new Date()
  await db.inventoryBatch.update({
    where: { id },
    data: {
      status: BATCH_STATUS.QUARANTINE,
      holdReason: reason.slice(0, 500),
      holdAt: now,
      holdById: user.sub,
      holdRef: ref,
      ...(note ? { note } : {}),
      releaseAt: null,
      releaseById: null,
      releaseNote: '',
    },
  })

  // audit (hash-chain, isti helper kot ostale write poti)
  await writeAudit(db, {
    userId: user.sub,
    action: 'BATCH_QUARANTINED',
    entityType: 'InventoryBatch',
    entityId: id,
    details: JSON.stringify({
      lotNumber: batch.lotNumber,
      itemName: batch.InventoryItem?.name,
      quantityRemaining: num(batch.quantityRemaining),
      reason: reason.slice(0, 500),
      ref,
      previousStatus: batch.status,
      previousHold: batch.holdAt ? { reason: batch.holdReason, by: batch.holdById, ref: batch.holdRef } : null,
    }),
    locationId: batch.locationId,
  })

  await publishEvent('LOT_BLOCKED', {
    entityType: 'InventoryBatch',
    entityId: id,
    payload: { lotNumber: batch.lotNumber, mode: 'quarantine', reason: reason.slice(0, 200), by: user.name || user.sub },
    locationId: batch.locationId,
  })

  void pushEvent(
    'LOT_BLOCKED',
    {
      title: 'Serija v karanteni',
      body: `${batch.InventoryItem?.name || batch.lotNumber} · serija ${batch.lotNumber} · ${num(batch.quantityRemaining)} ${batch.InventoryItem?.unit || ''}`,
      url: '/dashboard?tab=zaloga',
      tag: `lot-quarantine-${id}`,
    },
    { roles: ['manager', 'warehouse'], locationId: batch.locationId ?? undefined },
  )

  return ok({ id, status: BATCH_STATUS.QUARANTINE, holdAt: now, holdById: user.sub })
}
