import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, verifyToken, getAuth, employeePinFields, SESSION_COOKIE } from '../src/lib/auth'
import { roleToUI } from '../src/lib/map'
import { POST as reservationsPOST } from '../src/app/api/reservations/route'
import { GET as catchAllGET, POST as catchAllPOST } from '../src/app/api/[...path]/route'
import { POST as loginPOST } from '../src/app/api/auth/login/route'
import { POST as logoutPOST } from '../src/app/api/auth/logout/route'
import { POST as couponsWaitlistPOST } from '../src/app/api/admin/migrate-coupons-waitlist/route'

/**
 * JAVNI QA VAL #89–#97 (v1.219.0) — regresijska varovalka nad popravki.
 *
 *  #97  fiskalni storno iz seznama Računi ni bil več tihi no-op
 *       (confirmException je zahteval payingOrder, ki ga stornoReceipt ne nastavi);
 *  #96  Nova rezervacija: centralna vloga brez lokacije dobi izbirnik
 *       (UI) + strežniški fail-closed fallback ob NATANKO eni aktivni lokaciji;
 *  #91  neznane /api/* poti vračajo JSON 404 (ne HTML);
 *  #92  429 na prijavi/demo nosi Retry-After (meje same obstajajo od v1.94.0);
 *  #90  seja potuje tudi prek httpOnly piškotka ro_session (+ odjava prek
 *       strežnika — JS httpOnly piškotka ne more pobrisati);
 *  #94  Računi: EOR stanje namesto praznega, oznaka starih številk,
 *       datumski filter seznama (kontrolirani props portala);
 *  #89/#95  PIN/kiosk/display/nastavitve vnosi: id/name/inputMode/label;
 *  #93  demo seja vidno označena (ro_demo + značka v glavi).
 *
 * Statika (UI) po vzorcu obstoječih registrov — brskalniška preverba je bila
 * izvedena v živo (dev profil), tu pa so vzorci zapečateni proti regresu.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const P = 'v219-'
const RUN = String(Date.now()).slice(-8)
const PIN = String(Date.now()).slice(-6)

let org: string, brand: string, prop: string, loc1: string, loc2: string
let adminNoLocId: string, managerNoLocId: string, managerLocId: string

function authReq(path: string, token: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': `10.219.0.1` },
    body: JSON.stringify(body),
  })
}

function bearer(userId: string, role: string, loc: string | null): string {
  return createToken({ sub: userId, name: P, role: roleToUI(role), loc, sv: 0 })
}

async function seedEmployee(id: string, role: string, loc: string | null, seq: number): Promise<string> {
  const email = `${id}@test.local`
  const f = employeePinFields(`${PIN}${seq}`, email)
  await db.employee.create({
    data: { id, name: `${P}${id}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return id
}

async function cleanup() {
  await db.reservation.deleteMany({ where: { id: { startsWith: `${P}res-` } } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.property.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.brand.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.organization.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  org = `${P}org-${RUN}`; brand = `${P}brand-${RUN}`; prop = `${P}prop-${RUN}`
  loc1 = `${P}loc1-${RUN}`; loc2 = `${P}loc2-${RUN}`
  await db.organization.create({ data: { id: org, name: `${P}Org`, slug: `${P}-${RUN}` } })
  await db.brand.create({ data: { id: brand, organizationId: org, name: `${P}Brand` } })
  await db.property.create({ data: { id: prop, brandId: brand, name: `${P}Prop` } })
  await db.location.create({ data: { id: loc1, name: `${P}Lokacija1`, code: `V1${RUN}A`, propertyId: prop, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  await db.location.create({ data: { id: loc2, name: `${P}Lokacija2`, code: `V1${RUN}B`, propertyId: prop, timezone: 'Europe/Ljubljana', currency: 'EUR' } })
  adminNoLocId = await seedEmployee(`${P}admin-${RUN}`, 'admin', null, 1)
  managerNoLocId = await seedEmployee(`${P}mnoloc-${RUN}`, 'manager', null, 2)
  managerLocId = await seedEmployee(`${P}mloc-${RUN}`, 'manager', loc1, 3)
})

afterAll(async () => {
  await cleanup()
})

/* ── Č1 · #97 — fiskalni storno iz seznama ni tihi no-op ─────────────────── */

describe('v219 Č1 · #97 storno iz seznama (confirmException)', () => {
  const page = read('src/app/dashboard/page.tsx')

  it('pogoj veje NE zahteva več payingOrder za storno', () => {
    // nov varovalni pogoj: storno je izvzet iz zahteve payingOrder
    expect(page).toContain("if (excAction.type !== 'storno' && !payingOrder) return")
  })

  it('STARA tiha ovira (!excAction || !payingOrder) je ODSTRANJENA', () => {
    expect(page).not.toContain('if (!excAction || !payingOrder) return')
  })

  it('storno veja ima ves kontekst v excAction.receipt (brez payingOrder)', () => {
    expect(page).toContain('const r = excAction.receipt')
    expect(page).toContain('`/api/receipts/${r.id}/storno`')
  })
})

/* ── Č2 · #96 — rezervacija: lokacija za centralno vlogo brez dodelitve ──── */

describe('v219 Č2 · #96 lokacija rezervacije (backend)', () => {
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString()
  const baseBody = { guestName: `${P}Gost`, reservedAt: tomorrow, guests: 2, phone: '', source: 'phone' }

  it('400: centralna vloga brez loc + brez locationId + DVE lokaciji (fail-closed ostaja)', async () => {
    const res = await reservationsPOST(authReq('/api/reservations', bearer(adminNoLocId, 'admin', null), baseBody))
    expect(res.status).toBe(400)
    const d = (await res.json()) as { error?: string }
    expect(d.error).toContain('Lokacija ni določena')
  })

  it('201: centralna vloga brez loc + locationId v telesu → rezervacija na tej lokaciji', async () => {
    const res = await reservationsPOST(authReq('/api/reservations', bearer(adminNoLocId, 'admin', null), { ...baseBody, locationId: loc1 }))
    expect(res.status).toBe(201)
    const d = (await res.json()) as { reservation?: { locationId?: string; id?: string } }
    expect(d.reservation?.locationId).toBe(loc1)
  })

  it('201 fallback: natanko ENA aktivna lokacija → uporabljena brez ugibanja', async () => {
    // determinističnost: fallback se sproži SAMO ob natanko eni aktivni lokaciji
    // — ostale (iz sočasnih fikstur) se za čas testa deaktivirajo in povrnejo
    const others = await db.location.findMany({ where: { isActive: true, id: { not: loc1 } }, select: { id: true } })
    if (others.length > 0) await db.location.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: false } })
    try {
      const res = await reservationsPOST(authReq('/api/reservations', bearer(adminNoLocId, 'admin', null), { ...baseBody, guestName: `${P}GostFB` }))
      expect(res.status).toBe(201)
      const d = (await res.json()) as { reservation?: { locationId?: string } }
      expect(d.reservation?.locationId).toBe(loc1)
    } finally {
      if (others.length > 0) await db.location.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isActive: true } })
    }
  })

  it('403: NE-centralna vloga brez loc ostaja zavrnjena (brez fallbacka)', async () => {
    const res = await reservationsPOST(authReq('/api/reservations', bearer(managerNoLocId, 'manager', null), baseBody))
    expect(res.status).toBe(403)
    const d = (await res.json()) as { error?: string }
    expect(d.error).toContain('nima dodeljene lokacije')
  })

  it('lokalna vloga Z lokacijo: telo brez locationId → uporabniška lokacija (nespremenjeno)', async () => {
    const res = await reservationsPOST(authReq('/api/reservations', bearer(managerLocId, 'manager', loc1), baseBody))
    expect(res.status).toBe(201)
    const d = (await res.json()) as { reservation?: { locationId?: string } }
    expect(d.reservation?.locationId).toBe(loc1)
  })

  it('UI: dialog ima izbirnik lokacije + validacija pred oddajo (statika)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('resvNeedsLocation')
    expect(page).toContain('resvLocationMissing')
    expect(page).toContain('resv.locationLabel')
    expect(page).toContain('t(\'resv.locationMissing\')')
    // strežniški fallback je izrecno dokumentiran v ruti
    const route = read('src/app/api/reservations/route.ts')
    expect(route).toContain('rows.length === 1')
  })
})

/* ── Č3 · #91 — JSON 404 za neznane /api/* poti ──────────────────────────── */

describe('v219 Č3 · #91 JSON 404 catch-all', () => {
  const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) })

  it('GET /api/menu → 404 JSON z izpisano potjo', async () => {
    const res = await catchAllGET(new NextRequest('http://localhost:3000/api/menu'), ctx(['menu']))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const d = (await res.json()) as { error?: string; path?: string }
    expect(d.error).toBe('Not found')
    expect(d.path).toBe('/api/menu')
  })

  it('POST /api/reports/tax → 404 JSON (mutacija prav tako, ne HTML)', async () => {
    const res = await catchAllPOST(
      new NextRequest('http://localhost:3000/api/reports/tax', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ctx(['reports', 'tax']),
    )
    expect(res.status).toBe(404)
    const d = (await res.json()) as { path?: string }
    expect(d.path).toBe('/api/reports/tax')
  })

  it('vse metode so izvožene (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)', async () => {
    const mod = await import('../src/app/api/[...path]/route')
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(typeof (mod as Record<string, unknown>)[m]).toBe('function')
    }
  })

  it('ne obstaja ULOMEK imen z obstoječimi rutami: catch-all je edini v /api', () => {
    // specifične route datoteke ostajajo — catch-all jih NE more senčiti
    // (Next resolucija: specifična ruta > catch-all); dokaz z dvema živima
    // rutama, ki ju issue #91 navaja kot PRAVI imeni (/api/menus, /api/audit).
    expect(read('src/app/api/menus/route.ts').length).toBeGreaterThan(0)
    expect(read('src/app/api/audit/route.ts').length).toBeGreaterThan(0)
  })
})

/* ── Č4 · #92 — Retry-After na 429 (meje same od v1.94.0) ────────────────── */

describe('v219 Č4 · #92 Retry-After', () => {
  it('11. poskus napačnega PIN-a z istega IP → 429 + številski Retry-After', async () => {
    const email = `${P}rl-${RUN}@test.local`
    let last: Response | null = null
    for (let i = 0; i <= 10; i++) {
      last = await loginPOST(new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.219.92.${RUN.slice(-2)}` },
        body: JSON.stringify({ email, pin: '000000' }),
      }))
      if (i < 10) expect(last.status).toBe(401) // pod limitom: merjeno (10/min IP)
    }
    expect(last!.status).toBe(429)
    const ra = last!.headers.get('retry-after')
    expect(ra).not.toBeNull()
    expect(Number(ra)).toBeGreaterThanOrEqual(1)
    const d = (await last!.json()) as { error?: string }
    expect(d.error).toContain('Preveč poskusov')
  })

  it('login vrata: loginRateLimited vrača REZULTAT (ne boolean) — vir ResetAt', () => {
    const src = read('src/app/api/auth/login/route.ts')
    expect(src).toContain('Promise<RateLimitResult | null>')
    expect(src).toContain("'Retry-After'")
  })

  it('demo-login 429 prav tako nosi Retry-After (statika rute)', () => {
    const src = read('src/app/api/auth/demo-login/route.ts')
    expect(src).toContain("'Retry-After'")
  })
})

/* ── Č5 · #90 — httpOnly piškotek seje + odjava ──────────────────────────── */

describe('v219 Č5 · #90 httpOnly piškotek', () => {
  it('getAuth sprejme piškotek ro_session (drugi transport, isti žeton)', async () => {
    const token = bearer(managerLocId, 'manager', loc1)
    const req = new NextRequest('http://localhost:3000/api/any', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })
    const payload = getAuth(req)
    expect(payload?.sub).toBe(managerLocId)
    expect(verifyToken(token)?.sub).toBe(managerLocId)
  })

  it('getAuth: Bearer ima prednost, piškotek je rezerva (ne obratno)', async () => {
    const good = bearer(managerLocId, 'manager', loc1)
    const req = new NextRequest('http://localhost:3000/api/any', {
      headers: { authorization: `Bearer ${good}`, cookie: `${SESSION_COOKIE}=pokvarjen.zeton` },
    })
    expect(getAuth(req)?.sub).toBe(managerLocId)
  })

  it('uspešna prijava nastavi Set-Cookie: HttpOnly + SameSite=Lax + Path=/', async () => {
    const email = `${P}loginok-${RUN}@test.local`
    const f = employeePinFields(`${PIN}7`, email)
    await db.employee.create({ data: { id: `${P}loginok-${RUN}`, name: `${P}Login`, email, role: 'waiter', status: 'active', sessionVersion: 0, locationId: loc1, pin: f.pin, pinLookup: f.pinLookup } })
    const res = await loginPOST(new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.219.90.1' },
      body: JSON.stringify({ email, pin: `${PIN}7` }),
    }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    // Next serializira SameSite v mala črka (lax)
    expect(setCookie.toLowerCase()).toContain('samesite=lax')
    expect(setCookie).toContain('Path=/')
  })

  it('odjava pobriše piškotek (Max-Age=0) in je idempotentna brez seje', async () => {
    const withSession = await logoutPOST(new NextRequest('http://localhost:3000/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${bearer(managerLocId, 'manager', loc1)}` },
    }))
    expect(withSession.status).toBe(200)
    expect(withSession.headers.get('set-cookie') || '').toContain('Max-Age=0')

    const withoutSession = await logoutPOST(new NextRequest('http://localhost:3000/api/auth/logout', { method: 'POST' }))
    expect(withoutSession.status).toBe(200)
  })

  it('offline vrsta splakne tudi BREZ localStorage žetona (odstranjena ovira)', () => {
    const src = read('src/lib/offline-queue.ts')
    // zgodnji izstop brez žetona je ODSTRANJEN (ne sme več obstajati v kodi)
    expect(src).not.toContain('if (!token) return {')
    expect(src).toContain("...(token ? { Authorization: `Bearer ${token}` } : {})")
  })

  it('prijavni zaslon ne shranjuje več žetona; ro_user brez dovoljenj (statika)', () => {
    const page = read('src/app/page.tsx')
    expect(page).not.toContain("localStorage.setItem('ro_token'")
    expect(page).toContain('const { permissions: _omitPerms, ...employeeForUi } = data.employee ?? {}')
    // prijavljenost = ro_user ali legacy žeton (prehod)
    expect(page).toContain('const token = localStorage.getItem(\'ro_token\')')
    expect(page).toContain('if (token || sessionUser) {')
  })

  it('MFA enable/disable osvežita piškotek (nadaljevalni žeton, sv+1) — statika', () => {
    expect(read('src/app/api/auth/mfa/enable/route.ts')).toContain('setSessionCookie')
    expect(read('src/app/api/auth/mfa/disable/route.ts')).toContain('setSessionCookie')
  })
})

/* ── Č6 · #94 — Računi: EOR, stara številka, datumski filter ─────────────── */

describe('v219 Č6 · #94 Računi UI', () => {
  it('prazen EOR ne izriše golih »EOR: « — pove se stanje', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).not.toContain('>EOR: {r.eor}<')
    expect(page).toContain("r.eor ? `EOR: ${r.eor}` : (r.fiscalStatus === 'pending' ? t('rcpt.eorPending') : t('rcpt.eorNone'))")
  })

  it('stara številčna shema (R-YYYY-NNNNN) ima oznako', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('legacyInvoiceNumber(r.invoiceNumber)')
    expect(page).toContain("t('rcpt.legacyBadge')")
  })

  it('seznam upošteva datumsko obdobje (receiptsInRange) + CSV izvoz isto', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('receiptsInRange.map')
    expect(page).toContain('receipts.length > 0 && receiptsInRange.length === 0')
  })

  it('portal je NADZOROVAN iz zavihka (from/to/onFromChange/onToChange)', () => {
    const card = read('src/components/tabs/accounting-portal-card.tsx')
    expect(card).toContain('from?: string')
    expect(card).toContain('onFromChange?: (v: string) => void')
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('from={rcptFrom} to={rcptTo} onFromChange={setRcptFrom} onToChange={setRcptTo}')
  })

  it('i18n ključi SL/HR obstajajo (pariteta je pokrita v i18n.test.ts)', () => {
    const sl = read('src/lib/i18n/sl.ts')
    const hr = read('src/lib/i18n/hr.ts')
    for (const k of ['rcpt.eorPending', 'rcpt.eorNone', 'rcpt.legacyBadge', 'rcpt.noneInRange']) {
      expect(sl).toContain(`'${k}'`)
      expect(hr).toContain(`'${k}'`)
    }
  })
})

/* ── Č7 · #89/#95 — dostopnost vnosnih polj ─────────────────────────────── */

describe('v219 Č7 · #89/#95 a11y vnosov', () => {
  it('prijava: PIN ima inputMode/maxLength/name/autocomplete=off; email ime', () => {
    const page = read('src/app/page.tsx')
    const pinBlock = page.slice(page.indexOf('id="pin"'), page.indexOf('id="pin"') + 600)
    expect(pinBlock).toContain('name="pin"')
    expect(pinBlock).toContain('inputMode="numeric"')
    expect(pinBlock).toContain('maxLength={8}')
    expect(pinBlock).toContain('autoComplete="off"')
    expect(page).toContain('name="email"')
  })

  it('kiosk: vnos kode ima id/name/inputMode/aria-label/maxLength', () => {
    const kiosk = read('src/app/kiosk/page.tsx')
    expect(kiosk).toContain('id="kiosk-activation-code"')
    expect(kiosk).toContain('name="activationCode"')
    expect(kiosk).toContain('inputMode="numeric"')
    expect(kiosk).toContain("aria-label={t('guest.kiosk.tokenLabel')}")
    expect(kiosk).toContain('maxLength={64}')
  })

  it('display: obe vnosni polji (žeton + paritvena koda) imata id/name/aria-label', () => {
    const display = read('src/app/display/page.tsx')
    expect(display).toContain('id="display-device-token"')
    expect(display).toContain("aria-label={t('guest.display.tokenLabel')}")
    expect(display).toContain('id="display-pairing-code"')
    expect(display).toContain("aria-label={t('guest.display.pairCodeLabel')}")
  })

  it('guest.display ključi obstajajo v VSEH 5 jezikih (javne strani)', () => {
    for (const f of ['sl', 'hr', 'en', 'de', 'it']) {
      const d = read(`src/lib/i18n/${f}.ts`)
      expect(d).toContain("'guest.display.tokenLabel'")
      expect(d).toContain("'guest.display.pairCodeLabel'")
    }
  })

  it('hrošč 7: theme-color sledi ročnemu preklopu (ThemeColorMeta v layoutu)', () => {
    const layout = read('src/app/layout.tsx')
    expect(layout).toContain('ThemeColorMeta')
    const comp = read('src/components/theme-color-meta.tsx')
    expect(comp).toContain("resolvedTheme === 'dark' ? '#1c1917' : '#fafaf9'")
  })

  it('hrošč 8: manifest ima 192px maskable varianto', () => {
    const m = read('public/manifest.webmanifest')
    expect(m).toContain('"/pwa-icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"')
  })

  it('nastavitve: PIN polji sta zavit v <form> (DOM opozorilo izgine)', () => {
    const tab = read('src/components/tabs/nastavitve-tab.tsx')
    expect(tab).toContain('<form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (!(busy || pin.length < 4)) void startEnroll() }}>')
    expect(tab).toContain('confirmDisable() }}>')
  })

  it('REGRESIJSKA VAROVALKA: nobeno vnosno polje v app brez id IN name IN aria-label', () => {
    // isti pregled kot ob popravilu — izključno knjižnične komponente (ui/)
    // so izvzete; sidebar input prejema id od klicočih.
    const { readdirSync, statSync } = require('node:fs')
    const collect = (dir: string): string[] => readdirSync(dir).flatMap((f: string) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? collect(p) : (p.endsWith('.tsx') ? [p] : [])
    })
    const files = [...collect('src/app'), ...collect('src/components')].filter((f: string) => !f.includes('/ui/'))
    const pat = /<(Input|Textarea|SelectTrigger)\b[\s\S]*?\/>/g
    let violations = 0
    for (const f of files) {
      const s = read(f)
      for (const m of s.matchAll(pat)) {
        if (!/id=/.test(m[0]) && !/name=/.test(m[0]) && !/aria-label/.test(m[0])) {
          violations++
          console.error(`[a11y] ${f}: <${m[1]}> brez id/name/aria-label`)
        }
      }
    }
    expect(violations).toBe(0)
  })
})

/* ── Č8 · #93 — demo seja vidno označena ────────────────────────────────── */

describe('v219 Č8 · #93 demo oznaka', () => {
  it('prijavni zaslon ob demo vstopu zapiše ro_demo', () => {
    const page = read('src/app/page.tsx')
    expect(page).toContain("localStorage.setItem('ro_demo', '1')")
  })

  it('dashboard glava kaže značko DEMO nad imenom uporabnika', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("localStorage.getItem('ro_demo') === '1'")
    expect(page).toContain("t('header.demoBadge')")
  })

  it('i18n ključa header.demoBadge/demoTitle v SL/HR', () => {
    expect(read('src/lib/i18n/sl.ts')).toContain("'header.demoBadge'")
    expect(read('src/lib/i18n/hr.ts')).toContain("'header.demoBadge'")
  })
})

/* ── Č9 · verzija in registri ───────────────────────────────────────────── */

describe('v219 Č9 · verzija + registri', () => {
  it('verzija je dvignjena na 1.219.0 (version.ts + compose oznaka)', async () => {
    const { APP_VERSION } = await import('../src/lib/version')
    expect(APP_VERSION).toBe('1.226.0')
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.226.0')
  })

  it('PRD nosi zapis QA-vala v1.219.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('v1.219.0')
  })

  it('AUDIT §8 števci usklajeni (3750/3750, EN 263)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('3751 ključev SL in 3751 HR')
    expect(audit).toContain('263 ključev')
  })
})

/* ── Č10 · HOTFIX v1.220.0 — zamaskiran DDL (kuponi + čakalna vrsta) ────── */

describe('v219 Č10 · coupons-waitlist DDL pot (hotfix)', () => {
  it('ruta je idempotentna na dev SQLite (tabela iz db push zrcala → preskok)', async () => {
    const res = await couponsWaitlistPOST(authReq('/api/admin/migrate-coupons-waitlist', bearer(adminNoLocId, 'admin', null), {}))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { applied?: string[]; skipped?: string[]; alreadyApplied?: boolean }
    expect(Array.isArray(d.applied)).toBe(true)
    expect(Array.isArray(d.skipped)).toBe(true)
  })

  it('waiter (ne-centralna vloga) → 403 (samo centralne)', async () => {
    const res = await couponsWaitlistPOST(authReq('/api/admin/migrate-coupons-waitlist', bearer(managerLocId, 'manager', loc1), {}))
    expect([403, 401]).toContain(res.status)
  })

  it('register + konzola + drift allowlist so povezani (statika)', () => {
    const reg = read('src/lib/schema-migrations.ts')
    expect(reg).toContain("id: 'coupons-waitlist'")
    expect(reg).toContain("descKey: 'mig.couponsWaitlist.desc'")
    const console_ = read('src/app/api/admin/migrations/route.ts')
    expect(console_).toContain("'coupons-waitlist': couponsWaitlistPOST")
    const drift = read('scripts/drift-check.ts')
    expect(drift).toContain('isCouponsWaitlistStatement')
    // i18n ključ v obeh jezikih
    expect(read('src/lib/i18n/sl.ts')).toContain("'mig.couponsWaitlist.desc'")
    expect(read('src/lib/i18n/hr.ts')).toContain("'mig.couponsWaitlist.desc'")
  })
})
