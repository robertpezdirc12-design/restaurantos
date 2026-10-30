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
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download, FileCode2 } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'


/* ─────────────────────────── INTEGRACIJE (AUDIT-FIX val 3) ─────────────────────────── */

/*
 * AUDIT-FIX val 3 (v1.82.3) — drugi val razreza monolita dashboard-tabs.tsx:
 * IntegracijeTab (~265 vrst.), dobesedno prenesena (pure move).
 * Barrel dashboard-tabs.tsx re-exporta — porabniki nespremenjeni.
 */

interface IntegRowT {
  id: string
  name: string
  type: string
  provider: string
  baseUrl: string
  syncEnabled: boolean
  syncInterval: number
  isActive: boolean
  connectionStatus: string
  lastSyncAt: string | null
  lastSyncStatus: string
  lastSyncError: string
  config: Record<string, unknown>
  maskedFields?: string[]
}

interface IntegForm {
  name: string
  type: string
  provider: string
  baseUrl: string
  syncInterval: string
  syncEnabled: boolean
  config: string
}

const INTEG_TYPES = ['delivery', 'pos', 'accounting', 'ecommerce', 'other'] as const
const INTEG_TYPE_KEYS: Record<string, string> = {
  delivery: 'integ.typeDelivery', pos: 'integ.typePos', accounting: 'integ.typeAccounting',
  ecommerce: 'integ.typeEcommerce', other: 'integ.typeOther',
}

const emptyIntegForm = (): IntegForm => ({
  name: '', type: 'delivery', provider: '', baseUrl: '', syncInterval: '300', syncEnabled: true, config: '{}',
})

function integRowToForm(d: IntegRowT): IntegForm {
  return {
    name: d.name, type: INTEG_TYPES.includes(d.type as never) ? d.type : 'other',
    provider: d.provider, baseUrl: d.baseUrl,
    syncInterval: String(d.syncInterval ?? 300), syncEnabled: d.syncEnabled,
    config: JSON.stringify(d.config ?? {}, null, 2),
  }
}

function integFormPayload(f: IntegForm) {
  return {
    name: f.name.trim(), type: f.type, provider: f.provider.trim(), baseUrl: f.baseUrl.trim(),
    syncInterval: Number(f.syncInterval) || 300, syncEnabled: f.syncEnabled,
    config: JSON.parse(f.config || '{}') as Record<string, unknown>,
  }
}

export function IntegracijeTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<IntegRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [testBusyId, setTestBusyId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<IntegForm>(emptyIntegForm())

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ integrations: IntegRowT[] }>('/api/integrations')
      setRows(d.integrations || [])
      setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void (async () => { await load() })() }, [])

  const setF = (p: Partial<IntegForm>) => setForm((f) => ({ ...f, ...p }))
  let configOk = true
  try { const c = JSON.parse(form.config || '{}'); if (!c || typeof c !== 'object' || Array.isArray(c)) configOk = false } catch { configOk = false }
  const interval = Number(form.syncInterval)
  const valid = form.name.trim().length > 0
    && (form.baseUrl.trim() === '' || /^https?:\/\//i.test(form.baseUrl.trim()))
    && Number.isFinite(interval) && interval >= 30 && interval <= 86400
    && configOk

  function openCreate() { setEditId(null); setForm(emptyIntegForm()); setErr(''); setOpen(true) }
  function openEdit(d: IntegRowT) { setEditId(d.id); setForm(integRowToForm(d)); setErr(''); setOpen(true) }

  async function save() {
    if (!valid) return
    setBusy(true); setErr('')
    try {
      if (editId) await api(`/api/integrations/${editId}`, { method: 'PATCH', body: JSON.stringify(integFormPayload(form)) })
      else await api('/api/integrations', { method: 'POST', body: JSON.stringify(integFormPayload(form)) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function toggle(d: IntegRowT) {
    setBusy(true)
    try { await api(`/api/integrations/${d.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !d.isActive }) }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function remove(d: IntegRowT) {
    if (!window.confirm(t('integ.deleteConfirm', { name: d.name }))) return
    setBusy(true)
    try { await api(`/api/integrations/${d.id}`, { method: 'DELETE' }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function testConnection(d: IntegRowT) {
    setTestBusyId(d.id)
    try {
      const r = await api<{ connectionStatus: string; statusCode: number; durationMs: number; error: string; reachable: boolean }>(`/api/integrations/${d.id}/test`, { method: 'POST' })
      if (r.reachable) toast({ title: t('integ.testOk', { code: r.statusCode, ms: r.durationMs }) })
      else toast({ title: t('integ.testFail', { error: r.error || t('integ.statusDisconnected') }), variant: 'destructive' })
      await load()
    } catch (e) {
      toast({ title: t('common.error'), description: (e as Error).message, variant: 'destructive' })
    } finally { setTestBusyId(null) }
  }

  const statusBadge = (d: IntegRowT) => {
    if (d.connectionStatus === 'connected') return <Badge className="gap-1 bg-emerald-700 text-white"><CheckCircle2 className="h-3 w-3" />{t('integ.statusConnected')}</Badge>
    if (d.connectionStatus === 'disconnected') return <Badge variant="outline" className="gap-1 border-red-200 text-red-700"><XCircle className="h-3 w-3" />{t('integ.statusDisconnected')}</Badge>
    return <Badge variant="secondary">{t('integ.statusUnknown')}</Badge>
  }

  const active = rows.filter((r) => r.isActive).length
  const connected = rows.filter((r) => r.connectionStatus === 'connected').length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardDescription>{t('integ.kpiTotal')}</CardDescription><CardTitle className="text-2xl">{rows.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{t('integ.kpiActive')}</CardDescription><CardTitle className="text-2xl">{active}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{t('integ.kpiConnected')}</CardDescription><CardTitle className="text-2xl">{connected}</CardTitle></CardHeader></Card>
      </div>

      {canManage && (
        <div className="flex justify-end">
          <Button className="gap-1 bg-emerald-700 hover:bg-emerald-800" onClick={openCreate}><Plus className="h-4 w-4" /> {t('integ.add')}</Button>
        </div>
      )}

      {/* OSS-5 (v1.201.0): odprta API specifikacija — javna površina dokumentirana kot
          OpenAPI 3.0.3 (GET /api/openapi); pokritost disk↔spec uveljavlja tests/v201. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><FileCode2 className="h-4 w-4 text-stone-500" aria-hidden /> {t('integ.openapi.title')}</CardTitle>
          <CardDescription>{t('integ.openapi.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" variant="outline" className="gap-1" onClick={() => window.open('/api/openapi', '_blank', 'noopener')}>
            <Download className="h-3.5 w-3.5" /> {t('integ.openapi.btn')}
          </Button>
        </CardContent>
      </Card>
      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-stone-400" /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-stone-500">{t('integ.empty')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((d) => (
            <Card key={d.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{d.name}</CardTitle>
                  {d.type && <Badge variant="secondary">{t(INTEG_TYPE_KEYS[d.type] || 'integ.typeOther')}</Badge>}
                  {d.provider && <Badge variant="outline">{d.provider}</Badge>}
                  {statusBadge(d)}
                  {!d.isActive && <Badge variant="secondary">{t('integ.inactive')}</Badge>}
                </div>
                {d.baseUrl && <CardDescription className="truncate">{d.baseUrl}</CardDescription>}
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-stone-500">
                  {t('integ.lastSyncLabel')}: {d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : t('integ.never')}
                  {' · '}{t('integ.intervalSec', { n: d.syncInterval })}
                </p>
                {d.maskedFields && d.maskedFields.length > 0 && (
                  <p className="text-xs text-stone-400">{t('integ.maskedNote')}: {d.maskedFields.join(', ')}</p>
                )}
                {canManage && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button size="sm" variant="outline" className="gap-1" disabled={testBusyId === d.id} onClick={() => void testConnection(d)}>
                      {testBusyId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                      {testBusyId === d.id ? t('integ.testing') : t('integ.test')}
                    </Button>
                    <div className="flex items-center gap-1.5">
                      <Switch checked={d.isActive} onCheckedChange={() => void toggle(d)} aria-label={t('integ.active')} />
                      <span className="text-xs text-stone-600">{d.isActive ? t('integ.active') : t('integ.inactive')}</span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => openEdit(d)}>{t('integ.edit')}</Button>
                    <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => void remove(d)} aria-label={t('integ.delete')}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? t('integ.editTitle') : t('integ.add')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ig-name">{t('integ.name')}</Label>
              <Input id="ig-name" value={form.name} onChange={(e) => setF({ name: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ig-type">{t('integ.type')}</Label>
                <Select value={form.type} onValueChange={(v) => setF({ type: v })}>
                  <SelectTrigger id="ig-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{INTEG_TYPES.map((ty) => <SelectItem key={ty} value={ty}>{t(INTEG_TYPE_KEYS[ty])}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ig-provider">{t('integ.provider')}</Label>
                <Input id="ig-provider" value={form.provider} onChange={(e) => setF({ provider: e.target.value })} placeholder="glovo / wolt / …" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ig-url">{t('integ.baseUrl')}</Label>
              <Input id="ig-url" value={form.baseUrl} onChange={(e) => setF({ baseUrl: e.target.value })} placeholder="https://api.provider.com" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2">
              <Label htmlFor="ig-sync" className="text-sm">{t('integ.syncEnabled')}</Label>
              <Switch id="ig-sync" checked={form.syncEnabled} onCheckedChange={(v) => setF({ syncEnabled: v })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ig-interval">{t('integ.syncInterval')}</Label>
              <Input id="ig-interval" type="number" min={30} max={86400} value={form.syncInterval} onChange={(e) => setF({ syncInterval: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ig-config">{t('integ.config')}</Label>
              <Textarea id="ig-config" className="font-mono text-xs" rows={5} value={form.config} onChange={(e) => setF({ config: e.target.value })} />
              <p className="text-xs text-stone-400">{t('integ.configHint')}</p>
            </div>
            {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
