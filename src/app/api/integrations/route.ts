import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isCentralRole, isResponse, ok } from '@/lib/api'
import { jparse } from '@/lib/map'

/**
 * Issue #4 §1 — CONFIG SECRET MASKING: staff ne sme videti skrivnosti integracij.
 * Ključi, katerih ime vsebuje secret/token/key/password (case-insensitive), se
 * maskirajo ('••••') in označijo v `maskedFields`; OWNER/ADMIN vidijo celoten config.
 * Oblika ostane ista (ista polja) — samo vrednosti so maskirane za non-central.
 */
const SECRET_KEY_PATTERN = /(secret|token|key|password)/i
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.integration.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  const central = isCentralRole(user)
  return ok({
    integrations: rows.map((r) => {
      const config = jparse<Record<string, unknown>>(r.config, {})
      let maskedConfig: Record<string, unknown> = config
      let maskedFields: string[] = []
      if (!central) {
        maskedConfig = {}
        for (const [k, v] of Object.entries(config)) {
          if (SECRET_KEY_PATTERN.test(k)) {
            maskedConfig[k] = '••••'
            maskedFields.push(k)
          } else {
            maskedConfig[k] = v
          }
        }
      }
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        provider: r.provider,
        syncEnabled: r.syncEnabled,
        connectionStatus: r.connectionStatus,
        lastSyncAt: r.lastSyncAt,
        config: maskedConfig,
        ...(maskedFields.length ? { maskedFields } : {}),
        events: jparse(r.events, []),
      }
    }),
  })
}
