import crypto from 'crypto'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'
import type { StripeSessionView } from '@/lib/paylink/settle'

/**
 * v1.157.0 — Stripe webhook: podpis in branje dogodka.
 *
 * Vrstni red je varnostni pogoj: najprej podpis (Stripe-Signature, HMAC-SHA256
 * nad "<t>.<raw body>", timing-safe, toleranca 300 s), ŠELE nato branje
 * dogodka. Brez podpisa telo ni nikoli vir resnice — tudi če vsebuje
 * prepričljive payLinkId/zneske.
 */

export const STRIPE_PAYMENT_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] as const

export interface StripeSignatureOptions {
  /** Za deterministične teste; privzeto Date.now(). */
  now?: number
  /** Dovoljeno odstopanje (Stripe privzeto 300 s). */
  toleranceSeconds?: number
}

/**
 * Preveri glavo `Stripe-Signature` (npr. `t=123,v1=<hex>[,v1=<hex>]`).
 * Podpira več v1 podpisov (rotacija skrivnosti) — zadostuje eden veljaven.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: StripeSignatureOptions = {},
): boolean {
  if (!secret || !header) return false
  let timestampRaw: string | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestampRaw = value
    else if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase())
  }
  if (!timestampRaw || signatures.length === 0) return false
  const timestamp = Number(timestampRaw)
  if (!Number.isFinite(timestamp)) return false
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const tolerance = opts.toleranceSeconds ?? 300
  if (Math.abs(now - timestamp) > tolerance) return false

  const expected = crypto.createHmac('sha256', secret).update(`${timestampRaw}.${payload}`, 'utf8').digest('hex')
  const a = Buffer.from(expected, 'utf8')
  for (const sig of signatures) {
    const b = Buffer.from(sig, 'utf8')
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
  }
  return false
}

export interface StripeWebhookEvent {
  id: string | null
  type: string | null
  session: StripeSessionView | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function metadataOf(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string> = {}
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out[k] = value
  }
  return out
}

/** Varen razčlenjevalnik podpisanega dogodka; null = neveljavna oblika. */
export function parseStripeEvent(raw: string): StripeWebhookEvent | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const event = obj as { id?: unknown; type?: unknown; data?: { object?: unknown } }
  const o = event.data?.object
  if (!o || typeof o !== 'object') return { id: str(event.id), type: str(event.type), session: null }
  const s = o as Record<string, unknown>
  return {
    id: str(event.id),
    type: str(event.type),
    session: {
      id: str(s.id),
      paid: s.payment_status === 'paid',
      paymentIntent: str(s.payment_intent),
      amountTotalCents: typeof s.amount_total === 'number' ? s.amount_total : null,
      currency: str(s.currency),
      sessionStatus: str(s.status),
      mode: str(s.mode),
      metadata: metadataOf(s.metadata),
      clientReferenceId: str(s.client_reference_id),
    },
  }
}

/**
 * Lokacijski namig za izbiro skrivnosti (NEVERJETO vhodno polje — uporabi se
 * SAMO za izbiro skrivnosti, ki mora nato podpis potrditi).
 */
export function stripeEventLocationHint(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { data?: { object?: { metadata?: { locationId?: unknown } } } }
    const id = obj?.data?.object?.metadata?.locationId
    return typeof id === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Skrivnost webhooka: globalni `STRIPE_WEBHOOK_SECRET` ali (za ločene Stripe
 * račune po lokaciji) `webhookSecret` v Integration(type='payments'). Brez
 * skrivnosti endpoint vrača 503 — nikoli ne sprejema nepodpisanih dogodkov.
 */
export async function resolveStripeWebhookSecret(locationId?: string | null): Promise<string> {
  const env = (process.env.STRIPE_WEBHOOK_SECRET || '').trim()
  if (env) return env
  if (!locationId) return ''
  try {
    const rows = await db.integration.findMany({
      where: { type: 'payments', isActive: true, OR: [{ locationId }, { locationId: null }] },
    })
    for (const r of rows) {
      const cfg = jparse<{ provider?: string; webhookSecret?: string }>(r.config, {})
      if (cfg?.provider === 'stripe' && typeof cfg.webhookSecret === 'string' && cfg.webhookSecret.trim()) {
        return cfg.webhookSecret.trim()
      }
    }
  } catch {
    return ''
  }
  return ''
}
