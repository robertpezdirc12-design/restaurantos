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

/**
 * PRIMERJAVA §40 (v1.266.0) — NAPITNINSKE TOČKE PO VLOGI: sanitizacija
 * vnosa točk per oseba (POST body + GET query). Mapa employeeId → točke:
 * ohranjeni so IZKLJUČNO končni CELOŠTEVILSKI vnosi 0..999; NaN/Infinity/
 * negativ/decimal/niz/Polje → izpuščeni (0). Prej je surovi body šel v
 * methodWeights, kjer je Math.max(0, Number(x) || 0) spustil Infinity
 * skozi — splitTips je potem VRŽIL 'Uteži morajo biti ne-negativna
 * števila.' (neobdelan 500). Sanitizacija na VHODU = poštena obramba.
 */
export const TIP_POINTS_MAX = 999

export function sanitizeTipPointsRecord(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.trim() === '') continue
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= TIP_POINTS_MAX) {
      out[k] = v
    }
  }
  return out
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
 * - uteži < 0 / ne-finite → napaka; PRAZNA poraba uteži (vsota 0) →
 *   ENAKOVREDNA delitev (v1.266.0 §40 E2E najdba: prej je vsota-0 zanka
 *   razdelila le po 1 cent po vrstnem redu in OSTANEK TIHO VRGILA PROČ —
 *   [1,1] pri 30,00 € je kršilo lastno invarianto »vsota je TOČNO skupni
 *   znesek«; enakovredna delitev jo izpolni, enako kot fallbackEqual veja
 *   methodWeights za ure brez evidenc)
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
  // vsota 0 (vse uteži prazne) = enakovredna osnova: floor vsakemu, ostanek po indeksu
  const base =
    sum > 0
      ? weights.map((w) => Math.floor((w / sum) * totalCents))
      : weights.map(() => Math.floor(totalCents / weights.length))
  let remainder = totalCents - base.reduce((a, b) => a + b, 0)
  const order = weights
    .map((w, i) => ({ i, frac: sum > 0 ? (w / sum) * totalCents - base[i] : 0 }))
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
