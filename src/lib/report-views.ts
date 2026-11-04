/**
 * v1.247.0 (PRIMERJAVA-VMESNIKOV-2026 §21) — POGLEDI VAL: shranjeni pogledi
 * poročil (Lightspeed april 2026 »saved report views«).
 *
 * Merjena situacija: Računovodski izvoz (AccountingExportCard) zahteva ob
 * vsakem zagonu 4 ročne izbire (sekcija, Od, Do, format) — knjigovodski
 * izvoz vsak mesec, tedenski X/Z vsak ponedeljek; food-cost varianca vsak
 * teden. Lightspeed (april 2026): prilagodi poročilo enkrat, shrani pogled,
 * dosegaj ga z enim klikom.
 *
 * DVE odločitvi, izpeljani iz kode:
 *  1. RELATIVNA obdobja — fiksna datuma zastarita (pogled shranjen novembra
 *     je decembra neuporaben). Shranjeni pogled nosi PREDLOG obdobja, ki se
 *     ob vsakem zagonu reši SVEŽE (»ta mesec« je vedno trenutni mesec).
 *  2. SKUPNI registr per lokacija (Integration vrstica, 0 DDL — vzorec
 *     resv-pacing-config v1.244 / table-combos-config v1.245 / ops-checklists
 *     -config v1.246), NE per zaposleni: v gostilni z 2–3 poročevalci je
 *     skupna knjižnica poštena — ko je Ana na dopustu, poteže Borut isti
 *     mesečni izvoz (Lightspeed ima osebne poglede; naša ekipa si deli delo).
 *     Iskrena meja: brez per-uporabniške lastnine — to bi zahtevalo DDL.
 *
 * Jedro tega modula je ČISTO (0 DB uvozov) — testirljivo brez baze, vzorec
 * ops-checklists.ts (lekcija v1.246.0). DB dostop (loadSavedReportViews)
 * je na koncu modula za strežniške potrošnike.
 */

import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
// ponovna uporaba ČISTIH datumskih helperjev (disciplina »ne podvajamo« —
// isti vzorec kot seatCandidatesForParty v table-combos, skupna resnica)
import { dayKeyOf } from '@/lib/sales-by-hour'
import { isValidDateKey } from '@/lib/ops-checklists'

/** Marker Integration vrstice s shranjenimi pogledi poročil (per lokacija). */
export const SAVED_REPORT_VIEWS_MARKER = 'saved-report-views-config'

/** Največje število shranjenih pogledov na lokacijo (varovalo pisanja). */
export const MAX_SAVED_REPORT_VIEWS = 20

/** Poročili, ki ju shranjeni pogled lahko poteže (odprt nabor — ddv/ddv). */
export const SAVED_VIEW_REPORTS = ['export', 'food-cost'] as const
export type SavedViewReport = (typeof SAVED_VIEW_REPORTS)[number]

/** Sekcije računovodskega izvoza (izvoz natanko kot AccountingExportCard). */
export const EXPORT_SECTIONS = ['summary', 'dnevnik', 'ddv', 'zz'] as const
export type ExportSection = (typeof EXPORT_SECTIONS)[number]

/** Formati izvoza. */
export const EXPORT_FORMATS = ['csv', 'json'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/**
 * Predlogi obdobij. Fiksni datumi namenoma NE obstajajo kot predlog —
 * shranjen pogled z fiksnim obdobjem je naslednji mesec mrtev (edina
 * izjema je 'custom' za izjeme, ki jih relativnost ne pokrije).
 */
export const REPORT_RANGE_PRESETS = [
  'today', 'yesterday', 'thisWeek', 'lastWeek',
  'thisMonth', 'lastMonth',
  'last7', 'last30', 'last90',
  'ytd', 'custom',
] as const
export type ReportRangePreset = (typeof REPORT_RANGE_PRESETS)[number]

/** Kanonična oblika shranjenega pogleda (tako kot je shranjen v registru). */
export interface SavedReportView {
  id: string
  name: string
  report: SavedViewReport
  /** samo 'export': katera sekcija izvoza (privzeto 'summary'). */
  section?: ExportSection
  /** samo 'export': format datoteke (privzeto 'csv'). */
  format?: ExportFormat
  range: ReportRangePreset
  /** samo 'custom': fiksni datumi YYYY-MM-DD (from ≤ to). */
  from?: string
  to?: string
}

/* ─────────────────── ČISTO JEDRO: reševanje obdobij ─────────────────── */

/* Datumski helperji so PONOVNO UPORABLJENI (dayKeyOf — lokalni ključ YYYY-MM-DD,
 * NI UTC; isValidDateKey — obrambna validacija) iz obstoječih čistih modulov. */

/** Ponedeljek tedna, v katerem je `d` (slovenska konvencija, ISO teden). */
function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const shift = (m.getDay() + 6) % 7 // nedelja = 0 → 6; ponedeljek = 1 → 0
  m.setDate(m.getDate() - shift)
  return m
}

function daysAgo(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - n)
  return x
}

/**
 * Reši predlog obdobja v konkretna datuma (LOKALNO, glede na `now`).
 *
 * Poštena semantika »do zdaj«: tekoči teden/mesec/leto se končata z DNES
 * (prihodnji dnevi so prazni — datoteka z devetimi praznimi dnevi je laž);
 * ZAKLJUČENA obdobja (prejšnji teden/mesec, včeraj) pokrijejo celotno
 * obdobje. last7/30/90 so vključujoči okni (danes + 6/29/89 prejšnjih).
 */
export function resolveReportRange(
  preset: ReportRangePreset,
  now: Date,
  custom?: { from?: string; to?: string },
): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (preset) {
    case 'today':
      return { from: dayKeyOf(today), to: dayKeyOf(today) }
    case 'yesterday': {
      const y = daysAgo(today, 1)
      return { from: dayKeyOf(y), to: dayKeyOf(y) }
    }
    case 'thisWeek': {
      const mon = mondayOf(today)
      return { from: dayKeyOf(mon), to: dayKeyOf(today) }
    }
    case 'lastWeek': {
      const mon = mondayOf(today)
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate())
      sun.setDate(sun.getDate() - 1) // nedelja prejšnjega tedna
      const lastMon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate())
      lastMon.setDate(lastMon.getDate() - 7)
      return { from: dayKeyOf(lastMon), to: dayKeyOf(sun) }
    }
    case 'thisMonth':
      return { from: dayKeyOf(new Date(today.getFullYear(), today.getMonth(), 1)), to: dayKeyOf(today) }
    case 'lastMonth': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const last = new Date(today.getFullYear(), today.getMonth(), 0) // zadnji dan prejšnjega meseca
      return { from: dayKeyOf(first), to: dayKeyOf(last) }
    }
    case 'last7':
      return { from: dayKeyOf(daysAgo(today, 6)), to: dayKeyOf(today) }
    case 'last30':
      return { from: dayKeyOf(daysAgo(today, 29)), to: dayKeyOf(today) }
    case 'last90':
      return { from: dayKeyOf(daysAgo(today, 89)), to: dayKeyOf(today) }
    case 'ytd':
      return { from: dayKeyOf(new Date(today.getFullYear(), 0, 1)), to: dayKeyOf(today) }
    case 'custom': {
      const from = typeof custom?.from === 'string' ? custom.from : ''
      const to = typeof custom?.to === 'string' ? custom.to : ''
      return { from, to }
    }
  }
}

/** Človeška oznaka predloga za prikaz (ključ i18n, ne izpis). */
export function rangeLabelKey(preset: ReportRangePreset): string {
  return `rv.range.${preset}`
}

/* ─────────── OBRAMBNO BRANJE (self-healing, vzorec parseCombos) ─────────── */

/**
 * Defenzivna normalizacija registra pogledov: neveljavne vrstice se TIHO
 * izpustijo (json niz ali objekt — Integration.config Json se prebere kot
 * string, vzorec jparse). Nazaj samo kanonske vnose.
 */
export function parseSavedReportViews(raw: unknown): SavedReportView[] {
  const parsed = jparse<unknown>(raw, null)
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as { views?: unknown }
  if (!Array.isArray(o.views)) return []
  const out: SavedReportView[] = []
  const seen = new Set<string>()
  for (const v of o.views) {
    if (!v || typeof v !== 'object') continue
    const row = v as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const name = String(row.name ?? '').trim()
    const report = String(row.report ?? '').trim()
    const range = String(row.range ?? '').trim()
    if (!id || id.length > 64 || seen.has(id)) continue
    if (!name || name.length > 80) continue
    if (!(SAVED_VIEW_REPORTS as readonly string[]).includes(report)) continue
    if (!(REPORT_RANGE_PRESETS as readonly string[]).includes(range)) continue
    const view: SavedReportView = {
      id,
      name,
      report: report as SavedViewReport,
      range: range as ReportRangePreset,
    }
    // opcijska polja samo za export (food-cost jih ne pozna)
    if (view.report === 'export') {
      const section = String(row.section ?? '').trim()
      if ((EXPORT_SECTIONS as readonly string[]).includes(section)) view.section = section as ExportSection
      const format = String(row.format ?? '').trim()
      if ((EXPORT_FORMATS as readonly string[]).includes(format)) view.format = format as ExportFormat
    }
    if (view.range === 'custom') {
      const from = String(row.from ?? '').trim()
      const to = String(row.to ?? '').trim()
      if (isValidDateKey(from) && isValidDateKey(to) && from <= to) {
        view.from = from
        view.to = to
      } else {
        continue // custom z nedovoljnimi datumi je mrtev pogled — izpust
      }
    }
    seen.add(id)
    out.push(view)
  }
  return out
}

/* ─────────── STROGA VALIDACIJA PISANJA (vzorec validateChecklistTemplates) ─────────── */

/** Normalizira in OVIRA vnosno obliko pogleda; vrne napako ali kanonski vnos. */
export function validateSavedReportView(input: unknown): { view: SavedReportView } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Neveljaven pogled.' }
  const row = input as Record<string, unknown>
  const name = String(row.name ?? '').trim()
  if (!name) return { error: 'Ime pogleda je obvezno.' }
  if (name.length > 80) return { error: 'Ime pogleda je predolgo (največ 80 znakov).' }
  const report = String(row.report ?? '').trim()
  if (!(SAVED_VIEW_REPORTS as readonly string[]).includes(report)) {
    return { error: `Neznano poročilo: ${report || '—'} (pričakovano export | food-cost).` }
  }
  const range = String(row.range ?? '').trim()
  if (!(REPORT_RANGE_PRESETS as readonly string[]).includes(range)) {
    return { error: `Neznano obdobje: ${range || '—'}.` }
  }
  const id = String(row.id ?? '').trim() || `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  if (id.length > 64) return { error: 'Id pogleda je predolg (največ 64 znakov).' }
  const view: SavedReportView = { id, name, report: report as SavedViewReport, range: range as ReportRangePreset }
  if (view.report === 'export') {
    const section = String(row.section ?? 'summary').trim() || 'summary'
    if (!(EXPORT_SECTIONS as readonly string[]).includes(section)) {
      return { error: `Neveljavna sekcija izvoza: ${section}.` }
    }
    view.section = section as ExportSection
    const format = String(row.format ?? 'csv').trim() || 'csv'
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      return { error: `Neveljaven format izvoza: ${format}.` }
    }
    view.format = format as ExportFormat
  }
  if (view.range === 'custom') {
    const from = String(row.from ?? '').trim()
    const to = String(row.to ?? '').trim()
    if (!isValidDateKey(from) || !isValidDateKey(to)) return { error: 'Obdobje po meri zahteva veljavna datuma YYYY-MM-DD.' }
    if (from > to) return { error: 'Datum "Od" je za datumom "Do".' }
    view.from = from
    view.to = to
  }
  return { view }
}

/** Strežniška validacija CELEGA seznama (dolžina + duplikati id-jev). */
export function validateSavedReportViews(input: unknown): { views: SavedReportView[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'Pričakovan seznam "views".' }
  if (input.length > MAX_SAVED_REPORT_VIEWS) {
    return { error: `Največ ${MAX_SAVED_REPORT_VIEWS} shranjenih pogledov na lokacijo.` }
  }
  const views: SavedReportView[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const res = validateSavedReportView(raw)
    if ('error' in res) return res
    if (seen.has(res.view.id)) return { error: `Podvojen id pogleda: ${res.view.id}.` }
    seen.add(res.view.id)
    views.push(res.view)
  }
  return { views }
}

/* ─────────── DB DOSTOP (strežnik; jedro ostaja čisto) ─────────── */

/** Minimalna oblika odjemalca za branje registra (db ali transakcija). */
type ViewsReader = Pick<Prisma.TransactionClient, 'integration'>

/** Prebere shranjene poglede lokacije (brez vrstice → prazno). */
export async function loadSavedReportViews(client: ViewsReader, locationId: string): Promise<SavedReportView[]> {
  const row = await client.integration.findFirst({
    where: { name: SAVED_REPORT_VIEWS_MARKER, type: 'other', locationId },
    select: { config: true },
  })
  return parseSavedReportViews(row?.config)
}
