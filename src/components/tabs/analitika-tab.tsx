'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Legend,
} from 'recharts'
import { Loader2, RefreshCw, TrendingUp, CheckCircle2, Timer, Database, ChevronDown, Scale, Download, AlertTriangle } from 'lucide-react'

/* ─────────────── OPS-8 v1.71.0 — MENU ENGINEERING (Kasavana-Smith) ─────────────── */

type MeQuadrant = 'stars' | 'plowhorses' | 'puzzles' | 'dogs' | 'unknown'

interface MeItemRow {
  id: string; name: string; category: string; price: number; qtySold: number
  revenue: number; cost: number; costKnown: boolean
  cm: number; foodCostPct: number; popShare: number; quadrant: MeQuadrant
}
interface MeResp {
  days: number; generatedAt: string
  categories: { name: string; qtyThreshold: number; cmThreshold: number }[]
  items: MeItemRow[]
}

const ME_QUADRANT_STYLE: Record<MeQuadrant, { badge: string; dot: string }> = {
  stars: { badge: 'bg-emerald-100 text-emerald-800 border-emerald-200', dot: '#059669' },
  plowhorses: { badge: 'bg-amber-100 text-amber-800 border-amber-200', dot: '#d97706' },
  puzzles: { badge: 'bg-violet-100 text-violet-800 border-violet-200', dot: '#7c3aed' },
  dogs: { badge: 'bg-rose-100 text-rose-800 border-rose-200', dot: '#e11d48' },
  unknown: { badge: 'bg-stone-100 text-stone-600 border-stone-200', dot: '#a8a29e' },
}

interface MePoint { x: number; y: number; name: string; category: string; qtySold: number; revenue: number; cost: number; price: number; quadrant: MeQuadrant }

function MeScatterTooltip({ active, payload, tx }: { active?: boolean; payload?: { payload?: MePoint }[]; tx: (key: string) => string }) {
  if (!active || !payload?.length || !payload[0]?.payload) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-2.5 text-xs shadow-lg max-w-64" role="status">
      <p className="font-semibold truncate">{p.name}</p>
      <p className="text-stone-500">{p.category}</p>
      <p className="mt-1">{tx('me.q.' + p.quadrant)}</p>
      <p className="mt-1">{tx('me.th.pop')}: {p.x.toFixed(1)} %</p>
      <p>{tx('me.th.cm')}: {fmtEUR(p.y)}</p>
      <p>{tx('me.th.revenue')}: {fmtEUR(p.revenue)} · {tx('me.th.sold')}: {p.qtySold}</p>
      <p className="text-stone-500">{tx('me.th.cost')}: {fmtEUR(p.cost)} / {fmtEUR(p.price)}</p>
    </div>
  )
}

export function MenuEngineeringTab() {
  const { t } = useI18n()
  const [days, setDays] = useState<'30' | '60' | '90'>('30')
  const [cat, setCat] = useState('ALL')
  const [data, setData] = useState<MeResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true)
      setErr('')
      try {
        const d = await api<MeResp>(`/api/menu-engineering?days=${days}`)
        if (alive) { setData(d); setCat('ALL') }
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [days, reload])

  const items = data?.items ?? []
  const filtered = cat === 'ALL' ? items : items.filter((i) => i.category === cat)
  const catsShown = (data?.categories ?? []).filter((c) => cat === 'ALL' || c.name === cat)
  const meanQtyThr = catsShown.length ? catsShown.reduce((s, c) => s + c.qtyThreshold, 0) / catsShown.length : 0
  const meanCmThr = catsShown.length ? catsShown.reduce((s, c) => s + c.cmThreshold, 0) / catsShown.length : 0
  const known = filtered.filter((i) => i.costKnown)
  const points: MePoint[] = known.map((i) => ({
    x: i.popShare, y: i.cm, name: i.name, category: i.category,
    qtySold: i.qtySold, revenue: i.revenue, cost: i.cost, price: i.price, quadrant: i.quadrant,
  }))
  const unknownCount = filtered.filter((i) => !i.costKnown).length

  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      [t('me.th.item'), t('me.th.category'), t('me.th.sold'), t('me.th.revenue'), t('me.th.cost'), t('me.th.cm'), t('me.th.fc'), t('me.th.pop'), t('me.th.quadrant'), t('me.th.action')],
      ...filtered.map((i) => [
        i.name, i.category, i.qtySold, i.revenue.toFixed(2),
        i.costKnown ? i.cost.toFixed(2) : '—', i.costKnown ? i.cm.toFixed(2) : '—',
        i.costKnown ? i.foodCostPct.toFixed(1) : '—', i.popShare.toFixed(1),
        t('me.q.' + i.quadrant), t('me.act.' + i.quadrant),
      ]),
    ]
    downloadCSV(`menu-inzeniring-${days}dni.csv`, rows)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> {t('me.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-stone-500">{t('me.desc')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5 w-40">
              <Label htmlFor="me-period">{t('me.period')}</Label>
              <Select value={days} onValueChange={(v) => setDays(v as '30' | '60' | '90')}>
                <SelectTrigger id="me-period"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t('me.days30')}</SelectItem>
                  <SelectItem value="60">{t('me.days60')}</SelectItem>
                  <SelectItem value="90">{t('me.days90')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 w-48">
              <Label htmlFor="me-cat">{t('me.category')}</Label>
              <Select value={cat} onValueChange={setCat}>
                <SelectTrigger id="me-cat"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('me.allCat')}</SelectItem>
                  {(data?.categories ?? []).map((c) => <SelectItem key={c.name} value={c.name}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1" />
            {filtered.length > 0 && (
              <Button size="sm" variant="outline" onClick={exportCsv} className="gap-1.5">
                <Database className="w-3.5 h-3.5" /> {t('me.exportCsv')}
              </Button>
            )}
          </div>

          {err && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{t('me.error')} <span className="text-red-500/80">{err}</span></p>
              <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
            </div>
          )}

          {busy && !data && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-72 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          )}

          {data && items.length === 0 && <p className="text-sm text-stone-500">{t('me.empty')}</p>}

          {data && items.length > 0 && (
            <>
              <div className="min-h-80 w-full">
                {points.length > 0 ? (
                  <ResponsiveContainer width="100%" height={340}>
                    <ScatterChart margin={{ top: 12, right: 24, bottom: 24, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                      <XAxis type="number" dataKey="x" name={t('me.chartX')} domain={[0, 'auto']}
                        label={{ value: t('me.chartX'), position: 'insideBottom', offset: -12, fontSize: 11, fill: '#78716c' }}
                        tick={{ fontSize: 11 }} />
                      <YAxis type="number" dataKey="y" name={t('me.chartY')} width={56}
                        label={{ value: t('me.chartY'), angle: -90, position: 'insideLeft', fontSize: 11, fill: '#78716c' }}
                        tick={{ fontSize: 11 }} />
                      <RTooltip content={<MeScatterTooltip tx={t} />} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine x={meanQtyThr} stroke="#78716c" strokeDasharray="5 5"
                        label={{ value: `${meanQtyThr.toFixed(1)} %`, position: 'top', fontSize: 10, fill: '#78716c' }} />
                      <ReferenceLine y={meanCmThr} stroke="#78716c" strokeDasharray="5 5"
                        label={{ value: fmtEUR(meanCmThr), position: 'right', fontSize: 10, fill: '#78716c' }} />
                      {(['stars', 'plowhorses', 'puzzles', 'dogs'] as const).map((q) => (
                        <Scatter key={q} name={t(`me.q.${q}`)} data={points.filter((p) => p.quadrant === q)}
                          fill={ME_QUADRANT_STYLE[q].dot} fillOpacity={0.75} />
                      ))}
                    </ScatterChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-stone-500 py-16 text-center">{t('me.noRecipe')}</p>
                )}
              </div>
              <p className="text-xs text-stone-500">{t('me.refNote')}</p>
              {unknownCount > 0 && <p className="text-xs text-amber-700">⚠ {t('me.noRecipe')} ({t('me.count', { n: unknownCount })})</p>}
            </>
          )}
        </CardContent>
      </Card>

      {data && filtered.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-stone-500">{t('me.count', { n: filtered.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 overflow-auto rounded-lg border border-stone-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('me.th.item')}</th>
                    <th className="px-3 py-2 font-medium">{t('me.th.category')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.sold')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.revenue')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.cost')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.cm')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.fc')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('me.th.pop')}</th>
                    <th className="px-3 py-2 font-medium">{t('me.th.quadrant')}</th>
                    <th className="px-3 py-2 font-medium">{t('me.th.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i) => (
                    <tr key={i.id} className="border-t border-stone-100 hover:bg-stone-50/60">
                      <td className="px-3 py-2 font-medium max-w-40 truncate" title={i.name}>{i.name}</td>
                      <td className="px-3 py-2 text-stone-600">{i.category}</td>
                      <td className="px-3 py-2 text-right">{i.qtySold}</td>
                      <td className="px-3 py-2 text-right">{fmtEUR(i.revenue)}</td>
                      <td className="px-3 py-2 text-right">{i.costKnown ? fmtEUR(i.cost) : '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold">{i.costKnown ? fmtEUR(i.cm) : '—'}</td>
                      <td className="px-3 py-2 text-right">{i.costKnown ? `${i.foodCostPct.toFixed(1)} %` : '—'}</td>
                      <td className="px-3 py-2 text-right">{i.popShare.toFixed(1)} %</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={`whitespace-nowrap ${ME_QUADRANT_STYLE[i.quadrant].badge}`}>{t('me.q.' + i.quadrant)}</Badge></td>
                      <td className="px-3 py-2 text-xs text-stone-600 max-w-56">{t('me.act.' + i.quadrant)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-stone-500">ℹ {t('me.noRecipe')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/* ─────────────── OPS-8 v1.71.0 — KDS STATISTIKA PRIPRAVE ─────────────── */

interface KdsStatItem { name: string; count: number; avg: number; min: number; max: number; latePct: number }
/** OPS-10 val 1 (v1.77.0) — per-station breakdown row against its own target */
interface KdsStationRowT { station: 'BAR' | 'KITCHEN'; count: number; avg: number; min: number; max: number; okPct: number; warnPct: number; latePct: number; target: number }
interface KdsStatsResp {
  days: number; generatedAt: string
  kpi: { todayAvgPrep: number; todayCount: number; onTimePct: number; okPct: number; warnPct: number; latePct: number }
  items: KdsStatItem[]
  heatmap: { hour: number; half: number; avg: number; count: number }[]
  delays: { reason: string; count: number }[]
  // OPS-10 val 1 (v1.77.0) — additive: per-station targets (PrepStation.avgPrepTime)
  targets?: { BAR: number; KITCHEN: number }
  stations?: KdsStationRowT[]
  stationConfig?: { id: string; name: string; type: string; bucket: 'BAR' | 'KITCHEN'; avgPrepTime: number }[]
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`)
function kdsHeatClass(avg: number, count: number): string {
  if (!count) return 'bg-stone-100 border border-stone-200'
  if (avg <= 5) return 'bg-emerald-500'
  if (avg <= 10) return 'bg-amber-500'
  return 'bg-rose-500'
}

export function KdsStatsSection({ canEditTargets = false }: { canEditTargets?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [days, setDays] = useState<'7' | '14' | '30'>('7')
  const [station, setStation] = useState<'ALL' | 'KITCHEN' | 'BAR'>('ALL')
  const [data, setData] = useState<KdsStatsResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  // OPS-10 val 1 — target editing per PrepStation (avgPrepTime, PATCH /api/prep-stations/[id])
  const [targetDraft, setTargetDraft] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !loaded) return
    let alive = true
    ;(async () => {
      setBusy(true)
      setErr('')
      try {
        const q = `days=${days}${station === 'ALL' ? '' : `&station=${station}`}`
        const d = await api<KdsStatsResp>(`/api/kitchen/stats?${q}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [open, loaded, days, station, reload])

  const load = () => setLoaded(true)

  /** OPS-10 val 1: save edited avgPrepTime for a PrepStation row (1-60 clamp server-side). */
  const saveTarget = async (id: string) => {
    const raw = targetDraft[id]
    if (raw === undefined || raw.trim() === '') return
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n)) return
    setSavingId(id)
    try {
      await api(`/api/prep-stations/${id}`, { method: 'PATCH', body: JSON.stringify({ avgPrepTime: n }) })
      toast({ title: t('kds.stations.saved') })
      setTargetDraft((d) => {
        const next = { ...d }; delete next[id]; return next
      })
      setReload((r) => r + 1)
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setSavingId(null)
    }
  }

  const exportCsv = () => {
    if (!data) return
    const d = new Date()
    const rows: (string | number | null)[][] = [
      [t('kds.stats.thItem'), t('kds.stats.thCount'), t('kds.stats.thAvg') + ' (min)', t('kds.stats.thMin') + ' (min)', t('kds.stats.thMax') + ' (min)', t('kds.stats.thLate')],
      ...data.items.map((i) => [i.name, i.count, i.avg, i.min, i.max, i.latePct.toFixed(1)]),
      [],
      [t('kds.stats.heatmap')],
      ['ura', 'pol', t('kds.stats.thAvg') + ' (min)', t('kds.stats.thCount')],
      ...data.heatmap.map((c) => [c.hour, c.half === 0 ? '00' : '30', c.avg, c.count]),
      // OPS-9 val 3 (v1.76.0): delay reasons section (AuditLog KDS_DELAY aggregation)
      [],
      [t('kds.delay.title')],
      [t('kds.delay.colReason'), t('kds.stats.thCount')],
      ...data.delays.map((dl) => [t(`kds.delay.${dl.reason}`), dl.count]),
    ]
    downloadCSV(`kds-statistika-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`, rows)
  }

  const kpi = data?.kpi
  const maxCount = data ? Math.max(1, ...data.heatmap.map((c) => c.count)) : 1

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); if (v) load() }}>
      <Card>
        <CardHeader className="pb-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-1.5 text-left" aria-expanded={open}>
              <Timer className="w-4 h-4" />
              <CardTitle className="text-base flex-1">{t('kds.stats.title')}</CardTitle>
              <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <p className="text-xs text-stone-500">{t('kds.stats.desc')}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5 w-36">
                <Label htmlFor="kds-stats-days">{t('kds.stats.period')}</Label>
                <Select value={days} onValueChange={(v) => setDays(v as '7' | '14' | '30')}>
                  <SelectTrigger id="kds-stats-days"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">{t('kds.stats.days7')}</SelectItem>
                    <SelectItem value="14">{t('kds.stats.days14')}</SelectItem>
                    <SelectItem value="30">{t('kds.stats.days30')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 w-40">
                <Label htmlFor="kds-stats-station">{t('kds.stats.station')}</Label>
                <Select value={station} onValueChange={(v) => setStation(v as 'ALL' | 'KITCHEN' | 'BAR')}>
                  <SelectTrigger id="kds-stats-station"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('kds.stats.allStations')}</SelectItem>
                    <SelectItem value="KITCHEN">{t('menu.stationKitchen')}</SelectItem>
                    <SelectItem value="BAR">{t('menu.stationBar')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1" />
              {data && data.items.length > 0 && (
                <Button size="sm" variant="outline" onClick={exportCsv} className="gap-1.5">
                  <Database className="w-3.5 h-3.5" /> {t('kds.stats.exportCsv')}
                </Button>
              )}
            </div>

            {err && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{t('kds.stats.error')} <span className="text-red-500/80">{err}</span></p>
                <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            )}

            {busy && (
              <div className="space-y-3" aria-busy="true">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" />
                </div>
                <Skeleton className="h-40 w-full" />
              </div>
            )}

            {kpi && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Card><CardContent className="p-4">
                  <p className="text-xs text-stone-500">{t('kds.stats.avgToday')}</p>
                  <p className="text-2xl font-bold">{fmtMin(kpi.todayAvgPrep)}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <p className="text-xs text-stone-500">{t('kds.stats.countToday')}</p>
                  <p className="text-2xl font-bold">{kpi.todayCount}</p>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <p className="text-xs text-stone-500">{t('kds.stats.onTime')}</p>
                  <p className="text-2xl font-bold">{kpi.onTimePct.toFixed(1)} %</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {kpi.okPct.toFixed(1)} % {t('kds.stats.ok')}</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> {kpi.warnPct.toFixed(1)} % {t('kds.stats.warn')}</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" /> {kpi.latePct.toFixed(1)} % {t('kds.stats.late')}</span>
                  </p>
                </CardContent></Card>
              </div>
            )}

            {kpi && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('kds.stats.heatmap')}</p>
                <div className="grid gap-0.5 grid-cols-[repeat(12,minmax(0,1fr))] sm:grid-cols-[repeat(24,minmax(0,1fr))]">
                  {data?.heatmap.map((c) => (
                    <div
                      key={`${c.hour}:${c.half}`}
                      className={`h-5 rounded-sm ${kdsHeatClass(c.avg, c.count)}`}
                      style={{ opacity: c.count ? 0.4 + 0.6 * Math.min(1, c.count / maxCount) : 1 }}
                      title={`${String(c.hour).padStart(2, '0')}:${c.half === 0 ? '00' : '30'} — ${c.avg.toFixed(1)} min · ${c.count}×`}
                    />
                  ))}
                </div>
                <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-stone-500">
                  <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> {t('kds.stats.ok')}</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-500" /> {t('kds.stats.warn')}</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> {t('kds.stats.late')}</span>
                </p>
              </div>
            )}

            {data && data.items.length === 0 && !busy && <p className="text-sm text-stone-500">{t('kds.stats.empty')}</p>}

            {data && data.items.length > 0 && (
              <div className="max-h-96 overflow-auto rounded-lg border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('kds.stats.thItem')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thCount')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thAvg')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thMin')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thMax')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thLate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i) => (
                      <tr key={i.name} className="border-t border-stone-100 hover:bg-stone-50/60">
                        <td className="px-3 py-2 font-medium max-w-48 truncate" title={i.name}>{i.name}</td>
                        <td className="px-3 py-2 text-right">{i.count}</td>
                        <td className="px-3 py-2 text-right font-semibold">{fmtMin(i.avg)}</td>
                        <td className="px-3 py-2 text-right">{fmtMin(i.min)}</td>
                        <td className="px-3 py-2 text-right">{fmtMin(i.max)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-medium ${i.latePct > 25 ? 'bg-rose-100 text-rose-800' : i.latePct > 10 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                            {i.latePct.toFixed(1)} %
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* OPS-10 val 1 (v1.77.0): per-station breakdown vs PrepStation target
                (3-dot colors from classifyPrep: ok / warn(<=125 %) / late) */}
            {data && data.stations && data.stations.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-stone-500">{t('kds.stations.title')}</p>
                <div className="overflow-x-auto rounded-lg border border-stone-200">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('kds.stats.station')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thCount')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thAvg')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thLate')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('kds.stations.target')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.stations.map((sRow) => {
                        // 3-color dot against the station's own target (ok / warn / late by avg)
                        const dotCls = sRow.count === 0
                          ? 'bg-stone-300'
                          : sRow.avg <= sRow.target
                            ? 'bg-emerald-500'
                            : sRow.avg <= sRow.target * 1.25
                              ? 'bg-amber-500'
                              : 'bg-rose-500'
                        const cfg = data.stationConfig?.find((c) => c.bucket === sRow.station)
                        const draft = cfg ? targetDraft[cfg.id] : undefined
                        return (
                          <tr key={sRow.station} className="border-t border-stone-100 hover:bg-stone-50/60">
                            <td className="px-3 py-2 font-medium whitespace-nowrap">
                              <span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full ${dotCls}`} aria-hidden />
                              {sRow.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}
                              {cfg && <span className="ml-1 text-xs font-normal text-stone-400">{cfg.name}</span>}
                            </td>
                            <td className="px-3 py-2 text-right">{sRow.count}</td>
                            <td className="px-3 py-2 text-right font-semibold">{sRow.count > 0 ? fmtMin(sRow.avg) : '—'}</td>
                            <td className="px-3 py-2 text-right">
                              <span className={`inline-block min-w-14 rounded-full px-2 py-0.5 text-xs font-medium ${sRow.latePct > 25 ? 'bg-rose-100 text-rose-800' : sRow.latePct > 10 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
                                {sRow.latePct.toFixed(1)} %
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right">
                              {cfg && canEditTargets ? (
                                <span className="inline-flex items-center justify-end gap-1">
                                  <Input
                                    type="number"
                                    min={1}
                                    max={60}
                                    className="h-7 w-16 text-right text-xs"
                                    value={draft ?? String(cfg.avgPrepTime)}
                                    aria-label={t('kds.stations.target')}
                                    onChange={(e) => setTargetDraft((d) => ({ ...d, [cfg.id]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void saveTarget(cfg.id) }}
                                  />
                                  {draft !== undefined && draft !== String(cfg.avgPrepTime) && (
                                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={savingId === cfg.id} onClick={() => void saveTarget(cfg.id)}>
                                      {savingId === cfg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} {t('kds.stations.save')}
                                    </Button>
                                  )}
                                </span>
                              ) : (
                                <span className="text-stone-600">{fmtMin(sRow.target)}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-stone-500">
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> {t('kds.stats.ok')}</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> {t('kds.stats.warn')}</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" /> {t('kds.stats.late')}</span>
                </p>
              </div>
            )}

            {/* OPS-9 val 3 (v1.76.0): delay reasons (AuditLog KDS_DELAY) — catalog table + counts */}
            {data && data.delays.length > 0 && (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('kds.delay.colReason')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('kds.stats.thCount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.delays.map((dl) => (
                      <tr key={dl.reason} className="border-t border-stone-100 hover:bg-stone-50/60">
                        <td className="px-3 py-2 font-medium">{t(`kds.delay.${dl.reason}`)}</td>
                        <td className="px-3 py-2 text-right font-semibold">{dl.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

/* ─────────────── Issue #17 (v1.106.0) — FOOD-COST VARIANCE (actual vs theoretical) ─────────────── */

/**
 * Issue #17 (P1/P2): actual vs theoretical food cost report card.
 * Server engine + formulas: src/lib/food-cost-variance.ts (single source of
 * truth shared by UI, API and CSV export). All visible text via i18n keys
 * (fc.*) — no hardcoded strings.
 */

interface FcItem {
  inventoryItemId: string; name: string; category: string; unit: string
  locationId: string | null; locationName: string
  openingQty: number; openingBasis: 'stocktake' | 'ledger'; openingStocktakeId: string | null
  closingQty: number; closingBasis: 'stocktake' | 'ledger'; closingStocktakeId: string | null
  receiptsQty: number; productionQty: number
  theoreticalQty: number; actualUsageQty: number; varianceQty: number
  waste: { qty: number; value: number | null }
  prepConsumption: { qty: number; value: number | null }
  returns: { qty: number; value: number | null }
  saleShortfall: { qty: number; value: number | null }
  inventoryCorrection: { qty: number; value: number | null }
  unexplained: { qty: number; value: number | null }
  price: number | null; priceBasis: 'period_avg' | 'last_supplier_price' | 'current_cost' | 'unknown'
  priorPrice: number | null; priceChangeImpact: number | null
  theoreticalValue: number | null; actualValue: number | null; varianceValue: number | null
  saleOrderNumbers: number[]; receiptDocs: string[]; wasteReasons: string[]; stocktakeIds: string[]
  unitMismatch: boolean; recipeChangedSinceFrom: boolean; ledgerSaleQty: number
}
interface FcResp {
  from: string; to: string; generatedAt: string; currency: string
  salesBasis: 'paid_at'; recipeBasis: 'current'
  netSales: number
  kpi: {
    actualFoodCostValue: number | null; theoreticalFoodCostValue: number | null; varianceValue: number | null
    actualFoodCostPct: number | null; theoreticalFoodCostPct: number | null
    variancePctOfTheoretical: number | null; variancePctOfSales: number | null
    wasteValue: number | null; wasteSharePct: number | null
  }
  totals: {
    theoreticalQty: number; actualUsageQty: number; varianceQty: number; receiptsQty: number
    productionQty: number; wasteQty: number; prepQty: number; returnsQty: number
    shortfallQty: number; correctionQty: number; unexplainedQty: number; purchaseValue: number | null
  }
  items: FcItem[]
  byCategory: { category: string; theoreticalValue: number | null; actualValue: number | null; varianceValue: number | null; wasteValue: number | null; unexplainedValue: number | null }[]
  byLocation: { locationId: string | null; locationName: string; theoreticalValue: number | null; actualValue: number | null; varianceValue: number | null; unexplainedValue: number | null }[]
  soldWithoutRecipe: { menuItemId: string; name: string; qtySold: number; revenue: number }[]
  dataQuality: {
    incompleteData: boolean; reasons: string[]
    openingBasis: 'stocktake' | 'ledger'; closingBasis: 'stocktake' | 'ledger'
    hasOpeningStocktake: boolean; hasClosingStocktake: boolean
    itemsWithUnknownPrice: number; itemsWithUnitMismatch: number
    soldMenuItemsWithoutRecipe: number; recipesPossiblyChanged: number; transactionsTruncated: boolean
  }
  notes: string[]
}

const FC_Q_REASON_KEYS: Record<string, string> = {
  no_opening_stocktake: 'fc.q.noOpen',
  no_closing_stocktake: 'fc.q.noClose',
  items_with_unknown_price: 'fc.q.noPrice',
  unit_mismatch: 'fc.q.unit',
  sold_menu_items_without_recipe: 'fc.q.noRecipe',
  recipes_possibly_changed: 'fc.q.recipeChanged',
  transactions_truncated: 'fc.q.truncated',
  no_items_in_scope: 'fc.q.noItems',
}

const FC_BASIS_LABEL: Record<string, string> = {
  stocktake: 'fc.basis.stocktake',
  ledger: 'fc.basis.ledger',
  period_avg: 'fc.price.periodAvg',
  last_supplier_price: 'fc.price.lastSupplier',
  current_cost: 'fc.price.currentCost',
  unknown: 'fc.price.unknown',
}

function fcQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.abs(n) >= 100 ? n.toFixed(1) : String(n)
}

function fcPct(n: number | null | undefined): string {
  return n == null ? '—' : `${n.toFixed(1)} %`
}

/** Small component chips for non-zero variance components. */
function FcComponentChips({ it, t }: { it: FcItem; t: (k: string) => string }) {
  const chips: { label: string; cls: string; title: string }[] = []
  if (it.waste.qty !== 0) chips.push({ label: `${t('fc.c.waste')} ${fcQty(it.waste.qty)}`, cls: 'bg-rose-50 text-rose-700 border-rose-200', title: t('fc.c.wasteHint') })
  if (it.prepConsumption.qty !== 0) chips.push({ label: `${t('fc.c.prep')} ${fcQty(it.prepConsumption.qty)}`, cls: 'bg-violet-50 text-violet-700 border-violet-200', title: t('fc.c.prepHint') })
  if (it.returns.qty !== 0) chips.push({ label: `${t('fc.c.returns')} ${fcQty(it.returns.qty)}`, cls: 'bg-sky-50 text-sky-700 border-sky-200', title: t('fc.c.returnsHint') })
  if (it.saleShortfall.qty !== 0) chips.push({ label: `${t('fc.c.shortfall')} ${fcQty(it.saleShortfall.qty)}`, cls: 'bg-amber-50 text-amber-700 border-amber-200', title: t('fc.c.shortfallHint') })
  if (it.inventoryCorrection.qty !== 0) chips.push({ label: `${t('fc.c.correction')} ${fcQty(it.inventoryCorrection.qty)}`, cls: 'bg-stone-100 text-stone-700 border-stone-200', title: t('fc.c.correctionHint') })
  if (it.unexplained.qty !== 0) chips.push({ label: `${t('fc.c.unexplained')} ${fcQty(it.unexplained.qty)}`, cls: 'bg-orange-100 text-orange-800 border-orange-300', title: t('fc.c.unexplainedHint') })
  if (chips.length === 0) return <span className="text-xs text-stone-400">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <Badge key={i} variant="outline" className={`whitespace-nowrap text-xs ${c.cls}`} title={c.title}>{c.label}</Badge>
      ))}
    </div>
  )
}

export function FoodCostVarianceCard() {
  const { t } = useI18n()
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const [from, setFrom] = useState(monthStart.toISOString().slice(0, 10))
  const [to, setTo] = useState(now.toISOString().slice(0, 10))
  const [data, setData] = useState<FcResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<FcItem | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true); setErr('')
      try {
        const d = await api<FcResp>(`/api/reports/food-cost?from=${from}&to=${to}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [from, to, reload])

  const downloadCsv = async () => {
    try {
      const token = getToken()
      const res = await fetch(`/api/reports/food-cost?from=${from}&to=${to}&format=csv`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `food-cost-varianca-${from}_${to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast({ description: t('fc.csvErr') })
    }
  }

  const k = data?.kpi
  const dq = data?.dataQuality

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Scale className="w-4 h-4 text-stone-500" aria-hidden />
              {t('fc.title')}
            </CardTitle>
            <p className="mt-1 text-xs text-stone-500 max-w-2xl">{t('fc.desc')}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="fc-from" className="text-xs text-stone-500">{t('fc.from')}</Label>
              <Input id="fc-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="fc-to" className="text-xs text-stone-500">{t('fc.to')}</Label>
              <Input id="fc-to" type="date" value={to} min={from} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setReload((n) => n + 1)} disabled={busy}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden />} {t('fc.load')}
            </Button>
            {data && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={downloadCsv}>
                <Download className="w-3.5 h-3.5" aria-hidden /> {t('fc.csv')}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-red-700" role="alert">{err}</p>}
        {busy && !data && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}

        {data && (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-lg border border-stone-200 p-3">
                <p className="text-xs text-stone-500">{t('fc.kpi.actual')}</p>
                <p className="mt-1 text-lg font-semibold">{k?.actualFoodCostValue != null ? fmtEUR(k.actualFoodCostValue) : '—'}</p>
                <p className="text-xs text-stone-500">{t('fc.kpi.ofSales')}: {fcPct(k?.actualFoodCostPct)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 p-3">
                <p className="text-xs text-stone-500">{t('fc.kpi.theoretical')}</p>
                <p className="mt-1 text-lg font-semibold">{k?.theoreticalFoodCostValue != null ? fmtEUR(k.theoreticalFoodCostValue) : '—'}</p>
                <p className="text-xs text-stone-500">{t('fc.kpi.ofSales')}: {fcPct(k?.theoreticalFoodCostPct)}</p>
              </div>
              <div className={`rounded-lg border p-3 ${(k?.varianceValue ?? 0) > 0 ? 'border-amber-200 bg-amber-50/60' : 'border-emerald-200 bg-emerald-50/60'}`}>
                <p className="text-xs text-stone-500">{t('fc.kpi.variance')}</p>
                <p className={`mt-1 text-lg font-semibold ${(k?.varianceValue ?? 0) > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
                  {k?.varianceValue != null ? fmtEUR(k.varianceValue) : '—'}
                </p>
                <p className="text-xs text-stone-500">{t('fc.kpi.vsTheoretical')}: {fcPct(k?.variancePctOfTheoretical)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 p-3">
                <p className="text-xs text-stone-500">{t('fc.kpi.waste')}</p>
                <p className="mt-1 text-lg font-semibold">{k?.wasteValue != null ? fmtEUR(k.wasteValue) : '—'}</p>
                <p className="text-xs text-stone-500">{t('fc.kpi.wasteShare')}: {fcPct(k?.wasteSharePct)}</p>
              </div>
            </div>

            {/* data quality + honesty notes */}
            {dq?.incompleteData && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" role="status">
                <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" aria-hidden /> {t('fc.q.title')}</p>
                <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                  {dq.reasons.map((r) => (
                    <li key={r}>{t(FC_Q_REASON_KEYS[r] || 'fc.q.other')}{r.startsWith('items_') || r.startsWith('sold_') || r.startsWith('recipes_') ? ` (${t('fc.q.count')})` : ''}</li>
                  ))}
                </ul>
                <p className="mt-1.5">{t('fc.q.disclaimer')}</p>
                {!dq.hasOpeningStocktake || !dq.hasClosingStocktake ? <p className="mt-1">{t('fc.q.ledgerCaveat')}</p> : null}
              </div>
            )}
            <p className="text-xs text-stone-500">ℹ {t('fc.basisNote')} · {t('fc.recipeNote')}</p>

            {/* top deviations table */}
            {data.items.length === 0 ? (
              <p className="text-sm text-stone-500">{t('fc.empty')}</p>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500 z-10">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('fc.th.item')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('fc.th.theoretical')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('fc.th.actual')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('fc.th.variance')}</th>
                      <th className="px-3 py-2 font-medium">{t('fc.th.components')}</th>
                      <th className="px-3 py-2 font-medium text-right">{t('fc.th.price')}</th>
                      <th className="px-3 py-2 font-medium">{t('fc.th.flags')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((it) => (
                      <tr key={it.inventoryItemId} className="border-t border-stone-100 hover:bg-stone-50/60 cursor-pointer" onClick={() => setSel(it)}>
                        <td className="px-3 py-2 font-medium max-w-44 truncate" title={it.name}>{it.name}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fcQty(it.theoreticalQty)} {it.unit}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{fcQty(it.actualUsageQty)} {it.unit}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <span className={it.varianceQty > 0 ? 'text-amber-700 font-semibold' : it.varianceQty < 0 ? 'text-emerald-700 font-semibold' : ''}>
                            {fcQty(it.varianceQty)} {it.unit}
                          </span>
                          <span className="block text-xs text-stone-500">{it.varianceValue != null ? fmtEUR(it.varianceValue) : '—'}</span>
                        </td>
                        <td className="px-3 py-2"><FcComponentChips it={it} t={t} /></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {it.price != null ? fmtEUR(it.price) : '—'}
                          <span className="block text-xs text-stone-400">{t(FC_BASIS_LABEL[it.priceBasis])}</span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {it.unitMismatch && <Badge variant="outline" className="text-xs bg-amber-50 text-amber-800 border-amber-200" title={t('fc.flag.unitHint')}>{t('fc.flag.unit')}</Badge>}
                            {it.recipeChangedSinceFrom && <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200" title={t('fc.flag.recipeHint')}>{t('fc.flag.recipe')}</Badge>}
                            {it.priceBasis === 'unknown' && <Badge variant="outline" className="text-xs bg-stone-100 text-stone-600 border-stone-200" title={t('fc.price.unknown')}>{t('fc.flag.price')}</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* sales without recipe — visible gap, never hidden */}
            {data.soldWithoutRecipe.length > 0 && (
              <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-xs text-violet-900">
                <p className="font-semibold">{t('fc.noRecipe.title')} ({data.soldWithoutRecipe.length})</p>
                <p className="mt-0.5">{t('fc.noRecipe.desc')}</p>
                <ul className="mt-1 list-disc pl-5">
                  {data.soldWithoutRecipe.slice(0, 8).map((s) => (
                    <li key={s.menuItemId}>{s.name} — {s.qtySold} × · {fmtEUR(s.revenue)}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* per-location breakdown (central roles / multi-location) */}
            {data.byLocation.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {data.byLocation.map((l) => (
                  <Badge key={l.locationId || '_'} variant="outline" className="whitespace-nowrap">
                    {l.locationName}: {t('fc.kpi.variance')} {l.varianceValue != null ? fmtEUR(l.varianceValue) : '—'}
                    {l.unexplainedValue != null ? ` · ${t('fc.c.unexplained')} ${fmtEUR(l.unexplainedValue)}` : ''}
                  </Badge>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* drilldown dialog — full evidence for one ingredient */}
      <Dialog open={sel !== null} onOpenChange={(v) => { if (!v) setSel(null) }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          {sel && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 flex-wrap">
                  {sel.name}
                  <Badge variant="outline" className="text-xs">{sel.category}</Badge>
                  {sel.locationName && <Badge variant="outline" className="text-xs">{sel.locationName}</Badge>}
                </DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div className="rounded-sm border border-stone-200 p-2">
                    <p className="text-xs text-stone-500">{t('fc.d.opening')}</p>
                    <p className="font-semibold">{fcQty(sel.openingQty)} {sel.unit}</p>
                    <p className="text-xs text-stone-400">{t(FC_BASIS_LABEL[sel.openingBasis])}{sel.openingStocktakeId ? ` · ${sel.openingStocktakeId.slice(0, 10)}` : ''}</p>
                  </div>
                  <div className="rounded-sm border border-stone-200 p-2">
                    <p className="text-xs text-stone-500">{t('fc.d.receipts')}</p>
                    <p className="font-semibold">{fcQty(sel.receiptsQty)} {sel.unit}</p>
                    <p className="text-xs text-stone-400">{t('fc.d.production')}: {fcQty(sel.productionQty)}</p>
                  </div>
                  <div className="rounded-sm border border-stone-200 p-2">
                    <p className="text-xs text-stone-500">{t('fc.d.closing')}</p>
                    <p className="font-semibold">{fcQty(sel.closingQty)} {sel.unit}</p>
                    <p className="text-xs text-stone-400">{t(FC_BASIS_LABEL[sel.closingBasis])}{sel.closingStocktakeId ? ` · ${sel.closingStocktakeId.slice(0, 10)}` : ''}</p>
                  </div>
                </div>

                <div className="rounded-sm border border-stone-200 p-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-stone-500">{t('fc.d.theoretical')}</p>
                    <p className="font-semibold">{fcQty(sel.theoreticalQty)} {sel.unit} · {sel.theoreticalValue != null ? fmtEUR(sel.theoreticalValue) : '—'}</p>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-stone-500">{t('fc.d.actual')}</p>
                    <p className="font-semibold">{fcQty(sel.actualUsageQty)} {sel.unit} · {sel.actualValue != null ? fmtEUR(sel.actualValue) : '—'}</p>
                  </div>
                  <div className="flex items-center justify-between border-t border-stone-100 mt-1 pt-1">
                    <p className="text-xs font-medium">{t('fc.th.variance')}</p>
                    <p className={`font-bold ${sel.varianceQty > 0 ? 'text-amber-700' : sel.varianceQty < 0 ? 'text-emerald-700' : ''}`}>
                      {fcQty(sel.varianceQty)} {sel.unit} · {sel.varianceValue != null ? fmtEUR(sel.varianceValue) : '—'}
                    </p>
                  </div>
                </div>

                <div className="rounded-sm border border-stone-200 p-2">
                  <p className="text-xs text-stone-500 mb-1">{t('fc.d.components')}</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {([
                        ['fc.c.waste', sel.waste],
                        ['fc.c.prep', sel.prepConsumption],
                        ['fc.c.returns', sel.returns],
                        ['fc.c.shortfall', sel.saleShortfall],
                        ['fc.c.correction', sel.inventoryCorrection],
                        ['fc.c.unexplained', sel.unexplained],
                      ] as const).map(([label, c]) => (
                        <tr key={label} className={c.qty !== 0 ? '' : 'text-stone-400'}>
                          <td className="py-0.5 pr-2">{t(label)}</td>
                          <td className="py-0.5 text-right whitespace-nowrap">{fcQty(c.qty)} {sel.unit}</td>
                          <td className="py-0.5 text-right whitespace-nowrap">{c.value != null ? fmtEUR(c.value) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-sm border border-stone-200 p-2 text-xs space-y-0.5">
                  <p className="text-stone-500">{t('fc.d.price')}</p>
                  <p>{sel.price != null ? `${fmtEUR(sel.price)} / ${sel.unit}` : t('fc.price.unknown')} — {t(FC_BASIS_LABEL[sel.priceBasis])}</p>
                  {sel.priceChangeImpact != null && (
                    <p className="text-stone-500">{t('fc.d.priceChange')}: {fmtEUR(sel.priceChangeImpact)} ({sel.priorPrice != null ? fmtEUR(sel.priorPrice) : '—'} → {sel.price != null ? fmtEUR(sel.price) : '—'})</p>
                  )}
                </div>

                <div className="rounded-sm border border-stone-200 p-2 text-xs space-y-1">
                  <p className="text-stone-500">{t('fc.d.evidence')}</p>
                  {sel.saleOrderNumbers.length > 0 && <p>{t('fc.ev.orders')}: {sel.saleOrderNumbers.join(', ')}</p>}
                  {sel.receiptDocs.length > 0 && <p>{t('fc.ev.receipts')}: {sel.receiptDocs.join(', ')}</p>}
                  {sel.wasteReasons.length > 0 && <p>{t('fc.ev.waste')}: {sel.wasteReasons.join(', ')}</p>}
                  {sel.stocktakeIds.length > 0 && <p>{t('fc.ev.stocktakes')}: {sel.stocktakeIds.join(', ')}</p>}
                  {sel.saleOrderNumbers.length + sel.receiptDocs.length + sel.wasteReasons.length + sel.stocktakeIds.length === 0 && (
                    <p className="text-stone-400">{t('fc.ev.none')}</p>
                  )}
                </div>

                <p className="text-xs text-stone-500 border-t border-stone-100 pt-2">{t('fc.q.disclaimer')}</p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
