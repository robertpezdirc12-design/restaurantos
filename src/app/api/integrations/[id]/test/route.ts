import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr, nid } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Task 60 (audit §7 Integracije PARTIAL→DONE) — test povezave.
 * POST /api/integrations/[id]/test — poskuša doseči baseUrl (GET, 5 s timeout),
 * rezultat zapiše v connectionStatus/lastSync* + IntegrationLog + audit
 * INTEGRATION_TESTED. Vsak HTTP odgovor (tudi 4xx/5xx) = »dosegljiv«;
 * omrežna napaka/DNS = »prekinjeno«.
 *
 * SSRF varovalo (P1): zavrne localhost, zasebna območja IP (RFC 1918, CGNAT,
 * link-local, loopback, ULA) in .local/.internal domene — testiranje sme samo
 * javne http(s) naslove, dovoljenje settings.manage.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const row = await db.integration.findUnique({ where: { id } })
  if (!row) return fail('Povezava ne obstaja.', 404)
  let url: URL
  try {
    url = new URL(row.baseUrl)
  } catch {
    return fail('BaseUrl ni veljaven URL — najprej uredite povezavo.', 400)
  }
  if (!/^https?:$/.test(url.protocol)) return fail('Podprta sta le http in https.', 400)
  if (isPrivateHost(url.hostname)) return fail('Testiranje zasebnih/lokalnih naslovov ni dovoljeno.', 400)

  const started = Date.now()
  const headers: Record<string, string> = { accept: 'application/json, */*' }
  if (row.apiKey) headers['authorization'] = `Bearer ${row.apiKey}`
  if (row.apiSecret) headers['x-api-secret'] = row.apiSecret

  let statusCode = 0
  let reachable = false
  let errorMessage = ''
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(5000), redirect: 'follow' })
    statusCode = res.status
    reachable = true
    if (!res.ok) errorMessage = `HTTP ${res.status}`
    await res.body?.cancel().catch(() => null)
  } catch (err) {
    errorMessage = err instanceof Error ? err.message.slice(0, 200) : 'neznana napaka'
  }
  const durationMs = Date.now() - started
  const connectionStatus = reachable ? 'connected' : 'disconnected'
  const lastSyncStatus = reachable ? (statusCode < 400 ? 'ok' : `http_${statusCode}`) : 'failed'

  const updated = await db.integration.update({
    where: { id },
    data: { connectionStatus, lastSyncAt: new Date(), lastSyncStatus, lastSyncError: errorMessage },
  })
  await db.integrationLog.create({
    data: {
      id: nid(), integrationId: id, action: 'test_connection', direction: 'outbound',
      status: reachable && statusCode < 400 ? 'success' : 'failed',
      statusCode, errorMessage, durationMs, requestData: jstr({ url: row.baseUrl }),
    },
  })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_TESTED', entityType: 'Integration', entityId: id, details: jstr({ reachable, statusCode, durationMs, by: user.name }), locationId: updated.locationId })
  await publishEvent('IntegrationTested', { entityType: 'Integration', entityId: id, payload: { reachable, statusCode } })
  return ok({ connectionStatus, statusCode, durationMs, error: errorMessage, reachable })
}
