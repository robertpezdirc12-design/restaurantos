import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, r2, jstr } from '@/lib/map'
import { discountAmountOf } from '@/lib/billing'
import { writeAudit } from '@/lib/audit-chain'
import { exceptionPolicy, percentAboveThreshold, amountAboveThreshold, type ExceptionPolicy } from '@/lib/exception-policy'
import {
  validateExceptionReason,
  resolveExceptionApproval,
  reasonAuditFields,
  approvalAuditFields,
  type ReasonEvidence,
  type ApprovalEvidence,
} from '@/lib/exception-approval'
import { ORDER_MUTABLE_PAYMENT, ORDER_MUTABLE_STATUS } from '@/lib/ops'

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
 *    obstoječi popust, razlog #19, odobritev #19) PRED porabo kvote;
 *  - CAS na naročilu: paymentStatus IN (unpaid, partial) AND discount = prebrana
 *    vrednost — naročilo, ki je medtem plačano/stornirano/preklicano ALI je druga
 *    zahteva že pripela popust, povzroči ROLLBACK kvote (409);
 *  - dve sočasni zahtevi na isto naročilo: natanko ena uspe (CAS), druga 409 —
 *    tiho preiranje zneska ob dvojni porabi kvote ni več mogoče; zamenjava je
 *    EKSPlicitna (najprej DELETE, nato POST).
 *
 * Issue #19 (P1/P2, v1.107.0) — RAZLOG + ODOBRITEV finančne izjeme:
 *  - RAZLOG: ad-hoc popust zahteva razlog VEDNO (ročna izjema); register popust
 *    zahteva razlog, ko politika (excRequireReasonDiscount) ali prag odobritve
 *    to zahtevata — konfigurirana promocija pod pragom ni izjema. Validacija:
 *    katalog VoidReason kind=discount|any (aktiven, lokacija dejanja) ali prosto
 *    besedilo 3–200; POSNETEK razloga v audit sledi (preimenovanje kataloga ne
 *    spremeni zgodovine).
 *  - ODOBRITEV: prag politike (excDiscountApprovalPct privzeto 15 — ohranjena
 *    dosedanja disciplina; excDiscountApprovalAmountCents za fiksne zneske,
 *    privzeto izklopljen). Vodstvena izvajalska vloga = odobritev 'role';
 *    NE-vodstveni izvajalec potrebuje poverilnico DRUGE pooblaščene osebe
 *    (approverEmail + approverPin — ločena identiteta, PIN NIKOLI v auditu).
 *    Odobritev velja SAMO za ta klic (strežnik vsakokrat izračuna prag na novo);
 *    sprememba zneska/postavk znova zahteva potrditev.
 *  - DELETE (odstranitev uporabljenega popusta) je SAMA PO SEBI izjema: obvezen
 *    razlog + DISCOUNT_REMOVED dogodek s posnetkom (issue: »dodaten dogodek z
 *    razlogom; ne prepiši prejšnjega dogodka« — oba dogodka obstajata).
 */

/** OPS-4 (v1.67.0): privzeti zgornji prag odstotka za ne-vodstvene vloge —
 * nadzorovan zdaj prek politike (excDiscountApprovalPct); konstanta ostaja kot
 * dokumentirani privzetek za nazajkompatibilnost. */
export const DISCOUNT_APPROVAL_PERCENT = 15

/** Issue #45: plačljiva stanja naročila za spremembo ročnega popusta (CAS v samem update-u).
 * v1.148.0: SEZNAM NI VEČ KOPIJA — uvožen iz `src/lib/ops.ts`, da je to tisti isti
 * niz, ki ga uporabljata preklic in plačilna pot (addItems ga je prevzel že v #48). */
const PAYABLE = ORDER_MUTABLE_PAYMENT

/** Interni reject (#45) — znotraj $transaction povzroči ROLLBACK (naročilo + kvota). */
class DiscountApplyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Izračun, ali popust presega prag odobritve (politika issue #19). */
function discountNeedsApproval(kind: 'percent' | 'fixed', val: number, amount: number, policy: ExceptionPolicy): boolean {
  return kind === 'percent'
    ? percentAboveThreshold(val, policy)
    : amountAboveThreshold(amount, policy.discountApprovalAmountCents)
}

/** Osnova za approvalBasis v auditu (kaj je sprožilo odobritev). */
function approvalBasisOf(kind: 'percent' | 'fixed', val: number, amount: number, policy: ExceptionPolicy): string {
  return kind === 'percent'
    ? `percent ${val} > ${policy.discountApprovalPct}`
    : `amount ${amount.toFixed(2)} > ${(policy.discountApprovalAmountCents / 100).toFixed(2)}`
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
  /** 'register' (katalog promocij) | 'adhoc' (ročni vnos) — odloča obveznost razloga. */
  let source: 'register' | 'adhoc' = 'register'
  /** Odločitveni podatki za prag odobritve (vrsta + vhodna vrednost). */
  let thresholdKind: 'percent' | 'fixed' = 'percent'
  let thresholdVal = 0

  if (body?.discountId) {
    const d = await db.discount.findUnique({ where: { id: String(body.discountId) } })
    if (!d || !d.isActive) return fail('Popust ne obstaja ali ni aktiven.', 404)
    if (d.locationId !== order.locationId) return fail('Popust ni za to lokacijo.', 400)
    if (d.triggerType === 'auto') return fail('Avtomatski popust (Happy Hour) se uporabi samodejno ob plačilu.', 400)
    // veljavnost
    if (d.validFrom && d.validFrom > now) return fail('Popust še ni veljaven.', 400)
    if (d.validTo && d.validTo < now) return fail('Popust je pretekel.', 400)
    if (d.maxUses != null && d.currentUses >= d.maxUses) return fail('Popust je dosegel omejitev uporabe.', 409)
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = discountAmountOf(d, subtotal)
    discountName = d.name
    discountId = d.id
    if (d.maxUses != null) quota = { maxUses: d.maxUses }
    source = 'register'
    thresholdKind = d.type === 'percent' ? 'percent' : 'fixed'
    thresholdVal = num(d.amount)
  } else {
    const type = String(body?.type || '').toLowerCase()
    const val = num(body?.amount)
    if (!['percent', 'fixed'].includes(type)) return fail('Vrsta mora biti percent ali fixed.', 400)
    if (!(val > 0)) return fail('Znesek/odstotek mora biti večji od 0.', 400)
    if (type === 'percent' && val > 100) return fail('Odstotek ne sme presegati 100.', 400)
    const subtotal = r2(order.OrderItem.reduce((s, it) => s + num(it.price) * it.quantity, 0))
    amount = type === 'percent' ? r2(Math.min((subtotal * val) / 100, subtotal)) : r2(Math.min(val, subtotal))
    discountName = String(body?.name || 'Ročni popust').trim().slice(0, 120)
    source = 'adhoc'
    thresholdKind = type === 'percent' ? 'percent' : 'fixed'
    thresholdVal = val
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

  // ── Issue #19: politika → ODOBRITEV (avtorizacija) → razlog (ZA preverbami
  // stanja, PRED tx). Vrstni red je pomemben: zavrnitev odobritve (403) je
  // avtorizacijska odločitev in ima prednost pred zahtevo razloga (400). ──
  const policy = await exceptionPolicy()
  const needsApproval = discountNeedsApproval(thresholdKind, thresholdVal, amount, policy)
  const reasonRequired = source === 'adhoc' || policy.requireReasonDiscount || needsApproval

  let approval: ApprovalEvidence | null = null
  let approvalBasis: string | null = null
  if (needsApproval) {
    approvalBasis = approvalBasisOf(thresholdKind, thresholdVal, amount, policy)
    const a = await resolveExceptionApproval(user, order.locationId, body)
    if (!a.ok) return fail(a.message, a.status)
    approval = a.approval
  }

  let reason: ReasonEvidence | null = null
  if (reasonRequired) {
    const r = await validateExceptionReason('discount', order.locationId, body)
    if (!r.ok) return fail(r.message, r.status)
    reason = r.reason
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
      //    plačilo/storno/preklic ali konkurenčno pripenjanje med branjem → 409,
      //    kvota se povrne (rollback transakcije).
      //    v1.148.0: pogoj ima tudi `status`, ker samo plačilno stanje NE vidi
      //    združitve in preklica, ki na viru PUSTITA paymentStatus 'unpaid' —
      //    ročni popust se je zato lahko pripel naročilu, ki ga v toku ni več.
      const upd = await tx.order.updateMany({
        where: { id, status: { in: [...ORDER_MUTABLE_STATUS] }, paymentStatus: { in: [...PAYABLE] }, discount: previousDiscount },
        data: { discount: amount },
      })
      if (upd.count === 0) {
        throw new DiscountApplyError(409, 'Naročilo ni več v plačljivem stanju ali že ima popust — sprememba zavrnjena.')
      }
      // 3) audit v isti transakciji (noben uspeh brez sledi) — #19: razlog + odobritev
      await writeAudit(tx, {
        userId: user.sub,
        action: 'DISCOUNT_APPLIED',
        entityType: 'Order',
        entityId: id,
        details: jstr({
          discountId,
          name: discountName,
          source,
          amount,
          orderNumber: order.orderNumber,
          previousDiscount,
          by: user.name,
          ...reasonAuditFields(reason ?? { reasonId: null, reasonName: null, reasonText: null, comment: null }),
          ...approvalAuditFields(approval, approvalBasis),
        }),
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
  // #19: telo nosi razlog odstranitve (obvezna izjema). Vrstni red: stanje →
  // razlog → tx (negativne preverbe ostanejo pred zahtevo razloga).
  const body = await req.json().catch(() => null)
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // N6 popravek (P0 audit): lokacijski gate tudi na odstranjevanju popusta (kot ga ima POST) —
  // prej: natakar lokacije A je lahko odstranil popust naročilu lokacije B
  const delGuard = await guardResource(user, order.locationId)
  if (delGuard) return delGuard
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.', 409)
  const previous = num(order.discount)

  // Issue #19: odstranitev uporabljenega popusta je finančna izjema → obvezen razlog
  const r = await validateExceptionReason('discount_remove', order.locationId, body)
  if (!r.ok) return fail(r.message, r.status)

  try {
    await db.$transaction(async (tx) => {
      // (#45) CAS v SAMEM update-u: plačljivo stanje + dosedanja vrednost —
      // prej: preverba pred ločenim update-om (plačilo medtem bi tiho prepisalo).
      // v1.148.0: tudi tu `status`, da odstranitev popusta ne zadenje združenega
      // ali preklicanega naročila (na viru ostane paymentStatus 'unpaid').
      const upd = await tx.order.updateMany({
        where: { id, status: { in: [...ORDER_MUTABLE_STATUS] }, paymentStatus: { in: [...PAYABLE] }, discount: previous },
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
        details: jstr({
          removedAmount: previous,
          orderNumber: order.orderNumber,
          by: user.name,
          ...reasonAuditFields(r.reason),
        }),
        locationId: order.locationId,
      })
    })
    return ok({ removed: true, previous })
  } catch (e) {
    if (e instanceof DiscountApplyError) return fail(e.message, e.status)
    throw e
  }
}
