import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapEmployee, roleToDB, jstr, jparse } from '@/lib/map'
import { CANONICAL_PERMISSIONS, FULL_ONLY_PERMISSIONS } from '@/lib/permissions'
import { writeAudit } from '@/lib/audit-chain'

export { CANONICAL_PERMISSIONS }

/**
 * EMPLOYEE CONTROL CENTER (R265) — en kanonski profil zaposlenega:
 *  - PATCH podatkov: vloga (tudi enterprise vloge — P2 N7), status, DOVOLJENJA (permission overrides, R263/R264)
 *  - PIN reset (občutljiva akcija — vedno zapiše AUDIT zapis)
 * Kanonska avtorizacija (R268 + N3 audit P1): dovoljenje `employees.manage`
 * (DB lookup — override-i delujejo); MANAGER ne sme urejati ADMIN-ov,
 * LASTNIKove zaščite ostajajo nespremenjene.
 * P2 audit N7: enterprise vloge (group_owner|org_admin|property_manager|warehouse|accounting)
 * dodeljujejo SAMO centralne vloge (OWNER/ADMIN; bootstrap admin je ADMIN); MANAGER ne sme
 * dodeliti nobene vloge nad MANAGER.
 */

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // N3 (audit P1): kanonično dovoljenje namesto trdo kodiranih vlog; pravila o stopnjevanju
  // (MANAGER↛ADMIN, LASTNIKA ureja samo LASTNIK) ostajajo nespremenjena spodaj.
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const target = await db.employee.findUnique({ where: { id } })
  if (!target) return fail('Zaposleni ne obstaja.', 404)
  // Issue #4 §1: PIN reset / urejanje čez lokacije = identiteta theft — fail-closed
  const locRes = await guardResource(user, target.locationId)
  if (locRes) return locRes
  const targetRole = (target.role as string).toUpperCase()
  if (user.role === 'MANAGER' && targetRole === 'ADMIN') {
    return fail('MANAGER ne sme urejati ADMIN računa.', 403)
  }
  // LASTNIK/BOSS zaščita (issue #1, komentar: vloge): samo LASTNIK ureja LASTNIKA
  if (targetRole === 'OWNER' && user.role !== 'OWNER') {
    return fail('Samo LASTNIK lahko ureja LASTNIKOV račun.', 403)
  }

  const data: Record<string, unknown> = {}
  const sensitive: string[] = []

  // vloga
  if (body.role !== undefined) {
    const role = String(body.role).toUpperCase()
    // P2 audit N7: enterprise vloge (issue #11 §1 — kanonični seznam iz ROLE_DEFAULTS)
    // AUDIT-FIX v1.82.1: CLEANER dodan v BASE_ROLES — vloga je obstajala v RBAC
    // (permissions.ts ROLE_DEFAULTS['cleaner']), UI dropdownu in i18n, a PATCH jo je
    // zavrnil z 400 "Neznana vloga" (mrtva koda migracije cleaner-role).
    const BASE_ROLES = ['ADMIN', 'MANAGER', 'WAITER', 'BAR', 'KITCHEN', 'OWNER', 'CLEANER']
    const ENTERPRISE_ROLES = ['GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER', 'WAREHOUSE', 'ACCOUNTING']
    if (!BASE_ROLES.includes(role) && !ENTERPRISE_ROLES.includes(role)) return fail('Neznana vloga.', 400)
    // N7: enterprise vloge dodeljuje SAMO centralna vloga (OWNER/ADMIN) — MANAGER ne
    if (ENTERPRISE_ROLES.includes(role) && !isCentralRole(user)) {
      return fail('Enterprise vloge dodeljujejo samo OWNER ali ADMIN.', 403)
    }
    if (user.role === 'MANAGER' && role === 'ADMIN') return fail('MANAGER ne dodeljuje ADMIN vloge.', 403)
    // ISSUE #72 C2: MANAGER je vodstvena vloga — njeno dodeljevanje je rezervirano
    // za centralne vloge (prej: vodja je ustvaril vodjo, ta spet vodjo … vsak z
    // employees.manage in poljubnimi override-i = veriga prevzema)
    if (role === 'MANAGER' && !isCentralRole(user)) {
      return fail('Vlogo MANAGER dodeljujejo samo OWNER ali ADMIN.', 403)
    }
    // LASTNIKA dodeljuje LASTNIK ali ADMIN (prvi lastnik); urejati/odvzeti pa samo LASTNIK
    if (role === 'OWNER' && !['OWNER', 'ADMIN'].includes(user.role)) return fail('Samo LASTNIK dodeljuje LASTNIKA.', 403)
    if (targetRole === 'OWNER' && role !== 'OWNER' && user.role !== 'OWNER') {
      return fail('Samo LASTNIK lahko spremeni LASTNIKOVO vlogo.', 403)
    }
    data.role = roleToDB(role)
    // Issue #5 (P0 §B): sprememba vloge TAKOJ odpove stare seje (prej je 12h žeton
    // obdržal staro vlogo — requireAuth sicer preverja status/sv, vloga v žetonu
    // pa je ostala priviligirana do izteka)
    if (roleToDB(role) !== target.role) {
      data.sessionVersion = (Number(target.sessionVersion) || 0) + 1
    }
    sensitive.push(`sprememba vloge v ${role}`)
  }
  // status
  if (body.status !== undefined) {
    const status = String(body.status)
    if (!['active', 'inactive', 'suspended'].includes(status)) return fail('Neznan status.', 400)
    if (target.id === user.sub && status !== 'active') return fail('Ne morete deaktivirati sebe.', 400)
    if (targetRole === 'OWNER' && status !== 'active' && user.role !== 'OWNER') {
      return fail('Samo LASTNIK lahko deaktivira LASTNIKA.', 403)
    }
    data.status = status
    if (status !== 'active') {
      sensitive.push(`deaktivacija računa (${status})`)
      // Issue #4 D4: deaktivacija TAKOJ prekliče vse seje (žetoni živijo do 12 h)
      data.sessionVersion = (Number(target.sessionVersion) || 0) + 1
    }
  }
  // DOVOLJENJA (permission overrides)
  if (body.permissionOverrides !== undefined) {
    if (!Array.isArray(body.permissionOverrides)) return fail('permissionOverrides mora biti seznam.', 400)
    const valid = (body.permissionOverrides as string[]).filter((p) =>
      (CANONICAL_PERMISSIONS as readonly string[]).includes(p))
    if (valid.length !== body.permissionOverrides.length) return fail('Neznana dovoljenja.', 400)
    // ISSUE #72 C2 + ISSUE #75 5.1: stropovi — lastniške ključe (settings.manage,
    // receipts.storno, einvoices.issue — glej FULL_ONLY_PERMISSIONS) in
    // employees.manage sme DODATI samo centralna vloga — vodja/upravnik s
    // employees.manage bi si sicer lahko gojil naslednjega vodjo, odpiral globalne
    // nastavitve ali podeljeval fiskalna pooblastila. ODVZEM je vedno dovoljen
    // (privilegij se zmanjša, nikoli poveča).
    const targetExisting = jparse<string[]>(target.permissionOverrides, [])
    const addingPrivileged = valid.some((p) =>
      ((FULL_ONLY_PERMISSIONS as readonly string[]).includes(p) || p === 'employees.manage')
      && !targetExisting.includes(p))
    if (addingPrivileged && !isCentralRole(user)) {
      return fail('Dodeljevanje lastniških ključev (settings.manage, receipts.storno, einvoices.issue) in employees.manage je rezervirano za OWNER ali ADMIN.', 403)
    }
    data.permissionOverrides = jstr(valid)
    // Issue #6 §A (P0): sprememba dovoljenj prekliče stare seje — enaka disciplina
    // kot vloga/PIN/lokacija/status. requirePermission sicer razrešuje pravice iz
    // DB pri vsakem klicu (takojšen učinek na strežniku), a žeton v žepu (UI iz
    // localStorage, handheld offline vrsta) ostaja samozavesten do izteka —
    // sessionVersion ga pošlje na ponovno prijavo.
    data.sessionVersion = (Number(target.sessionVersion) || 0) + 1
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

  // Triage ⑧ — pravice po lokaciji: dodelitev zaposlenega poslovalnici.
  // Lokacija določa dostop do podatkov (fail-closed scoping), zato je sprememba
  // občutljiva: + sessionVersion (žeton nosi staro lokacijo → ponovna prijava).
  if (body.locationId !== undefined) {
    const locId = String(body.locationId || '').trim()
    if (!locId) return fail('Lokacija je obvezna — podaj locationId.', 400)
    if (locId !== target.locationId) {
      const loc = await db.location.findUnique({ where: { id: locId }, select: { id: true, name: true, isActive: true } })
      if (!loc) return fail('Lokacija ne obstaja.', 404)
      data.locationId = locId
      data.sessionVersion = (Number(target.sessionVersion) || 0) + 1
      sensitive.push(`sprememba lokacije v ${loc.name}${loc.isActive ? '' : ' (NEAKTIVNA)'}`)
    }
  }

  if (Object.keys(data).length === 0) return fail('Nič za posodobiti.', 400)

  const updated = await db.employee.update({ where: { id }, data })

  // AUDIT za občutljive akcije (SENSITIVE ACTION UX — R266: razlaga + sledljivost)
  if (sensitive.length > 0) {
    await writeAudit(db, { userId: user.sub, action: 'EMPLOYEE_SENSITIVE_UPDATE', entityType: 'Employee', entityId: id, details: jstr({ by: user.sub, target: id, changes: sensitive, pinNote }) }).catch(() => null)
  }

  return ok({ employee: mapEmployee(updated) })
}

/** Podrobnosti profila (kanonski vir za Control Center) — issue #28:
 *  SAMO lastni profil ALI employees.manage + tenant varovalka (lokacijska plast za
 *  osebje, org plast za centralne vloge). Prej: vsak prijavljeni na isti lokaciji
 *  je prebral e-pošto/telefon/dovoljenja kolega (samo requireAuth + lokacijska
 *  enakost), centralne vloge pa TUDI profile tujih organizacij (brez org preverbe).
 *  mapEmployee DTO ne nosi PIN/pinLookup/plače/IBAN (nikoli ni nosil). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const target = await db.employee.findUnique({ where: { id } })
  if (!target) return fail('Zaposleni ne obstaja.', 404)
  // lastni profil: vedno dostopen (Control Center lastnega računa)
  if (user.sub === id) return ok({ employee: mapEmployee(target) })
  // tuji profil: najmanjša pravica (employees.manage — enaka kot seznam) + obseg
  const gate = await requirePermission(req, 'employees.manage')
  if (isResponse(gate)) return gate
  const guard = await guardResource(user, target.locationId)
  if (guard) return guard
  return ok({ employee: mapEmployee(target) })
}
