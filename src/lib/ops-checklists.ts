/**
 * v1.246.0 (PRIMERJAVA-VMESNIKOV-2026 §20) — OPERATIVNI VAL: digitalni
 * checklisti (Lightspeed Tasks, marec 2026).
 *
 * Industrijska referenca: »Replace paper lists with digital checklists,
 * assign tasks, track progress and see who completed what — all in one
 * place.« En CHECKLIST = N nalog; osebje odšticka postavko po postavki,
 * sistem si zapiše KDO in KDAJ; pogostosti Daily / Weekly / Every two
 * weeks / Every four weeks / Monthly / Every three months / Every six
 * months + startni datum.
 *
 * HACCP meja (zavestna, §20 B): HaccpPlan je ENA kontrola (meritev z
 * pragi ali potrditev) z verigijsko sledjo po ES 852/2004 — odpiralni
 * seznam s 15 postavkami tja ne sodi. Ta modul je OPERATIVNI dnevni
 * ritem (luči, POS, žepnina, rezervacije, ključi …), brez merilnih pragov.
 *
 * TRI plasti (vzorec §19 kombinacijskega vala):
 *  1. REGISTR predlog (0 DDL): Integration vrstica name='ops-checklists-config'
 *     per lokacija — predloge s postavkami (check/count/text odzivi).
 *  2. NOSILEC izvedb (1 aditivna DDL, mig konzola): tabela ChecklistRun —
 *     ena vrstica na pojavitev, itemResults Json PO POSTAVKI
 *     { kind, value, at, byId, byName }.
 *  3. TERMINSKI MOTOR + PLOŠČA (ta datoteka): čiste funkcije — termin po
 *     pasu lokacije (DST-varno, vzorec haccp-ops), stanja zapadlo/v teku/
 *     prihaja/zaključeno + delna pokritost n/N.
 *
 * ČISTI MOTOR: jedro NE uvaža db (vzorec three-way-match/food-cost);
 * Prisma klient je izvožen ločeno na dnu (combosDb vzorec v1.245.0).
 */

import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import {
  isValidDueTime,
  localDateKey,
  localWeekday,
  zonedDateParts,
  zonedTimeToUtc,
  type LocalDate,
} from './haccp-ops'

/* ═══════════════ 1. TIPI (kanonične oblike) ═══════════════ */

/** Pogostost ponovitve (Lightspeed »Repeats«, marec 2026 — vseh sedem). */
export type ChecklistRepeat =
  | 'daily'
  | 'weekly'
  | 'biweekly' // vsaka 2 tedna (faza od anchorDate)
  | 'every4weeks' // vsaka 4 tedna (faza od anchorDate)
  | 'monthly'
  | 'quarterly' // vsaka 3 meseca (meseci od anchorDate)
  | 'semiannual' // vsakih 6 mesecev

export const CHECKLIST_REPEATS: readonly ChecklistRepeat[] = [
  'daily',
  'weekly',
  'biweekly',
  'every4weeks',
  'monthly',
  'quarterly',
  'semiannual',
]

/** Odzivni tip postavke (§20 B: check/count/text — poštena jedrna množica). */
export type ChecklistItemResponse = 'check' | 'count' | 'text'

export const CHECKLIST_ITEM_RESPONSES: readonly ChecklistItemResponse[] = ['check', 'count', 'text']

/** Operativna kategorija (HACCP kategorije so živilske — te so operativne). */
export type ChecklistCategory =
  | 'opening'
  | 'closing'
  | 'cleaning'
  | 'maintenance'
  | 'security'
  | 'other'

export const CHECKLIST_CATEGORIES: readonly ChecklistCategory[] = [
  'opening',
  'closing',
  'cleaning',
  'maintenance',
  'security',
  'other',
]

/** Postavka predloge — ena odštickljiva naloga. */
export interface ChecklistItem {
  id: string
  label: string
  /** check = potrditev | count = številka | text = opomba. */
  response: ChecklistItemResponse
}

/** Predloga seznama (kanonična oblika v Integration config). */
export interface ChecklistTemplate {
  id: string
  name: string
  category: ChecklistCategory
  repeat: ChecklistRepeat
  /** 1–7 (pon–ned) — za weekly/biweekly/every4weeks. */
  weekday: number | null
  /** 1–28 — za monthly/quarterly/semiannual (enak datum vsak mesec, brez amputacije februarja). */
  monthDay: number | null
  /** YYYY-MM-DD — prvi dan obveznosti (Lightspeed »start date«) + faza za večtedenske/mesečne. */
  anchorDate: string
  /** HH:MM — rok izvedbe v lokalnem pasu. */
  dueTime: string
  active: boolean
  items: ChecklistItem[]
}

/** Odziv na postavko (PO POSTAVKI kdo/kdaj — »who completed what«). */
export interface ChecklistItemResult {
  kind: ChecklistItemResponse
  value: boolean | number | string
  /** ISO čas izvedbe. */
  at: string
  byId: string
  byName: string
}

/** Zemljevid odzivov { [itemId]: result } — oblika ChecklistRun.itemResults. */
export type ItemResultsMap = Record<string, ChecklistItemResult>

/** Izvedba seznama (pogled nad ChecklistRun vrstico). */
export interface ChecklistRunView {
  id: string
  templateId: string
  templateName: string
  occurrenceKey: string
  state: string // 'open' | 'completed'
  itemResults: ItemResultsMap
  completedById: string
  completedByName: string
  completedAt: string | null
}

/* ═══════════════ 2. PARSANJE (obrambno, jparse) ═══════════════ */

/** Marker Integration vrstice s predlogami seznamov (per lokacija). */
export const OPS_CHECKLISTS_MARKER = 'ops-checklists-config'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Veljaven lokalni datumski ključ YYYY-MM-DD? */
export function isValidDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function asRepeat(v: unknown): ChecklistRepeat | null {
  return CHECKLIST_REPEATS.includes(v as ChecklistRepeat) ? (v as ChecklistRepeat) : null
}

function asCategory(v: unknown): ChecklistCategory {
  return CHECKLIST_CATEGORIES.includes(v as ChecklistCategory) ? (v as ChecklistCategory) : 'other'
}

function asResponse(v: unknown): ChecklistItemResponse {
  return CHECKLIST_ITEM_RESPONSES.includes(v as ChecklistItemResponse)
    ? (v as ChecklistItemResponse)
    : 'check'
}

/**
 * Obrambna normalizacija registra predlog (jparse — Integration.config Json
 * polje se prebere kot string). Neveljavne predloge se tiho izpustijo
 * (self-healing branje — vzorec parseCombos v1.245.0); pisanje validira
 * STROGO (validirajChecklistTemplates — napaka, ne tiho popravljanje).
 */
export function parseChecklistTemplates(raw: unknown): ChecklistTemplate[] {
  const parsed = jparse<unknown>(raw, null)
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as { templates?: unknown }
  if (!Array.isArray(o.templates)) return []
  const out: ChecklistTemplate[] = []
  for (const t of o.templates) {
    if (!t || typeof t !== 'object') continue
    const row = t as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const name = String(row.name ?? '').trim()
    const repeat = asRepeat(row.repeat)
    if (!id || !name || !repeat) continue
    const weekdayRaw = row.weekday === null || row.weekday === undefined ? null : Number(row.weekday)
    const monthDayRaw = row.monthDay === null || row.monthDay === undefined ? null : Number(row.monthDay)
    const itemsRaw = Array.isArray(row.items) ? row.items : []
    const items: ChecklistItem[] = []
    for (const it of itemsRaw) {
      if (!it || typeof it !== 'object') continue
      const irow = it as Record<string, unknown>
      const iid = String(irow.id ?? '').trim()
      const label = String(irow.label ?? '').trim()
      if (!iid || !label) continue
      items.push({ id: iid, label: label.slice(0, 160), response: asResponse(irow.response) })
    }
    if (items.length === 0) continue
    out.push({
      id,
      name: name.slice(0, 80),
      category: asCategory(row.category),
      repeat,
      weekday: weekdayRaw !== null && Number.isInteger(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 7 ? weekdayRaw : null,
      monthDay:
        monthDayRaw !== null && Number.isInteger(monthDayRaw) && monthDayRaw >= 1 && monthDayRaw <= 28 ? monthDayRaw : null,
      anchorDate: isValidDateKey(row.anchorDate) ? row.anchorDate : '',
      dueTime: isValidDueTime(row.dueTime ?? '') ? (row.dueTime as string) : '09:00',
      active: row.active === undefined ? true : Boolean(row.active),
      items: items.slice(0, 40),
    })
  }
  return out.slice(0, 20)
}

/** Obrambno branje itemResults iz ChecklistRun.itemResults (Json). */
export function parseItemResults(raw: unknown): ItemResultsMap {
  const parsed = jparse<unknown>(raw, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: ItemResultsMap = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    const kind = asResponse(r.kind)
    const value = r.value
    // check: boolean | count: število | text: niz — neveljavno preskočimo
    let val: boolean | number | string
    if (kind === 'check') {
      if (typeof value !== 'boolean') continue
      val = value
    } else if (kind === 'count') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      val = value
    } else {
      if (typeof value !== 'string') continue
      val = value
    }
    out[k] = {
      kind,
      value: val,
      at: String(r.at ?? ''),
      byId: String(r.byId ?? ''),
      byName: String(r.byName ?? ''),
    }
  }
  return out
}

/* ═══════════════ 3. TERMINI (occurrences — sedem pogostosti) ═══════════════ */

/** Polja predloge, ki jih terminski motor potrebuje. */
export interface ChecklistScheduleFields {
  id: string
  repeat: ChecklistRepeat
  weekday: number | null
  monthDay: number | null
  anchorDate: string
  dueTime: string
}

export interface ChecklistOccurrence {
  /** `${templateId}|YYYY-MM-DD` — stabilna identiteta termina (dedup, @@unique). */
  key: string
  templateId: string
  /** lokalni datum termina YYYY-MM-DD. */
  date: string
  /** UTC trenutek zapadlosti. */
  dueAt: Date
}

/** Število dni med dvema lokalnima datumoma (koledarsko, UTC-polnoč). */
function dayNumber(date: LocalDate): number {
  return Math.floor(Date.UTC(date.y, date.m - 1, date.d) / 86_400_000)
}

/** Število mesecev od (y1,m1) do (y2,m2) — (2026-01 → 2026-04) = 3. */
function monthDiff(a: LocalDate, b: LocalDate): number {
  return (b.y - a.y) * 12 + (b.m - a.m)
}

/** Lokalni LocalDate iz ključa YYYY-MM-DD (defenzivno; neveljaven → null). */
export function localDateFromKey(key: string): LocalDate | null {
  if (!isValidDateKey(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  return { y, m, d }
}

/**
 * Termin predloge za določen LOKALNI datum (ali null, če ta dan ni termina).
 *
 * Pogostosti (Lightspeed marec 2026 — vseh sedem):
 *  - daily: vsak dan;
 *  - weekly: ujemanje tedenskega dne (1 = pon … 7 = ned);
 *  - biweekly: weekly + faza — (dni od anchorDate) % 14 === 0;
 *  - every4weeks: weekly + faza — (dni od anchorDate) % 28 === 0;
 *  - monthly: datum dneva === monthDay (1–28, brez amputacije februarja);
 *  - quarterly/semiannual: monthly + meseci od anchorja % 3 oziroma % 6.
 *
 * anchorDate (startni datum): pred prvim dnem NI terminov — SAMO kadar je
 * podan (daily/weekly/monthly brez anchorja se ponavljajo od nekdaj). Za
 * tedenske razrede je anchor tudi NOSILEC FAZE (kateri teden je »prvi«),
 * za kvartalne/semestralne nosilec meseca; večtedenske brez anchorja
 * (samo ročno editirani podatki — pisanje jih zahteva) padejo na 1. 1.
 * tekočega leta (faza ostane deterministična — documented fallback).
 */
export function checklistOccurrenceForDate(
  template: ChecklistScheduleFields,
  date: LocalDate,
  timeZone: string,
): ChecklistOccurrence | null {
  const hasAnchor = isValidDateKey(template.anchorDate)
  const anchor = localDateFromKey(template.anchorDate) ?? { y: date.y, m: 1, d: 1 }
  // startni datum: dni PRED anchorjem nimajo termina (Lightspeed »first day«)
  if (hasAnchor && dayNumber(date) < dayNumber(anchor)) return null

  const daysFromAnchor = dayNumber(date) - dayNumber(anchor)
  const monthsFromAnchor = monthDiff(anchor, date)

  switch (template.repeat) {
    case 'daily':
      break
    case 'weekly': {
      if (template.weekday === null || localWeekday(date) !== template.weekday) return null
      break
    }
    case 'biweekly': {
      if (template.weekday === null || localWeekday(date) !== template.weekday) return null
      if (daysFromAnchor % 14 !== 0) return null
      break
    }
    case 'every4weeks': {
      if (template.weekday === null || localWeekday(date) !== template.weekday) return null
      if (daysFromAnchor % 28 !== 0) return null
      break
    }
    case 'monthly': {
      if (template.monthDay === null || date.d !== template.monthDay) return null
      break
    }
    case 'quarterly': {
      if (template.monthDay === null || date.d !== template.monthDay) return null
      if (monthsFromAnchor % 3 !== 0) return null
      break
    }
    case 'semiannual': {
      if (template.monthDay === null || date.d !== template.monthDay) return null
      if (monthsFromAnchor % 6 !== 0) return null
      break
    }
    default:
      return null
  }

  const [hh, mm] = isValidDueTime(template.dueTime ?? '')
    ? (template.dueTime as string).split(':').map(Number)
    : [9, 0]
  const dueAt = zonedTimeToUtc(date.y, date.m, date.d, hh, mm, timeZone)
  return { key: `${template.id}|${localDateKey(date)}`, templateId: template.id, date: localDateKey(date), dueAt }
}

/* ═══════════════ 4. PLOŠČA (stanja + pokritost) ═══════════════ */

export type ChecklistBoardState = 'overdue' | 'pending' | 'upcoming' | 'completed'

/** Koliko postavk ima odziv (pokritost n/N — tudi delna je vidna). */
export function coverageOf(template: { items: ChecklistItem[] }, results: ItemResultsMap): { done: number; total: number } {
  const done = template.items.filter((it) => results[it.id] !== undefined).length
  return { done, total: template.items.length }
}

export interface ChecklistBoardItem {
  template: ChecklistTemplate
  date: string
  dueAt: string // ISO
  state: ChecklistBoardState
  progress: { done: number; total: number }
  run: ChecklistRunView | null
}

/**
 * Plošča terminov: zadnjih daysBack dni + daysFwd naprej po LOKALNEM
 * koledarju (vzorec buildSchedule — haccp-ops). Dnevi brez izvedbe, katerih
 * rok je pretekel, so ZAPADLI (ista poštenost kot HACCP plošča).
 * Zaključena izvedba (state completed) pokrije termin kdorkoli je izvajal.
 */
export function buildChecklistBoard(
  templates: ChecklistTemplate[],
  runsByOccurrence: Map<string, ChecklistRunView>,
  timeZone: string,
  now: Date,
  daysBack: number,
  daysFwd: number,
): ChecklistBoardItem[] {
  const today = zonedDateParts(now, timeZone)
  const items: ChecklistBoardItem[] = []
  const active = templates.filter((t) => t.active)
  for (const template of active) {
    for (let off = -daysBack; off <= daysFwd; off++) {
      const d = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
      const date: LocalDate = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
      const occ = checklistOccurrenceForDate(template, date, timeZone)
      if (!occ) continue
      const run = runsByOccurrence.get(occ.key) ?? null
      let state: ChecklistBoardState
      if (run?.state === 'completed') {
        state = 'completed'
      } else if (occ.dueAt.getTime() <= now.getTime()) {
        state = 'overdue'
      } else if (off === 0) {
        state = 'pending'
      } else {
        state = 'upcoming'
      }
      items.push({
        template,
        date: occ.date,
        dueAt: occ.dueAt.toISOString(),
        state,
        progress: coverageOf(template, run?.itemResults ?? {}),
        run,
      })
    }
  }
  // najprej zapadli (najnovejši datum najprej), potem v teku, prihajajoči, zaključeni
  const rank: Record<ChecklistBoardState, number> = { overdue: 0, pending: 1, upcoming: 2, completed: 3 }
  return items.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      a.dueAt.localeCompare(b.dueAt) ||
      a.template.name.localeCompare(b.template.name, 'sl'),
  )
}

/* ═══════════════ 5. STROGA VALIDACIJA PISANJA (PUT predlog) ═══════════════ */

export interface ChecklistValidationResult {
  templates: ChecklistTemplate[]
  error: string | null
}

/**
 * Stroga validacija telesa PUT /api/checklists/templates (napaka je NAPAKA —
 * branje je defenzivno, pisanje pa ne tiho popravlja; vzorec pacing rute).
 * Mejne vrednosti so enake mejam parseChecklistTemplates (20 predlog,
 * 40 postavk, ime 80, oznaka 160) — ena resnica o mejah.
 */
export function validateChecklistTemplates(raw: unknown): ChecklistValidationResult {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { templates?: unknown }).templates)) {
    return { templates: [], error: 'Podajte polje "templates".' }
  }
  const list = (raw as { templates: unknown[] }).templates
  if (list.length > 20) return { templates: [], error: 'Največ 20 predlog seznamov na lokacijo.' }

  const seenTpl = new Set<string>()
  const out: ChecklistTemplate[] = []
  for (const t of list) {
    if (!t || typeof t !== 'object') return { templates: [], error: 'Neveljavna predloga seznama.' }
    const row = t as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const name = String(row.name ?? '').trim()
    if (!id) return { templates: [], error: 'Predloga potrebuje id.' }
    if (seenTpl.has(id)) return { templates: [], error: `Podvojen id predloge: ${id}.` }
    seenTpl.add(id)
    if (!name) return { templates: [], error: `Predloga ${id} potrebuje ime.` }
    if (name.length > 80) return { templates: [], error: `Ime predloge ${id} je predolgo (največ 80 znakov).` }

    const repeat = asRepeat(row.repeat)
    if (!repeat) {
      return { templates: [], error: `Predloga ${name}: neveljavna ponovitev (dovoljene: ${CHECKLIST_REPEATS.join(', ')}).` }
    }

    const category = asCategory(row.category)
    const weekdayRaw = row.weekday === null || row.weekday === undefined ? null : Number(row.weekday)
    const monthDayRaw = row.monthDay === null || row.monthDay === undefined ? null : Number(row.monthDay)

    if (repeat === 'weekly' || repeat === 'biweekly' || repeat === 'every4weeks') {
      if (weekdayRaw === null || !Number.isInteger(weekdayRaw) || weekdayRaw < 1 || weekdayRaw > 7) {
        return { templates: [], error: `Predloga ${name}: tedenska ponovitev potrebuje dan v tednu (1 = pon … 7 = ned).` }
      }
    }
    if (repeat === 'monthly' || repeat === 'quarterly' || repeat === 'semiannual') {
      if (monthDayRaw === null || !Number.isInteger(monthDayRaw) || monthDayRaw < 1 || monthDayRaw > 28) {
        return { templates: [], error: `Predloga ${name}: mesečna ponovitev potrebuje dan v mesecu (1–28).` }
      }
    }
    if (repeat === 'biweekly' || repeat === 'every4weeks' || repeat === 'quarterly' || repeat === 'semiannual') {
      if (!isValidDateKey(row.anchorDate)) {
        return { templates: [], error: `Predloga ${name}: večtedenska/mesečna faza potrebuje prvi dan (YYYY-MM-DD).` }
      }
    }

    const dueTime = String(row.dueTime ?? '').trim()
    if (!isValidDueTime(dueTime)) {
      return { templates: [], error: `Predloga ${name}: rok mora biti v obliki HH:MM (00:00–23:59).` }
    }

    if (!Array.isArray(row.items) || row.items.length === 0) {
      return { templates: [], error: `Predloga ${name} potrebuje vsaj eno postavko.` }
    }
    if (row.items.length > 40) return { templates: [], error: `Predloga ${name}: največ 40 postavk.` }

    const seenItem = new Set<string>()
    const items: ChecklistItem[] = []
    for (const it of row.items) {
      if (!it || typeof it !== 'object') return { templates: [], error: `Predloga ${name}: neveljavna postavka.` }
      const irow = it as Record<string, unknown>
      const iid = String(irow.id ?? '').trim()
      const label = String(irow.label ?? '').trim()
      if (!iid) return { templates: [], error: `Predloga ${name}: postavka potrebuje id.` }
      if (seenItem.has(iid)) return { templates: [], error: `Predloga ${name}: podvojen id postavke ${iid}.` }
      seenItem.add(iid)
      if (!label) return { templates: [], error: `Predloga ${name}: postavka potrebuje besedilo.` }
      if (label.length > 160) {
        return { templates: [], error: `Predloga ${name}: besedilo postavke je predolgo (največ 160 znakov).` }
      }
      const response = irow.response
      if (!CHECKLIST_ITEM_RESPONSES.includes(response as ChecklistItemResponse)) {
        return { templates: [], error: `Predloga ${name}: odzivni tip postavke mora biti check, count ali text.` }
      }
      items.push({ id: iid, label, response: response as ChecklistItemResponse })
    }

    const anchorDate = row.anchorDate === undefined || row.anchorDate === null ? '' : String(row.anchorDate)
    out.push({
      id,
      name,
      category,
      repeat,
      weekday: weekdayRaw !== null && Number.isInteger(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 7 ? weekdayRaw : null,
      monthDay:
        monthDayRaw !== null && Number.isInteger(monthDayRaw) && monthDayRaw >= 1 && monthDayRaw <= 28 ? monthDayRaw : null,
      anchorDate: isValidDateKey(anchorDate) ? anchorDate : '',
      dueTime,
      active: row.active === undefined ? true : Boolean(row.active),
      items,
    })
  }
  return { templates: out, error: null }
}

/* ═══════════════ 6. IZVEDBA (strežniška izpeljava zaključka) ═══════════════ */

/**
 * Ali je seznam ZAKLJUČEN? Strežnik odloča iz pokritosti postavk (klient
 * NE more prijaviti "completed" — enaka disciplina kot evalMeasurement):
 * zaključen, ko ima VSAKA postavka predloge veljaven odziv v itemResults.
 */
export function runCompletedFromCoverage(template: ChecklistTemplate, results: ItemResultsMap): boolean {
  return template.items.length > 0 && template.items.every((it) => results[it.id] !== undefined)
}

/**
 * Vsi occurrence ključi okna (daysBack dni nazaj + daysFwd naprej po lokalnem
 * koledarju) — za NATAČEN fetch izvedb po indeksu (board ruta poizveduje
 * occurrenceKey IN […], ne LIKE — vzorec HACCP occurrenceKey dedup).
 */
export function occurrenceKeysForWindow(
  templates: ChecklistTemplate[],
  timeZone: string,
  now: Date,
  daysBack: number,
  daysFwd: number,
): string[] {
  const today = zonedDateParts(now, timeZone)
  const keys: string[] = []
  for (const template of templates) {
    if (!template.active) continue
    for (let off = -daysBack; off <= daysFwd; off++) {
      const d = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
      const date: LocalDate = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
      const occ = checklistOccurrenceForDate(template, date, timeZone)
      if (occ) keys.push(occ.key)
    }
  }
  return keys
}

/** Minimalna oblika odjemalca za branje predlog (db ali transakcija). */
type ChecklistsReader = Pick<Prisma.TransactionClient, 'integration'>

/** Prebere predloge seznamov lokacije (brez vrstice → prazno). */
export async function loadChecklistTemplates(client: ChecklistsReader, locationId: string): Promise<ChecklistTemplate[]> {
  const row = await client.integration.findFirst({
    where: { name: OPS_CHECKLISTS_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parseChecklistTemplates(row?.config)
}

/* ═══════════════ 7. CAPABILITY PROBE (haccp-plans vzorec) ═══════════════ */

/**
 * Ali tabela ChecklistRun obstaja na trenutni bazi? (vzorec haccpPlansAvailable
 * v1.62.0): memoizirano 60 s — Vercel lambda instance se po DDL apliciranju
 * samozdravijo najpozneje v minuti brez redeploya; mig ruta resetira probo v
 * istem procesu. Infrastrukturne napake (P1001 …) NE veljajo za "DDL pending"
 * — probe vrne true in dejanska poizvedba pokaže pravo napako (brez maskiranja).
 */
const RUNS_PROBE_TTL_MS = 60_000
let runsProbeCache: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL apliciranju / v testih). Z vrednostjo jo vsili. */
export function resetChecklistRunsProbe(value?: boolean): void {
  runsProbeCache = value === undefined ? null : { value: value, at: Date.now() }
}

export async function checklistRunsAvailable(): Promise<boolean> {
  if (runsProbeCache && Date.now() - runsProbeCache.at < RUNS_PROBE_TTL_MS) return runsProbeCache.value
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "ChecklistRun" LIMIT 1')
    runsProbeCache = { value: true, at: Date.now() }
  } catch (e) {
    const { isMissingSchemaError } = await import('./prisma-missing')
    runsProbeCache = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return runsProbeCache.value
}

/** Kanonična referenca na db (en sam vir za teste/reputacijo — combosDb vzorec). */
export const checklistsDb = db
