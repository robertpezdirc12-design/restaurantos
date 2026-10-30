'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, CheckCircle2, Building2, Link2, Database } from 'lucide-react'

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
  useEffect(() => { void (async () => { await load() })() }, [])

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
            <div className="flex flex-col gap-2">
              {items.map((m) => (
                <div key={m.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2 flex-wrap min-w-0 [overflow-wrap:anywhere]">
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
  useEffect(() => { void (async () => { await load() })() }, [])
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
                  <Badge variant="outline" className="font-mono text-xs">{o.slug}</Badge>
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
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
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
                <p className="text-xs text-stone-400">{t('ent.slugAuto')}</p>
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
