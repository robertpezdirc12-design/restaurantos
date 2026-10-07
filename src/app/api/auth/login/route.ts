import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createToken, employeePinFields, matchesBootstrap } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { fail } from '@/lib/api'
import { resolvePermissions, resolvePermissionsForUIRole } from '@/lib/permissions'
import { totpVerify, consumeRecoveryCode, roleRequiresMfa } from '@/lib/mfa'
import { nid, jparse } from '@/lib/map'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email || '').trim().toLowerCase()
  const pin = String(body?.pin || '')
  if (!email || !pin) return fail('E-pošta in PIN sta obvezna.', 400)

  const employee = await db.employee.findUnique({ where: { email } })
  if (!employee || employee.status !== 'active') {
    if (!employee && matchesBootstrap(email, pin)) {
      const token = createToken({ sub: 'bootstrap', name: 'Bootstrap Admin', role: 'ADMIN', loc: null }, 2)
      return NextResponse.json({
        token,
        employee: { id: 'bootstrap', name: 'Bootstrap Admin', email, role: 'ADMIN', locationId: null, permissions: resolvePermissionsForUIRole('ADMIN') },
        bootstrap: true,
      })
    }
    return fail('Napačen e-poštni naslov ali PIN.', 401)
  }

  const expected = employeePinFields(pin, employee.email)
  const pinOk =
    (employee.pinLookup && employee.pinLookup === expected.pinLookup) ||
    (employee.pin && employee.pin === expected.pin)

  if (!pinOk) {
    if (matchesBootstrap(email, pin)) {
      const token = createToken({
        sub: employee.id,
        name: employee.name,
        role: roleToUI(employee.role),
        loc: employee.locationId,
        sv: employee.sessionVersion,
      }, 2)
      return NextResponse.json({
        token,
        employee: {
          id: employee.id, name: employee.name, email: employee.email,
          role: roleToUI(employee.role), locationId: employee.locationId,
          permissions: resolvePermissions(employee.role, employee.permissionOverrides),
        },
        bootstrap: true,
      })
    }
    return fail('Napačen e-poštni naslov ali PIN.', 401)
  }

  // Issue #12 §3 — MFA (TOTP / recovery koda) za prijavljene račune z mfaEnabled.
  // PIN prijava navadnih zaposlenih ostane nespremenjena; MFA je druga stopnja SAMO
  // ko je vklopljena na računu. Bootstrap (brez Employee vrstice) ostane break-glass.
  const storedRecovery = jparse<string[]>(employee.mfaRecoveryCodes, [])
  if (employee.mfaEnabled && employee.mfaSecret) {
    const mfaCode = String(body?.mfaCode || '').trim()
    const mfaRecovery = String(body?.mfaRecoveryCode || '').trim()
    let mfaOk = false
    let usedRecovery = false
    if (mfaCode) {
      mfaOk = totpVerify(employee.mfaSecret, mfaCode) !== null
    } else if (mfaRecovery && storedRecovery.length > 0) {
      const consumed = consumeRecoveryCode(mfaRecovery, storedRecovery)
      mfaOk = consumed.ok
      usedRecovery = consumed.ok
      if (consumed.ok) {
        await db.employee.update({ where: { id: employee.id }, data: { mfaRecoveryCodes: JSON.stringify(consumed.remaining) } })
      }
    }
    if (!mfaOk) {
      await db.auditLog.create({
        data: { id: nid(), userId: employee.id, action: 'MFA_LOGIN_FAILED', entityType: 'Employee', entityId: employee.id,
          details: 'Napačna ali manjkajoča MFA koda pri prijavi.', ipAddress: ipOf(req), locationId: employee.locationId },
      }).catch(() => {})
      // 401 + mfaRequired zastavica — UI prikaže MFA korak; brez uhajanja ali mfaEnabled je vklopljena
      return NextResponse.json({ error: 'Zahtevana je druga stopnja prijave (MFA koda).', mfaRequired: true }, { status: 401 })
    }
    await db.auditLog.create({
      data: { id: nid(), userId: employee.id, action: usedRecovery ? 'MFA_RECOVERY_USED' : 'MFA_LOGIN_SUCCESS', entityType: 'Employee', entityId: employee.id,
        details: 'MFA druga stopnja uspešna.', ipAddress: ipOf(req), locationId: employee.locationId },
    }).catch(() => {})
  }

  const mfaMandatory = roleRequiresMfa(employee.role) && !employee.mfaEnabled
  const token = createToken({
    sub: employee.id,
    name: employee.name,
    role: roleToUI(employee.role),
    loc: employee.locationId,
    sv: employee.sessionVersion,
  })

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

function ipOf(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}
