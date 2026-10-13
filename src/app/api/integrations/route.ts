import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isCentralRole, isResponse, ok, fail, locationScope } from '@/lib/api'
import { jparse, jstr, nid } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { maskIntegrationConfig, stripMaskedConfig } from '@/lib/integration-mask'

/**
 * Issue #4 §1 — CONFIG SECRET MASKING: staff ne sme videti skrivnosti integracij.
 * Ključi, katerih ime vsebuje secret/token/key/password (case-insensitive), se
 * maskirajo ('••••') in označijo v `maskedFields`; OWNER/ADMIN (centralna vloga)
 * vidijo celoten config. Oblika ostane ista — samo vrednosti so maskirane.
 *
 * Task 60 (audit §7 Integracije PARTIAL→DONE) — API za povezovanje:
 *  - GET: seznam z maskiranjem (+baseUrl, isActive, syncInterval, lastSync*)
 *  - POST: kreiranje povezave (settings.manage), maskne vrednosti v configu se
 *    izpustijo (src/lib/integration-mask.ts), audit INTEGRATION_CREATED + dogodek.
 */
/**
 * Issue #5 (P0, komentar #6): prej requireAuth + BREZ lokacijskega filtra — vsak
 * prijavljeni je videl integracije VSEH organizacij (metadata + status), centralne
 * vloge pa CELI konfigi (tudi tuje org). Zdaj: settings.manage (integracije-tab) +
 * locationScope org allow-lista. Maskiranje za non-central ostaja kot dodatni sloj.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const rows = await db.integration.findMany({
    where: { ...(await locationScope(user)) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const central = isCentralRole(user)
  return ok({
    integrations: rows.map((r) => {
      const config = jparse<Record<string, unknown>>(r.config, {})
      const { masked, maskedFields } = central
        ? { masked: config, maskedFields: [] as string[] }
        : maskIntegrationConfig(config)
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        provider: r.provider,
        baseUrl: r.baseUrl,
        syncEnabled: r.syncEnabled,
        syncInterval: r.syncInterval,
        isActive: r.isActive,
        connectionStatus: r.connectionStatus,
        lastSyncAt: r.lastSyncAt,
        lastSyncStatus: r.lastSyncStatus,
        lastSyncError: central ? r.lastSyncError : '',
        locationId: r.locationId,
        config: masked,
        ...(maskedFields.length ? { maskedFields } : {}),
        events: jparse(r.events, []),
      }
    }),
  })
}

const MAX_CONFIG_BYTES = 8192

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return fail('Ime povezave je obvezno.', 400)
  if (typeof body.baseUrl === 'string' && body.baseUrl && !/^https?:\/\//i.test(body.baseUrl)) {
    return fail('BaseUrl mora začeti s http(s)://.', 400)
  }
  const rawConfig = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {}
  if (jstr(rawConfig).length > MAX_CONFIG_BYTES) return fail('Config presega 8 kB.', 400)
  // maskni sentinel ('••••') se pri kreiranju izpusti — nočemo shraniti maske kot skrivnost
  const config = stripMaskedConfig(rawConfig as Record<string, unknown>)
  if (body.locationId) {
    const loc = await db.location.findUnique({ where: { id: String(body.locationId) } })
    if (!loc) return fail('Lokacija ne obstaja.', 400)
  }
  const id = nid()
  const row = await db.integration.create({
    data: {
      id,
      name: body.name.trim().slice(0, 120),
      type: typeof body.type === 'string' ? body.type.slice(0, 40) : '',
      provider: typeof body.provider === 'string' ? body.provider.slice(0, 80) : '',
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim().slice(0, 300) : '',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey.slice(0, 500) : '',
      apiSecret: typeof body.apiSecret === 'string' ? body.apiSecret.slice(0, 500) : '',
      syncEnabled: body.syncEnabled !== false,
      syncInterval: Number.isFinite(Number(body.syncInterval)) ? Math.min(Math.max(Number(body.syncInterval), 30), 86400) : 300,
      isActive: body.isActive !== false,
      locationId: body.locationId ? String(body.locationId) : null,
      config: jstr(config),
    },
  })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_CREATED', entityType: 'Integration', entityId: id, details: jstr({ name: row.name, type: row.type, provider: row.provider, by: user.name }), locationId: row.locationId })
  await publishEvent('IntegrationCreated', { entityType: 'Integration', entityId: id, payload: { name: row.name, provider: row.provider } })
  return ok({ integration: { ...row, config: jstr(config) } }, 201)
}
