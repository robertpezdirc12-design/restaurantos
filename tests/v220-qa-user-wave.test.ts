import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { mapTable } from '../src/lib/map'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { GET as tablesGET } from '../src/app/api/tables/route'
import { GET as hoursGET } from '../src/app/api/opening-hours/route'
import { APP_VERSION } from '../src/lib/version'

/**
 * JAVNI QA VAL #2 — UPORABNIŠKO TESTIRANJE KOT NATAKAR/GOST (v1.220.0).
 *
 * Val je nastal iz temeljitega E2E pregleda demo profila (agent-browser, živi
 * dev strežnik): mize → naročilo → plačilo → storno, hitra prodaja, KDS,
 * nabava (PO → prevzem → zaloga), čakalna lista → usaditev, rezervacije
 * (javni widget + osebje), QR meni → spletno naročilo → mnenje.
 *
 * Najdbe tega vala (vse izmerjene, ne ugibane):
 *  #5 (P1) celotno plačilo naročila Z izstavki (split T1/T2) je padlo s P2002
 *       na (orderId, checkNumber) → 500 + toast „Plačila ni bilo mogoče
 *       zaključiti“; posamično plačilo izstavka je delovalo;
 *  #4 (P1) usaditev s čakalne liste zaklene mizo (DB 'occupied'), a je Issue #70
 *       izpeljava preslikala v DIRTY — natakar je s klikom „pospravi“ pobrisal
 *       zaklenitev, usajeni gost pa izginil s tlorisa (izmerjeno Miza 5/10);
 *  #2 (P2) prazen urnik: status je lagal „Odprto 08:00–22:00“ (privzeta
 *       nadomestitev), rezervacijski widget pa iz istih podatkov „no_hours →
 *       zaprto“ — dve komponenti, isti vir, nasprotna odgovora; demo ni imel
 *       urnika, torej rezervacije niso bile testabilne iz prve roke;
 *  #6 (P3) prevzemni dialog: polje „Sprejeto“ brez dostopnega imena (Label brez
 *       htmlFor, Input brez aria-label — vzorec sosednjega „Zavrnjeno“ ima);
 *  #1 (P1, okolje) `bun run demo` zaganja next dev pod BUN runtime → Turbopack
 *       zunanji paketi (prisma) razpadejo → VSE /api/* z bazo vračajo 500.
 *
 * Tu so zapečateni VSAK popravek (vedenjsko, kjer gre, sicer statika po
 * vzorcu v219) + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const PREFIX = 'v220-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let menuItemId = ''

function req(url: string, token: string | null, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let orderSeq = 962200

async function cleanup() {
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanup()
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({
    data: {
      id: locId, name: `${PREFIX}Lokacija`, code: `V220${RUN.toUpperCase().slice(-6)}`,
      premisesId: `BLGV220${RUN.toUpperCase().slice(-5)}`, country: 'SI',
      registerNumber: 'BLG-220', fursEnvironment: 'simulation', currency: 'EUR', timezone: 'Europe/Ljubljana',
    },
  })
  adminId = `${PREFIX}admin-${RUN}`
  const pin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...pin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Artikel`, price: 10, categoryId: cat.id } })).id
})

afterAll(async () => {
  await cleanup()
})

/* ── Č1 · #5 — celotno plačilo naročila z izstavki (P2002) ───────────────── */

describe('v220 Č1 · #5 celotno plačilo po splitu (ne P2002)', () => {
  test('201: naročilo z 2 izstavkoma se celotno plača — izstavek #1 prevzame, vsi plačani', async () => {
    const orderId = `${PREFIX}o-split-${RUN}`
    await db.order.create({
      data: { id: orderId, orderNumber: orderSeq++, locationId: locId, status: 'open', paymentStatus: 'unpaid', type: 'dine-in', subtotal: 16.39, tax: 3.61, total: 20, employeeId: adminId },
    })
    for (const [i, checkId] of [`${PREFIX}chk1-${RUN}`, `${PREFIX}chk2-${RUN}`].entries()) {
      // vrstni red: Check NAJPREJ (OrderItem.checkId ima FK nanj — P2003, če
      // postavka nastane pred izstavkom; ujeto v samopregledu vala po prekinitvi)
      await db.check.create({ data: { id: checkId, checkNumber: i + 1, orderId, subtotal: 8.20, tax: 1.80, total: 10, paymentStatus: 'unpaid' } })
      await db.orderItem.create({
        data: { id: `${PREFIX}it${i}-${RUN}`, orderId, menuItemId, menuItemName: `${PREFIX}Artikel`, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.80, status: 'served', checkId },
      })
    }
    const res = await fursPOST(req('/api/furs', adminToken, 'POST', { orderId, type: 'cash', clientOperationId: `${PREFIX}idem-${RUN}` }))
    expect(res.status).toBe(201)
    const d = (await res.json()) as { invoice?: { id?: string; invoiceNumber?: string } }
    expect(d.invoice?.invoiceNumber).toBeTruthy()
    // naročilo plačano, VSI izstavki plačani (deljeni ostanki ne visijo)
    const order = await db.order.findUnique({ where: { id: orderId }, select: { status: true, paymentStatus: true } })
    expect(order?.status).toBe('paid')
    expect(order?.paymentStatus).toBe('paid')
    const checks = await db.check.findMany({ where: { orderId }, select: { checkNumber: true, paymentStatus: true, total: true } })
    expect(checks.length).toBe(2)
    for (const c of checks) expect(c.paymentStatus).toBe('paid')
    // izstavek #1 nosi znesek CELOTNEGA naročila (prevzel ga je, ne podvijal)
    // (Check.total je Decimal → objekt, primerjava s številom potrebuje Number())
    const first = checks.find((c) => c.checkNumber === 1)
    expect(Number(first?.total)).toBe(20)
    // točno EN račun (noben duplikat iz poskusa, ki bi padel)
    const receipts = await db.receipt.findMany({ where: { orderId }, select: { id: true } })
    expect(receipts.length).toBe(1)
  })

  test('201: naročilo BREZ izstavkov še vedno ustvari izstavek #1 (nazaj-kompatibilno)', async () => {
    const orderId = `${PREFIX}o-plain-${RUN}`
    await db.order.create({
      data: { id: orderId, orderNumber: orderSeq++, locationId: locId, status: 'open', paymentStatus: 'unpaid', type: 'dine-in', subtotal: 8.20, tax: 1.80, total: 10, employeeId: adminId },
    })
    await db.orderItem.create({
      data: { id: `${PREFIX}itp-${RUN}`, orderId, menuItemId, menuItemName: `${PREFIX}Artikel`, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.80, status: 'served' },
    })
    const res = await fursPOST(req('/api/furs', adminToken, 'POST', { orderId, type: 'cash', clientOperationId: `${PREFIX}idem2-${RUN}` }))
    expect(res.status).toBe(201)
    const checks = await db.check.findMany({ where: { orderId }, select: { checkNumber: true } })
    expect(checks.length).toBe(1)
    expect(checks[0].checkNumber).toBe(1)
  })

  test('statika: issue.ts ima varovalo obstoječega izstavka #1 (update, ne create)', () => {
    const src = read('src/lib/furs/issue.ts')
    expect(src).toContain('existingFirst')
    expect(src).toContain("where: { orderId: orderPre.id, checkNumber: 1 }")
    expect(src).toContain("paymentStatus: { not: 'paid' }")
  })
})

/* ── Č2 · #4 — usajena miza s čakalne liste je ZASEDENA, ne „za pospravit“ ── */

describe('v220 Č2 · #4 usaditev čakalne liste na tlorisu', () => {
  test('mapTable: occupied + usajen gost → OCCUPIED + seatedGuest (enota)', () => {
    const t = { id: 't1', number: 5, capacity: 4, area: 'Glavna dvorana', posX: 10, posY: 10, status: 'occupied' }
    const mapped = mapTable(t, null, null, { guestName: 'Petri Čakajoči', party: 2 })
    expect(mapped.status).toBe('OCCUPIED')
    expect(mapped.seatedGuest).toEqual({ guestName: 'Petri Čakajoči', party: 2 })
  })

  test('mapTable: occupied BREZ gosta ostane DIRTY (Issue #70 nedotaknjen)', () => {
    const t = { id: 't2', number: 6, capacity: 4, area: 'Glavna dvorana', posX: 10, posY: 10, status: 'occupied' }
    const mapped = mapTable(t, null, null, null)
    expect(mapped.status).toBe('DIRTY')
    expect(mapped.seatedGuest).toBeNull()
  })

  test('mapTable: gost ne sme preglasiti naročila (activeOrder ostane vir)', () => {
    const t = { id: 't3', number: 7, capacity: 4, area: 'Glavna dvorana', posX: 10, posY: 10, status: 'occupied' }
    const mapped = mapTable(t, { id: 'o1', total: 30, splitCount: 2 }, null, { guestName: 'Nekdo', party: 2 })
    expect(mapped.status).toBe('OCCUPIED')
    expect(mapped.seatedGuest).toBeNull()
    expect(mapped.activeOrder?.id).toBe('o1')
  })

  test('GET /api/tables: usajena miza OCCUPIED z gostom, zastarela occupied brez gosta DIRTY', async () => {
    const tSeated = `${PREFIX}tbl-seat-${RUN}`
    const tStale = `${PREFIX}tbl-stale-${RUN}`
    await db.table.create({ data: { id: tSeated, number: 901, capacity: 4, area: 'Glavna dvorana', posX: 10, posY: 10, status: 'occupied', locationId: locId } })
    await db.table.create({ data: { id: tStale, number: 902, capacity: 4, area: 'Glavna dvorana', posX: 30, posY: 10, status: 'occupied', locationId: locId } })
    await db.waitlistEntry.create({
      data: { id: `${PREFIX}wl-${RUN}`, guestName: `${PREFIX}Gost`, partySize: 3, status: 'seated', tableId: tSeated, locationId: locId, seatedAt: new Date() },
    })
    const res = await tablesGET(req('/api/tables', adminToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { tables?: { id: string; status: string; seatedGuest?: { guestName: string; party: number } | null }[] }
    const seated = d.tables?.find((t) => t.id === tSeated)
    const stale = d.tables?.find((t) => t.id === tStale)
    expect(seated?.status).toBe('OCCUPIED')
    expect(seated?.seatedGuest?.guestName).toBe(`${PREFIX}Gost`)
    expect(seated?.seatedGuest?.party).toBe(3)
    expect(stale?.status).toBe('DIRTY')
    expect(stale?.seatedGuest ?? null).toBeNull()
  })

  test('statika: dashboard ploščica kaže identiteto usajenega gosta (obe pogledi)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('seatedGuestL')
    expect(page).toContain('seatedGuest?: { guestName: string; party: number } | null')
  })
})

/* ── Č3 · #2 — prazen urnik ne laže več „Odprto 08:00–22:00“ ─────────────── */

describe('v220 Č3 · #2 pošten status ob praznem urniku', () => {
  test('GET /api/opening-hours: brez vrstic → zaprto (ne privzetih 08:00–22:00)', async () => {
    const res = await hoursGET(req('/api/opening-hours', adminToken))
    expect(res.status).toBe(200)
    const d = (await res.json()) as { status?: { isOpen?: boolean; phase?: string; detail?: string } }
    expect(d.status?.isOpen).toBe(false)
    expect(d.status?.phase).toBe('closed_day')
    expect(d.status?.detail ?? '').not.toContain('08:00')
  })

  test('statika: computeStatus ne izmišljuje več privzetih vrstic', () => {
    const src = read('src/app/api/opening-hours/route.ts')
    expect(src).not.toContain("openTime: '08:00'")
    expect(src).toContain('const v = validateOpeningHoursRows(rows)')
  })

  test('statika: seed naloži urnik 10:00–22:00 (demo rezervacije testabilne iz prve roke)', () => {
    const seed = read('prisma/seed.ts')
    expect(seed).toContain('db.openingHours.upsert')
    expect(seed).toContain("openTime: '10:00'")
    expect(seed).toContain("closeTime: '22:00'")
  })
})

/* ── Č4 · #6 — prevzemni dialog: „Sprejeto“ ima dostopno ime ──────────────── */

describe('v220 Č4 · #6 a11y prevzemnega dialoga', () => {
  test('statika: Input Sprejeto nosi aria-label (vzorec Zavrnjeno)', () => {
    const src = read('src/components/tabs/nabava-tab.tsx')
    const m = src.match(/nb-recv-accept-\$\{it\.id\}[^/]*\/>/)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('aria-label={t(\'proc.accepted\')}')
  })
})

/* ── Č5 · #1 — demo dev strežnik teče pod node (bun lomi Turbopack) ──────── */

describe('v220 Č5 · #1 demo-start runtime', () => {
  test('statika: dev strežnik se zaganja prek devServerRuntime() (node prednost)', () => {
    const src = read('scripts/demo-start.ts')
    expect(src).toContain('function devServerRuntime()')
    expect(src).toContain("spawn(devServerRuntime(), [NEXT_BIN, 'dev'")
    expect(src).not.toContain("spawn(process.execPath, [NEXT_BIN, 'dev'")
  })

  test('regresijska lekcija: opozorilo ob padcu na bun je vidno v dnevniku', () => {
    const src = read('scripts/demo-start.ts')
    expect(src).toContain('node ni bil najden')
    expect(src).toContain('Turbopack')
  })
})

/* ── Č6 · verzija vala ───────────────────────────────────────────────────── */

describe('v220 Č6 · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.279.0')
    expect(readFileSync(join(ROOT, 'deploy/docker-compose.yml'), 'utf8')).toContain('restaurantos:1.279.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.279.0-revizija-produkcije')
  })
})
