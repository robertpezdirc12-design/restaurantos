import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { labelTablesReady } from '@/lib/label-schema'

/**
 * Issue #24 — POST /api/labels/[id]/void: razveljavitev etikete (npr. napačen
 * izpis, pokvarjena nalepka). Upravljavski akt: inventory.manage. Razlog je
 * OBVEZEN (≥ 3 znaki — sledljiva akcija, ne tiha razveljavitev). Status
 * ACTIVE → VOID (nov tisk VOID etikete → 409; izdaj novo).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const { id } = await params
  const label = await db.prepLabel.findUnique({ where: { id } })
  if (!label) return fail('Etiketa ne obstaja.', 404)
  const locErr = await guardResource(user, label.locationId)
  if (locErr) return locErr
  if (String(label.status).toUpperCase() === 'VOID') {
    return fail('Etiketa je že razveljavljena.', 409)
  }
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null
  const reason = String(body?.reason ?? '').trim()
  if (reason.length < 3) return fail('Razlog razveljavitve je obvezen (vsaj 3 znaki).', 400)
  const updated = await db.prepLabel.update({
    where: { id },
    data: { status: 'VOID', voidReason: reason.slice(0, 200) },
  })
  await writeAudit(db, {
    userId: user.sub,
    action: 'LABEL_VOIDED',
    entityType: 'PrepLabel',
    entityId: id,
    details: jstr({
      reason: updated.voidReason,
      itemName: updated.itemName,
      batchId: updated.batchId,
      preparationId: updated.preparationId,
    }),
    locationId: updated.locationId,
  })
  return ok({ id: updated.id, status: updated.status, voidReason: updated.voidReason })
}
