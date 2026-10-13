'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
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
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'


/* ─────────────────────────── ČAS / URNIKI / POPUSTI (AUDIT-FIX val 3) ─────────────────────────── */

/*
 * AUDIT-FIX val 3 (v1.82.3) — drugi val razreza monolita dashboard-tabs.tsx:
 * DelovniCasTab + OdpiralniCasTab + DiscountsTab (~960 vrst.), dobesedno
 * prenesene (pure move). Barrel dashboard-tabs.tsx re-exporta vse tri —
 * porabniki nespremenjeni.
 */

/* ─────────────────────────── DELOVNI ČAS (clock-in/out, triage ⑥) ─────────────────────────── */

export interface TimeEntryT {
  id: string
  employeeId: string
  employeeName: string
  clockIn: string
  clockOut: string | null
  breakStart: string | null
  breakEnd: string | null
  breakMinutes: number
  totalMinutes: number
  payRate: number
  totalPay: number
  type: string
  status: string
  notes: string
  locationId?: string | null
}

export interface TimeclockEmployeeT { id: string; name: string; role: string }

const tcTypeBadge: Record<string, string> = {
  regular: 'bg-stone-100 text-stone-700',
  overtime: 'bg-amber-100 text-amber-800',
  holiday: 'bg-violet-100 text-violet-800',
  sick: 'bg-rose-100 text-rose-800',
  vacation: 'bg-teal-100 text-teal-800',
}
const tcTypeKeys: Record<string, string> = {
  regular: 'tc.typeRegular', overtime: 'tc.typeOvertime', holiday: 'tc.typeHoliday', sick: 'tc.typeSick', vacation: 'tc.typeVacation',
}
const tcStatusBadge: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  disputed: 'bg-red-100 text-red-800',
}
const tcStatusKeys: Record<string, string> = {
  active: 'tc.stPending', approved: 'tc.stApproved', disputed: 'tc.stDisputed',
}

function tcTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function tcDur(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}
function tcPay(eur: number): string {
  return eur.toFixed(2).replace('.', ',') + ' €'
}

export function DelovniCasTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [mine, setMine] = useState<TimeEntryT[]>([])
  const [activeEntry, setActiveEntry] = useState<TimeEntryT | null>(null)
  const [myStats, setMyStats] = useState<{ totalMinutes: number; approvedMinutes: number } | null>(null)
  const [team, setTeam] = useState<{ entries: TimeEntryT[]; employees: TimeclockEmployeeT[]; activeNow: { employeeId: string; employeeName: string; clockIn: string; breakStart: string | null }[]; stats: { totalMinutes: number; approvedMinutes: number; disputedCount: number; activeCount: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [tick, setTick] = useState(0)

  // ročni vnos (manager)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({ employeeId: '', clockIn: '', clockOut: '', breakMinutes: '0', type: 'regular', note: '' })
  const [teamDays, setTeamDays] = useState('7')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const own = await api<{ entries: TimeEntryT[]; activeEntry: TimeEntryT | null; stats: { totalMinutes: number; approvedMinutes: number } }>('/api/timeclock')
      setMine(own.entries)
      setActiveEntry(own.activeEntry)
      setMyStats(own.stats)
      if (canManage) {
        const t = await api<{ entries: TimeEntryT[]; employees: TimeclockEmployeeT[]; activeNow: { employeeId: string; employeeName: string; clockIn: string; breakStart: string | null }[]; stats: { totalMinutes: number; approvedMinutes: number; disputedCount: number; activeCount: number } }>(`/api/timeclock?scope=team&days=${teamDays}`)
        setTeam(t)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const iv = setInterval(() => setTick((x) => x + 1), 30_000)
    return () => clearInterval(iv)
  }, [canManage, teamDays])

  async function act(action: string) {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ summary?: { label: string; totalPay: number } }>('/api/timeclock', { method: 'POST', body: JSON.stringify({ action }) })
      if (action === 'clock-in') setOkMsg(t('tc.okClockIn'))
      else if (action === 'break-start') setOkMsg(t('tc.okBreakStart'))
      else if (action === 'break-end') setOkMsg(t('tc.okBreakEnd'))
      else if (action === 'clock-out' && d.summary) setOkMsg(t('tc.okClockOut', { label: d.summary.label, pay: d.summary.totalPay > 0 ? t('tc.okClockOutPay', { pay: tcPay(d.summary.totalPay) }) : '' }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function review(id: string, status: 'approved' | 'disputed') {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api(`/api/timeclock/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setOkMsg(status === 'approved' ? t('tc.okApproved') : t('tc.okDisputed'))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitManual() {
    if (!manual.employeeId) { setErr(t('tc.errEmployee')); return }
    if (!manual.clockIn || !manual.clockOut) { setErr(t('tc.errTimes')); return }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api('/api/timeclock', {
        method: 'POST',
        body: JSON.stringify({
          action: 'manual',
          employeeId: manual.employeeId,
          clockIn: new Date(manual.clockIn).toISOString(),
          clockOut: new Date(manual.clockOut).toISOString(),
          breakMinutes: Number(manual.breakMinutes) || 0,
          type: manual.type,
          note: manual.note || undefined,
        }),
      })
      setOkMsg(t('tc.okManual'))
      setManualOpen(false)
      setManual({ employeeId: '', clockIn: '', clockOut: '', breakMinutes: '0', type: 'regular', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onBreak = activeEntry?.breakStart !== null && activeEntry?.breakStart !== undefined && activeEntry?.breakEnd === null
  const nowMs = Date.now() + tick * 0 // tick sproži preracun
  const liveMin = activeEntry ? Math.max(0, Math.round((nowMs - new Date(activeEntry.clockIn).getTime()) / 60000) - activeEntry.breakMinutes) : 0

  return (
    <div className="space-y-6">
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700" role="status">{okMsg}</p>}

      {/* Moja ura */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Timer className="w-4 h-4" /> {activeEntry ? t('tc.shiftActive') : t('tc.myTitle')}</CardTitle>
          <CardDescription>{activeEntry ? t('tc.clockedInAt', { time: tcTime(activeEntry.clockIn), rate: activeEntry.payRate > 0 ? t('tc.rateSuffix', { pay: tcPay(activeEntry.payRate) }) : '' }) : t('tc.myDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeEntry ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-3xl font-bold tabular-nums">{tcDur(liveMin)}</div>
              {onBreak ? (
                <Badge className="bg-amber-100 text-amber-800">{t('tc.onBreakBadge', { time: new Date(activeEntry.breakStart!).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }) })}</Badge>
              ) : (
                <Badge className="bg-emerald-100 text-emerald-800">{t('tc.inProgress')}</Badge>
              )}
              <div className="flex gap-2 ml-auto flex-wrap">
                {!onBreak ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-start')}><Coffee className="w-4 h-4 mr-1" /> {t('tc.breakBtn')}</Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-end')}><Coffee className="w-4 h-4 mr-1" /> {t('tc.breakEndBtn')}</Button>
                )}
                <Button className="bg-red-700 hover:bg-red-800" disabled={busy} onClick={() => void act('clock-out')}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4 mr-1" />} {t('tc.clockOutBtn')}
                </Button>
              </div>
            </div>
          ) : (
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void act('clock-in')}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4 mr-1" />} {t('tc.clockInBtn')}
            </Button>
          )}
          {myStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-stone-100">
              <div><p className="text-xs text-stone-500">{t('waste.days30')}</p><p className="font-bold">{tcDur(myStats.totalMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">{t('tc.stApproved')}</p><p className="font-bold">{tcDur(myStats.approvedMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">{t('tc.entriesCount')}</p><p className="font-bold">{mine.length}</p></div>
              <div><p className="text-xs text-stone-500">{t('shifts.csvStatus')}</p><p className="font-bold">{activeEntry ? t('tc.onShift') : t('tc.offShift')}</p></div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Moja zgodovina */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('tc.myHistory')}</CardTitle></CardHeader>
        <CardContent>
          {mine.length === 0 && <p className="text-sm text-stone-500">{t('tc.myEmpty')}</p>}
          {mine.length > 0 && (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                  <th className="py-2 pr-3">{t('tc.thIn')}</th><th className="py-2 pr-3">{t('tc.thOut')}</th><th className="py-2 pr-3">{t('tc.thBreak')}</th>
                  <th className="py-2 pr-3">{t('tc.thTotal')}</th><th className="py-2 pr-3">{t('tc.thPay')}</th><th className="py-2 pr-3">{t('dev.typeLabel')}</th><th className="py-2">{t('shifts.csvStatus')}</th>
                </tr></thead>
                <tbody>
                  {mine.map((e) => (
                    <tr key={e.id} className="border-b border-stone-100">
                      <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">{t('tc.running')}</span>}</td>
                      <td className="py-2 pr-3">{e.breakMinutes > 0 ? tcDur(e.breakMinutes) : '—'}</td>
                      <td className="py-2 pr-3 font-semibold">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                      <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                      <td className="py-2 pr-3"><Badge className={tcTypeBadge[e.type] || 'bg-stone-100 text-stone-700'}>{tcTypeKeys[e.type] ? t(tcTypeKeys[e.type]) : e.type}</Badge></td>
                      <td className="py-2"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusKeys[e.status] ? t(tcStatusKeys[e.status]) : e.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ekipni vpogled (manager) */}
      {canManage && team && (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4" /> {t('tc.teamTitle')}</CardTitle>
              <CardDescription>{t('tc.teamDesc')}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={teamDays} onValueChange={setTeamDays}>
                <SelectTrigger className="w-32 h-8 text-xs" aria-label={t('tc.periodAria')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('shifts.csvToday')}</SelectItem>
                  <SelectItem value="7">{t('tc.day7')}</SelectItem>
                  <SelectItem value="14">{t('tc.day14')}</SelectItem>
                  <SelectItem value="31">{t('tc.day31')}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setManualOpen(true)}><Plus className="w-4 h-4 mr-1" /> {t('tc.manualBtn')}</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.totalPeriod')}</p><p className="text-lg font-bold">{tcDur(team.stats.totalMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.stApproved')}</p><p className="text-lg font-bold">{tcDur(team.stats.approvedMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.pendingApproval')}</p><p className="text-lg font-bold">{team.stats.activeCount}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.nowOnShift')}</p><p className="text-lg font-bold">{team.activeNow.length}</p></div>
            </div>
            {team.activeNow.length > 0 && (
              <div className="text-sm text-stone-600">
                <span className="font-semibold">{t('tc.onShiftColon')}</span>
                {team.activeNow.map((a) => `${a.employeeName}${a.breakStart ? ' ☕' : ''}`).join(', ')}
              </div>
            )}
            {team.entries.length === 0 && <p className="text-sm text-stone-500">{t('tc.teamEmpty')}</p>}
            {team.entries.length > 0 && (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                    <th className="py-2 pr-3">{t('shifts.csvEmployee')}</th><th className="py-2 pr-3">{t('tc.thIn')}</th><th className="py-2 pr-3">{t('tc.thOut')}</th>
                    <th className="py-2 pr-3">{t('tc.thTotal')}</th><th className="py-2 pr-3">{t('tc.thPay')}</th><th className="py-2 pr-3">{t('shifts.csvStatus')}</th><th className="py-2">{t('common.actions')}</th>
                  </tr></thead>
                  <tbody>
                    {team.entries.map((e) => (
                      <tr key={e.id} className="border-b border-stone-100">
                        <td className="py-2 pr-3 font-medium">{e.employeeName}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">{t('tc.running')}</span>}</td>
                        <td className="py-2 pr-3">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                        <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                        <td className="py-2 pr-3"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusKeys[e.status] ? t(tcStatusKeys[e.status]) : e.status}</Badge></td>
                        <td className="py-2">
                          {e.status !== 'approved' && e.clockOut && (
                            <Button size="sm" variant="outline" className="h-7 mr-1" disabled={busy} onClick={() => void review(e.id, 'approved')} title={t('tc.approveTitle')}><CheckCircle2 className="w-3.5 h-3.5" /><span className="sr-only">{t('tc.approveSr')}</span></Button>
                          )}
                          {e.status !== 'disputed' && (
                            <Button size="sm" variant="outline" className="h-7 text-red-700" disabled={busy} onClick={() => void review(e.id, 'disputed')} title={t('tc.disputeTitle')}><XCircle className="w-3.5 h-3.5" /><span className="sr-only">{t('tc.disputeTitle')}</span></Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ročni vnos dialog */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('tc.manualTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tc-employee">{t('shifts.csvEmployee')}</Label>
              <Select value={manual.employeeId} onValueChange={(v) => setManual((m) => ({ ...m, employeeId: v }))}>
                <SelectTrigger id="tc-employee"><SelectValue placeholder={t('tc.employeePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {(team?.employees || []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} ({e.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-in">{t('tc.thIn')}</Label>
                <Input id="tc-in" type="datetime-local" value={manual.clockIn} onChange={(e) => setManual((m) => ({ ...m, clockIn: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-out">{t('tc.thOut')}</Label>
                <Input id="tc-out" type="datetime-local" value={manual.clockOut} onChange={(e) => setManual((m) => ({ ...m, clockOut: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-break">{t('tc.breakMinutes')}</Label>
                <Input id="tc-break" type="number" min="0" value={manual.breakMinutes} onChange={(e) => setManual((m) => ({ ...m, breakMinutes: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-type">{t('dev.typeLabel')}</Label>
                <Select value={manual.type} onValueChange={(v) => setManual((m) => ({ ...m, type: v }))}>
                  <SelectTrigger id="tc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular">{t('tc.typeRegular')}</SelectItem>
                    <SelectItem value="overtime">{t('tc.typeOvertime')}</SelectItem>
                    <SelectItem value="holiday">{t('tc.typeHoliday')}</SelectItem>
                    <SelectItem value="sick">{t('tc.typeSick')}</SelectItem>
                    <SelectItem value="vacation">{t('tc.typeVacation')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tc-note">{t('haccp.note')}</Label>
              <Input id="tc-note" value={manual.note} onChange={(e) => setManual((m) => ({ ...m, note: e.target.value }))} placeholder={t('tc.notePlaceholder')} />
            </div>
            <p className="text-xs text-stone-500">{t('tc.manualHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitManual()} disabled={busy || !manual.employeeId || !manual.clockIn || !manual.clockOut}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('tc.addEntryBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('tc.loading')}</p>}
      {busy && !loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ODPIRALNI ČAS (issue #1, triage ⑦) ─────────────────────────── */


export interface OpeningHoursRowT { id: string; dayOfWeek: number; openTime: string; closeTime: string; breakStart: string; breakEnd: string; isClosed: boolean }
export interface SpecialDayT { id: string; date: string; isClosed: boolean; openTime: string; closeTime: string; note: string }
export interface OpenStatusT { isOpen: boolean; phase: string; label: string; detail: string; nextChangeAt: string | null; nextChangeLabel: string }
export interface OpeningHoursDataT {
  locationId: string
  inherited: boolean
  rows: OpeningHoursRowT[]
  specialDays: SpecialDayT[]
  status: OpenStatusT
  holidays: { date: string; name: string }[]
  holidaysYear: number
}

const DEFAULT_WEEK: OpeningHoursRowT[] = Array.from({ length: 7 }, (_, dow) => ({
  id: `new-${dow}`, dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
}))

const PHASE_STYLES: Record<string, { dot: string; card: string }> = {
  open: { dot: 'bg-emerald-500', card: 'border-emerald-200 bg-emerald-50' },
  break: { dot: 'bg-amber-500', card: 'border-amber-200 bg-amber-50' },
  closed_day: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
  special_closed: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
  special_hours: { dot: 'bg-sky-500', card: 'border-sky-200 bg-sky-50' },
  outside_hours: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
}

function fmtDateSL(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('sl-SI', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function OdpiralniCasTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [data, setData] = useState<OpeningHoursDataT | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<OpeningHoursRowT[]>(DEFAULT_WEEK)
  const [showBreak, setShowBreak] = useState<boolean[]>(Array(7).fill(false))
  const [spOpen, setSpOpen] = useState(false)
  const [sp, setSp] = useState({ date: '', isClosed: true, openTime: '', closeTime: '', note: '' })

  async function load() {
    try {
      const d = await api<OpeningHoursDataT>('/api/opening-hours')
      setData(d)
      const rows = d.rows.length === 7 ? d.rows : DEFAULT_WEEK
      setEdit(rows.map((r) => ({ ...r, id: r.id || `new-${r.dayOfWeek}` })))
      setShowBreak(Array.from({ length: 7 }, (_, i) => Boolean(rows[i]?.breakStart && rows[i]?.breakEnd)))
    } catch { /* status ostaja — napaka v msg */ } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  // status se osveži vsake 60 s (živi odprto/zaprto indikator)
  useEffect(() => {
    const t = setInterval(() => { void load() }, 60_000)
    return () => clearInterval(t)
  }, [])

  function setRow(dow: number, patch: Partial<OpeningHoursRowT>) {
    setEdit((rows) => rows.map((r) => (r.dayOfWeek === dow ? { ...r, ...patch } : r)))
  }

  async function save() {
    setBusy(true); setMsg('')
    try {
      const res = await api<{ rows: OpeningHoursRowT[]; status: OpenStatusT }>('/api/opening-hours', {
        method: 'PUT',
        body: JSON.stringify({ rows: edit.map((r) => ({ dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime, breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed })) }),
      })
      setData((d) => (d ? { ...d, rows: res.rows, status: res.status, inherited: false } : d))
      setMsg(t('oh.okSaved'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addSpecial() {
    setBusy(true); setMsg('')
    try {
      await api('/api/opening-hours/special', { method: 'POST', body: JSON.stringify(sp) })
      setSpOpen(false)
      setSp({ date: '', isClosed: true, openTime: '', closeTime: '', note: '' })
      setMsg(t('oh.okSpecialAdded'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function deleteSpecial(id: string) {
    if (!confirm(t('oh.confirmDeleteSpecial'))) return
    setBusy(true)
    try {
      await api(`/api/opening-hours/special?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setMsg(t('oh.okSpecialDeleted'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addHolidays() {
    if (!data?.holidays?.length) return
    if (!confirm(t('oh.confirmHolidays', { n: data.holidays.length, year: data.holidaysYear }))) return
    setBusy(true); setMsg('')
    try {
      const res = await api<{ added: number; skipped: string[] }>('/api/opening-hours/special', {
        method: 'POST', body: JSON.stringify({ holidays: data.holidays.map((h) => ({ date: h.date, name: h.name })) }),
      })
      setMsg(t('oh.okHolidays', { added: res.added, skipped: res.skipped.length }))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  const st = data?.status
  const phaseStyle = PHASE_STYLES[st?.phase ?? 'closed_day'] ?? PHASE_STYLES.closed_day

  return (
    <div className="space-y-4">
      {/* trenutni status — jasen odprto/zaprto indikator */}
      <Card className={phaseStyle.card}>
        <CardContent className="p-4">
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('oh.loadingStatus')}</p>
          ) : st ? (
            <div className="flex flex-wrap items-center gap-3">
              <span aria-hidden className={`w-3 h-3 rounded-full shrink-0 ${phaseStyle.dot} ${st.isOpen ? 'animate-pulse' : ''}`} />
              <div className="min-w-0">
                <p className="font-semibold text-stone-800">
                  {st.label}
                  {st.nextChangeLabel && <span className="font-normal text-stone-600"> — {st.nextChangeLabel}</span>}
                </p>
                <p className="text-sm text-stone-600">{st.detail}</p>
              </div>
              {data?.inherited && canManage && (
                <Badge variant="outline" className="ml-auto shrink-0">{t('oh.inheritedBadge')}</Badge>
              )}
            </div>
          ) : (
            <p className="text-sm text-stone-500">{t('oh.noStatus')}</p>
          )}
        </CardContent>
      </Card>

      {/* tedenski urnik */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-emerald-700" /> {t('oh.weekTitle')}</CardTitle>
            {canManage && <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void save()} disabled={busy}><CheckCircle2 className="w-3.5 h-3.5" /> {t('oh.saveBtn')}</Button>}
          </div>
          <CardDescription>{t('oh.weekDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {edit.map((r) => (
            <div key={r.dayOfWeek} className="rounded-lg border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-sm font-medium text-stone-700 shrink-0">{t(`oh.day${r.dayOfWeek}`)}</span>
                <Switch checked={!r.isClosed} onCheckedChange={(v) => setRow(r.dayOfWeek, v ? { isClosed: false, openTime: r.openTime || '08:00', closeTime: r.closeTime || '22:00' } : { isClosed: true, breakStart: '', breakEnd: '' })} disabled={!canManage} aria-label={t('oh.ariaOpen', { day: t(`oh.day${r.dayOfWeek}`) })} />
                {r.isClosed ? (
                  <Badge variant="outline" className="text-red-600 border-red-200">{t('oh.closed')}</Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input type="time" className="w-28 h-8" value={r.openTime} onChange={(e) => setRow(r.dayOfWeek, { openTime: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaOpens', { day: t(`oh.day${r.dayOfWeek}`) })} />
                    <span className="text-stone-400 text-sm">–</span>
                    <Input type="time" className="w-28 h-8" value={r.closeTime} onChange={(e) => setRow(r.dayOfWeek, { closeTime: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaCloses', { day: t(`oh.day${r.dayOfWeek}`) })} />
                    {canManage && (
                      <Button size="sm" variant={showBreak[r.dayOfWeek] ? 'secondary' : 'outline'} className="h-8 px-2 text-xs" onClick={() => setShowBreak((b) => b.map((v, i) => (i === r.dayOfWeek ? !v : v)))}>
                        <Coffee className="w-3.5 h-3.5" /> {t('tc.breakBtn')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {!r.isClosed && showBreak[r.dayOfWeek] && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pl-1 sm:pl-28">
                  <span className="text-xs text-stone-500 w-auto">{t('oh.breakColon')}</span>
                  <Input type="time" className="w-28 h-8" value={r.breakStart} onChange={(e) => setRow(r.dayOfWeek, { breakStart: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaBreakFrom', { day: t(`oh.day${r.dayOfWeek}`) })} />
                  <span className="text-stone-400 text-sm">–</span>
                  <Input type="time" className="w-28 h-8" value={r.breakEnd} onChange={(e) => setRow(r.dayOfWeek, { breakEnd: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaBreakTo', { day: t(`oh.day${r.dayOfWeek}`) })} />
                </div>
              )}
            </div>
          ))}
          {msg && <p className="text-sm text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> {msg}</p>}
          {err && <p className="text-sm text-red-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> {err}</p>}
        </CardContent>
      </Card>

      {/* posebni dnevi / prazniki */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-emerald-700" /> {t('oh.specialTitle')}</CardTitle>
              <CardDescription>{t('oh.specialDesc')}</CardDescription>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1" onClick={() => void addHolidays()} disabled={busy || !data?.holidays?.length}>
                  <Plus className="w-3.5 h-3.5" /> {t('oh.holidaysBtn', { year: data?.holidaysYear ?? '' })}
                </Button>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setSpOpen(true)} disabled={busy}>
                  <Plus className="w-3.5 h-3.5" /> {t('oh.specialBtn')}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {(data?.specialDays?.length ?? 0) === 0 ? (
            <p className="text-sm text-stone-500">{t('oh.specialEmpty')}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {data!.specialDays.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800">{fmtDateSL(s.date)}</p>
                    <p className="text-xs text-stone-500">
                      {s.isClosed ? t('oh.closedAllDay') : t('oh.openHours', { range: `${s.openTime}–${s.closeTime}` })}
                      {s.note ? ` · ${s.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant={s.isClosed ? 'destructive' : 'outline'}>{s.isClosed ? t('oh.closed') : t('oh.specialSchedule')}</Badge>
                    {canManage && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-red-600 border-red-200 hover:bg-red-50" disabled={busy} onClick={() => void deleteSpecial(s.id)}>
                        <Trash2 className="w-3.5 h-3.5" /><span className="sr-only">{t('oh.deleteSpecialAria', { date: s.date })}</span>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* dialog: nov poseben dan */}
      <Dialog open={spOpen} onOpenChange={setSpOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('oh.dialogTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sp-date">{t('exp.csvDate')}</Label>
              <Input id="sp-date" type="date" value={sp.date} onChange={(e) => setSp({ ...sp, date: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
              <Label htmlFor="sp-closed" className="font-normal">{t('oh.closedAllDay')}</Label>
              <Switch id="sp-closed" checked={sp.isClosed} onCheckedChange={(v) => setSp({ ...sp, isClosed: v })} />
            </div>
            {!sp.isClosed && (
              <div className="flex items-center gap-2">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-open">{t('oh.opensAt')}</Label>
                  <Input id="sp-open" type="time" value={sp.openTime} onChange={(e) => setSp({ ...sp, openTime: e.target.value })} />
                </div>
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-close">{t('oh.closesAt')}</Label>
                  <Input id="sp-close" type="time" value={sp.closeTime} onChange={(e) => setSp({ ...sp, closeTime: e.target.value })} />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="sp-note">{t('oh.noteReason')}</Label>
              <Input id="sp-note" value={sp.note} onChange={(e) => setSp({ ...sp, note: e.target.value })} placeholder={t('oh.notePlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={() => void addSpecial()} disabled={busy || !sp.date}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('inv.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && !data && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('tc.loading')}</p>}
    </div>
  )
}

/* ─────────────────────────── POPUSTI (admin upravljanje, Task 59) ─────────────────────────── */


export interface DiscountRowT {
  id: string
  name: string
  type: string
  amount: number
  appliesTo: string
  triggerType: string
  promoCode: string
  maxUses: number | null
  currentUses: number
  validFrom: string | null
  validTo: string | null
  happyDays: string
  happyFromHour: number | null
  happyToHour: number | null
  targetCategoryIds: string
  isActive: boolean
  sortOrder: number
}

interface CatLiteT { id: string; name: string }

const DAY_KEYS = ['disc.day0', 'disc.day1', 'disc.day2', 'disc.day3', 'disc.day4', 'disc.day5', 'disc.day6'] as const

interface DiscForm {
  name: string; type: string; amount: string; triggerType: string; promoCode: string
  maxUses: string; validFrom: string; validTo: string
  happy: boolean; days: number[]; fromHour: string; toHour: string; cats: string[]
}

const emptyForm = (): DiscForm => ({
  name: '', type: 'percent', amount: '', triggerType: 'manual', promoCode: '',
  maxUses: '', validFrom: '', validTo: '', happy: false, days: [1, 2, 3, 4, 5], fromHour: '16', toHour: '18', cats: [],
})

const rowToForm = (d: DiscountRowT): DiscForm => ({
  name: d.name,
  type: d.type,
  amount: String(d.amount),
  triggerType: d.triggerType,
  promoCode: d.promoCode || '',
  maxUses: d.maxUses == null ? '' : String(d.maxUses),
  validFrom: d.validFrom ? d.validFrom.slice(0, 10) : '',
  validTo: d.validTo ? d.validTo.slice(0, 10) : '',
  happy: d.happyFromHour != null,
  days: d.happyDays ? d.happyDays.split(',').map(Number) : [1, 2, 3, 4, 5],
  fromHour: d.happyFromHour == null ? '16' : String(d.happyFromHour),
  toHour: d.happyToHour == null ? '18' : String(d.happyToHour),
  cats: d.targetCategoryIds ? d.targetCategoryIds.split(',') : [],
})

const formPayload = (f: DiscForm) => ({
  name: f.name,
  type: f.type,
  amount: Number(f.amount.replace(',', '.')),
  triggerType: f.triggerType,
  promoCode: f.promoCode,
  maxUses: f.maxUses === '' ? null : Number(f.maxUses),
  validFrom: f.validFrom || null,
  validTo: f.validTo || null,
  happyDays: f.happy ? [...f.days].sort().join(',') : '',
  happyFromHour: f.happy ? Number(f.fromHour) : null,
  happyToHour: f.happy ? Number(f.toHour) : null,
  targetCategoryIds: f.cats.join(','),
  isActive: true,
})

const HOURS = Array.from({ length: 24 }, (_, i) => String(i))

export function DiscountsTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<DiscountRowT[]>([])
  const [cats, setCats] = useState<CatLiteT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<DiscForm>(emptyForm())

  const load = async () => {
    setLoading(true)
    try {
      const [ds, ms] = await Promise.all([
        api<{ discounts: DiscountRowT[] }>('/api/discounts'),
        api<{ categories: CatLiteT[] }>('/api/menus').catch(() => ({ categories: [] })),
      ])
      setRows(ds.discounts || [])
      setCats(ms.categories || [])
      setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const setF = (p: Partial<DiscForm>) => setForm((f) => ({ ...f, ...p }))
  const valid = form.name.trim().length > 0 && Number(form.amount.replace(',', '.')) > 0 && (!form.happy || form.fromHour !== form.toHour)

  function openCreate() { setEditId(null); setForm(emptyForm()); setErr(''); setOpen(true) }
  function openEdit(d: DiscountRowT) { setEditId(d.id); setForm(rowToForm(d)); setErr(''); setOpen(true) }

  async function save() {
    if (!valid) return
    setBusy(true); setErr('')
    try {
      if (editId) await api(`/api/discounts/${editId}`, { method: 'PATCH', body: JSON.stringify(formPayload(form)) })
      else await api('/api/discounts', { method: 'POST', body: JSON.stringify(formPayload(form)) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function toggle(d: DiscountRowT) {
    setBusy(true)
    try { await api(`/api/discounts/${d.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !d.isActive }) }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function remove(d: DiscountRowT) {
    if (!window.confirm(t('disc.deleteConfirm', { name: d.name }))) return
    setBusy(true)
    try { await api(`/api/discounts/${d.id}`, { method: 'DELETE' }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const happyText = (d: DiscountRowT) => {
    if (d.happyFromHour == null || d.happyToHour == null) return null
    const days = d.happyDays ? d.happyDays.split(',').map((n) => t(DAY_KEYS[Number(n)] || 'disc.day0')).join(', ') : t('disc.everyDay')
    return `${days} · ${d.happyFromHour}–${d.happyToHour}`
  }

  const active = rows.filter((d) => d.isActive).length
  const auto = rows.filter((d) => d.triggerType === 'auto').length
  const promo = rows.filter((d) => d.promoCode).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Percent className="w-4 h-4" /> {t('disc.kpiActive')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{active}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Clock className="w-4 h-4" /> {t('disc.kpiAuto')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{auto}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Ticket className="w-4 h-4" /> {t('disc.kpiPromo')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{promo}</p></CardContent></Card>
      </div>

      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {canManage && (
        <div className="flex justify-end">
          <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> {t('disc.new')}</Button>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('disc.list')}</CardTitle></CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('disc.loading')}</p>}
          {!loading && rows.length === 0 && <p className="text-sm text-stone-500">{t('disc.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="space-y-2">
              {rows.map((d) => {
                const hw = happyText(d)
                return (
                  <div key={d.id} className={`rounded-lg border p-3 flex items-center justify-between gap-3 ${d.isActive ? 'border-stone-200 bg-white' : 'border-stone-200 bg-stone-50 opacity-75'}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium truncate">{d.name}</p>
                        <Badge className="bg-emerald-700 text-white">{d.type === 'percent' ? `−${d.amount} %` : `−${fmtEUR(d.amount)}`}</Badge>
                        {d.triggerType === 'auto' && <Badge variant="outline">{t('disc.auto')}</Badge>}
                        {!d.isActive && <Badge variant="outline" className="text-stone-500">{t('disc.inactive')}</Badge>}
                      </div>
                      <p className="text-xs text-stone-500 mt-1">
                        {d.appliesTo === 'item' ? t('disc.appliesItems') : t('disc.appliesCheck')}
                        {d.promoCode ? ` · ${t('disc.promo')}: ${d.promoCode}` : ''}
                        {d.maxUses != null ? ` · ${t('disc.uses', { n: d.currentUses, m: d.maxUses })}` : ` · ${t('disc.unlimited', { n: d.currentUses })}`}
                        {hw ? ` · ${hw}` : ''}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch checked={d.isActive} disabled={busy} onCheckedChange={() => void toggle(d)} aria-label={t('disc.toggleAria', { name: d.name })} />
                        <Button size="sm" variant="outline" onClick={() => openEdit(d)}>{t('disc.edit')}</Button>
                        <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" disabled={busy} onClick={() => void remove(d)} aria-label={t('disc.deleteAria', { name: d.name })}><Trash2 className="w-4 h-4" /></Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? t('disc.editTitle') : t('disc.newTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dc-name">{t('disc.name')}</Label>
              <Input id="dc-name" value={form.name} onChange={(e) => setF({ name: e.target.value })} placeholder={t('disc.namePh')} maxLength={120} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-type">{t('disc.type')}</Label>
                <Select value={form.type} onValueChange={(v) => setF({ type: v })}>
                  <SelectTrigger id="dc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{['percent', 'fixed'].map((v) => <SelectItem key={v} value={v}>{v === 'percent' ? t('disc.percent') : t('disc.fixed')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-amount">{t('disc.amount')}</Label>
                <Input id="dc-amount" inputMode="decimal" value={form.amount} onChange={(e) => setF({ amount: e.target.value.replace(/[^\d.,]/g, '') })} placeholder={form.type === 'percent' ? t('disc.amountPercentPh') : t('disc.amountEurPh')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-trig">{t('disc.trigger')}</Label>
                <Select value={form.triggerType} onValueChange={(v) => setF({ triggerType: v })}>
                  <SelectTrigger id="dc-trig"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('disc.manual')}</SelectItem>
                    <SelectItem value="auto">{t('disc.auto')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-promo">{t('disc.promo')}</Label>
                <Input id="dc-promo" value={form.promoCode} onChange={(e) => setF({ promoCode: e.target.value.toUpperCase() })} placeholder={t('disc.promoPh')} maxLength={40} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-max">{t('disc.maxUses')}</Label>
                <Input id="dc-max" inputMode="numeric" value={form.maxUses} onChange={(e) => setF({ maxUses: e.target.value.replace(/\D/g, '') })} placeholder={t('disc.maxUsesPh')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-vf">{t('disc.validFrom')}</Label>
                <Input id="dc-vf" type="date" value={form.validFrom} onChange={(e) => setF({ validFrom: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-vt">{t('disc.validTo')}</Label>
                <Input id="dc-vt" type="date" value={form.validTo} onChange={(e) => setF({ validTo: e.target.value })} />
              </div>
            </div>
            <div className="rounded-lg border border-stone-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="dc-happy">{t('disc.happy')}</Label>
                <Switch id="dc-happy" checked={form.happy} onCheckedChange={(v) => setF({ happy: v })} />
              </div>
              {form.happy && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_KEYS.map((k, i) => (
                      <button
                        key={k} type="button"
                        className={`rounded-full px-2.5 py-1 text-xs border transition ${form.days.includes(i) ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'}`}
                        aria-pressed={form.days.includes(i)}
                        onClick={() => setF({ days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i] })}
                      >{t(k)}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="dc-hf">{t('disc.from')}</Label>
                      <Select value={form.fromHour} onValueChange={(v) => setF({ fromHour: v })}>
                        <SelectTrigger id="dc-hf"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-56">{HOURS.map((h) => <SelectItem key={h} value={h}>{h}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dc-ht">{t('disc.to')}</Label>
                      <Select value={form.toHour} onValueChange={(v) => setF({ toHour: v })}>
                        <SelectTrigger id="dc-ht"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-56">{HOURS.map((h) => <SelectItem key={h} value={h}>{h}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {cats.length > 0 && (
              <div className="space-y-1.5">
                <Label>{t('disc.cats')}</Label>
                <p className="text-[11px] text-stone-400">{t('disc.catsHint')}</p>
                <ScrollArea className="max-h-32 rounded-lg border border-stone-200 p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {cats.map((c) => (
                      <button
                        key={c.id} type="button"
                        className={`rounded-full px-2.5 py-1 text-xs border transition ${form.cats.includes(c.id) ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'}`}
                        aria-pressed={form.cats.includes(c.id)}
                        onClick={() => setF({ cats: form.cats.includes(c.id) ? form.cats.filter((x) => x !== c.id) : [...form.cats, c.id] })}
                      >{c.name}</button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
            {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('disc.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('disc.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


/* ─────────────── Integracije (Task 60 — audit §7 Integracije PARTIAL→DONE) ─────────────── */

