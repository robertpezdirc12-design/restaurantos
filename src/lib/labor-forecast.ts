/**
 * P1-4 (v1.186.0) — Labor forecast (napoved dela): čisti matematični sloj.
 *
 * Brez DB in brez I/O — ruta (/api/reports/labor-forecast + /api/reports/export
 * sekcija=labor-forecast) vanj vlije surove vzorce (plačani naročili, TimeEntry
 * tehtnica urne postavke, načrtovane StaffShift izmene) in iz njih sestavi
 * priporočilo dela za prihodnje dni. Vzorca sledita sales-by-hour.ts in
 * labor-coverage.ts: čiste funkcije, denar v centih zaokrožen na celo,
 * ure zaokrožene na četrt ure, UI izriše točno to, kar ta modul vrne.
 *
 * METODOLOGIJA (namerno ENAKA kot forecastSales v labor-coverage.ts, da imata
 * napoved pokritosti in napoved dela konsistentno osnovo in enako občutljivost):
 *   1) za vsak prihodnji dan (zadnji zgodovinski dan +1 … +horizon) povprečje
 *      neto prodaje ZGODOVINSKIH dni ISTEGA dneva tedna; vzorci = SAMO dnevi
 *      z > 0 neto prodajo (zaprti dnevi so ločeno štetje, ne pollutajo ocene);
 *   2) urni profil: delež neto prodaje po urah znotraj ISTEGA dneva tedna
 *      (agregirano po vseh vzorčnih dneh) → pričakovani prihodek na uro;
 *   3) potrebne ure na uro: prihodek × ciljni labor-% ÷ tehtana urna postavka
 *      (TimeEntry totalPay/totalMinutes) — zaokroženo na 0,25 h NAVZGOR na
 *      15-min semafor (restavracijska praksa: podzaposlitev je dražja kot
 *      četrt ure preveč); priporočeno osebje = strop potrebulih ur na uro;
 *   4) vrzeli vs. načrtovane izmene: prekrivanje intervalov izmen z odprtimi
 *      urami (− odmor) → podzaposlenost/pretirana zaposlenost na uro.
 *
 * Nič izmišljenega: brez vzorcev za dan tedna je napoved null + confidence
 * 'low' (enako kot forecastSales). Ni LLM-ja — to je deterministični P1-4;
 * AI naracija je ločena površina (ai-insights, P2-9).
 */

/* ─────────────────────────── 1) Javne oblike ─────────────────────────── */

/** Zgodovinski dan: neto prodaja (subtotal − discount, brez DDV) po urah. */
export interface ForecastHistoryDay {
  /** lokalni koledarski dan 'YYYY-MM-DD' (isti format kot dayKeyOf) */
  date: string
  /** 1 = ponedeljek … 7 = nedelja (isti vidik kot dowOf v labor-coverage.ts) */
  dow: number
  /** neto prodaja dneva v centih */
  netSalesCents: number
  /** natanko 24 vnosov (ura 0..23), neto prodaja v centih po urah */
  hourRevenueCents: number[]
}

/** Načrtovana izmena (StaffShift) — časi v minutah od polnoči. */
export interface ScheduledShiftSample {
  /** lokalni koledarski dan 'YYYY-MM-DD' izmene */
  date: string
  /** 'HH:MM' → minute; konec ≤ začetek pomeni prehod čez polnoč (+24 h) */
  startMinute: number
  endMinute: number
  /** odmor v minutah (se odšteje od načrtovanih ur) */
  breakMinutes: number
  /** vloga izmene (za prihodnje razčlenitve; motor je je neobčutljiv) */
  role: string
}

export interface LaborForecastConfig {
  /** ciljni delež stroška dela v neto prodaji (%) — LABOR_TARGET_PCT vzorec */
  targetLaborPct: number
  /** tehtana urna postavka (centi/h) — iz TimeEntry, fallback od rute */
  avgWageCentsPerHour: number
  /** horizon napovedi v dneh (1..14) */
  horizonDays: number
  /** zaokroževanje potrebulih ur na 0,25 h navzgor (privzeto true) */
  roundQuarter: boolean
  /**
   * sidro horizonta 'YYYY-MM-DD' (dan 1 = sidro +1). Privzeto zadnji
   * zgodovinski dan (vzorec forecastSales); ruta podaja DANES, da se okno
   * napovedi poravna z oknom poizvedbe izmen (jutri … danes+horizon) tudi,
   * ko je zgodovina umetno starša (testi) ali ko today nima prodaje.
   */
  anchorDate?: string
}

/** Odprta ura v napovedi dneva. */
export interface ForecastHourCell {
  hour: number
  /** pričakovana neto prodaja te ure (centi) */
  forecastNetCents: number
  /** potrebne ure dela za to uro (0,25 h granularost) */
  requiredHours: number
  /** priporočeno število ljudi na uro (strop potrebulih ur) */
  recommendedStaff: number
}

/** Napoved enega prihodnjega dne. */
export interface ForecastDay {
  date: string
  dow: number
  /** 'low' = < 3 vzorcev istega dne tedna ali brez vzorcev, sicer 'ok' */
  confidence: 'low' | 'ok'
  /** povprečje neto prodaje istega dne tedna (centi); null brez vzorcev */
  forecastNetCents: number | null
  /** min/max vzorcev istega dne tedna (centi); null brez vzorcev */
  minNetCents: number | null
  maxNetCents: number | null
  /** koliko zgodovinskih dni je prispevalo vzorec */
  sampleCount: number
  /** koliko istotedenskih dni je bilo brez prodaje (izključenih iz povprečja) */
  closedDays: number
  /** samo ure z > 0 zgodovinskim prihodkom, naraščajoče */
  openHours: ForecastHourCell[]
  /** vsota potrebulih ur odprtih ur (0,25 h granularost) */
  totalRequiredHours: number
  /** načrtovane ure dela (iz izmen, − odmor) tega dne; 0 brez izmen */
  scheduledHours: number
}

/** Vrzel med načrtom in potrebami na ravni ure. */
export interface ForecastGap {
  date: string
  hour: number
  /** 'under' = načrt < potrebe (podzaposlenost), 'over' = načrt > potrebe */
  kind: 'under' | 'over'
  /** načrtovane ure dela v tej uri (− odmor, prekrivanje z uro) */
  scheduledHours: number
  /** potrebne ure te ure */
  requiredHours: number
  /** |načrt − potreba| (samo vrzeli ≥ prag 0,5 h so izpisane) */
  deltaHours: number
}

export interface LaborForecastResult {
  config: LaborForecastConfig
  days: ForecastDay[]
  gaps: ForecastGap[]
}

/* ─────────────────────── 2) Konstante in pomožniki ─────────────────────── */

/** Ciljni labor-% (isti benchmark kot LABOR_TARGET_PCT v labor-cost ruti). */
export const LF_TARGET_LABOR_PCT = 32

/** Privzeti horizont (isti kot LCOV_FORECAST_DAYS v labor-coverage.ts). */
export const LF_FORECAST_DAYS = 7

/** Meje horizonta (ruta je stisne na ta razpon). */
export const LF_HORIZON_MIN = 1
export const LF_HORIZON_MAX = 14

/** Prag vrzeli v urah — manjše odstopanja niso vredna opozorila. */
export const LF_GAP_THRESHOLD_HOURS = 0.5

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * 'YYYY-MM-DD' → 1=pon … 7=ned (ENAK algoritem kot dowOf v labor-coverage.ts
 * — dve neodvisni implementaciji bi se nekega dne razšli; komentar tam:
 * Date.UTC + getUTCDay + premik, da nedelja ni 0 ampak 7).
 */
export function dowOfISO(dateKey: string): number {
  const [y, m, d] = String(dateKey).split('-').map((v) => Number(v))
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = nedelja
  return ((js + 6) % 7) + 1
}

/** 'YYYY-MM-DD' + n dni → 'YYYY-MM-DD' (UTC aritmetika, kot addDaysISO vzorec). */
export function addDaysISO(dateKey: string, n: number): string {
  const [y, m, d] = String(dateKey).split('-').map((v) => Number(v))
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + n)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** 'HH:MM' → minute od polnoči; neveljavno → null (parseHM vzorec). */
export function parseHMToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Povprečje; prazen vnos → null (nič izmišljenega). */
export function meanOf(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Mediana (za prihodnje razčlenitve; javna, ker je testi pokrijejo). */
export function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Zaokroži ure: roundQuarter → navzgor na 0,25 h, sicer na 2 decimalki. */
function roundHours(raw: number, roundQuarter: boolean): number {
  if (roundQuarter) return Math.ceil((raw - 1e-9) * 4) / 4
  return r2(raw)
}

/* ───────────────────────── 3) Glavni motor ───────────────────────── */

/**
 * Izračuna napoved dela za prihodnje dni + vrzeli vs. načrtovane izmene.
 *
 * @param history zgodovinski dnevi (vsaj en pričakovan; prazen → prazen rezultat)
 * @param shifts načrtovane izmene v horizontu (StaffShift presetek rute)
 * @param cfgPartial delna konfiguracija (manjkajoča polja = privzetki)
 */
export function forecastLabor(
  history: ForecastHistoryDay[],
  shifts: ScheduledShiftSample[],
  cfgPartial: Partial<LaborForecastConfig> = {},
): LaborForecastResult {
  const config: LaborForecastConfig = {
    targetLaborPct: cfgPartial.targetLaborPct ?? LF_TARGET_LABOR_PCT,
    avgWageCentsPerHour: cfgPartial.avgWageCentsPerHour ?? 1200,
    horizonDays: Math.max(LF_HORIZON_MIN, Math.min(LF_HORIZON_MAX, Math.round(cfgPartial.horizonDays ?? LF_FORECAST_DAYS))),
    roundQuarter: cfgPartial.roundQuarter ?? true,
  }

  const days: ForecastDay[] = []
  const gaps: ForecastGap[] = []
  if (history.length === 0 || config.avgWageCentsPerHour <= 0) {
    return { config, days, gaps }
  }

  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const lastDate = sorted[sorted.length - 1].date
  // Sidro horizonta: izrecna anchorDate (rute/testi) ali nazadnje zgodovinski
  // dan (forecastSales kompatibilnost). Neveljaven format = tiho na lastDate.
  const anchor = cfgPartial.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(cfgPartial.anchorDate)
    ? cfgPartial.anchorDate
    : lastDate

  // Združi zgodovino po dnevih tedna (vzorec forecastSales: byDow Map).
  const byDow = new Map<number, ForecastHistoryDay[]>()
  for (const d of sorted) {
    const list = byDow.get(d.dow)
    if (list) list.push(d)
    else byDow.set(d.dow, [d])
  }

  // Urni profili po dnevih tedna (za odprte ure in uteži).
  const hourSums = new Map<number, number[]>() // dow → 24 vsot neto centov
  for (const d of sorted) {
    const arr = hourSums.get(d.dow) ?? new Array<number>(24).fill(0)
    for (let h = 0; h < 24; h++) arr[h] += d.hourRevenueCents[h] || 0
    hourSums.set(d.dow, arr)
  }

  // Načrtovane ure dela po dnevih (za skupno vsoto) + na uro (za vrzeli).
  // Minute preko polnoči (konec ≤ začetek) se pripisajo NASLEDNJEMU dnevu —
  // ura 23:00–01:00 je ena ura na datum izmene in ena na dan prehoda.
  const scheduledByDate = new Map<string, number>() // date → vsota ur (− odmor)
  const scheduledHourly = new Map<string, number[]>() // date → 24 prekrivanj
  for (const s of shifts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) continue
    const rawDur = s.endMinute - s.startMinute
    const dur = rawDur <= 0 ? rawDur + 24 * 60 : rawDur // prehod čez polnoč
    const breakClamped = Math.max(0, Math.min(12 * 60, s.breakMinutes || 0))
    let workLeft = dur - breakClamped
    if (workLeft <= 0) continue
    const nextDate = addDaysISO(s.date, 1)
    let remaining = dur
    let cursor = s.startMinute
    // Odmor se porabi NAMEDEN (konservativno: delo najprej — vzorec C2).
    while (remaining > 0) {
      const curDate = cursor < s.startMinute ? nextDate : s.date
      const hour = Math.floor(cursor / 60) % 24
      const step = Math.min(60 - (cursor % 60), remaining) // minute do konca ure
      if (workLeft > 0) {
        const w = Math.min(workLeft, step)
        workLeft -= w
        const arr = scheduledHourly.get(curDate) ?? new Array<number>(24).fill(0)
        arr[hour] += w / 60
        scheduledHourly.set(curDate, arr)
        scheduledByDate.set(curDate, (scheduledByDate.get(curDate) ?? 0) + w / 60)
      }
      remaining -= step
      cursor = (cursor + step) % (24 * 60)
    }
  }

  for (let i = 1; i <= config.horizonDays; i++) {
    const date = addDaysISO(anchor, i)
    const dow = dowOfISO(date)
    const sameDow = byDow.get(dow) ?? []
    const samples = sameDow.filter((d) => d.netSalesCents > 0).map((d) => d.netSalesCents)
    const closedDays = sameDow.length - samples.length

    const scheduledHours = r2(scheduledByDate.get(date) ?? 0)
    const day: ForecastDay = {
      date,
      dow,
      confidence: 'low',
      forecastNetCents: null,
      minNetCents: null,
      maxNetCents: null,
      sampleCount: samples.length,
      closedDays,
      openHours: [],
      totalRequiredHours: 0,
      scheduledHours,
    }

    if (samples.length === 0) {
      // Ni vzorcev → brez napovedi (NIČ izmišljenega), a načrt izmen ostane viden.
      days.push(day)
      continue
    }

    const mean = meanOf(samples) as number
    day.forecastNetCents = Math.round(mean)
    day.minNetCents = Math.min(...samples)
    day.maxNetCents = Math.max(...samples)
    day.confidence = samples.length < 3 ? 'low' : 'ok'

    // Odprte ure + uteži iz zgodovine istega dne tedna.
    const sums = hourSums.get(dow) ?? new Array<number>(24).fill(0)
    const totalSum = sums.reduce((a, b) => a + b, 0)
    if (totalSum <= 0) {
      days.push(day)
      continue
    }

    let total = 0
    const hourly = scheduledHourly.get(date)
    for (let h = 0; h < 24; h++) {
      if (sums[h] <= 0) continue
      const weight = sums[h] / totalSum
      const cellNet = Math.round(mean * weight)
      const costCents = (cellNet * config.targetLaborPct) / 100
      const rawHours = costCents / config.avgWageCentsPerHour
      const requiredHours = roundHours(rawHours, config.roundQuarter)
      day.openHours.push({
        hour: h,
        forecastNetCents: cellNet,
        requiredHours,
        recommendedStaff: Math.ceil(rawHours - 1e-9),
      })
      total += requiredHours

      // Vrzeli: samo tam, kjer je napovedana tudi potreba.
      const sched = hourly?.[h] ?? 0
      const delta = sched - requiredHours
      if (Math.abs(delta) >= LF_GAP_THRESHOLD_HOURS) {
        gaps.push({
          date,
          hour: h,
          kind: delta < 0 ? 'under' : 'over',
          scheduledHours: r2(sched),
          requiredHours,
          deltaHours: r2(Math.abs(delta)),
        })
      }
    }
    day.totalRequiredHours = r2(total)
    days.push(day)
  }

  gaps.sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour)
  return { config, days, gaps }
}
