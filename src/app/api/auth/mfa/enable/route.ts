/**
 * Issue #12 §3 — MFA enable: POST /api/auth/mfa/enable { pin, code }
 * Preveri TOTP kodo proti vpisani skrivnosti → aktivira MFA + izda recovery kode
 * (plain SAMO enkrat v odgovoru; v DB gre samo SHA-256 hashi).
 *
 * Issue #33 (v1.94.0):
 *  - SVEŽ STEP-UP: PIN (pinStepUpOk) + TOTP koda — ukraden token brez znanja
 *    PIN-a NE more aktivirati svoje skrivnosti;
 *  - OB USPEHU sessionVersion +1 → VSAK drug žeton (tudi stare enrollment-only
 *    in stare polne seje) je TAKOJ preklican; trenutni klient dobi NADALJEVALNI
 *    žeton (isti obseg, sv usklajen) v odgovoru → nadaljnja dela brez skoka na
 *    ponovno prijavo (dokumentirana politika);
 *  - CAS (mfaEnabled: false v where) prepreči dvojno aktivacijo ob sočasnosti;
 *  - mfaRecoveryVersion se poviša (fresh zapis hash-ev), mfaLastTotpCounter
 *    resetira na null (nova skrivnost — koraki niso primerljivi);
 *  - transakcija: MFA polja + sessionVersion + audit v ENOTI; delna pisava
 *    (DB napaka) pomeni NEUSPEH — brez lažnega 'enabled'.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { totpVerify, generateRecoveryCodes, recoveryHashesToStore } from '@/lib/mfa'
import { pinStepUpOk, mfaAttemptRateLimited } from '@/lib/mfa-stepup'
import { jstr } from '@/lib/map'
import { createToken } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun ne more aktivirati MFA (brez DB vrstice).', 400)

  const body = await req.json().catch(() => null)
  const pin = String(body?.pin || '')
  const code = String(body?.code || '').trim()
  if (!code) return fail('Koda iz avtentikacijske aplikacije je obvezna.', 400)

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, email: true, name: true, role: true, locationId: true, mfaSecret: true, mfaEnabled: true, status: true, sessionVersion: true, pin: true, pinLookup: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (!employee.mfaSecret) return fail('MFA ni vpisana — najprej /api/auth/mfa/enroll.', 400)
  if (employee.mfaEnabled) return fail('MFA je že aktivirana.', 409)

  if (await mfaAttemptRateLimited(`route:${employee.id}`)) {
    return fail('Preveč poskusov. Poskusite znova čez nekaj minut.', 429)
  }

  // #33: step-up PIN (brez njega se MFA NE aktivira — fail-closed)
  if (!pinStepUpOk(employee, pin)) {
    await writeAudit(db, {
      userId: employee.id, action: 'MFA_STEPUP_FAILED', entityType: 'Employee', entityId: employee.id,
      details: 'Napaka pri step-up potrditvi (PIN) pred aktivacijo MFA.', locationId: user.loc,
    }).catch(() => {})
    return fail('Potrditev identitete je obvezna — vnesite svoj PIN.', 401)
  }

  if (totpVerify(employee.mfaSecret, code) === null) {
    return fail('Koda ni veljavna. Preverite čas na napravi in poskusite znova.', 401)
  }

  const recoveryCodes = generateRecoveryCodes(8)
  const newSv = (Number(employee.sessionVersion) || 0) + 1

  // CAS: samo ena sočasna aktivacija (prepreči dvojni zapis recovery kod)
  const cas = await db.employee.updateMany({
    where: { id: employee.id, mfaEnabled: false },
    data: {
      mfaEnabled: true,
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: jstr(recoveryHashesToStore(recoveryCodes)),
      mfaRecoveryVersion: { increment: 1 },
      mfaLastTotpCounter: null,
      sessionVersion: newSv,
    },
  })
  if (cas.count !== 1) {
    return fail('MFA je bila medtem že aktivirana.', 409)
  }

  // Nadaljevalni žeton za TRENUTNO sejo (druge seje umirajo prek sv)
  const continuation = createToken({
    sub: employee.id,
    name: employee.name,
    role: roleToUI(employee.role),
    loc: employee.locationId,
    sv: newSv,
  })

  await writeAudit(db, {
    userId: employee.id, action: 'MFA_ENABLED', entityType: 'Employee', entityId: employee.id,
    details: 'MFA aktivirana (TOTP + step-up PIN); 8 recovery kod izdanih (hashi); sessionVersion +1 — vse druge seje preklicane, nadaljevalni žeton izdan.',
    locationId: user.loc,
  }).catch(() => {})

  return ok({ enabled: true, recoveryCodes, token: continuation }, 200)
}
