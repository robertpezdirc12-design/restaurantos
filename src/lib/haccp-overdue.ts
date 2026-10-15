/**
 * Issue #20 (P1/P2, v1.109.0) — dnevni opomnik o ZAPADLIH HACCP kontrolah.
 *
 * DNEVNI klic (cron /api/cron/daily korak haccpOverdue): za vsako AKTIVNO
 * načrtno kontrolo na lokaciji preveri, ali je današnji termin (po lokalnem
 * koledarju + dueTime) že pretekel BREZ zapisa izvedbe → en HACCP_OVERDUE
 * push na lokacijo (združeno, največ 5 imen + števec).
 *
 * Stanje (en opomnik na termin — occurrenceKey) živi v Integration vrstici
 * (name='haccp-overdue-state', type='other') kot JSON slovar
 * { "<planId>|<YYYY-MM-DD>": "<ISO poslano>" }. Termin je nespremenljiv,
 * zato re-arm NI potreben (razlik od LOT_ALERT: tam se alertDate lahko premakne).
 *
 * Pošiljanje: pushEvent('HACCP_OVERDUE', …) → matrika obvestil (base target:
 * manager). Fire-and-forget, NIKOLI ne meče (vzorec lot-alert.ts).
 */
import { db } from '@/lib/db'
import { jparse, jstr } from '@/lib/map'
import { pushEvent } from '@/lib/push'
import { haccpOpsColumnsReady, occurrenceForDate, zonedDateParts, type LocalDate } from '@/lib/haccp-ops'

export const HACCP_OVERDUE_STATE_MARKER = 'haccp-overdue-state'

export type HaccpOverdueStateConfig = Record<string, string> // occurrenceKey → lastAlertedAt ISO

/** Pure: ali je termin včeraj/danes zapadel brez zapisa in še ni bil opomnjen? */
export function isUnalertedOverdue(dueAt: Date, hasEntry: boolean, now: Date, lastAlertedAt: string | undefined): boolean {
  if (hasEntry) return false
  if (dueAt.getTime() > now.getTime()) return false
  return !lastAlertedAt
}

/** Pure: združena vsebina opomnika (največ 5 + števec). */
export function overdueBody(names: string[]): string {
  const shown = names.slice(0, 5).join(', ')
  const rest = names.length - 5
  return rest > 0 ? `${shown} … (+${rest})` : shown
}

async function readState(): Promise<HaccpOverdueStateConfig> {
  const row = await db.integration.findFirst({ where: { name: HACCP_OVERDUE_STATE_MARKER, type: 'other' } })
  const cfg = jparse<HaccpOverdueStateConfig>(row?.config || '{}', {})
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
}

async function writeState(state: HaccpOverdueStateConfig): Promise<void> {
  const config = jstr(state)
  const row = await db.integration.findFirst({ where: { name: HACCP_OVERDUE_STATE_MARKER, type: 'other' } })
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `haccp-overdue-${Date.now().toString(36)}`,
        name: HACCP_OVERDUE_STATE_MARKER,
        type: 'other',
        provider: 'internal',
        config,
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/**
 * Dnevni pregled zapadlih načrtovih terminov. Vrne število poslanih opomnikov
 * (0 = nič za poslati / stolpci še niso aplicirani). Klicatelj: cron daily
 * (try/catch izoliran korak). Pregleda ZADNJIH 3 DNI (današnji termin, ki je
 * pretekel + včerajšnji izpuščeni — "dnevi brez izvedbe so vidni").
 */
export async function runDailyHaccpOverdue(now: Date = new Date()): Promise<number> {
  try {
    if (!(await haccpOpsColumnsReady())) return 0

    const plans = await db.haccpPlan.findMany({
      where: { active: true },
      select: {
        id: true, name: true, frequency: true, dueTime: true, weekday: true,
        monthDay: true, locationId: true,
      },
    })
    if (plans.length === 0) return 0

    // dnevi za pregled: včeraj, danes (lokalni koledarji PO LOKACIJI — terminal
    // načrtom z brez lokacije uporabimo privzeti pas strežnika)
    const byLocation = new Map<string, string | null>()
    for (const p of plans) if (!byLocation.has(p.locationId ?? '')) byLocation.set(p.locationId ?? '', p.locationId)
    const tzs = new Map<string, string | null>()
    for (const key of byLocation.keys()) {
      const locId = byLocation.get(key)
      if (!locId) {
        tzs.set(key, null)
        continue
      }
      const loc = await db.location.findUnique({ where: { id: locId }, select: { timezone: true } })
      tzs.set(key, loc?.timezone || null)
    }

    // vsi zapisi terminov zadnjih 4 dni ( occurrenceKey ni indeksiran po času —
    // filtriramo po createdAt/dueAt + planId)
    const since = new Date(now.getTime() - 4 * 24 * 3600 * 1000)
    const entries = await db.haccpEntry.findMany({
      where: { OR: [{ dueAt: { gte: since } }, { createdAt: { gte: since } }], occurrenceKey: { not: '' } },
      select: { occurrenceKey: true },
    })
    // vsak zapis (tudi odstopanje) pomeni, da je termin IZVEDEN — odstopanja
    // imajo svoj takojšen HACCP_DEVIATION push ob vnosu, zapadlost pa pomeni
    // izpuščen termin BREZ zapisa
    const doneKeys = new Set(entries.map((e) => e.occurrenceKey))
    const state = await readState()
    const due: { key: string; name: string; locationKey: string }[] = []

    for (const p of plans) {
      const tzKey = p.locationId ?? ''
      const tz = tzs.get(tzKey) || 'Europe/Ljubljana'
      const today = zonedDateParts(now, tz)
      for (let off = -1; off <= 0; off++) {
        const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + off))
        const date: LocalDate = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
        const occ = occurrenceForDate(
          { id: p.id, frequency: p.frequency, dueTime: p.dueTime, weekday: p.weekday, monthDay: p.monthDay },
          date,
          tz,
        )
        if (!occ) continue
        if (isUnalertedOverdue(occ.dueAt, doneKeys.has(occ.key), now, state[occ.key])) {
          due.push({ key: occ.key, name: p.name, locationKey: tzKey })
        }
      }
    }
    if (due.length === 0) return 0

    const byLoc = new Map<string, { key: string; name: string }[]>()
    for (const d of due) {
      const list = byLoc.get(d.locationKey) || []
      list.push({ key: d.key, name: d.name })
      byLoc.set(d.locationKey, list)
    }
    for (const [locKey, list] of byLoc) {
      void pushEvent(
        'HACCP_OVERDUE',
        {
          title: 'Zapadle HACCP kontrole',
          body: `Brez izvedbe: ${overdueBody(list.map((l) => l.name))}`,
          url: '/dashboard?tab=haccp',
          tag: `haccp-overdue-${locKey}-${now.toISOString().slice(0, 10)}`,
        },
        { roles: ['manager'], ...(locKey ? { locationId: locKey } : {}) },
      )
    }

    for (const d of due) state[d.key] = now.toISOString()
    await writeState(state)
    return due.length
  } catch (e) {
    console.warn('[haccp-overdue] runDailyHaccpOverdue failed (ignored):', (e as Error).message)
    return 0
  }
}
