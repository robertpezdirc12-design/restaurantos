/**
 * E2E v1.243.0 — POVRAČILNA CELICA (živa, proti dev strežniku :3000).
 *
 * Zlata pot: naročilo → kupon odkup (10 %) → plačilo s točkami (300) + darilno
 * kartico (4 €) + gotovino (2 €) → STORNO → povračila VSEH instrumentov.
 *
 * Fikstura: v243e- predpona (čista pred/po), kjer BRANJA in ASSERTI tečejo prek
 * PRAVIH HTTP rut (curl), stanja pa se preverijo neposredno v bazi (dokaz).
 */
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { nid } from '@/lib/map'

const BASE = 'http://localhost:3000'
const P = 'v243e'
const TS = Date.now()

let token = ''
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, json }
}

const num = (v: unknown) => Number(v) || 0

async function seed() {
  const loc = await db.location.create({
    data: { id: nid(), name: `${P} Lokacija`, code: `${P}-A-${TS}`, premisesId: `BLG${P}${TS}`,
      taxId: 'SI12345678', registerNumber: `${P}-REG-01`, country: 'SI', timezone: 'Europe/Ljubljana',
      loyaltyEnabled: true, loyaltyPointsPerEuro: 1, loyaltyPointsValue: 0.01 },
  })
  const mgr = await db.employee.create({
    data: { id: nid(), name: `${P} Vodja`, email: `${P}-mgr-${TS}@test.local`, role: 'owner', pin: `-pin-b`, locationId: loc.id },
  })
  const menu = await db.menu.create({ data: { id: nid(), name: `${P} meni`, locationId: loc.id } })
  const cat = await db.category.create({ data: { id: nid(), name: `${P} cat`, menuId: menu.id } })
  const item = await db.menuItem.create({ data: { id: nid(), name: `${P} Juha`, price: 10, categoryId: cat.id, vatRate: 22 } })
  const table = await db.table.create({ data: { id: nid(), number: 97, capacity: 4, locationId: loc.id, status: 'available' } })
  const guest = await db.guest.create({ data: { id: nid(), lastName: `${P} Gost`, email: `${P}-${TS}@test.local` } })
  const couponCode = `${P.toUpperCase()}-${TS}`
  await db.coupon.create({
    data: { id: nid(), code: couponCode, guestId: guest.id, reason: 'manual', percent: 10, status: 'issued',
      issuedAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() + 30 * 86_400_000),
      locationId: loc.id, note: `${P} ročna izdaja` },
  })
  const gc = await db.giftCard.create({
    data: { id: nid(), cardNumber: `GC-${P}-${TS}`, balance: 10, initialBalance: 10, status: 'active', ownerName: `${P} Gost`, locationId: loc.id },
  })
  await db.giftCardTransaction.create({
    data: { id: nid(), giftCardId: gc.id, type: 'issue', amount: 10, balanceAfter: 10, note: `${P} izdaja` },
  })
  const loy = await db.loyaltyAccount.create({
    data: { id: nid(), customerName: `${P} Zvesti`, customerPhone: '+38640111222', pointsBalance: 500, lifetimePoints: 500, tier: 'gold', isActive: true, locationId: loc.id },
  })
  const tok = createToken({ sub: mgr.id, name: `${P} Vodja`, role: 'MANAGER', loc: loc.id, sv: 0 })
  return { locId: loc.id, mgrId: mgr.id, itemId: item.id, tableId: table.id, guestId: guest.id, couponCode, gcId: gc.id, loyId: loy.id, tok }
}

async function cleanup() {
  const locs = await db.location.findMany({ where: { code: { startsWith: `${P}-` } } })
  for (const loc of locs) {
    const orders = await db.order.findMany({ where: { locationId: loc.id }, select: { id: true } })
    for (const o of orders) {
      const items = await db.orderItem.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } }).catch(() => null)
      const stx = await db.stockTransaction.findMany({ where: { orderId: o.id }, select: { id: true } })
      await db.stockBatchAllocation.deleteMany({ where: { stockTransactionId: { in: stx.map((t) => t.id) } } }).catch(() => null)
      const checks = await db.check.findMany({ where: { orderId: o.id }, select: { id: true } })
      for (const c of checks) {
        await db.giftCardTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
        await db.loyaltyTransaction.deleteMany({ where: { checkId: c.id } }).catch(() => null)
      }
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { entityId: o.id } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { OR: [{ entityId: o.id }, { details: { contains: P } }] } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.stockTransaction.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: o.id } }).catch(() => null)
      await db.order.deleteMany({ where: { id: o.id } }).catch(() => null)
    }
    const tables = await db.table.findMany({ where: { locationId: loc.id }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.auditLog.deleteMany({ where: { entityId: { in: tables.map((t) => t.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.menuItemModifierGroup.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    const gcs = await db.giftCard.findMany({ where: { locationId: loc.id }, select: { id: true } })
    for (const g of gcs) await db.giftCardTransaction.deleteMany({ where: { giftCardId: g.id } }).catch(() => null)
    await db.giftCard.deleteMany({ where: { id: { in: gcs.map((g) => g.id) } } }).catch(() => null)
    const las = await db.loyaltyAccount.findMany({ where: { locationId: loc.id }, select: { id: true } })
    for (const a of las) await db.loyaltyTransaction.deleteMany({ where: { loyaltyAccountId: a.id } }).catch(() => null)
    await db.loyaltyAccount.deleteMany({ where: { id: { in: las.map((a) => a.id) } } }).catch(() => null)
    await db.coupon.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    const guests = await db.guest.findMany({ where: { email: { startsWith: `${P}-` } }, select: { id: true } })
    for (const g of guests) {
      await db.guestConsent.deleteMany({ where: { guestId: g.id } }).catch(() => null)
      await db.guestFeedback.deleteMany({ where: { guestId: g.id } }).catch(() => null)
      await db.guestVisit.deleteMany({ where: { guestId: g.id } }).catch(() => null)
      await db.guest.deleteMany({ where: { id: g.id } }).catch(() => null)
    }
    await db.employee.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: { startsWith: `receipt:${loc.id}` } } }).catch(() => null)
    await db.location.deleteMany({ where: { id: loc.id } }).catch(() => null)
  }
  console.log('ČIŠČENJE: v243e fiksture odstranjene')
}

async function main() {
  await cleanup()
  const f = await seed()
  token = f.tok
  H.authorization = `Bearer ${token}`
  const out: string[] = []
  const ok = (name: string, cond: boolean, detail = '') => {
    out.push(`${cond ? '✓' : '✗ NAPAKA'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!cond) process.exitCode = 1
  }

  /* 1 — naročilo (1× Juha 10 €) */
  const order = await api('POST', '/api/orders', { tableId: f.tableId, items: [{ menuItemId: f.itemId, qty: 1 }], type: 'DINE_IN', guests: 2 })
  const orderId = (order.json as { order?: { id: string } }).order?.id ?? ''
  ok('POST /api/orders 201', order.status === 201, `status=${order.status}`)

  /* 2 — odkup kupona 10 % (1 €) */
  const disc = await api('POST', `/api/orders/${orderId}/discount`, { couponCode: f.couponCode })
  ok('kupon odkupljen (10 %)', disc.status === 200, `status=${disc.status} body=${JSON.stringify(disc.json).slice(0, 120)}`)
  const discAmount = num((disc.json as { discount?: number }).discount)
  ok('popust 1,00 €', Math.round(discAmount * 100) === 100, `amount=${discAmount}`)

  /* 3 — plačilo: 300 točk (3 €) + GC 4 € + gotovina 2 € = 9 € */
  const pay = await api('POST', '/api/furs', {
    orderId, loyaltyAccountId: f.loyId, loyaltyPointsUsed: 300,
    parts: [
      { type: 'giftcard', amount: 4, giftCardId: f.gcId },
      { type: 'cash', amount: 2 },
    ],
    clientOperationId: `${P}-furs-${TS}`,
  })
  const receiptId = (pay.json as { invoice?: { id: string } }).invoice?.id ?? ''
  ok('POST /api/furs 201', pay.status === 201, `status=${pay.status} body=${JSON.stringify(pay.json).slice(0, 160)}`)

  /* 4 — vmesna stanja (dokaz odjema) */
  const gcMid = await db.giftCard.findUnique({ where: { id: f.gcId } })
  ok('GC saldo po plačilu 6,00 €', Math.round(num(gcMid?.balance) * 100) === 600, `balance=${num(gcMid?.balance)}`)
  const loyMid = await db.loyaltyAccount.findUnique({ where: { id: f.loyId } })
  ok('točke po plačilu: 500 − 300 + 9 = 209', loyMid?.pointsBalance === 209, `balance=${loyMid?.pointsBalance}`)
  ok('lifetime po plačilu 509 (gold)', loyMid?.lifetimePoints === 509 && loyMid?.tier === 'gold', `lifetime=${loyMid?.lifetimePoints} tier=${loyMid?.tier}`)
  const couponMid = await db.coupon.findFirst({ where: { code: f.couponCode } })
  ok('kupon redeemed', couponMid?.status === 'redeemed' && couponMid?.orderId === orderId)

  /* 5 — STORNO */
  const st = await api('POST', `/api/receipts/${receiptId}/storno`, { reason: `${P} E2E testni storno povračilne celice` })
  ok('storno 201', st.status === 201, `status=${st.status} body=${JSON.stringify(st.json).slice(0, 200)}`)
  const vr = ((st.json as { storno?: { valueRefunds?: Record<string, unknown> } }).storno?.valueRefunds ?? {}) as Record<string, unknown>
  ok('valueRefunds.giftCards=1', vr.giftCards === 1, JSON.stringify(vr))
  ok('valueRefunds.giftCardTotal=4', num(vr.giftCardTotal) === 4)
  ok('valueRefunds.redeemedPoints=300', vr.redeemedPoints === 300)
  ok('valueRefunds.negatedEarnedPoints=9', vr.negatedEarnedPoints === 9)
  ok('valueRefunds.couponReissued=koda', vr.couponReissued === f.couponCode)

  /* 6 — končna stanja (dokaz povračila) */
  const gcAfter = await db.giftCard.findUnique({ where: { id: f.gcId } })
  ok('GC saldo NAZAJ 10,00 €', Math.round(num(gcAfter?.balance) * 100) === 1000, `balance=${num(gcAfter?.balance)}`)
  const gcRefund = await db.giftCardTransaction.findFirst({ where: { giftCardId: f.gcId, type: 'refund' } })
  ok("GC 'refund' vrstica (+4, balanceAfter 10)", !!gcRefund && Math.round(num(gcRefund.amount) * 100) === 400 && Math.round(num(gcRefund.balanceAfter) * 100) === 1000)
  const loyAfter = await db.loyaltyAccount.findUnique({ where: { id: f.loyId } })
  ok('točke rekonstruirane: 209 + 300 − 9 = 500', loyAfter?.pointsBalance === 500, `balance=${loyAfter?.pointsBalance}`)
  ok('lifetime rekonstruiran 500 (gold)', loyAfter?.lifetimePoints === 500 && loyAfter?.tier === 'gold', `lifetime=${loyAfter?.lifetimePoints} tier=${loyAfter?.tier}`)
  const couponAfter = await db.coupon.findFirst({ where: { code: f.couponCode } })
  ok("kupon nazaj 'issued' (orderId čist, opomba)", couponAfter?.status === 'issued' && couponAfter?.orderId === null && (couponAfter?.note || '').includes('Ponovno izdan'))
  const auditReissue = await db.auditLog.findFirst({ where: { action: 'COUPON_REISSUED' } })
  ok('revizija COUPON_REISSUED', !!auditReissue)
  const ledger = await db.giftCardTransaction.findMany({ where: { giftCardId: f.gcId } })
  const ledgerSum = ledger.reduce((s, t) => s + num(t.amount), 0)
  ok('GC ledžer invarianta: vsota = saldo (10 − 4 + 4 = 10)', Math.round(ledgerSum * 100) === 1000, `sum=${ledgerSum}`)
  const orderAfter = await db.order.findUnique({ where: { id: orderId } })
  ok("naročilo 'storno'", orderAfter?.paymentStatus === 'storno')

  console.log(out.join('\n'))
  const failed = out.filter((l) => l.startsWith('✗')).length
  console.log(`\nE2E v1.243.0 POVRAČILNA CELICA: ${out.length - failed}/${out.length} preverjanj`)
  await cleanup()
}

main().catch(async (e) => {
  console.error('E2E NAPAKA:', e)
  await cleanup()
  process.exit(1)
})
