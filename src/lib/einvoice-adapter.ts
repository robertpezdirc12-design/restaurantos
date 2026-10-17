/**
 * Issue #4 (P1, v1.125.0) — transportni adapter za ODHODNE B2B e-račune.
 *
 * Vzorec src/lib/channel-sync.ts (#9): register + ključavnica — integracija s
 * ponudnikom, ki NI registriran, NE more pošiljati zunaj (resolveEInvoiceProvider
 * vrne blocked in send/retry ruti odgovorita 409 z razlogom; NIKOLI ne lažemo,
 * da je bilo poslano).
 *
 * MOCK adapter je registriran VEDNO (testi/CI — 0 omrežnih klicev, 0 pravih
 * poverilnic): externalRef = 'mock-' + sha256(idempotencyKey).slice(0,12);
 * obnašanje prek neobveznega config parametra { simulate }:
 *  - 'deliver' (privzeto): send uspe → status 'sent' (prejem/delivered pride
 *    prek webhooka /api/einvoices/webhook/mock — pravilen življenjski cikel);
 *  - 'reject': send uspe (dokument prevzet) → poznejši webhook zavrnitve;
 *  - 'timeout': { ok:false, error:'timeout' } → status 'failed'.
 *
 * Produkcija čaka lastnikovo izbiro ponudnika e-poti / PEPPOL dostopne točke /
 * neposredne izmenjave (docs/E-INVOICES-SI-HR.md §3 — primerjalna tabela; izbira
 * je LASTNIKOVA, mi ne izbiramo plačljive storitve in NE izmišljujemo poverilnic).
 */
import { createHash } from 'crypto'
import { db } from '@/lib/db'

/* ─────────────── contract ─────────────── */

export interface EInvoiceSendInput {
  idempotencyKey: string
  xml: string
  receiverTaxId: string
  profile: string
}

export interface EInvoiceSendResult {
  ok: boolean
  /** zunanja referenca dokumenta pri ponudniku (retry/probe/webhook ključ) */
  externalRef?: string
  error?: string
}

export interface EInvoiceProbeResult {
  /** status pri ponudniku (ena iz EINVOICE_STATUSES) ali null, če neznan */
  status?: string
  reason?: string
}

export interface EInvoiceTransportAdapter {
  key: string
  send(input: EInvoiceSendInput, config?: EInvoiceMockConfig): Promise<EInvoiceSendResult>
  probeStatus(externalRef: string, config?: EInvoiceMockConfig): Promise<EInvoiceProbeResult>
}

/** Neobvezna konfiguracija mock obnašanja (Integration.config JSON ali testni). */
export interface EInvoiceMockConfig {
  simulate?: 'deliver' | 'reject' | 'timeout'
}

/* ─────────────── register (ključavnica proti naključni aktivaciji) ─────────────── */

const adapters = new Map<string, EInvoiceTransportAdapter>()

export function registerEInvoiceAdapter(a: EInvoiceTransportAdapter): void {
  if (!a || typeof a.key !== 'string' || !a.key.trim()) return
  adapters.set(a.key.trim().toLowerCase(), a)
}

export function getEInvoiceAdapter(key: string): EInvoiceTransportAdapter | null {
  const k = typeof key === 'string' ? key.trim().toLowerCase() : ''
  return k ? (adapters.get(k) ?? null) : null
}

/* ─────────────── MOCK adapter (vedno registriran; 0 omrežja) ─────────────── */

function mockExternalRef(idempotencyKey: string): string {
  return 'mock-' + createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 12)
}

const mockEInvoiceAdapter: EInvoiceTransportAdapter = {
  key: 'mock',
  async send(input, config) {
    const simulate = config?.simulate ?? 'deliver'
    if (simulate === 'timeout') {
      return { ok: false, error: 'timeout' }
    }
    // deliver | reject: dokument je prevzet (externalRef); nadaljnji status
    // prihaja prek webhooka (delivered/rejected) — pravilen življenjski cikel
    return { ok: true, externalRef: mockExternalRef(input.idempotencyKey) }
  },
  async probeStatus(externalRef) {
    if (!externalRef) return { status: undefined, reason: 'manjka zunanja referenca' }
    // mock: dokument z externalRef obstaja (poslan) — status ostaja pri pošiljatelju
    return { status: 'sent' }
  },
}
registerEInvoiceAdapter(mockEInvoiceAdapter)

/* ─────────────── integracijska izpeljava (provider) ─────────────── */

export interface EInvoiceProviderResolution {
  /** adapter je na voljo (registriran + aktivna integracija) */
  ok: boolean
  provider?: string
  integrationId?: string
  adapter?: EInvoiceTransportAdapter
  config?: EInvoiceMockConfig
  blocked?: boolean
  reason?: string
}

/**
 * Poišče ponudnika e-računov: Integration (type 'einvoice', isActive) →
 * provider ključ → adapter iz registra. Prednost ima integracija uporabnikove
 * lokacije, nato nevezana (locationId null), nato katera koli aktivna.
 * Neregistriran/nedelujoč → BLOKIRANO (ključavnica #9 vzorec — NIKOLI ne
 * lažemo, da je poslano).
 */
export async function resolveEInvoiceProvider(locationId?: string | null): Promise<EInvoiceProviderResolution> {
  const integrations = await db.integration
    .findMany({
      where: { type: 'einvoice', isActive: true },
      select: { id: true, provider: true, config: true, locationId: true },
    })
    .catch(() => null)

  const integration =
    (integrations || []).find((i) => locationId && i.locationId === locationId) ??
    (integrations || []).find((i) => !i.locationId) ??
    (integrations || [])[0]

  if (!integration) {
    return {
      ok: false,
      blocked: true,
      reason: 'Integracija za e-račune (type "einvoice") ni nastavljena ali ni aktivna — pošiljanje je blokirano do lastnikove izbire ponudnika e-poti.',
    }
  }

  const key = String(integration.provider || '').trim().toLowerCase()
  const adapter = getEInvoiceAdapter(key)
  if (!adapter) {
    return {
      ok: false,
      blocked: true,
      provider: key,
      integrationId: integration.id,
      reason: `Adapter za ponudnika "${key}" ni registriran — izhodni tok e-računov je blokiran (0 naključnih pošiljanj zunaj; produkcija čaka potrditev ponudnika).`,
    }
  }

  let config: EInvoiceMockConfig | undefined
  try {
    // config je v sqlite String, v postgres Json — oboje toleriramo (samo string je veljaven JSON vir)
    const parsed = JSON.parse(typeof integration.config === 'string' ? integration.config : '{}') as Record<string, unknown>
    if (parsed && typeof parsed.simulate === 'string' && ['deliver', 'reject', 'timeout'].includes(parsed.simulate)) {
      config = { simulate: parsed.simulate as 'deliver' | 'reject' | 'timeout' }
    }
  } catch {
    // tolerance: neveljaven config JSON → privzeto obnašanje
  }

  return { ok: true, provider: key, integrationId: integration.id, adapter, config }
}

/** Secret za webhook e-računov: Integration.apiSecret (provider) ali env. */
export async function getEInvoiceWebhookSecret(provider: string): Promise<string> {
  const integration = await db.integration
    .findFirst({
      where: { provider },
      select: { apiSecret: true },
    })
    .catch(() => null)
  if (integration?.apiSecret) return integration.apiSecret
  return process.env.EINVOICE_WEBHOOK_SECRET || ''
}
