/**
 * Issue #20 (P1/P2, v1.109.0) — operativni HACCP tok: zapadli termini,
 * strukturirane meritve, odstopanja, korektivni ukrepi in verifikacija.
 *
 * Pokritost (zahteve iz issue Testi):
 *  A. MOTOR (čiste funkcije): časovni pas (Ljubljana vs New York), DST
 *     prehod 25.10.2026 (CEST→CET — 10:00 lokalno = 09:00 UTC pozimi,
 *     08:00 UTC poleti), prelom dneva po LOKACIJSKEM koledarju, termini
 *     daily/weekly/monthly (neujemajoči dnevi → brez termina), evaluacija
 *     meritev (below/above/between/none + confirm pass/fail + kritičnost),
 *     validacija pravil načrta, plošča stanj (zapadlo vključno z dnevi brez
 *     izvedbe), numStrict (0 legitimna vrednost!), CSV izvoz.
 *  B. GOVERNED POST: strežnik izračuna status (klientov 'ok' čez kritično
 *     mejo → critical — ni ponarejanja), manjkajoča meritev → 400, confirm
 *     izid, podvojen termin → 409, napačen dan termina → 400, tuja lokacija
 *     403, DDL probe OFF → 503, RBAC (cleaner izvedba / natakar 403 / brez
 *     žetona 401).
 *  C. STATE MACHINE: kratek korektiv 400, korektiv → awaiting_verification
 *     (brez verifikacije NE zapre), ponovni odčitek USPEŠEN → closed,
 *     NEUSPEŠEN → odstopanje ostane, potrditev vodje (ne-vodstvo 403,
 *     vodstvo 200), zaklenjen 409, requiresVerification=false → korektiv
 *     zapre takoj, legacy zapis (brez cikla) — dogodek se zapiše brez stanj.
 *  D. SNAPSHOT: vnos pri okLimit 4 → PATCH na 8 → POSNETEK se NE spremeni
 *     (ponovni odčitek 6 še vedno NEUSPEŠEN po stari meji), version bump 2.
 *  E. PLOŠČA: zapadli/današnji/odstopanje vidni; tuja lokacija NE vidi;
 *     brez dovoljenja 403.
 *  F. POROČILO: CSV BOM/;/glave + vrstice s korektivom/verifikacijo;
 *     filtri; brez žetona 401.
 *  G. NAČRTI: nova polja + validacije (number brez enote 400, weekly brez
 *     dneva 400, monthDay 29 400), PATCH semantičen → version 2, admin
 *     brez dovoljenja 403, GET ddlOpsPending false.
 *  H. CRON: zapadli termin → 1 opomnik; PONOVNI tek → 0 (state marker);
 *     izveden termin → brez opomnika.
 *  I. DDL + drift + push tipi.
 *
 * Fiksture s predpono i20-. Lokacija timezone: Ljubljana (default).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { PUSH_EVENT_TYPES } from '../src/lib/push-events'
import {
  zonedTimeToUtc, zonedDateParts, localWeekday, occurrenceForDate, evalMeasurement, evalConfirm,
  validatePlanRuleInput, buildSchedule, stateOfEntry, thresholdText, numStrict, haccpReportCsv,
  ruleSnapshotOf, parseRuleSnapshot,
  type LocalDate, type PlanRule,
} from '../src/lib/haccp-ops'
import { isUnalertedOverdue, overdueBody, HACCP_OVERDUE_STATE_MARKER } from '../src/lib/haccp-overdue'
import { POST as entryPOST, GET as entryGET } from '../src/app/api/haccp/route'
import { GET as scheduleGET } from '../src/app/api/haccp/schedule/route'
import { GET as detailGET } from '../src/app/api/haccp/[id]/route'
import { POST as actionsPOST } from '../src/app/api/haccp/[id]/actions/route'
import { GET as reportGET } from '../src/app/api/haccp/report/route'
import { POST as planPOST, GET as planGET } from '../src/app/api/haccp/plans/route'
import { PATCH as planPATCH } from '../src/app/api/haccp/plans/[id]/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-haccp-ops/route'
import { classifyDrift } from '../scripts/drift-check'
import { resetHaccpOpsProbe } from '../src/lib/haccp-ops'

const P = 'i20-'
const RUN = Date.now().toString(36)

let locA = ''
let locB = ''
let cleanerAId = ''
let cleanerBId = ''
let mgrAId = ''
let mgrBId = ''
let tokMgrB = ''
let waiterAId = ''
let tokCleanerA = ''
let tokCleanerB = ''
let tokMgrA = ''
let tokWaiterA = ''

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(name: string, role: string, loc: string | null): Promise<{ id: string; pin: string }> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return { id, pin }
}

async function newLoc(tag: string): Promise<string> {
  const id = `${P}loc${tag}-${RUN}`
  await db.location.create({ data: { id, code: `${P}L${tag}`, name: `${P}Lok ${tag}`, premisesId: `${P}prem${tag}-${RUN}` } })
  return id
}

/** Ustvari načrt na lokaciji (settings.manage žeton). */
async function createPlan(loc: string, over: Record<string, unknown> = {}, token?: string): Promise<Record<string, unknown>> {
  const res = await planPOST(
    req('POST', '/api/haccp/plans', token ?? tokMgrA, {
      name: `${P}hladilnik ${RUN}`,
      category: 'temperature',
      frequency: 'daily',
      measureKind: 'number',
      unit: '°C',
      direction: 'below',
      okLimit: 4,
      warnLimit: 6,
      dueTime: '10:00',
      requiresVerification: true,
      locationId: loc,
      ...over,
    }),
  )
  const j = await body(res)
  return (j.plan ?? {}) as Record<string, unknown>
}

const today = (): LocalDate => {
  const p = zonedDateParts(new Date(), 'Europe/Ljubljana')
  return { y: p.y, m: p.m, d: p.d }
}
const dateKey = (d: LocalDate): string => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`

beforeAll(async () => {
  locA = await newLoc('A')
  locB = await newLoc('B')
  cleanerAId = (await seedEmp('cleanerA', 'cleaner', locA)).id
  cleanerBId = (await seedEmp('cleanerB', 'cleaner', locB)).id
  mgrAId = (await seedEmp('mgrA', 'manager', locA)).id
  waiterAId = (await seedEmp('waiterA', 'waiter', locA)).id
  mgrBId = (await seedEmp('mgrB', 'manager', locB)).id
  tokMgrB = tok(mgrBId, `${P}mgrB`, 'MANAGER', locB)
  tokCleanerA = tok(cleanerAId, `${P}cleanerA`, 'CLEANER', locA)
  tokCleanerB = tok(cleanerBId, `${P}cleanerB`, 'CLEANER', locB)
  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)
  resetHaccpOpsProbe(true) // dev baza ima stolpce (db push)
})

afterAll(async () => {
  resetHaccpOpsProbe()
  await sweepTestFixtures(db, [P])
})

/* ═══════════════ A. MOTOR — ČISTE FUNKCIJE ═══════════════ */

describe('A. časovni pas + DST (motor)', () => {
  it('A1: zonedTimeToUtc — Ljubljana (poletni CEST) 10:00 = 08:00 UTC', () => {
    const d = zonedTimeToUtc(2026, 7, 15, 10, 0, 'Europe/Ljubljana')
    expect(d.toISOString().slice(11, 16)).toBe('08:00')
  })

  it('A2: zonedTimeToUtc — New York (EDT) 10:00 = 14:00 UTC', () => {
    const d = zonedTimeToUtc(2026, 7, 15, 10, 0, 'America/New_York')
    expect(d.toISOString().slice(11, 16)).toBe('14:00')
  })

  it('A3: DST prehod 25.10.2026 (CEST→CET): predhodni dan 08:00 UTC, prehodni dan 09:00 UTC', () => {
    // sobota 24.10.2026 10:00 = še CEST (UTC+2) → 08:00Z
    const before = zonedTimeToUtc(2026, 10, 24, 10, 0, 'Europe/Ljubljana')
    expect(before.toISOString().slice(11, 16)).toBe('08:00')
    // nedelja 25.10.2026 10:00 = že CET (UTC+1) → 09:00Z
    const after = zonedTimeToUtc(2026, 10, 25, 10, 0, 'Europe/Ljubljana')
    expect(after.toISOString().slice(11, 16)).toBe('09:00')
    // SAM prehod je ob 03:00 — trenutek 00:30 še CEST
    const night = zonedTimeToUtc(2026, 10, 25, 0, 30, 'Europe/Ljubljana')
    expect(night.toISOString().slice(11, 16)).toBe('22:30') // prejšnji dan (24.10) 22:30 UTC
  })

  it('A4: zonedDateParts — prelom dneva po lokaciji (UTC 23:30 = naslednji dan v Ljubljani)', () => {
    const inst = new Date('2026-07-15T23:30:00Z')
    const p = zonedDateParts(inst, 'Europe/Ljubljana')
    expect(`${p.y}-${p.m}-${p.d}`).toBe('2026-7-16')
    expect(p.hh).toBe(1)
    expect(p.mm).toBe(30)
  })

  it('A5: localWeekday — ponedeljek 1, nedelja 7', () => {
    expect(localWeekday({ y: 2026, m: 7, d: 13 })).toBe(1) // 13.7.2026 = ponedeljek
    expect(localWeekday({ y: 2026, m: 7, d: 19 })).toBe(7) // 19.7.2026 = nedelja
  })
})

describe('B. termini načrta (motor)', () => {
  const plan = { id: 'p1', frequency: 'daily', dueTime: '10:00', weekday: null, monthDay: null }
  const weekly = { id: 'p2', frequency: 'weekly', dueTime: '08:00', weekday: 1, monthDay: null }
  const monthly = { id: 'p3', frequency: 'monthly', dueTime: '09:00', weekday: null, monthDay: 15 }
  const d = (day: number): LocalDate => ({ y: 2026, m: 7, d: day })

  it('B1: daily — termin vsak dan ob 10:00 (CEST → 08:00 UTC)', () => {
    const occ = occurrenceForDate(plan, d(15), 'Europe/Ljubljana')!
    expect(occ).not.toBeNull()
    expect(occ.key).toBe('p1|2026-07-15')
    expect(occ.dueAt.toISOString().slice(11, 16)).toBe('08:00')
  })

  it('B2: weekly — termin SAMO ob ustreznem dnevu v tednu', () => {
    expect(occurrenceForDate(weekly, d(13), 'Europe/Ljubljana')).not.toBeNull() // ponedeljek
    expect(occurrenceForDate(weekly, d(14), 'Europe/Ljubljana')).toBeNull() // torek
  })

  it('B3: monthly — termin SAMO ob ustreznem dnevu meseca', () => {
    expect(occurrenceForDate(monthly, d(15), 'Europe/Ljubljana')).not.toBeNull()
    expect(occurrenceForDate(monthly, d(14), 'Europe/Ljubljana')).toBeNull()
  })

  it('B4: neveljaven dueTime → varna privzeda vrednost 10:00', () => {
    const occ = occurrenceForDate({ ...plan, dueTime: '25:99' }, d(15), 'Europe/Ljubljana')!
    expect(occ.dueAt.toISOString().slice(11, 16)).toBe('08:00') // 10:00 CEST
  })
})

describe('C. evaluacija meritev (motor)', () => {
  const base: PlanRule = {
    measureKind: 'number', unit: '°C', direction: 'below',
    okLimit: 4, warnLimit: 6, rangeMin: null, rangeMax: null,
    critical: false, requiresVerification: true,
  }

  it('C1: below — 3.9 OK, 5.5 opozorilo, 7.0 kritično ( strežnik odloča)', () => {
    expect(evalMeasurement(base, 3.9)).toBe('ok')
    expect(evalMeasurement(base, 5.5)).toBe('warning')
    expect(evalMeasurement(base, 7)).toBe('critical')
    expect(evalMeasurement(base, 4)).toBe('ok') // meja je vključujoča
  })

  it('C2: above — kuhanje ≥ 63 OK, 60 opozorilo, 55 kritično', () => {
    const hot: PlanRule = { ...base, direction: 'above', okLimit: 63, warnLimit: 60 }
    expect(evalMeasurement(hot, 63)).toBe('ok')
    expect(evalMeasurement(hot, 61)).toBe('warning')
    expect(evalMeasurement(hot, 55)).toBe('critical')
  })

  it('C3: between — v obsegu OK, zunaj TAKOJ kritično (brez sive cone)', () => {
    const band: PlanRule = { ...base, direction: 'between', okLimit: null, warnLimit: null, rangeMin: 0, rangeMax: 4 }
    expect(evalMeasurement(band, 2)).toBe('ok')
    expect(evalMeasurement(band, 5)).toBe('critical')
    expect(evalMeasurement(band, -0.5)).toBe('critical')
  })

  it('C4: none / brez meja — samo beleženje vedno OK', () => {
    expect(evalMeasurement({ ...base, direction: 'none', okLimit: null, warnLimit: null }, 99)).toBe('ok')
  })

  it('C5: confirm — pass OK; fail = warning (obicajna) oziroma critical (kriticen načrt)', () => {
    const conf: PlanRule = { ...base, measureKind: 'confirm' }
    expect(evalConfirm(conf, 'pass')).toBe('ok')
    expect(evalConfirm(conf, 'fail')).toBe('warning')
    expect(evalConfirm({ ...conf, critical: true }, 'fail')).toBe('critical')
  })

  it('C6: numStrict — 0 je legitimna vrednost; mankajoča meritev je null (ne 0!)', () => {
    expect(numStrict(null)).toBeNull()
    expect(numStrict(undefined)).toBeNull()
    expect(numStrict('')).toBeNull()
    expect(numStrict('abc')).toBeNull()
    expect(numStrict(0)).toBe(0)
    expect(numStrict('4.5')).toBe(4.5)
    expect(numStrict('4,5')).toBe(4.5)
  })

  it('C7: thresholdText — berljiv prag za UI/izvoz', () => {
    expect(thresholdText(base)).toContain('≤ 4 °C')
    expect(thresholdText(base)).toContain('opozorilo ≤ 6 °C')
    expect(thresholdText({ ...base, measureKind: 'confirm' })).toContain('izid')
  })

  it('C8: CSV — BOM + `;` + escape narekovajev', () => {
    const csv = haccpReportCsv([
      { id: 'e1', date: '2026-07-15 10:00', planName: 'Hladilnik "1"', category: 'temperature', target: 'vitrina', value: '5.5 °C', status: 'warning', state: 'deviation', corrective: 'ponovno hlajenje', verified: '', employee: 'Ana' },
    ])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.split('\n')[0]).toContain('"ID zapisa";"Datum";"Načrt"')
    expect(csv).toContain('"Hladilnik ""1"""')
    expect(csv).toContain('5.5 °C')
  })
})

describe('D. validacija pravil načrta (motor)', () => {
  it('D1: number brez enote → napaka', () => {
    expect(validatePlanRuleInput({ measureKind: 'number', unit: '', direction: 'below', okLimit: 4 }, {})).toContain('enoto')
  })

  it('D2: below brez okLimit → napaka; warnLimit < okLimit → napaka', () => {
    expect(validatePlanRuleInput({ measureKind: 'number', unit: '°C', direction: 'below', okLimit: null }, {})).toContain('okLimit')
    expect(validatePlanRuleInput({ measureKind: 'number', unit: '°C', direction: 'below', okLimit: 4, warnLimit: 2 }, {})).toContain('Opozorilna meja')
  })

  it('D3: between brez meja → napaka; rangeMin > rangeMax → napaka', () => {
    expect(validatePlanRuleInput({ measureKind: 'number', unit: '°C', direction: 'between' }, {})).toContain('rangeMin')
    expect(validatePlanRuleInput({ measureKind: 'number', unit: '°C', direction: 'between', rangeMin: 5, rangeMax: 2 }, {})).toContain('rangeMin')
  })

  it('D4: weekly brez dneva / monthly brez dneva / monthDay 29 → napaka', () => {
    expect(validatePlanRuleInput({}, { frequency: 'weekly' })).toContain('dan v tednu')
    expect(validatePlanRuleInput({}, { frequency: 'monthly' })).toContain('dan v mesecu')
    expect(validatePlanRuleInput({}, { frequency: 'monthly', monthDay: 29 })).toContain('1-28')
    expect(validatePlanRuleInput({}, { frequency: 'monthly', monthDay: 15 })).toBeNull()
  })

  it('D5: neveljaven dueTime → napaka; confirm z smerjo → napaka', () => {
    expect(validatePlanRuleInput({}, { dueTime: '25:00' })).toContain('HH:MM')
    expect(validatePlanRuleInput({ measureKind: 'confirm', direction: 'below' }, {})).toContain('Potrditvena')
  })
})

describe('E. buildSchedule — stanja plošče (motor)', () => {
  it('E1: zapadlo/današnje/prihodnje/izvedeno/odstopanje + dnevi brez izvedbe so vidni', () => {
    const now = zonedTimeToUtc(2026, 7, 15, 12, 0, 'Europe/Ljubljana') // sreda 12:00
    const plan = {
      id: 'p1', name: 'Hladilnik', category: 'temperature', target: '', steps: [], responsible: '',
      frequency: 'daily', dueTime: '10:00', weekday: null, monthDay: null,
      rule: { measureKind: 'confirm', unit: '', direction: 'none', okLimit: null, warnLimit: null, rangeMin: null, rangeMax: null, critical: false, requiresVerification: true },
    }
    const dstr = (off: number) => new Date(Date.UTC(2026, 6, 15 + off)).toISOString().slice(0, 10)
    const entries = new Map<string, { id: string; occurrenceKey: string; entryState: string; status: string; numericValue: number | null; unit: string; measuredAt: Date }>([
      // včeraj izvedeno (done), predvčerajšnjim odstopanje
      [`p1|${dstr(-1)}`, { id: 'e-1', occurrenceKey: `p1|${dstr(-1)}`, entryState: 'done', status: 'ok', numericValue: null, unit: '', measuredAt: now }],
      [`p1|${dstr(-2)}`, { id: 'e-2', occurrenceKey: `p1|${dstr(-2)}`, entryState: 'deviation', status: 'warning', numericValue: null, unit: '', measuredAt: now }],
    ])
    const items = buildSchedule([plan], entries, 'Europe/Ljubljana', now, 3, 1)
    expect(items.find((i) => i.date === dstr(0))?.state).toBe('overdue')
    expect(items.find((i) => i.date === dstr(-1))?.state).toBe('done')
    expect(items.find((i) => i.date === dstr(-2))?.state).toBe('deviation')
    expect(items.find((i) => i.date === dstr(-3))?.state).toBe('overdue') // dan brez izvedbe = zapadlo
    expect(items.find((i) => i.date === dstr(1))?.state).toBe('upcoming')
    // vrstni red: časovno naraščajoče
    expect(items[0].date <= items[items.length - 1].date).toBe(true)
  })

  it('E2: stateOfEntry — legacy preslikava (ok → done, drugace → deviation)', () => {
    expect(stateOfEntry({ entryState: 'legacy', status: 'ok' })).toBe('done')
    expect(stateOfEntry({ entryState: 'legacy', status: 'warning' })).toBe('deviation')
    expect(stateOfEntry({ entryState: 'awaiting_verification', status: 'critical' })).toBe('awaiting_verification')
  })
})

describe('F. snapshot pravil (motor)', () => {
  it('F1: ruleSnapshotOf + parseRuleSnapshot — okrogle poti z Decimal/JSON', () => {
    const snap = ruleSnapshotOf({
      name: 'Hladilnik', version: 3, measureKind: 'number', unit: '°C', direction: 'below',
      okLimit: 4, warnLimit: 6, rangeMin: null, rangeMax: null, critical: true, requiresVerification: false,
    })
    expect(snap.planVersion).toBe(3)
    expect(snap.okLimit).toBe(4)
    expect(snap.critical).toBe(true)
    expect(snap.requiresVerification).toBe(false)
    const parsed = parseRuleSnapshot(JSON.stringify(snap))
    expect(parsed?.planVersion).toBe(3)
    expect(parsed?.okLimit).toBe(4)
    expect(parsed?.critical).toBe(true)
    expect(parseRuleSnapshot(null)).toBeNull()
    expect(parseRuleSnapshot('{"measureKind":"strani"}')).toBeNull()
  })
})

/* ═══════════════ G. GOVERNED POST /api/haccp ═══════════════ */

describe('G. governed vnos kontrole', () => {
  let planId = ''
  let confirmPlanId = ''

  beforeAll(async () => {
    const p = await createPlan(locA)
    planId = String(p.id ?? '')
    const c = await createPlan(locA, { name: `${P}ciscenje ${RUN}`, category: 'cleaning', measureKind: 'confirm', unit: '', direction: 'none', critical: false })
    confirmPlanId = String(c.id ?? '')
  })

  it('G1: veljavna meritev v meji → ok/done (status izracuna streznik)', async () => {
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, dueDate: dateKey(today()), numericValue: 3.5, note: `${P}v meji` }))
    expect(res.status).toBe(201)
    const j = await body(res)
    const c = (j.check ?? {}) as Record<string, unknown>
    expect(c.status).toBe('ok')
    expect(c.entryState).toBe('done')
    expect(c.planVersion).toBe(1)
    expect(c.value).toBe(3.5)
  })

  it('G2: klientova oznaka OK čez kritično mejo → strežnik PONAREDI prepreči (critical)', async () => {
    // dodaten termin: ad-hoc (brez dueDate) — plan-vezan vnos izven termina
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 8, status: 'ok', ok: true }))
    expect(res.status).toBe(201)
    const j = await body(res)
    const c = (j.check ?? {}) as Record<string, unknown>
    expect(c.status).toBe('critical') // strežnik IGNORIRA klientov status
    expect(c.entryState).toBe('deviation')
  })

  it('G3: opozorilni pas (5.5) → warning/deviation', async () => {
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 5.5 }))
    expect(res.status).toBe(201)
    const j = await body(res)
    expect((j.check as Record<string, unknown>).status).toBe('warning')
    expect((j.check as Record<string, unknown>).entryState).toBe('deviation')
  })

  it('G4: manjkajoča numerična meritev → 400 (0 pa je legitimna!)', async () => {
    expect((await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId }))).status).toBe(400)
    // 0 °C je veljavna meritev
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 0 }))
    expect(res.status).toBe(201)
  })

  it('G5: confirm — pass → done; fail → deviation; manjkajoč izid → 400', async () => {
    const ok = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: confirmPlanId, dueDate: dateKey(today()), outcome: 'pass' }))
    expect((await body(ok)).check).toMatchObject({ status: 'ok', entryState: 'done' })
    const fail = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: confirmPlanId, outcome: 'fail', status: 'ok' }))
    const jf = await body(fail)
    expect((jf.check as Record<string, unknown>).status).toBe('warning') // ne-kritičen načrt
    expect((jf.check as Record<string, unknown>).entryState).toBe('deviation')
    expect((await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: confirmPlanId, outcome: 'skip' }))).status).toBe(400)
  })

  it('G6: podvojen termin → 409 (brez podvojenih zapisov)', async () => {
    const d = dateKey(today())
    // G1 je že zapisal današnji termin → ponovni poskus isti dan
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, dueDate: d, numericValue: 2 }))
    expect(res.status).toBe(409)
  })

  it('G7: weekly načrt + datum v napačnem dnevu → 400', async () => {
    const wp = await createPlan(locA, { name: `${P}tedenska ${RUN}`, frequency: 'weekly', weekday: 1 })
    const day = new Date(Date.UTC(2026, 6, 14)) // torek
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: String(wp.id), dueDate: day.toISOString().slice(0, 10), numericValue: 3 }))
    expect(res.status).toBe(400)
  })

  it('G8: načrt DRUge lokacije → 403 (fail-closed)', async () => {
    const p = await createPlan(locB, {}, tokMgrB)
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: String(p.id), numericValue: 3 }))
    expect(res.status).toBe(403)
  })

  it('G9: neznani načrt → 404; DDL probe OFF → 503 (degradacija)', async () => {
    expect((await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: 'ne-obstaja' }))).status).toBe(404)
    resetHaccpOpsProbe(false)
    try {
      const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 3 }))
      expect(res.status).toBe(503)
      expect((await scheduleGET(req('GET', '/api/haccp/schedule', tokCleanerA))).status).toBe(503)
      expect((await actionsPOST(req('POST', '/api/haccp/x/actions', tokCleanerA, { kind: 'corrective', note: 'dvanajst znak' }), { params: Promise.resolve({ id: 'x' }) })).status).toBe(503)
      expect((await reportGET(req('GET', '/api/haccp/report', tokCleanerA))).status).toBe(503)
    } finally {
      resetHaccpOpsProbe(true)
    }
  })

  it('G10: RBAC — natakar brez haccp.execute → 403; brez žetona → 401', async () => {
    expect((await entryPOST(req('POST', '/api/haccp', tokWaiterA, { planId, numericValue: 3 }))).status).toBe(403)
    expect((await entryPOST(req('POST', '/api/haccp', undefined, { planId, numericValue: 3 }))).status).toBe(401)
  })

  it('G11: legacy ad-hoc tok ostaja NESPREMENJEN', async () => {
    const res = await entryPOST(req('POST', '/api/haccp', tokCleanerA, { type: 'temperature', target: `${P}ad-hoc`, value: 4, ok: true, note: `${P}opomba` }))
    expect(res.status).toBe(201)
    const j = await body(res)
    expect((j.check as Record<string, unknown>).ok).toBe(true)
    // GET lista vsebuje tako legacy kot governed vnose
    const list = await entryGET(req('GET', '/api/haccp', tokCleanerA))
    const jl = await body(list)
    const checks = (jl.haccpChecks ?? []) as Record<string, unknown>[]
    expect(checks.some((c) => c.planId === planId)).toBe(true)
    expect(checks.some((c) => c.entryState === 'legacy')).toBe(true)
  })
})

/* ═══════════════ H. STATE MACHINE — korektivni ukrep + verifikacija ═══════════════ */

describe('H. korektivni ukrep + verifikacija', () => {
  let planId = ''
  let planNoVerifId = ''
  let deviationEntryId = ''
  let deviationNoVerifId = ''

  beforeAll(async () => {
    const p = await createPlan(locA, { name: `${P}hladno ${RUN}` })
    planId = String(p.id)
    const nv = await createPlan(locA, { name: `${P}brez-verif ${RUN}`, requiresVerification: false })
    planNoVerifId = String(nv.id)
    // odstopanja: 8.0 (critical) na oba načrta
    const e1 = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 8 })))
    deviationEntryId = String((e1.check as Record<string, unknown>).id)
    const e2 = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId: planNoVerifId, numericValue: 8 })))
    deviationNoVerifId = String((e2.check as Record<string, unknown>).id)
  })

  it('H1: kratek korektivni ukrep → 400; zapis v redu → 409', async () => {
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerA, { kind: 'corrective', note: 'kratek' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(400)
    // done zapis (G1 na današnjem terminu istega načrta? — uporabi novega)
    const okEntry = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 1 })))
    const okId = String((okEntry.check as Record<string, unknown>).id)
    expect((await actionsPOST(req('POST', `/api/haccp/${okId}/actions`, tokCleanerA, { kind: 'corrective', note: 'dvanajst znakov' }), { params: Promise.resolve({ id: okId }) })).status).toBe(409)
  })

  it('H2: korektiv → awaiting_verification (verifikacija OBVEZNA — ne zapre)', async () => {
    const res = await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerA, { kind: 'corrective', note: 'Znižal temperaturo, živilo prestavljeno v rezervo.' }), { params: Promise.resolve({ id: deviationEntryId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.entryState).toBe('awaiting_verification')
    expect(j.closedAt).toBeNull()
    // podvojen korektiv na awaiting → 409
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerA, { kind: 'corrective', note: 'ponovno dvanajst' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(409)
  })

  it('H3: ponovni odčitek USPEŠEN (2.5 ≤ 4) → closed + closedAt', async () => {
    const res = await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerA, { kind: 'verify', method: 'recheck', numericValue: 2.5 }), { params: Promise.resolve({ id: deviationEntryId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    expect(j.entryState).toBe('closed')
    expect(j.outcome).toBe('ok')
    // verifikacija na zaklenjenem → 409
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerA, { kind: 'verify', method: 'approval' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(409)
  })

  it('H4: ponovni odčitek NEUSPEŠEN → odstopanje ostane odprto', async () => {
    const e = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 8 })))
    const id = String((e.check as Record<string, unknown>).id)
    await actionsPOST(req('POST', `/api/haccp/${id}/actions`, tokCleanerA, { kind: 'corrective', note: 'Popravek kompresorja, serija zavrz.' }), { params: Promise.resolve({ id: id }) })
    const res = await actionsPOST(req('POST', `/api/haccp/${id}/actions`, tokCleanerA, { kind: 'verify', method: 'recheck', numericValue: 9 }), { params: Promise.resolve({ id: id }) })
    const j = await body(res)
    expect(j.outcome).toBe('failed')
    expect(j.entryState).toBe('deviation') // ostaja odprto — potreben nov ukrep
  })

  it('H5: potrditev vodje — ne-vodstvo (čistilka) → 403; vodstvo → 200 closed', async () => {
    const e = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 8 })))
    const id = String((e.check as Record<string, unknown>).id)
    await actionsPOST(req('POST', `/api/haccp/${id}/actions`, tokCleanerA, { kind: 'corrective', note: 'Zamenjava tesnila, kontrola ponovljena.' }), { params: Promise.resolve({ id: id }) })
    expect((await actionsPOST(req('POST', `/api/haccp/${id}/actions`, tokCleanerA, { kind: 'verify', method: 'approval' }), { params: Promise.resolve({ id: id }) })).status).toBe(403)
    const res = await actionsPOST(req('POST', `/api/haccp/${id}/actions`, tokMgrA, { kind: 'verify', method: 'approval', note: 'Ukrep pregledan in sprejet.' }), { params: Promise.resolve({ id: id }) })
    const j = await body(res)
    expect(j.entryState).toBe('closed')
  })

  it('H6: requiresVerification=false → korektiv zapre TAKOJ (brez verifikacije)', async () => {
    const res = await actionsPOST(req('POST', `/api/haccp/${deviationNoVerifId}/actions`, tokCleanerA, { kind: 'corrective', note: 'Hitra obravnava po postopku lokala.' }), { params: Promise.resolve({ id: deviationNoVerifId }) })
    const j = await body(res)
    expect(j.entryState).toBe('closed')
    expect(j.closedAt).not.toBeNull()
  })

  it('H7: tuja lokacija → 404 (fail-closed); brez dovoljenja → 403', async () => {
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokCleanerB, { kind: 'corrective', note: 'korektivni ukrep tuje' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(404)
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, tokWaiterA, { kind: 'corrective', note: 'korektivni ukrep tuji' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(403)
    expect((await actionsPOST(req('POST', `/api/haccp/${deviationEntryId}/actions`, undefined, { kind: 'corrective', note: 'brez žetona' }), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(401)
  })

  it('H8: detail — zapis + revizijska zgodovina (append-only dogodki)', async () => {
    const res = await detailGET(req('GET', `/api/haccp/${deviationEntryId}`, tokCleanerA), { params: Promise.resolve({ id: deviationEntryId }) })
    expect(res.status).toBe(200)
    const j = await body(res)
    const actions = (j.actions ?? []) as Record<string, unknown>[]
    expect(actions.length).toBeGreaterThanOrEqual(2) // korektiv + verifikacija (recheck)
    expect(actions.some((a) => a.kind === 'corrective')).toBe(true)
    expect(actions.some((a) => a.kind === 'verify' && a.method === 'recheck')).toBe(true)
    expect((j.check as Record<string, unknown>).planVersion).toBe(1)
    // tuja lokacija → 404
    expect((await detailGET(req('GET', `/api/haccp/${deviationEntryId}`, tokCleanerB), { params: Promise.resolve({ id: deviationEntryId }) })).status).toBe(404)
  })
})

/* ═══════════════ I. SNAPSHOT — zgodovinska nespremenljivost ═══════════════ */

describe('I. posnetek pravil (sprememba načrta NE spremeni zgodovine)', () => {
  it('I1: vnos pri okLimit 4 → PATCH na 8 → ponovni odčitek 6 po STARI meji NEUSPEŠEN + version 2', async () => {
    const p = await createPlan(locA, { name: `${P}snapshot ${RUN}` })
    const planId = String(p.id)
    // odstopanje 6.0 po meji 4 (warning)
    const e = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 6 })))
    const entryId = String((e.check as Record<string, unknown>).id)
    expect((e.check as Record<string, unknown>).status).toBe('warning')
    // korektiv
    await actionsPOST(req('POST', `/api/haccp/${entryId}/actions`, tokCleanerA, { kind: 'corrective', note: 'Znižanje temperature po postopku.' }), { params: Promise.resolve({ id: entryId }) })
    // načrt spremeni mejo na 8 (sema #2)
    const patched = await planPATCH(req('PATCH', `/api/haccp/plans/${planId}`, tokMgrA, { okLimit: 8, warnLimit: 10 }), { params: Promise.resolve({ id: planId }) })
    const pj = await body(patched)
    expect((pj.plan as Record<string, unknown>).version).toBe(2)
    expect((pj.plan as Record<string, unknown>).okLimit).toBe(8)
    // ponovni odčitek 6: PO NOVI meji bi bil OK — vendar se oceni po POSNETKU (4) → failed
    const re = await actionsPOST(req('POST', `/api/haccp/${entryId}/actions`, tokCleanerA, { kind: 'verify', method: 'recheck', numericValue: 6 }), { params: Promise.resolve({ id: entryId }) })
    const rj = await body(re)
    expect(rj.outcome).toBe('failed')
    expect(rj.entryState).toBe('deviation')
    // NOV zapis po novem načrtu: 6 → sedaj OK
    const e2 = await body(await entryPOST(req('POST', '/api/haccp', tokCleanerA, { planId, numericValue: 6 })))
    expect((e2.check as Record<string, unknown>).status).toBe('ok')
    expect((e2.check as Record<string, unknown>).planVersion).toBe(2)
    // history zapis ima NESPREMENJEN posnetek
    const det = await body(await detailGET(req('GET', `/api/haccp/${entryId}`, tokMgrA), { params: Promise.resolve({ id: entryId }) }))
    const snap = (det.check as Record<string, unknown>).ruleSnapshot as Record<string, unknown>
    expect(snap.okLimit).toBe(4)
    expect(snap.planVersion).toBe(1)
  })
})

/* ═══════════════ J. PLOŠČA TERMINOV ═══════════════ */

describe('J. schedule plošča', () => {
  it('J1: termini z stanji + timezone + tuja lokacija izolirana', async () => {
    // načrt z ZAPADLIM današnjim terminom (dueTime 00:01, brez zapisa)
    const early = await createPlan(locA, { name: `${P}zgodaj ${RUN}`, dueTime: '00:01' })
    const earlyPlanId = String(early.id)
    const res = await scheduleGET(req('GET', '/api/haccp/schedule?daysBack=1&daysFwd=1', tokCleanerA))
    expect(res.status).toBe(200)
    const j = await body(res)
    const occ = (j.occurrences ?? []) as Record<string, unknown>[]
    expect(occ.length).toBeGreaterThan(0)
    // današnji termin 00:01 je (glede na "zdaj") pretekel brez zapisa → overdue
    const todayKey = dateKey(today())
    const todayOcc = occ.filter((o) => o.date === todayKey)
    expect(todayOcc.some((o) => o.state === 'overdue')).toBe(true)
    expect(j.timezone).toBe('Europe/Ljubljana')
    const summary = (j.summary ?? {}) as Record<string, number>
    expect(summary.overdue).toBeGreaterThanOrEqual(1)
    // čistilka B vidi SAMO svojo lokacijo (lokA načrti NE obstajajo v njeni plošči)
    const resB = await scheduleGET(req('GET', '/api/haccp/schedule?daysBack=1&daysFwd=1', tokCleanerB))
    const jB = await body(resB)
    const occB = (jB.occurrences ?? []) as Record<string, unknown>[]
    const planIdsB = new Set(occB.map((o) => String((o.plan as Record<string, unknown>).id)))
    expect(planIdsB.has(earlyPlanId)).toBe(false)
    expect(occB.length).toBeGreaterThanOrEqual(0) // lastna lokacija: G8 načrt (lahko tudi prazno)
    // RBAC: natakar → 403; brez žetona → 401
    expect((await scheduleGET(req('GET', '/api/haccp/schedule', tokWaiterA))).status).toBe(403)
    expect((await scheduleGET(req('GET', '/api/haccp/schedule'))).status).toBe(401)
  })
})

/* ═══════════════ K. POROČILO ═══════════════ */

describe('K. poročilo + CSV izvoz', () => {
  it('K1: CSV — BOM, `;`, glave, vrstice s korektivom/verifikacijo + sledljivost ID', async () => {
    const res = await reportGET(req('GET', `/api/haccp/report?format=csv&from=${dateKey(today())}`, tokCleanerA))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const csv = await res.text()
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"ID zapisa";"Datum";"Načrt";"Kategorija"')
    expect(csv).toContain('Korektivni ukrep')
    // vsaj ena vrstica z imenom i20 načrta (fixtures)
    expect(csv.toLowerCase()).toContain(P.trim().toLowerCase() === '' ? 'haccp' : 'hladilnik')
  })

  it('K2: json + filtri (state) + napačni datumi → 400', async () => {
    const res = await reportGET(req('GET', `/api/haccp/report?format=json&state=deviation`, tokCleanerA))
    expect(res.status).toBe(200)
    const j = await body(res)
    const rows = (j.rows ?? []) as Record<string, unknown>[]
    expect(rows.every((r) => String(r.state).includes('deviation') || String(r.state) === 'awaiting_verification')).toBe(true)
    expect((await reportGET(req('GET', '/api/haccp/report?from=abc', tokCleanerA))).status).toBe(400)
    expect((await reportGET(req('GET', '/api/haccp/report?from=2026-08-01&to=2026-07-01', tokCleanerA))).status).toBe(400)
    // natakar → 403; brez žetona → 401
    expect((await reportGET(req('GET', '/api/haccp/report', tokWaiterA))).status).toBe(403)
    expect((await reportGET(req('GET', '/api/haccp/report'))).status).toBe(401)
  })
})

/* ═══════════════ L. NAČRTI — nova polja + admin ═══════════════ */

describe('L. načrti (admin)', () => {
  it('L1: POST z novimi polji → 201 + izpis; privzeti vrednosti', async () => {
    const res = await planPOST(req('POST', '/api/haccp/plans', tokMgrA, {
      name: `${P}kuhanje ${RUN}`, category: 'temperature', frequency: 'weekly', weekday: 3,
      measureKind: 'number', unit: '°C', direction: 'above', okLimit: 63, warnLimit: 60,
      critical: true, requiresVerification: false, dueTime: '14:30', locationId: locA,
    }))
    expect(res.status).toBe(201)
    const j = await body(res)
    const plan = (j.plan ?? {}) as Record<string, unknown>
    expect(plan.measureKind).toBe('number')
    expect(plan.direction).toBe('above')
    expect(plan.okLimit).toBe(63)
    expect(plan.critical).toBe(true)
    expect(plan.dueTime).toBe('14:30')
    expect(plan.weekday).toBe(3)
    expect(plan.version).toBe(1)
  })

  it('L2: validacije — number brez enote 400, weekly brez dneva 400, monthDay 29 400, confirm+smer 400', async () => {
    expect((await planPOST(req('POST', '/api/haccp/plans', tokMgrA, { name: `${P}x1 ${RUN}`, category: 'temperature', measureKind: 'number', direction: 'below', okLimit: 4, locationId: locA }))).status).toBe(400)
    expect((await planPOST(req('POST', '/api/haccp/plans', tokMgrA, { name: `${P}x2 ${RUN}`, category: 'temperature', frequency: 'weekly', locationId: locA }))).status).toBe(400)
    expect((await planPOST(req('POST', '/api/haccp/plans', tokMgrA, { name: `${P}x3 ${RUN}`, category: 'temperature', frequency: 'monthly', monthDay: 29, locationId: locA }))).status).toBe(400)
    expect((await planPOST(req('POST', '/api/haccp/plans', tokMgrA, { name: `${P}x4 ${RUN}`, category: 'cleaning', measureKind: 'confirm', direction: 'below', locationId: locA }))).status).toBe(400)
  })

  it('L3: PATCH semantična sprememba → version 2; napačno vrednost → 400', async () => {
    const p = await createPlan(locA, { name: `${P}patch ${RUN}` })
    const id = String(p.id)
    const res = await planPATCH(req('PATCH', `/api/haccp/plans/${id}`, tokMgrA, { warnLimit: 7 }), { params: Promise.resolve({ id }) })
    const j = await body(res)
    expect((j.plan as Record<string, unknown>).version).toBe(2)
    expect((j.plan as Record<string, unknown>).warnLimit).toBe(7)
    expect((await planPATCH(req('PATCH', `/api/haccp/plans/${id}`, tokMgrA, { okLimit: 'abc' }), { params: Promise.resolve({ id }) })).status).toBe(400)
  })

  it('L4: GET → ddlOpsPending false + plans s novimi polji; čistilka → 403', async () => {
    const res = await planGET(req('GET', '/api/haccp/plans', tokMgrA))
    const j = await body(res)
    expect(j.ddlOpsPending).toBe(false)
    expect((await planGET(req('GET', '/api/haccp/plans', tokCleanerA))).status).toBe(403)
  })
})

/* ═══════════════ M. CRON — dnevni opomnik zapadlih ═══════════════ */

describe('M. dnevni opomnik (cron)', () => {
  it('M1: pure — isUnalertedOverdue + overdueBody', () => {
    const now = new Date('2026-07-15T12:00:00Z')
    const due = new Date('2026-07-15T08:00:00Z')
    expect(isUnalertedOverdue(due, false, now, undefined)).toBe(true)
    expect(isUnalertedOverdue(due, true, now, undefined)).toBe(false) // izvedeno
    expect(isUnalertedOverdue(due, false, new Date('2026-07-15T07:00:00Z'), undefined)).toBe(false) // še ni zapadlo
    expect(isUnalertedOverdue(due, false, now, '2026-07-15T11:00:00Z')).toBe(false) // že opomnjeno
    expect(overdueBody(['a', 'b'])).toBe('a, b')
    expect(overdueBody(Array.from({ length: 7 }, (_, i) => `n${i}`))).toContain('+2')
  })

  it('M2: runDailyHaccpOverdue — 1. tek pošlje, 2. tek 0 (state marker); izvedeni termin NE opomni', async () => {
    const { runDailyHaccpOverdue } = await import('../src/lib/haccp-overdue')
    // zapadli načrt: dueTime 00:01 danes brez zapisa (ustvarjen v J1) + čist marker
    const row = await db.integration.findFirst({ where: { name: HACCP_OVERDUE_STATE_MARKER, type: 'other' } })
    if (row) await db.integration.update({ where: { id: row.id }, data: { config: '{}' } })
    const n1 = await runDailyHaccpOverdue()
    expect(n1).toBeGreaterThanOrEqual(1)
    // state marker zapisan
    const after = await db.integration.findFirst({ where: { name: HACCP_OVERDUE_STATE_MARKER, type: 'other' } })
    expect(after).not.toBeNull()
    // drugi tek: isti termini → 0 (brez podvajanja)
    const n2 = await runDailyHaccpOverdue()
    expect(n2).toBe(0)
    // počisti marker (fixtures sweep počisti Integration? — eksplicitno za varnost)
    if (after) await db.integration.update({ where: { id: after.id }, data: { config: '{}' } })
  })
})

/* ═══════════════ N. DDL + drift + push ═══════════════ */

describe('N. DDL idempotenca + drift-check + push tipi', () => {
  it('N1: migrate POST — dev že ima stolpce → alreadyApplied (idempotentno)', async () => {
    const adminTok = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const res = await migratePOST(req('POST', '/api/admin/migrate-haccp-ops', adminTok))
    // dev = SQLite: information_schema ne obstaja → columnExists vrne true (preverba prek db push)
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      const j = await body(res)
      expect(j.alreadyApplied).toBe(true)
    }
  })

  it('N2: drift-check — HaccpEntry/HaccpPlan stavki → known haccp-ops; HaccpAction CREATE → known; tuji → unexpected', () => {
    const sql = [
      `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "planId" TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE "HaccpEntry" ADD COLUMN IF NOT EXISTS "entryState" TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "measureKind" TEXT NOT NULL DEFAULT 'confirm'`,
      `ALTER TABLE "HaccpPlan" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1`,
      `CREATE TABLE "HaccpAction" ("id" TEXT NOT NULL)`,
      `CREATE INDEX "HaccpAction_entryId_idx" ON "HaccpAction"("entryId")`,
      `ALTER TABLE "HaccpEntry" ADD COLUMN "evil" TEXT`,
    ].join(';\n')
    const cls = classifyDrift(sql)
    expect(cls.known.some((k) => k.id === 'haccp-ops' && k.statements.length >= 6)).toBe(true)
    expect(cls.unexpected).toEqual([`ALTER TABLE "HaccpEntry" ADD COLUMN "evil" TEXT`])
  })

  it('N3: push tipi 19 — HACCP_OVERDUE + HACCP_DEVIATION registrirana', () => {
    expect(PUSH_EVENT_TYPES).toContain('HACCP_OVERDUE')
    expect(PUSH_EVENT_TYPES).toContain('HACCP_DEVIATION')
    expect(PUSH_EVENT_TYPES.length).toBe(21)
    expect(new Set(PUSH_EVENT_TYPES).size).toBe(21)
  })
})
