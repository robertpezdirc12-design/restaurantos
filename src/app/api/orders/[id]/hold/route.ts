import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder, claimMutableOrder } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { canHoldOrder, sanitizeHoldReason } from '@/lib/order-hold'

/**
 * OSS-4 (v1.204.0) — HOLD/DRAFT NAROČILA.
 * POST /api/orders/[id]/hold  body (OPCIJSKO): { reason: string } — ≤ 200 znakov,
 * sanitiziran (sanitizeHoldReason), posnetek v reviziji.
 *
 * Pravila (src/lib/order-hold.ts):
 *  - dovoljenje `orders.create` (isti vzorec kot fire);
 *  - SAMO status 'open' + paymentStatus 'unpaid' + firedAt NULL (kuhinja še ne dela —
 *    zadržano naročilo se nikoli ne pojavi na KDS, ker kitchen ruta filtrira po
 *    ORDER_ACTIVE_DB, kamor 'hold' ne sodi);
 *  - zapis je CAS (claimMutableOrder z vonjskim prebrisom) — dirka s plačilom/fire/
 *    preklicom → 409 brez stranskih učinkov (revizija je ZA claimom v isti transakciji);
 *  - revizija ORDER_HOLD (chain) + dogodek OrderHeld (fire-and-forget);
 *  - med zadržanim so VSE ostale mutacijske poti fail-closed (409) prek obstoječih
 *    belih list (ORDER_MUTABLE_STATUS / ORDER_ACTIVE_DB / ORDER_PAYABLE_STATUS ne
 *    poznajo 'hold') — urejanje, plačilo, premik, združitev, popust, preklic, void,
 *    paylink, tečaji, fire; offline sync addItems operacija propade z 409 in ostane
 *    'failed' (po nadaljevanju se ponovi — R7 garancija nedotaknjena).
 *  - pot ven je SAMO resume (hold → open).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const reason = sanitizeHoldReason(body?.reason)

  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const check = canHoldOrder({ status: order.status, paymentStatus: order.paymentStatus, firedAt: order.firedAt })
  if (!check.ok) return fail(check.error, 409)

  // CAS zapis: uspe samo, če je vrstica ob zapisu še v istem odprtem, neplačanem stanju.
  const claimed = await db.$transaction(async (tx) => {
    const claim = await claimMutableOrder(
      tx,
      id,
      { status: 'hold' },
      { status: order.status, paymentStatus: order.paymentStatus, tableId: order.tableId },
    )
    if (!claim.ok) return false
    // Revizija ZA claimom v ISTI transakciji (vzorec cancel/fire): zavrnjeno
    // zadržanje ne pusti nobenega sledi.
    await writeAudit(tx, {
      userId: user.sub,
      action: 'ORDER_HOLD',
      entityType: 'Order',
      entityId: id,
      details: jstr({ orderNumber: order.orderNumber, total: Number(order.total), by: user.name, ...(reason ? { reason } : {}) }),
      locationId: order.locationId,
    })
    return true
  })
  if (!claimed) return fail('Naročilo se je medtem spremenilo (plačilo, pošiljanje na kuhinjo ali preklic) — osvežite in poskusite znova.', 409)

  await publishEvent('OrderHeld', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, locationId: order.locationId, ...(reason ? { reason } : {}) },
    locationId: order.locationId,
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), held: true })
}
