/**
 * OSS-10 (v1.209.0) — VARIANTE ARTIKLOV (velikosti/nivoji) — čisti sloj, 0 uvozov.
 *
 * Vzorec Gap analize (OrderRestro planned »variants — sizes/levels«): varianta
 * NI nov model, temveč DETERMINISTIČNA uporaba obstoječega mehanizma skupin
 * opcij (ModifierGroup.required + maxSelect) — 0 DDL, ker stolpci obstajajo od
 * začetka (shema v1.0): obvezna skupina z NATANČNO eno izbiro = velikost/nivo
 * (»0,5 L«, »nivo pikantnosti 2«), prosta skupina = dodatki (»brez čebule«).
 *
 * Zakaj je to varianta in ne »samo modifikator«: gost jo IZBERE v gostovskih
 * tokovih (kiosk/QR/mobilni — uveljavljanje že v src/lib/modifiers.ts), strežnik
 * jo validira, cena doplačila se zlije v ceno vrstice (ops.ts), KDS jo vidi kot
 * detail naloge — ta sloj doda tisto, kar je manjkalo: RAZRED in SESTAVLJENO
 * PRIKAZNO IME (kuhinja na listu, kiosk v košarici), da »0,5 L« ne živi le v
 * ločenih podvrsticah, ampak postane del enolične opisne vrstice postavke.
 *
 * OSS-10 B-del (v1.210.0): izbira opcij pride TUDI v POS dashboard za osebje —
 * ta sloj dobi čiste pomožnike košarice variant (vrstica = artikel + izbira,
 * spajanje enakih izbir, odstranitev pri 0, znesek z doplačilom, payload za
 * POST naročila). Vse ostane 0 uvozov in brez stranskih učinkov — UI prikaže,
 * strežnik pa ostane avtoritativna resnica (cene in validacija iz DB).
 *
 * Poštena meja (dokumentirana v GAP analizi, OSS-10 vrstica): poročila
 * grupirajo po osnovnem imenu artikla (razcep po varianti ostaja naslednji
 * val), OrderItem.modifiersJson ostaja '[]' (posnetek živi v OrderItemModifier
 * vrsticah).
 */

/** Oblika skupine opcij, ki jo sloj potrebuje za razred (podmnožina ModifierGroup). */
export interface VariantGroupShape {
  required: boolean
  maxSelect: number | null
}

/**
 * Varianta = obvezna skupina z NATANČNO eno izbiro.
 * Prosta skupina (required=false ALI maxSelect≠1) NI varianta — dodatki se
 * seštevajo, velikost se ZAMENJUJE. Točno ta kontrakt uveljavlja predloga
 * »varianta« v admin kartici (required=true, minSelect=1, maxSelect=1).
 */
export function isVariantGroup(g: VariantGroupShape): boolean {
  return g.required === true && g.maxSelect === 1
}

/** Gornja meja imena skupine/opcije — enaka diskretnosti kot ostala polja menija. */
export const VARIANT_NAME_MAX = 120

/**
 * Prikazno ime postavke z izbranimi opcijami: »Pizza · 0,5 L, brez čebule«.
 * Fail-soft po vzorcu ostalih čistih slojev: NIKOLI ne meče — neznani vhod
 * (null/undefined/ne-niz) → osnovno ime ali 'Artikel' (enako mapOrderItem);
 * brez opcij ali z vsemi praznimi → osnovno ime NESPREMENJENO (nič se ne laže);
 * podvojeni/prazni nizi opcij se odstranijo; ločilo ' · ' ne Pride v navzkrižje
 * z obstoječimi imeni (menus POST že prepoveduje podvojena prikazna imena).
 */
export function orderItemDisplayName(
  itemName: unknown,
  optionNames?: readonly unknown[] | null,
): string {
  const base = typeof itemName === 'string' ? itemName.trim() : ''
  const name = base || 'Artikel'
  if (!Array.isArray(optionNames)) return name
  const opts = [...new Set(
    optionNames
      .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      .map((o) => o.trim()),
  )]
  if (opts.length === 0) return name
  return `${name} · ${opts.join(', ')}`
}

/* ── OSS-10 B-del (v1.210.0): košarica variant za POS osebje ── */

/** Vrstica POS košarice z izbrano varianto (artikel + natanko določena izbira). */
export interface PosVariantLine {
  /** Stabilen ključ (artikel + razvrščene opcije) — isto izbira = ista vrstica. */
  key: string
  menuItemId: string
  qty: number
  modifierIds: string[]
  optionNames: string[]
  /** Doplačilo na ENOTO (vsota izbranih opcij) — osnova artikla prihaja zraven. */
  optionPrice: number
}

/** Pogled skupine opcij, kakor ga pošilja GET /api/modifier-groups (razred že izračunan). */
export interface PosVariantGroupView {
  id: string
  name: string
  /** Strežnikov izpeljani razred (isVariantGroup) — UI mu NE izmišljuje lastnega. */
  variant: boolean
  required: boolean
  minSelect: number
  maxSelect: number | null
  modifiers: { id: string; name: string; price: number; isAvailable: boolean }[]
  linkedMenuItemIds: string[]
}

/**
 * Enaka izbira opcij (vrstni red ni pomemben) — za spajanje vrstic košarice.
 * Niz za primerjavo je razvrščen skupaj; \u0000 ločilo ne more nastati v id-jih.
 */
export function sameVariantSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
}

/**
 * Obvezne skupine VARIANTE pripete artiklu z vsaj eno razpoložljivo opcijo —
 * točno te zahtevajo izbiro PRED vložitvijo v naročilo (strežnik sicer vrne
 * 400 »Skupina … je obvezna«). Razred prihaja s strežnika (`variant` flag);
 * prosta skupina (dodatki) tu NI — prostim skupinam izbira ostane prostovoljna.
 */
export function requiredVariantGroupsForItem(
  groups: readonly PosVariantGroupView[] | null | undefined,
  menuItemId: string,
): PosVariantGroupView[] {
  if (!Array.isArray(groups)) return []
  return groups.filter(
    (g) => !!g
      && g.variant === true
      && Array.isArray(g.linkedMenuItemIds)
      && g.linkedMenuItemIds.includes(menuItemId)
      && Array.isArray(g.modifiers)
      && g.modifiers.some((m) => m && m.isAvailable),
  )
}

/**
 * Dodaj vrstico variant: ENAKA izbira (isti artikel + iste opcije) → qty + 1,
 * drugačna → nova vrstica. Ključ je determinističen (artikel + razvrščene
 * opcije), zato replay/spajanje ne podvoji vrstic.
 */
export function addPosVariantLine(
  lines: readonly PosVariantLine[],
  incoming: { menuItemId: string; modifierIds: readonly string[]; optionNames: readonly string[]; optionPrice: number },
): PosVariantLine[] {
  const ids = [...new Set(incoming.modifierIds.filter((s) => typeof s === 'string' && s.trim()))]
  const existing = lines.find(
    (l) => l.menuItemId === incoming.menuItemId && sameVariantSelection(l.modifierIds, ids),
  )
  if (existing) return lines.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + 1 } : l))
  const key = `${incoming.menuItemId}-${[...ids].sort().join('_')}`
  return [
    ...lines,
    {
      key,
      menuItemId: incoming.menuItemId,
      qty: 1,
      modifierIds: ids,
      optionNames: incoming.optionNames.filter((s) => typeof s === 'string' && s.trim().length > 0),
      optionPrice: Math.max(0, Number(incoming.optionPrice) || 0),
    },
  ]
}

/** Količina vrstice ± delta; 0 ali manj → vrstica izgine (nič ostankov z 0). */
export function changePosVariantLineQty(
  lines: readonly PosVariantLine[],
  key: string,
  delta: number,
): PosVariantLine[] {
  return lines
    .map((l) => (l.key === key ? { ...l, qty: l.qty + delta } : l))
    .filter((l) => l.qty > 0)
}

/** Znesek vseh vrstic variant: (osnova artikla + doplačilo) × količina. */
export function posVariantLinesTotal(
  lines: readonly PosVariantLine[],
  basePriceOf: (menuItemId: string) => number,
): number {
  return lines.reduce((s, l) => s + (basePriceOf(l.menuItemId) + l.optionPrice) * l.qty, 0)
}

/**
 * Payload vrstic variant za POST /api/orders in PATCH addItems — kontrakt
 * createOrderCore: `modifiers: [{ modifierId }]` (cene/validacija iz DB).
 */
export function posVariantItemsPayload(
  lines: readonly PosVariantLine[],
): { menuItemId: string; qty: number; modifiers: { modifierId: string }[] }[] {
  return lines.map((l) => ({
    menuItemId: l.menuItemId,
    qty: l.qty,
    modifiers: l.modifierIds.map((id) => ({ modifierId: id })),
  }))
}
