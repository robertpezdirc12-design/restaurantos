import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, r2, jstr } from '@/lib/map'
import { discountAmountOf } from '@/lib/billing'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #1 §6 — ročni popust na naročilo (check-level).
 * - POST: { discountId } (iz registra popustov) ALI { name, type, amount } (ad-hoc, vedno audit)
 * - DELETE: odstrani ročni popust
 * Zahteva apply_discounts. Znesek se shrani na Order.discount (kanonično polje); končni
 * izračun (vključno s Happy Hour) se vedno izvede ob plačilu prek billing.ts.
 *
 * Issue #45 (P1) — SEMANTIKA currentUses (dokumentirana odločitev):
 * kvota šteje USPEŠNO PRIPETE popuste na naročilo (attachment = poraba; enako kot
 * »žig kupona ob uporabi«). Plačilo NI pogoj za porabo (billing izračunava sam ob
 * plačilu; auto/HappyHour popusti sploh ne grejo skozi ta števec). ODSTRANITEV
 * popusta (DELETE) s kvote NE vrača — računovodsko konzervativno (promocija je
 * porabila svojo izdajo). Kar je NOVO: poraba je VEZANA na uspeh celotne mutacije —
 * naročilo + kvota + audit v ENI transakciji:
 *  - vsa validacija (vnosi, veljavnost, končni znesek > 0, plačljivo stanje,
 *    obstoječi popust) PRED porabo kvote;
 *  - CAS na naročilu: paymentStatus IN (unpaid, partial) AND discount = prebrana
 *    vrednost — naročilo, ki je medtem plačano/stornirano/preklicano ALI je druga
 *    zahteva že pripela popust, povzroči ROLLBACK kvote (409);
 *  - dve sočasni zahtevi na isto naročilo: natanko ena uspe (CAS), druga 409 —
 *    tiho preiranje zneska ob dvojni porabi kvote ni več mogoče; zamenjava je
 *    EKSPlicitna (najprej DELETE, nato POST).
 */

/** OPS-4 (v1.67.0): zgornja meja ročnega odstotka za ne-vodstvene vloge (matrica §4b — Toast "manager approval"). */
export const DISCOUNT_APPROVAL_PERCENT = 15
const isManagerialRole = (role?: string | null): boolean =>
  ['MANAGER', 'ADMIN', 'OWNER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER'].includes(String(role ?? '').toUpperCase())

/** Issue #45: plačljiva stanja naročila za spremembo ročnega popusta (CAS v samem update-u). */
const PAYABLE: ('unpaid' | 'partial')[] = ['unpaid', 'partial']

/** Interni reject (#45) — znotraj $transaction povzroči ROLLBACK (naročilo + kvota). */
class DiscountApplyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: { where: { voided: false } } } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: popust na tujem naročilu ni dovoljen
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)

  const now = new Date()
  let discountName = ''
  let amount = 0
  let discountId: string | null = null
  let quota: { maxUses: number } | null = null

  if (body?.discountId) {
    const d = await db.discount.findUnique({ where: { id: String(body.discountId) } })
    if (!d || !d.isActive) return fail('Popust ne obstaja ali ni aktiven.', 404)
    if (d.locationId !== order.locationId) return fail('Popust ni za to lokacijo.', 400)
    if (d.triggerType === 'auto') return fail('Avtomatski popust (Happy Hour) se uporabi samodejno ob plačilu.', 400)
    // veljavnost
    if (d.validFrom && d.validFrom > now) return fail('Popust še ni veljaven.', 400)
    if (d.validTo && d.validTo < now) return fail('Popust je pretekel.', 400)
    if (d.maxUses != null && d.currentUses >= d.maxUses) return fail('Popust je dosegel omejitev uporabe.', 409)
    // OPS-4: vnaprej definiran odstotni popust nad limitom = tudi odobritev vodje
    if (d.type === 'percent' && num(d.amount) > DISCOUNT_APPROVAL_PERCENT && !isManagerialRole(user.role)) {
      return fail(`Odstotek nad ${DISCOUNT_APPROVAL_PERCENT} % zahteva odobritev vodje.`, 403)
    }
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = discountAmountOf(d, subtotal)
    discountName = d.name
    discountId = d.id
    if (d.maxUses != null) quota = { maxUses: d.maxUses }
  } else {
    const type = String(body?.type || '').toLowerCase()
    const val = num(body?.amount)
    if (!['percent', 'fixed'].includes(type)) return fail('Vrsta mora biti percent ali fixed.', 400)
    if (!(val > 0)) return fail('Znesek/odstotek mora biti večji od 0.', 400)
    if (type === 'percent' && val > 100) return fail('Odstotek ne sme presegati 100.', 400)
    // OPS-4: ročni odstotek nad limitom sme samo vodstvo (natakar/sank do limita)
    if (type === 'percent' && val > DISCOUNT_APPROVAL_PERCENT && !isManagerialRole(user.role)) {
      return fail(`Odstotek nad ${DISCOUNT_APPROVAL_PERCENT} % zahteva odobritev vodje.`, 403)
    }
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = type === 'percent' ? r2(Math.min((subtotal * val) / 100, subtotal)) : r2(Math.min(val, subtotal))
    discountName = String(body?.name || 'Ročni popust').trim().slice(0, 120)
  }

  // (#45) VSA validacija PRED porabo kvote — prej je bil končni pregled zneska
  // ZA incrementom currentUses (zavrnjen popust je že porabil kvoto)
  if (amount <= 0) return fail('Popust ima ničelen znesek na tem računu.', 400)
  // (#45) eksplicitna zamenjava: naročilo z obstoječim popustom se ZAVRNE — tiho
  // preiranje (2× porabljena kvota, viden samo zadnji znesek) ni več mogoče;
  // UI zamenjavo izvede eksplicitno (najprej DELETE, nato POST)
  if (num(order.discount) > 0) {
    return fail('Naročilo že ima popust — najprej odstranite obstoječega, nato aplicirajte novega.', 409)
  }

  const previousDiscount = num(order.discount)
  try {
    const applied = await db.$transaction(async (tx) => {
      // 1) kvota (#45): atomaren CAS claim — currentUses < maxUses, v ISTI
      //    transakciji kot sprememba naročila; neuspeh 2./3. koraka → ROLLBACK kvote
      if (quota) {
        const bump = await tx.discount.updateMany({
          where: { id: discountId as string, currentUses: { lt: quota.maxUses } },
          data: { currentUses: { increment: 1 } },
        })
        if (bump.count === 0) throw new DiscountApplyError(409, 'Popust je dosegel omejitev uporabe.')
      }
      // 2) naročilo (#45): CAS na plačljivo stanje + dosedanjo vrednost popusta —
      //    plačilo/storno/preklic ali konkurenčna pripenitev med branjem → 409,
      //    kvota se povrne (rollback transakcije)
      const upd = await tx.order.updateMany({
        where: { id, paymentStatus: { in: PAYABLE }, discount: previousDiscount },
        data: { discount: amount },
      })
      if (upd.count === 0) {
        throw new DiscountApplyError(409, 'Naročilo ni več v plačljivem stanju ali že ima popust — sprememba zavrnjena.')
      }
      // 3) audit v isti transakciji (noben uspeh brez sledi)
      await writeAudit(tx, {
        userId: user.sub,
        action: 'DISCOUNT_APPLIED',
        entityType: 'Order',
        entityId: id,
        details: jstr({ discountId, name: discountName, amount, orderNumber: order.orderNumber, previousDiscount }),
        locationId: order.locationId,
      })
      return amount
    })
    return ok({ discount: applied, discountId, name: discountName })
  } catch (e) {
    if (e instanceof DiscountApplyError) return fail(e.message, e.status)
    throw e
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // N6 popravek (P0 audit): lokacijski gate tudi na odstranjevanju popusta (kot ga ima POST) —
  // prej: natakar lokacije A je lahko odstranil popust naročilu lokacije B
  const delGuard = await guardResource(user, order.locationId)
  if (delGuard) return delGuard
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)
  const previous = num(order.discount)
  try {
    await db.$transaction(async (tx) => {
      // (#45) CAS v SAMEM update-u: plačljivo stanje + dosedanja vrednost —
      // prej: preverba pred ločenim update-om (plačilo medtem bi tiho prepisalo)
      const upd = await tx.order.updateMany({
        where: { id, paymentStatus: { in: PAYABLE }, discount: previous },
        data: { discount: 0 },
      })
      if (upd.count === 0) {
        throw new DiscountApplyError(409, 'Naročilo ni več v plačljivem stanju ali je popust že odstranjen/zamenjan.')
      }
      await writeAudit(tx, {
        userId: user.sub,
        action: 'DISCOUNT_REMOVED',
        entityType: 'Order',
        entityId: id,
        details: jstr({ removedAmount: previous, orderNumber: order.orderNumber }),
        locationId: order.locationId,
      })
    })
    return ok({ removed: true, previous })
  } catch (e) {
    if (e instanceof DiscountApplyError) return fail(e.message, e.status)
    throw e
  }
}
