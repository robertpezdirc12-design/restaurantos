import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { mapReceipt, nid, num, jstr, PAYMENT_TYPES_DB, ORDER_ACTIVE_DB } from '@/lib/map'
import { nextSequence } from '@/lib/sequences'
import { OrderError } from '@/lib/ops'

/**
 * Seznam izdanih računov (FURS). Najnovejši prvi, zadnjih 100.
 * Vključi povezavo na naročilo/mizo za prikaz v UI (zavihek Računi).
 */
export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const receipts = await db.receipt.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { Order: { include: { Table: true } } },
  })
  return ok({
    receipts: receipts.map((r) => ({
      ...mapReceipt(r),
      tableName: r.Order?.Table ? `Miza ${r.Order.Table.number ?? r.Order.Table.name ?? ''}` : null,
      orderNumber: r.Order?.orderNumber ?? null,
    })),
  })
}

/**
 * Plačilo + FURS račun — ATOMARNO (issue #1: stabilnost/idempotencija).
 * - $transaction: CAS zaščita (order.paymentStatus != paid) + Check + Receipt + Payment + miza
 *   → dvojni račun/plačilo za isti naročilo NI več mogoč (tudi ob dvojnem kliku/retry)
 * - Idempotencija: body.clientOperationId → Payment.idempotencyKey (unique); replay vrne
 *   ISTI račun (200, replayed) namesto novega
 * - Terminski POS: body.terminal.approvalCode → Payment.authorizationCode
 * - FURS: simulacija → ZOI=MD5, EOR=UUID, status 'verified'; produkcija → EOR='',
 *   status 'pending' (čaka pravo SOAP integracijo s certifikatom) + AuditLog INVOICE_ISSUE
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.orderId) return fail('orderId je obvezen.')

  const idempotencyKey =
    typeof body.clientOperationId === 'string' && body.clientOperationId.trim().length >= 8
      ? body.clientOperationId.trim().slice(0, 64)
      : typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim().length >= 8
        ? body.idempotencyKey.trim().slice(0, 64)
        : null

  // Predhodna preverjanja (definitivni odgovori, ne transakcijski)
  const orderPre = await db.order.findUnique({
    where: { id: body.orderId },
    include: { OrderItem: true, Table: true },
  })
  if (!orderPre) return fail('Naročilo ne obstaja.', 404)
  if (!ORDER_ACTIVE_DB.includes(orderPre.status) && orderPre.status !== 'paid') {
    return fail('Naročilo ni v plačljivem stanju.', 409)
  }

  // Idempotentni replay — plačilo za ta clientOperationId že obstaja?
  if (idempotencyKey) {
    const existing = await findReceiptByIdempotencyKey(idempotencyKey)
    if (existing) return ok({ invoice: existing, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
  }

  const location = await db.location.findUnique({ where: { id: orderPre.locationId } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  const fursEnv = process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation'
  const simulation =
    process.env.FURS_ALLOW_SIMULATION === 'true' || ['simulation', 'test'].includes(fursEnv.toLowerCase())

  const subtotal = num(orderPre.subtotal)
  const totalVat = num(orderPre.tax)
  const total = num(orderPre.total)
  const tip = num(orderPre.tip)
  const paymentMethod = PAYMENT_TYPES_DB.includes(String(body.type || '').toLowerCase())
    ? String(body.type).toLowerCase()
    : 'cash'

  // Terminal (issue #1: realne naprave): kartica/mobilno zahteva odobritev terminala
  const terminalApproval =
    body?.terminal && typeof body.terminal.approvalCode === 'string'
      ? body.terminal.approvalCode.trim().slice(0, 40)
      : ''
  if (['card', 'mobile'].includes(paymentMethod) && !terminalApproval) {
    return fail('Kartično plačilo zahteva odobritev terminala (approvalCode).', 402)
  }

  const now = new Date()

  // razčlenba DDV po stopnjah
  const vatMap: Record<string, { base: number; vat: number }> = {}
  for (const it of orderPre.OrderItem) {
    const rate = num(it.vatRate, 22).toFixed(2)
    const base = num(it.price) * (it.quantity || 0)
    const vat = num(it.vatAmount)
    if (!vatMap[rate]) vatMap[rate] = { base: 0, vat: 0 }
    vatMap[rate].base += base
    vatMap[rate].vat += vat
  }

  try {
    const receipt = await db.$transaction(async (tx) => {
      // CAS zaščita: posodobi naročilo SAMO če še ni plačano → dvojni klic izgubi dirko
      const cas = await tx.order.updateMany({
        where: { id: orderPre.id, paymentStatus: { not: 'paid' } },
        data: { status: 'paid', paymentStatus: 'paid', paidAt: now, paymentMethod },
      })
      if (cas.count === 0) {
        // drug klic je že plačal → vrni njegov račun (idempotentno)
        const twin = await tx.receipt.findFirst({
          where: { orderId: orderPre.id },
          orderBy: { createdAt: 'desc' },
        })
        if (twin) return { twin, duplicate: true as const }
        // plačano mimo plačilnega poteka (npr. ročni PAID) — brez računa
        throw new OrderError('Naročilo je že plačano (brez računa).', 409)
      }

      const seqFloor = await tx.receipt.count({ where: { locationId: location.id } })
      const seq = await nextSequence(tx, `receipt:${location.id}`, seqFloor + 1)
      const y = now.getFullYear()
      const m = now.getMonth() + 1
      const receiptNumber = `${y}-${m}-${seq}-${location.premisesId || 'BLG001'}`

      const zoiPayload = `${location.taxId}${now.toISOString()}${receiptNumber}${location.premisesId || 'BLG001'}${total.toFixed(2)}`
      const zoi = crypto.createHash('md5').update(zoiPayload).digest('hex')
      const eor = simulation ? crypto.randomUUID().toUpperCase() : ''

      const check = await tx.check.create({
        data: {
          id: nid(),
          checkNumber: 1,
          orderId: orderPre.id,
          subtotal,
          tax: totalVat,
          total,
          tip,
          totalWithTip: total + tip,
          paymentStatus: 'paid',
          paymentMethod,
        },
      })

      const created = await tx.receipt.create({
        data: {
          id: nid(),
          receiptNumber,
          orderId: orderPre.id,
          businessName: location.name,
          businessAddress: location.address || '',
          businessId: location.businessId || '',
          taxId: location.taxId || '',
          registerId: location.registerNumber || 'BLG-001',
          zoi,
          eor,
          fiscalVerified: simulation,
          fiscalStatus: simulation ? 'verified' : 'pending',
          verificationDate: simulation ? now : null,
          subtotal,
          vatBreakdown: jstr(vatMap),
          totalVat,
          discount: num(orderPre.discount),
          total,
          tip,
          totalWithTip: total + tip,
          paymentMethod,
          printedAt: now,
          locationId: location.id,
          cisStatus: 'none',
        },
      })

      await tx.payment.create({
        data: {
          id: nid(),
          checkId: check.id,
          amount: total,
          tipAmount: tip,
          type: paymentMethod as 'cash' | 'card' | 'mobile' | 'voucher' | 'loyalty' | 'giftcard' | 'alternate',
          status: 'completed',
          employeeId: user.sub,
          idempotencyKey,
          authorizationCode: terminalApproval,
        },
      })

      if (orderPre.tableId) {
        await tx.table.update({ where: { id: orderPre.tableId }, data: { status: 'cleaning' } })
      }

      // Revizijski dnevnik kritične operacije (issue #1: audit)
      await tx.auditLog.create({
        data: {
          id: nid(),
          userId: user.sub,
          action: 'INVOICE_ISSUE',
          entityType: 'Receipt',
          entityId: created.id,
          details: jstr({
            receiptNumber,
            orderId: orderPre.id,
            total,
            paymentMethod,
            simulation,
            terminalApproval: terminalApproval || null,
          }),
          locationId: location.id,
        },
      })

      return { twin: created, duplicate: false as const }
    })

    if (receipt.duplicate) {
      return ok({
        invoice: mapReceipt(receipt.twin),
        replayed: true,
        order: { id: orderPre.id, status: 'PAID' },
      }, 200)
    }
    return ok({
      invoice: mapReceipt(receipt.twin),
      order: { ...orderPre, status: 'PAID', fursEor: receipt.twin.eor },
    }, 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    // P2002 na Payment.idempotencyKey → vzporedni dvojnik je zmagal
    if ((e as { code?: string })?.code === 'P2002' && idempotencyKey) {
      const existing = await findReceiptByIdempotencyKey(idempotencyKey)
      if (existing) {
        return ok({ invoice: existing, replayed: true, order: { id: orderPre.id, status: 'PAID' } }, 200)
      }
    }
    console.error('[furs POST] transakcija ni uspela:', e)
    return fail('Plačila ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}

/** Poišči račun po idempotency ključu plačila (replay podpora) */
async function findReceiptByIdempotencyKey(key: string) {
  const payment = await db.payment.findUnique({
    where: { idempotencyKey: key },
    include: { Check: true },
  })
  if (!payment) return null
  const receipt = await db.receipt.findFirst({
    where: { orderId: payment.Check.orderId },
    orderBy: { createdAt: 'desc' },
  })
  return receipt ? mapReceipt(receipt) : null
}
