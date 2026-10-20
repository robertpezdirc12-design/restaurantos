/**
 * v1.158.0 — javni rezervacijski widget: kapaciteta za CELOTEN izbrani dan in
 * atomska zaščita sočasnih rezervacij.
 *
 * Najdba (lastni pregled): POST je nalagal obstoječe rezervacije v oknu
 * [now, now+24h] — za datum več kot en dan vnaprej je bila zasedenost videti
 * prazna (prekomerno rezerviranje), plošča GET pa je prav tako gledala okno
 * okoli "now" namesto izbranega datuma. Poleg tega je bil komentar ob create()
 * ("sočasna rezervacija istega termina → 409") neresničen: brez zaklepa sta
 * sočasni zahtevi obe videli prost termin in obe ustvarili rezervacijo.
 *
 * Testi tečejo skozi javni API (prava pot gosta), fiksture s predpono v158-.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { zonedDateParts, zonedTimeToUtc, localDateKey, type LocalDate } from '../src/lib/haccp-ops'
import { GET as publicGET, POST as publicPOST } from '../src/app/api/public/reservations/route'

const P = 'v158-'
const RUN = Date.now().toString(36)
const TZ = 'Europe/Ljubljana'

let loc = ''
let widgetToken = ''

function addDays(d: LocalDate, n: number): LocalDate {
  const dt = new Date(Date.UTC(d.y, d.m - 1, d.d + n))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}
const TODAY = zonedDateParts(new Date(), TZ)
/** +5 dni: zunaj starega okna [now−24h, now+48h], znotraj maxAdvanceDays 30. */
const FAR = addDays(TODAY, 5)
const FAR_KEY = localDateKey(FAR)
/** +6 dni: ločen dan za sočasnostni test. */
const CONC = addDays(TODAY, 6)
const CONC_KEY = localDateKey(CONC)

function req(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function post(payload: Record<string, unknown>): Promise<Response> {
  return publicPOST(req('POST', '/api/public/reservations', {
    token: widgetToken, partySize: 2, name: `${P}Gost`, phone: '+38640111222', ...payload,
  })) as unknown as Promise<Response>
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

beforeAll(async () => {
  __resetRateLimitForTests()
  await sweepTestFixtures(db, [P])
  loc = `${P}loc-${RUN}`
  widgetToken = crypto.randomBytes(16).toString('hex')
  await db.location.create({ data: { id: loc, code: `${P}L${RUN}`, name: `${P}Lok`, premisesId: `${P}prem-${RUN}` } })
  for (let dow = 0; dow < 7; dow++) {
    await db.openingHours.create({ data: { id: `${P}oh-${dow}-${RUN}`, dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, locationId: loc } })
  }
  // kapaciteta 8 = 2 mizi × 4 sedeži
  for (let n = 1; n <= 2; n++) {
    await db.table.create({ data: { id: `${P}tbl-${n}-${RUN}`, number: n, capacity: 4, locationId: loc } })
  }
  await db.reservationWidget.create({
    data: { id: `${P}widget-${RUN}`, locationId: loc, token: widgetToken, enabled: true, slotMinutes: 30, minParty: 1, maxParty: 8, leadMinutes: 0, maxAdvanceDays: 30, maxCoversPerSlot: 0 },
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})

describe('v1.158.0 — kapaciteta prihodnjega datuma (>24 h)', () => {
  it('POST: obstoječa rezervacija na dan +5 zasede termine — nova rezervacija → 409', async () => {
    __resetRateLimitForTests()
    await db.reservation.create({
      data: {
        id: `${P}seed-far-${RUN}`,
        customerName: `${P}Obstoječi`,
        customerPhone: '+38640111001',
        dateTime: zonedTimeToUtc(FAR.y, FAR.m, FAR.d, 18, 0, TZ),
        partySize: 8,
        duration: 120,
        status: 'confirmed',
        source: 'phone',
        locationId: loc,
      },
    })
    const res = await post({ date: FAR_KEY, time: '18:00', partySize: 2, phone: '+38640111223' })
    expect(res.status).toBe(409)
  })

  it('GET: plošča za dan +5 pokaže 18:00 kot zaseden, prost termin 12:00 pa ostane prost', async () => {
    __resetRateLimitForTests()
    const res = (await publicGET(req('GET', `/api/public/reservations?token=${widgetToken}&date=${FAR_KEY}`))) as unknown as Response
    const j = await body(res)
    expect(res.status).toBe(200)
    const slots = j.slots as { time: string; available: boolean; remaining: number }[]
    const occupied = slots.find((s) => s.time === '18:00')
    expect(occupied?.available).toBe(false)
    expect(occupied?.remaining).toBe(0)
    const free = slots.find((s) => s.time === '12:00')
    expect(free?.available).toBe(true)
    expect(free?.remaining).toBe(8)
  })
})

describe('v1.158.0 — sočasne rezervacije istega termina', () => {
  it('dve hkratni rezervaciji (vsaka zasede VSO kapaciteto) → natanko ena uspe', async () => {
    __resetRateLimitForTests()
    const [a, b] = await Promise.all([
      post({ date: CONC_KEY, time: '19:00', partySize: 8, phone: '+38640111301', name: `${P}A` }),
      post({ date: CONC_KEY, time: '19:00', partySize: 8, phone: '+38640111302', name: `${P}B` }),
    ])
    const statuses = [a.status, b.status].sort((x, y) => x - y)
    expect(statuses).toEqual([201, 409])
    const count = await db.reservation.count({
      where: {
        locationId: loc,
        status: 'confirmed',
        dateTime: zonedTimeToUtc(CONC.y, CONC.m, CONC.d, 19, 0, TZ),
      },
    })
    expect(count).toBe(1)
    // Zaklep lokacije mora biti DEJANSKO prevzet v obeh transakcijah: brez te
    // vrstice bi bila zaščita na PostgreSQL (READ COMMITTED) le transakcija brez
    // medsebojnega izključevanja, SQLite v CI pa bi jo skril. Mutacijsko
    // preverjeno: ob odstranitvi klica lockReservationCapacity ta trditev pade.
    const lock = await db.counter.findUnique({ where: { name: `resvslot:${loc}` } })
    expect(lock?.value).toBe(2)
  })
})
