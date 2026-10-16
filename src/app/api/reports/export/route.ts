import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import { prevWindow, buildXzReport, avgPartySizeOf } from '@/lib/xz-report'
import { salesByHour, type SalesHourSample } from '@/lib/sales-by-hour'
import { laborByDay, laborByRole, laborPct, type LaborSample } from '@/lib/labor-cost'
import { dayKeyOf } from '@/lib/sales-by-hour'
import { liveMinutes, totalPayCents } from '@/lib/timeclock'
import { laborCoverageReport } from '@/lib/labor-coverage'
import { loadLaborCoverageData, resolveLaborCoverageWindow } from '@/lib/labor-coverage-data'

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
  // OPS-7 (v1.70.0): section=summary (privzeto) | dnevnik (račun po račun) | ddv (povzetek po stopnjah)
  const section = (url.searchParams.get('section') || 'summary').toLowerCase()
  const range = { gte: from, lte: to }

  // Issue #4 §1: izvoz je location-scoped (centralne vloge = globalno).
  // Payment nima locationId → scope prek relacije Check → Order.locationId;
  // StockTransaction nima locationId → scope prek povezanega InventoryItem.locationId.
  const locScope = await locationScope(user)
  // Issue #5 (P0, komentar #6): payScope/stockScope prej ročni centralni bypass {} —
  // izvoz je pomešal org-scoped račune s PLAČILI/ZALOGAMI vseh organizacij (knjigovodska
  // napačna čez-obračunavanja). Zdaj org allow-lista (isti vzorec kot locScope).
  const payScope = { Check: { Order: locScope } }
  const stockScope = { InventoryItem: locScope }
  const p2 = (n: number) => n.toFixed(2)

  // OPS-8 val 3 (v1.73.0): section=zz — X/Z business report (Lightspeed Business Report
  // pattern): gross/net, VAT by rate, payments by method, discounts, voids, waste,
  // covers, average check, average party size + previous equal-length period comparison.
  if (section === 'zz') {
    const pw = prevWindow(from, to)
    const [recs, stornos, pays, waste, resRows, prevRecs] = await Promise.all([
      db.receipt.findMany({
        where: { createdAt: range, isStorno: false, ...locScope },
        select: { subtotal: true, totalVat: true, discount: true, total: true, tip: true, vatBreakdown: true },
        take: 20000,
      }),
      db.receipt.findMany({
        where: { createdAt: range, isStorno: true, ...locScope },
        select: { total: true },
        take: 20000,
      }),
      db.payment.findMany({
        where: { createdAt: range, status: 'completed', ...payScope },
        select: { type: true, amount: true },
        take: 20000,
      }),
      db.wasteRecord.findMany({
        where: { createdAt: range, reversedAt: null, ...locScope },
        select: { totalCost: true },
        take: 20000,
      }),
      db.reservation.findMany({
        where: { dateTime: range, status: { not: 'cancelled' }, ...locScope },
        select: { partySize: true },
        take: 20000,
      }),
      db.receipt.aggregate({
        where: { createdAt: { gte: pw.from, lte: pw.to }, isStorno: false, ...locScope },
        _sum: { subtotal: true },
        _count: true,
      }),
    ])
    let gross = 0, net = 0, discounts = 0, tips = 0, covers = 0
    const vatMap = new Map<string, { base: number; vat: number }>()
    for (const r of recs) {
      gross += num(r.total)
      net += num(r.subtotal)
      discounts += num(r.discount)
      tips += num(r.tip)
      covers += 1
      for (const [rate, v] of Object.entries(parseVat(r.vatBreakdown))) {
        const agg = vatMap.get(rate) || { base: 0, vat: 0 }
        agg.base = r2(agg.base + v.base)
        agg.vat = r2(agg.vat + v.vat)
        vatMap.set(rate, agg)
      }
    }
    let voidedTotal = 0
    for (const s of stornos) voidedTotal += Math.abs(num(s.total))
    const payMap = new Map<string, number>()
    for (const p of pays) payMap.set(p.type, r2((payMap.get(p.type) || 0) + num(p.amount)))
    const wasteTotal = waste.reduce((a, w) => a + num(w.totalCost), 0)
    const report = buildXzReport({
      from: day(from),
      to: day(to),
      grossSales: gross,
      netSales: net,
      vatByRate: [...vatMap.entries()].map(([rate, v]) => ({ rate: Number(rate), base: v.base, amount: v.vat })),
      paymentsByMethod: [...payMap.entries()].map(([method, amount]) => ({ method, amount })),
      discountsTotal: discounts,
      tipsTotal: tips,
      voidedCount: stornos.length,
      voidedTotal,
      wasteTotal,
      covers,
      avgPartySize: avgPartySizeOf(resRows.map((r) => r.partySize)),
      prevNetSales: num(prevRecs._sum.subtotal),
      prevCovers: prevRecs._count,
      prevFrom: day(pw.from),
      prevTo: day(pw.to),
    })
    if (format === 'json') return ok({ section: 'zz', generatedAt: new Date().toISOString(), ...report })
    // CSV — same conventions as the other sections (UTF-8 BOM, `;` separator, SL literals)
    const L4: string[] = []
    L4.push(`X/Z POSLOVNO POROCILO - RestaurantOS`)
    L4.push(`Obdobje;${report.from};${report.to}`)
    L4.push(`Ustvarjeno;${new Date().toISOString()}`)
    L4.push('')
    L4.push(`PRODAJA`)
    L4.push(`Bruto prodaja (z DDV);${p2(report.grossSales)}`)
    L4.push(`Neto prodaja (brez DDV);${p2(report.netSales)}`)
    L4.push(`DDV skupaj;${p2(report.vatTotal)}`)
    L4.push(`Popusti;${p2(report.discountsTotal)}`)
    L4.push(`Napitnine;${p2(report.tipsTotal)}`)
    L4.push(`Storno - stevilo;${report.voidedCount}`)
    L4.push(`Storno - znesek;${p2(report.voidedTotal)}`)
    L4.push(`Kalo (odpad);${p2(report.wasteTotal)}`)
    L4.push('')
    L4.push(`DDV PO STOPNJAH`)
    L4.push(`Stopnja (%);Osnova;DDV (EUR)`)
    for (const v of report.vatByRate) L4.push(`${v.rate};${p2(v.base)};${p2(v.amount)}`)
    L4.push('')
    L4.push(`PLACILA PO NACINIH`)
    L4.push(`Nacin;Znesek (EUR)`)
    for (const p of report.paymentsByMethod) L4.push(`${p.method};${p2(p.amount)}`)
    L4.push('')
    L4.push(`GOSTJE`)
    L4.push(`St. racunov (covers);${report.covers}`)
    L4.push(`Povprecni racun;${p2(report.avgCheck)}`)
    L4.push(`Povprecna velikost druzbe;${report.avgPartySize}`)
    L4.push('')
    L4.push(`PRIMERJAVA S PREJSNJIM OBDOBJEM (${report.comparison.prevFrom} - ${report.comparison.prevTo})`)
    L4.push(`Neto prodaja prejsnje obdobje;${p2(report.comparison.prevNetSales)}`)
    L4.push(`Sprememba neto (%);${report.comparison.deltaNetPct === null ? '' : report.comparison.deltaNetPct}`)
    L4.push(`St. racunov prejsnje obdobje;${report.comparison.prevCovers}`)
    L4.push(`Sprememba covers (%);${report.comparison.deltaCoversPct === null ? '' : report.comparison.deltaCoversPct}`)
    const csv4 = '\uFEFF' + L4.join('\r\n')
    return new NextResponse(csv4, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="xz-porocilo_${report.from}_${report.to}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // OPS-10 val 1 (v1.77.0): section=sbh — prodaja po urah (heatmap vir).
  // Vir: plačani Orders (paidAt v obdobju); Prodaja = Order.total (z DDV).
  if (section === 'sbh') {
    const rows = await db.order.findMany({
      where: { paidAt: range, ...locScope },
      select: { paidAt: true, total: true, orderSource: true },
      take: 50000,
    })
    const samples: SalesHourSample[] = []
    for (const o of rows) {
      if (!o.paidAt) continue
      samples.push({ paidAt: o.paidAt, total: num(o.total), orderSource: o.orderSource })
    }
    const { days: byDay, totals } = salesByHour(samples)
    if (format === 'json') {
      return ok({ section: 'sbh', from: day(from), to: day(to), days: byDay, totals })
    }
    const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`
    const Ls: string[] = []
    Ls.push(`PRODAJA PO URAH - RestaurantOS`)
    Ls.push(`Obdobje;${day(from)};${day(to)}`)
    Ls.push(`Ura;Prodaja;Narocila;Povprecni racun`)
    for (const t of totals) Ls.push(`${hourLabel(t.hour)};${p2(t.revenue)};${t.orders};${p2(t.avgCheck)}`)
    Ls.push(`SKUPAJ;${p2(totals.reduce((a, t) => a + t.revenue, 0))};${totals.reduce((a, t) => a + t.orders, 0)}`)
    for (const d of byDay) {
      Ls.push('')
      Ls.push(`DAN;${d.date}`)
      Ls.push(`Ura;Prodaja;Narocila;Povprecni racun`)
      for (const b of d.dayBuckets) Ls.push(`${hourLabel(b.hour)};${p2(b.revenue)};${b.orders};${p2(b.avgCheck)}`)
    }
    const csvS = '\uFEFF' + Ls.join('\r\n')
    return new NextResponse(csvS, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="prodaja-po-urah_${day(from)}_${day(to)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // OPS-10 val 1 (v1.77.0): section=labor — labor stroški (punch×wage/net sales).
  // Vir: TimeEntry (clockIn v obdobju; odprti vnosi šteti do min(zdaj, to))
  // + neto prodaja po dnevih iz plačanih Orders (subtotal − discount).
  if (section === 'labor') {
    const nowCapped = to < new Date() ? to : new Date()
    const [entries, paidOrders] = await Promise.all([
      db.timeEntry.findMany({
        where: { clockIn: range, ...locScope },
        select: {
          clockIn: true, clockOut: true, breakMinutes: true,
          totalMinutes: true, totalPay: true, payRate: true, type: true, jobId: true,
          Job: { select: { name: true } },
        },
        take: 50000,
      }),
      db.order.findMany({
        where: { paidAt: range, paymentStatus: 'paid', ...locScope },
        select: { paidAt: true, subtotal: true, discount: true },
        take: 50000,
      }),
    ])
    const samples: LaborSample[] = entries.map((e) => {
      if (e.clockOut) {
        return { clockIn: e.clockIn, clockOut: e.clockOut, totalMinutes: e.totalMinutes, totalPay: num(e.totalPay), jobId: e.jobId, type: e.type }
      }
      const end = nowCapped < e.clockIn ? e.clockIn : nowCapped
      const live = liveMinutes(e.clockIn.getTime(), end.getTime(), e.breakMinutes)
      const livePay = live > 0 ? num(totalPayCents(live, Math.round(num(e.payRate) * 100))) / 100 : 0
      return { clockIn: e.clockIn, clockOut: end, totalMinutes: live, totalPay: livePay, jobId: e.jobId, type: e.type }
    })
    const jobNames: Record<string, string> = {}
    for (const e of entries) if (e.jobId && e.Job?.name) jobNames[e.jobId] = e.Job.name
    const netByDay = new Map<string, number>()
    for (const o of paidOrders) {
      if (!o.paidAt) continue
      const key = dayKeyOf(o.paidAt)
      netByDay.set(key, (netByDay.get(key) || 0) + Math.max(0, num(o.subtotal) - num(o.discount)))
    }
    const dayRows = laborByDay(samples).map((d) => {
      const net = Math.round((netByDay.get(d.date) || 0) * 100) / 100
      return { ...d, net, pct: laborPct(d.cost, net) }
    })
    const roleRows = laborByRole(samples, jobNames)
    if (format === 'json') {
      return ok({ section: 'labor', from: day(from), to: day(to), days: dayRows, roles: roleRows })
    }
    const Ll: string[] = []
    Ll.push(`LABOR STROSKI - RestaurantOS`)
    Ll.push(`Obdobje;${day(from)};${day(to)}`)
    Ll.push(`Datum;Minute;Strosek (EUR);Neto prodaja (EUR);Labor %`)
    for (const d of dayRows) Ll.push(`${d.date};${d.minutes};${p2(d.cost)};${p2(d.net)};${d.pct === null ? '' : d.pct}`)
    Ll.push(`SKUPAJ;${Math.round(dayRows.reduce((a, d) => a + d.minutes, 0) * 100) / 100};${p2(dayRows.reduce((a, d) => a + d.cost, 0))};${p2([...netByDay.values()].reduce((a, v) => a + v, 0))}`)
    Ll.push('')
    Ll.push(`PO VLOGAH`)
    Ll.push(`Vloga;Minute;Strosek (EUR)`)
    for (const r of roleRows) Ll.push(`${r.roleName};${r.minutes};${p2(r.cost)}`)
    const csvL = '\uFEFF' + Ll.join('\r\n')
    return new NextResponse(csvL, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="labor-stroski_${day(from)}_${day(to)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // Issue #10 (P2, v1.117.0): section=labor-coverage — strošek dela + napoved
  // pokritosti izmen glede na prodajo. ISTI motor in ISTI viri kot
  // /api/reports/labor-coverage (skupni loader src/lib/labor-coverage-data.ts)
  // — izvoz uporablja ISTI obračun kot UI (zahteva issue #10).
  // Okno ima lastno strogo validacijo (privzeto zadnjih 28 dni, ≤ 90 dni,
  // to ≤ danes — resolveLaborCoverageWindow); extra query: locationId?, jobId?
  // (drugi odseki ostajajo brez eksplicitnega lokacijskega/vložnega filtra).
  if (section === 'labor-coverage') {
    const lcWin = resolveLaborCoverageWindow(fromP, toP)
    if ('error' in lcWin) return fail(lcWin.error, 400)
    const data = await loadLaborCoverageData(
      user,
      lcWin.from,
      lcWin.to,
      url.searchParams.get('locationId'),
      url.searchParams.get('jobId'),
    )
    if (isResponse(data)) return data
    const report = laborCoverageReport(data.input)
    const genAt = new Date().toISOString()

    if (format === 'json') {
      return ok({
        section: 'labor-coverage',
        ...report,
        exportMeta: {
          exportedAt: genAt,
          from: lcWin.from,
          to: lcWin.to,
          locationId: url.searchParams.get('locationId'),
          jobId: url.searchParams.get('jobId'),
        },
      })
    }

    // CSV — BOM + `;` + CRLF, 2 decimalki (p2), SL glave (vzorec drugih sekcij)
    const eur = (cents: number | null) => (cents === null ? '' : p2(cents / 100))
    const mnum = (v: number | null) => (v === null ? '' : String(r2(v)))
    const L10: string[] = []
    // ── PARAMETRI ──
    L10.push(`LABOR POKRITOST - RestaurantOS`)
    L10.push(`Obdobje;${report.parameters.from};${report.parameters.to}`)
    L10.push(`Ustvarjeno;${genAt}`)
    L10.push(`Lokacije;${report.parameters.locationIds.join(',')}`)
    L10.push(`Valute;${report.parameters.currencies.join(',')}`)
    if (report.parameters.jobId) L10.push(`Filter vloga (jobId);${report.parameters.jobId}`)
    L10.push(`Ciljni Labor %;${report.parameters.targetPct}`)
    L10.push(`Opozorilni %;${report.parameters.warnPct}`)
    L10.push(`Nizki %;${report.parameters.lowPct}`)
    L10.push(`Napoved (dni);${report.parameters.forecastDays}`)
    L10.push(`Vzorci (dnevi z prodajo);${report.parameters.sampleDays}`)
    L10.push(`Zaprti dnevi (brez naročil);${report.parameters.closedDays}`)
    L10.push(`Naložene vrstice;naročila;${report.parameters.counts.orders};vnosi;${report.parameters.counts.entries};izmene;${report.parameters.counts.shifts}`)
    L10.push('')
    // ── DNEVI ──
    L10.push(`DNEVI`)
    L10.push(`Datum;Neto prodaja (EUR);Naročila;Načrtovane minute;Načrtovani strošek (EUR);Nepopolne izmene;Dejanske minute;Dejanski strošek (EUR);Odprti vnosi;Nepotrjeni;Stopnja 0;Nadure minute;Varianca minute;Labor %;SPH (EUR);Strošek/naročilo (EUR)`)
    for (const d of report.days) {
      L10.push([
        d.date, p2(d.netSalesCents / 100), d.orders, d.plannedMinutes, p2(d.plannedCostCents / 100),
        d.plannedIncomplete, mnum(d.actualMinutes), p2(d.actualCostCents / 100), d.openEntries,
        d.unapproved, d.rateZero, mnum(d.overtimeMinutes), mnum(d.varianceMinutes),
        mnum(d.laborPct), eur(d.sphCents), eur(d.costPerOrderCents),
      ].join(';'))
    }
    const t = report.totals
    L10.push([
      `SKUPAJ`, p2(t.netSalesCents / 100), t.orders, t.plannedMinutes, p2(t.plannedCostCents / 100),
      ``, mnum(t.actualMinutes), p2(t.actualCostCents / 100), ``, ``, ``,
      mnum(t.overtimeMinutes), mnum(t.varianceMinutes), mnum(t.laborPct), eur(t.sphCents), eur(t.costPerOrderCents),
    ].join(';'))
    L10.push('')
    // ── URE (7×24) ──
    L10.push(`PRODAJA IN DELO PO URAH (7x24, dan = 1 ponedeljek)`)
    L10.push(`Dan;Ura;Neto prodaja (EUR);Naročila;Delo minute;Zaposleni`)
    for (const h of report.hours) {
      L10.push([h.dow, h.hour, p2(h.netSalesCents / 100), h.orders, mnum(h.laborMinutes), mnum(h.staffOn)].join(';'))
    }
    L10.push('')
    // ── NAPOVED PRODAJE ──
    L10.push(`NAPOVED PRODAJE (povprečje istega dneva tedna)`)
    L10.push(`Datum;Pričakovana neto prodaja (EUR);Min (EUR);Maks (EUR);Vzorci;Zaupanje;Zaprti dnevi`)
    for (const f of report.forecast.days) {
      L10.push([
        f.date, eur(f.expectedNetSalesCents), eur(f.minCents), eur(f.maxCents),
        f.sampleCount, f.confidence, f.closedDays,
      ].join(';'))
    }
    L10.push('')
    // ── POKRITOST (prihodnje izmene) ──
    L10.push(`POKRITOST PRIHODNJIH IZMEN`)
    L10.push(`Datum;Načrtovane minute;Načrtovani strošek (EUR);Nepopolna stopnja;Pričakovana neto prodaja (EUR);Pričakovani Labor %;Zastavica;Prekrivanja;Dolge brez odmora`)
    for (const c of report.forecast.coverage) {
      L10.push([
        c.date, c.plannedMinutes, p2(c.plannedCostCents / 100), mnum(c.incompleteRate),
        eur(c.expectedNetSalesCents), mnum(c.expectedPct), c.flag ?? '', c.overlaps, c.longNoBreak,
      ].join(';'))
    }
    L10.push('')
    // ── VLOGE ──
    L10.push(`VLOGE`)
    L10.push(`Vloga;Načrtovane minute;Načrtovani strošek (EUR);Dejanske minute;Dejanski strošek (EUR)`)
    for (const r of report.roles) {
      L10.push([r.name, mnum(r.plannedMinutes), p2(r.plannedCostCents / 100), mnum(r.actualMinutes), p2(r.actualCostCents / 100)].join(';'))
    }
    L10.push('')
    // ── IZJEME (podatkovna kakovost) ──
    const dq = report.dataQuality
    L10.push(`IZJEME (PODATKOVNA KAKOVOST)`)
    L10.push(`Odprti vnosi;${dq.openEntries}`)
    L10.push(`Stopnja 0 (zaprti vnosi);${dq.rateZero}`)
    L10.push(`Prekrivajoči vnosi (pari);${dq.overlapPairs}`)
    L10.push(`Nepotrjeni vnosi;${dq.unapproved}`)
    L10.push(`Izmene brez postavke;${dq.missingRateShifts}`)
    L10.push(`Mešane valute;${dq.mixedCurrencies > 1 ? `DA (${dq.mixedCurrencies})` : 'NE'}`)
    if (dq.reasons.length > 0) L10.push(`Razlogi (kode);${dq.reasons.join(',')}`)
    const csv10 = '\uFEFF' + L10.join('\r\n')
    return new NextResponse(csv10, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="labor-pokritost_${report.parameters.from}_${report.parameters.to}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  type DayRow = { count: number; net: number; vat: number; discount: number; gross: number; tip: number; grossWithTip: number }
  // ── 1) Računi ──
  const receipts = await db.receipt.findMany({
    where: { createdAt: range, isStorno: false, ...locScope },
    select: { createdAt: true, subtotal: true, vatBreakdown: true, totalVat: true, discount: true, total: true, tip: true, totalWithTip: true },
    orderBy: { createdAt: 'asc' as const },
    take: 20000,
  })
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
    where: { createdAt: range, type: { in: ['SALE', 'RECEIVE', 'ADJUST', 'WASTE', 'STORNO_RETURN', 'TRANSFER_IN', 'TRANSFER_OUT'] }, ...stockScope },
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

  if (section === 'dnevnik') {
    // OPS-7: DNEVNIK PRODAJE — dokument po dokument (knjigovodski pripenjanek; DURS-prijazno polja)
    const docs = await db.receipt.findMany({
      where: { createdAt: range, ...locScope },
      select: {
        receiptNumber: true, createdAt: true, subtotal: true, totalVat: true, discount: true, total: true, tip: true, totalWithTip: true,
        paymentMethod: true, eor: true, isStorno: true, stornoOf: true, vatBreakdown: true,
      },
      orderBy: { createdAt: 'asc' as const },
      take: 50000,
    })
    if (format === 'json') {
      return ok({ section: 'dnevnik', from: day(from), to: day(to), documents: docs.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), vat: parseVat(d.vatBreakdown) })) })
    }
    const L2: string[] = []
    L2.push(`DNEVNIK PRODAJE - RestaurantOS`)
    L2.push(`Obdobje;${day(from)};${day(to)}`)
    L2.push(`Stevilka racuna;Datum/cas;Storno;Storno od;Nacin placila;Neto;DDV;Popust;Skupaj;Napitnina;Skupaj z napitnino;EOR`)
    for (const d of docs) {
      L2.push([d.receiptNumber, d.createdAt.toISOString(), d.isStorno ? 'DA' : '', d.stornoOf || '', d.paymentMethod, p2(num(d.subtotal)), p2(num(d.totalVat)), p2(num(d.discount)), p2(num(d.total)), p2(num(d.tip)), p2(num(d.totalWithTip)), d.eor].join(';'))
    }
    const csv2 = '\uFEFF' + L2.join('\r\n')
    return new NextResponse(csv2, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="dnevnik-prodaje_${day(from)}_${day(to)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  if (section === 'ddv') {
    // OPS-7: DDV POVZETEK — osnova/DDV po stopnjah PER DAN + skupaj (za izjavo)
    const vatRows = [...vatByRate.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([rate, v]) => ({ rate: Number(rate), base: v.base, vat: v.vat }))
    const dayRows = [...salesByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }))
    if (format === 'json') {
      return ok({ section: 'ddv', from: day(from), to: day(to), vatByRate: vatRows, salesByDay: dayRows })
    }
    const L3: string[] = []
    L3.push(`DDV POVZETEK - RestaurantOS`)
    L3.push(`Obdobje;${day(from)};${day(to)}`)
    L3.push(`Stopnja (%);Osnova;DDV;Skupaj (EUR)`)
    for (const v of vatRows) L3.push(`${v.rate};${p2(v.base)};${p2(v.vat)};${p2(v.base + v.vat)}`)
    const tBase = vatRows.reduce((a, v) => a + v.base, 0)
    const tVat = vatRows.reduce((a, v) => a + v.vat, 0)
    L3.push(`SKUPAJ;${p2(tBase)};${p2(tVat)};${p2(tBase + tVat)}`)
    L3.push('')
    L3.push(`PO DNEVIH`)
    L3.push(`Datum;St. racunov;Neto;DDV;Bruto (EUR)`)
    for (const s of dayRows) L3.push(`${s.date};${s.count};${p2(s.net)};${p2(s.vat)};${p2(s.gross)}`)
    const csv3 = '\uFEFF' + L3.join('\r\n')
    return new NextResponse(csv3, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ddv-povzetek_${day(from)}_${day(to)}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
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
