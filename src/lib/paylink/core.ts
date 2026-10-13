import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { issueFursReceipt } from '@/lib/furs/issue'
import { clientIp } from '@/lib/guest'
import { jparse, r2 } from '@/lib/map'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) — jedro javne plačilne povezave (»QR položnica«).
 *
 * Načrt (isti duh kot Issue #3 javni naročilni tok):
 *  - token (32-hex skrivnost, vzorec Table.qrToken) JE avtorizacija — gost
 *    NIKOLI ne pošilja ID-jev, vse se reši strežniško iz tokena;
 *  - znesek se izračuna z kanoničnim computeBill ob plačilu (ne zaupan clientu);
 *  - PLAČILO teče skozi ISTO FURS jedro (issueFursReceipt): sintetični
 *    NextRequest + strežniško kovan break-glass žeton (sub='bootstrap', 2 min).
 *    Žeton ne zapusti procesa; requirePermission/guardResource/CAS/idempotenca/
 *    EOR/ZKI-JIR/audit veriga ostanejo kanonični (0 duplikata fiskalne logike).
 *    Vzorec: auth ostaja v jedru ker requirePermission zahteva NextRequest
 *    (komentar v src/lib/furs/issue.ts, enako kot src/lib/recurring-run.ts).
 *  - ponudnik plačil: Integration (type='payments', isActive) oz. STRIPE_SECRET_KEY
 *    env → Stripe Checkout (kartica se vnese NA Stripe domeni — PCI SAQ-A drža);
 *    brez konfiguracije → simulator (SIM-xxxxxx, kot terminalski simulator;
 *    NIKOLI se ne izdaja za produkcijo — stran nosi vidno značko "Simulacija").
 */

// ---------- token ----------

export function newPayLinkToken(): string {
  return crypto.randomBytes(16).toString('hex') // 32 znakov, unguessable (vzorec newQrToken)
}

export function isPayLinkTokenShape(token: string): boolean {
  return /^[a-f0-9]{32}$/.test(token || '')
}

export function payLinkUrl(req: Request, token: string): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000'
  return `${proto}://${host}/pay/${token}`
}

// ---------- ponudnik plačil ----------

export type PayProviderKind = 'simulator' | 'stripe'

export interface PayProvider {
  kind: PayProviderKind
  /** Stripe tajni ključ (samo kind='stripe'). */
  secretKey?: string
}

interface PaymentsIntegrationConfig {
  provider?: string
  secretKey?: string
}

/**
 * Ponudnik plačil za lokacijo: Integration (type='payments', isActive, enako
 * iskanje kot smsConfigForLocation) → config.provider='stripe' + secretKey;
 * sicer env STRIPE_SECRET_KEY; sicer simulator (izklop iz vesolja ni možen —
 * simulator je vedno honest, vidno označen).
 */
export async function resolvePayProvider(locationId: string): Promise<PayProvider> {
  const envKey = (process.env.STRIPE_SECRET_KEY || '').trim()
  if (envKey) return { kind: 'stripe', secretKey: envKey }
  const rows = await db.integration.findMany({
    where: { type: 'payments', isActive: true, OR: [{ locationId }, { locationId: null }] },
  })
  for (const r of rows) {
    const cfg = jparse<PaymentsIntegrationConfig>(r.config, {})
    if (cfg?.provider === 'stripe' && cfg.secretKey) return { kind: 'stripe', secretKey: cfg.secretKey }
  }
  return { kind: 'simulator' }
}

// ---------- simulator (honest, vidno označen na strani) ----------

export interface SimulatedChargeResult {
  approved: true
  approvalCode: string
  terminal: 'simulator'
}

/** Strežniški simulator (isti format odobritev SIM-XXXXXX kot terminalski adapter). */
export async function simulatedCharge(_amount: number): Promise<SimulatedChargeResult> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  const approvalCode = 'SIM-' + Math.random().toString(36).slice(2, 8).toUpperCase()
  return { approved: true, approvalCode, terminal: 'simulator' }
}

// ---------- Stripe Checkout (plain fetch — kartica se vnese na Stripe domeni) ----------

export interface StripeCheckoutArgs {
  secretKey: string
  amountCents: number
  currency: string
  description: string
  successUrl: string
  cancelUrl: string
}

export interface StripeCheckoutResult {
  sessionId: string
  url: string
}

/** Ustvari Stripe Checkout sejo (znesek ZAKLEPAN na seji — napitnina vključena). */
export async function stripeCreateCheckout(args: StripeCheckoutArgs): Promise<StripeCheckoutResult> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': args.currency,
    'line_items[0][price_data][unit_amount]': String(Math.round(args.amountCents)),
    'line_items[0][price_data][product_data][name]': args.description.slice(0, 100),
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  })
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Stripe checkout ${res.status}: ${detail.slice(0, 180)}`)
  }
  const data = (await res.json()) as { id: string; url: string }
  return { sessionId: data.id, url: data.url }
}

export interface StripeSessionStatus {
  paid: boolean
  paymentIntent: string | null
  amountTotalCents: number | null
}

/**
 * Preveri sejo (server-to-server — avtoriteta je Stripe, ne client).
 * payment_intent → approvalCode (sledljivost kot terminalski SIM- kodi).
 */
export async function stripeSessionStatus(secretKey: string, sessionId: string): Promise<StripeSessionStatus> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  })
  if (!res.ok) throw new Error(`Stripe session ${res.status}`)
  const data = (await res.json()) as { payment_status?: string; payment_intent?: string | null; amount_total?: number | null }
  return {
    paid: data.payment_status === 'paid',
    paymentIntent: data.payment_intent || null,
    amountTotalCents: typeof data.amount_total === 'number' ? data.amount_total : null,
  }
}

// ---------- finalize: plačilo SKOZI kanonično FURS jedro ----------

export interface FinalizePayLinkArgs {
  payLinkToken: string
  orderId: string
  /** Napitnina v EUR (absolutna vrednost — enaka konvencija kot POST /api/furs). */
  tip: number
  /** Oznaka ponudnika: 'simulator' | 'stripe' (v Payment sled). */
  approvalCode: string
  /** IP gosta za audit (lazy — null če neznan). */
  ip?: string | null
}

export type FinalizePayLinkResult =
  | { ok: true; replayed: boolean; invoice: Record<string, unknown> }
  | { ok: false; status: number; error: string }

/**
 * Izvede plačilo naročila prek povezave — 0 nove plačilne/fiskalne logike:
 * POST /api/furs (issueFursReceipt) prek sintetične zahteve z break-glass
 * žetonom (sub='bootstrap', vloga ADMIN, 2 minuti življenjske dobe, kovan
 * IZKLJUČNO v tem strežniškem procesu — HMAC podpis zahteva APP_SECRET).
 * clientOperationId = 'plk:<token>' → stabilna idempotenca: dvojni klik,
 * osvežitev ali ponovni prihod s Stripe vrnitve vrača ISTI račun (replayed).
 */
export async function finalizePayLinkPayment(args: FinalizePayLinkArgs): Promise<FinalizePayLinkResult> {
  const token = createToken(
    { sub: 'bootstrap', name: 'Plačilna povezava', role: 'ADMIN', loc: null, sv: 0 },
    2 / 60, // 2 minuti — žeton je samo za ta en klic
  )
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
  if (args.ip) headers['x-forwarded-for'] = args.ip
  const req = new NextRequest('http://127.0.0.1:3000/api/furs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      orderId: args.orderId,
      type: 'card',
      tip: r2(args.tip),
      terminal: { approvalCode: args.approvalCode },
      clientOperationId: `plk:${args.payLinkToken}`,
    }),
  })
  const res = await issueFursReceipt(req)
  const data = (await res.json().catch(() => null)) as { invoice?: Record<string, unknown>; replayed?: boolean; error?: string } | null
  if (!res.ok || !data?.invoice) {
    return { ok: false, status: res.status, error: data?.error || `Plačilo ni uspelo (${res.status}).` }
  }
  return { ok: true, replayed: data.replayed === true, invoice: data.invoice }
}

// ---------- capability probe (v1.85.1 — haccp-plans vzorec) ----------

/**
 * Ali tabela PayLink obstaja (dev SQLite: da prek db push; produkcijski Neon:
 * po migrate-paylink DDL koraku). 60 s TTL — produkcijska PayLink ruta med
 * čakanjem na DDL vrača 503 s prijaznim sporočilom namesto 500.
 */
let payLinkProbeCache: { ok: boolean; at: number } | null = null

export async function payLinkReady(): Promise<boolean> {
  if (payLinkProbeCache && Date.now() - payLinkProbeCache.at < 60_000) return payLinkProbeCache.ok
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "PayLink" LIMIT 1')
    payLinkProbeCache = { ok: true, at: Date.now() }
    return true
  } catch {
    payLinkProbeCache = { ok: false, at: Date.now() }
    return false
  }
}

/** Reset probe (migrate-paylink po DDL; teste). */
export function resetPayLinkProbe(): void {
  payLinkProbeCache = null
}

// ---------- skupne pomožke ----------

/** IP gosta (enaka izpeljava kot javne rute — clientIp iz @/lib/guest). */
export function payClientIp(req: Request): string {
  return clientIp(req)
}
