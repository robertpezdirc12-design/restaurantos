/**
 * Issue #7 (P1, v1.104.0) — ALERGENSKI PROFIL JEDI (izračun iz sestavin).
 *
 * Izvir resnice = InventoryItem.allergens (kanonične kode). Profil jedi se
 * izračuna BULK iz:
 *  - vseh RecipeItem vrstic jedi (vsako vozlišče drevesa je sestavina — podrecepture
 *    pokrite avtomatsko: otroci razstavljajo starša, vsi skupaj porabijo zalogo),
 *  - legacy prostega besedila MenuItem.allergens (preslikava prek alias tabel;
 *    nepreslikljive oznake ostanejo vidne → zahtevajo potrditev),
 *  - opcij modifikatorjev (posebej — dodatek spremeni profil NAROČENE postavke,
 *    ne baze jedi),
 *  - ročnega popravka (allergensOverride: dodaj/odstrani + IZVOR+RAZLOG+KDRO+KDaj;
 *    odstranjene izpeljane kode se NE izničijo — ostanejo vidne).
 *
 * Status (NAPAKA-nikoli-lažno-varno):
 *  - needs_confirmation — podatki manjkajo/niso potrjeni (brez recepture in zapisa,
 *    sestavina brez potrditve, profil jedi nepotrjen)
 *  - review_required    — podatki so, a zastareli/neznani (zastavica ponovne
 *    preverbe, nepreslikane oznake, odstranjene kode)
 *  - confirmed          — vse sestavine potrjene + profil potrjen + brez neznank
 *
 * Strežniški modul (db) — NE uvažati v client komponente.
 */
import { db } from '@/lib/db'
import {
  ALLERGEN_CODES,
  parseAllergenCodes,
  isAllergenCode,
  type AllergenCode,
} from './allergen-catalog'

export type AllergenStatus = 'confirmed' | 'review_required' | 'needs_confirmation'

export interface AllergenProfileIngredient {
  id: string
  name: string
  codes: string[]
  crossContact: string[]
  confirmedAt: string | null
  supplier: string
}

export interface AllergenProfile {
  menuItemId: string
  menuItemName: string
  status: AllergenStatus
  /** Končni nabor za prikaz: izpeljane ∪ legacy preslikane ∪ override.dodaj − override.odstrani. */
  codes: string[]
  /** Izključno iz sestavin recepture (strukturirani stolpci InventoryItem). */
  derivedCodes: string[]
  /** Legacy prosto besedilo, preslikano v kode (stari zapis — brez sestavinskega izvora). */
  legacyCodes: string[]
  crossContact: string[]
  /** Nepreslikane legacy oznake — vidne, sprožijo review_required. */
  unknownLabels: string[]
  /** Kode, ki jih je ročni popravek odstranil — OSTANEJO vidne (tiho izničenje prepovedano). */
  removedByOverride: string[]
  /** Kode vseh povezanih opcij modifikatorjev (DODATKI — ne baza jedi). */
  modifierCodes: string[]
  sources: Record<string, { ingredients: string[]; modifiers: string[] }>
  ingredients: AllergenProfileIngredient[]
  hasRecipe: boolean
  /** Sestavina brez potrjene alergenske evidence ali jed brez podatkov. */
  needsConfirmation: boolean
  unconfirmedIngredients: string[]
  confirmedAt: string | null
  confirmedById: string | null
  confirmedByName: string | null
  reviewFlag: boolean
  reviewReason: string
  override: {
    add: string[]
    remove: string[]
    reason: string
    confirmedByName: string | null
    confirmedAt: string | null
  } | null
}

interface OverrideShape {
  add?: unknown
  remove?: unknown
  reason?: unknown
  confirmedById?: unknown
  confirmedByName?: unknown
  confirmedAt?: unknown
}

function parseCodeList(raw: unknown): string[] {
  const { codes } = parseAllergenCodes(raw)
  return codes
}

function orderedCodes(set: Set<string>): string[] {
  const known = ALLERGEN_CODES.filter((c) => set.has(c))
  const extra = [...set].filter((c) => !isAllergenCode(c))
  return [...known, ...extra]
}

function parseOverride(raw: string | null | undefined): OverrideShape | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as OverrideShape
    }
  } catch {
    /* pokvarjen JSON → ignoriramo (ne meče) */
  }
  return null
}

function codeArrayOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) {
    if (isAllergenCode(x) && !out.includes(x)) out.push(x)
  }
  return orderedCodes(new Set(out))
}

export interface ProfileQueryRow {
  id: string
  name: string
  allergens: string
  allergensOverride: string | null
  allergensConfirmedAt: Date | null
  allergensConfirmedById: string | null
  allergenReviewFlag: boolean
  allergenReviewReason: string
}

/**
 * BULK izračun profilov za dano množico jedi. Prazna množica → prazen Map.
 * Poizvedbe so eksplicitno `select`-ane (samo alergensko relevantna polja).
 */
export async function getMenuItemAllergenProfiles(
  menuItemIds: string[]
): Promise<Map<string, AllergenProfile>> {
  const ids = [...new Set((menuItemIds || []).map(String).filter(Boolean))]
  const out = new Map<string, AllergenProfile>()
  if (ids.length === 0) return out

  const [menuItems, recipeRows, modifierRows] = await Promise.all([
    db.menuItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        allergens: true,
        allergensOverride: true,
        allergensConfirmedAt: true,
        allergensConfirmedById: true,
        allergenReviewFlag: true,
        allergenReviewReason: true,
      },
    }) as unknown as Promise<ProfileQueryRow[]>,
    db.recipeItem.findMany({
      where: { menuItemId: { in: ids } },
      select: { id: true, menuItemId: true, inventoryItemId: true },
    }),
    db.modifier.findMany({
      where: { ModifierGroup: { MenuItemModifierGroup: { some: { menuItemId: { in: ids } } } } },
      select: { id: true, name: true, allergens: true },
    }),
  ])

  const inventoryIds = [...new Set(recipeRows.map((r) => r.inventoryItemId))]
  const inventoryItems = inventoryIds.length
    ? await db.inventoryItem.findMany({
        where: { id: { in: inventoryIds } },
        select: {
          id: true,
          name: true,
          supplier: true,
          allergens: true,
          allergensCrossContact: true,
          allergensConfirmedAt: true,
        },
      })
    : []

  const invById = new Map(inventoryItems.map((i) => [i.id, i]))
  const miById = new Map(menuItems.map((m) => [m.id, m]))

  // imena potrjevalcev (sestavine + jedi + override) — ena poizvedba
  const confirmerIds = [
    ...menuItems.map((m) => m.allergensConfirmedById),
    ...parseOverrideMap(menuItems).map((o) => String(o.confirmedById ?? '')),
  ].filter((x): x is string => !!x)
  const confirmers = confirmerIds.length
    ? await db.employee.findMany({
        where: { id: { in: [...new Set(confirmerIds)] } },
        select: { id: true, name: true, email: true },
      })
    : []
  const nameById = new Map(confirmers.map((e) => [e.id, e.name || e.email]))

  for (const id of ids) {
    const mi = miById.get(id)
    if (!mi) continue
    const rows = recipeRows.filter((r) => r.menuItemId === id)
    const profile = computeProfile(mi, rows, invById, modifierRows, nameById)
    out.set(id, profile)
  }
  return out
}

function parseOverrideMap(menuItems: ProfileQueryRow[]): OverrideShape[] {
  return menuItems
    .map((m) => parseOverride(m.allergensOverride))
    .filter((o): o is OverrideShape => o !== null)
}

function computeProfile(
  mi: ProfileQueryRow,
  rows: { id: string; inventoryItemId: string }[],
  invById: Map<string, { id: string; name: string; supplier: string; allergens: string; allergensCrossContact: string; allergensConfirmedAt: Date | null }>,
  modifierRows: { id: string; name: string; allergens: string }[],
  nameById: Map<string, string>
): AllergenProfile {
  // 1) sestavine (celotno drevo recepture — vsako vozlišče je sestavina)
  const ingredients: AllergenProfileIngredient[] = []
  const derivedSet = new Set<string>()
  const crossSet = new Set<string>()
  const unconfirmedIngredients: string[] = []
  const seenInv = new Set<string>()
  for (const r of rows) {
    if (seenInv.has(r.inventoryItemId)) continue
    seenInv.add(r.inventoryItemId)
    const inv = invById.get(r.inventoryItemId)
    if (!inv) continue
    const codes = parseCodeList(inv.allergens)
    const cross = parseCodeList(inv.allergensCrossContact)
    ingredients.push({
      id: inv.id,
      name: inv.name,
      codes,
      crossContact: cross,
      confirmedAt: inv.allergensConfirmedAt ? inv.allergensConfirmedAt.toISOString() : null,
      supplier: inv.supplier || '',
    })
    for (const c of codes) derivedSet.add(c)
    for (const c of cross) crossSet.add(c)
    if (!inv.allergensConfirmedAt) unconfirmedIngredients.push(inv.name)
  }

  // 2) legacy prosto besedilo jedi
  const legacyParsed = parseAllergenCodes(mi.allergens)
  const legacySet = new Set<string>(legacyParsed.codes)
  const unknownLabels = [...legacyParsed.unknown]

  // 3) modifikatorji (opcije — DODATKI, ne baza jedi)
  const modifierCodes: string[] = []
  const modifiersByName: string[] = []
  for (const mod of modifierRows) {
    const parsed = parseAllergenCodes(mod.allergens)
    if (parsed.codes.length > 0) {
      for (const c of parsed.codes) {
        if (!modifierCodes.includes(c)) modifierCodes.push(c)
      }
      modifiersByName.push(mod.name)
    }
    for (const u of parsed.unknown) {
      if (!unknownLabels.includes(u)) unknownLabels.push(u)
    }
  }

  // 4) ročni popravek (override) — dodaj/odstrani z IZVOROM+RAZLOGOM
  const overrideRaw = parseOverride(mi.allergensOverride)
  const overrideAdd = codeArrayOf(overrideRaw?.add)
  const overrideRemove = codeArrayOf(overrideRaw?.remove)
  const baseSet = new Set<string>([...derivedSet, ...legacySet])
  for (const c of overrideAdd) baseSet.add(c)
  const removedByOverride = orderedCodes(new Set(overrideRemove.filter((c) => baseSet.has(c))))
  for (const c of overrideRemove) baseSet.delete(c)
  const finalCodes = orderedCodes(baseSet)

  // 5) viri po kodah (sestavine + modifikatorji)
  const sources: Record<string, { ingredients: string[]; modifiers: string[] }> = {}
  for (const r of rows) {
    const inv = invById.get(r.inventoryItemId)
    if (!inv) continue
    const codes = parseCodeList(inv.allergens)
    for (const c of codes) {
      const s = (sources[c] ??= { ingredients: [], modifiers: [] })
      if (!s.ingredients.includes(inv.name)) s.ingredients.push(inv.name)
    }
  }
  for (const c of modifierCodes) {
    const s = (sources[c] ??= { ingredients: [], modifiers: [] })
    s.modifiers = modifiersByName.slice(0, 8)
  }

  // 6) status — NIKOLI lažno "varno"
  const hasRecipe = rows.length > 0
  const hasLegacyData = unknownLabels.length > 0 || legacySet.size > 0
  const overridePresent = overrideRaw !== null
  const hasAllergenData = hasRecipe || hasLegacyData || overridePresent
  const confirmedAt = mi.allergensConfirmedAt ? mi.allergensConfirmedAt.toISOString() : null
  const needsConfirmation =
    !hasAllergenData || unconfirmedIngredients.length > 0 || !mi.allergensConfirmedAt
  const review =
    mi.allergenReviewFlag ||
    unknownLabels.length > 0 ||
    removedByOverride.length > 0
  const status: AllergenStatus = needsConfirmation
    ? 'needs_confirmation'
    : review
      ? 'review_required'
      : 'confirmed'

  return {
    menuItemId: mi.id,
    menuItemName: mi.name,
    status,
    codes: finalCodes,
    derivedCodes: orderedCodes(derivedSet),
    legacyCodes: orderedCodes(legacySet),
    crossContact: orderedCodes(crossSet),
    unknownLabels,
    removedByOverride,
    modifierCodes,
    sources,
    ingredients,
    hasRecipe,
    needsConfirmation,
    unconfirmedIngredients,
    confirmedAt,
    confirmedById: mi.allergensConfirmedById,
    confirmedByName: mi.allergensConfirmedById ? (nameById.get(mi.allergensConfirmedById) ?? null) : null,
    reviewFlag: mi.allergenReviewFlag,
    reviewReason: mi.allergenReviewReason || '',
    override: overrideRaw
      ? {
          add: overrideAdd,
          remove: overrideRemove,
          reason: String(overrideRaw.reason ?? '').slice(0, 300),
          confirmedByName: overrideRaw.confirmedById
            ? (nameById.get(String(overrideRaw.confirmedById)) ?? String(overrideRaw.confirmedByName ?? ''))
            : (overrideRaw.confirmedByName ? String(overrideRaw.confirmedByName) : null),
          confirmedAt: typeof overrideRaw.confirmedAt === 'string' ? overrideRaw.confirmedAt : null,
        }
      : null,
  }
}

/* ───────────────── posnetek ob nastanku naročila ───────────────── */

export interface AllergenSnapshot {
  /** Kode jedi (izračun ob nastanku) ∪ kode IZBRANIH opcij modifikatorjev. */
  codes: string[]
  crossContact: string[]
  status: AllergenStatus
  unknownLabels: string[]
  sources: Record<string, { ingredients: string[]; modifiers: string[] }>
  capturedAt: string
}

/**
 * Posnetek alergenskih informacij OB NASTANKU naročila — kasnejša sprememba
 * recepta NE spremeni zgodovine prejšnjega naročila (issue #7 §2).
 * Vrne JSON nize po vrsticah (pisani v OrderItem.allergenSnapshot).
 */
export async function buildAllergenSnapshots(
  lines: { menuItemId: string; chosenModifierIds: string[] }[]
): Promise<string[]> {
  const menuItemIds = [...new Set(lines.map((l) => String(l.menuItemId || '')).filter(Boolean))]
  const modifierIds = [...new Set(lines.flatMap((l) => (l.chosenModifierIds || []).map(String)).filter(Boolean))]
  if (menuItemIds.length === 0) return lines.map(() => '{}')

  const [profiles, chosenMods] = await Promise.all([
    getMenuItemAllergenProfiles(menuItemIds),
    modifierIds.length
      ? db.modifier.findMany({
          where: { id: { in: modifierIds } },
          select: { id: true, name: true, allergens: true },
        })
      : Promise.resolve([] as { id: string; name: string; allergens: string }[]),
  ])
  const modById = new Map(chosenMods.map((m) => [m.id, m]))

  return lines.map((line) => {
    const profile = profiles.get(line.menuItemId)
    if (!profile) return '{}'
    const codeSet = new Set<string>(profile.codes)
    const sources: Record<string, { ingredients: string[]; modifiers: string[] }> = JSON.parse(
      JSON.stringify(profile.sources)
    )
    const unknown = [...profile.unknownLabels]
    for (const mid of line.chosenModifierIds || []) {
      const mod = modById.get(String(mid))
      if (!mod) continue
      const parsed = parseAllergenCodes(mod.allergens)
      for (const c of parsed.codes) {
        codeSet.add(c)
        const s = (sources[c] ??= { ingredients: [], modifiers: [] })
        if (!s.modifiers.includes(mod.name)) s.modifiers.push(mod.name)
      }
      for (const u of parsed.unknown) {
        if (!unknown.includes(u)) unknown.push(u)
      }
    }
    // izbrane opcije z neznanimi oznakami → NIKOLI "confirmed"
    let status: AllergenStatus = profile.status
    if (unknown.length > 0 && status === 'confirmed') status = 'review_required'
    const snapshot: AllergenSnapshot = {
      codes: orderedCodes(codeSet),
      crossContact: profile.crossContact,
      status,
      unknownLabels: unknown,
      sources,
      capturedAt: new Date().toISOString(),
    }
    return JSON.stringify(snapshot)
  })
}

/** Toleranten parse posnetka iz OrderItem.allergenSnapshot (nikoli ne meče). */
export function parseAllergenSnapshot(raw: string | null | undefined): Partial<AllergenSnapshot> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<AllergenSnapshot>
    }
  } catch {
    /* prazno */
  }
  return {}
}

/** Kode iz posnetka (prazno → []) — za KDS/tisk brez parsanja v UI. */
export function snapshotCodes(raw: string | null | undefined): string[] {
  const s = parseAllergenSnapshot(raw)
  return Array.isArray(s.codes) ? s.codes.filter((c) => typeof c === 'string') : []
}

/** Validacija izrecnega opozorila (gost/osebje) — niz ≤ 200, obrezan. */
export function sanitizeAllergenWarning(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, 200)
}

/**
 * Označi prizadeta jedila za ponovno preverbo (issue #7 §1: sprememba dobavitelja,
 * sestavine, recepture ali modifikatorja). Vzrok se zapiše na MenuItem
 * (allergenReviewReason) — potrditev profila (POST /api/menus/[id]/allergens
 * action=confirm) zastavico POČISTI. Sprejema db ali tx (ChainDb-prijazen tip).
 */
export async function flagMenuItemsForAllergenReview(
  client: { menuItem: { updateMany: (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => Promise<unknown> } },
  menuItemIds: string[],
  reason: string
): Promise<void> {
  const ids = [...new Set((menuItemIds || []).map(String).filter(Boolean))]
  if (ids.length === 0) return
  await client.menuItem.updateMany({
    where: { id: { in: ids } },
    data: {
      allergenReviewFlag: true,
      allergenReviewReason: String(reason || 'sprememba').slice(0, 120),
    },
  })
}

/** Vse jedi, katerih receptura vsebuje sestavino (issue #7: sprememba sestavine). */
export async function menuItemIdsUsingInventoryItem(
  client: { recipeItem: { findMany: (args: { where: { inventoryItemId: string }; select: { menuItemId: true } }) => Promise<{ menuItemId: string }[]> } },
  inventoryItemId: string
): Promise<string[]> {
  const rows = await client.recipeItem.findMany({
    where: { inventoryItemId },
    select: { menuItemId: true },
  })
  return [...new Set(rows.map((r) => r.menuItemId))]
}

export type { AllergenCode }
