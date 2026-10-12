import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { canTransition, type PoStatus } from '@/lib/procurement'
import { auditChainFields } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'

/**
 * Issue #1 (triage ②) — nabava: detail + statusni prehodi naročila.
 *
 * GET /api/purchase-orders/[id]
 *   → naročilo z vrsticami (naročeno/prejeto/zavrnjeno), prevzemi (GRN)
 *     in zadnjo zgodovino cen dobavitelja za povezane artikle.
 *
 * PATCH /api/purchase-orders/[id] { action: 'submit'|'approve'|'cancel' }
 *   → statusni prehodi po kanoničnem toku (osnutek → oddaja → odobritev;
 *     preklic dovoljen do odobritve/dobave). Pravica: inventory.manage.
 *     Audit: PO_SUBMIT / PO_APPROVE / PO_CANCEL.
 *
 * Urejanje vrstic osnutka ni v obsegu tega inkrementa (osnutek se zbriše in
 * ustvari novo) — prehode in prevzem pa ta ruta pokriva v celoti.
 */

async function loadPo(id: string) {
  return db.purchaseOrder.findUnique({
    where: { id },
    include: {
      Supplier: { select: { id: true, name: true, contactPerson: true, email: true, phone: true } },
      PurchaseOrderItem: { orderBy: { createdAt: 'asc' } },
      GoodsReceipt: {
        orderBy: { receivedAt: 'desc' },
        include: { GoodsReceiptItem: true },
      },
    },
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params

  const po = await loadPo(id)
  if (!po) return fail('Naročilo ne obstaja.', 404)

  const itemIds = po.PurchaseOrderItem.map((i) => i.inventoryItemId).filter((x): x is string => !!x)
  const priceHistory = itemIds.length
    ? await db.supplierPriceHistory.findMany({
        where: { supplierId: po.supplierId, inventoryItemId: { in: itemIds } },
        orderBy: { observedAt: 'desc' },
        take: 30,
      })
    : []

  return ok({
    order: {
      id: po.id,
      poNumber: po.poNumber,
      status: po.status,
      supplier: po.Supplier,
      orderDate: po.orderDate,
      expectedDate: po.expectedDate,
      receivedDate: po.receivedDate,
      subtotal: Number(po.subtotal),
      vatAmount: Number(po.vatAmount),
      totalAmount: Number(po.totalAmount),
      deliveryAddress: po.deliveryAddress,
      deliveryNotes: po.deliveryNotes,
      notes: po.notes,
      locationId: po.locationId,
      requestedBy: po.requestedBy,
      approvedBy: po.approvedBy,
      invoiceStatus: po.invoiceStatus,
      items: po.PurchaseOrderItem.map((i) => ({
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
      })),
      receipts: po.GoodsReceipt.map((g) => ({
        id: g.id,
        grnNumber: g.grnNumber,
        status: g.status,
        supplierDocNumber: g.supplierDocNumber,
        notes: g.notes,
        receivedByName: g.receivedByName,
        receivedAt: g.receivedAt,
        items: g.GoodsReceiptItem.map((gi) => ({
          description: gi.description,
          quantityAccepted: Number(gi.quantityAccepted),
          quantityRejected: Number(gi.quantityRejected),
          rejectReason: gi.rejectReason,
          unit: gi.unit,
        })),
      })),
      priceHistory: priceHistory.map((h) => ({
        inventoryItemId: h.inventoryItemId,
        unitPrice: Number(h.unitPrice),
        vatRate: h.vatRate == null ? null : Number(h.vatRate),
        unit: h.unit,
        source: h.source,
        observedAt: h.observedAt,
      })),
    },
  })
}

const ACTION_TO_TARGET: Record<string, PoStatus> = {
  submit: 'submitted',
  approve: 'approved',
  cancel: 'cancelled',
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  const action = String(body?.action || '').trim()
  const target = ACTION_TO_TARGET[action]
  if (!target) return fail('Neznano dejanje — dovoljeno: submit, approve, cancel.', 400)

  const po = await db.purchaseOrder.findUnique({ where: { id }, include: { PurchaseOrderItem: true } })
  if (!po) return fail('Naročilo ne obstaja.', 404)

  if (!canTransition(po.status as PoStatus, target)) {
    return fail(`Prehod ${po.status} → ${target} ni dovoljen (kanonični tok: osnutek → oddaja → odobritev → dobava).`, 409)
  }

  // odobritev zahteva vsaj eno vrstico; oddaja prav tako (ničelnega osnutka ne oddajamo)
  if (po.PurchaseOrderItem.length === 0) return fail('Naročilo brez vrstic ni mogoče oddati.', 400)

  const data: Record<string, unknown> = { status: target }
  if (target === 'approved') {
    data.approvedBy = user.name || ''
    data.approvedById = user.sub || null
  }
  if (target === 'cancelled') data.notes = (po.notes ? po.notes + ' | ' : '') + `Preklicano ${new Date().toISOString()} (${user.name || user.sub})`

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.purchaseOrder.update({ where: { id }, data })
    const __aId2 = nid(); const __chain2 = await auditChainFields(tx, { action: action === 'submit' ? 'PO_SUBMIT' : action === 'approve' ? 'PO_APPROVE' : 'PO_CANCEL', entityType: 'PurchaseOrder', entityId: id, details: jstr({ poNumber: po.poNumber, from: po.status, to: target, supplierId: po.supplierId, total: Number(po.totalAmount) }), id: __aId2 })
    await tx.auditLog.create({
      data: { ...__chain2,
        id: __aId2,
        userId: user.sub,
        action: action === 'submit' ? 'PO_SUBMIT' : action === 'approve' ? 'PO_APPROVE' : 'PO_CANCEL',
        entityType: 'PurchaseOrder',
        entityId: id,
        details: jstr({ poNumber: po.poNumber, from: po.status, to: target, supplierId: po.supplierId, total: Number(po.totalAmount) }),
      },
    })
    return u
  })

  // OPS-8 val 2 (v1.72.0): push to warehouse/management on PO approval (via notification
  // matrix; fire-and-forget)
  if (target === 'approved') {
    void pushEvent('PO_APPROVED', {
      title: 'Nabavno naročilo odobreno',
      body: `${po.poNumber} · ${Number(po.totalAmount).toFixed(2)} € · ${po.PurchaseOrderItem.length} vrst`,
      url: '/dashboard?tab=nabava',
      tag: `po-approved-${id}`,
    }, { roles: ['warehouse', 'manager'], locationId: po.locationId })
  }

  return ok({ order: { id: updated.id, poNumber: updated.poNumber, status: updated.status } })
}
