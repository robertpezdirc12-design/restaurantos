import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAuth, AuthPayload } from '@/lib/auth'
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

export function requireAuth(req: NextRequest): AuthPayload | NextResponse {
  const user = getAuth(req)
  if (!user) return unauthorized()
  return user
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse
}

/**
 * Granularna avtorizacija (issue #1): zahteva eno kanonično dovoljenje.
 * ADMIN fast-path po žetonu (bootstrap admin nima Employee vrstice).
 * Sicer DB lookup — spremembe pravic/uveljavljenih obveznic delujejo TAKOJ (12h žeton jih ne zamrzne).
 */
export async function requirePermission(
  req: NextRequest,
  permission: CanonicalPermission
): Promise<AuthPayload | NextResponse> {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (user.role === 'ADMIN' || user.role === 'OWNER') return user
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

export const APP_VERSION = '1.27.0'
export const APP_COMMIT = 'reconstruction-1.0.0'
