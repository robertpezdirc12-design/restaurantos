import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapEmployee, roleToDB, jstr, nid } from '@/lib/map'

/**
 * EMPLOYEE CONTROL CENTER (R265) — en kanonski profil zaposlenega:
 *  - PATCH podatkov: vloga, status, DOVOLJENJA (permission overrides, R263/R264)
 *  - PIN reset (občutljiva akcija — vedno zapiše AUDIT zapis)
 * Kanonska avtorizacija (R268): samo ADMIN/MANAGER; MANAGER ne sme urejati ADMIN-ov.
 */

/** Kanonski seznam dovoljenj (nastavljivi override-i po zaposlenem) */
export const CANONICAL_PERMISSIONS = [
  'orders.create', 'orders.pay', 'kitchen.update', 'reservations.manage',
  'menu.manage', 'inventory.manage', 'reports.view', 'employees.manage',
  'settings.manage', 'furs.issue',
] as const

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj.', 403)
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const target = await db.employee.findUnique({ where: { id } })
  if (!target) return fail('Zaposleni ne obstaja.', 404)
  const targetRole = (target.role as string).toUpperCase()
  if (user.role === 'MANAGER' && targetRole === 'ADMIN') {
    return fail('MANAGER ne sme urejati ADMIN računa.', 403)
  }

  const data: Record<string, unknown> = {}
  const sensitive: string[] = []

  // vloga
  if (body.role !== undefined) {
    const role = String(body.role).toUpperCase()
    if (!['ADMIN', 'MANAGER', 'WAITER', 'KITCHEN'].includes(role)) return fail('Neznana vloga.', 400)
    if (user.role === 'MANAGER' && role === 'ADMIN') return fail('MANAGER ne dodeljuje ADMIN vloge.', 403)
    data.role = roleToDB(role)
    sensitive.push(`sprememba vloge v ${role}`)
  }
  // status
  if (body.status !== undefined) {
    const status = String(body.status)
    if (!['active', 'inactive', 'suspended'].includes(status)) return fail('Neznan status.', 400)
    if (target.id === user.sub && status !== 'active') return fail('Ne morete deaktivirati sebe.', 400)
    data.status = status
    if (status !== 'active') sensitive.push(`deaktivacija računa (${status})`)
  }
  // DOVOLJENJA (permission overrides)
  if (body.permissionOverrides !== undefined) {
    if (!Array.isArray(body.permissionOverrides)) return fail('permissionOverrides mora biti seznam.', 400)
    const valid = (body.permissionOverrides as string[]).filter((p) =>
      (CANONICAL_PERMISSIONS as readonly string[]).includes(p))
    if (valid.length !== body.permissionOverrides.length) return fail('Neznana dovoljenja.', 400)
    data.permissionOverrides = jstr(valid)
    sensitive.push('sprememba dovoljenj')
  }
  // PIN reset (občutljivo)
  let pinNote: string | null = null
  if (body.pin !== undefined) {
    const pin = String(body.pin)
    if (!/^\d{4,8}$/.test(pin)) return fail('PIN mora imeti 4–8 številk.', 400)
    const { employeePinFields } = await import('@/lib/auth')
    const fields = employeePinFields(pin, target.email)
    data.pin = fields.pin
    data.pinLookup = fields.pinLookup
    data.sessionVersion = (Number(target.sessionVersion) || 0) + 1
    sensitive.push('reset PIN-a')
    pinNote = `Zadnje številke: …${pin.slice(-2)}`
  }

  if (Object.keys(data).length === 0) return fail('Nič za posodobiti.', 400)

  const updated = await db.employee.update({ where: { id }, data })

  // AUDIT za občutljive akcije (SENSITIVE ACTION UX — R266: razlaga + sledljivost)
  if (sensitive.length > 0) {
    await db.auditLog.create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'EMPLOYEE_SENSITIVE_UPDATE',
        entityType: 'Employee',
        entityId: id,
        details: jstr({ by: user.sub, target: id, changes: sensitive, pinNote }),
      },
    }).catch(() => null)
  }

  return ok({ employee: mapEmployee(updated) })
}

/** Podrobnosti profila (kanonski vir za Control Center) */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const target = await db.employee.findUnique({ where: { id } })
  if (!target) return fail('Zaposleni ne obstaja.', 404)
  return ok({ employee: mapEmployee(target) })
}
