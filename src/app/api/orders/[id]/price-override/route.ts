import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { fmtEUR } from '@/lib/fmt'
import { mapOrder, num, r2, jstr, ORDER_ACTIVE_DB } from '@/lib/map'
import { recalcOrderTotals } from '@/lib/ops'
import { vatFromGross } from '@/lib/billing'
import { writeAudit } from '@/lib/audit-chain'
import { publishEvent } from '@/lib/events'
import { pushToLocationRoles } from '@/lib/push'
import {
  validatePriceOverrideInput,
  parsePriceOverrideMeta,
  composePriceOverrideMeta,
} from '@/lib/price-override'

/**
 * CENOVNI VAL v1.249.0 (PRIMERJAVA-VMESNIKOV-2026 §23 — Lightspeed junij
 * 2026 »authorized staff can now override an item's price directly on the
 * POS during an active order«) — SPREMEMBA CENE POSTAVKE NA POS.
 *
 * Denarna disciplina (§15/§16 vzorec, oklep preklica Issue #5/#39):
 *  - dovoljenje orders.priceOverride (vodstvo privzeto; natakarju ga lastnik
 *    podeli prek override-a — isto hierarhijo kot orders.void);
 *  - razlog OBVEZEN VEDNO (denarni poseg brez utemeljitve ne obstaja —
 *    strožje od preklica, kjer je obveznost politika excRequireReasonVoid);
 *  - ista cena → 400 (no-op poseg ne smrdi po revizijski sledi);
 *  - PLAČANO/stornirano naročilo → 409; postavka na PLAČANEM IZSTAVKU
 *    delno plačanega naročila → 409 (v1.239.0 §16 D — pre-bran + race-safe
 *    znotraj TX): izdani račun se spreminja SAMO s fiskalnim stornom;
 *  - preklicana postavka → 409 (mrtva vrstica nima cene);
 *  - DDV: cena je končna (z DDV — Naloga #6), zato poseg v isti transakciji
 *    preračuna OrderItem.vatAmount = vatFromGross(novaCena × qty, stopnja);
 *    recalcOrderTotals bere SHRANJENI vatAmount (brez tega bi Order.tax
 *    tiha zaostal za novo ceno);
 *  - OZNAKA: OrderItem.modifiersJson (zgodovinsko mrtva shramba '[]') nosi
 *    {priceOverride:{from,to,at,by}} — 0 DDL; žig na posnetku računa doda
 *    issue.ts ob izdaji (Receipt.itemsJson aditivno);
 *  - Issue #39 atomarnost: CAS claim (id + orderId + voided:false + stara
 *    cena) + recalc + optimistic-concurrency zapis totalov v ENI TX;
 *    audit/dogodek/push ŠLE PO commitu;
 *  - prag odobritve NI vključen (excVoidApprovalAmountCents je specifičen
 *    za preklic; nov prag bi zahteval stolpec = DDL): pooblastilo JE
 *    dovoljenje, ki ga podeljuje lastnik — dokumentirana iskrena meja.
 */

/** #39 oklep: terminalni konflikt (status + sporočilo, brez retryja). */
class PriceConflictError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** #39 oklep: retry-potreben lost-update (rollback + svež poskus; 3× → 409). */
class PriceRetryError extends Error {}

/** #39: prehodne napake transakcije (zaklep/write conflict) — varno ponovljive. */
function isTransientTxError(e: unknown): boolean {
  const code = (e as { code?: string })?.code
  if (code === 'P2024' || code === 'P2028') return true
  return /SQLITE_BUSY|database is locked|write conflict/i.test(String((e as Error)?.message || ''))
}

const MAX_PRICE_ATTEMPTS = 3
/** Issue #48/addItems/void ista bela lista — mutabilna plačilna stanja. */
const PRICE_PAYABLE: ('unpaid' | 'partial')[] = ['unpaid', 'partial']

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.priceOverride')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  const itemId = typeof body?.itemId === 'string' ? body.itemId.trim() : ''
  if (!itemId) return fail('itemId je obvezen.', 400)

  const input = validatePriceOverrideInput(body)
  if (!input.ok) return fail(input.error, 400)

  // hitri pred-brani (prijazna sporočila); avtoritativne preverbe so CAS znotraj transakcije
  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const locGuard = await guardResource(user, order.locationId)
  if (locGuard) return locGuard
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'storno' || order.status === 'cancelled') {
    return fail('Cene na plačanem/storniranem naročilu ni mogoče spremeniti — fiskalni storno je ločena pot.', 409)
  }
  const item = order.OrderItem.find((i) => i.id === itemId)
  if (!item) return fail('Postavka ne pripada temu naročilu.', 404)
  if (item.voided) return fail('Preklicane postavke ni mogoče ceniti.', 409)

  // v1.239.0 §16 D: postavka na ŽE PLAČANEM izstavku delno plačanega naročila
  // (pre-bran prijazen; avtoritativno znotraj TX — rakavec plačila)
  if (item.checkId) {
    const chk = await db.check.findUnique({
      where: { id: item.checkId },
      select: { paymentStatus: true, checkNumber: true },
    })
    if (chk?.paymentStatus === 'paid') {
      return fail(`Postavka je na plačanem izstavku #${chk.checkNumber} — izdani račun se spremeni samo s fiskalnim stornom.`, 409)
    }
  }

  const oldPrice = r2(num(item.price))
  if (input.price === oldPrice) {
    return fail('Nova cena je enaka trenutni — sprememba ni potrebna.', 400)
  }

  // #39 oklep: ena atomska enota — claim postavke + DDV + preračun + zapis zneskov
  let result: { subtotal: number; tax: number; total: number; oldPrice: number; newPrice: number } | null = null
  let tip = 0
  for (let attempt = 1; attempt <= MAX_PRICE_ATTEMPTS; attempt++) {
    try {
      const res = await db.$transaction(async (tx) => {
        // (a) sveža postavka ZNOTRAJ TX — from/cena za CAS in oznako
        const curItem = await tx.orderItem.findUnique({
          where: { id: itemId },
          select: { price: true, vatRate: true, quantity: true, voided: true, orderId: true, checkId: true },
        })
        if (!curItem || curItem.orderId !== id) throw new PriceConflictError(404, 'Postavka ne pripada temu naročilu.')
        if (curItem.voided) throw new PriceConflictError(409, 'Preklicane postavke ni mogoče ceniti.')
        const freshOld = r2(num(curItem.price))
        if (input.price === freshOld) throw new PriceConflictError(400, 'Nova cena je enaka trenutni — sprememba ni potrebna.')
        // (a2) race-safe plačani izstavek (v1.239.0 §16 D — isto kot void)
        if (curItem.checkId) {
          const paidNow = await tx.check.count({ where: { id: curItem.checkId, paymentStatus: 'paid' } })
          if (paidNow > 0) {
            throw new PriceConflictError(409, 'Postavka je na plačanem izstavku — uporabite fiskalni storno.')
          }
        }
        // (b) DDV nove cene (cena je končna z DDV — Naloga #6; qty/stopnja sta
        // immutable po nastanku, a beremo SVEŽE znotraj TX)
        const newVat = vatFromGross(r2(input.price * num(curItem.quantity)), num(curItem.vatRate, 22))
        // (c) CAS prevzem: cena se zapiše SAMO če vrstica še ni preklicana in
        // cena se ni medtem spremenila (dva sočasna posega → retry, ne tiho)
        const claim = await tx.orderItem.updateMany({
          where: { id: itemId, orderId: id, voided: false, price: curItem.price },
          data: {
            price: input.price,
            vatAmount: newVat,
            modifiersJson: composePriceOverrideMeta({
              from: freshOld,
              to: input.price,
              at: new Date().toISOString(),
              by: user.name,
            }),
          },
        })
        if (claim.count === 0) throw new PriceRetryError()
        // (d) preračun po posegu (recalc bere shranjeni vatAmount — novi DDV
        // je zapisan v (c)) + optimistic-concurrency zapis totalov
        const cur = await tx.order.findUnique({
          where: { id },
          select: { subtotal: true, tax: true, total: true, tip: true },
        })
        if (!cur) throw new PriceConflictError(404, 'Naročilo ne obstaja.')
        const next = await recalcOrderTotals(id, tx)
        tip = num(cur.tip)
        const write = await tx.order.updateMany({
          where: {
            id,
            status: { in: ORDER_ACTIVE_DB },
            paymentStatus: { in: PRICE_PAYABLE },
            subtotal: cur.subtotal,
            tax: cur.tax,
            total: cur.total,
          },
          data: { ...next, totalWithTip: r2(next.total + tip) },
        })
        if (write.count === 0) {
          const closed = await tx.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true } })
          if (!closed || !ORDER_ACTIVE_DB.includes(closed.status) || !PRICE_PAYABLE.includes(closed.paymentStatus as 'unpaid' | 'partial')) {
            throw new PriceConflictError(409, 'Cene na plačanem/storniranem naročilu ni mogoče spremeniti — fiskalni storno je ločena pot.')
          }
          throw new PriceRetryError()
        }
        return { ...next, oldPrice: freshOld, newPrice: input.price }
      })
      result = res
      break
    } catch (e) {
      if (e instanceof PriceConflictError) return fail(e.message, e.status)
      if (e instanceof PriceRetryError || isTransientTxError(e)) {
        if (attempt === MAX_PRICE_ATTEMPTS) {
          return fail('Naročilo se je medtem spremenilo (sočasen vnos/popust/preklic) — osvežite in poskusite znova.', 409)
        }
        continue
      }
      throw e
    }
  }
  if (!result) return fail('Spremembe cene ni bilo mogoče izvesti — poskusite znova.', 500)

  const delta = r2((result.newPrice - result.oldPrice) * num(item.quantity))
  const prevMeta = parsePriceOverrideMeta(item.modifiersJson)

  // #39 točka 4: audit/dogodek/push ŠLE PO uspešnem commitu
  await writeAudit(db, {
    userId: user.sub,
    action: 'ORDER_ITEM_PRICE_OVERRIDE',
    entityType: 'OrderItem',
    entityId: itemId,
    details: jstr({
      orderId: id,
      orderNumber: order.orderNumber,
      item: item.menuItemName,
      quantity: Number(item.quantity),
      oldPrice: result.oldPrice,
      newPrice: result.newPrice,
      delta,
      net: true, // razlika NEPLAČANEGA naročila — ni vračilo denarja
      reason: input.reason,
      comment: typeof body?.comment === 'string' ? body.comment.trim().slice(0, 500) || null : null,
      by: user.name,
      ...(prevMeta ? { previousOverride: prevMeta } : {}),
    }),
    locationId: order.locationId,
  })

  // osvežitev plošč: dogodev + push vodstvenim rolam lokacije (kuhinja cene
  // ne vidi — KDS listek je volumen, ne denar)
  await publishEvent('OrderItemPriceOverride', {
    entityType: 'Order',
    entityId: id,
    payload: { itemId, orderNumber: order.orderNumber, by: user.name },
    locationId: order.locationId,
  }).catch(() => undefined)
  pushToLocationRoles(order.locationId, ['manager'], {
    tag: 'ORDER_ITEM_PRICE_OVERRIDE',
    title: `Sprememba cene · naročilo ${order.orderNumber}`,
    body: `${item.menuItemName} (${Number(item.quantity)}×): ${fmtEUR(result.oldPrice)} → ${fmtEUR(result.newPrice)} · ${input.reason}`,
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
    overridden: {
      itemId,
      oldPrice: result.oldPrice,
      newPrice: result.newPrice,
      delta,
      reason: input.reason,
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
