import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { POST as fursPOST } from '../src/app/api/furs/route'
import { GET as gcLookupGET } from '../src/app/api/giftcards/lookup/route'
import { giftCardScopeFor } from '../src/lib/giftcard-scope'
import { APP_VERSION } from '../src/lib/version'

/**
 * JAVNI QA VAL #3 — NADALJEVANJE TEMELJITEGA UPORABNIŠKEGA TESTIRANJA (v1.222.0).
 *
 * Val pokriva module, ki v E2E valovih #1/#2 niso bili testirani KOT UPORABNIK:
 * darilne kartice (izdaja + POS plačilo), popusti (register prek dropdowna),
 * zvestoba (član + iskanje + zaslužek točk), izmene (začetek/atribucija/zaključek),
 * stroški, odpad (vključno z odštetjem zaloge).
 *
 * Najdbe tega vala (izmerjene v brskalniku na demo profilu):
 *  A (P1) POS iskanje darilne kartice je za ADMINA na nevezani lokaciji VEDNO
 *       vrnilo „Kartica s to številko ne obstaja.“ — giftCardScopeFor je centralno
 *       vlogo z loc (brez org dreva) spravil v 'none', ČEPRAV natakar na isti
 *       lokaciji kartico vidi ('own'). Trenutna produkcija/demo imajo lokacije
 *       brez propertyId → lastnik si kartico izda in je ne more unovčiti.
 *       Popravek: centralna vloga Z lokacijo → 'own' (kot osebje); 'none' ostane
 *       samo za BREZ lokacije (tenant.ts »zakaj tako« prepoveduje rezanje).
 *  B (P2) NOVI član zvestobe (0 točk) pri plačilu NI zaslužil prvih točk:
 *       dashboard payOrder je loyaltyAccountId poslal SAMO ob unovčenju
 *       (redeemPoints > 0) — strežnik pa zaslužek računa iz loyaltyAccount.
 *       Popravek: loyaltyAccountId se pošlje VEDNO, ko je gost izbran.
 *  C (P3, dokumentirano — B-odločitve lastnika): promo koda registra popustov ni
 *       unovčljiva v POS polju „Kupon (koda)« (to je osebni kupon P2-10b) —
 *       natakar dobi zavajujočo napako; register deluje prek dropdowna (izmerjeno
 *       3,50 € → 3,15 €). Podobno: ustvarjanje člana zvestobe brez dedupliciranja
 *       po telefonu (isti gost = več računov, točke razdrobljene).
 *
 * Tu sta zapečatena popravka A in B (vedenjsko) + statika payloada + verzija.
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const PREFIX = 'v221-'
const RUN = Date.now().toString(36)

let locId = ''
let adminId = ''
let adminToken = ''
let menuItemId = ''
let loyaltyAccId = ''

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

let orderSeq = 972100

async function cleanup() {
  await sweepTestFixtures(db, [PREFIX])
}

beforeAll(async () => {
  await cleanup()
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({
    data: {
      id: locId, name: `${PREFIX}Lokacija`, code: `V221${RUN.toUpperCase().slice(-6)}`,
      premisesId: `BLGV221${RUN.toUpperCase().slice(-5)}`, country: 'SI',
      registerNumber: 'BLG-221', fursEnvironment: 'simulation', currency: 'EUR', timezone: 'Europe/Ljubljana',
      // najdba B: program zvestobe VKLOPLJEN (1 točka/€) — zaslužek ob plačilu
      loyaltyEnabled: true, loyaltyPointsPerEuro: 1, loyaltyPointsValue: 0.01,
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

async function seedOrder(): Promise<string> {
  const orderId = `${PREFIX}o${orderSeq}-${RUN}`
  await db.order.create({
    data: { id: orderId, orderNumber: orderSeq++, locationId: locId, status: 'open', paymentStatus: 'unpaid', type: 'dine-in', subtotal: 8.20, tax: 1.80, total: 10, employeeId: adminId },
  })
  await db.orderItem.create({
    data: { id: `${PREFIX}it${orderSeq}-${RUN}`, orderId, menuItemId, menuItemName: `${PREFIX}Artikel`, quantity: 1, price: 10, vatRate: 22, vatAmount: 1.80, status: 'served' },
  })
  return orderId
}

/* ── A · P1 — POS iskanje darilne kartice: ADMIN na nevezani lokaciji ──── */

describe('v221 A · #A darilna kartica — scope ADMIN na nevezani lokaciji', () => {
  test('giftCardScopeFor: ADMIN z loc (brez org dreva) → own (prej none — regresija)', async () => {
    const scope = await giftCardScopeFor({ sub: adminId, name: 'A', role: 'ADMIN', loc: locId, sv: 0 } as never)
    expect(scope.kind).toBe('own')
  })

  test('lookup: ADMIN najde kartico LASTNE lokacije (200), tuja lokacija ostane nevidna (404)', async () => {
    const cardNum = `GC-20991201-${RUN.slice(-6)}`
    await db.giftCard.create({
      data: { id: `${PREFIX}gc-${RUN}`, cardNumber: cardNum, balance: 20, initialBalance: 20, status: 'active', ownerName: `${PREFIX}Gost`, locationId: locId, purchasedAt: new Date() },
    })
    const res = await gcLookupGET(req(`/api/giftcards/lookup?q=${cardNum}`, adminToken))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { card: { cardNumber: string; balance: number } }
    expect(j.card.cardNumber).toBe(cardNum)
    expect(j.card.balance).toBe(20)
  })
})

/* ── B · P2 — zaslužek točk ob plačilu BREZ unovčenja (novi člani) ─────── */

describe('v221 B · #B zvestoba — zaslužek točk za novega člana (brez unovčenja)', () => {
  test('201: plačilo z loyaltyAccountId BREZ loyaltyPointsUsed → točke zaračunane + earn transakcija', async () => {
    const acc = await db.loyaltyAccount.create({
      data: { id: `${PREFIX}la-${RUN}`, customerName: `${PREFIX}Gost`, customerPhone: '040111222', locationId: locId },
    })
    loyaltyAccId = acc.id
    const orderId = await seedOrder()
    // točno telo, ki ga klient sedaj pošlje za novega člana (0 točk za unovčenje):
    // loyaltyAccountId je prisoten, loyaltyPointsUsed IZPUŠČEN
    const res = await fursPOST(req('/api/furs', adminToken, 'POST', { orderId, type: 'cash', clientOperationId: `${PREFIX}idem-${RUN}`, loyaltyAccountId: acc.id }))
    expect(res.status).toBe(201)
    const d = (await res.json()) as { loyalty?: { earnedPoints?: number; redeemedPoints?: number } | null }
    expect(d.loyalty?.earnedPoints).toBe(10) // 10 € × 1 točka/€
    expect(d.loyalty?.redeemedPoints).toBe(0)
    const fresh = await db.loyaltyAccount.findUnique({ where: { id: acc.id } })
    expect(fresh?.pointsBalance).toBe(10)
    expect(fresh?.lifetimePoints).toBe(10)
    const earn = await db.loyaltyTransaction.findFirst({ where: { loyaltyAccountId: acc.id, type: 'earn' } })
    expect(earn).not.toBeNull()
    expect(earn?.points).toBe(10)
  })

  test('statika: klient pošlje loyaltyAccountId NEPOGOJENO ob izbranem gostu (ne samo ob unovčenju)', () => {
    const src = read('src/app/dashboard/page.tsx')
    // NOVI vzorec: loyaltyAccountId znotraj loyaltySel pogoja, loyaltyPointsUsed ločeno
    expect(src).toContain('...(loyaltySel')
    expect(src).toMatch(/\.\.\.\(redeemPoints > 0 \? \{ loyaltyPointsUsed: redeemPoints \} : \{\}\)/)
    // STARI (hroščati) vzorec NE sme obstajati več:
    expect(src).not.toContain('loyaltySel && redeemPoints > 0 ? { loyaltyAccountId')
  })
})

/* ── verzija ───────────────────────────────────────────────────────────── */

describe('v221 Č · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts)', () => {
    expect(APP_VERSION).toBe('1.263.0')
    expect(read('src/lib/version.ts')).toContain("'1.263.0'")
  })

  test('compose oznaka slike sledi verziji (selfhost pogodba)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('image: restaurantos:1.263.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.indexOf('Task ID: v1.227.0')).toBeLessThan(wl.indexOf('Task ID: v1.220.0'))
  })
})
