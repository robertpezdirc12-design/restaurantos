import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { canTransition, type PoStatus } from '@/lib/procurement'
import { writeAudit } from '@/lib/audit-chain'
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
 * Issue #54 (P0/P1): GET in PATCH sta varovana z inventory.manage + guardResource
 * nad kanoničnim po.locationId (PREJ: GET requireAuth — vsak prijavljeni je videl
 * detail tujega naročila/prevzemov; PATCH brez varovalke — tuje naročilo je bilo
 * mogoče oddati/odobriti/preklicati). Usklajeno z GET /api/purchase-orders seznamom
 * (isti permission + isti obseg — permission brez target-scope ni dovoljen).
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
  // Issue #54: detail = isti obseg kot seznam (inventory.manage + guardResource) —
  // prej requireAuth brez varovalke (vsak prijavljeni je videl tuj detail).
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const { id } = await params

  const po = await loadPo(id)
  if (!po) return fail('Naročilo ne obstaja.', 404)

  const poGuard = await guardResource(user, po.locationId)
  if (poGuard) return poGuard

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

  // Issue #54: statusna mutacija TUJEGA naročila je zavrnjena (obseg pred operacijo)
  const poGuard = await guardResource(user, po.locationId)
  if (poGuard) return poGuard

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
    // v1.238.0 §15 (P1): CAS na statusu — updateMany je vezan na stanje, prebrano
    // OB PRIHODU. PREJ je bil `update({ where: { id } })` brezpogojen: preklic na
    // zastarel branem 'approved' je PREPISSAL 'received' (fizična dobava na zalogi,
    // GRN + AP osnutek obstajajo), approve pa oživil že preklicano naročilo.
    // Prejemna ruta ima to varovalo od prej (receive: »Ne degradiraj 'received'…«) —
    // PATCH jo zdaj zrcali (Toast/MarketMan: statusni prehodi dokumentov so vedno CAS).
    const u = await tx.purchaseOrder.updateMany({ where: { id, status: po.status }, data })
    if (u.count === 0) {
      throw new Error(`Naročilo se je medtem spremenilo (zdaj ni več »${po.status}«) — osvežite seznam in poskusite znova.`)
    }
    await writeAudit(tx, { userId: user.sub, action: action === 'submit' ? 'PO_SUBMIT' : action === 'approve' ? 'PO_APPROVE' : 'PO_CANCEL', entityType: 'PurchaseOrder', entityId: id, details: jstr({ poNumber: po.poNumber, from: po.status, to: target, supplierId: po.supplierId, total: Number(po.totalAmount) }) })
    return tx.purchaseOrder.findUnique({ where: { id }, select: { id: true, poNumber: true, status: true } })
  })
  if (!updated) return fail('Naročilo ne obstaja več.', 404)

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
