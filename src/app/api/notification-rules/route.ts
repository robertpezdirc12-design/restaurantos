import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { PUSH_EVENT_TYPES, getNotificationRulesMarker, type NotificationRules } from '@/lib/push'

/**
 * OPS-8 val 2 (v1.72.0) — Notifikacijska matrika (RoxPos pattern).
 *
 * GET  /api/notification-rules → { rules } (empty = default behavior everywhere)
 * PUT  /api/notification-rules { rules: { EVENT: { mode: 'everyone'|'roles'|'off', roles?: [] } } }
 *   → stores the whole matrix in an Integration row (name='notification-rules',
 *     type='other', config JSON) — ZERO DDL (same storage as push VAPID).
 *
 * Permission: settings.manage (card in the Nastavitve tab). Audit: NOTIFICATION_RULES_UPDATED.
 * pushEvent() reads this config on every send (server-side filtering).
 */

const RULES_MARKER = getNotificationRulesMarker()
const VALID_MODES = new Set(['everyone', 'roles', 'off'])

async function loadRules(): Promise<NotificationRules> {
  const row = await db.integration.findFirst({ where: { name: RULES_MARKER, type: 'other' } })
  if (!row) return {}
  try {
    const cfg = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as { rules?: NotificationRules } | null
    return cfg?.rules && typeof cfg.rules === 'object' ? (cfg.rules as NotificationRules) : {}
  } catch {
    return {}
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  return ok({ rules: await loadRules() })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const raw = body?.rules
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Podatki (rules) so obvezni.', 400)

  // strict validation: only known event types, only valid modes, roles as non-empty strings
  const clean: NotificationRules = {}
  for (const [event, rule] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PUSH_EVENT_TYPES as readonly string[]).includes(event)) {
      return fail(`Neznana vrsta dogodka: ${event}.`, 400)
    }
    const r = rule as { mode?: unknown; roles?: unknown }
    const mode = String(r?.mode || '')
    if (!VALID_MODES.has(mode)) return fail(`Neveljaven način za ${event} (dovoljeno: everyone, roles, off).`, 400)
    if (mode === 'roles') {
      const roles = Array.isArray(r?.roles)
        ? (r.roles as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
        : []
      if (roles.length === 0) return fail(`${event}: način 'roles' zahteva vsaj eno vlogo.`, 400)
      clean[event as keyof NotificationRules] = { mode, roles }
    } else {
      clean[event as keyof NotificationRules] = { mode } as NotificationRules[keyof NotificationRules]
    }
  }

  const config = JSON.stringify({ rules: clean }) // config Json/String — stringify works on both schemas
  const existing = await db.integration.findFirst({ where: { name: RULES_MARKER, type: 'other' } })
  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `notif-rules-${Date.now().toString(36)}`,
        name: RULES_MARKER,
        type: 'other',
        provider: 'web-push',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }

  await writeAudit(db, { userId: user.sub, action: 'NOTIFICATION_RULES_UPDATED', entityType: 'Integration', entityId: existing?.id || RULES_MARKER, details: jstr({ events: Object.keys(clean), by: user.name }) })

  return ok({ rules: clean })
}
