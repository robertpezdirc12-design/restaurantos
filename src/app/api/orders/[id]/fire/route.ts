import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder } from '@/lib/map'
import { orderInclude, normalizeOrder } from '@/lib/ops'
import { pushEvent } from '@/lib/push'
import { fireOrderCore, FireOrderError, type FireOrderResult } from '@/lib/order-fire'

/**
 * P2 audit §57 — ekspliciten "fire" na kuhinjo (draft → fire korak).
 * POST /api/orders/[id]/fire  body (OPCIJSKO): {courseId: string}
 * Pravila:
 *  - dovoljenje `orders.create`; naročilo odprto; tenant obseg (guardResource)
 *  - v1.241.0 (§16 E): poslovno jedro je preseljeno v SKUPNI helper
 *    fireOrderCore (src/lib/order-fire.ts) — isto pravilo poganja tudi
 *    avto-fire javne QR/kiosk poti in POS autoFire zastavico (tablica).
 *    Ruta ostane odgovorna za HTTP plast: avtorizacija, tenant obseg,
 *    ORDER_FIRE push (avto-fire ga namenoma izpusti — ORDER_NEW push je
 *    ravno odšel) in svež odgovor.
 *  - idempotentno: že požgano naročilo → 200 alreadyFired BREZ sprememb
 *  - OSS-7 coursing: body.courseId → fire SAMO pending postavk TEGA tečaja
 *  - revizija ORDER_FIRED + dogodek OrderFired (fire-and-forget)
 *  - če ni pending postavk → 200 s firedCount 0 (idempotentna prijaznost)
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const fireCourseId = typeof body?.courseId === 'string' && body.courseId.trim() ? body.courseId.trim() : null

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  let result: FireOrderResult
  try {
    result = await fireOrderCore(id, { courseId: fireCourseId, userId: user.sub, by: user.name })
  } catch (e) {
    // v1.241.0: napake helperja nosijo HTTP status (404/409/400) — prej je
    // OrderError iz transakcije (tečaj brez pending postavk) ušel kot 500.
    if (e instanceof FireOrderError) return fail(e.message, e.status)
    throw e
  }

  // OPS-8 val 2 (v1.72.0): push to kitchen/bar on course fire (via notification matrix,
  // fire-and-forget — no rules = base targets kitchen/bar/chef)
  if (result.firedCount > 0) {
    void pushEvent('ORDER_FIRE', {
      title: 'Tečaj poslan',
      body: `${result.courseName || 'Postavke'}${order.orderNumber ? ` · #${order.orderNumber}` : ''} · ${result.firedCount} kos`,
      url: '/dashboard?tab=kuhinja',
      tag: `fire-${id}`,
    }, { roles: ['kitchen', 'bar', 'chef'], locationId: order.locationId })
  }

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)), firedCount: result.firedCount, stationTasks: result.stationTasks, alreadyFired: result.alreadyFired })
}
