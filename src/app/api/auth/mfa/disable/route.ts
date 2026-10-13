/**
 * Issue #12 §3 — MFA disable: POST /api/auth/mfa/disable { code } ali { recoveryCode }
 * Onemogočanje zahteva veljavno TOTP kodo ALI recovery kodo (samo-obskažba).
 * Recovery koda se pri tem porabi (enkratna uporaba). Vse se auditira.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { totpVerify, consumeRecoveryCode } from '@/lib/mfa'
import { jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun nima MFA.', 400)

  const body = await req.json().catch(() => null)
  const code = String(body?.code || '').trim()
  const recoveryCode = String(body?.recoveryCode || '').trim()

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, mfaSecret: true, mfaEnabled: true, mfaRecoveryCodes: true, status: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (!employee.mfaEnabled || !employee.mfaSecret) return fail('MFA ni aktivirana.', 409)

  const storedHashes = jparse<string[]>(employee.mfaRecoveryCodes, [])
  let verified = false
  let usedRecovery = false
  let remainingHashes = storedHashes

  if (code) {
    verified = totpVerify(employee.mfaSecret, code) !== null
  } else if (recoveryCode && storedHashes.length > 0) {
    const consumed = consumeRecoveryCode(recoveryCode, storedHashes)
    verified = consumed.ok
    usedRecovery = consumed.ok
    remainingHashes = consumed.remaining
  } else {
    return fail('Podajte TOTP kodo (code) ali recovery kodo (recoveryCode).', 400)
  }

  if (!verified) return fail('Koda ni veljavna — MFA ostaja aktivna.', 401)

  await db.employee.update({
    where: { id: employee.id },
    data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null, mfaRecoveryCodes: jstr([]) },
  })
  await writeAudit(db, { userId: employee.id, action: 'MFA_DISABLED', entityType: 'Employee', entityId: employee.id, details: usedRecovery ? 'MFA onemogočena z recovery kodo.' : 'MFA onemogočena s TOTP kodo.', locationId: user.loc }).catch(() => {})

  return ok({ enabled: false })
}
