import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr, num } from '@/lib/map'
import { orderInclude, normalizeOrder, claimMutableOrder, isMutableOrderState } from '@/lib/ops'
import { splitVat } from '@/lib/billing'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * v1.145.0 (audit #12) — notranji signal za zavrnitev združitve. Vrglje se ZNOTRAJ
 * transakcije, da rollback razveljavi že opravljen premik postavk; rok ga ujame in
 * pretvori v HTTP odgovor.
 */
class MergeRejected extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * P2 audit §54 — združevanje naročil (merge).
 * POST /api/orders/[id]/merge  body: { targetOrderId }
 * Vir (= [id]) prenese svoje aktivne postavke na cilj in se prekliče:
 *  - dovoljenje `orders.create`; oba naročila odprta, ISTA lokacija, različna ID-ja
 *  - postavke vira, ki so že na računu (checkId) → 409 (plačanih/delno plačanih ne premikamo);
 *    preklicane/voided postavke ostanejo pri viru (ne vplivajo na totalle cilja)
 *  - v tx: premik postavk, preklic vira (status cancelled + cancelReason), recalcTotals cilja,
 *    sprostitev mize vira (če brez drugih odprtih naročil), revizija ORDER_MERGE, dogodek OrderMerged
 *    — ZAPISA vira in cilja sta CAS (claimMutableOrder, v1.145.0), pogoja (mutabilnost +
 *    bremenjene postavke) se preverita znotraj transakcije; ob katerikoli zavrnitvi
 *    rollback izniči tudi premik postavk.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const targetOrderId = typeof body?.targetOrderId === 'string' ? body.targetOrderId.trim() : ''
  if (!targetOrderId) return fail('targetOrderId je obvezen.', 400)
  if (targetOrderId === id) return fail('Naročila ni mogoče združiti samo s seboj.', 400)

  const source = await db.order.findUnique({ where: { id } })
  if (!source) return fail('Naročilo (vir) ne obstaja.', 404)
  const guard = await guardResource(user, source.locationId)
  if (guard) return guard
  if (source.status === 'paid' || source.status === 'cancelled' || source.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče združiti.', 409)
  }

  const target = await db.order.findUnique({ where: { id: targetOrderId } })
  if (!target) return fail('Ciljno naročilo ne obstaja.', 404)
  if (target.locationId !== source.locationId) {
    return fail('Naročila pripadajo različnim lokacijam — združevanje ni mogoče.', 400)
  }
  if (target.status === 'paid' || target.status === 'cancelled' || target.paymentStatus === 'paid') {
    return fail('Ciljno naročilo ni več odprto.', 409)
  }

  // postavke na računu (Check) so že bremenjene — vir mora ostati celosten (dokumentirano: 409)
  const billed = await db.orderItem.count({ where: { orderId: id, checkId: { not: null } } })
  if (billed > 0) {
    return fail('Naročilo vsebuje postavke, ki so že na računu — združevanje ni mogoče.', 409)
  }

  // v1.145.0 (audit #12): združevanje sedaj ZAPISA oba naročila z CAS claimoma in
  // pogoje (mutabilnost, bremenjene postavke) preveri ZNOTRAJ transakcije. Prej so
  // bili pogoji preverjeni samo ob prihodu, zapis pa je bil brezpogojen. Posledice
  // sočasne dirke:
  //  - plačano naročilo (vir) je bilo kljub računu z EOR-jem preklicano, njegove
  //    postavke pa prenesene na cilj;
  //  - sočasno plačilo cilja je ostalo plačano z PREPISANIMI totali (plačan račun
  //    in naročilo se ne ujemata več — fiskalno neskladje);
  //  - sočasen Check je premaknil že bremenjeno postavko, ker je zunanji preizkus
  //    `billed` še pokazal 0.
  // Neuspeh katerega koli koraka = rollback → premik postavk se izniči, v bazi ne
  // ostane delno združeno naročilo.
  try {
    const merged = await db.$transaction(async (tx) => {
      const src = await tx.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true, tableId: true } })
      if (!src) throw new MergeRejected(404, 'Naročilo (vir) ne obstaja.')
      if (!isMutableOrderState(src)) throw new MergeRejected(409, 'Zaključenega (plačanega/storniranega) naročila ni mogoče združiti.')
      const tgt = await tx.order.findUnique({ where: { id: targetOrderId }, select: { status: true, paymentStatus: true } })
      if (!tgt) throw new MergeRejected(404, 'Ciljno naročilo ne obstaja.')
      if (!isMutableOrderState(tgt)) throw new MergeRejected(409, 'Ciljno naročilo ni več odprto.')

      // postavke na računu (Check) so že bremenjene — vir mora ostati celosten
      // (ponovljeno znotraj tx: med prihodom in transakcijo je lahko nastal Check)
      const billedNow = await tx.orderItem.count({ where: { orderId: id, checkId: { not: null } } })
      if (billedNow > 0) throw new MergeRejected(409, 'Naročilo vsebuje postavke, ki so že na računu — združevanje ni mogoče.')

      // premik aktivnih postavk (pending/fired/preparing/ready/served) iz vira na cilj;
      // cancelled/voided ostanejo pri viru — ne smejo spreminjati totalov cilja
      const moved = await tx.orderItem.updateMany({
        where: { orderId: id, checkId: null, status: { notIn: ['cancelled', 'voided'] } },
        data: { orderId: targetOrderId },
      })
      // totali cilja iz NE-voided postavk (isti izračun kot orders/[id] recalcTotals)
      const items = await tx.orderItem.findMany({ where: { orderId: targetOrderId, voided: false } })
      const split = splitVat(items, (it) => num(it.price) * (it.quantity || 0), (it) => num(it.vatAmount))
      const totals = { subtotal: split.net, tax: split.vat, total: split.gross }

      // CILJ prvi (sicer bi preklic vira ob odpovedi cilja pustil bremenjene
      // postavke brez naročila); oba zapisa sta pinned na stanje, prebrano zgoraj
      const tgtClaim = await claimMutableOrder(tx, targetOrderId, totals, tgt)
      if (!tgtClaim.ok) throw new MergeRejected(409, 'Ciljno naročilo je medtem zaključeno — združevanje ni mogoče.')
      // preklic vira (paymentStatus ostane nespremenjen — zgodovina plačil se ne izgubi)
      const srcClaim = await claimMutableOrder(tx, id, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: user.name,
        cancelledById: user.sub,
        cancelReason: `merged into ${target.orderNumber}`,
      }, src)
      if (!srcClaim.ok) throw new MergeRejected(409, 'Vir je medtem zaključen — združevanje ni mogoče.')

      // miza vira → prosta, če na njej ni več odprtega naročila (isti vzorec kot move)
      const sourceTableId = srcClaim.tableId
      if (sourceTableId) {
        const stillOpen = await tx.order.findFirst({
          where: {
            tableId: sourceTableId,
            id: { not: id },
            status: { notIn: ['paid', 'cancelled'] },
            paymentStatus: { not: 'paid' },
          },
          select: { id: true },
        })
        if (!stillOpen) {
          await tx.table.updateMany({ where: { id: sourceTableId, status: 'occupied' }, data: { status: 'available' } })
        }
      }
      await writeAudit(tx, { userId: user.sub, action: 'ORDER_MERGE', entityType: 'Order', entityId: id, details: jstr({
          sourceOrderId: id,
          targetOrderId,
          movedItems: moved.count,
          sourceTableId,
          targetTableId: target.tableId,
          orderNumber: source.orderNumber,
          by: user.name,
        }), locationId: source.locationId })
      return moved.count
    })

    await publishEvent('OrderMerged', {
      entityType: 'Order',
      entityId: targetOrderId,
      payload: { sourceOrderId: id, targetOrderId, movedItems: merged, locationId: source.locationId },
      locationId: source.locationId,
    }).catch(() => undefined)

    const fresh = await db.order.findUnique({ where: { id: targetOrderId }, include: orderInclude })
    if (!fresh) return fail('Ciljno naročilo ne obstaja.', 404)
    return ok({ order: mapOrder(normalizeOrder(fresh)), mergedItems: merged, sourceCancelled: true })
  } catch (e) {
    if (e instanceof MergeRejected) return fail(e.message, e.status)
    throw e
  }
}
