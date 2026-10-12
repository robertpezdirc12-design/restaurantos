/**
 * OPS-10 val 3 (v1.79.0) — eSLOG e-račun priloge (arhiv obveznosti, ZERO DDL).
 *
 * Persistence: Integration row (name='ap-attachments', type='other', provider='internal')
 * keeps one entry per AccountsPayable document in its config JSON:
 *   { [apNumber]: { savedAt: ISO, truncated: boolean,
 *       attachments: [{ mimeCode, filename, sizeB, dataBase64? }] } }
 *
 * Budget (praktična meja Integration configa): combined base64 payload ≤ 1.5 MB per
 * AP; max 5 attachments per AP. Oversized payloads are stored as METADATA ONLY
 * (mimeCode/filename/sizeB) and the entry is flagged `truncated` — the caller
 * appends a note on the AP row (see oversizeNote).
 *
 * Retention: ZDavP-2 requires 10-year retention of received invoices — the UI
 * documents this next to the archive (no automatic purge is implemented here).
 *
 * Module is DB-FREE at import time (the storage helpers import src/lib/db lazily)
 * so the pure sanitizers are unit-testable without a database connection.
 */

export const AP_ATTACHMENTS_MARKER = 'ap-attachments'

/** Max attachments kept per AP document (first ones win after dedupe). */
export const MAX_ATTACHMENTS_PER_AP = 5

/** 1.5 MB combined base64 payload budget per AP (string length of the base64). */
export const MAX_TOTAL_BASE64_LENGTH = 1_500_000

/** Raw attachment as extracted from the eSLOG XML (src/lib/eslog.ts). */
export interface ApAttachmentRaw {
  mimeCode?: string
  filename?: string
  dataBase64?: string
}

/** Stored attachment: dataBase64 present only when the payload fit the budget. */
export interface ApAttachmentMeta {
  mimeCode: string
  filename: string
  /** approximate decoded byte size of the base64 payload (0 when absent) */
  sizeB: number
  dataBase64?: string
}

/** Per-AP entry stored in the Integration config. */
export interface ApAttachmentEntry {
  savedAt: string
  /** true when at least one payload exceeded the budget and was stored as metadata only */
  truncated: boolean
  attachments: ApAttachmentMeta[]
}

export interface ApAttachmentConfig {
  [apNumber: string]: ApAttachmentEntry
}

export interface SanitizeAttachmentsResult {
  attachments: ApAttachmentMeta[]
  /** true when at least one payload was dropped (kept as metadata only) */
  truncated: boolean
  /** total decoded bytes of payloads that did NOT fit the budget */
  droppedBytes: number
}

/**
 * Decoded byte size of a base64 string (tolerant: whitespace ignored, invalid
 * length tolerated). Deterministic for tests: 'JVBERi0xLjQKJcOkw7zDtsOf' → 18.
 */
export function base64ByteSize(b64: unknown): number {
  if (typeof b64 !== 'string') return 0
  const s = b64.replace(/\s+/g, '')
  if (!s) return 0
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad)
}

/** Human note appended to AP.notes when a payload did not fit the archive budget. */
export function oversizeNote(droppedBytes: number): string {
  const mb = Math.round((droppedBytes / (1024 * 1024)) * 10) / 10
  return `(priloga ${mb.toFixed(1)} MB prevelika za arhiv v nastavitvah)`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Pure sanitizer (unit-tested, never throws):
 *  - non-object entries / missing payload → metadata-only entries (tolerant);
 *  - dedupe by filename + sizeB (first wins — idempotent re-imports);
 *  - cap at MAX_ATTACHMENTS_PER_AP;
 *  - enforce the 1.5 MB combined base64 budget: payloads that do not fit are
 *    stored as metadata only and flagged through `truncated` + counted in
 *    `droppedBytes`; unknown/invalid mime codes are kept as-is (tolerant).
 */
export function sanitizeAttachments(
  raw: unknown,
  opts?: { maxTotalBase64Length?: number; maxAttachments?: number },
): SanitizeAttachmentsResult {
  const maxTotal = opts?.maxTotalBase64Length ?? MAX_TOTAL_BASE64_LENGTH
  const maxCount = opts?.maxAttachments ?? MAX_ATTACHMENTS_PER_AP
  const list: ApAttachmentRaw[] = Array.isArray(raw)
    ? (raw.filter((x): x is ApAttachmentRaw => !!x && typeof x === 'object') as ApAttachmentRaw[])
    : []

  const out: ApAttachmentMeta[] = []
  const seen = new Set<string>()
  let used = 0
  let truncated = false
  let droppedBytes = 0

  for (const item of list) {
    if (out.length >= maxCount) break
    const mimeCode = str(item.mimeCode)
    const filename = str(item.filename)
    const data = str(item.dataBase64)
    const sizeB = base64ByteSize(data)
    const dedupeKey = `${filename}::${sizeB}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    if (data && used + data.length <= maxTotal) {
      used += data.length
      out.push({ mimeCode, filename, sizeB, dataBase64: data })
    } else {
      if (data) {
        truncated = true
        droppedBytes += sizeB
      }
      out.push({ mimeCode, filename, sizeB })
    }
  }

  return { attachments: out, truncated, droppedBytes }
}

/* ─────────── storage helpers (server-only, lazy db import) ─────────── */

async function readConfig(): Promise<{ rowId: string | null; config: ApAttachmentConfig }> {
  const { db } = await import('@/lib/db')
  const { jparse } = await import('@/lib/map')
  const row = await db.integration.findFirst({ where: { name: AP_ATTACHMENTS_MARKER, type: 'other' } })
  if (!row) return { rowId: null, config: {} }
  const cfg = jparse<ApAttachmentConfig>(row.config, {})
  return { rowId: row.id, config: cfg && typeof cfg === 'object' ? cfg : {} }
}

async function writeConfig(rowId: string | null, config: ApAttachmentConfig): Promise<void> {
  const { db } = await import('@/lib/db')
  const json = JSON.stringify(config)
  if (rowId) {
    await db.integration.update({ where: { id: rowId }, data: { config: json } })
    return
  }
  await db.integration.create({
    data: {
      id: `${AP_ATTACHMENTS_MARKER}-${Date.now().toString(36)}`,
      name: AP_ATTACHMENTS_MARKER,
      type: 'other',
      provider: 'internal',
      config: json,
      isActive: true,
      syncEnabled: false,
    },
  })
}

/** Attachments stored for one AP document (null when none were archived). */
export async function getApAttachments(apNumber: string): Promise<ApAttachmentEntry | null> {
  try {
    const { config } = await readConfig()
    const entry = config[String(apNumber || '')]
    if (!entry || !Array.isArray(entry.attachments)) return null
    return entry
  } catch {
    return null
  }
}

/**
 * Map { [apNumber]: attachmentCount } over the whole archive — a cheap index for
 * the UI badge column (metadata only, payloads included but unused by callers).
 */
export async function getApAttachmentIndex(): Promise<Record<string, number>> {
  try {
    const { config } = await readConfig()
    const index: Record<string, number> = {}
    for (const [apNumber, entry] of Object.entries(config)) {
      const n = Array.isArray(entry?.attachments) ? entry.attachments.length : 0
      if (n > 0) index[apNumber] = n
    }
    return index
  } catch {
    return {}
  }
}

/**
 * Merge new attachments into the AP archive entry (idempotent):
 * existing entries win the filename+sizeB dedupe, then new ones are appended
 * (sanitize re-applies the cap and the 1.5 MB budget over the merged list).
 * Returns the persisted entry; NEVER throws (archive is best-effort by design).
 */
export async function upsertApAttachments(
  apNumber: string,
  atts: ApAttachmentRaw[],
): Promise<{ entry: ApAttachmentEntry | null; truncated: boolean; droppedBytes: number }> {
  try {
    const key = String(apNumber || '').trim()
    if (!key || !Array.isArray(atts) || atts.length === 0) {
      return { entry: null, truncated: false, droppedBytes: 0 }
    }
    const { rowId, config } = await readConfig()
    const existing = config[key]
    const existingList: ApAttachmentRaw[] = Array.isArray(existing?.attachments) ? existing.attachments : []
    // existing entries first — dedupe (first wins) makes re-imports idempotent
    const merged = sanitizeAttachments([...existingList, ...atts])
    const entry: ApAttachmentEntry = {
      savedAt: new Date().toISOString(),
      truncated: merged.truncated || existing?.truncated === true,
      attachments: merged.attachments,
    }
    config[key] = entry
    await writeConfig(rowId, config)
    return { entry, truncated: merged.truncated, droppedBytes: merged.droppedBytes }
  } catch {
    return { entry: null, truncated: false, droppedBytes: 0 }
  }
}
