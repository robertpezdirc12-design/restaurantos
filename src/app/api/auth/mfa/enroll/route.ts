/**
 * Issue #12 §3 — MFA enroll: POST /api/auth/mfa/enroll
 * Generira TOTP skrivnost (še NE aktivira) + otpauth URI za QR.
 * Aktivacija gre šele prek /enable z veljavno kodo iz aplikacije.
 * Ponovni enroll na aktiviranem računu → 409 (najprej disable).
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { generateSecret, otpauthUri } from '@/lib/mfa'
import { nid } from '@/lib/map'

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.sub === 'bootstrap') return fail('Bootstrap račun ne more vpisati MFA (brez DB vrstice).', 400)

  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { id: true, email: true, mfaEnabled: true, status: true },
  })
  if (!employee || employee.status !== 'active') return fail('Račun ni aktiven.', 403)
  if (employee.mfaEnabled) return fail('MFA je že aktivirana. Za spremembo najprej onemogočite (disable).', 409)

  const secret = generateSecret()
  await db.employee.update({
    where: { id: employee.id },
    data: { mfaSecret: secret },
  })
  await db.auditLog.create({
    data: { id: nid(), userId: employee.id, action: 'MFA_ENROLL_STARTED', entityType: 'Employee', entityId: employee.id,
      details: 'Generirana TOTP skrivnost (aktivacija šele z /enable).', locationId: user.loc },
  }).catch(() => {})

  return ok({ secret, otpauthUri: otpauthUri(employee.email, secret) }, 201)
}
