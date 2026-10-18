'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken, fmtNumSI } from '@/lib/client'
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
import { deliveryOrderIsActive } from '@/lib/delivery-view'


/* ─────────────────────────── BACK-OFFICE (dostava + računovodstvo + napitnine) (AUDIT-FIX val 4) ─────────────────────────── */

/*
 * AUDIT-FIX val 4 (v1.82.4) — tretji val razreza monolita dashboard-tabs.tsx:
 * DeliveryTab (+ AutoAcceptCard) + AccountingExportCard + GlJournalCard +
 * NapitnineTab + delivery tipi (~1016 vrst.), dobesedno prenesene (pure move).
 * Barrel dashboard-tabs.tsx re-exporta javne izvoze — porabniki nespremenjeni
 * (page.tsx uva DeliveryTab/AccountingExportCard/GlJournalCard/NapitnineTab
 * + delivery tipe). AutoAcceptCard ostaja notranji (uporabljen samo v DeliveryTab).
 */

/* ─────────────────────────── DOSTAVA (issue #2 — Glovo/Wolt + domača dostava) ─────────────────────────── */

export interface DeliveryInfoT {
  id: string
  address: string
  city: string
  postCode: string
  recipientName: string
  recipientPhone: string
  instructions: string
  status: string
  deliveryFee: number
  packagingFee: number
  /** OPS-9 val 3 (v1.76.0): provider ETA (DeliveryInfo.estimatedTime) — formatted in the cards */
  estimatedTime: string | null
  courierName: string
  courierPhone: string
  /** OPS-8 val 3 (v1.73.0): driver may be an Employee (id + resolved name) */
  driver: { name: string; phone: string; status: string; employeeId?: string | null; employeeName?: string | null } | null
}
export interface DeliveryOrderT {
  id: string
  orderNumber: number
  type: string
  status: string
  note: string | null
  total: number
  paymentStatus: string
  createdAt: string
  fursEor: string | null
  items: { id: string; name: string; qty: number }[]
  delivery: DeliveryInfoT | null
}
export interface DeliveryZoneT {
  id: string
  name: string
  deliveryFee: number
  minOrderAmount: number
  estimatedMinutes: number
  isActive: boolean
}
export interface PlatformIntegrationT {
  id: string
  name: string
  provider: string
  isActive: boolean
  connectionStatus: string
  logs: { id: string; action: string; status: string; statusCode: number; errorMessage: string | null; createdAt: string }[]
}

const DELIVERY_STATUS_KEYS: Record<string, string> = {
  PENDING: 'dost.status.PENDING', CONFIRMED: 'dost.status.CONFIRMED', ASSIGNED: 'dost.status.ASSIGNED', PICKED_UP: 'dost.status.PICKED_UP',
  ON_THE_WAY: 'dost.status.ON_THE_WAY', DELIVERED: 'dost.status.DELIVERED', CANCELLED: 'dost.status.CANCELLED',
}
const DELIVERY_STATUS_BG: Record<string, string> = {
  PENDING: 'bg-amber-500 text-white', CONFIRMED: 'bg-emerald-600 text-white', ASSIGNED: 'bg-teal-600 text-white',
  PICKED_UP: 'bg-cyan-600 text-white', ON_THE_WAY: 'bg-sky-600 text-white',
  DELIVERED: 'bg-stone-500 text-white', CANCELLED: 'bg-red-600 text-white',
}
/** Naslednja tranzicija po toku (enako kot TRANSITIONS na backendu) */
const NEXT_STATUS: Record<string, { to: string; label: string } | null> = {
  PENDING: { to: 'CONFIRMED', label: 'common.confirm' },
  CONFIRMED: { to: 'ASSIGNED', label: 'dost.assignDriver' },
  ASSIGNED: { to: 'PICKED_UP', label: 'dost.pickedUpBtn' },
  PICKED_UP: { to: 'ON_THE_WAY', label: 'dost.status.ON_THE_WAY' },
  ON_THE_WAY: { to: 'DELIVERED', label: 'dost.status.DELIVERED' },
  DELIVERED: null, CANCELLED: null,
}
const platformOf = (note: string | null): 'GLOVO' | 'WOLT' | 'DOMAČA' =>
  note?.includes('Glovo') ? 'GLOVO' : note?.includes('Wolt') ? 'WOLT' : 'DOMAČA'

/** Issue #70 §3: status NAROČILA (dostava brez DeliveryInfo) → i18n ključ. */
const ORDER_STATUS_KEYS: Record<string, string> = {
  OPEN: 'status.OPEN', SENT: 'status.SENT', PREPARED: 'status.PREPARED', PAID: 'status.PAID', CANCELLED: 'status.CANCELLED',
}
const statusKey = (s: string): string => ORDER_STATUS_KEYS[s] ?? 'status.OPEN'
/** Issue #70 §3: barvne razredice statusa naročila (usklajeno s statusColors na dashboardu). */
const statusBadgeBg: Record<string, string> = {
  OPEN: 'bg-amber-600 text-white', SENT: 'bg-orange-600 text-white', PREPARED: 'bg-emerald-600 text-white',
  PAID: 'bg-stone-500 text-white', CANCELLED: 'bg-red-600 text-white',
}

/** OPS-9 val 3: provider ETA → "HH:MM" (null-safe; only rendered when the field is set). */
const fmtEta = (iso: string): string => new Date(iso).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })

export function DeliveryTab({ orders, zones, platformIntegrations, onReload }: {
  orders: DeliveryOrderT[]
  zones: DeliveryZoneT[]
  platformIntegrations: PlatformIntegrationT[]
  onReload: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [driverFor, setDriverFor] = useState<DeliveryOrderT | null>(null)
  // OPS-8 val 3 (v1.73.0): driver as Employee — 'MANUAL' sentinel keeps the free-text fallback
  const [driver, setDriver] = useState({ name: '', phone: '', employeeId: 'MANUAL' })
  const [drivers, setDrivers] = useState<{ id: string; name: string }[]>([])
  const [addZone, setAddZone] = useState(false)
  const [nz, setNz] = useState({ name: '', deliveryFee: '2.50', minOrderAmount: '10', estimatedMinutes: '30' })

  // OPS-8 val 3 (v1.73.0): load active employees for the driver dropdown (fail-soft —
  // without employees.manage permission the free-text input stays available)
  useEffect(() => {
    api<{ employees: { id: string; name: string; active: boolean }[] }>('/api/employees')
      .then((d) => {
        const list = (d.employees || []).filter((e) => e.active).map((e) => ({ id: e.id, name: e.name }))
        setDrivers(list)
      })
      .catch(() => null)
  }, [])

  // Issue #70 §3 (P1, v1.121.0): sekcija dost.history je semantično SKLADNA — v zgodovino
  // gredo SAMO terminalni zapisi (naročilo PLAČANO/PREKLICANO ali dostava DOSTAVLJENA/
  // PREKLICANA). Dostavna naročila BREZ DeliveryInfo (zastareli demo zapisi, status OPEN)
  // — prej so padla v zgodovino in pokazala oznako OPEN — so AKTIVNA (niso zaključena)
  // in dobijo svojo kartico z opombo "brez dostavnih podatkov" (brez prehodov — rut
  // /api/delivery PATCH za te zapise vrne 404). Preskočitev je izločena v čisto funkcijo
  // src/lib/delivery-view.ts (enotsko testirana, client-safe).
  const active = orders.filter(deliveryOrderIsActive)
  const history = orders.filter((o) => !active.includes(o))

  async function transition(o: DeliveryOrderT, to: string, extra?: { driverName?: string; driverPhone?: string; note?: string }) {
    setBusy(o.id)
    try {
      await api('/api/delivery', {
        method: 'PATCH',
        body: JSON.stringify({ orderId: o.id, status: to, ...extra }),
      })
      await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setBusy(null) }
  }

  async function createZone() {
    setBusy('zone')
    try {
      await api('/api/delivery/zones', {
        method: 'POST',
        body: JSON.stringify({
          name: nz.name, deliveryFee: Number(nz.deliveryFee), minOrderAmount: Number(nz.minOrderAmount),
          estimatedMinutes: Number(nz.estimatedMinutes),
        }),
      })
      setAddZone(false); setNz({ name: '', deliveryFee: '2.50', minOrderAmount: '10', estimatedMinutes: '30' })
      await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setBusy(null) }
  }

  async function toggleZone(z: DeliveryZoneT) {
    setBusy(z.id)
    try {
      await api('/api/delivery/zones', { method: 'PATCH', body: JSON.stringify({ id: z.id, isActive: !z.isActive }) })
      await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setBusy(null) }
  }

  return (
    <div className="space-y-6">
      {/* Aktivna dostavna naročila */}
      <div>
        <h3 className="text-sm font-semibold text-stone-500 mb-2 flex items-center gap-1.5"><Truck className="w-4 h-4" /> {t('dost.active', { n: active.length })}</h3>
        {active.length === 0 && (
          <Card><CardContent className="p-6 text-center text-sm text-stone-500">{t('dost.activeNone')}</CardContent></Card>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {active.map((o) => {
            const d = o.delivery
            // Issue #70 §3: dostavno naročilo BREZ DeliveryInfo (zastareli demo zapis) —
            // kompaktna kartica z opombo, BREZ prehodov (/api/delivery PATCH → 404) in
            // z oznako statusa NAROČILA (OPEN — pošteno: naročilo ni zaključeno).
            if (!d) {
              return (
                <Card key={o.id} className="border-dashed border-stone-300 bg-stone-50">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">#{o.orderNumber} <Badge variant="outline" className="ml-1">{platformOf(o.note)}</Badge></CardTitle>
                      <Badge className={statusBadgeBg[o.status] || 'bg-amber-600 text-white'}>{t(statusKey(o.status))}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-stone-500">{t('dost.itemsCount', { n: o.items.length })} · <span className="font-semibold text-stone-900">{fmtEUR(o.total)}</span></p>
                    <p className="rounded-sm border border-stone-300 bg-stone-100 px-2 py-1 text-xs text-stone-600">{t('dost.noInfo')}</p>
                  </CardContent>
                </Card>
              )
            }
            const plat = platformOf(o.note)
            const next = NEXT_STATUS[d.status]
            return (
              <Card key={o.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">#{o.orderNumber} <Badge variant="outline" className="ml-1">{plat}</Badge></CardTitle>
                    <Badge className={DELIVERY_STATUS_BG[d.status] || 'bg-stone-400 text-white'}>{DELIVERY_STATUS_KEYS[d.status] ? t(DELIVERY_STATUS_KEYS[d.status]) : d.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm"><span className="text-stone-500">{t('dost.recipient')}</span> {d.recipientName || '—'} {d.recipientPhone && <span className="text-stone-500">· {d.recipientPhone}</span>}</p>
                  <p className="text-sm"><span className="text-stone-500">{t('dost.address')}</span> {[d.address, d.postCode, d.city].filter(Boolean).join(', ') || '—'}</p>
                  {d.instructions && <p className="text-xs text-amber-700">{t('dost.note', { note: d.instructions })}</p>}
                  <p className="text-xs text-stone-500">{t('dost.itemsCount', { n: o.items.length })} · <span className="font-semibold text-stone-900">{fmtEUR(o.total)}</span> ({t('dost.deliveryFeeShort', { fee: fmtEUR(d.deliveryFee) })})</p>
                  {/* OPS-9 val 3: provider ETA — shown while the delivery is not yet completed */}
                  {d.estimatedTime && !['DELIVERED', 'CANCELLED'].includes(d.status) && (
                    <p className="text-xs font-medium text-stone-700">🚚 {t('dost.eta', { time: fmtEta(d.estimatedTime) })}</p>
                  )}
                  {o.status === 'PAID' && <Badge className="bg-emerald-600 text-white">{t('status.PAID')}</Badge>}
                  {o.fursEor && <p className="text-xs text-stone-400">FURS EOR: {o.fursEor}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {next && next.to !== 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => transition(o, next.to)} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t(next.label)}</Button>
                    )}
                    {next && next.to === 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => { setDriverFor(o); setDriver({ name: d.courierName || d.driver?.name || '', phone: d.courierPhone || d.driver?.phone || '', employeeId: d.driver?.employeeId || 'MANUAL' }) }} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t('dost.assignDriver')}</Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy === o.id} onClick={() => { if (confirm(t('dost.cancelConfirm', { n: o.orderNumber }))) transition(o, 'CANCELLED', { note: t('dost.cancelNote') }) }} className="border-red-300 text-red-700 hover:bg-red-50">{t('common.cancel')}</Button>
                  </div>
                  {d.driver?.name && <p className="text-xs text-stone-500">{t('dost.driver', { name: d.driver.name })} {d.driver.phone && `· ${d.driver.phone}`}</p>}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Zgodovina */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('dost.history')}</CardTitle></CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72">
              <div className="space-y-1.5 pr-3">
                {history.slice(0, 30).map((o) => {
                  const d = o.delivery
                  return (
                    <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm min-w-0 truncate">#{o.orderNumber} · {d?.recipientName || '—'} · {fmtEUR(o.total)}</p>
                        {/* Issue #70 §3: oznaka zgodovine je VEDNO terminalna — naročilo
                            PLAČANO/PREKLICANO pokaže status NAROČILA, sicer status dostave
                            (DOSTAVLJENA/PREKLICANA); surov niz "OPEN" ne more več padla v
                            "zaključenih" zapiseh */}
                        <Badge className={['PAID', 'CANCELLED'].includes(o.status) ? (statusBadgeBg[o.status] || 'bg-stone-400 text-white') : (DELIVERY_STATUS_BG[d?.status || ''] || 'bg-stone-400 text-white')}>
                          {['PAID', 'CANCELLED'].includes(o.status) ? t(statusKey(o.status)) : (d?.status && DELIVERY_STATUS_KEYS[d.status] ? t(DELIVERY_STATUS_KEYS[d.status]) : t(statusKey(o.status)))}
                        </Badge>
                      </div>
                      {(d?.driver?.name || d?.driver?.employeeName) && (
                        <p className="text-xs text-stone-400 mt-0.5 truncate">{t('dost.driver', { name: d.driver.employeeName || d.driver.name })}</p>
                      )}
                      {/* OPS-9 val 3: ETA also in the history list (delivered orders) */}
                      {d?.estimatedTime && (
                        <p className="text-xs text-stone-400 mt-0.5">{t('dost.eta', { time: fmtEta(d.estimatedTime) })}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* OPS-9 val 3 (v1.76.0) — Samodejna potrditev (auto-accept) prek webhookov */}
        <AutoAcceptCard />
        {/* Cone */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-1.5"><Plus className="w-4 h-4" /> {t('dost.zones')}</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setAddZone(true)}>{t('dost.newZone')}</Button>
          </CardHeader>
          <CardContent>
            {zones.length === 0 && <p className="text-sm text-stone-500">{t('dost.noZones')}</p>}
            <div className="space-y-1.5">
              {zones.map((z) => (
                <div key={z.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{z.name}</p>
                    <p className="text-xs text-stone-500">{t('dost.zoneMeta', { fee: fmtEUR(z.deliveryFee), min: fmtEUR(z.minOrderAmount), mins: z.estimatedMinutes })}</p>
                  </div>
                  <Switch checked={z.isActive} disabled={busy === z.id} onCheckedChange={() => toggleZone(z)} aria-label={t('dost.zoneActiveAria', { name: z.name })} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Platforme + napake webhookov */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><ShieldAlert className="w-4 h-4" /> {t('dost.platforms')}</CardTitle></CardHeader>
          <CardContent>
            {platformIntegrations.length === 0 && (
              <p className="text-sm text-stone-500">
                {t('dost.noIntegrationA')} <code className="text-xs bg-stone-100 px-1 rounded-sm">glovo</code>{t('dost.or')} <code className="text-xs bg-stone-100 px-1 rounded-sm ml-1">wolt</code> {t('dost.noIntegrationB')} <code className="text-xs bg-stone-100 px-1 rounded-sm">/api/delivery/webhook/glovo</code>, <code className="text-xs bg-stone-100 px-1 rounded-sm">/api/delivery/webhook/wolt</code>.
              </p>
            )}
            <div className="space-y-2">
              {platformIntegrations.map((p) => {
                const errors = p.logs.filter((l) => l.status !== 'success')
                return (
                  <div key={p.id} className="rounded-lg border border-stone-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium capitalize">{p.provider}</p>
                      <Badge className={p.isActive ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{p.isActive ? p.connectionStatus || t('dost.activeF') : t('dost.inactiveF')}</Badge>
                    </div>
                    {errors.length === 0
                      ? <p className="text-xs text-stone-400 mt-1">{t('dost.noErrors')}</p>
                      : (
                        <div className="mt-1.5 space-y-1">
                          {errors.slice(0, 5).map((l) => (
                            <p key={l.id} className="text-xs text-red-700 bg-red-50 rounded-sm px-2 py-1 truncate">
                              {l.statusCode} · {l.action}: {l.errorMessage || t('dost.error')}
                            </p>
                          ))}
                        </div>
                      )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dodelitev voznika */}
      <Dialog open={!!driverFor} onOpenChange={(v) => !v && setDriverFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('dost.assignDriverTitle', { n: driverFor?.orderNumber ?? '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {/* OPS-8 val 3 (v1.73.0): driver dropdown from Employees; free-text fallback */}
            {drivers.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="drv-employee">{t('dost.driverEmployee')}</Label>
                <Select value={driver.employeeId || 'MANUAL'} onValueChange={(v) => setDriver({ ...driver, employeeId: v, name: v === 'MANUAL' ? '' : drivers.find((x) => x.id === v)?.name || '' })}>
                  <SelectTrigger id="drv-employee" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64 overflow-y-auto">
                    <SelectItem value="MANUAL">{t('dost.driverManual')}</SelectItem>
                    {drivers.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {(driver.employeeId === 'MANUAL' || drivers.length === 0) && (
              <div><Label htmlFor="drv-name">{t('dost.driverName')}</Label><Input id="drv-name" value={driver.name} onChange={(e) => setDriver({ ...driver, name: e.target.value })} placeholder={t('dost.driverPlaceholder')} /></div>
            )}
            {driver.employeeId !== 'MANUAL' && drivers.length > 0 && (
              <p className="text-sm text-stone-600"><span className="text-stone-500">{t('dost.driverName')}:</span> {driver.name}</p>
            )}
            <div><Label htmlFor="drv-phone">{t('inv.phone')}</Label><Input id="drv-phone" value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} placeholder={t('dost.phonePlaceholder')} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDriverFor(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy !== null || (driver.employeeId === 'MANUAL' && !driver.name.trim())}
              onClick={async () => {
                if (!driverFor) return
                setBusy(driverFor.id)
                try {
                  const byEmployee = driver.employeeId !== 'MANUAL' && drivers.length > 0
                  await api('/api/delivery', { method: 'PATCH', body: JSON.stringify({
                    orderId: driverFor.id,
                    status: 'ASSIGNED',
                    ...(byEmployee ? { driverEmployeeId: driver.employeeId } : { driverName: driver.name }),
                    driverPhone: driver.phone,
                  }) })
                  setDriverFor(null); await onReload()
                } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setBusy(null) }
              }}>{t('dost.assign')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova cona */}
      <Dialog open={addZone} onOpenChange={setAddZone}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('dost.newZoneTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="z-name">{t('dost.zoneName')}</Label><Input id="z-name" value={nz.name} onChange={(e) => setNz({ ...nz, name: e.target.value })} placeholder={t('dost.zonePlaceholder')} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label htmlFor="z-fee">{t('dost.fee')}</Label><Input id="z-fee" type="number" step="0.01" value={nz.deliveryFee} onChange={(e) => setNz({ ...nz, deliveryFee: e.target.value })} /></div>
              <div><Label htmlFor="z-min">{t('dost.minOrder')}</Label><Input id="z-min" type="number" step="0.01" value={nz.minOrderAmount} onChange={(e) => setNz({ ...nz, minOrderAmount: e.target.value })} /></div>
              <div><Label htmlFor="z-mins">{t('dost.time')}</Label><Input id="z-mins" type="number" value={nz.estimatedMinutes} onChange={(e) => setNz({ ...nz, estimatedMinutes: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddZone(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy === 'zone' || !nz.name.trim()} onClick={createZone}>{t('inv.add')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── OPS-9 val 3 — AUTO-ACCEPT KARTICA ─────────────────────────── */

/**
 * OPS-9 val 3 (v1.76.0) — Auto-accept card (Dostava tab): Switch + provider chips.
 * Config lives in Integration 'delivery-auto-accept' (type='other') via
 * GET/PUT /api/delivery/auto-accept (delivery.manage). When enabled for a provider,
 * platform webhook orders arrive directly as 'confirmed' (audited DELIVERY_AUTO_ACCEPT);
 * when disabled they stay 'pending' for manual confirmation.
 */
function AutoAcceptCard() {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(true)
  const [providers, setProviders] = useState<string[]>(['glovo', 'wolt'])
  const [options, setOptions] = useState<string[]>(['glovo', 'wolt'])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    api<{ enabled: boolean; providers: string[]; providerOptions: string[] }>('/api/delivery/auto-accept')
      .then((d) => {
        if (!alive) return
        setEnabled(d.enabled)
        setProviders(d.providers || [])
        setOptions(d.providerOptions || ['glovo', 'wolt'])
      })
      .catch(() => { if (alive) setNotice(t('notif.loadError')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const save = async (nextEnabled: boolean, nextProviders: string[]) => {
    setBusy(true); setNotice('')
    try {
      const res = await api<{ enabled: boolean; providers: string[] }>('/api/delivery/auto-accept', {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextEnabled, providers: nextProviders }),
      })
      setEnabled(res.enabled); setProviders(res.providers)
      setNotice(t('notif.saved'))
    } catch (e) {
      setNotice(`${t('notif.error')} ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const toggleProvider = (p: string) => {
    const next = providers.includes(p) ? providers.filter((x) => x !== p) : [...providers, p]
    setProviders(next)
    void save(enabled, next)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><Zap className="w-4 h-4" /> {t('dost.autoAccept.title')}</CardTitle>
        <CardDescription>{t('dost.autoAccept.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('notif.loading')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="auto-accept-switch" className="text-sm">{t('dost.autoAccept.enable')}</Label>
              <Switch
                id="auto-accept-switch"
                checked={enabled}
                disabled={busy}
                onCheckedChange={(v) => { setEnabled(v); void save(v, providers) }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {options.map((p) => {
                const on = providers.includes(p)
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={busy || !enabled}
                    aria-pressed={on}
                    className={`min-h-11 rounded-full border px-4 text-sm font-medium capitalize transition-colors disabled:opacity-40 ${on ? 'border-emerald-700 bg-emerald-50 text-emerald-800' : 'border-stone-200 bg-white text-stone-500 hover:border-stone-300'}`}
                    onClick={() => toggleProvider(p)}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-stone-500">{t('dost.autoAccept.hint')}</p>
          </>
        )}
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('notif.error')) || notice === t('notif.loadError') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}
      </CardContent>
    </Card>
  )
}

/** X/Z report helpers (OPS-8 val 3) — kept below for module cohesion. */

/* ─────────────────────────── RAČUNOVODSKI IZVOZ ─────────────────────────── */

/** OPS-8 val 3 (v1.73.0) — X/Z preview payload (GET /api/reports/export?section=zz&format=json) */
interface XzPreviewT {
  section: 'zz'
  generatedAt: string
  from: string
  to: string
  grossSales: number
  netSales: number
  vatTotal: number
  vatByRate: { rate: number; base: number; amount: number }[]
  paymentsByMethod: { method: string; amount: number }[]
  discountsTotal: number
  tipsTotal: number
  voidedCount: number
  voidedTotal: number
  wasteTotal: number
  covers: number
  avgCheck: number
  avgPartySize: number
  comparison: { prevFrom: string; prevTo: string; prevNetSales: number; prevCovers: number; deltaNetPct: number | null; deltaCoversPct: number | null }
}

export function AccountingExportCard() {
  const { t } = useI18n()
  const firstOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) })()
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null)
  const [err, setErr] = useState('')
  // OPS-7 (v1.70.0): sekcija izvoza — summary | dnevnik prodaje | DDV povzetek
  // OPS-8 val 3 (v1.73.0): + 'zz' (X/Z poslovno poročilo s predogledom)
  const [section, setSection] = useState<'summary' | 'dnevnik' | 'ddv' | 'zz'>('summary')
  const [xzPreview, setXzPreview] = useState<XzPreviewT | null>(null)
  const [xzBusy, setXzBusy] = useState(false)
  const [xzErr, setXzErr] = useState('')

  async function download(fmt: 'csv' | 'json') {
    setBusy(fmt); setErr('')
    try {
      const token = getToken()
      const res = await fetch(`/api/reports/export?from=${from}&to=${to}&format=${fmt}&section=${section}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((data as { error?: string })?.error || t('acct.exportFailed'))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const nameBySection = section === 'summary' ? 'izvoz' : section === 'dnevnik' ? 'dnevnik-prodaje' : section === 'ddv' ? 'ddv-povzetek' : 'xz-porocilo'
      a.download = `${nameBySection}-${from}_${to}.${fmt}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** OPS-8 val 3 (v1.73.0): X/Z preview dialog (JSON, no download). */
  async function loadXzPreview() {
    setXzBusy(true); setXzErr('')
    try {
      const token = getToken()
      const res = await fetch(`/api/reports/export?from=${from}&to=${to}&format=json&section=zz`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((data as { error?: string })?.error || t('acct.xzLoadFailed'))
      }
      setXzPreview((await res.json()) as XzPreviewT)
    } catch (e) {
      setXzErr((e as Error).message)
    } finally {
      setXzBusy(false)
    }
  }

  const Row = ({ label, value, sub }: { label: string; value: string; sub?: boolean }) => (
    <div className={`flex items-center justify-between gap-3 ${sub ? 'pl-3' : ''}`}>
      <span className={sub ? 'text-xs text-stone-500' : 'text-stone-600'}>{label}</span>
      <span className={sub ? 'text-xs font-medium text-stone-700' : 'font-semibold text-stone-900'}>{value}</span>
    </div>
  )
  const DeltaRow = ({ label, pct }: { label: string; pct: number | null }) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-stone-600">{label}</span>
      {pct === null ? (
        <span className="text-xs text-stone-400">{t('acct.xzNoPrev')}</span>
      ) : (
        <span className={`font-semibold ${pct > 0 ? 'text-emerald-600' : pct < 0 ? 'text-rose-600' : 'text-stone-500'}`}>
          {deltaArrow(pct)} {pct > 0 ? '+' : ''}{pct.toLocaleString('sl-SI')}%
        </span>
      )}
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="w-4 h-4" /> {t('acct.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">
          {t('acct.desc')}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('acc.section')}</Label>
            <Select value={section} onValueChange={(v) => setSection(v as 'summary' | 'dnevnik' | 'ddv' | 'zz')}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="summary">{t('acc.summary')}</SelectItem>
                <SelectItem value="dnevnik">{t('acc.dnevnik')}</SelectItem>
                <SelectItem value="ddv">{t('acc.vat')}</SelectItem>
                <SelectItem value="zz">{t('acc.xz')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="exp-from" className="text-xs">{t('acct.from')}</Label>
            <Input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exp-to" className="text-xs">{t('acct.to')}</Label>
            <Input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white min-h-10 gap-1.5" disabled={busy !== null || !from || !to} onClick={() => download('csv')}>
            {busy === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} {t('acct.exportCsv')}
          </Button>
          <Button size="sm" variant="outline" className="min-h-10 gap-1.5" disabled={busy !== null || !from || !to} onClick={() => download('json')}>
            {busy === 'json' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} {t('acct.exportJson')}
          </Button>
          {section === 'zz' && (
            <Button size="sm" variant="outline" className="min-h-10 gap-1.5" disabled={xzBusy || !from || !to} onClick={() => void loadXzPreview()}>
              {xzBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} {t('acct.preview')}
            </Button>
          )}
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {xzErr && <p className="text-sm text-red-600">{xzErr}</p>}
      </CardContent>

      {/* OPS-8 val 3 (v1.73.0): X/Z poslovno poročilo — predogled (Lightspeed Business Report) */}
      <Dialog open={!!xzPreview} onOpenChange={(v) => !v && setXzPreview(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('acct.xzTitle')}</DialogTitle></DialogHeader>
          {xzPreview && (
            <div className="space-y-3 text-sm max-h-[60vh] overflow-y-auto pr-1">
              <p className="text-xs text-stone-500">{xzPreview.from} – {xzPreview.to}</p>
              <div className="space-y-1">
                <Row label={t('acct.xzGross')} value={fmtEUR(xzPreview.grossSales)} />
                <Row label={t('acct.xzNet')} value={fmtEUR(xzPreview.netSales)} />
                <Row label={t('acct.xzVatTotal')} value={fmtEUR(xzPreview.vatTotal)} />
                {xzPreview.vatByRate.map((v) => (
                  <Row key={v.rate} sub label={`${t('acct.xzVatRate')} ${fmtNumSI(v.rate, { max: 1 })} %`} value={fmtEUR(v.amount)} />
                ))}
                <Row label={t('acct.xzDiscounts')} value={fmtEUR(xzPreview.discountsTotal)} />
                <Row label={t('acct.xzTips')} value={fmtEUR(xzPreview.tipsTotal)} />
                <Row label={t('acct.xzVoided')} value={String(xzPreview.voidedCount)} />
                <Row label={t('acct.xzVoidedTotal')} value={fmtEUR(xzPreview.voidedTotal)} />
                <Row label={t('acct.xzWaste')} value={fmtEUR(xzPreview.wasteTotal)} />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t('acct.xzPayments')}</p>
                {xzPreview.paymentsByMethod.length === 0 ? (
                  <p className="text-xs text-stone-400">{t('common.none')}</p>
                ) : (
                  xzPreview.paymentsByMethod.map((p) => <Row key={p.method} sub label={p.method} value={fmtEUR(p.amount)} />)
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t('acct.xzGuests')}</p>
                <Row label={t('acct.xzCovers')} value={String(xzPreview.covers)} />
                <Row label={t('acct.xzAvgCheck')} value={fmtEUR(xzPreview.avgCheck)} />
                <Row label={t('acct.xzAvgParty')} value={xzPreview.avgPartySize.toLocaleString('sl-SI', { minimumFractionDigits: 2 })} />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                  {t('acct.xzCompare')} ({xzPreview.comparison.prevFrom} – {xzPreview.comparison.prevTo})
                </p>
                <Row label={t('acct.xzPrevNet')} value={fmtEUR(xzPreview.comparison.prevNetSales)} />
                <DeltaRow label={t('acct.xzDeltaNet')} pct={xzPreview.comparison.deltaNetPct} />
                <Row label={t('acct.xzPrevCovers')} value={String(xzPreview.comparison.prevCovers)} />
                <DeltaRow label={t('acct.xzDeltaCovers')} pct={xzPreview.comparison.deltaCoversPct} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setXzPreview(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ────────────────────── GL DNEVNIK (orientacijsko, OPS-8 val 3 v1.73.0) ────────────────────── */

/** GL journal API shapes (GET /api/reports/gl) */
interface GlLineT { accountCode: string; accountName: string; debit: number; credit: number }
interface GlEntryT { date: string; entryNo: string; memo: string; persisted: boolean; adjustedAccount: string | null; lines: GlLineT[]; debit: number; credit: number }
interface GlDataT { from: string; to: string; persisted: boolean; entries: GlEntryT[]; totals: { debits: number; credits: number } }

export function GlJournalCard() {
  const { t } = useI18n()
  const firstOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) })()
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [data, setData] = useState<GlDataT | null>(null)

  async function load() {
    setBusy(true); setErr('')
    try {
      const d = await api<GlDataT>(`/api/reports/gl?from=${from}&to=${to}`)
      setData(d)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Database className="w-4 h-4" /> {t('gl.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">{t('gl.note')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="gl-from" className="text-xs">{t('acct.from')}</Label>
            <Input id="gl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gl-to" className="text-xs">{t('acct.to')}</Label>
            <Input id="gl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white min-h-10 gap-1.5" disabled={busy || !from || !to} onClick={() => void load()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} {t('gl.view')}
          </Button>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {data && (
          <div className="space-y-2">
            {!data.persisted && <p className="text-xs text-amber-700">{t('gl.previewOnly')}</p>}
            {data.entries.length === 0 && <p className="text-sm text-stone-500">{t('gl.empty')}</p>}
            <ScrollArea className="max-h-96">
              <div className="space-y-2 pr-3">
                {data.entries.map((e) => (
                  <div key={e.entryNo} className="rounded-lg border border-stone-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="font-medium text-sm">{e.date} · {e.entryNo}</p>
                      {!e.persisted && (
                        <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">{t('gl.previewBadge')}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-stone-500 mb-2">{e.memo}</p>
                    <div className="space-y-0.5">
                      <div className="grid grid-cols-[1fr_5rem_5rem] gap-2 text-xs uppercase tracking-wide text-stone-400 font-medium">
                        <span>{t('gl.account')}</span>
                        <span className="text-right">{t('gl.debit')}</span>
                        <span className="text-right">{t('gl.credit')}</span>
                      </div>
                      {e.lines.map((l) => (
                        <div key={`${e.entryNo}-${l.accountCode}`} className="grid grid-cols-[1fr_5rem_5rem] gap-2 text-sm">
                          <span className="text-stone-700 min-w-0 truncate">{l.accountCode} · {l.accountName}</span>
                          <span className="text-right font-mono text-xs text-stone-700">{l.debit ? fmtEUR(l.debit) : '—'}</span>
                          <span className="text-right font-mono text-xs text-stone-700">{l.credit ? fmtEUR(l.credit) : '—'}</span>
                        </div>
                      ))}
                      <div className="grid grid-cols-[1fr_5rem_5rem] gap-2 text-xs border-t border-stone-200 pt-1 mt-1">
                        <span className="text-stone-500">{t('gl.totals')}</span>
                        <span className="text-right font-mono font-semibold text-stone-900">{fmtEUR(e.debit)}</span>
                        <span className="text-right font-mono font-semibold text-stone-900">{fmtEUR(e.credit)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
            {data.entries.length > 0 && (
              <p className="text-xs text-stone-500">
                {t('gl.totalsDebit')}: {fmtEUR(data.totals.debits)} · {t('gl.totalsCredit')}: {fmtEUR(data.totals.credits)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── NAPITNINE (issue #1, triage ①) ─────────────────────────── */

interface TipPreviewT {
  date: string
  locationId: string
  method: string
  fallbackEqual: boolean
  totals: { totalCents: number; cashCents: number; nonCashCents: number; payments: number }
  employees: { employeeId: string; employeeName: string; minutes: number; points: number; previewCents: number }[]
  pool: {
    id: string
    date: string
    totalTips: number
    cashTips: number
    cardTips: number
    distributionMethod: string
    status: string
    TipDistribution: { id: string; employeeName: string; hoursWorked: number; points: number; amount: number; status: string; paidAt: string | null }[]
  } | null
  history: { id: string; date: string; totalTips: number; distributionMethod: string; status: string; employees: number; paid: number }[]
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`)

export function NapitnineTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useI18n()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [locId, setLocId] = useState('')
  const [method, setMethod] = useState<'hours' | 'equal' | 'points'>('hours')
  const [data, setData] = useState<TipPreviewT | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const id = locId || locations[0]?.id || ''
    if (!id) return
    let alive = true
    ;(async () => {
      setBusy(true)
      setErr('')
      try {
        const d = await api<TipPreviewT>(`/api/tips?date=${date}&locationId=${id}&method=${method}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [date, locId, method, locations.length])

  const closeDay = async () => {
    setBusy(true)
    setErr('')
    try {
      await api('/api/tips', { method: 'POST', body: JSON.stringify({ date, locationId: locId || locations[0]?.id, method }) })
      await new Promise((r) => setTimeout(r, 150)) // oddih pred osvežitvijo
      setData(await api<TipPreviewT>(`/api/tips?date=${date}&locationId=${locId || locations[0]?.id}&method=${method}`))
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const payout = async (distributionId?: string) => {
    if (!data?.pool) return
    setBusy(true)
    setErr('')
    try {
      await api('/api/tips/payout', { method: 'POST', body: JSON.stringify({ poolId: data.pool.id, distributionId }) })
      setData(await api<TipPreviewT>(`/api/tips?date=${date}&locationId=${locId || locations[0]?.id}&method=${method}`))
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  const tot = data?.totals
  const pool = data?.pool ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5"><HeartHandshake className="w-4 h-4" /> {t('tips.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-stone-500">{t('tips.desc')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('tips.day')}</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('dev.location')}</Label>
              <Select value={locId || undefined} onValueChange={setLocId}>
                <SelectTrigger><SelectValue placeholder={locations[0]?.name || '—'} /></SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('tips.basis')}</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as 'hours' | 'equal' | 'points')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">{t('tips.basisHours')}</SelectItem>
                  <SelectItem value="equal">{t('tips.basisEqual')}</SelectItem>
                  <SelectItem value="points">{t('tips.basisPoints')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {tot && (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">{t('tips.collected')}</p>
                <p className="text-lg font-bold">{fmtEUR(tot.totalCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">{t('tips.cash')}</p>
                <p className="text-lg font-semibold">{fmtEUR(tot.cashCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">{t('tips.cardOther')}</p>
                <p className="text-lg font-semibold">{fmtEUR(tot.nonCashCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">{t('tips.paymentsWithTip')}</p>
                <p className="text-lg font-semibold">{tot.payments}</p>
              </div>
            </div>
          )}
          {data?.fallbackEqual && (
            <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {t('tips.noHoursFallback')}</p>
          )}
        </CardContent>
      </Card>

      {pool ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
              {t('tips.distribution')} — {pool.distributionMethod === 'hours' ? t('tips.mHours') : pool.distributionMethod === 'points' ? t('tips.mPoints') : t('tips.mEqual')}
              <Badge variant={pool.status === 'paid' ? 'default' : 'outline'} className={pool.status === 'paid' ? 'bg-emerald-700' : ''}>
                {pool.status === 'paid' ? t('tips.paid') : t('tips.awaitingPayout')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">{t('shifts.csvEmployee')}</th>
                    <th className="p-2">{t('tips.basisShort')}</th>
                    <th className="p-2 text-right">{t('tips.amount')}</th>
                    <th className="p-2">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="p-2 text-right">{t('tips.payoutCol')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {pool.TipDistribution.map((d) => (
                    <tr key={d.id} className="border-t border-stone-100">
                      <td className="p-2 font-medium">{d.employeeName}</td>
                      <td className="p-2 text-stone-600">
                        {pool.distributionMethod === 'hours' && d.hoursWorked > 0 ? `${d.hoursWorked.toFixed(2)} h` : pool.distributionMethod === 'points' && d.points > 0 ? t('payment.pointsOf', { n: d.points }) : t('tips.equalShort')}
                      </td>
                      <td className="p-2 text-right font-semibold">{fmtEUR(d.amount)}</td>
                      <td className="p-2">
                        {d.status === 'paid'
                          ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">{t('tips.paid')} {d.paidAt ? new Date(d.paidAt).toLocaleString('sl-SI') : ''}</Badge>
                          : <Badge variant="outline">{t('tips.pending')}</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          {d.status === 'pending' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => payout(d.id)}>{t('tips.markPaid')}</Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManage && pool.status !== 'paid' && (
              <div className="flex justify-end">
                <Button disabled={busy} onClick={() => payout()} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t('tips.payAllPending', { n: pool.TipDistribution.filter((d) => d.status === 'pending').length })}</Button>
              </div>
            )}
            <p className="text-xs text-stone-400">{t('tips.hashNote')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('tips.previewFor', { date })}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {data && data.employees.length > 0 ? (
              <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">{t('shifts.csvEmployee')}</th>
                      <th className="p-2">{t('tips.hoursToday')}</th>
                      <th className="p-2 text-right">{t('tips.expectedShare')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.employees.map((e) => (
                      <tr key={e.employeeId} className="border-t border-stone-100">
                        <td className="p-2 font-medium">{e.employeeName}</td>
                        <td className="p-2 text-stone-600">{e.minutes > 0 ? fmtMin(e.minutes) : '—'}</td>
                        <td className="p-2 text-right font-semibold">{fmtEUR(e.previewCents / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-stone-500">{t('tips.emptyDay')}</p>
            )}
            {canManage && tot && tot.totalCents > 0 && data && data.employees.length > 0 && (
              <div className="flex justify-end">
                <Button disabled={busy} onClick={closeDay} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t('tips.closeDay', { amount: fmtEUR(tot.totalCents / 100) })}</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('tips.history')}</CardTitle></CardHeader>
        <CardContent>
          {data && data.history.length > 0 ? (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">{t('tips.day')}</th>
                    <th className="p-2 text-right">{t('tips.total')}</th>
                    <th className="p-2">{t('tips.basisShort')}</th>
                    <th className="p-2 text-right">{t('shifts.csvEmployee')}</th>
                    <th className="p-2">{t('shifts.csvStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((p) => (
                    <tr key={p.id} className="border-t border-stone-100">
                      <td className="p-2">{new Date(p.date).toLocaleDateString('sl-SI')}</td>
                      <td className="p-2 text-right font-semibold">{fmtEUR(Number(p.totalTips))}</td>
                      <td className="p-2 text-stone-600">{p.distributionMethod === 'hours' ? t('tips.mHours') : p.distributionMethod === 'points' ? t('tips.mPoints') : t('tips.mEqual')}</td>
                      <td className="p-2 text-right">{p.paid}/{p.employees} {t('tips.paid')}</td>
                      <td className="p-2">
                        <Badge variant={p.status === 'paid' ? 'default' : 'outline'} className={p.status === 'paid' ? 'bg-emerald-700' : ''}>{p.status === 'paid' ? t('tips.paid') : t('tips.processing')}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-stone-500">{t('tips.noHistory')}</p>
          )}
        </CardContent>
      </Card>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  )
}

