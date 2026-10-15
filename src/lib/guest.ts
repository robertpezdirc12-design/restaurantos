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
import { rateLimitBoolAsync as rateLimitPublic } from '@/lib/rate-limit'
import { loadModifierContext, validateItemModifiers } from '@/lib/modifiers'
import { parseAllergenCodes } from '@/lib/allergen-catalog'
import { getMenuItemAllergenProfiles, sanitizeAllergenWarning, type AllergenProfile } from '@/lib/allergen-profile'

// Issue #4 §6: rate limiting je ZDAJ skupni modul z omejenim pomnilnikom + TTL
// (prej: lokalna Map brez TTL čiščenja). Public API ostaja kompatibilen.
export { rateLimitPublic }

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
  const [categories, items, groups, modifiers, settings] = await Promise.all([
    db.category.findMany({ where: { menuId: { in: menuIds } }, orderBy: { sortOrder: 'asc' } }),
    db.menuItem.findMany({
      where: { Category: { menuId: { in: menuIds } } },
      orderBy: { sortOrder: 'asc' },
      include: { MenuItemModifierGroup: true },
    }),
    db.modifierGroup.findMany({ where: { locationId }, orderBy: { sortOrder: 'asc' } }),
    db.modifier.findMany({ where: { isAvailable: true }, orderBy: { sortOrder: 'asc' } }),
    // OPS-9 val 3: gate for the QR-menu allergen filter (RestaurantSettings singleton)
    db.restaurantSettings.findFirst({ select: { allergenFilterEnabled: true } }),
  ])
  // Issue #7 (P1, v1.104.0): strukturirani kanonični alergeni (kode iz kataloga) —
  // en vir resnice (sestavine recepture ∪ legacy preslikano − override). Padec
  // izračuna (npr. pred DDL) NE podre javnega menija — pade nazaj na legacy niz.
  const allergenProfiles = await getMenuItemAllergenProfiles(items.map((i) => i.id)).catch(
    () => new Map<string, AllergenProfile>(),
  )
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
    // OPS-9 val 3 (v1.76.0): allergen filter gate — default true (schema default), only an
    // explicit false in RestaurantSettings hides the chips on the guest page
    allergenFilterEnabled: settings?.allergenFilterEnabled !== false,
    items: items.map((i) => {
      const profile = allergenProfiles.get(i.id)
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
        // Issue #7: strukturirani alergeni (kanonične kode + status — NIKOLI
        // lažno "brez alergenov": needs_confirmation pokaže opozorilo osebja)
        allergenCodes: profile?.codes ?? [],
        allergenCrossContact: profile?.crossContact ?? [],
        allergenStatus: profile?.status ?? 'needs_confirmation',
        categoryId: i.categoryId,
        modifierGroups: groupIds.map((g) => ({
          id: g.id,
          name: g.name,
          required: g.required,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          options: (modsByGroup.get(g.id) || [])
            .filter((m) => m.isAvailable)
            .map((m) => ({
              id: m.id,
              name: m.name,
              price: num(m.price),
              // Issue #7: alergeni dodatka (opcija spremeni profil NAROČENE postavke)
              allergenCodes: parseAllergenCodes(m.allergens).codes,
            })),
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
  /** Issue #7 (P1): izrecno alergensko opozorilo gosta (≤ 200) — viden na KDS + kuhinjskem listu */
  allergenWarning?: string
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
  allergenWarning: string
  price: number
  vatRate: number
  modifiers: ResolvedModifier[]
}

/**
 * Issue #4 §5: polna validacija — relacija MenuItem → MenuItemModifierGroup →
 * ModifierGroup → Modifier, required/minSelect/maxSelect, duplikati, cene iz DB.
 * §4: če je podan locationId, mora artikel pripadati tej lokaciji (prek Category→Menu).
 */
export async function resolveGuestItems(
  items: GuestItemInput[],
  opts?: { locationId?: string | null }
): Promise<ResolvedItem[]> {
  if (!Array.isArray(items) || items.length === 0) throw new GuestError('Naročilo mora vsebovati vsaj en artikel.')
  if (items.length > 60) throw new GuestError('Preveč postavk v enem naročilu (max 60).')
  const ids = [...new Set(items.map((i) => String(i?.menuItemId || '')))]
  const modIds = [...new Set(items.flatMap((i) => (Array.isArray(i.modifierIds) ? i.modifierIds : []).map(String)))]

  const [menuItemsRaw, ctx] = await Promise.all([
    db.menuItem.findMany({
      where: { id: { in: ids }, isAvailable: true },
      include: { Category: { include: { Menu: { select: { locationId: true } } } } },
    }),
    loadModifierContext(ids, modIds),
  ])
  const menuItems = opts?.locationId
    ? menuItemsRaw.filter((mi) => mi.Category?.Menu?.locationId === opts.locationId)
    : menuItemsRaw

  const out: ResolvedItem[] = []
  for (const item of items) {
    const mi = menuItems.find((m) => m.id === item.menuItemId)
    if (!mi) throw new GuestError('Artikel ni več na voljo.')
    const qty = Math.max(1, Math.min(30, Math.round(Number(item.qty) || 1)))
    const chosen = Array.isArray(item.modifierIds) ? item.modifierIds.map(String) : []
    const v = validateItemModifiers({
      allowedGroupIds: ctx.allowedByItem.get(mi.id) || [],
      groupById: ctx.groupById,
      modById: ctx.modById,
      chosenIds: chosen,
    })
    if (!v.ok) throw new GuestError(v.error || 'Opcije niso veljavne.', 400)
    out.push({
      menuItemId: mi.id,
      qty,
      note: String(item.note || '').slice(0, 200),
      allergenWarning: sanitizeAllergenWarning(item.allergenWarning),
      price: num(mi.price),
      vatRate: num(mi.vatRate, 22),
      modifiers: v.resolved,
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

/** Issue #4 §2.2: enkratna vpisna koda (8 števk) za device enrollment — kratkotrajna. */
export function newEnrollmentCode(): string {
  return String(crypto.randomInt(10000000, 99999999))
}

export { nid }
