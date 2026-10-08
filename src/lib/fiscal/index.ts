/**
 * Fiskalni adapterji po državi lokacije (issue #1 triage — SI/HR fiskalizacija).
 *
 * Načelo iz triage: »ločen modul po državi/lokaciji (Location.country → adapter
 * SI|HR), pred implementacijo preverim aktualne uradne specifikacije — ne ugibam.«
 *
 * Preverjeni uradni viri (Hrvaška — Fiskalizacija 2.0):
 *  - Zakon o fiskalizaciji (NN 89/2025, na snazi 1. 9. 2025) — zamenja zakon iz 2012;
 *    fiskalizacija VSEH računov v krajnji potrošnji ne glede na način plačila (čl. 3).
 *  - Pravilnik o fiskalizaciji računa u krajnjoj potrošnji (NN 153/2025, uporaba od
 *    1. 1. 2026) — ureja obliko JIR-a in ZKI-ja ter vsebino QR kode.
 *  - Tehnična specifikacija Porezne uprave »Fiskalizacija računa u krajnjoj potrošnji«:
 *    QR vsebuje `https://porezna.gov.hr/rn?jir=<JIR>&datv=<YYYYMMDD_HHMM>&izn=<iznos>`
 *    (ali `zki=` za račune še brez JIR); JIR ima 36 znakov (UUID), ZKI 32 znakov.
 *
 * Produkcija (SI FURS in HR Porezna) zahteva kvalificiran certifikat — do njegove
 * namestitve adapter vrne prazne kode, route označi račun 'pending' + audit
 * (isti vzorec kot obstoječi FURS produkcija). SIMULACIJA izračuna testne kode
 * z jasno oznako (simulated: true) — nikoli se ne lažira produkcija.
 */

import crypto from 'crypto'

export interface FiscalInput {
  taxId: string
  issuedAt: Date
  receiptNumber: string
  premisesId: string
  total: number
  simulation: boolean
}

export interface FiscalCodes {
  /** ZOI (SI) / ZKI (HR). '' v produkciji brez certifikata → račun 'pending'. */
  protective: string
  /** EOR (SI) / JIR (HR). '' v produkciji (prijavi ga Porezna/FURS). */
  verification: string
  /** Oznaka algoritma (audit/prikaz); '' ko produkcija brez certifikata. */
  algo: string
  /** true = test/sandbox koda (smemo tiskati z oznako simulacija). */
  simulated: boolean
}

export interface FiscalQrInput {
  verification: string
  protective: string
  issuedAt: Date
  total: number
}

export interface FiscalAdapter {
  country: 'SI' | 'HR'
  /** Oznaka zaščitnega kode za UI/tisk (ZOI / ZKI). */
  codeLabel: string
  /** Oznaka verifikacijske kode (EOR / JIR). */
  verifyLabel: string
  /** Produkcija zahteva certifikat (FURS/FINA) — brez njega koda '' + pending. */
  requiresCertificate: boolean
  computeCodes(input: FiscalInput): FiscalCodes
  /** Vsebina QR kode za potrditev računa (HR: uradni URL; SI: null — ni del toka). */
  qrContent(input: FiscalQrInput): string | null
  /** Validacija verifikacijske kode (HR JIR = UUID 36 znakov; SI EOR = passthrough). */
  isValidVerificationCode(raw: string): boolean
}

/** Fabrika po državi lokacije — nepoznana država → SI (varno, sedanje vedenje). */
export function fiscalAdapterFor(country: string | null | undefined): FiscalAdapter {
  const c = (country || '').trim().toUpperCase()
  if (c === 'HR') return hrAdapter
  return siAdapter
}

// ── SI — FURS (Zakon o davčnem postopku / Pravilnik o fiskalizaciji, simulacija) ──
// Koda MORA ostati byte-identična prejšnji vgradnji v /api/furs (§18): MD5 nad
// združenim nizom. Regresijski vektor: tests/fiscal.test.ts.

export interface SiFiscalInput {
  taxId: string
  issuedAt: Date
  receiptNumber: string
  premisesId: string
  total: number
}

/** ZOI — izvlečena 1:1 iz /api/furs (SI simulacija). */
export function computeZoi(input: SiFiscalInput): string {
  const payload = `${input.taxId}${input.issuedAt.toISOString()}${input.receiptNumber}${input.premisesId}${input.total.toFixed(2)}`
  return crypto.createHash('md5').update(payload).digest('hex')
}

const siAdapter: FiscalAdapter = {
  country: 'SI',
  codeLabel: 'ZOI',
  verifyLabel: 'EOR',
  requiresCertificate: true,
  computeCodes(input) {
    if (!input.simulation) return { protective: '', verification: '', algo: '', simulated: false }
    return {
      protective: computeZoi(input),
      verification: crypto.randomUUID().toUpperCase(),
      algo: 'SI-ZOI-MD5',
      simulated: true,
    }
  },
  qrContent() {
    // FURS QR za potrditev ni del tega toka (spec: EOR/ZOI na računu) — null.
    return null
  },
  isValidVerificationCode() {
    // EOR nima javno dokumentirane stabilne oblike — passthrough (kot do sedaj).
    return true
  },
}

// ── HR — Porezna uprava (Fiskalizacija 2.0, NN 89/2025 + Pravilnik NN 153/2025) ──

const JIR_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

/** Testni ZKI (simulacija): SHA-256 → prvih 32 hex znakov (spec: ZKI = 32 znakov). */
export function computeHrTestZki(input: FiscalInput): string {
  const payload = `${input.taxId}|${input.issuedAt.toISOString()}|${input.receiptNumber}|${input.premisesId}|${input.total.toFixed(2)}`
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

/** datv = datum in čas izdaje v uradni obliki YYYYMMDD_HHMM (prim. spec primer 20200921_0630). */
export function hrDatv(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** izn = znesek z vejico kot decimalnim ločilom, 2 decimalki (prim. spec primer izn=1000000,00). */
export function hrIzn(total: number): string {
  return total.toFixed(2).replace('.', ',')
}

/** Uradni QR URL Porezne uprave — JIR, če obstaja, sicer ZKI (prim. spec). */
export function hrQrContent(input: FiscalQrInput): string {
  const code = input.verification ? `jir=${input.verification}` : `zki=${input.protective}`
  return `https://porezna.gov.hr/rn?${code}&datv=${hrDatv(input.issuedAt)}&izn=${hrIzn(input.total)}`
}

const hrAdapter: FiscalAdapter = {
  country: 'HR',
  codeLabel: 'ZKI',
  verifyLabel: 'JIR',
  requiresCertificate: true,
  computeCodes(input) {
    if (!input.simulation) return { protective: '', verification: '', algo: '', simulated: false }
    return {
      protective: computeHrTestZki(input),
      verification: crypto.randomUUID().toUpperCase(),
      algo: 'HR-ZKI-SHA256-TEST',
      simulated: true,
    }
  },
  qrContent(input) {
    if (!input.verification && !input.protective) return null
    return hrQrContent(input)
  },
  isValidVerificationCode(raw: string) {
    return JIR_RE.test(String(raw || '').trim())
  },
}

export { siAdapter, hrAdapter }
