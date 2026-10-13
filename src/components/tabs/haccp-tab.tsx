'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client'
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
import { Loader2, Thermometer, AlertTriangle, Plus, Trash2, Pencil, ClipboardList } from 'lucide-react'

/* ─────────────────────────── HACCP ─────────────────────────── */

export interface HaccpT { id: string; type: string; target: string; value: number | null; ok: boolean; note?: string | null; employeeId?: string | null; checkedAt: string }

const HACCP_TYPE_KEYS: Record<string, string> = {
  TEMPERATURE: 'haccp.type.TEMPERATURE', CLEANING: 'haccp.type.CLEANING', DELIVERY: 'haccp.type.DELIVERY', COOLING: 'haccp.type.COOLING', TRAINING: 'haccp.type.TRAINING',
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

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('haccp.recent')}</CardTitle></CardHeader>
        <CardContent>
          {checks.length === 0 && <p className="text-sm text-stone-500">{t('haccp.none')}</p>}
          <ScrollArea className="max-h-80">
            <div className="grid gap-2 sm:grid-cols-2">
              {checks.map((c) => (
                <div key={c.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{c.target} <Badge variant="outline" className="ml-1">{HACCP_TYPE_KEYS[c.type] ? t(HACCP_TYPE_KEYS[c.type]) : c.type}</Badge></p>
                    <p className="text-xs text-stone-500">{new Date(c.checkedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{c.employeeId ? ` · ${c.employeeId}` : ''}{c.note ? ` · ${c.note}` : ''}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {c.value !== null && <p className="font-bold">{c.value}°</p>}
                    <Badge className={c.ok ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'}>{c.ok ? t('haccp.ok') : t('haccp.note')}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <HaccpPlansSection />
    </div>
  )
}

/* ───────────────── HACCP NAČRTI KONTROL (Task 64, v1.62.0) ───────────────── */

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
}

const PLAN_FREQ_KEYS: Record<string, string> = {
  daily: 'haccpPlan.freq.daily', weekly: 'haccpPlan.freq.weekly', monthly: 'haccpPlan.freq.monthly',
}

/**
 * Načrti kontrol (audit §7 vrstica 125 PARTIAL → DONE): CRUD nad HaccpPlan +
 * aktivnost stikalo. Issue-13 vzorec: ko produkcija čaka DDL, GET vrne
 * ddlPending: true → passiven pas namesto napake (gumbi skriti). Komponenta
 * si podatke naloži sama (HaccpTab ostane props-kompatibilen s page.tsx).
 */
function HaccpPlansSection() {
  const { t } = useI18n()
  const [plans, setPlans] = useState<HaccpPlanT[]>([])
  const [ddlPending, setDdlPending] = useState(false)
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

  async function load() {
    try {
      const d = await api<{ plans: HaccpPlanT[]; ddlPending: boolean }>('/api/haccp/plans')
      setPlans(d.plans ?? [])
      setDdlPending(Boolean(d.ddlPending))
    } catch { /* ostanek prikazuje obstoječe vnose — načrti niso kritični */ }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  function openCreate() {
    setEditing(null); setName(''); setCategory('TEMPERATURE'); setFrequency('daily')
    setPTarget(''); setThreshold(''); setResponsible(''); setStepsText(''); setDialogOpen(true)
  }
  function openEdit(p: HaccpPlanT) {
    setEditing(p); setName(p.name); setCategory(p.category); setFrequency(p.frequency)
    setPTarget(p.target); setThreshold(p.threshold); setResponsible(p.responsible)
    setStepsText(p.steps.join('\n')); setDialogOpen(true)
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
              <div key={p.id} className={`rounded-lg border p-3 flex items-start justify-between gap-3 ${p.active ? 'border-stone-200 bg-white' : 'border-stone-200 bg-stone-50 opacity-75'}`}>
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {p.name}
                    <Badge variant="outline" className="ml-1">{HACCP_TYPE_KEYS[p.category] ? t(HACCP_TYPE_KEYS[p.category]) : p.category}</Badge>
                    <Badge variant="outline" className="ml-1">{PLAN_FREQ_KEYS[p.frequency] ? t(PLAN_FREQ_KEYS[p.frequency]) : p.frequency}</Badge>
                  </p>
                  <p className="text-xs text-stone-500 truncate">
                    {p.target}{p.threshold ? ` · ${t('haccpPlan.threshold')}: ${p.threshold}` : ''}{p.responsible ? ` · ${t('haccpPlan.responsible')}: ${p.responsible}` : ''}
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
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
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

