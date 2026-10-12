/**
 * OPS-8 val 2 (v1.72.0) — DURS / ddv.inetis.com čisti sloj (brez DB, brez fetcha).
 *
 * Source: GET https://ddv.inetis.com/iskalnik3.aspx?isci=<tax number|name|maticna|IBAN>
 * (no API key; 200+[] = no hits; 400 <3 chars; 429 too many requests). Data comes from
 * daily FURS VAT-payer lists. This module normalizes input and response — the route
 * (/api/durs/check) adds auth, a 24h cache and error mapping (400/429/502).
 */

export const DURS_UPSTREAM_URL = 'https://ddv.inetis.com/iskalnik3.aspx'

export interface DursEntry {
  /** davčna številka — samo števke (brez SI) */
  taxNumber: string
  /** SI + davčna (identifikator za DDV) */
  vatId: string
  /** naziv subjekta (Naziv) */
  name: string
  /** zavezanec za DDV (ZavezanecZaDDV) */
  vatPayer: boolean
  /** transakcijski računi (TRR[]) */
  ibans: string[]
}

/** Normalize user input: strip spaces; 8 plain digits → SI prefix. */
export function normalizeDursInput(raw: string): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, '')
  if (/^\d{8}$/.test(s)) return `SI${s}`
  return s
}

function digitsOnly(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '')
}

function ibansOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim()).filter(Boolean)
}

/**
 * Tolerant parsing of the ddv.inetis.com response (JSON array).
 * Fields: DavcnaStevilka, Naziv, ZavezanecZaDDV, TransakcijskiRacuni[] (TRR[] alias).
 * Unknown shapes are skipped; vatPayer defaults to false (only explicit true counts).
 */
export function normalizeDursResponse(raw: unknown): DursEntry[] {
  if (!Array.isArray(raw)) return []
  const out: DursEntry[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const taxNumber = digitsOnly(r.DavcnaStevilka ?? r.davcnaStevilka ?? r.taxNumber)
    const name = String(r.Naziv ?? r.naziv ?? r.name ?? '').trim()
    if (!taxNumber && !name) continue
    const vatPayerRaw = r.ZavezanecZaDDV ?? r.zavezanecZaDDV ?? r.vatPayer
    const vatPayer = vatPayerRaw === true || vatPayerRaw === 'true' || vatPayerRaw === 'Da' || vatPayerRaw === 1
    const ibans = ibansOf(r.TransakcijskiRacuni ?? r.transakcijskiRacuni ?? r.TRR ?? r.trr)
    out.push({
      taxNumber,
      vatId: taxNumber ? `SI${taxNumber}` : '',
      name,
      vatPayer,
      ibans,
    })
  }
  return out
}

/** Most relevant hit: exact taxNumber match > name contains query > first entry. */
export function pickDursEntry(entries: DursEntry[], query: string): DursEntry | null {
  if (entries.length === 0) return null
  const digits = digitsOnly(query)
  if (digits.length === 8) {
    const exact = entries.find((e) => e.taxNumber === digits)
    if (exact) return exact
  }
  const lower = normalizeDursInput(query).toLowerCase()
  const byName = entries.find((e) => e.name.toLowerCase().includes(lower) && lower.length >= 3)
  return byName || entries[0]
}
