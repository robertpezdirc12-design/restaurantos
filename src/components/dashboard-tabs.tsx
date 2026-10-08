'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { newOperationId } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays } from 'lucide-react'

/* ─────────────────────────── ZALOGE ─────────────────────────── */

export interface InventoryT { id: string; name: string; unit: string; qty: number; minQty: number; cost: number; supplierId?: string | null }
export interface SupplierT { id: string; name: string; contact?: string | null; phone?: string | null; email?: string | null; address?: string | null }
export interface RecipeT { id: string; name: string; instructions: string; items: { inventoryItemId: string; name: string; unit: string; qty: number }[] }

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
  const [supForm, setSupForm] = useState<{ name: string; contact: string; phone: string } | null>(null)
  const [supBusy, setSupBusy] = useState(false)
  // Receptura urejevalnik (razknjiževanje po recepturah)
  const [recForm, setRecForm] = useState<{ menuItemId: string; lines: { inventoryItemId: string; qty: string }[] } | null>(null)
  const [recBusy, setRecBusy] = useState(false)

  function openRecipe(r?: RecipeT) {
    if (r) {
      setRecForm({ menuItemId: r.id, lines: r.items.map((i) => ({ inventoryItemId: i.inventoryItemId, qty: String(i.qty) })) })
    } else {
      setRecForm({ menuItemId: menuItems[0]?.id || '', lines: [{ inventoryItemId: items[0]?.id || '', qty: '' }] })
    }
  }

  async function saveRecipe() {
    if (!recForm || !recForm.menuItemId) return
    setRecBusy(true)
    try {
      await api('/api/recipes', { method: 'POST', body: JSON.stringify({ menuItemId: recForm.menuItemId, items: recForm.lines }) })
      setRecForm(null); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setRecBusy(false) }
  }

  async function deleteRecipe(menuItemId: string) {
    if (!confirm(t('inv.deleteRecipeConfirm'))) return
    try {
      await api(`/api/recipes?menuItemId=${encodeURIComponent(menuItemId)}`, { method: 'DELETE' })
      await onReload()
    } catch (err) { alert((err as Error).message) }
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><PackageSearch className="w-4 h-4" /> {t('inv.itemCount')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{items.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('inv.belowMin')}</CardTitle></CardHeader><CardContent><p className={`text-2xl font-bold ${low.length > 0 ? 'text-amber-600' : ''}`}>{low.length}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-1"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('inv.stockValue')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(totalValue)}</p></CardContent></Card>
      </div>

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
                    <p className="font-medium truncate">{r.name}</p>
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
                      {r.items.map((line, idx) => (
                        <li key={`${r.id}-${idx}`} className="text-xs text-stone-600 flex justify-between gap-2">
                          <span className="truncate">{line.name}</span>
                          <span className="shrink-0 font-medium">{line.qty} {line.unit}</span>
                        </li>
                      ))}
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
                  <div key={idx} className="flex gap-2 items-center">
                    <Select value={line.inventoryItemId} onValueChange={(v) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, inventoryItemId: v } : l) })}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder={t('inv.ingredient')} /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {items.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input type="number" step="0.001" min="0" className="w-24" value={line.qty} onChange={(e) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, qty: e.target.value } : l) })} placeholder="0" />
                    <Button size="sm" variant="outline" className="h-9 px-2 shrink-0 text-red-700 hover:text-red-800" onClick={() => setRecForm({ ...recForm, lines: recForm.lines.filter((_, i) => i !== idx) })} disabled={recForm.lines.length <= 1}>×</Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setRecForm({ ...recForm, lines: [...recForm.lines, { inventoryItemId: items[0]?.id || '', qty: '' }] })}><Plus className="w-3 h-3" /> {t('inv.addIngredient')}</Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecForm(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={recBusy || !recForm?.menuItemId || recForm.lines.some((l) => !l.inventoryItemId || !(Number(l.qty.replace(',', '.')) > 0))} onClick={saveRecipe}>{t('inv.saveRecipe')}</Button>
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

  async function startShift() {
    setBusy(true)
    try { await api('/api/shifts', { method: 'POST', body: JSON.stringify({ openingCash: Number(cash) || 0 }) }); setCash(''); await onReload() }
    catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }
  async function stopShift() {
    setBusy(true)
    try { await api('/api/shifts', { method: 'POST', body: JSON.stringify({ action: 'stop', closingCash: Number(cash) || 0 }) }); setCash(''); await onReload() }
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
    </div>
  )
}

/* ─────────────────────────── STROŠKI ─────────────────────────── */

export interface ExpenseT { id: string; category: string; description: string; amount: number; paidAt: string }

export function ExpensesTab({ expenses, canManage, onReload }: { expenses: ExpenseT[]; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const monthTotal = expenses
    .filter((e) => new Date(e.paidAt).getMonth() === new Date().getMonth() && new Date(e.paidAt).getFullYear() === new Date().getFullYear())
    .reduce((s, e) => s + e.amount, 0)

  async function submit() {
    setBusy(true)
    try {
      await api('/api/expenses', { method: 'POST', body: JSON.stringify({ description, amount: Number(amount.replace(',', '.')) }) })
      setDescription(''); setAmount(''); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> {t('exp.month')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(monthTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('exp.totalRecords')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{expenses.length}</p></CardContent></Card>
      </div>

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
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('exp.title')}</CardTitle></CardHeader>
        <CardContent>
          {expenses.length === 0 && <p className="text-sm text-stone-500">{t('exp.none')}</p>}
          <ScrollArea className="max-h-80">
            <div className="space-y-2">
              {expenses.map((e) => (
                <div key={e.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{e.description}</p>
                    <p className="text-xs text-stone-500">{new Date(e.paidAt).toLocaleDateString('sl-SI')}</p>
                  </div>
                  <p className="font-bold shrink-0">{fmtEUR(e.amount)}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
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
          {txt('taxId', t('set.taxId'))}
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
  courierName: string
  courierPhone: string
  driver: { name: string; phone: string; status: string } | null
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

export function DeliveryTab({ orders, zones, platformIntegrations, onReload }: {
  orders: DeliveryOrderT[]
  zones: DeliveryZoneT[]
  platformIntegrations: PlatformIntegrationT[]
  onReload: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [driverFor, setDriverFor] = useState<DeliveryOrderT | null>(null)
  const [driver, setDriver] = useState({ name: '', phone: '' })
  const [addZone, setAddZone] = useState(false)
  const [nz, setNz] = useState({ name: '', deliveryFee: '2.50', minOrderAmount: '10', estimatedMinutes: '30' })

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
                  {o.status === 'PAID' && <Badge className="bg-emerald-600 text-white">{t('status.PAID')}</Badge>}
                  {o.fursEor && <p className="text-[11px] text-stone-400">FURS EOR: {o.fursEor}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {next && next.to !== 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => transition(o, next.to)} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t(next.label)}</Button>
                    )}
                    {next && next.to === 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => { setDriverFor(o); setDriver({ name: d.courierName || d.driver?.name || '', phone: d.courierPhone || d.driver?.phone || '' }) }} className="bg-emerald-700 hover:bg-emerald-800 text-white">{t('dost.assignDriver')}</Button>
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
                    <div key={o.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white p-2.5">
                      <p className="text-sm min-w-0 truncate">#{o.orderNumber} · {d?.recipientName || '—'} · {fmtEUR(o.total)}</p>
                      <Badge className={DELIVERY_STATUS_BG[d?.status || ''] || 'bg-stone-400 text-white'}>{DELIVERY_STATUS_KEYS[d?.status || ''] ? t(DELIVERY_STATUS_KEYS[d?.status || '']) : d?.status || o.status}</Badge>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
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
            <div><Label htmlFor="drv-name">{t('dost.driverName')}</Label><Input id="drv-name" value={driver.name} onChange={(e) => setDriver({ ...driver, name: e.target.value })} placeholder={t('dost.driverPlaceholder')} /></div>
            <div><Label htmlFor="drv-phone">{t('inv.phone')}</Label><Input id="drv-phone" value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} placeholder={t('dost.phonePlaceholder')} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDriverFor(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy !== null || !driver.name.trim()}
              onClick={async () => {
                if (!driverFor) return
                setBusy(driverFor.id)
                try {
                  await api('/api/delivery', { method: 'PATCH', body: JSON.stringify({ orderId: driverFor.id, status: 'ASSIGNED', driverName: driver.name, driverPhone: driver.phone }) })
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

/* ─────────────────────────── RAČUNOVODSKI IZVOZ ─────────────────────────── */

export function AccountingExportCard() {
  const { t } = useI18n()
  const firstOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) })()
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null)
  const [err, setErr] = useState('')

  async function download(fmt: 'csv' | 'json') {
    setBusy(fmt); setErr('')
    try {
      const token = getToken()
      const res = await fetch(`/api/reports/export?from=${from}&to=${to}&format=${fmt}`, {
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
      a.download = `izvoz-${from}_${to}.${fmt}`
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
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
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

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [s, inv, o] = await Promise.all([
          api<{ suppliers: NabavaSupplier[] }>('/api/suppliers'),
          api<{ inventory: NabavaInvItem[] }>('/api/inventory'),
          api<{ orders: NabavaPo[] }>('/api/purchase-orders'),
        ])
        if (!alive) return
        setSuppliers(s.suppliers || [])
        setInvItems(inv.inventory || [])
        setOrders(o.orders || [])
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setLoading(false)
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

  const filteredOrders = statusFilter === 'all' ? orders : orders.filter((o) => o.status === statusFilter)

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">{t('proc.desc')}</p>

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
