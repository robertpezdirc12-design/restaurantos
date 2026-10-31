/**
 * N-27-3 (v1.197.0) — KONFIGURABILNE NOGE DOPLAČIL obračuna
 * (docs/TRZNA-VRZELI-2027.md §2A).
 *
 * v1.192.0 je izvažal doplačilne OSNOVE (minute) — odstotki ostali biroju. Ta
 * val pretvori odstotek v UPORABNIŠKI VHOD: lastnik vnese noge po SVOJI
 * kolektivni pogodbi, sistem izračuna ZNESKE iz minut in posnetkov urnih
 * postavk. Iskrena meja (ostaja, premaknjena za en korak): noga je uporabniški
 * vhod — zakonitost potrdi biro; sistem NIKOLI ne trdi, da je noga »zakonska«.
 *
 * Merila:
 *  Č1 čisti sloj payroll-rates.ts (PURE, 0 DB): parseSurchargeRates (vsa štiri
 *     polja OBVEZNA — manjkajoče polje je napaka, ne tiha nula; NaN/obseg/
 *     zaokrožitev na 2 decimali; numerični nizi), pctPctOf (stotinke odstotka),
 *     centna aritmetika (surchargeAmountOfRaw, overtimeAmountOf — celoštevilčni
 *     produkti, ENA zaokrožitev na skupino), pctCsv (EUR vzorec z vejico).
 *  Č2 aritmetika v surchargeBasisRows (pure): z nogami → zneski v centih ob
 *     minutah (noč/nedelja/praznik po zaposlenem+delu; nadure po zaposlenem po
 *     POVPREČNI urni postavki obdobja), brez nog → polja ODSOTNA (stare klice
 *     stabilni), vnos brez posnetka postavke prispeva 0, Σ netMinutes = 0 → 0.
 *  Č3 backend:
 *     - GET/PUT /api/payroll/surcharge-rates: 401 brez žetona, 403 brez
 *       employees.manage (waiter), 403 na privzete/NULL (globalni vir = samo
 *       centralne vloge — fail-closed assertResourceLocation), 403 tuja
 *       lokacija, 503 do DDL (probe false — eksplicitna, ne tiho);
 *     - detail BREZ nog → surchargeRates null + osnove brez zneskov
 *       (graceful); izvoz CSV brez nog → Eur kolone PRAZNE (nikoli 0 € za
 *       neizračunan znesek);
 *     - PUT validacija (400: manjkajoče polje z imenom, NaN, > 100, < 0);
 *       PUT shrani (upsert — drugi PUT POSODOBI isto vrstico) + audit
 *       PAYROLL_SURCHARGE_RATES_UPDATED; GET → source 'location'; pad na
 *       privzete (NULL vrstica) → source 'default';
 *     - detail/izvoz Z nogami: zneski ob minutah, noga izvoza zapiše
 *       uporabljene noge; ista noga → identical true; sprememba noge → nov
 *       contentHash (identical false, rowDigest/changedEntries nespremenjena —
 *       noge so del vsebine izvoza, ne vrstic);
 *     - DDL ruta /api/admin/migrate-payroll-surcharge-rates: 403 za managerja
 *       (requireCentralRole), 200 za admina (na SQLite tabela že prek db push →
 *       skipped; audit SCHEMA_MIGRATION_PAYROLL_SURCHARGE_RATES).
 *  Č4 UI statika + registri: kartica v payroll-tab (GET/PUT klici, pogojna
 *     kolona zneska), i18n pariteta novih ključev (SL/HR), model v OBEH shemah,
 *     baseline migracija, SCHEMA_MIGRATIONS 33 + register, drift allowlist 25
 *     (classifyDrift prepozna CREATE TABLE), verzija pin.
 *
 * Fiksture s predpono v197ps-; obdobje februar 2026 (CET = UTC+1 —
 * deterministično); NOGE so fikstura TEKOVNO ustvarjene/izbrisane — po teku
 * testa je tabela PayrollSurchargeRate spet v vhodnem stanju (drugi testi
 * dela izvoz delajo brez nog — pini v192/issue22 ostanejo veljavni).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  MAX_SURCHARGE_PCT,
  parseSurchargeRates,
  pctPctOf,
  surchargeAmountOfRaw,
  overtimeAmountOf,
  pctCsv,
} from '../src/lib/payroll-rates'
import { surchargeBasisRows, type SurchargeEntryRow } from '../src/lib/payroll-surcharges'
import { EXPORT_SCHEMA_VERSION } from '../src/lib/payroll'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import {
  __setSurchargeRatesCacheForTests,
  __resetSurchargeRatesCacheForTests,
} from '../src/lib/payroll-rates-store'
import { classifyDrift, KNOWN_DRIFTS } from '../scripts/drift-check'
import { GET as ratesGET, PUT as ratesPUT } from '../src/app/api/payroll/surcharge-rates/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-payroll-surcharge-rates/route'
import { GET as payrollDetailGET } from '../src/app/api/payroll/[id]/route'
import { POST as payrollPOST } from '../src/app/api/payroll/route'
import { POST as payrollClosePOST } from '../src/app/api/payroll/[id]/close/route'
import { GET as payrollExportGET } from '../src/app/api/payroll/[id]/export/route'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v197ps-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'
const RATES: { nightPct: number; sundayPct: number; holidayPct: number; overtimePct: number } = {
  nightPct: 30, sundayPct: 10, holidayPct: 20, overtimePct: 50,
}

let locA = ''
let locB = ''
let mgr = ''
let waiter = ''
let admin = ''
let empA = ''
let jobA = ''
let tok = ''
let waiterToken = ''
let adminToken = ''
let periodId = ''

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** SurchargeEntryRow hitri gradnik (approved; posnetki postavk v centih). */
function entry(o: Partial<SurchargeEntryRow>): SurchargeEntryRow {
  return {
    employeeId: 'emp', employeeName: 'N', jobId: 'job', jobName: 'J',
    date: '2026-02-08', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T10:00:00Z',
    netMinutes: 690, status: 'approved', ...o,
  }
}

async function cleanup() {
  // noge TEKOVNO: vse, kar je zvezalo to pripeljavo (lokacijske vrstice, NULL
  // fikstura z id-prefixom, PUT-vrstice prek updatedById)
  await db.payrollSurchargeRate.deleteMany({
    where: { OR: [{ locationId: { startsWith: P } }, { id: { startsWith: P } }, { updatedById: { startsWith: P } }] },
  }).catch(() => null)
  const periods = await db.payrollPeriod
    .findMany({ where: { locationId: { startsWith: P } }, select: { id: true } })
    .catch(() => [] as { id: string }[])
  if (periods.length > 0) {
    await db.payrollExport.deleteMany({ where: { periodId: { in: periods.map((x) => x.id) } } }).catch(() => null)
  }
  await db.payrollExport.deleteMany({ where: { exportedById: { startsWith: P } } }).catch(() => null)
  await db.payrollPeriod.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.timeEntry.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.employeeJob.deleteMany({ where: { employeeId: { startsWith: P } } }).catch(() => null)
  await db.job.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.auditLog
    .deleteMany({
      where: {
        OR: [
          { locationId: { startsWith: P } },
          { entityId: { startsWith: P } },
          { action: { in: ['PAYROLL_SURCHARGE_RATES_UPDATED', 'SCHEMA_MIGRATION_PAYROLL_SURCHARGE_RATES'] } },
        ],
      },
    })
    .catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  __setSurchargeRatesCacheForTests(true) // tabela je prek db push prisotna v dev/CI bazi
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `V97A-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locA = la.id
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `V97B-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locB = lb.id

  const seed = async (key: string, name: string, role: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', 1)
  waiter = await seed('waiter', `${P}Natakar Nace`, 'waiter', 2)
  admin = await seed('admin', `${P}Admin Alja`, 'admin', 3)
  empA = await seed('empA', `${P}Kuhar Klemen`, 'chef', 4)
  tok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })
  waiterToken = createToken({ sub: waiter, name: `${P}Natakar Nace`, role: 'WAITER', loc: locA, sv: 0 })
  adminToken = createToken({ sub: admin, name: `${P}Admin Alja`, role: 'ADMIN', loc: locA, sv: 0 })

  jobA = `${P}jobA-${RUN}`
  await db.job.create({ data: { id: jobA, name: `${P}Kuhar ${RUN}`, basePayRate: 10, isActive: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-a-${RUN}`, employeeId: empA, jobId: jobA, payRate: 10, isPrimary: true } })

  // ISTI vzorec kot v192 (deterministično, februar 2026 — CET +1):
  //  nočna izmena čez polnoč na PRAZNIŠKO NEDELJO (Prešernov dan 2026-02-08):
  //  12 h − 30 odmor = 690 neto; kategorije pred odmorom: noč 420, nedelja 660,
  //  praznik 660; postavka 10 €/h → payRateCents 1000, bruto 115 € → 11500 c
  await db.timeEntry.create({
    data: {
      id: `${P}te-n-${RUN}`, employeeId: empA, jobId: jobA,
      clockIn: new Date('2026-02-07T22:00:00Z'), clockOut: new Date('2026-02-08T10:00:00Z'),
      breakMinutes: 30, totalMinutes: 690, payRate: 10, totalPay: 115,
      type: 'regular', status: 'approved', notes: '', locationId: locA,
    },
  })
  //  dnevna izmena ponedeljek: 450 neto, brez kategorij; bruto 75 € → 7500 c
  await db.timeEntry.create({
    data: {
      id: `${P}te-d-${RUN}`, employeeId: empA, jobId: jobA,
      clockIn: new Date('2026-02-09T08:00:00Z'), clockOut: new Date('2026-02-09T16:00:00Z'),
      breakMinutes: 30, totalMinutes: 450, payRate: 10, totalPay: 75,
      type: 'regular', status: 'approved', notes: '', locationId: locA,
    },
  })

  const pr = await payrollPOST(req('POST', '/api/payroll', tok, { start: '2026-02-02', end: '2026-02-14' }))
  if (pr.status === 201) {
    const j = await body(pr)
    periodId = String((j.period as Record<string, unknown>).id)
  }
})

afterAll(async () => {
  __resetSurchargeRatesCacheForTests() // probe nazaj na dev resnico (ponovna preiskava)
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (payroll-rates.ts) ═══════════════════ */

describe('Č1 čisti sloj nog (pure)', () => {
  it('MAX_SURCHARGE_PCT = 100 (doplačilo NAD osnovno postavko)', () => {
    expect(MAX_SURCHARGE_PCT).toBe(100)
  })

  it('parseSurchargeRates: veljavne noge (števila in numerični nizi) → ok', () => {
    expect(parseSurchargeRates({ nightPct: 30, sundayPct: 10, holidayPct: 20, overtimePct: 50 })).toEqual({
      ok: true, rates: { nightPct: 30, sundayPct: 10, holidayPct: 20, overtimePct: 50 },
    })
    expect(parseSurchargeRates({ nightPct: '30', sundayPct: '10', holidayPct: '20', overtimePct: '50' })).toEqual({
      ok: true, rates: { nightPct: 30, sundayPct: 10, holidayPct: 20, overtimePct: 50 },
    })
    // zaokrožitev na 2 decimalni mesti + mejni 0 in 100
    expect(parseSurchargeRates({ nightPct: 33.333, sundayPct: 0, holidayPct: 100, overtimePct: 0.005 })).toEqual({
      ok: true, rates: { nightPct: 33.33, sundayPct: 0, holidayPct: 100, overtimePct: 0.01 },
    })
  })

  it('parseSurchargeRates: manjkajoče polje je NAPAKA (ne tiha nula) — fail-closed', () => {
    const r = parseSurchargeRates({ nightPct: 30, sundayPct: 10, holidayPct: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('overtimePct')
    expect(parseSurchargeRates(null).ok).toBe(false)
    expect(parseSurchargeRates('noge').ok).toBe(false)
    expect(parseSurchargeRates({ nightPct: '', sundayPct: 0, holidayPct: 0, overtimePct: 0 }).ok).toBe(false)
  })

  it('parseSurchargeRates: NaN, negativno, nad 100 → napaka', () => {
    for (const bad of [
      { nightPct: 'abc', sundayPct: 0, holidayPct: 0, overtimePct: 0 },
      { nightPct: -5, sundayPct: 0, holidayPct: 0, overtimePct: 0 },
      { nightPct: 150, sundayPct: 0, holidayPct: 0, overtimePct: 0 },
      { nightPct: 0, sundayPct: 100.01, holidayPct: 0, overtimePct: 0 },
      { nightPct: Number.POSITIVE_INFINITY, sundayPct: 0, holidayPct: 0, overtimePct: 0 },
    ]) {
      const r = parseSurchargeRates(bad)
      expect(r.ok).toBe(false)
    }
  })

  it('pctPctOf — odstotek → stotinke odstotka (celoštevilčna aritmetika)', () => {
    expect(pctPctOf(30)).toBe(3000)
    expect(pctPctOf(7.5)).toBe(750)
    expect(pctPctOf(33.33)).toBe(3333)
  })

  it('surchargeAmountOfRaw — Σ min × cents × pctPct / 600000, ENA zaokrožitev', () => {
    // 1 h na 10 €/h z 15 %: 60 × 1000 × 1500 / 600000 = 150 c = 1,50 €
    expect(surchargeAmountOfRaw(60 * 1000 * 1500)).toBe(150)
    // zaokrožitev na skupini: 1 min × 10 €/h × 5 % = 0,83 c → 1 cent (ne 0,83)
    expect(surchargeAmountOfRaw(1 * 1000 * 500)).toBe(1)
  })

  it('overtimeAmountOf — nadure po povprečni urni postavki obdobja + zero guardi', () => {
    // Σ gross 19000 c, Σ net 1140 min → povprečje 1000 c/h; 210 min × 50 %
    expect(overtimeAmountOf(210, 19000, 1140, 50)).toBe(1750)
    expect(overtimeAmountOf(210, 19000, 0, 50)).toBe(0)
    expect(overtimeAmountOf(210, 0, 1140, 50)).toBe(0)
    expect(overtimeAmountOf(0, 19000, 1140, 50)).toBe(0)
  })

  it('pctCsv — EUR vzorec (decimalna vejica) za nogo izvoza', () => {
    expect(pctCsv(30)).toBe('30%')
    expect(pctCsv(7.5)).toBe('7,5%')
  })
})

/* ═══════════════════ Č2. Aritmetika v surchargeBasisRows (pure) ═══════════════════ */

describe('Č2 zneski v osnovah (pure)', () => {
  const hol = new Set(['2026-02-08'])

  const rows = (): SurchargeEntryRow[] => [
    entry({ employeeId: 'e1', date: '2026-02-08', netMinutes: 690, payRateCents: 1000, grossCents: 11500 }),
    entry({ employeeId: 'e1', date: '2026-02-09', clockIn: '2026-02-09T08:00:00Z', clockOut: '2026-02-09T16:00:00Z', netMinutes: 450, payRateCents: 1000, grossCents: 7500 }),
  ]

  it('z nogami: zneski ob minutah (420 min noč × 30 % na 10 €/h = 21,00 € …)', () => {
    const b = surchargeBasisRows(rows(), TZ, hol, undefined, RATES)
    expect(b.perEmployeeJob).toHaveLength(1)
    const r = b.perEmployeeJob[0]
    expect(r.nightMinutes).toBe(420)
    expect(r.sundayMinutes).toBe(660)
    expect(r.holidayMinutes).toBe(660)
    // 420×1000×3000/600000 = 2100 c; 660×1000×1000/600000 = 1100 c; 660×1000×2000/600000 = 2200 c
    expect(r.nightAmtCents).toBe(2100)
    expect(r.sundayAmtCents).toBe(1100)
    expect(r.holidayAmtCents).toBe(2200)
    // nadure: (690−480) + (450−480→0) = 210 min; povprečna postavka 19000×60/1140 = 1000 c/h
    expect(b.overtime).toHaveLength(1)
    expect(b.overtime[0].overtimeBasisMinutes).toBe(210)
    expect(b.overtime[0].overtimeAmtCents).toBe(1750)
  })

  it('brez nog: oblika NESPREMENJENA — zneskovna polja odsotna (stare klice)', () => {
    const b = surchargeBasisRows(rows(), TZ, hol)
    const r = b.perEmployeeJob[0] as Record<string, unknown>
    expect('nightAmtCents' in r).toBe(false)
    expect('sundayAmtCents' in r).toBe(false)
    expect('holidayAmtCents' in r).toBe(false)
    expect('overtimeAmtCents' in (b.overtime[0] as Record<string, unknown>)).toBe(false)
  })

  it('vnos BREZ posnetka postavke prispeva 0 zneska (plačilna osnova nastane šele ob postavki)', () => {
    const b = surchargeBasisRows([entry({ payRateCents: undefined, grossCents: undefined })], TZ, hol, undefined, RATES)
    expect(b.perEmployeeJob[0].nightMinutes).toBe(420) // minute ostanejo
    expect(b.perEmployeeJob[0].nightAmtCents).toBe(0) // znesek NE (ni postavke — nič ne izmišljujemo)
    expect(b.overtime[0].overtimeAmtCents).toBe(0)
  })

  it('dnevni vnos brez kategorij in brez presežka → vsi zneski 0 (brez deljenja z nič)', () => {
    const b = surchargeBasisRows(
      [entry({ date: '2026-02-09', clockIn: '2026-02-09T08:00:00Z', clockOut: '2026-02-09T16:00:00Z', netMinutes: 0, payRateCents: 1000, grossCents: 0 })],
      TZ, hol, undefined, RATES,
    )
    expect(b.perEmployeeJob[0].nightAmtCents).toBe(0)
    expect(b.perEmployeeJob[0].sundayAmtCents).toBe(0)
    expect(b.perEmployeeJob[0].holidayAmtCents).toBe(0)
    // vrstica nadur obstaja za vsakega zaposlenega z vnosi — tudi z 0 presežkom
    expect(b.overtime).toHaveLength(1)
    expect(b.overtime[0].overtimeBasisMinutes).toBe(0)
    expect(b.overtime[0].overtimeAmtCents).toBe(0)
    expect(overtimeAmountOf(10, 5000, 0, 50)).toBe(0) // Σ net = 0 → 0
  })
})

/* ═══════════════════ Č3. BACKEND (rute) ═══════════════════ */

describe('Č3a pravice in graceful degradacija', () => {
  it('401 brez žetona (GET in PUT)', async () => {
    expect((await ratesGET(req('GET', '/api/payroll/surcharge-rates?locationId=x', null))).status).toBe(401)
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', null, { ...RATES }))).status).toBe(401)
  })

  it('403 brez employees.manage (waiter)', async () => {
    expect((await ratesGET(req('GET', `/api/payroll/surcharge-rates?locationId=${locA}`, waiterToken))).status).toBe(403)
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', waiterToken, { locationId: locA, ...RATES }))).status).toBe(403)
  })

  it('403 na PRIVZETE noge (NULL) — globalni vir, samo centralne vloge (fail-closed)', async () => {
    const g = await ratesGET(req('GET', '/api/payroll/surcharge-rates', tok))
    expect(g.status).toBe(403)
    const p = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { ...RATES }))
    expect(p.status).toBe(403)
  })

  it('403 na TUJO lokacijo (manager A → locB)', async () => {
    expect((await ratesGET(req('GET', `/api/payroll/surcharge-rates?locationId=${locB}`, tok))).status).toBe(403)
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locB, ...RATES }))).status).toBe(403)
  })

  it('503 do DDL (probe false — eksplicitna zahteva, ne tiho ignoriranje)', async () => {
    try {
      __setSurchargeRatesCacheForTests(false)
      const g = await ratesGET(req('GET', `/api/payroll/surcharge-rates?locationId=${locA}`, tok))
      expect(g.status).toBe(503)
      const jg = await body(g)
      expect(String(jg.error)).toContain('migracijo')
      const p = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, ...RATES }))
      expect(p.status).toBe(503)
    } finally {
      __setSurchargeRatesCacheForTests(true)
    }
  })
})

describe('Č3b detail + izvoz BREZ nog (graceful — minute brez zneskov)', () => {
  it('detail: surchargeRates null, osnove brez zneskov (stabilna oblika)', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${periodId}`, tok), params(periodId))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.surchargeRates).toBeNull()
    const bases = j.surchargeBases as { perEmployeeJob: Array<Record<string, unknown>> }
    expect(bases.perEmployeeJob).toHaveLength(1)
    expect('nightAmtCents' in bases.perEmployeeJob[0]).toBe(false)
    expect(bases.perEmployeeJob[0].nightMinutes).toBe(420)
  })

  it('izvoz CSV: Eur kolone PRAZNE (nikoli 0 € za neizračunan znesek), shema /3', async () => {
    const rc = await payrollClosePOST(req('POST', `/api/payroll/${periodId}/close`, tok, {}), params(periodId))
    expect(rc.status).toBe(200)
    const re = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=csv`, tok), params(periodId))
    expect(re.status).toBe(200)
    const csv = await re.text()
    expect(csv).toContain('ZaposleniID;Zaposleni;DeloID;Delo;NocMin;NocEur;NedeljaMin;NedeljaEur;PraznikMin;PraznikEur;PotrjenoNetoMin')
    expect(csv).toContain(';420;;660;;660;;1140')
    expect(csv).toContain('SKUPAJ;NocMin;420;NocEur;;NedeljaMin;660;NedeljaEur;;PraznikMin;660;PraznikEur;')
    expect(csv).toContain(';210;;1')
    expect(csv).toContain('RestaurantOS ne izracunava odstotkov doplacil (noge niso nastavljene)')
    expect(csv).toContain('Shema;payroll-export/3')
  })
})

describe('Č3c PUT validacija + shranjevanje + audit', () => {
  it('PUT 400: manjkajoče polje (z imenom), NaN, nad 100, negativno', async () => {
    const r1 = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: 30, sundayPct: 10, holidayPct: 20 }))
    expect(r1.status).toBe(400)
    expect(String((await body(r1)).error)).toContain('overtimePct')
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: 'abc', sundayPct: 10, holidayPct: 20, overtimePct: 0 }))).status).toBe(400)
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: 150, sundayPct: 10, holidayPct: 20, overtimePct: 0 }))).status).toBe(400)
    expect((await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: -1, sundayPct: 10, holidayPct: 20, overtimePct: 0 }))).status).toBe(400)
  })

  it('PUT shrani → DTO source location; drugi PUT POSODOBI isto vrstico (upsert); audit zapisan', async () => {
    const p1 = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, ...RATES }))
    expect(p1.status).toBe(200)
    const j1 = await body(p1)
    expect(j1.rates).toMatchObject({ locationId: locA, source: 'location', ...RATES })

    // upsert: drugi PUT z drugačnimi nogami NE ustvari druge vrstice
    const p2 = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: 35, sundayPct: 10, holidayPct: 20, overtimePct: 50 }))
    expect(p2.status).toBe(200)
    const count = await db.payrollSurchargeRate.count({ where: { locationId: locA } })
    expect(count).toBe(1)

    const g = await ratesGET(req('GET', `/api/payroll/surcharge-rates?locationId=${locA}`, tok))
    expect(g.status).toBe(200)
    const jg = await body(g)
    expect(jg.rates).toMatchObject({ locationId: locA, source: 'location', nightPct: 35 })

    const audit = await db.auditLog.findFirst({
      where: { action: 'PAYROLL_SURCHARGE_RATES_UPDATED', entityId: locA },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(String(audit?.details ?? '')).toContain('35')

    // nazaj na RATES (preostanek teka dela z dokumentiranimi nogami)
    const back = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, ...RATES }))
    expect(back.status).toBe(200)
  })

  it('GET za lokacijo BREZ vrstice pade na PRIVZETE (NULL) → source default', async () => {
    // NULL vrstica = platform-level konfiguracija; v testu jo vsadimo direktno
    // (ruto varuje guard) in POBRŠEMO v istem testu (drugi testi teka delajo brez nog)
    const id = `${P}rates-null-${RUN}`
    await db.payrollSurchargeRate.create({ data: { id, locationId: null, ...RATES } })
    try {
      const g = await ratesGET(req('GET', `/api/payroll/surcharge-rates?locationId=${locB}`, adminToken))
      expect(g.status).toBe(200)
      const jg = await body(g)
      expect(jg.rates).toMatchObject({ locationId: null, source: 'default', ...RATES })
    } finally {
      await db.payrollSurchargeRate.deleteMany({ where: { id } }).catch(() => null)
    }
  })
})

describe('Č3d detail + izvoz Z nogami (zneski ob minutah)', () => {
  it('detail: DTO nog + zneski v osnovah', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${periodId}`, tok), params(periodId))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.surchargeRates).toMatchObject({ locationId: locA, source: 'location', ...RATES })
    const bases = j.surchargeBases as { perEmployeeJob: Array<Record<string, number>>; overtime: Array<Record<string, number>> }
    expect(bases.perEmployeeJob[0].nightAmtCents).toBe(2100)
    expect(bases.perEmployeeJob[0].sundayAmtCents).toBe(1100)
    expect(bases.perEmployeeJob[0].holidayAmtCents).toBe(2200)
    expect(bases.overtime[0].overtimeAmtCents).toBe(1750)
  })

  it('izvoz CSV: zneski ob minutah + noga izvoza zapiše uporabljene noge', async () => {
    const re = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=csv`, tok), params(periodId))
    expect(re.status).toBe(200)
    const csv = await re.text()
    expect(csv).toContain(';420;21,00;660;11,00;660;22,00;1140')
    expect(csv).toContain('SKUPAJ;NocMin;420;NocEur;21,00;NedeljaMin;660;NedeljaEur;11,00;PraznikMin;660;PraznikEur;22,00')
    expect(csv).toContain(';210;17,50;1')
    expect(csv).toContain('Noge (uporabniski vhod po kolektivni pogodbi);Noc=30%;Nedelja=10%;Praznik=20%;Nadure=50%;Zakonitost nog potrdi zunanji payroll sistem.')
    expect(csv).toContain('Shema;payroll-export/3')
  })

  it('izvoz JSON: schemaVersion /3 + DTO nog; isti izvoz → identicalToPrevious true', async () => {
    const rj = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=json`, tok), params(periodId))
    expect(rj.status).toBe(200)
    const jj = await body(rj)
    expect(jj.schemaVersion).toBe('payroll-export/3')
    expect(jj.surchargeRates).toMatchObject({ locationId: locA, source: 'location', ...RATES })
    const bases = jj.surchargeBases as { perEmployeeJob: Array<Record<string, number>> }
    expect(bases.perEmployeeJob[0].nightAmtCents).toBe(2100)

    // ponovni izvoz BREZ spremembe → ista vsebina → identical true
    const re2 = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=csv`, tok), params(periodId))
    expect(re2.status).toBe(200)
    const exports = await db.payrollExport.findMany({ where: { periodId }, orderBy: { seq: 'asc' } })
    expect(exports.length).toBeGreaterThanOrEqual(4)
    expect(exports[exports.length - 1].identicalToPrevious).toBe(true)
  })

  it('sprememba noge → NOV contentHash (identical false), vrstice (rowDigest) nespremenjene', async () => {
    const p = await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, nightPct: 31, sundayPct: 10, holidayPct: 20, overtimePct: 50 }))
    expect(p.status).toBe(200)
    const re = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=csv`, tok), params(periodId))
    expect(re.status).toBe(200)
    const exports = await db.payrollExport.findMany({ where: { periodId }, orderBy: { seq: 'asc' } })
    const last = exports[exports.length - 1]
    const prev = exports[exports.length - 2]
    expect(last.contentHash).not.toBe(prev.contentHash)
    expect(last.identicalToPrevious).toBe(false)
    expect(last.changedEntries).toBe(0) // minute/bruto postavke NESPREMENJENE — spremenila se je noga
    // nazaj na RATES — po teku ostane dokumentirano stanje
    await ratesPUT(req('PUT', '/api/payroll/surcharge-rates', tok, { locationId: locA, ...RATES }))
  })
})

describe('Č3e DDL ruta (migrate-payroll-surcharge-rates)', () => {
  it('403 za managerja (requireCentralRole)', async () => {
    expect((await migratePOST(req('POST', '/api/admin/migrate-payroll-surcharge-rates', tok, {}))).status).toBe(403)
  })

  it('200 za admina; na SQLite/CI bazi tabela že prek db push → skipped + audit', async () => {
    const r = await migratePOST(req('POST', '/api/admin/migrate-payroll-surcharge-rates', adminToken, {}))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(Array.isArray(j.applied)).toBe(true)
    expect(j.skipped).toContain('PayrollSurchargeRate') // db push je tabelo že vsadil
    expect(j.alreadyApplied).toBe(true)
    const audit = await db.auditLog.findFirst({
      where: { action: 'SCHEMA_MIGRATION_PAYROLL_SURCHARGE_RATES', entityId: 'payroll-surcharge-rates' },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
  })
})

/* ═══════════════════ Č4. UI STATIKA + REGISTRI + DOKUMENTACIJSKA RESNICA ═══════════════════ */

describe('Č4 UI statika + registri', () => {
  const tab = () => readFileSync('src/components/tabs/payroll-tab.tsx', 'utf8')

  it('kartica nog: Collapsible komponenta z GET/PUT klici in pogojno kolono zneska', () => {
    const src = tab()
    expect(src).toContain('function SurchargeRatesCard')
    expect(src).toContain('/api/payroll/surcharge-rates')
    expect(src).toContain("t('payr.rates.title')")
    expect(src).toContain("t('payr.rates.migr')") // migrBox do DDL — ni tihe odpovedi
    expect(src).toContain("{rates && <th className=\"p-2 text-right\">{t('payr.rates.amount')}</th>}")
    // read-only invarianta pregleda osnov ostaja — kolona je prikaz, ne mutacija
    expect(src).toContain('<SurchargeTable bases={detail.surchargeBases} rates={detail.surchargeRates} />')
  })

  it('i18n: 16 novih ključev (payr.rates.* ×15 + mig.*) v OBAH slovarjih, pariteta', () => {
    const keys = [
      'payr.rates.title', 'payr.rates.hint', 'payr.rates.location', 'payr.rates.defaultLoc',
      'payr.rates.night', 'payr.rates.sunday', 'payr.rates.holiday', 'payr.rates.overtime',
      'payr.rates.save', 'payr.rates.saved', 'payr.rates.invalid', 'payr.rates.notSet',
      'payr.rates.amount', 'payr.rates.usedHint', 'payr.rates.migr',
      'mig.payrollSurchargeRates.desc',
    ]
    for (const k of keys) {
      expect(typeof sl[k]).toBe('string')
      expect(typeof hr[k]).toBe('string')
    }
    expect(sl['payr.rates.title']).toBe('Noge doplačil')
    expect(hr['payr.rates.title']).toBe('Stope doplata')
    // pariteta celotnih slovarjev
    expect(Object.keys(sl).length).toBe(Object.keys(hr).length)
  })

  it('shema: model v OBEH shemah + baseline migracija (polna projekcija)', () => {
    const prod = readFileSync('prisma/schema.prisma', 'utf8')
    const sqlite = readFileSync('prisma/schema.sqlite.prisma', 'utf8')
    for (const s of [prod, sqlite]) {
      expect(s).toContain('model PayrollSurchargeRate')
      expect(s).toContain('@@unique([locationId])')
    }
    expect(prod).toMatch(/nightPct\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(5,\s*2\)/)
    expect(sqlite).not.toContain('@db.Decimal')
    // zrcalna shema OBDRŽI runtime-gated stolpec kategorij (Task 66 — izven main schema)
    const apBlock = /model AccountsPayable \{[\s\S]*?\n\}/.exec(sqlite)?.[0] ?? ''
    expect(apBlock).toContain('category')
    const migration = readFileSync('prisma/migrations/00000000000000_init/migration.sql', 'utf8')
    expect(migration).toContain('CREATE TABLE "PayrollSurchargeRate"')
    expect(migration).toContain('CREATE UNIQUE INDEX "PayrollSurchargeRate_locationId_key"')
  })

  it('register SCHEMA_MIGRATIONS: 33. vnos payroll-surcharge-rates (descKey/endpoint/probe)', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(36) // v1.200.0: +equipment-maintenance (OSS-1)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'payroll-surcharge-rates')
    expect(m).toBeDefined()
    expect(m?.descKey).toBe('mig.payrollSurchargeRates.desc')
    expect(m?.endpoint).toBe('/api/admin/migrate-payroll-surcharge-rates')
    expect(typeof m?.probe).toBe('function')
  })

  it('drift allowlist: 25 vnosov; CREATE TABLE PayrollSurchargeRate je znan drift', () => {
    expect(KNOWN_DRIFTS).toHaveLength(28) // v1.202.0: +inventory-ean (OSS-9) // v1.200.0: +equipment-maintenance (OSS-1)
    const cls = classifyDrift(
      'CREATE TABLE "PayrollSurchargeRate" ("id" TEXT NOT NULL, "locationId" TEXT, CONSTRAINT "PayrollSurchargeRate_pkey" PRIMARY KEY ("id"));\n' +
        'CREATE UNIQUE INDEX "PayrollSurchargeRate_locationId_key" ON "PayrollSurchargeRate"("locationId");',
    )
    expect(cls.unexpected).toEqual([])
    expect(cls.known.map((k) => k.id)).toEqual(['payroll-surcharge-rates'])
    // strogost: ALTER na isti tabeli je prav tako pokrit, tuja tabela NE
    expect(classifyDrift('ALTER TABLE "PayrollSurchargeRate" ADD COLUMN "x" TEXT;').unexpected).toEqual([])
    expect(classifyDrift('CREATE TABLE "Backdoor" ("id" TEXT NOT NULL);').unexpected).toHaveLength(1)
  })

  it('izvozna shema je /3 (aditivna — Eur kolone vedno prisotne)', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe('payroll-export/3')
  })

  it('verzija 1.212.0', () => {
    expect(APP_VERSION).toBe('1.213.0')
  })
})
