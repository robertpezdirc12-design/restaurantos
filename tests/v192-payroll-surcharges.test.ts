/**
 * P3 #19 (v1.192.0) — doplačilne osnove obračuna (noč/nedelja/praznik/nadure).
 *
 * Zapira vrzel docs/TRZNA-VRZELI-2026.md §4 #19: izvoz obračuna je nosil minute
 * in bruto postavke, biro pa je statutarne doplačile razstavljali ROČNO. v1.192.0
 * doda deterministične OSNOVE (minute) — odstotki ostajajo biroju (noga izvoza):
 *
 *  Č1 PRAZNIKI (src/lib/payroll-holidays.ts, pure): Velika noč po Gregorijanskem
 *     algoritmu (pini uradnih koledarjev 2025–2027), SI/HR seznami (velikost +
 *     ključni dnevi), Božje telo HR (+60), meje obdobja čez leto, neznana
 *     država → [] (fail-safe), addDaysISO.
 *  Č2 ČISTI SLOJ (src/lib/payroll-surcharges.ts, pure): noč čez polnoč
 *     (Europe/Ljubljana CET — fiksni zamik v januarju), dnevna izmena → 0,
 *     nedelja čez polnoč (samo del po polnoči), Praznik+Nedelja dvojna
 *     kategorija (Prešernov dan 2026-02-08 je nedelja), odprt vnos → 0,
 *     nadure = dnevni presežek neto nad pragom (480; prag NE je presežen pri
 *     =), samo approved, clamp politike.
 *  Č3 IZVOZNI GRADNIKI (src/lib/payroll.ts, pure): CSV sekcija DOPLACILNE
 *     OSNOVE + SKUPAJ + noga (odstotki ostajajo zunanji), Shema
 *     payroll-export/2, canonicalExportJson pokriva osnove (contentHash).
 *  Č4 RUTE (DB): GET /api/payroll/[id] → surchargeBases ŽIVE (draft); 401;
 *     close (čisto obdobje); export CSV + JSON z osnovami (shema /2).
 *
 * Fiksture s predpono v192ps-; obdobje februar 2026 (konec v preteklosti —
 * fiksno leto, brez odvisnosti od tekočega datuma); CET (UTC+1) — brez DST v
 * februarju (deterministični zamik +1 h).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  easterSundayISO,
  addDaysISO,
  statutoryHolidays,
  holidaysInRange,
} from '../src/lib/payroll-holidays'
import {
  DEFAULT_SURCHARGE_CONFIG,
  clampSurchargeConfig,
  intervalCategoryMinutes,
  surchargeBasisRows,
  type SurchargeEntryRow,
} from '../src/lib/payroll-surcharges'
import {
  buildPayrollCsv,
  canonicalExportJson,
  totalsOfRows,
  EXPORT_SCHEMA_VERSION,
  type PayrollEntryRow,
  type TipExportRow,
} from '../src/lib/payroll'
import { GET as payrollDetailGET } from '../src/app/api/payroll/[id]/route'
import { POST as payrollPOST } from '../src/app/api/payroll/route'
import { POST as payrollClosePOST } from '../src/app/api/payroll/[id]/close/route'
import { GET as payrollExportGET } from '../src/app/api/payroll/[id]/export/route'

const P = 'v192ps-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TZ = 'Europe/Ljubljana'

let locA = ''
let mgr = ''
let empA = ''
let empB = ''
let jobA = ''
let tok = ''
let entryNight = ''
let entryDay = ''
let periodId = ''
let csv = ''

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function cleanup() {
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
    .deleteMany({ where: { OR: [{ locationId: { startsWith: P } }, { entityId: { startsWith: P } }] } })
    .catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `V19A-${RUN.toUpperCase()}`, timezone: TZ, country: 'SI' },
  })
  locA = la.id

  const seed = async (key: string, name: string, role: string, seq: number): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const pin = `${PIN_BASE}${seq}`
    const f = employeePinFields(pin, `${id}@test.local`)
    await db.employee.create({
      data: { id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: locA, pin: f.pin, pinLookup: f.pinLookup },
    })
    return id
  }
  mgr = await seed('mgr', `${P}Vodja Vida`, 'manager', 1)
  empA = await seed('empA', `${P}Natakar Nace`, 'waiter', 2)
  empB = await seed('empB', `${P}Kuhar Klemen`, 'chef', 3)
  tok = createToken({ sub: mgr, name: `${P}Vodja Vida`, role: 'MANAGER', loc: locA, sv: 0 })

  jobA = `${P}jobA-${RUN}`
  await db.job.create({ data: { id: jobA, name: `${P}Natakar ${RUN}`, basePayRate: 10, isActive: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-a-${RUN}`, employeeId: empA, jobId: jobA, payRate: 10, isPrimary: true } })
  await db.employeeJob.create({ data: { id: `${P}ej-b-${RUN}`, employeeId: empB, jobId: jobA, payRate: 10, isPrimary: true } })

  // vnos A — nočna izmena čez polnoč na PRAZNIŠKO NEDELJO (Prešernov dan
  // 2026-02-08): lokalno sob 23:00 → ned 11:00 (CET = UTC+1), 12 h − 30 odmor
  // = 690 neto (brez LONG_NO_BREAK); kategorije pred odmorom
  entryNight = `${P}te-n-${RUN}`
  await db.timeEntry.create({
    data: {
      id: entryNight, employeeId: empA, jobId: jobA,
      clockIn: new Date('2026-02-07T22:00:00Z'), clockOut: new Date('2026-02-08T10:00:00Z'),
      breakMinutes: 30, totalMinutes: 690, payRate: 10, totalPay: 115,
      type: 'regular', status: 'approved', notes: '', locationId: locA,
    },
  })
  // vnos B — dnevna izmena ponedeljek 480 neto (brez noči/nedelje/praznika)
  entryDay = `${P}te-d-${RUN}`
  await db.timeEntry.create({
    data: {
      id: entryDay, employeeId: empA, jobId: jobA,
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
  await cleanup()
})

/* ═══════════════════ Č1. PRAZNIKI (payroll-holidays.ts) ═══════════════════ */

describe('Č1 prazniki SI/HR (deterministično, pure)', () => {
  it('Velika noč po Gregorijanskem algoritmu — pini uradnih koledarjev', () => {
    expect(easterSundayISO(2026)).toBe('2026-04-05')
    expect(easterSundayISO(2025)).toBe('2025-04-20')
    expect(easterSundayISO(2027)).toBe('2027-03-28')
    expect(easterSundayISO(2024)).toBe('2024-03-31')
  })

  it('addDaysISO — prehod meseca in +60 dni (Božje telo)', () => {
    expect(addDaysISO('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysISO('2026-04-05', 1)).toBe('2026-04-06')
    expect(addDaysISO('2026-04-05', 60)).toBe('2026-06-04')
    expect(addDaysISO('2025-04-20', 60)).toBe('2025-06-19')
  })

  it('SI 2026: 14 praznikov (12 fiksnih + velika noč + ponedeljek), ključni dnevi', () => {
    const si = statutoryHolidays(2026, 'SI')
    expect(si.length).toBe(14)
    expect(si).toContain('2026-01-02') // novo leto 2. dan
    expect(si).toContain('2026-02-08') // Prešernov dan
    expect(si).toContain('2026-04-05') // velikonočna nedelja
    expect(si).toContain('2026-04-06') // velikonočni ponedeljek
    expect(si).toContain('2026-12-26') // dan samostojnosti in enotnosti
    expect(si).not.toContain('2026-01-06') // HR praznik, ne SI
  })

  it('HR 2026: 14 praznikov (11 fiksnih + velika noč + ponedeljek + Božje telo)', () => {
    const hr = statutoryHolidays(2026, 'HR')
    expect(hr.length).toBe(14)
    expect(hr).toContain('2026-01-06') // Bogojavljenje
    expect(hr).toContain('2026-05-30') // Dan državnosti (od 2020)
    expect(hr).toContain('2026-06-04') // Božje telo (velika noč + 60)
    expect(hr).toContain('2026-11-18') // Dan sjećanja (od 2020)
    expect(hr).not.toContain('2026-02-08') // SI praznik, ne HR
  })

  it('neznana država → prazen seznam (fail-safe, ne izmišljujemo si praznikov)', () => {
    expect(statutoryHolidays(2026, 'XX')).toEqual([])
    expect(statutoryHolidays(2026, '')).toEqual([])
  })

  it('holidaysInRange — meja čez leto pokrije obe leti', () => {
    const s = holidaysInRange('2025-12-20', '2026-01-10', 'SI')
    expect(s.has('2025-12-25')).toBe(true)
    expect(s.has('2026-01-02')).toBe(true)
    expect(s.has('2026-02-08')).toBe(true) // nadzorna množica obeh let
  })
})

/* ═══════════════════ Č2. ČISTI SLOJ (payroll-surcharges.ts) ═══════════════════ */

describe('Č2 doplačilne osnove (intervali + nadure, pure)', () => {
  it('noč čez polnoč (CET januar): lokalno 22:00–02:00 → 240 min noč', () => {
    // lokalna CET = UTC+1: 22:00 lokalno = 21:00 UTC; 02:00 lokalno = 01:00 UTC
    const c = intervalCategoryMinutes('2026-01-15T21:00:00Z', '2026-01-16T01:00:00Z', TZ, new Set())
    expect(c.nightMinutes).toBe(240)
    expect(c.sundayMinutes).toBe(0)
    expect(c.holidayMinutes).toBe(0)
  })

  it('dnevna izmena (09:00–17:00): vse kategorije 0', () => {
    const c = intervalCategoryMinutes('2026-01-16T08:00:00Z', '2026-01-16T16:00:00Z', TZ, new Set())
    expect(c.nightMinutes).toBe(0)
    expect(c.sundayMinutes).toBe(0)
    expect(c.holidayMinutes).toBe(0)
  })

  it('nedelja čez polnoč: sob 23:00 → ned 02:00 — nedelja 120, noč 180', () => {
    // 2026-01-17 = sobota, 2026-01-18 = nedelja
    const c = intervalCategoryMinutes('2026-01-17T22:00:00Z', '2026-01-18T01:00:00Z', TZ, new Set())
    expect(c.sundayMinutes).toBe(120) // 00:00–02:00 nedelje
    expect(c.nightMinutes).toBe(180) // 23:00–00:00 (60) + 00:00–02:00 (120)
    expect(c.holidayMinutes).toBe(0)
  })

  it('praznik + nedelja dvojno (Prešernov dan 2026-02-08 je nedelja): 660/660 + noč 420', () => {
    const hol = new Set(['2026-02-08'])
    const c = intervalCategoryMinutes('2026-02-07T22:00:00Z', '2026-02-08T10:00:00Z', TZ, hol)
    expect(c.sundayMinutes).toBe(660) // 00:00–11:00 nedelje
    expect(c.holidayMinutes).toBe(660) // isti dan je praznik
    expect(c.nightMinutes).toBe(420) // 23:00–00:00 (60) + 00:00–06:00 (360)
  })

  it('odprt vnos (clockOut null) → vse 0 (osnova nastane šele ob odjavi)', () => {
    const c = intervalCategoryMinutes('2026-02-07T22:00:00Z', null, TZ, new Set(['2026-02-08']))
    expect(c.nightMinutes).toBe(0)
    expect(c.sundayMinutes).toBe(0)
    expect(c.holidayMinutes).toBe(0)
  })

  it('nadure: dnevni presežek neto nad pragom 480 — samo preseženi dnevi', () => {
    const rows: SurchargeEntryRow[] = [
      { employeeId: 'e1', employeeName: 'A', jobId: null, jobName: '', date: '2026-02-07', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T10:00:00Z', netMinutes: 690, status: 'approved' },
      { employeeId: 'e1', employeeName: 'A', jobId: null, jobName: '', date: '2026-02-09', clockIn: '2026-02-09T08:00:00Z', clockOut: '2026-02-09T16:00:00Z', netMinutes: 450, status: 'approved' },
      { employeeId: 'e1', employeeName: 'A', jobId: null, jobName: '', date: '2026-02-10', clockIn: '2026-02-10T08:00:00Z', clockOut: '2026-02-10T16:00:00Z', netMinutes: 480, status: 'approved' }, // = prag NI presežen
    ]
    const r = surchargeBasisRows(rows, TZ, new Set())
    expect(r.overtime.length).toBe(1)
    expect(r.overtime[0].overtimeBasisMinutes).toBe(210) // (690−480) + 0 + 0
    expect(r.overtime[0].daysOverThreshold).toBe(1)
    // perEmployeeJob: ENA skupina (isti zaposleni+delo) z vsoto kategorij
    expect(r.perEmployeeJob.length).toBe(1)
    expect(r.perEmployeeJob[0].approvedMinutes).toBe(1620)
  })

  it('nepotrjene vrstice se NE štejejo (ista pravila kot plačilna osnova)', () => {
    const rows: SurchargeEntryRow[] = [
      { employeeId: 'e1', employeeName: 'A', jobId: null, jobName: '', date: '2026-02-07', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T02:00:00Z', netMinutes: 240, status: 'active' },
    ]
    const r = surchargeBasisRows(rows, TZ, new Set())
    expect(r.perEmployeeJob.length).toBe(0)
    expect(r.overtime.length).toBe(0)
  })

  it('clamp politike: meje 0–1440, konec ≥ začetek → samo jutranji rep', () => {
    const c = clampSurchargeConfig({ nightStartMin: 1500, nightEndMin: -5, dailyNetThresholdMin: 99999 })
    expect(c.nightStartMin).toBe(1440)
    expect(c.nightEndMin).toBe(0)
    expect(c.dailyNetThresholdMin).toBe(1440)
    // nightStart 1320, nightEnd 1320 → okno brez večernega repa
    const c2 = clampSurchargeConfig({ ...DEFAULT_SURCHARGE_CONFIG, nightEndMin: 1320 })
    const cats = intervalCategoryMinutes('2026-01-15T21:00:00Z', '2026-01-15T22:00:00Z', TZ, new Set(), c2)
    expect(cats.nightMinutes).toBe(0) // 22:00–23:00 lokalno = rep [1320,1440) je izklopljen
    expect(DEFAULT_SURCHARGE_CONFIG.nightStartMin).toBe(1320)
    expect(DEFAULT_SURCHARGE_CONFIG.nightEndMin).toBe(360)
    expect(DEFAULT_SURCHARGE_CONFIG.dailyNetThresholdMin).toBe(480)
  })
})

/* ═══════════════════ Č3. IZVOZNI GRADNIKI (payroll.ts) ═══════════════════ */

describe('Č3 izvoz: CSV sekcija + kanonični JSON pokriva osnove (pure)', () => {
  const row = (over: Partial<PayrollEntryRow>): PayrollEntryRow => ({
    entryId: 'e1', employeeId: 'emp', employeeName: 'N', jobId: null, jobName: '',
    date: '2026-02-08', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T02:00:00Z',
    breakMinutes: 0, netMinutes: 240, payRateCents: 1000, grossCents: 4000,
    type: 'regular', status: 'approved', locationId: null, ...over,
  })
  const tip = (over: Partial<TipExportRow>): TipExportRow => ({
    distributionId: 'd1', employeeId: 'emp', employeeName: 'N', amountCents: 1000,
    status: 'pending', poolId: 'p1', poolDate: '2026-02-08', poolCashCents: 1000, poolCardCents: 0, ...over,
  })
  const baseInput = () => {
    const rows = [row({}), row({ entryId: 'e2', status: 'active', grossCents: 0, netMinutes: 0 })]
    const tips = [tip({})]
    return {
      period: { id: 'per', locationId: null, startISO: '2026-02-02', endISO: '2026-02-14', timezone: TZ, status: 'closed', version: 1, closeNote: '' },
      rows,
      tips,
      totals: totalsOfRows(rows, tips, [{ cashCents: 1000, cardCents: 0 }]),
      surchargeBases: surchargeBasisRows([
        { employeeId: 'emp', employeeName: 'N', jobId: null, jobName: '', date: '2026-02-07', clockIn: '2026-02-07T22:00:00Z', clockOut: '2026-02-08T10:00:00Z', netMinutes: 690, status: 'approved' },
      ], TZ, new Set(['2026-02-08'])),
      exportMeta: { seq: 1, generatedISO: '2026-02-15T08:00:00Z', contentHash8: 'abcd1234', changedEntries: 0, identicalToPrevious: false },
    }
  }

  it(`EXPORT_SCHEMA_VERSION je 'payroll-export/2' (aditivna sekcija)`, () => {
    expect(EXPORT_SCHEMA_VERSION).toBe('payroll-export/2')
  })

  it('CSV: DOPLACILNE OSNOVE sekcija z vrednostmi + SKUPAJ + iskrena noga', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv.includes('DOPLACILNE OSNOVE (minute - odstotek potrdi zunanji payroll sistem)')).toBe(true)
    expect(csv.includes('ZaposleniID;Zaposleni;DeloID;Delo;NocMin;NedeljaMin;PraznikMin;PotrjenoNetoMin')).toBe(true)
    // vnos 690 neto na prazniško nedeljo: noč 420, nedelja 660, praznik 660
    expect(csv.includes(';420;660;660;690')).toBe(true)
    expect(csv.includes('SKUPAJ;NocMin;420;NedeljaMin;660;PraznikMin;660')).toBe(true)
    expect(csv.includes('Nadure po zaposlenem (dnevni presezek NETO minut nad pragom; po dnevu prijave)')).toBe(true)
    expect(csv.includes(';210;1')).toBe(true) // 690 − 480 = 210, 1 dan nad pragom
    expect(csv.includes('RestaurantOS ne izracunava odstotkov doplacil')).toBe(true)
    expect(csv.includes('Shema;payroll-export/2')).toBe(true)
    expect(csv.includes('KontrolniHash;abcd1234')).toBe(true)
  })

  it('canonicalExportJson pokriva surchargeBases (contentHash spremembe osnov ulovi)', () => {
    const a = canonicalExportJson(baseInput())
    const changed = baseInput()
    changed.surchargeBases.perEmployeeJob[0].nightMinutes = 421
    const b = canonicalExportJson(changed)
    expect(a.includes('surchargeBases')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('CSV obstoječe sekcije NESPREMENJENE (vnosi, povzetek, napitnine)', () => {
    const csv = buildPayrollCsv(baseInput())
    expect(csv.includes('VNOSI DELAVNEGA ČASA')).toBe(true)
    expect(csv.includes('POVPZETEK PO ZAPOSLENEM IN DELOVNEM MESTU (samo potrjeno)')).toBe(true)
    expect(csv.includes('NAPITNINE')).toBe(true)
    expect(csv.includes('Napitnine pending se ne stejejo kot izplacane.')).toBe(true)
  })
})

/* ═══════════════════ Č4. RUTE (DB) ═══════════════════ */

describe('Č4 rute: detail + close + export nosijo doplačilne osnove', () => {
  it('GET /api/payroll/[id] — ŽIVE osnove že v draftu (noč 420, nedelja 660, praznik 660, nadure 210)', async () => {
    expect(periodId).not.toBe('')
    const r = await payrollDetailGET(req('GET', `/api/payroll/${periodId}`, tok), params(periodId))
    expect(r.status).toBe(200)
    const j = await body(r)
    const bases = j.surchargeBases as { perEmployeeJob: Array<Record<string, number | string | null>>; overtime: Array<Record<string, number | string>> }
    expect(bases.perEmployeeJob.length).toBe(1)
    const b = bases.perEmployeeJob[0]
    expect(b.nightMinutes).toBe(420)
    expect(b.sundayMinutes).toBe(660)
    expect(b.holidayMinutes).toBe(660)
    expect(b.approvedMinutes).toBe(1140) // 690 + 450
    expect(bases.overtime.length).toBe(1)
    expect(bases.overtime[0].overtimeBasisMinutes).toBe(210) // (690−480) + (450−480→0)
    expect(bases.overtime[0].daysOverThreshold).toBe(1)
  })

  it('brez žetona → 401', async () => {
    const r = await payrollDetailGET(req('GET', `/api/payroll/${periodId}`, 'no-such-token'), params(periodId))
    expect(r.status).toBe(401)
  })

  it('close (čisto obdobje) → 200; export CSV + JSON z osnovami (shema /2)', async () => {
    const rc = await payrollClosePOST(req('POST', `/api/payroll/${periodId}/close`, tok, {}), params(periodId))
    expect(rc.status).toBe(200)

    const re = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=csv`, tok), params(periodId))
    expect(re.status).toBe(200)
    csv = await re.text()
    expect(csv.includes('DOPLACILNE OSNOVE (minute - odstotek potrdi zunanji payroll sistem)')).toBe(true)
    expect(csv.includes(';420;660;660;1140')).toBe(true) // kategorije + potrjena neto osnova
    expect(csv.includes('SKUPAJ;NocMin;420;NedeljaMin;660;PraznikMin;660')).toBe(true)
    expect(csv.includes(';210;1')).toBe(true) // nadure po zaposlenem
    expect(csv.includes('Shema;payroll-export/2')).toBe(true)

    const rj = await payrollExportGET(req('GET', `/api/payroll/${periodId}/export?format=json`, tok), params(periodId))
    expect(rj.status).toBe(200)
    const jj = await body(rj)
    expect(jj.schemaVersion).toBe('payroll-export/2')
    const bases = jj.surchargeBases as { perEmployeeJob: unknown[]; overtime: unknown[] }
    expect(bases.perEmployeeJob.length).toBe(1)
    expect(bases.overtime.length).toBe(1)
  })
})
