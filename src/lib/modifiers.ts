/**
 * Issue #4 §5 — kanonična validacija modifierjev z POPOLNO relacijo:
 *   MenuItem → MenuItemModifierGroup → ModifierGroup → Modifier
 *
 * Prej (guest.ts::resolveGuestItems) je bil relacijski check NO-OP:
 *   `const linked = mods.find((x) => x.id === m.id)` je vedno našel samega sebe,
 *   MenuItemModifierGroup se sploh ni poizvedoval → modifier kateregoli artikla
 *   je šel na katerikoli artikel. required/minSelect/maxSelect/duplikati niso
 *   bili uveljavljeni. Cene so v POS poti prihajale od clienta.
 *
 * Zdaj: čista funkcija + DB nalagalnik. Cene/imeni VEDNO iz DB (client ni zaupan).
 */

export interface ModifierGroupRule {
  id: string
  name: string
  required: boolean
  minSelect: number
  maxSelect: number
}

export interface ModifierRow {
  id: string
  name: string
  price: number
  modifierGroupId: string
  isAvailable: boolean
}

export interface ResolvedModifierOut {
  modifierId: string
  name: string
  price: number
  groupName: string
  modifierGroupId: string
}

export interface ModifierValidationInput {
  /** ID-ji skupin, povezanih s TEM artiklom (MenuItemModifierGroup) */
  allowedGroupIds: string[]
  /** Pravila skupin (samo povezane skupine) */
  groupById: Map<string, ModifierGroupRule>
  /** Kandidati iz DB (samo isAvailable) */
  modById: Map<string, ModifierRow>
  /** Client poslane ID-ji */
  chosenIds: string[]
}

export interface ModifierValidationResult {
  ok: boolean
  error: string | null
  /** VEDNO DB cene/imeni — client vrednosti se ignorirajo */
  resolved: ResolvedModifierOut[]
}

/**
 * Čista validacija (brez DB) — enotno uporabljena v guest (QR/kiosk) in POS poti.
 * Pravila: relacija artikel→skupina→modifier, required, minSelect, maxSelect,
 * podvojeni modifier, neaktiven/neznan modifier.
 */
export function validateItemModifiers(input: ModifierValidationInput): ModifierValidationResult {
  const { allowedGroupIds, groupById, modById, chosenIds } = input
  const allowed = new Set(allowedGroupIds)
  const resolved: ResolvedModifierOut[] = []
  const seen = new Set<string>()

  for (const raw of chosenIds) {
    const id = String(raw || '')
    const m = modById.get(id)
    if (!m) return { ok: false, error: 'Opcija ni več na voljo.', resolved: [] }
    if (!m.isAvailable) return { ok: false, error: 'Opcija ni več na voljo.', resolved: [] }
    if (!allowed.has(m.modifierGroupId)) {
      return { ok: false, error: 'Opcija ni na voljo za ta artikel.', resolved: [] }
    }
    if (seen.has(id)) {
      return { ok: false, error: 'Podvojena opcija pri isti postavki ni dovoljena.', resolved: [] }
    }
    seen.add(id)
    const g = groupById.get(m.modifierGroupId)
    resolved.push({
      modifierId: m.id,
      name: m.name,
      price: m.price,
      groupName: g?.name || '',
      modifierGroupId: m.modifierGroupId,
    })
  }

  // Pravila po skupinah (samo skupine tega artikla)
  const counts = new Map<string, number>()
  for (const r of resolved) counts.set(r.modifierGroupId, (counts.get(r.modifierGroupId) || 0) + 1)
  for (const gid of allowed) {
    const g = groupById.get(gid)
    if (!g) continue
    const c = counts.get(gid) || 0
    if (g.required && c === 0) {
      return { ok: false, error: `Skupina "${g.name}" je obvezna — izberite vsaj eno opcijo.`, resolved: [] }
    }
    if (g.minSelect > 0 && c < g.minSelect) {
      return {
        ok: false,
        error: `Skupina "${g.name}" zahteva vsaj ${g.minSelect} izborov (izbranih: ${c}).`,
        resolved: [],
      }
    }
    if (g.maxSelect > 0 && c > g.maxSelect) {
      return {
        ok: false,
        error: `Skupina "${g.name}" dovoljuje največ ${g.maxSelect} izborov (izbranih: ${c}).`,
        resolved: [],
      }
    }
  }
  return { ok: true, error: null, resolved }
}

/** DB kontekst za validacijo: povezave artikel→skupina, pravila skupin, razpoložljivi modifierji. */
export async function loadModifierContext(menuItemIds: string[], chosenModifierIds: string[]) {
  // REAL BUG FIX (v1.210.0): prej je `groupById` dobil pravila SAMO iz IZBRANIH
  // opcij — obvezna skupina z NIČ izbirami se je tiho preskočila (required/
  // minSelect preverba je `if (!g) continue` na manjkajočem pravilu). Posledica:
  // POST /api/orders (in gostovska + sync pot — isti kontekst) je sprejel artikel
  // z obvezno varianto BREZ izbire → napačna cena, kuhinja brez velikosti. Zdaj
  // se pravila naložijo za VSE pripete skupine artiklov (izvor resnice: povezave
  // artikel↔skupina) — uveljavljanje je enako z 0 in z N izbirami.
  const links = menuItemIds.length
    ? await (await import('@/lib/db')).db.menuItemModifierGroup.findMany({
        where: { menuItemId: { in: menuItemIds } },
      })
    : ([] as { menuItemId: string; modifierGroupId: string }[])
  const linkedGroupIds = [...new Set(links.map((l) => l.modifierGroupId))]
  const [chosen, linkedGroups] = await Promise.all([
    chosenModifierIds.length
      ? (await import('@/lib/db')).db.modifier.findMany({
          where: { id: { in: chosenModifierIds } },
          include: { ModifierGroup: true },
        })
      : Promise.resolve(
          [] as {
            id: string
            name: string
            price: unknown
            isAvailable: boolean
            modifierGroupId: string
            ModifierGroup: { id: string; name: string; required: boolean; minSelect: number; maxSelect: number } | null
          }[]
        ),
    linkedGroupIds.length
      ? (await import('@/lib/db')).db.modifierGroup.findMany({ where: { id: { in: linkedGroupIds } } })
      : Promise.resolve([] as { id: string; name: string; required: boolean; minSelect: number; maxSelect: number }[]),
  ])

  const allowedByItem = new Map<string, string[]>()
  for (const l of links) {
    const list = allowedByItem.get(l.menuItemId) || []
    list.push(l.modifierGroupId)
    allowedByItem.set(l.menuItemId, list)
  }
  const groupIds = new Set(links.map((l) => l.modifierGroupId))
  const groupById = new Map<string, ModifierGroupRule>()
  // pravila VSEH pripetih skupin (obvezna skupina z 0 izbirami MORA zatreti)
  for (const g of linkedGroups) {
    if (!groupById.has(g.id)) {
      groupById.set(g.id, {
        id: g.id,
        name: g.name,
        required: !!g.required,
        minSelect: Number(g.minSelect) || 0,
        maxSelect: Number(g.maxSelect) || 0,
      })
    }
  }
  // izbrane opcije nosijo grupna pravila prek relacije (podatkovno enak vir)
  for (const m of chosen) {
    const g = m.ModifierGroup
    if (g && groupIds.has(g.id) && !groupById.has(g.id)) {
      groupById.set(g.id, {
        id: g.id,
        name: g.name,
        required: !!g.required,
        minSelect: Number(g.minSelect) || 0,
        maxSelect: Number(g.maxSelect) || 0,
      })
    }
  }
  const modById = new Map<string, ModifierRow>()
  for (const m of chosen) {
    modById.set(m.id, {
      id: m.id,
      name: m.name,
      price: Number(m.price) || 0,
      modifierGroupId: m.modifierGroupId,
      isAvailable: !!m.isAvailable,
    })
  }
  return { allowedByItem, groupById, modById }
}
