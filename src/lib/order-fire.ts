import { db } from '@/lib/db'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { publishEvent } from '@/lib/events'
import { createStationTasksForItems } from '@/lib/station-task-service'
import { ORDER_MUTABLE_STATUS } from '@/lib/ops'

/**
 * v1.241.0 (PRIMERJAVA §16 E točka 3) — SKUPNI HELPER ZA POŽIG NAROČILA.
 *
 * "Požig" (fire) je bil do tega vala dosegljen SAMO prek ročne gumbske poti
 * POST /api/orders/[id]/fire — zato so vsi viri BREZ natakarjevega rokega
 * koraka pristajali kot open/pending in nikoli niso prišli v pripravo:
 *  - QR/kiosk naročilo gosta (POST /api/public/orders) — postajne deske ga
 *    NISO videle (StationTask nastane šele ob požigu), firedAt je ostal null
 *    (ETA/starost statistika je lagala), osebje ni dobilo ORDER_NEW pusha;
 *  - tablica submitCreate — gumb obljublja »Pošlji v pripravo« (tlb.send),
 *    implementacija pa je postavke pustila v pending.
 *
 * Helper je dobesedno izpeljan iz fire rute (P2 audit §57) — ista transakcija,
 * ista varovala, ista idempotenca — samo brez HTTP plasti (avtorizacija in
 * tenant obseg STA odgovornost klicatelja: javna pot reši lokacijo strežniško
 * iz žetona, POS pot ima requireUserLocation/assertOrgScope, fire ruta
 * guardResource).
 *
 * Pravila (nespremenjena iz fire rute):
 *  - terminalno (paid/cancelled) naročilo → 409; zadržano ('hold') → 409
 *    (OSS-4 v1.204.0: zadržano naročilo je parkirano pred kuhinjo);
 *  - idempotentno: order.firedAt ??= now — drugi požig brez courseId vrne
 *    alreadyFired: true BREZ sprememb (postavke, dodane po požigu, pokrije
 *    naslednji klic — v tej iteraciji je požig enkratna akcija odprtega
 *    naročila);
 *  - znotraj transakcije je prevzem firedAt CAS-belolisten
 *    (ORDER_MUTABLE_STATUS) — dirka hold↔fire vrne 409 in ROLLBACKA
 *    postavke/postaje/tečaj;
 *  - courseId (OPS-7 coursing): požig SAMO pending postavk TEGA tečaja
 *    (tečaj pending → fired); veljavnost tečaja preveri klicatelj, helper
 *    zaupa internemu ID-ju in zapiše prehod le ob firedCount > 0;
 *  - vsi ciljni OrderItem s statusom 'pending' (ne-voided) → 'fired' +
 *    firedAt = now; že fired/preparing/ready/served ostanejo nedotaknjeni;
 *  - revizija + dogodek OrderFired (fire-and-forget, če firedCount > 0).
 *
 * POZOR za klicatelje: helper NE pošilja ORDER_FIRE push obvestila — to je
 * odločitev klicatelja (ročna pot ga pošlje; avto-fire ga izpusti, ker je
 * ORDER_NEW push ravno odšel za isto naročilo — dvojni push v isti sekundi
 * je spam).
 */

/** Napaka požiga — status je HTTP koda (404/409/400), sporočilo je SL. */
export class FireOrderError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface FireOrderResult {
  firedCount: number
  stationTasks: number
  alreadyFired: boolean
  /** OPS-7: ime tečaja, če je bil požig po tečaju (za push sporočilo). */
  courseName?: string | null
}

export interface FireOrderOptions {
  /** OPS-7 coursing: požig samo pending postavk tega tečaja. */
  courseId?: string | null
  /** Identiteta za revizijo (null = sistemski/gostovski vir). */
  userId?: string | null
  /** Prikazno ime izvajalca za revizijo (gostovski vir: 'qr'/'kiosk'/…). */
  by?: string | null
  /** Akcija revizije (privzeto ORDER_FIRED; javna pot: GUEST_ORDER_FIRED). */
  auditAction?: string
  /** Dodatni podatki revizije (npr. { autoFire: true, source: 'qr' }). */
  auditExtra?: Record<string, unknown>
}

/** Notranja oznaka dirke hold↔fire (razred + catch zunaj transakcije — vzorec fire rute). */
class HoldRaceError extends Error {}

export async function fireOrderCore(orderId: string, opts: FireOrderOptions = {}): Promise<FireOrderResult> {
  const fireCourseId = opts.courseId && String(opts.courseId).trim() ? String(opts.courseId).trim() : null

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: fireCourseId ? { Course: true } : undefined,
  })
  if (!order) throw new FireOrderError('Naročilo ne obstaja.', 404)
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    throw new FireOrderError('Zaključenega (plačanega/storniranega) naročila ni mogoče poslati na kuhinjo.', 409)
  }
  // OSS-4 (v1.204.0): zadržano naročilo je parkirano pred kuhinjo — najprej nadaljuj.
  if (order.status === 'hold') {
    throw new FireOrderError('Zadržanega naročila ni mogoče poslati na kuhinjo — najprej ga nadaljujte.', 409)
  }
  let courseRow: { id: string; courseNumber: number; name: string; status: string } | null = null
  if (fireCourseId) {
    const c = (order as { Course?: { id: string; courseNumber: number; name: string; status: string }[] }).Course?.find((cc) => cc.id === fireCourseId)
    if (!c) throw new FireOrderError('Tečaj ne obstaja za to naročilo.', 404)
    if (c.status !== 'pending') throw new FireOrderError('Tečaj je že poslan v pripravo.', 409)
    courseRow = c
  }

  // idempotentnost: drugi klic ne sme spremeniti firedAt niti statusov postavk
  // (OPS-7: fire po tečaju je dovoljen tudi, če je order.firedAt že nastavljen —
  //  vsak tečaj ima svoj fire; skupni firedAt ostane prvi)
  if (order.firedAt && !fireCourseId) {
    return { firedCount: 0, stationTasks: 0, alreadyFired: true, courseName: null }
  }

  const now = new Date()
  let firedCount = 0
  let taskCount = 0
  // OSS-4: dirka hold↔fire — prevzem firedAt je CAS-belolisten PRED vsakim
  // zapisom postavk: count 0 = naročilo je med branjem in transakcijo prešlo
  // v 'hold' (ali terminalno stanje) → nič se ne zapiše.
  try {
    await db.$transaction(async (tx) => {
      if (!order.firedAt) {
        const holdClaim = await tx.order.updateMany({
          where: { id: orderId, status: { in: [...ORDER_MUTABLE_STATUS] } },
          data: { firedAt: now },
        })
        if (holdClaim.count === 0) throw new HoldRaceError()
      }
      // Issue #14 (v1.112.0): postavke, ki gredo v pripravo, zajamemo PRED
      // updateMany (isti pogoj) — usmerjanje na postaje (StationTask) se razreši
      // OB FIRE-u: posnetek imen postaj + zaporedje; idempotentno (re-fire tečaja
      // obstoječih (postavka × postaja) ne podvoji).
      const fireWhere = { orderId, status: 'pending' as const, voided: false, ...(fireCourseId ? { courseId: fireCourseId } : {}) }
      const firingItems = await tx.orderItem.findMany({
        where: fireWhere,
        select: {
          id: true, orderId: true, menuItemId: true, menuItemName: true, quantity: true, notes: true,
          OrderItemModifier: { select: { name: true, modifierGroupId: true } },
        },
      })
      const res = await tx.orderItem.updateMany({
        where: fireWhere,
        data: { status: 'fired', firedAt: now },
      })
      firedCount = res.count
      if (firedCount > 0) {
        taskCount = await createStationTasksForItems(tx, {
          locationId: order.locationId,
          orderId,
          items: firingItems,
          firedAt: now,
        })
      }
      if (fireCourseId) {
        if (firedCount === 0) throw new FireOrderError('Tečaj nima postavk za pošiljanje v pripravo.', 400)
        await tx.course.update({ where: { id: fireCourseId }, data: { status: 'fired', firedAt: now } })
      }
      await writeAudit(tx, {
        userId: opts.userId ?? null,
        action: opts.auditAction || 'ORDER_FIRED',
        entityType: 'Order',
        entityId: orderId,
        details: jstr({
          firedItems: firedCount,
          stationTasks: taskCount,
          orderNumber: order.orderNumber,
          by: opts.by ?? null,
          ...(fireCourseId ? { courseId: fireCourseId, courseNumber: courseRow?.courseNumber } : {}),
          ...(opts.auditExtra || {}),
        }),
        locationId: order.locationId,
      })
    })
  } catch (e) {
    if (e instanceof HoldRaceError) {
      throw new FireOrderError('Naročilo je bilo medtem zadržano — pošiljanje na kuhinjo je preklicano.', 409)
    }
    throw e
  }

  if (firedCount > 0) {
    await publishEvent('OrderFired', {
      entityType: 'Order',
      entityId: orderId,
      payload: { orderId, count: firedCount, locationId: order.locationId },
      locationId: order.locationId,
    }).catch(() => undefined)
  }

  return { firedCount, stationTasks: taskCount, alreadyFired: false, courseName: courseRow?.name ?? null }
}
