import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { rateLimitShared } from '@/lib/rate-limit'
import { getUpdateCheckResult } from '@/lib/update-check-server'

/**
 * R4b-1 (v1.216.0) — GET /api/update-check: stanje preverjanja posodobitev.
 *
 * Osebje (katera koli prijavljena vloga — različica ni skrivnost: je v
 * Ukazni paleti in health endpointu). Varovalka: requireAuth (route-coverage a).
 * Rate limit 30/min po uporabniku: odhodni klic že varuje predpomnilnik
 * (uspeh 1 h / odpoved 60 s) — limit varuje pred zanko napihnjenih zahtevkov.
 *
 * Odgovor VEDNO 200 (fail-soft je DELO rezultata — reason/durationMs poročata
 * pošteno); 429 samo ob preseženem limitu. no-store: stanje je živo, brskalnik
 * naj ga ne predpomni (šteje samo strežniška predpomnilnica).
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const rl = rateLimitShared(`updchk:${user.sub}`, 30, 60_000)
  if (!rl.allowed) {
    return ok({ error: 'Preveč zahtevkov — poskusite kasneje.' }, 429)
  }

  const result = await getUpdateCheckResult()
  return NextResponse.json(result, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}
