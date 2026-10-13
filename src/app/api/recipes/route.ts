import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { recipeCost, type RecipeNode } from '@/lib/recipe-cost'

/**
 * OPS-9 val 1 — recipe BOM maturity.
 * GET    : tree (children nested), yieldPercent per line, computed costPerServing
 *          (recursive cost incl. sub-recipes + yield) per menu item.
 * POST   : full recipe replace; lines accept yieldPercent (0 < y <= 100, default 100)
 *          and parentInventoryItemId (sub-recipe parent referenced by inventory item id
 *          within the SAME payload — rows get fresh ids on replace).
 * PATCH  : minimal single-line update (yieldPercent, quantityPerServing,
 *          parentRecipeItemId set/clear) with same-menuItem / self / cycle validation.
 */

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const rows = await db.recipeItem.findMany({
    // Issue #4 §1: receptura nima locationId → scope prek lanca MenuItem → Category → Menu.locationId
    // Issue #5 (P0, komentar #6): org allow-lista (locationScope) namesto centralnega bypassa
    where: { MenuItem: { Category: { Menu: await locationScope(user) } } },
    include: {
      MenuItem: { select: { id: true, name: true } },
      InventoryItem: { select: { id: true, name: true, unit: true, costPerUnit: true } },
    },
    take: 500,
  })

  type Line = {
    inventoryItemId: string
    name: string
    unit: string
    qty: number
    yieldPercent: number
    parentRecipeItemId: string | null
    children: Line[]
  }
  const byItem = new Map<string, {
    id: string
    name: string
    instructions: string
    items: Line[]
    costPerServing: number
    costKnown: boolean
  }>()

  // Group rows per menu item (children share the same menuItemId; the tree is rebuilt
  // in memory from parentRecipeItemId links).
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = groups.get(r.menuItemId) || []
    list.push(r)
    groups.set(r.menuItemId, list)
  }

  for (const [menuItemId, group] of groups) {
    const first = group[0]
    const nodes: RecipeNode[] = group.map((r) => ({
      id: r.id,
      menuItemId: r.menuItemId,
      inventoryItemId: r.inventoryItemId,
      inventoryName: r.InventoryItem?.name,
      quantityPerServing: num(r.quantityPerServing),
      yieldPercent: num(r.yieldPercent, 100),
      unit: r.unit || r.InventoryItem?.unit || '',
      parentRecipeItemId: r.parentRecipeItemId,
      // costPerUnit present (Decimal, default 0) -> costKnown reflects real joins
      costPerUnit: r.InventoryItem ? num(r.InventoryItem.costPerUnit) : undefined,
    }))
    const { cost, costKnown } = recipeCost(nodes, menuItemId)

    const rowById = new Map(group.map((r) => [r.id, r]))
    const toLine = (r: (typeof group)[number]): Line => ({
      inventoryItemId: r.inventoryItemId,
      name: r.InventoryItem?.name || 'Sestavina',
      unit: r.unit || r.InventoryItem?.unit || '',
      qty: num(r.quantityPerServing),
      yieldPercent: num(r.yieldPercent, 100),
      parentRecipeItemId: r.parentRecipeItemId,
      // children nested; a parent id pointing outside the group (dangling) stays top-level
      children: group
        .filter((c) => c.parentRecipeItemId === r.id)
        .map(toLine),
    })
    const topLevel = group
      .filter((r) => !r.parentRecipeItemId || !rowById.has(r.parentRecipeItemId))
      .map(toLine)

    byItem.set(menuItemId, {
      id: menuItemId,
      name: first.MenuItem?.name || 'Artikel',
      instructions: '',
      items: topLevel,
      costPerServing: cost,
      costKnown,
    })
  }

  return ok({ recipes: [...byItem.values()] })
}

/** yieldPercent validation: 0 < y <= 100 (missing -> 100). Returns { y } or { error }. */
function parseYieldPercent(raw: unknown): { y?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { y: 100 }
  const n = Number(String(raw).replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    return { error: 'Izkoristek mora biti med 1 in 100 %.' }
  }
  return { y: n }
}

/**
 * Shrani recepturo artikla menija (razknjiževanje po recepturah).
 * Telo: { menuItemId, items: [{ inventoryItemId, qty, unit?, yieldPercent?, parentInventoryItemId? }], notes? }
 * Zamenja obstoječe sestavine za ta artikel (atomarno v transakciji).
 * parentInventoryItemId referencira vrstico ISTEGA telesa (vrstice dobijo nove id-je) —
 * validacije: obstaja v telesu, ni self-parent, brez ciklov, isti artikel (po konstrukciji).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const menuItemId = String(body?.menuItemId || '')
  const rawItems = Array.isArray(body?.items) ? body.items : []

  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: {
      id: true, name: true,
      // Issue #4 §1: lokacija artikla prek lanca do Menu.locationId
      Category: { select: { Menu: { select: { locationId: true } } } },
    },
  })
  if (!menuItem) return ok({ error: 'Artikel menija ne obstaja.' }, 404)
  const menuLocRes = await guardResource(user, menuItem.Category?.Menu?.locationId)
  if (menuLocRes) return menuLocRes

  // Deduplikacija po sestavini (shema: @@unique(menuItemId, inventoryItemId));
  // OPS-9: ohrani yieldPercent + parent referenco prve pojavitve.
  const merged = new Map<string, { inventoryItemId: string; qty: number; unit: string; yieldPercent: number; parentInventoryItemId: string | null }>()
  for (const it of rawItems) {
    const inventoryItemId = String(it?.inventoryItemId || '')
    const qty = Number(String(it?.qty ?? 0).replace(',', '.'))
    if (!inventoryItemId || !(qty > 0)) continue
    const yRes = parseYieldPercent(it?.yieldPercent)
    if (yRes.error) return ok({ error: yRes.error }, 400)
    // parent reference: '' / undefined = top-level line
    const parentRaw = it?.parentInventoryItemId === undefined || it?.parentInventoryItemId === null
      ? ''
      : String(it.parentInventoryItemId)
    const prev = merged.get(inventoryItemId)
    merged.set(inventoryItemId, {
      inventoryItemId,
      qty: Math.round(((prev?.qty || 0) + qty) * 1000) / 1000,
      unit: String(it?.unit || ''),
      // first occurrence defines identity (yield pairs with the parent reference),
      // subsequent duplicates only add quantity
      yieldPercent: prev?.yieldPercent ?? yRes.y!,
      parentInventoryItemId: prev?.parentInventoryItemId ?? (parentRaw || null),
    })
  }
  if (merged.size === 0) return ok({ error: 'Receptura potrebuje vsaj eno sestavino s količino > 0.' }, 400)

  // OPS-9 validacije nadrejenosti: parent obstaja v istem telesu, ni self-parent, brez ciklov.
  for (const m of merged.values()) {
    if (!m.parentInventoryItemId) continue
    if (m.parentInventoryItemId === m.inventoryItemId) {
      return ok({ error: 'Vrstica ne more biti pod-receptura sama sebi.' }, 400)
    }
    if (!merged.has(m.parentInventoryItemId)) {
      return ok({ error: 'Nadrejena vrstica pod-recepture ne obstaja med sestavinami te recepture.' }, 400)
    }
  }
  {
    // Cycle guard: walk up the parent chain from every line; a revisit means a cycle.
    for (const m of merged.values()) {
      const seen = new Set<string>([m.inventoryItemId])
      let cursor = m.parentInventoryItemId
      while (cursor) {
        if (seen.has(cursor)) return ok({ error: 'Pod-recepture tvorijo zanko.' }, 400)
        seen.add(cursor)
        cursor = merged.get(cursor)?.parentInventoryItemId || null
      }
    }
  }

  const invItems = await db.inventoryItem.findMany({
    where: { id: { in: [...merged.keys()] } },
    select: { id: true, name: true, unit: true, costPerUnit: true },
  })
  if (invItems.length !== merged.size) return ok({ error: 'Ena od sestavin ne obstaja v zalogi.' }, 404)

  const notes = String(body?.notes || '')

  // OPS-9: topološki vrstni red (starši pred otroki) — FK RecipeItemToRecipeItem.
  const depthOf = new Map<string, number>()
  for (const m of merged.values()) {
    let depth = 0
    let cursor = m.parentInventoryItemId
    const guard = new Set<string>([m.inventoryItemId])
    while (cursor) {
      depth += 1
      if (guard.has(cursor)) break // cycles rejected above — defensive only
      guard.add(cursor)
      cursor = merged.get(cursor)?.parentInventoryItemId || null
    }
    depthOf.set(m.inventoryItemId, depth)
  }
  const ordered = [...merged.values()].sort((a, b) => (depthOf.get(a.inventoryItemId) || 0) - (depthOf.get(b.inventoryItemId) || 0))

  const rowIds = new Map<string, string>()
  for (const m of ordered) rowIds.set(m.inventoryItemId, nid())

  const rows = ordered.map((m) => {
    const inv = invItems.find((i) => i.id === m.inventoryItemId)!
    return {
      id: rowIds.get(m.inventoryItemId)!,
      menuItemId,
      inventoryItemId: m.inventoryItemId,
      quantityPerServing: m.qty,
      unit: m.unit || inv.unit || '',
      notes,
      yieldPercent: m.yieldPercent,
      // sub-recipe link resolved to the freshly generated parent row id
      parentRecipeItemId: m.parentInventoryItemId ? rowIds.get(m.parentInventoryItemId)! : null,
    }
  })

  await db.$transaction(async (tx) => {
    await tx.recipeItem.deleteMany({ where: { menuItemId } })
    for (const r of rows) await tx.recipeItem.create({ data: r })
  })

  // OPS-9: computed cost of the freshly saved recipe (children + yield aware).
  const savedNodes: RecipeNode[] = rows.map((r) => ({
    id: r.id,
    menuItemId: r.menuItemId,
    inventoryItemId: r.inventoryItemId,
    quantityPerServing: num(r.quantityPerServing),
    yieldPercent: r.yieldPercent,
    unit: r.unit,
    parentRecipeItemId: r.parentRecipeItemId,
    costPerUnit: num(invItems.find((i) => i.id === r.inventoryItemId)?.costPerUnit),
  }))
  const { cost, costKnown } = recipeCost(savedNodes, menuItemId)

  await writeAudit(db, { userId: user.sub, action: 'RECIPE_SAVED', entityType: 'MenuItem', entityId: menuItemId, details: jstr({ menuItem: menuItem.name, lines: rows.map((r) => ({ item: invItems.find((i) => i.id === r.inventoryItemId)?.name, qty: r.quantityPerServing, unit: r.unit, yieldPercent: r.yieldPercent, parent: r.parentRecipeItemId ? invItems.find((i) => i.id === rows.find((x) => x.id === r.parentRecipeItemId)?.inventoryItemId)?.name : null })), costPerServing: cost }) })

  return ok({ saved: rows.length, menuItemId, costPerServing: cost, costKnown }, 201)
}

/**
 * OPS-9 val 1 — minimalna posodobitev ene recepturne vrstice.
 * Telo: { menuItemId, lineId, yieldPercent?, quantityPerServing?, parentRecipeItemId? (string|null) }
 * Validacije: vrstica pripada artiklu; yield 0 < y <= 100; qty > 0; nadrejeni:
 * obstaja, ISTI menuItemId, ni self-parent, brez cikla (sprehod po verigi navzgor).
 */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const menuItemId = String(body?.menuItemId || '')
  const lineId = String(body?.lineId || '')
  if (!menuItemId || !lineId) return ok({ error: 'menuItemId in lineId sta obvezna.' }, 400)

  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { id: true, name: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  if (!menuItem) return ok({ error: 'Artikel menija ne obstaja.' }, 404)
  const menuLocRes = await guardResource(user, menuItem.Category?.Menu?.locationId)
  if (menuLocRes) return menuLocRes

  const line = await db.recipeItem.findFirst({ where: { id: lineId, menuItemId } })
  if (!line) return ok({ error: 'Recepturna vrstica ne obstaja za ta artikel.' }, 404)

  const data: { yieldPercent?: number; quantityPerServing?: number; parentRecipeItemId?: string | null } = {}

  if (body?.yieldPercent !== undefined) {
    const yRes = parseYieldPercent(body.yieldPercent)
    if (yRes.error) return ok({ error: yRes.error }, 400)
    data.yieldPercent = yRes.y!
  }
  if (body?.quantityPerServing !== undefined) {
    const q = Number(String(body.quantityPerServing).replace(',', '.'))
    if (!Number.isFinite(q) || !(q > 0)) return ok({ error: 'Količina na porcijo mora biti število > 0.' }, 400)
    data.quantityPerServing = Math.round(q * 1000) / 1000
  }
  if (body?.parentRecipeItemId !== undefined) {
    if (body.parentRecipeItemId === null || body.parentRecipeItemId === '') {
      data.parentRecipeItemId = null // clear -> top-level line
    } else {
      const parentId = String(body.parentRecipeItemId)
      if (parentId === line.id) return ok({ error: 'Vrstica ne more biti pod-receptura sama sebi.' }, 400)
      const parent = await db.recipeItem.findUnique({ where: { id: parentId } })
      if (!parent || parent.menuItemId !== menuItemId) {
        // parent must belong to the SAME menu item (cross-item links rejected)
        return ok({ error: 'Nadrejena vrstica ne obstaja ali ne pripada istemu artiklu.' }, 400)
      }
      // Cycle guard: walking UP from the proposed parent must never reach this line.
      const guard = new Set<string>([parentId])
      let cursor = parent.parentRecipeItemId
      let depth = 0
      const maxDepth = 100 // defensive cap against pre-existing corrupted loops
      while (cursor && depth < maxDepth) {
        if (cursor === line.id || guard.has(cursor)) break
        guard.add(cursor)
        const row = await db.recipeItem.findUnique({ where: { id: cursor }, select: { parentRecipeItemId: true } })
        cursor = row?.parentRecipeItemId || null
        depth += 1
      }
      if (cursor === line.id) return ok({ error: 'Premik bi ustvaril zanko pod-receptur.' }, 400)
      data.parentRecipeItemId = parentId
    }
  }

  if (Object.keys(data).length === 0) return ok({ error: 'Ni sprememb.' }, 400)

  const before = { yieldPercent: num(line.yieldPercent), quantityPerServing: num(line.quantityPerServing), parentRecipeItemId: line.parentRecipeItemId }
  const updated = await db.recipeItem.update({ where: { id: line.id }, data })
  const after = { yieldPercent: num(updated.yieldPercent), quantityPerServing: num(updated.quantityPerServing), parentRecipeItemId: updated.parentRecipeItemId }

  await writeAudit(db, { userId: user.sub, action: 'RECIPE_UPDATED', entityType: 'MenuItem', entityId: menuItemId, details: jstr({ menuItem: menuItem.name, lineId: line.id, inventoryItemId: line.inventoryItemId, before, after }) })

  return ok({
    line: {
      id: updated.id,
      inventoryItemId: updated.inventoryItemId,
      quantityPerServing: num(updated.quantityPerServing),
      unit: updated.unit,
      yieldPercent: num(updated.yieldPercent),
      parentRecipeItemId: updated.parentRecipeItemId,
    },
  })
}

/** Izbriši recepturo artikla menija (?menuItemId=). */
export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const menuItemId = url.searchParams.get('menuItemId') || ''
  if (!menuItemId) return ok({ error: 'menuItemId je obvezen.' }, 400)
  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { name: true, Category: { select: { Menu: { select: { locationId: true } } } } },
  })
  // Issue #4 §1: brisanje recepture samo za artikle lastne lokacije (fail-closed)
  if (menuItem) {
    const menuLocRes = await guardResource(user, menuItem.Category?.Menu?.locationId)
    if (menuLocRes) return menuLocRes
  }
  const del = await db.recipeItem.deleteMany({ where: { menuItemId } })
  if (del.count > 0) {
    await writeAudit(db, { userId: user.sub, action: 'RECIPE_DELETED', entityType: 'MenuItem', entityId: menuItemId, details: jstr({ menuItem: menuItem?.name || menuItemId, removed: del.count }) })
  }
  return ok({ deleted: del.count })
}
