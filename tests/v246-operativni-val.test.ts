/**
 * v1.246.0 — OPERATIVNI VAL (PRIMERJAVA-VMESNIKOV-2026 §20:
 * Lightspeed Tasks marec 2026 — digitalni checklisti).
 *
 * Dve ugotovitvi:
 *  A · PREDLOGE + PLOŠČA (P1): HaccpPlan je ENA kontrola — odpiralni seznam
 *    s 15 postavkami je zahteval 15 načrtov. Zdaj: predloga (Integration,
 *    0 DDL) + izvedba ChecklistRun (1 DDL) s PO POSTAVKI { kind, value, at,
 *    byId, byName } + terminski motor VSEH sedmih pogostosti Lightspeed.
 *  B · ODZIVNI TIPI (P2, iskrena meja): check/count/text — photo/signature
 *    čakata lastniško odločitev o shrambi medijev (§20 B).
 *
 * Predpona fiksatur `v246-`; cleanup v afterAll (obratna smer FK).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as tplGET, PUT as tplPUT } from '../src/app/api/checklists/templates/route'
import { GET as boardGET, POST as boardPOST } from '../src/app/api/checklists/board/route'
import {
  OPS_CHECKLISTS_MARKER,
  buildChecklistBoard,
  checklistOccurrenceForDate,
  coverageOf,
  isValidDateKey,
  localDateFromKey,
  occurrenceKeysForWindow,
  parseChecklistTemplates,
  parseItemResults,
  resetChecklistRunsProbe,
  runCompletedFromCoverage,
  validateChecklistTemplates,
  type ChecklistTemplate,
  type ItemResultsMap,
} from '../src/lib/ops-checklists'
import { KNOWN_DRIFTS, isChecklistRunsStatement } from '../scripts/drift-check'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { APP_VERSION } from '../src/lib/version'
import { zonedDateParts, type LocalDate } from '../src/lib/haccp-ops'
import { readFileSync } from 'fs'
import { join } from 'path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v246-'
const RUN = Date.now().toString(36)
const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf-8')
}

let locA = ''
let ownerId = ''
let token = '' // owner (settings.manage — predloge)
let staffId = ''
let staffToken = '' // natakar (samo plošča — izvedba)

function req(method: string, url: string, body?: unknown, tok: string | null = token): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

/** Današnji lokalni datumski ključ (Europe/Ljubljana) — dnevna predloga ima DANES termin. */
function todayKeyLj(): string {
  const p = zonedDateParts(new Date(), 'Europe/Ljubljana')
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

const tplDaily = (): ChecklistTemplate => ({
  id: `${P}tpl-daily-${RUN}`,
  name: `${P}Odpiralni seznam`,
  category: 'opening',
  repeat: 'daily',
  weekday: null,
  monthDay: null,
  anchorDate: '',
  dueTime: '09:00',
  active: true,
  items: [
    { id: `${P}it-luci`, label: 'Prižgi luči', response: 'check' },
    { id: `${P}it-pos`, label: 'Prižgi POS', response: 'check' },
    { id: `${P}it-zepnina`, label: 'Preštej žepnino', response: 'count' },
    { id: `${P}it-opomba`, label: 'Opomba odpiratelja', response: 'text' },
  ],
})

beforeAll(async () => {
  await sweepTestFixtures(db, [P])

  const a = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Lokacija A`, code: `V246A-${RUN.toUpperCase()}`, premisesId: `v246-premA-${RUN}`, timezone: 'Europe/Ljubljana' },
  })
  locA = a.id
  ownerId = `${P}owner-${RUN}`
  const pin = employeePinFields('v246-pin-1234', `${P}owner-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: ownerId, name: `${P}Lastnik`, email: `${P}owner-${RUN}@test.local`,
      role: 'owner', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pin.pin, pinLookup: pin.pinLookup,
    },
  })
  token = createToken({ sub: ownerId, name: `${P}Lastnik`, role: 'owner', loc: locA, sv: 0 })

  staffId = `${P}staff-${RUN}`
  const pinS = employeePinFields('v246-pinS-1234', `${P}staff-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id: staffId, name: `${P}Natakar`, email: `${P}staff-${RUN}@test.local`,
      role: 'staff', status: 'active', sessionVersion: 0, locationId: locA,
      pin: pinS.pin, pinLookup: pinS.pinLookup,
    },
  })
  staffToken = createToken({ sub: staffId, name: `${P}Natakar`, role: 'staff', loc: locA, sv: 0 })
})

afterAll(async () => {
  await db.checklistRun.deleteMany({ where: { templateId: { startsWith: P } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: P } }, { action: { in: ['CHECKLIST_TEMPLATES_CONFIG', 'CHECKLIST_RUN_ITEM', 'CHECKLIST_RUN_COMPLETED'] } }] } }).catch(() => null)
  await db.integration.deleteMany({ where: { name: OPS_CHECKLISTS_MARKER, locationId: locA } }).catch(() => null)
  await db.employee.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
})

/* ── A · Predloge (GET/PUT /api/checklists/templates) ─────────────────── */

describe('v1.246.0 A · registr predlog', () => {
  test('A1: GET brez vrstice → prazno', async () => {
    const res = await tplGET(req('GET', `/api/checklists/templates?locationId=${locA}`, undefined))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.templates).toEqual([])
  })

  test('A2: PUT dnevna predloga s 4 postavkami → 200 + revizija + GET vrne', async () => {
    const res = await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [tplDaily()] }))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect((d.templates as unknown[]).length).toBe(1)
    const audit = await db.auditLog.findFirst({ where: { action: 'CHECKLIST_TEMPLATES_CONFIG', locationId: locA } })
    expect(audit).not.toBeNull()
    const g = await tplGET(req('GET', `/api/checklists/templates?locationId=${locA}`, undefined))
    const gd = await body(g)
    const t = (gd.templates as ChecklistTemplate[])[0]
    expect(t.items.length).toBe(4)
    expect(t.repeat).toBe('daily')
    expect(t.dueTime).toBe('09:00')
  })

  test('A3: PUT validacija — manjkajoče ime / slaba ponovitev / tedenska brez dneva / mesečna brez dneva / biweekly brez anchorja / slab rok / prazne postavke / podvojen id / slab odzivni tip → 400', async () => {
    const base = tplDaily()
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, name: '' }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, repeat: 'hourly' as never }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, repeat: 'weekly' as never, weekday: null }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, repeat: 'monthly' as never, monthDay: null }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, repeat: 'biweekly' as never, weekday: 1, anchorDate: '' }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, dueTime: '25:00' }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, items: [] }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, items: [base.items[0], { ...base.items[1], id: base.items[0].id }] }] }))).status).toBe(400)
    expect((await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [{ ...base, items: [{ ...base.items[0], response: 'photo' as never }] }] }))).status).toBe(400)
  })

  test('A4: natakar BREZ settings.manage → PUT 403 (predloge so vodstvo)', async () => {
    const res = await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [tplDaily()] }, staffToken))
    expect(res.status).toBe(403)
  })

  test('A5: parse (defenzivno branje) — neveljavne predloge se tiho izpustijo (self-healing)', () => {
    const raw = JSON.stringify({
      templates: [
        tplDaily(), // veljavna
        { id: 'bad-1', name: '', repeat: 'daily', items: [{ id: 'a', label: 'x', response: 'check' }] }, // brez imena
        { id: 'bad-2', name: 'Brez postavk', repeat: 'daily', items: [] }, // brez postavk
        { name: 'Brez id', repeat: 'daily', items: [{ id: 'a', label: 'x', response: 'check' }] }, // brez id
        { id: 'bad-4', name: 'Slaba pogostost', repeat: 'hourly', items: [{ id: 'a', label: 'x', response: 'check' }] },
      ],
    })
    const parsed = parseChecklistTemplates(raw)
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe(tplDaily().id)
  })

  test('A6: validateChecklistTemplates — nadzorovana normalizacija (kategorija other, response check fallback NE velja pri pisanju)', () => {
    const { templates, error } = validateChecklistTemplates({ templates: [tplDaily()] })
    expect(error).toBeNull()
    expect(templates.length).toBe(1)
    // slaba kategorija je NAPAKA pri pisanju? NE — kategorija ima fallback 'other'
    // (ne-varnostno polje); odzivni tip pa je STROG (A3).
    const v2 = validateChecklistTemplates({ templates: [{ ...tplDaily(), category: 'nonsense' as never }] })
    expect(v2.error).toBeNull()
    expect(v2.templates[0].category).toBe('other')
  })
})

/* ── B · Terminski motor (čiste funkcije — vseh sedem pogostosti) ──────── */

describe('v1.246.0 B · terminski motor (checklistOccurrenceForDate)', () => {
  const TZ = 'Europe/Ljubljana'
  const D = (y: number, m: number, d: number): LocalDate => ({ y, m, d })

  test('B1: daily → termin vsak dan; ključ `${id}|YYYY-MM-DD`', () => {
    const tpl = { id: 't1', repeat: 'daily' as const, weekday: null, monthDay: null, anchorDate: '', dueTime: '09:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 15), TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 16), TZ)?.key).toBe('t1|2026-01-16')
  })

  test('B2: weekly → samo ponedeljki (1 = pon)', () => {
    // 2026-01-12 je ponedeljek
    const tpl = { id: 't2', repeat: 'weekly' as const, weekday: 1, monthDay: null, anchorDate: '', dueTime: '10:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 12), TZ)).not.toBeNull() // pon
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 13), TZ)).toBeNull() // tor
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 19), TZ)).not.toBeNull() // naslednji pon
  })

  test('B3: biweekly → faza 14 dni od anchorja (ponedeljki: 12. 1. ja, 19. 1. ne, 26. 1. ja)', () => {
    const tpl = { id: 't3', repeat: 'biweekly' as const, weekday: 1, monthDay: null, anchorDate: '2026-01-12', dueTime: '10:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 12), TZ)).not.toBeNull() // anchor
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 19), TZ)).toBeNull() // +7 — napačna faza
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 26), TZ)).not.toBeNull() // +14
  })

  test('B4: every4weeks → faza 28 dni (+14 je napačna faza)', () => {
    const tpl = { id: 't4', repeat: 'every4weeks' as const, weekday: 1, monthDay: null, anchorDate: '2026-01-12', dueTime: '10:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 12), TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 26), TZ)).toBeNull() // +14
    expect(checklistOccurrenceForDate(tpl, D(2026, 2, 9), TZ)).not.toBeNull() // +28
  })

  test('B5: monthly → dan v mesecu (1–28, brez amputacije februarja)', () => {
    const tpl = { id: 't5', repeat: 'monthly' as const, weekday: null, monthDay: 15, anchorDate: '', dueTime: '08:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 15), TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 14), TZ)).toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 2, 15), TZ)).not.toBeNull() // februar ima 15.
  })

  test('B6: quarterly → meseci od anchorja % 3 (januar anchor: jan, apr, jul, okt)', () => {
    const tpl = { id: 't6', repeat: 'quarterly' as const, weekday: null, monthDay: 5, anchorDate: '2026-01-05', dueTime: '08:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 5), TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 2, 5), TZ)).toBeNull() // +1 mesec
    expect(checklistOccurrenceForDate(tpl, D(2026, 4, 5), TZ)).not.toBeNull() // +3
    expect(checklistOccurrenceForDate(tpl, D(2026, 7, 5), TZ)).not.toBeNull() // +6
    expect(checklistOccurrenceForDate(tpl, D(2027, 1, 5), TZ)).not.toBeNull() // +12
    expect(checklistOccurrenceForDate(tpl, D(2026, 5, 5), TZ)).toBeNull() // +4
  })

  test('B7: semiannual → meseci od anchorja % 6', () => {
    const tpl = { id: 't7', repeat: 'semiannual' as const, weekday: null, monthDay: 10, anchorDate: '2026-01-10', dueTime: '08:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 1, 10), TZ)).not.toBeNull()
    expect(checklistOccurrenceForDate(tpl, D(2026, 4, 10), TZ)).toBeNull() // +3
    expect(checklistOccurrenceForDate(tpl, D(2026, 7, 10), TZ)).not.toBeNull() // +6
    expect(checklistOccurrenceForDate(tpl, D(2027, 1, 10), TZ)).not.toBeNull() // +12
  })

  test('B8: anchorDate = startni datum (Lightspeed »first day«) — pred njim NI terminov', () => {
    const tpl = { id: 't8', repeat: 'daily' as const, weekday: null, monthDay: null, anchorDate: '2026-06-01', dueTime: '09:00' }
    expect(checklistOccurrenceForDate(tpl, D(2026, 5, 31), TZ)).toBeNull() // pred prvim dnem
    expect(checklistOccurrenceForDate(tpl, D(2026, 6, 1), TZ)).not.toBeNull() // prvi dan
    expect(checklistOccurrenceForDate(tpl, D(2026, 6, 2), TZ)).not.toBeNull()
  })

  test('B9: dueTime po pasu lokacije — Ljubljana (CET, 15. 1.) 09:00 = 08:00 UTC', () => {
    const tpl = { id: 't9', repeat: 'daily' as const, weekday: null, monthDay: null, anchorDate: '', dueTime: '09:00' }
    const occ = checklistOccurrenceForDate(tpl, D(2026, 1, 15), TZ)
    expect(occ).not.toBeNull()
    expect(occ!.dueAt.toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  test('B10: occurrenceKeysForWindow — dnevi nazaj/naprej; NEAKTIVNE predloge izpuste', () => {
    const tpls: ChecklistTemplate[] = [
      { ...tplDaily(), id: `${P}w1` },
      { ...tplDaily(), id: `${P}w2`, active: false },
    ]
    const keys = occurrenceKeysForWindow(tpls, TZ, new Date('2026-01-15T10:00:00Z'), 3, 2)
    // samo w1: 3 dni nazaj + danes + 2 naprej = 6 terminov (daily)
    expect(keys.length).toBe(6)
    expect(keys.every((k) => k.startsWith(`${P}w1|`))).toBe(true)
  })
})

/* ── C · Plošča (buildChecklistBoard — čista) ──────────────────────────── */

describe('v1.246.0 C · plošča stanj (buildChecklistBoard)', () => {
  const TZ = 'Europe/Ljubljana'
  // sreda 2026-01-14 10:00 lokalnega (CET) = 09:00 UTC — dnevi AROUND tega
  const NOW = new Date('2026-01-14T09:00:00.000Z')

  const tpl = (): ChecklistTemplate => ({
    id: `${P}b-tpl`,
    name: 'Odpiranje',
    category: 'opening',
    repeat: 'daily',
    weekday: null,
    monthDay: null,
    anchorDate: '',
    dueTime: '09:00',
    active: true,
    items: [
      { id: 'i1', label: 'A', response: 'check' },
      { id: 'i2', label: 'B', response: 'check' },
      { id: 'i3', label: 'C', response: 'check' },
    ],
  })

  test('C1: včerajšnji termin brez izvedbe (rok 09:00 je pretekel) → ZAPADLO', () => {
    const board = buildChecklistBoard([tpl()], new Map(), TZ, NOW, 1, 1)
    const y = board.find((b) => b.date === '2026-01-13')
    expect(y?.state).toBe('overdue')
  })

  test('C2: današnji termin, rok še ni pretekel → V TEKU; prihodnji → PRIHAJA', () => {
    const nowAfter = new Date('2026-01-14T07:00:00.000Z') // 08:00 lokalno — rok 09:00 še prihaja
    const board = buildChecklistBoard([tpl()], new Map(), TZ, nowAfter, 1, 1)
    expect(board.find((b) => b.date === '2026-01-14')?.state).toBe('pending')
    expect(board.find((b) => b.date === '2026-01-15')?.state).toBe('upcoming')
  })

  test('C3: zaključena izvedba (state completed) → ZAKLJUČENO z izvajalcem', () => {
    const runs = new Map([
      [`${P}b-tpl|2026-01-13`, {
        id: 'r1', templateId: `${P}b-tpl`, templateName: 'Odpiranje', occurrenceKey: `${P}b-tpl|2026-01-13`,
        state: 'completed', itemResults: {}, completedById: 'u1', completedByName: 'Ana', completedAt: '2026-01-13T08:00:00.000Z',
      }],
    ])
    const board = buildChecklistBoard([tpl()], runs, TZ, NOW, 1, 1)
    const y = board.find((b) => b.date === '2026-01-13')
    expect(y?.state).toBe('completed')
    expect(y?.run?.completedByName).toBe('Ana')
  })

  test('C4: delna pokritost — progress 2/3 (včeraj zapadlo s pokritostjo)', () => {
    const results: ItemResultsMap = {
      i1: { kind: 'check', value: true, at: '2026-01-13T08:00:00.000Z', byId: 'u1', byName: 'Ana' },
      i2: { kind: 'check', value: true, at: '2026-01-13T08:05:00.000Z', byId: 'u1', byName: 'Ana' },
    }
    const runs = new Map([
      [`${P}b-tpl|2026-01-13`, {
        id: 'r1', templateId: `${P}b-tpl`, templateName: 'Odpiranje', occurrenceKey: `${P}b-tpl|2026-01-13`,
        state: 'open', itemResults: results, completedById: '', completedByName: '', completedAt: null,
      }],
    ])
    const board = buildChecklistBoard([tpl()], runs, TZ, NOW, 1, 1)
    const y = board.find((b) => b.date === '2026-01-13')
    expect(y?.state).toBe('overdue') // ni zaključena in rok je pretekel
    expect(y?.progress).toEqual({ done: 2, total: 3 })
  })

  test('C5: NEAKTIVNA predloga ne pride na ploščo', () => {
    const board = buildChecklistBoard([{ ...tpl(), active: false }], new Map(), TZ, NOW, 1, 1)
    expect(board.length).toBe(0)
  })

  test('C6: razvrstitev — rank narašča (zapadlo → v teku → prihaja → zaključeno)', () => {
    const runs = new Map([
      [`${P}b-tpl|2026-01-13`, {
        id: 'r1', templateId: `${P}b-tpl`, templateName: 'Odpiranje', occurrenceKey: `${P}b-tpl|2026-01-13`,
        state: 'completed', itemResults: {}, completedById: 'u1', completedByName: 'Ana', completedAt: '2026-01-13T08:00:00.000Z',
      }],
    ])
    const board = buildChecklistBoard([tpl()], runs, TZ, NOW, 2, 2)
    // okno: 12.–16. januar. 12. zapadli (brez izvedbe, rok pretekel), 13.
    // zaključen, 14. ob 10:00 z rokom 09:00 → zapadlo, 15./16. prihajajoči
    const rank: Record<string, number> = { overdue: 0, pending: 1, upcoming: 2, completed: 3 }
    const ranks = board.map((b) => rank[b.state])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b)) // nedebeče narašča
    expect(board.some((b) => b.state === 'completed')).toBe(true)
    expect(board.filter((b) => b.state === 'overdue').length).toBe(2) // 12., 14.
    expect(board.filter((b) => b.state === 'upcoming').length).toBe(2) // 15., 16.
  })
})

/* ── D · Izvedbe (POST /api/checklists/board) ──────────────────────────── */

describe('v1.246.0 D · izvedbe po postavki', () => {
  test('D1: POST check postavka → 200; run open z itemResults[kdo+kdaj]; revizija CHECKLIST_RUN_ITEM', async () => {
    const today = todayKeyLj()
    const res = await boardPOST(
      req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-luci`, value: true }, staffToken),
    )
    expect(res.status).toBe(200)
    const d = await body(res)
    const run = d.run as { state: string; itemResults: Record<string, { byName: string; kind: string; value: boolean }> }
    expect(run.state).toBe('open')
    expect(run.itemResults[`${P}it-luci`].value).toBe(true)
    expect(run.itemResults[`${P}it-luci`].byName).toBe(`${P}Natakar`) // KDO (Lightspeed »who completed what«)
    expect(run.itemResults[`${P}it-luci`].kind).toBe('check')
    expect(d.progress).toEqual({ done: 1, total: 4 })
    const audit = await db.auditLog.findFirst({ where: { action: 'CHECKLIST_RUN_ITEM', locationId: locA } })
    expect(audit).not.toBeNull()
  })

  test('D2: POST vse preostale postavke (check+count+text) → ZAKLJUČEK izpelje strežnik (state completed + completedByName) + revizija CHECKLIST_RUN_COMPLETED', async () => {
    const today = todayKeyLj()
    const r2 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-pos`, value: true }, staffToken))
    expect(r2.status).toBe(200)
    const r3 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-zepnina`, value: 152.5 }, staffToken))
    expect(r3.status).toBe(200)
    const r4 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-opomba`, value: 'Terasa čista' }, staffToken))
    expect(r4.status).toBe(200)
    const d4 = await body(r4)
    const run = d4.run as { state: string; completedByName: string; completedAt: string | null }
    expect(d4.completed).toBe(true)
    expect(run.state).toBe('completed')
    expect(run.completedByName).toBe(`${P}Natakar`)
    expect(run.completedAt).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'CHECKLIST_RUN_COMPLETED', locationId: locA } })
    expect(audit).not.toBeNull()
    // DB resnica: ena vrstica (dedup @@unique), itemResults 4 vnosi
    const row = await db.checklistRun.findFirst({ where: { templateId: tplDaily().id, locationId: locA } })
    expect(row).not.toBeNull()
    const results = parseItemResults(row!.itemResults)
    expect(Object.keys(results).length).toBe(4)
    expect(results[`${P}it-zepnina`].value).toBe(152.5)
    expect(results[`${P}it-opomba`].value).toBe('Terasa čista')
  })

  test('D3: POČISTI odziv (value null) na zaključenem seznamu → strežnik znova ODPRE (completed počiščen)', async () => {
    const today = todayKeyLj()
    const res = await boardPOST(
      req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-luci`, value: null }, staffToken),
    )
    expect(res.status).toBe(200)
    const d = await body(res)
    const run = d.run as { state: string; completedAt: string | null }
    expect(d.completed).toBe(false)
    expect(run.state).toBe('open')
    expect(run.completedAt).toBeNull()
    expect(d.progress).toEqual({ done: 3, total: 4 })
  })

  test('D4: NAPAČEN tip vrednosti (niz za check; niz za count) → 400', async () => {
    const today = todayKeyLj()
    const r1 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-pos`, value: 'da' }, staffToken))
    expect(r1.status).toBe(400)
    const r2 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: `${P}it-zepnina`, value: 'pet' }, staffToken))
    expect(r2.status).toBe(400)
  })

  test('D5: datum NI termin te predloge (včerajšnji dan tedenske) → 400 brez fantomske izvedbe', async () => {
    // tedenska predloga na ponedeljek — danes ni nujno ponedeljek: izberidatum, ki NI ponedeljek
    const tplW: ChecklistTemplate = { ...tplDaily(), id: `${P}tpl-weekly-${RUN}`, name: `${P}Tedenski`, repeat: 'weekly', weekday: 1, monthDay: null, anchorDate: '', dueTime: '09:00' }
    await tplPUT(req('PUT', '/api/checklists/templates', { locationId: locA, templates: [tplDaily(), tplW] }))
    // poišči prihodnji DAN, ki ni ponedeljek
    const p = zonedDateParts(new Date(Date.now() + 3 * 86400_000), 'Europe/Ljubljana')
    let probe = new Date(Date.now() + 3 * 86400_000)
    for (let i = 0; i < 7; i++) {
      probe = new Date(probe.getTime() + 86400_000)
      const pp = zonedDateParts(probe, 'Europe/Ljubljana')
      const wd = new Date(Date.UTC(pp.y, pp.m - 1, pp.d)).getUTCDay() || 7
      if (wd !== 1) {
        const key = `${pp.y}-${String(pp.m).padStart(2, '0')}-${String(pp.d).padStart(2, '0')}`
        const res = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplW.id, date: key, itemId: `${P}it-luci`, value: true }, staffToken))
        expect(res.status).toBe(400)
        const phantom = await db.checklistRun.findFirst({ where: { templateId: tplW.id } })
        expect(phantom).toBeNull()
        break
      }
    }
    void p
  })

  test('D6: neznana predloga / neznana postavka → 404', async () => {
    const today = todayKeyLj()
    const r1 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: 'ne-obstaja', date: today, itemId: 'x', value: true }, staffToken))
    expect(r1.status).toBe(404)
    const r2 = await boardPOST(req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: today, itemId: 'ne-obstaja', value: true }, staffToken))
    expect(r2.status).toBe(404)
  })

  test('D7: GET plošča (natakar) → današnji termin s pokritostjo 3/4 + izvajalci PO POSTAVKI', async () => {
    const res = await boardGET(req('GET', `/api/checklists/board?locationId=${locA}`, undefined, staffToken))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.ddlPending).toBe(false)
    const today = todayKeyLj()
    const item = (d.checklists as { template: { id: string }; date: string; state: string; progress: { done: number; total: number } }[])
      .find((b) => b.template.id === tplDaily().id && b.date === today)
    expect(item).not.toBeUndefined()
    expect(item!.progress).toEqual({ done: 3, total: 4 })
    expect(['overdue', 'pending']).toContain(item!.state)
    // predloge pridejo zraven (urejevalnik/prazna stanja)
    expect(((d.templates as unknown[]) ?? []).length).toBeGreaterThanOrEqual(1)
  })

  test('D8: runCompletedFromCoverage — čista izpeljava (prazne postavke nikoli zaključene)', () => {
    const t = tplDaily()
    expect(runCompletedFromCoverage(t, {})).toBe(false)
    const full: ItemResultsMap = {}
    for (const it of t.items) full[it.id] = { kind: it.response, value: it.response === 'check' ? true : it.response === 'count' ? 1 : 'x', at: '', byId: '', byName: '' }
    expect(runCompletedFromCoverage(t, full)).toBe(true)
    expect(runCompletedFromCoverage({ ...t, items: [] }, full)).toBe(false)
  })

  test('D9: coverageOf + parseItemResults — obrambno branje (neveljavni odzivi se preskočijo)', () => {
    const t = tplDaily()
    expect(coverageOf(t, {})).toEqual({ done: 0, total: 4 })
    expect(coverageOf(t, { [`${P}it-luci`]: { kind: 'check', value: true, at: '', byId: '', byName: '' } })).toEqual({ done: 1, total: 4 })
    const parsed = parseItemResults(
      JSON.stringify({
        a: { kind: 'check', value: true, at: '', byId: '', byName: '' }, // veljaven
        b: { kind: 'check', value: 'da' }, // napačen tip vrednosti → ven
        c: { kind: 'count', value: 'pet' }, // število kot niz → ven
        d: 'ni-objekt', // → ven
      }),
    )
    expect(Object.keys(parsed)).toEqual(['a'])
  })
})

/* ── E · DDL gate (probe) ──────────────────────────────────────────────── */

describe('v1.246.0 E · DDL gate (haccp-plans vzorec)', () => {
  test('E1: probe false → GET plošča graceful { checklists: [], ddlPending: true } (predloge vseeno pridejo)', async () => {
    resetChecklistRunsProbe(false)
    const res = await boardGET(req('GET', `/api/checklists/board?locationId=${locA}`, undefined, staffToken))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.ddlPending).toBe(true)
    expect(d.checklists).toEqual([])
    expect((d.templates as unknown[]).length).toBeGreaterThanOrEqual(1) // 0 DDL plast dela
    resetChecklistRunsProbe()
  })

  test('E2: probe false → POST 503 (pisanja ne delajo brez tabele)', async () => {
    resetChecklistRunsProbe(false)
    const res = await boardPOST(
      req('POST', '/api/checklists/board', { locationId: locA, templateId: tplDaily().id, date: todayKeyLj(), itemId: `${P}it-luci`, value: true }, staffToken),
    )
    expect(res.status).toBe(503)
    resetChecklistRunsProbe()
  })

  test('E3: probe NE maskira infra napak (reset → prava tabela obstaja na dev zrcalu)', async () => {
    resetChecklistRunsProbe() // cache čist — dejanska sonda
    const res = await boardGET(req('GET', `/api/checklists/board?locationId=${locA}`, undefined, staffToken))
    expect(res.status).toBe(200)
    const d = await body(res)
    expect(d.ddlPending).toBe(false)
  })
})

/* ── Ž · Registri (verzija, DDL pot, drift, i18n, navigacija) ──────────── */

describe('v1.246.0 Ž · verzija in dokumenti', () => {
  test('Ž1: APP_VERSION dvignjena na 1.246.0', () => {
    expect(APP_VERSION).toBe('1.281.0')
  })

  test('Ž2: SCHEMA_MIGRATIONS 40 vnosov — checklist-runs z endpointom + desc ključem', () => {
    expect(SCHEMA_MIGRATIONS).toHaveLength(44)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'checklist-runs')
    expect(m).toBeDefined()
    expect(m!.endpoint).toBe('/api/admin/migrate-checklist-runs')
    expect(m!.descKey).toBe('mig.checklistRuns.desc')
    // mig konzola: opis v obeh slovarjih
    expect(sl['mig.checklistRuns.desc']).toContain('ChecklistRun')
    expect(hr['mig.checklistRuns.desc']).toContain('ChecklistRun')
  })

  test('Ž3: KNOWN_DRIFTS 32 vnosov — checklist-runs matcher (CREATE da, DROP ne)', () => {
    expect(KNOWN_DRIFTS).toHaveLength(36)
    expect(new Set(KNOWN_DRIFTS.map((k) => k.id)).size).toBe(36) // v1.263.0 §37: +receipt-display-policy
    const k = KNOWN_DRIFTS.find((x) => x.id === 'checklist-runs')
    expect(k).toBeDefined()
    expect(k!.reason).toContain('/api/admin/migrate-checklist-runs')
    // STROGO enosmerno: CREATE TABLE/INDEX na ChecklistRun → znan; DROP → NEznan
    expect(isChecklistRunsStatement('CREATE TABLE "ChecklistRun" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isChecklistRunsStatement('CREATE UNIQUE INDEX "ChecklistRun_locationId_templateId_occurrenceKey_key" ON "ChecklistRun"("locationId", "templateId", "occurrenceKey")')).toBe(true)
    expect(isChecklistRunsStatement('CREATE INDEX "ChecklistRun_state_idx" ON "ChecklistRun"("state")')).toBe(true)
    expect(isChecklistRunsStatement('DROP TABLE "ChecklistRun"')).toBe(false)
    expect(isChecklistRunsStatement('ALTER TABLE "ChecklistRun" DROP COLUMN "itemResults"')).toBe(false)
    expect(isChecklistRunsStatement('CREATE TABLE "NecijaDrugje" ("id" TEXT)')).toBe(false)
  })

  test('Ž4: i18n števci 3968 v SL in HR (3889 + 47; pariteta) + vzorčni opv ključi', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    for (const key of ['tabs.opravila', 'opv.board', 'opv.state.overdue', 'opv.cat.opening', 'opv.rep.semiannual', 'opv.resp.count', 'opv.anchorDate', 'opv.itemLabel']) {
      expect(sl[key]).toBeTruthy()
      expect(hr[key]).toBeTruthy()
    }
  })

  test('Ž5: prisma shema — model ChecklistRun z @@unique dedupom; sqlite zrcalo generirano', () => {
    const mainSchema = read('prisma/schema.prisma')
    expect(mainSchema).toContain('model ChecklistRun {')
    expect(mainSchema).toContain('@@unique([locationId, templateId, occurrenceKey])')
    const mirror = read('prisma/schema.sqlite.prisma')
    expect(mirror).toContain('model ChecklistRun {')
  })

  test('Ž6: navigacija — zavihek opravila (TAB_PERM_ALL, skupina staff, mobilna vrstica čistilke)', () => {
    const tabPerm = read('src/lib/tab-permissions.ts')
    expect(tabPerm).toContain("opravila: TAB_PERM_ALL")
    const nav = read('src/lib/nav-groups.ts')
    expect(nav).toContain("opravila: 'staff'")
    expect(nav).toContain("CLEANER: ['pregled', 'haccp', 'opravila', 'delovnicas', 'urnik']")
  })

  test('Ž7: dashboard — DASHBOARD_TABS vnos + TabsContent + komponenta', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("['opravila', ClipboardCheck]")
    expect(page).toContain('<TabsContent value="opravila">')
    expect(page).toContain('<OpravilaTab />')
    const barrel = read('src/components/dashboard-tabs.tsx')
    expect(barrel).toContain("export { OpravilaTab }")
  })

  test('Ž8: isValidDateKey / localDateFromKey — defenzivni parserji', () => {
    expect(isValidDateKey('2026-01-15')).toBe(true)
    expect(isValidDateKey('2026-02-30')).toBe(false) // neobstoječ dan
    expect(isValidDateKey('2026-13-01')).toBe(false)
    expect(isValidDateKey('15. 1. 2026')).toBe(false)
    expect(localDateFromKey('2026-01-15')).toEqual({ y: 2026, m: 1, d: 15 })
    expect(localDateFromKey('slabo')).toBeNull()
  })
})
