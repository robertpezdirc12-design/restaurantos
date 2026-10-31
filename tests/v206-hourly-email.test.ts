/**
 * OSS-8 (v1.206.0) — URNA RAZČLENITEV PRODAJE V DNEVNEM E-POŠTNEM DIGESTU.
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md — OrderRestro #13.
 *
 * KONTEKST: OrderRestro #13 „Načrtovana poročila po e-pošti: 18 poročil +
 * urni pošiljanji" — analiza v1.199.0: „urni poročila na SMTP NI". Cron
 * (Vercel 0 5 * * *), SMTP transport (RestaurantSettings) in urna analitika
 * (salesByHour, OPS-10 val 1) ŽE obstajajo — preostali deterministični
 * A-del: urna razčlenitev prodaje potuje Z DNEVNIM digestom:
 *   - čisti sloj hourly-email.ts (0 uvozov) — gard podatkov + sestava vrstic;
 *   - sendDailyDigest izpelje urne vedre iz ŽE naloženih Receipt.createdAt
 *     (brez nove poizvedbe; storno izključeni z istim continue);
 *   - sekcija »Prodaja po urah:« po top artiklih, pred naročilnicami;
 *   - vrhunec dneva pri ≥ 2 aktivnih urah (ena ura je svoj vrhunec).
 * Poštena meja (GAP dokument): samodejni pošiljanji VSAKO uro ostanejo B —
 * Vercel cron ima en termin.
 *
 * 0 omrežja, 0 AI, 0 novih odvisnosti, 0 DDL. Fiksture s predpono v206-.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { sendDailyDigest, dailyDigestEmailText } from '../src/lib/daily-email'
import {
  activeHourlyBuckets, hourlyReportSection, orderWord, peakHour,
  type HourlyEmailBucket,
} from '../src/lib/hourly-email'
import { startOfDay } from '../src/lib/cron-daily'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { sweepTestFixtures } from './helpers/fixture-sweep'

const P = 'v206'
const RECIPIENT = 'v206-digest@example.local'

/** Fiksni trenutek (vzorec v167) — zajeti dan = dan pred NOW (lokalno). */
const NOW = new Date('2026-06-10T12:00:00Z')
const TO = startOfDay(NOW)
const FROM = new Date(TO.getTime())
FROM.setDate(FROM.getDate() - 1)

/** Lokalni čas znotraj zajetega dne (deterministično brez UTC zank). */
const at = (day: Date, h: number, m: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0)

let sendCalls = 0
let lastMail: { subject?: string; text?: string } = {}
const mailer = {
  sendMail: async (mail: { subject?: string; text?: string }): Promise<{ messageId: string }> => {
    sendCalls++
    lastMail = mail
    return { messageId: `${P}msg` }
  },
}
const transportFactory = async (): Promise<typeof mailer> => mailer

let settingsId: string | null = null
let savedSettings: { email: string; emailEnabled: boolean } | null = null

async function setEmailEnabled(on: boolean): Promise<void> {
  if (!settingsId) throw new Error(`${P} nastavitve ne obstajajo — predpogoj testa ni izpolnjen`)
  await db.restaurantSettings.update({ where: { id: settingsId }, data: { emailEnabled: on } })
}

async function clearFixtures(): Promise<void> {
  await db.scheduledEmailLog.deleteMany({ where: { recipient: RECIPIENT } })
  await db.receipt.deleteMany({ where: { id: { startsWith: P } } })
  await db.order.deleteMany({ where: { id: { startsWith: P } } })
  await db.location.deleteMany({ where: { id: { startsWith: P } } })
}

beforeAll(async () => {
  await clearFixtures()
  const existing = await db.restaurantSettings.findFirst()
  if (existing) {
    settingsId = existing.id
    savedSettings = { email: existing.email, emailEnabled: existing.emailEnabled }
    await db.restaurantSettings.update({ where: { id: existing.id }, data: { email: RECIPIENT, emailEnabled: true } })
  } else {
    settingsId = `${P}settings`
    await db.restaurantSettings.create({ data: { id: settingsId, email: RECIPIENT, emailEnabled: true } })
  }
})

afterAll(async () => {
  await clearFixtures()
  if (settingsId && savedSettings) {
    await db.restaurantSettings.update({ where: { id: settingsId }, data: { email: savedSettings.email, emailEnabled: savedSettings.emailEnabled } })
  } else if (settingsId) {
    await db.restaurantSettings.delete({ where: { id: settingsId } })
  }
  await sweepTestFixtures(db, [P])
})

/** Fiksatura: lokacija + naročilo + računi (2 v 17. uri, 1 v 19., storno v 17. in 21.). */
async function seedSales(): Promise<string> {
  const locId = `${P}loc-${Date.now().toString(36)}`
  await db.location.create({
    data: { id: locId, name: `${P} Urna kuhna`, code: `H2UR-${Date.now().toString(36).toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  const orderId = `${P}ord-${Date.now().toString(36)}`
  await db.order.create({
    data: { id: orderId, orderNumber: 206000001 + Math.floor(Math.random() * 900), locationId: locId, status: 'paid', paymentStatus: 'paid', type: 'dine-in', total: 169 },
  })
  const mk = (createdAt: Date, isStorno: boolean): { createdAt: Date; isStorno: boolean } => ({ createdAt, isStorno })
  const rows = [
    mk(at(FROM, 17, 30), false), // 45.60 → ura 17
    mk(at(FROM, 17, 50), false), // 23.40 → ura 17
    mk(at(FROM, 19, 0), false), // 100.00 → ura 19
    mk(at(FROM, 17, 45), true), // storno −12.20 → nikoli v odseku
    mk(at(FROM, 21, 0), true), // storno → ura 21 ne sme obstajati
  ]
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const storno = r.isStorno
    const total = storno ? -12.2 : i === 2 ? 100 : i === 1 ? 23.4 : 45.6
    await db.receipt.create({
      data: {
        id: `${P}rc-${i}-${Date.now().toString(36)}`, receiptNumber: `206-${i}-${Date.now().toString(36)}`, orderId, locationId: locId,
        isStorno: storno, stornoOf: storno ? `${P}orig-${i}` : '',
        businessName: P, businessAddress: P, businessId: P, taxId: 'SI20620620',
        subtotal: total, totalVat: 0, total, vatBreakdown: JSON.stringify({}),
        paymentMethod: 'cash', createdAt: r.createdAt, updatedAt: r.createdAt,
      },
    })
  }
  return locId
}

describe('Č1 — čisti sloj hourly-email.ts (0 uvozov)', () => {
  test('orderWord — slovenski plural računov', () => {
    expect(orderWord(1)).toBe('račun')
    expect(orderWord(2)).toBe('računa')
    expect(orderWord(3)).toBe('računi')
    expect(orderWord(4)).toBe('računi')
    expect(orderWord(5)).toBe('računov')
    expect(orderWord(12)).toBe('računov')
    expect(orderWord(0)).toBe('računov')
    expect(orderWord(-3)).toBe('računov')
  })

  test('activeHourlyBuckets — gard podatkov + naraščajoč sort + r2', () => {
    const out = activeHourlyBuckets([
      { hour: 19, revenue: 100.125, orders: 1 }, // r2 → 100.13 (točno predstavljivo: 100.125·100 = 10012.5)
      { hour: -1, revenue: 5, orders: 1 }, // neveljavna ura
      { hour: 24, revenue: 5, orders: 1 }, // neveljavna ura
      { hour: 8.5, revenue: 5, orders: 1 }, // ne-cela ura
      { hour: 9, revenue: Number.NaN, orders: 1 }, // ne-finite prihodek
      { hour: 10, revenue: -2, orders: 1 }, // negativen prihodek (isti gard kot salesByHour)
      { hour: 11, revenue: 5, orders: 0 }, // brez računov → nima aktivnosti
      { hour: 7, revenue: 7.125, orders: 2.6 }, // orders round → 3, revenue 7.13 (sort po uri: 7 je pred 19)
      null,
    ])
    expect(out.map((b) => b.hour)).toEqual([7, 19])
    expect(out[0].orders).toBe(3)
    expect(out[0].revenue).toBe(7.13)
    expect(out[1].revenue).toBe(100.13)
  })

  test('hourlyReportSection — prazno okno → [] (nič se ne laže)', () => {
    expect(hourlyReportSection([])).toEqual([])
    expect(hourlyReportSection(null)).toEqual([])
    expect(hourlyReportSection([{ hour: 17, revenue: 50, orders: 0 }])).toEqual([])
  })

  test('hourlyReportSection — ena ura: brez vrhunca (je svoj)', () => {
    expect(hourlyReportSection([{ hour: 17, revenue: 45.6, orders: 1 }])).toEqual([
      'Prodaja po urah:',
      '  17:00 – 18:00 · 1 račun · 45.60 EUR',
    ])
  })

  test('hourlyReportSection — dve uri + vrhunec + meja 23:00–24:00', () => {
    const lines = hourlyReportSection([
      { hour: 23, revenue: 9.1, orders: 2 },
      { hour: 17, revenue: 69, orders: 2 },
      { hour: 19, revenue: 100, orders: 1 },
    ])
    expect(lines).toEqual([
      'Prodaja po urah:',
      '  17:00 – 18:00 · 2 računa · 69.00 EUR',
      '  19:00 – 20:00 · 1 račun · 100.00 EUR',
      '  23:00 – 24:00 · 2 računa · 9.10 EUR',
      '  Vrhunec: 19:00 (100.00 EUR)',
    ])
  })

  test('peakHour — enakost prihodkov → nižja ura (stabilna izbira)', () => {
    expect(peakHour([])).toBeNull()
    expect(peakHour([{ hour: 17, revenue: 50, orders: 1 }, { hour: 19, revenue: 50, orders: 1 }])?.hour).toBe(17)
    expect(peakHour([{ hour: 17, revenue: 50, orders: 1 }, { hour: 19, revenue: 51, orders: 1 }])?.hour).toBe(19)
  })

  test('dailyDigestEmailText — brez hourlyBuckets izhod brez sekcije (byte-identičen prej)', () => {
    const { body } = dailyDigestEmailText({
      shiftId: 'daily-x', shiftDate: FROM, from: FROM, to: TO, locationId: null,
      gross: 100, net: 80, vat: 20, covers: 2, payments: [], topItems: [],
      windowLabel: 'Dan',
    })
    expect(body).not.toContain('Prodaja po urah:')
    const withHourly = dailyDigestEmailText({
      shiftId: 'daily-x', shiftDate: FROM, from: FROM, to: TO, locationId: null,
      gross: 100, net: 80, vat: 20, covers: 2, payments: [], topItems: [],
      hourlyBuckets: [{ hour: 17, revenue: 100, orders: 2 }],
      windowLabel: 'Dan',
    })
    expect(withHourly.body).toContain('Prodaja po urah:')
    expect(withHourly.body.length).toBeGreaterThan(body.length)
    expect(withHourly.subject).toContain('dnevni povzetek')
  })
})

describe('Č2 — sendDailyDigest z urnim odsekom (transportFactory šiv)', () => {
  test('digest vsebuje »Prodaja po urah:« — storno izključeni, vrhunec pravi', async () => {
    const locId = await seedSales()
    sendCalls = 0
    lastMail = {}
    const res = await sendDailyDigest({ locationId: locId, now: NOW, transportFactory })
    expect(res).toEqual({ sent: true })
    expect(sendCalls).toBe(1)
    const body = lastMail.text || ''
    expect(body).toContain('Prodaja po urah:')
    expect(body).toContain('  17:00 – 18:00 · 2 računa · 69.00 EUR')
    expect(body).toContain('  19:00 – 20:00 · 1 račun · 100.00 EUR')
    expect(body).toContain('  Vrhunec: 19:00 (100.00 EUR)')
    expect(body).not.toContain('21:00 – ')
    expect(body).not.toContain('-12.20 EUR')
    // urna sekcija je PO top artiklih (praznih), PRED zaključno vrstico
    const idx = body.indexOf('Prodaja po urah:')
    const idxTop = body.indexOf('Najbolj prodani artikli:')
    const idxFoot = body.indexOf('— Samodejno sporočilo RestaurantOS')
    expect(idx).toBeGreaterThan(idxTop)
    expect(idx).toBeLessThan(idxFoot)
    // log vrstica 'sent' z reportDate = zajeti dan
    const row = await db.scheduledEmailLog.findFirst({ where: { reportType: 'DAILY_DIGEST', recipient: RECIPIENT, status: 'sent' } })
    expect(row?.reportDate?.getTime()).toBe(FROM.getTime())
  })

  test('already_sent ostane prva varovalka — isti dan brez druge pošte', async () => {
    sendCalls = 0
    const res = await sendDailyDigest({ now: NOW, transportFactory })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('already_sent')
    expect(sendCalls).toBe(0)
  })

  test('brez SMTP transporta → smtp_not_configured (urni odsek ne spreminja fail-softa)', async () => {
    // zasedi drug dan (dan pred NOW je zasklenjen) — neodvisna varovalka po dnevu
    const NEXT = new Date(NOW.getTime())
    NEXT.setDate(NEXT.getDate() + 1)
    const res = await sendDailyDigest({ now: NEXT, transportFactory: async () => null })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('smtp_not_configured')
    // še izklopljen e-poštni profil → email_not_configured
    await setEmailEnabled(false)
    const res2 = await sendDailyDigest({ now: NEXT, transportFactory: async () => null })
    expect(res2.reason).toBe('email_not_configured')
    await setEmailEnabled(true)
  })
})

describe('Č3 — registri v1.206.0', () => {
  test('verzija 1.212.0', () => {
    expect(APP_VERSION).toBe('1.215.0')
    expect(readFileSync('src/lib/version.ts', 'utf8')).toMatch(/APP_VERSION = '1\.215\.0'/)
  })

  test('GAP dokument: OSS-8 A-del IZVEDENO @ v1.206.0 + poštena B-meja', () => {
    const doc = readFileSync('docs/GAP-ANALIZA-odprtokodna-konkurenca.md', 'utf8')
    expect(doc).toContain('**A-del IZVEDENO @ v1.206.0**')
    expect(doc).toContain('urna razčlenitev prodaje')
    expect(doc).toContain('samodejni pošiljanji VSAKO uro ostanejo B')
  })

  test('hourly-email.ts je čisti sloj — 0 uvozov', () => {
    const src = readFileSync('src/lib/hourly-email.ts', 'utf8')
    expect(src).not.toMatch(/^import\s/m)
    expect(src).not.toMatch(/from\s+['"]@?\//)
  })

  test('i18n pariteta nespremenjena — e-poštna besedila so SL literali po konvenciji', () => {
    expect(Object.keys(sl).length).toBe(3731)
    expect(Object.keys(hr).length).toBe(3731)
  })

  test('0 DDL — urni odsek je vrednost, ne model (shema nespremenjena)', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).not.toContain('model HourlyEmail')
    expect(schema).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/)
  })
})

/** Tipovni pin — HourlyEmailBucket strukturno pokriva SalesHourBucket vedra. */
const _typePin: HourlyEmailBucket = { hour: 0, revenue: 0, orders: 0 }
void _typePin
