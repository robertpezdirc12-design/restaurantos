import webpush from 'web-push'
import { db } from '@/lib/db'
import { jparse } from '@/lib/map'

/**
 * OPS-7 (v1.70.0) — WEB PUSH obvestila (nova naročila → kuhinja/bar; pripravljeno → natakar).
 *
 * VAPID ključi: generirajo se SAMODEJNO ob prvi uporabi in se trajno shranijo v
 * Integration vrstico (name='push-vapid', type='other', config JSON) — brez env
 * nastavitev (produkcija Vercel: ključi so v DB, ne v dashboardu). Public key gre
 * brskalniku prek GET /api/push/key; private ostane strežniško.
 *
 * Pošiljanje: web-push na vse aktivne PushSubscription zaposlenih (lokacijsko filtrirano,
 * do max 3 poskusi; 404/410 → deaktivacija naročnine). Dispatcher je fire-and-forget —
 * NE SME blokirati ali rušiti glavnega toka (naročilo/kuhinja so kritične poti).
 */

interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

const VAPID_MARKER = 'push-vapid'

export async function getVapidConfig(): Promise<VapidConfig | null> {
  const row = await db.integration.findFirst({ where: { name: VAPID_MARKER, type: 'other' } })
  if (row) {
    const cfg = jparse<Partial<VapidConfig>>(row.config, {})
    if (cfg.publicKey && cfg.privateKey) {
      return { publicKey: cfg.publicKey, privateKey: cfg.privateKey, subject: cfg.subject || 'mailto:info@restaurantos.app' }
    }
  }
  // auto-generate + persist (enkrat; race se reši z updateMany na istem markerju)
  const keys = webpush.generateVAPIDKeys()
  const subject = 'mailto:info@restaurantos.app'
  const cfg: VapidConfig = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject }
  const cfgJson = JSON.stringify(cfg) // Integration.config je String (JSON stringify — enako na obeh shemah)
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config: cfgJson } })
  } else {
    await db.integration.create({
      data: {
        id: `push-vapid-${Date.now().toString(36)}`,
        name: VAPID_MARKER,
        type: 'other',
        provider: 'web-push',
        config: cfgJson,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
  return cfg
}

export interface PushTarget {
  employeeIds?: string[] // natančen seznam (npr. avtor naročila)
  roles?: string[] // DB vloge (bar, kitchen, chef …)
  locationId?: string | null
}

export interface PushPayload {
  title: string
  body: string
  url?: string
  tag?: string
}

/** Pošlji push vsem ujemajočim aktivnim naročninam. Fire-and-forget (klicatelj ne čaka). */
export async function pushNotify(payload: PushPayload, target: PushTarget = {}): Promise<void> {
  try {
    const cfg = await getVapidConfig()
    if (!cfg) return
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey)
    const subs = await db.pushSubscription.findMany({
      where: {
        isActive: true,
        ...(target.employeeIds && target.employeeIds.length > 0 ? { employeeId: { in: target.employeeIds } } : {}),
        ...(target.roles && target.roles.length > 0
          ? { Employee: { role: { in: target.roles }, ...(target.locationId ? { locationId: target.locationId } : {}) } }
          : { Employee: target.locationId ? { locationId: target.locationId } : {} }),
      },
      select: { id: true, endpoint: true, p256dhKey: true, authKey: true },
    })
    const json = JSON.stringify(payload)
    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dhKey, auth: s.authKey } },
            json,
            { TTL: 120 },
          )
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode
          if (code === 404 || code === 410) {
            await db.pushSubscription.updateMany({ where: { id: s.id }, data: { isActive: false } }).catch(() => undefined)
          }
        }
      }),
    )
  } catch {
    // push NIKOLI ne ruši glavnega toka
  }
}

/** Pošlji push naročniku dogodka (fire-and-forget wrapper z lokacijskim obsegom). */
export function pushToLocationRoles(locationId: string | null | undefined, roles: string[], payload: PushPayload): void {
  void pushNotify(payload, { roles, locationId: locationId ?? undefined })
}

export function pushToEmployees(employeeIds: string[], payload: PushPayload): void {
  if (employeeIds.length === 0) return
  void pushNotify(payload, { employeeIds })
}

/* ─────────── OPS-11 val 2 (v1.81.0) — AP_NEW (nov dobaviteljev račun) ─────────── */

/**
 * Structured payload for the AP_NEW event (AccountsPayable created — eSLOG
 * e-invoice import or the manual expense create). Call sites pass this through
 * apNewPushPayload() so the notification text stays consistent across both paths.
 */
export interface ApNewPushData {
  apNumber: string
  supplierName: string
  amount: number
  /** ISO datetime or 'YYYY-MM-DD'; rendered as the date part only; null = unknown. */
  dueDate: string | null
}

/** Build the PushPayload for AP_NEW (title/body hard-coded SL — same convention as ORDER_NEW et al.). */
export function apNewPushPayload(data: ApNewPushData): PushPayload {
  const due = data.dueDate ? ` · zapade ${String(data.dueDate).slice(0, 10)}` : ''
  return {
    title: 'Nov dobaviteljev račun',
    body: `${data.apNumber} · ${data.supplierName} · ${data.amount.toFixed(2)} €${due}`,
    url: '/dashboard?tab=stroski',
    tag: `ap-new-${data.apNumber}`,
  }
}

/* ─────────── OPS-8 val 2 (v1.72.0) — Notification matrix (RoxPos pattern) ───────────
 * Event type x {everyone | selected roles | off}. Rules live in an Integration row
 * (name='notification-rules', type='other') config JSON:
 *   { rules: { ORDER_NEW: { mode: 'everyone'|'roles'|'off', roles: ['bar','kitchen'] }, ... } }
 * Missing rule for an event type = default behavior (base target passes through).
 * resolvePushTargets is server-side filtering — pushEvent is the only new entry point
 * (pushNotify stays unchanged for backward compatibility).
 *
 * OPS-11 val 2 (v1.81.0): the event type registry lives in './push-events'
 * (client-safe, zero imports) so the UI matrix card can render dynamically from
 * the same constant; the re-export below keeps every '@/lib/push' import intact.
 * New in the registry: 'AP_NEW' (eSLOG import + manual expense create).
 */

export { PUSH_EVENT_TYPES, type PushEventType } from './push-events'

import type { PushEventType } from './push-events'

const NOTIF_RULES_MARKER = 'notification-rules'

export interface NotificationRule {
  mode: 'everyone' | 'roles' | 'off'
  roles?: string[]
}

export type NotificationRules = Partial<Record<PushEventType, NotificationRule>>

/**
 * Pure resolver (unit-tested, no DB):
 *  - undefined rule / mode 'everyone'  → base target unchanged;
 *  - mode 'off'                        → null (caller skips the push);
 *  - mode 'roles'                      → roles overridden by configured roles,
 *                                        employeeIds merge is preserved (author /
 *                                        requester always gets their own event);
 *                                        empty configured roles → nobody to notify → null.
 */
export function resolveTargetsByRule(
  base: PushTarget,
  rule: NotificationRule | undefined | null,
): PushTarget | null {
  if (!rule || rule.mode === 'everyone' || (rule.mode !== 'roles' && rule.mode !== 'off')) return base
  if (rule.mode === 'off') return null
  const roles = (Array.isArray(rule.roles) ? rule.roles : []).filter((r) => typeof r === 'string' && r.trim())
  if (roles.length === 0) return null
  return { ...base, roles }
}

async function getNotificationRules(): Promise<NotificationRules> {
  const row = await db.integration.findFirst({ where: { name: NOTIF_RULES_MARKER, type: 'other' } })
  if (!row) return {}
  const cfg = jparse<{ rules?: NotificationRules }>(row.config, {})
  return cfg && cfg.rules && typeof cfg.rules === 'object' ? cfg.rules : {}
}

/** Adjusted target for an event type (matrix-aware) or null when the event is switched off. */
export async function resolvePushTargets(
  eventType: PushEventType,
  baseTarget: PushTarget,
): Promise<PushTarget | null> {
  const rules = await getNotificationRules()
  return resolveTargetsByRule(baseTarget, rules[eventType])
}

/**
 * Matrix-aware dispatch (fire-and-forget by convention: call sites use `void pushEvent(...)`).
 * Never throws and never blocks the main flow — same contract as pushNotify.
 */
export async function pushEvent(
  eventType: PushEventType,
  payload: PushPayload,
  baseTarget: PushTarget = {},
): Promise<void> {
  try {
    const target = await resolvePushTargets(eventType, baseTarget)
    if (!target) return
    await pushNotify(payload, target)
  } catch {
    // push NIKOLI ne ruši glavnega toka
  }
}

export function getNotificationRulesMarker(): string {
  return NOTIF_RULES_MARKER
}
