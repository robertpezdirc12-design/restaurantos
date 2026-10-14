/**
 * Issue #12 §3 — MFA enroll: POST /api/auth/mfa/enroll { pin }
 * Generira TOTP skrivnost (še NE aktivira) + otpauth URI za QR.
 * Aktivacija gre šele prek /enable z veljavno kodo iz aplikacije.
 * Ponovni enroll na aktiviranem računu → 409 (najprej disable).
 *
 * Issue #33 (v1.94.0) — SVEŽ STEP-UP DOKAZ: obstoječi access token sam po sebi
 * NE zadostuje (ukraden 12-urni žeton bi lahko nastavil svojo skrivnost!).
 * Zahtevamo TRENUTNI PIN (pinStepUpOk — ista scrypt/pinLookup disciplina kot
 * prijava, timing-safe). Klientova trditev (reauthenticated ipd.) se ne sprejema.
 * Sočasen enroll CAS-varuje mfaSecret (stara vrednost v where) → točno en
 * zapis; izgubljen CAS → 409 (konflikt zaznan, najnovejši zapis zmagovalec).
 * Skrivnosti/URI se NE zapisujeta v audit.
 */
import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { generateSecret, otpauthUri } from '@/lib/mfa'
import { pinStepUpOk, mfaAttemptRateLimited } from '@/lib/mfa-stepup'

import { writeAudit } from '@/lib/audit-chain'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun ne more vpisati MFA (brez DB vrstice).', 400)

  const body = await req.json().catch(() => null)
  const pin = String(body?.pin || '')

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, email: true, mfaSecret: true, mfaEnabled: true, status: true, pin: true, pinLookup: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (employee.mfaEnabled) return fail('MFA je že aktivirana. Za spremembo najprej onemogočite (disable).', 409)

  // #32: namenski limit step-up poskusov po računu (IP limit login-a ga ne pokriva)
  if (await mfaAttemptRateLimited(`route:${employee.id}`)) {
    return fail('Preveč poskusov. Poskusite znova čez nekaj minut.', 429)
  }

  // #33: sveža potrditev identitete — brez PIN-a ali ob napačnem PIN-u
  // se mfaSecret NE spremeni (fail-closed, brez razloga v javni napaki).
  if (!pinStepUpOk(employee, pin)) {
    await writeAudit(db, {
      userId: employee.id, action: 'MFA_STEPUP_FAILED', entityType: 'Employee', entityId: employee.id,
      details: 'Napaka pri step-up potrditvi (PIN) pred MFA vpisom.', locationId: user.loc,
    }).catch(() => {})
    return fail('Potrditev identitete je obvezna — vnesite svoj PIN.', 401)
  }

  const secret = generateSecret()
  // CAS: uspe le, če se mfaSecret/mfaEnabled NISTA spremenila od prebranka —
  // sočasna zahteva izgubi (409) in NE prepisše tujega začetka vpisa.
  const cas = await db.employee.updateMany({
    where: { id: employee.id, mfaEnabled: false, mfaSecret: employee.mfaSecret },
    data: { mfaSecret: secret },
  })
  if (cas.count !== 1) {
    return fail('Zahtevek je bil medtem spremenjen (sočasen vpis MFA) — poskusite znova.', 409)
  }
  await writeAudit(db, { userId: employee.id, action: 'MFA_ENROLL_STARTED', entityType: 'Employee', entityId: employee.id, details: 'Generirana TOTP skrivnost (aktivacija šele z /enable; step-up PIN potrjen).', locationId: user.loc }).catch(() => {})

  // QR (png data-url, strežniško generiran — qrcode lib ostaja izven client
  // bundla) za enostavno dodajanje v Google Authenticator/Aegis.
  const qrDataUrl = await QRCode.toDataURL(otpauthUri(employee.email, secret), { margin: 1, width: 220 })
  return ok({ secret, otpauthUri: otpauthUri(employee.email, secret), qrDataUrl }, 201)
}
