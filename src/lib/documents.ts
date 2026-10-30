/**
 * OSS-2 (v1.203.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — čisti sloj
 * DOKUMENTOV S PRIPONKAMI (pure, 0 DB uvozov — vzorec equipment.ts).
 *
 * Splošni dokumenti po lokaciji: SOP-i, pogodbe, recepture, navodila (obseg
 * HACCP načrtov ostaja LOČEN — haccp-plans). Vsebina gre V BAZO (Prisma Bytes
 * — Postgres bytea / SQLite BLOB): produkcija ima read-only disk, datoteke
 * NIKOLI ne grejo na lokalni disk (ap-attachments budget vzorec). Budget
 * 1 MB raw na dokument.
 *
 * Varnost (deterministično, brez magične detekcije):
 *  - MIME allowlist — BREZ SVG/HTML (ni inline izvedbe tveganja); download
 *    VEDNO Content-Disposition: attachment + X-Content-Type-Options: nosniff.
 *  - fileName sanitizacija: brez poti (/, \, ..), brez kontrolnih znakov,
 *    brez skritih narekovajev za header, ≤ 200 znakov.
 *  - base64 validacija: čist alphabet, dolžina % 4 == 0; velikost izračunana
 *    iz dolžine (brez dekodiranja celotnega payloada pri validaciji).
 *
 * Kategorija je prost niz z znano množico (GRN/WasteRecord konvencija).
 * Zamenjava vsebine = cel paket fileName+mimeType+contentBase64 (pošteno
 * atomsko) → verzija +1; metapodatki (naziv/kategorija/opis) verzije NE
 * povečajo. Pravila vnosa: naziv 1–120, opis ≤ 500, kategorija iz množice.
 */

/** Znane kategorije dokumentov (prost niz — znana množica, GRN/WasteRecord konvencija). */
export const DOCUMENT_CATEGORIES = ['sop', 'pogodba', 'receptura', 'navodilo', 'ostalo'] as const
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

export const DEFAULT_DOCUMENT_CATEGORY: DocumentCategory = 'sop'

/** Budget vsebine: 1 MB RAW na dokument (base64 ≈ 1.37 MB) — ap-attachments vzorec. */
export const MAX_DOCUMENT_BYTES = 1_000_000

/** Maksimalna dolžina imena datoteke (sanitizirano). */
export const MAX_FILE_NAME_LENGTH = 200

/**
 * MIME allowlist (deterministično, točne vrednosti — BREZ prefix divjanja):
 * PDF, slike PNG/JPEG/WebP, golo besedilo, CSV ter Office OpenXML (docx/xlsx/
 * pptx). SVG (image/svg+xml) in HTML (text/html) NISTA na listi — ni inline
 * izvedbe; brskalnik dokument prejme kot attachment (nosniff).
 */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const

export function isAllowedMime(m: unknown): boolean {
  return typeof m === 'string' && (ALLOWED_MIME_TYPES as readonly string[]).includes(m)
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Veljaven čist base64 (brez data: URL predpone — odreže klicatelj oz. parse). */
export function isValidBase64(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length % 4 !== 0) return false
  return BASE64_RE.test(s)
}

/** Poštena ocena raw velikosti iz base64 dolžine (brez dekodiranja). */
export function base64SizeBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/** Odreže `data:…;base64,` predpono (FileReader.readAsDataURL izhod) — čist input. */
export function stripBase64DataUrl(v: string): string {
  const m = /^data:[^;]*;base64,/i.exec(v)
  return m ? v.slice(m[0].length) : v
}

/**
 * Sanitizacija imena datoteke: pot (/, \, ..) ven, kontrolni znaki ven,
 * narekovaji in presledki na robu ven, ≤ 200 znakov. null = imena ni moč rešiti
 * (prazno po sanitizaciji).
 */
export function safeFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const cleaned = v
    .replace(/[/\\]/g, '-')
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/**
 * RFC 5987/6266 Content-Disposition vrednost: ASCII padajoča ime v filename="" +
 * UTF-8 percent-kodirana v filename*. Deterministično — enaka vhoda, enak izhod.
 */
export function contentDispositionValue(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/\\/g, '_').replace(/"/g, '_')
  const encoded = encodeURIComponent(fileName)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export interface ParsedDocumentInput {
  title: string
  category: DocumentCategory
  description: string | null
  fileName: string
  mimeType: string
  contentBase64: string
  sizeBytes: number
}

export interface ParsedDocumentPatch {
  title?: string
  category?: DocumentCategory
  description?: string | null
  /** podana VSA TROJICA → zamenjava vsebine (verzija +1 v ruti) */
  fileName?: string
  mimeType?: string
  contentBase64?: string
  sizeBytes?: number
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function asTrimmedString(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') return undefined
  return v.trim()
}

/**
 * Parse novega dokumenta (POST). locationId reši RUTA (requireUserLocation vzorec).
 * contentBase64 sme priti tudi kot FileReader data: URL (stripBase64DataUrl).
 */
export function parseDocumentInput(body: unknown): ParseResult<ParsedDocumentInput> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Neveljaven vnos.' }
  const b = body as Record<string, unknown>

  const title = asTrimmedString(b.title)
  if (!title) return { ok: false, error: 'Naziv je obvezen (1–120 znakov).' }
  if (title.length > 120) return { ok: false, error: 'Naziv je preveč dolg (največ 120 znakov).' }

  const rawCategory = asTrimmedString(b.category)
  if (rawCategory !== undefined && rawCategory !== '') {
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(rawCategory)) {
      return { ok: false, error: 'Neznana kategorija dokumenta.' }
    }
  }
  const category = (rawCategory === undefined || rawCategory === '' ? DEFAULT_DOCUMENT_CATEGORY : rawCategory) as DocumentCategory

  const description = asTrimmedString(b.description) ?? null
  if (description !== null && description.length > 500) {
    return { ok: false, error: 'Opis je predolg (največ 500 znakov).' }
  }

  const fileName = safeFileName(b.fileName)
  if (!fileName) return { ok: false, error: 'Ime datoteke je obvezno.' }

  if (!isAllowedMime(b.mimeType)) {
    return { ok: false, error: 'Vrsta datoteke ni dovoljena (PDF, PNG/JPEG/WebP, besedilo, CSV, Office OpenXML).' }
  }
  const mimeType = b.mimeType as string

  const raw = b.contentBase64
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'Vsebina datoteke (base64) je obvezna.' }
  }
  const contentBase64 = stripBase64DataUrl(raw.trim())
  if (!isValidBase64(contentBase64)) {
    return { ok: false, error: 'Vsebina ni veljaven base64.' }
  }
  const sizeBytes = base64SizeBytes(contentBase64)
  if (sizeBytes === 0) {
    return { ok: false, error: 'Datoteka je prazna.' }
  }
  if (sizeBytes > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: `Datoteka presega omejitev ${Math.round(MAX_DOCUMENT_BYTES / 1000)} kB.` }
  }

  return {
    ok: true,
    value: { title, category, description, fileName, mimeType, contentBase64, sizeBytes },
  }
}

/**
 * Parse delnega popravka (PATCH). Metapodatki so samostojni; zamenjava vsebine
 * zahteva CEL paket (fileName + mimeType + contentBase64) — delni paket je
 * napaka (pošteno atomsko, brez pol-spremenjenih dokumentov).
 */
export function parseDocumentPatch(body: unknown): ParseResult<ParsedDocumentPatch> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Neveljaven vnos.' }
  const b = body as Record<string, unknown>
  const out: ParsedDocumentPatch = {}

  const title = asTrimmedString(b.title)
  if (title !== undefined) {
    if (!title || title.length > 120) return { ok: false, error: 'Naziv je obvezen (1–120 znakov).' }
    out.title = title
  }

  const category = asTrimmedString(b.category)
  if (category !== undefined) {
    if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, error: 'Neznana kategorija dokumenta.' }
    }
    out.category = category as DocumentCategory
  }

  if ('description' in b) {
    const d = b.description
    if (d === null) out.description = null
    else {
      const ds = asTrimmedString(d)
      if (ds === undefined) return { ok: false, error: 'Opis mora biti niz ali null.' }
      if (ds.length > 500) return { ok: false, error: 'Opis je predolg (največ 500 znakov).' }
      out.description = ds === '' ? null : ds
    }
  }

  const hasFileName = b.fileName !== undefined
  const hasMime = b.mimeType !== undefined
  const hasContent = b.contentBase64 !== undefined
  if (hasFileName || hasMime || hasContent) {
    if (!(hasFileName && hasMime && hasContent)) {
      return { ok: false, error: 'Zamenjava datoteke zahteva ime, vrsto in vsebino skupaj.' }
    }
    const fileName = safeFileName(b.fileName)
    if (!fileName) return { ok: false, error: 'Ime datoteke je obvezno.' }
    if (!isAllowedMime(b.mimeType)) {
      return { ok: false, error: 'Vrsta datoteke ni dovoljena (PDF, PNG/JPEG/WebP, besedilo, CSV, Office OpenXML).' }
    }
    const raw = b.contentBase64
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { ok: false, error: 'Vsebina datoteke (base64) je obvezna.' }
    }
    const contentBase64 = stripBase64DataUrl(raw.trim())
    if (!isValidBase64(contentBase64)) return { ok: false, error: 'Vsebina ni veljaven base64.' }
    const sizeBytes = base64SizeBytes(contentBase64)
    if (sizeBytes === 0) return { ok: false, error: 'Datoteka je prazna.' }
    if (sizeBytes > MAX_DOCUMENT_BYTES) {
      return { ok: false, error: `Datoteka presega omejitev ${Math.round(MAX_DOCUMENT_BYTES / 1000)} kB.` }
    }
    out.fileName = fileName
    out.mimeType = b.mimeType as string
    out.contentBase64 = contentBase64
    out.sizeBytes = sizeBytes
  }

  if (Object.keys(out).length === 0) return { ok: false, error: 'Brez sprememb.' }
  return { ok: true, value: out }
}

/** Minimalna oblika DB vrstice za DTO (content NI vključen — list nikoli ne nosi bloba). */
export interface DocumentRowLike {
  id: string
  locationId: string
  title: string
  category: string
  description: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  version: number
  createdAt: Date
  updatedAt: Date
  createdById: string | null
  updatedById: string | null
}

export interface DocumentDto {
  id: string
  locationId: string
  title: string
  category: string
  description: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  version: number
  createdAt: string
  updatedAt: string
}

/** Pure preslikava (vzorec equipmentDto) — content NIKOLI v DTO (seznam je lahek). */
export function documentDto(r: DocumentRowLike): DocumentDto {
  return {
    id: r.id,
    locationId: r.locationId,
    title: r.title,
    category: r.category,
    description: r.description,
    fileName: r.fileName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

/** Človeku berljiva velikost (kB/MB, ena decimalka) — deterministično. */
export function humanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace(/\.0$/, '')} kB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}
