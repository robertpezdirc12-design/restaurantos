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
