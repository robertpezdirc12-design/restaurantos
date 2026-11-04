/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 B — Lightspeed maj
 * 2026 »preset notes … reusable notes … keep kitchen instructions
 * consistent«) — REGISTAR PREDNASTAVLJENIH OPOMB ZA KUHINJO.
 *
 * IZMERA pred valom: cela cev opomb obstaja RAZEN vnosa — createOrderCore
 * sprejema note per postavka (OrderItem.notes), KDS listek kaže »ℹ opomba«,
 * postajni nalogi nosijo opombo v detailu, kuhinjski/bar list tiska
 * »opomba: …«. Manjkala je izbira v košaricah POS in Registr rezuabilnih
 * opomb (Lightspeed Back Office > Menu > Production instructions > Notes).
 *
 * Shranjevanje: Integration vrstica `preset-notes-config` per lokacija
 * (0 DDL — vzorec ops-checklists/table-combos). Čisti sloj (0 uvozov):
 * parse = defenzivno branje (neveljavne tiho ven — self-healing), validate =
 * STROGA validacija pisanja (napaka je napaka).
 *
 * ISKRENA MEJA (§22 B): ena opomba per vrstica, ki gre VEDNO na KDS in na
 * tisk — per-note stikalo tiska je Back Office niansa, ki bi zahtevala
 * shranjevanje zastavice na postavki; naša opomba je ena resnica povsod.
 */

/** Integration feature marker (ime vrstice, type 'other'). */
export const PRESET_NOTES_MARKER = 'preset-notes-config'

/** Največ prednastavljenih opomb na lokacijo (ist prag kot predloge seznamov). */
export const MAX_PRESET_NOTES = 20

/** Najdaljša oznaka opombe (kuhinjsko navodilo, ne esej). */
export const MAX_PRESET_NOTE_LABEL = 60

/** Ena prednastavljena opomba (kanonična oblika v Integration config). */
export interface PresetNote {
  id: string
  label: string
  sortOrder: number
}

/**
 * Defenzivno branje registra (jparse — Integration.config Json se prebere
 * kot string). Neveljavni vnosi se tiho izpustijo (self-healing — vzorec
 * parseChecklistTemplates); pisanje validira STROGO (validatePresetNotes).
 */
export function parsePresetNotes(raw: unknown): PresetNote[] {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw
  const o = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as { notes?: unknown }
  if (!Array.isArray(o.notes)) return []
  const out: PresetNote[] = []
  for (const n of o.notes) {
    if (!n || typeof n !== 'object') continue
    const row = n as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const label = String(row.label ?? '').trim()
    if (!id || !label) continue
    const sortOrder = Number(row.sortOrder)
    out.push({
      id,
      label: label.slice(0, MAX_PRESET_NOTE_LABEL),
      sortOrder: Number.isFinite(sortOrder) ? Math.max(0, Math.round(sortOrder)) : out.length,
    })
  }
  return out.slice(0, MAX_PRESET_NOTES)
}

/** jparse brez uvoza (0-odvisnostna disciplina tega sloja). */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export type PresetNotesValidationResult =
  | { notes: PresetNote[]; error: null }
  | { notes: []; error: string }

/**
 * STROGA validacija pisanja: ≤ 20 opomb, oznaka obvezna ≤ 60, id se dodeli
 * če manjka, duplikati zavrnjeni, vrstni red celo število ≥ 0. Napaka je
 * napaka — ne tiho popravljanje (validateChecklistTemplates disciplina).
 */
export function validatePresetNotes(raw: unknown): PresetNotesValidationResult {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { notes?: unknown }).notes)) {
    return { notes: [], error: 'Podajte polje "notes".' }
  }
  const list = (raw as { notes: unknown[] }).notes
  if (list.length > MAX_PRESET_NOTES) {
    return { notes: [], error: `Največ ${MAX_PRESET_NOTES} prednastavljenih opomb na lokacijo.` }
  }
  const seen = new Set<string>()
  const out: PresetNote[] = []
  for (const [idx, n] of list.entries()) {
    if (!n || typeof n !== 'object') return { notes: [], error: 'Neveljavna opomba.' }
    const row = n as Record<string, unknown>
    const label = String(row.label ?? '').trim()
    if (!label) return { notes: [], error: `Opomba #${idx + 1} potrebuje besedilo.` }
    if (label.length > MAX_PRESET_NOTE_LABEL) {
      return { notes: [], error: `Opomba »${label.slice(0, 20)}…« je predolga (največ ${MAX_PRESET_NOTE_LABEL} znakov).` }
    }
    const id = row.id === undefined || row.id === null || String(row.id).trim() === ''
      ? `pn-${idx + 1}`
      : String(row.id).trim()
    if (seen.has(id)) return { notes: [], error: `Podvojen id opombe: ${id}.` }
    seen.add(id)
    const sortOrder = Number(row.sortOrder)
    out.push({
      id,
      label,
      sortOrder: Number.isFinite(sortOrder) ? Math.max(0, Math.round(sortOrder)) : idx,
    })
  }
  return { notes: out, error: null }
}

/**
 * Sestavi opombo vrstice iz izbire: izbrane prednastavljene oznake + prosto
 * besedilo, združene z »; « (kuhinjski list tiska ENO vrstico »opomba: …«).
 * Prazna izbira in prazno besedilo → '' (brez opombe — nič se ne laže).
 * Besedilo se poreže na 200 (isti prag kot OrderItem alergensko opozorilo —
 * strežnik pri zapisu ne zaupa dolžine klienta).
 */
export function composeItemNote(presetLabels: readonly string[], freeText: string): string {
  const text = String(freeText ?? '').trim()
  const parts = [
    ...presetLabels.map((l) => String(l ?? '').trim()).filter(Boolean),
    ...(text ? [text] : []), // prazno besedilo ne pusti praznega dela (»x; «)
  ]
  return parts.join('; ').slice(0, 200)
}
