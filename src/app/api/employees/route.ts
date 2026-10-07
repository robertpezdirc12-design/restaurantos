import { NextRequest } from 'next/server'
import { EmployeeRole } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, locationScope, requireUserLocation } from '@/lib/api'
import { mapEmployee } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const employees = await db.employee.findMany({ where: locationScope(user), orderBy: { name: 'asc' } })
  return ok({ employees: employees.map(mapEmployee) })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const email = String(body?.email || '').trim().toLowerCase()
  const name = String(body?.name || '').trim()
  const pin = String(body?.pin || '')
  if (!email || !name || !pin) return ok({ error: 'Ime, e-pošta in PIN so obvezni.' }, 400)
  const exists = await db.employee.findUnique({ where: { email } })
  if (exists) return ok({ error: 'Zaposleni s to e-pošto že obstaja.' }, 409)
  const { employeePinFields } = await import('@/lib/auth')
  const { roleToDB } = await import('@/lib/map')
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const fields = employeePinFields(pin, email)
  const employee = await db.employee.create({
    data: {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 25),
      name,
      email,
      role: roleToDB(body.role || 'WAITER') as EmployeeRole,
      status: 'active',
      locationId,
      pin: fields.pin,
      pinLookup: fields.pinLookup,
    },
  })
  return ok({ employee: mapEmployee(employee) }, 201)
}
