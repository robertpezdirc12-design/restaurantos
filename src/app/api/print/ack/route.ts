/**
 * Issue #10 P2-3 — POST /api/print/ack
 * Evidenca tiskalnega poskusa (ACK iz clienta/print toka). Fire-and-forget s
 * client strani — napaka ACK-a nikoli ne vpliva na sam tisk (§18).
 * Neuspeli poskusi (status='failed') → AuditLog PRINT_FAILED (vidno v audit sledi).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, locationScope } from '@/lib/api'
import { nid } from '@/lib/map'
import { parsePrintAck } from '@/lib/print'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const parsed = parsePrintAck(await req.json().catch(() => null))
  if (!parsed.ok) return ok({ error: parsed.error }, 400)
  const d = parsed.data

  const scope = locationScope(user)
  const row = await db.printJob.create({
    data: {
      id: nid(),
      userId: user.sub,
      locationId: scope.locationId ?? null,
      kind: d.kind,
      refId: d.refId,
      target: d.target,
      status: d.status,
      error: d.error,
      attempts: d.attempts,
      device: d.device,
    },
  })

  if (d.status === 'failed') {
    await db.auditLog
      .create({
        data: {
          id: nid(),
          userId: user.sub,
          action: 'PRINT_FAILED',
          entityType: 'PrintJob',
          entityId: row.id,
          details: JSON.stringify({ kind: d.kind, refId: d.refId, target: d.target, device: d.device, error: d.error.slice(0, 200) }),
        },
      })
      .catch(() => null)
  }

  return ok({ printJob: { id: row.id, status: row.status } }, 201)
}
