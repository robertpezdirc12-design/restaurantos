/**
 * Issue #1 sklop ⑦ — Odpiralni čas restavracije (čista logika, brez I/O).
 *
 * Kanonični model: OpeningHours (tedenski vrstni red, @@unique([locationId, dayOfWeek]))
 * + SpecialOpeningDay (posebni dnevi/prazniki, @@unique([locationId, date])).
 *
 * Konvencije:
 *  - dayOfWeek 0-6, 0 = nedelja (JS `Date.getDay()` konvencija).
 *  - Časi so nizi "HH:MM" (00:00-23:59). Overnight okno: closeTime < openTime
 *    pomeni okno čez polnoč (npr. 20:00 → 02:00).
 *  - Odmor (breakStart/breakEnd) je znotraj okna istega dne (prek polnoči:
 *    ovrednoten v odprtih minutah okna).
 *  - Prioriteta statusa: posebni dan > tedenska vrstica > zaprto.
 */

export interface OpeningRow {
  dayOfWeek: number
  openTime: string
  closeTime: string
  breakStart: string
  breakEnd: string
  isClosed: boolean
}

export interface SpecialDay {
  date: string // YYYY-MM-DD
  isClosed: boolean
  openTime: string
  closeTime: string
  note: string
}

export const DAY_NAMES_SL = ['Nedelja', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota'] as const
export const DAY_SHORT_SL = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'] as const

/* ─────────────────────────── časovni pomočniki ─────────────────────────── */

/** "HH:MM" → minute od polnoči (0-1439) ali null, če oblika ni veljavna. */
export function parseHHMM(s: string): number | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** minute od polnoči → "HH:MM" (normira "9:05" → "09:05"). */
export function fmtHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "YYYY-MM-DD" iz Date v LOCALnem času (ne UTC — status mora slediti lokalu). */
export function toLocalDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function isValidDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** Date → { dateKey, dayOfWeek, minutes } v lokalnem času. */
export function localParts(d: Date): { dateKey: string; dayOfWeek: number; minutes: number } {
  return {
    dateKey: toLocalDateKey(d),
    dayOfWeek: d.getDay(),
    minutes: d.getHours() * 60 + d.getMinutes(),
  }
}

/* ─────────────────────────── validacija tedenskih vrstic ─────────────────────────── */

export interface ValidatedRow extends OpeningRow {
  openMin: number
  closeMin: number // lahko > 1440 za overnight (close+1440)
  breakStartMin: number | null
  breakEndMin: number | null
}

/**
 * Validira vnosnih 7 tedenskih vrstic (ena na dayOfWeek 0-6).
 * Vrne normalizirane vrstice z razčlenjenimi minutami ali { error } z SL sporočilom.
 */
export function validateOpeningHoursRows(
  rows: unknown
): { ok: true; rows: ValidatedRow[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: 'Vrstice odpiralnega časa manjkajo.' }
  if (rows.length !== 7) return { ok: false, error: 'Potrebnih je točno 7 vrstic (po ena za vsak dan).' }

  const seen = new Set<number>()
  const out: ValidatedRow[] = []

  for (const r of rows) {
    const row = r as Partial<OpeningRow>
    const dow = Number(row.dayOfWeek)
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return { ok: false, error: 'Dan v tednu mora biti med 0 (nedelja) in 6 (sobota).' }
    if (seen.has(dow)) return { ok: false, error: `Podvojen dan v tednu: ${DAY_NAMES_SL[dow]}.` }
    seen.add(dow)

    if (row.isClosed) {
      out.push({ dayOfWeek: dow, openTime: '', closeTime: '', breakStart: '', breakEnd: '', isClosed: true, openMin: 0, closeMin: 0, breakStartMin: null, breakEndMin: null })
      continue
    }

    const openMin = parseHHMM(String(row.openTime ?? ''))
    if (openMin === null) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odpiralni čas ni veljaven (pričakovano HH:MM).` }
    const closeRaw = parseHHMM(String(row.closeTime ?? ''))
    if (closeRaw === null) return { ok: false, error: `${DAY_NAMES_SL[dow]}: zapiralni čas ni veljaven (pričakovano HH:MM).` }
    if (openMin === closeRaw) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odpiralni in zapiralni čas ne smeta biti enaka (za 24-urno delo uporabite 00:00 kot zapiralni).` }

    // overnight: closeMin < openMin → okno čez polnoč (npr. 20:00 → 02:00)
    const closeMin = closeRaw < openMin ? closeRaw + 1440 : closeRaw

    let breakStartMin: number | null = null
    let breakEndMin: number | null = null
    const bs = String(row.breakStart ?? '')
    const be = String(row.breakEnd ?? '')
    if (bs || be) {
      breakStartMin = parseHHMM(bs)
      breakEndMin = parseHHMM(be)
      if (breakStartMin === null || breakEndMin === null) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odmor mora imeti oba časa (začetek in konec, HH:MM).` }
      // efektivne minute: čas pred odpiranjem = rep overnight okna (+1440)
      const bsEff = breakStartMin < openMin ? breakStartMin + 1440 : breakStartMin
      const beEff = breakEndMin < openMin ? breakEndMin + 1440 : breakEndMin
      if (bsEff >= beEff) return { ok: false, error: `${DAY_NAMES_SL[dow]}: začetek odmora mora biti pred koncem odmora.` }
      if (bsEff < openMin || beEff > closeMin) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odmor mora ležati znotraj odpiralnega časa (${fmtHHMM(openMin)}–${fmtHHMM(closeMin)}).` }
    }

    out.push({
      dayOfWeek: dow,
      openTime: fmtHHMM(openMin),
      closeTime: fmtHHMM(closeMin),
      breakStart: breakStartMin !== null ? fmtHHMM(breakStartMin) : '',
      breakEnd: breakEndMin !== null ? fmtHHMM(breakEndMin) : '',
      isClosed: false,
      openMin, closeMin, breakStartMin, breakEndMin,
    })
  }

  return { ok: true, rows: out }
}

/**
 * Delna validacija (za gatenje rezervacij): vsaka vrstica se validira posamezno,
 * brez zahteve po 7 dnevih — nekonfigurirani dnevi preprosto ne obstajajo.
 */
export function validateOpeningHoursRowsPartial(rows: unknown): { ok: true; rows: ValidatedRow[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: 'Vrstice odpiralnega časa manjkajo.' }
  const out: ValidatedRow[] = []
  for (const r of rows) {
    const row = r as Partial<OpeningRow>
    const dow = Number(row.dayOfWeek)
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return { ok: false, error: 'Dan v tednu mora biti med 0 (nedelja) in 6 (sobota).' }
    if (row.isClosed) {
      out.push({ dayOfWeek: dow, openTime: '', closeTime: '', breakStart: '', breakEnd: '', isClosed: true, openMin: 0, closeMin: 0, breakStartMin: null, breakEndMin: null })
      continue
    }
    const openMin = parseHHMM(String(row.openTime ?? ''))
    if (openMin === null) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odpiralni čas ni veljaven (pričakovano HH:MM).` }
    const closeRaw = parseHHMM(String(row.closeTime ?? ''))
    if (closeRaw === null) return { ok: false, error: `${DAY_NAMES_SL[dow]}: zapiralni čas ni veljaven (pričakovano HH:MM).` }
    if (openMin === closeRaw) return { ok: false, error: `${DAY_NAMES_SL[dow]}: odpiralni in zapiralni čas ne smeta biti enaka.` }
    const closeMin = closeRaw < openMin ? closeRaw + 1440 : closeRaw
    out.push({
      dayOfWeek: dow,
      openTime: fmtHHMM(openMin),
      closeTime: fmtHHMM(closeMin),
      breakStart: '', breakEnd: '',
      isClosed: false,
      openMin, closeMin, breakStartMin: null, breakEndMin: null,
    })
  }
  return { ok: true, rows: out.sort((a, b) => a.dayOfWeek - b.dayOfWeek) }
}

/* ─────────────────────────── validacija posebnega dne ─────────────────────────── */

export function validateSpecialDayInput(body: { date?: unknown; isClosed?: unknown; openTime?: unknown; closeTime?: unknown; note?: unknown }):
  { ok: true; day: SpecialDay } | { ok: false; error: string } {
  const date = String(body.date ?? '')
  if (!isValidDateKey(date)) return { ok: false, error: 'Datum ni veljaven (pričakovano YYYY-MM-DD).' }
  const note = String(body.note ?? '').trim()
  if (note.length > 200) return { ok: false, error: 'Opomba je lahko dolga največ 200 znakov.' }
  if (body.isClosed === undefined || body.isClosed === null || body.isClosed === true) {
    return { ok: true, day: { date, isClosed: true, openTime: '', closeTime: '', note } }
  }
  const openMin = parseHHMM(String(body.openTime ?? ''))
  if (openMin === null) return { ok: false, error: 'Odpiralni čas posebnega dne ni veljaven (HH:MM).' }
  const closeMin = parseHHMM(String(body.closeTime ?? ''))
  if (closeMin === null) return { ok: false, error: 'Zapiralni čas posebnega dne ni veljaven (HH:MM).' }
  if (openMin === closeMin) return { ok: false, error: 'Odpiralni in zapiralni čas ne smeta biti enaka.' }
  return { ok: true, day: { date, isClosed: false, openTime: fmtHHMM(openMin), closeTime: fmtHHMM(closeMin), note } }
}

/* ─────────────────────────── odprto/zaprto ob dani minuti ─────────────────────────── */

/** Je "minutes" (od polnoči, možno > 1440 za prek polnoči) znotraj okna vrstice (brez odmora)? */
export function isOpenAtMinute(row: ValidatedRow, minutes: number): { inside: boolean; onBreak: boolean } {
  if (row.isClosed) return { inside: false, onBreak: false }
  let t = minutes
  if (t < row.openMin) t += 1440
  if (t < row.openMin || t >= row.closeMin) return { inside: false, onBreak: false } // pokrije tudi 24h+ (t-1440)
  if (row.breakStartMin !== null && row.breakEndMin !== null) {
    const bs = row.breakStartMin < row.openMin ? row.breakStartMin + 1440 : row.breakStartMin
    const be = row.breakEndMin < row.openMin ? row.breakEndMin + 1440 : row.breakEndMin
    if (t >= bs && t < be) return { inside: true, onBreak: true }
  }
  return { inside: true, onBreak: false }
}

/* ─────────────────────────── trenutni status ─────────────────────────── */

export type OpenPhase = 'open' | 'break' | 'closed_day' | 'special_closed' | 'special_hours' | 'outside_hours'

export interface OpenStatus {
  isOpen: boolean
  phase: OpenPhase
  /** Kratka oznaka: "Odprto" / "Na odmoru" / "Zaprto" */
  label: string
  /** Podrobnost v SL: kdaj se odpre/zapre, zakaj je zaprto … */
  detail: string
  /** Naslednji prehod (ISO timestamp) ali null, če ni znan v 8 dneh. */
  nextChangeAt: string | null
  /** "Zapre se ob 22:00" / "Odpre se v ponedeljek ob 08:00" */
  nextChangeLabel: string
}

function specialForDate(specials: SpecialDay[], dateKey: string): SpecialDay | undefined {
  return specials.find((s) => s.date === dateKey)
}

function rowForDay(rows: ValidatedRow[], dayOfWeek: number): ValidatedRow | undefined {
  return rows.find((r) => r.dayOfWeek === dayOfWeek)
}

interface SpanEvent { atMs: number; kind: 'open' | 'close' | 'break_start' | 'break_end' }

/** Absolutni dogodki (ms) za dan datum+tedensko vrstico; overnight zaključi naslednji dan. */
function eventsForDate(base: Date, row: ValidatedRow | undefined, special: SpecialDay | undefined): SpanEvent[] {
  const ev: SpanEvent[] = []
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()
  const mk = (min: number) => dayStart + min * 60_000

  if (special) {
    if (special.isClosed) return []
    const o = parseHHMM(special.openTime)
    const c = parseHHMM(special.closeTime)
    if (o === null || c === null) return []
    const closeMin = c <= o ? c + 1440 : c
    ev.push({ atMs: mk(o), kind: 'open' }, { atMs: mk(closeMin), kind: 'close' })
    return ev
  }
  if (!row || row.isClosed) return []
  ev.push({ atMs: mk(row.openMin), kind: 'open' }, { atMs: mk(row.closeMin), kind: 'close' })
  if (row.breakStartMin !== null && row.breakEndMin !== null) {
    const bs = row.breakStartMin < row.openMin ? row.breakStartMin + 1440 : row.breakStartMin
    const be = row.breakEndMin < row.openMin ? row.breakEndMin + 1440 : row.breakEndMin
    if (be > bs) ev.push({ atMs: mk(bs), kind: 'break_start' }, { atMs: mk(be), kind: 'break_end' })
  }
  return ev
}

/** Prvi dogodek striktno po `nowMs` v naslednjih 9 dneh (dan 0 danes + overnight zaključki). */
export function nextChange(rows: ValidatedRow[], specials: SpecialDay[], now: Date): { atMs: number; label: string } | null {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let best: SpanEvent | null = null
  for (let i = 0; i <= 8; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const row = rowForDay(rows, d.getDay())
    const sp = specialForDate(specials, toLocalDateKey(d))
    for (const e of eventsForDate(d, row, sp)) {
      if (e.atMs > now.getTime() && (!best || e.atMs < best.atMs)) best = e
    }
  }
  if (!best) return null
  const at = new Date(best.atMs)
  const dayDiff = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()) / 86_400_000)
  const time = fmtHHMM(at.getHours() * 60 + at.getMinutes())
  const dayLabel = dayDiff === 0 ? '' : dayDiff === 1 ? 'jutri ' : `v ${DAY_NAMES_SL[at.getDay()].toLowerCase()} `
  const verb = best.kind === 'open' ? 'Odpre se' : best.kind === 'close' ? 'Zapre se' : best.kind === 'break_start' ? 'Odmor od' : 'Nadaljuje'
  return { atMs: best.atMs, label: `${verb} ${dayLabel}ob ${time}` }
}

/**
 * Status za zdaj: posebni dan > tedenska vrstica > zaprto.
 */
export function currentStatus(rows: ValidatedRow[], specials: SpecialDay[], now: Date = new Date()): OpenStatus {
  const { dateKey, dayOfWeek, minutes } = localParts(now)
  const special = specialForDate(specials, dateKey)
  const row = rowForDay(rows, dayOfWeek)
  const nc = () => nextChange(rows, specials, now)

  if (special) {
    if (special.isClosed) {
      const n = nc()
      return { isOpen: false, phase: 'special_closed', label: 'Zaprto', detail: special.note ? `Zaprto (poseben dan: ${special.note})` : 'Zaprto — poseben dan', nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
    }
    const o = parseHHMM(special.openTime)
    const c = parseHHMM(special.closeTime)
    if (o !== null && c !== null) {
      const closeMin = c <= o ? c + 1440 : c
      let t = minutes
      if (t < o) t += 1440
      if (t >= o && t < closeMin) {
        const n = nextChange([], [{ ...special }], now)
        return { isOpen: true, phase: 'special_hours', label: 'Odprto', detail: `Odprto po posebnem urniku (${special.openTime}–${special.closeTime})${special.note ? ` — ${special.note}` : ''}`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? 'Zapre se' }
      }
      const n = nc()
      return { isOpen: false, phase: 'special_hours', label: 'Zaprto', detail: `Zaprto — poseben urnik (${special.openTime}–${special.closeTime})${special.note ? ` — ${special.note}` : ''}`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
    }
  }

  if (row && !row.isClosed) {
    const st = isOpenAtMinute(row, minutes)
    const n = nc()
    if (st.inside && !st.onBreak) {
      return { isOpen: true, phase: 'open', label: 'Odprto', detail: `Danes: ${row.openTime}–${row.closeTime}`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
    }
    if (st.onBreak) {
      return { isOpen: false, phase: 'break', label: 'Na odmoru', detail: `Odmor ${row.breakStart}–${row.breakEnd} — nadaljujemo ob ${row.breakEnd}`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
    }
    return { isOpen: false, phase: 'outside_hours', label: 'Zaprto', detail: `Danes: ${row.openTime}–${row.closeTime}`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
  }

  const n = nc()
  return { isOpen: false, phase: 'closed_day', label: 'Zaprto', detail: `Danes zaprto (${DAY_NAMES_SL[dayOfWeek]})`, nextChangeAt: n ? new Date(n.atMs).toISOString() : null, nextChangeLabel: n?.label ?? '' }
}

/* ─────────────────────────── uporaba pri rezervacijah ─────────────────────────── */

export interface OutsideHoursResult {
  outside: boolean
  reason: 'closed_day' | 'special_closed' | 'outside_hours' | 'break' | 'special_hours_outside' | null
  label: string
}

/**
 * Ali rezervacija (DateTime) pada izven odpiralnega časa?
 * Uporaba pri rezervacijah (triage ⑦): POST /api/reservations → 409 z razlago,
 * upravitelj lahko izrecno preglasi (allowOutsideHours).
 */
export function outsideHoursFor(rows: ValidatedRow[], specials: SpecialDay[], when: Date): OutsideHoursResult {
  const { dateKey, dayOfWeek, minutes } = localParts(when)
  const special = specialForDate(specials, dateKey)
  if (special?.isClosed) return { outside: true, reason: 'special_closed', label: special.note ? `${dateKey} je zaprto (${special.note})` : `${dateKey} je zaprto (poseben dan)` }
  if (special) {
    // poseben odprti urnik popolnoma nadomesti tedensko vrstico
    const o = parseHHMM(special.openTime)
    const c = parseHHMM(special.closeTime)
    if (o !== null && c !== null) {
      const closeMin = c <= o ? c + 1440 : c
      let t = minutes
      if (t < o) t += 1440
      if (t < o || t >= closeMin) {
        return { outside: true, reason: 'special_hours_outside', label: `Poseben urnik: ${special.openTime}–${special.closeTime}${special.note ? ` — ${special.note}` : ''}` }
      }
      return { outside: false, reason: null, label: '' }
    }
  }
  const row = rowForDay(rows, dayOfWeek)
  // brez vnosa za ta dan = brez omejitve (delni podatki ne smejo blokirati obstoječih rezervacij)
  if (!row) return { outside: false, reason: null, label: '' }
  if (row.isClosed) return { outside: true, reason: 'closed_day', label: `${DAY_NAMES_SL[dayOfWeek]} je zaprto` }
  const st = isOpenAtMinute(row, minutes)
  if (st.onBreak) return { outside: true, reason: 'break', label: `Ob rezervaciji je odmor (${row.breakStart}–${row.breakEnd})` }
  if (!st.inside) return { outside: true, reason: 'outside_hours', label: `Rezervacija je izven odpiralnega časa (${row.openTime}–${row.closeTime})` }
  return { outside: false, reason: null, label: '' }
}

/* ─────────────────────────── slovenski prazniki (dela prost dan) ─────────────────────────── */

/** Gregorijanska Velika noč (anonimni algoritem) — vrne dan v letu za mesečno/dnevno računanje. */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export interface Holiday { date: string; name: string }

/** Državni prazniki in dela prosti dnevi v Sloveniji za podano leto (računski Velika noč + binkošti). */
export function slovenianHolidays(year: number): Holiday[] {
  const easter = easterSunday(year)
  const fixed: [number, number, string][] = [
    [1, 1, 'Novo leto'],
    [2, 8, 'Prešernov dan, slovenski kulturni praznik'],
    [4, 27, 'Dan upora proti okupatorju'],
    [5, 1, 'Praznik dela'],
    [5, 2, 'Praznik dela'],
    [6, 25, 'Dan državnosti'],
    [8, 15, 'Marijino vnebovzetje'],
    [11, 1, 'Dan spomina na mrtve'],
    [12, 25, 'Božič'],
    [12, 26, 'Dan samostojnosti in enotnosti'],
  ]
  const list: Holiday[] = fixed.map(([m, d, name]) => ({ date: toLocalDateKey(new Date(year, m - 1, d)), name }))
  list.push({ date: toLocalDateKey(addDays(easter, 1)), name: 'Velikonočni ponedeljek' })
  list.push({ date: toLocalDateKey(addDays(easter, 49)), name: 'Binkošti' })
  return list.sort((x, y) => x.date.localeCompare(y.date))
}

/** Naslednjih `days` prihodnjih posebnih dni (od danes − 1 za zgodovino). */
export function upcomingSpecialDays(specials: SpecialDay[], now: Date = new Date(), days = 60): SpecialDay[] {
  const from = toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const to = toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days))
  return specials.filter((s) => s.date >= from && s.date <= to).sort((a, b) => a.date.localeCompare(b.date))
}
