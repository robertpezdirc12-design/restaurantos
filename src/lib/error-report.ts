/**
 * Issue #25 (P1) — validacija + sanitizacija diagnostičnega poročila napake
 * (POST /api/monitoring/errors) PRED zapisom v AuditLog.
 *
 * Prej (potrjena vrzel v issue-ju):
 *  - POST je sprejel poljuben JSON od kateregakoli prijavljenega uporabnika
 *    (edini pogoj: body.message truthy) in CELOTNO telo zapisal v AuditLog.details
 *    (jstr(body).slice(0, 2000)) — vključno s poljubnimi dodatnimi polji;
 *  - odgovor je vrnil mapAudit(log) → polje `data` = shranjeni details → surov
 *    odmev klientovega telesa nazaj pošiljatelju.
 *
 * Zdaj (ta modul):
 *  1. VALIDACIJA — allow-list DTO (message, code, component, correlationId,
 *     context), tipi, dolžine posameznih polj, zgornja meja context ključev,
 *     skupna velikost. Nepoznana polja in ugnezdeni objekti → zavrnitev (400).
 *  2. SANITIZACIJA / REDAKCIJA (obramba v globini — teče TUDI na dovoljenih
 *     poljih, ker message je prosti tekst uporabnika): bearer/basic glave,
 *     JWT trojčki, poznani žetonski prefiksi (sk_…, ghp_…, glpat-…, vcp_…,
 *     xox…-, AIza…), poverilnice v query-stringu, označene skrivnosti
 *     (password/token/secret/api key/session id/cvv/pin …), kartični PAN,
 *     e-poštni lokalni deli (PII) in stack-trace ogrodja.
 *  3. Zapis je SAMO kanonični DTO (jstr) — ne surovo telo; odgovor ne vrača
 *     details (samo accepted + reportId + status — glej route).
 *
 * Ločitev pravic (zahteva issue-ja): ODDAJA ostaja vsem prijavljenim
 * (requireAuth v ruti), VPogLED pa ostaja na settings.manage + lokacijski
 * obseg (GET — nedotaknjen). AuditLog/hash-chain infrastruktura in
 * locationId akterja ostajata (brez novega log sistema).
 */

// ── meje DTO (dokumentirane omejitve) ──
export const ERROR_REPORT_MAX_MESSAGE = 2000
export const ERROR_REPORT_MAX_CODE = 64
export const ERROR_REPORT_MAX_COMPONENT = 128
export const ERROR_REPORT_MAX_CORRELATION_ID = 64
export const ERROR_REPORT_MAX_CONTEXT_KEYS = 8
export const ERROR_REPORT_MAX_CONTEXT_KEY_LEN = 40
export const ERROR_REPORT_MAX_CONTEXT_VALUE_LEN = 200
/** Skupna velikost kanoničnega DTO (jstr) — preveliko telo se ZAVRNE. */
export const ERROR_REPORT_MAX_TOTAL = 4500

/** Dovoljena (edina) vrhnja polja diagnostičnega poročila. */
export const ERROR_REPORT_FIELDS = ['message', 'code', 'component', 'correlationId', 'context'] as const

export interface ErrorReportDto {
  message: string
  code?: string
  component?: string
  correlationId?: string
  context?: Record<string, string>
}

export interface ErrorReportOk {
  ok: true
  dto: ErrorReportDto
  /** imena redakcijskih vzorcev, ki so zadeli (samo število/imen se sme prikazati, ne vsebine) */
  redactions: string[]
}

export type ErrorReportResult =
  | ErrorReportOk
  | { ok: false; error: string }

// ── redakcija prostega besedila (obramba v globini) ──

const REDACTED = '[REDACTED]'
const REDACTED_JWT = '[REDACTED_JWT]'
const REDACTED_TOKEN = '[REDACTED_TOKEN]'
const REDACTED_PAN = '[REDACTED_PAN]'
const REDACTED_FRAME = '[STACK_FRAME_REDACTED]'

/** Nadzorni znaki (razen \n \t) + ANSI escape zapisi — log injection obramba.
 *  ANSI PRVI: sam izraz ESC [0-9;]* X, sicer bi alternativna veja za en znak ESC
 *  pojedla ESC in pustila "[31m" kot besedilo. */
const CTRL_RE = /\u001B\[[0-9;]*[A-Za-z]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Authorization glave: Bearer <žeton> / Basic <b64> — vrednost zamenjana. */
const AUTH_HEADER_RE = /\b(bearer|basic)\s+[a-z0-9\-._~+/]+=*/gi

/** JWT: trije base64url segmenti, glava se začne z "eyJ" (base64 '{'). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g

/** Poznani prefiksi strežniških žetonov (Stripe/GitHub/GitLab/Vercel/Slack/Google). */
const SERVICE_TOKEN_RE = /\b(?:sk-(?:live|test)-[A-Za-z0-9]{8,}|sk_[a-z]+_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9._-]{8,}|vcp_[A-Za-z0-9_\-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,})/g

/** Poverilnice v query-stringu URL: ?token=…&api_key=… (ime ostane, vrednost zamenjana). */
const QUERY_CRED_RE = /([?&](?:api[_-]?key|apikey|access[_-]?token|client[_-]?secret|password|passwd|secret|session[_-]?id|token|auth)=)[^&\s"']*/gi

/**
 * Označene skrivnosti v prostem tekstu: `password: x`, `token=x`,
 * `api_key: "y"` … Oznaka ostane, vrednost zamenjana. Zajema tudi cvv/pin.
 * \b na začetku vsake oznake ( »mapping=…« NE zadene pin ). Negativen pogled
 * naprej (?!\[REDACTED) prej zamaskirane vrednosti NE zadene znova (pravila
 * se izvajajo zaporedno — queryCredential/serviceToken pustita marker).
 */
const LABELED_SECRET_RE = /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd|session[_-]?id|authorization|cvv|cvc|pin|key)([ \t]*[:=][ \t]*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s,;)}\]'"&]+)/gi

/** Kartični PAN (13–19 števk, ločilo presledek/pomišljaj) — tudi brez ločil. */
const PAN_RE = /\b(?:\d{4}[ -]?){3}\d{1,4}\b/g

/** E-pošta (PII): lokalni del pusti prvo črko + *** (@domena ostane — nizka občutljivost). */
const EMAIL_RE = /([a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g

/** Stack-trace ogrodje: vrstice, ki se začnejo z `at ` (poti/moduli — nepotrebni). */
const STACK_FRAME_RE = /(^|\n)[ \t]*at[ \t][^\n]*/g

interface RedactionRule {
  name: string
  re: RegExp
  to: string
}

const REDACTION_RULES: RedactionRule[] = [
  { name: 'authHeader', re: AUTH_HEADER_RE, to: `$1 ${REDACTED}` },
  { name: 'jwt', re: JWT_RE, to: REDACTED_JWT },
  { name: 'serviceToken', re: SERVICE_TOKEN_RE, to: REDACTED_TOKEN },
  { name: 'queryCredential', re: QUERY_CRED_RE, to: `$1${REDACTED}` },
  { name: 'labeledSecret', re: LABELED_SECRET_RE, to: `$1$2${REDACTED}` },
  { name: 'cardPan', re: PAN_RE, to: REDACTED_PAN },
  { name: 'emailPii', re: EMAIL_RE, to: '$1***$2' },
  { name: 'stackFrame', re: STACK_FRAME_RE, to: `$1${REDACTED_FRAME}` },
]

/**
 * Sanitizacija enega niza: nadzorni znaki stran → redakcijska pravila po vrsti.
 * Vrne očiščen niz + imena zadetih pravil (za teste/telemetrijo, ne za vsebino).
 * Over-redakcija (npr. dolgo številko ali »key: vrednost« v nedolžnem tekstu)
 * je SPREJEMLJIVA smer — varnost > berljivost diagnoze.
 */
export function redactSensitiveText(text: string): { text: string; hits: string[] } {
  let out = text.replace(CTRL_RE, '')
  const hits: string[] = []
  for (const rule of REDACTION_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(out)) {
      rule.re.lastIndex = 0
      out = out.replace(rule.re, rule.to)
      hits.push(rule.name)
    }
  }
  return { text: out, hits }
}

// ── validacija DTO ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function boundedString(v: unknown, field: string, max: number, required: boolean): { ok: true; value: string } | { ok: false; error: string } {
  if (v === undefined || v === null) {
    if (required) return { ok: false, error: `message je obvezen.` }
    return { ok: true, value: '' }
  }
  if (typeof v !== 'string') return { ok: false, error: `Polje ${field} mora biti niz.` }
  const trimmed = v.trim()
  if (required && !trimmed) return { ok: false, error: `message je obvezen (ne prazen).` }
  if (trimmed.length > max) return { ok: false, error: `Polje ${field} je predolgo (max ${max} znakov).` }
  return { ok: true, value: trimmed }
}

/**
 * Validacija + sanitizacija telesa POST /api/monitoring/errors.
 * Vrne kanonični DTO (samo dovoljena, omejena in PO REDAKCIJI sanitizirana
 * polja) ali napako 400.
 */
export function validateErrorReport(body: unknown): ErrorReportResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Telo mora biti JSON objekt.' }
  }
  const unknownKeys = Object.keys(body).filter((k) => !(ERROR_REPORT_FIELDS as readonly string[]).includes(k))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `Nepoznana polja: ${unknownKeys.join(', ')} — dovoljena so samo: ${ERROR_REPORT_FIELDS.join(', ')}.`,
    }
  }

  const redactions = new Set<string>()
  const sanitize = (s: string): string => {
    const r = redactSensitiveText(s)
    r.hits.forEach((h) => redactions.add(h))
    return r.text
  }

  // message (obvezen)
  const msg = boundedString(body.message, 'message', ERROR_REPORT_MAX_MESSAGE, true)
  if (!msg.ok) return { ok: false, error: msg.error }
  const dto: ErrorReportDto = { message: sanitize(msg.value) }

  // code / component / correlationId (neobvezni nizi)
  for (const [field, max] of [
    ['code', ERROR_REPORT_MAX_CODE],
    ['component', ERROR_REPORT_MAX_COMPONENT],
    ['correlationId', ERROR_REPORT_MAX_CORRELATION_ID],
  ] as const) {
    const raw = body[field]
    if (raw === undefined) continue
    const r = boundedString(raw, field, max, false)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.value) (dto as unknown as Record<string, unknown>)[field] = sanitize(r.value)
  }

  // context (neobvezen PLOŠČAT objekt niz ≤ string)
  if (body.context !== undefined) {
    if (!isPlainObject(body.context)) {
      return { ok: false, error: 'context mora biti objekt niz → niz (brez ugnezdenih vrednosti).' }
    }
    const entries = Object.entries(body.context)
    if (entries.length > ERROR_REPORT_MAX_CONTEXT_KEYS) {
      return { ok: false, error: `context ima preveč ključev (max ${ERROR_REPORT_MAX_CONTEXT_KEYS}).` }
    }
    const ctx: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || !k.trim()) return { ok: false, error: 'context ključi morajo biti neprazni nizi.' }
      if (k.length > ERROR_REPORT_MAX_CONTEXT_KEY_LEN) {
        return { ok: false, error: `context ključ je predolg (max ${ERROR_REPORT_MAX_CONTEXT_KEY_LEN} znakov).` }
      }
      if (typeof v !== 'string') {
        return { ok: false, error: `context.${k} mora biti niz (ugnezdeni objekti/tipi niso dovoljeni).` }
      }
      const vTrimmed = v.trim()
      if (vTrimmed.length > ERROR_REPORT_MAX_CONTEXT_VALUE_LEN) {
        return { ok: false, error: `context.${k} je predolg (max ${ERROR_REPORT_MAX_CONTEXT_VALUE_LEN} znakov).` }
      }
      if (vTrimmed) ctx[sanitize(k)] = sanitize(vTrimmed)
    }
    if (Object.keys(ctx).length > 0) dto.context = ctx
  }

  // skupna velikost kanoničnega DTO
  if (JSON.stringify(dto).length > ERROR_REPORT_MAX_TOTAL) {
    return { ok: false, error: `Poročilo je preveliko (max ${ERROR_REPORT_MAX_TOTAL} znakov skupaj).` }
  }

  return { ok: true, dto, redactions: [...redactions] }
}
