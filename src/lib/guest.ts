/**
 * Issue #3 — QR meni / self-order / kiosk / customer display (javni gostujoči tok).
 * Ključna pravila:
 *  - QR token JE skrivnost (32 hex, random) — shranjen v Table.qrToken, revokacija = rotacija.
 *  - Gost NIKOLI ne pošilja locationId/tableId — vsi ID-ji se rešijo server-side iz tokena.
 *  - Cene/DDV/modifierji se VEDNO berejo iz DB (isti meni kot POS) — client price ni zaupan.
 *  - Idempotencija: clientOperationId (isti unique kot POS) — refresh/double-tap ne ustvari dvojnika.
 *  - Rate limiting: v pomnilniku (enako kot delivery.ts).
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { nid, num } from '@/lib/map'

// ---------- Rate limiting (v pomnilniku, enak vzorec kot delivery.ts) ----------
const buckets = new Map<string, { count: number; reset: number }>()

export function rateLimitPublic(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.reset < now) {
    if (buckets.size > 5000) buckets.clear()
    buckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  b.count++
  return b.count <= limit
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  return (fwd ? fwd.split(',')[0].trim() : null) || req.headers.get('x-real-ip') || 'local'
}

// ---------- QR token ----------
export function newQrToken(): string {
  return crypto.randomBytes(16).toString('hex') // 32 znakov, unguessable
}

export function qrUrl(req: Request, token: string): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000'
  return `${proto}://${host}/m/${token}`
}

/** Reši QR token → miza + lokacija. Vrne null če token neveljaven/izklopljen. */
export async function resolveQrToken(token: string) {
  if (!token || token.length < 16 || !/^[a-f0-9]+$/i.test(token)) return null
  const table = await db.table.findUnique({
    where: { qrToken: token },
    include: { Location: true },
  })
  if (!table || !table.qrEnabled) return null
  return table
}

// ---------- Javni meni (ENOTEN vir = isti DB kot POS) ----------
export async function loadPublicMenu(locationId: string) {
  const menus = await db.menu.findMany({ where: { locationId, isActive: true }, select: { id: true } })
  const menuIds = menus.map((m) => m.id)
  const [categories, items, groups, modifiers] = await Promise.all([
    db.category.findMany({ where: { menuId: { in: menuIds } }, orderBy: { sortOrder: 'asc' } }),
    db.menuItem.findMany({
      where: { Category: { menuId: { in: menuIds } } },
      orderBy: { sortOrder: 'asc' },
      include: { MenuItemModifierGroup: true },
    }),
    db.modifierGroup.findMany({ where: { locationId }, orderBy: { sortOrder: 'asc' } }),
    db.modifier.findMany({ where: { isAvailable: true }, orderBy: { sortOrder: 'asc' } }),
  ])
  const links = items.length
    ? await db.menuItemModifierGroup.findMany({ where: { menuItemId: { in: items.map((i) => i.id) } } })
    : []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const modsByGroup = new Map<string, typeof modifiers>()
  for (const m of modifiers) {
    const list = modsByGroup.get(m.modifierGroupId) || []
    list.push(m)
    modsByGroup.set(m.modifierGroupId, list)
  }
  const linksByItem = new Map<string, string[]>()
  for (const l of links) {
    const list = linksByItem.get(l.menuItemId) || []
    list.push(l.modifierGroupId)
    linksByItem.set(l.menuItemId, list)
  }
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })),
    items: items.map((i) => {
      const groupIds = (linksByItem.get(i.id) || [])
        .map((gid) => groupById.get(gid))
        .filter((g): g is NonNullable<typeof g> => !!g)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      return {
        id: i.id,
        name: i.name,
        description: i.description,
        price: num(i.price),
        vatRate: num(i.vatRate, 22),
        isAvailable: i.isAvailable,
        image: i.image || '',
        allergens: i.allergens || '',
        categoryId: i.categoryId,
        modifierGroups: groupIds.map((g) => ({
          id: g.id,
          name: g.name,
          required: g.required,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          options: (modsByGroup.get(g.id) || [])
            .filter((m) => m.isAvailable)
            .map((m) => ({ id: m.id, name: m.name, price: num(m.price) })),
        })),
      }
    }),
  }
}

// ---------- Validacija gostujočih postavk (cene VEDNO iz DB) ----------
export interface GuestItemInput {
  menuItemId: string
  qty?: number
  note?: string
  modifierIds?: string[]
}

export interface ResolvedModifier {
  modifierId: string
  name: string
  price: number
  groupName: string
  modifierGroupId: string
}

export interface ResolvedItem {
  menuItemId: string
  qty: number
  note: string
  price: number
  vatRate: number
  modifiers: ResolvedModifier[]
}

export async function resolveGuestItems(items: GuestItemInput[]): Promise<ResolvedItem[]> {
  if (!Array.isArray(items) || items.length === 0) throw new GuestError('Naročilo mora vsebovati vsaj en artikel.')
  if (items.length > 60) throw new GuestError('Preveč postavk v enem naročilu (max 60).')
  const ids = items.map((i) => String(i?.menuItemId || ''))
  const menuItems = await db.menuItem.findMany({
    where: { id: { in: ids }, isAvailable: true },
    include: { Category: true },
  })
  const modIds = items.flatMap((i) => (Array.isArray(i.modifierIds) ? i.modifierIds : []).map(String))
  const mods = modIds.length
    ? await db.modifier.findMany({ where: { id: { in: modIds }, isAvailable: true }, include: { ModifierGroup: true } })
    : []
  const out: ResolvedItem[] = []
  for (const item of items) {
    const mi = menuItems.find((m) => m.id === item.menuItemId)
    if (!mi) throw new GuestError('Artikel ni več na voljo.')
    const qty = Math.max(1, Math.min(30, Math.round(Number(item.qty) || 1)))
    const itemMods: ResolvedModifier[] = []
    for (const mid of Array.isArray(item.modifierIds) ? item.modifierIds : []) {
      const m = mods.find((x) => x.id === String(mid))
      if (!m) throw new GuestError('Opcija ni več na voljo.')
      // opcija mora pripadati skupini, ki je povezana s tem artiklom
      const linked = mods.find((x) => x.id === m.id)
      if (!linked) throw new GuestError('Opcija ni na voljo za ta artikel.')
      itemMods.push({
        modifierId: m.id,
        name: m.name,
        price: num(m.price),
        groupName: m.ModifierGroup?.name || '',
        modifierGroupId: m.modifierGroupId,
      })
    }
    out.push({
      menuItemId: mi.id,
      qty,
      note: String(item.note || '').slice(0, 200),
      price: num(mi.price),
      vatRate: num(mi.vatRate, 22),
      modifiers: itemMods,
    })
  }
  return out
}

export class GuestError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// ---------- Javni status (whitelist polj — brez občutljivih podatkov) ----------
export const GUEST_VISIBLE_ORDER_STATUS: Record<string, string> = {
  open: 'prejeto',
  in_progress: 'v pripravi',
  ready: 'pripravljeno',
  served: 'postreženo',
  paid: 'plačano',
  cancelled: 'preklicano',
}

export function deviceFromToken(deviceId: string | null) {
  if (!deviceId) return null
  return db.deviceRegistry.findUnique({ where: { deviceId }, include: { Location: true } })
}

export function deviceAlive<T extends { revokedAt: Date | null; type: string }>(
  device: T | null,
  allowedTypes: string[]
): device is T {
  return !!device && !device.revokedAt && allowedTypes.includes(device.type)
}

export function newPairingCode(): string {
  return String(crypto.randomInt(100000, 999999))
}

export { nid }
