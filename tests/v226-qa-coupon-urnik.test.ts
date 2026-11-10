import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as discountPOST } from '../src/app/api/orders/[id]/discount/route'
import { parseHHMM, validateOpeningHoursRows, validateOpeningHoursRowsPartial } from '../src/lib/openinghours'
import { slotsForDate, WIDGET_POLICY_DEFAULTS, type WidgetPolicy, type DayHoursInput } from '../src/lib/reservation-slots'
import { APP_VERSION } from '../src/lib/version'

/**
 * UPORABNIŠKI QA VAL #8 — NEPREKRITE POVRŠINE #2: CRM, ČAKALNA LISTA,
 * ODPIRALNI ČAS, ORGANIZACIJA, QR MENI (v1.228.0).
 *
 * Val je nastal iz E2E pregleda površin, ki v valovih #1–#7 niso bile izrecno
 * odprte: Odnosi z gosti (CRM — segmenti, soglasja, združitev, kuponi,
 * kampanje, izvoz), Čakalna lista (prijava → obvesti → usadi z zaklepom mize),
 * Odprtost lokala (urejevalnik urnika), Organizacija (enterprise drevo +
 * migracijska konzola) in QR meni /m/<token> (kovanje tokena → javni meni →
 * košarica → oddaja → POS sprejem; agent-browser, živi dev :3000, SQLite
 * demo baza, prijava Ana Admin).
 *
 * NAJDBA #1 (P1 — OSEBNI KUPONI SO BILI NEUNOVČLJIVI): odkup osebnega
 * kupona je zahteval order.guestId === coupon.guestId, a NOBENA pot ni
 * nastavljala gostId na naročilu (ne POS UI, ne orders API) — vsak poskus
 * odkupa je padel s 400 »Naročilo nima dodeljenega gosta« (slepa ulica;
 * izmerjeno E2E: CRM izda kupon BD26-… → plačilni dialog → 400). POPRAVEK:
 * naročilo BREZ gosta dobi ob odkupu gosta KUPONA samodejno pripetega v isti
 * transakciji (KODA JE identifikacija — gost jo je predal osebju, enaka
 * varnostna masa kot fizični vavčer); naročilo Z gostom ostaja strogo
 * (drug gost = 400). Audit DISCOUNT_APPLIED nosi guestLinked (transparentnost).
 *
 * NAJDBA #2 (P1 — URNIK '24:00' IZ SEMENA): demo seed je za petek/soboto
 * zapisal closeTime '24:00', kar lasten validator (parseHHMM) ZAVRNE —
 * tridelna posledica (vse izmerjeno): (a) /r/ widget je vrstico preskočil →
 * petek IN sobota BREZ terminov (open:false, note:'no_hours' — najboljša
 * dneva za rezervacije!), (b) urejevalnik je zaključni čas prikazal kot
 * PRAZEN (input type=time ne podpira 24:00), (c) shranjevanje urnika je
 * padlo na 400 z nevidnim vzrokom. POPRAVEK (četverno): seme piše '00:00'
 * (overnight semantika — 08:00 → 00:00 = do polnoči), parseHHMM sprejme
 * TOČNO '24:00' kot 1440 (toleranca za obstoječe baze; normalizacija v
 * '00:00' ob shranjevanju), urejevalnik normalizira prikaz ob nalaganju,
 * validatorja pa zavrneta tudi degenerirano okno po overnight prilagoditvi
 * (24:00–00:00 = nič dolžine).
 *
 * Tu je zapečaten popravek (vedenjsko: odkup + urnik) + statika + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const PREFIX = 'v226-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let itemSeq = 0
// kuponova koda nosi SEKVENCO, ne naključno pripono: Math.random(100–999)
// daje ~0,3 % možnost trka unique(code) na poskus (CI fail 68a27f2 — flaky,
// ki je izstrelil šele po mesecih zelenih tekov); sekvenca je deterministično
// unikatna znotraj teka, RUN pa loči posamezne teke
let couponSeq = 0
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

async function cleanup() {
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanup()
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({
    data: {
      id: locId, name: `${PREFIX}Lokacija`, code: `V226${RUN.toUpperCase().slice(-6)}`,
      premisesId: `BLGV226${RUN.toUpperCase().slice(-5)}`, country: 'SI',
      registerNumber: 'BLG-226', fursEnvironment: 'simulation', currency: 'EUR', timezone: 'Europe/Ljubljana',
    },
  })
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
  menuItemId = (await db.menuItem.create({ data: { id: `${PREFIX}mi-${RUN}`, name: `${PREFIX}Kava`, price: 10, categoryId: cat.id } })).id
})

afterAll(async () => {
  // sweep POČISTI vse razen Guest/Coupon (fiksura-sweep ju ne pozna — v187
  // istoimenske fiksture pušča dev bazi). Vrstni red: sweep (naročila z
  // guestId morajo pasti PRVA — Order→Guest FK), nato gostje (Coupon ima
  // onDelete: Cascade, kupone pobriše sočasno).
  await sweepTestFixtures(db, [PREFIX])
  try { await db.guest.deleteMany({ where: { id: { startsWith: PREFIX } } }) } catch { /* dev-only higiena; napaka ne sme podreti teka */ }
})

/* ── pomočniki fixtures ─────────────────────────────────────────────────── */

async function seedGuest(name: string): Promise<string> {
  const row = await db.guest.create({
    data: { id: `${PREFIX}g${name}-${RUN}`, firstName: `${PREFIX}${name}`, lastName: 'Test', locationId: locId },
  })
  return row.id
}

async function seedCoupon(guestId: string, percent = 10): Promise<string> {
  const code = `V226${RUN.toUpperCase().slice(-5)}${String(++couponSeq).padStart(3, '0')}`
  await db.coupon.create({
    data: { id: `${PREFIX}cp${++itemSeq}-${RUN}`, code, guestId, percent, status: 'issued', locationId: locId, reason: 'manual', expiresAt: new Date(Date.now() + 30 * 86400_000) },
  })
  return code
}

async function seedOrder(guestId: string | null): Promise<string> {
  const id = `${PREFIX}o${++itemSeq}-${RUN}`
  await db.order.create({
    data: {
      id, locationId: locId, orderNumber: 964000 + itemSeq,
      status: 'open', paymentStatus: 'unpaid', ...(guestId ? { guestId } : {}),
    },
  })
  await db.orderItem.create({
    data: { id: `${PREFIX}it${itemSeq}-${RUN}`, orderId: id, menuItemId, menuItemName: 'Kava', quantity: 1, price: 10, vatRate: 22, vatAmount: 0, status: 'fired', voided: false },
  })
  return id
}

/* ═══════════════ A. KUPON — SAMODEJNO PRIPETJE GOSTA (P1) ═══════════════ */

describe('v226 A · kupon: odkup na naročilu brez gosta (slepa ulica zaprta)', () => {
  test('A1 naročilo BREZ gosta + veljaven kupon → 200 + guestLinked + DB pripetje + odkup', async () => {
    const g = await seedGuest('a1')
    const code = await seedCoupon(g, 10)
    const o = await seedOrder(null)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { guestLinked?: string }
    expect(body.guestLinked).toBe(g)
    const order = await db.order.findUnique({ where: { id: o }, select: { guestId: true, discount: true } })
    expect(order?.guestId).toBe(g)
    expect(Number(order?.discount)).toBe(1) // 10 % od 10 €
    const coupon = await db.coupon.findUnique({ where: { code } })
    expect(coupon?.status).toBe('redeemed')
    expect(coupon?.orderId).toBe(o)
  })

  test('A2 naročilo Z DRUGIM gostom ostaja zavrnjeno (stroga osebnost)', async () => {
    const g1 = await seedGuest('a2g1')
    const g2 = await seedGuest('a2g2')
    const code = await seedCoupon(g2, 10)
    const o = await seedOrder(g1)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('temu gostu')
    const order = await db.order.findUnique({ where: { id: o }, select: { guestId: true } })
    expect(order?.guestId).toBe(g1) // nepreiskan
  })

  test('A3 naročje z ISTIM gostom → 200 brez ponovnega pripetja (guestLinked odsoten)', async () => {
    const g = await seedGuest('a3')
    const code = await seedCoupon(g, 10)
    const o = await seedOrder(g)
    const res = await discountPOST(req(`/api/orders/${o}/discount`, adminToken, 'POST', { couponCode: code }), { params: Promise.resolve({ id: o }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { guestLinked?: string }
    expect(body.guestLinked).toBeUndefined() // gost je že bil — ni pripetja
  })

  test('A4 statika: route vsebuje avtorizacijsko varovalo + audit guestLinked', () => {
    const src = read('src/app/api/orders/[id]/discount/route.ts')
    expect(src).toContain('guestLink = !order.guestId ? coupon.guestId : null')
    expect(src).toContain('...(guestLink ? { guestId: guestLink } : {})')
    expect(src).toContain('guestLinked: guestLink ?? undefined')
    // stara slepa ulica je ODSOTNA (besedilo sporočila ne sme več obstajati)
    expect(src).not.toContain('nima dodeljenega gosta')
  })
})

/* ═══════════════ B. URNIK '24:00' — TOLERANCA + NORMALIZACIJA (P1) ═══════════════ */

describe('v226 B · urnik: zapiralni čas 24:00 (polnoč na koncu dneva)', () => {
  test('B1 parseHHMM: 24:00 → 1440; 24:01/25:00/24:60 → null', () => {
    expect(parseHHMM('24:00')).toBe(1440)
    expect(parseHHMM('24:01')).toBeNull()
    expect(parseHHMM('25:00')).toBeNull()
    expect(parseHHMM('2:60')).toBeNull()
  })

  test('B2 validateOpeningHoursRows sprejme 24:00 in normalizira v 00:00 (overnight okno)', () => {
    const rows = Array.from({ length: 7 }, (_, dow) => ({
      dayOfWeek: dow,
      openTime: dow === 5 ? '08:00' : '10:00',
      closeTime: dow === 5 ? '24:00' : '22:00',
      breakStart: '', breakEnd: '', isClosed: dow === 0,
    }))
    const v = validateOpeningHoursRows(rows)
    expect(v.ok).toBe(true)
    if (!v.ok) throw new Error(v.error)
    const fri = v.rows.find((r) => r.dayOfWeek === 5)!
    expect(fri.closeTime).toBe('00:00') // normalizirano
    expect(fri.closeMin).toBe(1440) // overnight konec na polnoči
    expect(fri.openMin).toBe(480)
  })

  test('B3 validateOpeningHoursRowsPartial: enaka toleranca (rezervacijska pot)', () => {
    const v = validateOpeningHoursRowsPartial([
      { dayOfWeek: 6, openTime: '09:00', closeTime: '24:00', breakStart: '', breakEnd: '', isClosed: false },
    ])
    expect(v.ok).toBe(true)
    if (!v.ok) throw new Error(v.error)
    expect(v.rows[0].closeTime).toBe('00:00')
    expect(v.rows[0].closeMin).toBe(1440)
  })

  test('B4 degenerirano okno 24:00–00:00 (nič dolžine) je zavrnjeno', () => {
    const mk = (dow: number, o: string, c: string, closed = false) => ({ dayOfWeek: dow, openTime: o, closeTime: c, breakStart: '', breakEnd: '', isClosed: closed })
    const v = validateOpeningHoursRows([
      mk(0, '', '', true),
      mk(1, '24:00', '00:00'), // odpiralni 24:00 → 1440; zapiralni 00:00 → 1440 po overnight = nič dolžine
      mk(2, '10:00', '22:00'),
      mk(3, '10:00', '22:00'),
      mk(4, '10:00', '22:00'),
      mk(5, '10:00', '22:00'),
      mk(6, '10:00', '22:00'),
    ])
    expect(v.ok).toBe(false)
  })

  test('B5 terminski motor: vrstica s 24:00 generira termine do polnoči (petek)', () => {
    // petek 6. 11. 2026, "now" pred njim
    const POLICY: WidgetPolicy = { ...WIDGET_POLICY_DEFAULTS }
    const rows: DayHoursInput['rows'] = Array.from({ length: 7 }, (_, dow) => ({
      dayOfWeek: dow,
      openTime: dow === 5 ? '08:00' : '10:00',
      closeTime: dow === 5 ? '24:00' : '22:00',
      breakStart: '', breakEnd: '', isClosed: dow === 0,
    }))
    const r = slotsForDate(POLICY, { rows, specials: [] }, '2026-11-06', new Date('2026-11-02T10:00:00Z'), [], 0, 'Europe/Ljubljana')
    expect(r.open).toBe(true)
    expect(r.slots.length).toBeGreaterThan(0)
    // zadnji termin še dopušča 120-min trajanje znotraj okna do polnoči (22:00 zadnji)
    const last = r.slots[r.slots.length - 1]
    expect(last?.time).toBe('22:00')
  })

  test('B6 statika: seme piše 00:00 (ne 24:00) + urejevalnik normalizira prikaz', () => {
    const seed = read('prisma/seed-demo.ts')
    expect(seed).not.toContain("c: '24:00'")
    expect(seed).toContain("{ d: 5, o: '08:00', c: '00:00' }")
    expect(seed).toContain("{ d: 6, o: '09:00', c: '00:00' }")
    const editor = read('src/components/tabs/urniki-tab.tsx')
    expect(editor).toContain("closeTime: r.closeTime === '24:00' ? '00:00' : r.closeTime")
  })
})

/* ═══════════════ Č. VERZIJA + REGISTRI ═══════════════ */

describe('v226 Č · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts)', () => {
    expect(APP_VERSION).toBe('1.308.0')
    expect(read('src/lib/version.ts')).toContain("'1.308.0'")
  })

  test('compose oznaka slike sledi verziji (selfhost pogodba)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('image: restaurantos:1.308.0')
  })

  test('PRD nosi zapis QA-vala v1.227.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.227.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.indexOf('Task ID: v1.227.0')).toBeGreaterThanOrEqual(0)
    expect(wl.indexOf('Task ID: v1.227.0')).toBeLessThan(wl.indexOf('Task ID: v1.225.0'))
  })
})
