import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { lotGovernanceColumnsReady, BATCH_STATUS } from '@/lib/lot-governance'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'

/**
 * Issue #15 (P1, v1.105.0) — ODKPOKIC serije (ročno sprožen, TERMINALEN).
 *
 * POST /api/inventory/batches/[id]/recall { reason, supplierNotified, ref?, note? }
 *  - status → RECALLED (terminalen: release 409; fizika odstranitve gre skozi
 *    obstoječi odpis/waste — zaloga sledi dobavnici, ne računu);
 *  - razlog ≥ 10 znakov OBVEZEN + supplierNotified (bool) — ali je bil
 *    dobavitelj obveščen — in ref (referenca obvestila/uradnega odpoklica);
 *  - pravica: inventory.manage + lokacijska izolacija;
 *  - audit (hash-chain) + EventLog LOT_BLOCKED (mode=recall) + push vodstvu;
 *  - pre-DDL: 503.
 * Povezava do prodanih jedi: sledljivostno poročilo (/trace) pokaže izpostavljene
 * naročila — odpoklic NE spreminja zgodovinskih računov retroaktivno.
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
  if (reason.length < 10) return fail('Razlog odpoklica je obvezen (vsaj 10 znakov).', 400)
  const supplierNotified = b.supplierNotified === true
  const ref = String(b.ref || '').trim().slice(0, 120)
  const note = String(b.note || '').trim().slice(0, 500)

  const batch = await db.inventoryBatch.findUnique({
    where: { id },
    select: { id: true, lotNumber: true, status: true, locationId: true, inventoryItemId: true, quantityRemaining: true, supplierId: true, supplierName: true, holdReason: true, holdAt: true, holdById: true, holdRef: true, InventoryItem: { select: { name: true, unit: true } } },
  })
  if (!batch) return fail('Serija ne obstaja.', 404)
  if (batch.locationId && user.role !== 'ADMIN' && user.loc && batch.locationId !== user.loc) {
    return fail('Serija pripada drugi lokaciji.', 403)
  }
  if ((batch.status || '').toUpperCase() === BATCH_STATUS.RECALLED) {
    return fail('Serija je ŽE v odpoklicu (terminalen status).', 409)
  }

  const now = new Date()
  await db.inventoryBatch.update({
    where: { id },
    data: {
      status: BATCH_STATUS.RECALLED,
      holdReason: `ODPOKlic: ${reason.slice(0, 480)}`,
      holdAt: now,
      holdById: user.sub,
      holdRef: ref,
      ...(note ? { note } : {}),
      releaseAt: null,
      releaseById: null,
      releaseNote: '',
    },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'BATCH_RECALLED',
    entityType: 'InventoryBatch',
    entityId: id,
    details: JSON.stringify({
      lotNumber: batch.lotNumber,
      itemName: batch.InventoryItem?.name,
      quantityRemaining: num(batch.quantityRemaining),
      supplierId: batch.supplierId,
      supplierName: batch.supplierName,
      reason: reason.slice(0, 480),
      supplierNotified,
      ref,
      previousStatus: batch.status,
    }),
    locationId: batch.locationId,
  })

  await publishEvent('LOT_BLOCKED', {
    entityType: 'InventoryBatch',
    entityId: id,
    payload: { lotNumber: batch.lotNumber, mode: 'recall', reason: reason.slice(0, 200), supplierNotified, by: user.name || user.sub },
    locationId: batch.locationId,
  })

  void pushEvent(
    'LOT_BLOCKED',
    {
      title: 'ODPOKlic serije',
      body: `${batch.InventoryItem?.name || batch.lotNumber} · serija ${batch.lotNumber} · dobavitelj ${batch.supplierName || '(neznano)'} — preveri sledljivostno poročilo`,
      url: `/dashboard?tab=zaloga&lot=${id}`,
      tag: `lot-recall-${id}`,
    },
    { roles: ['manager', 'warehouse'], locationId: batch.locationId ?? undefined },
  )

  return ok({ id, status: BATCH_STATUS.RECALLED, holdAt: now, holdById: user.sub, supplierNotified })
}
