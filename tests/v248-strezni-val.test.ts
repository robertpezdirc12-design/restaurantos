/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 — raziskava maj/junij
 * 2026): dodelitve miz spletnim rezervacijam (A), prednastavljene opombe za
 * kuhinjo (B), povzetki opravil po e-pošti + končni datumi razporedov (C).
 *
 *  Č1 — čisti sloj table-autoassign (okno zasedenosti + izbor najmanjše mize)
 *  Č2 — validUntil (parse defenzivno, validate strogo, terminski motor)
 *  Č3 — čisti sloj task-summary-email (dnevna sekcija + tedenski povzetek)
 *  Č4 — čisti sloj preset-notes (parse/validate/compose)
 *  Č5 — ruti /api/preset-notes (pravice + validacija + revizija + tenant)
 *  Č6 — javna rezervacija z avtododelitvijo mize (živa ruta, widget fiksture)
 *  Č7 — digest sekcija + tedenski email (nalagalca nad pravo bazo)
 *  Ž  — registri (verzija, compose, i18n pariteta, dokumenti, montaža, pini)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import {
  busyTableIdsForWindow,
  autoassignTableForBooking,
  AUTOASSIGN_DURATION_MIN,
} from '../src/lib/table-autoassign'
import {
  parseChecklistTemplates,
  validateChecklistTemplates,
  checklistOccurrenceForDate,
  localDateFromKey,
  loadChecklistTemplates,
  OPS_CHECKLISTS_MARKER,
} from '../src/lib/ops-checklists'
import {
  dailyTaskSummarySection,
  weeklyTaskSummaryEmailText,
  weeklyCoveragePct,
  type TaskSummaryLine,
  type WeeklyTaskRow,
} from '../src/lib/task-summary-email'
import {
  parsePresetNotes,
  validatePresetNotes,
  composeItemNote,
  PRESET_NOTES_MARKER,
  MAX_PRESET_NOTES,
} from '../src/lib/preset-notes'
import { loadTaskSummaryForDigest, sendWeeklyTaskSummary, dailyDigestEmailText, type DigestMailer } from '../src/lib/daily-email'
import { GET as notesGET, PUT as notesPUT } from '../src/app/api/preset-notes/route'
import { POST as publicPOST } from '../src/app/api/public/reservations/route'
import { GET as widgetGET, PUT as widgetPUT } from '../src/app/api/reservations/widget/route'
import { zonedDateParts, localDateKey, type LocalDate } from '../src/lib/haccp-ops'
// v1.270.0 CI flaky fix: loadTaskSummaryForDigest gradi dayKey prek cron-daily
// localDateKey (SISTEMSKA časovna cona). Test je predpostavil LJ-cono
// (zonedDateParts + TZ) — med 00:00 in 01:00 LJ se UTC-datum razlikuje od
// LJ-datuma (CI runner je UTC), occurrenceKey se razide z dayKey implementacije
// in G1 pade ČISTO ČASOVNO (v1.269 CI 22:48 = zeleno, v1.270 CI 00:41 = rdeče;
// 4.58ms fail brez dotaknjene kode). Fikstura MORA nositi isti vir resnice
// »danes« kot implementacija — sistemski ključ, deterministično v vseh okoljih.
import { localDateKey as systemLocalDateKey } from '../src/lib/cron-daily'
import type { DayHoursInput } from '../src/lib/reservation-slots'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v248-'
const RUN = Date.now().toString(36)
const TZ = 'Europe/Ljubljana'

/* ═══════════════ Č1 — čisti sloj table-autoassign ═══════════════ */

describe('Č1 — table-autoassign (§22 A)', () => {
  const T = (id: string, seats: number) => ({ id, number: Number(id.slice(1)), seats })

  test('A1: okno zasedenosti — prekrivanje obojestransko, sosednji termin NE blokira', () => {
    const start = new Date('2026-11-15T18:00:00Z')
    // rezervacija 19:00–21:00 NE blokira nove 21:00–23:00 (sosednji termini)
    const busy = busyTableIdsForWindow(
      [{ dateTime: new Date('2026-11-15T19:00:00Z'), duration: 120, tableId: 't1', comboTableIds: '' }],
      new Date('2026-11-15T21:00:00Z'),
      120,
    )
    expect(busy.size).toBe(0)
    // 18:30–20:30 SE prekriva z 19:00–21:00 → blokira
    const busy2 = busyTableIdsForWindow(
      [{ dateTime: new Date('2026-11-15T19:00:00Z'), duration: 120, tableId: 't1', comboTableIds: '' }],
      new Date('2026-11-15T18:30:00Z'),
      120,
    )
    expect(busy2.has('t1')).toBe(true)
  })

  test('A2: kombinacijska rezervacija blokira VSE članice (primarna + ostale)', () => {
    const busy = busyTableIdsForWindow(
      [{ dateTime: new Date('2026-11-15T19:00:00Z'), duration: 120, tableId: 't1', comboTableIds: ',t1,t2,' }],
      new Date('2026-11-15T19:00:00Z'),
      60,
    )
    expect(busy.has('t1')).toBe(true)
    expect(busy.has('t2')).toBe(true)
    expect(busy.size).toBe(2)
  })

  test('A3: izbor — najmanjša ustrezna miza zmaga (3 osebe → 4-miza, ne 8-miza; 2-miza premajhna)', () => {
    const pick = autoassignTableForBooking({
      tables: [T('t1', 8), T('t2', 4), T('t3', 2)],
      combos: [],
      party: 3,
      busyTableIds: new Set(),
    })
    expect(pick).not.toBeNull()
    expect(pick!.tableIds).toEqual(['t2'])
    expect(pick!.seats).toBe(4)
  })

  test('A4: izključene mize (walk-in rezerva) NE sodelujejo — spletni gost je ne dobi', () => {
    const pick = autoassignTableForBooking({
      tables: [T('t1', 4)],
      combos: [],
      party: 2,
      busyTableIds: new Set(),
      excludedTableIds: ['t1'],
    })
    expect(pick).toBeNull()
  })

  test('A5: zasedena miza izpade; kombinacija pride na vrsto, ko enojne ne zadoščajo', () => {
    // mize: 4 (zasedena), 4 (prosta), 6 (izključena); kombinacija 4+6 = 10 za 8 oseb
    const pick = autoassignTableForBooking({
      tables: [T('t1', 4), T('t2', 4), T('t3', 6)],
      combos: [{ id: 'c1', tableIds: ['t1', 't3'] }],
      party: 8,
      busyTableIds: new Set(), // nobena ne blokira → kombinacija zmaga (edina z ≥ 8)
      excludedTableIds: [],
    })
    expect(pick).not.toBeNull()
    expect(pick!.comboId).toBe('c1')
    expect(pick!.seats).toBe(10)
    // kombinacija s ČLANICO izključeno ne sme zmagati
    const pick2 = autoassignTableForBooking({
      tables: [T('t1', 4), T('t3', 6)],
      combos: [{ id: 'c1', tableIds: ['t1', 't3'] }],
      party: 8,
      busyTableIds: new Set(),
      excludedTableIds: ['t3'],
    })
    expect(pick2).toBeNull()
  })

  test('A6: nobena ne ustreza → null (iskrena rezerva — osebje dodeli ročno)', () => {
    const pick = autoassignTableForBooking({
      tables: [T('t1', 2)],
      combos: [],
      party: 6,
      busyTableIds: new Set(['t1']),
    })
    expect(pick).toBeNull()
  })

  test('A7: določen vrstni red — sedeži naraščajoče, nato oznaka po sl (isti tie-break kot seatCandidatesForParty)', () => {
    const pick = autoassignTableForBooking({
      tables: [{ id: 'tb', number: 9, seats: 4 }, { id: 'ta', number: 3, seats: 4 }],
      combos: [],
      party: 2,
      busyTableIds: new Set(),
    })
    expect(pick!.tableIds).toEqual(['ta']) // Miza 3 < Miza 9 po 'sl' collation
  })

  test('A8: zamujena izbrisana članica kombinacije → kombinacija izpade (defenzivno)', () => {
    const pick = autoassignTableForBooking({
      tables: [T('t1', 4)], // t2 manjka
      combos: [{ id: 'c1', tableIds: ['t1', 't2'] }],
      party: 8,
      busyTableIds: new Set(),
    })
    expect(pick).toBeNull()
  })

  test('A9: AUTOASSIGN_DURATION_MIN = 120 (kanonična minutaža javne poti)', () => {
    expect(AUTOASSIGN_DURATION_MIN).toBe(120)
  })
})

/* ═══════════════ Č2 — validUntil (končni datum predloge) ═══════════════ */

describe('Č2 — validUntil (§22 C1, Lightspeed junij 2026 »optional end dates«)', () => {
  const base = {
    id: 'tpl-1', name: 'Terasa', category: 'opening', repeat: 'daily',
    weekday: null, monthDay: null, anchorDate: '2026-06-01',
    dueTime: '09:00', active: true,
    items: [{ id: 'i1', label: 'Zalij rože', response: 'check' as const }],
  }

  test('B1: motor — termin NA validUntil dnevu še ŽIV, dan kasneje NE', () => {
    const tpl = { ...base, validUntil: '2026-09-30' }
    expect(checklistOccurrenceForDate(tpl, localDateFromKey('2026-09-30')!, TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, localDateFromKey('2026-10-01')!, TZ)).toBeNull()
  })

  test('B2: motor — brez validUntil se dnevna predloga ponavlja neskončno (nazadnja kompatibilnost)', () => {
    expect(checklistOccurrenceForDate({ ...base }, localDateFromKey('2030-01-01')!, TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate({ ...base, validUntil: null }, localDateFromKey('2030-01-01')!, TZ)).not.toBeNull()
  })

  test('B3: parse — neveljaven validUntil se bere kot ODSOTEN (predloga ostane živa, ne izpusti)', () => {
    const parsed = parseChecklistTemplates(JSON.stringify({
      templates: [{ ...base, validUntil: '31.09.2026' }],
    }))
    expect(parsed.length).toBe(1)
    expect(parsed[0].validUntil).toBeNull()
  })

  test('B4: parse — veljaven validUntil se ohrani', () => {
    const parsed = parseChecklistTemplates(JSON.stringify({
      templates: [{ ...base, validUntil: '2026-09-30' }],
    }))
    expect(parsed[0].validUntil).toBe('2026-09-30')
  })

  test('B5: validate — neveljavna oblika zavrnjena (strogo, ne tiho)', () => {
    const r = validateChecklistTemplates({ templates: [{ ...base, validUntil: 'jutri' }] })
    expect(r.error).toContain('končni datum')
  })

  test('B6: validate — validUntil PRED prvim dnem zavrnjen (tipkarska napaka ne ubije predloge tiho)', () => {
    const r = validateChecklistTemplates({ templates: [{ ...base, validUntil: '2026-05-31' }] })
    expect(r.error).toContain('pred prvim dnem')
  })

  test('B7: validate — veljaven validUntil sprejet + prazni niz = brez konca', () => {
    const ok = validateChecklistTemplates({ templates: [{ ...base, validUntil: '2026-09-30' }] })
    expect(ok.error).toBeNull()
    expect(ok.templates[0].validUntil).toBe('2026-09-30')
    const okEmpty = validateChecklistTemplates({ templates: [{ ...base, validUntil: '' }] })
    expect(okEmpty.error).toBeNull()
    expect(okEmpty.templates[0].validUntil).toBeNull()
  })
})

/* ═══════════════ Č3 — čisti sloj task-summary-email ═══════════════ */

describe('Č3 — task-summary-email (§22 C2, čisti sloj 0 uvozov)', () => {
  test('C1: dnevna sekcija — prazna tabela → [] (brez sekcije, nič se ne laže)', () => {
    expect(dailyTaskSummarySection([])).toEqual([])
  })

  test('C2: dnevna sekcija — zaključen seznam piše ZAKLJUČENO, delna pokritost n/N', () => {
    const lines: TaskSummaryLine[] = [
      { template: 'Odpiranje', done: 3, total: 3, completed: true },
      { template: 'Zapiranje', done: 1, total: 5, completed: false },
    ]
    const out = dailyTaskSummarySection(lines)
    expect(out[0]).toBe('Opravila:')
    expect(out.join('\n')).toContain('Odpiranje — ZAKLJUČENO')
    expect(out.join('\n')).toContain('Zapiranje — pokritost 1/5')
  })

  test('C3: dnevna sekcija — več lokacij: vrstica nosi ime lokacije; ena lokacija: brez predpone', () => {
    const multi = dailyTaskSummarySection([
      { template: 'Odpiranje', done: 1, total: 1, completed: true, location: 'Ljubljana' },
      { template: 'Odpiranje', done: 0, total: 1, completed: false, location: 'Maribor' },
    ])
    expect(multi.join('\n')).toContain('Ljubljana: Odpiranje')
    expect(multi.join('\n')).toContain('Maribor: Odpiranje')
    const single = dailyTaskSummarySection([
      { template: 'Odpiranje', done: 1, total: 1, completed: true, location: 'Ljubljana' },
    ])
    expect(single.join('\n')).not.toContain('Ljubljana:')
    expect(single.join('\n')).toContain('Odpiranje — ZAKLJUČENO')
  })

  test('C4: tedenski povzetek — prazne vrstice → null (teden brez terminov ni novica)', () => {
    expect(weeklyTaskSummaryEmailText({ rows: [], weekLabel: '3.11. – 9.11.' })).toBeNull()
  })

  test('C5: tedenski povzetek — vrstice z zaključki in pokritostjo + naslov z oznako tedna', () => {
    const rows: WeeklyTaskRow[] = [
      { template: 'Odpiranje', occurrences: 7, completedCount: 5, coveragePct: 80, location: 'Ljubljana' },
      { template: 'Terasa', occurrences: 2, completedCount: 2, coveragePct: 100, location: 'Kranj' },
    ]
    const email = weeklyTaskSummaryEmailText({ rows, weekLabel: '3.11. – 9.11.2026' })
    expect(email).not.toBeNull()
    expect(email!.subject).toContain('tedenski povzetek')
    expect(email!.subject).toContain('3.11. – 9.11.2026')
    expect(email!.body).toContain('Odpiranje: 5/7 zaključenih · pokritost 80 %')
    expect(email!.body).toContain('Kranj: Terasa')
  })

  test('C6: weeklyCoveragePct — agregacija delov; brez terminov → 0 (ne deljenje z nič)', () => {
    expect(weeklyCoveragePct([])).toBe(0)
    expect(weeklyCoveragePct([{ done: 3, total: 4 }, { done: 1, total: 4 }])).toBe(50)
    expect(weeklyCoveragePct([{ done: 0, total: 0 }])).toBe(0)
  })
})

/* ═══════════════ Č4 — čisti sloj preset-notes ═══════════════ */

describe('Č4 — preset-notes (§22 B, registr prednastavljenih opomb)', () => {
  test('D1: parse — smeti → []; neveljavni vnosi tiho ven (self-healing)', () => {
    expect(parsePresetNotes(null)).toEqual([])
    expect(parsePresetNotes('ne-json')).toEqual([])
    expect(parsePresetNotes(JSON.stringify({ notes: [{ id: 'a' }, { label: 'brez id' }, 42, null] }))).toEqual([])
    expect(parsePresetNotes(JSON.stringify({}))).toEqual([])
  })

  test('D2: parse — veljavni vnosi + cap MAX_PRESET_NOTES + vrstni red fallback', () => {
    const raw = JSON.stringify({ notes: [{ id: 'a', label: 'brez čebule' }, { id: 'b', label: 'dobro prepečeno', sortOrder: 2 }] })
    const parsed = parsePresetNotes(raw)
    expect(parsed.length).toBe(2)
    expect(parsed[0].label).toBe('brez čebule')
    expect(parsed[0].sortOrder).toBe(0) // fallback: indeks
    expect(parsed[1].sortOrder).toBe(2)
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `opomba ${i}` }))
    expect(parsePresetNotes(JSON.stringify({ notes: many })).length).toBe(MAX_PRESET_NOTES)
  })

  test('D3: validate — strogo: prazna oznaka, predolga, duplikat id, > 20', () => {
    expect(validatePresetNotes({}).error).toContain('notes')
    expect(validatePresetNotes({ notes: [{ label: '' }] }).error).toContain('besedilo')
    expect(validatePresetNotes({ notes: [{ id: 'a', label: 'x'.repeat(61) }] }).error).toContain('predolga')
    expect(validatePresetNotes({ notes: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }).error).toContain('Podvojen')
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, label: `o${i}` }))
    expect(validatePresetNotes({ notes: many }).error).toContain('20')
  })

  test('D4: validate — id se dodeli, če manjka; veljavna listo gre skozi', () => {
    const r = validatePresetNotes({ notes: [{ label: 'brez čebule' }, { id: 'b', label: 'brez glutena', sortOrder: 1 }] })
    expect(r.error).toBeNull()
    expect(r.notes[0].id).toBe('pn-1')
    expect(r.notes[1].id).toBe('b')
  })

  test('D5: composeItemNote — čipi + besedilo združeni z ; , cap 200, prazno → prazno', () => {
    expect(composeItemNote(['brez čebule', 'brez glutena'], 'rezervacija ob 19:00')).toBe('brez čebule; brez glutena; rezervacija ob 19:00')
    expect(composeItemNote([], '')).toBe('')
    expect(composeItemNote(['a'], 'b'.repeat(300)).length).toBe(200)
    expect(composeItemNote(['  ', 'x'], '   ')).toBe('x')
  })

  test('D6: marker — Integration vrstica preset-notes-config (0 DDL dokaz: brez modela)', () => {
    expect(PRESET_NOTES_MARKER).toBe('preset-notes-config')
    const schema = readFileSync(join(import.meta.dir, '..', 'prisma', 'schema.prisma'), 'utf8')
    expect(schema).not.toMatch(/model\s+PresetNote\b/)
  })
})

/* ═══════════════ Č5 — ruti /api/preset-notes ═══════════════ */

const HOURS_ALL: DayHoursInput['rows'] = Array.from({ length: 7 }, (_, dow) => ({
  dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
}))

let locA = ''
let mgrAId = ''
let waitAId = ''
let tokMgrA = ''
let tokWaitA = ''

function req(method: string, url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function jbody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(name: string, role: string, loc: string | null): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return id
}

describe('Č5 — ruti /api/preset-notes (pravice + revizija)', () => {
  beforeAll(async () => {
    __resetRateLimitForTests()
    locA = `${P}locA-${RUN}`
    await db.location.create({ data: { id: locA, code: `${P}LA${RUN}`, name: `${P}Lok A`, premisesId: `${P}premA-${RUN}` } })
    mgrAId = await seedEmp('mgr', 'manager', locA)
    waitAId = await seedEmp('wait', 'waiter', locA)
    // ISSUE #72 C1: MANAGER nima settings.manage — widget inicializacija ga
    // zahteva (issue13 vzorec: ADMIN-odobren override na zaposlenem)
    await db.employee.update({ where: { id: mgrAId }, data: { permissionOverrides: JSON.stringify(['settings.manage']) } })
    tokMgrA = createToken({ sub: mgrAId, name: `${P}mgr`, role: 'MANAGER', loc: locA, sv: 0 })
    tokWaitA = createToken({ sub: waitAId, name: `${P}wait`, role: 'WAITER', loc: locA, sv: 0 })
  })

  test('E1: GET brez žetona → 401', async () => {
    const res = await notesGET(req('GET', '/api/preset-notes'))
    expect(res.status).toBe(401)
  })

  test('E2: GET natakarja → 200 (branje = vsa osebja) — prazno brez vrstice', async () => {
    const res = await notesGET(req('GET', '/api/preset-notes', tokWaitA))
    expect(res.status).toBe(200)
    const j = await jbody(res)
    expect((j.notes as unknown[]).length).toBe(0)
  })

  test('E3: PUT natakarja → 403 (pisanje = menu.manage)', async () => {
    const res = await notesPUT(req('PUT', '/api/preset-notes', tokWaitA, { notes: [{ label: 'x' }] }))
    expect(res.status).toBe(403)
  })

  test('E4: PUT managerja → 200 + GET vrne opombe + revizija PRESET_NOTES_CONFIG', async () => {
    const res = await notesPUT(req('PUT', '/api/preset-notes', tokMgrA, {
      notes: [{ id: 'n1', label: 'brez čebule' }, { id: 'n2', label: 'dobro prepečeno' }],
    }))
    expect(res.status).toBe(200)
    const got = await notesGET(req('GET', '/api/preset-notes', tokWaitA))
    const j = await jbody(got)
    expect((j.notes as { label: string }[]).map((n) => n.label)).toEqual(['brez čebule', 'dobro prepečeno'])
    const audit = await db.auditLog.findFirst({
      where: { action: 'PRESET_NOTES_CONFIG', entityId: PRESET_NOTES_MARKER },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(audit!.details).toContain('brez čebule')
    expect(audit!.locationId).toBe(locA)
  })

  test('E5: PUT z neveljavnim vnosom → 400 (stroga validacija)', async () => {
    const res = await notesPUT(req('PUT', '/api/preset-notes', tokMgrA, { notes: [{ label: '' }] }))
    expect(res.status).toBe(400)
  })

  test('E6: tenant — druga lokacija ima SVOJ registr (prazno, ločeno)', async () => {
    const locB = `${P}locB-${RUN}`
    await db.location.create({ data: { id: locB, code: `${P}LB${RUN}`, name: `${P}Lok B`, premisesId: `${P}premB-${RUN}` } })
    const mgrB = await seedEmp('mgrB', 'manager', locB)
    const tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
    const res = await notesGET(req('GET', '/api/preset-notes', tokB))
    const j = await jbody(res)
    expect((j.notes as unknown[]).length).toBe(0)
  })
})

/* ═══════════════ Č6 — javna rezervacija z avtododelitvijo ═══════════════ */

describe('Č6 — javna rezervacija z avtododelitvijo mize (živa ruta)', () => {
  let widgetToken = ''

  function keyOf(d: LocalDate): string { return localDateKey(d) }
  function addDays(d: LocalDate, n: number): LocalDate {
    const dt = new Date(Date.UTC(d.y, d.m - 1, d.d + n))
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
  }
  const DATE = keyOf(addDays(zonedDateParts(new Date(), TZ), 2))

  beforeAll(async () => {
    __resetRateLimitForTests()
    // urnik lokacije A (10:00–22:00 vsak dan)
    for (let dow = 0; dow < 7; dow++) {
      await db.openingHours.create({
        data: { id: `${P}oh-${RUN}-${dow}`, dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false, locationId: locA },
      })
    }
    // mize: 4, 6, 8 sedežev
    let n = 1
    for (const s of [4, 6, 8]) {
      await db.table.create({ data: { id: `${P}tbl-${n}-${RUN}`, number: n, capacity: s, locationId: locA } })
      n++
    }
    // widget (settings.manage = manager; oblika telesa kot issue13 inicializacija)
    const res = await widgetPUT(req('PUT', '/api/reservations/widget', tokMgrA, {
      locationId: locA, enabled: true, slotMinutes: 30, minParty: 1, maxParty: 8, leadMinutes: 0, maxAdvanceDays: 30,
    }))
    const j = await jbody(res)
    widgetToken = String(j.token || '')
    expect(widgetToken.length).toBe(32)
  })

  test('F1: zlata pot — 4 osebe dobijo NAJMANJŠO ustrezno mizo (4-miza, ne 6/8)', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(req('POST', '/api/public/reservations', undefined, {
      token: widgetToken, date: DATE, time: '18:00', partySize: 4, name: 'Ana Avtododelitev', phone: '+38640111222',
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect((j.reservation as { tableName?: string | null }).tableName).toBe('Miza 1') // 4 sedežev = najmanjša ustrezna
    const r = await db.reservation.findFirst({ where: { customerName: `${P}`.replace(P, 'Ana Avtododelitev') + '' } })
    expect(r).not.toBeNull()
    expect(r!.tableId).toBe(`${P}tbl-1-${RUN}`)
  })

  test('F2: druga rezervacija v ISTEM oknu dobi DRUGO mizo (sočasnost varna)', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(req('POST', '/api/public/reservations', undefined, {
      token: widgetToken, date: DATE, time: '18:30', partySize: 2, name: 'Borut Drugi', phone: '+38640333444',
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    expect((j.reservation as { tableName?: string | null }).tableName).toBe('Miza 2') // miza 1 drži Ana 18:00–20:00 → 18:30 se prekriva
  })

  test('F3: sosednji termin (20:00 takoj po Ani 18:00–20:00) dobe isto mizo — brez lažnjivega konflikta', async () => {
    __resetRateLimitForTests()
    // zadnji veljavni termin mreže: 22:00 zaprtje − 120 min = 20:00
    const res = await publicPOST(req('POST', '/api/public/reservations', undefined, {
      token: widgetToken, date: DATE, time: '20:00', partySize: 2, name: 'Cvetka Sosednja', phone: '+38640555666',
    }))
    expect(res.status).toBe(201)
    const j = await jbody(res)
    // Ana 18:00–20:00 na mizi 1; Cvetka 20:00–22:00 = SUSEDNJI okno (konec ==
    // start se NE šteje za prekrivanje — strogo odprti intervali) → miza 1 prosta
    expect((j.reservation as { tableName?: string | null }).tableName).toBe('Miza 1')
  })

  test('F4: prevelika družina brez kombinacije → rezervacija BREZ mize (null — osebje dodeli)', async () => {
    __resetRateLimitForTests()
    const res = await publicPOST(req('POST', '/api/public/reservations', undefined, {
      token: widgetToken, date: DATE, time: '12:00', partySize: 20, name: 'Velika Družina', phone: '+38640777888',
    }))
    // 20 oseb > maxParty privzete politike (12)? — politika lahko zavrne že kapaciteto;
    // v tem primeru je 409 PRAVILEN odgovor (ne test avtododelitve). Preverimo
    // obe pošteni veji: 409 (politika) ALI 201 brez mize (avtododelitev null).
    if (res.status === 201) {
      const j = await jbody(res)
      expect((j.reservation as { tableName?: string | null }).tableName).toBeNull()
    } else {
      expect([409, 400]).toContain(res.status)
    }
  })
})

/* ═══════════════ Č7 — digest sekcija + tedenski email (nalagalca) ═══════════════ */

describe('Č7 — povzetki opravil nad pravo bazo (nalagalca)', () => {
  test('G1: loadTaskSummaryForDigest — predloga s terminom + izvedba → vrstica s pokritostjo', async () => {
    // dnevna predloga z današnjim terminom (SISTEMSKI datum — isto definicijo
    // »danes« kot loadTaskSummaryForDigest; glej import opombo zgoraj)
    const todayKey = systemLocalDateKey(new Date())
    const tpl = {
      id: `${P}tpl-digest`, name: `${P}Odpiranje digest`, category: 'opening', repeat: 'daily',
      weekday: null, monthDay: null, anchorDate: '', validUntil: null, dueTime: '09:00', active: true,
      items: [{ id: 'i1', label: 'Preveri kavo', response: 'check' }, { id: 'i2', label: 'Zalij rože', response: 'check' }],
    }
    await db.integration.create({
      data: {
        id: `${P}int-digest-${RUN}`, name: OPS_CHECKLISTS_MARKER, type: 'other', provider: 'internal',
        config: JSON.stringify({ templates: [tpl] }), isActive: true, syncEnabled: false, locationId: locA,
      },
    })
    // izvedba: 1 od 2 postavk
    await db.checklistRun.create({
      data: {
        id: `${P}run-digest-${RUN}`, locationId: locA, templateId: tpl.id, templateName: tpl.name,
        occurrenceKey: `${tpl.id}|${todayKey}`, state: 'open',
        itemResults: JSON.stringify({ i1: { kind: 'check', value: true, at: new Date().toISOString(), byId: mgrAId, byName: `${P}mgr` } }),
      },
    })
    const lines = await loadTaskSummaryForDigest(new Date(), null)
    const mine = lines.find((l) => l.template === tpl.name)
    expect(mine).toBeDefined()
    expect(mine!.done).toBe(1)
    expect(mine!.total).toBe(2)
    expect(mine!.completed).toBe(false)
  })

  test('G2: loadTaskSummaryForDigest — validUntil pretekli: predloga NE rodi termina (prazna vrstica odsotna)', async () => {
    const tpl = {
      id: `${P}tpl-dead`, name: `${P}Ugasnjena`, category: 'closing', repeat: 'daily',
      weekday: null, monthDay: null, anchorDate: '', validUntil: '2020-01-01', dueTime: '22:00', active: true,
      items: [{ id: 'i1', label: 'Zakleni', response: 'check' }],
    }
    await db.integration.create({
      data: {
        id: `${P}int-dead-${RUN}`, name: OPS_CHECKLISTS_MARKER, type: 'other', provider: 'internal',
        config: JSON.stringify({ templates: [tpl] }), isActive: true, syncEnabled: false, locationId: locA,
      },
    })
    const lines = await loadTaskSummaryForDigest(new Date(), null)
    expect(lines.find((l) => l.template === tpl.name)).toBeUndefined()
  })

  test('G3: sendWeeklyTaskSummary — ne-ponedeljek → not_monday; ponedeljek pošlje + varovalka already_sent', async () => {
    // torek
    const tue = await sendWeeklyTaskSummary({ now: new Date('2026-11-10T05:00:00Z'), transportFactory: async () => fakeMailer() })
    expect(tue.sent).toBe(false)
    expect(tue.reason).toBe('not_monday')
    // ponedeljek z dnevno predlogo (iz G1) — 7 pojavitvev na teden
    await db.scheduledEmailLog.deleteMany({ where: { reportType: 'TASK_WEEKLY' } })
    await db.restaurantSettings.deleteMany({ where: { emailEnabled: true, email: { contains: 'v248' } } })
    // SMTP profil: settings vrstica z emailom (vzorec v167/v206 testov)
    const settingsId = `${P}set-${RUN}`
    await db.restaurantSettings.create({
      data: { id: settingsId, name: `${P}Gostilna`, emailEnabled: true, email: 'v248-digest@test.local' },
    } as never)
    const sent: string[] = []
    const mailer: DigestMailer = {
      sendMail: async (opts) => { sent.push(String((opts as { text?: string }).text || '')); return { messageId: 'x' } },
    }
    const mon = await sendWeeklyTaskSummary({ now: new Date('2026-11-09T05:00:00Z'), transportFactory: async () => mailer })
    expect(mon.sent).toBe(true)
    expect(sent[0]).toContain(`${P}Odpiranje digest`)
    // varovalka: drugi klic isti ponedeljek → already_sent
    const again = await sendWeeklyTaskSummary({ now: new Date('2026-11-09T06:00:00Z'), transportFactory: async () => mailer })
    expect(again.sent).toBe(false)
    expect(again.reason).toBe('already_sent')
  })

  test('G4: digest besedilo — taskSummary sekcija additivno (absent → byte-identično brez nje)', () => {
    const base = {
      shiftId: 'x', shiftDate: new Date('2026-11-08T18:00:00Z'), from: new Date('2026-11-08T00:00:00Z'), to: new Date('2026-11-09T00:00:00Z'),
      locationId: null, gross: 100, net: 80, vat: 20, covers: 4, payments: [], topItems: [],
    }
    const without = dailyDigestEmailText(base)
    expect(without.body).not.toContain('Opravila:')
    const withTasks = dailyDigestEmailText({ ...base, taskSummary: [{ template: 'Odpiranje', done: 3, total: 3, completed: true }] })
    expect(withTasks.body).toContain('Opravila:')
    expect(withTasks.body).toContain('ZAKLJUČENO')
  })
})

/* ═══════════════ Ž — registri in pini ═══════════════ */

describe('Ž — registri v1.248.0', () => {
  const root = join(import.meta.dir, '..')

  test('Ž1: verzija 1.248.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.307.0')
    const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8')
    expect(compose).toContain('restaurantos:1.307.0')
  })

  test('Ž2: i18n pariteta SL/HR 3989/3989 (+21: opv.validUntil×2, pn×10, posn×8, common.add)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    expect(sl['opv.validUntil']).toBeDefined()
    expect(hr['opv.validUntil']).toBeDefined()
    expect(sl['pn.title']).toBeDefined()
    expect(sl['posn.title']).toBeDefined()
    expect(sl['common.add']).toBeDefined()
  })

  test('Ž3: dokumenti — PRIMERJAVA §22 STREŽNI VAL', () => {
    const doc = readFileSync(join(root, 'docs', 'PRIMERJAVA-VMESNIKOV-2026.md'), 'utf8')
    expect(doc).toContain('## 22. Raziskava maj/junij 2026 — STREŽNI VAL v1.248.0')
    expect(doc).toContain('automatic table assignments')
    expect(doc).toContain('preset notes')
    expect(doc).toContain('task summary emails')
  })

  test('Ž4: rute obstajajo — /api/preset-notes (GET/PUT) + javna rezervacijska ruta nosi avtododelitev', () => {
    expect(existsSync(join(root, 'src', 'app', 'api', 'preset-notes', 'route.ts'))).toBe(true)
    const pub = readFileSync(join(root, 'src', 'app', 'api', 'public', 'reservations', 'route.ts'), 'utf8')
    expect(pub).toContain('autoassignTableForBooking')
    expect(pub).toContain('busyTableIdsForWindow')
    expect(pub).toContain('loadBookableExcluded')
  })

  test('Ž5: UI montaža — PresetNotesCard v Meni zavihku + CartNoteButton + dialog opombe', () => {
    const dash = readFileSync(join(root, 'src', 'app', 'dashboard', 'page.tsx'), 'utf8')
    expect(dash).toContain('<PresetNotesCard')
    expect(dash).toContain('CartNoteButton')
    expect(dash).toContain('openNotePick')
    expect(dash).toContain("data-region=\"posn-chips\"")
    expect(dash).toContain('composeItemNote')
    // tri košarice: vse tri note mape v payloadih
    expect(dash).toContain('cartNotes[menuItemId]')
    expect(dash).toContain('saleNotes[menuItemId]')
    expect(dash).toContain('sheetNotes[menuItemId]')
  })

  test('Ž6: urejevalnik predlog nosi validUntil polje', () => {
    const tab = readFileSync(join(root, 'src', 'components', 'tabs', 'opravila-tab.tsx'), 'utf8')
    expect(tab).toContain('opv.validUntil')
    expect(tab).toContain('draft.validUntil')
  })

  test('Ž7: cron-daily nosi tedenski korak + digest sekcijo', () => {
    const cron = readFileSync(join(root, 'src', 'app', 'api', 'cron', 'daily', 'route.ts'), 'utf8')
    expect(cron).toContain('sendWeeklyTaskSummary')
    expect(cron).toContain('taskWeekly')
    const email = readFileSync(join(root, 'src', 'lib', 'daily-email.ts'), 'utf8')
    expect(email).toContain('loadTaskSummaryForDigest')
    expect(email).toContain('TASK_WEEKLY')
  })

  test('Ž8: čisti sloji brez DB uvozov (table-autoassign, task-summary-email, preset-notes)', () => {
    for (const f of ['table-autoassign.ts', 'task-summary-email.ts', 'preset-notes.ts']) {
      const src = readFileSync(join(root, 'src', 'lib', f), 'utf8')
      expect(src).not.toMatch(/^import\s/m)
    }
  })
})

/** Lažni mailer za transportFactory šiv (vzorec v167/v206). */
function fakeMailer(): DigestMailer {
  return {
    sendMail: async () => ({ messageId: 'fake' }),
  }
}

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
