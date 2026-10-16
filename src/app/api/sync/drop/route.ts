import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { rateLimitSharedAsync } from '@/lib/rate-limit'

/**
 * Issue #3 §A (P0) — POST /api/sync/drop
 *
 * Poročilo klienta (offline-queue.ts reportDeadOp), da je offline operacija po
 * 10 neuspelih poskusih padla v dead-letter. PREJ je klient operacijo TIHO izvrgel
 * iz localStorage vrste — strežnik ni vedel, da je operacija padla (DeviceSyncOperation
 * 'failed' obstaja samo, če je flush sploh prišel do /api/sync). Zdaj vsak prehod v
 * dead-letter sproži to poročilo → AuditLog SYNC_OP_DROPPED (vidno v /api/monitoring/
 * errors + incident runbook docs/INCIDENT-RUNBOOK.md).
 *
 * Pravila:
 *  - requireAuth (NE requirePermission): vsak prijavljeni uslužbenec sme poročati
 *    o padli operaciji SVOJE naprave — zrcalno POST /api/monitoring/errors (issue #5,
 *    komentar #4: pošiljanje poročil je ločeno od vpogleda);
 *  - allow-list telo: clientOperationId (≤64), kind ∈ replajabilne 3 vrste,
 *    attempts 1..50, lastError ≤200 — VSEBINA PAYLOAD SE NE POŠILJA (skrivnosti/
 *    količine ostanejo na napravi);
 *  - zapis je fire-and-forget (uspeh odgovora ni odvisen od audita);
 *  - lahek rate limit (30/min na uporabnika) — poročilo ne sme biti vektor spam-a.
 */
export const dynamic = 'force-dynamic'

const ALLOWED_KINDS = ['order.create', 'order.addItems', 'kitchen.status'] as const

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  if (!(await rateLimitSharedAsync(`syncdrop:${user.sub}`, 30, 60_000)).allowed) {
    return fail('Preveč poročil. Počakajte trenutek.', 429)
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('Neveljavno telo zahteve.')
  }

  const clientOperationId = typeof body.clientOperationId === 'string' ? body.clientOperationId.trim().slice(0, 64) : ''
  if (!clientOperationId) return fail('clientOperationId je obvezen.')

  const kind = typeof body.kind === 'string' ? body.kind.trim() : ''
  if (!(ALLOWED_KINDS as readonly string[]).includes(kind)) {
    return fail('Neznan tip operacije.')
  }

  const attemptsRaw = Number(body.attempts)
  if (!Number.isFinite(attemptsRaw) || attemptsRaw < 1 || attemptsRaw > 50) {
    return fail('attempts je izven dovoljenega obsega (1–50).')
  }

  const lastError = typeof body.lastError === 'string' ? body.lastError.slice(0, 200) : ''

  await writeAudit(db, {
    userId: user.sub,
    action: 'SYNC_OP_DROPPED',
    entityType: 'DeviceSyncOperation',
    entityId: clientOperationId,
    details: jstr({ kind, attempts: Math.round(attemptsRaw), lastError }),
    locationId: user.loc ?? null,
  }).catch(() => null)

  return ok({ accepted: true }, 201)
}
