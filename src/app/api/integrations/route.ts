import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isCentralRole, isResponse, ok, fail, locationScope } from '@/lib/api'
import { jstr, nid } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { stripMaskedConfig } from '@/lib/integration-mask'
import { safeIntegrationDto } from '@/lib/secret-dto'
import { guardIntegration } from '@/lib/tenant'

/**
 * Issue #4 §1 — CONFIG SECRET MASKING: staff ne sme videti skrivnosti integracij.
 * Ključi, katerih ime vsebuje secret/token/key/password (case-insensitive), se
 * maskirajo ('••••') in označijo v `maskedFields`. Issue #23 §3: maskiranje sedaj
 * velja ZA VSE vloge (prej so centralne videle surov config — VAPID privateKey
 * je bil živo izpostavljen). lastSyncError ostane central-only (ni skrivnost,
 * a ni operativno potreben osebju).
 *
 * Task 60 (audit §7 Integracije PARTIAL→DONE) — API za povezovanje:
 *  - GET: seznam z maskiranjem (+baseUrl, isActive, syncInterval, lastSync*)
 *  - POST: kreiranje povezave (settings.manage), maskni sentinel v configu se
 *    izpusti, odgovor = varni DTO (#23 §3 — ne odmeva apiKey/apiSecret)
 */
/**
 * Issue #5 (P0, komentar #6): prej requireAuth + BREZ lokacijskega filtra — vsak
 * prijavljeni je videl integracije VSEH organizacij (metadata + status), centralne
 * vloge pa CELI konfigi (tudi tuje org). Zdaj: settings.manage (integracije-tab) +
 * locationScope org allow-lista. Maskiranje za vse vloge = dodatni sloj (#23).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const rows = await db.integration.findMany({
    where: { ...(await locationScope(user)) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({ integrations: rows.map((r) => safeIntegrationDto(r, { central: isCentralRole(user) })) })
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
  // #42 (isti pravilnik kot PATCH/GET seznam): ciljna lokacija mora biti v uporabnikovem
  // obsegu. Brez eksplicitne lokacije: VEZANA na uporabnikovo lokacijo (vidna v lastnem
  // seznamu); globalna (null) nastane SAMO pri platform-level adminu brez loc — zavezana
  // centralna vloga globalov ne vidi v seznamu in jih zato tudi ne sme ustvarjati.
  const central = isCentralRole(user)
  let targetLocationId: string | null
  if (body.locationId) {
    const loc = await db.location.findUnique({ where: { id: String(body.locationId) } })
    if (!loc) return fail('Lokacija ne obstaja.', 400)
    const guard = await guardIntegration(user, loc.id)
    if (guard) return guard
    targetLocationId = loc.id
  } else if (user.loc) {
    targetLocationId = user.loc // staff + centralni z loc → vedno vezano (fail-closed)
  } else if (central) {
    targetLocationId = null // platform-level admin brez loc → globalna (izrecno)
  } else {
    return fail('Lokacija ni določena — podajte locationId.', 403)
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
      locationId: targetLocationId,
      config: jstr(config),
    },
  })
  await writeAudit(db, { userId: user.sub, action: 'INTEGRATION_CREATED', entityType: 'Integration', entityId: id, details: jstr({ name: row.name, type: row.type, provider: row.provider, by: user.name }), locationId: row.locationId })
  await publishEvent('IntegrationCreated', { entityType: 'Integration', entityId: id, payload: { name: row.name, provider: row.provider }, locationId: row.locationId })
  // #23 §3: odgovor = varni DTO — apiKey/apiSecret/config nikoli v surovi obliki
  return ok({ integration: safeIntegrationDto(row, { central: isCentralRole(user) }) }, 201)
}
