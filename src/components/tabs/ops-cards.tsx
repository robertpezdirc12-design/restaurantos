'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken, getUser } from '@/lib/client'
import { newOperationId } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, Legend, BarChart, Bar,
} from 'recharts'
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download, Tag } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'
/* Issue #24 (v1.114.0) — prepared-food label dialog (issue + print + QR + void). */
import { LabelDialog } from '@/components/label-dialog'

/* ─────────────────────────── ZALOGE ─────────────────────────── */

/*
 * AUDIT-FIX v1.82.1 — prvi val razreza monolita dashboard-tabs.tsx (9217 vrst.).
 * Ops kartice: analitika, DURS, push notifikacije, serije, batch priprava, upsell, display promocije.
 * dashboard-tabs.tsx ostaja nazajkompatibilen barrel (re-export) — porabniki se ne spremenijo.
 * DursCheckButton/BatchesCard/BatchPrepCard uvaža monolit (SettingsEditor/InventoryTab).
 */

/** Lazy fetch helper — resolves true once the element first enters the viewport.
 * v1.132.1 (hidracijska varnost): inicialno stanje je VEDNO false — prej je bil
 * inicializator `() => typeof IntersectionObserver === 'undefined'`, kar je SSR
 * (Node: IO ne obstaja → true → „Ni podatkov.“ izrisan) razlikovalo od prvega izrisa
 * klienta (brskalnik: IO obstaja → false → <p> NI izrisan) → React #418 ob vsakem
 * polnem nalaganju (strežniško drevo zavrženo, celoten UI izrisan na novo).
 * Old-brskalniki brez IO: effect takoj postavi true (enako končno stanje). */
function useInViewOnce<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (inView) return
    // no IntersectionObserver (old browsers) → treat as visible, a ASINHRONO
    // (setTimeout 0 — tako kot IO callback; synchroni setState v effectu povzroča
    // kaskadne izrise, react-hooks/set-state-in-effect ga prepoveduje)
    if (typeof IntersectionObserver === 'undefined') {
      const t = setTimeout(() => setInView(true), 0)
      return () => clearTimeout(t)
    }
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect() } },
      { rootMargin: '160px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView])
  return [ref, inView]
}

/** CSV download of an /api/reports/export section (Bearer-authenticated, blob save).
 * `extraQuery` (issue #10): dodatni query parametri (npr. locationId/jobId) —
 * neobvezno, nazajkompatibilno (ostali klicatelji brez spremembe). */
async function downloadReportSection(section: string, from: string, to: string, filename: string, extraQuery?: string) {
  const token = getToken()
  const res = await fetch(`/api/reports/export?section=${section}&from=${from}&to=${to}${extraQuery ? `&${extraQuery}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error || 'export failed')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 'YYYY-MM-DD' → 'DD.MM.' (compact day label for heatmap rows / tables). */
const shortDay = (iso: string) => (iso.length >= 10 ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : iso)

interface SbhRespT {
  periodDays: number
  days: { date: string; dayBuckets: { hour: number; revenue: number; orders: number; avgCheck: number }[] }[]
  totals: { hour: number; revenue: number; orders: number; avgCheck: number }[]
  edges: number[]
}

/** amber→rose heat scale (5 classes) — internal tailwind palette, no indigo/blue. */
const SBH_HEAT_CLASSES = ['bg-stone-100 border border-stone-200', 'bg-amber-100', 'bg-amber-300', 'bg-orange-500', 'bg-rose-600']

/** "Prodaja po urah" Pregled card — 24h × day heatmap + hourly totals bar chart. */
export function SalesByHourCard() {
  const { t } = useI18n()
  const [ref, inView] = useInViewOnce<HTMLDivElement>()
  const [days, setDays] = useState<'7' | '14' | '30'>('7')
  const [data, setData] = useState<SbhRespT | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  const [csvBusy, setCsvBusy] = useState(false)

  useEffect(() => {
    if (!inView) return
    let alive = true
    ;(async () => {
      setBusy(true); setErr('')
      try {
        const d = await api<SbhRespT>(`/api/reports/sales-by-hour?days=${days}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [inView, days, reload])

  const csvExport = async () => {
    setCsvBusy(true)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - Number(days) * 86400000)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      await downloadReportSection('sbh', iso(from), iso(to), `prodaja-po-urah_${iso(from)}_${iso(to)}.csv`)
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setCsvBusy(false)
    }
  }

  const edges = data?.edges || []
  const totalOrders = data ? data.totals.reduce((a, b) => a + b.orders, 0) : 0
  const totalRevenue = data ? data.totals.reduce((a, b) => a + b.revenue, 0) : 0
  const hasData = !!data && totalOrders > 0
  const chartData = data?.totals.filter((b) => b.orders > 0).map((b) => ({ ura: `${String(b.hour).padStart(2, '0')}`, prodaja: b.revenue })) || []

  return (
    <Card ref={ref}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Clock className="w-4 h-4" /> {t('sbh.title')}
          <span className="ml-auto flex items-center gap-2">
            <Select value={days} onValueChange={(v) => setDays(v as '7' | '14' | '30')}>
              <SelectTrigger className="h-7 w-24 text-xs" aria-label={t('kds.stats.period')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('kds.stats.days7')}</SelectItem>
                <SelectItem value="14">{t('kds.stats.days14')}</SelectItem>
                <SelectItem value="30">{t('kds.stats.days30')}</SelectItem>
              </SelectContent>
            </Select>
            {hasData && (
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={csvBusy} onClick={() => void csvExport()}>
                {csvBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />} {t('sbh.csv')}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">{t('sbh.desc')}</p>
        {err && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{t('sbh.error')} <span className="text-red-500/80">{err}</span></p>
            <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
          </div>
        )}
        {busy && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {!busy && data && !hasData && <p className="text-sm text-stone-500">{t('sbh.empty')}</p>}
        {!busy && hasData && data && (
          <>
            <div>
              <p className="mb-1.5 text-xs font-medium text-stone-500">{t('sbh.heat')}</p>
              <div className="overflow-x-auto">
                <div className="min-w-[520px] space-y-0.5">
                  {data.days.map((d) => (
                    <div key={d.date} className="flex items-center gap-1.5">
                      <span className="w-12 shrink-0 text-[11px] text-stone-500">{shortDay(d.date)}</span>
                      <div className="grid flex-1 gap-0.5" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
                        {d.dayBuckets.map((b) => (
                          <div
                            key={b.hour}
                            className={`h-5 rounded-sm ${SBH_HEAT_CLASSES[heatClass(b.revenue, edges)] ?? SBH_HEAT_CLASSES[0]}`}
                            title={`${d.date} ${String(b.hour).padStart(2, '0')}:00 — ${t('sbh.revenue')}: ${fmtEUR(b.revenue)} · ${t('sbh.orders')}: ${b.orders}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5">
                    <span className="w-12 shrink-0 text-[11px] font-medium text-stone-500">{t('sbh.allDays')}</span>
                    <div className="grid flex-1 gap-0.5" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
                      {data.totals.map((b) => (
                        <div
                          key={b.hour}
                          className={`h-5 rounded-sm ${SBH_HEAT_CLASSES[heatClass(b.revenue, edges)] ?? SBH_HEAT_CLASSES[0]}`}
                          title={`${String(b.hour).padStart(2, '0')}:00 — ${t('sbh.revenue')}: ${fmtEUR(b.revenue)} · ${t('sbh.orders')}: ${b.orders}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-stone-500">
                <span>{t('sbh.low')}</span>
                {SBH_HEAT_CLASSES.map((c, i) => <span key={i} className={`h-2.5 w-4 rounded-sm ${c}`} />)}
                <span>{t('sbh.high')}</span>
                <span className="ml-2">{t('sbh.sumLine', { revenue: fmtEUR(totalRevenue), orders: totalOrders })}</span>
              </p>
            </div>
            {chartData.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('sbh.chartTitle')}</p>
                <div className="h-36 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="ura" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} width={54} tickFormatter={(v: number) => fmtEUR(v)} />
                      <RTooltip formatter={(v) => fmtEUR(Number(v))} />
                      <Bar dataKey="prodaja" fill="#ea580c" radius={[3, 3, 0, 0]} name={t('sbh.revenue')} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

interface LaborRespT {
  days: { date: string; cost: number; minutes: number; overtimeMinutes: number; netSales: number; pct: number | null }[]
  roles: { roleName: string; minutes: number; cost: number }[]
  summary: { periodDays: number; totalCost: number; totalMinutes: number; totalOvertimeMinutes: number; totalNetSales: number; avgPct: number | null; targetPct: number }
}

/** Labor % badge color: green ≤32, amber ≤38, red >38 (null = no net sales base). */
const laborPctCls = (pct: number | null): string =>
  pct === null ? 'bg-stone-100 text-stone-500' : pct <= 32 ? 'bg-emerald-100 text-emerald-800' : pct <= 38 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'

/** "Labor stroški" Pregled card — daily labor % vs target + per-role top 5. */
export function LaborCostCard() {
  const { t } = useI18n()
  const [ref, inView] = useInViewOnce<HTMLDivElement>()
  const [days, setDays] = useState<'7' | '14' | '30'>('7')
  const [data, setData] = useState<LaborRespT | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  const [csvBusy, setCsvBusy] = useState(false)

  useEffect(() => {
    if (!inView) return
    let alive = true
    ;(async () => {
      setBusy(true); setErr('')
      try {
        const d = await api<LaborRespT>(`/api/reports/labor-cost?days=${days}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [inView, days, reload])

  const csvExport = async () => {
    setCsvBusy(true)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - Number(days) * 86400000)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      await downloadReportSection('labor', iso(from), iso(to), `labor-stroski_${iso(from)}_${iso(to)}.csv`)
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setCsvBusy(false)
    }
  }

  const s = data?.summary
  const hasData = !!data && (data.days.length > 0 || (s !== undefined && s.totalMinutes > 0))
  const topRoles = data?.roles.slice(0, 5) || []

  return (
    <Card ref={ref}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Wallet className="w-4 h-4" /> {t('labor.title')}
          <span className="ml-auto flex items-center gap-2">
            <Select value={days} onValueChange={(v) => setDays(v as '7' | '14' | '30')}>
              <SelectTrigger className="h-7 w-24 text-xs" aria-label={t('kds.stats.period')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('kds.stats.days7')}</SelectItem>
                <SelectItem value="14">{t('kds.stats.days14')}</SelectItem>
                <SelectItem value="30">{t('kds.stats.days30')}</SelectItem>
              </SelectContent>
            </Select>
            {hasData && (
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={csvBusy} onClick={() => void csvExport()}>
                {csvBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />} {t('labor.csv')}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">{t('labor.desc')}</p>
        {err && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{t('labor.error')} <span className="text-red-500/80">{err}</span></p>
            <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
          </div>
        )}
        {busy && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {!busy && data && !hasData && <p className="text-sm text-stone-500">{t('labor.empty')}</p>}
        {!busy && hasData && data && s && (
          <>
            <div className="overflow-x-auto rounded-lg border border-stone-200">
              <table className="w-full min-w-[440px] text-sm">
                <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('labor.colDate')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('labor.colHours')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('labor.colCost')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('labor.colNet')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('labor.colPct')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date} className="border-t border-stone-100 hover:bg-stone-50/60">
                      <td className="px-3 py-2 font-medium whitespace-nowrap">{shortDay(d.date)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{durationLabel(d.minutes)}</td>
                      <td className="px-3 py-2 text-right">{fmtEUR(d.cost)}</td>
                      <td className="px-3 py-2 text-right">{fmtEUR(d.netSales)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`inline-block min-w-16 rounded-full px-2 py-0.5 text-xs font-medium ${laborPctCls(d.pct)}`}>
                          {d.pct === null ? '—' : `${d.pct.toFixed(2)} %`}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {data.days.length === 0 && (
                    <tr><td className="px-3 py-2 text-sm text-stone-500" colSpan={5}>{t('labor.empty')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="grid gap-2 text-xs text-stone-600 sm:grid-cols-2">
              <p>
                {t('labor.target', { n: s.targetPct })} · <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${laborPctCls(s.avgPct)}`}>{s.avgPct === null ? '—' : `${s.avgPct.toFixed(2)} %`}</span>
                <span className="ml-1">{t('labor.avgHint')}</span>
              </p>
              <p>{t('labor.overtime')}: <span className="font-semibold">{durationLabel(s.totalOvertimeMinutes)}</span> · {t('labor.totalCost')}: <span className="font-semibold">{fmtEUR(s.totalCost)}</span></p>
            </div>
            {topRoles.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('labor.roles')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {topRoles.map((r) => (
                    <Badge key={r.roleName} variant="outline" className="gap-1.5 whitespace-nowrap">
                      {r.roleName} · {durationLabel(r.minutes)} · {fmtEUR(r.cost)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/* ─────────────────── Issue #10 (v1.117.0) — labor coverage card ─────────────────── */

/*
 * Pokritost izmen Pregled card (lcov) — načrtovano vs. dejansko po
 * dnevih/vlogah + urna matrika 7×24 (client-side filtri) + forecast prodaje
 * in pokritost prihodnjih izmen (pasovi low/ok/warn/alarm) + banner podatkovne
 * kakovosti + parameters footnote.
 * (Komentar je v angleščini/kraticah — besedila, ki bi jih reg-resijski
 * i18n sken (tests/i18n.test.ts) razbral kot trdo kodirane nize, se tu
 * namenoma izogiba.)
 *
 * DESIGN ADAPTATION: 10-design §5 je predvidel novo datoteko
 * labor-coverage-card.tsx, a kartica živi TUKAJ — oba helperja
 * (useInViewOnce/downloadReportSection) in obe sestrske kartici
 * (SalesByHourCard/LaborCostCard) sta v ops-cards.tsx (vzorec razreza
 * monolita AUDIT-FIX v1.82.1) → ena sama lokacija, 0 novih uvozov.
 *
 * Lokacijski filter: kartica dobi `locations` prop iz dashboarda (locStats)
 * in prikaže Select SAMO če je v obsegu >1 lokacija (vzorec TransfersTab
 * 'needTwoLocs' — ena lokacija = filter brez pomena).
 *
 * Job filter: izhodi roles[] iz poročila; pod aktivnim filtrom se roles
 * skrči → opcije se zlivajo z UNIONOM vseh doslej videnih (stabilen seznam).
 *
 * Urna matrika: API vrne CELO 7×24 matriko (168 celic) — dow + razpon ur sta
 * CLIENT-SIDE filtra (10-design odločitev). Prikaz: vrstice URE (0–23) ×
 * izbrani dnevi, celice = neto + minute + povprečni zaposleni — 390px varno
 * (7 stolpcev matrike bi bilo preširoko).
 *
 * DENAR = centi (fmtEUR(cents/100)), minute = r2 floati (durationLabel zaokroži),
 * laborPct/sph/cpo = null → '—' (NIKOLI 0/∞). money je lahko mešana valuta →
 * samo zastavica (dataQuality.mixedCurrencies > 1).
 */

/** Lokalni odgovor GET /api/reports/labor-coverage (brez uvoza strežniškega tipa — client-safe). */
interface LcovRespT {
  parameters: {
    from: string; to: string; locationIds: string[]; jobId: string | null
    targetPct: number; warnPct: number; lowPct: number; forecastDays: number
    currencies: string[]; sampleDays: number; closedDays: number
    counts: { orders: number; entries: number; shifts: number }
  }
  days: { date: string; dow: number; netSalesCents: number; orders: number; plannedMinutes: number; plannedCostCents: number; plannedIncomplete: number; actualMinutes: number; actualCostCents: number; openEntries: number; unapproved: number; rateZero: number; overtimeMinutes: number; varianceMinutes: number; laborPct: number | null; sphCents: number | null; costPerOrderCents: number | null }[]
  hours: { dow: number; hour: number; netSalesCents: number; orders: number; laborMinutes: number; staffOn: number }[]
  roles: { jobId: string | null; name: string; plannedMinutes: number; plannedCostCents: number; actualMinutes: number; actualCostCents: number }[]
  totals: { netSalesCents: number; orders: number; plannedMinutes: number; plannedCostCents: number; actualMinutes: number; actualCostCents: number; laborPct: number | null; sphCents: number | null; costPerOrderCents: number | null; varianceMinutes: number; overtimeMinutes: number }
  dataQuality: { incompleteData: boolean; reasons: string[]; openEntries: number; rateZero: number; overlapPairs: number; unapproved: number; missingRateShifts: number; mixedCurrencies: number }
  forecast: {
    method: 'same-weekday-average'
    days: { date: string; dow: number; expectedNetSalesCents: number | null; minCents: number | null; maxCents: number | null; sampleCount: number; closedDays: number; confidence: 'low' | 'ok' }[]
    coverage: { date: string; dow: number; shiftCount: number; plannedMinutes: number; plannedCostCents: number; incompleteRate: number; expectedNetSalesCents: number | null; expectedPct: number | null; flag: 'low' | 'ok' | 'warn' | 'alarm' | null; overtimeMinutes: number; overlaps: number; longNoBreak: number }[]
  }
  generatedAt: string
}

/** Labor % / pokritost badge — 4 pasovi (10-design): low <20 · ok 20–32 · warn 32–38 · alarm >38 · null = brez ocene (muted, NE rdeče). */
const lcovBandCls = (pct: number | null): string =>
  pct === null
    ? 'bg-stone-100 text-stone-500'
    : pct < 20
      ? 'bg-orange-100 text-orange-800'
      : pct <= 32
        ? 'bg-emerald-100 text-emerald-800'
        : pct <= 38
          ? 'bg-amber-100 text-amber-800'
          : 'bg-rose-100 text-rose-800'

/** Varianca minut (načrtovano − dejansko) — ± barva: nad načrtom rose, pod emerald. */
const lcovVarCls = (v: number): string => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-stone-500')
const lcovVarLabel = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v)} min`

/** API dow je 1-osnovni (1=pon..7=ned); ključi oh.day* pa 0-osnovni (0=ned) → preslikava (7→0). */
const ohDay = (dow: number) => `oh.day${dow % 7}`

/** Okno analize: zadnjih n dni ZAKLJUČNO s koncem danes (from/to = YYYY-MM-DD, UTC). */
const lcovWinOf = (n: number): { from: string; to: string } => {
  const to = new Date()
  const from = new Date(to.getTime() - (n - 1) * 86400000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(to) }
}

/** Client-side razponi ur za urno matriko (API vrne celo 7×24). */
const LCOV_HOUR_RANGES: { value: 'all' | '0' | '6' | '12' | '18'; key: string; from: number; to: number }[] = [
  { value: 'all', key: 'lcov.hoursRangeAll', from: 0, to: 23 },
  { value: '0', key: 'lcov.hoursRangeNight', from: 0, to: 5 },
  { value: '6', key: 'lcov.hoursRangeMorning', from: 6, to: 11 },
  { value: '12', key: 'lcov.hoursRangeAfternoon', from: 12, to: 17 },
  { value: '18', key: 'lcov.hoursRangeEvening', from: 18, to: 23 },
]

/** Koda razloga podatkovne kakovosti → števec (no-sales = brez števca). */
const LCOV_DQ_KEYS = ['open-entries', 'rate-zero', 'overlap', 'unapproved', 'missing-rate-shifts', 'mixed-currencies', 'no-sales'] as const

/** Pokritost izmen Pregled card (issue #10, lcov.*) — lazy fetch ko je vidna. */
export function LaborCoverageCard({ locations }: { locations?: { id: string; name: string }[] }) {
  const { t, locale } = useI18n()
  const [ref, inView] = useInViewOnce<HTMLDivElement>()
  const [days, setDays] = useState<'7' | '14' | '28' | '30'>('28')
  const [locId, setLocId] = useState('all')
  const [jobId, setJobId] = useState('all')
  const [jobOpts, setJobOpts] = useState<{ jobId: string; name: string }[]>([])
  const [dow, setDow] = useState('all')
  const [hRange, setHRange] = useState<'all' | '0' | '6' | '12' | '18'>('all')
  const [data, setData] = useState<LcovRespT | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  const [csvBusy, setCsvBusy] = useState(false)

  useEffect(() => {
    if (!inView) return
    let alive = true
    ;(async () => {
      setBusy(true); setErr('')
      try {
        const { from, to } = lcovWinOf(Number(days))
        const q = new URLSearchParams({ from, to })
        if (locId !== 'all') q.set('locationId', locId)
        if (jobId !== 'all') q.set('jobId', jobId)
        const d = await api<LcovRespT>(`/api/reports/labor-coverage?${q.toString()}`)
        if (!alive) return
        setData(d)
        // opcije vlog: UNION vseh doslej videnih (roles se pod filtrom skrči)
        setJobOpts((prev) => {
          const map = new Map(prev.map((j) => [j.jobId, j]))
          for (const r of d.roles) if (r.jobId) map.set(r.jobId, { jobId: r.jobId, name: r.name })
          return [...map.values()]
        })
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [inView, days, locId, jobId, reload])

  const csvExport = async () => {
    setCsvBusy(true)
    try {
      const { from, to } = lcovWinOf(Number(days))
      const extra = new URLSearchParams()
      if (locId !== 'all') extra.set('locationId', locId)
      if (jobId !== 'all') extra.set('jobId', jobId)
      await downloadReportSection('labor-coverage', from, to, `labor-pokritost_${from}_${to}.csv`, extra.toString() || undefined)
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setCsvBusy(false)
    }
  }

  // ── urna matrika: client-side agregacija (dow × razpon ur) ──
  const dows = dow === 'all' ? [1, 2, 3, 4, 5, 6, 7] : [Number(dow)]
  const hr = LCOV_HOUR_RANGES.find((r) => r.value === hRange) ?? LCOV_HOUR_RANGES[0]
  const hourRows: { h: number; net: number; orders: number; minutes: number; staff: number }[] = []
  for (let h = hr.from; h <= hr.to; h++) {
    const cells = (data?.hours ?? []).filter((c) => c.hour === h && dows.includes(c.dow))
    const net = cells.reduce((a, c) => a + c.netSalesCents, 0)
    const orders = cells.reduce((a, c) => a + c.orders, 0)
    const minutes = cells.reduce((a, c) => a + c.laborMinutes, 0)
    const withStaff = cells.filter((c) => c.laborMinutes > 0)
    const staff = withStaff.length ? withStaff.reduce((a, c) => a + c.staffOn, 0) / withStaff.length : 0
    if (hRange === 'all' && net === 0 && orders === 0 && minutes === 0) continue // "Vse" = samo aktivne ure
    hourRows.push({ h, net, orders, minutes, staff })
  }
  const hourTot = hourRows.reduce((a, r) => ({ net: a.net + r.net, orders: a.orders + r.orders, minutes: a.minutes + r.minutes }), { net: 0, orders: 0, minutes: 0 })

  const tt = data?.totals
  const dq = data?.dataQuality
  const genLabel = data ? new Date(data.generatedAt).toLocaleString(locale === 'hr' ? 'hr-HR' : 'sl-SI') : ''
  const showLocFilter = !!locations && locations.length > 1

  return (
    <Card ref={ref}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Timer className="w-4 h-4" /> {t('lcov.title')}
          <span className="ml-auto flex items-center gap-2">
            <Select value={days} onValueChange={(v) => setDays(v as '7' | '14' | '28' | '30')}>
              <SelectTrigger className="h-7 w-24 text-xs" aria-label={t('kds.stats.period')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('kds.stats.days7')}</SelectItem>
                <SelectItem value="14">{t('kds.stats.days14')}</SelectItem>
                <SelectItem value="28">{t('lcov.days28')}</SelectItem>
                <SelectItem value="30">{t('kds.stats.days30')}</SelectItem>
              </SelectContent>
            </Select>
            {data && (
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={csvBusy} onClick={() => void csvExport()}>
                {csvBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />} {t('lcov.csv')}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">{t('lcov.desc')}</p>
        {err && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-700">{t('lcov.error')} <span className="text-red-500/80">{err}</span></p>
            <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
          </div>
        )}
        {inView && busy && !data && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
        {inView && !busy && !data && !err && <p className="text-sm text-stone-500">{t('common.none')}</p>}
        {data && (
          <>
            {(showLocFilter || jobOpts.length > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                {showLocFilter && (
                  <Select value={locId} onValueChange={setLocId}>
                    <SelectTrigger className="h-8 w-40 text-xs" aria-label={t('lcov.filterLoc')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('lcov.locAll')}</SelectItem>
                      {locations!.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {jobOpts.length > 0 && (
                  <Select value={jobId} onValueChange={setJobId}>
                    <SelectTrigger className="h-8 w-40 text-xs" aria-label={t('lcov.filterJob')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('lcov.jobAll')}</SelectItem>
                      {jobOpts.map((j) => <SelectItem key={j.jobId} value={j.jobId}>{j.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            {dq?.incompleteData && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {t('lcov.dqTitle')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {dq.reasons.map((code) => {
                    const key = LCOV_DQ_KEYS.find((k) => k === code)
                    if (!key) return null
                    const cnt =
                      code === 'open-entries' ? dq.openEntries
                        : code === 'rate-zero' ? dq.rateZero
                          : code === 'overlap' ? dq.overlapPairs
                            : code === 'unapproved' ? dq.unapproved
                              : code === 'missing-rate-shifts' ? dq.missingRateShifts
                                : code === 'mixed-currencies' ? dq.mixedCurrencies
                                  : -1
                    return (
                      <span key={code} className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-800">
                        {t(`lcov.dq.${code}`)}{cnt >= 0 ? ` (${cnt})` : ''}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
            {tt && (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <div className="rounded-lg border border-stone-200 p-2.5">
                  <p className="text-[11px] text-stone-500">{t('lcov.kpiLabor')}</p>
                  <span className={`mt-0.5 inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-semibold ${lcovBandCls(tt.laborPct)}`}>
                    {tt.laborPct === null ? '—' : `${tt.laborPct.toFixed(2)} %`}
                  </span>
                  <p className="mt-0.5 text-[10px] text-stone-400">{t('lcov.kpiLaborHint')}</p>
                </div>
                <div className="rounded-lg border border-stone-200 p-2.5">
                  <p className="text-[11px] text-stone-500">{t('lcov.kpiSph')}</p>
                  <p className="text-sm font-semibold">{tt.sphCents === null ? '—' : fmtEUR(tt.sphCents / 100)}</p>
                  <p className="text-[10px] text-stone-400">{t('lcov.kpiSphHint')}</p>
                </div>
                <div className="rounded-lg border border-stone-200 p-2.5">
                  <p className="text-[11px] text-stone-500">{t('lcov.kpiCpo')}</p>
                  <p className="text-sm font-semibold">{tt.costPerOrderCents === null ? '—' : fmtEUR(tt.costPerOrderCents / 100)}</p>
                  <p className="text-[10px] text-stone-400">{t('lcov.kpiCpoHint')}</p>
                </div>
                <div className="rounded-lg border border-stone-200 p-2.5" title={t('lcov.varianceNote')}>
                  <p className="text-[11px] text-stone-500">{t('lcov.kpiVariance')}</p>
                  <p className={`text-sm font-semibold ${lcovVarCls(tt.varianceMinutes)}`}>{lcovVarLabel(tt.varianceMinutes)}</p>
                  <p className="text-[10px] text-stone-400">{t('lcov.kpiVarianceHint')}</p>
                </div>
              </div>
            )}
            <div>
              <p className="mb-1.5 text-xs font-medium text-stone-500">{t('lcov.daysTitle')}</p>
              <div className="overflow-auto max-h-96 rounded-lg border border-stone-200 hidden md:block">
                <table className="w-full min-w-[680px] text-sm">
                  <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('lcov.colDate')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colNet')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colOrders')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colPlannedMin')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colPlannedCost')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colActualMin')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colActualCost')}</th>
                      <th className="px-3 py-2 font-medium text-right" title={t('lcov.varianceNote')}>{t('lcov.colVariance')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('lcov.colPct')}</th>
                      <th className="px-2 py-2 font-medium text-center">⚠</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.days.map((d) => (
                      <tr key={d.date} className="border-t border-stone-100 hover:bg-stone-50/60">
                        <td className="px-3 py-2 font-medium whitespace-nowrap">
                          {shortDay(d.date)} <span className="text-xs font-normal text-stone-500">{t(ohDay(d.dow))}</span>
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(d.netSalesCents / 100)}</td>
                        <td className="px-3 py-2 text-right">{d.orders}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{durationLabel(d.plannedMinutes)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(d.plannedCostCents / 100)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{durationLabel(d.actualMinutes)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(d.actualCostCents / 100)}</td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${lcovVarCls(d.varianceMinutes)}`}>{lcovVarLabel(d.varianceMinutes)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-medium ${lcovBandCls(d.laborPct)}`}>
                            {d.laborPct === null ? '—' : `${d.laborPct.toFixed(2)} %`}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center whitespace-nowrap">
                          {d.openEntries > 0 && <span title={`${t('lcov.flagOpen')}: ${d.openEntries}`} className="inline-flex text-amber-600"><Hourglass className="w-3.5 h-3.5" /></span>}
                          {d.unapproved > 0 && <span title={`${t('lcov.flagUnapproved')}: ${d.unapproved}`} className="inline-flex text-amber-600"><XCircle className="w-3.5 h-3.5" /></span>}
                          {d.rateZero > 0 && <span title={`${t('lcov.flagRateZero')}: ${d.rateZero}`} className="inline-flex text-amber-600"><Wallet className="w-3.5 h-3.5" /></span>}
                          {d.plannedIncomplete > 0 && <span title={`${t('lcov.flagIncomplete')}: ${d.plannedIncomplete}`} className="inline-flex text-amber-600"><AlertTriangle className="w-3.5 h-3.5" /></span>}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-stone-200 bg-stone-50/60 font-medium">
                      <td className="px-3 py-2">{t('lcov.sum')}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(data.totals.netSalesCents / 100)}</td>
                      <td className="px-3 py-2 text-right">{data.totals.orders}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{durationLabel(data.totals.plannedMinutes)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(data.totals.plannedCostCents / 100)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{durationLabel(data.totals.actualMinutes)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtEUR(data.totals.actualCostCents / 100)}</td>
                      <td className={`px-3 py-2 text-right whitespace-nowrap ${lcovVarCls(data.totals.varianceMinutes)}`}>{lcovVarLabel(data.totals.varianceMinutes)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-semibold ${lcovBandCls(data.totals.laborPct)}`}>
                          {data.totals.laborPct === null ? '—' : `${data.totals.laborPct.toFixed(2)} %`}
                        </span>
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* Mobilne kartice (390 px) — skladne vrstice namesto tabele (vzorec TransfersTab) */}
              <div className="max-h-96 overflow-y-auto space-y-2 md:hidden">
                {data.days.map((d) => (
                  <div key={d.date} className="rounded-lg border border-stone-200 p-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium whitespace-nowrap">{shortDay(d.date)} <span className="text-xs font-normal text-stone-500">{t(ohDay(d.dow))}</span></span>
                      <span className={`inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-medium ${lcovBandCls(d.laborPct)}`}>
                        {d.laborPct === null ? '—' : `${d.laborPct.toFixed(2)} %`}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs text-stone-600">
                      <span className="truncate">{t('lcov.colNet')}: <span className="font-medium">{fmtEUR(d.netSalesCents / 100)}</span></span>
                      <span>{t('lcov.colOrders')}: <span className="font-medium">{d.orders}</span></span>
                      <span className="truncate">{t('lcov.plannedShort')}: <span className="font-medium">{durationLabel(d.plannedMinutes)}</span> · {fmtEUR(d.plannedCostCents / 100)}</span>
                      <span className="truncate">{t('lcov.actualShort')}: <span className="font-medium">{durationLabel(d.actualMinutes)}</span> · {fmtEUR(d.actualCostCents / 100)}</span>
                      <span className={lcovVarCls(d.varianceMinutes)}>{t('lcov.colVariance')}: {lcovVarLabel(d.varianceMinutes)}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-amber-600">
                        {d.openEntries > 0 && <span title={`${t('lcov.flagOpen')}: ${d.openEntries}`}><Hourglass className="w-3.5 h-3.5" /></span>}
                        {d.unapproved > 0 && <span title={`${t('lcov.flagUnapproved')}: ${d.unapproved}`}><XCircle className="w-3.5 h-3.5" /></span>}
                        {d.rateZero > 0 && <span title={`${t('lcov.flagRateZero')}: ${d.rateZero}`}><Wallet className="w-3.5 h-3.5" /></span>}
                        {d.plannedIncomplete > 0 && <span title={`${t('lcov.flagIncomplete')}: ${d.plannedIncomplete}`}><AlertTriangle className="w-3.5 h-3.5" /></span>}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium text-stone-500">{t('lcov.hoursTitle')}</p>
                <span className="ml-auto flex items-center gap-2">
                  <Select value={dow} onValueChange={setDow}>
                    <SelectTrigger className="h-7 w-32 text-xs" aria-label={t('lcov.hoursDow')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('lcov.hoursDowAll')}</SelectItem>
                      {[1, 2, 3, 4, 5, 6, 7].map((n) => <SelectItem key={n} value={String(n)}>{t(ohDay(n))}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={hRange} onValueChange={(v) => setHRange(v as 'all' | '0' | '6' | '12' | '18')}>
                    <SelectTrigger className="h-7 w-24 text-xs" aria-label={t('lcov.hoursRange')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LCOV_HOUR_RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.key)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </span>
              </div>
              {hourRows.length === 0 ? (
                <p className="text-sm text-stone-500">{t('lcov.hoursEmpty')}</p>
              ) : (
                <div className="max-h-80 overflow-auto rounded-lg border border-stone-200">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-medium">{t('lcov.colHour')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colHourNet')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colHourOrders')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colHourLabor')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right" title={t('lcov.hoursStaffNote')}>{t('lcov.colHourStaff')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourRows.map((r) => (
                        <tr key={r.h} className="border-t border-stone-100">
                          <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{String(r.h).padStart(2, '0')}:00</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{r.net > 0 ? fmtEUR(r.net / 100) : '—'}</td>
                          <td className="px-2.5 py-1.5 text-right">{r.orders || '—'}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{r.minutes > 0 ? `${Math.round(r.minutes)} min` : '—'}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{r.staff > 0 ? (r.staff % 1 === 0 ? String(Math.round(r.staff)) : r.staff.toFixed(1)) : '—'}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-stone-200 bg-stone-50/60 font-medium">
                        <td className="px-2.5 py-1.5">{t('lcov.sum')}</td>
                        <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{hourTot.net > 0 ? fmtEUR(hourTot.net / 100) : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right">{hourTot.orders || '—'}</td>
                        <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{hourTot.minutes > 0 ? `${Math.round(hourTot.minutes)} min` : '—'}</td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('lcov.fcTitle', { n: data.parameters.forecastDays })}</p>
                {data.forecast.days.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('lcov.fcEmpty')}</p>
                ) : (
                  <div className="max-h-64 overflow-auto rounded-lg border border-stone-200">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                        <tr>
                          <th className="px-2.5 py-1.5 font-medium">{t('lcov.fcDate')}</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.fcExpected')}</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.fcSamples')}</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.fcClosed')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.forecast.days.map((f) => (
                          <tr key={f.date} className="border-t border-stone-100">
                            <td className="px-2.5 py-1.5 whitespace-nowrap font-medium">
                              {shortDay(f.date)} <span className="font-normal text-stone-500">{t(ohDay(f.dow))}</span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                              {f.expectedNetSalesCents === null ? (
                                <span className="text-stone-400" title={t('lcov.fcNoSamples')}>— {t('lcov.fcNoSamples')}</span>
                              ) : (
                                <>
                                  <span className="font-medium">{fmtEUR(f.expectedNetSalesCents / 100)}</span>
                                  {f.minCents !== null && f.maxCents !== null && (
                                    <span className="block text-[10px] text-stone-400">{t('lcov.fcRange')} {fmtEUR(f.minCents / 100)}–{fmtEUR(f.maxCents / 100)}</span>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                              {f.sampleCount}{' '}
                              <span className={`ml-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${f.confidence === 'ok' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                                {f.confidence === 'ok' ? t('lcov.fcConfOk') : t('lcov.fcConfLow')}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right text-stone-500">{f.closedDays || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('lcov.covTitle')}</p>
                {data.forecast.coverage.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('lcov.covEmpty')}</p>
                ) : (
                  <>
                    <div className="max-h-64 overflow-auto rounded-lg border border-stone-200 hidden md:block">
                      <table className="w-full min-w-[480px] text-xs">
                        <thead className="sticky top-0 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                          <tr>
                            <th className="px-2.5 py-1.5 font-medium">{t('lcov.fcDate')}</th>
                            <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.covShifts')}</th>
                            <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.covPlanned')}</th>
                            <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.covExpectedNet')}</th>
                            <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.covExpectedPct')}</th>
                            <th className="px-2 py-1.5 font-medium text-center">⚠</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.forecast.coverage.map((c) => (
                            <tr key={c.date} className="border-t border-stone-100">
                              <td className="px-2.5 py-1.5 whitespace-nowrap font-medium">
                                {shortDay(c.date)} <span className="font-normal text-stone-500">{t(ohDay(c.dow))}</span>
                              </td>
                              <td className="px-2.5 py-1.5 text-right">{c.shiftCount}</td>
                              <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{durationLabel(c.plannedMinutes)} · {fmtEUR(c.plannedCostCents / 100)}</td>
                              <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{c.expectedNetSalesCents === null ? '—' : fmtEUR(c.expectedNetSalesCents / 100)}</td>
                              <td className="px-2.5 py-1.5 text-right">
                                <span className={`inline-block min-w-16 rounded-full px-2 py-0.5 text-[11px] font-medium ${lcovBandCls(c.expectedPct)}`} title={c.flag === null ? t('lcov.covNoVerdict') : t(`lcov.flag.${c.flag}`)}>
                                  {c.flag === null ? t('lcov.covNoVerdict') : `${c.expectedPct === null ? '—' : `${c.expectedPct.toFixed(2)} %`} · ${t(`lcov.flag.${c.flag}`)}`}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-center whitespace-nowrap">
                                {c.incompleteRate > 0 && <span title={`${t('lcov.covIncomplete')}: ${Math.round(c.incompleteRate * 100)} %`} className="inline-flex text-amber-600"><AlertTriangle className="w-3.5 h-3.5" /></span>}
                                {c.overlaps > 0 && <span title={`${t('lcov.covOverlaps')}: ${c.overlaps}`} className="inline-flex text-amber-600"><Repeat className="w-3.5 h-3.5" /></span>}
                                {c.longNoBreak > 0 && <span title={`${t('lcov.covLongNoBreak')}: ${c.longNoBreak}`} className="inline-flex text-amber-600"><Coffee className="w-3.5 h-3.5" /></span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* Mobilne kartice (390 px) — pokritost */}
                    <div className="max-h-64 overflow-y-auto space-y-2 md:hidden">
                      {data.forecast.coverage.map((c) => (
                        <div key={c.date} className="rounded-lg border border-stone-200 p-2.5 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium whitespace-nowrap">{shortDay(c.date)} <span className="text-xs font-normal text-stone-500">{t(ohDay(c.dow))}</span></span>
                            <span className={`inline-block min-w-16 rounded-full px-2 py-0.5 text-[11px] font-medium ${lcovBandCls(c.expectedPct)}`}>
                              {c.expectedPct === null ? '—' : `${c.expectedPct.toFixed(2)} %`} · {c.flag === null ? t('lcov.covNoVerdict') : t(`lcov.flag.${c.flag}`)}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs text-stone-600">
                            <span className="truncate">{t('lcov.covShifts')}: <span className="font-medium">{c.shiftCount}</span></span>
                            <span className="truncate">{t('lcov.covPlanned')}: <span className="font-medium">{durationLabel(c.plannedMinutes)}</span> · {fmtEUR(c.plannedCostCents / 100)}</span>
                            <span className="truncate">{t('lcov.covExpectedNet')}: <span className="font-medium">{c.expectedNetSalesCents === null ? '—' : fmtEUR(c.expectedNetSalesCents / 100)}</span></span>
                            <span className="flex items-center gap-1.5 text-amber-600">
                              {c.incompleteRate > 0 && <span title={`${t('lcov.covIncomplete')}: ${Math.round(c.incompleteRate * 100)} %`}><AlertTriangle className="w-3.5 h-3.5" /></span>}
                              {c.overlaps > 0 && <span title={`${t('lcov.covOverlaps')}: ${c.overlaps}`}><Repeat className="w-3.5 h-3.5" /></span>}
                              {c.longNoBreak > 0 && <span title={`${t('lcov.covLongNoBreak')}: ${c.longNoBreak}`}><Coffee className="w-3.5 h-3.5" /></span>}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            {data.roles.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('lcov.rolesTitle')}</p>
                <div className="max-h-64 overflow-auto rounded-lg border border-stone-200">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-medium">{t('lcov.colRole')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colPlannedMin')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colPlannedCost')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colActualMin')}</th>
                        <th className="px-2.5 py-1.5 font-medium text-right">{t('lcov.colActualCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.roles.map((r) => (
                        <tr key={r.jobId ?? 'none'} className="border-t border-stone-100">
                          <td className="px-2.5 py-1.5 font-medium">{r.name}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{durationLabel(r.plannedMinutes)}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{fmtEUR(r.plannedCostCents / 100)}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{durationLabel(r.actualMinutes)}</td>
                          <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{fmtEUR(r.actualCostCents / 100)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {data.roles.length === 0 && <p className="text-xs text-stone-500">{t('lcov.rolesEmpty')}</p>}
            <div className="space-y-0.5 border-t border-stone-100 pt-2 text-[11px] text-stone-400">
              <p>{t('lcov.footMethod')} · {t('lcov.footSamples', { n: data.parameters.sampleDays, m: data.parameters.closedDays })}</p>
              <p>
                {t('lcov.footCounts', { orders: data.parameters.counts.orders, entries: data.parameters.counts.entries, shifts: data.parameters.counts.shifts })}{' '}
                · {t('lcov.footCurrencies', { list: data.parameters.currencies.join(', ') })}
                {data.dataQuality.mixedCurrencies > 1 && <span className="ml-1 font-medium text-amber-700">{t('lcov.footMixed')}</span>}
              </p>
              <p>{t('lcov.footGenerated', { ts: genLabel })} · {t('lcov.disclaimer')}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/* ─────────────────── OPS-8 val 2 — DURS VAT payer check ─────────────────── */

interface DursEntryT { taxNumber: string; vatId: string; name: string; vatPayer: boolean; ibans: string[]; source?: 'inetis' | 'vies' }
type DursState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'none' }
  | { kind: 'ok'; entry: DursEntryT | null }

/** DURS VAT payer check button (ddv.inetis.com proxy): payer badge + autofill name + bank account. */
export function DursCheckButton({ query, onName, onIban, compact = false }: { query: string; onName?: (name: string) => void; onIban?: (iban: string) => void; compact?: boolean }) {
  const { t } = useI18n()
  const [state, setState] = useState<DursState>({ kind: 'idle' })

  const run = async () => {
    if (state.kind === 'loading') return
    setState({ kind: 'loading' })
    try {
      const res = await api<{ results?: DursEntryT[]; entry?: DursEntryT | null; error?: string }>(`/api/durs/check?q=${encodeURIComponent(query)}`)
      const results = res.results || []
      if (results.length === 0) {
        setState({ kind: 'none' })
        return
      }
      const entry = res.entry || results[0]
      if (!entry.name && onName == null) {
        // no name to show — still render the payer badge
      }
      if (entry.name && onName) onName(entry.name)
      if (entry.ibans?.length && onIban) onIban(entry.ibans[0])
      setState({ kind: 'ok', entry })
    } catch (e) {
      setState({ kind: 'error', code: String((e as Error).message || 'upstream') })
    }
  }

  const errLabel =
    state.kind === 'error'
      ? state.code === 'too_short'
        ? t('durs.errTooShort')
        : state.code === 'rate_limited'
          ? t('durs.errRate')
          : t('durs.errUpstream')
      : ''

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={compact ? 'h-7 px-2 text-xs' : 'h-9'}
        onClick={run}
        disabled={state.kind === 'loading' || !query.trim()}
      >
        {state.kind === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5" />}
        {state.kind === 'loading' ? t('durs.checking') : t('durs.checkBtn')}
      </Button>
      {state.kind === 'ok' && state.entry && (
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className={state.entry.vatPayer ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-rose-300 bg-rose-50 text-rose-700'}>
              {state.entry.vatPayer ? `✓ ${t('durs.vatPayerYes')}` : `✗ ${t('durs.vatPayerNo')}`}
            </Badge>
            {/* OPS-9 val 2 — source badge: domestic DURS (Inetis) vs EU VIES */}
            {state.entry.source && (
              <Badge variant="outline" className="border-stone-300 bg-stone-50 text-stone-600">
                {state.entry.source === 'vies' ? t('durs.srcEu') : t('durs.srcSi')}
              </Badge>
            )}
          </div>
          {state.entry.name && <span className="text-stone-600">{state.entry.name}</span>}
          {state.entry.ibans?.length > 0 && <span className="text-stone-500">{t('durs.ibanHint')}: {state.entry.ibans[0]}</span>}
        </div>
      )}
      {state.kind === 'none' && <p className="text-xs text-stone-500">{t('durs.noResults')}</p>}
      {state.kind === 'error' && <p className="text-xs text-rose-700">{errLabel}</p>}
    </div>
  )
}

/* ─────────────────── OPS-8 val 2 — notification matrix (RoxPos pattern) ─────────────────── */

const NOTIF_EVENTS = PUSH_EVENT_TYPES

const NOTIF_ROLES = ['waiter', 'bar', 'kitchen', 'chef', 'staff', 'manager', 'warehouse', 'accounting', 'admin'] as const

type NotifMode = 'everyone' | 'roles' | 'off'

/** Notifications card (Nastavitve tab): event types x {everyone | selected roles | off} —
 *  rows render dynamically from PUSH_EVENT_TYPES (client-safe registry, @/lib/push-events)
 *  so a new server event type appears in the matrix without a UI change. */
export function NotificationsCard() {
  const { t } = useI18n()
  const [rules, setRules] = useState<Record<string, { mode: NotifMode; roles?: string[] }>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api<{ rules: Record<string, { mode: NotifMode; roles?: string[] }> }>('/api/notification-rules')
        if (alive) setRules(res.rules || {})
      } catch {
        if (alive) setNotice(t('notif.loadError'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const setMode = (event: string, mode: NotifMode) => {
    setNotice('')
    setRules((r) => ({ ...r, [event]: { mode, roles: r[event]?.roles || [] } }))
  }
  const toggleRole = (event: string, role: string) => {
    setNotice('')
    setRules((r) => {
      const cur = r[event] || { mode: 'roles' as NotifMode, roles: [] as string[] }
      const roles = cur.roles || []
      return { ...r, [event]: { ...cur, roles: roles.includes(role) ? roles.filter((x) => x !== role) : [...roles, role] } }
    })
  }

  const save = async () => {
    setBusy(true); setNotice('')
    try {
      await api('/api/notification-rules', { method: 'PUT', body: JSON.stringify({ rules }) })
      setNotice(t('notif.saved'))
    } catch (e) {
      setNotice(`${t('notif.error')} ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><Bell className="w-4 h-4" /> {t('notif.title')}</CardTitle>
        <CardDescription>{t('notif.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('notif.loading')}</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                <tr>
                  <th className="p-2">{t('notif.title')}</th>
                  <th className="p-2 w-44">{t('notif.mode')}</th>
                </tr>
              </thead>
              <tbody>
                {NOTIF_EVENTS.map((ev) => {
                  const rule = rules[ev] || { mode: 'everyone' as NotifMode, roles: [] as string[] }
                  return (
                    <tr key={ev} className="border-t border-stone-100 align-top">
                      <td className="p-2 font-medium">{t(`notif.event.${ev}`)}</td>
                      <td className="p-2">
                        <Select value={rule.mode} onValueChange={(v) => setMode(ev, v as NotifMode)}>
                          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="everyone">{t('notif.modeEveryone')}</SelectItem>
                            <SelectItem value="roles">{t('notif.modeRoles')}</SelectItem>
                            <SelectItem value="off">{t('notif.modeOff')}</SelectItem>
                          </SelectContent>
                        </Select>
                        {rule.mode === 'roles' && (
                          <div className="mt-2 grid grid-cols-2 gap-1">
                            {NOTIF_ROLES.map((role) => (
                              <label key={role} className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 accent-emerald-700"
                                  checked={(rule.roles || []).includes(role)}
                                  onChange={() => toggleRole(ev, role)}
                                />
                                {t(`role.${role}`)}
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('notif.error')) || notice === t('notif.loadError') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}
        <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy || loading} onClick={save}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t('notif.save')}
        </Button>
      </CardContent>
    </Card>
  )
}

/* ─────────────────── OPS-8 val 2 + issue #15 (v1.105.0) — serije / lot governance ─────────────────── */

interface BatchRowT {
  id: string; itemName: string; itemUnit: string; lotNumber: string
  expiryDate: string | null; alertDate: string | null; removalDate: string | null
  quantityRemaining: number; quantityInitial: number
  supplierName: string; supplierId: string | null; locationId: string | null
  status: string; bucket: string
  holdReason: string; holdAt: string | null; holdRef: string
  releaseAt: string | null; releaseNote: string
  receivedAt: string | null; note: string
}

/** Lot-governance filtri (GET /api/inventory/batches?filter=). */
const LOT_FILTERS = [
  { key: 'usable', labelKey: 'bat.filter.usable' },
  { key: 'expiring', labelKey: 'bat.filter.expiring' },
  { key: 'expired', labelKey: 'bat.filter.expired' },
  { key: 'quarantine', labelKey: 'bat.filter.quarantine' },
  { key: 'recalled', labelKey: 'bat.filter.recalled' },
  { key: 'exhausted', labelKey: 'bat.filter.exhausted' },
  { key: 'unknown', labelKey: 'bat.filter.unknown' },
] as const

type LotAction = { mode: 'dates'; batch: BatchRowT } | { mode: 'hold'; batch: BatchRowT } | { mode: 'recall'; batch: BatchRowT } | { mode: 'release'; batch: BatchRowT } | null

interface TraceReportT {
  generatedAt: string
  batch: {
    id: string; lotNumber: string; itemName: string; unit: string; supplierName: string
    receivedAt: string | null; expiryDate: string | null; alertDate: string | null; removalDate: string | null
    status: string; bucket: string; quantityInitial: number; quantityRemaining: number
    hold: { reason: string; at: string | null; by: string | null; ref: string } | null
    release: { note: string; at: string | null; by: string | null } | null
    note: string; locationId: string | null
  }
  summary: {
    received: number; onStock: number; allocatedOut: number; returnsEstimate: number
    untracked: number; untrackedExplanation: string; crossCheckOk: boolean
  }
  allocations: {
    allocationId: string; date: string; type: string; quantity: number; employeeName: string
    orderId: string | null; orderNumber: string | null; orderStatus: string | null
    prepId: string | null; prepStatus: string | null; prepOutputItem: string | null
    prepOutputQty: number | null; indirect: boolean
  }[]
  exposedOrders: {
    orderId: string; orderNumber: string | null; status: string | null; date: string | null
    source: string | null; quantityFromLot: number; items: { name: string; qty: number }[]
  }[]
  uncertainty: { prepIndirect: string; noLotClaim: string }
}

const dstr = (d: string | null) => (d ? new Date(d).toLocaleDateString('sl-SI') : '—')

/**
 * Inventory batches card (Zaloge tab) — issue #15 lot governance:
 * seznami po klasifikaciji (zapade kmalu / zapadel rok / karantena / odpoklic /
 * izčrpano / brez roka), upravljanje opozorilnega + odstranitvenega datuma,
 * karantena/odpoklic/sprostitev (inventory.manage) in sledljivostno poročilo
 * (datum → alokacije → dokazana naročila + CSV izvoz).
 */
export function BatchesCard({ canManage = false }: { canManage?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<BatchRowT[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<string>('usable')
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<LotAction>(null)
  const [aErr, setAErr] = useState('')
  const [aReason, setAReason] = useState('')
  const [aRef, setARef] = useState('')
  const [aSupplierNotified, setASupplierNotified] = useState(false)
  const [aAlert, setAAlert] = useState('')
  const [aRemoval, setARemoval] = useState('')
  const [trace, setTrace] = useState<TraceReportT | null>(null)
  const [traceBusy, setTraceBusy] = useState(false)
  const [traceErr, setTraceErr] = useState('')
  // issue #24 — label dialog target row (source='batch', open lot)
  const [labelFor, setLabelFor] = useState<BatchRowT | null>(null)

  const load = async (f: string = filter) => {
    setLoading(true); setErr('')
    try {
      const res = await api<{ batches: BatchRowT[] }>(`/api/inventory/batches?filter=${f}&take=100`)
      setRows(res.batches || [])
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }

  const switchFilter = (f: string) => {
    setFilter(f)
    setRows(null)
    void load(f)
  }

  const expiryBadge = (b: BatchRowT) => {
    if (b.bucket === 'recalled') return <Badge variant="outline" className="border-rose-400 bg-rose-100 text-rose-800 font-semibold">{t('bat.bRecalled')}</Badge>
    if (b.bucket === 'quarantined') return <Badge variant="outline" className="border-amber-400 bg-amber-100 text-amber-900 font-semibold">{t('bat.bQuarantined')}</Badge>
    if (b.bucket === 'expired') return <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">{t('bat.expired')}</Badge>
    if (b.bucket === 'removal_due') return <Badge variant="outline" className="border-orange-300 bg-orange-50 text-orange-800">{t('bat.bRemovalDue')}</Badge>
    if (b.bucket === 'exhausted') return <Badge variant="outline" className="border-stone-300 bg-stone-100 text-stone-600">{t('bat.bExhausted')}</Badge>
    if (b.bucket === 'unknown_expiry') return <Badge variant="outline" className="border-stone-300 bg-stone-50 text-stone-500">{t('bat.bUnknown')}</Badge>
    if (b.bucket === 'alert') return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">{t('bat.expiresSoon')}</Badge>
    return null
  }

  const openAction = (mode: 'dates' | 'hold' | 'recall' | 'release', batch: BatchRowT) => {
    setAction({ mode, batch }); setAErr(''); setAReason(''); setARef(''); setASupplierNotified(false)
    setAAlert(batch.alertDate ? batch.alertDate.slice(0, 10) : '')
    setARemoval(batch.removalDate ? batch.removalDate.slice(0, 10) : '')
  }

  const runAction = async () => {
    if (!action) return
    setBusy(true); setAErr('')
    try {
      if (action.mode === 'dates') {
        await api('/api/inventory/batches', {
          method: 'PATCH',
          body: JSON.stringify({
            id: action.batch.id,
            ...(aAlert ? { alertDate: new Date(aAlert).toISOString() } : { alertDate: null }),
            ...(aRemoval ? { removalDate: new Date(aRemoval).toISOString() } : { removalDate: null }),
          }),
        })
        toast({ description: t('bat.datesSaved') })
      } else if (action.mode === 'hold') {
        await api(`/api/inventory/batches/${action.batch.id}/hold`, { method: 'POST', body: JSON.stringify({ reason: aReason, ref: aRef }) })
        toast({ description: t('bat.holdDone') })
      } else if (action.mode === 'recall') {
        await api(`/api/inventory/batches/${action.batch.id}/recall`, { method: 'POST', body: JSON.stringify({ reason: aReason, supplierNotified: aSupplierNotified, ref: aRef }) })
        toast({ description: t('bat.recallDone') })
      } else if (action.mode === 'release') {
        await api(`/api/inventory/batches/${action.batch.id}/release`, { method: 'POST', body: JSON.stringify({ note: aReason }) })
        toast({ description: t('bat.releaseDone') })
      }
      setAction(null)
      void load(filter)
    } catch (e) {
      setAErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const openTrace = async (batch: BatchRowT) => {
    setTrace(null); setTraceErr(''); setTraceBusy(true)
    try {
      const res = await api<TraceReportT>(`/api/inventory/batches/${batch.id}/trace`)
      setTrace(res)
    } catch (e) {
      setTraceErr(String((e as Error).message || e))
    } finally {
      setTraceBusy(false)
    }
  }

  const traceCsv = async (batch: BatchRowT) => {
    const res = await fetch(`/api/inventory/batches/${batch.id}/trace?format=csv`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) { toast({ description: t('bat.traceCsvErr') }); return }
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `sledljivost-${batch.lotNumber}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); if (v && rows === null && !loading) void load() }}>
      <Card>
        <CardHeader className="pb-2">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><Clock className="w-4 h-4" /> {t('bat.title')}</CardTitle>
            <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </CollapsibleTrigger>
          <CardDescription>{t('bat.desc15')}</CardDescription>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {LOT_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => switchFilter(f.key)}
                  className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${filter === f.key ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-stone-600 border-stone-200 hover:border-stone-400'}`}
                >
                  {t(f.labelKey)}
                </button>
              ))}
            </div>
            {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('bat.loading')}</p>}
            {err && <p className="text-sm text-rose-700">{t('bat.error')} {err}</p>}
            {rows !== null && rows.length === 0 && <p className="text-sm text-stone-500">{t('bat.empty')}</p>}
            {rows !== null && rows.length > 0 && (
              <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">{t('bat.colItem')}</th>
                      <th className="p-2">{t('bat.colLot')}</th>
                      <th className="p-2">{t('bat.colExpiry')}</th>
                      <th className="p-2 text-right">{t('bat.colQty')}</th>
                      <th className="p-2">{t('bat.colSupplier')}</th>
                      <th className="p-2 text-right">{t('bat.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id} className={`border-t border-stone-100 ${b.bucket === 'recalled' ? 'bg-rose-50/70' : b.bucket === 'quarantined' ? 'bg-amber-50/70' : ''}`}>
                        <td className="p-2 font-medium max-w-40 truncate" title={b.itemName}>{b.itemName}</td>
                        <td className="p-2 text-stone-600 max-w-40 truncate" title={b.lotNumber}>{b.lotNumber}</td>
                        <td className="p-2">
                          <span className="flex items-center gap-1.5 flex-wrap">
                            <span title={t('bat.colExpiry')}>{dstr(b.expiryDate)}</span>
                            {expiryBadge(b)}
                            {b.alertDate && <span className="text-[10px] text-amber-700" title={t('bat.alertDate')}>⚠ {dstr(b.alertDate)}</span>}
                            {b.removalDate && <span className="text-[10px] text-orange-700" title={t('bat.removalDate')}>⇥ {dstr(b.removalDate)}</span>}
                          </span>
                        </td>
                        <td className="p-2 text-right font-semibold">{b.quantityRemaining} {b.itemUnit}</td>
                        <td className="p-2 text-stone-600 max-w-32 truncate text-xs" title={b.supplierName}>{b.supplierName || '—'}</td>
                        <td className="p-2 text-right whitespace-nowrap">
                          <button className="text-xs px-1.5 py-1 rounded border border-stone-200 hover:border-stone-400 text-stone-700" onClick={() => void openTrace(b)} title={t('bat.trace')}>{t('bat.trace')}</button>
                          {/* issue #24 — issue/print a label for this open batch (auth only; blocked lots get 409) */}
                          <button
                            type="button"
                            className="inline-flex items-center justify-center min-h-8 min-w-8 ml-1 rounded border border-stone-200 hover:border-stone-400 text-stone-700"
                            onClick={() => setLabelFor(b)}
                            title={t('lbl.button')}
                            aria-label={`${t('lbl.button')} ${b.itemName} ${b.lotNumber}`}
                          >
                            <Tag className="w-3 h-3" aria-hidden />
                          </button>
                          {canManage && (
                            <>
                              <button className="text-xs px-1.5 py-1 ml-1 rounded border border-stone-200 hover:border-stone-400 text-stone-700" onClick={() => openAction('dates', b)} title={t('bat.dates')}>{t('bat.dates')}</button>
                              {b.bucket !== 'recalled' && b.bucket !== 'quarantined' && (
                                <>
                                  <button className="text-xs px-1.5 py-1 ml-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-50" onClick={() => openAction('hold', b)} title={t('bat.hold')}>{t('bat.hold')}</button>
                                  <button className="text-xs px-1.5 py-1 ml-1 rounded border border-rose-300 text-rose-800 hover:bg-rose-50" onClick={() => openAction('recall', b)} title={t('bat.recall')}>{t('bat.recall')}</button>
                                </>
                              )}
                              {b.bucket === 'quarantined' && (
                                <button className="text-xs px-1.5 py-1 ml-1 rounded border border-emerald-300 text-emerald-800 hover:bg-emerald-50" onClick={() => openAction('release', b)} title={t('bat.release')}>{t('bat.release')}</button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows !== null && <p className="text-[11px] text-stone-400">{t('bat.fefoNote')}</p>}
          </CardContent>
        </CollapsibleContent>
      </Card>

      {/* ── akcija: datumi / karantena / odpoklic / sprostitev ── */}
      <Dialog open={action !== null} onOpenChange={(v) => { if (!v) setAction(null) }}>
        <DialogContent className="sm:max-w-md">
          {action && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {action.mode === 'dates' && t('bat.datesTitle')}
                  {action.mode === 'hold' && t('bat.holdTitle')}
                  {action.mode === 'recall' && t('bat.recallTitle')}
                  {action.mode === 'release' && t('bat.releaseTitle')}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-stone-600">{action.batch.itemName} · <span className="font-mono text-xs">{action.batch.lotNumber}</span> · {action.batch.quantityRemaining} {action.batch.itemUnit}</p>

                {action.mode === 'dates' && (
                  <>
                    <div>
                      <Label htmlFor="bat-alert">{t('bat.alertDate')}</Label>
                      <Input id="bat-alert" type="date" value={aAlert} onChange={(e) => setAAlert(e.target.value)} />
                      <p className="text-xs text-stone-400 mt-0.5">{t('bat.alertDateHint')}</p>
                    </div>
                    <div>
                      <Label htmlFor="bat-removal">{t('bat.removalDate')}</Label>
                      <Input id="bat-removal" type="date" value={aRemoval} onChange={(e) => setARemoval(e.target.value)} />
                      <p className="text-xs text-stone-400 mt-0.5">{t('bat.removalDateHint')}</p>
                    </div>
                  </>
                )}

                {(action.mode === 'hold' || action.mode === 'recall' || action.mode === 'release') && (
                  <div>
                    <Label htmlFor="bat-reason">{action.mode === 'release' ? t('bat.releaseReason') : t('bat.reason')}</Label>
                    <Textarea id="bat-reason" rows={3} value={aReason} onChange={(e) => setAReason(e.target.value)} placeholder={t('bat.reasonPh')} />
                  </div>
                )}

                {(action.mode === 'hold' || action.mode === 'recall') && (
                  <div>
                    <Label htmlFor="bat-ref">{t('bat.ref')}</Label>
                    <Input id="bat-ref" value={aRef} onChange={(e) => setARef(e.target.value)} placeholder={t('bat.refPh')} />
                  </div>
                )}

                {action.mode === 'recall' && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="h-4 w-4 accent-emerald-700" checked={aSupplierNotified} onChange={(e) => setASupplierNotified(e.target.checked)} />
                    {t('bat.supplierNotified')}
                  </label>
                )}

                {action.mode === 'hold' && <p className="text-xs text-amber-700">{t('bat.holdNote')}</p>}
                {action.mode === 'recall' && <p className="text-xs text-rose-700">{t('bat.recallNote')}</p>}
                {action.mode === 'release' && <p className="text-xs text-emerald-700">{t('bat.releaseNote')}</p>}
                {aErr && <p className="text-sm text-rose-700">{aErr}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAction(null)}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => void runAction()}>
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t('common.confirm')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── sledljivostno poročilo ── */}
      <Dialog open={trace !== null || traceBusy} onOpenChange={(v) => { if (!v) { setTrace(null); setTraceErr('') } }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><ClipboardList className="w-4 h-4" /> {t('bat.traceTitle')}</DialogTitle>
          </DialogHeader>
          {traceBusy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('bat.loading')}</p>}
          {traceErr && <p className="text-sm text-rose-700">{traceErr}</p>}
          {trace && (
            <div className="space-y-4 text-sm">
              <div className="rounded-lg border border-stone-200 p-3 space-y-1">
                <p className="font-semibold">{trace.batch.itemName} · <span className="font-mono text-xs">{trace.batch.lotNumber}</span></p>
                <p className="text-xs text-stone-600">{t('bat.supplier')}: {trace.batch.supplierName || '—'} · {t('bat.colExpiry')}: {dstr(trace.batch.expiryDate)} · {t('bat.received')}: {dstr(trace.batch.receivedAt)}</p>
                <div className="flex gap-1.5 flex-wrap pt-1">
                  {trace.batch.status === 'RECALLED' && <Badge variant="outline" className="border-rose-400 bg-rose-100 text-rose-800 font-semibold">{t('bat.bRecalled')}</Badge>}
                  {trace.batch.status === 'QUARANTINE' && <Badge variant="outline" className="border-amber-400 bg-amber-100 text-amber-900 font-semibold">{t('bat.bQuarantined')}</Badge>}
                  {trace.batch.hold && <span className="text-xs text-stone-500">{t('bat.reason')}: {trace.batch.hold.reason}</span>}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                <div className="rounded-lg border border-stone-200 p-2"><p className="text-xs text-stone-500">{t('bat.tr.received')}</p><p className="font-bold">{trace.summary.received}</p></div>
                <div className="rounded-lg border border-stone-200 p-2"><p className="text-xs text-stone-500">{t('bat.tr.onStock')}</p><p className="font-bold">{trace.summary.onStock}</p></div>
                <div className="rounded-lg border border-stone-200 p-2"><p className="text-xs text-stone-500">{t('bat.tr.allocated')}</p><p className="font-bold">{trace.summary.allocatedOut}</p></div>
                <div className="rounded-lg border border-stone-200 p-2"><p className="text-xs text-stone-500">{t('bat.tr.returns')}</p><p className="font-bold">{trace.summary.returnsEstimate}</p></div>
                <div className="rounded-lg border border-stone-300 p-2 bg-stone-50"><p className="text-xs text-stone-500">{t('bat.tr.untracked')}</p><p className="font-bold">{trace.summary.untracked}</p></div>
              </div>

              <div>
                <p className="font-semibold mb-1">{t('bat.tr.allocations')} ({trace.allocations.length})</p>
                {trace.allocations.length === 0 && <p className="text-xs text-stone-500">{t('bat.tr.noAlloc')}</p>}
                {trace.allocations.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-stone-200">
                    <table className="w-full text-xs">
                      <thead className="bg-stone-50 text-left sticky top-0">
                        <tr><th className="p-1.5">{t('bat.tr.date')}</th><th className="p-1.5">{t('bat.tr.type')}</th><th className="p-1.5 text-right">{t('bat.tr.qty')}</th><th className="p-1.5">{t('bat.tr.doc')}</th><th className="p-1.5">{t('bat.tr.person')}</th></tr>
                      </thead>
                      <tbody>
                        {trace.allocations.map((a) => (
                          <tr key={a.allocationId} className="border-t border-stone-100">
                            <td className="p-1.5">{new Date(a.date).toLocaleString('sl-SI')}</td>
                            <td className="p-1.5">{a.type === 'SALE' ? t('bat.tr.sale') : a.type === 'BATCH_INPUT' ? t('bat.tr.prep') : a.type}</td>
                            <td className="p-1.5 text-right font-semibold">{a.quantity}</td>
                            <td className="p-1.5">
                              {a.orderNumber ? <span>#{a.orderNumber} {a.indirect ? '' : '✓'}</span> : null}
                              {a.prepId && !a.orderNumber ? <span title={t('bat.tr.indirect')}>{a.prepOutputItem} ⚠</span> : null}
                            </td>
                            <td className="p-1.5 text-stone-600">{a.employeeName || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {trace.exposedOrders.length > 0 && (
                <div>
                  <p className="font-semibold mb-1">{t('bat.tr.exposed')} ({trace.exposedOrders.length})</p>
                  <div className="space-y-1.5">
                    {trace.exposedOrders.map((o) => (
                      <div key={o.orderId} className="rounded-lg border border-stone-200 p-2 text-xs">
                        <p className="font-semibold">#{o.orderNumber} · {o.date ? new Date(o.date).toLocaleString('sl-SI') : ''} · {t('bat.tr.fromLot')}: {o.quantityFromLot} {trace.batch.unit}</p>
                        <p className="text-stone-600">{o.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-stone-500 rounded-md bg-stone-50 p-2">{trace.uncertainty.prepIndirect}</p>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => trace && void traceCsv({ id: trace.batch.id, lotNumber: trace.batch.lotNumber } as BatchRowT)}>
                  <Download className="w-3.5 h-3.5" /> {t('bat.tr.csv')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── issue #24 — label issue/print for the selected open batch ── */}
      <LabelDialog
        open={labelFor !== null}
        onOpenChange={(v) => { if (!v) setLabelFor(null) }}
        source="batch"
        batchId={labelFor?.id}
        context={{
          itemName: labelFor?.itemName ?? '',
          lotNumber: labelFor?.lotNumber ?? '',
          unit: labelFor?.itemUnit ?? '',
          defaultQuantity: labelFor?.quantityRemaining ?? 0,
        }}
        canManage={canManage}
        onDone={() => { void load(filter) }}
      />
    </Collapsible>
  )
}

/* ─────────────────── OPS-10 val 3 (v1.79.0) — priprava po serijah (BatchPreparation) ─────────────────── */

interface BatchPrepRowT {
  id: string; status: string; note: string
  outputItemName: string; outputUnit: string; outputQuantity: number
  outputCostPerUnit: number; totalInputCost: number
  createdAt: string; completedAt: string | null; cancelledAt: string | null
  createdByName: string; completedByName: string
  lines: { id: string; name: string; unit: string; quantity: number; costPerUnit: number }[]
}
interface BatchCandidateT { id: string; name: string; unit: string; menuItemId: string }
interface BomPreviewLineT { inventoryItemId: string; name: string; unit: string; qty: number; costPerUnit: number }

/** Radix Select sentinel — never value="" (empty string is rejected by Radix). */
const BATCH_NONE = 'NONE'

/** BatchPreparation card (Zaloge tab): BOM-driven production runs, lazy-loaded on expand. */
export function BatchPrepCard() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<BatchPrepRowT[] | null>(null)
  const [cands, setCands] = useState<BatchCandidateT[]>([])
  const [forecast, setForecast] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // new batch dialog
  const [dlgOpen, setDlgOpen] = useState(false)
  const [selItem, setSelItem] = useState(BATCH_NONE)
  const [qty, setQty] = useState('')
  const [bomLines, setBomLines] = useState<BomPreviewLineT[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dlgErr, setDlgErr] = useState('')
  // issue #24 — label dialog target row (source='preparation', COMPLETED runs only)
  const [labelFor, setLabelFor] = useState<BatchPrepRowT | null>(null)
  // void action inside the label dialog needs inventory.manage (server enforces it too)
  const user = getUser()
  const canManageLabels = Boolean(
    (user?.permissions ?? []).includes('inventory.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER',
  )

  const load = async () => {
    setLoading(true); setErr('')
    try {
      const res = await api<{ batches: BatchPrepRowT[]; candidates: BatchCandidateT[]; forecast: Record<string, number> }>('/api/batch-preparations')
      setRows(res.batches || [])
      setCands(res.candidates || [])
      setForecast(res.forecast || {})
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }

  const pickItem = async (id: string) => {
    setSelItem(id); setBomLines(null); setDlgErr('')
    if (id === BATCH_NONE) { setQty(''); return }
    const f = forecast[id]
    setQty(f ? String(f) : '')
    try {
      const res = await api<{ lines: BomPreviewLineT[]; hasBom: boolean }>(`/api/batch-preparations?bomFor=${encodeURIComponent(id)}`)
      setBomLines(res.lines || [])
    } catch { setBomLines([]) }
  }

  // client-side preview with the SAME pure math the server applies on POST
  const planned = Number(qty.replace(',', '.'))
  const preview = bomLines
    ? scaleBatchLines(bomLines.map((l) => ({ inventoryItemId: l.inventoryItemId, qty: l.qty })), planned)
    : []
  const previewCost = bomLines
    ? preview.reduce((s, p) => s + p.qty * (bomLines.find((b) => b.inventoryItemId === p.inventoryItemId)?.costPerUnit || 0), 0)
    : 0

  const openDialog = () => {
    setSelItem(BATCH_NONE); setQty(''); setBomLines(null); setDlgErr(''); setDlgOpen(true)
  }

  const createBatch = async () => {
    if (selItem === BATCH_NONE) { setDlgErr(t('batch.errNoItem')); return }
    if (!(planned > 0)) { setDlgErr(t('batch.errQty')); return }
    setBusy(true); setDlgErr('')
    try {
      await api('/api/batch-preparations', { method: 'POST', body: JSON.stringify({ outputItemId: selItem, plannedQty: planned }) })
      setDlgOpen(false)
      toast({ title: t('batch.created') })
      await load()
    } catch (e) {
      setDlgErr(String((e as Error).message || e))
    } finally { setBusy(false) }
  }

  const completeBatch = async (id: string) => {
    setBusy(true); setErr('')
    try {
      await api(`/api/batch-preparations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'complete' }) })
      toast({ title: t('batch.completed') })
      await load()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally { setBusy(false) }
  }

  const cancelBatch = async (id: string) => {
    if (!window.confirm(t('batch.confirmCancel'))) return
    setBusy(true); setErr('')
    try {
      await api(`/api/batch-preparations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) })
      toast({ title: t('batch.cancelled') })
      await load()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally { setBusy(false) }
  }

  const statusBadge = (s: string) => {
    if (s === 'COMPLETED') return <Badge className="bg-emerald-700 text-white">{t('batch.statusCompleted')}</Badge>
    if (s === 'CANCELLED') return <Badge variant="outline" className="text-stone-400 line-through">{t('batch.statusCancelled')}</Badge>
    return <Badge variant="outline" className="text-amber-700 border-amber-300">{t('batch.statusDraft')}</Badge>
  }

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); if (v && rows === null && !loading) void load() }}>
      <Card>
        <CardHeader className="pb-2">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><Layers className="w-4 h-4" /> {t('batch.card')}</CardTitle>
            <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </CollapsibleTrigger>
          <CardDescription>{t('batch.desc')}</CardDescription>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('batch.loading')}</p>}
            {err && <p role="alert" className="text-sm text-rose-700">{t('batch.error')} {err}</p>}
            {rows !== null && rows.length === 0 && <p className="text-sm text-stone-500">{t('batch.empty')}</p>}
            {rows !== null && rows.length > 0 && (
              <div className="max-h-80 overflow-y-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">{t('batch.colOutput')}</th>
                      <th className="p-2">{t('batch.colQty')}</th>
                      <th className="p-2 text-right">{t('batch.colCost')}</th>
                      <th className="p-2">{t('batch.colStatus')}</th>
                      <th className="p-2 text-right">{t('batch.colCreated')}</th>
                      <th className="p-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id} className="border-t border-stone-100 align-top">
                        <td className="p-2 font-medium max-w-44 truncate" title={b.outputItemName}>{b.outputItemName}</td>
                        <td className="p-2">{b.outputQuantity} {b.outputUnit}</td>
                        <td className="p-2 text-right font-semibold">
                          {b.status === 'COMPLETED' ? fmtEUR(b.outputCostPerUnit) : <span className="text-stone-400">{fmtEUR(b.totalInputCost)}</span>}
                        </td>
                        <td className="p-2">{statusBadge(b.status)}</td>
                        <td className="p-2 text-right text-xs text-stone-500">{new Date(b.createdAt).toLocaleDateString('sl-SI')}</td>
                        <td className="p-2 text-right whitespace-nowrap">
                          {b.status === 'DRAFT' && (
                            <>
                              <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 mr-1" disabled={busy} onClick={() => void completeBatch(b.id)}>{t('batch.complete')}</Button>
                              <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" disabled={busy} onClick={() => void cancelBatch(b.id)}>{t('batch.cancelBtn')}</Button>
                            </>
                          )}
                          {/* issue #24 — completed preparations get a food label (expiry + QR) */}
                          {b.status === 'COMPLETED' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9 gap-1"
                              disabled={busy}
                              onClick={() => setLabelFor(b)}
                              aria-label={`${t('lbl.button')} ${b.outputItemName}`}
                            >
                              <Tag className="w-3.5 h-3.5" aria-hidden /> {t('lbl.button')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows !== null && rows.length > 0 && cands.length > 0 && (
              <div>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={openDialog}><Plus className="w-4 h-4" /> {t('batch.new')}</Button>
              </div>
            )}
            {rows !== null && cands.length === 0 && <p className="text-xs text-stone-500">{t('batch.noCandidates')}</p>}

            {/* new batch dialog — candidate + planned qty prefilled from the forecast + scaled-line preview */}
            <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader><DialogTitle>{t('batch.dialogTitle')}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{t('batch.item')}</Label>
                    <Select value={selItem || BATCH_NONE} onValueChange={(v) => void pickItem(v)}>
                      <SelectTrigger><SelectValue placeholder={t('batch.itemPick')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={BATCH_NONE}>{t('batch.itemPick')}</SelectItem>
                        {cands.map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.name} ({c.unit})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selItem !== BATCH_NONE && forecast[selItem] !== undefined && (
                    <p className="text-xs text-stone-500">{t('batch.forecast', { n: forecast[selItem] })}</p>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="bp-qty">{t('batch.plannedQty')}</Label>
                    <Input id="bp-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0" className="w-32" />
                  </div>
                  {bomLines !== null && bomLines.length === 0 && <p className="text-xs text-amber-700">{t('batch.noBom')}</p>}
                  {preview.length > 0 && (
                    <div className="rounded-md border border-stone-200 p-2.5">
                      <p className="text-xs font-medium text-stone-600 mb-1.5">{t('batch.preview')}</p>
                      <ul className="text-xs text-stone-600 space-y-1">
                        {preview.map((p) => {
                          const meta = bomLines?.find((b) => b.inventoryItemId === p.inventoryItemId)
                          return (
                            <li key={p.inventoryItemId} className="flex justify-between gap-2">
                              <span className="truncate">{meta?.name || p.inventoryItemId}</span>
                              <span className="shrink-0 font-medium">{p.qty} {meta?.unit || ''}</span>
                            </li>
                          )
                        })}
                      </ul>
                      <p className="text-xs text-stone-500 mt-1.5">{t('batch.totalCost', { c: fmtEUR(previewCost) })}</p>
                    </div>
                  )}
                  {dlgErr && <p role="alert" className="text-sm text-red-600">{dlgErr}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDlgOpen(false)} disabled={busy}>{t('batch.cancel')}</Button>
                  <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || selItem === BATCH_NONE || !(planned > 0)} onClick={createBatch}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('batch.create')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* issue #24 — label issue/print for the selected completed preparation */}
            <LabelDialog
              open={labelFor !== null}
              onOpenChange={(v) => { if (!v) setLabelFor(null) }}
              source="preparation"
              preparationId={labelFor?.id}
              context={{
                itemName: labelFor?.outputItemName ?? '',
                lotNumber: '',
                unit: labelFor?.outputUnit ?? '',
                defaultQuantity: labelFor?.outputQuantity ?? 0,
              }}
              canManage={canManageLabels}
              onDone={() => { void load() }}
            />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

/* ─────────────────── OPS-10 val 2 (v1.78.0) — front-of-house: kiosk upsell + display promos ─────────────────── */

interface UpsellMenuItemT { id: string; name: string; price: number; available: boolean }
/** Radix Select sentinel — never value="" (empty string is rejected by Radix). */
const UPSELL_NONE = 'NONE'
/** Max suggestions per item — mirrors MAX_UPSELLS in src/lib/upsell.ts. */
const UPSELL_MAX_PICKS = 3

/**
 * Upsell suggestions card (Meni tab): per-item "Dodaj še" suggestions shown on the
 * kiosk while the cart holds items. Max 3 suggestions per item, always sent as the
 * WHOLE config (server sanitizes against live menu items and audits the change).
 */
export function UpsellCard({ menuItems, canManage }: { menuItems: UpsellMenuItemT[]; canManage: boolean }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [editItem, setEditItem] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [pickNew, setPickNew] = useState<string>(UPSELL_NONE)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api<{ config: Record<string, string[]> }>('/api/kiosk-upsell')
        if (alive) setConfig(res.config || {})
      } catch {
        if (alive) setNotice(t('upsell.loadError'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const byId = new Map(menuItems.map((m) => [m.id, m]))
  const configuredIds = Object.keys(config).filter((id) => byId.has(id))
  const unconfigured = menuItems.filter((m) => !(m.id in config))

  const togglePick = (id: string) => {
    setNotice('')
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= UPSELL_MAX_PICKS ? p : [...p, id]))
  }

  const saveEdit = async () => {
    if (!editItem) return
    setBusy(true); setNotice('')
    try {
      const next = { ...config }
      if (picked.length > 0) next[editItem] = picked
      else delete next[editItem]
      const res = await api<{ config: Record<string, string[]> }>('/api/kiosk-upsell', { method: 'PUT', body: JSON.stringify({ config: next }) })
      setConfig(res.config || {})
      setEditItem(null)
      setPickNew(UPSELL_NONE)
      setNotice(t('upsell.saved'))
    } catch (e) {
      setNotice(`${t('upsell.error')} ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const editTarget = editItem ? byId.get(editItem) : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><UtensilsCrossed className="w-4 h-4" /> {t('upsell.title')}</CardTitle>
        <CardDescription>{t('upsell.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('upsell.loading')}</p>
        ) : (
          <>
            {configuredIds.length === 0 && <p className="text-sm text-stone-500">{t('upsell.empty')}</p>}
            {configuredIds.length > 0 && (
              <div className="space-y-2">
                {configuredIds.map((id) => {
                  const item = byId.get(id)!
                  return (
                    <div key={id} className="rounded-lg border border-stone-200 bg-white p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate text-sm">{item?.name || id} <span className="text-stone-400 font-normal">· {fmtEUR(item?.price || 0)}</span></p>
                        {canManage && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" onClick={() => { setEditItem(id); setPicked(config[id] || []) }}>
                              <Pencil className="w-3 h-3" /> {t('upsell.edit')}
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-rose-700 border-rose-200 hover:bg-rose-50" disabled={busy}
                              onClick={() => { setEditItem(id); setPicked([]) }}>
                              <Trash2 className="w-3 h-3" /> {t('upsell.clear')}
                            </Button>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {(config[id] || []).map((sid) => (
                          <Badge key={sid} variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">{byId.get(sid)?.name || sid}</Badge>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {canManage && (
              <div className="flex items-center gap-2">
                <Select value={pickNew} onValueChange={(v) => { if (v !== UPSELL_NONE) { setEditItem(v); setPicked(config[v] || []) } setPickNew(UPSELL_NONE) }}>
                  <SelectTrigger className="h-9 max-w-72"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UPSELL_NONE}>{t('upsell.addFor')}</SelectItem>
                    {unconfigured.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.name} · {fmtEUR(m.price)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('upsell.error')) || notice === t('upsell.loadError') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}
      </CardContent>

      <Dialog open={!!editItem} onOpenChange={(o) => { if (!o) setEditItem(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{t('upsell.dialogTitle', { name: editTarget?.name || '' })}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-stone-500">{t('upsell.maxHint')}</p>
          <ScrollArea className="max-h-72 rounded-xl border border-stone-200">
            <div className="p-2 space-y-1">
              {menuItems.filter((m) => m.id !== editItem).map((m) => {
                const checked = picked.includes(m.id)
                return (
                  <label key={m.id} className={`flex items-center justify-between rounded-lg border px-2.5 py-2 text-sm cursor-pointer ${checked ? 'border-emerald-500 bg-emerald-50' : 'border-stone-100 hover:border-stone-300'} ${!checked && picked.length >= UPSELL_MAX_PICKS ? 'opacity-50' : ''}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-700"
                        checked={checked}
                        disabled={!checked && picked.length >= UPSELL_MAX_PICKS}
                        onChange={() => togglePick(m.id)}
                      />
                      <span className="truncate">{m.name}</span>
                    </span>
                    <span className="text-stone-500 shrink-0">{fmtEUR(m.price)}</span>
                  </label>
                )
              })}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditItem(null)}>{t('common.cancel')}</Button>
            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={saveEdit}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

interface DisplayPromoRowT { id: string; imageUrl: string; durationSec: number; active: boolean; startDate?: string; endDate?: string }
/** Local (unsaved) row id prefix — the server re-assigns ids on save. */
const PROMO_NEW_PREFIX = 'new-'
/** Max promos — mirrors MAX_PROMOS in src/lib/display-promos.ts. */
const PROMO_MAX = 5

/** True when the ad carries at least one valid campaign-window bound (chip is meaningless without one). */
function hasWindow(ad: DisplayPromoRowT): boolean {
  return isValidDateStr(ad.startDate) || isValidDateStr(ad.endDate)
}

/**
 * Campaign window state chip (inclusive 'YYYY-MM-DD' bounds, local time):
 *  - in window (or no bound)  → promo.active    (green);
 *  - start bound in the future → promo.upcoming (amber) — probe: a start-only
 *    window that is closed means now < start;
 *  - end bound in the past     → promo.expired  (rose) — probe: an end-only
 *    window that is closed means now > end.
 */
function WindowChip({ ad }: { ad: DisplayPromoRowT }) {
  const { t } = useI18n()
  const inWindow = isAdInWindow(ad)
  const upcoming = !inWindow && !isAdInWindow({ startDate: ad.startDate })
  const state = inWindow ? 'active' : upcoming ? 'upcoming' : 'expired'
  const cls = state === 'active'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : state === 'upcoming'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'
  const label = state === 'active' ? t('promo.active') : state === 'upcoming' ? t('promo.upcoming') : t('promo.expired')
  return <span className={`inline-block text-xs rounded-full border px-2 py-0.5 ${cls}`}>{label}</span>
}

/**
 * Customer display promos card (Nastavitve tab): idle-carousel ads for the wall
 * display — image URL (http/s), per-image duration (5-120 s, default 15), active
 * switch, and (OPS-11 val 2) an OPTIONAL campaign window: Od/Do date inputs
 * ('YYYY-MM-DD', inclusive, local time; empty = no bound) with a live state chip
 * (promo.active / promo.upcoming / promo.expired) computed via the pure isAdInWindow().
 * Whole list is PUT at once; server sanitizes (max 5, bad URLs dropped, invalid
 * date strings stripped field-wise) and audits DISPLAY_PROMOS_UPDATED.
 */
export function DisplayPromosCard() {
  const { t } = useI18n()
  const [ads, setAds] = useState<DisplayPromoRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = async () => {
    setLoading(true); setNotice('')
    try {
      const res = await api<{ ads: DisplayPromoRowT[] }>('/api/display-promos')
      setAds(res.ads || [])
    } catch {
      setNotice(t('promo.loadError'))
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const patchRow = (id: string, patch: Partial<DisplayPromoRowT>) => {
    setNotice('')
    setAds((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const addRow = () => {
    setNotice('')
    if (ads.length >= PROMO_MAX) return
    setAds((rows) => [...rows, { id: `${PROMO_NEW_PREFIX}${Date.now().toString(36)}-${rows.length}`, imageUrl: '', durationSec: 15, active: true }])
  }
  const removeRow = (id: string) => {
    setNotice('')
    setAds((rows) => rows.filter((r) => r.id !== id))
  }

  const save = async () => {
    setBusy(true); setNotice('')
    try {
      const badUrl = ads.some((a) => a.imageUrl.trim() !== '' && !/^https?:\/\/\S+$/i.test(a.imageUrl.trim()))
      if (badUrl) { setNotice(t('promo.invalidUrl')); return }
      // OPS-11 val 2: invalid (non-YYYY-MM-DD) date strings are stripped client-side
      // too — matches the tolerant server sanitize (field dropped, ad kept).
      const clean = ads
        .filter((a) => a.imageUrl.trim() !== '')
        .map((a) => ({
          ...a,
          imageUrl: a.imageUrl.trim(),
          startDate: isValidDateStr(a.startDate) ? a.startDate!.trim() : undefined,
          endDate: isValidDateStr(a.endDate) ? a.endDate!.trim() : undefined,
        }))
      const res = await api<{ ads: DisplayPromoRowT[] }>('/api/display-promos', { method: 'PUT', body: JSON.stringify({ ads: clean }) })
      setAds(res.ads || [])
      setNotice(clean.length !== ads.length ? t('promo.savedFiltered', { dropped: ads.length - clean.length }) : t('promo.saved'))
    } catch (e) {
      setNotice(`${t('promo.error')} ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><MonitorSmartphone className="w-4 h-4" /> {t('promo.title')}</CardTitle>
        <CardDescription>{t('promo.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('promo.loading')}</p>
        ) : (
          <>
            {ads.length === 0 && <p className="text-sm text-stone-500">{t('promo.empty')}</p>}
            {ads.length > 0 && (
              <div className="space-y-2">
                {ads.map((ad) => (
                  <div key={ad.id} className="rounded-lg border border-stone-200 bg-white p-2.5 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
                    <div className="space-y-2 min-w-0">
                      <div className="space-y-1">
                        <Label className="text-xs text-stone-500">{t('promo.image')}</Label>
                        <Input
                          value={ad.imageUrl}
                          onChange={(e) => patchRow(ad.id, { imageUrl: e.target.value })}
                          placeholder="https://…"
                          className="h-9"
                        />
                      </div>
                      {/* OPS-11 val 2: campaign window (inclusive, local; empty = no bound) */}
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('promo.from')}</Label>
                          <Input
                            type="date"
                            value={ad.startDate ?? ''}
                            onChange={(e) => patchRow(ad.id, { startDate: e.target.value || undefined })}
                            className="h-9"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('promo.to')}</Label>
                          <Input
                            type="date"
                            value={ad.endDate ?? ''}
                            onChange={(e) => patchRow(ad.id, { endDate: e.target.value || undefined })}
                            className="h-9"
                          />
                        </div>
                      </div>
                      {hasWindow(ad) && <WindowChip ad={ad} />}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-stone-500">{t('promo.duration')}</Label>
                      <Input
                        inputMode="numeric"
                        value={String(ad.durationSec)}
                        onChange={(e) => patchRow(ad.id, { durationSec: Number(e.target.value.replace(/\D/g, '')) || 15 })}
                        className="h-9 w-20"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-4 sm:pt-0">
                      <Switch checked={ad.active} onCheckedChange={(v) => patchRow(ad.id, { active: v })} aria-label={t('promo.active')} />
                      <span className="text-xs text-stone-600">{t('promo.active')}</span>
                    </div>
                    <div className="pt-2 sm:pt-0">
                      <Button size="icon" variant="outline" className="h-9 w-9 text-rose-700 border-rose-200 hover:bg-rose-50" onClick={() => removeRow(ad.id)} title={t('promo.delete')}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="gap-1" disabled={ads.length >= PROMO_MAX} onClick={addRow}>
                <Plus className="w-3.5 h-3.5" /> {t('promo.add')}
              </Button>
              <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy || loading} onClick={save}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t('promo.save')}
              </Button>
              {ads.length >= PROMO_MAX && <span className="text-xs text-amber-700">{t('promo.maxHint')}</span>}
            </div>
          </>
        )}
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('promo.error')) || notice === t('promo.loadError') || notice === t('promo.invalidUrl') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}
      </CardContent>
    </Card>
  )
}
