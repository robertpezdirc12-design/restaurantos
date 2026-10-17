import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, num, r2, jstr, ORDER_ACTIVE_DB } from '@/lib/map'
import { recalcOrderTotals } from '@/lib/ops'
import { writeAudit } from '@/lib/audit-chain'
import { publishEvent } from '@/lib/events'
import { pushToLocationRoles } from '@/lib/push'
import { exceptionPolicy, amountAboveThreshold } from '@/lib/exception-policy'
import { resolveExceptionApproval, reasonAuditFields, approvalAuditFields, type ApprovalEvidence } from '@/lib/exception-approval'

/**
 * Issue #5 (komentar #3 — P0 funkcionalna vrzel): PREKLIC POSAMEZNE POSTAVKE.
 *
 * `orders.void` dovoljenje + `OrderItem.voided`/`voidReasonId` + `VoidReason`
 * katalog obstajajo v shemi od N3/OPS-4, a BREZ poti (dovoljenje nikoli
 * uveljavljeno, VoidReason nikoli sejdan). Toast vzorec: preklic zahteva
 * pooblastilo + RAZLOG.
 *
 * Pravila:
 *  - dovoljenje orders.void (vodstvo; natakar ne more — gumb vidi samo
 *    pooblaščeni);
 *  - razlog OBVEZEN: reasonId (katalog VoidReason: aktiven, ista lokacija/org)
 *    ALI reason besedilo (3–200 znakov — shranjeno v audit sledi);
 *  - PLAČANO/stornirano naročilo → 409 (fiskalni storno/vračilo je LOČENA
 *    kanonična pot /api/receipts/[id]/storno — izdanih računov ne spreminjamo);
 *  - zaloga: razknjižba teče ob FURS izstavitvi SAMO za izstavljene postavke
 *    (deductStockForOrderTx onlyItemIds + billing voided filter) — preklic pred
 *    plačilom pomeni, da se postavka nikoli ne razknjiži (brez popravkov);
 *  - KDS: kuhinjski GET filtrira voided: false + aktivne statuse → preklicana
 *    postavka IZGINE iz vrste; osebje obvestimo prek dogodka + pusha.
 *
 * Issue #39 (P1) — ATOMARNOST + lost-update zaščita (prej: ločeni koraki
 * updateMany-claim → recalcOrderTotals BREZ tx → ločen order.update; padec po
 * CAS-u je pustil preklicano postavko s STARIMI zneski, sočasna voida/addItems
 * pa sta si lahko tiho prepisala totale):
 *  1. CAS claim, razlog, preračun in zapis Order.subtotal/tax/total/
 *     totalWithTip so zdaj ENA DB transakcija — padec katerega koli koraka
 *     povrne tudi voided/voidReasonId (ni polovičnega stanja);
 *  2. CAS veže itemId NA orderId (`where: { id, orderId, voided: false }`) —
 *     identiteta postavke se preveri tudi v sami mutaciji, ne samo v pre-branju;
 *  3. optimistic-concurrency CAS na zapisu naročila: zneski se zapišejo SAMO,
 *     če so v vrstici še vedno vrednosti, ki smo jih prebrali ZNOTRAJ
 *     transakcije (status whitelist + paymentStatus unpaid/partial + prejšnji
 *     subtotal/tax/total). Sočasen void/addItems/popust, ki je medtem
 *     Committiral, povzroči rollback + ponovitev (≤3) — dva sočasna preklica
 *     RAZLIČNIH postavk torej OBETA uspešno izvedeta, končni zneski pa točno
 *     ustrezajo preostalim postavkam; vztrajen konflikt → 409 (uporabnik
 *     osveži in ponovi). Navadna transakcija brez tega ščita pod READ COMMITTED
 *     (PostgreSQL/Neon) NI dovolj — recalc druge transakcije ne vidi nepotrjenega
 *     claima, zadnji zapis bi tiho prepisal novejše zneske;
 *  4. audit/dogodek/push šele PO uspešnem commitu (kuhinja ne dobi obvestila o
 *     preklicu, ki je bil razveljavljen);
 *  5. Issue #39 semantika: odgovor/audit nosita `amountRemovedFromOrder`
 *     (KONČNI znesek, ki ga gost ne plača več: qty × cena − popust vrstice;
 *     DDV je v ceni že vsebovan), NE `refund` — vračilo denarja/fiskalni
 *     storno sta ločeni poti.
 */

/** #39: terminalni konflikt (vračamo status + sporočilo, brez retryja). */
class VoidConflictError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** #39: retry-potreben lost-update (rollback + svež poskus; 3× → 409). */
class VoidRetryError extends Error {}

/**
 * #39: prehodne napake transakcije (zaklep/write conflict) — tudi te so varno
 * ponovljive: celoten poskus se je povrnil (rollback), claim/razlog/zneski so
 * nedotaknjeni. Pokriva SQLITE_BUSY (dev) in P2024/P2028 (Prisma timeouti).
 */
function isTransientTxError(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  if (code === 'P2024' || code === 'P2028') return true
  return /SQLITE_BUSY|database is locked|write conflict/i.test(String((e as Error)?.message || ''))
}

const MAX_VOID_ATTEMPTS = 3
/** Issue #48/addItems ista bela lista — mutabilna stanja naročila za zapis zneskov. */
const VOID_PAYABLE: ('unpaid' | 'partial')[] = ['unpaid', 'partial']

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.void')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : ''
  if (!itemId) return fail('itemId je obvezen.', 400)
  const reasonId = typeof body?.reasonId === 'string' ? body.reasonId.trim() : ''
  const reasonText = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : ''

  // Issue #19 (v1.107.0): obveznost razloga je politika (excRequireReasonVoid,
  // privzeto TRUE — ohranja dosedanjo obveznost preklica postavke)
  const policy = await exceptionPolicy()
  if (policy.requireReasonVoid && !reasonId && reasonText.length < 3) {
    return fail('Razlog preklica je obvezen (izberi iz seznama ali vpiši vsaj 3 znake).', 400)
  }

  // hitri pred-brani (prijazna sporočila); avtoritativne preverbe so CAS znotraj transakcije
  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const locGuard = await guardResource(user, order.locationId)
  if (locGuard) return locGuard
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'storno' || order.status === 'cancelled') {
    return fail('Plačanega/storniranega naročila ni mogoče preklicati po postavkah — fiskalni storno je ločena pot.', 409)
  }
  const item = order.OrderItem.find((i) => i.id === itemId)
  if (!item) return fail('Postavka ne pripada temu naročilu.', 404)
  if (item.voided) return fail('Postavka je že preklicana.', 409)

  // katalog razlogov: aktiven + LOKACIJA/org guard (tuji katalog zavrnjen)
  let reason: { id: string; name: string } | null = null
  if (reasonId) {
    const row = await db.voidReason.findUnique({ where: { id: reasonId } })
    if (!row || !row.isActive) return fail('Razlog preklica ne obstaja ali ni aktiven.', 400)
    const rGuard = await guardResource(user, row.locationId)
    if (rGuard) return rGuard
    reason = { id: row.id, name: row.name }
  }

  // NETO zmanjšanje vrednosti neplačanega naročila (qty × price − popust vrstice)
  const amountRemovedFromOrder = r2(num(item.quantity) * num(item.price) - num(item.discountAmount || 0))

  // Issue #19: prag odobritve za preklic (excVoidApprovalAmountCents; privzeto
  // 0 = izklopljen — dovoljenje orders.void je že vodstveno). Če je prag aktiven
  // in ga vrednost presega, NE-vodstveni izvajalec rabi poverilnico DRUGE
  // pooblaščene osebe (ločena identiteta; PIN nikoli v auditu).
  const voidNeedsApproval = amountAboveThreshold(amountRemovedFromOrder, policy.voidApprovalAmountCents)
  let voidApproval: ApprovalEvidence | null = null
  let voidApprovalBasis: string | null = null
  if (voidNeedsApproval) {
    voidApprovalBasis = `amount ${amountRemovedFromOrder.toFixed(2)} > ${(policy.voidApprovalAmountCents / 100).toFixed(2)}`
    const a = await resolveExceptionApproval(user, order.locationId, body)
    if (!a.ok) return fail(a.message, a.status)
    voidApproval = a.approval
  }

  // #39: ena atomska enota — claim postavke + preračun + zapis zneskov
  let totals: { subtotal: number; tax: number; total: number } | null = null
  let tip = 0
  for (let attempt = 1; attempt <= MAX_VOID_ATTEMPTS; attempt++) {
    try {
      const res = await db.$transaction(async (tx) => {
        // (a) sveže stanje ZNOTRAJ transakcije — optimistični predpis za CAS zapis
        const cur = await tx.order.findUnique({
          where: { id },
          select: { subtotal: true, tax: true, total: true, tip: true },
        })
        if (!cur) throw new VoidConflictError(404, 'Naročilo ne obstaja.')
        // (b) CAS prevzem: prvi poskus prekliče (podvojen klik → 0 vrstic → 409);
        // itemId je VEZAN na orderId — mutacija ne more zadeti tuje postavke
        const claim = await tx.orderItem.updateMany({
          where: { id: itemId, orderId: id, voided: false },
          data: { voided: true, ...(reason ? { voidReasonId: reason.id } : {}) },
        })
        if (claim.count === 0) throw new VoidConflictError(409, 'Postavka je že preklicana.')
        // (c) preračun po claimu, v isti transakciji (obstoječa kanonična formula)
        const next = await recalcOrderTotals(id, tx)
        // (d) optimistic-concurrency zapis: zgolj če se stanje/znosni niso
        // spremenili med (a) in (d), se zapišejo novi zneski (totalWithTip
        // ostane skladen: total + tip)
        tip = num(cur.tip)
        const write = await tx.order.updateMany({
          where: {
            id,
            status: { in: ORDER_ACTIVE_DB },
            paymentStatus: { in: VOID_PAYABLE },
            subtotal: cur.subtotal,
            tax: cur.tax,
            total: cur.total,
          },
          data: { ...next, totalWithTip: r2(next.total + tip) },
        })
        if (write.count === 0) {
          // ločena vzroka: naročilo je medtem zaprlo (terminalni 409) ALI je
          // sočasna mutacija Committirala nove zneske (lost-update → retry)
          const closed = await tx.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true } })
          if (!closed || !ORDER_ACTIVE_DB.includes(closed.status) || !VOID_PAYABLE.includes(closed.paymentStatus as 'unpaid' | 'partial')) {
            throw new VoidConflictError(409, 'Plačanega/storniranega naročila ni mogoče preklicati po postavkah — fiskalni storno je ločena pot.')
          }
          throw new VoidRetryError()
        }
        return next
      })
      totals = res
      break
    } catch (e) {
      if (e instanceof VoidConflictError) return fail(e.message, e.status)
      if (e instanceof VoidRetryError || isTransientTxError(e)) {
        // zadnji poskus je porabil vse retryje → izrecni 409 (uporabnik osveži)
        if (attempt === MAX_VOID_ATTEMPTS) {
          return fail('Naročilo se je medtem spremenilo (sočasen vnos/popust/preklic) — osvežite in poskusite znova.', 409)
        }
        continue
      }
      throw e
    }
  }
  if (!totals) return fail('Preklica ni bilo mogoče izvesti — poskusite znova.', 500)

  // #39 točka 4: audit/push/dogodek ŠELE PO uspešnem commitu — #19: razlog
  // (posnetek, enoten zapis) + odobritev (če je prag aktiven)
  await writeAudit(db, {
    userId: user.sub,
    action: 'ORDER_ITEM_VOID',
    entityType: 'OrderItem',
    entityId: itemId,
    details: jstr({
      orderId: id,
      orderNumber: order.orderNumber,
      item: item.menuItemName,
      quantity: Number(item.quantity),
      amountRemovedFromOrder,
      net: true, // zmanjšanje NEPLAČANEGA naročila — ni vračilo denarja
      by: user.name,
      ...reasonAuditFields({
        reasonId: reason?.id ?? null,
        reasonName: reason?.name ?? null,
        reasonText: reasonText || null,
        comment: typeof body?.comment === 'string' ? body.comment.trim().slice(0, 500) || null : null,
      }),
      ...approvalAuditFields(voidApproval, voidApprovalBasis),
    }),
    locationId: order.locationId,
  })

  // KDS osvežitev: dogodek + direkten push kuhinjskim/vodstvenim vlogam lokacije
  await publishEvent('OrderItemVoided', {
    entityType: 'Order',
    entityId: id,
    payload: { itemId, orderNumber: order.orderNumber, by: user.name },
    locationId: order.locationId,
  }).catch(() => undefined)
  pushToLocationRoles(order.locationId, ['chef', 'kitchen', 'bar', 'manager'], {
    tag: 'ORDER_ITEM_VOID',
    title: `Preklic postavke · naročilo ${order.orderNumber}`,
    body: `${item.menuItemName} (${Number(item.quantity)}×) preklicana${reason ? ` · ${reason.name}` : ''}`,
  })

  const fresh = await db.order.findUnique({
    where: { id },
    include: {
      OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } },
      Table: true,
      Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
    },
  })
  return ok({
    voided: {
      itemId,
      // #39: nedvoumen izraz — zmanjšanje vrednosti neplačanega naročila
      // (NETO: brez davka; vračilo denarja/fiskalni storno = ločeni poti)
      amountRemovedFromOrder,
      reason: reason?.name || reasonText || null,
    },
    order: fresh
      ? mapOrder({
          ...fresh,
          items: fresh.OrderItem,
          table: fresh.Table,
          employee: fresh.Employee_Order_employeeIdToEmployee,
        } as Parameters<typeof mapOrder>[0])
      : null,
  })
}
