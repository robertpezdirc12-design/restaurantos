/**
 * OPS-10 val 2 (v1.78.0) — Kiosk upsell konfiguracija ("Dodaj še …").
 *
 * GET /api/kiosk-upsell → { config: { [menuItemId]: string[] } }
 * PUT /api/kiosk-upsell { config } → sanitized → Integration row
 *   (name='kiosk-upsell', type='other', config JSON) — ZERO DDL.
 *
 * Permission: menu.manage (same gate as menu item routes — the config card lives
 * in the Meni tab). Audit: KIOSK_UPSELL_UPDATED.
 * Sanitization is always performed against the LIVE menu item ids, so a PUT never
 * persists dangling suggestions.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jparse, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { KIOSK_UPSELL_MARKER, sanitizeUpsellConfig, type UpsellConfig } from '@/lib/upsell'

/** Live menu item ids (all items — the config editor shows the whole menu). */
async function validItemIds(): Promise<Set<string>> {
  const rows = await db.menuItem.findMany({ select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

async function loadConfig(): Promise<UpsellConfig> {
  const [row, ids] = await Promise.all([
    db.integration.findFirst({ where: { name: KIOSK_UPSELL_MARKER, type: 'other' } }),
    validItemIds(),
  ])
  if (!row) return {}
  return sanitizeUpsellConfig(jparse<unknown>(row.config, null), ids)
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  return ok({ config: await loadConfig() })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as { config?: unknown } | null
  if (!body || typeof body !== 'object') return fail('Podatek config je obvezen.', 400)
  const ids = await validItemIds()
  const config = sanitizeUpsellConfig(body.config, ids)

  const cfgJson = JSON.stringify(config)
  const existing = await db.integration.findFirst({ where: { name: KIOSK_UPSELL_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config: cfgJson } })
  } else {
    await db.integration.create({
      data: {
        id: `kiosk-upsell-${Date.now().toString(36)}`,
        name: KIOSK_UPSELL_MARKER,
        type: 'other',
        provider: 'internal',
        config: cfgJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }

  const details = { items: Object.keys(config).length, by: user.name }
  await writeAudit(db, { userId: user.sub, action: 'KIOSK_UPSELL_UPDATED', entityType: 'Integration', entityId: existing?.id || KIOSK_UPSELL_MARKER, details: jstr(details) }).catch(() => null)

  return ok({ config })
}
