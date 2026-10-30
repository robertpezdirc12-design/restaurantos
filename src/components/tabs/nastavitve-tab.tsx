'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Briefcase, Store, MonitorSmartphone, ShieldAlert, ShieldCheck, Plus, AlertTriangle, Check } from 'lucide-react'
import { DursCheckButton } from './ops-cards'

/* ─────────────────────────── VARNOST — MFA (v1.94.0, issue #31–#36) ─────────────────────────── */

interface MfaStatus {
  enabled: boolean
  secretPending: boolean
  mandatory: boolean
  enforcementActive?: boolean
  bootstrap?: boolean
}

/**
 * Samo-oskrbni MFA (TOTP) upravitelj za PRIJAVLJENEGA uporabnika:
 *  - status iz /api/auth/mfa/status (brez skrivnosti);
 *  - vklop: PIN (step-up, #33) → QR/skrivnost → koda → /enable → recovery
 *    kode prikazane ENKRAT (v DB samo SHA-256) + nadaljevalni žeton (druge
 *    seje so preklicane — sessionVersion +1);
 *  - izklop: PIN + TOTP/recovery koda → /disable → nadaljevalni žeton.
 *  - enforcement (#31): mandatory=true opozori, enforcementActive pa pove,
 *    da bo brez MFA dostop omejen (enrollment-only seja).
 */
export function MfaCard() {
  const { t } = useI18n()
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null)
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [notice, setNotice] = useState('')

  async function loadStatus() {
    try {
      const s = await api<MfaStatus>('/api/auth/mfa/status')
      setStatus(s)
    } catch { setStatus(null) }
  }
  useEffect(() => { void (async () => { await loadStatus() })() }, [])

  /* enable/disable vračata NADALJEVALNI žeton (sessionVersion +1 revokacija
     ostalih sej) — shranimo ga takoj, sicer bi trenutna seja umrla. */
  async function mfaFetch(path: string, body: Record<string, unknown>) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('ro_token') || ''}`,
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String(data.error || t('common.error')))
    if (typeof data.token === 'string' && data.token) {
      localStorage.setItem('ro_token', data.token)
    }
    return data
  }

  async function startEnroll() {
    setError(''); setNotice(''); setBusy(true)
    try {
      const data = await mfaFetch('/api/auth/mfa/enroll', { pin })
      setEnroll({ secret: String(data.secret || ''), otpauthUri: String(data.otpauthUri || ''), qrDataUrl: String(data.qrDataUrl || '') })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function confirmEnable() {
    setError(''); setBusy(true)
    try {
      const data = await mfaFetch('/api/auth/mfa/enable', { pin, code })
      setRecovery(Array.isArray(data.recoveryCodes) ? (data.recoveryCodes as string[]) : [])
      setEnroll(null); setCode(''); setPin('')
      await loadStatus()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function confirmDisable() {
    setError(''); setBusy(true)
    try {
      // recovery koda (XXXX-XXXX, črke) ali TOTP koda — pošljemo glede na vsebino
      const isRecovery = /-[A-Z2-9]/i.test(code)
      const body = isRecovery ? { pin, recoveryCode: code } : { pin, code }
      await mfaFetch('/api/auth/mfa/disable', body)
      setNotice(t('mfa.disabled'))
      setCode(''); setPin('')
      await loadStatus()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (status?.bootstrap) return null // break-glass identiteta nima DB vrstice/MFA

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4" /> {t('mfa.title')}
          {status && (
            <Badge className={status.enabled ? 'bg-emerald-600 text-white' : status.mandatory ? 'bg-amber-500 text-white' : 'bg-stone-400 text-white'}>
              {status.enabled ? t('mfa.on') : status.mandatory ? t('mfa.required') : t('mfa.off')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!status && <p className="text-sm text-stone-500">{t('mfa.loading')}</p>}

        {status && !status.enabled && status.mandatory && (
          <p className={`text-xs rounded-md px-2.5 py-1.5 ${status.enforcementActive ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
            {status.enforcementActive ? t('mfa.enforcementOn') : t('mfa.mandatoryHint')}
          </p>
        )}
        {status?.enabled && <p className="text-xs text-stone-500">{t('mfa.enabledHint')}</p>}

        {status && !status.enabled && !enroll && !recovery && (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="mfa-pin">{t('mfa.pinLabel')}</Label>
              <Input id="mfa-pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••••" className="w-40 tracking-[0.3em] font-mono" />
              <p className="text-xs text-stone-400">{t('mfa.pinHint')}</p>
            </div>
            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || pin.length < 4} onClick={startEnroll}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mfa.start')}
            </Button>
          </div>
        )}

        {enroll && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-3">
            <p className="text-sm font-medium text-amber-900">{t('mfa.enrollTitle')}</p>
            <div className="flex flex-col sm:flex-row gap-3 items-start">
              {enroll.qrDataUrl && <img src={enroll.qrDataUrl} alt={t('mfa.qrAlt')} className="rounded-lg bg-white p-1 border border-amber-200 w-28 h-28" />}
              <div className="space-y-1 min-w-0 flex-1">
                <p className="text-xs text-amber-800">{t('mfa.scanHint')}</p>
                <p className="text-xs text-stone-500">{t('mfa.manual')}</p>
                <p className="font-mono text-xs break-all bg-white border border-amber-200 rounded-sm px-2 py-1 select-all">{enroll.secret}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="mfa-code">{t('mfa.codeLabel')}</Label>
                <Input id="mfa-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" className="tracking-[0.3em] font-mono" />
              </div>
            </div>
            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || code.length !== 6} onClick={confirmEnable}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mfa.enable')}
            </Button>
          </div>
        )}

        {recovery && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 space-y-2">
            <p className="text-sm font-semibold text-emerald-900">{t('mfa.recoveryTitle')}</p>
            <p className="text-xs text-emerald-700">{t('mfa.recoveryHint')}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {recovery.map((c) => (
                <p key={c} className="font-mono text-xs bg-white border border-emerald-200 rounded-sm px-2 py-1 select-all">{c}</p>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(recovery.join('\n')); setNotice(t('dev.copied')) }}>{t('dev.copyCode')}</Button>
          </div>
        )}

        {status?.enabled && (
          <div className="space-y-2">
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="mfa-pin-off">{t('mfa.pinLabel')}</Label>
                <Input id="mfa-pin-off" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••••" className="tracking-[0.3em] font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mfa-code-off">{t('mfa.codeLabel')}</Label>
                <Input id="mfa-code-off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12))} placeholder="••••••" className="tracking-[0.2em] font-mono" />
                <p className="text-xs text-stone-400">{t('mfa.disableCodeHint')}</p>
              </div>
            </div>
            <Button size="sm" variant="outline" className="text-red-700 border-red-200 hover:bg-red-50" disabled={busy || pin.length < 4 || code.length < 4} onClick={confirmDisable}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mfa.disable')}
            </Button>
          </div>
        )}

        {notice && <p className="text-xs text-emerald-700">{notice}</p>}
        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-2.5 py-1.5">{error}</p>}
      </CardContent>
    </Card>
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
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setBusy(false) }
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
  /* form sledi zadnjim shranjenim nastavitvam (prej effect — zdaj varovano
     stanje med renderjem, identiteta settings je ključ, enako kot prej) */
  const [prevSettings, setPrevSettings] = useState<SettingsT | null>(settings)
  if (prevSettings !== settings) {
    setPrevSettings(settings)
    setForm(settings)
  }

  /* ISSUE #73 audit-19 (v1.136.0): tveganje TIHE IZGUBE podatkov — en obrazec s
     več razdelki in enim gumbom Shrani na koncu dolge strani (uporabnik spremeni
     razdelek, scrolla, odide → spremembe izginejo brez sledi). Zdaj:
      - neshranjena sprememba je VEDNO vidna (dirtyKeys števec, lepljiva vrstica),
      - jasen izhod: Prekliči (reset na zadnje shranjeno) ali Shrani (nad vrstico),
      - Shrani tudi na koncu vsakega razdelka (akcija blizu spremembe). */
  const dirtyKeys = useMemo(() => {
    if (!form || !settings) return [] as string[]
    return Object.keys(form).filter((k) => {
      const a = (form as unknown as Record<string, unknown>)[k]
      const b = (settings as unknown as Record<string, unknown>)[k]
      return String(a ?? '') !== String(b ?? '')
    })
  }, [form, settings])
  const revert = () => { setForm(settings); setNotice(t('set.reverted')) }

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

  /* audit-19: mini gumb na koncu razdelka — akcija blizu spremembe (isti PUT,
         ki shranjuje celoten form; gumb je kontekstno vezan na razdelek). */
  const sectionSave = (
    <div className="flex justify-end pt-1">
      <Button size="sm" variant="outline" className="h-10 gap-1" disabled={saving || dirtyKeys.length === 0} onClick={save}>
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {t('set.saveSection')}
      </Button>
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><Store className="w-4 h-4" /> {t('set.company')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('common.error')) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}

        {/* ISSUE #73 audit-19: LEPLJIVA vrstica neshranjenih sprememb — vidna na
            vsaki višini scrolla (ne samo na dnu); N šteje spremenjena polja,
            Prekliči obnovi zadnje shranjeno, Shrani potrdi. */}
        {dirtyKeys.length > 0 && (
          <div className="sticky top-20 z-20 -mx-4 sm:-mx-6 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 backdrop-blur" role="status" aria-live="polite">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" aria-hidden />
            <p className="min-w-0 flex-1 text-xs font-bold text-amber-900">{t('set.unsaved', { n: dirtyKeys.length })}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="outline" className="h-9" disabled={saving} onClick={revert}>{t('set.revert')}</Button>
              <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('set.save')}
              </Button>
            </div>
          </div>
        )}

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
        {sectionSave}

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
            <p className="text-xs text-amber-600">{t('set.fursWarning')}</p>
          </div>
          {txt('receiptFooter', t('set.receiptFooter'), t('set.receiptFooterPlaceholder'))}
        </div>
        {sectionSave}

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {txt('defaultVatRate', t('set.vatBasic'), '22')}
          {txt('reducedVatRate', t('set.vatReduced'), '9.5')}
          {txt('currency', t('set.currency'), 'EUR')}
          {txt('locale', t('set.localeLabel'), 'sl-SI')}
        </div>
        {sectionSave}

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
        {sectionSave}

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
                <p className="text-xs text-stone-400">{t('dev.lastSeen', { when: d.lastSeen ? new Date(d.lastSeen).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('dev.never') })}{d.revoked ? t('dev.revoked') : ''}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge className={d.revoked ? 'bg-red-600 text-white' : d.status === 'online' ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{d.revoked ? 'revoked' : d.status}</Badge>
                <div className="flex gap-1">
                  {d.type.toUpperCase() === 'POS' && !d.revoked && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => showPairCode(d)}>{t('dev.cfdCode')}</Button>
                  )}
                  {d.revoked ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => deviceAction(d.id, 'restore')}>{t('dev.restore')}</Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => deviceAction(d.id, 'revoke')}>{t('dev.revoke')}</Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 text-xs text-red-700" disabled={busy} onClick={() => deviceAction(d.id, 'delete')}>{t('common.delete')}</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
