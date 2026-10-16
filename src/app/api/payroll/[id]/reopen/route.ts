import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { payrollTablesReady } from '@/lib/payroll-schema'
import { periodDto } from '@/lib/payroll'

/**
 * Issue #22 (P2, v1.115.0) — PONOVNO ODPRTJE obračunskega obdobja.
 *
 * POST /api/payroll/[id]/reopen  { reason: string }
 *   → status closed → draft, reopenCount + 1 (korektivni zapis — RAZLOG je
 *     obvezen 3–500 znakov; brez njega bi se obdobja tiho prepisovala).
 *     Snapshot polj se NE resetira — ostanejo kot ZGODOVINA zadnjega zaklepa
 *     do naslednjega zaključka (nova različica = 1 + reopenCount). Pravica:
 *     employees.manage + guardResource. Audit PAYROLL_PERIOD_REOPENED z
 *     razlogom (razlog JE vsebina revizije, vrstice/PII pa ne).
 *
 * Po ponovnem odprtju velja znova PATCH /api/timeclock/[id] čuvav
 * (vnosi v zaključenem obdobju so 409 — dokler ni ponovno odprto).
 *
 * PRE-DDL: probe payrollTablesReady → 503 (graceful).
 */

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await payrollTablesReady())) {
    return fail('Obračunsko obdobje čaka na shemsko migracijo (Enterprise → Shema migracije → payroll-periods).', 503)
  }
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 3 || reason.length > 500) {
    return fail('Razlog za ponovno odprtje je obvezen (3–500 znakov).', 400)
  }

  const period = await db.payrollPeriod.findUnique({ where: { id } })
  if (!period) return fail('Obračunsko obdobje ne obstaja.', 404)
  const guarded = await guardResource(user, period.locationId)
  if (guarded) return guarded
  if (period.status !== 'closed') return fail('Obdobje ni zaključeno.', 409)

  const reopenCount = period.reopenCount + 1
  const now = new Date()

  try {
    const updated = await db.$transaction(async (tx) => {
      // CAS: samo iz 'closed' — sočasna/vzporedna ponovna odprtja pomenijo
      // count 0 → 409 (prva zmaga; audit pripada le njej). Snapshot polj se
      // NEONAMERNO ne resetira (zgodovina zadnjega zaklepa ostane vidna).
      const res = await tx.payrollPeriod.updateMany({
        where: { id: period.id, status: 'closed' },
        data: { status: 'draft', reopenCount, updatedAt: now },
      })
      if (res.count === 0) throw new Error('CONCURRENT_REOPEN')
      await writeAudit(tx, {
        userId: user.sub,
        action: 'PAYROLL_PERIOD_REOPENED',
        entityType: 'PayrollPeriod',
        entityId: period.id,
        details: jstr({ reason, reopenCount, previousVersion: period.version }),
        locationId: period.locationId,
      })
      return tx.payrollPeriod.findUnique({ where: { id: period.id } })
    })
    if (!updated) return fail('Obračunsko obdobje ne obstaja.', 404)
    return ok({
      period: periodDto(updated),
      message: 'Obdobje je ponovno odprto — spremembe bodo zabeležene v novi različici ob zaključku.',
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'CONCURRENT_REOPEN') {
      return fail('Obdobje je medtem že ponovno odprto.', 409)
    }
    throw e
  }
}
