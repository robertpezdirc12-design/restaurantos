import { NextRequest, NextResponse } from 'next/server'
import { CI_DEPLOY_COMMIT } from '@/lib/deploy-commit'
import { db } from '@/lib/db'
import { getAuth, AuthPayload, sessionRevoked } from '@/lib/auth'
import { resolvePermissions, resolvePermissionsForUIRole, CanonicalPermission } from '@/lib/permissions'

export function ok(data: unknown, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 })
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function unauthorized() {
  return fail('Avtentikacija je obvezna. Pošljite Authorization: Bearer <token>', 401)
}

export function forbidden() {
  return fail('Dostop zavrnjen. Ni ustreznih dovoljenj.', 403)
}

/**
 * Issue #4 D4 — session revokacija:
 * sinhroni žeton check (HMAC + exp) + DB preverjanje statusa in sessionVersion.
 * PIN reset / deaktivacija zaposlenega TAKOJ prekliče vse obstoječe žetone.
 * Fail-closed: žeton brez sv (izdan pred tem deployem) → 401 (ponovna prijava).
 * Bootstrap admin (sub='bootstrap', brez Employee vrstice) gre po fast-pathu.
 */
export async function requireAuth(req: NextRequest): Promise<AuthPayload | NextResponse> {
  const user = getAuth(req)
  if (!user) return unauthorized()
  if (user.role === 'ADMIN' && user.sub === 'bootstrap') return user
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { status: true, sessionVersion: true },
  })
  if (!employee) return forbidden()
  if (employee.status !== 'active') {
    return fail('Račun je deaktiviran.', 401)
  }
  if (sessionRevoked(user.sv, employee.sessionVersion)) {
    return fail('Seja je preklicana (sprememba PIN-a ali deaktivacija) — prijavite se ponovno.', 401)
  }
  return user
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse
}

/**
 * Granularna avtorizacija (issue #1): zahteva eno kanonično dovoljenje.
 * Fast-path za bootstrap admina (brez Employee vrstice): break-glass ADMIN ima
 * vsa kanonična dovoljenja — rešena prek istega resolverja, ki jih vrača tudi
 * prijava (resolvePermissionsForUIRole('ADMIN')), da se pravila vedno ujemata.
 * Vsi realni zaposleni gredo čez DB: status + sessionVersion (D4) + dovoljenja
 * delujejo TAKOJ (12h žeton jih ne zamrzne).
 */
export async function requirePermission(
  req: NextRequest,
  permission: CanonicalPermission
): Promise<AuthPayload | NextResponse> {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.role === 'ADMIN' && user.sub === 'bootstrap') {
    const bootstrapPermissions = resolvePermissionsForUIRole('ADMIN')
    if (!bootstrapPermissions.includes(permission)) {
      return fail(`Dostop zavrnjen — manjka dovoljenje: ${permission}.`, 403)
    }
    return user
  }
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { role: true, permissionOverrides: true },
  })
  if (!employee) return forbidden()
  const permissions = resolvePermissions(employee.role, employee.permissionOverrides)
  if (!permissions.includes(permission)) {
    return fail(`Dostop zavrnjen — manjka dovoljenje: ${permission}.`, 403)
  }
  return user
}

export const APP_VERSION = '1.57.0'
export const APP_COMMIT = 'reconstruction-1.0.0'
/**
 * Realen deployan commit (Task 40 + Task 41): 
 *  - Git-integration deployi: Vercel vbrizga VERCEL_GIT_COMMIT_SHA v runtime.
 *  - CLI deployi (vercel-deploy.yml): CI prepiše src/lib/deploy-commit.ts z realnim
 *    GITHUB_SHA/run_id pred `vercel deploy` (prilepi se v bundle).
 * Health endpoint tako vedno pokaže TOČNO verzijo kode, ki teče v produkciji.
 * Lokalno/CI (brez obeh) ostane statični fallback APP_COMMIT.
 */
export const DEPLOY_COMMIT = process.env.VERCEL_GIT_COMMIT_SHA || CI_DEPLOY_COMMIT || APP_COMMIT

/**
 * N4 (audit P1): DDL rute (`/api/admin/migrate-*`, $executeRawUnsafe) zahtevajo
 * CENTRALNI VLOGI na nivoju DB (owner/admin) — dovoljenja (npr. employees.manage)
 * ima tudi MANAGER, zato so permission-based gate-i za DDL premajhni.
 * Vloga se preveri proti DB (živ vir resnice — padec vloge velja takoj),
 * seja/revoke pa varuje requireAuth (status + sessionVersion, D4).
 * Bootstrap admin (brez Employee vrstice) gre skozi kot break-glass
 * (isti fast-path pogoj kot v requireAuth).
 */
export async function requireCentralRole(req: NextRequest): Promise<AuthPayload | NextResponse> {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.role === 'ADMIN' && user.sub === 'bootstrap') return user
  const employee = await db.employee.findUnique({
    where: { id: user.sub },
    select: { role: true },
  })
  if (!employee) return forbidden()
  const roleDB = String(employee.role).toLowerCase()
  if (roleDB !== 'admin' && roleDB !== 'owner') return forbidden()
  return user
}

// ---------- Issue #4 §1 — centralni resource/location authorization ----------

/**
 * Centralne vloge (OWNER/ADMIN) imajo po authorization modelu širši dostop
 * čez lokacije (bootstrap admin nima lokacije). Vse ostalo je location-scoped.
 */
export function isCentralRole(user: AuthPayload): boolean {
  return user.role === 'ADMIN' || user.role === 'OWNER'
}

/**
 * §1: authenticated + permission NI dovolj — resource mora pripadati lokaciji uporabnika.
 * Vrne NextResponse(403) pri kršitvi, null pa pomeni dostop dovoljen.
 * Fail-closed: manjkajoča lokacija uporabnika ali resource-a zavrne dostop (razen centralnih).
 */
export function assertResourceLocation(
  user: AuthPayload,
  resourceLocationId: string | null | undefined
): NextResponse | null {
  if (isCentralRole(user)) return null
  if (!user.loc) return fail('Uporabnik nima dodeljene lokacije — dostop zavrnjen.', 403)
  if (!resourceLocationId) return fail('Vir nima lokacije — dostop zavrnjen.', 403)
  if (resourceLocationId !== user.loc) return forbidden()
  return null
}

/**
 * §10: where-filter za findMany nad lokacijskimi modeli (Task 54 — org allow-lista).
 *  - staff: izključno svoja lokacija (fail-closed — brez lokacije ne vidijo nič);
 *  - centralne vloge: lokacije svoje organizacije + nevezane legacy lokacije
 *    (propertyId null — migracijsko varno, isti pravilnik kot assertTenantScope/
 *    assertOrgScope v1.53.0); neznana org uporabnika → brez org filtra (produkcija
 *    z nevezanimi lokacijami se ne regresira — lokacijski sloj ostaja varovalka);
 *  - bootstrap admin: break-glass, vidi vse.
 */
export async function locationScope(
  user: AuthPayload
): Promise<{ locationId?: string | { in: string[] } }> {
  if (isCentralRole(user)) {
    // bootstrap break-glass — isti predikat kot isBootstrapAdmin (tenant.ts), brez cirkularnega uvoza
    if (user.role === 'ADMIN' && user.sub === 'bootstrap') return {}
    const orgId = await userOrgIdForScope(user.loc)
    if (!orgId) return {}
    const rows = await db.location.findMany({
      where: { OR: [{ Property: { Brand: { organizationId: orgId } } }, { propertyId: null }] },
      select: { id: true },
    })
    return { locationId: { in: rows.map((r) => r.id) } }
  }
  return { locationId: user.loc || '__no_location__' }
}

/** org uporabnikove lokacije (Location → Property → Brand → Organization); null = neznana. */
async function userOrgIdForScope(locId: string | null | undefined): Promise<string | null> {
  if (!locId) return null
  const loc = await db.location.findUnique({
    where: { id: locId },
    select: { Property: { select: { Brand: { select: { organizationId: true } } } } },
  })
  return loc?.Property?.Brand?.organizationId ?? null
}

/**
 * §10: obvezna lokacija za CREATE/PATCH — staff MORA imeti lokacijo;
 * prepovedan je findFirst() fallback (implicitna izbira "prve" lokacije).
 * Centralne vloge lahko lokacijo podajo eksplicitno v telesu.
 */
export function requireUserLocation(user: AuthPayload, bodyLocationId?: unknown): string | NextResponse {
  if (isCentralRole(user)) {
    const id = typeof bodyLocationId === 'string' && bodyLocationId.trim() ? bodyLocationId.trim() : ''
    if (id) return id
    if (user.loc) return user.loc
    return fail('Lokacija ni določena — podajte locationId.', 400)
  }
  if (!user.loc) return fail('Uporabnik nima dodeljene lokacije.', 403)
  return user.loc
}
