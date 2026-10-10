import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, r2, jstr } from '@/lib/map'
import { poNumberFor, computeTotalsCents, computeLineCents, type PoStatus } from '@/lib/procurement'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * Issue #1 (triage ②) — nabava: nabavna naročila dobavitelju.
 *
 * GET  /api/purchase-orders?status=&supplierId=&locationId=&take=
 *   → seznam naročil z vrsticami (naročeno/prejeto) in številom prevzemov.
 *     Bralna pravica: requireAuth (pogled za vse, kot ostali seznami).
 *
 * POST /api/purchase-orders { supplierId, locationId?, expectedDate?,
 *   deliveryAddress?, deliveryNotes?, notes?, lines: [{ inventoryItemId?,
 *   description, quantity, unit?, unitPrice, vatRate?, packQty?, packUnit? }] }
 *   → novo naročilo v OSNUTKU (status draft), vsote točno v centih.
 *     Pravica: inventory.manage. Audit: PO_CREATE.
 *
 * Kanonični tok (triage §9): dobavitelj → naročilo (tu) → prevzem
 * (/api/purchase-orders/[id]/receive) → zaloga. §18: brez podvajanja —
 * uporabljamo obstoječe modele PurchaseOrder/PurchaseOrderItem/Supplier.
 */

const PO_STATUSES: readonly string[] = ['draft', 'submitted', 'approved', 'partial', 'received', 'cancelled']

export function serializeItem(i: {
  id: string
  description: string
  quantityOrdered: unknown
  quantityReceived: unknown
  quantityRejected: unknown
  unit: string
  unitPrice: unknown
  vatRate: unknown
  totalPrice: unknown
  status: string
  inventoryItemId: string | null
  packQty: unknown
  packUnit: string | null
}) {
  return {
    id: i.id,
    description: i.description,
    quantityOrdered: Number(i.quantityOrdered),
    quantityReceived: Number(i.quantityReceived),
    quantityRejected: Number(i.quantityRejected),
    unit: i.unit,
    unitPrice: Number(i.unitPrice),
    vatRate: Number(i.vatRate),
    totalPrice: Number(i.totalPrice),
    status: i.status,
    inventoryItemId: i.inventoryItemId,
    packQty: i.packQty == null ? null : Number(i.packQty),
    packUnit: i.packUnit,
  }
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const supplierId = url.searchParams.get('supplierId')
  const locationId = url.searchParams.get('locationId')
  const take = Math.min(Math.max(parseInt(url.searchParams.get('take') || '50', 10) || 50, 1), 100)

  const where: Record<string, unknown> = {}
  if (status && PO_STATUSES.includes(status)) where.status = status
  if (supplierId) where.supplierId = supplierId
  if (locationId) where.locationId = locationId

  const rows = await db.purchaseOrder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      Supplier: { select: { id: true, name: true } },
      PurchaseOrderItem: true,
      _count: { select: { GoodsReceipt: true } },
    },
  })

  return ok({
    orders: rows.map((p) => ({
      id: p.id,
      poNumber: p.poNumber,
      status: p.status as PoStatus,
      supplierId: p.supplierId,
      supplierName: p.Supplier?.name || '',
      orderDate: p.orderDate,
      expectedDate: p.expectedDate,
      receivedDate: p.receivedDate,
      subtotal: Number(p.subtotal),
      vatAmount: Number(p.vatAmount),
      totalAmount: Number(p.totalAmount),
      locationId: p.locationId,
      notes: p.notes,
      requestedBy: p.requestedBy,
      approvedBy: p.approvedBy,
      invoiceStatus: p.invoiceStatus,
      items: p.PurchaseOrderItem.map(serializeItem),
      receiptsCount: p._count.GoodsReceipt,
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const supplierId = String(body.supplierId || '').trim()
  if (!supplierId) return fail('Dobavitelj je obvezen.', 400)
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) return fail('Dobavitelj ne obstaja.', 404)

  const rawLines = Array.isArray(body.lines) ? body.lines : []
  if (rawLines.length === 0) return fail('Naročilo potrebuje vsaj eno vrstico.', 400)
  if (rawLines.length > 100) return fail('Naročilo ima lahko največ 100 vrstic.', 400)

  const seenItem = new Set<string>()
  const lines: {
    id: string
    description: string
    inventoryItemId: string | null
    quantityOrdered: number
    unit: string
    unitPrice: number
    vatRate: number
    totalPrice: number
    status: string
    packQty: number | null
    packUnit: string | null
  }[] = []
  for (const [idx, l] of rawLines.entries()) {
    const inventoryItemId = l?.inventoryItemId ? String(l.inventoryItemId) : ''
    const description = String(l?.description || '').trim()
    const quantity = num(l?.quantity)
    const unitPrice = num(l?.unitPrice)
    const vatRate = l?.vatRate == null || l?.vatRate === '' ? 22 : num(l?.vatRate)
    let invName = ''
    let invUnit = ''
    if (!inventoryItemId && !description) return fail(`Vrstica ${idx + 1}: artikel ali opis je obvezen.`, 400)
    if (!(quantity > 0)) return fail(`Vrstica ${idx + 1}: količina mora biti večja od 0.`, 400)
    if (!(unitPrice >= 0)) return fail(`Vrstica ${idx + 1}: cena ne sme biti negativna.`, 400)
    if (!(vatRate >= 0 && vatRate <= 30)) return fail(`Vrstica ${idx + 1}: DDV stopnja mora biti med 0 in 30 %.`, 400)
    if (inventoryItemId && seenItem.has(inventoryItemId)) return fail(`Vrstica ${idx + 1}: artikel je naveden večkrat — združi količine.`, 400)
    if (inventoryItemId) seenItem.add(inventoryItemId)

    // referenčna integriteta: artikel, če je podan
    if (inventoryItemId) {
      const inv = await db.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { id: true, name: true, unit: true } })
      if (!inv) return fail(`Vrstica ${idx + 1}: inventarni artikel ne obstaja.`, 400)
      invName = inv.name
      invUnit = inv.unit
    }
    const unit = String(l?.unit || '').trim() || invUnit || 'pcs'

    const unitPriceCents = Math.round(unitPrice * 100)
    const t = computeLineCents({ quantity, unitPriceCents, vatRate })
    lines.push({
      id: nid(),
      description: description || invName || '',
      inventoryItemId: inventoryItemId || null,
      quantityOrdered: quantity,
      unit,
      unitPrice,
      vatRate: r2(vatRate),
      totalPrice: t.totalCents / 100,
      status: 'pending',
      packQty: l?.packQty == null || l?.packQty === '' ? null : num(l.packQty),
      packUnit: l?.packUnit ? String(l.packUnit) : null,
    })
  }

  const totals = computeTotalsCents(lines.map((l) => ({ quantity: l.quantityOrdered, unitPriceCents: Math.round(l.unitPrice * 100), vatRate: l.vatRate })))

  const locationId = body?.locationId ? String(body.locationId) : user.loc || null
  const expectedDate = body?.expectedDate ? new Date(String(body.expectedDate)) : null
  if (expectedDate && isNaN(expectedDate.getTime())) return fail('Neveljaven pričakovani datum.', 400)

  // številčenje: zaporedje znotraj dneva (odporno na sočasnost — retry na unique)
  let po: Awaited<ReturnType<typeof createPo>> | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = (await db.purchaseOrder.count({ where: { poNumber: { startsWith: poNumberFor(new Date(), 1).slice(0, 13) } } })) + 1
    try {
      po = await createPo({ supplierId, expectedDate, totals, locationId, body, user, lines, seq })
      break
    } catch (e) {
      const msg = String((e as Error).message || '')
      if (msg.includes('poNumber') && attempt < 4) continue // sočasno številčenje — poskusi znova
      throw e
    }
  }
  if (!po) return fail('Ustvarjanje naročila ni uspelo (številčenje).', 500)

  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'PO_CREATE', entityType: 'PurchaseOrder', entityId: po.id, details: jstr({ poNumber: po.poNumber, supplierId, supplierName: supplier.name, lines: lines.length, subtotalCents: totals.subtotalCents, vatCents: totals.vatCents, totalCents: totals.totalCents, locationId, }), id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2,
      id: __aId2,
      userId: user.sub,
      action: 'PO_CREATE',
      entityType: 'PurchaseOrder',
      entityId: po.id,
      details: jstr({
        poNumber: po.poNumber,
        supplierId,
        supplierName: supplier.name,
        lines: lines.length,
        subtotalCents: totals.subtotalCents,
        vatCents: totals.vatCents,
        totalCents: totals.totalCents,
        locationId,
      }),
    },
  })

  return ok(
    {
      order: {
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        supplierName: po.Supplier?.name || '',
        subtotal: Number(po.subtotal),
        vatAmount: Number(po.vatAmount),
        totalAmount: Number(po.totalAmount),
        items: po.PurchaseOrderItem.map(serializeItem),
      },
    },
    201
  )
}

async function createPo(args: {
  supplierId: string
  expectedDate: Date | null
  totals: { subtotalCents: number; vatCents: number; totalCents: number }
  locationId: string | null
  body: Record<string, unknown> | null
  user: { sub: string; name?: string }
  lines: {
    description: string
    inventoryItemId: string | null
    quantityOrdered: number
    unit: string
    unitPrice: number
    vatRate: number
    totalPrice: number
    packQty: number | null
    packUnit: string | null
  }[]
  seq: number
}) {
  const { supplierId, expectedDate, totals, locationId, body, user, lines, seq } = args
  return db.$transaction(async (tx) => {
    const created = await tx.purchaseOrder.create({
      data: {
        id: nid(),
        poNumber: poNumberFor(new Date(), seq),
        supplierId,
        status: 'draft',
        expectedDate,
        subtotal: totals.subtotalCents / 100,
        vatAmount: totals.vatCents / 100,
        totalAmount: totals.totalCents / 100,
        deliveryAddress: String(body?.deliveryAddress || ''),
        deliveryNotes: String(body?.deliveryNotes || ''),
        notes: String(body?.notes || ''),
        locationId,
        requestedBy: user.name || '',
        requestedById: user.sub || null,
        PurchaseOrderItem: {
          create: lines.map((l) => ({ ...l, id: nid() })),
        },
      },
      include: { PurchaseOrderItem: true, Supplier: { select: { name: true } } },
    })

    // katalog dobavitelja (SupplierItem) — aditivno: dodaj samo, če vez še ne obstaja
    for (const l of lines) {
      if (!l.inventoryItemId) continue
      const existing = await tx.supplierItem.findUnique({
        where: { supplierId_inventoryItemId: { supplierId, inventoryItemId: l.inventoryItemId } },
      })
      if (!existing) {
        await tx.supplierItem.create({
          data: { id: nid(), supplierId, inventoryItemId: l.inventoryItemId, pricePerPack: l.unitPrice, packQty: l.packQty ?? 1, packUnit: l.packUnit ?? 'paket', vatRate: l.vatRate },
        })
      }
    }
    return created
  })
}
