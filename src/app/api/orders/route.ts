import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAnyPermission, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { mapOrder, ORDER_ACTIVE_DB } from '@/lib/map'
import { createOrderCore, orderInclude, normalizeOrder, OrderError } from '@/lib/ops'
import { pushEvent } from '@/lib/push'
import { fireOrderCore } from '@/lib/order-fire'

/** Normalizacija produkcijske vrstice -> mapper pričakovana oblika */
function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

/**
 * Issue #5 (P0 §B): prej requireAuth — naročila (zneski, opombe, eor) so bila
 * bralno dostopna vsakemu prijavljenemu (čistilka vključno). Bralna pravica
 * domene = orders.create (natakar sledi svojim) ALI kitchen.update (KDS) ALI
 * orders.pay (blagajna) ALI delivery.manage (dostava).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAnyPermission(req, ['orders.create', 'kitchen.update', 'orders.pay', 'delivery.manage'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const status = req.nextUrl.searchParams.get('status')
  const base = status
    ? { status: status.toLowerCase() }
    : { status: { in: ORDER_ACTIVE_DB } }
  // Issue #4 §1: lokacijski scope (prej: vsak staff je videl naročila VSEH lokacij)
  const where = { ...base, ...(await locationScope(user)) }
  const orders = await db.order.findMany({
    where,
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({ orders: orders.map((o) => mapOrder(normalize(o))) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return fail('Naročilo mora vsebovati vsaj en artikel.')
  }
  // v1.238.0 §15: neznana vrednost tipa se NIČ več tiho preslika v dine-in.
  // PREJ: map.orderTypeToDB poznal samo DINE_IN/TAKEAWAY/DELIVERY — tipkarska
  // napaka odjemalca ('TAKEOUT' hitre prodaje!) je tiho pristala kot dine-in in
  // vsa poročila po kanalih (sales-by-hour, food-cost) lažala. Square/Toast:
  // strežnik neznano dining-option ZAVRNE (strict enum), ne pa fallback.
  const ORDER_TYPES_ALLOWED = ['DINE_IN', 'TAKEAWAY', 'DELIVERY']
  if (body.type !== undefined && body.type !== null && String(body.type).trim() !== '') {
    const t = String(body.type).trim().toUpperCase()
    if (!ORDER_TYPES_ALLOWED.includes(t)) {
      return fail(`Neznan tip naročila »${String(body.type).slice(0, 30)}« — dovoljeno: ${ORDER_TYPES_ALLOWED.join(', ')} (ali izpusti za privzeto DINE_IN).`, 400)
    }
    body.type = t
  }
  try {
    // Issue #4 §10: brez findFirst() fallbacka — staff MORA imeti lokacijo (admin lahko poda body.locationId)
    const loc = requireUserLocation(user, body?.locationId)
    if (typeof loc !== 'string') return loc
    const orgGuard = await assertOrgScope(user, loc)
    if (orgGuard) return orgGuard
    const { order, replayed } = await createOrderCore({
      employeeId: user.sub,
      locationId: loc,
      items: body.items,
      tableId: body.tableId || null,
      type: body.type || 'DINE_IN',
      note: body.note,
      guests: body.guests,
      clientOperationId: body.clientOperationId || body.idempotencyKey || null,
    })
    // OPS-7 (v1.70.0) push on new order; OPS-8 (v1.72.0) via notification matrix
    // (fire-and-forget, non-blocking; no rules = same behavior as before)
    if (!replayed) {
      void pushEvent('ORDER_NEW', {
        title: 'Novo naročilo',
        body: `${order.orderNumber ? `#${order.orderNumber} · ` : ''}${order.items?.length ?? 0} postavk`,
        url: '/dashboard?tab=kuhinja',
        tag: `order-${order.id}`,
      }, { roles: ['bar', 'kitchen', 'chef'], locationId: loc })
    }
    // v1.241.0 (§16 E točka 3): autoFire — eksplicitna zastavica klicatelja
    // (tablica submitCreate: gumb »Pošlji v pripravo« končno drži obljubo).
    // Isti dovoljenji kontekst kot ročni fire (orders.create zgoraj) — ni novih
    // pravic; dashboard/handheld zastavice ne pošljeta (coursing kontrola ostane
    // pri natakarju). NEGLEJ replaya (helper idempotenten — pokrije tudi retry
    // po fail-soft odpovedi); FAIL-SOFT: naročilo obstaja, pending je varno stanje.
    let autoFireRes: { firedCount: number; alreadyFired: boolean } | null = null
    if (body.autoFire === true) {
      try {
        autoFireRes = await fireOrderCore(order.id, {
          userId: user.sub,
          by: user.name,
          auditExtra: { autoFire: true },
        })
      } catch (fireErr) {
        console.error('order autoFire error', fireErr)
      }
    }
    if (autoFireRes) {
      // svež odgovor PO požigu (konzistentno s fire ruto — postavke so sedaj fired)
      const fresh = await db.order.findUnique({ where: { id: order.id }, include: orderInclude })
      return ok({ order: fresh ? mapOrder(normalizeOrder(fresh)) : order, replayed, firedCount: autoFireRes.firedCount }, replayed ? 200 : 201)
    }
    return ok({ order, replayed }, replayed ? 200 : 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    return fail('Naročila ni bilo mogoče ustvariti.', 500)
  }
}
