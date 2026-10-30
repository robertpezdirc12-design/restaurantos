/**
 * P3 #19 (v1.192.0) — doplačilne OSNOVE obračuna, ČISTI sloj.
 *
 * VRZEL (docs/TRZNA-VRZELI-2026.md §4 #19, zaprta v v1.192.0): izvoz obračuna
 * je nosil minute in bruto postavke, biro pa je za statutarne doplačile (noč/
 * nedelja/praznik/nadure) moral minute razstavljati ROČNO iz vnosov. Ta modul
 * doplačilne minute ZRAČUNA deterministično:
 *
 *   - noč / nedelja / praznik: PO ZAPOSLENEM IN DELOVNEM MESTU, interval
 *     [clockIn, clockOut) v lokalnem stenskem času lokacije — PRED odmorom
 *     (položaj odmora v izmeni NI znan; osnova je konzervativno navzgor,
 *     biro potrdi/popravi);
 *   - nadure: PO ZAPOSLENEM (ne po delovnem mestu — prag je osebni), dnevni
 *     presežek NETO potrjenih minut nad pragom (privzeto 480 = 8 h), po
 *     lokalnem dnevu vnosa (isti vidik kot labor sekcija — vnosi stojijo na
 *     dnevu prijave).
 *
 * ISKRENOST (noga izvoza ostaja): RestaurantOS izvaža OSNOVNE minute —
 * ODSTOTKE doplačil potrdi zunanji payroll sistem (biro), ker so odvisni od
 * kolektivne pogodbe/uredb. Nič tu ni pravni nasvet — to je časovna evidence.
 *
 * MEJE (dokumentirane, testirane):
 *   - odprti vnosi (clockOut null) prispevajo 0 — plačilna osnova nastane
 *     šele ob odjavi/potrditvi (ista pravila kot toEntryRow/totalsOfRows);
 *   - prehod čez polnoč in čez več dni je pokrit (sprehod po lokalnih dneh,
 *     strop 62 dni = MAX_PERIOD_DAYS, daljši interval se na 62 dni skrči in
 *     je dokumentiran kot izjema v vrstici? NE — presežek se NE šteje);
 *   - DST: model deluje v stenskem času (minute dneva 0..1440) — premik ure
 *     ne sme narediti niti negativnih niti >24 h kategorij na dan; preklop
 *     ure se pokaže le kot manj/višje realno deljene minute, kar nosi
 *     totalMinutes vnosa (enako kot obstoječi obračun).
 *
 * Strukturno tipkanje: vhod je STRUKTURNI podniz PayrollEntryRow (brez
 * uvoza payroll.ts — prepreči cikel payroll.ts ↔ payroll-surcharges.ts).
 */

import type { SurchargeRates } from './payroll-rates'
import { overtimeAmountOf, pctPctOf, surchargeAmountOfRaw } from './payroll-rates'

/* ─────────────────────── 1) Konfiguracija (politika, ne zakon) ─────────────────────── */

export interface SurchargeBasisConfig {
  /** začetek nočnega okna, minute dneva (privzeto 22:00 = 1320) */
  nightStartMin: number
  /** konec nočnega okna, minute dneva (privzeto 06:00 = 360; okno 22–6 = [0,360) ∪ [1320,1440)) */
  nightEndMin: number
  /** dnevni prag NETO minut po zaposlenem za osnovo nadur (privzeto 480 = 8 h) */
  dailyNetThresholdMin: number
}

export const DEFAULT_SURCHARGE_CONFIG: SurchargeBasisConfig = {
  nightStartMin: 22 * 60,
  nightEndMin: 6 * 60,
  dailyNetThresholdMin: 8 * 60,
}

/** Obdamosen clamp politike (vzorec portalPolicyOf/web-portal): okno 0–24 h,
 * prag 0–24 h; konec ≤ začetek → okno brez večernega repa (samo [0, end)). */
export function clampSurchargeConfig(c: SurchargeBasisConfig): SurchargeBasisConfig {
  const nEnd = Math.min(1440, Math.max(0, Math.round(c.nightEndMin)))
  const nStart = Math.min(1440, Math.max(0, Math.round(c.nightStartMin)))
  return {
    nightStartMin: nStart,
    nightEndMin: nEnd,
    dailyNetThresholdMin: Math.min(1440, Math.max(0, Math.round(c.dailyNetThresholdMin))),
  }
}

/* ─────────────────────── 2) Strukturni vhodi/izhodi ─────────────────────── */

/** Strukturni podniz PayrollEntryRow (src/lib/payroll.ts) — brez uvoza. */
export interface SurchargeEntryRow {
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  /** lokalni koledarski dan prijave 'YYYY-MM-DD' (localDateKey) */
  date: string
  /** ISO UTC — null za odprt vnos */
  clockIn: string
  /** ISO UTC — null za odprt vnos */
  clockOut: string | null
  /** neto minute (samo APPROVED vrstice se štejejo — ista pravila kot agregacija) */
  netMinutes: number
  status: string
  /** N-27-3 (v1.197.0): POSNETEK urne postavke vnosa v centih — kadar ga klic
   * ne poda (starejši vhodi), zneski prispevajo 0 (deterministično). */
  payRateCents?: number
  /** N-27-3: posnetek bruto plače vnosa v centih — osnova povprečne postavke nadur. */
  grossCents?: number
}

/** Doplačilne osnove po zaposlenem IN delovnem mestu (noč/nedelja/praznik). */
export interface SurchargeBasisRow {
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  /** kontrolna vsota neto potrjenih minut skupine (morja se ujemati s plačilno osnovo) */
  approvedMinutes: number
  /** minute v nočnem oknu (pred odmorom) */
  nightMinutes: number
  /** minute na lokalni nedelji (pred odmorom) */
  sundayMinutes: number
  /** minute na lokalni praznik (pred odmorom) */
  holidayMinutes: number
  /** N-27-3 (v1.197.0): zneski v centih — prisotni SAMO, kadar klic poda noge
   * (surchargeRates); ena zaokrožitev na skupino (Math.round) nad celoštevilčno
   * količino Σ catMin × payRateCents × pctPct. */
  nightAmtCents?: number
  sundayAmtCents?: number
  holidayAmtCents?: number
}

/** Osnova nadur po zaposlenem (dnevni presežek neto minut nad pragom). */
export interface OvertimeBasisRow {
  employeeId: string
  employeeName: string
  /** Σ po dnevih: max(0, dnevne neto minute − prag) */
  overtimeBasisMinutes: number
  /** število dni, kjer je dnevna vsota presegla prag */
  daysOverThreshold: number
  /** N-27-3 (v1.197.0): znesek nadur v centih po POVPREČNI urni postavki
   * obdobja (Σ grossCents × 60 / Σ netMinutes) — prisoten samo kadar klic
   * poda noge; Σ netMinutes = 0 → 0. */
  overtimeAmtCents?: number
}

/** Združene osnove obdobja (en obliko nosita detail ruta, izvoz CSV/JSON). */
export interface SurchargeBases {
  perEmployeeJob: SurchargeBasisRow[]
  overtime: OvertimeBasisRow[]
}

/* ─────────────────────── 3) Stenski čas (DST varno) ─────────────────────── */

/** Dan v tednu 'YYYY-MM-DD': 1 = ponedeljek … 7 = nedelja (isti vidik kot
 * dowOf v labor-coverage.ts). Čisto koledarsko aritmetiko (UTC), DST izven. */
export function dowOf(dateISO: string): number {
  const [y, m, d] = dateISO.split('-').map(Number)
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=ned … 6=sob
  return js === 0 ? 7 : js
}

/** Stenski vidik instanta v časovnem coni → { lokalni dan, minute dneva }. */
export function wallOf(instantISO: string, tz: string): { dateISO: string; minute: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(instantISO))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const minute = Math.min(1439, Number(parts.hour) * 60 + Number(parts.minute))
  return { dateISO: `${parts.year}-${parts.month}-${parts.day}`, minute }
}

/** Splošni prekrivanj [aS,aE) ∩ [bS,bE) v minutah na istem dnevu. */
function overlapMin(aS: number, aE: number, bS: number, bE: number): number {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS))
}

/** Strop sprehoda po dnevih (enak obseg kot obdobja — MAX_PERIOD_DAYS). */
const MAX_WALK_DAYS = 62

/**
 * Kategorije ENEGA intervala (lokalni stenski čas, po lokalnih dnevih):
 * noč = [0, nightEnd) ∪ [nightStart, 1440) na vsakem dotaknjenem dnevu;
 * nedelja = celoten dotaknjen dan z dowOf 7; praznik = dan v holidays.
 * Odprt/napačen interval (null, obrnjen) → vse 0. Strop 62 dni.
 */
export function intervalCategoryMinutes(
  clockInISO: string,
  clockOutISO: string | null,
  tz: string,
  holidays: Set<string>,
  cfg: SurchargeBasisConfig = DEFAULT_SURCHARGE_CONFIG,
): { nightMinutes: number; sundayMinutes: number; holidayMinutes: number } {
  if (!clockOutISO) return { nightMinutes: 0, sundayMinutes: 0, holidayMinutes: 0 }
  const c = clampSurchargeConfig(cfg)
  let cur = wallOf(clockInISO, tz)
  const end = wallOf(clockOutISO, tz)
  let night = 0
  let sunday = 0
  let holiday = 0
  for (let i = 0; i <= MAX_WALK_DAYS; i++) {
    const last = cur.dateISO === end.dateISO
    const dayEnd = last ? end.minute : 1440
    if (dayEnd > cur.minute) {
      const isSunday = dowOf(cur.dateISO) === 7
      const isHoliday = holidays.has(cur.dateISO)
      if (isSunday) sunday += dayEnd - cur.minute
      if (isHoliday) holiday += dayEnd - cur.minute
      // nočno okno [0, nightEnd) ∪ [nightStart, 1440) — konec ≤ začetek pomeni
      // samo jutranji rep (konzervativno; klampiranje politike je dokumentirano)
      if (c.nightEndMin > 0) night += overlapMin(cur.minute, dayEnd, 0, c.nightEndMin)
      if (c.nightStartMin < 1440 && c.nightStartMin > c.nightEndMin) {
        night += overlapMin(cur.minute, dayEnd, c.nightStartMin, 1440)
      }
    }
    if (last) break
    cur = { dateISO: addDaysISOLocal(cur.dateISO), minute: 0 }
  }
  return { nightMinutes: night, sundayMinutes: sunday, holidayMinutes: holiday }
}

/** +1 dan 'YYYY-MM-DD' (lokalna, brez DST — čisto koledarsko). */
function addDaysISOLocal(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/* ─────────────────────── 4) Združevanje po skupinah ─────────────────────── */

/**
 * Doplačilne osnove po (zaposleni, delovno mesto) — noč/nedelja/praznik —
 * + po zaposlenem — nadure. Samo APPROVED vrstice (ista pravila kot
 * aggregateByEmployeeJob — nepotrjeno ostane vidno prek izjem). Sortiranje
 * po imenu zaposlenega in delovnem mestu (enako kot obstoječa agregacija).
 *
 * N-27-3 (v1.197.0): kadar klic poda 5. argument `rates` (noge doplačil iz
 * uporabniške konfiguracije), vrstice dobijo tudi ZNESKE v centih
 * (nightAmtCents/sundayAmtCents/holidayAmtCents + overtimeAmtCents). Brez
 * nog se oblika NE spremeni (polja odsotna — stabilnost za stare klice in
 * hash: noge so del vsebine izvoza, ne njegove strukture).
 */
export function surchargeBasisRows(
  rows: SurchargeEntryRow[],
  tz: string,
  holidays: Set<string>,
  cfg: SurchargeBasisConfig = DEFAULT_SURCHARGE_CONFIG,
  rates?: SurchargeRates,
): SurchargeBases {
  const c = clampSurchargeConfig(cfg)
  const map = new Map<string, SurchargeBasisRow>()
  const otDays = new Map<string, Map<string, number>>() // employeeId → dan → neto min
  // N-27-3: RAW centne količine (celoštevilčni produkti minute × centi ×
  // stotinke odstotka) — zaokrožitev ENA na skupino, na koncu.
  const amtRaw = new Map<string, { night: number; sunday: number; holiday: number }>()
  const empTotals = new Map<string, { gross: number; net: number }>()

  for (const r of rows) {
    if (r.status !== 'approved') continue
    const net = Math.max(0, Math.round(r.netMinutes || 0))
    const key = `${r.employeeId}|${r.jobId ?? ''}`
    let agg = map.get(key)
    if (!agg) {
      agg = {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        jobId: r.jobId,
        jobName: r.jobName,
        approvedMinutes: 0,
        nightMinutes: 0,
        sundayMinutes: 0,
        holidayMinutes: 0,
      }
      map.set(key, agg)
    }
    if (r.employeeName) agg.employeeName = r.employeeName
    if (!agg.jobName && r.jobName) agg.jobName = r.jobName
    agg.approvedMinutes += net

    const cats = intervalCategoryMinutes(r.clockIn, r.clockOut, tz, holidays, c)
    agg.nightMinutes += cats.nightMinutes
    agg.sundayMinutes += cats.sundayMinutes
    agg.holidayMinutes += cats.holidayMinutes

    if (rates) {
      const cents = Math.max(0, Math.round(r.payRateCents ?? 0))
      let raw = amtRaw.get(key)
      if (!raw) {
        raw = { night: 0, sunday: 0, holiday: 0 }
        amtRaw.set(key, raw)
      }
      if (cents > 0) {
        const pctN = pctPctOf(rates.nightPct)
        const pctS = pctPctOf(rates.sundayPct)
        const pctH = pctPctOf(rates.holidayPct)
        if (cats.nightMinutes > 0) raw.night += cats.nightMinutes * cents * pctN
        if (cats.sundayMinutes > 0) raw.sunday += cats.sundayMinutes * cents * pctS
        if (cats.holidayMinutes > 0) raw.holiday += cats.holidayMinutes * cents * pctH
      }
      const emp = empTotals.get(r.employeeId) ?? { gross: 0, net: 0 }
      emp.gross += Math.max(0, Math.round(r.grossCents ?? 0))
      emp.net += net
      empTotals.set(r.employeeId, emp)
    }

    // nadure: po ZAPOSLENEM (ne po delovnem mestu) na lokalnem dnevu prijave
    let days = otDays.get(r.employeeId)
    if (!days) {
      days = new Map()
      otDays.set(r.employeeId, days)
    }
    days.set(r.date, (days.get(r.date) || 0) + net)
  }

  const perEmployeeJob = [...map.values()].sort(
    (a, b) => a.employeeName.localeCompare(b.employeeName) || a.jobName.localeCompare(b.jobName),
  )

  if (rates) {
    for (const row of perEmployeeJob) {
      const key = `${row.employeeId}|${row.jobId ?? ''}`
      const raw = amtRaw.get(key)
      row.nightAmtCents = raw ? surchargeAmountOfRaw(raw.night) : 0
      row.sundayAmtCents = raw ? surchargeAmountOfRaw(raw.sunday) : 0
      row.holidayAmtCents = raw ? surchargeAmountOfRaw(raw.holiday) : 0
    }
  }

  const nameOf = new Map<string, string>()
  for (const r of rows) if (r.employeeName) nameOf.set(r.employeeId, r.employeeName)
  const overtime: OvertimeBasisRow[] = []
  for (const [employeeId, days] of [...otDays.entries()].sort((a, b) => (nameOf.get(a[0]) || a[0]).localeCompare(nameOf.get(b[0]) || b[0]))) {
    let over = 0
    let daysOver = 0
    for (const minutes of days.values()) {
      if (minutes > c.dailyNetThresholdMin) {
        over += minutes - c.dailyNetThresholdMin
        daysOver += 1
      }
    }
    const ot: OvertimeBasisRow = {
      employeeId,
      employeeName: nameOf.get(employeeId) || '',
      overtimeBasisMinutes: over,
      daysOverThreshold: daysOver,
    }
    if (rates) {
      const emp = empTotals.get(employeeId)
      ot.overtimeAmtCents = emp ? overtimeAmountOf(over, emp.gross, emp.net, rates.overtimePct) : 0
    }
    overtime.push(ot)
  }

  return { perEmployeeJob, overtime }
}
