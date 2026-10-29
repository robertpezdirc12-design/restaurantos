import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as forecastGET, clampHistory, clampHorizon } from '../src/app/api/reports/labor-forecast/route'
import { GET as exportGET } from '../src/app/api/reports/export/route'
import {
  forecastLabor, dowOfISO, addDaysISO, parseHMToMinutes, meanOf, medianOf,
  LF_TARGET_LABOR_PCT, type ForecastHistoryDay, type ScheduledShiftSample,
} from '../src/lib/labor-forecast'

/**
 * P1-4 (v1.186.0) — LABOR FORECAST (napoved dela).
 *
 * Tržna vrzel (docs/TRZNA-VRZELI-2026.md §4 P1 #4): podatki že zbrani (prodaja
 * po urah, labor cost), priporočila ur/osebja pa ni. Izdaja: deterministični
 * čisti sloj (ista metodologija kot forecastSales — povprečje istega dneva
 * tedna, zaprti dnevi izključeni), ruta + export sekcija (skupni loader),
 * sidro horizonta na DANES (poravnava z oknom izmen).
 *
 * Merila:
 *  A čisti sloj — pomožniki (dowOfISO 1=pon..7=ned, addDaysISO, parseHM,
 *    meanOf/medianOf prazni vnos)
 *  B čisti sloj — motor (povprečje istega dne tedna, zaprti dnevi ločeno,
 *    uteži ur, 0,25 h zaokrožitev NAVZGOR, priporočeno osebje = strop,
 *    brez vzorcev = null + 'low', sidro horizonta)
 *  C čisti sloj — vrzeli (prekrivanje izmen z odprtimi urami, − odmor,
 *    prehod čez polnoč, prag 0,5 h, under/over)
 *  D ruta — pravice (401 brez žetona, 403 brez reports.labour)
 *  E ruta — srečen tok (struktura, wage iz TimeEntry tehtnice, clampi)
 *  F export — sekcija labor-forecast (JSON + CSV z BOM)
 *
 * ID-ji s predpono `v186lf-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v186lf-'
const RUN = Date.now().toString(36)

let locId = ''
let adminToken = ''
let cleanerToken = ''

function req(url: string, token: string | null): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
  })
}

/** Lokalni dan 'YYYY-MM-DD' za Date (dayKeyOf vzorec, brez uvozov). */
function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Zadnji datum z danim dnevom tedna (1=pon), ki je ≤ datum. */
function lastDowDate(dow: number, from: Date): Date {
  const d = new Date(from)
  while (((d.getDay() + 6) % 7) + 1 !== dow) d.setDate(d.getDate() - 1)
  return d
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V186LF-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  const adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`9${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const cleanerPin = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const cleaner = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...cleanerPin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  cleanerToken = createToken({ sub: cleaner.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

describe('v1.186.0 P1-4 — čisti sloj: pomožniki', () => {
  test('A1 dowOfISO: 1=ponedeljek … 7=nedelja', () => {
    expect(dowOfISO('2026-10-26')).toBe(1) // ponedeljek
    expect(dowOfISO('2026-11-01')).toBe(7) // nedelja
    expect(dowOfISO('2026-10-31')).toBe(6) // sobota
  })

  test('A2 addDaysISO: prehod meseca in leta', () => {
    expect(addDaysISO('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysISO('2026-10-29', -29)).toBe('2026-09-30')
  })

  test('A3 parseHMToMinutes: veljavno/neveljavno/prehod meja', () => {
    expect(parseHMToMinutes('00:00')).toBe(0)
    expect(parseHMToMinutes('18:30')).toBe(1110)
    expect(parseHMToMinutes('23:59')).toBe(1439)
    expect(parseHMToMinutes('24:00')).toBeNull()
    expect(parseHMToMinutes('7:5')).toBeNull()
    expect(parseHMToMinutes('')).toBeNull()
  })

  test('A4 meanOf/medianOf: prazen vnos je null, nič izmišljenega', () => {
    expect(meanOf([])).toBeNull()
    expect(medianOf([])).toBeNull()
    expect(meanOf([2, 4])).toBe(3)
    expect(medianOf([5, 1, 3])).toBe(3)
    expect(medianOf([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('v1.186.0 P1-4 — čisti sloj: motor', () => {
  // Trije ponedeljki: vsak 200 € neto (100 € @18, 100 € @19) → napoved
  // ponedeljka 200 € z zaupanjem 'ok' (prag ≥ 3 vzorce, kot forecastSales),
  // uteži 0,5/0,5; urna postavka 12 €/h → strošek/uro 32 € → 2,6667 h.
  const history: ForecastHistoryDay[] = [
    { date: '2026-09-28', dow: 1, netSalesCents: 20000, hourRevenueCents: Array(24).fill(0).map((_, h) => (h === 18 || h === 19 ? 10000 : 0)) },
    { date: '2026-10-05', dow: 1, netSalesCents: 20000, hourRevenueCents: Array(24).fill(0).map((_, h) => (h === 18 || h === 19 ? 10000 : 0)) },
    { date: '2026-10-12', dow: 1, netSalesCents: 20000, hourRevenueCents: Array(24).fill(0).map((_, h) => (h === 18 || h === 19 ? 10000 : 0)) },
    { date: '2026-10-06', dow: 2, netSalesCents: 0, hourRevenueCents: new Array(24).fill(0) }, // zaprt torek
  ]

  test('B1 povprečje istega dne tedna, zaprti dnevi ločeno, confidence', () => {
    const res = forecastLabor(history, [], { anchorDate: '2026-10-26', horizonDays: 1 })
    expect(res.days).toHaveLength(1)
    const d = res.days[0]
    expect(d.dow).toBe(2) // 2026-10-27 je torek — zaprt dan: brez vzorcev
    expect(d.forecastNetCents).toBeNull()
    expect(d.confidence).toBe('low')
    expect(d.closedDays).toBe(1)
    expect(d.openHours).toHaveLength(0)
  })

  test('B2 uteži ur, 0,25 h navzgor, priporočeno osebje = strop', () => {
    const res = forecastLabor(history, [], { anchorDate: '2026-11-01', horizonDays: 1 }) // sidro+1 = pon 2. 11.
    const d = res.days[0]
    expect(d.date).toBe('2026-11-02')
    expect(d.dow).toBe(1)
    expect(d.forecastNetCents).toBe(20000)
    expect(d.minNetCents).toBe(20000)
    expect(d.maxNetCents).toBe(20000)
    expect(d.sampleCount).toBe(3)
    expect(d.confidence).toBe('ok') // ≥ 3 vzorce
    expect(d.closedDays).toBe(0) // zaprti torek ne sodi k ponedeljkovim vzorcem
    expect(d.openHours).toHaveLength(2)
    const h18 = d.openHours.find((c) => c.hour === 18)!
    const h19 = d.openHours.find((c) => c.hour === 19)!
    expect(h18.forecastNetCents).toBe(10000)
    // 10000 × 32% = 3200 c / 1200 c/h = 2,6667 h → 0,25 h navzgor = 2,75
    expect(h18.requiredHours).toBe(2.75)
    expect(h19.requiredHours).toBe(2.75)
    expect(h18.recommendedStaff).toBe(3) // strop(2,6667)
    expect(d.totalRequiredHours).toBe(5.5)
  })

  test('B3 brez 0,25 h zaokrožitve → 2 decimalki', () => {
    const res = forecastLabor(history, [], { anchorDate: '2026-11-01', horizonDays: 1, roundQuarter: false })
    expect(res.days[0].openHours[0].requiredHours).toBe(2.67)
  })

  test('B4 brez zgodovine → prazen rezultat, konfiguracija ohranjena', () => {
    const res = forecastLabor([], [], { horizonDays: 3 })
    expect(res.days).toHaveLength(0)
    expect(res.gaps).toHaveLength(0)
    expect(res.config.horizonDays).toBe(3)
    expect(res.config.targetLaborPct).toBe(LF_TARGET_LABOR_PCT)
  })

  test('B5 horizont se stisne na 1..14', () => {
    const res = forecastLabor(history, [], { horizonDays: 99 })
    expect(res.days).toHaveLength(14)
    const tiny = forecastLabor(history, [], { horizonDays: 0 })
    expect(tiny.days).toHaveLength(1)
  })

  test('B6 default sidro = zadnji zgodovinski dan (forecastSales kompatibilnost)', () => {
    const res = forecastLabor(history, [], { horizonDays: 2 })
    expect(res.days[0].date).toBe('2026-10-13') // 2026-10-06 (zadnji) + 1
    expect(res.days[1].date).toBe('2026-10-14')
  })
})

describe('v1.186.0 P1-4 — čisti sloj: vrzeli vs. načrt', () => {
  const history: ForecastHistoryDay[] = [
    { date: '2026-10-05', dow: 1, netSalesCents: 20000, hourRevenueCents: Array(24).fill(0).map((_, h) => (h === 18 || h === 19 ? 10000 : 0)) },
    { date: '2026-10-12', dow: 1, netSalesCents: 20000, hourRevenueCents: Array(24).fill(0).map((_, h) => (h === 18 || h === 19 ? 10000 : 0)) },
  ]
  const potrebneUre = 2.75

  test('C1 podzaposlenost: izmena 18–20 pokrije 2 od 5,5 potrebulih ur', () => {
    const shifts: ScheduledShiftSample[] = [
      { date: '2026-11-02', startMinute: 18 * 60, endMinute: 20 * 60, breakMinutes: 0, role: 'server' },
    ]
    const res = forecastLabor(history, shifts, { anchorDate: '2026-11-01', horizonDays: 1 })
    expect(res.days[0].scheduledHours).toBe(2)
    const gaps = res.gaps.filter((g) => g.date === '2026-11-02')
    expect(gaps).toHaveLength(2) // obe uri podzaposleni
    for (const g of gaps) {
      expect(g.kind).toBe('under')
      expect(g.scheduledHours).toBe(1)
      expect(g.requiredHours).toBe(potrebneUre)
      expect(g.deltaHours).toBeCloseTo(1.75, 5)
    }
  })

  test('C2 odmor zmanjša načrtovane ure in premakne prekrivanje', () => {
    const shifts: ScheduledShiftSample[] = [
      // 18:00–19:30 z 30 min odmorom → delo 60 min (odmor najprej) → ura 18 = 1 h
      { date: '2026-11-02', startMinute: 18 * 60, endMinute: 19 * 60 + 30, breakMinutes: 30, role: 'bar' },
    ]
    const res = forecastLabor(history, shifts, { anchorDate: '2026-11-01', horizonDays: 1 })
    expect(res.days[0].scheduledHours).toBe(1)
    const g18 = res.gaps.find((g) => g.date === '2026-11-02' && g.hour === 18)
    expect(g18?.scheduledHours).toBe(1)
    // ura 19: delo je poteklo prej → načrt 0 → vrzeli kljub izmeni
    const sched19 = res.gaps.find((g) => g.date === '2026-11-02' && g.hour === 19)?.scheduledHours ?? 0
    expect(sched19).toBe(0)
  })

  test('C3 prehod čez polnoč: 23:00–01:00 pokrije tudi uro 0 (naprej naslednji dan)', () => {
    const shifts: ScheduledShiftSample[] = [
      { date: '2026-11-02', startMinute: 23 * 60, endMinute: 60, breakMinutes: 0, role: 'server' },
    ]
    const res = forecastLabor(history, shifts, { anchorDate: '2026-11-01', horizonDays: 2 })
    expect(res.days[0].scheduledHours).toBe(1) // ura 23 na 2. 11.
    // preostanek (60 min) pade na 3. 11. uro 0 — dan 2 (brez zgodovine: brez vrzeli)
    expect(res.days[1].scheduledHours).toBe(1)
  })

  test('C4 vrzeli pod pragom 0,5 h so tihe', () => {
    // tehtana postavka 12 €/h → potreba/uro 2,75 h; načrt 2,5 h je odmik 0,25 < 0,5
    const shifts: ScheduledShiftSample[] = [
      { date: '2026-11-02', startMinute: 18 * 60, endMinute: 20 * 60 + 30, breakMinutes: 0, role: 'server' }, // 2,5 h v uri 18 (30 min preliva v 20)
    ]
    const res = forecastLabor(history, shifts, { anchorDate: '2026-11-01', horizonDays: 1 })
    const g18 = res.gaps.find((g) => g.date === '2026-11-02' && g.hour === 18)
    // načrt v uri 18 = 2 h (celi del) — vrzel 0,75 pod? NE: 2,75−2 = 0,75 ≥ 0,5 → under
    expect(g18?.kind).toBe('under')
    // ura 20 ni odprta (brez zgodovinske prodaje) → nobena vrzel
    expect(res.gaps.find((g) => g.date === '2026-11-02' && g.hour === 20)).toBeUndefined()
  })
})

describe('v1.186.0 P1-4 — ruta /api/reports/labor-forecast', () => {
  test('D1 brez žetona → 401', async () => {
    const res = await forecastGET(req('/api/reports/labor-forecast', null))
    expect(res.status).toBe(401)
  })

  test('D2 CLEANER brez reports.labour → 403', async () => {
    const res = await forecastGET(req('/api/reports/labor-forecast?days=7&horizon=2', cleanerToken))
    expect(res.status).toBe(403)
  })

  test('E1 clampi: default 28/7, meje 7..90 in 1..14', () => {
    expect(clampHistory(null)).toBe(28)
    expect(clampHistory('3')).toBe(7)
    expect(clampHistory('500')).toBe(90)
    expect(clampHorizon(null)).toBe(7)
    expect(clampHorizon('0')).toBe(1)
    expect(clampHorizon('99')).toBe(14)
  })

  test('E2 srečen tok: struktura, tehtana postavka iz TimeEntry, sidro = danes', async () => {
    const now = new Date()
    // 3 ponedeljki v zgodovini: 2× po 150 € @19 (različni, da testira povprečje)
    const mon1 = lastDowDate(1, new Date(now.getTime() - 7 * 86400000))
    const mon2 = new Date(mon1.getTime() - 7 * 86400000)
    let seq = 0
    for (const [d, subtotal] of [[mon1, 150], [mon2, 250]] as const) {
      seq += 1
      const paidAt = new Date(d)
      paidAt.setHours(19, 0, 0, 0)
      await db.order.create({
        data: {
          id: `${PREFIX}o${seq}-${RUN}`, locationId: locId, orderNumber: 964000 + seq,
          status: 'paid', paymentStatus: 'paid', subtotal, discount: 0, total: subtotal,
          paidAt,
        },
      })
    }
    // TimeEntry: 120 min za 24 € → tehtana postavka 12 €/h
    const clockIn = new Date(now.getTime() - 3 * 86400000)
    clockIn.setHours(10, 0, 0, 0)
    const clockOut = new Date(clockIn.getTime() + 120 * 60000)
    await db.timeEntry.create({
      data: {
        id: `${PREFIX}te-${RUN}`, employeeId: `${PREFIX}admin-${RUN}`, clockIn, clockOut,
        breakMinutes: 0, totalMinutes: 120, payRate: 12, totalPay: 24, locationId: locId,
      },
    })
    // izmena na prvi napovedani ponedeljek: 19:00–20:30 (1,5 h) — podzaposlenost
    const nextMon = new Date(lastDowDate(1, now))
    nextMon.setDate(nextMon.getDate() + (keyOf(nextMon) === keyOf(now) ? 7 : 0))
    if (nextMon.getTime() <= now.getTime()) nextMon.setDate(nextMon.getDate() + 7)
    await db.staffShift.create({
      data: {
        id: `${PREFIX}ss-${RUN}`, employeeId: `${PREFIX}admin-${RUN}`, shiftDate: new Date(`${keyOf(nextMon)}T12:00:00.000Z`),
        startTime: '19:00', endTime: '20:30', breakMinutes: 0, role: 'server', status: 'scheduled', locationId: locId,
      },
    })

    const res = await forecastGET(req('/api/reports/labor-forecast?days=28&horizon=7', adminToken))
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.generatedAt).toBeDefined()
    expect(data.parameters).toEqual({ historyDays: 28, horizonDays: 7 })
    const wage = data.wage as { centsPerHour: number; source: string }
    expect(wage.source).toBe('timeclock')
    expect(wage.centsPerHour).toBe(1200)
    const days = data.days as Array<{ date: string; dow: number; forecastNetCents: number | null; totalRequiredHours: number; scheduledHours: number; sampleCount: number }>
    expect(days).toHaveLength(7)
    // prvi napovedani dan = jutri (sidro danes)
    expect(days[0].date).toBe(keyOf(new Date(now.getTime() + 86400000)))
    // ponedeljek v horizontu: povprečje (150+250)/2 = 200 €, samo ura 19
    const mon = days.find((d) => d.dow === 1)!
    expect(mon.forecastNetCents).toBe(20000)
    expect(mon.sampleCount).toBe(2)
    expect(mon.openHours).toHaveLength(1)
    expect(mon.openHours[0].hour).toBe(19)
    // 20000 × 32% / 1200 = 5,3333 h → 0,25 navzgor = 5,5
    expect(mon.totalRequiredHours).toBe(5.5)
    expect(mon.scheduledHours).toBe(1.5)
    // vrzeli: vsa prodaja v uri 19 → potreba 5,5 h, načrt 1,0 h → under 4,5
    const gaps = data.gaps as Array<{ date: string; hour: number; kind: string; deltaHours: number }>
    const g = gaps.find((x) => x.date === mon.date && x.hour === 19)
    expect(g?.kind).toBe('under')
    expect(g?.deltaHours).toBe(4.5)
  })

  test('E3 fallback postavka: brez žigosanja → 12 €/h + vir fallback', async () => {
    // ločena lokacija z NE-centralno vlogo (MANAGER = strižen locationScope):
    // centralni ADMIN vidi vse lokacije (org allow-lista) in bi ujel TimeEntry
    // s prejšnjega preizkusa — MANAGER vidi IZKLJUČNO svojo (prazno) lokacijo.
    const loc2 = await db.location.create({
      data: { id: `${PREFIX}loc2-${RUN}`, name: `${PREFIX}Lokacija2`, code: `V186L2-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem2-${RUN}`, country: 'SI' },
    })
    const mgrId = `${PREFIX}mgr-${RUN}`
    const mgrPin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}mgr-${RUN}@test.local`)
    await db.employee.create({
      data: { id: mgrId, name: `${PREFIX}Vodja`, email: `${PREFIX}mgr-${RUN}@test.local`, role: 'MANAGER', status: 'active', sessionVersion: 0, locationId: loc2.id, ...mgrPin },
    })
    const mgr2 = createToken({ sub: mgrId, name: `${PREFIX}Vodja`, role: 'MANAGER', loc: loc2.id, sv: 0 })
    const res = await forecastGET(req('/api/reports/labor-forecast?days=7&horizon=1', mgr2))
    expect(res.status).toBe(200)
    const data = await res.json() as { wage: { source: string; centsPerHour: number } }
    expect(data.wage.source).toBe('fallback')
    expect(data.wage.centsPerHour).toBe(1200)
  })
})

describe('v1.186.0 P1-4 — export sekcija labor-forecast', () => {
  test('F1 JSON format', async () => {
    const res = await exportGET(req('/api/reports/export?section=labor-forecast&format=json', adminToken))
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.section).toBe('labor-forecast')
    expect(data.days).toBeDefined()
    expect(data.wage).toBeDefined()
    expect((data.exportMeta as Record<string, unknown>).historyDays).toBe(28)
  })

  test('F2 CSV format: BOM, glave, vrstice dni', async () => {
    const res = await exportGET(req('/api/reports/export?section=labor-forecast&format=csv', adminToken))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    const text = await res.text()
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text).toContain('LABOR NAPOVED - RestaurantOS')
    expect(text).toContain('NAPOVED DNEV')
    expect(text).toContain('ODPRTE URE (priporočilo po urah)')
    expect(text).toContain('VRZELI VS. NAČRT (prag 0,5 h)')
  })
})
