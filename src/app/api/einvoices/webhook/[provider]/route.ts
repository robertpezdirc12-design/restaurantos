import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { rateLimit, verifyWebhookSignature } from '@/lib/delivery'
import { EINVOICE_STATUSES, resolveStatusPath, EINVOICE_TERMINAL } from '@/lib/einvoice-lifecycle'
import { getEInvoiceWebhookSecret } from '@/lib/einvoice-adapter'

/**
 * Issue #4 (P1, v1.125.0) — webhook statusov izmenjave e-računov (BREZ seje — HMAC).
 *
 * POST /api/einvoices/webhook/[provider]  (provider ∈ {'mock','sandbox'} — neznano 404)
 *
 * Varnost (vzorec delivery webhook, issue #2):
 *  - rate limit ( isti helper — 30/min po provider+IP);
 *  - telo ≤ 64 KB → 413 (preverba content-length GLAVE pred branjem + dejanska dolžina);
 *  - podpis x-einvoice-signature (HMAC-SHA256, hex, timingSafeEqual) PREJ kot
 *    katera koli obravnava vsebine — podpis neveljaven → 401 (brez razkritja);
 *  - secret = Integration (type 'einvoice', provider) apiSecret ali env
 *    EINVOICE_WEBHOOK_SECRET; brez secreta endpoint NE deluje (503 — skrivnost
 *    ni v source);
 *  - eventId dedup prek processedEvents (zadnjih 50) — ponovljen webhook NE
 *    povzroči drugega prehoda (200 {duplicate:true});
 *  - neznan externalRef → 404 BREZ razkritja (ključ ni poverilnica);
 *  - statusni prehod: forward-only (terminala NIKOLI nazaj — accepted + webhook
 *    rejected → ignored, brez regresije); no-op → 200 {ignored:true, status}.
 *
 * Audit: EINVOICE_STATUS origin 'webhook' correlationId=eventId (veriga).
 * IntegrationLog zapis + Integration.lastSync* posodobitev (vidno v Dnevniku).
 */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROVIDERS = new Set(['mock', 'sandbox'])
const MAX_BODY_BYTES = 64 * 1024 // 64 KB — statusni dogodki so majhni

interface WebhookPayload {
  eventId: string
  externalRef: string
  status: string
  reason?: string
  occurredAt?: string
}

async function logIntegration(
  provider: string, integrationId: string | null, status: 'ok' | 'error' | 'skipped',
  statusCode: number, errorMessage: string, durationMs: number, requestData: unknown,
) {
  if (!integrationId) return
  await db.integrationLog.create({
    data: {
      id: nid(),
      integrationId,
      action: 'einvoice-webhook',
      direction: 'inbound',
      status,
      statusCode,
      errorMessage: errorMessage.slice(0, 500),
      durationMs,
      requestData: jstr(requestData).slice(0, 2000),
      responseData: '{}',
    },
  }).catch(() => null)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const t0 = Date.now()
  const { provider } = await params
  const p = provider?.toLowerCase() ?? ''
  if (!PROVIDERS.has(p)) return fail('Neznan ponudnik izmenjave e-računov.', 404)

  // Rate limiting (javni endpoint — isti helper kot dostavni webhook)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!(await rateLimit(`einvoice:${p}:${ip}`))) {
    return fail('Preveč zahtev — rate limit.', 429)
  }

  // Velikost telesa: GLAVA prej (brez branja), nato dejanska dolžina
  const declaredLength = parseInt(req.headers.get('content-length') || '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return fail('Telo zahteve je preveliko (največ 64 KB).', 413)
  }
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return fail('Telo zahteve je preveliko (največ 64 KB).', 413)
  }

  // Secret: Integration (provider) ali env — brez njega endpoint NE deluje
  const integration = await db.integration.findFirst({
    where: { provider: p, type: 'einvoice' },
    select: { id: true, isActive: true },
  }).catch(() => null)
  const integrationId = integration?.id ?? null
  const secret = await getEInvoiceWebhookSecret(p)
  if (!secret) {
    await logIntegration(p, integrationId, 'skipped', 503, 'Webhook secret ni nastavljen (Integration.apiSecret ali EINVOICE_WEBHOOK_SECRET).', Date.now() - t0, null)
    return fail('Integracija izmenjave e-računov ni konfigurirana.', 503)
  }

  // Podpis PREJ kot katera koli obravnava vsebine (raw body!)
  const sigHeader = req.headers.get('x-einvoice-signature')
  if (!verifyWebhookSignature(raw, sigHeader, secret)) {
    await logIntegration(p, integrationId, 'error', 401, 'Neveljaven/manjkajoč podpis.', Date.now() - t0, null)
    return fail('Neveljaven podpis.', 401)
  }

  // JSON + oblika payloada (po preverbi podpisa — vsebina je avtenticirana)
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    await logIntegration(p, integrationId, 'error', 400, 'Payload ni veljaven JSON.', Date.now() - t0, null)
    return fail('Payload ni veljaven JSON.', 400)
  }

  const eventId = String(body.eventId ?? '').trim().slice(0, 128)
  const externalRef = String(body.externalRef ?? '').trim().slice(0, 64)
  const status = String(body.status ?? '').trim().toLowerCase()
  const reason = String(body.reason ?? '').trim().slice(0, 200)
  const occurredAtRaw = String(body.occurredAt ?? '').trim()

  if (!eventId) return fail('Manjka eventId dogodka.', 400)
  if (!externalRef) return fail('Manjka externalRef e-računa.', 400)
  if (!EINVOICE_STATUSES.includes(status as never)) {
    await logIntegration(p, integrationId, 'error', 400, `Neveljaven status: ${status || '(prazen)'}.`, Date.now() - t0, { eventId })
    return fail(`Neveljaven status izmenjave: ${status || '(prazen)'}.`, 400)
  }
  if (occurredAtRaw && isNaN(new Date(occurredAtRaw).getTime())) {
    return fail('Neveljaven occurredAt (pričakovan ISO datum).', 400)
  }

  // Zunanja referenca NI poverilnica — neznan dokument → 404 brez razkritja
  const outbox = await db.eInvoiceOutbox.findFirst({
    where: { externalRef },
    select: { id: true, status: true, invoiceNumber: true, processedEvents: true, locationId: true, lastReason: true },
  })
  if (!outbox) {
    await logIntegration(p, integrationId, 'error', 404, 'Neznana zunanja referenca.', Date.now() - t0, { eventId, externalRef })
    return fail('E-račun s to zunanjo referenco ne obstaja.', 404)
  }

  // eventId dedup (processedEvents — zadnjih 50): ponovljen webhook = EN prehod
  let processed: string[] = []
  try {
    const parsedEvents = JSON.parse(outbox.processedEvents || '[]') as unknown
    if (Array.isArray(parsedEvents)) processed = parsedEvents.filter((e) => typeof e === 'string').slice(-50)
  } catch {
    processed = []
  }
  if (processed.includes(eventId)) {
    await logIntegration(p, integrationId, 'ok', 200, '', Date.now() - t0, { eventId, duplicate: true })
    return ok({ duplicate: true, status: outbox.status })
  }

  // Statusni prehod: forward-only; terminal NIKOLI nazaj; no-op → ignored
  if (outbox.status === status) {
    processed.push(eventId)
    await db.eInvoiceOutbox.update({
      where: { id: outbox.id },
      data: { processedEvents: jstr(processed.slice(-50)) },
    }).catch(() => null)
    await logIntegration(p, integrationId, 'ok', 200, '', Date.now() - t0, { eventId, ignored: true })
    return ok({ ignored: true, status: outbox.status })
  }
  const path = resolveStatusPath(outbox.status, status)
  if (!path || EINVOICE_TERMINAL.includes(outbox.status as never)) {
    // terminal brez regresije (accepted + rejected webhook → ignored) ali
    // nedosegljiv status → dogodke vseeno dedupliciramo (brez prehoda)
    processed.push(eventId)
    await db.eInvoiceOutbox.update({
      where: { id: outbox.id },
      data: { processedEvents: jstr(processed.slice(-50)) },
    }).catch(() => null)
    await logIntegration(p, integrationId, 'ok', 200, `Prehod ${outbox.status} → ${status} ni dovoljen (ignoriran).`, Date.now() - t0, { eventId })
    return ok({ ignored: true, status: outbox.status, note: `Prehod statusa ${outbox.status} → ${status} ni dovoljen — dogodek je zabeležen, status ni spremenjen.` })
  }

  // VELJAVEN prehod → posodobi status + razlog + dedup seznam
  processed.push(eventId)
  const now = new Date()
  await db.eInvoiceOutbox.update({
    where: { id: outbox.id },
    data: {
      status,
      lastReason: reason,
      processedEvents: jstr(processed.slice(-50)),
      ...(status === 'sent' ? { sentAt: now } : {}),
      ...(status === 'delivered' || status === 'accepted' || status === 'rejected' ? { lastAttemptAt: now } : {}),
    },
  })
  await writeAudit(db, {
    userId: 'system',
    action: 'EINVOICE_STATUS',
    entityType: 'EInvoiceOutbox',
    entityId: outbox.id,
    details: jstr({
      from: outbox.status, to: status, path,
      origin: 'webhook', provider: p, correlationId: eventId,
      externalRef, reason: reason.slice(0, 200), occurredAt: occurredAtRaw || undefined,
    }),
    locationId: outbox.locationId,
  })
  if (integrationId) {
    await db.integration.update({
      where: { id: integrationId },
      data: { lastSyncAt: now, lastSyncStatus: 'ok', lastSyncError: '' },
    }).catch(() => null)
  }
  await logIntegration(p, integrationId, 'ok', 200, '', Date.now() - t0, { eventId, externalRef, status })
  return ok({ received: true, status })
}

/** Health/verify hook za ponudnike (ne spremeni ničesar). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (!PROVIDERS.has(provider?.toLowerCase() ?? '')) return fail('Neznan ponudnik izmenjave e-računov.', 404)
  return ok({ ok: true, provider: provider.toLowerCase(), webhook: 'ready' })
}
