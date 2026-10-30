'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Trash2, CheckCircle2, XCircle, CalendarClock, Pencil } from 'lucide-react'

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

  useEffect(() => { void (async () => { await load() })() }, [weekStart])

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
                  {dayShifts.length === 0 && <p className="text-xs text-stone-400">—</p>}
                  {dayShifts.map((s) => (
                    <div key={s.id} className={`rounded-lg border px-2 py-1.5 text-xs ${SHIFT_STATUS_BADGE[s.status] || SHIFT_STATUS_BADGE.scheduled}`}>
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
