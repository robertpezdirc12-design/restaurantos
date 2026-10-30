'use client'

/*
 * OSS-1 (v1.200.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — equipment
 * maintenance card: device register + service plans + derived overdue flags.
 * Mounted in dashboard Settings → Ops section (settings.manage render gate).
 * i18n REGRESSION TRAP: this file is inside the scanned family (dashboard-tabs
 * family) — comments use English and key names ONLY; every user-visible string
 * goes through t().
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Wrench, AlertTriangle, RefreshCw, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { EquipmentDto } from '@/lib/equipment'

interface LocationRowT { id: string; name: string }

const EMPTY_FORM = {
  locationId: '',
  name: '',
  kind: '',
  serial: '',
  installed: '',
  interval: '90',
  planTitle: '',
  notes: '',
}

function day(s: string | null): string {
  return s ? s.slice(0, 10) : '—'
}

export function EquipmentCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const perms = user?.permissions ?? []
  const canConfigure =
    perms.includes('settings.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'

  const [rows, setRows] = useState<EquipmentDto[]>([])
  const [locations, setLocations] = useState<LocationRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState('')

  const [editFor, setEditFor] = useState<EquipmentDto | null>(null)
  const [edit, setEdit] = useState({ name: '', status: 'active', interval: '90', active: true })
  const [saving, setSaving] = useState(false)

  const [deleteFor, setDeleteFor] = useState<EquipmentDto | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api<{ equipment: EquipmentDto[]; locations: LocationRowT[] }>('/api/equipment')
      setRows(d.equipment ?? [])
      setLocations(d.locations ?? [])
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canConfigure) return
    void (async () => { await load() })()
  }, [load, canConfigure])

  if (!canConfigure) return null

  /** 503 pre-DDL detection (haccp/payroll pattern: fail() message contains 'migracij'). */
  const migrPending = /migracij/.test(err)

  const migrBox = (retry: () => void) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-amber-800 flex items-center gap-1.5">
        <AlertTriangle className="h-4 w-4 shrink-0" /> {t('eq.hint')}
      </p>
      <Button size="sm" variant="outline" onClick={retry}>
        <RefreshCw className="h-3.5 w-3.5" /> {t('common.retry')}
      </Button>
    </div>
  )

  async function create() {
    const name = form.name.trim()
    if (!name || name.length > 80) {
      setFormErr(t('eq.errName'))
      return
    }
    setCreating(true)
    setFormErr('')
    try {
      // Select displays the first location as fallback — the payload must send
      // the SAME value (central users have no default location server-side).
      const locationId = form.locationId || locations[0]?.id || undefined
      await api('/api/equipment', {
        method: 'POST',
        body: JSON.stringify({
          name,
          ...(locationId ? { locationId } : {}),
          ...(form.kind.trim() ? { kind: form.kind.trim() } : {}),
          ...(form.serial.trim() ? { serialNumber: form.serial.trim() } : {}),
          ...(form.installed ? { installedAt: form.installed } : {}),
          intervalDays: Math.round(Number(form.interval)) || 90,
          ...(form.planTitle.trim() ? { planTitle: form.planTitle.trim() } : {}),
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        }),
      })
      setForm(EMPTY_FORM)
      setFormOpen(false)
      toast({ description: t('eq.saved') })
      await load()
    } catch (e) {
      setFormErr(String((e as Error).message || e))
    } finally {
      setCreating(false)
    }
  }

  async function saveEdit() {
    if (!editFor || saving) return
    const name = edit.name.trim()
    if (!name || name.length > 80) {
      toast({ variant: 'destructive', description: t('eq.errName') })
      return
    }
    setSaving(true)
    try {
      await api(`/api/equipment/${editFor.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          status: edit.status,
          intervalDays: Math.round(Number(edit.interval)) || 90,
          planActive: edit.active,
        }),
      })
      toast({ description: t('eq.edited') })
      setEditFor(null)
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setSaving(false)
    }
  }

  async function logService(id: string) {
    if (busy) return
    setBusy(id)
    try {
      await api(`/api/equipment/${id}/service`, { method: 'POST', body: JSON.stringify({}) })
      toast({ description: t('eq.saved') })
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
    }
  }

  async function remove(eq: EquipmentDto) {
    if (busy) return
    setBusy(eq.id)
    try {
      await api(`/api/equipment/${eq.id}`, { method: 'DELETE' })
      toast({ description: t('eq.saved') })
      setDeleteFor(null)
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
      setDeleteFor(null)
    }
  }

  function dueBadge(eq: EquipmentDto) {
    const p = eq.plan
    if (!p || p.due === 'paused') return <Badge variant="secondary">{t('eq.paused')}</Badge>
    if (p.due === 'overdue') return <Badge variant="destructive">{t('eq.overdue')}</Badge>
    if (p.due === 'dueSoon') {
      return (
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
          {t('eq.dueSoon')} ({p.dueInDays})
        </Badge>
      )
    }
    return <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">{t('eq.ok')}</Badge>
  }

  function statusBadge(eq: EquipmentDto) {
    if (eq.status === 'broken') return <Badge variant="destructive">{t('eq.statusBroken')}</Badge>
    if (eq.status === 'retired') return <Badge variant="secondary">{t('eq.statusRetired')}</Badge>
    return <Badge variant="outline">{t('eq.statusActive')}</Badge>
  }

  const locName = (id: string): string => locations.find((l) => l.id === id)?.name ?? id

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Wrench className="h-4 w-4" /> {t('eq.title')}
          <Badge variant="secondary" className="ml-1">{rows.length}</Badge>
          <Button size="sm" variant="outline" className="h-8 gap-1 ml-auto" onClick={() => { void load() }} title={t('common.refresh')}>
            <RefreshCw className="h-3.5 w-3.5" /> {t('common.refresh')}
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setFormOpen(!formOpen)} aria-expanded={formOpen}>
            <Plus className="h-3.5 w-3.5" /> {t('eq.add')}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4">
        {migrPending ? (
          migrBox(() => { void load() })
        ) : (
          <>
            {err && <p className="text-sm text-destructive">{err}</p>}

            {formOpen && (
              <form
                className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4"
                onSubmit={(e) => { e.preventDefault(); void create() }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-name">{t('eq.name')} *</Label>
                  <Input id="eq-name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-kind">{t('eq.kind')}</Label>
                  <Input id="eq-kind" value={form.kind} maxLength={40} placeholder={t('eq.kindPh')} onChange={(e) => setForm({ ...form, kind: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-serial">{t('eq.serial')}</Label>
                  <Input id="eq-serial" value={form.serial} maxLength={80} onChange={(e) => setForm({ ...form, serial: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-installed">{t('eq.installed')}</Label>
                  <Input id="eq-installed" type="date" value={form.installed} onChange={(e) => setForm({ ...form, installed: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-interval">{t('eq.interval')}</Label>
                  <Input id="eq-interval" type="number" min={1} max={3650} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-planTitle">{t('eq.planTitle')}</Label>
                  <Input id="eq-planTitle" value={form.planTitle} maxLength={120} onChange={(e) => setForm({ ...form, planTitle: e.target.value })} />
                </div>
                {locations.length > 1 && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="eq-loc">{t('eq.location')}</Label>
                    <Select value={form.locationId || locations[0]?.id} onValueChange={(v) => setForm({ ...form, locationId: v })}>
                      <SelectTrigger id="eq-loc" aria-label={t('eq.location')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="eq-notes">{t('eq.notes')}</Label>
                  <Input id="eq-notes" value={form.notes} maxLength={500} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
                {formErr && <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">{formErr}</p>}
                <div className="sm:col-span-2 lg:col-span-4">
                  <Button type="submit" size="sm" disabled={creating}>{t('common.save')}</Button>
                </div>
              </form>
            )}

            {loading ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('eq.empty')}</p>
            ) : (
              <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto">
                {rows.map((eq) => (
                  <li key={eq.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{eq.name}</span>
                      <Badge variant="outline">{eq.kind}</Badge>
                      {statusBadge(eq)}
                      {dueBadge(eq)}
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          size="sm" variant="outline" className="h-8 gap-1" disabled={busy === eq.id || !!deleteFor}
                          onClick={() => { void logService(eq.id) }} title={t('eq.serviceDone')}
                        >
                          <Wrench className="h-3.5 w-3.5" /> {t('eq.serviceDone')}
                        </Button>
                        <Button
                          size="sm" variant="outline" className="h-8" disabled={!!deleteFor}
                          onClick={() => {
                            setEditFor(eq)
                            setEdit({ name: eq.name, status: eq.status, interval: String(eq.plan?.intervalDays ?? 90), active: eq.plan?.active ?? true })
                          }}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-8" disabled={busy === eq.id} onClick={() => setDeleteFor(eq)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{t('eq.location')}: {locName(eq.locationId)}</span>
                      {eq.serialNumber && <span>{t('eq.serial')}: {eq.serialNumber}</span>}
                      {eq.installedAt && <span>{t('eq.installed')}: {day(eq.installedAt)}</span>}
                      <span>{t('eq.interval')}: {eq.plan?.intervalDays ?? '—'}</span>
                      <span>{t('eq.lastService')}: {day(eq.plan?.lastServicedAt ?? null)}</span>
                      <span className={eq.plan?.due === 'overdue' ? 'font-medium text-destructive' : ''}>
                        {t('eq.nextDue')}: {day(eq.plan?.nextDueAt ?? null)}
                      </span>
                      {eq.notes && <span>{t('eq.notes')}: {eq.notes}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {/* Edit dialog: name + status + interval + plan pause */}
      <Dialog open={!!editFor} onOpenChange={(o) => { if (!o) setEditFor(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('common.edit')} — {editFor?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="eq-e-name">{t('eq.name')}</Label>
              <Input id="eq-e-name" value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="eq-e-status">{t('eq.status')}</Label>
              <Select value={edit.status} onValueChange={(v) => setEdit({ ...edit, status: v })}>
                <SelectTrigger id="eq-e-status" aria-label={t('eq.status')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('eq.statusActive')}</SelectItem>
                  <SelectItem value="broken">{t('eq.statusBroken')}</SelectItem>
                  <SelectItem value="retired">{t('eq.statusRetired')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="eq-e-interval">{t('eq.interval')}</Label>
              <Input id="eq-e-interval" type="number" min={1} max={3650} value={edit.interval} onChange={(e) => setEdit({ ...edit, interval: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="eq-e-active" checked={edit.active} onCheckedChange={(v) => setEdit({ ...edit, active: v })} />
              <Label htmlFor="eq-e-active">{t('eq.paused')}: {edit.active ? t('eq.statusActive') : t('eq.paused')}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditFor(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => { void saveEdit() }} disabled={saving}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteFor} onOpenChange={(o) => { if (!o) setDeleteFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.delete')} — {deleteFor?.name}</AlertDialogTitle>
            <AlertDialogDescription>{t('eq.confirmDelete')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy === deleteFor?.id}
              onClick={(e) => {
                e.preventDefault()
                if (deleteFor) void remove(deleteFor)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
