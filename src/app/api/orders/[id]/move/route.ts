import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, jstr } from '@/lib/map'
import { orderInclude, normalizeOrder, isMutableOrderState } from '@/lib/ops'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'

/**
 * v1.145.0 (audit #12) — notranji signal za zavrnitev selitve. Vrglje se ZNOTRAJ
 * transakcije, da rollback razveljavi že opravljeno zasedbo ciljne mize; rok ga
 * pretvori v HTTP odgovor.
 */
class MoveRejected extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * P2 audit §54 — selitev naročila na drugo mizo (move).
 * POST /api/orders/[id]/move  body: { tableId }
 * Pravila:
 *  - dovoljenje `orders.create` (natakar sme; kuhinja/staff brez → 403)
 *  - naročilo mora biti odprto (status NOT IN paid/cancelled IN paymentStatus NOT paid)
 *  - ciljna miza: obstaja, ISTA lokacija kot naročilo, brez drugega odprtega naročila (409)
 *  - tableId == trenutni tableId → 400
 *  - v tx: order.tableId + status miz (nova → occupied; stara → available, če brez drugih odprtih naročil)
 *  - revizija ORDER_MOVE + dogodek OrderMoved (fire-and-forget)
 * v1.145.0 (audit #12): VSI pogoji se ponovijo znotraj transakcije, zasedba ciljne
 * mize preverja svoj `count`, premik naročila pa je pinned na stanje in mizo,
 * prebrano v isti transakciji — zavrnjen premak ne pusti zasedene mize.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.create')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const tableId = typeof body?.tableId === 'string' ? body.tableId.trim() : ''
  if (!tableId) return fail('tableId je obvezen.', 400)

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  // selitev je mogoča samo za odprto naročilo (plačanega/storniranega ne premikamo)
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenega (plačanega/storniranega) naročila ni mogoče premakniti.', 409)
  }
  if (order.tableId === tableId) return fail('Naročilo je že na tej mizi.', 400)

  const table = await db.table.findUnique({ where: { id: tableId } })
  if (!table) return fail('Ciljna miza ne obstaja.', 404)
  if (table.locationId !== order.locationId) {
    return fail('Ciljna miza pripada drugi lokaciji.', 400)
  }

  // ciljna miza ne sme imeti drugega odprtega naročila (isti vzorec kot R6 zasedba mize)
  const busy = await db.order.findFirst({
    where: {
      tableId,
      id: { not: id },
      status: { notIn: ['paid', 'cancelled'] },
      paymentStatus: { not: 'paid' },
    },
    select: { id: true, orderNumber: true },
  })
  if (busy) return fail('Ciljna miza je zasedena (odprto naročilo).', 409)

  const fromTableId = order.tableId
  // v1.145.0 (audit #12): selitev je sedaj v celoti preverjena in zapisana
  // ZNOTRAJ transakcije. Prej sta bila dva pogreška:
  //  - preizkus zasedenosti ciljne mize je bil PRED transakcijo → dva sočasna
  //    premika na ISTO mizo sta oba videla "prosto" in oba uspela (dvočna zasedba);
  //  - rezultat CAS zasedbe mize (status != occupied) je bil IGNORIRAN → naročilo
  //    je bilo preusmerjeno na mizo, ki je v tlorisu še vedno pokazala tuje
  //    naročilo, in tabela miz se ni posodobil (miza "prosta" z naročilom);
  //  - plačano/preklicano naročilo se je lahko premaknilo (branje pogojev pred
  //    dirko, potem brezpogojni update).
  try {
    await db.$transaction(async (tx) => {
      const cur = await tx.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true, tableId: true } })
      if (!cur) throw new MoveRejected(404, 'Naročilo ne obstaja.')
      if (!isMutableOrderState(cur)) throw new MoveRejected(409, 'Zaključenega (plačanega/storniranega) naročila ni mogoče premakniti.')
      if (cur.tableId === tableId) throw new MoveRejected(400, 'Naročilo je že na tej mizi.')

      const tbl = await tx.table.findFirst({ where: { id: tableId, locationId: order.locationId }, select: { id: true, number: true, status: true } })
      if (!tbl) throw new MoveRejected(404, 'Ciljna miza ne obstaja na lokaciji naročila.')

      // ciljna miza ne sme imeti drugega odprtega naročila — ZNOTRAJ tx (prej ven:
      // dve vzporedni selitvi sta obe šli skozi)
      const busy = await tx.order.findFirst({
        where: {
          tableId,
          id: { not: id },
          status: { notIn: ['paid', 'cancelled'] },
          paymentStatus: { not: 'paid' },
        },
        select: { id: true, orderNumber: true },
      })
      if (busy) throw new MoveRejected(409, 'Ciljna miza je zasedena (odprto naročilo).')

      // zasedba ciljne mize: CAS in PREVERJEN rezultat (sicer je miza lahko v
      // stanju, ki ga tloris obravnava kot zasedenega, brez odprtega naročila)
      const seat = await tx.table.updateMany({ where: { id: tableId, status: { not: 'occupied' } }, data: { status: 'occupied' } })
      if (seat.count === 0) throw new MoveRejected(409, 'Ciljna miza je zasedena.')

      // premik naročila: pinned na stanje IN mizo, prebrano znotraj tx (dirka z
      // drugo selitvijo/preklicom/plačilom → count 0 → rollback zasedbe mize)
      const moved = await tx.order.updateMany({
        where: { id, status: cur.status, paymentStatus: cur.paymentStatus, tableId: cur.tableId },
        data: { tableId },
      })
      if (moved.count === 0) throw new MoveRejected(409, 'Naročilo se je medtem spremenilo — selitev ni mogoča.')

      // stara miza → prosta, če na njej ni več odprtega naročila
      if (cur.tableId) {
        const stillOpen = await tx.order.findFirst({
          where: {
            tableId: cur.tableId,
            id: { not: id },
            status: { notIn: ['paid', 'cancelled'] },
            paymentStatus: { not: 'paid' },
          },
          select: { id: true },
        })
        if (!stillOpen) {
          await tx.table.updateMany({ where: { id: cur.tableId, status: 'occupied' }, data: { status: 'available' } })
        }
      }
      await writeAudit(tx, { userId: user.sub, action: 'ORDER_MOVE', entityType: 'Order', entityId: id, details: jstr({ fromTableId: cur.tableId, toTableId: tableId, tableNumber: tbl.number, orderNumber: order.orderNumber, by: user.name }), locationId: order.locationId })
    })
  } catch (e) {
    if (e instanceof MoveRejected) return fail(e.message, e.status)
    throw e
  }

  await publishEvent('OrderMoved', {
    entityType: 'Order',
    entityId: id,
    payload: { orderId: id, fromTableId, toTableId: tableId, locationId: order.locationId },
    locationId: order.locationId,
  }).catch(() => undefined)

  const fresh = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!fresh) return fail('Naročilo ne obstaja.', 404)
  return ok({ order: mapOrder(normalizeOrder(fresh)) })
}
