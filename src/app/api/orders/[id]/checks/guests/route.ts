import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr, num, r2 } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * P1-6 (v1.185.0) — SPLIT PO GOSTIH (»2 gosta na računu«, Toast "split evenly"
 * na ravni IZSTAVKOV, ne plačilnih delov).
 *
 * POST   {guestCount: N}           → postavke se pošteno porazdelijo na N izstavkov
 *                                     (vsak gost svoj izstavek → svoje plačilo → svoj račun).
 *
 * Zakaj LOČENA ruta in ne odjemalec, ki N-krat kliče POST /checks: porazdelitev mora
 * biti ATOMSKA (vsi izstavki ali noben), PONOVLJIVA (ponoven klic medtem, ko nič ni
 * plačano, PREBALANSIRA — ne dodaja novih izstavkov), poštena po znesku (LPT:
 * najdražja postavka gre v trenutno najlažje vedro — sicer bi lahko eden od gostov
 * dobil vse drage postavke, čeprav je število postavk enakomerno) in enkrat revizijsko
 * označena (ORDER_CHECK_GUEST_SPLIT). Odjemalec ne sme biti vir resnice za denar.
 *
 * Pravila (isti konservativni okvir kot split po izstavkih):
 *  - dovoljenje `orders.pay`;
 *  - SAMO dokler ni plačan še noben izstavek IN noben izstavek nima plačila
 *    (paymentStatus je lahko 'unpaid' tudi ob zgodnjem plačilu — branimo po obeh);
 *  - delitev samo dokler je naročilo odprto;
 *  - samo ne-voided postavke; N ≤ število postavk (vsak gost dobi vsaj eno postavko);
 *  - izstavek #1 ostane baza (ohrani id), novi so 2..N zaporedno;
 *    ponovna delitev prejšnje dodatne izstavke izbriše (niso plačani, brez plačil).
 */

const MIN_GUESTS = 2
const MAX_GUESTS = 10

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const nRaw = Number(body?.guestCount)
  if (!Number.isFinite(nRaw) || !Number.isInteger(nRaw) || nRaw < MIN_GUESTS || nRaw > MAX_GUESTS) {
    return fail(`guestCount mora biti celo število med ${MIN_GUESTS} in ${MAX_GUESTS}.`, 400)
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega naročila ni mogoče razdeliti.', 409)
  }

  const checks = await db.check.findMany({
    where: { orderId: id },
    orderBy: { checkNumber: 'asc' },
    include: { _count: { select: { Payment: true } } },
  })
  if (checks.some((c) => c.paymentStatus === 'paid')) {
    return fail('Razdelitev po gostih je dovoljena samo dokler ni plačan še noben izstavek.', 409)
  }
  if (checks.some((c) => c._count.Payment > 0)) {
    return fail('Izstavek s plačilom ni mogoče prebalansirati.', 409)
  }

  const movable = order.OrderItem.filter((it) => !it.voided)
  if (movable.length === 0) return fail('Naročilo nima razdeljivih postavk.', 400)
  if (movable.length < nRaw) {
    return fail(`Na ${nRaw} gostov ni mogoče razdeliti ${movable.length} postavk — vsak gost mora dobiti vsaj eno.`, 409)
  }

  // LPT (longest processing time first): najdražje postavke najprej, vsaka v
  // trenutno NAJLAŽJE vedro. Deterministično: pri enakem znesku odloči id.
  const sorted = [...movable].sort((a, b) => {
    const ta = num(a.price) * a.quantity
    const tb = num(b.price) * b.quantity
    return tb - ta || a.id.localeCompare(b.id)
  })
  const buckets: { itemIds: string[]; total: number }[] = Array.from({ length: nRaw }, () => ({ itemIds: [], total: 0 }))
  for (const it of sorted) {
    const lightest = buckets.reduce((min, b) => (b.total < min.total ? b : min), buckets[0])
    lightest.itemIds.push(it.id)
    lightest.total += num(it.price) * it.quantity
  }

  const result = await db.$transaction(async (tx) => {
    // izrecen ozek tip: checks[0] ima _count (iz include), tx.check.create ga ne —
    // spodaj potrebujemo samo id in checkNumber
    let baseCheck: { id: string; checkNumber: number } | null = checks[0] ?? null
    if (!baseCheck) {
      baseCheck = await tx.check.create({
        data: { id: nid(), checkNumber: 1, orderId: id, paymentStatus: 'unpaid' },
      })
    }
    // rebalans: vse postavke za trenutek nazaj v bazo, dodatni (neplačani) izstavki Proč
    await tx.orderItem.updateMany({ where: { orderId: id, voided: false }, data: { checkId: baseCheck.id } })
    const extraIds = checks.slice(1).map((c) => c.id)
    if (extraIds.length > 0) await tx.check.deleteMany({ where: { id: { in: extraIds }, orderId: id } })

    const out: { id: string; checkNumber: number; items: number; total: number }[] = [
      { id: baseCheck.id, checkNumber: baseCheck.checkNumber, items: buckets[0].itemIds.length, total: r2(buckets[0].total) },
    ]
    let nextNumber = baseCheck.checkNumber
    for (let i = 1; i < buckets.length; i++) {
      nextNumber += 1
      const created = await tx.check.create({
        data: { id: nid(), checkNumber: nextNumber, orderId: id, paymentStatus: 'unpaid' },
      })
      out.push({ id: created.id, checkNumber: nextNumber, items: buckets[i].itemIds.length, total: r2(buckets[i].total) })
      await tx.orderItem.updateMany({ where: { id: { in: buckets[i].itemIds } }, data: { checkId: created.id } })
    }
    // vedro #1 nazaj na bazo (po rebansu je imelo vse)
    await tx.orderItem.updateMany({ where: { id: { in: buckets[0].itemIds } }, data: { checkId: baseCheck.id } })

    await writeAudit(tx, {
      userId: user.sub,
      action: 'ORDER_CHECK_GUEST_SPLIT',
      entityType: 'Order',
      entityId: id,
      details: jstr({ guestCount: nRaw, by: user.name, checks: out }),
      locationId: order.locationId,
    })
    return out
  })

  return ok({ guestCount: nRaw, checks: result })
}
