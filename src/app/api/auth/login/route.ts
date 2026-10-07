import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createToken, employeePinFields, matchesBootstrap } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { fail } from '@/lib/api'
import { resolvePermissions, resolvePermissionsForUIRole } from '@/lib/permissions'

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

  const token = createToken({
    sub: employee.id,
    name: employee.name,
    role: roleToUI(employee.role),
    loc: employee.locationId,
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
  })
}
