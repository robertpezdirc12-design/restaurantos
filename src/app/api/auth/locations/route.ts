import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { describeDbError, logDbError } from '@/lib/db-error'
import { clientIp } from '@/lib/guest'
import { rateLimitSharedAsync } from '@/lib/rate-limit'

/**
 * Javna endpointa (kot v originalu): vrača lokacije za izbor na prijavi.
 *
 * Issue #76: prej je db.location.findMany() ob izpadu baze vrglo NEUJETO
 * izjemo → Next.js je vrnil HTTP 500 s PRAZNIM telesom (login stran je
 * pokazala le "napaka strežnika"). Zdaj: 503 s strukturiranim JSON
 * (code: DB_UNAVAILABLE + varna kategorija dbError) in console.error z
 * izjemo/stackom v Vercel runtime logih.
 *
 * audit #9 (v1.147.0) — javni seznam je NUJEN (pred prijavo ni seje, sicer
 * uporabnik ne more izbrati poslovalnice), hkrati pa je javni imenik vseh
 * najemnikov. Zato dve plasti, ki prijave ne lomita:
 *  - rate limit 30/min na IP (isti vzorec kot /api/auth/login = 10/min in
 *    POST /api/devices = 20/min): en obisk strani je ena zahteva, strojno
 *    naštevanje tisočih organizacij pa se ustavi samo;
 *  - `Cache-Control: no-store` (tudi na 429/503): brez tega se seznam hrani v
 *    brskalnikih, CDN in vmesnih posrednikih — kopija imenika živi dlje kot
 *    zahtevek in je dosegljiva brez ponovnega posega v aplikacijo.
 * Polna odprava tveganja zahteva zastavico vidnosti na lokaciji (DDL — spada v
 * blok najdb #17/#19) ali prehod na iskanje po kodi lokacije (odločitev o UX je
 * lastnikova). Seznam vrača izključno {id, name} AKTIVNIH lokacij — brez
 * naslovov, davčnih številk, FURS/prijavnih podatkov ali števila zaposlenih.
 */
const LIMIT_PER_MIN = 30

/** Skupne glave javnega odgovora (no-store = kopija imenika ne sme ostati v vmesnikih). */
function publicHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Cache-Control': 'no-store', ...extra }
}

export async function GET(req: NextRequest) {
  const rl = await rateLimitSharedAsync(`locations:list:${clientIp(req)}`, LIMIT_PER_MIN)
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: 'Preveč zahtevkov. Poskusite znova čez minuto.',
        code: 'RATE_LIMITED',
      },
      {
        status: 429,
        headers: publicHeaders({ 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) }),
      },
    )
  }
  try {
    const locations = await db.location.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ locations }, { headers: publicHeaders() })
  } catch (err) {
    logDbError('GET /api/auth/locations — db.location.findMany', err)
    const { code, category } = describeDbError(err)
    return NextResponse.json(
      {
        error: 'Podatkovna baza trenutno ni dosegljiva. Poskusite znova kasneje.',
        code: 'DB_UNAVAILABLE',
        dbError: { code, category },
      },
      { status: 503, headers: publicHeaders() },
    )
  }
}
