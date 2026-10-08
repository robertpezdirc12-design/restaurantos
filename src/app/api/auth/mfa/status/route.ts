/**
 * Issue #12 §3 — MFA status: GET /api/auth/mfa/status
 * Za UI: { enabled, secretPending (vpisana, aktivacija šele z /enable), mandatory (privilegirana vloga) }.
 * Brez uhajanja skrivnosti ali recovery kod.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { roleRequiresMfa } from '@/lib/mfa'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') {
    return ok({ enabled: false, secretPending: false, mandatory: false, bootstrap: true })
  }
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { mfaSecret: true, mfaEnabled: true, role: true },
  })
  if (!employee) return ok({ enabled: false, secretPending: false, mandatory: false })
  return ok({
    enabled: employee.mfaEnabled,
    secretPending: !employee.mfaEnabled && !!employee.mfaSecret,
    mandatory: roleRequiresMfa(employee.role) && !employee.mfaEnabled,
  })
}
