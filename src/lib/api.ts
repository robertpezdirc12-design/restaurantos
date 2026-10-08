import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuth, AuthPayload, sessionRevoked } from '@/lib/auth'
import { resolvePermissions, CanonicalPermission } from '@/lib/permissions'

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
 * Fast-path SAMO za bootstrap admina (brez Employee vrstice) — vsi realni zaposleni
 * gredo čez DB: status + sessionVersion (D4) + dovoljenja delujejo TAKOJ (12h žeton jih ne zamrzne).
 */
export async function requirePermission(
  req: NextRequest,
  permission: CanonicalPermission
): Promise<AuthPayload | NextResponse> {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
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

export const APP_VERSION = '1.36.0'
export const APP_COMMIT = 'reconstruction-1.0.0'

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
 * §10: where-filter za findMany nad lokacijskimi modeli.
 * Centralne vloge vidijo vse; ostali samo svojo lokacijo (fail-closed — brez lokacije ne vidijo nič).
 */
export function locationScope(user: AuthPayload): { locationId?: string } {
  if (isCentralRole(user)) return {}
  return { locationId: user.loc || '__no_location__' }
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
