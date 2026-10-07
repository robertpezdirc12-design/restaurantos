import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, isCentralRole } from '@/lib/api'
import { num } from '@/lib/map'

type VatRow = { base: number; vat: number }

/** Varstno parsanje vatBreakdown (shranjen kot JSON string: Record<rate, {base, vat}>) */
function parseVat(raw: unknown): Record<string, VatRow> {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}') } catch { return {} }
  }
  if (!obj || typeof obj !== 'object') return {}
  const out: Record<string, VatRow> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'base' in (v as VatRow) && 'vat' in (v as VatRow)) {
      out[k] = { base: num((v as VatRow).base as never), vat: num((v as VatRow).vat as never) }
    }
  }
  return out
}

const r2 = (n: number) => Math.round(n * 100) / 100
const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Računovodski izvoz (GitLab issue #1 — "ostalo odprto": računovodski izvoz).
 * GET /api/reports/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json
 * - Prodaja po dnevih (računi: neto, DDV, popusti, bruto, napitnine)
 * - DDV razčlenba po stopnjah (iz vatBreakdown izdanih računov)
 * - Plačila po načinih (Payment: cash/card/mobile/voucher/giftcard/loyalty/…)
 * - Stroški — računi dobaviteljev (AccountsPayable) po statusih
 * - Gibanje zalog (StockTransaction: SALE/RECEIVE/ADJUST/WASTE) z vrednostjo
 * CSV: UTF-8 BOM, ločilo `;` (pripravljeno za slovenske računovodske programe/Excel).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const now = new Date()
  const fromP = url.searchParams.get('from')
  const toP = url.searchParams.get('to')
  const from = fromP ? new Date(`${fromP}T00:00:00`) : (() => { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d })()
  const to = toP ? new Date(`${toP}T23:59:59.999`) : now
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return fail('Neveljaven datum (pričakovano YYYY-MM-DD).', 400)
  if (from > to) return fail('Datum "from" je za datumom "to".', 400)
  const format = (url.searchParams.get('format') || 'csv').toLowerCase()
  const range = { gte: from, lte: to }

  // Issue #4 §1: izvoz je location-scoped (centralne vloge = globalno).
  // Payment nima locationId → scope prek relacije Check → Order.locationId;
  // StockTransaction nima locationId → scope prek povezanega InventoryItem.locationId.
  const locScope = locationScope(user)
  const payScope = isCentralRole(user) ? {} : { Check: { Order: { locationId: user.loc || '__no_location__' } } }
  const stockScope = isCentralRole(user) ? {} : { InventoryItem: { locationId: user.loc || '__no_location__' } }

  // ── 1) Računi ──
  const receipts = await db.receipt.findMany({
    where: { createdAt: range, isStorno: false, ...locScope },
    select: { createdAt: true, subtotal: true, vatBreakdown: true, totalVat: true, discount: true, total: true, tip: true, totalWithTip: true },
    orderBy: { createdAt: 'asc' as const },
    take: 20000,
  })
  type DayRow = { count: number; net: number; vat: number; discount: number; gross: number; tip: number; grossWithTip: number }
  const salesByDay = new Map<string, DayRow>()
  const vatByRate = new Map<string, { base: number; vat: number }>()
  for (const r of receipts) {
    const d = day(r.createdAt)
    const row = salesByDay.get(d) || { count: 0, net: 0, vat: 0, discount: 0, gross: 0, tip: 0, grossWithTip: 0 }
    row.count += 1
    row.net = r2(row.net + num(r.subtotal))
    row.vat = r2(row.vat + num(r.totalVat))
    row.discount = r2(row.discount + num(r.discount))
    row.gross = r2(row.gross + num(r.total))
    row.tip = r2(row.tip + num(r.tip))
    row.grossWithTip = r2(row.grossWithTip + num(r.totalWithTip))
    salesByDay.set(d, row)
    for (const [rate, v] of Object.entries(parseVat(r.vatBreakdown))) {
      const agg = vatByRate.get(rate) || { base: 0, vat: 0 }
      agg.base = r2(agg.base + v.base)
      agg.vat = r2(agg.vat + v.vat)
      vatByRate.set(rate, agg)
    }
  }

  // ── 2) Plačila po načinih ──
  const payments = await db.payment.findMany({
    where: { createdAt: range, status: 'completed', ...payScope },
    select: { type: true, amount: true, tipAmount: true },
    take: 20000,
  })
  const payByType = new Map<string, { count: number; amount: number; tips: number }>()
  for (const p of payments) {
    const t = p.type as string
    const row = payByType.get(t) || { count: 0, amount: 0, tips: 0 }
    row.count += 1
    row.amount = r2(row.amount + num(p.amount))
    row.tips = r2(row.tips + num(p.tipAmount))
    payByType.set(t, row)
  }

  // ── 3) Stroški — računi dobaviteljev ──
  const aps = await db.accountsPayable.findMany({
    where: { invoiceDate: range, ...locScope },
    select: { status: true, subtotal: true, vatAmount: true, totalAmount: true, paidAmount: true },
    take: 20000,
  })
  const apByStatus = new Map<string, { count: number; subtotal: number; vat: number; total: number; paid: number }>()
  for (const a of aps) {
    const s = a.status || 'open'
    const row = apByStatus.get(s) || { count: 0, subtotal: 0, vat: 0, total: 0, paid: 0 }
    row.count += 1
    row.subtotal = r2(row.subtotal + num(a.subtotal))
    row.vat = r2(row.vat + num(a.vatAmount))
    row.total = r2(row.total + num(a.totalAmount))
    row.paid = r2(row.paid + num(a.paidAmount))
    apByStatus.set(s, row)
  }

  // ── 4) Gibanje zalog ──
  const stockTx = await db.stockTransaction.findMany({
    where: { createdAt: range, type: { in: ['SALE', 'RECEIVE', 'ADJUST', 'WASTE'] }, ...stockScope },
    select: { type: true, quantity: true, totalCost: true },
    take: 20000,
  })
  const stockByType = new Map<string, { count: number; qty: number; cost: number }>()
  for (const s of stockTx) {
    const row = stockByType.get(s.type) || { count: 0, qty: 0, cost: 0 }
    row.count += 1
    row.qty = Math.round((row.qty + num(s.quantity)) * 1000) / 1000
    row.cost = r2(row.cost + num(s.totalCost))
    stockByType.set(s.type, row)
  }

  const payload = {
    from: day(from),
    to: day(to),
    generatedAt: new Date().toISOString(),
    salesByDay: [...salesByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    vatByRate: [...vatByRate.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([rate, v]) => ({ rate: Number(rate), ...v })),
    paymentsByType: [...payByType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.amount - a.amount),
    expensesByStatus: [...apByStatus.entries()].map(([status, v]) => ({ status, ...v })),
    stockByType: [...stockByType.entries()].map(([type, v]) => ({ type, ...v })),
  }

  if (format === 'json') return ok(payload)

  // ── CSV (BOM + `;`) ──
  const L: string[] = []
  const p2 = (n: number) => n.toFixed(2)
  L.push(`RACUNOVODSKI IZVOZ - RestaurantOS`)
  L.push(`Obdobje;${payload.from};${payload.to}`)
  L.push(`Ustvarjeno;${payload.generatedAt}`)
  L.push('')
  L.push(`PRODAJA PO DNEVIH`)
  L.push(`Datum;St. racunov;Neto (brez DDV);DDV;Popusti;Bruto;Napitnine;Bruto z napitnino (EUR)`)
  for (const s of payload.salesByDay) L.push(`${s.date};${s.count};${p2(s.net)};${p2(s.vat)};${p2(s.discount)};${p2(s.gross)};${p2(s.tip)};${p2(s.grossWithTip)}`)
  const sum = (f: (s: DayRow & { date: string }) => number) => p2(payload.salesByDay.reduce((a, s) => a + f(s), 0))
  L.push(`SKUPAJ;${payload.salesByDay.reduce((a, s) => a + s.count, 0)};${sum((s) => s.net)};${sum((s) => s.vat)};${sum((s) => s.discount)};${sum((s) => s.gross)};${sum((s) => s.tip)};${sum((s) => s.grossWithTip)}`)
  L.push('')
  L.push(`DDV RAZČLEMBA`)
  L.push(`Stopnja (%);Osnova;DDV (EUR)`)
  for (const v of payload.vatByRate) L.push(`${v.rate};${p2(v.base)};${p2(v.vat)}`)
  L.push('')
  L.push(`PLAČILA PO NAČINIH`)
  L.push(`Način;St. plačil;Znesek;Napitnine (EUR)`)
  for (const p of payload.paymentsByType) L.push(`${p.type};${p.count};${p2(p.amount)};${p2(p.tips)}`)
  L.push('')
  L.push(`STROŠKI — RAČUNI DOBAVITELJEV`)
  L.push(`Status;St. dokumentov;Neto;DDV;Skupaj;Plačano (EUR)`)
  for (const e of payload.expensesByStatus) L.push(`${e.status};${e.count};${p2(e.subtotal)};${p2(e.vat)};${p2(e.total)};${p2(e.paid)}`)
  L.push('')
  L.push(`GIBANJE ZALOG`)
  L.push(`Vrsta;St. premikov;Količina;Vrednost (EUR)`)
  for (const s of payload.stockByType) L.push(`${s.type};${s.count};${s.qty};${p2(s.cost)}`)

  const csv = '\uFEFF' + L.join('\r\n')
  const fname = `izvoz-${payload.from}_${payload.to}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    },
  })
}
