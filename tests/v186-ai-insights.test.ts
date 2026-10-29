import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { GET as insightsGET, clampWindow } from '../src/app/api/reports/ai-insights/route'
import { aiInsights, AI_MAX_PER_KIND, AI_LABOR_ANOMALY_PCT, type AiInsightsInput } from '../src/lib/ai-insights'

/**
 * P2-9 (v1.186.0) — AI INSIGHTS (vpogledi): deterministični motor + prvi
 * pisec tabele AIConversation (doslej mrtva — TRZNA-VRZELI-2026.md §P2-9).
 *
 * Tržna vrzel: napoved obremenitve, predlog naročila zalog, opozorila na
 * mrtve artikle. Ta izdaja zapre deterministično jedro (vrzeli P2-9a) z
 * auditabilnim zapisom vsakega klica v AIConversation; LLM naracija ostaja
 * odprta vrzel P2-9b (ni odvisnosti, ni ključev, ni omrežnih klicev — CI
 * determinističen).
 *
 * Merila:
 *  A čisti sloj — mrtvi artikli (kape 3), restock (enote/dan × 1,1, strop 1),
 *    vrhova okna, labor anomalije (cilj + 5 t. točk), prazno → 'none'
 *  B ruta — pravice (401 brez žetona, 403 brez reports.*)
 *  C ruta — srečen tok (vpogledi iz živih podatkov + AIConversation zapis:
 *    type 'insight_pack', model deterministic-v1, employeeId, responseTimeMs)
 *  D ruta — i18nKey + params oblika (UI prevaja, strežnik ne gradi besedil)
 *
 * ID-ji s predpono `v186ai-` (sweep beforeAll, cleanup afterAll).
 */

const PREFIX = 'v186ai-'
const RUN = Date.now().toString(36)

let locId = ''
let adminToken = ''
let cleanerToken = ''
let mgrToken = ''
let adminId = ''
let mgrId = ''

function req(url: string, token: string | null): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
  })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  const loc = await db.location.create({
    data: { id: `${PREFIX}loc-${RUN}`, name: `${PREFIX}Lokacija`, code: `V186AI-${RUN.toUpperCase()}`, premisesId: `${PREFIX}prem-${RUN}`, country: 'SI' },
  })
  locId = loc.id
  adminId = `${PREFIX}admin-${RUN}`
  const adminPin = employeePinFields(`9${RUN.slice(-5)}`, `${PREFIX}admin-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}Admin`, email: `${PREFIX}admin-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locId, ...adminPin },
  })
  const cleanerPin = employeePinFields(`8${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const cleaner = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locId, ...cleanerPin },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}Admin`, role: 'ADMIN', loc: locId, sv: 0 })
  cleanerToken = createToken({ sub: cleaner.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locId, sv: 0 })
  // MANAGER = NE-centralna vloga (strižen locationScope na svojo lokacijo) —
  // ADMIN bi videl tudi seedane artikle drugih lokacij (kap 3 bi zakrila fixture).
  mgrId = `${PREFIX}mgr-${RUN}`
  const mgrPin = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: { id: mgrId, name: `${PREFIX}Vodja`, email: `${PREFIX}mgr-${RUN}@test.local`, role: 'MANAGER', status: 'active', sessionVersion: 0, locationId: locId, ...mgrPin },
  })
  mgrToken = createToken({ sub: mgrId, name: `${PREFIX}Vodja`, role: 'MANAGER', loc: locId, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

describe('v1.186.0 P2-9 — čisti sloj', () => {
  const base: AiInsightsInput = {
    windowDays: 28,
    itemSales: [
      { menuItemId: 'm1', name: 'Piščančja solata', qty: 55, revenueCents: 550000 },
      { menuItemId: 'm2', name: 'Pizza Margherita', qty: 33, revenueCents: 396000 },
    ],
    deadCandidates: [
      { id: 'd1', name: 'Trkača z željo' },
      { id: 'd2', name: 'Polnjeni kumare' },
      { id: 'd3', name: 'Juha iz megle' },
      { id: 'd4', name: 'Četrti mrtvi' },
    ],
    dayNet: [{ date: '2026-10-20', netCents: 94600 }],
    dayLabor: [{ date: '2026-10-20', laborPct: 38.5 }],
    hourProfile: [
      { dow: 5, hour: 19, revenueCents: 40000 },
      { dow: 6, hour: 12, revenueCents: 25000 },
      { dow: 5, hour: 20, revenueCents: 10000 },
    ],
    targetLaborPct: 32,
  }

  test('A1 mrtvi artikli: opozorila z imenom + oknom, kapa 3', () => {
    const { insights } = aiInsights(base)
    const dead = insights.filter((i) => i.kind === 'deadItem')
    expect(dead).toHaveLength(AI_MAX_PER_KIND) // 4 kandidata → samo 3
    expect(dead.every((i) => i.severity === 'warning')).toBe(true)
    expect(dead[0].i18nKey).toBe('ai.insight.deadItem')
    expect(dead[0].params.name).toBe('Trkača z željo')
    expect(dead[0].params.days).toBe(28)
  })

  test('A2 restock: enote/dan × 1,1 (varnostni faktor), strop na 1', () => {
    const { insights } = aiInsights(base)
    const restock = insights.filter((i) => i.kind === 'restock')
    expect(restock).toHaveLength(2)
    // 55/28 × 1,1 = 2,16 → 2
    expect(restock[0].params.perDay).toBe(2)
    expect(restock[0].params.name).toBe('Piščančja solata')
    // 33/28 × 1,1 = 1,30 → 1
    expect(restock[1].params.perDay).toBe(1)
  })

  test('A3 vrhova okna: 2 najmočnejši (dan tedna × ura) celici', () => {
    const { insights } = aiInsights(base)
    const peaks = insights.filter((i) => i.kind === 'peak')
    expect(peaks).toHaveLength(2)
    expect(peaks[0].params.dow).toBe(5)
    expect(peaks[0].params.hour).toBe(19)
    expect(peaks[0].params.revenue).toBe(400)
  })

  test('A4 labor anomalija: nad ciljem + 5 t. točk', () => {
    expect(AI_LABOR_ANOMALY_PCT).toBe(5)
    const { insights } = aiInsights(base)
    const labor = insights.filter((i) => i.kind === 'labor')
    expect(labor).toHaveLength(1)
    expect(labor[0].severity).toBe('warning')
    expect(labor[0].params.pct).toBe(38.5)
    expect(labor[0].params.target).toBe(32)
    // 36 % (cilj+4) NI anomalija
    const quiet = aiInsights({ ...base, dayLabor: [{ date: '2026-10-20', laborPct: 36 }] })
    expect(quiet.insights.some((i) => i.kind === 'labor')).toBe(false)
  })

  test('A5 prazen vnos → točno en info vpogled ai.insight.none', () => {
    const { insights, summary } = aiInsights({
      windowDays: 28, itemSales: [], deadCandidates: [], dayNet: [], dayLabor: [], hourProfile: [], targetLaborPct: 32,
    })
    expect(insights).toHaveLength(1)
    expect(insights[0].kind).toBe('none')
    expect(insights[0].i18nKey).toBe('ai.insight.none')
    expect(summary.insightCount).toBe(1)
    expect(summary.deadItems).toBe(0)
  })

  test('A6 windowDays 0/NaN → stisnjen na 1 (brez delitve z nič)', () => {
    const { summary } = aiInsights({ ...base, windowDays: 0, itemSales: [{ menuItemId: 'm', name: 'X', qty: 3, revenueCents: 300 }] })
    expect(summary.windowDays).toBe(1)
    const r = aiInsights({ ...base, windowDays: Number.NaN })
    expect(r.summary.windowDays).toBe(1)
  })
})

describe('v1.186.0 P2-9 — ruta /api/reports/ai-insights', () => {
  test('B1 brez žetona → 401', async () => {
    const res = await insightsGET(req('/api/reports/ai-insights', null))
    expect(res.status).toBe(401)
  })

  test('B2 CLEANER brez reports.* → 403', async () => {
    const res = await insightsGET(req('/api/reports/ai-insights', cleanerToken))
    expect(res.status).toBe(403)
  })

  test('C1 srečen tok: živi vpogledi + AIConversation zapis', async () => {
    const now = new Date()
    // meni → kategorija → 2 artikla: en prodajan, en mrtvi
    const menu = await db.menu.create({ data: { id: `${PREFIX}menu-${RUN}`, name: `${PREFIX}Meni`, locationId: locId } })
    const cat = await db.category.create({ data: { id: `${PREFIX}cat-${RUN}`, name: `${PREFIX}Kategorija`, menuId: menu.id } })
    const soldItem = await db.menuItem.create({ data: { id: `${PREFIX}mi1-${RUN}`, name: `${PREFIX}Goveji golaž`, price: 12.5, categoryId: cat.id } })
    await db.menuItem.create({ data: { id: `${PREFIX}mi2-${RUN}`, name: `${PREFIX}Žabji kraki`, price: 18, categoryId: cat.id } })
    // plačano naročilo @ petek 19:00 pred 7 dnevi (neto 125 €)
    const paidAt = new Date(now.getTime() - 7 * 86400000)
    paidAt.setHours(19, 0, 0, 0)
    const order = await db.order.create({
      data: {
        id: `${PREFIX}o1-${RUN}`, locationId: locId, orderNumber: 965001,
        status: 'paid', paymentStatus: 'paid', subtotal: 125, discount: 0, total: 125, paidAt,
      },
    })
    await db.orderItem.create({
      data: {
        id: `${PREFIX}oi1-${RUN}`, orderId: order.id, menuItemId: soldItem.id,
        menuItemName: soldItem.name, quantity: 10, price: 12.5, vatRate: 22, vatAmount: 0, status: 'fired',
      },
    })
    // TimeEntry: 300 min za 60 € → labor 60/125 = 48 % > 37 → anomalija
    const clockIn = new Date(paidAt.getTime() - 4 * 3600000)
    await db.timeEntry.create({
      data: {
        id: `${PREFIX}te-${RUN}`, employeeId: adminId, clockIn, clockOut: new Date(paidAt.getTime() + 60 * 60000),
        breakMinutes: 0, totalMinutes: 300, payRate: 12, totalPay: 60, locationId: locId,
      },
    })

    const res = await insightsGET(req('/api/reports/ai-insights?days=28', mgrToken))
    expect(res.status).toBe(200)
    const data = await res.json() as {
      insights: Array<{ kind: string; i18nKey: string; params: Record<string, string | number> }>
      summary: Record<string, number>
      meta: { model: string; conversationId: string; windowDays: number }
    }
    expect(data.meta.windowDays).toBe(28)
    expect(data.meta.model).toBe('deterministic-v1')
    // mrtvi artikel
    expect(data.insights.some((i) => i.kind === 'deadItem' && i.params.name === `${PREFIX}Žabji kraki`)).toBe(true)
    // restock prodanega (10/28 × 1,1 = 0,39 → strop 1)
    const restock = data.insights.find((i) => i.kind === 'restock')
    expect(restock?.params.name).toBe(`${PREFIX}Goveji golaž`)
    expect(restock?.params.perDay).toBe(1)
    // vrh (petek 19)
    const peak = data.insights.find((i) => i.kind === 'peak')
    expect(peak?.params.hour).toBe(19)
    // labor anomalija (48 %)
    expect(data.insights.some((i) => i.kind === 'labor')).toBe(true)
    // AIConversation zapis (prvi pisec tabele)
    const conv = await db.aIConversation.findUnique({ where: { id: data.meta.conversationId } })
    expect(conv).not.toBeNull()
    expect(conv?.type).toBe('insight_pack')
    expect(conv?.model).toBe('deterministic-v1')
    expect(conv?.employeeId).toBe(mgrId)
    expect(conv?.responseTimeMs).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(conv!.aiResponse) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    const userMsg = JSON.parse(conv!.userMessage) as { orders: number; items: number }
    expect(userMsg.orders).toBe(1)
    expect(userMsg.items).toBe(1)
  })

  test('D1 vpogledi nosijo i18nKey + params — strežnik ne gradi besedil', async () => {
    const res = await insightsGET(req('/api/reports/ai-insights', adminToken))
    const data = await res.json() as { insights: Array<{ i18nKey: string; params: object }> }
    expect(data.insights.length).toBeGreaterThan(0)
    for (const i of data.insights) {
      expect(i.i18nKey).toMatch(/^ai\.insight\.[a-zA-Z]+$/)
      expect(typeof i.params).toBe('object')
    }
  })

  test('D2 okno se stisne na meje (7..90)', async () => {
    expect(clampWindow(null)).toBe(28)
    expect(clampWindow('2')).toBe(7)
    expect(clampWindow('500')).toBe(90)
    const res = await insightsGET(req('/api/reports/ai-insights?days=500', adminToken))
    const data = await res.json() as { meta: { windowDays: number } }
    expect(data.meta.windowDays).toBe(90)
  })
})
