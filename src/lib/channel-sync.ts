/**
 * Issue #9 (P2, v1.119.0) — adapter contract za sinhronizacijo razpoložljivosti
 * artiklov (86-plošča) na ZUNANJE kanale (agregatorji dostave / marketplace).
 *
 * PRAVILA (po dizajnu 9-design):
 *  - 0 NOVIH tabel: stanje sinhronizacije živi v OBSTOJEČI Integration vrstici
 *    (lastSyncAt/lastSyncStatus/lastSyncError — syncEnabled/syncInterval že
 *    obstajata) + IntegrationLog (direction 'outbound') — diagnostika vidna v
 *    obstoječem Integrations zavihku, ne v novi shemi.
 *  - Brez potrjenega produkcijskega ponudnika je izhodni push BLOKIRAN: v registru
 *    je (izključno) MOCK adapter za teste. Register je namenska ključavnica —
 *    integracija s providerjem, ki ni registriran, NE more naključno pošiljati
 *    zunaj (syncAvailabilityToChannel vrne blocked in zapiše FAILED audit).
 *  - Produkcija čaka lastnikovo potrditev ponudnika + skrivnosti (API ključi v
 *    Integration, nikoli v source-u) — nov adapter se registrira s
 *    registerChannelAdapter() v prihodnjem valu.
 *  - Neuspeh NIKOLI tiho: vsak poskus (uspeh, napaka adapterja, blokada) posodobi
 *    Integration.lastSync* + zapiše IntegrationLog + audit CHANNEL_SYNC_OK /
 *    CHANNEL_SYNC_FAILED. Funkcija NE meče napak — vedno vrne outcome.
 */
import { db } from '@/lib/db'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/* ───── Contract ───── */

export interface ChannelAvailabilityItem { id: string; isAvailable: boolean; price: number }
export interface ChannelSyncOutcome { ok: boolean; syncedAt: Date; detail: string; statusCode?: number }
export interface ChannelAvailabilityAdapter {
  key: string                        // 'mock' | prihodnje 'glovo'|'wolt'|...
  push(items: ChannelAvailabilityItem[]): Promise<ChannelSyncOutcome>
}

/** Dodatna blokada izhoda (register ključavnica) — ok:false brez omrežnega klica. */
export type ChannelSyncBlocked = 'no-adapter-registered' | 'integration-not-found'

export type ChannelSyncResult = ChannelSyncOutcome & { blocked?: ChannelSyncBlocked }

/* ───── Register (ključavnica proti naključni aktivaciji) ───── */

const adapters = new Map<string, ChannelAvailabilityAdapter>()

/** Registrira adapter pod njegovim ključem (ključi so case-insensitive). */
export function registerChannelAdapter(a: ChannelAvailabilityAdapter): void {
  if (!a || typeof a.key !== 'string' || !a.key.trim()) return
  adapters.set(a.key.trim().toLowerCase(), a)
}

/** Adapter za ključ ali null (neznan/neregistriran kanal = push blokiran). */
export function getChannelAdapter(key: string): ChannelAvailabilityAdapter | null {
  const k = typeof key === 'string' ? key.trim().toLowerCase() : ''
  return k ? (adapters.get(k) ?? null) : null
}

/**
 * MOCK adapter (SAMO testni): nikoli NE kliče pravega omrežja (0 fetch klicev),
 * vedno uspe. Produkcija čaka lastnikovo potrditev ponudnika + skrivnosti.
 */
const mockChannelAdapter: ChannelAvailabilityAdapter = {
  key: 'mock',
  async push(_items: ChannelAvailabilityItem[]): Promise<ChannelSyncOutcome> {
    return { ok: true, syncedAt: new Date(), detail: 'mock — 0 artiklov poslanih zunaj', statusCode: 200 }
  },
}
registerChannelAdapter(mockChannelAdapter)

/* ───── Sinhronizacija (edini vstop za izhodni push) ───── */

/** Integracijski ključ kanala: provider (lowercase), sicer name. */
function channelKeyOf(integration: { provider: string; name: string }): string {
  return String(integration.provider || integration.name || '').trim().toLowerCase()
}

/**
 * Potisne razpoložljivost artiklov na kanal dane integracije:
 *  1. adapter = getChannelAdapter(provider) — ni ga → BLOKIRANO (ok:false,
 *     blocked 'no-adapter-registered', status 'blocked', audit FAILED);
 *  2. sicer adapter.push(items) (napake adapterja ujete → outcome error);
 *  3. VEDNO posodobi Integration (lastSyncAt, lastSyncStatus 'ok'|'error',
 *     lastSyncError) + IntegrationLog (outbound 'availability-push') +
 *     audit CHANNEL_SYNC_OK/CHANNEL_SYNC_FAILED.
 * Ne meče napak — vrne outcome (blocked oz. push rezultat).
 */
export async function syncAvailabilityToChannel(
  integrationId: string,
  items: ChannelAvailabilityItem[],
): Promise<ChannelSyncResult> {
  const t0 = Date.now()
  const integration = await db.integration.findUnique({ where: { id: integrationId } }).catch(() => null)
  if (!integration) {
    return {
      ok: false,
      syncedAt: new Date(),
      detail: `Integracija "${integrationId}" ne obstaja — sinhronizacija ni izvedena.`,
      blocked: 'integration-not-found',
    }
  }

  const key = channelKeyOf(integration)
  const adapter = getChannelAdapter(key)

  // BLOKIRANO — register ključavnica: neznan/nepotrjen kanal NE sme pošiljati zunaj.
  if (!adapter) {
    const detail = `Adapter za kanal "${key}" ni registriran — izhodni push blokiran (ni potrjenega produkcijskega ponudnika).`
    await db.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date(), lastSyncStatus: 'blocked', lastSyncError: detail.slice(0, 500) },
    }).catch(() => null)
    await db.integrationLog.create({
      data: {
        id: nid(),
        integrationId: integration.id,
        action: 'availability-push',
        direction: 'outbound',
        status: 'blocked',
        statusCode: 0,
        errorMessage: detail.slice(0, 500),
        durationMs: Date.now() - t0,
        requestData: jstr(items ?? []).slice(0, 2000),
        responseData: detail.slice(0, 500),
      },
    }).catch(() => null)
    await writeAudit(db, {
      userId: 'system',
      action: 'CHANNEL_SYNC_FAILED',
      entityType: 'Integration',
      entityId: integration.id,
      details: jstr({ provider: key, blocked: 'no-adapter-registered', items: Array.isArray(items) ? items.length : 0 }),
      locationId: integration.locationId ?? null,
    }).catch(() => null)
    return { ok: false, syncedAt: new Date(), detail, statusCode: 0, blocked: 'no-adapter-registered' }
  }

  // Push (napake adapterja ujamemo — funkcija NE meče)
  let outcome: ChannelSyncOutcome
  try {
    outcome = await adapter.push(Array.isArray(items) ? items : [])
  } catch (e) {
    outcome = {
      ok: false,
      syncedAt: new Date(),
      detail: e instanceof Error ? e.message : 'Neznana napaka adapterja kanala.',
      statusCode: 500,
    }
  }

  // VEDNO zapiši stanje (uspeh IN napaka — nikoli tiho)
  await db.integration.update({
    where: { id: integration.id },
    data: {
      lastSyncAt: outcome.syncedAt,
      lastSyncStatus: outcome.ok ? 'ok' : 'error',
      lastSyncError: outcome.ok ? '' : outcome.detail.slice(0, 500),
    },
  }).catch(() => null)
  await db.integrationLog.create({
    data: {
      id: nid(),
      integrationId: integration.id,
      action: 'availability-push',
      direction: 'outbound',
      status: outcome.ok ? 'ok' : 'error',
      statusCode: typeof outcome.statusCode === 'number' ? outcome.statusCode : 0,
      errorMessage: outcome.ok ? '' : outcome.detail.slice(0, 500),
      durationMs: Date.now() - t0,
      requestData: jstr(items ?? []).slice(0, 2000),
      responseData: outcome.detail.slice(0, 500),
    },
  }).catch(() => null)
  await writeAudit(db, {
    userId: 'system',
    action: outcome.ok ? 'CHANNEL_SYNC_OK' : 'CHANNEL_SYNC_FAILED',
    entityType: 'Integration',
    entityId: integration.id,
    details: jstr({ provider: key, ok: outcome.ok, items: Array.isArray(items) ? items.length : 0, detail: outcome.detail.slice(0, 200) }),
    locationId: integration.locationId ?? null,
  }).catch(() => null)

  return outcome
}
