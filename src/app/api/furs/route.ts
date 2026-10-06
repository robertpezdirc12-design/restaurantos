import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'

/** Plačilo + FURS račun (v rekonstrukciji: SIMULACIJA, kot FURS_ALLOW_SIMULATION v originalu) */
export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.orderId) return fail('orderId je obvezen.')

  const order = await db.order.findUnique({ where: { id: body.orderId }, include: { items: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.status === 'PAID') return fail('Naročilo je že plačano.')

  const fursEnv = (await db.setting.findUnique({ where: { key: 'furs.environment' } }))?.value || 'SIMULATION'
  const zoi = crypto.randomUUID().replace(/-/g, '')
  const eor = fursEnv === 'SIMULATION' ? `SIM-${zoi.slice(0, 24).toUpperCase()}` : zoi
  const invoiceNumber = `${new Date().getFullYear()}-${String(order.id.slice(-6)).toUpperCase()}`

  const [invoice] = await Promise.all([
    db.fursInvoice.create({
      data: {
        orderId: order.id,
        zoi,
        eor,
        invoiceNumber,
        status: fursEnv === 'SIMULATION' ? 'SIMULATED' : 'SENT',
        payload: JSON.stringify({ order: order.id, total: order.total, env: fursEnv }),
      },
    }),
    db.order.update({
      where: { id: order.id },
      data: { status: 'PAID', closedAt: new Date(), fursEor: eor },
    }),
    order.tableId
      ? db.table.update({ where: { id: order.tableId }, data: { status: 'DIRTY' } })
      : Promise.resolve(null),
  ])

  return ok({ invoice, order: { ...order, status: 'PAID', fursEor: eor } }, 201)
}
