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
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'
import { DursCheckButton, BatchesCard, BatchPrepCard } from './tabs/ops-cards'

/* ─────────────────────────── ZALOGE ─────────────────────────── */

export interface InventoryT { id: string; name: string; unit: string; qty: number; minQty: number; cost: number; supplierId?: string | null }
export interface SupplierT { id: string; name: string; contact?: string | null; phone?: string | null; email?: string | null; address?: string | null }
/** OPS-9 val 1: recipe line with BOM maturity — yieldPercent + nested sub-recipe children. */
export interface RecipeLineT { inventoryItemId: string; name: string; unit: string; qty: number; yieldPercent?: number; parentRecipeItemId?: string | null; children?: RecipeLineT[] }
export interface RecipeT { id: string; name: string; instructions: string; costPerServing?: number; costKnown?: boolean; items: RecipeLineT[] }

type StRow = {
  id: string; status: string; note: string; createdByName: string
  counted: number; total: number; varianceValue: number
  recountCount: number; createdAt: string; approvedByName: string | null
}
type StItemRow = {
  id: string; name: string; unit: string; expectedQty: number
  countedQty: number | null; varianceQty: number | null
  varianceValue: number | null; note: string
}
type StFull = StRow & { items: StItemRow[] }

export function InventoryTab({ items, suppliers, recipes, menuItems = [], canManage, onReload }: { items: InventoryT[]; suppliers: SupplierT[]; recipes: RecipeT[]; menuItems?: { id: string; name: string }[]; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const low = items.filter((i) => i.minQty > 0 && i.qty <= i.minQty)
  const totalValue = items.reduce((s, i) => s + i.qty * i.cost, 0)
  const [addItem, setAddItem] = useState(false)
  const [ni, setNi] = useState({ name: '', unit: 'kg', qty: '', minQty: '', cost: '' })
  const [niBusy, setNiBusy] = useState(false)
  const [adjust, setAdjust] = useState<InventoryT | null>(null)
  const [adj, setAdj] = useState({ delta: '', setQty: '', minQty: '', cost: '' })
  const [adjBusy, setAdjBusy] = useState(false)
  const [stList, setStList] = useState<StRow[]>([])
  const [stOpen, setStOpen] = useState<StFull | null>(null)
  const [stInputs, setStInputs] = useState<Record<string, string>>({})
  const [stNote, setStNote] = useState('')
  const [stBusy, setStBusy] = useState(false)
  const [stErr, setStErr] = useState('')

  async function loadStocktakes() {
    try {
      const r = await api<{ stocktakes: StRow[] }>('/api/stocktakes')
      const rows = r.stocktakes ?? []
      setStList(rows)
      const open = rows.find((s) => s.status === 'DRAFT' || s.status === 'SUBMITTED')
      if (open) {
        const d = await api<{ stocktake: StFull }>(`/api/stocktakes/${open.id}`)
        setStOpen(d.stocktake)
        const inp: Record<string, string> = {}
        for (const it of d.stocktake.items) inp[it.id] = it.countedQty == null ? '' : String(it.countedQty)
        setStInputs(inp)
      } else { setStOpen(null); setStInputs({}) }
    } catch { /* seznam ni kritičen — tiho */ }
  }
  useEffect(() => { loadStocktakes() }, [])

  async function stAction(method: 'POST' | 'PATCH', url: string, body?: unknown) {
    setStBusy(true); setStErr('')
    try {
      await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })
      await loadStocktakes()
      if (method === 'POST') await onReload()
    } catch (err) { setStErr((err as Error).message) } finally { setStBusy(false) }
  }
  const openStocktake = () => stAction('POST', '/api/stocktakes', { note: stNote })
  const saveCounts = () => stAction('PATCH', `/api/stocktakes/${stOpen?.id}`, {
    items: (stOpen?.items ?? []).filter((it) => stInputs[it.id] !== '').map((it) => ({ id: it.id, countedQuantity: stInputs[it.id] === '' ? null : Number(stInputs[it.id].replace(',', '.')) })),
  })
  const submitSt = () => stAction('POST', `/api/stocktakes/${stOpen?.id}/submit`)
  const approveSt = () => stAction('POST', `/api/stocktakes/${stOpen?.id}/approve`)
  const cancelSt = () => stAction('POST', `/api/stocktakes/${stOpen?.id}/cancel`)
  const recountSt = () => stAction('POST', `/api/stocktakes/${stOpen?.id}/recount`)
  const [supForm, setSupForm] = useState<{ name: string; contact: string; phone: string } | null>(null)
  const [supBusy, setSupBusy] = useState(false)
  // Receptura urejevalnik (razknjiževanje po recepturah) — OPS-9: yield + pod-recepture
  const [recForm, setRecForm] = useState<{ menuItemId: string; lines: { inventoryItemId: string; qty: string; yield: string; parent: string }[] } | null>(null)
  const [recEdit, setRecEdit] = useState<RecipeT | null>(null)
  const [recBusy, setRecBusy] = useState(false)

  function openRecipe(r?: RecipeT) {
    if (r) {
      // Flatten the nested tree (children under parents) into editable lines;
      // sub-recipe parent is referenced by inventoryItemId (unique within one recipe).
      const lines: { inventoryItemId: string; qty: string; yield: string; parent: string }[] = []
      const walk = (rows: RecipeLineT[], parentInv: string) => {
        for (const l of rows) {
          lines.push({ inventoryItemId: l.inventoryItemId, qty: String(l.qty), yield: String(l.yieldPercent ?? 100), parent: parentInv })
          walk(l.children ?? [], l.inventoryItemId)
        }
      }
      walk(r.items, '')
      setRecEdit(r)
      setRecForm({ menuItemId: r.id, lines: lines.length > 0 ? lines : [{ inventoryItemId: items[0]?.id || '', qty: '', yield: '100', parent: '' }] })
    } else {
      setRecEdit(null)
      setRecForm({ menuItemId: menuItems[0]?.id || '', lines: [{ inventoryItemId: items[0]?.id || '', qty: '', yield: '100', parent: '' }] })
    }
  }

  async function saveRecipe() {
    if (!recForm || !recForm.menuItemId) return
    setRecBusy(true)
    try {
      await api('/api/recipes', {
        method: 'POST',
        body: JSON.stringify({
          menuItemId: recForm.menuItemId,
          items: recForm.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            qty: l.qty,
            yieldPercent: l.yield === '' ? undefined : Number(l.yield.replace(',', '.')),
            parentInventoryItemId: l.parent || undefined,
          })),
        }),
      })
      setRecForm(null); setRecEdit(null); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setRecBusy(false) }
  }

  async function deleteRecipe(menuItemId: string) {
    if (!confirm(t('inv.deleteRecipeConfirm'))) return
    try {
      await api(`/api/recipes?menuItemId=${encodeURIComponent(menuItemId)}`, { method: 'DELETE' })
      await onReload()
    } catch (err) { alert((err as Error).message) }
  }

  // OPS-9: recursive recipe line renderer — children indented with a sub-recipe badge,
  // non-default yield shown next to the name.
  function renderRecipeLine(line: RecipeLineT, depth: number) {
    return (
      <Fragment key={line.inventoryItemId}>
        <li className={`text-xs text-stone-600 flex justify-between gap-2 ${depth > 0 ? 'ml-4' : ''}`}>
          <span className="truncate flex items-center gap-1 min-w-0">
            {depth > 0 && <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">{t('recipe.subRecipe')}</Badge>}
            <span className="truncate">{line.name}</span>
            {line.yieldPercent !== undefined && line.yieldPercent !== 100 && <span className="shrink-0 text-stone-400">· {line.yieldPercent} %</span>}
          </span>
          <span className="shrink-0 font-medium">{line.qty} {line.unit}</span>
        </li>
        {(line.children ?? []).map((c) => renderRecipeLine(c, depth + 1))}
      </Fragment>
    )
  }

  async function createItem() {
    setNiBusy(true)
    try {
      await api('/api/inventory', { method: 'POST', body: JSON.stringify({ name: ni.name, unit: ni.unit, qty: ni.qty, minQty: ni.minQty, cost: ni.cost }) })
      setAddItem(false); setNi({ name: '', unit: 'kg', qty: '', minQty: '', cost: '' }); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setNiBusy(false) }
  }
  async function saveAdjust() {
    if (!adjust) return
    setAdjBusy(true)
    try {
      await api('/api/inventory', { method: 'PATCH', body: JSON.stringify({ id: adjust.id, delta: adj.delta, setQty: adj.setQty, minQty: adj.minQty, cost: adj.cost }) })
      setAdjust(null); setAdj({ delta: '', setQty: '', minQty: '', cost: '' }); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setAdjBusy(false) }
  }
  async function createSupplier() {
    if (!supForm) return
    setSupBusy(true)
    try {
      await api('/api/suppliers', { method: 'POST', body: JSON.stringify(supForm) })
      setSupForm(null); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setSupBusy(false) }
  }

  // OPS-9: yield validity (empty = default 100; otherwise 1..100)
  const yieldInvalid = (s: string) => {
    if (s === '') return false
    const n = Number(s.replace(',', '.'))
    return !Number.isFinite(n) || n <= 0 || n > 100
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><PackageSearch className="w-4 h-4" /> {t('inv.itemCount')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{items.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('inv.belowMin')}</CardTitle></CardHeader><CardContent><p className={`text-2xl font-bold ${low.length > 0 ? 'text-amber-600' : ''}`}>{low.length}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-1"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('inv.stockValue')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(totalValue)}</p></CardContent></Card>
      </div>

      {/* OPS-8 val 2 — batches / expiry (FEFO, lazy-load on expand) */}
      <BatchesCard />

      {/* OPS-10 val 3 — batch preparations (BOM production, lazy-load on expand) */}
      <BatchPrepCard />

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setAddItem(true)}><Plus className="w-4 h-4" /> {t('inv.newItem')}</Button>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('inv.stockList')}</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 && <p className="text-sm text-stone-500">{t('inv.empty')}</p>}
          <ScrollArea className="max-h-[55vh]">
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((i) => {
                const isLow = i.minQty > 0 && i.qty <= i.minQty
                return (
                  <div key={i.id} className={`rounded-lg border bg-white p-3 flex items-center justify-between gap-2 ${isLow ? 'border-amber-300 bg-amber-50/60' : 'border-stone-200'}`}>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{i.name}</p>
                      <p className="text-xs text-stone-500">{i.cost > 0 ? `${fmtEUR(i.cost)}/${i.unit}` : i.unit}{isLow && ` · ${t('inv.minShort')} ${i.minQty}`}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className="font-bold">{i.qty} {i.unit}</p>
                        {isLow && <Badge className="bg-amber-600 text-white mt-0.5">{t('inv.belowMin')}</Badge>}
                      </div>
                      {canManage && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setAdjust(i); setAdj({ delta: '', setQty: String(i.qty), minQty: String(i.minQty), cost: String(i.cost) }) }}>
                          {t('inv.adjust')}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-1.5"><PackageSearch className="w-4 h-4" /> {t('st.title')}</CardTitle>
          {canManage && !stOpen && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stBusy} onClick={openStocktake}>
              <Plus className="w-3 h-3" /> {t('st.open')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {stErr && <p className="text-xs text-red-600">{stErr}</p>}
          {stOpen ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge className={stOpen.status === 'DRAFT' ? 'bg-stone-600 text-white' : 'bg-amber-600 text-white'}>{t(`st.status.${stOpen.status}`)}</Badge>
                <span className="text-xs text-stone-500">{stOpen.counted}/{stOpen.total} · {t('st.counted')}</span>
                {stOpen.recountCount > 0 && <Badge variant="outline" className="text-[10px]">{t('st.recounts')}: {stOpen.recountCount}</Badge>}
              </div>
              <ScrollArea className="max-h-56">
                <div className="space-y-1.5">
                  {stOpen.items.map((it) => (
                    <div key={it.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 p-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{it.name}</p>
                        <p className="text-xs text-stone-500">{t('st.expected')}: {it.expectedQty} {it.unit}</p>
                      </div>
                      <Input
                        className="h-8 w-24 text-right text-sm"
                        inputMode="decimal"
                        placeholder="—"
                        disabled={!canManage || stBusy || stOpen.status !== 'DRAFT'}
                        value={stInputs[it.id] ?? ''}
                        onChange={(e) => setStInputs((prev) => ({ ...prev, [it.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {canManage && (
                <div className="flex flex-wrap gap-1.5">
                  {stOpen.status === 'DRAFT' && (<>
                    <Button size="sm" className="h-7 text-xs" disabled={stBusy} onClick={saveCounts}>{t('st.save')}</Button>
                    <Button size="sm" className="h-7 bg-emerald-700 text-xs text-white hover:bg-emerald-800" disabled={stBusy} onClick={submitSt}>{t('st.submit')}</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stBusy} onClick={cancelSt}>{t('st.cancel')}</Button>
                  </>)}
                  {stOpen.status === 'SUBMITTED' && (<>
                    <Button size="sm" className="h-7 bg-emerald-700 text-xs text-white hover:bg-emerald-800" disabled={stBusy} onClick={approveSt}>{t('st.approve')}</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stBusy} onClick={recountSt}>{t('st.recount')}</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={stBusy} onClick={cancelSt}>{t('st.cancel')}</Button>
                  </>)}
                </div>
              )}
            </div>
          ) : stList.length === 0 ? (
            <p className="text-sm text-stone-500">{t('st.empty')}</p>
          ) : (
            <div className="space-y-1.5">
              {stList.slice(0, 5).map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 p-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{s.createdByName} · {new Date(s.createdAt).toLocaleDateString()}</p>
                    {s.note && <p className="truncate text-xs text-stone-500">{s.note}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-stone-500">{s.counted}/{s.total}</span>
                    {s.varianceValue !== 0 && <span className={`text-xs font-medium ${s.varianceValue > 0 ? 'text-emerald-700' : 'text-red-600'}`}>{s.varianceValue > 0 ? '+' : ''}{s.varianceValue.toFixed(2)} €</span>}
                    <Badge variant="outline" className="text-[10px]">{t(`st.status.${s.status}`)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-1.5"><Truck className="w-4 h-4" /> {t('inv.suppliers')}</CardTitle>
          {canManage && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSupForm({ name: '', contact: '', phone: '' })}><Plus className="w-3 h-3" /> {t('inv.add')}</Button>}
        </CardHeader>
        <CardContent>
          {suppliers.length === 0 && <p className="text-sm text-stone-500">{t('inv.noSuppliers')}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {suppliers.map((s) => (
              <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3">
                <p className="font-medium truncate">{s.name}</p>
                <p className="text-xs text-stone-500 truncate">
                  {s.contact || '—'}{s.phone ? ` · ${s.phone}` : ''}{s.email ? ` · ${s.email}` : ''}
                </p>
                {s.address && <p className="text-[11px] text-stone-400 truncate">{s.address}</p>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-1.5"><UtensilsCrossed className="w-4 h-4" /> {t('inv.recipes')}</CardTitle>
          {canManage && menuItems.length > 0 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openRecipe()}><Plus className="w-3 h-3" /> {t('inv.recipe')}</Button>
          )}
        </CardHeader>
        <CardContent>
          {recipes.length === 0 && <p className="text-sm text-stone-500">{t('inv.noRecipes')}</p>}
          <ScrollArea className="max-h-80">
            <div className="grid gap-2 sm:grid-cols-2">
              {recipes.map((r) => (
                <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{r.name}</p>
                      {/* OPS-9: computed cost per serving (recursive BOM; from GET, refreshes on reload) */}
                      <p className="text-[11px] text-stone-500">
                        {t('recipe.costPerServing')}:{' '}
                        {r.costKnown ? <span className="font-medium text-stone-700">{fmtEUR(r.costPerServing || 0)}</span> : <span className="text-amber-600">{t('recipe.costUnknown')}</span>}
                      </p>
                    </div>
                    {canManage && (
                      <div className="shrink-0 flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => openRecipe(r)}>{t('common.edit')}</Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] text-red-700 hover:text-red-800" onClick={() => deleteRecipe(r.id)}>{t('common.delete')}</Button>
                      </div>
                    )}
                  </div>
                  {r.items.length === 0 ? (
                    <p className="text-xs text-stone-400">{t('inv.noIngredients')}</p>
                  ) : (
                    <ul className="mt-1 space-y-0.5">
                      {r.items.map((line) => renderRecipeLine(line, 0))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Receptura: sestavine artikla menija */}
      <Dialog open={recForm !== null} onOpenChange={(v) => !v && setRecForm(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t('inv.recipeTitle')}</DialogTitle></DialogHeader>
          {recForm && (
            <div className="space-y-3">
              {/* OPS-9: computed cost per serving of the recipe being edited (from GET) */}
              {recEdit && recEdit.id === recForm.menuItemId && (
                <p className="text-xs text-stone-500">
                  {t('recipe.costPerServing')}:{' '}
                  {recEdit.costKnown ? <span className="font-medium text-stone-700">{fmtEUR(recEdit.costPerServing || 0)}</span> : <span className="text-amber-600">{t('recipe.costUnknown')}</span>}
                </p>
              )}
              <div className="space-y-1.5">
                <Label>{t('inv.menuItem')}</Label>
                <Select value={recForm.menuItemId} onValueChange={(v) => setRecForm({ ...recForm, menuItemId: v })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t('inv.selectItem')} /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {menuItems.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('inv.ingredients')}</Label>
                {recForm.lines.map((line, idx) => (
                  <div key={idx} className="space-y-1">
                    <div className="flex gap-2 items-center">
                      <Select value={line.inventoryItemId} onValueChange={(v) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, inventoryItemId: v } : l) })}>
                        <SelectTrigger className="flex-1"><SelectValue placeholder={t('inv.ingredient')} /></SelectTrigger>
                        <SelectContent className="max-h-72">
                          {items.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input type="number" step="0.001" min="0" className="w-20" value={line.qty} onChange={(e) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, qty: e.target.value } : l) })} placeholder="0" />
                      {/* OPS-9: yield percent per line (1-100, default 100) */}
                      <div className="relative w-20 shrink-0">
                        <Input type="number" min="1" max="100" step="1" className="w-20 pr-6" aria-label={t('recipe.yield')} value={line.yield} onChange={(e) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, yield: e.target.value } : l) })} placeholder="100" />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-400 pointer-events-none">%</span>
                      </div>
                      <Button size="sm" variant="outline" className="h-9 px-2 shrink-0 text-red-700 hover:text-red-800" onClick={() => setRecForm({ ...recForm, lines: recForm.lines.filter((_, i) => i !== idx) })} disabled={recForm.lines.length <= 1}>×</Button>
                    </div>
                    {/* OPS-9: mark a line as sub-recipe of another line (same menu item) */}
                    {recForm.lines.length > 1 && (
                      <div className="flex items-center gap-1.5 pl-1">
                        <span className="text-[10px] text-stone-400 shrink-0">{t('recipe.parentOf')}</span>
                        <Select value={line.parent || '__none__'} onValueChange={(v) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, parent: v === '__none__' ? '' : v } : l) })}>
                          <SelectTrigger className="h-7 flex-1 text-[11px]"><SelectValue /></SelectTrigger>
                          <SelectContent className="max-h-72">
                            <SelectItem value="__none__">{t('recipe.parentNone')}</SelectItem>
                            {recForm.lines.map((l, i) => (i !== idx && l.inventoryItemId && l.inventoryItemId !== line.inventoryItemId) ? (
                              <SelectItem key={i} value={l.inventoryItemId}>
                                {items.find((it) => it.id === l.inventoryItemId)?.name || l.inventoryItemId}
                              </SelectItem>
                            ) : null)}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setRecForm({ ...recForm, lines: [...recForm.lines, { inventoryItemId: items[0]?.id || '', qty: '', yield: '100', parent: '' }] })}><Plus className="w-3 h-3" /> {t('inv.addIngredient')}</Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecForm(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={recBusy || !recForm?.menuItemId || recForm.lines.some((l) => !l.inventoryItemId || !(Number(l.qty.replace(',', '.')) > 0) || yieldInvalid(l.yield))} onClick={saveRecipe}>{t('inv.saveRecipe')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nov artikel zaloge */}
      <Dialog open={addItem} onOpenChange={(v) => !v && setAddItem(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('inv.newItemTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ni-name">{t('inv.name')}</Label>
              <Input id="ni-name" value={ni.name} onChange={(e) => setNi({ ...ni, name: e.target.value })} placeholder={t('inv.namePlaceholder')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ni-unit">{t('inv.unit')}</Label>
                <Select value={ni.unit} onValueChange={(v) => setNi({ ...ni, unit: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['kg', 'l', 'pcs', 'g', 'ml'].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ni-qty">{t('inv.initQty')}</Label>
                <Input id="ni-qty" inputMode="decimal" value={ni.qty} onChange={(e) => setNi({ ...ni, qty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ni-min">{t('inv.minQty')}</Label>
                <Input id="ni-min" inputMode="decimal" value={ni.minQty} onChange={(e) => setNi({ ...ni, minQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ni-cost">{t('inv.costPerUnit')}</Label>
                <Input id="ni-cost" inputMode="decimal" value={ni.cost} onChange={(e) => setNi({ ...ni, cost: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0.00" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddItem(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={niBusy || !ni.name} onClick={createItem}>{niBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('inv.saveItem')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Prilagoditev zaloge */}
      <Dialog open={!!adjust} onOpenChange={(v) => !v && setAdjust(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('inv.adjustTitle', { name: adjust?.name ?? '' })}</DialogTitle></DialogHeader>
          {adjust && (
            <div className="space-y-3">
              <p className="text-xs text-stone-500">{t('inv.currentStock')} <b>{adjust.qty} {adjust.unit}</b></p>
              <div className="space-y-1.5">
                <Label htmlFor="adj-delta">{t('inv.deltaLabel', { unit: adjust.unit })}</Label>
                <Input id="adj-delta" inputMode="decimal" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value.replace(/[^\d.,-]/g, '').replace(',', '.') })} placeholder={t('inv.deltaPlaceholder')} />
                <p className="text-[11px] text-stone-400">{t('inv.deltaHint')}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="adj-set">{t('inv.setQtyTo')}</Label>
                  <Input id="adj-set" inputMode="decimal" value={adj.setQty} onChange={(e) => setAdj({ ...adj, setQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-min">{t('inv.minQty')}</Label>
                  <Input id="adj-min" inputMode="decimal" value={adj.minQty} onChange={(e) => setAdj({ ...adj, minQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adj-cost">{t('inv.costPerUnit')}</Label>
                <Input id="adj-cost" inputMode="decimal" value={adj.cost} onChange={(e) => setAdj({ ...adj, cost: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjust(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={adjBusy} onClick={saveAdjust}>{adjBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('inv.saveAdjust')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nov dobavitelj */}
      <Dialog open={!!supForm} onOpenChange={(v) => !v && setSupForm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('inv.newSupplier')}</DialogTitle></DialogHeader>
          {supForm && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sup-name">{t('inv.name')}</Label>
                <Input id="sup-name" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} placeholder={t('inv.supplierNamePlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sup-contact">{t('inv.contactPerson')}</Label>
                  <Input id="sup-contact" value={supForm.contact} onChange={(e) => setSupForm({ ...supForm, contact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sup-phone">{t('inv.phone')}</Label>
                  <Input id="sup-phone" value={supForm.phone} onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupForm(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={supBusy || !supForm?.name} onClick={createSupplier}>{supBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('inv.saveSupplier')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export interface ShiftT { id: string; employeeId?: string | null; employee?: { name: string; role: string } | null; startedAt: string; endedAt?: string | null; openingCash: number; closingCash: number; status: string }
export interface FinancialT { today: { revenue: number; tax: number; invoices: number }; month: { revenue: number; tax: number; invoices: number; expenses: number; profit: number }; taxBreakdown: { taxRate: number; qty: number }[] }

export function ShiftsTab({ shifts, financial, canManage, onReload }: { shifts: ShiftT[]; financial: FinancialT | null; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [cash, setCash] = useState('')
  const [busy, setBusy] = useState(false)
  const openShift = shifts.find((s) => s.status === 'open')
  // OPS-7 (v1.70.0): Z poročilo po zaključku izmene (Lightspeed vzorec — pokaži povzetek)
  const [zRep, setZRep] = useState<{ totalSales: number; cash: number; card: number; totalTax: number; receipts: number; totalStorno: number; cashDifference: number } | null>(null)

  async function startShift() {
    setBusy(true)
    try { await api('/api/shifts', { method: 'POST', body: JSON.stringify({ openingCash: Number(cash) || 0 }) }); setCash(''); await onReload() }
    catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }
  async function stopShift() {
    setBusy(true)
    try {
      const d = await api<{ zReport: { totalSales: number; cash: number; card: number; totalTax: number; receipts: number; totalStorno: number; cashDifference: number } | null }>('/api/shifts', { method: 'POST', body: JSON.stringify({ action: 'stop', closingCash: Number(cash) || 0 }) })
      setCash('')
      if (d.zReport) setZRep(d.zReport)
      await onReload()
    }
    catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> {t('shifts.revenueMonth')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.revenue) : '—'}</p><p className="text-xs text-stone-400">{t('shifts.tax')} {financial ? fmtEUR(financial.month.tax) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> {t('exp.month')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.expenses) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.profitMonth')}</CardTitle></CardHeader><CardContent><p className={`text-xl font-bold ${(financial?.month.profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{financial ? fmtEUR(financial.month.profit) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.invoicesMonth')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial?.month.invoices ?? '—'}</p></CardContent></Card>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> {t('shifts.revenueToday')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.today.revenue) : '—'}</p><p className="text-xs text-stone-400">{t('shifts.todayDetail', { n: financial?.today.invoices ?? '—', tax: financial ? fmtEUR(financial.today.tax) : '—' })}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-3"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.taxBreakdown')}</CardTitle></CardHeader><CardContent>
          {!financial || financial.taxBreakdown.length === 0 ? <p className="text-sm text-stone-500">{t('shifts.noTraffic')}</p> : (
            <div className="flex flex-wrap gap-2">
              {financial.taxBreakdown.map((tb) => (
                <Badge key={tb.taxRate} variant="outline" className="text-sm px-2.5 py-1">{t('shifts.vatBadge', { rate: tb.taxRate, qty: tb.qty })}</Badge>
              ))}
            </div>
          )}
        </CardContent></Card>
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => {
          if (!financial) return
          const d = new Date()
          downloadCSV(`porocilo-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
            [t('shifts.csvTitle'), new Date().toLocaleDateString('sl-SI')],
            [],
            [t('shifts.csvPeriod'), t('shifts.csvRevenue'), t('shifts.csvTax'), t('shifts.csvExpenses'), t('shifts.csvProfit'), t('shifts.csvInvoices')],
            [t('shifts.csvToday'), financial.today.revenue, financial.today.tax, '', '', financial.today.invoices],
            [t('shifts.csvMonth'), financial.month.revenue, financial.month.tax, financial.month.expenses, financial.month.profit, financial.month.invoices],
            [],
            [t('shifts.csvTaxRate'), t('shifts.csvItems')],
            ...financial.taxBreakdown.map((t) => [t.taxRate, t.qty]),
            [],
            [t('shifts.csvShift'), t('shifts.csvEmployee'), t('shifts.csvRole'), t('shifts.csvStart'), t('shifts.csvEnd'), t('shifts.csvOpening'), t('shifts.csvClosing'), t('shifts.csvStatus')],
            ...shifts.map((s) => [s.id, s.employee?.name || '', s.employee?.role || '', s.startedAt, s.endedAt || '', s.openingCash, s.closingCash, s.status]),
          ])
        }}>
          {t('shifts.exportCsv')}
        </Button>
      </div>

      {/* OPS-7: Z poročilo po zaključku izmene */}
      <Dialog open={!!zRep} onOpenChange={(v) => !v && setZRep(null)}>
        <DialogContent className="max-w-sm" aria-describedby={undefined}>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600" /> {t('zrep.title')}</DialogTitle></DialogHeader>
          {zRep && (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span>{t('zrep.sales')}</span><b>{fmtEUR(zRep.totalSales)}</b></div>
              <div className="flex justify-between"><span>{t('zrep.tax')}</span><span>{fmtEUR(zRep.totalTax)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.cash')}</span><span>{fmtEUR(zRep.cash)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.card')}</span><span>{fmtEUR(zRep.card)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.receipts')}</span><span>{zRep.receipts}</span></div>
              {zRep.totalStorno > 0 && <div className="flex justify-between text-red-600"><span>{t('zrep.storno')}</span><span>−{fmtEUR(zRep.totalStorno)}</span></div>}
              <div className={`flex justify-between border-t border-stone-200 pt-1 ${Math.abs(zRep.cashDifference) >= 0.01 ? 'text-amber-700 font-semibold' : 'text-stone-500'}`}><span>{t('zrep.diff')}</span><span>{fmtEUR(zRep.cashDifference)}</span></div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setZRep(null)}>{t('zrep.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4" /> {openShift ? t('shifts.openShift', { name: openShift.employee?.name || '' }) : t('shifts.noOpenShift')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="cash">{openShift ? t('shifts.closingCashLabel') : t('shifts.openingCashLabel')}</Label>
              <Input id="cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0.00" className="w-44" />
            </div>
            {openShift ? (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={stopShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('shifts.stopShift')}</Button>
            ) : (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={startShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('shifts.startShift')}</Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('shifts.recent')}</CardTitle></CardHeader>
        <CardContent>
          {shifts.length === 0 && <p className="text-sm text-stone-500">{t('shifts.none')}</p>}
          <ScrollArea className="max-h-80">
            <div className="space-y-2">
              {shifts.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.employee?.name || '—'} <span className="text-xs text-stone-400">· {s.employee?.role || ''}</span></p>
                    <p className="text-xs text-stone-500">{new Date(s.startedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{s.endedAt ? ` → ${new Date(s.endedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-stone-500">{t('shifts.opening')} {fmtEUR(s.openingCash)}</span>
                    {s.status === 'closed' && <span className="text-xs font-semibold">{t('shifts.closing')} {fmtEUR(s.closingCash)}</span>}
                    <Badge className={s.status === 'open' ? 'bg-amber-600 text-white' : 'bg-stone-500 text-white'}>{s.status === 'open' ? t('shifts.openF') : t('shifts.closedF')}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

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

/* ─────────────────────────── STROŠKI ─────────────────────────── */

export interface ExpenseT {
  id: string
  category: string
  description: string
  amount: number
  paidAt: string
  status?: string
  apNumber?: string
  dueDate?: string | null
  paidAmount?: number
  supplierName?: string | null
}

/**
 * Task 61 (revizija §7 vrstica 122): admin nadzor nad stroški — prej samo vnos+seznam (PARTIAL),
 * zdaj: urejanje (dialog), plačilo/odprtje, mehko preklicanje (status 'void') + status
 * oznake + zapadlost KPI. API: PATCH/DELETE /api/expenses/[id] (settings.manage +
 * lokacijski gate). Knjigovodska varnost: znesek plačanega zapisa se ureja šele po
 * odprtju plačila (backend 409) — UI onemogoči vnos v dialogu.
 *
 * Task 67 (v1.65.0): kategorije stroškov (runtime-gated na categoriesEnabled — API
 * vrne true, ko stolpec AccountsPayable.category obstaja; do uporabnikovega DDL klika
 * se UI polja/filter NE prikažejo). Vnos: datalist iz obstoječih kategorij (prost
 * tekst, ≤60), urejanje + brisanje kategorije v dialogu, oznaka v seznamu + filter.
 */
/** OPS-10 val 3 — archived eSLOG attachment (server shape, src/lib/ap-attachments.ts). */
interface ApAttT { mimeCode: string; filename: string; sizeB: number; dataBase64?: string }

export function ExpensesTab({ expenses, canManage, onReload, categoriesEnabled }: { expenses: ExpenseT[]; canManage: boolean; onReload: () => Promise<void>; categoriesEnabled?: boolean }) {
  const { t } = useI18n()
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ description: '', amount: '', dueDate: '', category: '' })
  const [catFilter, setCatFilter] = useState('all')
  const [err, setErr] = useState('')

  // OPS-10 val 3 — eSLOG attachment archive (lazy badge index + per-AP dialog)
  const [attIndex, setAttIndex] = useState<Record<string, number>>({})
  const [attDialog, setAttDialog] = useState<{ apNumber: string; description: string } | null>(null)
  const [attList, setAttList] = useState<ApAttT[] | null>(null)
  const [attTruncated, setAttTruncated] = useState(false)
  const [attBusy, setAttBusy] = useState(false)
  const [attErr, setAttErr] = useState('')
  const [attPreview, setAttPreview] = useState<{ name: string; uri: string } | null>(null)

  useEffect(() => {
    let alive = true
    api<{ attachmentsIndex: Record<string, number> }>('/api/expenses?attachmentsIndex=1')
      .then((r) => { if (alive) setAttIndex(r.attachmentsIndex || {}) })
      .catch(() => { /* best-effort badge index */ })
    return () => { alive = false }
  }, [])

  const openAttachments = async (apNumber: string, description: string) => {
    setAttDialog({ apNumber, description }); setAttList(null); setAttErr(''); setAttTruncated(false); setAttPreview(null)
    setAttBusy(true)
    try {
      const r = await api<{ attachments: ApAttT[]; truncated: boolean }>(`/api/expenses?withAttachments=1&apNumber=${encodeURIComponent(apNumber)}`)
      setAttList(r.attachments || [])
      setAttTruncated(r.truncated === true)
    } catch (e) {
      setAttErr(String((e as Error).message || e))
    } finally { setAttBusy(false) }
  }

  const monthTotal = expenses
    .filter((e) => e.status !== 'void' && new Date(e.paidAt).getMonth() === new Date().getMonth() && new Date(e.paidAt).getFullYear() === new Date().getFullYear())
    .reduce((s, e) => s + e.amount, 0)
  const openTotal = expenses.filter((e) => e.status === 'open').reduce((s, e) => s + e.amount, 0)
  const overdueCount = expenses.filter((e) => e.status === 'open' && e.dueDate && new Date(e.dueDate) < new Date()).length
  const isPaid = (e: ExpenseT) => e.status === 'paid' || (e.paidAmount ?? 0) >= e.amount
  // Task 67: distinct kategorije (iz GET okna) + klienti filter prikaza
  const categories = categoriesEnabled
    ? Array.from(new Set(expenses.map((e) => e.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sl'))
    : []
  const visible = catFilter && catFilter !== 'all' ? expenses.filter((e) => e.category === catFilter) : expenses

  function openEdit(e: ExpenseT) {
    setEditId(e.id)
    setEditForm({
      description: e.description,
      amount: String(e.amount).replace('.', ','),
      dueDate: e.dueDate ? new Date(e.dueDate).toISOString().slice(0, 10) : '',
      category: e.category && e.category !== 'OSTALO' ? e.category : '',
    })
    setErr('')
    setOpen(true)
  }

  async function saveEdit() {
    if (!editId) return
    const amt = Number(editForm.amount.replace(',', '.'))
    setBusy(true); setErr('')
    try {
      await api(`/api/expenses/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: editForm.description,
          amount: amt,
          dueDate: editForm.dueDate || undefined,
          // Task 67: kategorija samo ko je funkcija aktivna ('' = brisanje)
          ...(categoriesEnabled ? { category: editForm.category.trim() } : {}),
        }),
      })
      setOpen(false); await onReload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function togglePaid(e: ExpenseT) {
    setBusy(true); setErr('')
    try {
      await api(`/api/expenses/${e.id}`, { method: 'PATCH', body: JSON.stringify({ status: isPaid(e) ? 'open' : 'paid' }) })
      await onReload()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function remove(e: ExpenseT) {
    if (!window.confirm(t('exp.deleteConfirm', { d: e.description }))) return
    setBusy(true); setErr('')
    try { await api(`/api/expenses/${e.id}`, { method: 'DELETE' }); await onReload() }
    catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function submit() {
    setBusy(true)
    try {
      await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          description,
          amount: Number(amount.replace(',', '.')),
          // Task 67: kategorija samo ko je funkcija aktivna
          ...(categoriesEnabled && category.trim() ? { category: category.trim() } : {}),
        }),
      })
      setDescription(''); setAmount(''); setCategory(''); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  const statusBadge = (e: ExpenseT) => {
    if (e.status === 'void') return <Badge variant="outline" className="text-stone-400 line-through">{t('exp.statusVoid')}</Badge>
    if (isPaid(e)) return <Badge className="bg-emerald-700 text-white">{t('exp.statusPaid')}</Badge>
    if (e.dueDate && new Date(e.dueDate) < new Date()) return <Badge variant="outline" className="text-red-600 border-red-300">{t('exp.statusOverdue')}</Badge>
    return <Badge variant="outline" className="text-amber-700 border-amber-300">{t('exp.statusOpen')}</Badge>
  }

  // OPS-10 val 3 — human attachment size (B/KB/MB)
  const fmtSize = (b: number) => {
    if (!Number.isFinite(b) || b <= 0) return '0 B'
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(Math.round((b / 1024) * 10) / 10).toFixed(1)} KB`
    return `${(Math.round((b / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`
  }
  const attUri = (a: ApAttT) => `data:${a.mimeCode || 'application/octet-stream'};base64,${a.dataBase64 || ''}`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> {t('exp.month')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(monthTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Hourglass className="w-4 h-4" /> {t('exp.kpiOpen')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(openTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('exp.kpiOverdue')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{overdueCount}</p></CardContent></Card>
      </div>

      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {canManage && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('exp.new')}</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 min-w-48 flex-1">
              <Label htmlFor="ex-desc">{t('exp.description')}</Label>
              <Input id="ex-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('exp.descPlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ex-amount">{t('exp.amount')}</Label>
              <Input id="ex-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0.00" className="w-32" />
            </div>
            {categoriesEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-cat">{t('exp.category')}</Label>
                <Input id="ex-cat" list="ex-cats" value={category} onChange={(e) => setCategory(e.target.value.slice(0, 60))} placeholder={t('exp.categoryPlaceholder')} className="w-44" maxLength={60} />
                <datalist id="ex-cats">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            )}
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !description || !(Number(amount.replace(',', '.')) > 0)} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('exp.submit')}</Button>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => {
          const d = new Date()
          downloadCSV(`stroski-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
            [t('exp.csvDate'), t('exp.description'), t('exp.csvCategory'), t('exp.csvAmount')],
            ...expenses.map((e) => [new Date(e.paidAt).toLocaleDateString('sl-SI'), e.description, e.category || '', e.amount]),
          ])
        }}>
          {t('exp.exportCsv')}
        </Button>
      </div>
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('exp.title')}</CardTitle>
          <div className="flex items-center gap-3">
            {categories.length > 0 && (
              <Select value={catFilter} onValueChange={setCatFilter}>
                <SelectTrigger className="h-8 w-44 text-xs" aria-label={t('exp.category')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('exp.allCategories')}</SelectItem>
                  {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <span className="text-xs text-stone-500">{t('exp.totalRecords')}: {visible.length}{catFilter !== 'all' ? ` / ${expenses.length}` : ''}</span>
          </div>
        </CardHeader>
        <CardContent>
          {visible.length === 0 && <p className="text-sm text-stone-500">{t('exp.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="space-y-2">
              {visible.map((e) => {
                const voided = e.status === 'void'
                return (
                  <div key={e.id} className={`rounded-lg border p-3 flex flex-wrap items-center justify-between gap-2 ${voided ? 'border-stone-200 bg-stone-50 opacity-70' : 'border-stone-200 bg-white'}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={`font-medium truncate ${voided ? 'line-through text-stone-400' : ''}`}>{e.description}</p>
                        {statusBadge(e)}
                        {categoriesEnabled && e.category && e.category !== 'OSTALO' && <Badge variant="outline" className="text-stone-600 border-stone-300">{e.category}</Badge>}
                        {/* OPS-10 val 3 — archived eSLOG attachments (click opens the preview dialog) */}
                        {e.apNumber && (attIndex[e.apNumber] || 0) > 0 && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-700 hover:bg-stone-100"
                            onClick={() => void openAttachments(e.apNumber as string, e.description)}
                            aria-label={t('apatt.badge', { n: attIndex[e.apNumber] })}
                          >
                            <Paperclip className="w-3 h-3" /> {t('apatt.badge', { n: attIndex[e.apNumber] })}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-stone-500 mt-1">
                        {new Date(e.paidAt).toLocaleDateString('sl-SI')}
                        {e.supplierName ? ` · ${e.supplierName}` : ''}
                        {e.apNumber ? ` · ${e.apNumber}` : ''}
                        {e.dueDate && !voided && !isPaid(e) ? ` · ${t('exp.dueDate')}: ${new Date(e.dueDate).toLocaleDateString('sl-SI')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <p className={`font-bold ${voided ? 'line-through text-stone-400' : ''}`}>{fmtEUR(e.amount)}</p>
                      {canManage && !voided && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => void togglePaid(e)} disabled={busy} aria-label={isPaid(e) ? t('exp.markOpen') : t('exp.markPaid')}>
                            {isPaid(e) ? <RotateCcw className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openEdit(e)} disabled={busy} aria-label={t('exp.editAria', { d: e.description })}><Pencil className="w-4 h-4" /></Button>
                          <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" onClick={() => void remove(e)} disabled={busy} aria-label={t('exp.deleteAria', { d: e.description })}><Trash2 className="w-4 h-4" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('exp.editTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ex-edit-desc">{t('exp.description')}</Label>
              <Input id="ex-edit-desc" value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} maxLength={120} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-amount">{t('exp.amount')}</Label>
                <Input id="ex-edit-amount" inputMode="decimal" value={editForm.amount} onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-due">{t('exp.dueDate')}</Label>
                <Input id="ex-edit-due" type="date" value={editForm.dueDate} onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))} />
              </div>
            </div>
            {categoriesEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-cat">{t('exp.category')}</Label>
                <Input id="ex-edit-cat" list="ex-cats-edit" value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value.slice(0, 60) }))} placeholder={t('exp.categoryPlaceholder')} maxLength={60} />
                <datalist id="ex-cats-edit">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            )}
            {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t('exp.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !editForm.description.trim() || !(Number(editForm.amount.replace(',', '.')) > 0)} onClick={saveEdit}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('exp.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OPS-10 val 3 — attachment archive dialog (list + inline PDF preview + download) */}
      <Dialog open={!!attDialog} onOpenChange={(v) => { if (!v) { setAttDialog(null); setAttPreview(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><Paperclip className="w-4 h-4" /> {t('apatt.title')}</DialogTitle>
            <CardDescription>{attDialog?.description}{attDialog ? ` · ${attDialog.apNumber}` : ''}</CardDescription>
          </DialogHeader>
          <div className="space-y-3">
            {attBusy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('apatt.loading')}</p>}
            {attErr && <p role="alert" className="text-sm text-red-600">{attErr}</p>}
            {attList !== null && attList.length === 0 && <p className="text-sm text-stone-500">{t('apatt.none')}</p>}
            {attList !== null && attList.length > 0 && (
              <div className="space-y-2">
                {attList.map((a, i) => (
                  <div key={`${a.filename}-${i}`} className="rounded-lg border border-stone-200 p-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate max-w-56" title={a.filename || '(brez imena)'}>{a.filename || '(brez imena)'}</p>
                      <p className="text-xs text-stone-500">{a.mimeCode || '—'} · {fmtSize(a.sizeB)}{!a.dataBase64 ? ` · ${t('apatt.metaOnly')}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {a.dataBase64 && (a.mimeCode || '').includes('pdf') && (
                        <Button size="sm" variant="outline" onClick={() => setAttPreview({ name: a.filename || 'priloga.pdf', uri: attUri(a) })}>
                          <Eye className="w-3.5 h-3.5" /> {t('apatt.preview')}
                        </Button>
                      )}
                      {a.dataBase64 && (
                        <a href={attUri(a)} download={a.filename || 'priloga'} className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-stone-200 bg-white px-3 text-xs font-medium hover:bg-stone-50">
                          <Download className="w-3.5 h-3.5" /> {t('apatt.download')}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
                {attTruncated && <p className="text-xs text-amber-700">{t('apatt.truncated')}</p>}
                <p className="text-[11px] text-stone-400">{t('apatt.retention')}</p>
              </div>
            )}
            {attPreview && (
              <div className="rounded-lg border border-stone-200 overflow-hidden">
                <div className="flex items-center justify-between gap-2 bg-stone-50 px-2.5 py-1.5">
                  <span className="text-xs font-medium truncate">{attPreview.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => setAttPreview(null)} aria-label={t('apatt.closePreview')}>{t('apatt.closePreview')}</Button>
                </div>
                <iframe src={attPreview.uri} title={attPreview.name} className="w-full h-72 bg-white" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAttDialog(null); setAttPreview(null) }}>{t('exp.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

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

  const active = orders.filter((o) => !['PAID', 'CANCELLED'].includes(o.status) && o.delivery && o.delivery.status !== 'DELIVERED' && o.delivery.status !== 'CANCELLED')
  const history = orders.filter((o) => !active.includes(o))

  async function transition(o: DeliveryOrderT, to: string, extra?: { driverName?: string; driverPhone?: string; note?: string }) {
    setBusy(o.id)
    try {
      await api('/api/delivery', {
        method: 'PATCH',
        body: JSON.stringify({ orderId: o.id, status: to, ...extra }),
      })
      await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(null) }
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
    } catch (err) { alert((err as Error).message) } finally { setBusy(null) }
  }

  async function toggleZone(z: DeliveryZoneT) {
    setBusy(z.id)
    try {
      await api('/api/delivery/zones', { method: 'PATCH', body: JSON.stringify({ id: z.id, isActive: !z.isActive }) })
      await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(null) }
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
            const d = o.delivery!
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
                  {o.fursEor && <p className="text-[11px] text-stone-400">FURS EOR: {o.fursEor}</p>}
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
                        <Badge className={DELIVERY_STATUS_BG[d?.status || ''] || 'bg-stone-400 text-white'}>{DELIVERY_STATUS_KEYS[d?.status || ''] ? t(DELIVERY_STATUS_KEYS[d?.status || '']) : d?.status || o.status}</Badge>
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
                {t('dost.noIntegrationA')} <code className="text-xs bg-stone-100 px-1 rounded">glovo</code>{t('dost.or')} <code className="text-xs bg-stone-100 px-1 rounded ml-1">wolt</code> {t('dost.noIntegrationB')} <code className="text-xs bg-stone-100 px-1 rounded">/api/delivery/webhook/glovo</code>, <code className="text-xs bg-stone-100 px-1 rounded">/api/delivery/webhook/wolt</code>.
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
                            <p key={l.id} className="text-xs text-red-700 bg-red-50 rounded px-2 py-1 truncate">
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
                } catch (err) { alert((err as Error).message) } finally { setBusy(null) }
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
                  <Row key={v.rate} sub label={`${t('acct.xzVatRate')} ${v.rate}%`} value={fmtEUR(v.amount)} />
                ))}
                <Row label={t('acct.xzDiscounts')} value={fmtEUR(xzPreview.discountsTotal)} />
                <Row label={t('acct.xzTips')} value={fmtEUR(xzPreview.tipsTotal)} />
                <Row label={t('acct.xzVoided')} value={String(xzPreview.voidedCount)} />
                <Row label={t('acct.xzVoidedTotal')} value={fmtEUR(xzPreview.voidedTotal)} />
                <Row label={t('acct.xzWaste')} value={fmtEUR(xzPreview.wasteTotal)} />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('acct.xzPayments')}</p>
                {xzPreview.paymentsByMethod.length === 0 ? (
                  <p className="text-xs text-stone-400">{t('common.none')}</p>
                ) : (
                  xzPreview.paymentsByMethod.map((p) => <Row key={p.method} sub label={p.method} value={fmtEUR(p.amount)} />)
                )}
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t('acct.xzGuests')}</p>
                <Row label={t('acct.xzCovers')} value={String(xzPreview.covers)} />
                <Row label={t('acct.xzAvgCheck')} value={fmtEUR(xzPreview.avgCheck)} />
                <Row label={t('acct.xzAvgParty')} value={xzPreview.avgPartySize.toLocaleString('sl-SI', { minimumFractionDigits: 2 })} />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
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
                        <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">{t('gl.previewBadge')}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-stone-500 mb-2">{e.memo}</p>
                    <div className="space-y-0.5">
                      <div className="grid grid-cols-[1fr_5rem_5rem] gap-2 text-[10px] uppercase tracking-wide text-stone-400 font-medium">
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

/* ─────────────────────────── NABAVA (triage ② — dobavitelji → naročila → prevzem) ─────────────────────────── */
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


/* ─────────────────────────── AUDIT-FIX v1.82.1 — RAZREZ MONOLITA (prvi val) ───────────────────────────
 * dashboard-tabs.tsx (9217 → ~6600 vrst.): dve domeni izluščeni v src/components/tabs/:
 *   - tabs/ops-cards.tsx  (~1230 vrst.): SalesByHourCard, LaborCostCard, DursCheckButton,
 *     NotificationsCard, BatchesCard, BatchPrepCard, UpsellCard, DisplayPromosCard
 *   - tabs/nabava-tab.tsx (~1380 vrst.): NabavaTab (+ zasebni tipi/helperji)
 * Ta modul ostaja KANONIČNI barrel — vsi obstoječi uvozi (@/components/dashboard-tabs)
 * delujejo nespremenjeno (re-export). Interni uvozi zgoraj pokrivajo preostale
 * med-komponentne reference (SettingsEditor→DursCheckButton, InventoryTab→Batches/BatchPrep).
 * Naslednji valovi: DarilneKarticeTab, DelovniCasTab, CakalnaListaTab, IntegracijeTab …
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

