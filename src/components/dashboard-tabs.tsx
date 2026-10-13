'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Legend,
} from 'recharts'
import { Loader2, RefreshCw, TrendingUp, Plus, Trash2, CheckCircle2, XCircle, Timer, CalendarClock, Pencil, Database, ChevronDown } from 'lucide-react'

/* ─────────────────────── OPS-7 (v1.69.0): URNIK IZMEN (7shifts vzorec) ─────────────────────── */

export interface StaffShiftRowT {
  id: string
  employeeId: string
  employeeName: string
  employeeRole: string
  shiftDate: string
  shiftType: string
  startTime: string
  endTime: string
  breakMinutes: number
  notes: string
  status: string
  locationId: string | null
}

export interface TimeOffRowT {
  id: string
  employeeId: string
  employeeName: string
  type: string
  startDate: string
  endDate: string
  status: string
  reason: string
  reviewedAt: string | null
}

const SHIFT_TYPE_LABELS: Record<string, string> = {
  morning: 'urnik.morning', afternoon: 'urnik.afternoon', evening: 'urnik.evening',
  night: 'urnik.night', split: 'urnik.split', full: 'urnik.full',
}

const SHIFT_STATUS_BADGE: Record<string, string> = {
  scheduled: 'bg-stone-100 text-stone-700 border-stone-200',
  confirmed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed: 'bg-emerald-600 text-white border-emerald-600',
  absent: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-stone-100 text-stone-400 border-stone-200 line-through',
  no_show: 'bg-red-100 text-red-800 border-red-200',
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function StaffScheduleTab({ employees, canManage }: { employees: { id: string; name: string; role: string; active: boolean }[]; canManage: boolean }) {
  const { t, locale } = useI18n()
  const [weekStart, setWeekStart] = useState(() => {
    const now = new Date()
    const dow = now.getDay() || 7
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - dow)
    return isoDay(mon)
  })
  const [shifts, setShifts] = useState<StaffShiftRowT[]>([])
  const [timeOff, setTimeOff] = useState<TimeOffRowT[]>([])
  const [canManageRequests, setCanManageRequests] = useState(canManage)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editShift, setEditShift] = useState<StaffShiftRowT | null>(null)
  const [selEmployee, setSelEmployee] = useState('')
  const [selDate, setSelDate] = useState(weekStart)
  const [selType, setSelType] = useState('full')
  const [selStart, setSelStart] = useState('08:00')
  const [selEnd, setSelEnd] = useState('16:00')
  const [selBreak, setSelBreak] = useState('30')
  const [selNotes, setSelNotes] = useState('')
  // zahteva za prostost
  const [toOpen, setToOpen] = useState(false)
  const [toType, setToType] = useState('vacation')
  const [toFrom, setToFrom] = useState(weekStart)
  const [toTo, setToTo] = useState(weekStart)
  const [toReason, setToReason] = useState('')
  const [toEmployee, setToEmployee] = useState('')

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00`)
    d.setDate(d.getDate() + i)
    return d
  })

  const load = async () => {
    setLoading(true)
    try {
      const from = weekStart
      const end = new Date(`${weekStart}T00:00:00`)
      end.setDate(end.getDate() + 6)
      const [s, tf] = await Promise.all([
        api<{ shifts: StaffShiftRowT[] }>(`/api/staff-shifts?from=${from}&to=${isoDay(end)}`),
        api<{ requests: TimeOffRowT[]; canManage: boolean }>('/api/time-off'),
      ])
      setShifts(s.shifts)
      setTimeOff(tf.requests)
      setCanManageRequests(tf.canManage || canManage)
    } catch {
      toast({ title: t('common.error'), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [weekStart])

  const activeEmployees = employees.filter((e) => e.active)

  async function saveShift() {
    if (!selEmployee || !/^\d{4}-\d{2}-\d{2}$/.test(selDate)) return
    setBusy(true)
    try {
      if (editShift) {
        await api('/api/staff-shifts', { method: 'PATCH', body: JSON.stringify({ id: editShift.id, shiftType: selType, startTime: selStart, endTime: selEnd, breakMinutes: Number(selBreak) || 0, notes: selNotes }) })
      } else {
        await api('/api/staff-shifts', { method: 'POST', body: JSON.stringify({ employeeId: selEmployee, shiftDate: selDate, shiftType: selType, startTime: selStart, endTime: selEnd, breakMinutes: Number(selBreak) || 0, notes: selNotes }) })
      }
      setDialogOpen(false)
      setEditShift(null)
      await load()
      toast({ title: t('common.save') })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  async function removeShift(id: string) {
    setBusy(true)
    try {
      await api('/api/staff-shifts', { method: 'DELETE', body: JSON.stringify({ id }) })
      await load()
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  async function decideTimeOff(id: string, status: string) {
    setBusy(true)
    try {
      await api('/api/time-off', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      await load()
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  async function createTimeOff() {
    setBusy(true)
    try {
      await api('/api/time-off', { method: 'POST', body: JSON.stringify({ type: toType, startDate: toFrom, endDate: toTo, reason: toReason, ...(canManageRequests && toEmployee && toEmployee !== '__self' ? { employeeId: toEmployee } : {}) }) })
      setToOpen(false)
      setToReason('')
      await load()
      toast({ title: t('urnik.requestSent') })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const dayName = (d: Date) => d.toLocaleDateString(locale === 'hr' ? 'hr-HR' : 'sl-SI', { weekday: 'short', day: 'numeric', month: 'numeric' })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setWeekStart((w) => { const d = new Date(`${w}T00:00:00`); d.setDate(d.getDate() - 7); return isoDay(d) })}>←</Button>
        <Input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} className="h-9 w-40" aria-label={t('urnik.weekStart')} />
        <Button size="sm" variant="outline" onClick={() => setWeekStart((w) => { const d = new Date(`${w}T00:00:00`); d.setDate(d.getDate() + 7); return isoDay(d) })}>→</Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="h-9" onClick={() => setToOpen(true)}><CalendarClock className="w-4 h-4" /> {t('urnik.requestTimeOff')}</Button>
          {canManage && (
            <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" onClick={() => { setEditShift(null); setSelEmployee(activeEmployees[0]?.id || ''); setSelDate(weekStart); setSelType('full'); setSelStart('08:00'); setSelEnd('16:00'); setSelBreak('30'); setSelNotes(''); setDialogOpen(true) }}>
              <Plus className="w-4 h-4" /> {t('urnik.newShift')}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {days.map((d) => {
            const key = isoDay(d)
            const dayShifts = shifts.filter((s) => s.shiftDate.slice(0, 10) === key)
            const isToday = key === isoDay(new Date())
            return (
              <Card key={key} className={`min-h-32 ${isToday ? 'border-emerald-300' : ''}`}>
                <CardHeader className="pb-1 pt-3"><CardTitle className={`text-xs font-semibold ${isToday ? 'text-emerald-700' : 'text-stone-500'}`}>{dayName(d)}</CardTitle></CardHeader>
                <CardContent className="space-y-1.5 pb-3">
                  {dayShifts.length === 0 && <p className="text-[11px] text-stone-400">—</p>}
                  {dayShifts.map((s) => (
                    <div key={s.id} className={`rounded-lg border px-2 py-1.5 text-[11px] ${SHIFT_STATUS_BADGE[s.status] || SHIFT_STATUS_BADGE.scheduled}`}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold truncate">{s.employeeName}</span>
                        {canManage && (
                          <button className="shrink-0 opacity-60 hover:opacity-100" onClick={() => { setEditShift(s); setSelEmployee(s.employeeId); setSelDate(s.shiftDate.slice(0, 10)); setSelType(s.shiftType); setSelStart(s.startTime); setSelEnd(s.endTime); setSelBreak(String(s.breakMinutes)); setSelNotes(s.notes); setDialogOpen(true) }} aria-label={t('common.edit')}>
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span>{s.startTime}–{s.endTime}</span>
                        <span className="opacity-70">{t(SHIFT_TYPE_LABELS[s.shiftType] || 'urnik.full')}</span>
                      </div>
                      {s.notes && <p className="truncate opacity-70">{s.notes}</p>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* zahteve za prostost */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm font-medium flex items-center gap-1.5"><CalendarClock className="w-4 h-4" /> {t('urnik.timeOff')}</CardTitle></CardHeader>
        <CardContent>
          {timeOff.length === 0 ? (
            <p className="text-sm text-stone-500">{t('urnik.noRequests')}</p>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {timeOff.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-100 px-2.5 py-1.5 text-sm">
                  <span className="font-medium">{r.employeeName}</span>
                  <Badge variant="outline" className="text-xs">{t(`urnik.to.${r.type}`)}</Badge>
                  <span className="text-stone-600">{r.startDate.slice(0, 10)} → {r.endDate.slice(0, 10)}</span>
                  {r.reason && <span className="text-xs text-stone-400 truncate max-w-40">{r.reason}</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    {r.status === 'pending' ? (
                      canManageRequests ? (
                        <>
                          <Button size="sm" className="h-7 text-xs bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void decideTimeOff(r.id, 'approved')}><CheckCircle2 className="w-3 h-3" /> {t('urnik.approve')}</Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void decideTimeOff(r.id, 'rejected')}><XCircle className="w-3 h-3" /> {t('urnik.reject')}</Button>
                        </>
                      ) : (
                        <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">{t('urnik.pending')}</Badge>
                      )
                    ) : (
                      <Badge variant="outline" className={`text-xs ${r.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : r.status === 'rejected' ? 'bg-red-50 text-red-700 border-red-200' : ''}`}>{t(`urnik.st.${r.status}`)}</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* dialog izmene */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{editShift ? t('urnik.editShift') : t('urnik.newShift')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {!editShift && (
              <div className="space-y-1">
                <Label>{t('urnik.employee')}</Label>
                <Select value={selEmployee} onValueChange={setSelEmployee}>
                  <SelectTrigger><SelectValue placeholder={t('urnik.employee')} /></SelectTrigger>
                  <SelectContent>
                    {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name} — {e.role}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {!editShift && (
              <div className="space-y-1">
                <Label>{t('urnik.date')}</Label>
                <Input type="date" value={selDate} onChange={(e) => setSelDate(e.target.value)} />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t('urnik.shiftType')}</Label>
                <Select value={selType} onValueChange={setSelType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(SHIFT_TYPE_LABELS).map(([k, key]) => <SelectItem key={k} value={k}>{t(key)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('urnik.break')}</Label>
                <Input type="number" min={0} max={240} value={selBreak} onChange={(e) => setSelBreak(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('urnik.from')}</Label>
                <Input type="time" value={selStart} onChange={(e) => setSelStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('urnik.to')}</Label>
                <Input type="time" value={selEnd} onChange={(e) => setSelEnd(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('urnik.notes')}</Label>
              <Input value={selNotes} onChange={(e) => setSelNotes(e.target.value)} placeholder={t('urnik.notesPh')} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            {editShift && (
              <Button variant="destructive" className="mr-auto h-9" disabled={busy} onClick={() => { const id = editShift.id; setDialogOpen(false); setEditShift(null); void removeShift(id) }}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || (!editShift && !selEmployee)} onClick={() => void saveShift()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog zahteve za prostost */}
      <Dialog open={toOpen} onOpenChange={setToOpen}>
        <DialogContent className="max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('urnik.requestTimeOff')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {canManageRequests && (
              <div className="space-y-1">
                <Label>{t('urnik.employee')}</Label>
                <Select value={toEmployee} onValueChange={setToEmployee}>
                  <SelectTrigger><SelectValue placeholder={t('urnik.myself')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__self">{t('urnik.myself')}</SelectItem>
                    {activeEmployees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t('urnik.toType')}</Label>
              <Select value={toType} onValueChange={setToType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['vacation', 'sick', 'personal', 'unpaid'].map((k) => <SelectItem key={k} value={k}>{t(`urnik.to.${k}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t('urnik.from')}</Label>
                <Input type="date" value={toFrom} onChange={(e) => setToFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('urnik.to')}</Label>
                <Input type="date" value={toTo} onChange={(e) => setToTo(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('urnik.reason')}</Label>
              <Input value={toReason} onChange={(e) => setToReason(e.target.value)} placeholder={t('urnik.reasonPh')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void createTimeOff()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('urnik.submitRequest')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

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
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-stone-500">
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
                <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-stone-500">
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
                <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-stone-500">
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

/* ─────────────── OPS-10 v1.77.0 — ANALITIKA kartice v Pregledu ─────────────── */

/* ─────────────────────── RAZREZ MONOLITA (v1.82.1 → v1.82.6, 7 valov) ───────────────────────
 * dashboard-tabs.tsx (9217 → ~1890 vrst., −79 %): domenski razrez v src/components/tabs/:
 *   - ops-cards.tsx (~1266): Pregled kartice (SalesByHour, LaborCost, Durs, Batches, …)
 *   - nabava-tab.tsx (1421): NabavaTab · zaloga-tab.tsx (~545): InventoryTab (+recepti/štetja)
 *   - gostinske-ops-tab.tsx (1170): DarilneKartice/Odpad/CakalnaLista · urniki-tab.tsx (1016)
 *   - integracje-tab.tsx (288) · finance-tab.tsx (~820): ShiftsTab+ExpensesTab
 *   - haccp-tab.tsx (~329): HaccpTab+načrti · backoffice-tab.tsx (1080): Dostava/Računi/Napitnine
 *   - gostje-tab.tsx (~175): Zvestoba+Mnenja · nastavitve-tab.tsx (~350): Jobs/Settings/Devices
 *   - enterprise-tab.tsx (~405): EnterpriseTab+MigrationsConsole
 * Ta modul ostaja KANONIČNI barrel — vsi obstoječi uvozi (@/components/dashboard-tabs)
 * delujejo nespremenjeno (re-export). Preostanek: Loyalty/Feedback/Jobs/Settings/Devices/
 * Enterprise/Migrations/StaffSchedule/MenuEngineering/KDS.
 */

export {
  SalesByHourCard, LaborCostCard, DursCheckButton, NotificationsCard,
  BatchesCard, BatchPrepCard, UpsellCard, DisplayPromosCard,
} from './tabs/ops-cards'
export { NabavaTab } from './tabs/nabava-tab'
export { DarilneKarticeTab, OdpadTab, CakalnaListaTab } from './tabs/gostinske-ops-tab'
export { DelovniCasTab, OdpiralniCasTab, DiscountsTab } from './tabs/urniki-tab'
export type { OpeningHoursRowT, DiscountRowT, TimeEntryT, TimeclockEmployeeT } from './tabs/urniki-tab'
export { IntegracijeTab } from './tabs/integracje-tab'
export { DeliveryTab, AccountingExportCard, GlJournalCard, NapitnineTab } from './tabs/backoffice-tab'
export type { DeliveryInfoT, DeliveryOrderT, DeliveryZoneT, PlatformIntegrationT } from './tabs/backoffice-tab'
export { InventoryTab } from './tabs/zaloga-tab'
export type { InventoryT, SupplierT, RecipeT, RecipeLineT } from './tabs/zaloga-tab'
export { ShiftsTab, ExpensesTab } from './tabs/finance-tab'
export type { ShiftT, FinancialT, ExpenseT } from './tabs/finance-tab'
export { HaccpTab } from './tabs/haccp-tab'
export type { HaccpT, HaccpPlanT } from './tabs/haccp-tab'
export { LoyaltyTab, FeedbackTab } from './tabs/gostje-tab'
export type { LoyaltyT, FeedbackT } from './tabs/gostje-tab'
export { JobsCard, SettingsEditor, DevicesCard } from './tabs/nastavitve-tab'
export type { JobT, SettingsT, DeviceT } from './tabs/nastavitve-tab'
export { EnterpriseTab, MigrationsConsoleSection } from './tabs/enterprise-tab'
