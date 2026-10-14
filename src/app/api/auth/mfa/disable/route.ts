/**
 * Issue #12 §3 — MFA disable: POST /api/auth/mfa/disable { pin, code | recoveryCode }
 * Onemogočanje zahteva TOTP kodo ALI recovery kodo (samo-obskrba) — v1.94.0
 * dodaja še SVEŽ PIN (step-up, issue #33): ukraden token + opažena TOTP koda
 * brez PIN-a NE zadostujeta več.
 *
 * Issue #33/#35 (v1.94.0):
 *  - recovery poraba je ATOMARNA (consumeRecoveryCodeAtomic — CAS na
 *    mfaRecoveryVersion; poražena koda → 401, brez izdaje žetona/konca MFA);
 *  - ob uspehu sessionVersion +1 → VSE druge seje preklicane; trenutni klient
 *    dobi NADALJEVALNI žeton (sv usklajen) v odgovoru;
 *  - mfaRecoveryVersion se poviša ob vsakem zapisu seznama (tudi praznega);
 *  - mfaLastTotpCounter se počisti (naslednja aktivacija začne na novo);
 *  - TOTP koda pri disable se NE porabi kot prijavni korak (login samo —
 *    dokumentirano; disable je že step-up: PIN + koda).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { totpVerify } from '@/lib/mfa'
import { pinStepUpOk, consumeRecoveryCodeAtomic, mfaAttemptRateLimited } from '@/lib/mfa-stepup'
import { jstr } from '@/lib/map'
import { createToken } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun nima MFA.', 400)

  const body = await req.json().catch(() => null)
  const pin = String(body?.pin || '')
  const code = String(body?.code || '').trim()
  const recoveryCode = String(body?.recoveryCode || '').trim()

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, email: true, name: true, role: true, locationId: true, mfaSecret: true, mfaEnabled: true, status: true, sessionVersion: true, pin: true, pinLookup: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (!employee.mfaEnabled || !employee.mfaSecret) return fail('MFA ni aktivirana.', 409)

  if (await mfaAttemptRateLimited(`route:${employee.id}`)) {
    return fail('Preveč poskusov. Poskusite znova čez nekaj minut.', 429)
  }

  // #33: step-up PIN — obvezna sveža potrditev lastništva računa
  if (!pinStepUpOk(employee, pin)) {
    await writeAudit(db, {
      userId: employee.id, action: 'MFA_STEPUP_FAILED', entityType: 'Employee', entityId: employee.id,
      details: 'Napaka pri step-up potrditvi (PIN) pred izklopom MFA.', locationId: user.loc,
    }).catch(() => {})
    return fail('Potrditev identitete je obvezna — vnesite svoj PIN.', 401)
  }

  let verified = false
  let usedRecovery = false

  if (code) {
    verified = totpVerify(employee.mfaSecret, code) !== null
  } else if (recoveryCode) {
    // #35: atomarna poraba — sočasnost/replay → točno ena zmagovalka
    const consumed = await consumeRecoveryCodeAtomic(employee.id, recoveryCode)
    verified = consumed.ok
    usedRecovery = consumed.ok
  } else {
    return fail('Podajte TOTP kodo (code) ali recovery kodo (recoveryCode).', 400)
  }

  if (!verified) return fail('Koda ni veljavna — MFA ostaja aktivna.', 401)

  const newSv = (Number(employee.sessionVersion) || 0) + 1
  await db.employee.update({
    where: { id: employee.id },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaEnrolledAt: null,
      mfaRecoveryCodes: jstr([]),
      mfaRecoveryVersion: { increment: 1 },
      mfaLastTotpCounter: null,
      sessionVersion: newSv,
    },
  })

  const continuation = createToken({
    sub: employee.id,
    name: employee.name,
    role: roleToUI(employee.role),
    loc: employee.locationId,
    sv: newSv,
  })

  await writeAudit(db, {
    userId: employee.id, action: 'MFA_DISABLED', entityType: 'Employee', entityId: employee.id,
    details: usedRecovery ? 'MFA onemogočena z recovery kodo (atomarno porabljena) + step-up PIN.' : 'MFA onemogočena s TOTP kodo + step-up PIN. Vsi drugi žetoni preklicani (sessionVersion +1), nadaljevalni žeton izdan.',
    locationId: user.loc,
  }).catch(() => {})

  return ok({ enabled: false, token: continuation }, 200)
}
