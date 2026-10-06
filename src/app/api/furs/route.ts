import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { mapReceipt, nid, num, jstr, PAYMENT_TYPES_DB, ORDER_ACTIVE_DB } from '@/lib/map'

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
 * Plačilo + FURS račun.
 * FURS v rekonstrukciji: SIMULACIJA (env FURS_ALLOW_SIMULATION na Vercel projektu je true,
 * kot v originalu). ZOI = MD5 payload (simulacija), EOR = UUID. Produkcija piše:
 *  - Receipt (fiscalni račun z ZOI/EOR/vatBreakdown)
 *  - Check   (blagajniški račun naročila)
 *  - Payment (plačilna transakcija, tip: cash|card|mobile|...)
 *  - Order   (paymentStatus=paid, paidAt)
 */
export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.orderId) return fail('orderId je obvezen.')

  const order = await db.order.findUnique({
    where: { id: body.orderId },
    include: { OrderItem: true, Table: true },
  })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.paymentStatus === 'paid') return fail('Naročilo je že plačano.')
  if (!ORDER_ACTIVE_DB.includes(order.status) && order.status !== 'paid') {
    return fail('Naročilo ni v plačljivem stanju.', 409)
  }

  const location = await db.location.findUnique({ where: { id: order.locationId } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  const fursEnv = process.env.FURS_ENVIRONMENT || location.fursEnvironment || 'simulation'
  const simulation = process.env.FURS_ALLOW_SIMULATION === 'true' || ['simulation', 'test'].includes(fursEnv.toLowerCase())

  const subtotal = num(order.subtotal)
  const totalVat = num(order.tax)
  const total = num(order.total)
  const tip = num(order.tip)
  const paymentMethod = PAYMENT_TYPES_DB.includes(String(body.type || '').toLowerCase())
    ? String(body.type).toLowerCase()
    : 'cash'

  // ZOI (simulacija): MD5(Davčnašt + datum + št. računa + poslovni prostor + blagajna + znesek)
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const seq = (await db.receipt.count({ where: { locationId: location.id } })) + 1
  const receiptNumber = `${y}-${m}-${seq}-${location.premisesId || 'BLG001'}`
  const zoiPayload = `${location.taxId}${now.toISOString()}${receiptNumber}${location.premisesId || 'BLG001'}${total.toFixed(2)}`
  const zoi = crypto.createHash('md5').update(zoiPayload).digest('hex')
  const eor = simulation ? crypto.randomUUID().toUpperCase() : ''

  // razčlenba DDV po stopnjah
  const vatMap: Record<string, { base: number; vat: number }> = {}
  for (const it of order.OrderItem) {
    const rate = num(it.vatRate, 22).toFixed(2)
    const base = num(it.price) * (it.quantity || 0)
    const vat = num(it.vatAmount)
    if (!vatMap[rate]) vatMap[rate] = { base: 0, vat: 0 }
    vatMap[rate].base += base
    vatMap[rate].vat += vat
  }

  const check = await db.check.create({
    data: {
      id: nid(),
      checkNumber: 1,
      orderId: order.id,
      subtotal,
      tax: totalVat,
      total,
      tip,
      totalWithTip: total + tip,
      paymentStatus: 'paid',
      paymentMethod,
    },
  })

  const [receipt] = await Promise.all([
    db.receipt.create({
      data: {
        id: nid(),
        receiptNumber,
        orderId: order.id,
        businessName: location.name,
        businessAddress: location.address || '',
        businessId: location.businessId || '',
        taxId: location.taxId || '',
        registerId: location.registerNumber || 'BLG-001',
        zoi,
        eor,
        fiscalVerified: simulation,
        fiscalStatus: 'verified',
        verificationDate: simulation ? now : null,
        subtotal,
        vatBreakdown: jstr(vatMap),
        totalVat,
        discount: num(order.discount),
        total,
        tip,
        totalWithTip: total + tip,
        paymentMethod,
        printedAt: now,
        locationId: location.id,
        cisStatus: 'none',
      },
    }),
    db.payment.create({
      data: {
        id: nid(),
        checkId: check.id,
        amount: total,
        tipAmount: tip,
        type: paymentMethod as 'cash' | 'card' | 'mobile' | 'voucher' | 'loyalty' | 'giftcard' | 'alternate',
        status: 'completed',
        employeeId: user.sub,
      },
    }),
    db.order.update({
      where: { id: order.id },
      data: { status: 'paid', paymentStatus: 'paid', paidAt: now, paymentMethod },
    }),
    order.tableId
      ? db.table.update({ where: { id: order.tableId }, data: { status: 'cleaning' } })
      : Promise.resolve(null),
  ])

  return ok({
    invoice: mapReceipt(receipt),
    order: { ...order, status: 'PAID', fursEor: eor },
  }, 201)
}
