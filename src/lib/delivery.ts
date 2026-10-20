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
 *    idempotencija prek Order.idempotencyKey (v1.159.0: ključ vsebuje
 *    lokacijo — isti platformski ID dveh lokacij ne trči; stari ključi brez
 *    lokacije ostajajo berljivi za replay/preklic),
 *    rate limiting, audit + IntegrationLog (napake vidne v Dnevniku napak);
 *  - občutljivi podatki (telefon) v logih maskirani.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { r2 } from '@/lib/map'
import { rateLimitBoolAsync } from '@/lib/rate-limit'

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

/** Env secret platforme (uporabljen, ko Integration.apiSecret ni nastavljen). */
export function deliveryEnvSecret(provider: string): string {
  const envKey = provider === 'glovo' ? 'GLOVO_WEBHOOK_SECRET' : provider === 'wolt' ? 'WOLT_WEBHOOK_SECRET' : ''
  return (envKey && process.env[envKey]) || ''
}

/* ───── Rate limiting javnih webhook endpointov (enoten limiter, issue #4 §6 + #10 P2-1) ───── */

/** 30 zahtev / min per provider+IP; store-aware (Upstash, ko je konfiguriran, sicer memory). */
export async function rateLimit(key: string): Promise<boolean> {
  return rateLimitBoolAsync(key, 30)
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
  /** OPS-9 val 3: provider ETA in minutes (tolerant pickup; undefined = not supplied). */
  estimatedMinutes?: number
}

type Row = Record<string, unknown>

function s(v: unknown, fb = ''): string {
  return (typeof v === 'string' && v.trim()) || (v == null ? fb : String(v ?? fb))
}
function n(v: unknown, fb = 0): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : fb
}

/**
 * Najde lokalni MenuItem: po id, po imenu (case-insensitive) ali po kodi.
 * v1.159.0: ko je lokacija znana, se išče SAMO v meniju te lokacije — enako
 * ime na dveh lokacijah ne sme izbrati tujega artikla (naročilo bi padlo na
 * "Artikel ni na voljo na tej lokaciji"). Brez lokacije ostane globalno
 * iskanje (legacy namestitve brez Integration.locationId).
 */
async function resolveMenuItemId(raw: Row, locationId: string | null): Promise<string | null> {
  const { db } = await import('@/lib/db')
  const scope = locationId
    ? { Category: { is: { Menu: { is: { locationId } } } } }
    : {}
  const id = s(raw.menuItemId || raw.id || raw.sku)
  if (id) {
    const byId = await db.menuItem.findFirst({ where: { id, ...scope }, select: { id: true } })
    if (byId) return byId.id
  }
  const name = s(raw.name || raw.title || raw.product_name)
  if (name) {
    const byName = await db.menuItem.findFirst({
      where: { name: { equals: name }, ...scope },
      select: { id: true },
    })
    if (byName) return byName.id
  }
  return null
}

/** Glovo: tolerantna preslikava (rekonstruiran contract, ni verbatim iz originala). */
export async function mapGlovoPayload(body: Row, locationId: string | null = null): Promise<MappedPlatformOrder> {
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

  const items: MappedPlatformOrder['items'] = []
  const unmapped: string[] = []
  for (const raw of rawItems) {
    const menuItemId = await resolveMenuItemId(raw, locationId)
    const qty = Math.max(1, Math.round(n(raw.quantity ?? raw.qty ?? raw.count, 1)))
    if (menuItemId) {
      items.push({ menuItemId, qty, note: s(raw.note || raw.notes || raw.instructions) || undefined })
    } else {
      unmapped.push(s(raw.name || raw.title || raw.id, 'neznan artikel'))
    }
  }

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
    note: `Glovo #${s(order.id ?? order.code)}`,
    estimatedMinutes: n(order.eta_minutes ?? order.estimated_minutes ?? order.delivery_time, 0) || undefined,
  }
}

/** Wolt: tolerantna preslikava (rekonstruiran contract, ni verbatim iz originala). */
export async function mapWoltPayload(body: Row, locationId: string | null = null): Promise<MappedPlatformOrder> {
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
    const menuItemId = await resolveMenuItemId(raw, locationId)
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
    estimatedMinutes: n(order.eta_minutes ?? order.estimated_minutes ?? order.delivery_time, 0) || undefined,
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

/* ───── OPS-9 val 3 (v1.76.0) — Auto-accept konfiguracija (delivery-auto-accept) ───── */

/** Integration row marker (name=..., type='other') holding the auto-accept config JSON. */
export const DELIVERY_AUTO_ACCEPT_MARKER = 'delivery-auto-accept'

/** Providers that can be auto-accepted (webhook /api/delivery/webhook/[provider] set). */
export const DELIVERY_AUTO_ACCEPT_PROVIDERS = ['glovo', 'wolt'] as const

export interface DeliveryAutoAcceptConfig {
  enabled: boolean
  providers: string[]
}

/**
 * Pure resolver for the Integration config JSON (unit-tested):
 *  - missing/garbage config → defaults (enabled = fallbackEnabled, all known providers);
 *    fallbackEnabled defaults TRUE so existing setups keep today's behavior (platform
 *    orders arrive confirmed) until a manager explicitly switches auto-accept off;
 *  - enabled must be a boolean to deviate from the fallback;
 *  - providers: filtered to known providers, lowercased, deduped; empty/invalid → default.
 */
export function resolveAutoAcceptConfig(raw: unknown, fallbackEnabled = true): DeliveryAutoAcceptConfig {
  const defaultProviders: string[] = [...DELIVERY_AUTO_ACCEPT_PROVIDERS]
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: fallbackEnabled, providers: defaultProviders }
  }
  const o = raw as Record<string, unknown>
  const enabled = typeof o.enabled === 'boolean' ? o.enabled : fallbackEnabled
  let providers = defaultProviders
  if (Array.isArray(o.providers)) {
    const clean = [...new Set(
      (o.providers as unknown[])
        .filter((p): p is string => typeof p === 'string' && !!p.trim())
        .map((p) => p.trim().toLowerCase())
        .filter((p) => (DELIVERY_AUTO_ACCEPT_PROVIDERS as readonly string[]).includes(p)),
    )]
    if (clean.length > 0) providers = clean
  }
  return { enabled, providers }
}

/** Auto-accept decision for a concrete provider (case-insensitive; disabled → false). */
export function autoAcceptsProvider(cfg: DeliveryAutoAcceptConfig, provider: string): boolean {
  if (!cfg.enabled) return false
  return cfg.providers.includes(String(provider || '').trim().toLowerCase())
}

/** Tolerant ETA pickup: positive numeric minutes (or numeric string) → Date | null. */
export function estimatedTimeFromMinutes(raw: unknown, now: Date = new Date()): Date | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) return null
  return new Date(now.getTime() + Math.round(n) * 60000)
}

/** DB loader for the auto-accept config (same dynamic-import pattern as getPlatformSecret). */
export async function getDeliveryAutoAcceptConfig(): Promise<DeliveryAutoAcceptConfig> {
  const { db } = await import('@/lib/db')
  const { jparse } = await import('@/lib/map')
  const row = await db.integration.findFirst({ where: { name: DELIVERY_AUTO_ACCEPT_MARKER, type: 'other' } })
  if (!row) return resolveAutoAcceptConfig(null) // defaults: enabled=true, all providers (backward compatible)
  return resolveAutoAcceptConfig(jparse<unknown>(row.config, null))
}

/* ───── Idempotencija webhookov (Order.idempotencyKey) ───── */

/** Stari ključ (v1.159.0 in prej): brez lokacije — ostaja za branje obstoječih vrstic. */
export function legacyWebhookIdempotencyKey(platform: 'glovo' | 'wolt', platformOrderId: string): string {
  return `${platform}:${platformOrderId}`.slice(0, 64)
}

/**
 * Ključ idempotence, vezan na lokacijo: isti platformski ID dveh računov
 * (dveh lokacij) NE sme trčiti — sicer drugo naročilo postane "replay" s
 * tujim kontekstom in je zavrnjeno. Berljiva predpona + hash (polna lokacija
 * in ID), zato dolžina ≤ 64 tudi pri dolgih ID-jih.
 */
export function webhookIdempotencyKey(platform: 'glovo' | 'wolt', platformOrderId: string, locationId?: string | null): string {
  if (!locationId) return legacyWebhookIdempotencyKey(platform, platformOrderId)
  const digest = createHash('sha256').update(`${locationId}\u0000${platformOrderId}`, 'utf8').digest('hex').slice(0, 32)
  return `${platform}:${locationId.slice(0, 12)}:${digest}`
}
