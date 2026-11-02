/**
 * v1.230.0 — Samodejni 86 ob izpraznitvi zaloge (Toast Inventory benchmark;
 * docs/PRIMERJAVA-VMESNIKOV-2026.md §5 → C-seznam »samodejni 86 ob izpraznitvi«).
 *
 * NAČELO: ko razknjižba ob prodaji (deductStockForOrderTx) sprazni zalogo
 * artikla (newQty <= 0), se menu artikli, ki so od te zaloge ODVISNI, v ISTI
 * transakciji kot račun označijo razprodani (isAvailable = false). Toast
 * Inventory to počne privzeno za »tracked« artikle — pri nas je to:
 *
 *  - mode 'direct' (privzeto): InventoryItem.menuItemId povezava — pakirane
 *    pijače/jedi, kjer je zaloga 1:1 z menu artiklom (EAN čitalnik v1.229
 *    uporablja isto povezavo). Varovan pred »začimbno pastjo« (izpraznjena
 *    sol ne sprazni cele karte).
 *  - mode 'recipe' (opt-in): VSE artikle, katerih receptura (RecipeItem)
 *    porablja izpraznjeno sestavino — primer Toast »86 items when ingredients
 *    run out«. Naprednejše, a zahteva disciplinirane recepture; privzeto IZKLOP.
 *
 * KONFIGURACIJA: Integration vrstica name='auto86-config', type='other'
 * (isti vzorec kot low-stock-state — 0 DDL): { enabled, mode }.
 *
 * SAMODEJNA OBNOVITEV (Toast: count shows stock → item returns): ko zaloga
 * spet prispe (GRN prevzem, ročni prejem/popravek, potrditev popisa, storno
 * računa, reverzija odpada, prejem prenosa), se SAMODEJNO razprodani artikel
 * (in samo ta — ročni 86 ostaja ročni) vrne v prodajo. Stanje »kdo je bil
 * samodejno ugasnjen in zakaj« živi v Integration vrstici name='auto86-state'
 * (key = menuItemId → { inventoryItemId, at }). Obnovitev je fire-and-forget
 * (po commitu, void klic), NIKOLI ne podre priliva; CAS na isAvailable=false
 * + brisanje stanja sta idempotentna — zastareli vnosi se počistijo ob
 * naslednjem prilivu (self-healing).
 *
 * REVIZIJA: MENU_ITEM_AUTO_86 / MENU_ITEM_AUTO_RESTORE (entityType MenuItem,
 * isti details format kot MENU_ITEM_AVAILABILITY + vzrok). INVOICE_ISSUE
 * audit nosi rezultat v details.auto86.
 */
import { db } from '@/lib/db'
import { jparse, jstr, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

export const AUTO86_CONFIG_MARKER = 'auto86-config'
export const AUTO86_STATE_MARKER = 'auto86-state'

export interface Auto86Config {
  enabled: boolean
  mode: 'direct' | 'recipe'
}

/** Privzeta konfiguracija (vrstica še ne obstaja): direct način, VKLOPLJENO. */
export const DEFAULT_AUTO86_CONFIG: Auto86Config = { enabled: true, mode: 'direct' }

export interface Auto86Entry {
  menuItemId: string
  name: string
  inventoryItemId: string
  inventoryItemName: string
  newQty: number
}

interface Auto86StateValue {
  inventoryItemId: string
  at: string
}
/** key = menuItemId, value = vzrok (izpraznjena zaloga) + čas. */
export type Auto86StateConfig = Record<string, Auto86StateValue>

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Pure: razčleni in kanoniziraj konfiguracijo (Integration.config JSON).
 * Neveljavni/zmanjkani deli → privzeta vrednost; mode le 'direct' | 'recipe'.
 */
export function parseAuto86Config(raw: unknown): Auto86Config {
  const parsed = jparse<unknown>(raw, null)
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_AUTO86_CONFIG }
  const cfg = parsed as Record<string, unknown>
  const enabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : DEFAULT_AUTO86_CONFIG.enabled
  const mode = cfg.mode === 'recipe' ? 'recipe' : 'direct'
  return { enabled, mode }
}

/** Pure: klasifikacija odvzemov — kateri so artikel dejansko spraznili (<= 0). */
export function depletedDeductions(deductions: { inventoryItemId: string; newQty: number }[]): { inventoryItemId: string; newQty: number }[] {
  return (Array.isArray(deductions) ? deductions : []).filter(
    (d) => d && typeof d.inventoryItemId === 'string' && d.inventoryItemId !== '' && r3(num(d.newQty)) <= 0,
  )
}

async function readConfigTx(tx: Tx): Promise<Auto86Config> {
  const row = await tx.integration.findFirst({ where: { name: AUTO86_CONFIG_MARKER, type: 'other' } })
  return parseAuto86Config(row?.config)
}

async function readStateTx(tx: Tx): Promise<Auto86StateConfig> {
  const row = await tx.integration.findFirst({ where: { name: AUTO86_STATE_MARKER, type: 'other' } })
  const cfg = jparse<Auto86StateConfig>(row?.config, {} as Auto86StateConfig)
  return cfg && typeof cfg === 'object' ? cfg : {}
}

async function writeStateTx(tx: Tx, state: Auto86StateConfig): Promise<void> {
  const config = JSON.stringify(state)
  const row = await tx.integration.findFirst({ where: { name: AUTO86_STATE_MARKER, type: 'other' }, select: { id: true } })
  if (row) {
    await tx.integration.update({ where: { id: row.id }, data: { config } })
  } else {
    await tx.integration.create({
      data: {
        id: `auto86-state-${Date.now().toString(36)}`,
        name: AUTO86_STATE_MARKER,
        type: 'other',
        provider: 'internal',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/**
 * Samodejni 86 znotraj FURS transakcije (izdaja računa). Pogoj: razknjižba
 * (stock.deducted) + vsaj en odvod, ki je spraznil zalogo. Vrača seznam
 * ugasnjenih menu artiklov (prazno = nič ni bilo treba).
 *
 * Ni try/catch: DB napaka prevrača CELO plačilno transakcijo (konsistentno
 * stanje — račun in 86 skupaj); logika naprej je čista in preizkušena.
 * Sočasni plačili istega artikla: CAS updateMany (isAvailable: true) šteje 0
 * pri drugi → brez dvojnega audita. Stanje (state) ima znano mejo: dve
 * sočasni transakciji zapišeta vsak svoj ključ — last-write-wins na celotni
 * config JSON; najslabši izid je, da en vnos ostane brez zapisa v stanju
 * (artikel je vseeno ugasnjen in viden na 86 plošči; ročna obnova deluje).
 */
export async function applyAuto86ForDeductions(
  tx: Tx,
  deductions: { inventoryItemId: string; newQty: number }[],
  locationId: string | null,
  userId: string | null,
): Promise<Auto86Entry[]> {
  const depleted = depletedDeductions(deductions)
  if (depleted.length === 0) return []
  const cfg = await readConfigTx(tx)
  if (!cfg.enabled) return []
  const depletedIds = [...new Set(depleted.map((d) => d.inventoryItemId))]

  // Vzročni menu artikli: 'direct' povezave vedno; v 'recipe' načinu tudi vsi
  // potrošniki po recepturi (superset — operater se je zavedno odločil zanjo).
  const causeByMenuItem = new Map<string, { inventoryItemId: string; inventoryItemName: string }>()
  const linked = await tx.inventoryItem.findMany({
    where: { id: { in: depletedIds }, menuItemId: { not: null } },
    select: { id: true, name: true, menuItemId: true },
  })
  for (const l of linked) {
    if (l.menuItemId && !causeByMenuItem.has(l.menuItemId)) {
      causeByMenuItem.set(l.menuItemId, { inventoryItemId: l.id, inventoryItemName: l.name })
    }
  }
  if (cfg.mode === 'recipe') {
    const consumers = await tx.recipeItem.findMany({
      where: { inventoryItemId: { in: depletedIds } },
      select: { menuItemId: true, inventoryItemId: true, InventoryItem: { select: { name: true } } },
    })
    for (const c of consumers) {
      if (!causeByMenuItem.has(c.menuItemId)) {
        causeByMenuItem.set(c.menuItemId, {
          inventoryItemId: c.inventoryItemId,
          inventoryItemName: c.InventoryItem?.name || c.inventoryItemId,
        })
      }
    }
  }
  if (causeByMenuItem.size === 0) return []

  // Samo RAZPOLOŽLJIVI artikli na meniju TE lokacije (že ugasenih ne podvajamo;
  // centralna vloga brez lokacije = brez lokacijskega filtra, enaka disciplina
  // kot drugje — guardResource je že opravil nadzor najemnika v izdaji računa).
  const candidates = await tx.menuItem.findMany({
    where: {
      id: { in: [...causeByMenuItem.keys()] },
      isAvailable: true,
      ...(locationId ? { Category: { Menu: { locationId } } } : {}),
    },
    select: { id: true, name: true },
  })
  if (candidates.length === 0) return []

  const newQtyById = new Map(depleted.map((d) => [d.inventoryItemId, r3(num(d.newQty))]))
  const state = await readStateTx(tx)
  const at = new Date().toISOString()
  const out: Auto86Entry[] = []
  for (const mi of candidates) {
    const cause = causeByMenuItem.get(mi.id)!
    const newQty = newQtyById.get(cause.inventoryItemId) ?? 0
    const cas = await tx.menuItem.updateMany({ where: { id: mi.id, isAvailable: true }, data: { isAvailable: false } })
    if (cas.count === 0) continue
    await writeAudit(tx, {
      userId,
      action: 'MENU_ITEM_AUTO_86',
      entityType: 'MenuItem',
      entityId: mi.id,
      details: jstr({
        name: mi.name,
        from: true,
        to: false,
        source: 'auto',
        mode: cfg.mode,
        inventoryItem: cause.inventoryItemName,
        inventoryItemId: cause.inventoryItemId,
        newQty,
        reason: 'stock-depleted',
      }),
      locationId,
    })
    state[mi.id] = { inventoryItemId: cause.inventoryItemId, at }
    out.push({ menuItemId: mi.id, name: mi.name, inventoryItemId: cause.inventoryItemId, inventoryItemName: cause.inventoryItemName, newQty })
  }
  if (out.length > 0) await writeStateTx(tx, state)
  return out
}

/**
 * Samodejna obnovitev po prilivu zaloge (GRN/prejem/popis/storno/odpad/prenos).
 * Fire-and-forget PO commitu (`void restoreAuto86ForInventory(...)`): napaka
 * se zapiše in NIKOLI ne podre priliva. Obnovi SAMO avtomatsko ugasnene
 * (state zapis) artikle, katerih vzročna zaloga je spet > 0; v 'recipe'
 * smislu preveri tudi, da NIČE od sestavin recepta ni več na nič.
 * Ročno ugasnjeni (brez state zapisa) ostanejo ugasneni — Toast disciplina.
 *
 * KANDIDATI (A10 disciplina): priliv zadeva artikel, če se je vrnil zapisani
 * VZROK (direct) ALI katera od sestavin njegove recepture (recipe — vzrok je
 * lahko druga izpraznjena sestavina, ki se je vrnila ŽE V PREJŠNJEM prilivu,
 * zato zapisani vzrok ni nujno v tem prilivu). Varovalka v zanki spodaj
 * vseeno zahteva, da je VSE, kar artikel potrebuje, spet > 0 — razširitev
 * kandidatov je varna v obeh načinih.
 */
export async function restoreAuto86ForInventory(inventoryItemIds: string[], userId?: string | null): Promise<void> {
  try {
    const ids = [...new Set((Array.isArray(inventoryItemIds) ? inventoryItemIds : []).filter((x) => typeof x === 'string' && x !== ''))]
    if (ids.length === 0) return

    const back = await db.inventoryItem.findMany({
      where: { id: { in: ids }, quantity: { gt: 0 } },
      select: { id: true, name: true, quantity: true },
    })
    if (back.length === 0) return
    const backById = new Map(back.map((b) => [b.id, b]))

    const state = await readStateTx(db)
    if (Object.keys(state).length === 0) return

    // Kandidati za obnovitev (A10): zapisani VZROK se je vrnil (direct) ALI se
    // je po recepturi vrnila katera od sestavin (recipe — vzrok je lahko druga
    // izpraznjena sestavina, ki se je vrnila ŽE V PREJŠNJEM prilivu, zato
    // zapisani vzrok ni nujno med tem prilivom). Varovalka v zanki spodaj
    // vseeno zahteva, da je VSE, kar artikel potrebuje, spet > 0.
    const candidateIds = new Set<string>()
    for (const [menuItemId, v] of Object.entries(state)) {
      if (backById.has(v?.inventoryItemId)) candidateIds.add(menuItemId)
    }
    const remaining = Object.keys(state).filter((id) => !candidateIds.has(id))
    if (remaining.length > 0) {
      const recipeHits = await db.recipeItem.findMany({
        where: { menuItemId: { in: remaining }, inventoryItemId: { in: ids } },
        select: { menuItemId: true },
      })
      for (const r of recipeHits) candidateIds.add(r.menuItemId)
    }
    if (candidateIds.size === 0) return
    const entries = Object.entries(state).filter(([menuItemId]) => candidateIds.has(menuItemId))

    let stateChanged = false
    for (const [menuItemId, v] of entries) {
      // Vzrok mora biti spet na zalogi — pri kandidatu prek recepture se je
      // zapisani vzrok morda vrnil že v PREJŠNJEM prilivu (backById pokriva
      // samo ta), zato sveža DB preveritev, kadar ni v trenutnem prilivu.
      const cause = backById.get(v.inventoryItemId) ?? (await db.inventoryItem.findUnique({
        where: { id: v.inventoryItemId },
        select: { id: true, name: true, quantity: true },
      }))
      if (!cause || r3(num(cause.quantity)) <= 0) continue // vzrok še ni nazaj — ne obnavljamo
      const mi = await db.menuItem.findUnique({
        where: { id: menuItemId },
        select: { id: true, name: true, isAvailable: true, Category: { select: { Menu: { select: { locationId: true } } } } },
      })
      if (!mi || mi.isAvailable) {
        // že ročno obnovljen / izbrisan → počisti zastareli state zapis
        delete state[menuItemId]
        stateChanged = true
        continue
      }
      // 'recipe' varovalka: nobena sestavina recepta ne sme biti več na nič
      // (direct artikli brez recepta imajo ingredients = [] → pogoj trivialno izpolnjen)
      const ingredients = await db.recipeItem.findMany({
        where: { menuItemId },
        select: { inventoryItemId: true },
      })
      if (ingredients.length > 0) {
        const zeroCount = await db.inventoryItem.count({
          where: { id: { in: [...new Set(ingredients.map((i) => i.inventoryItemId))] }, quantity: { lte: 0 } },
        })
        if (zeroCount > 0) continue // kaj drugega je še izpraznjeno — ne obnavljamo
      }
      const cas = await db.menuItem.updateMany({ where: { id: menuItemId, isAvailable: false }, data: { isAvailable: true } })
      delete state[menuItemId]
      stateChanged = true
      if (cas.count > 0) {
        await writeAudit(db, {
          userId: userId ?? null,
          action: 'MENU_ITEM_AUTO_RESTORE',
          entityType: 'MenuItem',
          entityId: menuItemId,
          details: jstr({
            name: mi.name,
            from: false,
            to: true,
            source: 'auto-restore',
            inventoryItem: cause.name,
            inventoryItemId: v.inventoryItemId,
            qty: r3(num(cause.quantity)),
          }),
          locationId: mi.Category?.Menu?.locationId ?? null,
        })
      }
    }
    if (stateChanged) await writeStateTx(db, state)
  } catch (e) {
    // obnovitev je ugodnost, ne kritična operacija — priliv OSTANE veljaven
    console.warn('[auto-86] restoreAuto86ForInventory failed (ignored):', (e as Error).message)
  }
}
