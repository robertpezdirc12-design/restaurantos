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
  Tooltip as RTooltip, ReferenceLine, Legend,
} from 'recharts'
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'

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

interface NabavaSupplier {
  id: string; name: string; contact?: string | null; phone?: string | null; email?: string | null; address?: string | null
  code?: string | null; city?: string | null; country?: string | null; taxId?: string | null; iban?: string | null; paymentTerms?: string | null
  isActive: boolean; purchaseOrdersCount: number; itemsCount: number
}
interface NabavaInvItem { id: string; name: string; unit: string; qty: number; minQty: number; cost: number; locationId?: string | null }
interface NabavaPoItem { id: string; description: string; quantityOrdered: number; quantityReceived: number; quantityRejected: number; unit: string; unitPrice: number; vatRate: number; totalPrice: number; status: string; inventoryItemId?: string | null }
interface NabavaPo {
  id: string; poNumber: string; status: string; supplierId: string; supplierName: string
  orderDate: string; expectedDate?: string | null; receivedDate?: string | null
  subtotal: number; vatAmount: number; totalAmount: number; locationId?: string | null
  notes?: string | null; requestedBy?: string | null; approvedBy?: string | null
  receiptsCount: number; items: NabavaPoItem[]
}
interface NabavaPoDetail {
  id: string; poNumber: string; status: string
  supplier?: { id: string; name: string; contactPerson?: string | null; email?: string | null; phone?: string | null } | null
  orderDate: string; expectedDate?: string | null; receivedDate?: string | null
  subtotal: number; vatAmount: number; totalAmount: number; notes?: string | null
  requestedBy?: string | null; approvedBy?: string | null
  items: NabavaPoItem[]
  receipts: { id: string; grnNumber: string; status: string; supplierDocNumber?: string | null; notes?: string | null; receivedByName?: string | null; receivedAt?: string | null; items: { description: string; quantityAccepted: number; quantityRejected: number; rejectReason?: string | null; unit: string }[] }[]
  priceHistory: { inventoryItemId: string | null; unitPrice: number; vatRate: number | null; unit: string; source: string; observedAt: string }[]
}
interface NabavaSupForm { editingId: string | null; name: string; contact: string; phone: string; email: string; address: string; city: string; taxId: string; iban: string; paymentTerms: string }
interface NabavaNewLine { inventoryItemId: string; description: string; quantity: string; unit: string; unitPrice: string; vatRate: string }
interface NabavaRecvLine { accept: string; reject: string; reason: string; expiry: string }
interface NabavaSuggestion { itemId: string; itemName: string; unit: string; qty: number; par: number; incoming: number; suggested: number; supplierId: string | null; supplierName: string; costEstimate: number }
interface NabavaSuggGroup { supplierId: string | null; supplierName: string; items: NabavaSuggestion[]; total: number }
/** OPS-9 val 2 — recurring PO rule (server shape, src/lib/recurring-po.ts). */
interface RecRuleT {
  id: string; supplierId: string
  items: { inventoryItemId: string; qty: number }[]
  weekdays: number[]; hour: number; everyWeeks: number
  active: boolean; lastRun: string | null; nextRun: string | null
}
/** Display order for weekday toggles: Monday-first (0 = Sunday, JS getDay). */
const REC_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const NABAVA_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'proc.stDraft', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  submitted: { label: 'proc.stSubmitted', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  approved: { label: 'proc.stApproved', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  partial: { label: 'proc.stPartial', cls: 'border-orange-300 bg-orange-100 text-orange-800' },
  received: { label: 'proc.stReceived', cls: 'border-green-300 bg-green-100 text-green-800' },
  cancelled: { label: 'proc.stCancelled', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const NABAVA_ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'proc.itPending', cls: 'border-stone-300 text-stone-600' },
  partial: { label: 'proc.itPartial', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  received: { label: 'proc.itReceived', cls: 'border-green-300 bg-green-50 text-green-800' },
}

const nabavaNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
const nabavaDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('sl-SI') : '—')

export function NabavaTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useI18n()
  const [suppliers, setSuppliers] = useState<NabavaSupplier[]>([])
  const [invItems, setInvItems] = useState<NabavaInvItem[]>([])
  const [orders, setOrders] = useState<NabavaPo[]>([])
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // — Dobavitelji (dodaj / uredi) —
  const [supDialog, setSupDialog] = useState<NabavaSupForm | null>(null)
  const [supBusy, setSupBusy] = useState(false)
  const [supErr, setSupErr] = useState('')

  // — Novo nabavno naročilo —
  const [poDialog, setPoDialog] = useState(false)
  const [poSupplierId, setPoSupplierId] = useState('')
  const [poLocationId, setPoLocationId] = useState('')
  const [poExpected, setPoExpected] = useState('')
  const [poNotes, setPoNotes] = useState('')
  const [poLines, setPoLines] = useState<NabavaNewLine[]>([])
  const [poBusy, setPoBusy] = useState(false)
  const [poErr, setPoErr] = useState('')

  // — Detajl naročila —
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<NabavaPoDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailErr, setDetailErr] = useState('')

  // — Prevzem (GRN) —
  const [recvOrder, setRecvOrder] = useState<NabavaPo | null>(null)
  const [recvLines, setRecvLines] = useState<Record<string, NabavaRecvLine>>({})
  const [recvDoc, setRecvDoc] = useState('')
  const [recvNotes, setRecvNotes] = useState('')
  const [recvBusy, setRecvBusy] = useState(false)
  const [recvErr, setRecvErr] = useState('')
  const [recvDone, setRecvDone] = useState<{ grnNumber: string; warnings: string[] } | null>(null)

  // — Reorder suggestions (OPS-8 val 2) —
  const [suggGroups, setSuggGroups] = useState<NabavaSuggGroup[]>([])
  const [suggLoading, setSuggLoading] = useState(true)
  const [suggErr, setSuggErr] = useState('')

  // — eSLOG e-invoice import (OPS-9 val 2) —
  const [eslogFile, setEslogFile] = useState<File | null>(null)
  const [eslogBusy, setEslogBusy] = useState(false)
  const [eslogResult, setEslogResult] = useState<{ apNumber: string; supplierName: string; totalAmount: number; dueDate: string; lines: number } | null>(null)
  const [eslogWarn, setEslogWarn] = useState<{ error: string; supplierName?: string; taxId?: string } | null>(null)
  const [eslogDup, setEslogDup] = useState('')

  // — Recurring purchase orders (OPS-9 val 2) —
  const [recRules, setRecRules] = useState<RecRuleT[]>([])
  const [recLoading, setRecLoading] = useState(true)
  const [recBusy, setRecBusy] = useState(false)
  const [recErr, setRecErr] = useState('')
  const [recDialog, setRecDialog] = useState(false)
  const [recSupplierId, setRecSupplierId] = useState('')
  const [recItemId, setRecItemId] = useState('')
  const [recItems, setRecItems] = useState<{ inventoryItemId: string; name: string; qty: string }[]>([])
  const [recWeekdays, setRecWeekdays] = useState<number[]>([1])
  const [recHour, setRecHour] = useState('8')
  const [recEvery, setRecEvery] = useState('1')
  const recTriggered = useRef(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [s, inv, o, sg] = await Promise.all([
          api<{ suppliers: NabavaSupplier[] }>('/api/suppliers'),
          api<{ inventory: NabavaInvItem[] }>('/api/inventory'),
          api<{ orders: NabavaPo[] }>('/api/purchase-orders'),
          api<{ groupedBySupplier: NabavaSuggGroup[] }>('/api/purchase-orders/suggestions').catch(() => ({ groupedBySupplier: [] as NabavaSuggGroup[] })),
        ])
        if (!alive) return
        setSuppliers(s.suppliers || [])
        setInvItems(inv.inventory || [])
        setOrders(o.orders || [])
        setSuggGroups(sg.groupedBySupplier || [])
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) { setLoading(false); setSuggLoading(false) }
      }
    })()
    return () => { alive = false }
  }, [])

  const loadOrders = async () => {
    const o = await api<{ orders: NabavaPo[] }>('/api/purchase-orders')
    setOrders(o.orders || [])
  }
  const loadSuppliers = async () => {
    const s = await api<{ suppliers: NabavaSupplier[] }>('/api/suppliers')
    setSuppliers(s.suppliers || [])
  }
  /* OPS-9 val 2 — recurring rules list */
  const loadRecRules = async () => {
    const r = await api<{ rules: RecRuleT[] }>('/api/recurring-po')
    setRecRules(r.rules || [])
  }
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await loadRecRules()
      } catch (e) {
        if (alive) setRecErr(String((e as Error).message || e))
      } finally {
        if (alive) setRecLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])
  /* OPS-9 val 2 — lazy trigger: evaluate due recurring rules once per tab mount.
   * Fire-and-forget; when drafts were created the order list refreshes silently.
   * Users without inventory.manage get a silent 403 here (best-effort by design). */
  useEffect(() => {
    if (recTriggered.current) return
    recTriggered.current = true
    api<{ created: { poNumber: string }[]; skipped: number }>('/api/purchase-orders/run-recurring', { method: 'POST', body: JSON.stringify({}) })
      .then((r) => { if (r.created?.length) void loadOrders() })
      .catch(() => { /* best-effort — the explicit "run now" button reports errors */ })
  }, [])
  const fetchDetail = async (id: string) => {
    setDetailBusy(true); setDetailErr('')
    try {
      const d = await api<{ order: NabavaPoDetail }>(`/api/purchase-orders/${id}`)
      setDetail(d.order)
    } catch (e) {
      setDetailErr(String((e as Error).message || e))
    } finally {
      setDetailBusy(false)
    }
  }
  const openDetail = (id: string) => { setDetail(null); setDetailId(id); fetchDetail(id) }

  /* statusni prehodi naročila: oddaja / odobritev / preklic */
  const poAction = async (id: string, action: 'submit' | 'approve' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(t('proc.cancelConfirm'))) return
    setBusy(true); setErr(''); setOkMsg('')
    try {
      await api(`/api/purchase-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      setOkMsg(action === 'submit' ? t('proc.msgSubmitted') : action === 'approve' ? t('proc.msgApproved') : t('proc.msgCancelled'))
      await loadOrders()
      if (detailId === id) await fetchDetail(id)
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  /* — dobavitelji — */
  const openSupDialog = (s?: NabavaSupplier) => {
    setSupErr('')
    setSupDialog(s
      ? { editingId: s.id, name: s.name, contact: s.contact || '', phone: s.phone || '', email: s.email || '', address: s.address || '', city: s.city || '', taxId: s.taxId || '', iban: s.iban || '', paymentTerms: s.paymentTerms || '' }
      : { editingId: null, name: '', contact: '', phone: '', email: '', address: '', city: '', taxId: '', iban: '', paymentTerms: '' })
  }
  const saveSupplier = async () => {
    if (!supDialog) return
    if (!supDialog.name.trim()) { setSupErr(t('proc.supNameRequired')); return }
    setSupBusy(true); setSupErr('')
    const body = {
      name: supDialog.name.trim(),
      contact: supDialog.contact.trim(),
      phone: supDialog.phone.trim(),
      email: supDialog.email.trim(),
      address: supDialog.address.trim(),
      city: supDialog.city.trim(),
      taxId: supDialog.taxId.trim(),
      iban: supDialog.iban.trim(),
      paymentTerms: supDialog.paymentTerms.trim(),
    }
    try {
      if (supDialog.editingId) {
        await api('/api/suppliers', { method: 'PATCH', body: JSON.stringify({ id: supDialog.editingId, ...body }) })
        setOkMsg(t('proc.supUpdated'))
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) })
        setOkMsg(t('proc.supAdded'))
      }
      setSupDialog(null)
      await loadSuppliers()
    } catch (e) {
      setSupErr(String((e as Error).message || e))
    } finally {
      setSupBusy(false)
    }
  }

  /* — novo naročilo — */
  const openPoDialog = () => {
    setPoSupplierId(suppliers.find((s) => s.isActive)?.id || '')
    setPoLocationId(''); setPoExpected(''); setPoNotes(''); setPoLines([]); setPoErr('')
    setPoDialog(true)
  }
  /* OPS-8 val 2 — prefill PO creator from a suggestion group (per supplier) */
  const openPoDialogPrefilled = (group: NabavaSuggGroup) => {
    if (!group.supplierId) return
    setPoSupplierId(group.supplierId)
    setPoLocationId(''); setPoExpected(''); setPoNotes(''); setPoErr('')
    setPoLines(group.items.map((s) => {
      const inv = invItems.find((i) => i.id === s.itemId)
      return {
        inventoryItemId: s.itemId,
        description: s.itemName,
        quantity: String(s.suggested),
        unit: s.unit || inv?.unit || 'kos',
        unitPrice: inv && inv.cost > 0 ? String(inv.cost) : '',
        vatRate: '22',
      }
    }))
    setPoDialog(true)
  }
  const addPoLineFromInventory = (invId: string) => {
    if (!invId) return
    const it = invItems.find((i) => i.id === invId)
    if (!it || poLines.some((l) => l.inventoryItemId === invId)) return
    setPoLines((ls) => [...ls, { inventoryItemId: it.id, description: it.name, quantity: '', unit: it.unit, unitPrice: it.cost > 0 ? String(it.cost) : '', vatRate: '22' }])
  }
  const addManualPoLine = () => {
    setPoLines((ls) => [...ls, { inventoryItemId: '', description: '', quantity: '', unit: 'kos', unitPrice: '', vatRate: '22' }])
  }
  const updatePoLine = (idx: number, patch: Partial<NabavaNewLine>) => {
    setPoLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }
  const removePoLine = (idx: number) => setPoLines((ls) => ls.filter((_, i) => i !== idx))
  const poLineNet = (l: NabavaNewLine) => {
    const q = nabavaNum(l.quantity), p = nabavaNum(l.unitPrice)
    return Number.isFinite(q) && Number.isFinite(p) ? q * p : 0
  }
  const poLineVat = (l: NabavaNewLine) => {
    const v = nabavaNum(l.vatRate)
    return (poLineNet(l) * (Number.isFinite(v) ? v : 0)) / 100
  }
  const poSubtotal = poLines.reduce((s, l) => s + poLineNet(l), 0)
  const poVatTotal = poLines.reduce((s, l) => s + poLineVat(l), 0)

  const savePo = async () => {
    if (!poSupplierId) { setPoErr(t('proc.chooseSupplierErr')); return }
    if (poLines.length === 0) { setPoErr(t('proc.addLineRequired')); return }
    for (let i = 0; i < poLines.length; i++) {
      const l = poLines[i]
      if (!l.inventoryItemId && !l.description.trim()) { setPoErr(t('proc.lineDescRequired', { n: i + 1 })); return }
      const q = nabavaNum(l.quantity)
      if (!Number.isFinite(q) || q <= 0) { setPoErr(t('proc.lineQtyRequired', { n: i + 1 })); return }
      const p = nabavaNum(l.unitPrice)
      if (!Number.isFinite(p) || p < 0) { setPoErr(t('proc.linePriceRequired', { n: i + 1 })); return }
    }
    setPoBusy(true); setPoErr('')
    try {
      await api('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId,
          locationId: poLocationId || undefined,
          expectedDate: poExpected || undefined,
          notes: poNotes.trim() || undefined,
          lines: poLines.map((l) => ({
            inventoryItemId: l.inventoryItemId || undefined,
            description: l.inventoryItemId ? undefined : l.description.trim(),
            quantity: nabavaNum(l.quantity),
            unit: l.unit.trim() || undefined,
            unitPrice: nabavaNum(l.unitPrice),
            vatRate: nabavaNum(l.vatRate) || undefined,
          })),
        }),
      })
      setPoDialog(false); setPoLines([]); setOkMsg(t('proc.poCreated'))
      await loadOrders()
    } catch (e) {
      setPoErr(String((e as Error).message || e))
    } finally {
      setPoBusy(false)
    }
  }

  /* — prevzem (GRN) — */
  const openReceive = (o: NabavaPo) => {
    const lines: Record<string, NabavaRecvLine> = {}
    for (const it of o.items) {
      const remaining = Math.max(0, it.quantityOrdered - it.quantityReceived)
      lines[it.id] = { accept: remaining > 0 ? String(remaining) : '0', reject: '0', reason: '', expiry: '' }
    }
    setRecvOrder(o); setRecvLines(lines); setRecvDoc(''); setRecvNotes(''); setRecvErr(''); setRecvDone(null)
  }
  const updateRecvLine = (id: string, patch: Partial<NabavaRecvLine>) => {
    setRecvLines((ls) => ({ ...ls, [id]: { ...(ls[id] || { accept: '0', reject: '0', reason: '', expiry: '' }), ...patch } }))
  }
  const submitReceive = async () => {
    if (!recvOrder) return
    const payloadLines: { purchaseOrderItemId: string; quantityAccepted: number; quantityRejected: number; rejectReason?: string; expiryDate?: string }[] = []
    for (const it of recvOrder.items) {
      const l = recvLines[it.id] || { accept: '0', reject: '0', reason: '', expiry: '' }
      const a = nabavaNum(l.accept), r = nabavaNum(l.reject)
      if (!Number.isFinite(a) || a < 0 || !Number.isFinite(r) || r < 0) { setRecvErr(t('proc.lineQtyNumbers', { name: it.description })); return }
      if (a === 0 && r === 0) continue
      if (r > 0 && !l.reason.trim()) { setRecvErr(t('proc.lineReasonRequired', { name: it.description })); return }
      payloadLines.push({
        purchaseOrderItemId: it.id,
        quantityAccepted: a,
        quantityRejected: r,
        rejectReason: r > 0 ? l.reason.trim() : undefined,
        expiryDate: l.expiry || undefined,
      })
    }
    if (payloadLines.length === 0) { setRecvErr(t('proc.enterQty')); return }
    setRecvBusy(true); setRecvErr('')
    try {
      const res = await api<{ receipt: { id: string; grnNumber: string; status: string; poStatus: string; warnings?: string[] } }>(`/api/purchase-orders/${recvOrder.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ supplierDocNumber: recvDoc.trim() || undefined, notes: recvNotes.trim() || undefined, lines: payloadLines }),
      })
      setRecvDone({ grnNumber: res.receipt.grnNumber, warnings: res.receipt.warnings || [] })
      await loadOrders()
      if (detailId === recvOrder.id) await fetchDetail(recvOrder.id)
    } catch (e) {
      setRecvErr(String((e as Error).message || e))
    } finally {
      setRecvBusy(false)
    }
  }

  /* — eSLOG e-račun uvoz (OPS-9 val 2) —
   * raw fetch instead of api(): the 422 body carries the parsed invoice
   * (supplier name/taxId) for the inline "create the supplier first" hint. */
  const importEslog = async () => {
    if (!eslogFile) return
    setEslogBusy(true); setEslogWarn(null); setEslogDup(''); setEslogResult(null)
    try {
      const xml = await eslogFile.text()
      const token = getToken()
      const res = await fetch('/api/ap/import-eslog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ xml }),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string; duplicate?: boolean
        ap?: { apNumber: string; dueDate: string; totalAmount: number }
        supplier?: { id: string; name: string }
        parsed?: { lines: unknown[]; supplier: { name: string; taxId: string } } | null
      }
      if (res.status === 422) {
        const tax = data?.parsed?.supplier?.taxId || ''
        const name = data?.parsed?.supplier?.name || ''
        setEslogWarn({ error: tax ? t('eslog.errSupplier', { tax, name }) : String(data.error || t('common.error')), supplierName: name, taxId: tax })
        return
      }
      if (!res.ok) throw new Error(data?.error || 'Napaka zahteve')
      if (data.duplicate && data.ap) {
        setEslogDup(data.ap.apNumber)
        toast({ title: t('eslog.dup', { ap: data.ap.apNumber }) })
        return
      }
      if (data.ap) {
        setEslogResult({
          apNumber: data.ap.apNumber,
          supplierName: data.supplier?.name || '',
          totalAmount: Number(data.ap.totalAmount),
          dueDate: data.ap.dueDate ? nabavaDate(data.ap.dueDate) : '—',
          lines: data.parsed?.lines?.length || 0,
        })
        toast({ title: t('eslog.ok', { ap: data.ap.apNumber }) })
      }
    } catch (e) {
      setEslogWarn({ error: String((e as Error).message || e) })
    } finally {
      setEslogBusy(false)
    }
  }

  /* — ponavljajoča naročila (OPS-9 val 2) — */
  const runRecurringNow = async () => {
    setRecBusy(true); setRecErr('')
    try {
      const res = await api<{ created: { poNumber: string }[]; skipped: number }>('/api/purchase-orders/run-recurring', { method: 'POST', body: JSON.stringify({}) })
      toast({ title: t('recurring.created', { n: res.created.length, s: res.skipped }) })
      if (res.created.length > 0) await loadOrders()
      await loadRecRules()
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const toggleRule = async (rule: RecRuleT) => {
    setRecBusy(true); setRecErr('')
    try {
      const res = await api<{ rule: RecRuleT }>('/api/recurring-po', { method: 'PATCH', body: JSON.stringify({ id: rule.id, active: !rule.active }) })
      setRecRules((rs) => rs.map((r) => (r.id === rule.id ? res.rule : r)))
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const deleteRule = async (id: string) => {
    if (!window.confirm(t('recurring.confirmDelete'))) return
    setRecBusy(true); setRecErr('')
    try {
      await api(`/api/recurring-po?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setRecRules((rs) => rs.filter((r) => r.id !== id))
      toast({ title: t('recurring.deleted') })
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const openRecDialog = () => {
    setRecSupplierId(suppliers.find((s) => s.isActive)?.id || '')
    setRecItemId(''); setRecItems([]); setRecWeekdays([1]); setRecHour('8'); setRecEvery('1'); setRecErr('')
    setRecDialog(true)
  }
  const addRecItem = () => {
    if (!recItemId) return
    const it = invItems.find((i) => i.id === recItemId)
    if (!it || recItems.some((x) => x.inventoryItemId === recItemId)) return
    setRecItems((xs) => [...xs, { inventoryItemId: it.id, name: it.name, qty: '' }])
    setRecItemId('')
  }
  const saveRecRule = async () => {
    if (!recSupplierId) { setRecErr(t('recurring.errSupplier')); return }
    if (recItems.length === 0 || recItems.some((x) => !(nabavaNum(x.qty) > 0))) { setRecErr(t('recurring.errItems')); return }
    if (recWeekdays.length === 0) { setRecErr(t('recurring.errWeekdays')); return }
    setRecBusy(true); setRecErr('')
    try {
      await api('/api/recurring-po', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: recSupplierId,
          items: recItems.map((x) => ({ inventoryItemId: x.inventoryItemId, qty: nabavaNum(x.qty) })),
          weekdays: recWeekdays,
          hour: Number(recHour) || 8,
          everyWeeks: Number(recEvery) || 1,
        }),
      })
      setRecDialog(false)
      toast({ title: t('recurring.saved') })
      await loadRecRules()
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }

  const filteredOrders = statusFilter === 'all' ? orders : orders.filter((o) => o.status === statusFilter)

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">{t('proc.desc')}</p>

      {/* 0 — reorder suggestions (OPS-8 val 2): PAR - stock - incoming, per supplier */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <TrendingUp className="w-4 h-4" /> {t('sugg.title')}
          </CardTitle>
          <CardDescription>{t('sugg.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {suggLoading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('sugg.loading')}</p>
          ) : suggGroups.length === 0 ? (
            <p className="text-sm text-stone-500">{t('sugg.empty')}</p>
          ) : (
            <div className="space-y-3">
              {suggGroups.map((g) => (
                <div key={g.supplierId || `none-${g.supplierName}`} className="rounded-xl border border-stone-200">
                  <div className="flex items-center justify-between gap-2 flex-wrap border-b border-stone-100 bg-stone-50 px-3 py-2 rounded-t-xl">
                    <span className="font-semibold text-sm">{g.supplierName || t('sugg.noSupplier')}</span>
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-stone-500">{t('sugg.total')}: <strong>{fmtEUR(g.total)}</strong></span>
                      {canManage && g.supplierId && (
                        <Button size="sm" className="h-7 px-2 text-xs bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => openPoDialogPrefilled(g)}>
                          <Plus className="w-3 h-3" /> {t('sugg.createPo')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-white text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('sugg.colItem')}</th>
                          <th className="p-2 text-right">{t('sugg.colQty')}</th>
                          <th className="p-2 text-right">{t('sugg.colPar')}</th>
                          <th className="p-2 text-right">{t('sugg.colIncoming')}</th>
                          <th className="p-2 text-right">{t('sugg.colSuggested')}</th>
                          <th className="p-2 text-right">{t('sugg.colCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((s) => (
                          <tr key={s.itemId} className="border-t border-stone-100">
                            <td className="p-2 font-medium max-w-48 truncate" title={s.itemName}>{s.itemName}</td>
                            <td className="p-2 text-right">{s.qty} {s.unit}</td>
                            <td className="p-2 text-right">{s.par}</td>
                            <td className="p-2 text-right">{s.incoming}</td>
                            <td className="p-2 text-right font-bold text-emerald-700">{s.suggested}</td>
                            <td className="p-2 text-right">{fmtEUR(s.costEstimate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
          {suggErr && <p className="text-sm text-rose-700">{t('sugg.error')} {suggErr}</p>}
        </CardContent>
      </Card>

      {/* 0b — eSLOG e-invoice import (OPS-9 val 2): XML file → AccountsPayable */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <FileUp className="w-4 h-4" /> {t('eslog.card')}
          </CardTitle>
          <CardDescription>{t('eslog.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="nb-eslog-file">{t('eslog.file')}</Label>
              <Input
                id="nb-eslog-file"
                type="file"
                accept=".xml,text/xml,application/xml"
                className="w-full sm:w-72 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-stone-100 file:px-2 file:py-1 file:text-xs"
                disabled={eslogBusy}
                onChange={(e) => { setEslogFile(e.target.files?.[0] || null); setEslogWarn(null); setEslogDup(''); setEslogResult(null) }}
              />
            </div>
            <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800 text-white" disabled={eslogBusy || !eslogFile} onClick={importEslog}>
              {eslogBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
              {eslogBusy ? t('eslog.importing') : t('eslog.importBtn')}
            </Button>
          </div>
          {eslogDup && (
            <p className="text-sm text-stone-700 rounded-xl border border-stone-200 bg-stone-50 p-3">{t('eslog.dup', { ap: eslogDup })}</p>
          )}
          {eslogWarn && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-semibold flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {eslogWarn.error}</p>
            </div>
          )}
          {eslogResult && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 space-y-1">
              <p className="font-semibold">{t('eslog.summary')}: {eslogResult.apNumber}</p>
              <p>
                {t('eslog.colSupplier')}: <strong>{eslogResult.supplierName}</strong> · {t('eslog.colAmount')}: <strong>{fmtEUR(eslogResult.totalAmount)}</strong> · {t('eslog.colDue')}: {eslogResult.dueDate} · {t('eslog.lines', { n: eslogResult.lines })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 0c — recurring purchase orders (OPS-9 val 2): rules → draft POs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Repeat className="w-4 h-4" /> {t('recurring.card')}
            {canManage && (
              <span className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={recBusy} onClick={runRecurringNow}>
                  <RotateCcw className="w-3.5 h-3.5" /> {recBusy ? t('recurring.running') : t('recurring.runNow')}
                </Button>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={openRecDialog}>
                  <Plus className="w-3.5 h-3.5" /> {t('recurring.new')}
                </Button>
              </span>
            )}
          </CardTitle>
          <CardDescription>{t('recurring.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {recLoading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</p>
          ) : recRules.length === 0 ? (
            <p className="text-sm text-stone-500">{t('recurring.empty')}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {recRules.map((rule) => {
                const sup = suppliers.find((s) => s.id === rule.supplierId)
                return (
                  <div key={rule.id} className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{sup?.name || rule.supplierId}</span>
                        <Badge variant="outline" className={rule.active ? 'border-emerald-600 text-emerald-700' : 'text-stone-500'}>
                          {rule.active ? t('recurring.active') : t('proc.inactiveF')}
                        </Badge>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <Switch checked={rule.active} disabled={recBusy} onCheckedChange={() => toggleRule(rule)} aria-label={t('recurring.active')} />
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-red-200 text-red-700 hover:bg-red-50" disabled={recBusy} onClick={() => deleteRule(rule.id)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-stone-600 mt-1">
                      {rule.items.map((it) => `${invItems.find((i) => i.id === it.inventoryItemId)?.name || it.inventoryItemId} × ${it.qty}`).join(', ')}
                    </p>
                    <p className="text-xs text-stone-500 mt-0.5">
                      {t('recurring.weekdays')}: {REC_DAY_ORDER.filter((d) => rule.weekdays.includes(d)).map((d) => t(`recurring.day${d}`)).join(', ')} · {t('recurring.hour')}: {rule.hour}:00 · {t('recurring.every')}: {t(`recurring.every${Math.max(1, Math.min(4, rule.everyWeeks))}`)}
                    </p>
                    <p className="text-xs text-stone-500">
                      {t('recurring.next')}: {rule.nextRun ? nabavaDate(rule.nextRun) : t('recurring.never')} · {t('recurring.lastRun')}: {rule.lastRun ? nabavaDate(rule.lastRun) : t('recurring.never')}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
          {recErr && <p className="text-sm text-red-600">{recErr}</p>}
        </CardContent>
      </Card>

      {/* A — DOBAVITELJI */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Truck className="w-4 h-4" /> {t('inv.suppliers')}
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => openSupDialog()}>
                <Plus className="w-3.5 h-3.5" /> {t('inv.newSupplier')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suppliers.length === 0 ? (
            <p className="text-sm text-stone-500">{t('proc.noSuppliers')} {canManage ? t('proc.noSuppliersAdd') : t('proc.noSuppliersManager')}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">{t('jobs.name')}</th>
                    <th className="p-2">{t('proc.contact')}</th>
                    <th className="p-2">{t('proc.phoneEmail')}</th>
                    <th className="p-2">{t('set.city')}</th>
                    <th className="p-2 text-right">{t('proc.ordersCount')}</th>
                    <th className="p-2 text-right">{t('proc.itemsCol')}</th>
                    <th className="p-2">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="p-2 text-right">{t('common.edit')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.id} className="border-t border-stone-100">
                      <td className="p-2 font-medium">{s.name}</td>
                      <td className="p-2 text-stone-600">{s.contact || '—'}</td>
                      <td className="p-2 text-stone-600">{[s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="p-2 text-stone-600">{s.city || '—'}</td>
                      <td className="p-2 text-right">{s.purchaseOrdersCount}</td>
                      <td className="p-2 text-right">{s.itemsCount}</td>
                      <td className="p-2">
                        {s.isActive
                          ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">{t('proc.activeF')}</Badge>
                          : <Badge variant="outline" className="text-stone-500">{t('proc.inactiveF')}</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => openSupDialog(s)}>{t('common.edit')}</Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* B — NABAVNA NAROČILA */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <PackageSearch className="w-4 h-4" /> {t('proc.ordersTitle')}
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={openPoDialog}>
                <Plus className="w-3.5 h-3.5" /> {t('proc.newOrder')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="sm:max-w-xs space-y-1.5">
            <Label>{t('proc.statusFilter')}</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('proc.allStatuses')}</SelectItem>
                {Object.entries(NABAVA_STATUS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{t(v.label)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('proc.loading')}</p>
          ) : filteredOrders.length === 0 ? (
            <p className="text-sm text-stone-500">{orders.length === 0 ? t('proc.noOrders') : t('proc.noOrdersStatus')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
              {filteredOrders.map((o) => {
                const st = NABAVA_STATUS[o.status]
                const active = o.status === 'draft' || o.status === 'submitted' || o.status === 'approved' || o.status === 'partial'
                return (
                  <div
                    key={o.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(o.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openDetail(o.id) }}
                    className="rounded-xl border border-stone-200 bg-stone-50 p-3 cursor-pointer hover:border-emerald-400 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{o.poNumber}</span>
                        <Badge variant="outline" className={st?.cls || ''}>{st?.label ? t(st.label) : o.status}</Badge>
                      </div>
                      <span className="font-bold">{fmtEUR(o.totalAmount)}</span>
                    </div>
                    <p className="text-xs text-stone-500 mt-1">
                      {o.supplierName || '—'} · {t('proc.ordered')} {nabavaDate(o.orderDate)}
                      {o.expectedDate ? ` · ${t('proc.expected')} ${nabavaDate(o.expectedDate)}` : ''}
                      {' · '}{t('proc.linesCount', { n: o.items.length })} · {o.receiptsCount === 1 ? t('proc.receiptOne') : o.receiptsCount === 2 ? t('proc.receiptTwo') : t('proc.receiptMany', { n: o.receiptsCount })}
                    </p>
                    {canManage && active && (
                      <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                        {o.status === 'draft' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => poAction(o.id, 'submit')}>{t('proc.submitBtn')}</Button>
                        )}
                        {o.status === 'submitted' && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => poAction(o.id, 'approve')}>{t('proc.approveBtn')}</Button>
                        )}
                        {(o.status === 'approved' || o.status === 'partial') && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => openReceive(o)}>
                            <Truck className="w-3.5 h-3.5" /> {t('proc.receiveBtn')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy} onClick={() => poAction(o.id, 'cancel')}>{t('common.cancel')}</Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Dialog: dobavitelj (nov / uredi) */}
      <Dialog open={supDialog !== null} onOpenChange={(v) => { if (!v) setSupDialog(null) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{supDialog?.editingId ? t('proc.editSupplier') : t('inv.newSupplier')}</DialogTitle></DialogHeader>
          {supDialog && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-name">{t('inv.name')}</Label>
                <Input id="nb-sup-name" value={supDialog.name} onChange={(e) => setSupDialog({ ...supDialog, name: e.target.value })} placeholder={t('proc.supNamePlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-contact">{t('inv.contactPerson')}</Label>
                  <Input id="nb-sup-contact" value={supDialog.contact} onChange={(e) => setSupDialog({ ...supDialog, contact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-phone">{t('inv.phone')}</Label>
                  <Input id="nb-sup-phone" value={supDialog.phone} onChange={(e) => setSupDialog({ ...supDialog, phone: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-email">{t('set.email')}</Label>
                  <Input id="nb-sup-email" type="email" value={supDialog.email} onChange={(e) => setSupDialog({ ...supDialog, email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-city">{t('set.city')}</Label>
                  <Input id="nb-sup-city" value={supDialog.city} onChange={(e) => setSupDialog({ ...supDialog, city: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-tax">{t('set.taxId')}</Label>
                  <Input id="nb-sup-tax" value={supDialog.taxId} onChange={(e) => setSupDialog({ ...supDialog, taxId: e.target.value })} />
                  {/* OPS-8 val 2 — DURS VAT payer check (badge + autofill name + bank account) */}
                  <DursCheckButton
                    query={supDialog.taxId}
                    compact
                    onName={(name) => setSupDialog((d) => (d && !d.name.trim() ? { ...d, name } : d))}
                    onIban={(iban) => setSupDialog((d) => (d && !d.iban.trim() ? { ...d, iban } : d))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-iban">{t('proc.iban')}</Label>
                  <Input id="nb-sup-iban" value={supDialog.iban} onChange={(e) => setSupDialog({ ...supDialog, iban: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-terms">{t('proc.paymentTerms')}</Label>
                  <Input id="nb-sup-terms" value={supDialog.paymentTerms} onChange={(e) => setSupDialog({ ...supDialog, paymentTerms: e.target.value })} placeholder={t('proc.termsPlaceholder')} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-addr">{t('set.address')}</Label>
                <Input id="nb-sup-addr" value={supDialog.address} onChange={(e) => setSupDialog({ ...supDialog, address: e.target.value })} />
              </div>
              {supErr && <p className="text-sm text-red-600">{supErr}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupDialog(null)} disabled={supBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={saveSupplier} disabled={supBusy}>
              {supBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: novo nabavno naročilo */}
      <Dialog open={poDialog} onOpenChange={(v) => { if (!v) setPoDialog(false) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('proc.newOrderTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('proc.supplierLabel')}</Label>
                <Select value={poSupplierId} onValueChange={setPoSupplierId}>
                  <SelectTrigger><SelectValue placeholder={suppliers[0]?.name || t('proc.chooseSupplier')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {suppliers.filter((s) => s.isActive).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {suppliers.length === 0 && <p className="text-xs text-amber-700">{t('proc.noActiveSuppliers')}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>{t('dev.location')}</Label>
                {locations.length > 0 ? (
                  <Select value={poLocationId} onValueChange={setPoLocationId}>
                    <SelectTrigger><SelectValue placeholder={t('proc.defaultLocation')} /></SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input disabled value={t('proc.defaultLocation')} />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-expected">{t('proc.expectedDate')}</Label>
                <Input id="nb-po-expected" type="date" value={poExpected} onChange={(e) => setPoExpected(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-notes">{t('proc.note')}</Label>
                <Input id="nb-po-notes" value={poNotes} onChange={(e) => setPoNotes(e.target.value)} placeholder={t('proc.notePlaceholder')} />
              </div>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1.5 grow min-w-48">
                <Label>{t('proc.addInvItem')}</Label>
                <Select value="" onValueChange={addPoLineFromInventory}>
                  <SelectTrigger><SelectValue placeholder={t('proc.itemPlaceholder')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {invItems.filter((i) => !poLines.some((l) => l.inventoryItemId === i.id)).map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" size="sm" className="h-9" onClick={addManualPoLine}>
                <Plus className="w-3.5 h-3.5" /> {t('proc.manualLine')}
              </Button>
            </div>

            {poLines.length === 0 ? (
              <p className="text-xs text-stone-500">{t('proc.noLines')}</p>
            ) : (
              <div className="space-y-2">
                {poLines.map((l, idx) => (
                  <div key={l.inventoryItemId || `m${idx}`} className="rounded-lg border border-stone-200 bg-stone-50 p-2">
                    <div className="grid gap-2 sm:grid-cols-12 items-end">
                      <div className="sm:col-span-4 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.itemDesc')}</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm font-medium py-1.5">{l.description}</p>
                        ) : (
                          <Input value={l.description} onChange={(e) => updatePoLine(idx, { description: e.target.value })} placeholder={t('proc.lineDescPlaceholder')} />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.qty')}</Label>
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => updatePoLine(idx, { quantity: e.target.value })} />
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('inv.unit')}</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm py-1.5 text-stone-600">{l.unit}</p>
                        ) : (
                          <Input value={l.unit} onChange={(e) => updatePoLine(idx, { unit: e.target.value })} />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.pricePerUnit')}</Label>
                        <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => updatePoLine(idx, { unitPrice: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.vatPercent')}</Label>
                        <Input inputMode="decimal" value={l.vatRate} onChange={(e) => updatePoLine(idx, { vatRate: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <Button size="sm" variant="outline" className="h-9 w-9 p-0 text-red-600" aria-label={t('proc.removeLine')} onClick={() => removePoLine(idx)}>×</Button>
                      </div>
                    </div>
                    <p className="text-xs text-stone-500 mt-1 text-right">{t('proc.lineAmount')} <b>{fmtEUR(poLineNet(l))}</b></p>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-stone-600">{t('proc.netTotal')}</span><span>{fmtEUR(poSubtotal)}</span></div>
              <div className="flex justify-between"><span className="text-stone-600">{t('proc.vat')}</span><span>{fmtEUR(poVatTotal)}</span></div>
              <div className="flex justify-between font-bold"><span>{t('proc.total')}</span><span>{fmtEUR(poSubtotal + poVatTotal)}</span></div>
            </div>

            {poErr && <p className="text-sm text-red-600">{poErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPoDialog(false)} disabled={poBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={savePo} disabled={poBusy}>
              {poBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('proc.createDraft')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: detajl naročila (naročeno/prejeto/zavrnjeno, prevzemi, zgodovina cen) */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) { setDetailId(null); setDetail(null) } }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              {t('proc.order')} {detail?.poNumber || '…'}
              {detail && (
                <Badge variant="outline" className={NABAVA_STATUS[detail.status]?.cls || ''}>
                  {NABAVA_STATUS[detail.status]?.label ? t(NABAVA_STATUS[detail.status].label) : detail.status}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailBusy && !detail && (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('proc.loadingDetail')}</p>
          )}
          {detailErr && <p className="text-sm text-red-600">{detailErr}</p>}
          {detail && (
            <div className="space-y-4">
              <div className="text-xs text-stone-600 space-y-0.5">
                <p>
                  {t('proc.supplierColon')} <b>{detail.supplier?.name || '—'}</b>
                  {detail.supplier?.contactPerson ? ` · ${detail.supplier.contactPerson}` : ''}
                  {detail.supplier?.phone ? ` · ${detail.supplier.phone}` : ''}
                  {detail.supplier?.email ? ` · ${detail.supplier.email}` : ''}
                </p>
                <p>{t('proc.orderedColon')} {nabavaDate(detail.orderDate)} · {t('proc.expectedColon')} {nabavaDate(detail.expectedDate)} · {t('proc.receivedColon')} {nabavaDate(detail.receivedDate)}</p>
                <p>{t('proc.submittedBy')} {detail.requestedBy || '—'} · {t('proc.approvedByLabel')} {detail.approvedBy || '—'}</p>
                {detail.notes && <p>{t('proc.noteColon')} {detail.notes}</p>}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.linesHeader')}</p>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-stone-200">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                      <tr>
                        <th className="p-2">{t('proc.item')}</th>
                        <th className="p-2 text-right">{t('proc.thOrdered')}</th>
                        <th className="p-2 text-right">{t('proc.thReceived')}</th>
                        <th className="p-2 text-right">{t('proc.thRejected')}</th>
                        <th className="p-2 text-right">{t('proc.thPriceUnit')}</th>
                        <th className="p-2 text-right">{t('proc.total')}</th>
                        <th className="p-2">{t('shifts.csvStatus')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((it) => {
                        const ist = NABAVA_ITEM_STATUS[it.status]
                        return (
                          <tr key={it.id} className="border-t border-stone-100">
                            <td className="p-2 font-medium">{it.description}</td>
                            <td className="p-2 text-right">{it.quantityOrdered} {it.unit}</td>
                            <td className="p-2 text-right text-emerald-700">{it.quantityReceived}</td>
                            <td className="p-2 text-right text-red-600">{it.quantityRejected > 0 ? it.quantityRejected : '—'}</td>
                            <td className="p-2 text-right">{fmtEUR(it.unitPrice)}</td>
                            <td className="p-2 text-right font-semibold">{fmtEUR(it.totalPrice)}</td>
                            <td className="p-2">
                              <Badge variant="outline" className={ist?.cls || ''}>{ist?.label ? t(ist.label) : it.status}</Badge>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-stone-600 mt-2 text-right">
                  {t('proc.netLabel')} {fmtEUR(detail.subtotal)} · {t('proc.vat')}: {fmtEUR(detail.vatAmount)} · <b>{t('proc.total')}: {fmtEUR(detail.totalAmount)}</b>
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.receiptsCount', { n: detail.receipts.length })}</p>
                {detail.receipts.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('proc.noReceipts')}</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto space-y-2">
                    {detail.receipts.map((g) => (
                      <div key={g.id} className="rounded-lg border border-stone-200 bg-stone-50 p-2 text-sm">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-semibold">{g.grnNumber}</span>
                          <span className="text-xs text-stone-500">
                            {g.receivedAt ? new Date(g.receivedAt).toLocaleString('sl-SI') : '—'}{g.receivedByName ? ` · ${g.receivedByName}` : ''}
                          </span>
                        </div>
                        {g.supplierDocNumber && <p className="text-xs text-stone-500">{t('proc.supplierDoc')} {g.supplierDocNumber}</p>}
                        <ul className="text-xs text-stone-600 mt-1 space-y-0.5">
                          {g.items.map((gi, i) => (
                            <li key={i}>
                              {gi.description}: {t('proc.acceptedShort')} {gi.quantityAccepted} {gi.unit}
                              {gi.quantityRejected > 0 ? ` · ${t('proc.rejectedShort')} ${gi.quantityRejected}${gi.rejectReason ? ` (${gi.rejectReason})` : ''}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.priceHistory')}</p>
                {detail.priceHistory.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('proc.noPriceHistory')}</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded-xl border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('proc.article')}</th>
                          <th className="p-2 text-right">{t('proc.thPriceUnit')}</th>
                          <th className="p-2 text-right">{t('proc.vat')}</th>
                          <th className="p-2">{t('proc.source')}</th>
                          <th className="p-2 text-right">{t('proc.observed')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.priceHistory.slice(0, 10).map((h, i) => {
                          const inv = invItems.find((x) => x.id === h.inventoryItemId)
                          return (
                            <tr key={i} className="border-t border-stone-100">
                              <td className="p-2">{inv?.name || h.inventoryItemId || '—'}</td>
                              <td className="p-2 text-right font-semibold">{fmtEUR(h.unitPrice)}</td>
                              <td className="p-2 text-right">{h.vatRate != null ? `${h.vatRate} %` : '—'}</td>
                              <td className="p-2 text-stone-600">{h.source === 'goods_receipt' ? t('proc.srcReceipt') : h.source === 'purchase_order' ? t('proc.srcOrder') : h.source}</td>
                              <td className="p-2 text-right text-stone-500">{new Date(h.observedAt).toLocaleDateString('sl-SI')}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: prevzem (GRN) */}
      <Dialog open={recvOrder !== null} onOpenChange={(v) => { if (!v) setRecvOrder(null) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('proc.receiveTitle', { po: recvOrder?.poNumber || '' })}</DialogTitle></DialogHeader>
          {recvDone ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
                {t('proc.recvSavedA')} <b>{recvDone.grnNumber}</b>{t('proc.recvSavedB')}
              </div>
              {recvDone.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('proc.warnings')}</p>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {recvDone.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : recvOrder ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="nb-recv-doc">{t('proc.supplierDocLabel')}</Label>
                  <Input id="nb-recv-doc" value={recvDoc} onChange={(e) => setRecvDoc(e.target.value)} placeholder={t('proc.docPlaceholder')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-recv-notes">{t('proc.note')}</Label>
                  <Input id="nb-recv-notes" value={recvNotes} onChange={(e) => setRecvNotes(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                {recvOrder.items.map((it) => {
                  const l = recvLines[it.id] || { accept: '0', reject: '0', reason: '', expiry: '' }
                  const rejNum = nabavaNum(l.reject)
                  const remaining = Math.max(0, it.quantityOrdered - it.quantityReceived)
                  return (
                    <div key={it.id} className="rounded-lg border border-stone-200 bg-stone-50 p-2">
                      <p className="text-sm font-medium">{it.description}</p>
                      <p className="text-xs text-stone-500 mb-2">
                        {t('proc.orderedColon')} {it.quantityOrdered} {it.unit} · {t('proc.alreadyReceived')} {it.quantityReceived}
                        {it.quantityRejected > 0 ? ` · ${t('proc.rejectedColon')} ${it.quantityRejected}` : ''} · {t('proc.remaining')} {remaining} {it.unit}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-4 items-end">
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.accepted')}</Label>
                          <Input inputMode="decimal" value={l.accept} onChange={(e) => updateRecvLine(it.id, { accept: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.thRejected')}</Label>
                          <Input inputMode="decimal" value={l.reject} onChange={(e) => updateRecvLine(it.id, { reject: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.rejectReason')}{rejNum > 0 ? ' *' : ''}</Label>
                          <Input value={l.reason} onChange={(e) => updateRecvLine(it.id, { reason: e.target.value })} placeholder={t('proc.reasonPlaceholder')} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.expiry')}</Label>
                          <Input type="date" value={l.expiry} onChange={(e) => updateRecvLine(it.id, { expiry: e.target.value })} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {recvErr && <p className="text-sm text-red-600">{recvErr}</p>}
            </div>
          ) : null}
          <DialogFooter>
            {recvDone ? (
              <Button variant="outline" onClick={() => setRecvOrder(null)}>{t('common.close')}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setRecvOrder(null)} disabled={recvBusy}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={submitReceive} disabled={recvBusy}>
                  {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} {t('proc.submitReceive')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: ponavljajoče naročilo — novo pravilo (OPS-9 val 2) */}
      <Dialog open={recDialog} onOpenChange={(v) => { if (!v) setRecDialog(false) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('recurring.dialogTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="nb-rec-sup">{t('recurring.supplier')}</Label>
              <Select value={recSupplierId} onValueChange={setRecSupplierId}>
                <SelectTrigger id="nb-rec-sup"><SelectValue placeholder={t('proc.chooseSupplier')} /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {suppliers.filter((s) => s.isActive).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nb-rec-item">{t('recurring.items')}</Label>
              <div className="flex gap-2 items-end">
                <Select value={recItemId} onValueChange={setRecItemId}>
                  <SelectTrigger id="nb-rec-item" className="flex-1"><SelectValue placeholder={t('recurring.itemPick')} /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    {invItems.map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" className="h-9" onClick={addRecItem} disabled={!recItemId}>
                  <Plus className="w-3.5 h-3.5" /> {t('recurring.addItem')}
                </Button>
              </div>
              {recItems.length === 0 ? (
                <p className="text-xs text-stone-500">{t('recurring.errItems')}</p>
              ) : (
                <div className="space-y-1.5">
                  {recItems.map((x, idx) => (
                    <div key={x.inventoryItemId} className="flex items-center gap-2">
                      <span className="text-sm flex-1 truncate" title={x.name}>{x.name}</span>
                      <Input
                        inputMode="decimal"
                        className="w-24 h-9 text-sm"
                        value={x.qty}
                        aria-label={t('recurring.qty')}
                        placeholder={t('recurring.qty')}
                        onChange={(e) => setRecItems((xs) => xs.map((y, i) => (i === idx ? { ...y, qty: e.target.value } : y)))}
                      />
                      <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => setRecItems((xs) => xs.filter((_, i) => i !== idx))} aria-label={t('common.delete')}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t('recurring.weekdays')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {REC_DAY_ORDER.map((d) => {
                  const on = recWeekdays.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setRecWeekdays((ws) => (on ? ws.filter((w) => w !== d) : [...ws, d]))}
                      aria-pressed={on}
                      className={`h-9 min-w-12 rounded-md border px-2 text-xs font-medium transition-colors ${on ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300'}`}
                    >
                      {t(`recurring.day${d}`)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-rec-hour">{t('recurring.hour')}</Label>
                <Select value={recHour} onValueChange={setRecHour}>
                  <SelectTrigger id="nb-rec-hour"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    {Array.from({ length: 13 }, (_, i) => String(i + 6)).map((h) => (
                      <SelectItem key={h} value={h}>{h}:00</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-rec-every">{t('recurring.every')}</Label>
                <Select value={recEvery} onValueChange={setRecEvery}>
                  <SelectTrigger id="nb-rec-every"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['1', '2', '3', '4'].map((n) => (
                      <SelectItem key={n} value={n}>{t(`recurring.every${n}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {recErr && <p className="text-sm text-red-600">{recErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecDialog(false)} disabled={recBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={saveRecRule} disabled={recBusy}>
              {recBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('recurring.new')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── DARILNE KARTICE (triage ③ — izdaja → polnjenje → unovčenje) ─────────────────────────── */

interface GiftCardT {
  id: string; cardNumber: string; balance: number; initialBalance: number
  status: string; effectiveStatus: string; ownerName: string
  purchasedAt: string; expiresAt: string | null; locationId: string | null; createdAt: string
}
interface GiftCardTxT {
  id: string; type: string; amount: number; balanceAfter: number
  orderId?: string | null; checkId?: string | null; note: string; createdAt: string
}
interface GiftCardStatsT { total: number; active: number; totalBalance: number; issued30: number; redeemed30: number }

const GC_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'gc.stActive', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  inactive: { label: 'gc.stInactive', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  exhausted: { label: 'gc.stExhausted', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  expired: { label: 'gc.stExpired', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const GC_TX: Record<string, { label: string; cls: string }> = {
  issue: { label: 'gc.txIssue', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  topup: { label: 'gc.txTopup', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  redeem: { label: 'gc.txRedeem', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  refund: { label: 'gc.txRefund', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
  adjust: { label: 'gc.txAdjust', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
}

const gcEur = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Issue #1 (triage ③): darilne kartice — pregled, izdaja, polnjenje, ledžer, deaktivacija. */
export function DarilneKarticeTab({ canPay, canManage }: { canPay: boolean; canManage: boolean }) {
  const { t } = useI18n()
  const [cards, setCards] = useState<GiftCardT[]>([])
  const [stats, setStats] = useState<GiftCardStatsT | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // izdaja
  const [issueOpen, setIssueOpen] = useState(false)
  const [issueForm, setIssueForm] = useState({ ownerName: '', initialBalance: '', expiresAt: '', note: '' })
  // polnjenje
  const [topupCard, setTopupCard] = useState<GiftCardT | null>(null)
  const [topupForm, setTopupForm] = useState({ amount: '', note: '' })
  // detalj + ledžer
  const [detail, setDetail] = useState<{ card: GiftCardT; transactions: GiftCardTxT[] } | null>(null)

  async function load(search = q) {
    setLoading(true)
    setErr('')
    try {
      const d = await api<{ cards: GiftCardT[]; stats: GiftCardStatsT }>(`/api/giftcards?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`)
      setCards(d.cards)
      setStats(d.stats)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  async function submitIssue() {
    const eur = gcEur(issueForm.initialBalance)
    if (Number.isNaN(eur) || eur < 0) {
      setErr(t('gc.errInitialBalance'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ card: GiftCardT; replayed: boolean }>('/api/giftcards', {
        method: 'POST',
        body: JSON.stringify({
          ownerName: issueForm.ownerName,
          initialBalance: eur,
          expiresAt: issueForm.expiresAt || null,
          note: issueForm.note || undefined,
          clientOperationId: newOperationId(),
        }),
      })
      setOkMsg(d.replayed ? t('gc.okReplayIssue', { num: d.card.cardNumber }) : t('gc.okIssued', { num: d.card.cardNumber }))
      setIssueOpen(false)
      setIssueForm({ ownerName: '', initialBalance: '', expiresAt: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitTopup() {
    if (!topupCard) return
    const eur = gcEur(topupForm.amount)
    if (Number.isNaN(eur) || eur <= 0) {
      setErr(t('gc.errTopupAmount'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ card: { balance: number }; replayed: boolean }>(`/api/giftcards/${topupCard.id}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount: eur, note: topupForm.note || undefined, clientOperationId: newOperationId() }),
      })
      setOkMsg(d.replayed ? t('gc.okReplayTopup', { balance: fmtEUR(d.card.balance) }) : t('gc.okTopped', { amount: fmtEUR(eur), balance: fmtEUR(d.card.balance) }))
      setTopupCard(null)
      setTopupForm({ amount: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function openDetail(c: GiftCardT) {
    setErr('')
    try {
      const d = await api<{ card: GiftCardT; transactions: GiftCardTxT[] }>(`/api/giftcards/${c.id}`)
      setDetail(d)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function toggleStatus(c: GiftCardT) {
    const next = c.status === 'active' ? 'inactive' : 'active'
    if (!window.confirm(next === 'inactive' ? t('gc.confirmDeactivate', { num: c.cardNumber }) : t('gc.confirmReactivate', { num: c.cardNumber }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/giftcards/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      setOkMsg(next === 'inactive' ? t('gc.okDeactivated') : t('gc.okReactivated'))
      setDetail(null)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex-1 flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder={t('gc.searchPlaceholder')}
            className="max-w-xs"
            aria-label={t('gc.searchAria')}
          />
          <Button variant="outline" onClick={() => void load()} disabled={loading}>{t('gc.searchBtn')}</Button>
          {q && <Button variant="ghost" onClick={() => { setQ(''); void load('') }}>{t('gc.clearBtn')}</Button>}
        </div>
        {canPay && (
          <Button className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5" onClick={() => { setErr(''); setOkMsg(''); setIssueOpen(true) }}>
            <Plus className="w-4 h-4" /> {t('gc.newCard')}
          </Button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            [t('gc.statActive'), String(stats.active), t('gc.statActiveSub')],
            [t('gc.statTotal'), fmtEUR(stats.totalBalance), t('gc.statTotalSub')],
            [t('gc.statIssued'), String(stats.issued30), t('gc.statIssuedSub')],
            [t('gc.statRedeemed'), fmtEUR(stats.redeemed30), t('gc.statRedeemedSub')],
          ] as [string, string, string][]).map(([label, val, sub]) => (
            <Card key={label}>
              <CardContent className="p-4">
                <p className="text-xs text-stone-500">{label}</p>
                <p className="text-xl font-bold">{val}</p>
                <p className="text-xs text-stone-400">{sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {okMsg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">{okMsg}</p>}
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">{err}</p>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('gc.cards')} {cards.length > 0 && <span className="text-stone-400 font-normal">({cards.length})</span>}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-4 text-sm text-stone-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('gc.loading')}</p>
          ) : cards.length === 0 ? (
            <p className="p-4 text-sm text-stone-500">{t('gc.none')}{q ? t('gc.noneSearch') : ''}. {canPay ? t('gc.noneFirst') : ''}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-stone-500 border-b border-stone-200 sticky top-0 bg-white">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('gc.thNumber')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thOwner')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thSaldo')}</th>
                    <th className="px-4 py-2 font-medium hidden sm:table-cell">{t('gc.thIssued')}</th>
                    <th className="px-4 py-2 font-medium hidden md:table-cell">{t('gc.thValidUntil')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thStatus')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => (
                    <tr key={c.id} className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer" onClick={() => void openDetail(c)}>
                      <td className="px-4 py-2.5 font-mono text-xs">{c.cardNumber}</td>
                      <td className="px-4 py-2.5">{c.ownerName || <span className="text-stone-400">—</span>}</td>
                      <td className="px-4 py-2.5 font-semibold">{fmtEUR(c.balance)}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-stone-500">{new Date(c.purchasedAt).toLocaleDateString('sl-SI')}</td>
                      <td className="px-4 py-2.5 hidden md:table-cell text-xs text-stone-500">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('sl-SI') : '∞'}</td>
                      <td className="px-4 py-2.5"><Badge variant="outline" className={GC_STATUS[c.effectiveStatus]?.cls || ''}>{GC_STATUS[c.effectiveStatus] ? t(GC_STATUS[c.effectiveStatus].label) : c.effectiveStatus}</Badge></td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {canPay && (
                          <Button variant="outline" size="sm" className="h-8 mr-1.5" onClick={() => { setTopupCard(c); setTopupForm({ amount: '', note: '' }); setErr(''); setOkMsg('') }}>
                            {t('gc.topupBtn')}
                          </Button>
                        )}
                        {canManage && c.status !== 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8 text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(c)}>
                            {t('gc.deactivateBtn')}
                          </Button>
                        )}
                        {canManage && c.status === 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8" onClick={() => void toggleStatus(c)}>
                            {t('gc.reactivateBtn')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* dialog: izdaja nove kartice */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader><DialogTitle className="text-lg">{t('gc.issueTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.ownerOptional')}</Label>
              <Input value={issueForm.ownerName} onChange={(e) => setIssueForm((f) => ({ ...f, ownerName: e.target.value }))} placeholder={t('gc.ownerPlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.initialBalance')}</Label>
              <Input type="number" step="0.01" min="0" value={issueForm.initialBalance} onChange={(e) => setIssueForm((f) => ({ ...f, initialBalance: e.target.value }))} placeholder={t('gc.initialBalancePlaceholder')} />
              <p className="text-xs text-stone-500">{t('gc.initialBalanceHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.validUntilOptional')}</Label>
              <Input type="date" value={issueForm.expiresAt} onChange={(e) => setIssueForm((f) => ({ ...f, expiresAt: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.noteOptional')}</Label>
              <Input value={issueForm.note} onChange={(e) => setIssueForm((f) => ({ ...f, note: e.target.value }))} placeholder={t('gc.noteIssuePlaceholder')} />
            </div>
          </div>
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitIssue()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('gc.issueBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: polnjenje */}
      <Dialog open={!!topupCard} onOpenChange={(v) => !v && setTopupCard(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('gc.topupTitle')} {topupCard?.cardNumber}</DialogTitle>
          </DialogHeader>
          {topupCard && (
            <div className="space-y-3">
              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 text-sm space-y-0.5">
                <p>{t('gc.currentSaldo')} <b>{fmtEUR(topupCard.balance)}</b></p>
                {topupCard.ownerName && <p className="text-stone-500">{t('gc.ownerColon')} {topupCard.ownerName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('gc.topupAmount')}</Label>
                <Input type="number" step="0.01" min="0.01" value={topupForm.amount} onChange={(e) => setTopupForm((f) => ({ ...f, amount: e.target.value }))} placeholder="10.00" autoFocus />
                <p className="text-xs text-stone-500">{t('gc.topupMaxHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('gc.noteOptional')}</Label>
                <Input value={topupForm.note} onChange={(e) => setTopupForm((f) => ({ ...f, note: e.target.value }))} placeholder={t('gc.noteTopupPlaceholder')} />
              </div>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setTopupCard(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitTopup()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('gc.topupBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: detalj + ledžer transakcij */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('gc.detailTitle')} {detail?.card.cardNumber}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                  <p className="text-xs text-stone-500">{t('gc.thSaldo')}</p>
                  <p className="text-lg font-bold">{fmtEUR(detail.card.balance)}</p>
                  <p className="text-xs text-stone-400">{t('gc.initialLower')} {fmtEUR(detail.card.initialBalance)}</p>
                </div>
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5 space-y-0.5">
                  <p className="text-xs text-stone-500">{t('gc.thStatus')}</p>
                  <Badge variant="outline" className={GC_STATUS[detail.card.effectiveStatus]?.cls || ''}>{GC_STATUS[detail.card.effectiveStatus] ? t(GC_STATUS[detail.card.effectiveStatus].label) : detail.card.effectiveStatus}</Badge>
                  <p className="text-xs text-stone-400">{detail.card.ownerName ? t('gc.ownerLine', { name: detail.card.ownerName }) : t('payment.noOwner')}</p>
                  <p className="text-xs text-stone-400">{detail.card.expiresAt ? t('gc.validUntilLine', { date: new Date(detail.card.expiresAt).toLocaleDateString('sl-SI') }) : t('gc.noExpiry')}</p>
                </div>
              </div>
              {canManage && detail.card.status !== 'inactive' && (
                <Button variant="outline" size="sm" className="text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(detail.card)}>{t('gc.deactivateCardBtn')}</Button>
              )}
              {canManage && detail.card.status === 'inactive' && (
                <Button variant="outline" size="sm" onClick={() => void toggleStatus(detail.card)}>{t('gc.reactivateCardBtn')}</Button>
              )}
              <div>
                <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1.5">{t('gc.ledger')}</p>
                {detail.transactions.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('gc.noTx')}</p>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-stone-500 border-b border-stone-200 bg-stone-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 font-medium">{t('gc.thType')}</th>
                          <th className="px-3 py-2 font-medium text-right">{t('tips.amount')}</th>
                          <th className="px-3 py-2 font-medium text-right">{t('gc.thBalanceAfter')}</th>
                          <th className="px-3 py-2 font-medium hidden sm:table-cell">{t('proc.note')}</th>
                          <th className="px-3 py-2 font-medium">{t('exp.csvDate')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.transactions.map((tx) => (
                          <tr key={tx.id} className="border-b border-stone-100">
                            <td className="px-3 py-2"><Badge variant="outline" className={GC_TX[tx.type]?.cls || ''}>{GC_TX[tx.type] ? t(GC_TX[tx.type].label) : tx.type}</Badge></td>
                            <td className={`px-3 py-2 text-right font-semibold ${tx.amount < 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{tx.amount > 0 ? '+' : ''}{fmtEUR(tx.amount)}</td>
                            <td className="px-3 py-2 text-right">{fmtEUR(tx.balanceAfter)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell text-xs text-stone-500 max-w-40 truncate" title={tx.note}>{tx.note}</td>
                            <td className="px-3 py-2 text-xs text-stone-500 whitespace-nowrap">{new Date(tx.createdAt).toLocaleString('sl-SI')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setDetail(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ODPAD (issue #1, triage ④) ─────────────────────────── */

interface WasteT {
  id: string
  inventoryItemId: string
  itemName: string
  unit: string
  quantity: number
  reason: string
  reasonLabel: string
  note: string
  costPerUnit: number
  totalCost: number
  reversedAt: string | null
  recordedByUserId: string | null
  createdAt: string
}

interface WasteReasonStatT { reason: string; label: string; count: number; totalCents: number }
interface WasteStatsT { count: number; totalCents: number; byReason: WasteReasonStatT[]; topReason: string | null }

/** Kanonični razlogi (v ravnovesju z src/lib/waste.ts) */
const WASTE_REASON_OPTIONS: { value: string; label: string }[] = [
  { value: 'pokvarjeno', label: 'waste.rPokvareno' },
  { value: 'preteklo', label: 'waste.rPretekelRok' },
  { value: 'priprava', label: 'waste.rPriprava' },
  { value: 'razlitje', label: 'waste.rRazlitje' },
  { value: 'hlajenje', label: 'waste.rHlajenje' },
  { value: 'reklamacija', label: 'waste.rReklamacija' },
  { value: 'drugo', label: 'waste.rDrugo' },
]
const wasteReasonBadgeCls = (reason: string): string => ({
  pokvarjeno: 'border-red-300 bg-red-50 text-red-800',
  preteklo: 'border-amber-300 bg-amber-50 text-amber-800',
  priprava: 'border-orange-300 bg-orange-50 text-orange-800',
  razlitje: 'border-stone-300 bg-stone-50 text-stone-700',
  hlajenje: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  reklamacija: 'border-purple-200 bg-purple-50 text-purple-800',
  drugo: 'border-stone-300 bg-stone-50 text-stone-700',
}[reason] ?? 'border-stone-300 bg-stone-50 text-stone-700')

/** i18n ključi razlogov (vzorec DEVICE_TYPE_KEYS — neznani razlog → surovi label iz API-ja) */
const WASTE_REASON_KEYS: Record<string, string> = {
  pokvarjeno: 'waste.rPokvareno', preteklo: 'waste.rPretekelRok', priprava: 'waste.rPriprava', razlitje: 'waste.rRazlitje', hlajenje: 'waste.rHlajenje', reklamacija: 'waste.rReklamacija', drugo: 'waste.rDrugo',
}

const wasteNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Issue #1 (triage ④): odpad hrane — evidenca (zaloga ↓, StockTransaction WASTE), statistika po razlogih, reverzija pomote. */
export function OdpadTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [records, setRecords] = useState<WasteT[]>([])
  const [stats, setStats] = useState<WasteStatsT | null>(null)
  const [items, setItems] = useState<InventoryT[]>([])
  const [days, setDays] = useState('30')
  const [reasonFilter, setReasonFilter] = useState('vsi')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // nov odpad
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ itemId: '', quantity: '', reason: '', note: '' })

  async function load(d = days, r = reasonFilter) {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams({ days: d })
      if (r && r !== 'vsi') params.set('reason', r)
      const [w, inv] = await Promise.all([
        api<{ records: WasteT[]; stats: WasteStatsT }>(`/api/waste?${params.toString()}`),
        api<{ inventory: InventoryT[] }>('/api/inventory'),
      ])
      setRecords(w.records)
      setStats(w.stats)
      setItems(inv.inventory)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function submitNew() {
    const sel = items.find((i) => i.id === form.itemId)
    if (!sel) {
      setErr(t('waste.errSelectItem'))
      return
    }
    const qty = wasteNum(form.quantity)
    if (Number.isNaN(qty) || qty <= 0) {
      setErr(t('waste.errQty'))
      return
    }
    if (!form.reason) {
      setErr(t('waste.errReason'))
      return
    }
    if (qty > sel.qty) {
      setErr(t('waste.errOverStock', { qty: sel.qty, unit: sel.unit }))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ record: { id: string; quantity: number; totalCost: number; newQty?: number }; replayed: boolean }>('/api/waste', {
        method: 'POST',
        body: JSON.stringify({ itemId: form.itemId, quantity: qty, reason: form.reason, note: form.note || undefined, idempotencyKey: newOperationId() }),
      })
      const idx = items.find((i) => i.id === form.itemId)
      const newQty = d.record.newQty ?? (idx ? idx.qty - d.record.quantity : undefined)
      setOkMsg(d.replayed
        ? t('waste.okReplay')
        : `${t('waste.okRecord', { qty: d.record.quantity, unit: idx?.unit ?? '', cost: fmtEUR(idx?.cost ?? 0), total: fmtEUR(d.record.totalCost) })}${idx && newQty !== undefined ? t('waste.okRecordTail', { qty: idx.qty, newQty: newQty ?? '' }) : ''}`)
      setNewOpen(false)
      setForm({ itemId: '', quantity: '', reason: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function reverseRecord(w: WasteT) {
    if (!window.confirm(t('waste.confirmReverse', { name: w.itemName, qty: w.quantity, unit: w.unit }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waste/${w.id}/reverse`, { method: 'POST' })
      setOkMsg(t('waste.okReversed', { qty: w.quantity, unit: w.unit, name: w.itemName }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selected = items.find((i) => i.id === form.itemId)
  const selQty = wasteNum(form.quantity)
  const previewCost = selected && Number.isFinite(selQty) && selQty > 0 ? Math.round((Math.round(selQty * 1000) * Math.round(selected.cost * 100)) / 1000) / 100 : null
  const selOver = selected && Number.isFinite(selQty) && selQty > selected.qty

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex-1 flex items-center gap-2 flex-wrap">
          <Select value={days} onValueChange={(v) => { setDays(v); void load(v, reasonFilter) }}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t('waste.days7')}</SelectItem>
              <SelectItem value="30">{t('waste.days30')}</SelectItem>
              <SelectItem value="90">{t('waste.days90')}</SelectItem>
              <SelectItem value="365">{t('waste.days365')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={reasonFilter} onValueChange={(v) => { setReasonFilter(v); void load(days, v) }}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vsi">{t('waste.allReasons')}</SelectItem>
              {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5">
            <Plus className="w-4 h-4" /> {t('waste.newBtn')}
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('waste.inPeriod')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-red-700">{fmtEUR(stats.totalCents / 100)}</p><p className="text-xs text-stone-500">{t('waste.recordsCount', { n: stats.count })}</p></CardContent>
          </Card>
          {stats.byReason.slice(0, 3).map((r) => (
            <Card key={r.reason}>
              <CardHeader className="pb-2"><CardDescription className="text-xs">{WASTE_REASON_KEYS[r.reason] ? t(WASTE_REASON_KEYS[r.reason]) : r.label}</CardDescription></CardHeader>
              <CardContent><p className="text-xl font-semibold">{fmtEUR(r.totalCents / 100)}</p><p className="text-xs text-stone-500">{t('waste.recordsCount', { n: r.count })}</p></CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('waste.title')}</CardTitle>
          <CardDescription className="text-xs">{t('waste.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('waste.loading')}</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-stone-500">{t('waste.none')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">{t('exp.csvDate')}</th>
                    <th className="px-3 py-2 font-medium">{t('proc.article')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('proc.qty')}</th>
                    <th className="px-3 py-2 font-medium">{t('loy.reason')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('waste.thCost')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="px-3 py-2"><span className="sr-only">{t('common.actions')}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {records.map((w) => (
                    <tr key={w.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-xs text-stone-500 whitespace-nowrap">{new Date(w.createdAt).toLocaleString('sl-SI')}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{w.itemName}</span>
                        {w.note && <span className="block text-xs text-stone-500 max-w-56 truncate" title={w.note}>{w.note}</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{w.quantity} {w.unit}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${wasteReasonBadgeCls(w.reason)}`}>{WASTE_REASON_KEYS[w.reason] ? t(WASTE_REASON_KEYS[w.reason]) : w.reasonLabel}</Badge></td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{fmtEUR(w.totalCost)}</td>
                      <td className="px-3 py-2">
                        {w.reversedAt ? <Badge variant="outline" className="text-xs border-stone-300 bg-stone-50 text-stone-600">{t('waste.reversedBadge')}</Badge> : <Badge variant="outline" className="text-xs border-emerald-300 bg-emerald-50 text-emerald-800">{t('waste.validBadge')}</Badge>}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2 text-right">
                          {!w.reversedAt && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => void reverseRecord(w)}>{t('waste.reverseBtn')}</Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Nov odpad */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('waste.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="waste-item">{t('proc.article')}</Label>
              <Select value={form.itemId} onValueChange={(v) => setForm({ ...form, itemId: v })}>
                <SelectTrigger id="waste-item"><SelectValue placeholder={t('waste.itemPlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name} ({i.qty} {i.unit} {t('waste.onStock')})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="waste-qty">{t('proc.qty')} {selected ? `(${selected.unit})` : ''}</Label>
                <Input id="waste-qty" inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder={t('waste.qtyPlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="waste-reason">{t('loy.reason')}</Label>
                <Select value={form.reason} onValueChange={(v) => setForm({ ...form, reason: v })}>
                  <SelectTrigger id="waste-reason"><SelectValue placeholder={t('waste.reasonPlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.label)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="waste-note">{t('waste.noteOptional')}</Label>
              <Input id="waste-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('waste.notePlaceholder')} />
            </div>
            {selected && (
              <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 space-y-0.5">
                <p>{t('waste.onStockColon')} <strong>{selected.qty} {selected.unit}</strong> {t('waste.priceColon')} {fmtEUR(selected.cost)} / {selected.unit}</p>
                {Number.isFinite(selQty) && selQty > 0 && previewCost !== null && (
                  <p className={selOver ? 'text-red-700 font-medium' : ''}>
                    {t('waste.estimatedCost')} <strong>{fmtEUR(previewCost)}</strong>
                    {selOver ? t('waste.overStockSuffix', { qty: selected.qty, unit: selected.unit }) : t('waste.afterWasteSuffix', { qty: Math.round((selected.qty - selQty) * 1000) / 1000, unit: selected.unit })}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.itemId || !form.reason || !form.quantity}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('waste.submitBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ČAKALNA LISTA (issue #1, triage ⑤) ─────────────────────────── */

interface WaitlistEntryT {
  id: string
  guestName: string
  guestPhone: string
  partySize: number
  quotedWaitMinutes: number
  actualWaitMinutes: number
  preferredArea: string
  specialNeeds: string
  notes: string
  status: string
  checkedInAt: string
  notifiedAt: string | null
  seatedAt: string | null
  leftAt: string | null
  tableId: string | null
  tableNumber: number | null
  locationId: string | null
}

interface WaitlistStatsT { waiting: number; notified: number; seated: number; left: number; waitingParty: number; avgActualWait: number; maxActualWait: number }

interface TableLiteT { id: string; name: string; number: number; zone: string; seats: number; status: string }

/** Slovenska n-tev "oseba" (v ravnovesju z src/lib/waitlist.ts) */
const wlParty = (n: number, tx: (key: string, vars?: Record<string, string | number>) => string): string => {
  const v = Math.max(0, Math.floor(n))
  if (v === 1) return tx('wl.party1')
  if (v === 2) return tx('wl.party2')
  if (v === 3 || v === 4) return tx('wl.party34', { n: v })
  return tx('wl.partyN', { n: v })
}
const wlMin = (s: string, now: number): number => {
  const a = new Date(s).getTime()
  return Number.isFinite(a) && now > a ? Math.floor((now - a) / 60_000) : 0
}
const wlDur = (m: number): string => {
  const v = Math.max(0, Math.floor(m))
  return v < 60 ? `${v} min` : `${Math.floor(v / 60)} h ${v % 60} min`
}
const wlStatusBadge = (status: string, tx: (key: string) => string): { label: string; cls: string } => ({
  waiting: { label: tx('wl.stWaiting'), cls: 'border-amber-300 bg-amber-50 text-amber-800' },
  notified: { label: tx('wl.stNotified'), cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  seated: { label: tx('wl.stSeated'), cls: 'border-green-300 bg-green-50 text-green-800' },
  left: { label: tx('wl.stLeft'), cls: 'border-stone-300 bg-stone-50 text-stone-600' },
}[status] ?? { label: status, cls: 'border-stone-300 bg-stone-50 text-stone-700' })

/** Issue #1 (triage ⑤): čakalna lista — prijava → obvestilo → usaditev (zaklene mizo) / odhod + statistika. */
export function CakalnaListaTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [active, setActive] = useState<WaitlistEntryT[]>([])
  const [finished, setFinished] = useState<WaitlistEntryT[]>([])
  const [stats, setStats] = useState<WaitlistStatsT | null>(null)
  const [tables, setTables] = useState<TableLiteT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [tick, setTick] = useState(0) // živo osveževanje minut čakanja

  // nova prijava
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ guestName: '', guestPhone: '', partySize: '2', quotedWaitMinutes: '15', preferredArea: '', specialNeeds: '', notes: '' })
  // usaditev
  const [seatFor, setSeatFor] = useState<WaitlistEntryT | null>(null)
  const [seatTableId, setSeatTableId] = useState('')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const [w, t] = await Promise.all([
        api<{ active: WaitlistEntryT[]; finished: WaitlistEntryT[]; stats: WaitlistStatsT }>('/api/waitlist?days=1'),
        api<{ tables: TableLiteT[] }>('/api/tables'),
      ])
      setActive(w.active)
      setFinished(w.finished)
      setStats(w.stats)
      setTables(t.tables)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const iv = setInterval(() => setTick((x) => x + 1), 30_000) // žive minute brez ponovnega nalaganja
    return () => clearInterval(iv)
  }, [])

  async function submitNew() {
    const party = Number(form.partySize)
    if (!form.guestName.trim()) {
      setErr(t('wl.errName'))
      return
    }
    if (!Number.isInteger(party) || party < 1) {
      setErr(t('wl.errParty'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api('/api/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          guestName: form.guestName,
          guestPhone: form.guestPhone || undefined,
          partySize: party,
          quotedWaitMinutes: form.quotedWaitMinutes === '' ? 0 : Number(form.quotedWaitMinutes.replace(',', '.')),
          preferredArea: form.preferredArea || undefined,
          specialNeeds: form.specialNeeds || undefined,
          notes: form.notes || undefined,
        }),
      })
      setOkMsg(t('wl.okAdded', { name: form.guestName.trim() }))
      setNewOpen(false)
      setForm({ guestName: '', guestPhone: '', partySize: '2', quotedWaitMinutes: '15', preferredArea: '', specialNeeds: '', notes: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function transition(w: WaitlistEntryT, status: string, tableId?: string) {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ entry: { id: string; status: string; actualWaitMinutes?: number | null } }>('/api/waitlist', {
        method: 'PATCH',
        body: JSON.stringify({ id: w.id, status, tableId: tableId || undefined }),
      })
      if (status === 'notified') setOkMsg(t('wl.okNotified', { name: w.guestName }))
      else if (status === 'seated') setOkMsg(t('wl.okSeated', { name: w.guestName, wait: d.entry.actualWaitMinutes !== null && d.entry.actualWaitMinutes !== undefined ? t('wl.okSeatedWait', { dur: wlDur(d.entry.actualWaitMinutes) }) : '' }))
      else setOkMsg(t('wl.okLeft', { name: w.guestName }))
      setSeatFor(null)
      setSeatTableId('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function seatEntry() {
    if (!seatFor) return
    if (!seatTableId) {
      setErr(t('wl.errSelectTable'))
      return
    }
    await transition(seatFor, 'seated', seatTableId)
  }

  async function deleteEntry(w: WaitlistEntryT) {
    if (!window.confirm(t('wl.confirmDelete', { name: w.guestName }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waitlist?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      setOkMsg(t('wl.okDeleted', { name: w.guestName }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const nowMs = Date.now() + tick * 0 // tick sproži ponovni izris živih minut
  const freeTables = tables.filter((t) => t.status !== 'OCCUPIED')

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-sm text-stone-600">
          {t('wl.desc')}
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5 shrink-0">
            <Plus className="w-4 h-4" /> {t('wl.newBtn')}
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statWaiting')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-amber-700">{stats.waiting}</p><p className="text-xs text-stone-500">{wlParty(stats.waitingParty, t)} {t('wl.naListo')}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statNotified')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-emerald-700">{stats.notified}</p><p className="text-xs text-stone-500">{t('wl.preparingTable')}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statSeated')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-green-700">{stats.seated}</p><p className="text-xs text-stone-500">{t('wl.leftCount', { n: stats.left })}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statAvgWait')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold">{wlDur(stats.avgActualWait)}</p><p className="text-xs text-stone-500">{t('wl.longest', { dur: wlDur(stats.maxActualWait) })}</p></CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('wl.activeTitle')}</CardTitle>
          <CardDescription className="text-xs">{t('wl.activeDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('gc.loading')}</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-stone-500">{t('wl.empty')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">{t('wl.thGuest')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('wl.thWait')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="px-3 py-2 text-right"><span className="sr-only">{t('common.actions')}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {active.map((w, i) => {
                    const mins = wlMin(w.checkedInAt, nowMs)
                    const over = w.quotedWaitMinutes > 0 && mins > w.quotedWaitMinutes
                    const badge = wlStatusBadge(w.status, t)
                    return (
                      <tr key={w.id} className="border-b last:border-0 align-top">
                        <td className="px-3 py-2 text-xs text-stone-400 font-medium">{i + 1}.</td>
                        <td className="px-3 py-2">
                          <span className="font-medium">{w.guestName}</span>
                          <span className="block text-xs text-stone-500">{wlParty(w.partySize, t)}{w.guestPhone ? ` · ${w.guestPhone}` : ''}{w.preferredArea ? ` · ${w.preferredArea}` : ''}</span>
                          {(w.specialNeeds || w.notes) && (
                            <span className="block text-xs text-stone-500 max-w-64 truncate" title={w.specialNeeds || w.notes}>ℹ {w.specialNeeds || w.notes}</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${over ? 'text-red-700 font-semibold' : ''}`}>
                          {wlDur(mins)}
                          <span className="block text-xs text-stone-400">{t('wl.forecast')} {w.quotedWaitMinutes > 0 ? `≈ ${w.quotedWaitMinutes} min` : '—'}</span>
                        </td>
                        <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${badge.cls}`}>{badge.label}</Badge></td>
                        {canManage && (
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {w.status === 'waiting' && (
                                <Button variant="outline" size="sm" disabled={busy} onClick={() => void transition(w, 'notified')} title={t('wl.notifyTitle')}>
                                  <Bell className="w-3.5 h-3.5" /> {t('wl.notifyBtn')}
                                </Button>
                              )}
                              <Button size="sm" disabled={busy} onClick={() => { setSeatFor(w); setSeatTableId('') }} title={t('wl.seatTitle')}>
                                <UserCheck className="w-3.5 h-3.5" /> {t('wl.seatBtn')}
                              </Button>
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(t('wl.confirmLeft', { name: w.guestName }))) void transition(w, 'left') }}>
                                {t('wl.leftBtn')}
                              </Button>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deleteEntry(w)} aria-label={t('wl.deleteAria', { name: w.guestName })} title={t('wl.deleteTitle')}>
                                <Trash2 className="w-3.5 h-3.5 text-stone-400" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {finished.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('wl.finishedTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('wl.finishedDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">{t('wl.thGuest')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('wl.thWaited')}</th>
                    <th className="px-3 py-2 font-medium">{t('wl.thTable')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {finished.map((w) => {
                    const badge = wlStatusBadge(w.status, t)
                    return (
                      <tr key={w.id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{w.guestName} <span className="text-xs text-stone-400 font-normal">{wlParty(w.partySize, t)}</span></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{w.status === 'seated' ? wlDur(w.actualWaitMinutes) : '—'}</td>
                        <td className="px-3 py-2 text-xs text-stone-600">{w.tableNumber ? t('wl.tableN', { n: w.tableNumber }) : '—'}</td>
                        <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${badge.cls}`}>{badge.label}</Badge></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nova prijava */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('wl.newTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-name">{t('loy.guestName')}</Label>
                <Input id="wl-name" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} placeholder={t('wl.namePlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-phone">{t('wl.phoneOptional')}</Label>
                <Input id="wl-phone" value={form.guestPhone} onChange={(e) => setForm({ ...form, guestPhone: e.target.value })} placeholder="041 234 567" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-party">{t('wl.partyLabel')}</Label>
                <Input id="wl-party" inputMode="numeric" value={form.partySize} onChange={(e) => setForm({ ...form, partySize: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-quote">{t('wl.quoteLabel')}</Label>
                <Input id="wl-quote" inputMode="numeric" value={form.quotedWaitMinutes} onChange={(e) => setForm({ ...form, quotedWaitMinutes: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-area">{t('wl.areaLabel')}</Label>
              <Input id="wl-area" value={form.preferredArea} onChange={(e) => setForm({ ...form, preferredArea: e.target.value })} placeholder={t('wl.areaPlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-needs">{t('wl.needsLabel')}</Label>
              <Input id="wl-needs" value={form.specialNeeds} onChange={(e) => setForm({ ...form, specialNeeds: e.target.value })} placeholder={t('wl.needsPlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-notes">{t('waste.noteOptional')}</Label>
              <Input id="wl-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={t('wl.notesPlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.guestName.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('wl.submitBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Usaditev */}
      <Dialog open={!!seatFor} onOpenChange={(o) => !o && setSeatFor(null)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('wl.seatTitleDialog', { name: seatFor?.guestName ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {seatFor && (
              <p className="text-sm text-stone-600">
                {wlParty(seatFor.partySize, t)} {t('wl.waitingSince')} <strong>{wlDur(wlMin(seatFor.checkedInAt, Date.now()))}</strong>
                {seatFor.preferredArea ? t('wl.wantsSuffix', { area: seatFor.preferredArea }) : ''}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="wl-table">{t('wl.thTable')}</Label>
              <Select value={seatTableId} onValueChange={setSeatTableId}>
                <SelectTrigger id="wl-table"><SelectValue placeholder={t('wl.tablePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {freeTables.map((tbl) => (
                    <SelectItem key={tbl.id} value={tbl.id}>
                      {tbl.name} ({t('tables.seats', { n: tbl.seats })} · {tbl.zone}{tbl.status !== 'FREE' ? ` · ${tbl.status === 'RESERVED' ? t('wl.tblReserved') : tbl.status === 'DIRTY' ? t('wl.tblDirty') : ''}` : ''})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {seatFor && freeTables.length === 0 && (
                <p className="text-xs text-red-600">{t('wl.noFreeTables')}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeatFor(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void seatEntry()} disabled={busy || !seatTableId}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />} {t('wl.seatBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── DELOVNI ČAS (clock-in/out, triage ⑥) ─────────────────────────── */

export interface TimeEntryT {
  id: string
  employeeId: string
  employeeName: string
  clockIn: string
  clockOut: string | null
  breakStart: string | null
  breakEnd: string | null
  breakMinutes: number
  totalMinutes: number
  payRate: number
  totalPay: number
  type: string
  status: string
  notes: string
  locationId?: string | null
}

export interface TimeclockEmployeeT { id: string; name: string; role: string }

const tcTypeBadge: Record<string, string> = {
  regular: 'bg-stone-100 text-stone-700',
  overtime: 'bg-amber-100 text-amber-800',
  holiday: 'bg-violet-100 text-violet-800',
  sick: 'bg-rose-100 text-rose-800',
  vacation: 'bg-teal-100 text-teal-800',
}
const tcTypeKeys: Record<string, string> = {
  regular: 'tc.typeRegular', overtime: 'tc.typeOvertime', holiday: 'tc.typeHoliday', sick: 'tc.typeSick', vacation: 'tc.typeVacation',
}
const tcStatusBadge: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  disputed: 'bg-red-100 text-red-800',
}
const tcStatusKeys: Record<string, string> = {
  active: 'tc.stPending', approved: 'tc.stApproved', disputed: 'tc.stDisputed',
}

function tcTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function tcDur(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}
function tcPay(eur: number): string {
  return eur.toFixed(2).replace('.', ',') + ' €'
}

export function DelovniCasTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [mine, setMine] = useState<TimeEntryT[]>([])
  const [activeEntry, setActiveEntry] = useState<TimeEntryT | null>(null)
  const [myStats, setMyStats] = useState<{ totalMinutes: number; approvedMinutes: number } | null>(null)
  const [team, setTeam] = useState<{ entries: TimeEntryT[]; employees: TimeclockEmployeeT[]; activeNow: { employeeId: string; employeeName: string; clockIn: string; breakStart: string | null }[]; stats: { totalMinutes: number; approvedMinutes: number; disputedCount: number; activeCount: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [tick, setTick] = useState(0)

  // ročni vnos (manager)
  const [manualOpen, setManualOpen] = useState(false)
  const [manual, setManual] = useState({ employeeId: '', clockIn: '', clockOut: '', breakMinutes: '0', type: 'regular', note: '' })
  const [teamDays, setTeamDays] = useState('7')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const own = await api<{ entries: TimeEntryT[]; activeEntry: TimeEntryT | null; stats: { totalMinutes: number; approvedMinutes: number } }>('/api/timeclock')
      setMine(own.entries)
      setActiveEntry(own.activeEntry)
      setMyStats(own.stats)
      if (canManage) {
        const t = await api<{ entries: TimeEntryT[]; employees: TimeclockEmployeeT[]; activeNow: { employeeId: string; employeeName: string; clockIn: string; breakStart: string | null }[]; stats: { totalMinutes: number; approvedMinutes: number; disputedCount: number; activeCount: number } }>(`/api/timeclock?scope=team&days=${teamDays}`)
        setTeam(t)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const iv = setInterval(() => setTick((x) => x + 1), 30_000)
    return () => clearInterval(iv)
  }, [canManage, teamDays])

  async function act(action: string) {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ summary?: { label: string; totalPay: number } }>('/api/timeclock', { method: 'POST', body: JSON.stringify({ action }) })
      if (action === 'clock-in') setOkMsg(t('tc.okClockIn'))
      else if (action === 'break-start') setOkMsg(t('tc.okBreakStart'))
      else if (action === 'break-end') setOkMsg(t('tc.okBreakEnd'))
      else if (action === 'clock-out' && d.summary) setOkMsg(t('tc.okClockOut', { label: d.summary.label, pay: d.summary.totalPay > 0 ? t('tc.okClockOutPay', { pay: tcPay(d.summary.totalPay) }) : '' }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function review(id: string, status: 'approved' | 'disputed') {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api(`/api/timeclock/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setOkMsg(status === 'approved' ? t('tc.okApproved') : t('tc.okDisputed'))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitManual() {
    if (!manual.employeeId) { setErr(t('tc.errEmployee')); return }
    if (!manual.clockIn || !manual.clockOut) { setErr(t('tc.errTimes')); return }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api('/api/timeclock', {
        method: 'POST',
        body: JSON.stringify({
          action: 'manual',
          employeeId: manual.employeeId,
          clockIn: new Date(manual.clockIn).toISOString(),
          clockOut: new Date(manual.clockOut).toISOString(),
          breakMinutes: Number(manual.breakMinutes) || 0,
          type: manual.type,
          note: manual.note || undefined,
        }),
      })
      setOkMsg(t('tc.okManual'))
      setManualOpen(false)
      setManual({ employeeId: '', clockIn: '', clockOut: '', breakMinutes: '0', type: 'regular', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onBreak = activeEntry?.breakStart !== null && activeEntry?.breakStart !== undefined && activeEntry?.breakEnd === null
  const nowMs = Date.now() + tick * 0 // tick sproži preracun
  const liveMin = activeEntry ? Math.max(0, Math.round((nowMs - new Date(activeEntry.clockIn).getTime()) / 60000) - activeEntry.breakMinutes) : 0

  return (
    <div className="space-y-6">
      {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700" role="status">{okMsg}</p>}

      {/* Moja ura */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Timer className="w-4 h-4" /> {activeEntry ? t('tc.shiftActive') : t('tc.myTitle')}</CardTitle>
          <CardDescription>{activeEntry ? t('tc.clockedInAt', { time: tcTime(activeEntry.clockIn), rate: activeEntry.payRate > 0 ? t('tc.rateSuffix', { pay: tcPay(activeEntry.payRate) }) : '' }) : t('tc.myDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeEntry ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-3xl font-bold tabular-nums">{tcDur(liveMin)}</div>
              {onBreak ? (
                <Badge className="bg-amber-100 text-amber-800">{t('tc.onBreakBadge', { time: new Date(activeEntry.breakStart!).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }) })}</Badge>
              ) : (
                <Badge className="bg-emerald-100 text-emerald-800">{t('tc.inProgress')}</Badge>
              )}
              <div className="flex gap-2 ml-auto flex-wrap">
                {!onBreak ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-start')}><Coffee className="w-4 h-4 mr-1" /> {t('tc.breakBtn')}</Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-end')}><Coffee className="w-4 h-4 mr-1" /> {t('tc.breakEndBtn')}</Button>
                )}
                <Button className="bg-red-700 hover:bg-red-800" disabled={busy} onClick={() => void act('clock-out')}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4 mr-1" />} {t('tc.clockOutBtn')}
                </Button>
              </div>
            </div>
          ) : (
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void act('clock-in')}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4 mr-1" />} {t('tc.clockInBtn')}
            </Button>
          )}
          {myStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-stone-100">
              <div><p className="text-xs text-stone-500">{t('waste.days30')}</p><p className="font-bold">{tcDur(myStats.totalMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">{t('tc.stApproved')}</p><p className="font-bold">{tcDur(myStats.approvedMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">{t('tc.entriesCount')}</p><p className="font-bold">{mine.length}</p></div>
              <div><p className="text-xs text-stone-500">{t('shifts.csvStatus')}</p><p className="font-bold">{activeEntry ? t('tc.onShift') : t('tc.offShift')}</p></div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Moja zgodovina */}
      <Card>
        <CardHeader><CardTitle className="text-base">{t('tc.myHistory')}</CardTitle></CardHeader>
        <CardContent>
          {mine.length === 0 && <p className="text-sm text-stone-500">{t('tc.myEmpty')}</p>}
          {mine.length > 0 && (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                  <th className="py-2 pr-3">{t('tc.thIn')}</th><th className="py-2 pr-3">{t('tc.thOut')}</th><th className="py-2 pr-3">{t('tc.thBreak')}</th>
                  <th className="py-2 pr-3">{t('tc.thTotal')}</th><th className="py-2 pr-3">{t('tc.thPay')}</th><th className="py-2 pr-3">{t('dev.typeLabel')}</th><th className="py-2">{t('shifts.csvStatus')}</th>
                </tr></thead>
                <tbody>
                  {mine.map((e) => (
                    <tr key={e.id} className="border-b border-stone-100">
                      <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">{t('tc.running')}</span>}</td>
                      <td className="py-2 pr-3">{e.breakMinutes > 0 ? tcDur(e.breakMinutes) : '—'}</td>
                      <td className="py-2 pr-3 font-semibold">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                      <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                      <td className="py-2 pr-3"><Badge className={tcTypeBadge[e.type] || 'bg-stone-100 text-stone-700'}>{tcTypeKeys[e.type] ? t(tcTypeKeys[e.type]) : e.type}</Badge></td>
                      <td className="py-2"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusKeys[e.status] ? t(tcStatusKeys[e.status]) : e.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ekipni vpogled (manager) */}
      {canManage && team && (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4" /> {t('tc.teamTitle')}</CardTitle>
              <CardDescription>{t('tc.teamDesc')}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={teamDays} onValueChange={setTeamDays}>
                <SelectTrigger className="w-32 h-8 text-xs" aria-label={t('tc.periodAria')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('shifts.csvToday')}</SelectItem>
                  <SelectItem value="7">{t('tc.day7')}</SelectItem>
                  <SelectItem value="14">{t('tc.day14')}</SelectItem>
                  <SelectItem value="31">{t('tc.day31')}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setManualOpen(true)}><Plus className="w-4 h-4 mr-1" /> {t('tc.manualBtn')}</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.totalPeriod')}</p><p className="text-lg font-bold">{tcDur(team.stats.totalMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.stApproved')}</p><p className="text-lg font-bold">{tcDur(team.stats.approvedMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.pendingApproval')}</p><p className="text-lg font-bold">{team.stats.activeCount}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">{t('tc.nowOnShift')}</p><p className="text-lg font-bold">{team.activeNow.length}</p></div>
            </div>
            {team.activeNow.length > 0 && (
              <div className="text-sm text-stone-600">
                <span className="font-semibold">{t('tc.onShiftColon')}</span>
                {team.activeNow.map((a) => `${a.employeeName}${a.breakStart ? ' ☕' : ''}`).join(', ')}
              </div>
            )}
            {team.entries.length === 0 && <p className="text-sm text-stone-500">{t('tc.teamEmpty')}</p>}
            {team.entries.length > 0 && (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                    <th className="py-2 pr-3">{t('shifts.csvEmployee')}</th><th className="py-2 pr-3">{t('tc.thIn')}</th><th className="py-2 pr-3">{t('tc.thOut')}</th>
                    <th className="py-2 pr-3">{t('tc.thTotal')}</th><th className="py-2 pr-3">{t('tc.thPay')}</th><th className="py-2 pr-3">{t('shifts.csvStatus')}</th><th className="py-2">{t('common.actions')}</th>
                  </tr></thead>
                  <tbody>
                    {team.entries.map((e) => (
                      <tr key={e.id} className="border-b border-stone-100">
                        <td className="py-2 pr-3 font-medium">{e.employeeName}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">{t('tc.running')}</span>}</td>
                        <td className="py-2 pr-3">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                        <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                        <td className="py-2 pr-3"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusKeys[e.status] ? t(tcStatusKeys[e.status]) : e.status}</Badge></td>
                        <td className="py-2">
                          {e.status !== 'approved' && e.clockOut && (
                            <Button size="sm" variant="outline" className="h-7 mr-1" disabled={busy} onClick={() => void review(e.id, 'approved')} title={t('tc.approveTitle')}><CheckCircle2 className="w-3.5 h-3.5" /><span className="sr-only">{t('tc.approveSr')}</span></Button>
                          )}
                          {e.status !== 'disputed' && (
                            <Button size="sm" variant="outline" className="h-7 text-red-700" disabled={busy} onClick={() => void review(e.id, 'disputed')} title={t('tc.disputeTitle')}><XCircle className="w-3.5 h-3.5" /><span className="sr-only">{t('tc.disputeTitle')}</span></Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ročni vnos dialog */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('tc.manualTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tc-employee">{t('shifts.csvEmployee')}</Label>
              <Select value={manual.employeeId} onValueChange={(v) => setManual((m) => ({ ...m, employeeId: v }))}>
                <SelectTrigger id="tc-employee"><SelectValue placeholder={t('tc.employeePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {(team?.employees || []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} ({e.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-in">{t('tc.thIn')}</Label>
                <Input id="tc-in" type="datetime-local" value={manual.clockIn} onChange={(e) => setManual((m) => ({ ...m, clockIn: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-out">{t('tc.thOut')}</Label>
                <Input id="tc-out" type="datetime-local" value={manual.clockOut} onChange={(e) => setManual((m) => ({ ...m, clockOut: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-break">{t('tc.breakMinutes')}</Label>
                <Input id="tc-break" type="number" min="0" value={manual.breakMinutes} onChange={(e) => setManual((m) => ({ ...m, breakMinutes: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-type">{t('dev.typeLabel')}</Label>
                <Select value={manual.type} onValueChange={(v) => setManual((m) => ({ ...m, type: v }))}>
                  <SelectTrigger id="tc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular">{t('tc.typeRegular')}</SelectItem>
                    <SelectItem value="overtime">{t('tc.typeOvertime')}</SelectItem>
                    <SelectItem value="holiday">{t('tc.typeHoliday')}</SelectItem>
                    <SelectItem value="sick">{t('tc.typeSick')}</SelectItem>
                    <SelectItem value="vacation">{t('tc.typeVacation')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tc-note">{t('haccp.note')}</Label>
              <Input id="tc-note" value={manual.note} onChange={(e) => setManual((m) => ({ ...m, note: e.target.value }))} placeholder={t('tc.notePlaceholder')} />
            </div>
            <p className="text-xs text-stone-500">{t('tc.manualHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitManual()} disabled={busy || !manual.employeeId || !manual.clockIn || !manual.clockOut}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('tc.addEntryBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('tc.loading')}</p>}
      {busy && !loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ODPIRALNI ČAS (issue #1, triage ⑦) ─────────────────────────── */

export interface OpeningHoursRowT { id: string; dayOfWeek: number; openTime: string; closeTime: string; breakStart: string; breakEnd: string; isClosed: boolean }
export interface SpecialDayT { id: string; date: string; isClosed: boolean; openTime: string; closeTime: string; note: string }
export interface OpenStatusT { isOpen: boolean; phase: string; label: string; detail: string; nextChangeAt: string | null; nextChangeLabel: string }
export interface OpeningHoursDataT {
  locationId: string
  inherited: boolean
  rows: OpeningHoursRowT[]
  specialDays: SpecialDayT[]
  status: OpenStatusT
  holidays: { date: string; name: string }[]
  holidaysYear: number
}

const DEFAULT_WEEK: OpeningHoursRowT[] = Array.from({ length: 7 }, (_, dow) => ({
  id: `new-${dow}`, dayOfWeek: dow, openTime: '08:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
}))

const PHASE_STYLES: Record<string, { dot: string; card: string }> = {
  open: { dot: 'bg-emerald-500', card: 'border-emerald-200 bg-emerald-50' },
  break: { dot: 'bg-amber-500', card: 'border-amber-200 bg-amber-50' },
  closed_day: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
  special_closed: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
  special_hours: { dot: 'bg-sky-500', card: 'border-sky-200 bg-sky-50' },
  outside_hours: { dot: 'bg-red-400', card: 'border-red-200 bg-red-50' },
}

function fmtDateSL(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('sl-SI', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function OdpiralniCasTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [data, setData] = useState<OpeningHoursDataT | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<OpeningHoursRowT[]>(DEFAULT_WEEK)
  const [showBreak, setShowBreak] = useState<boolean[]>(Array(7).fill(false))
  const [spOpen, setSpOpen] = useState(false)
  const [sp, setSp] = useState({ date: '', isClosed: true, openTime: '', closeTime: '', note: '' })

  async function load() {
    try {
      const d = await api<OpeningHoursDataT>('/api/opening-hours')
      setData(d)
      const rows = d.rows.length === 7 ? d.rows : DEFAULT_WEEK
      setEdit(rows.map((r) => ({ ...r, id: r.id || `new-${r.dayOfWeek}` })))
      setShowBreak(Array.from({ length: 7 }, (_, i) => Boolean(rows[i]?.breakStart && rows[i]?.breakEnd)))
    } catch { /* status ostaja — napaka v msg */ } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  // status se osveži vsake 60 s (živi odprto/zaprto indikator)
  useEffect(() => {
    const t = setInterval(() => { void load() }, 60_000)
    return () => clearInterval(t)
  }, [])

  function setRow(dow: number, patch: Partial<OpeningHoursRowT>) {
    setEdit((rows) => rows.map((r) => (r.dayOfWeek === dow ? { ...r, ...patch } : r)))
  }

  async function save() {
    setBusy(true); setMsg('')
    try {
      const res = await api<{ rows: OpeningHoursRowT[]; status: OpenStatusT }>('/api/opening-hours', {
        method: 'PUT',
        body: JSON.stringify({ rows: edit.map((r) => ({ dayOfWeek: r.dayOfWeek, openTime: r.openTime, closeTime: r.closeTime, breakStart: r.breakStart, breakEnd: r.breakEnd, isClosed: r.isClosed })) }),
      })
      setData((d) => (d ? { ...d, rows: res.rows, status: res.status, inherited: false } : d))
      setMsg(t('oh.okSaved'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addSpecial() {
    setBusy(true); setMsg('')
    try {
      await api('/api/opening-hours/special', { method: 'POST', body: JSON.stringify(sp) })
      setSpOpen(false)
      setSp({ date: '', isClosed: true, openTime: '', closeTime: '', note: '' })
      setMsg(t('oh.okSpecialAdded'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function deleteSpecial(id: string) {
    if (!confirm(t('oh.confirmDeleteSpecial'))) return
    setBusy(true)
    try {
      await api(`/api/opening-hours/special?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setMsg(t('oh.okSpecialDeleted'))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addHolidays() {
    if (!data?.holidays?.length) return
    if (!confirm(t('oh.confirmHolidays', { n: data.holidays.length, year: data.holidaysYear }))) return
    setBusy(true); setMsg('')
    try {
      const res = await api<{ added: number; skipped: string[] }>('/api/opening-hours/special', {
        method: 'POST', body: JSON.stringify({ holidays: data.holidays.map((h) => ({ date: h.date, name: h.name })) }),
      })
      setMsg(t('oh.okHolidays', { added: res.added, skipped: res.skipped.length }))
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  const st = data?.status
  const phaseStyle = PHASE_STYLES[st?.phase ?? 'closed_day'] ?? PHASE_STYLES.closed_day

  return (
    <div className="space-y-4">
      {/* trenutni status — jasen odprto/zaprto indikator */}
      <Card className={phaseStyle.card}>
        <CardContent className="p-4">
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('oh.loadingStatus')}</p>
          ) : st ? (
            <div className="flex flex-wrap items-center gap-3">
              <span aria-hidden className={`w-3 h-3 rounded-full shrink-0 ${phaseStyle.dot} ${st.isOpen ? 'animate-pulse' : ''}`} />
              <div className="min-w-0">
                <p className="font-semibold text-stone-800">
                  {st.label}
                  {st.nextChangeLabel && <span className="font-normal text-stone-600"> — {st.nextChangeLabel}</span>}
                </p>
                <p className="text-sm text-stone-600">{st.detail}</p>
              </div>
              {data?.inherited && canManage && (
                <Badge variant="outline" className="ml-auto shrink-0">{t('oh.inheritedBadge')}</Badge>
              )}
            </div>
          ) : (
            <p className="text-sm text-stone-500">{t('oh.noStatus')}</p>
          )}
        </CardContent>
      </Card>

      {/* tedenski urnik */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-emerald-700" /> {t('oh.weekTitle')}</CardTitle>
            {canManage && <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void save()} disabled={busy}><CheckCircle2 className="w-3.5 h-3.5" /> {t('oh.saveBtn')}</Button>}
          </div>
          <CardDescription>{t('oh.weekDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {edit.map((r) => (
            <div key={r.dayOfWeek} className="rounded-lg border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-sm font-medium text-stone-700 shrink-0">{t(`oh.day${r.dayOfWeek}`)}</span>
                <Switch checked={!r.isClosed} onCheckedChange={(v) => setRow(r.dayOfWeek, v ? { isClosed: false, openTime: r.openTime || '08:00', closeTime: r.closeTime || '22:00' } : { isClosed: true, breakStart: '', breakEnd: '' })} disabled={!canManage} aria-label={t('oh.ariaOpen', { day: t(`oh.day${r.dayOfWeek}`) })} />
                {r.isClosed ? (
                  <Badge variant="outline" className="text-red-600 border-red-200">{t('oh.closed')}</Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input type="time" className="w-28 h-8" value={r.openTime} onChange={(e) => setRow(r.dayOfWeek, { openTime: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaOpens', { day: t(`oh.day${r.dayOfWeek}`) })} />
                    <span className="text-stone-400 text-sm">–</span>
                    <Input type="time" className="w-28 h-8" value={r.closeTime} onChange={(e) => setRow(r.dayOfWeek, { closeTime: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaCloses', { day: t(`oh.day${r.dayOfWeek}`) })} />
                    {canManage && (
                      <Button size="sm" variant={showBreak[r.dayOfWeek] ? 'secondary' : 'outline'} className="h-8 px-2 text-xs" onClick={() => setShowBreak((b) => b.map((v, i) => (i === r.dayOfWeek ? !v : v)))}>
                        <Coffee className="w-3.5 h-3.5" /> {t('tc.breakBtn')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {!r.isClosed && showBreak[r.dayOfWeek] && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pl-1 sm:pl-28">
                  <span className="text-xs text-stone-500 w-auto">{t('oh.breakColon')}</span>
                  <Input type="time" className="w-28 h-8" value={r.breakStart} onChange={(e) => setRow(r.dayOfWeek, { breakStart: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaBreakFrom', { day: t(`oh.day${r.dayOfWeek}`) })} />
                  <span className="text-stone-400 text-sm">–</span>
                  <Input type="time" className="w-28 h-8" value={r.breakEnd} onChange={(e) => setRow(r.dayOfWeek, { breakEnd: e.target.value })} disabled={!canManage} aria-label={t('oh.ariaBreakTo', { day: t(`oh.day${r.dayOfWeek}`) })} />
                </div>
              )}
            </div>
          ))}
          {msg && <p className="text-sm text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> {msg}</p>}
          {err && <p className="text-sm text-red-700 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> {err}</p>}
        </CardContent>
      </Card>

      {/* posebni dnevi / prazniki */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-emerald-700" /> {t('oh.specialTitle')}</CardTitle>
              <CardDescription>{t('oh.specialDesc')}</CardDescription>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1" onClick={() => void addHolidays()} disabled={busy || !data?.holidays?.length}>
                  <Plus className="w-3.5 h-3.5" /> {t('oh.holidaysBtn', { year: data?.holidaysYear ?? '' })}
                </Button>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setSpOpen(true)} disabled={busy}>
                  <Plus className="w-3.5 h-3.5" /> {t('oh.specialBtn')}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {(data?.specialDays?.length ?? 0) === 0 ? (
            <p className="text-sm text-stone-500">{t('oh.specialEmpty')}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {data!.specialDays.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800">{fmtDateSL(s.date)}</p>
                    <p className="text-xs text-stone-500">
                      {s.isClosed ? t('oh.closedAllDay') : t('oh.openHours', { range: `${s.openTime}–${s.closeTime}` })}
                      {s.note ? ` · ${s.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant={s.isClosed ? 'destructive' : 'outline'}>{s.isClosed ? t('oh.closed') : t('oh.specialSchedule')}</Badge>
                    {canManage && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-red-600 border-red-200 hover:bg-red-50" disabled={busy} onClick={() => void deleteSpecial(s.id)}>
                        <Trash2 className="w-3.5 h-3.5" /><span className="sr-only">{t('oh.deleteSpecialAria', { date: s.date })}</span>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* dialog: nov poseben dan */}
      <Dialog open={spOpen} onOpenChange={setSpOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('oh.dialogTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sp-date">{t('exp.csvDate')}</Label>
              <Input id="sp-date" type="date" value={sp.date} onChange={(e) => setSp({ ...sp, date: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
              <Label htmlFor="sp-closed" className="font-normal">{t('oh.closedAllDay')}</Label>
              <Switch id="sp-closed" checked={sp.isClosed} onCheckedChange={(v) => setSp({ ...sp, isClosed: v })} />
            </div>
            {!sp.isClosed && (
              <div className="flex items-center gap-2">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-open">{t('oh.opensAt')}</Label>
                  <Input id="sp-open" type="time" value={sp.openTime} onChange={(e) => setSp({ ...sp, openTime: e.target.value })} />
                </div>
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-close">{t('oh.closesAt')}</Label>
                  <Input id="sp-close" type="time" value={sp.closeTime} onChange={(e) => setSp({ ...sp, closeTime: e.target.value })} />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="sp-note">{t('oh.noteReason')}</Label>
              <Input id="sp-note" value={sp.note} onChange={(e) => setSp({ ...sp, note: e.target.value })} placeholder={t('oh.notePlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={() => void addSpecial()} disabled={busy || !sp.date}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('inv.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && !data && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('tc.loading')}</p>}
    </div>
  )
}

/* ─────────────────────────── POPUSTI (admin upravljanje, Task 59) ─────────────────────────── */

export interface DiscountRowT {
  id: string
  name: string
  type: string
  amount: number
  appliesTo: string
  triggerType: string
  promoCode: string
  maxUses: number | null
  currentUses: number
  validFrom: string | null
  validTo: string | null
  happyDays: string
  happyFromHour: number | null
  happyToHour: number | null
  targetCategoryIds: string
  isActive: boolean
  sortOrder: number
}

interface CatLiteT { id: string; name: string }

const DAY_KEYS = ['disc.day0', 'disc.day1', 'disc.day2', 'disc.day3', 'disc.day4', 'disc.day5', 'disc.day6'] as const

interface DiscForm {
  name: string; type: string; amount: string; triggerType: string; promoCode: string
  maxUses: string; validFrom: string; validTo: string
  happy: boolean; days: number[]; fromHour: string; toHour: string; cats: string[]
}

const emptyForm = (): DiscForm => ({
  name: '', type: 'percent', amount: '', triggerType: 'manual', promoCode: '',
  maxUses: '', validFrom: '', validTo: '', happy: false, days: [1, 2, 3, 4, 5], fromHour: '16', toHour: '18', cats: [],
})

const rowToForm = (d: DiscountRowT): DiscForm => ({
  name: d.name,
  type: d.type,
  amount: String(d.amount),
  triggerType: d.triggerType,
  promoCode: d.promoCode || '',
  maxUses: d.maxUses == null ? '' : String(d.maxUses),
  validFrom: d.validFrom ? d.validFrom.slice(0, 10) : '',
  validTo: d.validTo ? d.validTo.slice(0, 10) : '',
  happy: d.happyFromHour != null,
  days: d.happyDays ? d.happyDays.split(',').map(Number) : [1, 2, 3, 4, 5],
  fromHour: d.happyFromHour == null ? '16' : String(d.happyFromHour),
  toHour: d.happyToHour == null ? '18' : String(d.happyToHour),
  cats: d.targetCategoryIds ? d.targetCategoryIds.split(',') : [],
})

const formPayload = (f: DiscForm) => ({
  name: f.name,
  type: f.type,
  amount: Number(f.amount.replace(',', '.')),
  triggerType: f.triggerType,
  promoCode: f.promoCode,
  maxUses: f.maxUses === '' ? null : Number(f.maxUses),
  validFrom: f.validFrom || null,
  validTo: f.validTo || null,
  happyDays: f.happy ? [...f.days].sort().join(',') : '',
  happyFromHour: f.happy ? Number(f.fromHour) : null,
  happyToHour: f.happy ? Number(f.toHour) : null,
  targetCategoryIds: f.cats.join(','),
  isActive: true,
})

const HOURS = Array.from({ length: 24 }, (_, i) => String(i))

export function DiscountsTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<DiscountRowT[]>([])
  const [cats, setCats] = useState<CatLiteT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<DiscForm>(emptyForm())

  const load = async () => {
    setLoading(true)
    try {
      const [ds, ms] = await Promise.all([
        api<{ discounts: DiscountRowT[] }>('/api/discounts'),
        api<{ categories: CatLiteT[] }>('/api/menus').catch(() => ({ categories: [] })),
      ])
      setRows(ds.discounts || [])
      setCats(ms.categories || [])
      setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const setF = (p: Partial<DiscForm>) => setForm((f) => ({ ...f, ...p }))
  const valid = form.name.trim().length > 0 && Number(form.amount.replace(',', '.')) > 0 && (!form.happy || form.fromHour !== form.toHour)

  function openCreate() { setEditId(null); setForm(emptyForm()); setErr(''); setOpen(true) }
  function openEdit(d: DiscountRowT) { setEditId(d.id); setForm(rowToForm(d)); setErr(''); setOpen(true) }

  async function save() {
    if (!valid) return
    setBusy(true); setErr('')
    try {
      if (editId) await api(`/api/discounts/${editId}`, { method: 'PATCH', body: JSON.stringify(formPayload(form)) })
      else await api('/api/discounts', { method: 'POST', body: JSON.stringify(formPayload(form)) })
      setOpen(false); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function toggle(d: DiscountRowT) {
    setBusy(true)
    try { await api(`/api/discounts/${d.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !d.isActive }) }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function remove(d: DiscountRowT) {
    if (!window.confirm(t('disc.deleteConfirm', { name: d.name }))) return
    setBusy(true)
    try { await api(`/api/discounts/${d.id}`, { method: 'DELETE' }); await load() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const happyText = (d: DiscountRowT) => {
    if (d.happyFromHour == null || d.happyToHour == null) return null
    const days = d.happyDays ? d.happyDays.split(',').map((n) => t(DAY_KEYS[Number(n)] || 'disc.day0')).join(', ') : t('disc.everyDay')
    return `${days} · ${d.happyFromHour}–${d.happyToHour}`
  }

  const active = rows.filter((d) => d.isActive).length
  const auto = rows.filter((d) => d.triggerType === 'auto').length
  const promo = rows.filter((d) => d.promoCode).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Percent className="w-4 h-4" /> {t('disc.kpiActive')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{active}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Clock className="w-4 h-4" /> {t('disc.kpiAuto')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{auto}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Ticket className="w-4 h-4" /> {t('disc.kpiPromo')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{promo}</p></CardContent></Card>
      </div>

      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {canManage && (
        <div className="flex justify-end">
          <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={openCreate}><Plus className="w-4 h-4 mr-1" /> {t('disc.new')}</Button>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('disc.list')}</CardTitle></CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('disc.loading')}</p>}
          {!loading && rows.length === 0 && <p className="text-sm text-stone-500">{t('disc.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="space-y-2">
              {rows.map((d) => {
                const hw = happyText(d)
                return (
                  <div key={d.id} className={`rounded-lg border p-3 flex items-center justify-between gap-3 ${d.isActive ? 'border-stone-200 bg-white' : 'border-stone-200 bg-stone-50 opacity-75'}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium truncate">{d.name}</p>
                        <Badge className="bg-emerald-700 text-white">{d.type === 'percent' ? `−${d.amount} %` : `−${fmtEUR(d.amount)}`}</Badge>
                        {d.triggerType === 'auto' && <Badge variant="outline">{t('disc.auto')}</Badge>}
                        {!d.isActive && <Badge variant="outline" className="text-stone-500">{t('disc.inactive')}</Badge>}
                      </div>
                      <p className="text-xs text-stone-500 mt-1">
                        {d.appliesTo === 'item' ? t('disc.appliesItems') : t('disc.appliesCheck')}
                        {d.promoCode ? ` · ${t('disc.promo')}: ${d.promoCode}` : ''}
                        {d.maxUses != null ? ` · ${t('disc.uses', { n: d.currentUses, m: d.maxUses })}` : ` · ${t('disc.unlimited', { n: d.currentUses })}`}
                        {hw ? ` · ${hw}` : ''}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch checked={d.isActive} disabled={busy} onCheckedChange={() => void toggle(d)} aria-label={t('disc.toggleAria', { name: d.name })} />
                        <Button size="sm" variant="outline" onClick={() => openEdit(d)}>{t('disc.edit')}</Button>
                        <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" disabled={busy} onClick={() => void remove(d)} aria-label={t('disc.deleteAria', { name: d.name })}><Trash2 className="w-4 h-4" /></Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editId ? t('disc.editTitle') : t('disc.newTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dc-name">{t('disc.name')}</Label>
              <Input id="dc-name" value={form.name} onChange={(e) => setF({ name: e.target.value })} placeholder={t('disc.namePh')} maxLength={120} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-type">{t('disc.type')}</Label>
                <Select value={form.type} onValueChange={(v) => setF({ type: v })}>
                  <SelectTrigger id="dc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>{['percent', 'fixed'].map((v) => <SelectItem key={v} value={v}>{v === 'percent' ? t('disc.percent') : t('disc.fixed')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-amount">{t('disc.amount')}</Label>
                <Input id="dc-amount" inputMode="decimal" value={form.amount} onChange={(e) => setF({ amount: e.target.value.replace(/[^\d.,]/g, '') })} placeholder={form.type === 'percent' ? t('disc.amountPercentPh') : t('disc.amountEurPh')} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-trig">{t('disc.trigger')}</Label>
                <Select value={form.triggerType} onValueChange={(v) => setF({ triggerType: v })}>
                  <SelectTrigger id="dc-trig"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('disc.manual')}</SelectItem>
                    <SelectItem value="auto">{t('disc.auto')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-promo">{t('disc.promo')}</Label>
                <Input id="dc-promo" value={form.promoCode} onChange={(e) => setF({ promoCode: e.target.value.toUpperCase() })} placeholder={t('disc.promoPh')} maxLength={40} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-max">{t('disc.maxUses')}</Label>
                <Input id="dc-max" inputMode="numeric" value={form.maxUses} onChange={(e) => setF({ maxUses: e.target.value.replace(/\D/g, '') })} placeholder={t('disc.maxUsesPh')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-vf">{t('disc.validFrom')}</Label>
                <Input id="dc-vf" type="date" value={form.validFrom} onChange={(e) => setF({ validFrom: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-vt">{t('disc.validTo')}</Label>
                <Input id="dc-vt" type="date" value={form.validTo} onChange={(e) => setF({ validTo: e.target.value })} />
              </div>
            </div>
            <div className="rounded-lg border border-stone-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="dc-happy">{t('disc.happy')}</Label>
                <Switch id="dc-happy" checked={form.happy} onCheckedChange={(v) => setF({ happy: v })} />
              </div>
              {form.happy && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {DAY_KEYS.map((k, i) => (
                      <button
                        key={k} type="button"
                        className={`rounded-full px-2.5 py-1 text-xs border transition ${form.days.includes(i) ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'}`}
                        aria-pressed={form.days.includes(i)}
                        onClick={() => setF({ days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i] })}
                      >{t(k)}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="dc-hf">{t('disc.from')}</Label>
                      <Select value={form.fromHour} onValueChange={(v) => setF({ fromHour: v })}>
                        <SelectTrigger id="dc-hf"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-56">{HOURS.map((h) => <SelectItem key={h} value={h}>{h}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dc-ht">{t('disc.to')}</Label>
                      <Select value={form.toHour} onValueChange={(v) => setF({ toHour: v })}>
                        <SelectTrigger id="dc-ht"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-h-56">{HOURS.map((h) => <SelectItem key={h} value={h}>{h}:00</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {cats.length > 0 && (
              <div className="space-y-1.5">
                <Label>{t('disc.cats')}</Label>
                <p className="text-[11px] text-stone-400">{t('disc.catsHint')}</p>
                <ScrollArea className="max-h-32 rounded-lg border border-stone-200 p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {cats.map((c) => (
                      <button
                        key={c.id} type="button"
                        className={`rounded-full px-2.5 py-1 text-xs border transition ${form.cats.includes(c.id) ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'}`}
                        aria-pressed={form.cats.includes(c.id)}
                        onClick={() => setF({ cats: form.cats.includes(c.id) ? form.cats.filter((x) => x !== c.id) : [...form.cats, c.id] })}
                      >{c.name}</button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
            {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('disc.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('disc.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


/* ─────────────── Integracije (Task 60 — audit §7 Integracije PARTIAL→DONE) ─────────────── */

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
  useEffect(() => { void load() }, [])

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
                  <p className="text-[11px] text-stone-400">{t('integ.maskedNote')}: {d.maskedFields.join(', ')}</p>
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
              <p className="text-[11px] text-stone-400">{t('integ.configHint')}</p>
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
interface KdsStatsResp {
  days: number; generatedAt: string
  kpi: { todayAvgPrep: number; todayCount: number; onTimePct: number; okPct: number; warnPct: number; latePct: number }
  items: KdsStatItem[]
  heatmap: { hour: number; half: number; avg: number; count: number }[]
  delays: { reason: string; count: number }[]
}

function kdsHeatClass(avg: number, count: number): string {
  if (!count) return 'bg-stone-100 border border-stone-200'
  if (avg <= 5) return 'bg-emerald-500'
  if (avg <= 10) return 'bg-amber-500'
  return 'bg-rose-500'
}

export function KdsStatsSection() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [days, setDays] = useState<'7' | '14' | '30'>('7')
  const [station, setStation] = useState<'ALL' | 'KITCHEN' | 'BAR'>('ALL')
  const [data, setData] = useState<KdsStatsResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)

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

/* ─────────────────── OPS-8 val 2 — DURS VAT payer check ─────────────────── */

interface DursEntryT { taxNumber: string; vatId: string; name: string; vatPayer: boolean; ibans: string[]; source?: 'inetis' | 'vies' }
type DursState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'none' }
  | { kind: 'ok'; entry: DursEntryT | null }

/** DURS VAT payer check button (ddv.inetis.com proxy): payer badge + autofill name + bank account. */
export function DursCheckButton({ query, onName, onIban, compact = false }: { query: string; onName?: (name: string) => void; onIban?: (iban: string) => void; compact?: boolean }) {
  const { t } = useI18n()
  const [state, setState] = useState<DursState>({ kind: 'idle' })

  const run = async () => {
    if (state.kind === 'loading') return
    setState({ kind: 'loading' })
    try {
      const res = await api<{ results?: DursEntryT[]; entry?: DursEntryT | null; error?: string }>(`/api/durs/check?q=${encodeURIComponent(query)}`)
      const results = res.results || []
      if (results.length === 0) {
        setState({ kind: 'none' })
        return
      }
      const entry = res.entry || results[0]
      if (!entry.name && onName == null) {
        // no name to show — still render the payer badge
      }
      if (entry.name && onName) onName(entry.name)
      if (entry.ibans?.length && onIban) onIban(entry.ibans[0])
      setState({ kind: 'ok', entry })
    } catch (e) {
      setState({ kind: 'error', code: String((e as Error).message || 'upstream') })
    }
  }

  const errLabel =
    state.kind === 'error'
      ? state.code === 'too_short'
        ? t('durs.errTooShort')
        : state.code === 'rate_limited'
          ? t('durs.errRate')
          : t('durs.errUpstream')
      : ''

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={compact ? 'h-7 px-2 text-xs' : 'h-9'}
        onClick={run}
        disabled={state.kind === 'loading' || !query.trim()}
      >
        {state.kind === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5" />}
        {state.kind === 'loading' ? t('durs.checking') : t('durs.checkBtn')}
      </Button>
      {state.kind === 'ok' && state.entry && (
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className={state.entry.vatPayer ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-rose-300 bg-rose-50 text-rose-700'}>
              {state.entry.vatPayer ? `✓ ${t('durs.vatPayerYes')}` : `✗ ${t('durs.vatPayerNo')}`}
            </Badge>
            {/* OPS-9 val 2 — source badge: domestic DURS (Inetis) vs EU VIES */}
            {state.entry.source && (
              <Badge variant="outline" className="border-stone-300 bg-stone-50 text-stone-600">
                {state.entry.source === 'vies' ? t('durs.srcEu') : t('durs.srcSi')}
              </Badge>
            )}
          </div>
          {state.entry.name && <span className="text-stone-600">{state.entry.name}</span>}
          {state.entry.ibans?.length > 0 && <span className="text-stone-500">{t('durs.ibanHint')}: {state.entry.ibans[0]}</span>}
        </div>
      )}
      {state.kind === 'none' && <p className="text-xs text-stone-500">{t('durs.noResults')}</p>}
      {state.kind === 'error' && <p className="text-xs text-rose-700">{errLabel}</p>}
    </div>
  )
}

/* ─────────────────── OPS-8 val 2 — notification matrix (RoxPos pattern) ─────────────────── */

const NOTIF_EVENTS = [
  'ORDER_NEW', 'ORDER_READY', 'ORDER_FIRE', 'DELIVERY_NEW', 'DRIVER_ASSIGNED', 'RESERVATION_NEW',
  'LOW_STOCK', 'PO_APPROVED', 'PO_RECEIVED', 'TIME_OFF_STATUS', 'RECEIPT_FAILED', 'Z_CLOSED',
] as const

const NOTIF_ROLES = ['waiter', 'bar', 'kitchen', 'chef', 'staff', 'manager', 'warehouse', 'accounting', 'admin'] as const

type NotifMode = 'everyone' | 'roles' | 'off'

/** Notifications card (Nastavitve tab): 11 event types x {everyone | selected roles | off}. */
export function NotificationsCard() {
  const { t } = useI18n()
  const [rules, setRules] = useState<Record<string, { mode: NotifMode; roles?: string[] }>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api<{ rules: Record<string, { mode: NotifMode; roles?: string[] }> }>('/api/notification-rules')
        if (alive) setRules(res.rules || {})
      } catch {
        if (alive) setNotice(t('notif.loadError'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const setMode = (event: string, mode: NotifMode) => {
    setNotice('')
    setRules((r) => ({ ...r, [event]: { mode, roles: r[event]?.roles || [] } }))
  }
  const toggleRole = (event: string, role: string) => {
    setNotice('')
    setRules((r) => {
      const cur = r[event] || { mode: 'roles' as NotifMode, roles: [] as string[] }
      const roles = cur.roles || []
      return { ...r, [event]: { ...cur, roles: roles.includes(role) ? roles.filter((x) => x !== role) : [...roles, role] } }
    })
  }

  const save = async () => {
    setBusy(true); setNotice('')
    try {
      await api('/api/notification-rules', { method: 'PUT', body: JSON.stringify({ rules }) })
      setNotice(t('notif.saved'))
    } catch (e) {
      setNotice(`${t('notif.error')} ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5"><Bell className="w-4 h-4" /> {t('notif.title')}</CardTitle>
        <CardDescription>{t('notif.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('notif.loading')}</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                <tr>
                  <th className="p-2">{t('notif.title')}</th>
                  <th className="p-2 w-44">{t('notif.mode')}</th>
                </tr>
              </thead>
              <tbody>
                {NOTIF_EVENTS.map((ev) => {
                  const rule = rules[ev] || { mode: 'everyone' as NotifMode, roles: [] as string[] }
                  return (
                    <tr key={ev} className="border-t border-stone-100 align-top">
                      <td className="p-2 font-medium">{t(`notif.event.${ev}`)}</td>
                      <td className="p-2">
                        <Select value={rule.mode} onValueChange={(v) => setMode(ev, v as NotifMode)}>
                          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="everyone">{t('notif.modeEveryone')}</SelectItem>
                            <SelectItem value="roles">{t('notif.modeRoles')}</SelectItem>
                            <SelectItem value="off">{t('notif.modeOff')}</SelectItem>
                          </SelectContent>
                        </Select>
                        {rule.mode === 'roles' && (
                          <div className="mt-2 grid grid-cols-2 gap-1">
                            {NOTIF_ROLES.map((role) => (
                              <label key={role} className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 accent-emerald-700"
                                  checked={(rule.roles || []).includes(role)}
                                  onChange={() => toggleRole(ev, role)}
                                />
                                {t(`role.${role}`)}
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith(t('notif.error')) || notice === t('notif.loadError') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}
        <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy || loading} onClick={save}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {t('notif.save')}
        </Button>
      </CardContent>
    </Card>
  )
}

/* ─────────────────── OPS-8 val 2 — inventory batches / expiry (FEFO) ─────────────────── */

interface BatchRowT { id: string; itemName: string; itemUnit: string; lotNumber: string; expiryDate: string | null; quantityRemaining: number; supplierName: string }

/** Inventory batches card (Zaloge tab): expiry badges (<= 7 days amber / expired rose). */
export function BatchesCard() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<BatchRowT[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const load = async () => {
    setLoading(true); setErr('')
    try {
      const res = await api<{ batches: BatchRowT[] }>('/api/inventory/batches')
      setRows(res.batches || [])
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }

  const expiryBadge = (d: string | null) => {
    if (!d) return null
    const days = Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)
    if (days < 0) return <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">{t('bat.expired')}</Badge>
    if (days <= 7) return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">{t('bat.expiresSoon')}</Badge>
    return null
  }

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); if (v && rows === null && !loading) void load() }}>
      <Card>
        <CardHeader className="pb-2">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><Clock className="w-4 h-4" /> {t('bat.title')}</CardTitle>
            <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </CollapsibleTrigger>
          <CardDescription>{t('bat.desc')}</CardDescription>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('bat.loading')}</p>}
            {err && <p className="text-sm text-rose-700">{t('bat.error')} {err}</p>}
            {rows !== null && rows.length === 0 && <p className="text-sm text-stone-500">{t('bat.empty')}</p>}
            {rows !== null && rows.length > 0 && (
              <div className="max-h-80 overflow-y-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">{t('bat.colItem')}</th>
                      <th className="p-2">{t('bat.colLot')}</th>
                      <th className="p-2">{t('bat.colExpiry')}</th>
                      <th className="p-2 text-right">{t('bat.colQty')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((b) => (
                      <tr key={b.id} className="border-t border-stone-100">
                        <td className="p-2 font-medium max-w-40 truncate" title={b.itemName}>{b.itemName}</td>
                        <td className="p-2 text-stone-600 max-w-40 truncate" title={b.lotNumber}>{b.lotNumber}</td>
                        <td className="p-2">
                          <span className="flex items-center gap-1.5 flex-wrap">
                            {b.expiryDate ? new Date(b.expiryDate).toLocaleDateString('sl-SI') : '—'}
                            {expiryBadge(b.expiryDate)}
                          </span>
                        </td>
                        <td className="p-2 text-right font-semibold">{b.quantityRemaining} {b.itemUnit}</td>
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
