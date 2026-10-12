/**
 * OPS-9 val 3 (v1.76.0) — Auto-accept dostavnih naročil prek platformskih webhookov.
 *
 * GET /api/delivery/auto-accept → { enabled, providers, providerOptions }
 * PUT /api/delivery/auto-accept { enabled: boolean, providers: string[] }
 *   → upsert Integration row (name='delivery-auto-accept', type='other', config JSON)
 *     — ZERO DDL (isti vzorec kot push-vapid / notification-rules).
 *
 * Storage: { "enabled": true/false, "providers": ["glovo","wolt"] }. Brez vrstice
 * je privzeto enabled=true (nazajkompatibilno: doslej so platformska naročila
 * prihajala kot 'confirmed'); izklop pomeni, da nova platformska naročila ostanejo
 * 'pending' in jih osebstvo potrdi ročno v Dostava tabu.
 *
 * Permission: delivery.manage (kartica je v Dostava tabu). Audit: DELIVERY_AUTO_ACCEPT.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jparse, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import {
  DELIVERY_AUTO_ACCEPT_MARKER,
  DELIVERY_AUTO_ACCEPT_PROVIDERS,
  resolveAutoAcceptConfig,
  type DeliveryAutoAcceptConfig,
} from '@/lib/delivery'

async function loadConfig(): Promise<DeliveryAutoAcceptConfig> {
  const row = await db.integration.findFirst({ where: { name: DELIVERY_AUTO_ACCEPT_MARKER, type: 'other' } })
  if (!row) return resolveAutoAcceptConfig(null) // defaults (enabled=true, all providers)
  return resolveAutoAcceptConfig(jparse<unknown>(row.config, null))
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'delivery.manage')
  if (isResponse(user)) return user
  const cfg = await loadConfig()
  return ok({ ...cfg, providerOptions: [...DELIVERY_AUTO_ACCEPT_PROVIDERS] })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'delivery.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as { enabled?: unknown; providers?: unknown } | null
  if (!body || typeof body.enabled !== 'boolean') return fail('Podatek enabled (boolean) je obvezen.', 400)
  const resolved = resolveAutoAcceptConfig({ enabled: body.enabled, providers: body.providers })
  // enabled brez izbranih ponudnikov ni smiseln — zahtevaj vsaj enega (400, brez tihe poprave)
  if (resolved.enabled && resolved.providers.length === 0) {
    return fail('Samodejna potrditev zahteva vsaj enega ponudnika (glovo/wolt).', 400)
  }

  const config = JSON.stringify({ enabled: resolved.enabled, providers: resolved.providers })
  const existing = await db.integration.findFirst({ where: { name: DELIVERY_AUTO_ACCEPT_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `delivery-auto-accept-${Date.now().toString(36)}`,
        name: DELIVERY_AUTO_ACCEPT_MARKER,
        type: 'other',
        provider: 'glovo,wolt',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }

  const __aId = nid()
  const details = { enabled: resolved.enabled, providers: resolved.providers, by: user.name }
  const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'DELIVERY_AUTO_ACCEPT',
    entityType: 'Integration',
    entityId: existing?.id || DELIVERY_AUTO_ACCEPT_MARKER,
    details,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'DELIVERY_AUTO_ACCEPT',
      entityType: 'Integration',
      entityId: existing?.id || DELIVERY_AUTO_ACCEPT_MARKER,
      details: jstr(details),
    },
  }).catch(() => null)

  return ok({ enabled: resolved.enabled, providers: resolved.providers })
}
