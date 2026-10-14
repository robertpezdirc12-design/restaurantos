import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { roleToUI } from '@/lib/map'
import { resolvePermissions } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    // select (v1.94.0 hotfix): namesto include (ki prebere VSA skalarna polja —
    // novi MFA stolpci čakajo DDL na produkciji → P2022). Izbrana obstoječa polja.
    select: {
      id: true, name: true, email: true, role: true, permissionOverrides: true,
      Location: { select: { id: true, name: true } },
    },
  })
  if (!employee) return ok({ error: 'Zaposleni ne obstaja' }, 404)
  return ok({
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      role: roleToUI(employee.role),
      location: employee.Location,
      permissions: resolvePermissions(employee.role, employee.permissionOverrides),
    },
  })
}
