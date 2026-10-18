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
 */

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
    details: 'Demo vstop brez gesla (zahteva lastnika med razvojem) — izdana polna seja.',
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
