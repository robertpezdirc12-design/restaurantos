import { createHash } from 'crypto'

/**
 * Issue #1 (triage ①) — napitnine: dnevni bazen + distribucija po zaposlenih.
 * Čista logika (brez DB) — testirana v tests/tips.test.ts.
 *
 * Pravila:
 *  - en bazen na dan + lokacijo (zaščita pred podvojitvijo/zdvojenim izplačilom)
 *  - osnova delitve: ure (TimeEntry), enako (equal) ali ročne točke (points)
 *  - razdelitev v centih z metodo največjega ostanka → vsota je TOČNO skupni znesek
 *  - distribucije so hash-verižene (previousHash/chainHash) → tamper-evident
 */

export type TipMethod = 'hours' | 'equal' | 'points'

export function parseTipMethod(m: unknown): TipMethod | null {
  return m === 'hours' || m === 'equal' || m === 'points' ? m : null
}

/** Dnevno okno [00:00, naslednji dan 00:00) — DB časi so UTC, zato UTC okno. */
export function dayRange(dateStr: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Datum mora biti v obliki YYYY-MM-DD.')
  const from = new Date(dateStr + 'T00:00:00.000Z')
  if (Number.isNaN(from.getTime())) throw new Error('Neveljaven datum.')
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  return { from, to }
}

/**
 * Razdeli totalCents po utežeh. Vsota rezultatov je TOČNO totalCents.
 * - uteži < 0 / ne-finite → napaka; prazna poraba uteži (vsota 0) → ostanek gre po indeksu (enakomerno)
 * - največji ostanek: preostali centi gredejo k največjim frakcijam (neodločeno → nižji indeks)
 */
export function splitTips(totalCents: number, weights: number[]): number[] {
  if (!Number.isFinite(totalCents) || totalCents < 0 || !Number.isInteger(totalCents)) {
    throw new Error('Neveljaven skupni znesek (pričakovan nenegativen integer v centih).')
  }
  if (weights.length === 0) return []
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error('Uteži morajo biti ne-negativna števila.')
  }
  const sum = weights.reduce((a, w) => a + w, 0)
  const base = weights.map((w) => (sum > 0 ? Math.floor((w / sum) * totalCents) : 0))
  let remainder = totalCents - base.reduce((a, b) => a + b, 0)
  const order = weights
    .map((w, i) => ({ i, frac: sum > 0 ? (w / sum) * totalCents - base[i] : i / weights.length }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = base.slice()
  for (const { i } of order) {
    if (remainder <= 0) break
    out[i]++
    remainder--
  }
  return out
}

/** Člen verige: sha256(prev | employeeId | osnova | znesekVCentih) — tamper-evident zaporedje. */
export function tipChainHash(previousHash: string, employeeId: string, basisCents: number, amountCents: number): string {
  return createHash('sha256')
    .update(`${previousHash}|${employeeId}|${basisCents}|${amountCents}`, 'utf8')
    .digest('hex')
}

export interface ChainRow {
  previousHash: string
  chainHash: string
  employeeId: string
  /** osnova v centih (ure×60, točke×100 ali 1 pri equal) */
  basis: number
  /** znesek v centih */
  amount: number
}

/** Preveri celotno verigo (povezanost + hashe). Karkoli spremenjeno → false. */
export function verifyTipChain(rows: ChainRow[]): boolean {
  let prev = ''
  for (const r of rows) {
    if (r.previousHash !== prev) return false
    const expected = tipChainHash(prev, r.employeeId, r.basis, r.amount)
    if (r.chainHash !== expected) return false
    prev = r.chainHash
  }
  return true
}

/** Število minut TimeEntry vnosa, ki pade v dnevno okno (aktiven vnos = do konca dneva). */
export function entryMinutesInRange(
  clockInMs: number,
  clockOutMs: number | null,
  breakMinutes: number,
  fromMs: number,
  toMs: number
): number {
  if (clockInMs < fromMs) return 0 // šteto pri dnevu začetka izmene
  const end = clockOutMs === null ? toMs : Math.min(clockOutMs, toMs)
  if (end <= clockInMs) return 0
  const gross = (end - clockInMs) / 60000
  return Math.max(0, Math.round(gross - (breakMinutes || 0)))
}
