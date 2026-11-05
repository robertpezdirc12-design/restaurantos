import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAnyPermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, stationToUI, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { writeAudit } from '@/lib/audit-chain'

/**
 * v1.256.0 (PRIMERJAVA-VMESNIKOV-2026 §30; Lightspeed maj 2026 »Reprint
 * orders«): PONATIS KUHINJSKEGA/BAR LISTKA ZAPRTEGA NAROČILA.
 *
 * POST /api/orders/[id]/reprint-ticket  body: { station: 'KITCHEN' | 'BAR' | 'ALL' }
 *
 * Pravila:
 *  - dovoljenje `reports.sales` (lastnik površine Računi — isti prag kot
 *    seznam, CSV izvoz in skeniranje §25) ALI `kitchen.update` (vodja
 *    produkcije sme rekonstruirati svoj dokument); blagajna/čistilka ne,
 *  - lokacijska vrata (guardResource — issue #4 §1),
 *  - station validacija (strogi nabor — neznana vrednost se ZAVRNE po
 *    vzorcu strict enum v1.238.0 §15, ne tih fallback),
 *  - revizija ORDER_TICKET_REPRINT: listek zaprtega naročila je DOKUMENT
 *    v sporu (»gost pravi, da jed ni prispela«) — vsak ponatis mora biti
 *    sledljiv (kdo, kdaj, katero središče, koliko postavk). 0 DDL:
 *    auditLog je obstoječa revizijska miza,
 *  - ruta NE spreminja stanja naročila/postavk/miz (brez publishEvent —
 *    brez spremembe stanja ni dogodka); vrača sveže naročilo za klientni
 *    tisk po obstoječi cevi (buildKitchenTicketLines + printLines).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnyPermission(req, ['reports.sales', 'kitchen.update'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const station = typeof body?.station === 'string' ? body.station.trim().toUpperCase() : ''
  if (station !== 'KITCHEN' && station !== 'BAR' && station !== 'ALL') {
    return fail("station je obvezen in mora biti 'KITCHEN', 'BAR' ali 'ALL'.", 400)
  }

  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  // Iskrenost postavk: ponatis nosi SAMO produkcijo, ki je nastala —
  // preklicane (status cancelled) in umaknjene (voided) postavke kuhinja/bar
  // nikoli nista dobili (isti pogoj kot filterTicketItems v libu; klient
  // tiska ISTO množico, ki jo strežnik zabeleži — revizija ne laže).
  const liveItems = order.OrderItem.filter((it) => {
    if (it.voided) return false
    const st = (it.status || '').toLowerCase()
    return st !== 'cancelled' && st !== 'voided'
  })
  // station preslikava po istem kanonu kot KDS/list (stationToUI:
  // PrepStation.type kitchen|bar → KITCHEN|BAR; neznan tip → KITCHEN)
  const stationItems = station === 'ALL'
    ? liveItems
    : liveItems.filter((it) => stationToUI(it.MenuItem?.PrepStation?.type) === station)

  await writeAudit(db, {
    userId: user.sub,
    action: 'ORDER_TICKET_REPRINT',
    entityType: 'Order',
    entityId: id,
    details: jstr({
      station,
      orderNumber: order.orderNumber,
      itemCount: stationItems.reduce((s, it) => s + it.quantity, 0),
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      by: user.name,
    }),
    locationId: order.locationId,
  })

  return ok({ order: mapOrder(normalizeOrder(order)), station })
}
