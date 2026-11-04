/**
 * v1.250.0 (PRIMERJAVA-VMESNIKOV-2026 §24 — TEMPO INSIGHTS VAL; Lightspeed
 * junij 2026 Tempo »service insights«: »tables with the most empty time and
 * orders with the longest service gaps«): čista agregacijska plast nad
 * OBSTOJEČIMI podatki — 0 DDL, 0 novih odvisnosti.
 *
 * Dve merili (dopolnilo KDS statistikam, ne podvajanje — KDS gleda POSTAVKO/
 * POSTAJO (firedAt→readyAt), Tempo gleda MIZO/NAROČILO end-to-end):
 *
 *  1. PRAZNI ČAS MIZ — koliko odprtih ur je bila miza fizično prosta.
 *     Zasedenost = UNIJA intervalov naročil na mizi (plačana: createdAt→paidAt;
 *     odprta: createdAt→meja okna; preklicana: createdAt→cancelledAt — tudi
 *     preklic je BLOKIRAL mizo, prihodek pa je 0). Prazno = odprte ure −
 *     zasedenost (mreža tedenskih ur + posebni dnevi lokacije, odmik kosila
 *     NI del odprtih ur; intervali se srežejo na okno [since, now]).
 *  2. SERVISNE LUKNJE — plačana naročila (disciplina staff-performance/
 *     sales-by-hour: paidAt >= since), po naročilu:
 *     vnos→pošiljanje (min firedAt − createdAt), prvi krožnik (min readyAt −
 *     createdAt), CELOTNA strežba (max readyAt − createdAt — vse postavke
 *     zunaj), obrat mize (paidAt − createdAt). Preklicane postavke ne štejejo;
 *     naročila brez katere koli pripravljene postavke so iskreno ločena
 *     (unknownReady), ne zlita tiho v mediane.
 *
 * Konvencija staff-performance/sales-by-hour: BREZ uvozov (0 DB, 0 I/O, 0
 * odvisnosti) — vhod so vzorci, izhod pa vrstice + statistike. Časovni pas
 * (Intl, DST-varen) je samoizrojena ista tehnika kot haccp-ops — uvoz od
 * tam bi v čisto plast vpleten db graf. Uravnovesje: ~30 vrstic izrojenega,
 * a osamljenega časa, dokumentiranega tukaj in pokritega z testi (DST rob).
 */

/* ═══════════════ 1) ČASOVNI PAS (Intl, DST-varen — tehnika haccp-ops) ═══════════════ */

/** Odmik UTC trenutka do lokalnega časa pasu (ms). DST-varen. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const m: Record<string, number> = {}
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value)
  }
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour === 24 ? 0 : m.hour, m.minute, m.second)
  return asUTC - instant.getTime()
}

/** Lokalni datumski deli trenutka v pasu (y, m 1–12, d 1–31). */
export function tempoLocalParts(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const m: Record<string, number> = {}
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') m[p.type] = Number(p.value)
  }
  return { y: m.year, m: m.month, d: m.day }
}

/** LOKALNI (y, m, d, hh, mm) v pasu → UTC trenutek (DST-varen dvostopenjski
 * ugib — prehod po pomladi/jeseni ne more zmesti ura za eno). */
export function tempoZonedTimeToUtc(
  y: number, month: number, day: number, hh: number, mm: number, timeZone: string
): Date {
  const guess = Date.UTC(y, month - 1, day, hh, mm, 0)
  const off1 = tzOffsetMs(new Date(guess), timeZone)
  let ts = guess - off1
  const off2 = tzOffsetMs(new Date(ts), timeZone)
  if (off2 !== off1) ts = guess - off2 // prehod DST med ugotavljanjem
  return new Date(ts)
}

/** ISO dan tedna lokalnega datuma: 1 = ponedeljek … 7 = nedelja. */
function localWeekday(y: number, m: number, d: number): number {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = nedelja
  return wd === 0 ? 7 : wd
}

/** 'HH:MM' → minute od polnoči; neveljavno/prazno → null (payroll parseHM vzorec). */
export function parseHm(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/* ═══════════════ 2) SPANI ODPIRALNIH UR (čista izpeljava) ═══════════════ */

/** Tedenska odpiralna vrstica lokacije (surovi OpeningHours podatki). */
export interface TempoOpeningRow {
  dayOfWeek: number // 1 = pon … 7 = ned (OpeningHours.dayOfWeek)
  openTime: string
  closeTime: string
  breakStart: string
  breakEnd: string
  isClosed: boolean
}

/** Poseben dan (SpecialOpeningDay) — POVEŽE tedensko vrstico tega datuma. */
export interface TempoSpecialDay {
  date: string // 'YYYY-MM-DD' lokalni datum
  isClosed: boolean
  openTime?: string
  closeTime?: string
}

/** UTC interval odprtih ur (ms epoch; končna strogo > začetna). */
export interface TempoServiceSpan {
  start: number
  end: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Spani odprtih ur enega LOKALNEGA dne (UTC ms). Vrstica posebnega dne
 * povozi tedensko (ista prednostnost kot rezervacijski widget); odmik kosila
 * NI odprta ura — dan z veljavnim odmikom znotraj (odprto, zaprto) da DVA
 * spana. Neveljavni časi (parseHm null, zaprto ≤ odprto, odmik izven dneva)
 * → prazen dan (iskreno 0 odprtih ur, ne zmeda). Vsi spani so prirezani na
 * [sinceMs, nowMs] — del dneva izven okna ne šteje.
 */
export function serviceSpansForLocalDay(
  dateKey: string,
  weekly: TempoOpeningRow[],
  specials: TempoSpecialDay[],
  timeZone: string,
  sinceMs: number,
  nowMs: number
): TempoServiceSpan[] {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return []
  const special = specials.find((s) => s.date === dateKey)
  const row = special
    ? // poseben dan ne pozna odmika kosila (SpecialOpeningDay ga nima) — prazen niz
      { isClosed: special.isClosed, openTime: special.openTime ?? '', closeTime: special.closeTime ?? '', breakStart: '', breakEnd: '' }
    : (() => {
        const wd = localWeekday(y, m, d)
        const hit = weekly.find((r) => r.dayOfWeek === wd)
        return hit
          ? { isClosed: hit.isClosed, openTime: hit.openTime, closeTime: hit.closeTime, breakStart: hit.breakStart, breakEnd: hit.breakEnd }
          : null
      })()
  if (!row || row.isClosed) return []

  const open = parseHm(row.openTime)
  const close = parseHm(row.closeTime)
  if (open === null || close === null || close <= open) return []

  // odmik kosila: samo kadar obe konici veljavni in znotraj odprtih ur
  const brStart = parseHm(row.breakStart ?? '')
  const brEnd = parseHm(row.breakEnd ?? '')
  const hasBreak = brStart !== null && brEnd !== null && brEnd > brStart && brStart > open && brEnd < close

  const toUtc = (min: number): number =>
    tempoZonedTimeToUtc(y, m, d, Math.floor(min / 60), min % 60, timeZone).getTime()

  const raw: Array<[number, number]> = hasBreak
    ? [[open, brStart as number], [brEnd as number, close]]
    : [[open, close]]

  const spans: TempoServiceSpan[] = []
  for (const [a, b] of raw) {
    // prirez na okno [since, now] — dan, ki sega čez mejo, prispeva le svoj del
    const start = Math.max(toUtc(a), sinceMs)
    const end = Math.min(toUtc(b), nowMs)
    if (end > start) spans.push({ start, end })
  }
  return spans
}

/**
 * Spani VSEH lokalnih dni v oknu [since, now] za eno lokacijo (tedenske
 * vrstice + posebni dnevi). Iteracija po LOKALNIH dnevih pasu (od localDate
 * since do localDate now vključno) — prelom dneva teče po lokaciji.
 */
export function serviceSpansInWindow(
  weekly: TempoOpeningRow[],
  specials: TempoSpecialDay[],
  timeZone: string,
  sinceMs: number,
  nowMs: number
): TempoServiceSpan[] {
  if (!(nowMs > sinceMs)) return []
  const from = tempoLocalParts(new Date(sinceMs), timeZone)
  const to = tempoLocalParts(new Date(nowMs), timeZone)
  const out: TempoServiceSpan[] = []
  // varovalo: največ 400 dni (okno je stežka 1..90 dni — guard proti zanki ob
  // neumnem vhodu, ne produktna meja)
  let cursor = Date.UTC(from.y, from.m - 1, from.d)
  const last = Date.UTC(to.y, to.m - 1, to.d)
  for (let i = 0; i < 400 && cursor <= last; i++) {
    const dt = new Date(cursor)
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
    out.push(...serviceSpansForLocalDay(key, weekly, specials, timeZone, sinceMs, nowMs))
    cursor += DAY_MS
  }
  return out
}

/* ═══════════════ 3) INTERVALNA MATEMATIKA (unija + presek) ═══════════════ */

/** Zaokrožitev na 1 decimalko (minute so dovolj natančne za tempo). */
const r1 = (n: number): number => Math.round((n + Number.EPSILON) * 10) / 10

/**
 * UNIJA intervalov [start, end] (ms) — sortiranje po začetku, stikajoči in
 * prekrivajoči se intervali se zlijejo. Neveljavni (konec ≤ začetek,
 * ne-koncna števila) se izpustijo (data-error guard, politika sales-by-hour).
 */
export function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const clean = list.filter(
    ([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a
  )
  clean.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: Array<[number, number]> = []
  for (const iv of clean) {
    const last = out[out.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else out.push([iv[0], iv[1]])
  }
  return out
}

/** Skupna dolžina presekov UNIJE intervalov s spani, v minutah (r1). */
export function overlapMinutes(intervals: Array<[number, number]>, spans: TempoServiceSpan[]): number {
  const merged = mergeIntervals(intervals)
  let ms = 0
  for (const span of spans) {
    if (!(span.end > span.start)) continue
    for (const [a, b] of merged) {
      const lo = Math.max(a, span.start)
      const hi = Math.min(b, span.end)
      if (hi > lo) ms += hi - lo
    }
  }
  return r1(ms / 60000)
}

/* ═══════════════ 4) PRAZNI ČAS MIZ (agregacija po mizi) ═══════════════ */

/** Registr miz (vse mize obsega — tudi nikoli uporabljene: najbolj prazna
 *  miza je tista, ki je v obdobju niso nikoli odprli). */
export interface TempoTableRef {
  tableId: string
  label: string
  locationName?: string
}

/** Eno naročilo, ki je (fizično) zasedalo mizo. */
export interface TempoTableSample {
  tableId: string
  /** Order.createdAt (ms) */
  start: number
  /** plačano: paidAt · preklicano: cancelledAt · odprto: meja okna (now) */
  end: number
  cancelled: boolean
  paid: boolean
  /** Order.total plačanega naročila (z DDV); 0 za odprta/preklicana */
  revenue: number
}

export interface TempoTableRow {
  tableId: string
  label: string
  locationName: string
  /** strežena naročila (plačana + odprta) — preklicana se ne štejejo */
  orders: number
  /** odprte ure v oknu (brez odmika kosila), minute */
  serviceMin: number
  /** fizična zasedenost (unija vseh naročil, vključno preklicanimi), minute */
  occupiedMin: number
  /** max(0, serviceMin − occupiedMin), minute */
  emptyMin: number
  /** occupied/service, 0–1 (0 kdor ni odprt) */
  utilization: number
  /** povprečen obrat PLAČANIH naročil (start→end), minute; null brez plačanih */
  avgTurnMin: number | null
  /** prihodek plačanih naročil (r2) */
  revenue: number
}

/**
 * Vrstice po mizi, padajoče po praznem času (»tables with the most empty
 * time«). Mize brez odprtih ur ostanejo v seznamu s serviceMin 0 — iskreno,
 * ne tiho skrite (UI jih loči). Stabilno razvrščanje: emptyMin desc →
 * orders asc → label asc.
 */
export function aggregateTableTempo(
  tables: TempoTableRef[],
  samples: TempoTableSample[],
  spansByTable: Record<string, TempoServiceSpan[]>
): TempoTableRow[] {
  const byTable = new Map<string, TempoTableSample[]>()
  for (const s of samples) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue
    const arr = byTable.get(s.tableId)
    if (arr) arr.push(s)
    else byTable.set(s.tableId, [s])
  }
  return tables
    .map((t) => {
      const spans = spansByTable[t.tableId] ?? []
      const serviceMin = r1(
        spans.reduce((sum, sp) => sum + (sp.end > sp.start ? sp.end - sp.start : 0), 0) / 60000
      )
      const rows = byTable.get(t.tableId) ?? []
      const intervals = rows.map((s) => [s.start, s.end] as [number, number])
      const occupiedMin = overlapMinutes(intervals, spans)
      const paidRows = rows.filter((s) => s.paid)
      const avgTurnMin =
        paidRows.length > 0
          ? r1(paidRows.reduce((sum, s) => sum + (s.end - s.start), 0) / paidRows.length / 60000)
          : null
      return {
        tableId: t.tableId,
        label: t.label,
        locationName: t.locationName ?? '',
        orders: rows.filter((s) => !s.cancelled).length,
        serviceMin,
        occupiedMin,
        emptyMin: Math.max(0, r1(serviceMin - occupiedMin)),
        utilization: serviceMin > 0 ? Math.min(1, occupiedMin / serviceMin) : 0,
        avgTurnMin,
        revenue: r1(paidRows.reduce((sum, s) => sum + (Number.isFinite(s.revenue) ? s.revenue : 0), 0)),
      }
    })
    .sort((a, b) => b.emptyMin - a.emptyMin || a.orders - b.orders || a.label.localeCompare(b.label))
}

/* ═══════════════ 5) SERVISNE LUKNJE (po naročilu) ═══════════════ */

export interface TempoGapItem {
  firedAt: number | null
  readyAt: number | null
  voided: boolean
}

export interface TempoGapOrder {
  orderId: string
  orderNumber: number
  /** prikazna oznaka mize ('Miza 4'); null = brez mize (ponos/z dodaja) */
  tableLabel: string | null
  waiter: string
  createdAt: number
  paidAt: number | null
  items: TempoGapItem[]
}

export interface TempoGapRow {
  orderId: string
  orderNumber: number
  tableLabel: string | null
  waiter: string
  createdAt: number
  paidAt: number | null
  /** min(firedAt) − createdAt — zamuda, preden je kuhinja sploh videla naročilo */
  entryToFireMin: number | null
  /** min(readyAt) − createdAt — prvi krožnik zunaj */
  firstReadyMin: number | null
  /** max(readyAt) − createdAt — VSE postavke zunaj (prava »servisna luknja«) */
  fullServiceMin: number | null
  /** paidAt − createdAt — celoten obrat mize */
  turnMin: number | null
}

export interface TempoGapStats {
  /** vsa plačana naročila v obdobju */
  orders: number
  /** naročila z ≥ 1 pripravljeno postavko (fullServiceMin znan) */
  measured: number
  /** plačana naročila brez pripravljene postavke — iskreno šteta, ne v medianah */
  unknownReady: number
  medianFullServiceMin: number | null
  medianFirstReadyMin: number | null
  medianEntryToFireMin: number | null
  medianTurnMin: number | null
}

export interface TempoGapsResult {
  /** najpočasnejših topN po celotni strežbi (padajoče; izmerjena samo) */
  rows: TempoGapRow[]
  stats: TempoGapStats
}

/** Klasična mediana (sodo število → povprečje srednjih dveh); prazno → null. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return r1(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2)
}

/** Metrike enega naročila (preklicane postavke ne štejejo; negativni časi —
 *  urona nesreča/zamikanja — se prižne na 0, vzorec kds-stats prepMinutes). */
export function gapRowOf(order: TempoGapOrder): TempoGapRow {
  const live = order.items.filter((i) => !i.voided)
  const fired = live.map((i) => i.firedAt).filter((v): v is number => v != null && Number.isFinite(v))
  const ready = live.map((i) => i.readyAt).filter((v): v is number => v != null && Number.isFinite(v))
  const minOf = (arr: number[]): number | null => (arr.length > 0 ? Math.min(...arr) : null)
  const maxOf = (arr: number[]): number | null => (arr.length > 0 ? Math.max(...arr) : null)
  const c = order.createdAt
  const sinceMin = (ts: number | null): number | null => (ts == null ? null : r1(Math.max(0, ts - c) / 60000))
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    tableLabel: order.tableLabel,
    waiter: order.waiter,
    createdAt: c,
    paidAt: order.paidAt,
    entryToFireMin: sinceMin(minOf(fired)),
    firstReadyMin: sinceMin(minOf(ready)),
    fullServiceMin: sinceMin(maxOf(ready)),
    turnMin: sinceMin(order.paidAt),
  }
}

/**
 * Statistike + najpočasnejša naročila (topN padajoče po celotni strežbi;
 * izenačena → nižja številka naročila naprej — stabilno). Mediane tečejo po
 * IZMERJENIH vrednostih vsake metrike posebej (naročilo brez žiga ne zvleče
 * mediane navzdol, ampak se šteje v unknownReady).
 */
export function aggregateServiceGaps(orders: TempoGapOrder[], topN = 10): TempoGapsResult {
  const rows = orders.map(gapRowOf)
  const med = (pick: (r: TempoGapRow) => number | null): number | null =>
    medianOf(rows.map(pick).filter((v): v is number => v != null))
  const measuredRows = rows.filter((r) => r.fullServiceMin != null)
  const top = [...measuredRows]
    .sort((a, b) => (b.fullServiceMin as number) - (a.fullServiceMin as number) || a.orderNumber - b.orderNumber)
    .slice(0, Math.max(1, topN))
  return {
    rows: top,
    stats: {
      orders: rows.length,
      measured: measuredRows.length,
      unknownReady: rows.length - measuredRows.length,
      medianFullServiceMin: med((r) => r.fullServiceMin),
      medianFirstReadyMin: med((r) => r.firstReadyMin),
      medianEntryToFireMin: med((r) => r.entryToFireMin),
      medianTurnMin: med((r) => r.turnMin),
    },
  }
}
