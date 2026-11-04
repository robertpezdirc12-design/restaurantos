/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 C — Lightspeed junij
 * 2026 »daily and weekly Tasks summary emails … checklist completion rates«)
 * — POVZETKI OPRAVIL PO E-POŠTI.
 *
 * IZMERA pred valom: v1.246.0 je zgradila ChecklistRun (nosilec izvedb s
 * pokritostjo postavk) in dnevni digest ima vzorec aditivnih sekcij
 * (hourlyBuckets v1.206.0). Ta sloj je ČISTI DELVLJEN odseka — enaka
 * disciplina kot hourly-email.ts: 0 uvozov, nikoli ne meče (digest je nad
 * sekcijo; absent/empty → BREZ sekcije, izhod za stare vhode byte-identičen).
 *
 * DVE obliki:
 *  - DNEVNA sekcija digesta: vrstica na AKTIVNO predlogo s terminom v dnevu
 *    (»Odpiranje — pokritost 2/3« / »Zaključek — ZAKLJUČENO«); če podatki
 *    nosijo več lokacij, vrstica nosi ime lokacije (večlokacijski najemniki).
 *  - TEDENSKI povzetek (samostojno pismo, ponedelki): na predlogo pojavitve
 *    × zaključki × povprečna pokritost tedna.
 */

/** Ena vrstica dnevne sekcije (izvedba ene predloge na en dan). */
export interface TaskSummaryLine {
  /** ime predloge (posnetek). */
  template: string
  /** pokritost postavk (koliko odgovorov od vseh). */
  done: number
  total: number
  /** strežniško izpeljan zaključek (runCompletedFromCoverage). */
  completed: boolean
  /** ime lokacije (za večlokacijske najemnike; null = ne izpiši). */
  location?: string | null
}

/** Ena vrstica tedenskega povzetka (agregat predloge cez teden). */
export interface WeeklyTaskRow {
  template: string
  /** koliko terminov je predloga imela v tednu. */
  occurrences: number
  /** koliko terminov je bilo zaključenih. */
  completedCount: number
  /** povprečna pokritost v % (0–100, zaokroženo na celo). */
  coveragePct: number
  location?: string | null
}

/** Ali je treba vrstico označiti z lokacijo (samo kadar jih je več). */
function needsLocationPrefix(lines: readonly { location?: string | null }[]): boolean {
  const names = new Set(lines.map((l) => (l.location ?? '').trim()).filter(Boolean))
  return names.size > 1
}

/**
 * Dnevna sekcija »Opravila« za digest. Prazna tabela → [] (brez sekcije —
 * nič se ne laže o dnevu brez seznamov). Zaključeni seznami pišejo
 * ZAKLJUČENO (vidna disciplina, ne le številka).
 */
export function dailyTaskSummarySection(lines: readonly TaskSummaryLine[]): string[] {
  if (lines.length === 0) return []
  const withLoc = needsLocationPrefix(lines)
  const out = ['Opravila:']
  for (const l of lines) {
    const loc = withLoc && l.location ? `${l.location}: ` : ''
    if (l.completed) {
      out.push(`  ${loc}${l.template} — ZAKLJUČENO`)
    } else if (l.total > 0) {
      out.push(`  ${loc}${l.template} — pokritost ${l.done}/${l.total}`)
    } else {
      // predloga brez postavk je mrtva vrstica — pošteno stanje
      out.push(`  ${loc}${l.template} — brez postavk`)
    }
  }
  return out
}

/**
 * Tedenski povzetek opravil (samostojno pismo). Prazna tabela → null (brez
 * pošiljanja — teden brez terminov ni novica). Čista funkcija: podatek o
 * tednu pride zunanje (oznaka obdobja v naslovu).
 */
export function weeklyTaskSummaryEmailText(args: {
  rows: readonly WeeklyTaskRow[]
  weekLabel: string
}): { subject: string; body: string } | null {
  if (args.rows.length === 0) return null
  const withLoc = needsLocationPrefix(args.rows)
  const lines: string[] = [`Povzetek opravil — ${args.weekLabel}`, '']
  for (const r of args.rows) {
    const loc = withLoc && r.location ? `${r.location}: ` : ''
    lines.push(`  ${loc}${r.template}: ${r.completedCount}/${r.occurrences} zaključenih · pokritost ${r.coveragePct} %`)
  }
  lines.push('')
  lines.push('— RestaurantOS')
  return {
    subject: `Opravila — tedenski povzetek (${args.weekLabel})`,
    body: lines.join('\n'),
  }
}

/**
 * Povprečna pokritost tedna iz seznamov (done,total) — 0, kadar ni terminov
 * (deljenje z nič je laž; teden brez pojavitve teče čez 0 % LE če je bila
 * pojavitev, a brez odgovorov — razlika je pomembna za iskrenost).
 */
export function weeklyCoveragePct(parts: readonly { done: number; total: number }[]): number {
  if (parts.length === 0) return 0
  let done = 0
  let total = 0
  for (const p of parts) {
    done += p.done
    total += p.total
  }
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}
