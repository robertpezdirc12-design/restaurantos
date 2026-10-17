import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jparse, jstr, nid } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { guardIntegration } from '@/lib/tenant'
import { ssrfSafeRequest, ssrfErrorText, validateTargetUrl } from '@/lib/ssrf-guard'

/**
 * Task 60 (audit §7 Integracije PARTIAL→DONE) — test povezave.
 * POST /api/integrations/[id]/test — poskuša doseči baseUrl (GET, 5 s timeout),
 * rezultat zapiše v connectionStatus/lastSync* + IntegrationLog + audit
 * INTEGRATION_TESTED. Vsak HTTP odgovor (tudi 4xx/5xx/3xx) = »dosegljiv«;
 * omrežna napaka/DNS = »prekinjeno«.
 *
 * Issue #30 (P0) — POPOLNA SSRF zaščita (nadomesti delni isPrivateHost):
 *  - URL politika: https (http le izven produkcije), brez userinfo, porti
 *    80/443/8443, izčrpen IPv4/IPv6 literal filter (vgrajeni IPv4 vključno);
 *  - DNS: VSI A/AAAA rezultati validirani (mešani/zasebni zapisi → zavrnitev);
 *    povezava se VZEZE na preverjeni IP (Host/SNI ohranita ime) → DNS
 *    rebinding/TOCTOU med preverbo in povezavo NI mogoč;
 *  - preusmeritve: NE sledijo (redirect:'follow' odstranjen) — 3xx je rezultat,
 *    ki ga uporabnik pregleda; credential glave se ne prenesejo naprej;
 *  - credential politika (§B): shranjeni apiKey/apiSecret se na testni klic
 *    pošljejo SAMO ob izrecnem opt-in config.sendCredentialsOnTest === true
 *    IN izključno na https cilj (glej credentialHeadersFor); znani ponudniki
 *    (Stripe/Twilio) imajo fiksne adaptere s svojimi gostitelji — generični
 *    test ne pošilja univerzalnih Bearer glav na poljuben baseUrl;
 *  - higiiena logov (§B): IntegrationLog/audit/odgovor vsebujejo SAMO varni
 *    hostname + shemo + status + trajanje + kategorijo napake — brez query
 *    stringa, brez Authorization glav, brez surovih omrežnih sporočil.
 *
 * Issue #42: test po znanem ID-ju nosi ISTI tenant/lokacijski pravilnik kot
 * seznam/PATCH/DELETE (guardResource) — credential headerje (apiKey/apiSecret)
 * strežnik pošlje cilju ŠELE, ko je vir v uporabnikovem obsegu in je cilj
 * prestal SSRF varovalo.
 */

interface TestableIntegration {
  baseUrl: string
  apiKey: string
  apiSecret: string
  /**
   * `Integration.config` je na Postgresu `Json` (Prisma vrne ŽE razčlenjen
   * objekt), na SQLite pa `String`. `jparse` obvlada obe oblike, zato tip ne
   * sme trditi `string` — sicer produkcijski `tsc` ne prevede vrstice naprej.
   */
  config: unknown
}

/**
 * Issue #30 §B — credential glave za testni klic: PRIVZETO PRAZNO.
 * Pošlje se SAMO ob izrecnem opt-in (config.sendCredentialsOnTest === true)
 * IN izključno na https cilj. Izvoženo za enotske teste.
 */
export function credentialHeadersFor(row: TestableIntegration, url: URL): Record<string, string> {
  const cfg = jparse<Record<string, unknown>>(row.config, {})
  const optIn = cfg?.sendCredentialsOnTest === true
  if (!optIn || url.protocol !== 'https:') return {}
  const h: Record<string, string> = {}
  if (row.apiKey) h['authorization'] = `Bearer ${row.apiKey}`
  if (row.apiSecret) h['x-api-secret'] = row.apiSecret
  return h
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const row = await db.integration.findUnique({ where: { id } })
  if (!row) return fail('Povezava ne obstaja.', 404)
  // #42: obseg vira PRED testnim klicem — tujih integracij ne smemo niti testirati
  // (test pošlje shranjene credential headerje na baseUrl — najprej pooblastilo)
  const guard = await guardIntegration(user, row.locationId)
  if (guard) return guard

  // #30: URL politika PRED katerim koli klicem (razlog se vrne uporabniku)
  const v = validateTargetUrl(row.baseUrl)
  if (!v.ok) return fail(v.reason, 400)
  const url = v.url

  // #30 §B: credential glave (privzeto izpuste; opt-in + https)
  const headers: Record<string, string> = {
    accept: 'application/json, */*',
    ...credentialHeadersFor(row, url),
  }

  // #30: DNS-pinned klic brez sledenja preusmeritvam
  const res = await ssrfSafeRequest(row.baseUrl, { method: 'GET', headers, timeoutMs: 5000 })
  const reachable = res.status > 0
  const statusCode = res.status
  const durationMs = res.durationMs
  // varna kategorija napake (brez surovih sporočil z URL-ji/glavami)
  const errorMessage = reachable
    ? res.errorCategory
      ? ssrfErrorText(res.errorCategory)
      : statusCode >= 300 && statusCode < 400
        ? 'Preusmeritev (ni sledena) — preverite cilj.'
        : statusCode < 400
          ? ''
          : `HTTP ${statusCode}`
    : ssrfErrorText(res.errorCategory)
  const connectionStatus = reachable ? 'connected' : 'disconnected'
  const lastSyncStatus = reachable ? (statusCode < 300 ? 'ok' : `http_${statusCode}`) : 'failed'

  const updated = await db.integration.update({
    where: { id },
    data: { connectionStatus, lastSyncAt: new Date(), lastSyncStatus, lastSyncError: errorMessage },
  })
  // #30 §B: log samo varni hostname + shema (BREZ query stringa/Authorization)
  await db.integrationLog.create({
    data: {
      id: nid(), integrationId: id, action: 'test_connection', direction: 'outbound',
      status: reachable && statusCode < 300 ? 'success' : 'failed',
      statusCode, errorMessage, durationMs,
      requestData: jstr({ host: url.hostname, scheme: url.protocol.replace(':', ''), port: url.port || null }),
    },
  })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_TESTED', entityType: 'Integration', entityId: id, details: jstr({ reachable, statusCode, durationMs, by: user.name }), locationId: updated.locationId })
  await publishEvent('IntegrationTested', { entityType: 'Integration', entityId: id, payload: { reachable, statusCode }, locationId: updated.locationId })
  return ok({ connectionStatus, statusCode, durationMs, error: errorMessage, reachable })
}
