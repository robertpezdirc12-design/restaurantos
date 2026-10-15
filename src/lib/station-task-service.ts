/**
 * Issue #14 (P1/P2, v1.112.0) — KDS postajne naloge: STORITVENI sloj (DB).
 *
 * Motor (čiste funkcije) živi v src/lib/kds-station-routing.ts; TA modul ga
 * priključi na bazo:
 *  - createStationTasksForItems: ob FIRE-u razreši usmerjanje vsake postavke
 *    (primarna postaja + dodatne + opcije) in zapiše StationTask vrstice
 *    (idempotentno: obstoječe (postavka × postaja) preskoči — re-fire tečaja
 *    ne podvoji nalog);
 *  - rollupItemStatusFromTasks: postavkin status iz nalog (kanonični vir, ko
 *    naloge obstajajo) + žigi readyAt/readyById ob prehodu v 'ready';
 *  - completeTasksForItem: terminalno spravi vse naloge postavke ('done') —
 *    ob izdaji (expo) ali strežbi (SERVED), da deskas osvobodi;
 *  - hasActiveStationTasks: preverba za legacy pot (PATCH /api/kitchen, sync).
 *
 * DDL VAROVALKA (produkcija pred migrate-kds-stations): VSA poizvedba čez
 * StationTask/MenuItemStation tukaj lovi isMissingSchemaError in se TIHO
 * degradira (brez nalog / brez rollupa) — obstoječi POS/KDS tok deluje
 * nespremenjeno (isti vzorec kot paylink split .catch → []).
 */
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { isMissingSchemaError } from '@/lib/prisma-missing'
import { buildTaskPlan, itemStatusFromTasks, type StationRef, type TaskPlanItem } from '@/lib/kds-station-routing'

type Tx = Prisma.TransactionClient

/** Vrstica OrderItem z opcijami, kot jo pošilja fire pot. */
export interface FiredItemRow {
  id: string
  orderId: string
  menuItemId: string
  menuItemName: string
  quantity: number
  notes: string
  OrderItemModifier?: { name: string; modifierGroupId: string | null }[]
}

/** Ali postavka (ali katera koli od postavk) ima AKTIVNE postajne naloge. */
export async function hasActiveStationTasks(orderItemIds: string[]): Promise<boolean> {
  if (orderItemIds.length === 0) return false
  try {
    const row = await db.stationTask.findFirst({
      where: { orderItemId: { in: orderItemIds }, status: { in: ['waiting', 'pending', 'preparing'] } },
      select: { id: true },
    })
    return !!row
  } catch (e) {
    if (isMissingSchemaError(e)) return false
    throw e
  }
}

/**
 * Ustvari postajne naloge za ODDANE postavke (fire pot — znotraj transakcije).
 * Vrača število ZAPISANIH nalog (0 = brez konfiguracije/že obstoječe — legacy).
 */
export async function createStationTasksForItems(
  tx: Tx,
  opts: { locationId: string; orderId: string; items: FiredItemRow[]; firedAt: Date }
): Promise<number> {
  if (opts.items.length === 0) return 0
  try {
    // 1) aktivne postaje lokacije (razreševanje + posnetki)
    const stations = await tx.prepStation.findMany({
      where: { locationId: opts.locationId, isActive: true },
      select: { id: true, name: true, type: true, avgPrepTime: true, sortOrder: true, isExpo: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    if (stations.length === 0) return 0
    const stationRefs: StationRef[] = stations.map((s) => ({ ...s, isActive: true }))

    // 2) dodatne postaje artiklov (MenuItemStation)
    const menuItemIds = [...new Set(opts.items.map((i) => i.menuItemId).filter(Boolean))]
    const extraRows = menuItemIds.length
      ? await tx.menuItemStation.findMany({ where: { menuItemId: { in: menuItemIds } }, select: { menuItemId: true, stationId: true } })
      : []
    const extraByItem = new Map<string, string[]>()
    for (const r of extraRows) {
      const arr = extraByItem.get(r.menuItemId) ?? []
      arr.push(r.stationId)
      extraByItem.set(r.menuItemId, arr)
    }

    // 3) primarne postaje artiklov (MenuItem.prepStationId)
    const menuRows = menuItemIds.length
      ? await tx.menuItem.findMany({ where: { id: { in: menuItemIds } }, select: { id: true, prepStationId: true } })
      : []
    const primaryByItem = new Map(menuRows.map((m) => [m.id, m.prepStationId]))

    // 4) opcije postavk → usmerjene postaje (Modifier.prepStationId)
    const groupIds = [...new Set(opts.items.flatMap((i) => (i.OrderItemModifier ?? []).map((m) => m.modifierGroupId).filter((x): x is string => !!x)))]
    const modifierRows = groupIds.length
      ? await tx.modifier.findMany({
          where: { modifierGroupId: { in: groupIds }, prepStationId: { not: null } },
          select: { id: true, name: true, modifierGroupId: true, prepStationId: true },
        })
      : []
    // razreševanje po (skupina, ime) — OrderItemModifier hrani posnetek imena
    const modsByKey = new Map<string, { prepStationId: string; name: string }>()
    for (const m of modifierRows) {
      if (m.prepStationId) modsByKey.set(`${m.modifierGroupId}:${m.name}`, { prepStationId: m.prepStationId, name: m.name })
    }

    // 5) že obstoječe naloge (idempotenca na ravni (postavka × postaja) —
    //    DB unique je (postavka × postaja × kind), ker priprava+izdajna postaja
    //    dobi dve vrstici; preskok po postaji je NAMERNO strožji: re-fire ne
    //    podvoji NOBENEGA koraka postaje)
    const itemIds = opts.items.map((i) => i.id)
    const existing = await tx.stationTask.findMany({
      where: { orderItemId: { in: itemIds } },
      select: { orderItemId: true, stationId: true },
    })
    const existsKey = new Set(existing.map((e) => `${e.orderItemId}:${e.stationId}`))

    // 6) načrt + zapis
    const toCreate: (TaskPlanItem & { orderItemId: string; orderId: string; locationId: string; firedAt: Date })[] = []
    for (const item of opts.items) {
      const modifierStations = new Map<string, string[]>()
      for (const mod of item.OrderItemModifier ?? []) {
        const key = `${mod.modifierGroupId}:${mod.name}`
        const routed = modsByKey.get(key)
        if (!routed) continue
        const arr = modifierStations.get(routed.prepStationId) ?? []
        arr.push(mod.name)
        modifierStations.set(routed.prepStationId, arr)
      }
      const plan = buildTaskPlan({
        stations: stationRefs,
        primaryStationId: primaryByItem.get(item.menuItemId) ?? null,
        extraStationIds: extraByItem.get(item.menuItemId) ?? [],
        modifierStations: [...modifierStations.entries()].map(([stationId, names]) => ({ stationId, names })),
        title: item.menuItemName || 'Artikel',
        quantity: item.quantity,
      })
      for (const p of plan) {
        if (existsKey.has(`${item.id}:${p.stationId}`)) continue
        toCreate.push({ ...p, orderItemId: item.id, orderId: opts.orderId, locationId: opts.locationId, firedAt: opts.firedAt })
      }
    }
    if (toCreate.length === 0) return 0
    await tx.stationTask.createMany({
      data: toCreate.map((t) => ({
        id: nid(),
        locationId: t.locationId,
        orderItemId: t.orderItemId,
        orderId: t.orderId,
        stationId: t.stationId,
        stationName: t.stationName,
        stationType: t.stationType,
        kind: t.kind,
        sequence: t.sequence,
        status: t.status,
        title: t.title,
        detail: `${t.detail}${item_notes(t.detail, (opts.items.find((i) => i.id === t.orderItemId)?.notes ?? ''))}`,
        quantity: t.quantity,
        firedAt: t.firedAt,
      })),
    })
    return toCreate.length
  } catch (e) {
    if (isMissingSchemaError(e)) return 0 // DDL pending — legacy tok
    throw e
  }
}

function item_notes(detail: string, notes: string): string {
  const d = detail ? detail.trim() : ''
  const n = notes ? notes.trim() : ''
  if (d && n) return `${d} · ${n}`
  return d || n
}

/**
 * Rollup statusa postavke iz nalog + žigi. Vrača novi status ali null
 * (brez nalog / brez spremembe — klicatelj potem uporabi lastno logiko).
 * OB prehodu v 'ready' zapiše readyAt/readyById/readyByName (žig zadnjega
 * končevalca naloge — isti pomen kot legacy bump).
 */
export async function rollupItemStatusFromTasks(
  tx: Tx,
  orderItemId: string,
  actor: { sub: string; name: string }
): Promise<'served' | 'ready' | 'preparing' | 'fired' | null> {
  let tasks: { kind: string; status: string }[]
  try {
    tasks = await tx.stationTask.findMany({ where: { orderItemId }, select: { kind: true, status: true } })
  } catch (e) {
    if (isMissingSchemaError(e)) return null
    throw e
  }
  const next = itemStatusFromTasks(tasks)
  if (next === null) return null
  const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, select: { status: true } })
  if (!item || item.status === next) return next
  await tx.orderItem.update({
    where: { id: orderItemId },
    data: {
      status: next,
      ...(next === 'ready' && item.status !== 'ready'
        ? { readyAt: new Date(), readyById: actor.sub, readyByName: actor.name }
        : {}),
    },
  })
  return next
}

/** Terminalno spravi vse naloge postavke ('done') — ob izdaji/strežbi. */
export async function completeTasksForItem(tx: Tx, orderItemId: string): Promise<void> {
  try {
    await tx.stationTask.updateMany({ where: { orderItemId, status: { not: 'done' } }, data: { status: 'done' } })
  } catch (e) {
    if (isMissingSchemaError(e)) return
    throw e
  }
}

/** Naloge postavke (za preverbo blokad/izdaj v PATCH poti). */
export async function tasksForItem(
  orderItemId: string
): Promise<{ id: string; stationId: string; stationName: string; kind: string; sequence: number; status: string }[]> {
  try {
    return await db.stationTask.findMany({
      where: { orderItemId },
      select: { id: true, stationId: true, stationName: true, kind: true, sequence: true, status: true },
      orderBy: { sequence: 'asc' },
    })
  } catch (e) {
    if (isMissingSchemaError(e)) return []
    throw e
  }
}

/**
 * Validacija usmerjenih postaj za LOKACIJO (meniji/opcije — issue #14 §2:
 * določitev postaje je strežniško preverjena; postaja tuje lokacije ne sme
 * sprejeti artikla/opcije). Vrača dedup+normaliziran seznam ali napako.
 */
export async function validateStationsForLocation(
  stationIds: unknown,
  locationId: string
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string; status: number }> {
  if (!Array.isArray(stationIds)) return { ok: false, error: 'stationIds mora biti seznam.', status: 400 }
  const clean = [...new Set(stationIds.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
  if (clean.length !== stationIds.filter((s) => typeof s === 'string' && s.trim() !== '').length) {
    return { ok: false, error: 'stationIds vsebuje duplikate ali prazne vnose.', status: 400 }
  }
  if (clean.length > 8) return { ok: false, error: 'Največ 8 dodatnih postaj na artikel.', status: 400 }
  if (clean.length === 0) return { ok: true, ids: [] }
  const rows = await db.prepStation.findMany({ where: { id: { in: clean }, locationId }, select: { id: true, isActive: true } })
  if (rows.length !== clean.length) {
    return { ok: false, error: 'Postaja ne obstaja na tej lokaciji.', status: 400 }
  }
  return { ok: true, ids: clean }
}
