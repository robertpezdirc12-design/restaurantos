import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createToken, hashPin } from '@/lib/auth'
import { fail } from '@/lib/api'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const email = String(body?.email || '').trim().toLowerCase()
  const pin = String(body?.pin || '')
  if (!email || !pin) return fail('E-pošta in PIN sta obvezna.', 400)

  const employee = await db.employee.findUnique({ where: { email } })
  if (!employee || !employee.active) return fail('Napačen e-poštni naslov ali PIN.', 401)

  if (hashPin(pin, employee.pinSalt) !== employee.pinHash) {
    return fail('Napačen e-poštni naslov ali PIN.', 401)
  }

  const token = createToken({
    sub: employee.id,
    name: employee.name,
    role: employee.role,
    loc: employee.locationId,
  })

  return NextResponse.json({
    token,
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      locationId: employee.locationId,
      language: employee.language,
    },
  })
}
