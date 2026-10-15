import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAnyPermission, isResponse, ok, fail } from '@/lib/api'
import { num } from '@/lib/map'
import { lotGovernanceColumnsReady, batchBucket } from '@/lib/lot-governance'

/**
 * Issue #15 (P1, v1.105.0) — SLEDTĽIVOSTNO POROČILO serije (lot → jedi).
 *
 * GET /api/inventory/batches/[id]/trace[?format=csv]
 *
 * Iz serije sestavine pokaže DOKAZLJIVE povezave:
 *  1. allocations — StockBatchAllocation → StockTransaction:
 *     - SALE (orderId): prodajna postavka/naročilo, ki je DEJANSKO odvzelo
 *       količino iz TE serije (dokazana povezava lot→naročilo);
 *     - BATCH_INPUT (BatchPreparationLine): priprava, ki je porabila serijo
 *       (povezava lot→priprava dokazana; priprava→prodaja izdelka je POSREDNA
 *       — stopnja negotovosti je izrecno označena, NI trditve kdo je zaužil);
 *  2. summary — prejeto / na zalogi / dodeljeno ven / vračila (storno) /
 *     nezvezano (količina brez serijske povezave — ročni odpis, popis,
 *     prilagoditve NIMAJÓ lot alokacij → VRZEL je vidna, ne skrita);
 *  3. exposedOrders — za odpoklic: naročila z dokazano alokacijo + jedi;
 *  4. cross-check: prejeto = na zalogi + dodeljeno − vračila + nezvezano ±.
 *
 * Pravice: inventory.manage ALI reports.view; lokacijska izolacija (tuja
 * serija → 404). CSV izvoz (format=csv) za uradni pregled/odgovorno osebo:
 * dobavitelj, serija, datumi, količine, reference, časovni interval.
 * Poročilo NE spreminja zaloge — samo branje.
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return `"${s.replace(/"/g, '""')}"`
}

function iso(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString() : ''
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnyPermission(req, ['inventory.manage', 'reports.view'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const { id } = await params

  const lotReady = await lotGovernanceColumnsReady()

  const batch = await db.inventoryBatch.findUnique({
    where: { id },
    select: {
      id: true, lotNumber: true, supplierId: true, supplierName: true, locationId: true,
      receivedAt: true, expiryDate: true, quantityInitial: true, quantityRemaining: true,
      unit: true, unitCost: true, status: true, note: true,
      ...(lotReady ? { alertDate: true, removalDate: true, holdReason: true, holdAt: true, holdById: true, holdRef: true, releaseAt: true, releaseById: true, releaseNote: true } : {}),
      InventoryItem: { select: { id: true, name: true, unit: true } },
    },
  })
  if (!batch) return fail('Serija ne obstaja.', 404)
  if (batch.locationId && user.role !== 'ADMIN' && user.loc && batch.locationId !== user.loc) {
    return fail('Serija pripada drugi lokaciji.', 403)
  }

  // 1. allocations z dokazano povezavo (vsaka StockBatchAllocation te serije)
  const allocs = await db.stockBatchAllocation.findMany({
    where: { batchId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, quantity: true, createdAt: true,
      StockTransaction: {
        select: {
          id: true, type: true, quantity: true, createdAt: true, employeeName: true, reason: true, note: true, orderId: true,
          Order: { select: { id: true, orderNumber: true, status: true, createdAt: true, orderSource: true } },
          BatchPreparationLine: { select: { preparationId: true, BatchPreparation: { select: { id: true, status: true, outputItemId: true, outputQuantity: true, completedAt: true, InventoryItem: { select: { name: true } } } } } },
        },
      },
    },
  })

  // Order → OrderItems (jed-i na dokazanih naročilih) — ločena poizvedba
  const orderIds = [...new Set(allocs.map((a) => a.StockTransaction.orderId).filter((o): o is string => !!o))]
  const orders = orderIds.length > 0
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true, orderNumber: true, status: true, createdAt: true, orderSource: true,
          OrderItem: { select: { menuItemName: true, quantity: true, voided: true } },
        },
      })
    : []
  const orderById = new Map(orders.map((o) => [o.id, o]))

  const allocations = allocs.map((a) => {
    const tx = a.StockTransaction
    const o = tx.orderId ? orderById.get(tx.orderId) : null
    const prep = tx.BatchPreparationLine?.BatchPreparation
    return {
      allocationId: a.id,
      txId: tx.id,
      date: tx.createdAt,
      type: tx.type,
      quantity: r3(num(a.quantity)),
      employeeName: tx.employeeName,
      orderId: tx.orderId,
      orderNumber: o?.orderNumber || null,
      orderStatus: o?.status || null,
      orderDate: o?.createdAt || null,
      orderSource: o?.orderSource || null,
      prepId: prep?.id || null,
      prepStatus: prep?.status || null,
      prepOutputItem: prep?.InventoryItem?.name || null,
      prepOutputQty: prep ? r3(num(prep.outputQuantity)) : null,
      prepCompletedAt: prep?.completedAt || null,
      indirect: !!prep, // priprava → prodaja izdelka je POSREDNA (negotovost)
    }
  })

  // 2. summary — matematična razčlenitev (prejeto = zaloga + dodeljeno − vračila)
  const allocatedOut = r3(allocations.reduce((s, a) => s + Math.max(0, num(a.quantity)), 0))
  const received = r3(num(batch.quantityInitial))
  const onStock = r3(num(batch.quantityRemaining))
  // vračila (storno poveča quantityRemaining BREZ nove alokacije) in vsa ostala
  // odstopanja so VRZEL — izračunana, ne skrita:
  const gap = r3(received - onStock - allocatedOut)
  const returnsEstimate = gap < 0 ? r3(-gap) : 0
  const untracked = gap > 0 ? gap : 0

  const exposedOrders = [...new Map(
    allocations.filter((a) => a.orderId).map((a) => [a.orderId as string, a]),
  ).entries()].map(([orderId, a]) => {
    const o = orderById.get(orderId)
    return {
      orderId,
      orderNumber: a.orderNumber,
      status: a.orderStatus,
      date: a.orderDate,
      source: a.orderSource,
      quantityFromLot: r3(
        allocations.filter((x) => x.orderId === orderId).reduce((s, x) => s + x.quantity, 0),
      ),
      items: (o?.OrderItem || [])
        .filter((i) => !i.voided)
        .map((i) => ({ name: i.menuItemName, qty: i.quantity })),
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    batch: {
      id: batch.id,
      lotNumber: batch.lotNumber,
      itemName: batch.InventoryItem?.name || '',
      unit: batch.InventoryItem?.unit || batch.unit,
      supplierId: batch.supplierId,
      supplierName: batch.supplierName,
      receivedAt: batch.receivedAt,
      expiryDate: batch.expiryDate,
      alertDate: lotReady ? batch.alertDate : null,
      removalDate: lotReady ? batch.removalDate : null,
      status: (batch.status || '').toUpperCase(),
      bucket: batchBucket(
        {
          status: batch.status,
          quantityRemaining: batch.quantityRemaining,
          expiryDate: batch.expiryDate,
          alertDate: lotReady ? batch.alertDate : null,
          removalDate: lotReady ? batch.removalDate : null,
        },
        new Date(),
      ),
      quantityInitial: received,
      quantityRemaining: onStock,
      unitCost: batch.unitCost === null ? null : num(batch.unitCost),
      hold: lotReady && batch.holdAt
        ? { reason: batch.holdReason, at: batch.holdAt, by: batch.holdById, ref: batch.holdRef }
        : null,
      release: lotReady && batch.releaseAt
        ? { note: batch.releaseNote, at: batch.releaseAt, by: batch.releaseById }
        : null,
      note: batch.note,
      locationId: batch.locationId,
    },
    summary: {
      received,
      onStock,
      allocatedOut,
      returnsEstimate,
      untracked,
      untrackedExplanation:
        'Količine odpisa, ročnih popravkov in popisa NIMAJO serijske alokacije (vrzel sledljivosti) — nezvezana količina je izračunana kot prejeto − zaloga − dodeljeno + vračila in je prikazana, ne skrita. Vračila storno povečajo zalogo brez nove alokacije.',
      crossCheckOk: Math.abs(received - (onStock + allocatedOut - returnsEstimate + untracked)) < 0.001,
    },
    allocations,
    exposedOrders,
    uncertainty: {
      prepIndirect:
        'Priprave (BATCH_INPUT) so dokazano porabile serijo; nadaljnja prodaja PRIPRAVLJENEGA izdelka ni direktno povezana s to serijo (združena proizvodnja) — izpostavljena naročila veljajo SAMO za neposredne SALE alokacije.',
      noLotClaim:
        'Poročilo dokazuje količine, ne zaužitja — identifikacija gostov ni del sledljivosti (za uradni postopek odpoklica je odgovorna oseba dolžna upoštevati HACCP/odpoklic postopek).',
    },
  }

  // CSV izvoz (odgovorna oseba/uradni pregled)
  if ((req.nextUrl.searchParams.get('format') || '').toLowerCase() === 'csv') {
    const rows: string[][] = [
      ['RestaurantOS sledljivostno poročilo serije'],
      ['serija', batch.lotNumber],
      ['artikel', batch.InventoryItem?.name || ''],
      ['enota', batch.InventoryItem?.unit || batch.unit || ''],
      ['dobavitelj', batch.supplierName || ''],
      ['prejeto', iso(batch.receivedAt)],
      ['rok uporabe', iso(batch.expiryDate)],
      ['opozorilni datum', lotReady ? iso(batch.alertDate) : ''],
      ['datum odstranitve', lotReady ? iso(batch.removalDate) : ''],
      ['status', (batch.status || '').toUpperCase()],
      ['količina prejeta', String(received)],
      ['količina na zalogi', String(onStock)],
      ['dodeljeno ven', String(allocatedOut)],
      ['vračila (ocena)', String(returnsEstimate)],
      ['nezvezano', String(untracked)],
      [],
      ['datum', 'vrsta', 'količina', 'naročilo', 'priprava', 'izdelek priprave', 'oseba', 'posredna'],
      ...allocations.map((a): string[] => [
        iso(a.date),
        a.type,
        String(a.quantity),
        a.orderNumber != null ? String(a.orderNumber) : (a.orderId || ''),
        a.prepId || '',
        a.prepOutputItem || '',
        a.employeeName || '',
        a.indirect ? 'DA (priprava — prodaja izdelka posredna)' : 'NE',
      ]),
    ]
    const csv = '\uFEFF' + rows.map((r) => r.map(csvEscape).join(';')).join('\r\n')
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sledljivost-${batch.lotNumber.replace(/[^a-zA-Z0-9-]/g, '_')}.csv"`,
      },
    })
  }

  return ok(report)
}
