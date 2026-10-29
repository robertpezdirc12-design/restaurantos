import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAnyPermission, isResponse, ok, locationScope } from '@/lib/api'
import { nid, num, r2 } from '@/lib/map'
import { dayKeyOf } from '@/lib/sales-by-hour'
import { liveMinutes, totalPayCents } from '@/lib/timeclock'
import {
  aiInsights, AI_MAX_PER_KIND,
  type InsightItemSales, type InsightHourCell,
} from '@/lib/ai-insights'

/** Meje zgodovinskega okna (dni nazaj): 7..90, privzeto 28. */
export function clampWindow(raw: string | null): number {
  // Number(null)/Number('') sta 0 — manjkajoč parameter pada na privzeto 28.
  if (raw === null || String(raw).trim() === '') return 28
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 28
  return Math.min(90, Math.max(7, n))
}

/**
 * P2-9 (v1.186.0) — GET /api/reports/ai-insights?days=28
 *
 * Vpogledi (mrtvi artikli, predlog restocka, vrhova obremenitve, labor
 * anomalije) — DETERMINISTIČNI motor (src/lib/ai-insights.ts), ki ga napaja
 * živa podatkovna baza; vsak klic se zapiše v tabelo AIConversation (prvi
 * pisec te doslej mrtve tabele — TRZNA-VRZELI-2026.md §P2-9). LLM naracija
 * ostaja odprta vrzel P2-9b; ta končna točka je njen varen temelj:
 * vprašanje (userMessage) in odgovor (aiResponse) sta že strukturirana.
 *
 * Dovoljenja: reports.sales ALI reports.labour (vpogledi se dotikajo obeh
 * svetov); lokacijski scope enako kot ostala poročila.
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now()
  // requireAnyPermission vrača AuthedContext (user + perms) — za locationScope
  // in zapis employeeId potrebujemo surov AuthPayload (ctx.user).
  const ctx = await requireAnyPermission(req, ['reports.sales', 'reports.labour'])
  if (isResponse(ctx)) return ctx
  const user = ctx.user

  const url = new URL(req.url)
  const days = clampWindow(url.searchParams.get('days'))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const now = new Date()

  const locScope = await locationScope(user)
  const [paidOrders, items, menuItems, entries] = await Promise.all([
    db.order.findMany({
      where: { paidAt: { gte: since }, paymentStatus: 'paid', ...locScope },
      select: { paidAt: true, subtotal: true, discount: true },
      take: 50000,
    }),
    db.orderItem.findMany({
      where: { voided: false, Order: { paidAt: { gte: since }, paymentStatus: 'paid', ...locScope } },
      select: { menuItemId: true, menuItemName: true, quantity: true, price: true, createdAt: true },
      take: 50000,
    }),
    db.menuItem.findMany({
      where: { isAvailable: true, Category: { Menu: { ...locScope } } },
      select: { id: true, name: true },
      take: 20000,
    }),
    db.timeEntry.findMany({
      where: { clockIn: { gte: since }, ...locScope },
      select: {
        clockIn: true, clockOut: true, breakMinutes: true,
        totalMinutes: true, totalPay: true, payRate: true,
      },
      take: 50000,
    }),
  ])

  // 1) Neto prodaja po dnevih + urni profil (dan tedna × ura).
  const dayMap = new Map<string, { netCents: number; hours: number[] }>()
  for (const o of paidOrders) {
    const paidAt = o.paidAt
    if (!paidAt) continue
    const netCents = Math.round((num(o.subtotal) - num(o.discount)) * 100)
    if (!Number.isFinite(netCents) || netCents <= 0) continue
    const key = dayKeyOf(paidAt)
    const rec = dayMap.get(key) ?? { netCents: 0, hours: new Array<number>(24).fill(0) }
    rec.netCents += netCents
    rec.hours[paidAt.getHours()] += netCents
    dayMap.set(key, rec)
  }
  const dayNet = [...dayMap.entries()]
    .map(([date, rec]) => ({ date, netCents: rec.netCents }))
  const hourProfile: InsightHourCell[] = []
  const dowSum = new Map<number, number[]>() // dow → 24 vsot
  for (const [date, rec] of dayMap) {
    const dow = (() => {
      const [y, m, d] = date.split('-').map(Number)
      return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1
    })()
    const arr = dowSum.get(dow) ?? new Array<number>(24).fill(0)
    for (let h = 0; h < 24; h++) arr[h] += rec.hours[h]
    dowSum.set(dow, arr)
  }
  for (const [dow, arr] of dowSum) {
    for (let h = 0; h < 24; h++) {
      if (arr[h] > 0) hourProfile.push({ dow, hour: h, revenueCents: arr[h] })
    }
  }

  // 2) Prodaja po artiklih (ne-voided): količina + prihodek + nazadnje prodano.
  const itemMap = new Map<string, { name: string; qty: number; revenueCents: number }>()
  for (const it of items) {
    const qty = it.quantity || 0
    const rev = Math.round(num(it.price) * 100) * qty
    const rec = itemMap.get(it.menuItemId) ?? { name: it.menuItemName, qty: 0, revenueCents: 0 }
    rec.qty += qty
    rec.revenueCents += rev
    itemMap.set(it.menuItemId, rec)
  }
  const itemSales: InsightItemSales[] = [...itemMap.entries()].map(([menuItemId, rec]) => ({
    menuItemId,
    name: rec.name,
    qty: rec.qty,
    revenueCents: rec.revenueCents,
  }))

  // 3) Mrtvi kandidati: aktivni artikli brez ene same prodane enote v oknu.
  const soldIds = new Set(itemMap.keys())
  const deadCandidates = menuItems
    .filter((m) => !soldIds.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }))

  // 4) Labor-% po dnevih (live-minutes konvencija, kot labor-cost).
  const laborMap = new Map<string, { cents: number }>()
  for (const e of entries) {
    let m: number
    let pay: number
    if (e.clockOut) {
      m = e.totalMinutes
      pay = num(e.totalPay)
    } else {
      m = liveMinutes(e.clockIn.getTime(), now.getTime(), e.breakMinutes)
      pay = m > 0 ? num(totalPayCents(m, Math.round(num(e.payRate) * 100))) / 100 : 0
    }
    if (m <= 0) continue
    const key = dayKeyOf(e.clockIn)
    const rec = laborMap.get(key) ?? { cents: 0 }
    rec.cents += Math.round(pay * 100)
    laborMap.set(key, rec)
  }
  const dayLabor = dayNet.map((d) => {
    const lab = laborMap.get(d.date)
    if (!lab || d.netCents <= 0) return { date: d.date, laborPct: null }
    return { date: d.date, laborPct: r2((lab.cents / d.netCents) * 100) }
  })

  // 5) Deterministični motor + zapis v AIConversation (prvi pisec tabele).
  const result = aiInsights({
    windowDays: days,
    itemSales,
    deadCandidates,
    dayNet,
    dayLabor,
    hourProfile,
    targetLaborPct: 32,
  })

  const responseTimeMs = Date.now() - t0
  const conversationId = nid()
  await db.aIConversation.create({
    data: {
      id: conversationId,
      type: 'insight_pack',
      userMessage: JSON.stringify({
        window: { days, since: since.toISOString() },
        orders: paidOrders.length,
        items: itemSales.length,
        ...result.summary,
      }),
      aiResponse: JSON.stringify(result.insights),
      model: 'deterministic-v1',
      tokensUsed: 0,
      responseTimeMs,
      employeeId: user.sub, // AuthPayload.sub — lastnik vpogleda (AIConversation.employeeId)
    },
  })

  return ok({
    generatedAt: now.toISOString(),
    meta: {
      windowDays: days,
      maxPerKind: AI_MAX_PER_KIND,
      conversationId,
      responseTimeMs,
      model: 'deterministic-v1',
    },
    ...result,
  })
}
