'use client'

import { Fragment, useEffect, useState } from 'react'
import { api, fmtEUR, fmtNumSI } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, PackageSearch, AlertTriangle, Truck, UtensilsCrossed, Plus, ShoppingCart, ArrowLeftRight, Trash2 } from 'lucide-react'
import { BatchesCard, BatchPrepCard } from './ops-cards'

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

export function InventoryTab({ items, suppliers, recipes, menuItems = [], canManage, onReload, onNavigate }: { items: InventoryT[]; suppliers: SupplierT[]; recipes: RecipeT[]; menuItems?: { id: string; name: string }[]; canManage: boolean; onReload: () => Promise<void>; onNavigate?: (tab: string) => void }) {
  const { t } = useI18n()
  const low = items.filter((i) => i.minQty > 0 && i.qty <= i.minQty)
  const out = items.filter((i) => i.qty <= 0)
  const totalValue = items.reduce((s, i) => s + i.qty * i.cost, 0)
  /* Issue #71 audit-24: iskalnik + filtri — KPI šteje artikle pod-minimumom, seznam
     pa je bil gol abecedni spust; artikel z 0 kg ni bil označen. Zdaj: iskanje + trije filtri. */
  const [invSearch, setInvSearch] = useState('')
  const [invFilter, setInvFilter] = useState<'ALL' | 'LOW' | 'OUT'>('ALL')
  const visibleItems = items.filter((i) => {
    if (invFilter === 'LOW' && !(i.minQty > 0 && i.qty <= i.minQty)) return false
    if (invFilter === 'OUT' && i.qty > 0) return false
    const q = invSearch.trim().toLowerCase()
    return !q || i.name.toLowerCase().includes(q)
  })
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
  useEffect(() => { void (async () => { await loadStocktakes() })() }, [])

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
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setRecBusy(false) }
  }

  async function deleteRecipe(menuItemId: string) {
    if (!confirm(t('inv.deleteRecipeConfirm'))) return
    try {
      await api(`/api/recipes?menuItemId=${encodeURIComponent(menuItemId)}`, { method: 'DELETE' })
      await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) }
  }

  // OPS-9: recursive recipe line renderer — children indented with a sub-recipe badge,
  // non-default yield shown next to the name.
  function renderRecipeLine(line: RecipeLineT, depth: number) {
    return (
      <Fragment key={line.inventoryItemId}>
        <li className={`text-xs text-stone-600 flex justify-between gap-2 ${depth > 0 ? 'ml-4' : ''}`}>
          <span className="truncate flex items-center gap-1 min-w-0">
            {depth > 0 && <Badge variant="outline" className="text-xs px-1 py-0 shrink-0">{t('recipe.subRecipe')}</Badge>}
            <span className="truncate">{line.name}</span>
            {line.yieldPercent !== undefined && line.yieldPercent !== 100 && <span className="shrink-0 text-stone-400">· {line.yieldPercent} %</span>}
          </span>
          <span className="shrink-0 font-medium">{fmtNumSI(line.qty, { max: 3 })} {line.unit}</span>
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
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setNiBusy(false) }
  }
  async function saveAdjust() {
    if (!adjust) return
    setAdjBusy(true)
    try {
      await api('/api/inventory', { method: 'PATCH', body: JSON.stringify({ id: adjust.id, delta: adj.delta, setQty: adj.setQty, minQty: adj.minQty, cost: adj.cost }) })
      setAdjust(null); setAdj({ delta: '', setQty: '', minQty: '', cost: '' }); await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setAdjBusy(false) }
  }
  async function createSupplier() {
    if (!supForm) return
    setSupBusy(true)
    try {
      await api('/api/suppliers', { method: 'POST', body: JSON.stringify(supForm) })
      setSupForm(null); await onReload()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setSupBusy(false) }
  }

  // OPS-9: yield validity (empty = default 100; otherwise 1..100)
  const yieldInvalid = (s: string) => {
    if (s === '') return false
    const n = Number(s.replace(',', '.'))
    return !Number.isFinite(n) || n <= 0 || n > 100
  }

  return (
    <div className="space-y-4">
      {/* v1.129.0 (MarketMan/Square Inventory benchmark): AKCIJSKE bližnjice nad statistiko —
          skladiščnik pristane na »kaj moram narediti« (nabava/prejem, prenosi, odpad),
          ne samo na pasivni seznam. Klik vodi v pripadajoči zavihek. */}
      {onNavigate && (
        <div data-region="inv-actions" className="grid grid-cols-3 gap-3">
          {([
            { tab: 'nabava', Icon: ShoppingCart, label: t('inv.actNabava'), desc: t('inv.actNabavaDesc'), badge: low.length > 0 ? `${low.length}` : null },
            { tab: 'prenosi', Icon: ArrowLeftRight, label: t('inv.actPrenosi'), desc: t('inv.actPrenosiDesc'), badge: null },
            { tab: 'odpad', Icon: Trash2, label: t('inv.actOdpad'), desc: t('inv.actOdpadDesc'), badge: null },
          ] as { tab: string; Icon: typeof ShoppingCart; label: string; desc: string; badge: string | null }[]).map((a) => {
            const Ic = a.Icon
            return (
              <button
                key={a.tab}
                type="button"
                onClick={() => { onNavigate(a.tab); history.replaceState(null, '', `/dashboard?tab=${a.tab}`) }}
                aria-label={a.label}
                title={a.desc}
                className="rounded-xl border border-stone-200 bg-white p-3 sm:p-4 text-left shadow-sm hover:border-emerald-400 hover:shadow transition flex items-center gap-3 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              >
                <span className="rounded-lg bg-emerald-50 text-emerald-700 p-2 shrink-0"><Ic className="w-5 h-5" aria-hidden /></span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold text-stone-900 truncate">{a.label}</span>
                    {a.badge && <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 text-xs font-bold text-amber-900 shrink-0">{a.badge}</span>}
                  </span>
                  <span className="block text-xs text-stone-500 truncate">{a.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><PackageSearch className="w-4 h-4" /> {t('inv.itemCount')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{items.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('inv.belowMin')}</CardTitle></CardHeader><CardContent><p className={`text-2xl font-bold ${low.length > 0 ? 'text-amber-600' : ''}`}>{low.length}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-1"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('inv.stockValue')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(totalValue)}</p></CardContent></Card>
      </div>

      {/* OPS-8 val 2 — batches / expiry (FEFO, lazy-load on expand) */}
      <BatchesCard canManage={canManage} />

      {/* OPS-10 val 3 — batch preparations (BOM production, lazy-load on expand) */}
      <BatchPrepCard />

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setAddItem(true)}><Plus className="w-4 h-4" /> {t('inv.newItem')}</Button>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('inv.stockList')}</CardTitle>
          {/* Issue #71 audit-24: iskalnik + filtri (vsi / pod-minimumom / zmanjkalo) */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Input value={invSearch} onChange={(e) => setInvSearch(e.target.value)} placeholder={t('inv.search')} className="h-9 w-full sm:w-52" aria-label={t('inv.search')} />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('inv.filterAll')}>
              <Button size="sm" variant={invFilter === 'ALL' ? 'default' : 'outline'} className={`h-9 ${invFilter === 'ALL' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`} onClick={() => setInvFilter('ALL')}>{t('inv.filterAll')}</Button>
              <Button size="sm" variant={invFilter === 'LOW' ? 'default' : 'outline'} className={`h-9 ${invFilter === 'LOW' ? 'bg-amber-600 hover:bg-amber-700' : ''}`} onClick={() => setInvFilter('LOW')}>{t('inv.filterLow', { n: low.length })}</Button>
              <Button size="sm" variant={invFilter === 'OUT' ? 'default' : 'outline'} className={`h-9 ${invFilter === 'OUT' ? 'bg-red-700 hover:bg-red-800' : ''}`} onClick={() => setInvFilter('OUT')}>{t('inv.filterOut', { n: out.length })}</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {items.length === 0 && <p className="text-sm text-stone-500">{t('inv.empty')}</p>}
          {items.length > 0 && visibleItems.length === 0 && <p className="text-sm text-stone-500">{t('inv.searchNone')}</p>}
          <ScrollArea className="max-h-[55vh]">
            <div className="grid gap-2 sm:grid-cols-2">
              {visibleItems.map((i) => {
                const isLow = i.minQty > 0 && i.qty <= i.minQty
                const isOut = i.qty <= 0
                return (
                  <div key={i.id} className={`rounded-lg border bg-white p-3 flex items-center justify-between gap-2 ${isOut ? 'border-red-300 bg-red-50/50' : isLow ? 'border-amber-300 bg-amber-50/60' : 'border-stone-200'}`}>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{i.name}</p>
                      <p className="text-xs text-stone-500">{i.cost > 0 ? `${fmtEUR(i.cost)}/${i.unit}` : i.unit}{isLow && ` · ${t('inv.minShort')} ${fmtNumSI(i.minQty)}`}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        {/* Issue #71 audit-12: količine v sl-SI obliki (0,08 kg — ne 0.08 kg) */}
                        <p className={`font-bold ${isOut ? 'text-red-700' : ''}`}>{fmtNumSI(i.qty)} {i.unit}</p>
                        {isOut && <Badge className="bg-red-700 text-white mt-0.5">{t('inv.outBadge')}</Badge>}
                        {isLow && !isOut && <Badge className="bg-amber-600 text-white mt-0.5">{t('inv.belowMin')}</Badge>}
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
                {stOpen.recountCount > 0 && <Badge variant="outline" className="text-xs">{t('st.recounts')}: {stOpen.recountCount}</Badge>}
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
                    <Badge variant="outline" className="text-xs">{t(`st.status.${s.status}`)}</Badge>
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
                {s.address && <p className="text-xs text-stone-400 truncate">{s.address}</p>}
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
                      <p className="text-xs text-stone-500">
                        {t('recipe.costPerServing')}:{' '}
                        {r.costKnown ? <span className="font-medium text-stone-700">{fmtEUR(r.costPerServing || 0)}</span> : <span className="text-amber-600">{t('recipe.costUnknown')}</span>}
                      </p>
                    </div>
                    {canManage && (
                      <div className="shrink-0 flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => openRecipe(r)}>{t('common.edit')}</Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs text-red-700 hover:text-red-800" onClick={() => deleteRecipe(r.id)}>{t('common.delete')}</Button>
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
                        <span className="text-xs text-stone-400 shrink-0">{t('recipe.parentOf')}</span>
                        <Select value={line.parent || '__none__'} onValueChange={(v) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, parent: v === '__none__' ? '' : v } : l) })}>
                          <SelectTrigger className="h-7 flex-1 text-xs"><SelectValue /></SelectTrigger>
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
                <p className="text-xs text-stone-400">{t('inv.deltaHint')}</p>
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
