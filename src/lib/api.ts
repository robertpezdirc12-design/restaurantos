import { NextRequest, NextResponse } from 'next/server'
import { getAuth, AuthPayload } from '@/lib/auth'

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

export const APP_VERSION = '1.26.0'
export const APP_COMMIT = 'reconstruction-1.0.0'
