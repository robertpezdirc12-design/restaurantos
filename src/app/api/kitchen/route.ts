import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import type { OrderItemStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, mapOrderItem, itemStatusToDB, orderStatusToUI, ORDER_ACTIVE_DB, ITEM_ACTIVE_DB, nid, jstr } from '@/lib/map'
import { stationOf } from '@/lib/kds-stats'
import { publishEvent } from '@/lib/events'
import { pushEvent, pushToEmployees } from '@/lib/push'
import { auditChainFields, writeAudit } from '@/lib/audit-chain'
import { KDS_DELAY_ACTION, computePrepMin, delayThresholdForTarget, isLatePrep, isValidDelayReason, kdsDelayDetails } from '@/lib/kds-delays'
import { isMissingSchemaError } from '@/lib/prisma-missing'
import { taskTransitionFrom, stationViewKey } from '@/lib/kds-station-routing'
import { rollupItemStatusFromTasks, completeTasksForItem, tasksForItem } from '@/lib/station-task-service'

const ITEM_ACTIVE_PRISMA = ITEM_ACTIVE_DB as OrderItemStatus[]

type KitchenOrder = Prisma.OrderGetPayload<{
  include: {
    Table: true
    OrderItem: { include: { MenuItem: { include: { PrepStation: true } } } }
  }
}>

/**
 * Issue #5 (P0 §C + komentar #2): prej requireAuth — KDS vrsta je bila vidna vsakemu
 * prijavljenemu (vključno s čistilko). Zdaj kitchen.update (kuhinja/šank/vodstvo;
 * natakar sledi statusom prek /api/orders — ločena pravica od spremembe statusa).
 * + ?station=KITCHEN|BAR: STREŽNIŠKI filter postaje (issue: omejitev postaje mora biti
 * uveljavljena na strežniku, ne samo UI filter). Postaja = PrepStation.type 'bar' → BAR,
 * vse ostalo (tudi brez postaje) → KITCHEN.
 *
 * Issue #14 (P1/P2, v1.112.0) — DODATNA (additive) polja za poimenovane postaje:
 *  - stations: aktivne postaje lokacije (id/name/type/isExpo/avgPrepTime/sortOrder) —
 *    desk jih uporabi za izbirnik pogledov; legacy BAR/KITCHEN tipa se preslikata v
 *    vedri (stationViewKey), vsak drug tip dobi svoj pogled;
 *  - tasks: AKTIVNE postajne naloge (waiting/pending/preparing/ready; 'done' zapusti
 *    desk) s posnetki postaj, strežniško filtrirane po ?station= (bucket ALBO id
 *    postaje — določitev postaje je strežniško preverjena, issue §2);
 *  - stationStats: vrsta/čakalna doba PO postaji (waiting/pending/preparing/ready +
 *    target) — ločena uspešnost/obremenitev vsake postaje (issue §4).
 * Pred DDL (migrate-kds-stations) se vsa tri polja tiho izpraznijo — queue in
 * stationTargets ostaneta točno takšna, kot sta bila (graceful degradacija).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const stationParam = new URL(req.url).searchParams.get('station')
  const stationFilter = stationParam === 'BAR' || stationParam === 'KITCHEN' ? stationParam : null
  const scope = await locationScope(user)
  const orders = await db.order.findMany({
    where: { ...scope, status: { in: ORDER_ACTIVE_DB }, OrderItem: { some: { status: { in: ITEM_ACTIVE_PRISMA } } } },
    include: {
      Table: true,
      OrderItem: {
        where: { status: { in: ITEM_ACTIVE_PRISMA }, voided: false },
        orderBy: { createdAt: 'asc' },
        include: { MenuItem: { include: { PrepStation: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  }) as unknown as KitchenOrder[]

  const mapped = orders.map((o) => ({
    ...mapOrder({ ...o, items: o.OrderItem, table: o.Table, employee: null }),
    items: o.OrderItem.map((it) =>
      mapOrderItem({ ...it, menuItem: it.MenuItem ? { prepStation: it.MenuItem.PrepStation } : undefined })
    ),
  }))
  // strežniški station filter (issue #5 §C: postaja na strežniku): KDS vrsta naprave
  // dobi SAMO svojo postajo; brez parametra ostane celotna vrsta (kuhinjski tab ALL)
  const queue = stationFilter
    ? mapped
        .map((o) => ({ ...o, items: o.items.filter((it) => (it.station || 'KITCHEN') === stationFilter) }))
        .filter((o) => o.items.length > 0)
    : mapped
  // OPS-11 val 1 (v1.80.0): per-station delay targets — PrepStation.avgPrepTime mapped onto
  // the two KDS buckets (stationOf), first active station per bucket wins (mirrors the
  // /api/kitchen/stats reading pattern). ADDITIVE response key — the queue shape is untouched;
  // a null bucket means "no active station" → the client falls back to the global 10 min.
  const prepStations = await db.prepStation.findMany({
    where: { isActive: true, ...scope },
    select: { type: true, avgPrepTime: true, sortOrder: true, name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  const stationTargets: { BAR: number | null; KITCHEN: number | null } = { BAR: null, KITCHEN: null }
  for (const ps of prepStations) {
    const bucket = stationOf(ps.type) as 'BAR' | 'KITCHEN'
    if (stationTargets[bucket] === null) stationTargets[bucket] = ps.avgPrepTime
  }

  // ── Issue #14 (v1.112.0): poimenovane postaje + naloge (additive; pre-DDL → []) ──
  let stations: { id: string; name: string; type: string; isExpo: boolean; sortOrder: number; avgPrepTime: number }[] = []
  let tasks: Record<string, unknown>[] = []
  let stationStats: Record<string, unknown>[] = []
  try {
    stations = await db.prepStation.findMany({
      where: { isActive: true, ...scope },
      select: { id: true, name: true, type: true, isExpo: true, sortOrder: true, avgPrepTime: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    // Naloge se vračajo VSE aktivne (lokacijsko obsegovane — RBAC plast);
    // po-stajni VIEW filter je klientski (desk za expo potrebuje sorojene
    // naloge za sinhronizacijski status; sama določitev postaje je strežniško
    // razrešena ob FIRE-u — issue §2). Legacy ?station= filter ostaja na vrsti.
    const taskWhere: Prisma.StationTaskWhereInput = {
      locationId: scope.locationId,
      status: { in: ['waiting', 'pending', 'preparing', 'ready'] },
    }
    const rows = await db.stationTask.findMany({ where: taskWhere, orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] })
    if (rows.length > 0) {
      const orderRows = await db.order.findMany({
        where: { id: { in: [...new Set(rows.map((t) => t.orderId))] } },
        select: { id: true, orderNumber: true, type: true, Table: { select: { number: true } } },
      })
      const orderById = new Map(orderRows.map((o) => [o.id, o]))
      tasks = rows.map((t) => {
        const o = orderById.get(t.orderId)
        return {
          id: t.id,
          itemId: t.orderItemId,
          orderId: t.orderId,
          orderNumber: o?.orderNumber ?? null,
          tableNumber: o?.Table?.number ?? null,
          orderType: o?.type ?? 'dine-in',
          stationId: t.stationId,
          stationName: t.stationName,
          stationType: t.stationType,
          viewKey: stationViewKey({ id: t.stationId, type: t.stationType }),
          kind: t.kind,
          sequence: t.sequence,
          status: t.status,
          title: t.title,
          detail: t.detail,
          quantity: t.quantity,
          firedAt: t.firedAt,
          startedAt: t.startedAt,
          readyAt: t.readyAt,
          issuedAt: t.issuedAt,
          readyByName: t.readyByName,
        }
      })
    }
    // statistika po postaji (vrsta/obremenitev — issue §4); vse postaje, ne samo filtrirana
    const statRows = await db.stationTask.findMany({
      where: { locationId: scope.locationId, status: { in: ['waiting', 'pending', 'preparing', 'ready'] } },
      select: { stationId: true, stationName: true, status: true, kind: true },
    })
    const byStation = new Map<string, { stationId: string; stationName: string; waiting: number; pending: number; preparing: number; ready: number }>()
    for (const r of statRows) {
      const cur = byStation.get(r.stationId) ?? { stationId: r.stationId, stationName: r.stationName, waiting: 0, pending: 0, preparing: 0, ready: 0 }
      if (r.status === 'waiting' || r.status === 'pending' || r.status === 'preparing' || r.status === 'ready') cur[r.status] += 1
      byStation.set(r.stationId, cur)
    }
    stationStats = [...byStation.values()].map((s) => ({
      ...s,
      target: stations.find((st) => st.id === s.stationId)?.avgPrepTime ?? null,
    }))
  } catch (e) {
    if (!isMissingSchemaError(e)) throw e
    // DDL pending (produkcija pred migrate-kds-stations) — additive polja izpraznjena,
    // queue + stationTargets ostaneta nespremenjena (graceful degradacija)
  }
  return ok({ queue, stationTargets, stations, tasks, stationStats })
}

/** Skupni order-rollup po spremembi statusa postavke (legacy + postajni tok). */
async function applyOrderRollup(item: { orderId: string; id: string; menuItemName: string }, user: { sub: string; name: string }) {
  const remaining = await db.orderItem.count({ where: { orderId: item.orderId, status: { in: ['pending', 'fired', 'preparing'] } } })
  if (remaining === 0) {
    await db.order.update({ where: { id: item.orderId }, data: { status: 'prepared' } })
    const doneOrder = await db.order.findUnique({ where: { id: item.orderId }, select: { orderNumber: true, locationId: true, employeeId: true } })
    // Issue #11 §3 — kuhinja zaključena (vsi artikli ready)
    // Issue #38: locationId iz prebranega naročila (verifikovan vir, ne klient)
    await publishEvent('KitchenCompleted', { entityType: 'Order', entityId: item.orderId, payload: { itemId: item.id, by: user.name }, locationId: doneOrder?.locationId ?? null }).catch(() => undefined)
    // OPS-7 (v1.70.0) push to waiters/management; OPS-8 (v1.72.0) via notification matrix
    // (fire-and-forget; no rules = same behavior as before). Push to the order author goes
    // DIRECTLY (pushToEmployees) on purpose — personal notification, not a matrix event.
    if (doneOrder) {
      void pushEvent('ORDER_READY', {
        title: 'Naročilo pripravljeno',
        body: `#${doneOrder.orderNumber ?? ''} — ${item.menuItemName ?? 'postavke'}`,
        url: '/dashboard?tab=mize',
        tag: `ready-${item.orderId}`,
      }, { roles: ['waiter', 'staff', 'manager'], locationId: doneOrder.locationId })
      if (doneOrder.employeeId) pushToEmployees([doneOrder.employeeId], {
        title: 'Naročilo pripravljeno',
        body: `#${doneOrder.orderNumber ?? ''} — ${item.menuItemName ?? 'postavke'}`,
        url: '/dashboard?tab=mize',
        tag: `ready-${item.orderId}`,
      })
    }
  }
  else await db.order.updateMany({ where: { id: item.orderId, status: 'open' }, data: { status: 'sent' } })
}

/** Izhod postajne transakcije (enoten tudi za napake — isti vzorec kot manager-call). */
type TaskOutcome = {
  status: number
  message?: string
  task?: unknown
  blockedBy?: { stationName: string; status: string }[]
  already?: boolean
  itemStatus?: string | null
  orderId?: string
  orderItemId?: string
  title?: string
}

/**
 * PATCH /api/kitchen — dve poti (issue #14):
 *  A) POSTAJNA NALOGA: {taskId, action: 'start'|'ready'|'issue', delayReason?}
 *     - start: waiting/blocked → 409 (z blokirniki); pending → preparing (CAS)
 *     - ready: pending/preparing → ready + žigi (CAS; replay istega stanja → 200)
 *     - issue: SAMO izdajna naloga (kind expo) po končani pripravi → done +
 *       postavka 'served' (zapusti desko) — 409 sicer
 *     - vse transakcijsko + idempotentno (sočasna klika → en zaključek, issue §4)
 *  B) LEGACY: {itemId, status: PENDING|PREPARING|READY|SERVED, delayReason?}
 *     - če postavka IMA postajne naloge: SERVED dovoljen (ko so naloge končane —
 *       spravi vse v done); ostali statusi → 409 (postavka upravlja postajni tok)
 *     - sicer: nespremenjeno zgodovinsko vedenje
 */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)

  /* ── A) postajna naloga ── */
  if (body?.taskId) {
    const action = String(body.action ?? '')
    const transition = taskTransitionFrom(action as 'start' | 'ready' | 'issue')
    if (!transition) return fail('taskId zahteva action: start | ready | issue.')
    const delayReason = isValidDelayReason(body.delayReason) ? body.delayReason : null

    const task = await db.stationTask.findUnique({ where: { id: body.taskId } })
    if (!task) return fail('Postajna naloga ne obstaja.', 404)
    // tenant varovalka (issue §4): naloga tuje lokacije → 403
    const locRes = await guardResource(user, task.locationId)
    if (locRes) return locRes
    if (action === 'issue' && task.kind !== 'expo') {
      return fail('Izdaja je dovoljena samo na izdajni postaji.', 409)
    }

    const outcome: TaskOutcome = await db.$transaction(async (tx): Promise<TaskOutcome> => {
      // ponovni IN-TX branje: sočasnost + zaporedne varovalke (issue §4)
      const fresh = await tx.stationTask.findUnique({ where: { id: task.id } })
      if (!fresh) return { status: 404, message: 'Postajna naloga ne obstaja.' }
      const siblings = await tx.stationTask.findMany({
        where: { orderItemId: fresh.orderItemId },
        select: { id: true, stationId: true, stationName: true, kind: true, sequence: true, status: true },
        orderBy: { sequence: 'asc' },
      })
      const blockers = siblings.filter(
        (s) =>
          s.id !== fresh.id &&
          s.sequence < fresh.sequence &&
          s.kind !== 'modifier' &&
          !['ready', 'done'].includes(s.status)
      )
      const blocked = blockers.length > 0
      // izdajna naloga: čaka na VSE pripravljalne korake (tudi vzporedne isti sequence)
      const issueBlockers = action === 'issue'
        ? siblings.filter((s) => s.id !== fresh.id && s.kind !== 'expo' && !['ready', 'done'].includes(s.status))
        : blockers

      // idempotenca: enak ciljni status → 200 brez sprememb (replay)
      if (fresh.status === transition.to) {
        return { status: 200, already: true, task: fresh }
      }
      // prehodna validacija ( waiting → start/issue zahteva ODKLENJENO zaporedje )
      const allowedNow =
        (transition.allowedFrom as string[]).includes(fresh.status) ||
        (fresh.status === 'waiting' && (action === 'issue' || action === 'start') && !blocked)
      if (!allowedNow) {
        return {
          status: 409,
          message:
            fresh.status === 'waiting'
              ? 'Predhodna postaja še ni zaključena.'
              : `Prehod (${fresh.status} → ${transition.to}) ni dovoljen.`,
          task: fresh,
          blockedBy: issueBlockers.map((b) => ({ stationName: b.stationName, status: b.status })),
        }
      }
      if (blocked && action !== 'issue') {
        return {
          status: 409,
          message: 'Predhodna postaja še ni zaključena.',
          task: fresh,
          blockedBy: blockers.map((b) => ({ stationName: b.stationName, status: b.status })),
        }
      }
      if (action === 'issue' && issueBlockers.length > 0) {
        return {
          status: 409,
          message: 'Priprava na postajah še ni zaključena.',
          task: fresh,
          blockedBy: issueBlockers.map((b) => ({ stationName: b.stationName, status: b.status })),
        }
      }

      const now = new Date()
      const stamps: Prisma.StationTaskUpdateInput = {}
      if (transition.to === 'preparing') stamps.startedAt = now
      if (transition.to === 'ready') { stamps.readyAt = now; stamps.readyById = user.sub; stamps.readyByName = user.name }
      if (transition.to === 'done') { stamps.issuedAt = now; stamps.issuedById = user.sub; stamps.issuedByName = user.name }

      // CAS: točno iz prebranega statusa — sočasen dvojni klik naredi ENO spremembo
      const cas = await tx.stationTask.updateMany({
        where: { id: fresh.id, status: fresh.status },
        data: { status: transition.to, ...stamps },
      })
      if (cas.count === 0) {
        return { status: 409, message: 'Naloga se je medtem spremenila — osveži desko.', task: fresh }
      }

      // rollup postavke (iz nalog) + terminalna sprav (izdaja)
      const itemStatus = await rollupItemStatusFromTasks(tx, fresh.orderItemId, { sub: user.sub, name: user.name })
      if (action === 'issue') {
        await completeTasksForItem(tx, fresh.orderItemId)
      }
      const auditAction = transition.to === 'preparing' ? 'STATION_TASK_STARTED' : transition.to === 'ready' ? 'STATION_TASK_READY' : 'STATION_TASK_ISSUED'
      await writeAudit(tx, {
        userId: user.sub,
        action: auditAction,
        entityType: 'StationTask',
        entityId: fresh.id,
        details: jstr({
          stationId: fresh.stationId, stationName: fresh.stationName, kind: fresh.kind,
          orderItemId: fresh.orderItemId, orderId: fresh.orderId, action,
          ...(itemStatus ? { itemStatus } : {}), by: user.name,
        }),
        locationId: fresh.locationId,
      })
      const updated = await tx.stationTask.findUnique({ where: { id: fresh.id } })
      return { status: 200, task: updated, itemStatus, orderId: fresh.orderId, orderItemId: fresh.orderItemId, title: fresh.title }
    })
    if (outcome.status !== 200) {
      // sočasnost/zaporedje: pošljemo aktualno stanje naloge + blokirnike
      // (isti vzorec kot manager-call PATCH 409 {error, call})
      const payload: Record<string, unknown> = { error: outcome.message ?? 'Sprememba naloge ni uspela.' }
      if (outcome.task) payload.task = outcome.task
      if (outcome.blockedBy) payload.blockedBy = outcome.blockedBy
      return NextResponse.json(payload, { status: outcome.status })
    }
    // OPS-9 val 3: KDS_DELAY revizija ob ZAMUDNJI (prag PO postaji — task target)
    if (action === 'ready' && delayReason) {
      try {
        const prepMin = computePrepMin(task.firedAt, new Date())
        const station = await db.prepStation.findUnique({ where: { id: task.stationId }, select: { avgPrepTime: true } })
        if (prepMin !== null && isLatePrep(prepMin, station?.avgPrepTime ?? null)) {
          const __aId = nid()
          const details = kdsDelayDetails({
            orderItemId: task.orderItemId,
            menuItemName: task.title || '—',
            reason: delayReason,
            prepMin: prepMin as number,
            orderId: task.orderId,
            threshold: delayThresholdForTarget(station?.avgPrepTime ?? null),
          })
          const __chain = await auditChainFields(db, {
            id: __aId,
            action: KDS_DELAY_ACTION,
            entityType: 'StationTask',
            entityId: task.id,
            details,
            locationId: task.locationId,
          })
          await db.auditLog.create({
            data: {
              ...__chain,
              id: __aId,
              userId: user.sub,
              action: KDS_DELAY_ACTION,
              entityType: 'StationTask',
              entityId: task.id,
              details: jstr(details),
              locationId: task.locationId,
            },
          })
        }
      } catch {
        // never fail the bump because of the delay-reason audit
      }
    }
    // order rollup + ORDER_READY push (ista semantika kot legacy pot)
    if (outcome.orderId) {
      await applyOrderRollup({ orderId: outcome.orderId, id: outcome.orderItemId ?? '', menuItemName: outcome.title ?? '' }, user)
    }
    return ok({ task: outcome.task, itemStatus: outcome.itemStatus ?? null, already: outcome.already === true })
  }

  /* ── B) legacy pot ── */
  if (!body?.itemId || !['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(body.status)) return fail('itemId in veljaven status sta obvezna.')
  // OPS-9 val 3: optional delay reason sent by the KDS when a LATE item (>10 min) is bumped
  const delayReason = isValidDelayReason(body.delayReason) ? body.delayReason : null
  const newDbStatus = itemStatusToDB(body.status)
  const target = await db.orderItem.findUnique({
    where: { id: body.itemId },
    include: {
      Order: { select: { locationId: true } },
      // OPS-11 val 1: station of the item (single include) — PrepStation.avgPrepTime drives the delay threshold
      MenuItem: { include: { PrepStation: true } },
    },
  })
  if (!target) return fail('Artikel naročila ne obstaja.', 404)
  const locRes = await guardResource(user, target.Order?.locationId)
  if (locRes) return locRes

  // Issue #14 (v1.112.0): postavka z postajnimi nalogami se upravlja s postajnim
  // tokom — SERVED je izjema (natakar/izdaja spravi naloge v done), ostalo 409.
  const itemTasks = await tasksForItem(target.id)
  if (itemTasks.length > 0) {
    const active = itemTasks.filter((t) => !['ready', 'done'].includes(t.status))
    if (active.length > 0) {
      return fail(body.status === 'SERVED' ? 'Postavka še ni zaključena na vseh postajah.' : 'Postavka je usmerjena na postaje — uporabi postajni tok (taskId).', 409)
    }
    if (body.status === 'SERVED' || body.status === 'PENDING') {
      // strežba izvedena / vračilo v vrsto: naloge terminalno spravi
      await db.$transaction(async (tx) => {
        await tx.orderItem.update({ where: { id: target.id }, data: { status: newDbStatus as Prisma.OrderItemUpdateInput['status'] } })
        await completeTasksForItem(tx, target.id)
        await writeAudit(tx, { userId: user.sub, action: 'KDS_ITEM_STATUS', entityType: 'OrderItem', entityId: target.id, details: jstr({ status: body.status, stationTasks: 'done', by: user.name }), locationId: target.Order?.locationId ?? null })
      })
      await applyOrderRollup({ orderId: target.orderId, id: target.id, menuItemName: target.menuItemName }, user)
      const freshServed = await db.orderItem.findUnique({ where: { id: target.id }, include: { MenuItem: { include: { PrepStation: true } } } })
      return ok({ item: freshServed ? mapOrderItem({ ...freshServed, menuItem: freshServed.MenuItem ? { prepStation: freshServed.MenuItem.PrepStation } : undefined }) : { id: target.id, status: orderStatusToUI(newDbStatus) } })
    }
    return fail('Postavka je usmerjena na postaje — uporabi postajni tok (taskId).', 409)
  }

  const item = await db.orderItem.update({
    where: { id: body.itemId },
    data: { status: newDbStatus as Prisma.OrderItemUpdateInput['status'], ...(newDbStatus === 'ready' ? { readyAt: new Date(), readyById: user.sub, readyByName: user.name } : {}) },
  })
  // OPS-9 val 3 (v1.76.0) — KDS_DELAY audit when a LATE item is bumped to ready with a reason
  // from the catalog. OPS-11 val 1 (v1.80.0): "late" is PER STATION — OrderItem → MenuItem
  // → PrepStation.avgPrepTime resolves the threshold (max(10, ceil(target×1.25)); no station
  // → the global 10 min, identical to the old behavior). NON-BLOCKING: any failure here must
  // never fail the bump.
  if (newDbStatus === 'ready' && delayReason) {
    try {
      const prepMin = computePrepMin(target.firedAt, new Date())
      const stationAvgPrep = target.MenuItem?.PrepStation?.avgPrepTime ?? null
      if (prepMin !== null && isLatePrep(prepMin, stationAvgPrep)) {
        const __aId = nid()
        const details = kdsDelayDetails({
          orderItemId: item.id,
          menuItemName: target.menuItemName || item.menuItemName || '—',
          reason: delayReason,
          prepMin: prepMin as number,
          orderId: item.orderId,
          // additive: stats know the threshold that applied at bump time
          threshold: delayThresholdForTarget(stationAvgPrep),
        })
        const __chain = await auditChainFields(db, {
          id: __aId,
          action: KDS_DELAY_ACTION,
          entityType: 'OrderItem',
          entityId: item.id,
          details,
          locationId: target.Order?.locationId ?? null,
        })
        await db.auditLog.create({
          data: {
            ...__chain,
            id: __aId,
            userId: user.sub,
            action: KDS_DELAY_ACTION,
            entityType: 'OrderItem',
            entityId: item.id,
            details: jstr(details),
            locationId: target.Order?.locationId ?? null,
          },
        })
      }
    } catch {
      // never fail the bump because of the delay-reason audit
    }
  }
  await applyOrderRollup({ orderId: item.orderId, id: item.id, menuItemName: item.menuItemName }, user)
  const fresh = await db.orderItem.findUnique({ where: { id: item.id }, include: { MenuItem: { include: { PrepStation: true } } } })
  const mapped = fresh ? mapOrderItem({ ...fresh, menuItem: fresh.MenuItem ? { prepStation: fresh.MenuItem.PrepStation } : undefined }) : { id: item.id, status: orderStatusToUI(item.status) }
  return ok({ item: mapped })
}
