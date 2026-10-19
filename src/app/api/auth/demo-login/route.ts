import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { roleToUI } from '@/lib/map'
import { resolvePermissions } from '@/lib/permissions'
import { rateLimitSharedAsync } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit-chain'
import { describeDbError, logDbError } from '@/lib/db-error'

/**
 * DEMO VSTOP BREZ GESLA (zahteva lastnika, 16. 10. 2026 — "dokler delamo":
 * med razvojem lastnik pozabi PIN/e-pošto, zato želi prost vstop).
 *
 * Prijavi kot PRVI (najstarejši) AKTIVEN vodstveni račun (owner/admin) BREZ
 * vklopljenega MFA — torej isti račun, ki bi ga lastnik sicer uporabil, samo
 * brez vpisa poverilnic. Prijave na MFA-zavarovane račune NE obide (izbira
 * jih preskoči; če takega računa ni → 403).
 *
 * Zavesti (namenoma vidno, ne skrivnost):
 *  - namenski AUDIT dogodek DEMO_LOGIN (vsak vstop je sledljiv);
 *  - rate-limit 10/min po IP (isti vzorec kot prijava);
 *  - neobvezna env konstanta DEMO_LOGIN_EMAIL pripne demo vstop na TOČNO
 *    določen račun (uporabno kasneje, ko lastnik želi demo prijavo ločiti od
 *    svojega računa) — ne nastavi se samo od sebe.
 *
 * To je izrecna zahteva lastnika za obdobje razvoja demo aplikacije. Ko bo
 * delo zaključeno, gumb in to rut(o) enostavno odstranimo.
 *
 * Issue #7 (v1.148.0): vrata so bila doslej odprta PO PRIVZETI in brez roka —
 * edini mehanizem za zaprtje je bilo ročno odstranjanje kode, v produkciji pa je
 * anonimen klic dobil POLNO lastnikovo sejo. Zdaj imajo vrata tri zavore, vse
 * nastavljene z env spremenljivkami; nobena ne prekine obstoječega delovnega
 * toka, dokler lastnik zavor sam ne nastavi:
 *  - `DEMO_LOGIN_ENABLED=0` (0/false/no/off) — zapre vrata takoj,
 *  - `DEMO_LOGIN_EXPIRES_AT=<ISO datum>` — zapre po roku; neveljaven zapis
 *    zapre (fail-closed), ker »nikoli ne poteče« ne sme biti posledica
 *    tipkarske napake,
 *  - `GET` na isti poti vrne SAMO stanje vrat (brez imen, e-pošt in računov), da
 *    prijavni zaslon gumb skrije in ne obeta nekaj, kar je zaprto.
 * Brez nastavljenega roka vrata ostanejo odprta — to je sedanja lastnikova
 * odločitev — vsak vstop pa se zabeleži z opombo o (ne)omejenosti.
 */

const DISABLED_VALUES = ['0', 'false', 'no', 'off']

type DemoGate =
  | { open: true; expiresAt: Date | null }
  | { open: false; code: 'DEMO_LOGIN_DISABLED' | 'DEMO_LOGIN_EXPIRED' | 'DEMO_LOGIN_CONFIG_INVALID'; error: string }

/**
 * Stanje demo vrat. `now` je parameter samo zato, da je potek testen brez
 * pomikanja sistemskih ur.
 */
export function demoGate(now = new Date()): DemoGate {
  const enabled = String(process.env.DEMO_LOGIN_ENABLED || '').trim().toLowerCase()
  if (DISABLED_VALUES.includes(enabled)) {
    return { open: false, code: 'DEMO_LOGIN_DISABLED', error: 'Demo prijava je izklopljena (DEMO_LOGIN_ENABLED).' }
  }
  const raw = String(process.env.DEMO_LOGIN_EXPIRES_AT || '').trim()
  if (!raw) return { open: true, expiresAt: null }
  const expiresAt = new Date(raw)
  if (Number.isNaN(expiresAt.getTime())) {
    return { open: false, code: 'DEMO_LOGIN_CONFIG_INVALID', error: 'Demo prijava je onemogočena — neveljaven DEMO_LOGIN_EXPIRES_AT.' }
  }
  if (now.getTime() > expiresAt.getTime()) {
    return { open: false, code: 'DEMO_LOGIN_EXPIRED', error: `Demo prijava je potekla (${expiresAt.toISOString().slice(0, 10)}).` }
  }
  return { open: true, expiresAt }
}

let unboundedWarned = false
// Zavrnjen poskus je PUBLIC endpoint pred omejitvijo (vrata so zaprta → 403 takoj,
// brez DB dela), zato bi klica na minuto napisala enako število log vrstic. Opozorilo
// se donc združi po kodi: vsaka od treh zavor je v procesu zapisana ENKRAT.
const refusalWarned = new Set<string>()

export async function GET() {
  const gate = demoGate()
  const body = gate.open
    ? { enabled: true, code: null, expiresAt: gate.expiresAt ? gate.expiresAt.toISOString() : null }
    : { enabled: false, code: gate.code, expiresAt: null }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

function ipOf(req: NextRequest): string {
  const vff = req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
  if (vff) return vff
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function fetchCandidates() {
  return db.employee.findMany({
    where: { status: 'active' },
    select: {
      id: true, name: true, email: true, role: true, locationId: true,
      sessionVersion: true, permissionOverrides: true, mfaEnabled: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  })
}

const CENTRAL_DB_ROLES = ['owner', 'admin']

export async function POST(req: NextRequest) {
  const ip = ipOf(req)

  // Issue #7: zaprta vrata se preverijo PRVA (env branje, brez DB dela) —
  // odgovor je 403 s strojno berljivo kodo, da ujemanje ne ostane samo v
  // besedilu. Zavrnjen poskus namerno NE piše revizijskega zapisa: vrata so
  // javna, sicer bi anonimen caller z 403-ji polnil AuditLog (zanj piše samo
  // dejanski vstop).
  const gate = demoGate()
  if (!gate.open) {
    if (!refusalWarned.has(gate.code)) {
      refusalWarned.add(gate.code)
      console.warn(`[auth] demo-login zavrnjen: ${gate.code}`)
    }
    return NextResponse.json({ error: gate.error, code: gate.code }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!gate.expiresAt && !unboundedWarned) {
    // Neomejena vrata so trenutna lastnikova odločitev, ne pozaba — opozorilo
    // je zato glasno v runtime logih, a ne sme motiti testnega izpisa.
    unboundedWarned = true
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[auth] demo-login: vrata so odprta BREZ ROKA (DEMO_LOGIN_EXPIRES_AT ni nastavljen).')
    }
  }

  // isti burst limit kot prijava (10/min po IP) — demo vrata niso za robote
  if (!(await rateLimitSharedAsync(`demo-login:${ip}`, 10, 60_000)).allowed) {
    return NextResponse.json({ error: 'Preveč poskusov. Poskusite znova kasneje.' }, { status: 429 })
  }

  const pinned = String(process.env.DEMO_LOGIN_EMAIL || '').trim().toLowerCase()

  // Issue #76: ob izpadu baze NE ujeta izjema več sesuje route v prazen HTTP 500 —
  // vrni 503 s strukturiranim telesom (DB_UNAVAILABLE + varna kategorija) in
  // izjemo/stack zapiši v Vercel runtime loge.
  let candidates: Awaited<ReturnType<typeof fetchCandidates>>
  try {
    candidates = await fetchCandidates()
  } catch (err) {
    logDbError('POST /api/auth/demo-login — db.employee.findMany', err)
    const { code, category } = describeDbError(err)
    return NextResponse.json(
      {
        error: 'Podatkovna baza trenutno ni dosegljiva. Poskusite znova kasneje.',
        code: 'DB_UNAVAILABLE',
        dbError: { code, category },
      },
      { status: 503 },
    )
  }

  let pick: (typeof candidates)[number] | undefined
  if (pinned) {
    pick = candidates.find((e) => String(e.email).toLowerCase() === pinned)
    if (!pick) {
      return NextResponse.json({ error: 'Demo prijava ni na voljo (pripet račun ne obstaja ali ni aktiven).' }, { status: 403 })
    }
    if (!CENTRAL_DB_ROLES.includes(String(pick.role).toLowerCase())) {
      return NextResponse.json({ error: 'Demo prijava je na voljo le za vodstveni račun.' }, { status: 403 })
    }
    if (pick.mfaEnabled) {
      return NextResponse.json({ error: 'Demo prijava ne obide MFA — uporabite navadno prijavo.' }, { status: 403 })
    }
  } else {
    pick = candidates.find(
      (e) => CENTRAL_DB_ROLES.includes(String(e.role).toLowerCase()) && !e.mfaEnabled,
    )
    if (!pick) {
      return NextResponse.json(
        { error: 'Demo vstop ni na voljo: ni aktivnega vodstvenega računa brez MFA.' },
        { status: 403 },
      )
    }
  }

  // Issue #76: APP_SECRET validacija je zdaj LAZY (uporaba, ne uvoz modula) — ob
  // mankajoči skrivnosti dobimo tukaj jasen CONFIG error (500 s telesom), ne sesutega
  // uvoza z modulsko izjemo, ki bi praznila telo odgovora.
  let token: string
  try {
    token = createToken({
      sub: pick.id,
      name: pick.name,
      role: roleToUI(pick.role),
      loc: pick.locationId,
      sv: pick.sessionVersion,
    })
  } catch (err) {
    console.error('[auth] demo-login: izdaja žetona ni uspela — APP_SECRET?', (err as Error).message)
    return NextResponse.json(
      { error: 'Prijava trenutno ni na voljo (manjka strežniška konfiguracija).', code: 'CONFIG_MISSING' },
      { status: 500 },
    )
  }

  await writeAudit(db, {
    userId: pick.id,
    action: 'DEMO_LOGIN',
    entityType: 'Employee',
    entityId: pick.id,
    details: `Demo vstop brez gesla (zahteva lastnika med razvojem) — izdana polna seja. ${
      gate.expiresAt ? `Vrata potekajo ${gate.expiresAt.toISOString()}.` : 'Vrata brez nastavljenega roka (DEMO_LOGIN_EXPIRES_AT ni nastavljen).'
    }`,
    ipAddress: ip,
    locationId: pick.locationId,
  }).catch((auditErr: unknown) => {
    // Issue #76: demo vstop je sledljiv tudi kadar audit zapis spodleti — napaka
    // ni več tiha, gre v runtime loge (ne vpliva odgovora).
    logDbError('POST /api/auth/demo-login — writeAudit (DEMO_LOGIN zapis)', auditErr)
  })

  return NextResponse.json({
    token,
    employee: {
      id: pick.id,
      name: pick.name,
      email: pick.email,
      role: roleToUI(pick.role),
      locationId: pick.locationId,
      permissions: resolvePermissions(pick.role, pick.permissionOverrides),
    },
    demo: true,
  })
}
