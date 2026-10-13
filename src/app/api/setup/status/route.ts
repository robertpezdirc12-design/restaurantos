import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { rateLimitBool } from '@/lib/rate-limit'

/**
 * Status inicializacije (setup wizard) — JAVNA ruta po namenu (preveri, ali je
 * sistem še pred inicializacijo). AUDIT-FIX v1.82.1: dodan rate limit (30/min/IP)
 * — prej je vsak klic neavtentikirano pognal 3 DB COUNT poizvedbe (info disclosure
 * + trivialen DoS vektor na javni luknji). Odgovor ne razkriva številk (counts: null
 * ostaja) — samo binarne zastavice.
 */
export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!rateLimitBool(`setup-status:${ip}`, 30, 60_000)) {
    return NextResponse.json({ error: 'Preveč zahtev. Poskusite znova čez minuto.' }, { status: 429 })
  }
  const [employees, locations, settings] = await Promise.all([
    db.employee.count(),
    db.location.count(),
    db.restaurantSettings.count(),
  ])
  return NextResponse.json({
    isInitialized: employees > 0,
    mode: locations > 1 ? 'multi' : 'single',
    hasEmployees: employees > 0,
    hasLocations: locations > 0,
    hasSettings: settings > 0,
    counts: null,
    multiLocationReady: locations > 0,
    databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing',
  })
}
