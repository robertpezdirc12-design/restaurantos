import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { issueFursReceipt } from '@/lib/furs/issue'
import { resolveFiscalProfile, FiscalConfigError } from '@/lib/fiscal-profile'
import { clientIp } from '@/lib/guest'
import { jparse, r2 } from '@/lib/map'
import { GET as billGET } from '@/app/api/orders/[id]/bill/route'

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

export interface PayLinkSettlementEnv {
  FURS_ENVIRONMENT?: string
  FURS_ALLOW_SIMULATION?: string
  FURS_PRODUCTION_TEST_MODE?: string
  NODE_ENV?: string
}

/**
 * Ali javna plačilna povezava SME poravnati prek simulatorja za to lokacijo.
 *
 * Simulator je edini ponudnik brez konfiguracije, zato mora meja priti iz
 * STREŽNIŠKEGA fiskalnega profila (issue #53), ne iz klienta. Fail-closed:
 * manjkajoča/neveljavna produkcijska konfiguracija → false (ruta vrne 503),
 * v dev/test runtimeu pa ostaja privzeta simulacija (obstoječe vedenje).
 */
export function payLinkSimulationAllowed(
  locationEnv: string | null | undefined,
  env: PayLinkSettlementEnv = process.env,
): boolean {
  try {
    return resolveFiscalProfile({
      globalEnv: env.FURS_ENVIRONMENT,
      locationEnv,
      allowSimulation: env.FURS_ALLOW_SIMULATION,
      productionTestMode: env.FURS_PRODUCTION_TEST_MODE,
      nodeEnv: env.NODE_ENV,
    }).simulation
  } catch (e) {
    if (e instanceof FiscalConfigError) return false
    throw e
  }
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
  /** Issue #37: vezava seje na KONKRETEN PayLink/naročilo/lokacijo (server-side
   *  metadata + client_reference_id — klient jih ne more ponarediti). */
  payLinkId: string
  orderId: string
  locationId: string
}

export interface StripeCheckoutResult {
  sessionId: string
  url: string
}

/**
 * Ustvari Stripe Checkout sejo (znesek ZAKLEPAN na seji — napitnina vključena).
 * Issue #37: seja se nujno zaveže na konkretne PayLink/Order/Location prek
 * metadata (verifikacija jih strežniško preverja) + client_reference_id;
 * Idempotency-Key je vezan na (povezava, znesek) — ponovljen klic z istim
 * zneskom vrne ISTO sejo, spremenjena napitnina (nov znesek) pa nov ključ.
 */
export async function stripeCreateCheckout(args: StripeCheckoutArgs): Promise<StripeCheckoutResult> {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': args.currency,
    'line_items[0][price_data][unit_amount]': String(Math.round(args.amountCents)),
    'line_items[0][price_data][product_data][name]': args.description.slice(0, 100),
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.payLinkId,
    'metadata[payLinkId]': args.payLinkId,
    'metadata[orderId]': args.orderId,
    'metadata[locationId]': args.locationId,
    'metadata[expectedAmountCents]': String(Math.round(args.amountCents)),
    'metadata[currency]': args.currency,
  })
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `paylink-${args.payLinkId}-${Math.round(args.amountCents)}`,
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
  /** Stripe ID seje (echo — primerjava s pričakovano). */
  id: string | null
  paid: boolean
  paymentIntent: string | null
  amountTotalCents: number | null
  currency: string | null
  /** Stripe session.status: open | complete | expired. */
  sessionStatus: string | null
  /** 'payment' za Checkout enkratno plačilo. */
  mode: string | null
  /** server-side metadata (mi jih postavimo ob ustvarjanju — klient ne more ponarediti). */
  metadata: Record<string, string> | null
  clientReferenceId: string | null
  /** URL plačilne strani (samo dokler je seja odprta). */
  url: string | null
}

interface StripeSessionRaw {
  id?: string
  status?: string
  mode?: string
  payment_status?: string
  payment_intent?: string | null
  amount_total?: number | null
  currency?: string | null
  metadata?: Record<string, string> | null
  client_reference_id?: string | null
  url?: string | null
}

/**
 * Preveri sejo (server-to-server — avtoriteta je Stripe, ne client).
 * Issue #37: vrača CELO preverjeno stanje (id/payment_status/amount_total/
 * currency/mode/metadata/client_reference_id/status) — payment_intent →
 * approvalCode (sledljivost kot terminalski SIM- kodi).
 */
export async function stripeSessionStatus(secretKey: string, sessionId: string): Promise<StripeSessionStatus> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  })
  if (!res.ok) throw new Error(`Stripe session ${res.status}`)
  const data = (await res.json()) as StripeSessionRaw
  return {
    id: typeof data.id === 'string' ? data.id : null,
    paid: data.payment_status === 'paid',
    paymentIntent: data.payment_intent || null,
    amountTotalCents: typeof data.amount_total === 'number' ? data.amount_total : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
    sessionStatus: typeof data.status === 'string' ? data.status : null,
    mode: typeof data.mode === 'string' ? data.mode : null,
    metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : null,
    clientReferenceId: typeof data.client_reference_id === 'string' ? data.client_reference_id : null,
    url: typeof data.url === 'string' ? data.url : null,
  }
}

/**
 * Issue #37: zapri (expire) sejo — najboljši poskus (fail-soft). Uporabi se ob
 * zamenjavi kanonične seje (spremenjena napitnina) in ob izgubljenem CAS
 * (sočasna ustvarjanja: izgubljenikova seja se zapre, ostane plačljiva SAMO
 * kanonična). Napaka se tiho pogoltne (že zajet denar bi reševal webhook/rok —
 * izven obsega; kanonična verifikacija ostaja edina pot poravnave).
 */
export async function stripeExpireSession(secretKey: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secretKey}` },
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------- skupni predogled računa (break-glass klic kanonične bill rute) ----------

/**
 * P1-6 (v1.87.0): loadBill iz javne pay rute povzdignjen v core — deleže
 * izračunava TUDI osebje (POST /api/orders/[id]/paylink). 0 duplikata
 * izračuna: vedno kanonični computeBill prek GET /api/orders/[id]/bill.
 */
export async function loadOrderBill(orderId: string): Promise<{ totalDue: number; bill: Record<string, unknown> } | null> {
  const token = createToken({ sub: 'bootstrap', name: 'Plačilna povezava', role: 'ADMIN', loc: null, sv: 0 }, 2 / 60)
  const req = new NextRequest(`http://127.0.0.1:3000/api/orders/${orderId}/bill`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const res = await billGET(req, { params: Promise.resolve({ id: orderId }) })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { bill?: { totalDue?: number } } | null
  if (!data?.bill || typeof data.bill.totalDue !== 'number') return null
  return { totalDue: r2(data.bill.totalDue), bill: data.bill as Record<string, unknown> }
}

// ---------- finalize: plačilo SKOZI kanonično FURS jedro ----------

export interface FinalizePayLinkPart {
  type: string
  amount: number
  approvalCode: string
}

export type FinalizePayLinkResult =
  | { ok: true; replayed: boolean; invoice: Record<string, unknown>; receiptId: string | null }
  | { ok: false; status: number; error: string }

/** break-glass žeton za EN kanonični klic (sub='bootstrap', 2 min, procesno-lokalen). */
function payLinkCoreToken(): string {
  return createToken(
    { sub: 'bootstrap', name: 'Plačilna povezava', role: 'ADMIN', loc: null, sv: 0 },
    2 / 60,
  )
}

/** Skupni klic issueFursReceipt prek sintetične POST /api/furs zahteve. */
async function postFursCore(
  orderId: string,
  parts: FinalizePayLinkPart[],
  tip: number,
  clientOperationId: string,
  ip?: string | null,
): Promise<FinalizePayLinkResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${payLinkCoreToken()}`,
    'content-type': 'application/json',
  }
  if (ip) headers['x-forwarded-for'] = ip
  const req = new NextRequest('http://127.0.0.1:3000/api/furs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      orderId,
      parts: parts.map((p) => ({ type: p.type, amount: r2(p.amount), terminal: { approvalCode: p.approvalCode } })),
      tip: r2(tip),
      clientOperationId,
    }),
  })
  const res = await issueFursReceipt(req)
  const data = (await res.json().catch(() => null)) as { invoice?: Record<string, unknown>; replayed?: boolean; error?: string } | null
  if (!res.ok || !data?.invoice) {
    return { ok: false, status: res.status, error: data?.error || `Plačilo ni uspelo (${res.status}).` }
  }
  const receiptId = String(data.invoice['id'] || '') || null
  return { ok: true, replayed: data.replayed === true, invoice: data.invoice, receiptId }
}

/**
 * P1-6: DOKONČANJE NIZA deležev — zadnji gost je plačal svoj delež, odprtih
 * povezav ni več → izda KONČNI račun prek kanoničnega FURS jedra:
 * parts: [] (ročnih delov ni) + jedro SAMO prišteje plačane deleže povezav
 * (status='paid', receiptId null → glej issue.ts P1-6 blok) + njihove
 * napitnine. clientOperationId = 'plkset:<orderId>' (stabilen po naročilu —
 * dvojni klik/refresh/obnova GET vrača ISTI račun, replayed).
 * Po uspehu se receiptId zapiše na VSE plačane povezave niza (idempotentno).
 */
export async function finalizePayLinkSet(orderId: string, ip?: string | null): Promise<FinalizePayLinkResult> {
  const result = await postFursCore(orderId, [], 0, `plkset:${orderId}`, ip)
  if (!result.ok) return result
  if (result.receiptId) {
    await db.payLink
      .updateMany({ where: { orderId, status: 'paid', receiptId: null }, data: { receiptId: result.receiptId } })
      .catch(() => {})
  }
  return result
}

// ---------- capability probe (v1.85.1 — haccp-plans vzorec) ----------

/**
 * Ali je PayLink shema PRIPRAVLJENA (v1.87.0: tabela + P1-6 split stolpci;
 * v1.98.0: še sessionId — kanonična Stripe Checkout seja, issue #37). 60 s TTL —
 * produkcijska PayLink ruta med čakanjem na DDL vrača 503 s prijaznim sporočilom
 * namesto 500. NAMERNO prazen catch (javna gostova ruta — prijazno 503 tudi pri
 * infra napaki).
 */
let payLinkProbeCache: { ok: boolean; at: number } | null = null

export async function payLinkReady(): Promise<boolean> {
  if (payLinkProbeCache && Date.now() - payLinkProbeCache.at < 60_000) return payLinkProbeCache.ok
  try {
    await db.$queryRawUnsafe('SELECT "splitIndex", "approvalCode", "sessionId" FROM "PayLink" LIMIT 1')
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
