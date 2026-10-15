'use client'

/**
 * Issue #14 (P1/P2, v1.112.0) — prep stations config card (Settings tab).
 *
 * Sources:
 *  - GET /api/prep-stations — list (15 s poll, stable useCallback deps — the
 *    v1.110 lesson about endless fetch loops); every role with kitchen.update
 *    may READ, the card itself renders only for settings.manage holders;
 *  - POST /api/prep-stations — create (name/type/avgPrepTime/sortOrder/isExpo);
 *  - PATCH /api/prep-stations/[id] — inline edit + isExpo/isActive switches;
 *  - DELETE /api/prep-stations/[id] — AlertDialog confirm; 409 (station has
 *    active tasks) surfaces the server error in a destructive toast;
 *  - item routing editor (menu.manage): GET /api/menus → per item primary
 *    station Select + additional stations chips; save via PATCH /api/menus/[id]
 *    {prepStationId, stationIds} (the primary is never repeated in stationIds).
 *
 * i18n REGRESSION TRAP: this file is inside the scanned family
 * (dashboard-tabs.tsx + src/components/tabs/*) — comments use English and
 * key names ONLY; every user-visible string goes through t().
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ChefHat, ChevronDown, Loader2, Pencil, Plus, RefreshCw, Ship, Trash2 } from 'lucide-react'

interface StationRowT {
  id: string
  name: string
  type: string
  avgPrepTime: number
  isActive: boolean
  sortOrder: number
  isExpo: boolean
  menuItemCount: number
}

/** Menu item with routing fields (GET /api/menus additive fields). */
interface MenuRouteItemT {
  id: string
  name: string
  prepStationId?: string | null
  stationIds?: string[]
}

/** Draft of an item's routing (primary + additional stations). */
interface RouteDraftT {
  /** station id or the 'none' sentinel (Select cannot hold an empty value) */
  prep: string
  extra: string[]
}

const EMPTY_FORM = { name: '', type: '', avg: '15', order: '0', expo: false }

export function PrepStationsCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const perms = user?.permissions ?? []
  const canConfigure =
    perms.includes('settings.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'
  const canRoute =
    perms.includes('menu.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'

  const [stations, setStations] = useState<StationRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState('')

  const [editing, setEditing] = useState<string | null>(null)
  const [edit, setEdit] = useState({ name: '', type: '', avg: '15', order: '0' })
  const [busy, setBusy] = useState('')

  const [deleteFor, setDeleteFor] = useState<StationRowT | null>(null)

  const [routingOpen, setRoutingOpen] = useState(false)
  const [routeItems, setRouteItems] = useState<MenuRouteItemT[]>([])
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeSaving, setRouteSaving] = useState('')
  const [routeSearch, setRouteSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, RouteDraftT>>({})

  /* 15 s poll — stable deps (useCallback []) so the interval never re-arms. */
  const load = useCallback(async () => {
    try {
      const d = await api<{ stations: StationRowT[] }>('/api/prep-stations')
      setStations(d.stations ?? [])
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canConfigure) return
    void load()
    const iv = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(iv)
  }, [load, canConfigure])

  /** Routing editor payload (loaded when the collapsible opens). */
  const loadRouting = useCallback(async () => {
    setRouteLoading(true)
    try {
      const d = await api<{ items: MenuRouteItemT[] }>('/api/menus')
      setRouteItems(d.items ?? [])
      setDrafts(Object.fromEntries(
        (d.items ?? []).map((mi) => [mi.id, { prep: mi.prepStationId ?? 'none', extra: [...(mi.stationIds ?? [])] }]),
      ))
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setRouteLoading(false)
    }
  }, [])

  if (!canConfigure) return null

  async function patchStation(id: string, body: Record<string, unknown>, okMsg?: string) {
    if (busy) return
    setBusy(id)
    try {
      await api(`/api/prep-stations/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      if (okMsg) toast({ description: okMsg })
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
    }
  }

  async function create() {
    const name = form.name.trim()
    if (!name || name.length > 60) {
      setFormErr(t('kds.cfg.errName'))
      return
    }
    setCreating(true)
    setFormErr('')
    try {
      await api('/api/prep-stations', {
        method: 'POST',
        body: JSON.stringify({
          name,
          ...(form.type.trim() ? { type: form.type.trim().toLowerCase() } : {}),
          avgPrepTime: Math.round(Number(form.avg)) || 15,
          sortOrder: Math.round(Number(form.order)) || 0,
          isExpo: form.expo,
        }),
      })
      setForm(EMPTY_FORM)
      toast({ description: t('kds.cfg.saved') })
      await load()
    } catch (e) {
      const msg = String((e as Error).message || e)
      setFormErr(/obstaja|postoji/i.test(msg) ? `${t('kds.cfg.errDupe')}` : msg)
    } finally {
      setCreating(false)
    }
  }

  async function saveEdit(id: string) {
    const name = edit.name.trim()
    if (!name || name.length > 60) {
      toast({ variant: 'destructive', description: t('kds.cfg.errName') })
      return
    }
    await patchStation(id, {
      name,
      ...(edit.type.trim() ? { type: edit.type.trim().toLowerCase() } : {}),
      avgPrepTime: Math.round(Number(edit.avg)) || 15,
      sortOrder: Math.round(Number(edit.order)) || 0,
    }, t('kds.cfg.saved'))
    setEditing(null)
  }

  async function removeStation(st: StationRowT) {
    if (busy) return
    setBusy(st.id)
    try {
      await api(`/api/prep-stations/${st.id}`, { method: 'DELETE' })
      toast({ description: t('kds.cfg.deleted') })
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
      setDeleteFor(null)
    }
  }

  function setPrimary(itemId: string, v: string) {
    setDrafts((prev) => {
      const cur = prev[itemId] ?? { prep: 'none', extra: [] }
      // keep it clean: the primary is never repeated in stationIds
      return { ...prev, [itemId]: { prep: v, extra: cur.extra.filter((sid) => sid !== v) } }
    })
  }

  function toggleExtra(itemId: string, sid: string) {
    setDrafts((prev) => {
      const cur = prev[itemId] ?? { prep: 'none', extra: [] }
      const has = cur.extra.includes(sid)
      return { ...prev, [itemId]: { prep: cur.prep, extra: has ? cur.extra.filter((x) => x !== sid) : [...cur.extra, sid] } }
    })
  }

  async function saveRoute(mi: MenuRouteItemT) {
    const draft = drafts[mi.id]
    if (!draft || routeSaving) return
    setRouteSaving(mi.id)
    try {
      const prepStationId = draft.prep === 'none' ? null : draft.prep
      const stationIds = draft.extra.filter((sid) => sid !== draft.prep)
      await api(`/api/menus/${mi.id}`, { method: 'PATCH', body: JSON.stringify({ prepStationId, stationIds }) })
      toast({ description: t('kds.cfg.routingSaved') })
      await loadRouting()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setRouteSaving('')
    }
  }

  const routeDirty = (mi: MenuRouteItemT, draft: RouteDraftT): boolean =>
    draft.prep !== (mi.prepStationId ?? 'none') ||
    draft.extra.length !== (mi.stationIds ?? []).length ||
    draft.extra.some((sid) => !(mi.stationIds ?? []).includes(sid))

  const filteredRouteItems = routeItems.filter((mi) =>
    mi.name.toLowerCase().includes(routeSearch.trim().toLowerCase()))

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <ChefHat className="w-4 h-4" /> {t('kds.cfg.title')}
          <Badge variant="secondary" className="ml-1">{stations.length}</Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 ml-auto"
            onClick={() => { void load() }}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </CardTitle>
        <p className="text-xs text-stone-500">{t('kds.cfg.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <Skeleton className="h-24 w-full" />}
        {err && <p className="text-sm text-red-600">{err}</p>}

        {/* station list */}
        {!loading && stations.length === 0 && <p className="text-sm text-stone-500">{t('kds.cfg.empty')}</p>}
        {!loading && stations.length > 0 && (
          <div className="space-y-2">
            {stations.map((st) => {
              const rowBusy = busy === st.id
              return (
                <div key={st.id} className={`rounded-xl border border-stone-200 bg-white p-3 space-y-1.5 min-w-0 ${st.isActive ? '' : 'opacity-60'}`}>
                  {editing === st.id ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div className="space-y-1 col-span-2 sm:col-span-1">
                          <Label htmlFor={`ps-edit-name-${st.id}`} className="text-xs">{t('kds.cfg.name')}</Label>
                          <Input id={`ps-edit-name-${st.id}`} value={edit.name} maxLength={60} onChange={(e) => setEdit((c) => ({ ...c, name: e.target.value }))} className="h-8 text-sm" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ps-edit-type-${st.id}`} className="text-xs">{t('kds.cfg.type')}</Label>
                          <Input id={`ps-edit-type-${st.id}`} value={edit.type} maxLength={30} onChange={(e) => setEdit((c) => ({ ...c, type: e.target.value }))} className="h-8 text-sm" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ps-edit-avg-${st.id}`} className="text-xs">{t('kds.cfg.avgPrep')}</Label>
                          <Input id={`ps-edit-avg-${st.id}`} type="number" inputMode="numeric" min={1} max={60} value={edit.avg} onChange={(e) => setEdit((c) => ({ ...c, avg: e.target.value }))} className="h-8 text-sm" />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ps-edit-order-${st.id}`} className="text-xs">{t('kds.cfg.order')}</Label>
                          <Input id={`ps-edit-order-${st.id}`} type="number" inputMode="numeric" min={0} max={999} value={edit.order} onChange={(e) => setEdit((c) => ({ ...c, order: e.target.value }))} className="h-8 text-sm" />
                        </div>
                      </div>
                      <p className="text-[11px] text-stone-500">{t('kds.cfg.typeHint')}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" disabled={rowBusy} onClick={() => void saveEdit(st.id)}>
                          {rowBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('kds.cfg.save')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-9" disabled={rowBusy} onClick={() => setEditing(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <p className="text-sm font-medium truncate min-w-0">{st.name}</p>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{st.type}</Badge>
                        {st.isExpo && (
                          <Badge variant="outline" className="gap-1 shrink-0 border-emerald-300 bg-emerald-50 text-emerald-800">
                            <Ship className="w-3 h-3" aria-hidden /> {t('kds.cfg.expo')}
                          </Badge>
                        )}
                        <Badge variant="outline" className="shrink-0 text-[10px] text-stone-500">
                          {t('kds.cfg.inUse', { n: st.menuItemCount })}
                        </Badge>
                        <span className="ml-auto flex gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            disabled={rowBusy}
                            onClick={() => { setEditing(st.id); setEdit({ name: st.name, type: st.type, avg: String(st.avgPrepTime), order: String(st.sortOrder) }) }}
                            aria-label={t('common.edit')}
                            title={t('common.edit')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-stone-400 hover:text-red-700"
                            disabled={rowBusy}
                            onClick={() => setDeleteFor(st)}
                            aria-label={t('kds.cfg.delete')}
                            title={t('kds.cfg.delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 min-w-0">
                        {t('kds.cfg.avgPrep')}: {st.avgPrepTime} · {t('kds.cfg.order')}: {st.sortOrder}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Ship className="w-3.5 h-3.5 text-stone-400" aria-hidden />
                          <Switch
                            checked={st.isExpo}
                            disabled={rowBusy}
                            onCheckedChange={(v) => void patchStation(st.id, { isExpo: v === true })}
                            aria-label={`${t('kds.cfg.expo')}: ${st.name}`}
                          />
                          <span className="text-stone-600" title={t('kds.cfg.expHint')}>{t('kds.cfg.expo')}</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Switch
                            checked={st.isActive}
                            disabled={rowBusy}
                            onCheckedChange={(v) => void patchStation(st.id, { isActive: v === true })}
                            aria-label={`${t('kds.cfg.active')}: ${st.name}`}
                          />
                          <span className="text-stone-600">{t('kds.cfg.active')}</span>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* create form */}
        <div className="rounded-xl border border-dashed border-stone-300 p-3 space-y-2">
          <p className="text-sm font-medium flex items-center gap-1.5"><Plus className="w-4 h-4" /> {t('kds.cfg.add')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <Label htmlFor="ps-new-name" className="text-xs">{t('kds.cfg.name')}</Label>
              <Input id="ps-new-name" value={form.name} maxLength={60} onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ps-new-type" className="text-xs">{t('kds.cfg.type')}</Label>
              <Input id="ps-new-type" value={form.type} maxLength={30} placeholder="grill" onChange={(e) => setForm((c) => ({ ...c, type: e.target.value }))} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ps-new-avg" className="text-xs">{t('kds.cfg.avgPrep')}</Label>
              <Input id="ps-new-avg" type="number" inputMode="numeric" min={1} max={60} value={form.avg} onChange={(e) => setForm((c) => ({ ...c, avg: e.target.value }))} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ps-new-order" className="text-xs">{t('kds.cfg.order')}</Label>
              <Input id="ps-new-order" type="number" inputMode="numeric" min={0} max={999} value={form.order} onChange={(e) => setForm((c) => ({ ...c, order: e.target.value }))} className="h-9 text-sm" />
            </div>
          </div>
          <label htmlFor="ps-new-expo" className="flex items-center gap-2 text-xs cursor-pointer min-h-8" title={t('kds.cfg.expHint')}>
            <Checkbox id="ps-new-expo" checked={form.expo} onCheckedChange={(v) => setForm((c) => ({ ...c, expo: v === true }))} />
            <span>{t('kds.cfg.expo')}</span>
          </label>
          <p className="text-[11px] text-stone-500">{t('kds.cfg.typeHint')} · {t('kds.cfg.expHint')}</p>
          <Button size="sm" className="h-9 gap-1 bg-emerald-700 hover:bg-emerald-800" disabled={creating} onClick={() => void create()}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {t('kds.cfg.add')}
          </Button>
          {formErr && <p className="text-xs text-red-600">{formErr}</p>}
        </div>

        {/* item routing editor (menu.manage) */}
        {canRoute && (
          <Collapsible
            open={routingOpen}
            onOpenChange={(v) => { setRoutingOpen(v); if (v) void loadRouting() }}
          >
            <div className="border-t border-stone-200 pt-3 space-y-2">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left">
                <p className="text-sm font-semibold flex items-center gap-1.5">
                  <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${routingOpen ? 'rotate-180' : ''}`} aria-hidden />
                  {t('kds.cfg.routing')}
                </p>
              </CollapsibleTrigger>
              <p className="text-xs text-stone-500">{t('kds.cfg.routingDesc')}</p>
              <CollapsibleContent className="space-y-2 pt-1">
                <Input
                  value={routeSearch}
                  onChange={(e) => setRouteSearch(e.target.value)}
                  placeholder={t('kds.cfg.routingSearch')}
                  className="h-9 text-sm"
                  aria-label={t('kds.cfg.routingSearch')}
                />
                {routeLoading && <Skeleton className="h-16 w-full" />}
                {!routeLoading && filteredRouteItems.length === 0 && (
                  <p className="text-sm text-stone-500">{t('kds.cfg.empty')}</p>
                )}
                <div className="max-h-96 overflow-y-auto pr-1 space-y-1.5">
                  {filteredRouteItems.map((mi) => {
                    const draft = drafts[mi.id] ?? { prep: mi.prepStationId ?? 'none', extra: [...(mi.stationIds ?? [])] }
                    return (
                      <div key={mi.id} className="rounded-lg border border-stone-200 bg-white p-2.5 space-y-1.5 min-w-0">
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <p className="text-sm font-medium truncate min-w-0">{mi.name}</p>
                          {routeDirty(mi, draft) && (
                            <Button
                              size="sm"
                              className="h-8 shrink-0 bg-emerald-700 hover:bg-emerald-800"
                              disabled={!!routeSaving}
                              onClick={() => void saveRoute(mi)}
                            >
                              {routeSaving === mi.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('kds.cfg.save')}
                            </Button>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ps-route-${mi.id}`} className="text-[11px]">{t('kds.cfg.primaryStation')}</Label>
                          <Select value={draft.prep} onValueChange={(v) => setPrimary(mi.id, v)}>
                            <SelectTrigger id={`ps-route-${mi.id}`} className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('kds.cfg.noStation')}</SelectItem>
                              {stations.map((s) => (
                                <SelectItem key={s.id} value={s.id}>{s.name}{s.isExpo ? ' · ' + t('kds.cfg.expo') : ''}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <p className="text-[11px] text-stone-500">{t('kds.cfg.additional')}</p>
                          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('kds.cfg.additional')}>
                            {stations
                              .filter((s) => s.id !== draft.prep)
                              .map((s) => {
                                const selected = draft.extra.includes(s.id)
                                return (
                                  <button
                                    key={s.id}
                                    type="button"
                                    aria-pressed={selected}
                                    onClick={() => toggleExtra(mi.id, s.id)}
                                    className={`min-h-8 rounded-full px-3 py-1 text-xs font-semibold border transition ${
                                      selected
                                        ? 'bg-emerald-700 text-white border-emerald-700'
                                        : 'bg-white border-stone-200 text-stone-600 hover:border-stone-400'
                                    } ${s.isActive ? '' : 'opacity-50'}`}
                                  >
                                    {s.name}
                                  </button>
                                )
                              })}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}
      </CardContent>

      {/* delete confirm (409 with active tasks → destructive toast) */}
      <AlertDialog open={!!deleteFor} onOpenChange={(v) => !v && setDeleteFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('kds.cfg.deleteConfirm', { name: deleteFor?.name || '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('kds.cfg.deleteHint')}
              {deleteFor && deleteFor.menuItemCount > 0 ? ` ${t('kds.cfg.inUse', { n: deleteFor.menuItemCount })}.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteFor && void removeStation(deleteFor)}>
              {t('kds.cfg.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
