import type { Prisma } from '@prisma/client'
import { num } from '@/lib/map'

/**
 * v1.239.0 (PRIMERJAVA-VMESNIKOV-2026 §16 A) — vedra načinov plačila po VRSTICAH
 * Payment, ne po oznaki Receipt.paymentMethod.
 *
 * Najdba: račun, plačan z MEŠANO (npr. 10 € gotovina + 30 € kartica), je dobil
 * eno samo oznako 'mixed' na Receipt — Z-poročilo izmene je CEL znesek metnilo
 * v »drugo«, gotovinski del (10 €) pa je IZPADAL iz pričakovane gotovine predala
 * → namišljena razlika ob zaključku izmene (lažni presežek/primanjkljaj).
 * Referenca: X/Z izvoz (/api/reports/export section=zz) ŽE agregira po vrsticah
 * Payment (en vrstica na del plačila) — ta helper izenači Z-poročilo, živi
 * pregled premikov, PRE-TX preview variance in dnevni e-poštni povzetek.
 *
 * Toast/Square: način plačila je lastnost DELA plačila, ne računa — split
 * tender (gotovina + kartica + darilna na enem računu) je standard.
 *
 * Storno disciplina:
 *  - novi storni (v1.239.0+) pišejo NEGACIJSKE vrstice Payment (zrcalo z negiranim
 *    amount/tipAmount, isti tip) → v this oknu se neto sami (ni popravka potrebnega);
 *  - legacy storno računi (izdani pred v1.239.0) negacijskih vrstic NISO dobili —
 *    njihovo neto vračamo ročno v vedro izvirnega načina plačila (obseg po
 *    Receipt.checkId, če obstaja, sicer vsi izstavki naročila);
 *  - okno brez VRHU ene vrstice Payment (zgodovina pred uvedbo tabele) → nazaj-
 *    kompatibilna izpeljava po računih (prejšnje obnašanje).
 */

export interface ShiftPaymentBuckets {
  /** gotovinski del prodaje v oknu (neto — negacije vključno) */
  cash: number
  /** kartični del prodaje v oknu (neto) */
  card: number
  /** mobilni del prodaje v oknu (neto) */
  mobile: number
  /** voucher/darilne/zvestoba/ostalo + neznani tipi (neto) */
  alternate: number
  /** število vrstic Payment v oknu (0 → source='receipts' legacy fallback) */
  rowCount: number
  /** 'payments' = po vrsticah (kanonično) · 'receipts' = legacy po računih */
  source: 'payments' | 'receipts'
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Znesek, ki ga še manjka do popolne negacije (centna toleranca). */
const MISSING_EPS = 0.005

export async function shiftPaymentBuckets(
  tx: Prisma.TransactionClient,
  args: { locationId: string; from: Date; to: Date },
): Promise<ShiftPaymentBuckets> {
  const payments = await tx.payment.findMany({
    where: {
      status: 'completed',
      createdAt: { gte: args.from, lt: args.to },
      Check: { Order: { locationId: args.locationId } },
    },
    select: { checkId: true, amount: true, type: true },
    take: 20000,
  })

  // Legacy okno (pred uvedbo vrstic Payment) → vedra po računih (prejšnja logika)
  if (payments.length === 0) {
    const receipts = await tx.receipt.findMany({
      where: { locationId: args.locationId, createdAt: { gte: args.from, lt: args.to } },
      select: { total: true, paymentMethod: true },
      take: 20000,
    })
    let c = 0
    let d = 0
    let m = 0
    let a = 0
    for (const rc of receipts) {
      const amt = num(rc.total) // storno računi so že negativni
      if (rc.paymentMethod === 'cash') c += amt
      else if (rc.paymentMethod === 'card') d += amt
      else if (rc.paymentMethod === 'mobile') m += amt
      else a += amt
    }
    return { cash: r2(c), card: r2(d), mobile: r2(m), alternate: r2(a), rowCount: 0, source: 'receipts' }
  }

  let cash = 0
  let card = 0
  let mobile = 0
  let alternate = 0
  // negacije (amount < 0) po izstavku — za preverbo pokritosti legacy stornov
  const negatedByCheck = new Map<string, number>()
  for (const p of payments) {
    const amt = num(p.amount)
    if (amt < 0) {
      negatedByCheck.set(p.checkId, (negatedByCheck.get(p.checkId) || 0) + Math.abs(amt))
    }
    switch (p.type) {
      case 'cash': cash += amt; break
      case 'card': card += amt; break
      case 'mobile': mobile += amt; break
      // voucher/giftcard/loyalty/alternate → »drugo« (kot doslej)
      default: alternate += amt
    }
  }

  // Legacy storno računi brez negacijskih vrstic → ročna korekcija vetrov
  const stornos = await tx.receipt.findMany({
    where: { locationId: args.locationId, createdAt: { gte: args.from, lt: args.to }, isStorno: true },
    select: { orderId: true, checkId: true, paymentMethod: true, total: true },
    take: 20000,
  })
  if (stornos.length > 0) {
    const stornoOrderIds = [...new Set(stornos.map((s) => s.orderId))]
    const checks = await tx.check.findMany({
      where: { orderId: { in: stornoOrderIds } },
      select: { id: true, orderId: true },
    })
    const checksOfOrder = new Map<string, Set<string>>()
    for (const c of checks) {
      const set = checksOfOrder.get(c.orderId) ?? new Set<string>()
      set.add(c.id)
      checksOfOrder.set(c.orderId, set)
    }
    for (const s of stornos) {
      // obseg storna: per-check (checkId) sicer vsi izstavki naročila
      const scope = s.checkId
        ? new Set([s.checkId])
        : (checksOfOrder.get(s.orderId) ?? new Set<string>())
      let negated = 0
      for (const cid of scope) negated += negatedByCheck.get(cid) || 0
      const missing = Math.abs(num(s.total)) - negated
      if (missing > MISSING_EPS) {
        const amt = -missing
        if (s.paymentMethod === 'cash') cash += amt
        else if (s.paymentMethod === 'card') card += amt
        else if (s.paymentMethod === 'mobile') mobile += amt
        else alternate += amt
      }
    }
  }

  return { cash: r2(cash), card: r2(card), mobile: r2(mobile), alternate: r2(alternate), rowCount: payments.length, source: 'payments' }
}
