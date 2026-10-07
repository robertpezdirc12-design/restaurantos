/**
 * Dostava (issue #2 — obnova manjkajoče integracije Glovo/Wolt).
 *
 * REKONSTRUKCIJA: izvirni webhook contract-i niso berljivi v rekonstruiranem
 * source-u (v originalu so bili /api/delivery/webhook/glovo in /api/delivery/webhook/wolt
 * — dokazano z build logom zadnjega originalnega Vercel deploymenta). Dejanski
 * payload format je označen kot NOT_RECOVERABLE in je rekonstruiran tolerantno
 * (znana polja iz javnih platformskih vzorcev, neznana ignorirana, manjkajoče
 * polja poimenujemo). Nič ne kopira UX-a platform — samo podatkovni tok.
 *
 * Pravila (issue #2):
 *  - NI vzporednega modela naročil — vedno kanonični Order (createOrderCore);
 *  - isti meni/DDV/kuhinja/plačilo/FURS tok kot POS;
 *  - webhook secret NIKOLI v source-u (Integration.apiSecret v DB ali env);
 *  - podpis preverjen PRED zapisom (timingSafeEqual), replay zaščita,
 *    idempotencija prek Order.idempotencyKey (`glovo:<id>` / `wolt:<id>`),
 *    rate limiting, audit + IntegrationLog (napake vidne v Dnevniku napak);
 *  - občutljivi podatki (telefon) v logih maskirani.
 */
import { createHmac, timingSafeEqual } from 'crypto'
import { r2 } from '@/lib/map'

/* ───── Statusi dostave — kanonske mape živijo v map.ts (mapper sloj); tu re-eksport ───── */

export { deliveryStatusToUI, deliveryStatusToDB } from '@/lib/map'

/** Platforma → dobavljeno ime v Order.notes označi vir. Podprti viri webhookov. */
export const DELIVERY_PLATFORMS = ['glovo', 'wolt', 'domaca'] as const

/* ───── Preverjanje podpisa webhooka (HMAC-SHA256, timing-safe) ───── */

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!secret) return false
  if (!signatureHeader) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(expected, 'utf8')
  // podpira "sha256=<hex>" in gol <hex>
  const provided = signatureHeader.replace(/^sha256=/i, '').trim()
  let b: Buffer
  try {
    b = Buffer.from(provided, 'utf8')
  } catch {
    return false
  }
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Secret za platformo: Integration.apiSecret (DB, provider=glovo/wolt) ali env fallback. */
export async function getPlatformSecret(provider: string): Promise<string> {
  const { db } = await import('@/lib/db')
  const integration = await db.integration.findFirst({
    where: { provider, isActive: true },
    select: { apiSecret: true },
  })
  if (integration?.apiSecret) return integration.apiSecret
  const envKey = provider === 'glovo' ? 'GLOVO_WEBHOOK_SECRET' : provider === 'wolt' ? 'WOLT_WEBHOOK_SECRET' : ''
  return (envKey && process.env[envKey]) || ''
}

/* ───── Rate limiting javnih webhook endpointov (in-memory, per provider+IP) ───── */

const RATE_LIMIT = 30 // zahtev / min
const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (b.count >= RATE_LIMIT) return false
  b.count += 1
  return true
}

/* ───── Maskiranje občutljivih podatkov za log/audit ───── */

export function maskPhone(p: unknown): string {
  const s = String(p ?? '')
  if (s.length < 4) return '***'
  return `${'*'.repeat(Math.max(0, s.length - 3))}${s.slice(-3)}`
}

/* ───── Rekonstruirana preslikava payloadov → kanonični vnos ───── */

export interface MappedPlatformOrder {
  platformOrderId: string
  platform: 'glovo' | 'wolt'
  recipientName: string
  recipientPhone: string
  address: string
  city: string
  postCode: string
  instructions: string
  /** platformski artikel-id → lokalni MenuItem.id (povezava prek MenuItem.id ali eksternega koda) */
  items: { menuItemId: string; qty: number; note?: string }[]
  unmappedItems: string[]
  deliveryFee: number
  packagingFee: number
  note: string
}

type Row = Record<string, unknown>

function s(v: unknown, fb = ''): string {
  return (typeof v === 'string' && v.trim()) || (v == null ? fb : String(v ?? fb))
}
function n(v: unknown, fb = 0): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : fb
}

/** Najde lokalni MenuItem: po id, po imenu (case-insensitive) ali po kodi. */
async function resolveMenuItemId(raw: Row): Promise<string | null> {
  const { db } = await import('@/lib/db')
  const id = s(raw.menuItemId || raw.id || raw.sku)
  if (id) {
    const byId = await db.menuItem.findUnique({ where: { id }, select: { id: true } })
    if (byId) return byId.id
  }
  const name = s(raw.name || raw.title || raw.product_name)
  if (name) {
    const byName = await db.menuItem.findFirst({
      where: { name: { equals: name } },
      select: { id: true },
    })
    if (byName) return byName.id
  }
  return null
}

/** Glovo: tolerantna preslikava (rekonstruiran contract, ni verbatim iz originala). */
export async function mapGlovoPayload(body: Row): Promise<MappedPlatformOrder> {
  const order = (body.order && typeof body.order === 'object' ? (body.order as Row) : body)
  const customer = (order.customer && typeof order.customer === 'object' ? (order.customer as Row) : {})
  const addr = (order.delivery_address && typeof order.delivery_address === 'object'
    ? (order.delivery_address as Row)
    : (order.address && typeof order.address === 'object' ? (order.address as Row) : {}))
  const rawItems: Row[] = Array.isArray(order.products)
    ? (order.products as Row[])
    : Array.isArray(order.items)
      ? (order.items as Row[])
      : []

  const { db } = await import('@/lib/db')
  const items: MappedPlatformOrder['items'] = []
  const unmapped: string[] = []
  for (const raw of rawItems) {
    const menuItemId = await resolveMenuItemId(raw)
    const qty = Math.max(1, Math.round(n(raw.quantity ?? raw.qty ?? raw.count, 1)))
    if (menuItemId) {
      items.push({ menuItemId, qty, note: s(raw.note || raw.notes || raw.instructions) || undefined })
    } else {
      unmapped.push(s(raw.name || raw.title || raw.id, 'neznan artikel'))
    }
  }
  const loc = await db.location.findFirst({ select: { id: true } })

  return {
    platformOrderId: s(order.id ?? order.order_id ?? order.code),
    platform: 'glovo',
    recipientName: s(customer.first_name || customer.name) + (customer.last_name ? ` ${s(customer.last_name)}` : ''),
    recipientPhone: s(customer.phone || customer.phone_number),
    address: s(addr.street || addr.address || addr.line1),
    city: s(addr.city),
    postCode: s(addr.post_code || addr.zip || addr.postal_code),
    instructions: s(addr.extra || addr.details || order.customer_instructions || order.instructions),
    items,
    unmappedItems: unmapped,
    deliveryFee: n(order.delivery_fee ?? addr.delivery_fee, 0),
    packagingFee: n(order.packaging_fee, 0),
    note: `Glovo #${s(order.id ?? order.code)}${loc ? '' : ''}`,
  }
}

/** Wolt: tolerantna preslikava (rekonstruiran contract, ni verbatim iz originala). */
export async function mapWoltPayload(body: Row): Promise<MappedPlatformOrder> {
  const order = (body.order && typeof body.order === 'object' ? (body.order as Row) : body)
  const customer = (order.customer && typeof order.customer === 'object' ? (order.customer as Row) : {})
  const addr = (order.delivery && typeof order.delivery === 'object'
    ? (order.delivery as Row)
    : (order.address && typeof order.address === 'object' ? (order.address as Row) : {}))
  const rawItems: Row[] = Array.isArray(order.items)
    ? (order.items as Row[])
    : Array.isArray(order.products)
      ? (order.products as Row[])
      : []

  const items: MappedPlatformOrder['items'] = []
  const unmapped: string[] = []
  for (const raw of rawItems) {
    const menuItemId = await resolveMenuItemId(raw)
    const qty = Math.max(1, Math.round(n(raw.quantity ?? raw.qty ?? raw.count, 1)))
    if (menuItemId) {
      items.push({ menuItemId, qty, note: s(raw.note || raw.notes) || undefined })
    } else {
      unmapped.push(s(raw.name || raw.title || raw.sku, 'neznan artikel'))
    }
  }
  // Wolt pošilja cene v minor units (centi) — preslikava samo za log; cena vedno iz lokalnega menija
  return {
    platformOrderId: s(order.id ?? order.reference ?? order.order_id),
    platform: 'wolt',
    recipientName: s(customer.name || customer.first_name),
    recipientPhone: s(customer.phone || customer.phone_number),
    address: s(addr.address || addr.street || addr.line1),
    city: s(addr.city),
    postCode: s(addr.post_code || addr.zip || addr.postal_code),
    instructions: s(addr.details || order.customer_instructions || order.instructions),
    items,
    unmappedItems: unmapped,
    // Wolt konvencija: zneski v minor units (centi) → vedno /100 (dokumentirano v Wolt API v1)
    deliveryFee: r2(n(order.delivery_fee, 0) / 100),
    packagingFee: 0,
    note: `Wolt #${s(order.id ?? order.reference)}`,
  }
}

/** Enotna validacija preslikave — pred zapisom (issue #2: podpis → validacija → zapis). */
export function validateMapped(m: MappedPlatformOrder): string | null {
  if (!m.platformOrderId) return 'Manjka platformski ID naročila.'
  if (m.items.length === 0) {
    return m.unmappedItems.length > 0
      ? `Artiklov ni bilo mogoče preslikati v lokalni meni: ${m.unmappedItems.join(', ')}.`
      : 'Payload ne vsebuje artiklov.'
  }
  return null
}

/* ───── Idempotencija webhookov (Order.idempotencyKey) ───── */

export function webhookIdempotencyKey(platform: 'glovo' | 'wolt', platformOrderId: string): string {
  return `${platform}:${platformOrderId}`.slice(0, 64)
}
