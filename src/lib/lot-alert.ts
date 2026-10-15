/**
 * Issue #15 (P1, v1.105.0) — opozorila o roku uporabe serij (lot alert).
 *
 * DNEVNI klic (cron /api/cron/daily korak lotAlert): poišči serije, katerih
 * IZRECNO določen opozorilni datum (alertDate) je pretekel — samo takšne
 * (issue #15: "Ne izpeljuj roka iz naključnega privzetega števila dni" —
 * brez alertDate NI opozorila, ne glede na bližino expiryDate).
 *
 * Stanje (en opomnik na serijo) živi v Integration vrstici
 * (name='lot-alert-state', type='other') config JSON:
 *   { "<batchId>": "2026-02-10T12:00:00.000Z", ... } — zadnji poslani opomnik.
 * RE-ARM pravilo: ponovni opomnik SAMO če je bil alertDate medtem premaknjen
 * v prihodnost in je spet pretekel (nova eksplicitna odločitev upravljavca).
 *
 * Pošiljanje: pushEvent('LOT_ALERT', ...) → matrika obvestil (base target:
 * manager + warehouse). Funkcija je fire-and-forget pri klicatelju in NIKOLI
 * ne meče (vzorec src/lib/low-stock.ts).
 */
import { db } from '@/lib/db'
import { num, jparse, jstr } from '@/lib/map'
import { pushEvent } from '@/lib/push'
import { lotGovernanceColumnsReady } from '@/lib/lot-governance'

export const LOT_ALERT_STATE_MARKER = 'lot-alert-state'

export interface LotAlertRow {
  id: string
  lotNumber: string
  itemName: string
  unit: string
  alertDate: Date
  expiryDate: Date | null
  quantityRemaining: number
  locationId: string | null
  supplierName: string
}

export type LotAlertStateConfig = Record<string, string> // batchId → lastAlertedAt ISO

/** Pure: ali je opozorilo upravičeno (alertDate pretekel, še ni bilo poslano). */
export function shouldSendLotAlert(alertDate: Date, now: Date, lastAlertedAt: string | undefined): boolean {
  if (alertDate.getTime() > now.getTime()) return false
  if (!lastAlertedAt) return true
  // re-arm: alertDate je bil po zadnjem opomniku premaknjen v prihodnost in je
  // spet pretekel — nova izrecna odločitev upravljavca
  return new Date(lastAlertedAt).getTime() < alertDate.getTime()
}

/** Pure: grupirana vsebina opomnika (največ 5 serij + števec). */
export function lotAlertBody(rows: LotAlertRow[]): string {
  const shown = rows.slice(0, 5).map((r) => `${r.itemName} (${r.lotNumber})`).join(', ')
  const rest = rows.length - 5
  return rest > 0 ? `${shown} … (+${rest})` : shown
}

async function readState(): Promise<LotAlertStateConfig> {
  const row = await db.integration.findFirst({ where: { name: LOT_ALERT_STATE_MARKER, type: 'other' } })
  const cfg = jparse<LotAlertStateConfig>(row?.config || '{}', {})
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
}

async function writeState(state: LotAlertStateConfig): Promise<void> {
  const config = jstr(state)
  const row = await db.integration.findFirst({ where: { name: LOT_ALERT_STATE_MARKER, type: 'other' } })
  if (row) {
    await db.integration.update({ where: { id: row.id }, data: { config } })
  } else {
    await db.integration.create({
      data: {
        id: `lot-alert-${Date.now().toString(36)}`,
        name: LOT_ALERT_STATE_MARKER,
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
 * Dnevni pregled opozorilnih datumov serij. Vrne število poslanih opomnikov
 * (0 = nič za poslati / lot-governance stolpci še niso aplicirani).
 * Klicatelj: cron daily (try/catch izoliran korak).
 */
export async function runDailyLotAlerts(now: Date = new Date()): Promise<number> {
  try {
    if (!(await lotGovernanceColumnsReady())) return 0

    const rows = await db.inventoryBatch.findMany({
      where: {
        status: { in: ['ACTIVE', 'active'] },
        quantityRemaining: { gt: 0 },
        alertDate: { not: null, lte: now },
      },
      take: 100,
      select: {
        id: true, lotNumber: true, alertDate: true, expiryDate: true,
        quantityRemaining: true, locationId: true, supplierName: true, unit: true,
        InventoryItem: { select: { name: true, unit: true } },
      },
    })

    const state = await readState()
    const due = rows.filter((r) => shouldSendLotAlert(r.alertDate as Date, now, state[r.id]))
    if (due.length === 0) return 0

    // poslani opomniki po lokacijah (tenant ločeno: en push na lokacijo)
    const byLocation = new Map<string, LotAlertRow[]>()
    for (const r of due) {
      const key = r.locationId || ''
      const list = byLocation.get(key) || []
      list.push({
        id: r.id,
        lotNumber: r.lotNumber,
        itemName: r.InventoryItem?.name || r.lotNumber,
        unit: r.InventoryItem?.unit || r.unit || '',
        alertDate: r.alertDate as Date,
        expiryDate: r.expiryDate,
        quantityRemaining: num(r.quantityRemaining),
        locationId: r.locationId,
        supplierName: r.supplierName || '',
      })
      byLocation.set(key, list)
    }

    for (const [locKey, list] of byLocation) {
      void pushEvent(
        'LOT_ALERT',
        {
          title: 'Opozorilo: rok uporabe serij',
          body: `Pretekel opozorilni datum: ${lotAlertBody(list)}`,
          url: '/dashboard?tab=zaloga',
          tag: `lot-alert-${locKey}-${now.toISOString().slice(0, 10)}`,
        },
        { roles: ['manager', 'warehouse'], ...(locKey ? { locationId: locKey } : {}) },
      )
    }

    // stanje: zadnji opomnik = sedaj (re-arm samo ob premiku alertDate)
    for (const r of due) state[r.id] = now.toISOString()
    await writeState(state)
    return due.length
  } catch (e) {
    console.warn('[lot-alert] runDailyLotAlerts failed (ignored):', (e as Error).message)
    return 0
  }
}
