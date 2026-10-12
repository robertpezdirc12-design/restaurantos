/**
 * OPS-10 val 2 (v1.78.0) — Promocije za customer display (idle carousel).
 *
 * GET /api/display-promos → { ads: [{ id, imageUrl, durationSec, active }] }
 * PUT /api/display-promos { ads } → sanitized → Integration row
 *   (name='display-promos', type='other', config JSON) — ZERO DDL
 *   (same pattern as notification-rules / delivery-auto-accept).
 *
 * Permission: settings.manage (card lives in the Nastavitve tab — same gate as
 * the notifications matrix). The display page itself does NOT call this route:
 * it receives active promos through GET /api/devices/display/state (device token).
 * Audit: DISPLAY_PROMOS_UPDATED.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jparse, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { DISPLAY_PROMOS_MARKER, sanitizePromos, type DisplayPromo } from '@/lib/display-promos'

async function loadPromos(): Promise<DisplayPromo[]> {
  const row = await db.integration.findFirst({ where: { name: DISPLAY_PROMOS_MARKER, type: 'other' } })
  if (!row) return []
  return sanitizePromos(jparse<unknown>(row.config, null)).ads
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  return ok({ ads: await loadPromos() })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as { ads?: unknown } | null
  if (!body || typeof body !== 'object') return fail('Podatek ads je obvezen.', 400)
  const ads = sanitizePromos(body).ads

  const cfgJson = JSON.stringify({ ads })
  const existing = await db.integration.findFirst({ where: { name: DISPLAY_PROMOS_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: cfgJson } })
  } else {
    await db.integration.create({
      data: {
        id: `display-promos-${Date.now().toString(36)}`,
        name: DISPLAY_PROMOS_MARKER,
        type: 'other',
        provider: 'internal',
        config: cfgJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }

  const details = { count: ads.length, by: user.name }
  const __aId = nid()
  const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'DISPLAY_PROMOS_UPDATED',
    entityType: 'Integration',
    entityId: existing?.id || DISPLAY_PROMOS_MARKER,
    details,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'DISPLAY_PROMOS_UPDATED',
      entityType: 'Integration',
      entityId: existing?.id || DISPLAY_PROMOS_MARKER,
      details: jstr(details),
    },
  }).catch(() => null)

  return ok({ ads })
}
