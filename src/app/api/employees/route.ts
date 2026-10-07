import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok } from '@/lib/api'
import { mapEmployee } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const employees = await db.employee.findMany({ orderBy: { name: 'asc' } })
  return ok({ employees: employees.map(mapEmployee) })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const email = String(body?.email || '').trim().toLowerCase()
  const name = String(body?.name || '').trim()
  const pin = String(body?.pin || '')
  if (!email || !name || !pin) return ok({ error: 'Ime, e-pošta in PIN so obvezni.' }, 400)
  const exists = await db.employee.findUnique({ where: { email } })
  if (exists) return ok({ error: 'Zaposleni s to e-pošto že obstaja.' }, 409)
  const { employeePinFields } = await import('@/lib/auth')
  const { roleToDB } = await import('@/lib/map')
  const fields = employeePinFields(pin, email)
  const employee = await db.employee.create({
    data: {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 25),
      name,
      email,
      role: roleToDB(body.role || 'WAITER'),
      status: 'active',
      locationId: body.locationId ?? user.loc ?? null,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  return ok({ employee: mapEmployee(employee) }, 201)
}
