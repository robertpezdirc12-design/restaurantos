/**
 * v1.254.0 — REAL-TIME CHECK VIEW (docs/PRIMERJAVA-VMESNIKOV-2026 §28;
 * Square oktober 2026 »Edit items with the check in view«).
 *
 * Merjena situacija: vsi štirje urejevalni dialogi POS (izbira variante
 * OSS-10, opomba vrstice §22 B, sprememba cene §23, preklic postavke
 * Issue #5) so max-w-sm modali, ki račun PREKRIJEJO — osebje ureja
 * »na slepo«, račun se posodobi šele po Potrdi. Square je oktobra 2026
 * obrnil vrstni red: podrobnosti se odprejo ZRAVEN računa in račun se
 * posodablja z VSAKO izbiro (»the check updates with each choice as
 * staff edit«).
 *
 * Ta lib je ČIST SLOJ predogleda (0 uvozov iz db/api — enaka disciplina
 * kot item-variants/report-views): iz stanja košaric sestavi model
 * vrstic, ki ga LiveCheckAside izriše ZRAVEN urejevalca. Zapis OSTANE
 * na Potrdi (dialogi imajo Prekliči — sprememba je vidna živo, zapis
 * pa šele ob potrditvi; Square auto-save je mehanika njihove modal-less
 * razporeditve, mi ohranjamo možnost preklica).
 *
 * Defenzivna disciplina: vsi vhodi se normalizirajo (qty ≥ 0 celo,
 * cene r2 ≥ 0, opombe trim, kap 30 vrstic z iskrenim števcem »… in
 * še N«); prečrtane (voided) vrstice IZPUSTIJO iz skupaj — plošča ne
 * laže o denarju, ki ga preklic odnese.
 */
import { orderItemDisplayName } from '@/lib/item-variants'

// ── Model ──

/** Ena vrstica predogleda računa (poljno kompatibilna z LiveCheckLine v komponenti). */
export interface LiveCheckLine {
  /** enolični ključ vrstice (menuItemId / variantni l.key / orderItem.id / '__pending_variant__') */
  key: string
  /** prikazno ime (osnovno ime + variantne opcije — orderItemDisplayName) */
  name: string
  /** količina ≥ 0 (celo) */
  qty: number
  /** cena na enoto ≥ 0 (r2) */
  unitPrice: number
  /** opomba vrstice (ℹ na KDS/listu); '' ali manjkajoče = brez opombe */
  note?: string
  /** vrstica se UREJA ta trenutek → jantarna obroba + značka (Square: urejevalec zraven) */
  pending?: boolean
  /** preklicana v predogledu → prečrtana, IZPUSTI iz skupaj */
  voided?: boolean
  /** prejšnja cena na enoto (samo pri predogledu spremembe cene) */
  prevPrice?: number
}

/** Zgoščen model plošče: vrstice (≤ kap) + skupaj + koliko vrstic je padlo čez kap. */
export interface LiveCheckModel {
  lines: LiveCheckLine[]
  /** Σ qty×unitPrice po NE-prečrtanih vrsticah (r2) — pošteno nezrezano (tudi onkraj kapa, disciplina §27) */
  total: number
  /** število vrstic onkraj kapa (iskren »… in še N«, ne tiha rezanja) */
  more: number
}

/** Zgornja meja vrstic predogleda (plošča drsi; enak prag discipline kot MAX_XZ_OPEN_ROWS). */
export const MAX_LIVE_CHECK_LINES = 30

/** Prazni model (dialog zaprt / ni konteksta) — nič se ne laže. */
export const LIVE_CHECK_EMPTY: LiveCheckModel = Object.freeze({ lines: [], total: 0, more: 0 }) as LiveCheckModel

// ── Normalizacija ──

/** r2 zaokroževanje zneskov (isti vzorec kot xz-report). */
function r2(n: number): number {
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0
}

/** Defenzivna pretvorba ene vrstice (smeti → null; presenetljive vrednosti → ščip). */
function coerceLine(entry: unknown): LiveCheckLine | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  const key = typeof e.key === 'string' ? e.key.trim() : ''
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  if (!key || !name) return null
  const qty = Number(e.qty)
  const unitPrice = Number(e.unitPrice)
  const prevPriceRaw = e.prevPrice
  const prevPrice = prevPriceRaw === undefined || prevPriceRaw === null ? undefined : Number(prevPriceRaw)
  const note = typeof e.note === 'string' ? e.note.trim() : ''
  return {
    key,
    name,
    qty: Number.isFinite(qty) ? Math.max(0, Math.round(qty)) : 0,
    unitPrice: Number.isFinite(unitPrice) ? r2(Math.max(0, unitPrice)) : 0,
    ...(note ? { note } : {}),
    ...(e.pending === true ? { pending: true } : {}),
    ...(e.voided === true ? { voided: true } : {}),
    ...(prevPrice !== undefined && Number.isFinite(prevPrice) && prevPrice >= 0 ? { prevPrice: r2(prevPrice) } : {}),
  }
}

/**
 * Sestavi model plošče iz surovih vrstic: normalizacija, odstranitev
 * podvojenih ključev (prvi zmaga — vrstica je enolična), kap z iskrenim
 * števcem, skupaj brez prečrtanih in NEZREZANO (šteje tudi vrstice onkraj
 * kapa — reza se dotakne samo seznama). Vnos null/undefined → prazen model.
 */
export function buildLiveCheck(raw: readonly unknown[] | null | undefined, cap: number = MAX_LIVE_CHECK_LINES): LiveCheckModel {
  const max = Number.isFinite(cap) && cap > 0 ? Math.min(Math.floor(cap), MAX_LIVE_CHECK_LINES) : MAX_LIVE_CHECK_LINES
  const seen = new Set<string>()
  const lines: LiveCheckLine[] = []
  let more = 0
  let total = 0
  if (!Array.isArray(raw)) return { lines, total: 0, more: 0 } // defenzivno: ne-tabela = prazno
  for (const entry of raw) {
    const line = coerceLine(entry)
    if (!line || seen.has(line.key)) continue
    seen.add(line.key)
    // skupaj šteje VSE vrstice (nezrezano — disciplina §27: poštena številka,
    // reza se dotakne SAMO seznama, s kirurškim števcem »… in še N«)
    if (!line.voided) total += line.qty * line.unitPrice
    if (lines.length >= max) { more += 1; continue }
    lines.push(line)
  }
  return { lines, total: Math.round((total + Number.EPSILON) * 100) / 100, more }
}

// ── Preslikave stanja košaric ──

/** Minimalna oblika menijskega artikla (strukturno tipizirano — MenuT ustreza). */
export interface LiveCheckMenuLike {
  id: string
  name: string
  price: number
}

/** Minimalna oblika variantne vrstice (strukturno tipizirano — PosVariantLine ustreza). */
export interface LiveVariantLineLike {
  key: string
  menuItemId: string
  qty: number
  optionNames: readonly string[]
  optionPrice: number
}

/**
 * Preslikava ene od TREH košaric POS (novo naročilo / hitra prodaja /
 * urejevalnik naročila) v vrstice predogleda. Vrstice z qty ≤ 0 in
 * vrstice, katerih artikel ni več v meniju, se preskočijo (predogled je
 * pomoč, pot oddaje validira strogo — vrstica brez artikla nima ne imena
 * ne cene in bi lagala o 0,00 €).
 */
export function cartPreviewLines(
  cart: Record<string, number> | null | undefined,
  variants: readonly LiveVariantLineLike[] | null | undefined,
  notes: Record<string, string> | null | undefined,
  menu: readonly LiveCheckMenuLike[] | null | undefined,
): LiveCheckLine[] {
  const out: LiveCheckLine[] = []
  const byId = new Map<string, LiveCheckMenuLike>()
  for (const m of menu ?? []) {
    if (m && typeof m.id === 'string' && !byId.has(m.id)) byId.set(m.id, m)
  }
  for (const [id, qtyRaw] of Object.entries(cart ?? {})) {
    const qty = Number(qtyRaw)
    if (!Number.isFinite(qty) || qty <= 0) continue
    const m = byId.get(id)
    if (!m) continue
    const note = typeof notes?.[id] === 'string' ? notes[id].trim() : ''
    out.push({
      key: id,
      name: m.name,
      qty: Math.round(qty),
      unitPrice: r2(Number(m.price) || 0),
      ...(note ? { note } : {}),
    })
  }
  for (const l of variants ?? []) {
    if (!l || typeof l.key !== 'string' || !l.key) continue
    const qty = Number(l.qty)
    if (!Number.isFinite(qty) || qty <= 0) continue
    const m = byId.get(l.menuItemId)
    if (!m) continue
    const note = typeof notes?.[l.key] === 'string' ? notes[l.key].trim() : ''
    out.push({
      key: l.key,
      name: orderItemDisplayName(m.name, Array.isArray(l.optionNames) ? l.optionNames : []),
      qty: Math.round(qty),
      unitPrice: r2((Number(m.price) || 0) + (Number(l.optionPrice) || 0)),
      ...(note ? { note } : {}),
    })
  }
  return out
}

/** Minimalna oblika obstoječe postavke naročila (strukturno tipizirano — OrderItemT ustreza). */
export interface LiveOrderItemLike {
  id: string
  name: string
  qty: number
  unitPrice: number
  note?: string | null
  voided?: boolean
  modifiers?: readonly string[] | null
}

/**
 * Preslikava OBSTOJEČIH postavk naročila (urejevalnik NaročiloSheet) —
 * preklicane (voided) se preskočijo (enak filter kot seznam v listu);
 * variantne opcije se prilepijo k imenu (»Pizza · 0,5 L«) po istem
 * vzorcu kot vrstica v listu.
 */
export function orderPreviewLines(items: readonly LiveOrderItemLike[] | null | undefined): LiveCheckLine[] {
  const out: LiveCheckLine[] = []
  for (const it of items ?? []) {
    if (!it || typeof it.id !== 'string' || !it.id || it.voided === true) continue
    const name = typeof it.name === 'string' ? it.name.trim() : ''
    if (!name) continue
    const mods = Array.isArray(it.modifiers) ? it.modifiers.filter((x) => typeof x === 'string' && x.trim()) : []
    const note = typeof it.note === 'string' ? it.note.trim() : ''
    const qty = Number(it.qty)
    const unitPrice = Number(it.unitPrice)
    out.push({
      key: it.id,
      name: mods.length ? `${name} · ${mods.join(', ')}` : name,
      qty: Number.isFinite(qty) ? Math.max(0, Math.round(qty)) : 0,
      unitPrice: Number.isFinite(unitPrice) ? r2(Math.max(0, unitPrice)) : 0,
      ...(note ? { note } : {}),
    })
  }
  return out
}

// ── Živi predogledi urejanja ──

/** Minimalna oblika variante skupine (strukturno tipizirano — PosVariantGroupView ustreza). */
export interface LiveVariantGroupLike {
  id: string
  modifiers: readonly { id: string; name: string; price: number; isAvailable?: boolean }[]
}

/**
 * ŽIVA vrstica izbire variante (OSS-10): iz TRENUTNIH izbir sestavi
 * pending vrstico — ime z izbranimi opcijami, cena z doplačilom, qty 1.
 * Prazne izbire → samo osnovno ime/cena (vrstica je VEDNO vidna, ker se
 * artikel ureja). Artikel null/pražen → null (dialog brez konteksta).
 */
export function variantPendingLine(
  item: { name: string; price: number } | null | undefined,
  groups: readonly LiveVariantGroupLike[] | null | undefined,
  selections: Record<string, string> | null | undefined,
): LiveCheckLine | null {
  if (!item || typeof item.name !== 'string' || !item.name.trim()) return null
  const names: string[] = []
  let surcharge = 0
  for (const g of groups ?? []) {
    if (!g || !Array.isArray(g.modifiers)) continue
    const sel = selections?.[g.id]
    if (typeof sel !== 'string' || !sel) continue
    const opt = g.modifiers.find((m) => m && m.id === sel)
    if (!opt) continue // neznana izbira se tiho preskoči (defenzivno)
    names.push(opt.name)
    surcharge += Number(opt.price) || 0
  }
  return {
    key: '__pending_variant__',
    name: orderItemDisplayName(item.name, names),
    qty: 1,
    unitPrice: r2((Number(item.price) || 0) + surcharge),
    pending: true,
  }
}

/** Delni popravki vrstice (note/cena/preklic) — uporablja jih withLineUpdate. */
export interface LiveLinePatch {
  note?: string
  unitPrice?: number
  voided?: boolean
  prevPrice?: number
}

/**
 * ČISTA nadgradnja ENE vrstice po ključu (opomba / cena / preklic):
 * vrne NOVO tabelo, dotaknjena vrstica dobi pending: true (jantarna
 * obroba — urejaš jo ta trenutek). Neznan ključ → tabelo nespremenjeno
 * (predogled ne izumi vrstic, ki jih ni).
 */
export function withLineUpdate(
  lines: readonly LiveCheckLine[] | null | undefined,
  key: string,
  patch: LiveLinePatch,
): LiveCheckLine[] {
  if (typeof key !== 'string' || !key || !patch) return [...(lines ?? [])]
  return (lines ?? []).map((l) => {
    if (!l || l.key !== key) return l
    const nx: LiveCheckLine = { ...l, ...patch, pending: true }
    return nx
  })
}

/**
 * Parse vnosa cene za PREDogled (§23): '12,50' in '12.5' → 12.5;
 * smeti / negativno / > 99999,99 → null (predogled pokaže trenutno
 * ceno — ne laže). Mehkejša od strežniške validacije (potrditev +
 * orders.priceOverride ostajata VRATA, to je samo zrcalo tipkanja).
 */
export function parsePriceInput(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0 || n > 99999.99) return null
  return r2(n)
}
