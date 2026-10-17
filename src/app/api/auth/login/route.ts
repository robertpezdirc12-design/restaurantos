import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createToken, employeePinFields, matchesBootstrap, timingSafeEqualStr } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { fail } from '@/lib/api'
import { rateLimitSharedAsync } from '@/lib/rate-limit'
import { resolvePermissions, resolvePermissionsForUIRole } from '@/lib/permissions'
import { totpVerify, roleRequiresMfa, mfaEnforcementActive, MFA_ENROLLMENT_ONLY_HOURS } from '@/lib/mfa'
import { claimTotpCounter, consumeRecoveryCodeAtomic, mfaAttemptRateLimited } from '@/lib/mfa-stepup'
import { jparse } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Prijava (email + PIN + druga stopnja MFA) — v1.94.0 utrjevanje #31/#32/#34/#35/#36:
 *
 *  #32 — distribuirana + večdimenzionalna zaščita pred ugibanjem:
 *   - IP limit (10/min) zdaj STORE-AWARE (rateLimitSharedAsync: Upstash, če je
 *     konfiguriran — vse instance delijo števec; izpad → BOUNDED-MEMORY fallback
 *     + glasen console.error — fallback NI globalna meja, kar je eksplicitno
 *     dokumentirano v lib/rate-limit.ts);
 *   - ločen ACCOUNT limit po normaliziranem e-poštnem naslovu: burst 10/min +
 *     progresivno vzdrževano okno 30/15 min (časovno omejen zaklep — NE trajen
 *     hard-lockout; žrtev DoS se samodejno opomore po okencu; javne napake
 *     ostanejo enake za vse vzroke — brez naštevanja računov);
 *   - IP signal: x-vercel-forwarded-for (platforma NASTAVI/prepiše — klient ga
 *     ne more ponarediti) > x-forwarded-for > 'unknown'.
 *
 *  #34 — bootstrap break-glass VEDNO ločena identiteta:
 *   veljavna BOOTSTRAP_ADMIN_EMAIL/PIN poverilnica izda SAMO sub='bootstrap'
 *   sejo (2 h) — NE izda nikoli žetona pod employee.id, tudi če za istim
 *     e-poštnim naslovom obstaja aktivni zaposleni (prej je napačen PIN +
 *     bootstrap skrivnost obšla MFA in izdala NAVADNO sejo zaposlenega!).
 *   Break-glass uspeh se auditira z lastnim dogodkom (LOGIN_BOOTSTRAP_*),
 *     LOGIN_FAILED pa ni končni zapis te poti.
 *
 *  #35 — atomarna poraba recovery kode (CAS na mfaRecoveryVersion):
 *   sočasna uporaba iste kode → točno ENA zmagovalka (preostale nedotaknjene).
 *
 *  #36 — RFC 6238 §5.2 replay zaščita TOTP: sprejet korak se atomarno zapiše
 *   (claimTotpCounter); enak/starejši korak ali sočasna ista koda → 401.
 *
 *  #31 — enforcement (MFA_ENFORCE_AFTER): privilegiran račun brez MFA dobi
 *   SAMO omejen mfa-enrollment-only žeton (1 h, samo /api/auth/mfa/** + me);
 *   brez enforcementa ostane mehka politika (mfaMandatory zastavica za UI).
 */

/** IP signal: platforma-postavljen header ima prednost (neponareljiv na Vercelu). */
function ipOf(req: NextRequest): string {
  const vff = req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
  if (vff) return vff
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function loginRateLimited(ip: string, email: string): Promise<boolean> {
  // IP dimenzija — burst 10/min (isti limit kot prej, zdaj store-aware)
  if (!(await rateLimitSharedAsync(`login:${ip}`, 10, 60_000)).allowed) return true
  // ACCOUNT dimenzija — burst 10/min + progresivno okno 30/15 min (brez
  // trajnega zaklepa: okence poteče, legitimna prijava se opomore sama)
  if (!(await rateLimitSharedAsync(`login-acct:${email}`, 10, 60_000)).allowed) return true
  if (!(await rateLimitSharedAsync(`login-acct15:${email}`, 30, 900_000)).allowed) return true
  return false
}

/** #34: break-glass prijava — VEDNO ločena bootstrap identiteta (2 h). */
async function bootstrapSession(email: string, ip: string, existingAccountId: string | null) {
  const token = createToken({ sub: 'bootstrap', name: 'Bootstrap Admin', email, role: 'ADMIN', loc: null }, 2)
  // Jasen dogodek za način prijave brez (uspešnega) PIN-a zaposlenega — brez
  // razkrivanja skrivnosti; LOGIN_FAILED ni končni zapis break-glass poti.
  await writeAudit(db, {
    userId: 'bootstrap',
    action: existingAccountId ? 'LOGIN_BOOTSTRAP_BREAKGLASS' : 'LOGIN_BOOTSTRAP_USED',
    entityType: 'Employee',
    entityId: existingAccountId || email,
    details: existingAccountId
      ? 'Break-glass prijava z bootstrap poverilnico na obstoječi e-poštni naslov (PIN ni bil uspešen) — izdana LOČENA bootstrap identiteta (2 h), ne seja zaposlenega.'
      : 'Break-glass prijava z bootstrap poverilnico (brez Employee vrstice) — izdana bootstrap identiteta (2 h).',
    ipAddress: ip,
  }).catch(() => {})
  return NextResponse.json({
    token,
    employee: { id: 'bootstrap', name: 'Bootstrap Admin', email, role: 'ADMIN', locationId: null, permissions: resolvePermissionsForUIRole('ADMIN') },
    bootstrap: true,
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email || '').trim().toLowerCase()
  const pin = String(body?.pin || '')
  if (!email || !pin) return fail('E-pošta in PIN sta obvezna.', 400)

  const ip = ipOf(req)
  if (await loginRateLimited(ip, email)) {
    // enaka javna napaka za IP/račun vzrok (brez naštevanja) + zaznava v auditu
    await writeAudit(db, {
      userId: 'anonymous', action: 'LOGIN_RATE_LIMITED', entityType: 'Employee', entityId: email,
      details: 'Presežen limit prijavnih poskusov (IP ali račun).', ipAddress: ip,
    }).catch(() => {})
    return fail('Preveč poskusov prijave. Poskusite znova kasneje.', 429)
  }

  // EKSPlicitni select (v1.94.0 hotfix): findUnique brez select je prebral VSA
  // skalarna polja — vključno z novima mfaLastTotpCounter/mfaRecoveryVersion,
  // ki na produkciji čakata DDL korak (migrate-issue31-36) → P2022 → login 500.
  // Z izbiro OBSTOJEČIH polj prijava deluje TUDI pred aplikacijo DDL.
  const employee = await db.employee.findUnique({
    where: { email },
    select: {
      id: true, name: true, email: true, role: true, status: true, locationId: true,
      sessionVersion: true, pin: true, pinLookup: true, permissionOverrides: true,
      mfaSecret: true, mfaEnabled: true, mfaRecoveryCodes: true,
    },
  })

  // #34: break-glass Preverba ZDAJ na enem mestu, PRED katero koli potjo
  // zaposlenega — velja za neobstoječi račun, deaktiviranega IN napačen PIN.
  // Nikoli ne izda seje pod employee.id (MFA se ne more obiti).
  if (matchesBootstrap(email, pin)) {
    return bootstrapSession(email, ip, employee?.id || null)
  }

  if (!employee || employee.status !== 'active') {
    // P0 audit (C1): neuspešne prijave se beležijo (prej: brute-force neviden v reviziji)
    await writeAudit(db, { userId: 'anonymous', action: 'LOGIN_FAILED', entityType: 'Employee', entityId: email, details: `Neuspešna prijava (neznan/deaktiviran račun: ${email}).`, ipAddress: ip }).catch(() => {})
    return fail('Napačen e-poštni naslov ali PIN.', 401)
  }

  // AUDIT-FIX v1.82.1: pinLookup/pin primerjavi sedaj timing-safe (enaka disciplina
  // kot verifyToken/matchesBootstrap — prej gola === primerjava nizov).
  // pinLookup je fiksno-dolgi hex digest — lowercase normalizacija je varna.
  const expected = employeePinFields(pin, employee.email)
  const pinOk =
    (employee.pinLookup && timingSafeEqualStr(employee.pinLookup.toLowerCase(), expected.pinLookup)) ||
    (employee.pin && timingSafeEqualStr(employee.pin, expected.pin))

  if (!pinOk) {
    // P0 audit (C1): neuspešna PIN prijava se beleži
    await writeAudit(db, { userId: employee.id, action: 'LOGIN_FAILED', entityType: 'Employee', entityId: employee.id, details: `Neuspešna prijava (napačen PIN): ${email}.`, ipAddress: ip, locationId: employee.locationId }).catch(() => {})
    return fail('Napačen e-poštni naslov ali PIN.', 401)
  }

  // Issue #12 §3 — MFA (TOTP / recovery koda) za prijavljene račune z mfaEnabled.
  // PIN prijava navadnih zaposlenih ostane nespremenjena; MFA je druga stopnja SAMO
  // ko je vklopljena na računu. Bootstrap (brez Employee vrstice) ostaja break-glass.
  if (employee.mfaEnabled && employee.mfaSecret) {
    // #32: NAMENSKI limit MFA poskusov po računu (IP limit ga ne nadomešča)
    if (await mfaAttemptRateLimited(employee.id)) {
      await writeAudit(db, {
        userId: employee.id, action: 'MFA_RATE_LIMITED', entityType: 'Employee', entityId: employee.id,
        details: 'Presežen limit MFA poskusov za račun.', ipAddress: ip, locationId: employee.locationId,
      }).catch(() => {})
      return fail('Preveč poskusov MFA kode. Poskusite znova čez nekaj minut.', 429)
    }
    const mfaCode = String(body?.mfaCode || '').trim()
    const mfaRecovery = String(body?.mfaRecoveryCode || '').trim()
    let mfaOk = false
    let usedRecovery = false
    if (mfaCode) {
      // #36: korak uspešne preverbe ATOMARNO zahtevamo (RFC 6238 §5.2) —
      // enak/starejši korak (replay ali sočasnost) → count=0 → 401.
      const counter = totpVerify(employee.mfaSecret, mfaCode)
      mfaOk = counter !== null && (await claimTotpCounter(employee.id, counter))
    } else if (mfaRecovery) {
      // #35: atomarna CAS poraba — sočasna ista koda → točno ena zmagovalka
      const consumed = await consumeRecoveryCodeAtomic(employee.id, mfaRecovery)
      mfaOk = consumed.ok
      usedRecovery = consumed.ok
    }
    if (!mfaOk) {
      await writeAudit(db, { userId: employee.id, action: 'MFA_LOGIN_FAILED', entityType: 'Employee', entityId: employee.id, details: 'Napačna ali manjkajoča MFA koda pri prijavi (ali ponovno uporabljena koda).', ipAddress: ipOf(req), locationId: employee.locationId }).catch(() => {})
      // 401 + mfaRequired zastavica — UI prikaže MFA korak; brez uhajanja ali mfaEnabled je vklopljena
      return NextResponse.json({ error: 'Zahtevana je druga stopnja prijave (MFA koda).', mfaRequired: true }, { status: 401 })
    }
    await writeAudit(db, { userId: employee.id, action: usedRecovery ? 'MFA_RECOVERY_USED' : 'MFA_LOGIN_SUCCESS', entityType: 'Employee', entityId: employee.id, details: 'MFA druga stopnja uspešna.', ipAddress: ipOf(req), locationId: employee.locationId }).catch(() => {})
  }

  const mfaMandatory = roleRequiresMfa(employee.role) && !employee.mfaEnabled

  // #31: STROGO uveljavljanje — privilegiran račun brez MFA dobi SAMO omejen
  // enrollment-only žeton (1 h; dostopen zgolj /api/auth/mfa/** + /me).
  // Migracijsko obdobje (MFA_ENFORCE_AFTER neveljaven ali v prihodnosti) ohranja
  // obstoječe obnašanje (poln žeton + mfaMandatory UI nagovor).
  if (mfaEnforcementActive() && mfaMandatory) {
    const enrollToken = createToken({
      sub: employee.id,
      name: employee.name,
      role: roleToUI(employee.role),
      loc: employee.locationId,
      sv: employee.sessionVersion,
      mfaEnrollOnly: true,
    }, MFA_ENROLLMENT_ONLY_HOURS)
    await writeAudit(db, {
      userId: employee.id, action: 'LOGIN_MFA_ENROLLMENT_REQUIRED', entityType: 'Employee', entityId: employee.id,
      details: 'Prijava uspešna (PIN), vloga zahteva MFA — izdana OMEJENA enrollment-only seja (1 h).',
      ipAddress: ip, locationId: employee.locationId,
    }).catch(() => {})
    return NextResponse.json({
      token: enrollToken,
      employee: {
        id: employee.id, name: employee.name, email: employee.email,
        role: roleToUI(employee.role), locationId: employee.locationId,
        permissions: [] as string[],
      },
      mfaMandatory: true,
      mfaEnrollmentRequired: true,
    })
  }

  const token = createToken({
    sub: employee.id,
    name: employee.name,
    role: roleToUI(employee.role),
    loc: employee.locationId,
    sv: employee.sessionVersion,
  })

  // P0 audit (C1): uspešna prijava se beleži (actor + IP)
  await writeAudit(db, { userId: employee.id, action: 'LOGIN_SUCCESS', entityType: 'Employee', entityId: employee.id, details: `Prijava uspešna.`, ipAddress: ip, locationId: employee.locationId }).catch(() => {})

  return NextResponse.json({
    token,
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: roleToUI(employee.role),
      locationId: employee.locationId,
      permissions: resolvePermissions(employee.role, employee.permissionOverrides),
    },
    // issue #12 §3: privilegiran račun brez MFA → UI nagovori enroll (ne blokira prijave — migracijsko varno)
    mfaMandatory,
  })
}
