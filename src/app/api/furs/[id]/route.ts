import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num } from '@/lib/map'
import { vatFromGross } from '@/lib/billing'
import { fiscalAdapterFor } from '@/lib/fiscal'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params
  const [r, company] = await Promise.all([
    db.receipt.findUnique({
      where: { id },
      include: { Order: { include: { Table: true, Employee_Order_employeeIdToEmployee: true, OrderItem: { orderBy: { createdAt: 'asc' } } } }, Location: true },
    }),
    db.restaurantSettings.findFirst(),
  ])
  if (!r) return fail('Račun ne obstaja.', 404)
  const guard = await guardResource(user, r.locationId)
  if (guard) return guard

  let raw: unknown = {}
  try {
    raw = typeof r.vatBreakdown === 'string' ? JSON.parse(r.vatBreakdown) : (r.vatBreakdown ?? {})
  } catch { raw = {} }

  // audit #4: filter je bil `rate > 0 && (base > 0 || vat > 0)` → pobrisal je vse
  // 0 % stopnje IN celotno negativno razčlenitev storna. Veljaven je vsak znesek,
  // ki ni ničelen (storno ima namenoma negativno osnovo in DDV).
  const usable = (x: { rate: number; base: number; vat: number }): boolean =>
    Number.isFinite(x.rate) && x.rate >= 0 && (x.base !== 0 || x.vat !== 0)
  let breakdown: { rate: number; base: number; vat: number }[] = []
  if (Array.isArray(raw)) {
    breakdown = (raw as Record<string, unknown>[])
      .map((v) => ({ rate: Number(v?.rate ?? 0), base: num(v?.base), vat: num(v?.vat) }))
      .filter(usable)
  } else if (raw && typeof raw === 'object') {
    breakdown = Object.entries(raw as Record<string, unknown>).map(([rate, v]) => {
      const o = v as { base?: unknown; vat?: unknown } | null
      return { rate: Number(rate), base: num(o?.base), vat: num(o?.vat) }
    }).filter(usable)
  }

  // storno si deli orderId z originalom → postavke so POZITIVNE, dokument negativen.
  // Predznak dokumenta je edini vir resnice za rebuild in za izpis vrstic.
  const sign = r.isStorno || num(r.total) < 0 ? -1 : 1
  const items = (r.Order?.OrderItem ?? []).filter((i) => !i.voided).map((i) => ({
    name: i.menuItemName || 'Artikel',
    qty: i.quantity || 1,
    price: num(i.price) * sign,
    vatRate: num(i.vatRate, 22),
    vatAmount: num(i.vatAmount) * sign,
    amount: num(i.price) * (i.quantity || 1) * sign,
  }))

  if (breakdown.length === 0 && items.length > 0) {
    const m = new Map<string, { rate: number; base: number; vat: number }>()
    for (const it of items) {
      const key = it.vatRate.toFixed(2)
      const cur = m.get(key) || { rate: it.vatRate, base: 0, vat: 0 }
      // ze negirani `it.*` (zgoraj) → predznaka ne smemo uporabiti dvakrat
      const derivedVat = sign > 0 ? vatFromGross(it.amount, it.vatRate) : -vatFromGross(-it.amount, it.vatRate)
      const vat = Math.abs(it.vatAmount) > 0 ? it.vatAmount : derivedVat
      cur.base += it.amount - vat
      cur.vat += vat
      m.set(key, cur)
    }
    breakdown = [...m.values()].map((v) => ({ rate: v.rate, base: Math.round(v.base * 100) / 100, vat: Math.round(v.vat * 100) / 100 }))
  }

  return ok({ receipt: {
    id: r.id, invoiceNumber: r.receiptNumber, createdAt: r.createdAt, printedAt: r.printedAt,
    businessName: r.businessName || r.Location?.name || company?.name || '',
    businessAddress: r.businessAddress || r.Location?.address || [company?.address, company?.city].filter(Boolean).join(', ') || '',
    businessId: r.businessId || r.Location?.businessId || company?.businessId || '',
    taxId: r.taxId || r.Location?.taxId || company?.taxId || '',
    registerId: r.registerId || company?.registerNumber || 'BLG-001',
    premisesId: r.Location?.premisesId || null, zoi: r.zoi, eor: r.eor, fiscalVerified: r.fiscalVerified, fiscalStatus: r.fiscalStatus,
    subtotal: num(r.subtotal), discount: num(r.discount), totalVat: num(r.totalVat), total: num(r.total), tip: num(r.tip), totalWithTip: num(r.totalWithTip),
    paymentMethod: r.paymentMethod, isCopy: r.isCopy, isStorno: r.isStorno, vatBreakdown: breakdown,
    orderNumber: r.Order?.orderNumber ?? null,
    tableName: r.Order?.Table ? `Miza ${r.Order.Table.number ?? (r.Order.Table as unknown as { name?: string }).name ?? ''}` : null,
    operator: r.Order?.Employee_Order_employeeIdToEmployee?.name || null, items,
    // Triage SI/HR fiskalizacija: država določa pot na izpisu (ZOI/EOR vs ZKI/JIR + QR)
    country: r.Location?.country || 'SI',
    zki: r.cisZki || undefined,
    jir: r.cisJir || undefined,
    qr: (() => {
      const adapter = fiscalAdapterFor(r.Location?.country)
      if (adapter.country !== 'HR') return undefined
      return adapter.qrContent({
        verification: r.cisJir || '',
        protective: r.cisZki || '',
        issuedAt: r.createdAt,
        total: num(r.totalWithTip) > 0 ? num(r.totalWithTip) : num(r.total),
        timeZone: r.Location?.timezone,
      }) || undefined
    })(),
  }})
}
