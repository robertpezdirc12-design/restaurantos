'use client'

/**
 * Issue #24 (P2, v1.114.0) — label shelf-life rules card (Settings tab).
 *
 * Confirmed shelf life per inventory item (LabelShelfRule, #15 philosophy:
 * the system NEVER invents a number of hours — a person confirms it):
 *  - GET /api/labels/rules — rule list (inventory.manage, backend-enforced);
 *  - PUT /api/labels/rules { inventoryItemId, shelfLifeHours: 0..8760, note? }
 *    — upsert + confirmation stamp (who/when);
 *  - PUT /api/labels/rules { inventoryItemId, shelfLifeHours: null } — delete.
 *
 * Item picker reuses the stock list API (GET /api/inventory — same source the
 * inventory tab uses). No polling — settings cards reload after each action
 * (ManagerCallSettingsCard pattern). Render gate: inventory.manage OR
 * OWNER/ADMIN/MANAGER fallback (PrepStationsCard pattern).
 *
 * i18n REGRESSION TRAP: this file is inside the scanned family
 * (src/components/tabs/*) — comments use English and key names ONLY; every
 * user-visible string goes through t().
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Loader2, Pencil, RefreshCw, Tag, Trash2 } from 'lucide-react'

/** GET /api/labels/rules row (server joins item name + unit). */
interface RuleRowT {
  id: string
  inventoryItemId: string
  itemName: string
  itemUnit: string
  shelfLifeHours: number
  note: string
  confirmedByName: string
  confirmedAt: string
}

/** Minimal stock item from GET /api/inventory (picker source). */
interface InvItemT {
  id: string
  name: string
  unit: string
}

/** Mirror of LABEL_RULE_HOURS_MAX in src/lib/label.ts (client-side pre-validation). */
const HOURS_MAX = 8760

export function LabelRulesCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const canManage = Boolean(
    (user?.permissions ?? []).includes('inventory.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER',
  )

  const [rules, setRules] = useState<RuleRowT[] | null>(null)
  const [items, setItems] = useState<InvItemT[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // item picker
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // rule form for the picked item
  const [form, setForm] = useState({ hours: '', note: '' })
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')

  // inline row editing in the rules table
  const [editing, setEditing] = useState<string | null>(null)
  const [edit, setEdit] = useState({ hours: '', note: '' })
  const [editErr, setEditErr] = useState('')
  const [rowBusy, setRowBusy] = useState('')

  const [deleteFor, setDeleteFor] = useState<RuleRowT | null>(null)

  /* single load — returns the fresh list so callers can re-sync their form */
  const load = useCallback(async (): Promise<RuleRowT[]> => {
    setLoading(true)
    setErr('')
    try {
      const d = await api<{ rules: RuleRowT[] }>('/api/labels/rules')
      setRules(d.rules ?? [])
      return d.rules ?? []
    } catch (e) {
      setErr(String((e as Error).message || e))
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canManage) return
    void (async () => { await load() })()
    // item picker needs the stock list (soft-fail: rules table still works)
    void (async () => {
      try {
        const d = await api<{ inventory: InvItemT[] }>('/api/inventory')
        setItems(d.inventory ?? [])
      } catch { /* picker degraded — the table above remains the source of truth */ }
    })()
  }, [canManage, load])

  if (!canManage) return null

  const selectedRule = selectedId ? (rules ?? []).find((r) => r.inventoryItemId === selectedId) ?? null : null
  const selectedItem = selectedId ? items.find((it) => it.id === selectedId) ?? null : null
  const selectedName = selectedItem?.name ?? selectedRule?.itemName ?? ''
  const selectedUnit = selectedItem?.unit ?? selectedRule?.itemUnit ?? ''

  const filteredItems = items.filter((it) =>
    it.name.toLowerCase().includes(search.trim().toLowerCase()))

  function pickItem(id: string) {
    setSelectedId(id)
    setFormErr('')
    const r = (rules ?? []).find((x) => x.inventoryItemId === id)
    setForm({ hours: r ? String(r.shelfLifeHours) : '', note: r?.note ?? '' })
  }

  /** Integer 0..8760 or the localized range error (mirrors the server check). */
  function parseHours(raw: string): number | null {
    const s = raw.trim().replace(',', '.')
    if (s === '') return null
    const n = Number(s)
    if (!Number.isInteger(n) || n < 0 || n > HOURS_MAX) return null
    return n
  }

  async function save() {
    if (saving || !selectedId) return
    const h = parseHours(form.hours)
    if (h === null) {
      setFormErr(t('lbl.rules.hoursRange'))
      return
    }
    setSaving(true)
    setFormErr('')
    try {
      await api('/api/labels/rules', {
        method: 'PUT',
        body: JSON.stringify({ inventoryItemId: selectedId, shelfLifeHours: h, note: form.note.trim() }),
      })
      toast({ description: t('lbl.rules.saved') })
      const fresh = await load()
      const nr = fresh.find((x) => x.inventoryItemId === selectedId)
      setForm({ hours: nr ? String(nr.shelfLifeHours) : '', note: nr?.note ?? '' })
    } catch (e) {
      setFormErr(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  async function saveEdit(r: RuleRowT) {
    if (rowBusy) return
    const h = parseHours(edit.hours)
    if (h === null) {
      setEditErr(t('lbl.rules.hoursRange'))
      return
    }
    setRowBusy(r.inventoryItemId)
    setEditErr('')
    try {
      await api('/api/labels/rules', {
        method: 'PUT',
        body: JSON.stringify({ inventoryItemId: r.inventoryItemId, shelfLifeHours: h, note: edit.note.trim() }),
      })
      toast({ description: t('lbl.rules.saved') })
      setEditing(null)
      const fresh = await load()
      if (selectedId === r.inventoryItemId) {
        const nr = fresh.find((x) => x.inventoryItemId === selectedId)
        setForm({ hours: nr ? String(nr.shelfLifeHours) : '', note: nr?.note ?? '' })
      }
    } catch (e) {
      setEditErr(String((e as Error).message || e))
    } finally {
      setRowBusy('')
    }
  }

  /** shelfLifeHours: null = delete the rule (LABEL_RULE_REMOVED audit). */
  async function removeRule(r: RuleRowT) {
    if (rowBusy) return
    setRowBusy(r.inventoryItemId)
    try {
      await api('/api/labels/rules', {
        method: 'PUT',
        body: JSON.stringify({ inventoryItemId: r.inventoryItemId, shelfLifeHours: null }),
      })
      toast({ description: t('lbl.rules.deleted') })
      const fresh = await load()
      if (selectedId === r.inventoryItemId) {
        const nr = fresh.find((x) => x.inventoryItemId === selectedId)
        setForm({ hours: nr ? String(nr.shelfLifeHours) : '', note: nr?.note ?? '' })
      }
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setRowBusy('')
      setDeleteFor(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Tag className="w-4 h-4" /> {t('lbl.rules.title')}
          {rules !== null && <Badge variant="secondary" className="ml-1">{rules.length}</Badge>}
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
        <p className="text-xs text-stone-500">{t('lbl.rules.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <Skeleton className="h-24 w-full" />}
        {err && <p className="text-sm text-red-600">{err}</p>}

        {/* item picker + rule form for the picked item */}
        <div className="rounded-xl border border-dashed border-stone-300 p-3 space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('lbl.rules.search')}
            className="h-9 text-sm"
            aria-label={t('lbl.rules.search')}
          />
          <div className="max-h-48 overflow-y-auto pr-1 space-y-1">
            {filteredItems.length === 0 && (
              <p className="text-xs text-stone-500">{t('common.none')}</p>
            )}
            {filteredItems.map((it) => {
              const rule = (rules ?? []).find((r) => r.inventoryItemId === it.id)
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => pickItem(it.id)}
                  aria-pressed={selectedId === it.id}
                  className={`w-full flex items-center justify-between gap-2 rounded-lg border p-2 text-left text-sm transition min-h-9 ${
                    selectedId === it.id
                      ? 'border-emerald-600 bg-emerald-50'
                      : 'border-stone-200 bg-white hover:border-stone-400'
                  }`}
                >
                  <span className="truncate min-w-0">{it.name}</span>
                  <span className="shrink-0">
                    {rule ? (
                      <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
                        {rule.shelfLifeHours} h
                      </Badge>
                    ) : (
                      <span className="text-xs text-stone-500">{it.unit}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          {selectedId && (
            <div className="space-y-2 border-t border-stone-200 pt-2">
              <p className="text-sm font-medium">
                {selectedName} {selectedUnit && <span className="text-xs text-stone-500">({selectedUnit})</span>}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="lr-hours" className="text-xs">{t('lbl.rules.hours')}</Label>
                  <Input
                    id="lr-hours"
                    type="number"
                    min={0}
                    max={HOURS_MAX}
                    inputMode="numeric"
                    value={form.hours}
                    onChange={(e) => setForm((c) => ({ ...c, hours: e.target.value }))}
                    className="h-9 text-sm"
                  />
                  <p className="text-xs text-stone-400">{t('lbl.rules.hoursHint')}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lr-note" className="text-xs">{t('lbl.rules.note')}</Label>
                  <Input
                    id="lr-note"
                    maxLength={200}
                    value={form.note}
                    onChange={(e) => setForm((c) => ({ ...c, note: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" disabled={saving} onClick={() => void save()}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t('lbl.rules.save')}
                </Button>
                {selectedRule && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 gap-1 text-red-700 hover:bg-red-50 hover:text-red-800"
                    disabled={saving}
                    onClick={() => setDeleteFor(selectedRule)}
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden /> {t('lbl.rules.delete')}
                  </Button>
                )}
              </div>
              {formErr && <p className="text-xs text-red-600">{formErr}</p>}
            </div>
          )}
        </div>

        {/* existing rules */}
        {!loading && rules !== null && rules.length === 0 && (
          <p className="text-sm text-stone-500">{t('lbl.rules.noRules')}</p>
        )}
        {rules !== null && rules.length > 0 && (
          <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                <tr>
                  <th className="p-2">{t('lbl.print.item')}</th>
                  <th className="p-2">{t('lbl.rules.hours')}</th>
                  <th className="p-2">{t('lbl.rules.note')}</th>
                  <th className="p-2">{t('lbl.rules.confirmedBy')}</th>
                  <th className="p-2 text-right">{t('bat.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const rowEditing = editing === r.inventoryItemId
                  const busy = rowBusy === r.inventoryItemId
                  return (
                    <tr key={r.inventoryItemId} className="border-t border-stone-100 align-top">
                      {rowEditing ? (
                        <td className="p-2" colSpan={5}>
                          <div className="space-y-2">
                            <p className="text-sm font-medium">
                              {r.itemName} {r.itemUnit && <span className="text-xs text-stone-500">({r.itemUnit})</span>}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label htmlFor={`lr-e-hours-${r.inventoryItemId}`} className="text-xs">{t('lbl.rules.hours')}</Label>
                                <Input
                                  id={`lr-e-hours-${r.inventoryItemId}`}
                                  type="number"
                                  min={0}
                                  max={HOURS_MAX}
                                  inputMode="numeric"
                                  value={edit.hours}
                                  onChange={(e) => setEdit((c) => ({ ...c, hours: e.target.value }))}
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label htmlFor={`lr-e-note-${r.inventoryItemId}`} className="text-xs">{t('lbl.rules.note')}</Label>
                                <Input
                                  id={`lr-e-note-${r.inventoryItemId}`}
                                  maxLength={200}
                                  value={edit.note}
                                  onChange={(e) => setEdit((c) => ({ ...c, note: e.target.value }))}
                                  className="h-8 text-sm"
                                />
                              </div>
                            </div>
                            <p className="text-xs text-stone-400">{t('lbl.rules.hoursHint')}</p>
                            <div className="flex flex-wrap gap-2">
                              <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void saveEdit(r)}>
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('lbl.rules.save')}
                              </Button>
                              <Button size="sm" variant="outline" className="h-9" disabled={busy} onClick={() => { setEditing(null); setEditErr('') }}>
                                {t('common.cancel')}
                              </Button>
                            </div>
                            {editErr && <p className="text-xs text-red-600">{editErr}</p>}
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="p-2 font-medium max-w-40 truncate" title={r.itemName}>{r.itemName}</td>
                          <td className="p-2 font-semibold whitespace-nowrap">{r.shelfLifeHours} h</td>
                          <td className="p-2 text-xs text-stone-500 max-w-40 truncate" title={r.note}>{r.note || '—'}</td>
                          <td className="p-2 text-xs text-stone-500">
                            {r.confirmedByName || '—'}
                            {r.confirmedAt && (
                              <span className="block text-stone-400">{new Date(r.confirmedAt).toLocaleDateString('sl-SI')}</span>
                            )}
                          </td>
                          <td className="p-2 text-right whitespace-nowrap">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              disabled={busy}
                              onClick={() => { setEditing(r.inventoryItemId); setEdit({ hours: String(r.shelfLifeHours), note: r.note }); setEditErr('') }}
                              aria-label={`${t('common.edit')} ${r.itemName}`}
                              title={t('common.edit')}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-stone-400 hover:text-red-700"
                              disabled={busy}
                              onClick={() => setDeleteFor(r)}
                              aria-label={`${t('lbl.rules.delete')} ${r.itemName}`}
                              title={t('lbl.rules.delete')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* delete confirm — PUT shelfLifeHours:null (LABEL_RULE_REMOVED) */}
      <AlertDialog open={!!deleteFor} onOpenChange={(v) => !v && setDeleteFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lbl.rules.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFor?.itemName ? `${deleteFor.itemName} · ${deleteFor.shelfLifeHours} h` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteFor && void removeRule(deleteFor)}>
              {t('lbl.rules.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
