/**
 * Issue #12 §3 — MFA enable: POST /api/auth/mfa/enable { code }
 * Preveri TOTP kodo proti vpsani skrivnosti → aktivira MFA + izda recovery kode
 * (plain SAMO enkrat v odgovoru; v DB gre samo SHA-256 hashi).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { totpVerify, generateRecoveryCodes, recoveryHashesToStore } from '@/lib/mfa'
import { nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun ne more aktivirati MFA (brez DB vrstice).', 400)

  const body = await req.json().catch(() => null)
  const code = String(body?.code || '').trim()
  if (!code) return fail('Koda iz avtentikacijske aplikacije je obvezna.', 400)

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, mfaSecret: true, mfaEnabled: true, status: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (!employee.mfaSecret) return fail('MFA ni vpisana — najprej /api/auth/mfa/enroll.', 400)
  if (employee.mfaEnabled) return fail('MFA je že aktivirana.', 409)

  if (totpVerify(employee.mfaSecret, code) === null) {
    return fail('Koda ni veljavna. Preverite čas na napravi in poskusite znova.', 401)
  }

  const recoveryCodes = generateRecoveryCodes(8)
  await db.employee.update({
    where: { id: employee.id },
    data: {
      mfaEnabled: true,
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: jstr(recoveryHashesToStore(recoveryCodes)),
    },
  })
  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'MFA_ENABLED', entityType: 'Employee', entityId: employee.id, details: 'MFA aktivirana (TOTP); 8 recovery kod izdanih (shranjeni hashi).', locationId: user.loc, id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2, id: __aId2, userId: employee.id, action: 'MFA_ENABLED', entityType: 'Employee', entityId: employee.id,
      details: 'MFA aktivirana (TOTP); 8 recovery kod izdanih (shranjeni hashi).', locationId: user.loc },
  }).catch(() => {})

  return ok({ enabled: true, recoveryCodes }, 200)
}
