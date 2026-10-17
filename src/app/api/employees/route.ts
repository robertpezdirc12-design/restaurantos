import { NextRequest } from 'next/server'
import type { EmployeeRole } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { mapEmployee, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const employees = await db.employee.findMany({ where: await locationScope(user), orderBy: { name: 'asc' } })
  return ok({ employees: employees.map(mapEmployee) })
}

/**
 * Nov zaposleni.
 * N3 (audit P1): kanonično dovoljenje `employees.manage` namesto trdo kodiranih vlog —
 * enterprise vloge s to pravico in permissionOverrides delujejo na pisanje (DB lookup).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
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
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  // Issue #5 (P0, komentar #3): POST prej NI IMEL eskalacijskih pravil — MANAGER
  // (ima employees.manage) je lahko ustvaril OWNER/ADMIN račun = popoln prevzem.
  // Zrcali PATCH matrico: ENTERPRISE vloge + ADMIN + OWNER sme ustvariti samo
  // centralna vloga (OWNER/ADMIN); MANAGER sme ustvarjati samo operativne vloge.
  // ISSUE #72 C2: MANAGER je prav tako vodstvena vloga — vodja ne sme ustvarjati
  // vodij (veriga MANAGER → MANAGER → poljubni override-i je vodila do vseh 20
  // pravic pri vsakem novem vodji). Ustvarjanje MANAGER-ja = centralna vloga.
  const requestedRole = String(body.role || 'WAITER').toUpperCase()
  const ENTERPRISE_ROLES = ['GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER', 'WAREHOUSE', 'ACCOUNTING']
  const PRIVILEGED_ROLES = ['OWNER', 'ADMIN', 'MANAGER', ...ENTERPRISE_ROLES]
  if (PRIVILEGED_ROLES.includes(requestedRole) && !isCentralRole(user)) {
    return fail(`Vloga ${requestedRole} je privilegirana — ustvari jo lahko samo OWNER ali ADMIN.`, 403)
  }
  // ISSUE #72 B2: operativne vloge ZAHTEVAJOJO lokacijo (prej je prazna vrednost
  // tiho ustvarila »delavca, ki vidi prazne sezname« — 9/11 računov v produkciji
  // brez lokacije). Centralne vloge (računovodstvo, uprava) smejo ostati brez nje —
  // v UI je to izrecno zapisano, ne pa skrita prazna vrednost.
  const OPERATIVE_ROLES = ['WAITER', 'BAR', 'KITCHEN', 'CHEF', 'CLEANER', 'MANAGER']
  if (OPERATIVE_ROLES.includes(requestedRole) && !locationId) {
    return fail('Operativna vloga zahteva dodeljeno lokacijo — izberite poslovalnico.', 400)
  }
  if (!/^\d{4,8}$/.test(pin)) return ok({ error: 'PIN mora imeti 4–8 številk.' }, 400)
  const fields = employeePinFields(pin, email)
  let employee
  try {
    employee = await db.employee.create({
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
  } catch (e: unknown) {
    // Task 42: race okno med findUnique in create (email @unique) — P2002 → 409, ne 500
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return ok({ error: 'Zaposleni s to e-pošto že obstaja.' }, 409)
    }
    throw e
  }
  // 33-c (audit §6): kreiranje zaposlenega je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'EMPLOYEE_CREATE', entityType: 'Employee', entityId: employee.id, details: jstr({ name: employee.name, email: employee.email, role: employee.role, status: employee.status }), locationId: locationId })
  return ok({ employee: mapEmployee(employee) }, 201)
}
