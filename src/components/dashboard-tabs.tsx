'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
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
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Legend,
} from 'recharts'
import { Loader2, RefreshCw, HeartHandshake, TrendingUp, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Trash2, CheckCircle2, XCircle, Timer, CalendarClock, Pencil, Building2, Link2, Database, ChevronDown } from 'lucide-react'
import { DursCheckButton } from './tabs/ops-cards'

/* ─────────────────────────── ZVESTOBA ─────────────────────────── */

export interface LoyaltyT { id: string; guestName: string; phone?: string | null; points: number; visits: number; tier?: string | null }

const TIER_COLORS: Record<string, string> = {
  BRONZE: 'bg-amber-700 text-white', SILVER: 'bg-stone-400 text-white', GOLD: 'bg-yellow-500 text-white', PLATINUM: 'bg-stone-700 text-white',
}

export function LoyaltyTab({ accounts, canManage, onReload }: { accounts: LoyaltyT[]; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const totalPoints = accounts.reduce((s, a) => s + a.points, 0)
  const [member, setMember] = useState<{ guestName: string; phone: string } | null>(null)
  const [mBusy, setMBusy] = useState(false)
  const [pts, setPts] = useState<LoyaltyT | null>(null)
  const [pForm, setPForm] = useState({ delta: '', reason: '' })
  const [pBusy, setPBusy] = useState(false)

  async function createMember() {
    if (!member) return
    setMBusy(true)
    try {
      await api('/api/loyalty', { method: 'POST', body: JSON.stringify(member) })
      setMember(null); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setMBusy(false) }
  }
  async function savePoints() {
    if (!pts) return
    setPBusy(true)
    try {
      await api('/api/loyalty', { method: 'PATCH', body: JSON.stringify({ id: pts.id, delta: Number(pForm.delta), reason: pForm.reason }) })
      setPts(null); setPForm({ delta: '', reason: '' }); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setPBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><HeartHandshake className="w-4 h-4" /> {t('loy.members')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{accounts.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('loy.totalPoints')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{totalPoints}</p></CardContent></Card>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setMember({ guestName: '', phone: '' })}><Plus className="w-4 h-4" /> {t('loy.newMember')}</Button>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('loy.accounts')}</CardTitle></CardHeader>
        <CardContent>
          {accounts.length === 0 && <p className="text-sm text-stone-500">{t('loy.none')}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {accounts.map((a) => (
              <div key={a.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{a.guestName}</p>
                  <p className="text-xs text-stone-500">{a.phone || '—'} · {t('loy.visitsSuffix', { n: a.visits })}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <p className="font-bold">{t('payment.pointsOf', { n: a.points })}</p>
                    {a.tier && <Badge className={`mt-0.5 ${TIER_COLORS[a.tier] || 'bg-stone-500 text-white'}`}>{a.tier}</Badge>}
                  </div>
                  {canManage && (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setPts(a); setPForm({ delta: '', reason: '' }) }}>
                      {t('loy.pointsBtn')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!member} onOpenChange={(v) => !v && setMember(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('loy.newMemberTitle')}</DialogTitle></DialogHeader>
          {member && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="lo-name">{t('loy.guestName')}</Label>
                <Input id="lo-name" value={member.guestName} onChange={(e) => setMember({ ...member, guestName: e.target.value })} placeholder={t('loy.namePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lo-phone">{t('inv.phone')}</Label>
                <Input id="lo-phone" value={member.phone} onChange={(e) => setMember({ ...member, phone: e.target.value })} placeholder={t('loy.phonePlaceholder')} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMember(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={mBusy || !member?.guestName} onClick={createMember}>{mBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('loy.saveMember')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pts} onOpenChange={(v) => !v && setPts(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('loy.pointsTitle', { name: pts?.guestName ?? '' })}</DialogTitle></DialogHeader>
          {pts && (
            <div className="space-y-3">
              <p className="text-xs text-stone-500">{t('inv.currentStock')} <b>{t('payment.pointsOf', { n: pts.points })}</b> · {t('loy.tierLabel')} {pts.tier || 'bronze'}</p>
              <div className="space-y-1.5">
                <Label htmlFor="pt-delta">{t('loy.pointsDelta')}</Label>
                <Input id="pt-delta" inputMode="numeric" value={pForm.delta} onChange={(e) => setPForm({ ...pForm, delta: e.target.value.replace(/[^\d-]/g, '') })} placeholder={t('loy.deltaPlaceholder')} />
                <p className="text-[11px] text-stone-400">{t('loy.tierHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pt-reason">{t('loy.reason')}</Label>
                <Input id="pt-reason" value={pForm.reason} onChange={(e) => setPForm({ ...pForm, reason: e.target.value })} placeholder={t('haccp.optional')} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPts(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={pBusy || !pForm.delta || Number(pForm.delta) === 0} onClick={savePoints}>{pBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('loy.savePoints')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── MNENJA GOSTOV ─────────────────────────── */

export interface FeedbackT { id: string; rating: number; comment?: string | null; tableId?: string | null; createdAt: string }

export function FeedbackTab({ feedback, tables }: { feedback: FeedbackT[]; tables: { id: string; name: string }[] }) {
  const { t } = useI18n()
  const avg = feedback.length > 0 ? feedback.reduce((s, f) => s + f.rating, 0) / feedback.length : 0
  const tableName = (id?: string | null) => (id ? tables.find((t) => t.id === id)?.name || null : null)
  const stars = (r: number) => '★'.repeat(Math.round(r)) + '☆'.repeat(Math.max(0, 5 - Math.round(r)))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Star className="w-4 h-4" /> {t('fb.avgRating')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{feedback.length > 0 ? avg.toFixed(1) : '—'}<span className="text-base text-amber-500 ml-1.5">{feedback.length > 0 && stars(avg)}</span></p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('fb.count')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{feedback.length}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('fb.title')}</CardTitle></CardHeader>
        <CardContent>
          {feedback.length === 0 && <p className="text-sm text-stone-500">{t('fb.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="grid gap-2 sm:grid-cols-2">
              {feedback.map((f) => (
                <div key={f.id} className="rounded-lg border border-stone-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-amber-500 text-sm">{stars(f.rating)}</span>
                    <span className="text-xs text-stone-400 shrink-0">{new Date(f.createdAt).toLocaleDateString('sl-SI')}{tableName(f.tableId) ? ` · ${tableName(f.tableId)}` : ''}</span>
                  </div>
                  {f.comment && <p className="text-sm text-stone-600 mt-1 break-words">“{f.comment}”</p>}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

/* ─────────────────────────── DELOVNA MESTA ─────────────────────────── */

export interface JobT { id: string; title: string; permissions: string; active: boolean; startedAt: string }

export function JobsCard({ jobs, canManage, onReload }: { jobs: JobT[]; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [payRate, setPayRate] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ title, payRate: Number(payRate.replace(',', '.')) || 0 }) })
      setTitle(''); setPayRate(''); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Briefcase className="w-4 h-4" /> {t('jobs.title')}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {canManage && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 min-w-48 flex-1">
              <Label htmlFor="job-title">{t('jobs.name')}</Label>
              <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('jobs.titlePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="job-rate">{t('jobs.hourlyRate')}</Label>
              <Input id="job-rate" inputMode="decimal" value={payRate} onChange={(e) => setPayRate(e.target.value.replace(/[^\d.,]/g, ''))} placeholder={t('jobs.ratePlaceholder')} className="w-36" />
            </div>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !title} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('inv.add')}</Button>
          </div>
        )}
        {jobs.length === 0 && <p className="text-sm text-stone-500">{t('jobs.none')}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {jobs.map((j) => (
            <div key={j.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{j.title}</p>
                {j.permissions && <p className="text-xs text-stone-500 truncate">{j.permissions.split(',').join(' · ')}</p>}
              </div>
              <Badge className={j.active ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{j.active ? t('jobs.activeF') : t('jobs.inactiveF')}</Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── NASTAVITVE — UREJEVALNIK ─────────────────────────── */

export interface SettingsT {
  name: string; address: string; city: string; postCode: string; phone: string; email: string; web: string
  businessId: string; taxId: string; registerNumber: string; fursEnvironment: string
  defaultVatRate: string; reducedVatRate: string; loyaltyEnabled: boolean
  receiptFooter: string; currency: string; locale: string; country: string; emailEnabled: boolean
}

export function SettingsEditor({ settings, canManage, onReload }: { settings: SettingsT | null; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [form, setForm] = useState<SettingsT | null>(settings)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { setForm(settings) }, [settings])

  if (!form) {
    return canManage ? (
      <Card><CardContent className="text-sm text-stone-500">{t('set.notCreated')}</CardContent></Card>
    ) : null
  }
  if (!canManage) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Store className="w-4 h-4" /> {t('set.locationData')}</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1 text-stone-600">
          <p className="font-medium text-stone-800">{form.name}</p>
          <p>{[form.address, form.postCode, form.city].filter(Boolean).join(', ') || '—'}</p>
          <p className="text-xs text-stone-500">{form.phone} · {form.email}{form.web ? ` · ${form.web}` : ''}</p>
          <p className="text-xs text-stone-500">{t('set.idsLine', { tax: form.taxId || '—', business: form.businessId || '—', register: form.registerNumber })}</p>
        </CardContent>
      </Card>
    )
  }

  const set = (k: keyof SettingsT, v: string | boolean) => { setNotice(''); setForm((f) => (f ? { ...f, [k]: v } : f)) }
  async function save() {
    if (!form) return
    setSaving(true)
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          defaultVatRate: Number(form.defaultVatRate.replace(',', '.')),
          reducedVatRate: Number(form.reducedVatRate.replace(',', '.')),
        }),
      })
      setNotice(t('set.saved'))
      await onReload()
    } catch (err) { setNotice(`${t('common.error')}: ${(err as Error).message}`) } finally { setSaving(false) }
  }

  const txt = (k: keyof SettingsT, label: string, placeholder = '') => (
    <div className="space-y-1.5">
      <Label htmlFor={`st-${k}`}>{label}</Label>
      <Input id={`st-${k}`} value={String(form[k] ?? '')} onChange={(e) => set(k, e.target.value)} placeholder={placeholder} />
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><Store className="w-4 h-4" /> {t('set.company')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('common.error')) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {txt('name', t('jobs.name'), t('set.namePlaceholder'))}
          {txt('address', t('set.address'))}
          {txt('city', t('set.city'))}
          {txt('postCode', t('set.postCode'))}
          {txt('phone', t('inv.phone'))}
          {txt('email', t('set.email'))}
          {txt('web', t('set.web'))}
          {txt('businessId', t('set.businessId'))}
          <div className="space-y-1.5">
            <Label htmlFor="st-taxId">{t('set.taxId')}</Label>
            <Input id="st-taxId" value={String(form.taxId ?? '')} onChange={(e) => set('taxId', e.target.value)} />
            {/* OPS-8 val 2 — DURS VAT payer check (badge + autofill name) */}
            <DursCheckButton
              query={String(form.taxId ?? '')}
              compact
              onName={(name) => set('name', String(form.name ?? '').trim() ? String(form.name) : name)}
            />
          </div>
          {txt('registerNumber', t('set.registerNumber'), t('set.registerPlaceholder'))}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> {t('set.fursEnv')}</Label>
            <Select value={form.fursEnvironment || 'test'} onValueChange={(v) => set('fursEnvironment', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="test">{t('set.envTest')}</SelectItem>
                <SelectItem value="production">{t('set.envProduction')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-amber-600">{t('set.fursWarning')}</p>
          </div>
          {txt('receiptFooter', t('set.receiptFooter'), t('set.receiptFooterPlaceholder'))}
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {txt('defaultVatRate', t('set.vatBasic'), '22')}
          {txt('reducedVatRate', t('set.vatReduced'), '9.5')}
          {txt('currency', t('set.currency'), 'EUR')}
          {txt('locale', t('set.localeLabel'), 'sl-SI')}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5">
            <div><p className="text-sm font-medium">{t('set.loyaltyProgram')}</p><p className="text-xs text-stone-500">{t('set.loyaltyDesc')}</p></div>
            <Switch checked={form.loyaltyEnabled} onCheckedChange={(v) => set('loyaltyEnabled', v)} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5">
            <div><p className="text-sm font-medium">{t('set.emailReports')}</p><p className="text-xs text-stone-500">{t('set.emailReportsDesc')}</p></div>
            <Switch checked={form.emailEnabled} onCheckedChange={(v) => set('emailEnabled', v)} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('set.save')}
          </Button>
          <span className="text-xs text-stone-400">{form.country || 'SI'} · {form.locale || 'sl-SI'} · {form.currency || 'EUR'}</span>
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── NAPRAVE ─────────────────────────── */

export interface DeviceT { id: string; name: string; type: string; token: string; lastSeen?: string | null; status: string; locationId?: string | null; revoked?: boolean; pairedToDeviceId?: string | null }

const DEVICE_TYPE_KEYS: Record<string, string> = {
  POS: 'dev.type.pos', KDS: 'dev.type.kds', KDS_BAR: 'dev.type.kdsBar', TABLET: 'dev.type.tablet', KIOSK: 'dev.type.kiosk', MOBILE: 'dev.type.mobile', CUSTOMER_DISPLAY: 'dev.type.customerDisplay',
}

/**
 * Issue #3 — popoln Device Onboarding · Issue #4 §2 — VARNOSTNO HARDENED:
 * - nova naprava → ENKRATNA VPISNA KODA (15 min) — naprava jo unovči JAVNO na /kiosk ali prijavi
 * - žetoni v seznamu so MASKIRANI (poln token se nikoli ne vrača v GET)
 * - CFD paring koda (10 min, enkratna)
 */
export function DevicesCard({ devices, locations, onChanged }: { devices: DeviceT[]; locations: { id: string; name: string }[]; onChanged?: () => void }) {
  const { t } = useI18n()
  const locName = (id?: string | null) => (id ? locations.find((l) => l.id === id)?.name || null : null)
  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState({ name: '', type: 'pos', locationId: locations[0]?.id || 'none' })
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState<{ name: string; code: string } | null>(null)
  const [pairCode, setPairCode] = useState<{ device: string; code: string } | null>(null)
  const [notice, setNotice] = useState('')

  async function createEnrollmentCode() {
    if (nf.name.trim().length < 2) { setNotice(t('dev.nameMin')); return }
    setBusy(true); setNotice('')
    try {
      const res = await api<{ code: string; device: { name: string } }>('/api/devices/enroll', {
        method: 'POST',
        body: JSON.stringify({ name: nf.name.trim(), type: nf.type, locationId: nf.locationId === 'none' ? '' : nf.locationId }),
      })
      setNewCode({ name: res.device.name, code: res.code })
      setAddOpen(false)
      setNf({ name: '', type: 'pos', locationId: 'none' })
      onChanged?.()
    } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }

  async function deviceAction(id: string, action: 'revoke' | 'restore' | 'delete') {
    if (action === 'delete' && !confirm(t('dev.deleteConfirm'))) return
    setBusy(true); setNotice('')
    try {
      if (action === 'delete') await api(`/api/devices/${id}`, { method: 'DELETE' })
      else await api(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      onChanged?.()
    } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }

  async function showPairCode(d: DeviceT) {
    setBusy(true); setNotice('')
    try {
      const res = await api<{ code: string }>('/api/devices/display', { method: 'POST', body: JSON.stringify({ action: 'pair' }) })
      setPairCode({ device: d.name, code: res.code })
    } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-1.5"><MonitorSmartphone className="w-4 h-4" /> {t('dev.title')}</CardTitle>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => { setAddOpen((v) => !v); setNewCode(null) }}><Plus className="w-3.5 h-3.5" /> {t('dev.enrollCode')}</Button>
      </CardHeader>
      <CardContent>
        {addOpen && (
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 mb-3 space-y-3">
            <p className="text-xs font-medium text-stone-500">{t('dev.newHint')}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t('dev.typeLabel')}</Label>
                <Select value={nf.type} onValueChange={(v) => setNf((f) => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pos">{t('dev.type.pos')}</SelectItem>
                    <SelectItem value="kds">{t('dev.type.kds')}</SelectItem>
                    <SelectItem value="kds_bar">{t('dev.type.kdsBar')}</SelectItem>
                    <SelectItem value="tablet">{t('dev.type.tablet')}</SelectItem>
                    <SelectItem value="kiosk">{t('dev.sel.kiosk')}</SelectItem>
                    <SelectItem value="mobile">{t('dev.sel.mobile')}</SelectItem>
                    <SelectItem value="customer_display">{t('dev.sel.cfd')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('dev.location')}</Label>
                <Select value={nf.locationId} onValueChange={(v) => setNf((f) => ({ ...f, locationId: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('dev.noLocation')}</SelectItem>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('dev.name')}</Label>
                <Input value={nf.name} onChange={(e) => setNf((f) => ({ ...f, name: e.target.value }))} placeholder={t('dev.namePlaceholder')} />
              </div>
            </div>
            <Button size="sm" onClick={createEnrollmentCode} disabled={busy}>{busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null} {t('dev.createCode')}</Button>
          </div>
        )}

        {newCode && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-3">
            <p className="text-sm font-semibold text-amber-900">{t('dev.codeFor', { name: newCode.name })}</p>
            <p className="text-4xl font-extrabold tracking-[0.3em] my-2 text-center select-all">{newCode.code}</p>
            <p className="text-xs text-amber-700 mt-1">{t('dev.codeHint')}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => { navigator.clipboard?.writeText(newCode.code); setNotice(t('dev.copied')) }}>{t('dev.copyCode')}</Button>
          </div>
        )}

        {pairCode && (
          <div className="rounded-xl border border-stone-300 bg-stone-100 p-4 mb-3 text-center">
            <p className="text-sm text-stone-500">{t('dev.pairCode', { device: pairCode.device })}</p>
            <p className="text-4xl font-extrabold tracking-[0.3em] my-2 select-all">{pairCode.code}</p>
            <p className="text-xs text-stone-500">{t('dev.pairHint')}</p>
          </div>
        )}

        {notice && <p className="text-xs text-emerald-700 mb-2">{notice}</p>}
        {devices.length === 0 && <p className="text-sm text-stone-500">{t('dev.none')}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {devices.map((d) => (
            <div key={d.id} className={`rounded-lg border p-3 flex items-center justify-between gap-2 ${d.revoked ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-white'}`}>
              <div className="min-w-0">
                <p className="font-medium truncate">{d.name} <Badge variant="outline" className="ml-1">{DEVICE_TYPE_KEYS[d.type] ? t(DEVICE_TYPE_KEYS[d.type]) : d.type}</Badge></p>
                <p className="text-xs text-stone-500 truncate">{locName(d.locationId) || t('dev.withoutLocation')} · {t('dev.token', { token: d.token })}</p>
                <p className="text-[11px] text-stone-400">{t('dev.lastSeen', { when: d.lastSeen ? new Date(d.lastSeen).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('dev.never') })}{d.revoked ? t('dev.revoked') : ''}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge className={d.revoked ? 'bg-red-600 text-white' : d.status === 'online' ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{d.revoked ? 'revoked' : d.status}</Badge>
                <div className="flex gap-1">
                  {d.type.toUpperCase() === 'POS' && !d.revoked && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => showPairCode(d)}>{t('dev.cfdCode')}</Button>
                  )}
                  {d.revoked ? (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => deviceAction(d.id, 'restore')}>{t('dev.restore')}</Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => deviceAction(d.id, 'revoke')}>{t('dev.revoke')}</Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 text-[11px] text-red-700" disabled={busy} onClick={() => deviceAction(d.id, 'delete')}>{t('common.delete')}</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── ENTERPRISE (org/brand/property drevo) ─────────────────────────── */

interface EntLocationRow { id: string; name: string; code: string; type: string; isActive: boolean }
interface EntRcRow { id: string; name: string; code: string; isActive: boolean }
interface EntWsRow { id: string; name: string; kind: string; isActive: boolean }
interface EntPropertyRow {
  id: string; name: string; city: string; country: string; isActive: boolean; inScope: boolean
  locations: EntLocationRow[]; revenueCenters: EntRcRow[]; workstations: EntWsRow[]
}
interface EntBrandRow { id: string; name: string; isActive: boolean; properties: EntPropertyRow[] }
interface EntOrgRow { id: string; name: string; slug: string; isActive: boolean; brands: EntBrandRow[] }
interface EntData {
  myScope: { organizationId: string | null; brandId: string | null; propertyId: string | null; locationId: string | null } | null
  organizations: EntOrgRow[]
}

const ENT_COUNTRIES = ['SI', 'HR'] as const

function emptyEntForm() {
  return { name: '', organizationId: '', brandId: '', propertyId: '', locationId: '', address: '', city: '', country: 'SI' }
}
type EntForm = ReturnType<typeof emptyEntForm>
type EntKind = 'organization' | 'brand' | 'property' | 'link'

/* ─────────────────────────── MIGRACIJSKA KONZOLA (Task 65) ─────────────────────────── */

interface MigItem { id: string; descKey: string; endpoint: string; applied: boolean; error?: string }
interface MigResp { migrations: MigItem[]; pending: number; allApplied: boolean }
interface MigApplyResult { id: string; ok: boolean; status: number; detail?: string }

/**
 * Task 65 (v1.63.0) — DDL konzola: 9 idempotentnih produkcijskih migracij na enem mestu
 * (prej 9 ročnih POST klicev). Status probe + en klik "uporabi vse čakajoče"; delegacija
 * na obstoječe /api/admin/migrate-* rute (ENAK DDL vir + audit chain). Samo centralne
 * vloge — 403 → sekcija se skrije (backend je vir resnice).
 */
export function MigrationsConsoleSection() {
  const { t } = useI18n()
  const [items, setItems] = useState<MigItem[] | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function load() {
    try {
      const d = await api<MigResp>('/api/admin/migrations')
      setItems(d.migrations); setErr('')
    } catch (e) {
      const msg = (e as Error).message
      // 403 (non-central) → tiho skrij; infra napaka → pokaži besedilo
      if (msg.includes('Dostop zavrnjen') || msg.includes('unauthorized')) setHidden(true)
      else setErr(msg)
    }
  }
  useEffect(() => { void load() }, [])

  async function apply(id?: string) {
    setBusy(true); setErr('')
    try {
      const d = await api<MigResp & { applied: MigApplyResult[] }>('/api/admin/migrations', {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      })
      const okN = d.applied.filter((r) => r.ok).length
      const bad = d.applied.filter((r) => !r.ok)
      if (bad.length > 0) {
        toast({
          title: t('mig.partialToast', { n: okN }),
          description: bad.map((b) => `${b.id}: ${b.detail ?? b.status}`).join(' · '),
          variant: 'destructive',
        })
      } else if (okN > 0) {
        toast({ title: t('mig.appliedToast', { n: okN }) })
      } else {
        toast({ title: t('mig.nothingPending') })
      }
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  if (hidden) return null
  const pending = items?.filter((m) => !m.applied) ?? []

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Database className="w-4 h-4" /> {t('mig.title')}</CardTitle>
        <CardDescription>{t('mig.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items === null ? (
          <div className="flex items-center gap-2 text-sm text-stone-500 py-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</div>
        ) : (
          <>
            {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}
            {pending.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex items-center justify-between gap-3 flex-wrap">
                <span>{t('mig.pendingBanner', { n: pending.length })}</span>
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white shrink-0" disabled={busy} onClick={() => void apply()}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mig.applyAll')}
                </Button>
              </div>
            )}
            {pending.length === 0 && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" /> {t('mig.allDone')}
              </div>
            )}
            <div className="grid gap-2">
              {items.map((m) => (
                <div key={m.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {t(m.descKey)}
                      {m.applied ? (
                        <Badge className="gap-1 bg-emerald-700 text-white"><CheckCircle2 className="h-3 w-3" />{t('mig.status.applied')}</Badge>
                      ) : m.error ? (
                        <Badge variant="destructive">{t('mig.status.error')}</Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-300 text-amber-700">{t('mig.status.pending')}</Badge>
                      )}
                    </p>
                    <p className="text-xs text-stone-500 font-mono truncate">{m.endpoint}</p>
                    {m.error && <p className="text-xs text-red-600">{m.error}</p>}
                  </div>
                  {!m.applied && !m.error && (
                    <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => void apply(m.id)}>
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mig.apply')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function EnterpriseTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [data, setData] = useState<EntData | null>(null)
  const [locs, setLocs] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<EntKind>('organization')
  const [form, setForm] = useState<EntForm>(emptyEntForm())

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<EntData>('/api/enterprise')
      setData(d); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  // lokacije za povezovanje (javna pot vrne samo {id, name} aktivnih)
  useEffect(() => {
    fetch('/api/auth/locations').then((r) => r.json()).then((d) => setLocs(d.locations || [])).catch(() => setLocs([]))
  }, [])

  const setF = (p: Partial<EntForm>) => setForm((f) => ({ ...f, ...p }))
  const isBootstrap = data !== null && data.myScope === null
  const orgs = data?.organizations ?? []
  const kpi = {
    orgs: orgs.length,
    brands: orgs.reduce((n, o) => n + o.brands.length, 0),
    properties: orgs.reduce((n, o) => n + o.brands.reduce((m, b) => m + b.properties.length, 0), 0),
    locations: orgs.reduce((n, o) => n + o.brands.reduce((m, b) => m + b.properties.reduce((k, p) => k + p.locations.length, 0), 0), 0),
  }

  function openDialog(k: EntKind, pre: Partial<EntForm> = {}) {
    setKind(k); setForm({ ...emptyEntForm(), ...pre }); setErr(''); setOpen(true)
  }

  const valid =
    kind === 'organization' ? form.name.trim().length > 0
    : kind === 'brand' ? form.name.trim().length > 0 && form.organizationId !== ''
    : kind === 'property' ? form.name.trim().length > 0 && form.brandId !== ''
    : form.propertyId !== '' && form.locationId !== ''

  async function save() {
    if (!valid) return
    setBusy(true); setErr('')
    try {
      const body = kind === 'organization' ? { kind, name: form.name.trim() }
        : kind === 'brand' ? { kind, name: form.name.trim(), organizationId: form.organizationId }
        : kind === 'property' ? { kind, name: form.name.trim(), brandId: form.brandId, address: form.address.trim(), city: form.city.trim(), country: form.country }
        : { kind: 'link-location', propertyId: form.propertyId, locationId: form.locationId }
      await api('/api/enterprise', { method: 'POST', body: JSON.stringify(body) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  // sme uporabnik upravljati to org? bootstrap = break-glass (vse); ostali SAMO svoja org (backend 403 dvokraten)
  const canWriteOrg = (orgId: string) => canManage && (isBootstrap || data?.myScope?.organizationId === orgId)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>{t('ent.kpiOrgs')}</CardDescription><CardTitle className="text-2xl">{kpi.orgs}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{t('ent.kpiBrands')}</CardDescription><CardTitle className="text-2xl">{kpi.brands}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{t('ent.kpiProperties')}</CardDescription><CardTitle className="text-2xl">{kpi.properties}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>{t('ent.kpiLocations')}</CardDescription><CardTitle className="text-2xl">{kpi.locations}</CardTitle></CardHeader></Card>
      </div>

      {canManage && (
        <div className="flex justify-end">
          {isBootstrap && (
            <Button className="gap-1 bg-emerald-700 hover:bg-emerald-800" onClick={() => openDialog('organization')}>
              <Plus className="h-4 w-4" /> {t('ent.newOrg')}
            </Button>
          )}
        </div>
      )}
      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-stone-400" /></div>
      ) : orgs.length === 0 ? (
        <p className="text-sm text-stone-500">{t('ent.empty')}</p>
      ) : (
        <div className="space-y-4">
          {orgs.map((o) => (
            <Card key={o.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 text-emerald-700" />
                  <CardTitle className="text-base">{o.name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-[11px]">{o.slug}</Badge>
                  {!o.isActive && <Badge variant="secondary">{t('ent.inactive')}</Badge>}
                  {canWriteOrg(o.id) && (
                    <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => openDialog('brand', { organizationId: o.id })}>
                      <Plus className="h-3.5 w-3.5" /> {t('ent.newBrand')}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {o.brands.length === 0 && <p className="text-xs text-stone-400">{t('ent.noBrands')}</p>}
                {o.brands.map((b) => (
                  <div key={b.id} className="rounded-lg border border-stone-200 p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-sm">{b.name}</p>
                      {!b.isActive && <Badge variant="secondary">{t('ent.inactive')}</Badge>}
                      {canWriteOrg(o.id) && (
                        <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => openDialog('property', { organizationId: o.id, brandId: b.id })}>
                          <Plus className="h-3.5 w-3.5" /> {t('ent.newProperty')}
                        </Button>
                      )}
                    </div>
                    {b.properties.length === 0 && <p className="text-xs text-stone-400">{t('ent.noProperties')}</p>}
                    {b.properties.map((p) => (
                      <div key={p.id} className="rounded-md border border-stone-100 bg-stone-50 p-2.5 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{p.name}</p>
                          <span className="text-xs text-stone-500">{p.city} ({p.country})</span>
                          {!p.isActive && <Badge variant="secondary">{t('ent.inactive')}</Badge>}
                          {data?.myScope && (p.inScope
                            ? <Badge className="gap-1 bg-emerald-700 text-white"><CheckCircle2 className="h-3 w-3" />{t('ent.inScope')}</Badge>
                            : <Badge variant="outline" className="border-amber-200 text-amber-700">{t('ent.outScope')}</Badge>)}
                          {canWriteOrg(o.id) && (
                            <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => openDialog('link', { propertyId: p.id })}>
                              <Link2 className="h-3.5 w-3.5" /> {t('ent.linkLocation')}
                            </Button>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500">
                          <span>{t('ent.locCount', { n: p.locations.length })}</span>
                          <span>{t('ent.rcCount', { n: p.revenueCenters.length, m: p.workstations.length })}</span>
                          {p.locations.map((l) => (
                            <Badge key={l.id} variant="secondary" className="font-normal">{l.name}</Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {kind === 'organization' ? t('ent.newOrg') : kind === 'brand' ? t('ent.newBrand') : kind === 'property' ? t('ent.newProperty') : t('ent.linkLocation')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {kind === 'organization' && (
              <div className="space-y-1.5">
                <Label htmlFor="ent-name">{t('ent.orgName')}</Label>
                <Input id="ent-name" value={form.name} onChange={(e) => setF({ name: e.target.value })} />
                <p className="text-[11px] text-stone-400">{t('ent.slugAuto')}</p>
              </div>
            )}
            {kind === 'brand' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-org">{t('ent.selectOrg')}</Label>
                  <Select value={form.organizationId} onValueChange={(v) => setF({ organizationId: v })}>
                    <SelectTrigger id="ent-org"><SelectValue placeholder={t('ent.selectOrg')} /></SelectTrigger>
                    <SelectContent>{orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-brand">{t('ent.brandName')}</Label>
                  <Input id="ent-brand" value={form.name} onChange={(e) => setF({ name: e.target.value })} />
                </div>
              </>
            )}
            {kind === 'property' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-brand2">{t('ent.selectBrand')}</Label>
                  <Select value={form.brandId} onValueChange={(v) => setF({ brandId: v })}>
                    <SelectTrigger id="ent-brand2"><SelectValue placeholder={t('ent.selectBrand')} /></SelectTrigger>
                    <SelectContent>
                      {orgs.flatMap((o) => o.brands.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name} · {o.name}</SelectItem>
                      )))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-prop">{t('ent.propName')}</Label>
                  <Input id="ent-prop" value={form.name} onChange={(e) => setF({ name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-addr">{t('ent.address')}</Label>
                  <Input id="ent-addr" value={form.address} onChange={(e) => setF({ address: e.target.value })} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ent-city">{t('ent.city')}</Label>
                    <Input id="ent-city" value={form.city} onChange={(e) => setF({ city: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ent-country">{t('ent.country')}</Label>
                    <Select value={form.country} onValueChange={(v) => setF({ country: v })}>
                      <SelectTrigger id="ent-country"><SelectValue /></SelectTrigger>
                      <SelectContent>{ENT_COUNTRIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              </>
            )}
            {kind === 'link' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-prop2">{t('ent.selectProperty')}</Label>
                  <Select value={form.propertyId} onValueChange={(v) => setF({ propertyId: v })}>
                    <SelectTrigger id="ent-prop2"><SelectValue placeholder={t('ent.selectProperty')} /></SelectTrigger>
                    <SelectContent>
                      {orgs.flatMap((o) => o.brands.flatMap((b) => b.properties.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name} · {b.name}</SelectItem>
                      ))))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ent-loc">{t('ent.selectLocation')}</Label>
                  <Select value={form.locationId} onValueChange={(v) => setF({ locationId: v })}>
                    <SelectTrigger id="ent-loc"><SelectValue placeholder={t('ent.selectLocation')} /></SelectTrigger>
                    <SelectContent>{locs.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </>
            )}
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

      <MigrationsConsoleSection />
    </div>
  )
}

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

/* ─────────────────────── RAZREZ MONOLITA (v1.82.1 → v1.82.5, 6 valov) ───────────────────────
 * dashboard-tabs.tsx (9217 → ~1890 vrst., −79 %): domenski razrez v src/components/tabs/:
 *   - ops-cards.tsx (~1266): Pregled kartice (SalesByHour, LaborCost, Durs, Batches, …)
 *   - nabava-tab.tsx (1421): NabavaTab · zaloga-tab.tsx (~545): InventoryTab (+recepti/štetja)
 *   - gostinske-ops-tab.tsx (1170): DarilneKartice/Odpad/CakalnaLista · urniki-tab.tsx (1016)
 *   - integracje-tab.tsx (288) · finance-tab.tsx (~820): ShiftsTab+ExpensesTab
 *   - haccp-tab.tsx (~310): HaccpTab+načrti · backoffice-tab.tsx (1080): Dostava/Računi/Napitnine
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
