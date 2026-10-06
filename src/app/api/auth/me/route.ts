import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    include: { location: { select: { id: true, name: true } } },
  })
  if (!employee) return ok({ error: 'Zaposleni ne obstaja' }, 404)
  return ok({
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: employee.role,
      language: employee.language,
      location: employee.location,
    },
  })
}
