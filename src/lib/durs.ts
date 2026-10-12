/**
 * OPS-8 val 2 (v1.72.0) — DURS / ddv.inetis.com čisti sloj (brez DB, brez fetcha).
 *
 * Source: GET https://ddv.inetis.com/iskalnik3.aspx?isci=<tax number|name|maticna|IBAN>
 * (no API key; 200+[] = no hits; 400 <3 chars; 429 too many requests). Data comes from
 * daily FURS VAT-payer lists. This module normalizes input and response — the route
 * (/api/durs/check) adds auth, a 24h cache and error mapping (400/429/502).
 *
 * OPS-9 val 2 (v1.75.0) — EU rozširitev: tuji davčni zavezanci (VIES).
 * classifyDursQuery() razvrsti poizvedbo: 'si' (domača št. → Inetis/DURS),
 * 'eu' (tuji EU predponi → VIES REST) ali 'invalid' (naziv/prosto besedilo —
 * ostane pri obstoječi Inetis poti). normalizeViesResponse() preslika odgovor
 * ec.europa.eu VIES REST v isto obliko kot DursEntry (+ source: 'vies').
 */

export const DURS_UPSTREAM_URL = 'https://ddv.inetis.com/iskalnik3.aspx'
export const VIES_UPSTREAM_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms'

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
  /** OPS-9 val 2 — izvor vnosa: 'inetis' (DURS/FURS) ali 'vies' (EU REST); route ga doda */
  source?: 'inetis' | 'vies'
}

/** All EU member-state codes accepted by VIES + XI (Northern Ireland). */
const VIES_MS_CODES = 'AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|XI'
const VIES_VAT_RE = new RegExp(`^(${VIES_MS_CODES})[A-Z0-9]{5,12}$`, 'i')

/** Query classification: 'si' = domestic (Inetis/DURS), 'eu' = foreign EU VAT (VIES), 'invalid' = rest. */
export function classifyDursQuery(raw: string): 'si' | 'eu' | 'invalid' {
  const s = normalizeDursInput(raw)
  if (VIES_VAT_RE.test(s)) {
    const cc = s.slice(0, 2).toUpperCase()
    return cc === 'SI' ? 'si' : 'eu'
  }
  if (/^\d{8}$/.test(s)) return 'si'
  return 'invalid'
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
  return v
    .map((x) => {
      if (typeof x === 'string') return x.trim()
      // Inetis sometimes returns TRR rows as objects ({ TRR: 'SI56...' }) — take the first string value
      if (x && typeof x === 'object') {
        for (const val of Object.values(x as Record<string, unknown>)) {
          if (typeof val === 'string' && val.trim()) return val.trim()
        }
      }
      return ''
    })
    .filter(Boolean)
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

/* ─────────── OPS-9 val 2 (v1.75.0) — VIES (ec.europa.eu REST) ─────────── */

/**
 * Map the EU VIES REST response to the SAME shape as DURS entries (+ source: 'vies').
 * REST shape: { isValid: boolean, userError?: string, name?: string, address?: string,
 * countryCode?: string, vatNumber?: string } — name/address may be missing or "-" for
 * some member states. An invalid/unregistered number still yields an entry with
 * vatPayer=false (UI shows the ✗ badge); garbage input yields null.
 */
export function normalizeViesResponse(raw: unknown): (DursEntry & { source: 'vies' }) | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.isValid !== 'boolean') return null

  const countryCode = String(r.countryCode ?? '').trim().toUpperCase()
  const vatNumberRaw = String(r.vatNumber ?? '').trim().toUpperCase()
  const taxNumber = digitsOnly(vatNumberRaw)
  const nameRaw = String(r.name ?? '').trim()
  // VIES often reports "-" / "--" / empty for member states that do not return trader data
  const name = nameRaw && !/^-{1,4}$/.test(nameRaw) ? nameRaw : ''

  return {
    taxNumber,
    vatId: `${countryCode}${vatNumberRaw}`,
    name,
    vatPayer: r.isValid,
    ibans: [],
    source: 'vies',
  }
}
