'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getToken } from '@/lib/client'
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
import {
  Loader2, Thermometer, AlertTriangle, Plus, Trash2, Pencil, ClipboardList,
  CalendarClock, CheckCircle2, XCircle, ShieldCheck, FileDown, RefreshCw, History,
} from 'lucide-react'

/* ─────────────────────────── HACCP (Issue #20) ─────────────────────────── */

export interface HaccpT {
  id: string; type: string; target: string; value: number | null; ok: boolean; note?: string | null
  employeeId?: string | null; checkedAt: string; locationId?: string | null
  // Issue #20 — operativna polja (legacy vrstice: prazni)
  planId?: string | null; planName?: string | null; entryState?: string; status?: string
  measureKind?: string | null; unit?: string | null; dueAt?: string | null
  closedAt?: string | null
}

const HACCP_TYPE_KEYS: Record<string, string> = {
  TEMPERATURE: 'haccp.type.TEMPERATURE', CLEANING: 'haccp.type.CLEANING', DELIVERY: 'haccp.type.DELIVERY', COOLING: 'haccp.type.COOLING', TRAINING: 'haccp.type.TRAINING',
}

const STATE_KEYS: Record<string, string> = {
  overdue: 'haccp.state.overdue', pending: 'haccp.state.pending', upcoming: 'haccp.state.upcoming',
  done: 'haccp.state.done', deviation: 'haccp.state.deviation',
  awaiting_verification: 'haccp.state.awaiting', closed: 'haccp.state.closed', legacy: 'haccp.state.done',
}

const STATE_CLASSES: Record<string, string> = {
  overdue: 'bg-red-600 text-white', pending: 'bg-amber-500 text-white', upcoming: 'bg-stone-200 text-stone-700',
  done: 'bg-emerald-600 text-white', deviation: 'bg-orange-600 text-white',
  awaiting_verification: 'bg-sky-600 text-white', closed: 'bg-stone-500 text-white',
}

export function HaccpTab({ checks, onReload }: { checks: HaccpT[]; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [type, setType] = useState('TEMPERATURE')
  const [target, setTarget] = useState('')
  const [value, setValue] = useState('')
  const [ok, setOk] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await api('/api/haccp', { method: 'POST', body: JSON.stringify({ type: type.toLowerCase(), target, value: value === '' ? null : Number(value.replace(',', '.')), ok, note }) })
      setTarget(''); setValue(''); setNote(''); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      {/* Issue #20 — plošča terminov (zapadle/današnje/prihodnje kontrole) */}
      <ScheduleBoard onChanged={onReload} />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Thermometer className="w-4 h-4" /> {t('haccp.newCheck')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('haccp.typeLabel')}</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(HACCP_TYPE_KEYS).map(([v, k]) => <SelectItem key={v} value={v}>{t(k)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-target">{t('haccp.target')}</Label>
              <Input id="h-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('haccp.targetPlaceholder')} />
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="h-value">{t('haccp.value')}</Label>
              <Input id="h-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder={t('haccp.valuePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('haccp.result')}</Label>
              <Select value={ok ? 'ok' : 'warn'} onValueChange={(v) => setOk(v === 'ok')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ok">{t('haccp.okSelect')}</SelectItem>
                  <SelectItem value="warn">{t('haccp.noteSelect')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-note">{t('haccp.note')}</Label>
              <Input id="h-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('haccp.optional')} />
            </div>
          </div>
          <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !target} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('haccp.submit')}</Button>
        </CardContent>
      </Card>

      <RecentChecks checks={checks} />

      <HaccpPlansSection />
    </div>
  )
}

/* ───────────────── ZADNJE KONTROLE (z življenjskim ciklom) ───────────────── */

function RecentChecks({ checks }: { checks: HaccpT[] }) {
  const { t } = useI18n()
  const [detailId, setDetailId] = useState<string | null>(null)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" /> {t('haccp.recent')}</CardTitle>
        <CardDescription>{t('haccp.recentDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {checks.length === 0 && <p className="text-sm text-stone-500">{t('haccp.none')}</p>}
        <ScrollArea className="max-h-80">
          <div className="grid gap-2 sm:grid-cols-2">
            {checks.map((c) => {
              const state = c.entryState || 'legacy'
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setDetailId(c.id)}
                  className="min-w-0 text-left rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2 hover:border-emerald-400 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {c.planName || c.target}
                      <Badge variant="outline" className="ml-1">{HACCP_TYPE_KEYS[c.type] ? t(HACCP_TYPE_KEYS[c.type]) : c.type}</Badge>
                      {c.planId && <Badge variant="outline" className="ml-1">{t('haccp.planBadge')}</Badge>}
                    </p>
                    <p className="text-xs text-stone-500">
                      {new Date(c.checkedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      {c.employeeId ? ` · ${c.employeeId}` : ''}{c.note ? ` · ${c.note}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {c.value !== null && c.value !== undefined && <p className="font-bold">{c.value}{c.unit || '°'}</p>}
                    <Badge className={state === 'done' ? 'bg-emerald-600 text-white' : state === 'deviation' ? 'bg-orange-600 text-white' : state === 'awaiting_verification' ? 'bg-sky-600 text-white' : state === 'closed' ? 'bg-stone-500 text-white' : 'bg-amber-600 text-white'}>
                      {t(STATE_KEYS[state] ?? 'haccp.state.done')}
                    </Badge>
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
      <EntryDetailDialog entryId={detailId} onClose={() => setDetailId(null)} onChanged={async () => {}} />
    </Card>
  )
}

/* ───────────────── PLOŠČA TERMINOV (Issue #20) ───────────────── */

interface OccurrenceT {
  plan: {
    id: string; name: string; category: string; target: string; steps: string[]; responsible: string
    frequency: string; dueTime: string | null; weekday: number | null; monthDay: number | null
    rule: { measureKind: string; unit: string } | null; thresholdText?: string
  }
  date: string
  dueAt: string
  state: 'overdue' | 'pending' | 'upcoming' | 'done' | 'deviation' | 'awaiting_verification' | 'closed'
  entry?: { id: string; numericValue: number | null; unit: string; status: string; entryState: string }
}

function ScheduleBoard({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useI18n()
  const [items, setItems] = useState<OccurrenceT[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [ddlPending, setDdlPending] = useState(false)
  const [perform, setPerform] = useState<OccurrenceT | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<{ occurrences: OccurrenceT[]; summary: Record<string, number> }>('/api/haccp/schedule?daysBack=3&daysFwd=2')
      setItems(d.occurrences ?? [])
      setSummary(d.summary ?? {})
      setDdlPending(false)
    } catch (err) {
      const msg = String((err as Error).message || '')
      if (msg.includes('DDL') || msg.includes('503')) setDdlPending(true)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  // ragrupiranje po datumih (lokalni datum termina)
  const byDate = useMemo(() => {
    const map = new Map<string, OccurrenceT[]>()
    for (const it of items) {
      const list = map.get(it.date) || []
      list.push(it)
      map.set(it.date, list)
    }
    return Array.from(map.entries())
  }, [items])

  const todayKey = new Date().toISOString().slice(0, 10)

  async function exportCsv() {
    setBusy(true)
    try {
      const token = getToken()
      const res = await fetch('/api/haccp/report?format=csv', token ? { headers: { authorization: `Bearer ${token}` } } : {})
      if (!res.ok) throw new Error(await res.text().catch(() => ''))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `haccp-porocilo-${todayKey}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast({ description: t('haccp.report.exported') })
    } catch {
      toast({ description: t('haccp.report.csvErr') })
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarClock className="w-4 h-4" /> {t('haccp.board.title')}
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void load()} aria-label={t('common.refresh')}><RefreshCw className="w-4 h-4" /></Button>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={exportCsv}>
            <FileDown className="w-4 h-4 mr-1" /> {t('haccp.report.export')}
          </Button>
        </CardTitle>
        <CardDescription>{t('haccp.board.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ddlPending && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{t('haccp.board.ddlPending')}</span>
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-stone-500 py-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</div>
        ) : items.length === 0 && !ddlPending ? (
          <p className="text-sm text-stone-500">{t('haccp.board.none')}</p>
        ) : (
          <>
            {/* povzetek stanj */}
            <div className="flex flex-wrap gap-1.5">
              {(['overdue', 'pending', 'deviation', 'awaiting_verification'] as const).map((k) => (
                <Badge key={k} className={STATE_CLASSES[k]}>
                  {t(STATE_KEYS[k])}: {summary[k] ?? 0}
                </Badge>
              ))}
            </div>
            <ScrollArea className="max-h-96">
              <div className="space-y-3">
                {byDate.map(([date, list]) => (
                  <div key={date}>
                    <p className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${date === todayKey ? 'text-emerald-700' : 'text-stone-400'}`}>
                      {date === todayKey ? t('haccp.board.today') : new Date(`${date}T12:00:00`).toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'numeric' })}
                    </p>
                    <div className="grid gap-2">
                      {list.map((it) => (
                        <div
                          key={`${it.plan.id}|${it.date}`}
                          className={`min-w-0 rounded-lg border p-3 flex items-start justify-between gap-3 ${
                            it.state === 'overdue' ? 'border-red-300 bg-red-50' : it.state === 'deviation' || it.state === 'awaiting_verification' ? 'border-orange-200 bg-orange-50' : 'border-stone-200 bg-white'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="font-medium truncate text-sm">
                              {it.plan.name}
                              <Badge variant="outline" className="ml-1">{HACCP_TYPE_KEYS[it.plan.category?.toUpperCase()] ? t(HACCP_TYPE_KEYS[it.plan.category.toUpperCase()]) : it.plan.category}</Badge>
                            </p>
                            <p className="text-xs text-stone-500 truncate">
                              {new Date(it.dueAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}
                              {it.plan.thresholdText ? ` · ${it.plan.thresholdText}` : ''}
                              {it.plan.responsible ? ` · ${it.plan.responsible}` : ''}
                              {it.entry && it.entry.numericValue !== null && it.entry.numericValue !== undefined ? ` · ${it.entry.numericValue} ${it.entry.unit || ''}`.trim() : ''}
                            </p>
                          </div>
                          <div className="shrink-0 flex flex-col items-end gap-1.5">
                            <Badge className={STATE_CLASSES[it.state] ?? 'bg-stone-400 text-white'}>{t(STATE_KEYS[it.state] ?? 'haccp.state.pending')}</Badge>
                            {(it.state === 'overdue' || it.state === 'pending') && (
                              <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800 min-h-11 px-4" onClick={() => setPerform(it)}>
                                {t('haccp.board.perform')}
                              </Button>
                            )}
                            {it.entry && (it.state === 'deviation' || it.state === 'awaiting_verification' || it.state === 'done' || it.state === 'closed') && (
                              <Button size="sm" variant="outline" className="h-9 min-h-11" onClick={() => setDetailId(it.entry!.id)}>
                                {t('haccp.board.detail')}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <p className="text-xs text-stone-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {t('haccp.board.disclaimer')}
            </p>
          </>
        )}
      </CardContent>

      {/* hiter vnos iz termina */}
      <PerformDialog
        occurrence={perform}
        onClose={() => setPerform(null)}
        onSaved={async (entryId, deviation) => {
          setPerform(null)
          await load()
          await onChanged()
          if (deviation && entryId) setDetailId(entryId)
        }}
      />
      <EntryDetailDialog
        entryId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={async () => { await load(); await onChanged() }}
      />
    </Card>
  )
}

/* ───────────────── HITER VNOS KONTROLE (termin → izvedba) ───────────────── */

function PerformDialog({
  occurrence, onClose, onSaved,
}: {
  occurrence: OccurrenceT | null
  onClose: () => void
  onSaved: (entryId: string | null, deviation: boolean) => Promise<void> | void
}) {
  const { t } = useI18n()
  const [numericValue, setNumericValue] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setNumericValue(''); setNote(''); setError('') }, [occurrence])

  const plan = occurrence?.plan
  const isNumber = plan?.rule?.measureKind === 'number'

  async function submit(outcome?: 'pass' | 'fail') {
    if (!plan) return
    setBusy(true); setError('')
    try {
      const body: Record<string, unknown> = { planId: plan.id, dueDate: occurrence?.date, note: note.trim() || undefined }
      if (isNumber) {
        const v = numericValue.trim().replace(',', '.')
        body.numericValue = Number(v)
      } else if (outcome) {
        body.outcome = outcome
      }
      const d = await api<{ check: { id: string; entryState: string } }>('/api/haccp', { method: 'POST', body: JSON.stringify(body) })
      await onSaved(d.check.id, d.check.entryState !== 'done')
    } catch (err) {
      setError(String((err as Error).message || ''))
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={occurrence !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent aria-describedby={undefined} className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plan?.name}</DialogTitle>
        </DialogHeader>
        {plan && (
          <div className="space-y-3">
            {/* jasna kontekstna ploščica: prag, enota, čas, odgovorna oseba */}
            <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 space-y-1 text-sm">
              {plan.thresholdText && (
                <p className="flex items-center gap-1.5 font-medium text-stone-800"><Thermometer className="w-4 h-4 shrink-0" /> {plan.thresholdText}</p>
              )}
              <p className="text-stone-500">{t('haccp.perform.time')}: {occurrence && new Date(occurrence.dueAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}</p>
              {plan.responsible && <p className="text-stone-500">{t('haccpPlan.responsible')}: {plan.responsible}</p>}
              {plan.target && <p className="text-stone-500">{t('haccp.target')}: {plan.target}</p>}
            </div>
            {plan.steps.length > 0 && (
              <ol className="list-decimal list-inside text-xs text-stone-600 space-y-0.5">
                {plan.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            )}

            {isNumber ? (
              <div className="space-y-1.5">
                <Label htmlFor="pf-value">{t('haccp.perform.value')} {plan.rule?.unit ? `(${plan.rule.unit})` : ''}</Label>
                <Input
                  id="pf-value"
                  inputMode="decimal"
                  autoFocus
                  className="h-14 text-lg text-center"
                  value={numericValue}
                  onChange={(e) => setNumericValue(e.target.value.replace(/[^\d.,-]/g, ''))}
                  placeholder={t('haccp.valuePlaceholder')}
                />
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="pf-note">{t('haccp.note')} ({t('haccp.optional')})</Label>
              <Input id="pf-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('haccp.perform.notePlaceholder')} />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex flex-col gap-2 pt-1">
              {isNumber ? (
                <Button className="bg-emerald-700 hover:bg-emerald-800 min-h-14 text-base" disabled={busy || numericValue.trim() === ''} onClick={() => void submit()}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-5 h-5 mr-1" />} {t('haccp.submit')}
                </Button>
              ) : (
                <>
                  <Button className="bg-emerald-700 hover:bg-emerald-800 min-h-14 text-base" disabled={busy} onClick={() => void submit('pass')}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-5 h-5 mr-1" />} {t('haccp.perform.pass')}
                  </Button>
                  <Button variant="destructive" className="min-h-14 text-base" disabled={busy} onClick={() => void submit('fail')}>
                    <XCircle className="w-5 h-5 mr-1" /> {t('haccp.perform.fail')}
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            </div>
            <p className="text-xs text-stone-400">{t('haccp.perform.serverAuthority')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ───────────────── PODROBNOST ZAPISA + CIKEL ODSTOPANJA ───────────────── */

interface ActionT {
  id: string; kind: string; method: string; note: string; outcome: string
  recheckValue: number | null; performedByName: string; managerial: boolean; createdAt: string
}

function EntryDetailDialog({ entryId, onClose, onChanged }: { entryId: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { t } = useI18n()
  const [data, setData] = useState<{ check: Record<string, unknown>; actions: ActionT[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'none' | 'corrective' | 'verify'>('none')
  const [note, setNote] = useState('')
  const [recheckValue, setRecheckValue] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const d = await api<{ check: Record<string, unknown>; actions: ActionT[] }>(`/api/haccp/${id}`)
      setData(d)
    } catch { /* zapis je menda izbrisan — zapri */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (entryId) { setMode('none'); setNote(''); setRecheckValue(''); setError(''); void load(entryId) }
    else setData(null)
  }, [entryId, load])

  const check = data?.check
  const entryState = String(check?.entryState ?? 'legacy')
  const canCorrective = entryState === 'deviation'
  const canVerify = entryState === 'awaiting_verification' || entryState === 'deviation'

  async function doCorrective() {
    if (!entryId) return
    setBusy(true); setError('')
    try {
      await api(`/api/haccp/${entryId}/actions`, { method: 'POST', body: JSON.stringify({ kind: 'corrective', note: note.trim() }) })
      setMode('none'); setNote('')
      await load(entryId)
      await onChanged()
      toast({ description: t('haccp.corrective.saved') })
    } catch (err) { setError(String((err as Error).message || '')) } finally { setBusy(false) }
  }

  async function doVerify(method: 'recheck' | 'approval') {
    if (!entryId) return
    setBusy(true); setError('')
    try {
      const body: Record<string, unknown> = { kind: 'verify', method }
      if (method === 'recheck') body.numericValue = Number(recheckValue.trim().replace(',', '.'))
      if (note.trim()) body.note = note.trim()
      await api(`/api/haccp/${entryId}/actions`, { method: 'POST', body: JSON.stringify(body) })
      setMode('none'); setNote(''); setRecheckValue('')
      await load(entryId)
      await onChanged()
      toast({ description: t('haccp.verify.saved') })
    } catch (err) { setError(String((err as Error).message || '')) } finally { setBusy(false) }
  }

  return (
    <Dialog open={entryId !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent aria-describedby={undefined} className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('haccp.detail.title')}
            {entryState !== 'legacy' && <Badge className={STATE_CLASSES[entryState] ?? 'bg-stone-400 text-white'}>{t(STATE_KEYS[entryState] ?? 'haccp.state.done')}</Badge>}
          </DialogTitle>
        </DialogHeader>
        {loading || !check ? (
          <div className="flex items-center gap-2 text-sm text-stone-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</div>
        ) : (
          <div className="space-y-3">
            {/* meritev */}
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 space-y-1 text-sm">
              <p className="font-medium">{String(check.planName || check.target || '')}</p>
              <p className="text-stone-600">
                {t('haccp.perform.value')}:{' '}
                <span className="font-bold">
                  {check.value !== null && check.value !== undefined ? `${check.value} ${check.unit || ''}`.trim() : check.status === 'ok' ? t('haccp.ok') : t('haccp.noteSelect')}
                </span>
                {' · '}{String(check.status).toUpperCase()}
              </p>
              {check.thresholdText ? <p className="text-stone-500">{t('haccp.detail.threshold')}: {String(check.thresholdText)}</p> : null}
              <p className="text-stone-500">
                {new Date(String(check.checkedAt)).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {check.employeeId ? ` · ${check.employeeId}` : ''}
                {check.planId ? ` · ${t('haccp.detail.planVersion')} v${String(check.planVersion ?? 1)}` : ''}
              </p>
              {check.note ? <p className="text-stone-500">{t('haccp.note')}: {String(check.note)}</p> : null}
            </div>

            {/* revizijska zgodovina (append-only) */}
            {data && data.actions.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-1.5">{t('haccp.detail.timeline')}</p>
                <div className="space-y-1.5">
                  {data.actions.map((a) => (
                    <div key={a.id} className="rounded-lg border border-stone-200 p-2.5 text-xs flex items-start gap-2">
                      {a.kind === 'corrective' ? <ClipboardList className="w-4 h-4 shrink-0 mt-0.5 text-orange-600" /> : <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-sky-600" />}
                      <div className="min-w-0">
                        <p className="font-medium">
                          {a.kind === 'corrective' ? t('haccp.detail.corrective') : a.method === 'recheck' ? t('haccp.detail.recheck') : t('haccp.detail.approval')}
                          {a.outcome && <Badge variant="outline" className="ml-1.5">{a.outcome === 'ok' ? 'OK' : a.outcome === 'failed' ? t('haccp.detail.failed') : a.outcome}</Badge>}
                          {a.recheckValue !== null && <span className="ml-1.5 font-bold">{a.recheckValue}</span>}
                        </p>
                        {a.note && <p className="text-stone-600">{a.note}</p>}
                        <p className="text-stone-400">
                          {new Date(a.createdAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          {a.performedByName ? ` · ${a.performedByName}` : ''}{a.managerial ? ` · ${t('haccp.detail.managerial')}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            {/* akcije glede na stanje */}
            {mode === 'none' ? (
              <div className="flex flex-col gap-2">
                {canCorrective && (
                  <Button className="bg-orange-600 hover:bg-orange-700 min-h-14" onClick={() => setMode('corrective')}>
                    <ClipboardList className="w-5 h-5 mr-1" /> {t('haccp.corrective.add')}
                  </Button>
                )}
                {canVerify && (
                  <Button className="bg-sky-700 hover:bg-sky-800 min-h-14" onClick={() => setMode('verify')}>
                    <ShieldCheck className="w-5 h-5 mr-1" /> {t('haccp.verify.add')}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
              </div>
            ) : mode === 'corrective' ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="corr-note">{t('haccp.corrective.noteLabel')}</Label>
                  <Textarea id="corr-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('haccp.corrective.placeholder')} />
                  <p className="text-xs text-stone-400">{t('haccp.corrective.hint')}</p>
                </div>
                <div className="flex flex-col gap-2">
                  <Button className="bg-orange-600 hover:bg-orange-700 min-h-14" disabled={busy || note.trim().length < 10} onClick={() => void doCorrective()}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-5 h-5 mr-1" />} {t('haccp.corrective.save')}
                  </Button>
                  <Button variant="outline" onClick={() => { setMode('none'); setError('') }}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>{t('haccp.verify.method')}</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" className="min-h-14 flex flex-col gap-0.5" disabled={busy} onClick={() => void doVerify('recheck')}>
                      <Thermometer className="w-5 h-5" />
                      <span className="text-xs">{t('haccp.verify.recheck')}</span>
                    </Button>
                    <Button variant="outline" className="min-h-14 flex flex-col gap-0.5" disabled={busy} onClick={() => void doVerify('approval')}>
                      <ShieldCheck className="w-5 h-5" />
                      <span className="text-xs">{t('haccp.verify.approval')}</span>
                    </Button>
                  </div>
                  <Input
                    inputMode="decimal"
                    className="h-14 text-lg text-center"
                    value={recheckValue}
                    onChange={(e) => setRecheckValue(e.target.value.replace(/[^\d.,-]/g, ''))}
                    placeholder={t('haccp.verify.recheckValue')}
                  />
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('haccp.verify.notePlaceholder')} />
                  <p className="text-xs text-stone-400">{t('haccp.verify.hint')}</p>
                </div>
                <Button variant="outline" onClick={() => { setMode('none'); setError('') }}>{t('common.cancel')}</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ───────────────── HACCP NAČRTI KONTROL (Task 64 + Issue #20) ───────────────── */

export interface HaccpPlanT {
  id: string
  name: string
  category: string
  frequency: string
  target: string
  threshold: string
  steps: string[]
  responsible: string
  active: boolean
  locationId: string | null
  createdAt: string
  // Issue #20 — operativna pravila
  measureKind: string | null
  unit: string | null
  direction: string | null
  okLimit: number | null
  warnLimit: number | null
  rangeMin: number | null
  rangeMax: number | null
  critical: boolean | null
  requiresVerification: boolean | null
  dueTime: string | null
  weekday: number | null
  monthDay: number | null
  version: number | null
}

const PLAN_FREQ_KEYS: Record<string, string> = {
  daily: 'haccpPlan.freq.daily', weekly: 'haccpPlan.freq.weekly', monthly: 'haccpPlan.freq.monthly',
}

const WEEKDAY_KEYS: Record<number, string> = {
  1: 'haccpPlan.wd.1', 2: 'haccpPlan.wd.2', 3: 'haccpPlan.wd.3', 4: 'haccpPlan.wd.4',
  5: 'haccpPlan.wd.5', 6: 'haccpPlan.wd.6', 7: 'haccpPlan.wd.7',
}

/**
 * Načrti kontrol (audit §7 vrstica 125 PARTIAL → DONE): CRUD nad HaccpPlan +
 * aktivnost stikalo. Issue #20: operativna pravila (meritev number/confirm,
 * pragi po smeri, termin dueTime + weekday/monthDay, kritičnost, obvezna
 * verifikacija) — polja so pasivna, dokler DDL haccp-ops ni apliciran
 * (plans.get ddlOpsPending → pasivna sekcija).
 */
function HaccpPlansSection() {
  const { t } = useI18n()
  const [plans, setPlans] = useState<HaccpPlanT[]>([])
  const [ddlPending, setDdlPending] = useState(false)
  const [opsPending, setOpsPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<HaccpPlanT | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('TEMPERATURE')
  const [frequency, setFrequency] = useState('daily')
  const [pTarget, setPTarget] = useState('')
  const [threshold, setThreshold] = useState('')
  const [responsible, setResponsible] = useState('')
  const [stepsText, setStepsText] = useState('')
  // Issue #20 — operativna pravila
  const [measureKind, setMeasureKind] = useState('confirm')
  const [unit, setUnit] = useState('')
  const [direction, setDirection] = useState('none')
  const [okLimit, setOkLimit] = useState('')
  const [warnLimit, setWarnLimit] = useState('')
  const [rangeMin, setRangeMin] = useState('')
  const [rangeMax, setRangeMax] = useState('')
  const [critical, setCritical] = useState(false)
  const [requiresVerification, setRequiresVerification] = useState(true)
  const [dueTime, setDueTime] = useState('10:00')
  const [weekday, setWeekday] = useState('1')
  const [monthDay, setMonthDay] = useState('1')

  async function load() {
    try {
      const d = await api<{ plans: HaccpPlanT[]; ddlPending: boolean; ddlOpsPending?: boolean }>('/api/haccp/plans')
      setPlans(d.plans ?? [])
      setDdlPending(Boolean(d.ddlPending))
      setOpsPending(Boolean(d.ddlOpsPending))
    } catch { /* ostanek prikazuje obstoječe vnose — načrti niso kritični */ }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  function openCreate() {
    setEditing(null); setName(''); setCategory('TEMPERATURE'); setFrequency('daily')
    setPTarget(''); setThreshold(''); setResponsible(''); setStepsText('')
    setMeasureKind('confirm'); setUnit(''); setDirection('none')
    setOkLimit(''); setWarnLimit(''); setRangeMin(''); setRangeMax('')
    setCritical(false); setRequiresVerification(true); setDueTime('10:00'); setWeekday('1'); setMonthDay('1')
    setDialogOpen(true)
  }
  function openEdit(p: HaccpPlanT) {
    setEditing(p); setName(p.name); setCategory(p.category); setFrequency(p.frequency)
    setPTarget(p.target); setThreshold(p.threshold); setResponsible(p.responsible)
    setStepsText(p.steps.join('\n'))
    setMeasureKind(p.measureKind || 'confirm'); setUnit(p.unit || ''); setDirection(p.direction || 'none')
    setOkLimit(p.okLimit !== null && p.okLimit !== undefined ? String(p.okLimit) : '')
    setWarnLimit(p.warnLimit !== null && p.warnLimit !== undefined ? String(p.warnLimit) : '')
    setRangeMin(p.rangeMin !== null && p.rangeMin !== undefined ? String(p.rangeMin) : '')
    setRangeMax(p.rangeMax !== null && p.rangeMax !== undefined ? String(p.rangeMax) : '')
    setCritical(Boolean(p.critical)); setRequiresVerification(p.requiresVerification !== false)
    setDueTime(p.dueTime || '10:00'); setWeekday(String(p.weekday || 1)); setMonthDay(String(p.monthDay || 1))
    setDialogOpen(true)
  }

  async function submit() {
    setBusy(true)
    try {
      const body = JSON.stringify({
        name,
        category: category.toLowerCase(),
        frequency,
        target: pTarget,
        threshold,
        responsible,
        steps: stepsText.split('\n').map((s) => s.trim()).filter(Boolean),
        // Issue #20 — operativna pravila (prazne meje → null)
        measureKind,
        unit: unit.trim() || undefined,
        direction,
        okLimit: okLimit.trim() === '' ? null : Number(okLimit.replace(',', '.')),
        warnLimit: warnLimit.trim() === '' ? null : Number(warnLimit.replace(',', '.')),
        rangeMin: rangeMin.trim() === '' ? null : Number(rangeMin.replace(',', '.')),
        rangeMax: rangeMax.trim() === '' ? null : Number(rangeMax.replace(',', '.')),
        critical,
        requiresVerification,
        dueTime,
        weekday: frequency === 'weekly' ? Number(weekday) : null,
        monthDay: frequency === 'monthly' ? Number(monthDay) : null,
      })
      if (editing) await api(`/api/haccp/plans/${editing.id}`, { method: 'PATCH', body })
      else await api('/api/haccp/plans', { method: 'POST', body })
      setDialogOpen(false)
      await load()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  async function toggleActive(p: HaccpPlanT) {
    try {
      await api(`/api/haccp/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ active: !p.active }) })
      await load()
    } catch (err) { alert((err as Error).message) }
  }

  async function remove(p: HaccpPlanT) {
    if (!window.confirm(t('haccpPlan.confirmDelete'))) return
    try {
      await api(`/api/haccp/plans/${p.id}`, { method: 'DELETE' })
      toast({ title: t('haccpPlan.deleted') })
      await load()
    } catch (err) { alert((err as Error).message) }
  }

  const isNumber = measureKind === 'number'

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ClipboardList className="w-4 h-4" /> {t('haccpPlan.title')}</CardTitle>
        <CardDescription>{t('haccpPlan.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ddlPending && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{t('haccpPlan.ddlPending')}</span>
          </div>
        )}
        {opsPending && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{t('haccpPlan.ddlOpsPending')}</span>
          </div>
        )}
        {!ddlPending && (
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1" /> {t('haccpPlan.new')}
          </Button>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-stone-500 py-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</div>
        ) : plans.length === 0 && !ddlPending ? (
          <p className="text-sm text-stone-500">{t('haccpPlan.none')}</p>
        ) : (
          <div className="grid gap-2">
            {plans.map((p) => (
              <div key={p.id} className={`min-w-0 rounded-lg border p-3 flex items-start justify-between gap-3 ${p.active ? 'border-stone-200 bg-white' : 'border-stone-200 bg-stone-50 opacity-75'}`}>
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {p.name}
                    <Badge variant="outline" className="ml-1">{HACCP_TYPE_KEYS[p.category] ? t(HACCP_TYPE_KEYS[p.category]) : p.category}</Badge>
                    <Badge variant="outline" className="ml-1">{PLAN_FREQ_KEYS[p.frequency] ? t(PLAN_FREQ_KEYS[p.frequency]) : p.frequency}</Badge>
                    {p.measureKind === 'number' && p.unit ? <Badge variant="outline" className="ml-1">{t('haccpPlan.measureNumber')} · {p.unit}</Badge> : null}
                    {p.critical ? <Badge className="ml-1 bg-red-600 text-white">{t('haccpPlan.criticalBadge')}</Badge> : null}
                    {p.version && p.version > 1 ? <Badge variant="outline" className="ml-1">v{p.version}</Badge> : null}
                  </p>
                  <p className="text-xs text-stone-500 truncate">
                    {p.target}{p.threshold ? ` · ${t('haccpPlan.threshold')}: ${p.threshold}` : ''}{p.responsible ? ` · ${t('haccpPlan.responsible')}: ${p.responsible}` : ''}
                    {p.dueTime ? ` · ${t('haccpPlan.dueTime')}: ${p.dueTime}` : ''}
                    {p.frequency === 'weekly' && p.weekday ? ` · ${WEEKDAY_KEYS[p.weekday] ? t(WEEKDAY_KEYS[p.weekday]) : ''}` : ''}
                    {p.frequency === 'monthly' && p.monthDay ? ` · ${t('haccpPlan.monthDay')}: ${p.monthDay}.` : ''}
                    {p.steps.length > 0 ? ` · ${t('haccpPlan.stepsCount').replace('{n}', String(p.steps.length))}` : ''}
                  </p>
                  {p.steps.length > 0 && (
                    <ol className="list-decimal list-inside text-xs text-stone-600 mt-1 space-y-0.5">
                      {p.steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
                      {p.steps.length > 4 && <li className="list-none text-stone-400">+{p.steps.length - 4} …</li>}
                    </ol>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <Switch checked={p.active} onCheckedChange={() => void toggleActive(p)} aria-label={t('haccpPlan.active')} />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(p)} aria-label={t('common.edit')}><Pencil className="w-4 h-4" /></Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600 hover:text-red-700" onClick={() => void remove(p)} aria-label={t('common.delete')}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t('haccpPlan.edit') : t('haccpPlan.new')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="hp-name">{t('haccpPlan.name')}</Label>
              <Input id="hp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('haccpPlan.namePlaceholder')} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('haccp.typeLabel')}</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(HACCP_TYPE_KEYS).map(([v, k]) => <SelectItem key={v} value={v}>{t(k)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('haccpPlan.frequency')}</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">{t('haccpPlan.freq.daily')}</SelectItem>
                    <SelectItem value="weekly">{t('haccpPlan.freq.weekly')}</SelectItem>
                    <SelectItem value="monthly">{t('haccpPlan.freq.monthly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hp-target">{t('haccp.target')}</Label>
                <Input id="hp-target" value={pTarget} onChange={(e) => setPTarget(e.target.value)} placeholder={t('haccp.targetPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hp-threshold">{t('haccpPlan.threshold')}</Label>
                <Input id="hp-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder={t('haccpPlan.thresholdPlaceholder')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hp-responsible">{t('haccpPlan.responsible')}</Label>
              <Input id="hp-responsible" value={responsible} onChange={(e) => setResponsible(e.target.value)} placeholder={t('haccpPlan.responsiblePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hp-steps">{t('haccpPlan.steps')}</Label>
              <Textarea id="hp-steps" rows={4} value={stepsText} onChange={(e) => setStepsText(e.target.value)} placeholder={t('haccpPlan.stepsPlaceholder')} />
            </div>

            {/* Issue #20 — operativna pravila */}
            <div className="border-t border-stone-200 pt-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t('haccpPlan.opsSection')}</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t('haccpPlan.measureKind')}</Label>
                  <Select value={measureKind} onValueChange={setMeasureKind}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="confirm">{t('haccpPlan.measureConfirm')}</SelectItem>
                      <SelectItem value="number">{t('haccpPlan.measureNumber')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {isNumber ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="hp-unit">{t('haccpPlan.unit')}</Label>
                    <Input id="hp-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="°C" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>{t('haccpPlan.critical')}</Label>
                    <div className="flex items-center h-9 gap-2">
                      <Switch checked={critical} onCheckedChange={setCritical} aria-label={t('haccpPlan.critical')} />
                      <span className="text-xs text-stone-500">{t('haccpPlan.criticalHint')}</span>
                    </div>
                  </div>
                )}
              </div>
              {isNumber && (
                <>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>{t('haccpPlan.direction')}</Label>
                      <Select value={direction} onValueChange={setDirection}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="below">{t('haccpPlan.dir.below')}</SelectItem>
                          <SelectItem value="above">{t('haccpPlan.dir.above')}</SelectItem>
                          <SelectItem value="between">{t('haccpPlan.dir.between')}</SelectItem>
                          <SelectItem value="none">{t('haccpPlan.dir.none')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {(direction === 'below' || direction === 'above') ? (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor="hp-ok">{t('haccpPlan.okLimit')}</Label>
                          <Input id="hp-ok" inputMode="decimal" value={okLimit} onChange={(e) => setOkLimit(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder={direction === 'below' ? '4' : '63'} />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="hp-warn">{t('haccpPlan.warnLimit')}</Label>
                          <Input id="hp-warn" inputMode="decimal" value={warnLimit} onChange={(e) => setWarnLimit(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder={direction === 'below' ? '6' : '60'} />
                        </div>
                      </>
                    ) : direction === 'between' ? (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor="hp-rmin">{t('haccpPlan.rangeMin')}</Label>
                          <Input id="hp-rmin" inputMode="decimal" value={rangeMin} onChange={(e) => setRangeMin(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder="0" />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="hp-rmax">{t('haccpPlan.rangeMax')}</Label>
                          <Input id="hp-rmax" inputMode="decimal" value={rangeMax} onChange={(e) => setRangeMax(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder="4" />
                        </div>
                      </>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('haccpPlan.critical')}</Label>
                    <div className="flex items-center gap-2">
                      <Switch checked={critical} onCheckedChange={setCritical} aria-label={t('haccpPlan.critical')} />
                      <span className="text-xs text-stone-500">{t('haccpPlan.criticalHint')}</span>
                    </div>
                  </div>
                </>
              )}
              <div className="grid sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="hp-due">{t('haccpPlan.dueTime')}</Label>
                  <Input id="hp-due" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
                </div>
                {frequency === 'weekly' ? (
                  <div className="space-y-1.5">
                    <Label>{t('haccpPlan.weekday')}</Label>
                    <Select value={weekday} onValueChange={setWeekday}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(WEEKDAY_KEYS).map(([v, k]) => <SelectItem key={v} value={v}>{t(k)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {frequency === 'monthly' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="hp-mday">{t('haccpPlan.monthDay')}</Label>
                    <Input id="hp-mday" inputMode="numeric" value={monthDay} onChange={(e) => setMonthDay(e.target.value.replace(/[^\d]/g, ''))} placeholder="1-28" />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label>{t('haccpPlan.requiresVerification')}</Label>
                  <div className="flex items-center h-9 gap-2">
                    <Switch checked={requiresVerification} onCheckedChange={setRequiresVerification} aria-label={t('haccpPlan.requiresVerification')} />
                  </div>
                </div>
              </div>
              <p className="text-xs text-stone-400">{t('haccpPlan.opsHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !name.trim()} onClick={submit}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? t('common.save') : t('haccpPlan.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
