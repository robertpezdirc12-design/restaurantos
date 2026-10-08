'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { DAY_NAMES_SL } from '@/lib/openinghours'
import { newOperationId } from '@/lib/offline-queue'
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
    if (!confirm('Izbrišem recepturo? Razknjiževanje za ta artikel se ustavi.')) return
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
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><PackageSearch className="w-4 h-4" /> Artiklov</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{items.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Pod minimumom</CardTitle></CardHeader><CardContent><p className={`text-2xl font-bold ${low.length > 0 ? 'text-amber-600' : ''}`}>{low.length}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-1"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Vrednost zaloge</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(totalValue)}</p></CardContent></Card>
      </div>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setAddItem(true)}><Plus className="w-4 h-4" /> Nov artikel</Button>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Sklad zalog</CardTitle></CardHeader>
        <CardContent>
          {items.length === 0 && <p className="text-sm text-stone-500">Zaloga je prazna.</p>}
          <ScrollArea className="max-h-[55vh]">
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((i) => {
                const isLow = i.minQty > 0 && i.qty <= i.minQty
                return (
                  <div key={i.id} className={`rounded-lg border bg-white p-3 flex items-center justify-between gap-2 ${isLow ? 'border-amber-300 bg-amber-50/60' : 'border-stone-200'}`}>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{i.name}</p>
                      <p className="text-xs text-stone-500">{i.cost > 0 ? `${fmtEUR(i.cost)}/${i.unit}` : i.unit}{isLow && ' · min ' + i.minQty}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className="font-bold">{i.qty} {i.unit}</p>
                        {isLow && <Badge className="bg-amber-600 text-white mt-0.5">Pod minimumom</Badge>}
                      </div>
                      {canManage && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setAdjust(i); setAdj({ delta: '', setQty: String(i.qty), minQty: String(i.minQty), cost: String(i.cost) }) }}>
                          Prilagodi
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
          <CardTitle className="text-base flex items-center gap-1.5"><Truck className="w-4 h-4" /> Dobavitelji</CardTitle>
          {canManage && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSupForm({ name: '', contact: '', phone: '' })}><Plus className="w-3 h-3" /> Dodaj</Button>}
        </CardHeader>
        <CardContent>
          {suppliers.length === 0 && <p className="text-sm text-stone-500">Ni dodanih dobaviteljev.</p>}
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
          <CardTitle className="text-base flex items-center gap-1.5"><UtensilsCrossed className="w-4 h-4" /> Recepti (sestavine artiklov)</CardTitle>
          {canManage && menuItems.length > 0 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openRecipe()}><Plus className="w-3 h-3" /> Receptura</Button>
          )}
        </CardHeader>
        <CardContent>
          {recipes.length === 0 && <p className="text-sm text-stone-500">Ni shranjenih receptov — brez recepture se zaloga ob prodaji ne razknjiži.</p>}
          <ScrollArea className="max-h-80">
            <div className="grid gap-2 sm:grid-cols-2">
              {recipes.map((r) => (
                <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium truncate">{r.name}</p>
                    {canManage && (
                      <div className="shrink-0 flex gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => openRecipe(r)}>Uredi</Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] text-red-700 hover:text-red-800" onClick={() => deleteRecipe(r.id)}>Izbriši</Button>
                      </div>
                    )}
                  </div>
                  {r.items.length === 0 ? (
                    <p className="text-xs text-stone-400">brez sestavin</p>
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
          <DialogHeader><DialogTitle>Receptura artikla</DialogTitle></DialogHeader>
          {recForm && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Artikel menija *</Label>
                <Select value={recForm.menuItemId} onValueChange={(v) => setRecForm({ ...recForm, menuItemId: v })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Izberi artikel" /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {menuItems.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sestavine (količina na eno prodano enoto)</Label>
                {recForm.lines.map((line, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <Select value={line.inventoryItemId} onValueChange={(v) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, inventoryItemId: v } : l) })}>
                      <SelectTrigger className="flex-1"><SelectValue placeholder="Sestavina" /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        {items.map((i) => <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input type="number" step="0.001" min="0" className="w-24" value={line.qty} onChange={(e) => setRecForm({ ...recForm, lines: recForm.lines.map((l, i) => i === idx ? { ...l, qty: e.target.value } : l) })} placeholder="0" />
                    <Button size="sm" variant="outline" className="h-9 px-2 shrink-0 text-red-700 hover:text-red-800" onClick={() => setRecForm({ ...recForm, lines: recForm.lines.filter((_, i) => i !== idx) })} disabled={recForm.lines.length <= 1}>×</Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setRecForm({ ...recForm, lines: [...recForm.lines, { inventoryItemId: items[0]?.id || '', qty: '' }] })}><Plus className="w-3 h-3" /> Dodaj sestavino</Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecForm(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={recBusy || !recForm?.menuItemId || recForm.lines.some((l) => !l.inventoryItemId || !(Number(l.qty.replace(',', '.')) > 0))} onClick={saveRecipe}>Shrani recepturo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nov artikel zaloge */}
      <Dialog open={addItem} onOpenChange={(v) => !v && setAddItem(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nov artikel zaloge</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ni-name">Naziv *</Label>
              <Input id="ni-name" value={ni.name} onChange={(e) => setNi({ ...ni, name: e.target.value })} placeholder="npr. Moka tip 500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ni-unit">Enota</Label>
                <Select value={ni.unit} onValueChange={(v) => setNi({ ...ni, unit: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['kg', 'l', 'pcs', 'g', 'ml'].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ni-qty">Začetna količina</Label>
                <Input id="ni-qty" inputMode="decimal" value={ni.qty} onChange={(e) => setNi({ ...ni, qty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ni-min">Min. količina</Label>
                <Input id="ni-min" inputMode="decimal" value={ni.minQty} onChange={(e) => setNi({ ...ni, minQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ni-cost">Cena / enoto (€)</Label>
                <Input id="ni-cost" inputMode="decimal" value={ni.cost} onChange={(e) => setNi({ ...ni, cost: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} placeholder="0.00" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddItem(false)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={niBusy || !ni.name} onClick={createItem}>{niBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani artikel'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Prilagoditev zaloge */}
      <Dialog open={!!adjust} onOpenChange={(v) => !v && setAdjust(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Prilagodi zalogo — {adjust?.name}</DialogTitle></DialogHeader>
          {adjust && (
            <div className="space-y-3">
              <p className="text-xs text-stone-500">Trenutno stanje: <b>{adjust.qty} {adjust.unit}</b></p>
              <div className="space-y-1.5">
                <Label htmlFor="adj-delta">Prejem / sprememba (+/- {adjust.unit})</Label>
                <Input id="adj-delta" inputMode="decimal" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value.replace(/[^\d.,-]/g, '').replace(',', '.') })} placeholder="npr. 12 ali -3" />
                <p className="text-[11px] text-stone-400">Če je vneseno, se prišteje k trenutni količini (pozitivno = prejem blaga).</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="adj-set">Nastavi količino na</Label>
                  <Input id="adj-set" inputMode="decimal" value={adj.setQty} onChange={(e) => setAdj({ ...adj, setQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-min">Min. količina</Label>
                  <Input id="adj-min" inputMode="decimal" value={adj.minQty} onChange={(e) => setAdj({ ...adj, minQty: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adj-cost">Cena / enoto (€)</Label>
                <Input id="adj-cost" inputMode="decimal" value={adj.cost} onChange={(e) => setAdj({ ...adj, cost: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjust(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={adjBusy} onClick={saveAdjust}>{adjBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani prilagoditev'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nov dobavitelj */}
      <Dialog open={!!supForm} onOpenChange={(v) => !v && setSupForm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nov dobavitelj</DialogTitle></DialogHeader>
          {supForm && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sup-name">Naziv *</Label>
                <Input id="sup-name" value={supForm.name} onChange={(e) => setSupForm({ ...supForm, name: e.target.value })} placeholder="npr. Kmetija Vidmar" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sup-contact">Kontaktna oseba</Label>
                  <Input id="sup-contact" value={supForm.contact} onChange={(e) => setSupForm({ ...supForm, contact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sup-phone">Telefon</Label>
                  <Input id="sup-phone" value={supForm.phone} onChange={(e) => setSupForm({ ...supForm, phone: e.target.value })} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupForm(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={supBusy || !supForm?.name} onClick={createSupplier}>{supBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani dobavitelja'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export interface ShiftT { id: string; employeeId?: string | null; employee?: { name: string; role: string } | null; startedAt: string; endedAt?: string | null; openingCash: number; closingCash: number; status: string }
export interface FinancialT { today: { revenue: number; tax: number; invoices: number }; month: { revenue: number; tax: number; invoices: number; expenses: number; profit: number }; taxBreakdown: { taxRate: number; qty: number }[] }

export function ShiftsTab({ shifts, financial, canManage, onReload }: { shifts: ShiftT[]; financial: FinancialT | null; canManage: boolean; onReload: () => Promise<void> }) {
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
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> Prihodki (mesec)</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.revenue) : '—'}</p><p className="text-xs text-stone-400">davek {financial ? fmtEUR(financial.month.tax) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> Stroški (mesec)</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.expenses) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Dobiček (mesec)</CardTitle></CardHeader><CardContent><p className={`text-xl font-bold ${(financial?.month.profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{financial ? fmtEUR(financial.month.profit) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Računov (mesec)</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial?.month.invoices ?? '—'}</p></CardContent></Card>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> Prihodki (danes)</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.today.revenue) : '—'}</p><p className="text-xs text-stone-400">{financial?.today.invoices ?? '—'} računov · davek {financial ? fmtEUR(financial.today.tax) : '—'}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-3"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Promet po davčnih stopnjah (mesec)</CardTitle></CardHeader><CardContent>
          {!financial || financial.taxBreakdown.length === 0 ? <p className="text-sm text-stone-500">Ni prometa.</p> : (
            <div className="flex flex-wrap gap-2">
              {financial.taxBreakdown.map((t) => (
                <Badge key={t.taxRate} variant="outline" className="text-sm px-2.5 py-1">DDV {t.taxRate} % · {t.qty} postavk</Badge>
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
            ['Financno porocilo RestavrantOS', new Date().toLocaleDateString('sl-SI')],
            [],
            ['Obdobje', 'Prihodki (EUR)', 'Davek (EUR)', 'Stroski (EUR)', 'Dobicek (EUR)', 'Racunov'],
            ['Danes', financial.today.revenue, financial.today.tax, '', '', financial.today.invoices],
            ['Mesec', financial.month.revenue, financial.month.tax, financial.month.expenses, financial.month.profit, financial.month.invoices],
            [],
            ['Davcna stopnja (%)', 'Postavk'],
            ...financial.taxBreakdown.map((t) => [t.taxRate, t.qty]),
            [],
            ['Izmena', 'Zaposleni', 'Vloga', 'Zacetek', 'Konec', 'Odpiranje (EUR)', 'Zakljucek (EUR)', 'Status'],
            ...shifts.map((s) => [s.id, s.employee?.name || '', s.employee?.role || '', s.startedAt, s.endedAt || '', s.openingCash, s.closingCash, s.status]),
          ])
        }}>
          Izvozi poročilo (CSV)
        </Button>
      </div>

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4" /> {openShift ? `Odprta izmena — ${openShift.employee?.name || ''}` : 'Ni odprte izmene'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="cash">{openShift ? 'Blagajna ob zaključku (€)' : 'Začetno stanje blagajne (€)'}</Label>
              <Input id="cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0.00" className="w-44" />
            </div>
            {openShift ? (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={stopShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Zaključi izmeno (Z)'}</Button>
            ) : (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={startShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Začni izmeno'}</Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Zadnje izmene (Z-poročila)</CardTitle></CardHeader>
        <CardContent>
          {shifts.length === 0 && <p className="text-sm text-stone-500">Ni zapisov izmen.</p>}
          <ScrollArea className="max-h-80">
            <div className="space-y-2">
              {shifts.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.employee?.name || '—'} <span className="text-xs text-stone-400">· {s.employee?.role || ''}</span></p>
                    <p className="text-xs text-stone-500">{new Date(s.startedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{s.endedAt ? ` → ${new Date(s.endedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-stone-500">odpiranje {fmtEUR(s.openingCash)}</span>
                    {s.status === 'closed' && <span className="text-xs font-semibold">zaključek {fmtEUR(s.closingCash)}</span>}
                    <Badge className={s.status === 'open' ? 'bg-amber-600 text-white' : 'bg-stone-500 text-white'}>{s.status === 'open' ? 'Odprta' : 'Zaključena'}</Badge>
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

const HACCP_TYPE_LABELS: Record<string, string> = {
  TEMPERATURE: 'Temperatura', CLEANING: 'Čiščenje', DELIVERY: 'Prevzem', COOLING: 'Hlajenje', TRAINING: 'Usposabljanje',
}

export function HaccpTab({ checks, onReload }: { checks: HaccpT[]; onReload: () => Promise<void> }) {
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
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Thermometer className="w-4 h-4" /> Nova kontrola</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Vrsta kontrole</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(HACCP_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-target">Cilj (naprava / prostor)</Label>
              <Input id="h-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="npr. Hladilna vitrina 1" />
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="h-value">Vrednost (°C)</Label>
              <Input id="h-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.,-]/g, ''))} placeholder="npr. 4.5" />
            </div>
            <div className="space-y-1.5">
              <Label>Rezultat</Label>
              <Select value={ok ? 'ok' : 'warn'} onValueChange={(v) => setOk(v === 'ok')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ok">✅ V redu</SelectItem>
                  <SelectItem value="warn">⚠️ Opomba</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-note">Opomba</Label>
              <Input id="h-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="neobvezno" />
            </div>
          </div>
          <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !target} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Zapiši kontrolo'}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Zadnje kontrole</CardTitle></CardHeader>
        <CardContent>
          {checks.length === 0 && <p className="text-sm text-stone-500">Ni zapisov HACCP kontrol.</p>}
          <ScrollArea className="max-h-80">
            <div className="grid gap-2 sm:grid-cols-2">
              {checks.map((c) => (
                <div key={c.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{c.target} <Badge variant="outline" className="ml-1">{HACCP_TYPE_LABELS[c.type] || c.type}</Badge></p>
                    <p className="text-xs text-stone-500">{new Date(c.checkedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{c.employeeId ? ` · ${c.employeeId}` : ''}{c.note ? ` · ${c.note}` : ''}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {c.value !== null && <p className="font-bold">{c.value}°</p>}
                    <Badge className={c.ok ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'}>{c.ok ? 'V redu' : 'Opomba'}</Badge>
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
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> Stroški (mesec)</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(monthTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Vseh zapisov</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{expenses.length}</p></CardContent></Card>
      </div>

      {canManage && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Nov strošek</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 min-w-48 flex-1">
              <Label htmlFor="ex-desc">Opis</Label>
              <Input id="ex-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="npr. Zelje in krompir — Kmetija Vidmar" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ex-amount">Znesek (€)</Label>
              <Input id="ex-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0.00" className="w-32" />
            </div>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !description || !(Number(amount.replace(',', '.')) > 0)} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Zapiši strošek'}</Button>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => {
          const d = new Date()
          downloadCSV(`stroski-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
            ['Datum', 'Opis', 'Kategorija', 'Znesek (EUR)'],
            ...expenses.map((e) => [new Date(e.paidAt).toLocaleDateString('sl-SI'), e.description, e.category || '', e.amount]),
          ])
        }}>
          Izvozi stroške (CSV)
        </Button>
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Stroški</CardTitle></CardHeader>
        <CardContent>
          {expenses.length === 0 && <p className="text-sm text-stone-500">Ni zapisov stroškov.</p>}
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
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><HeartHandshake className="w-4 h-4" /> Članov</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{accounts.length}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Skupaj točk</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{totalPoints}</p></CardContent></Card>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setMember({ guestName: '', phone: '' })}><Plus className="w-4 h-4" /> Nov član</Button>
        </div>
      )}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Zvestobni računi</CardTitle></CardHeader>
        <CardContent>
          {accounts.length === 0 && <p className="text-sm text-stone-500">Ni članov programa zvestobe.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {accounts.map((a) => (
              <div key={a.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{a.guestName}</p>
                  <p className="text-xs text-stone-500">{a.phone || '—'} · {a.visits} točk skupaj</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <p className="font-bold">{a.points} točk</p>
                    {a.tier && <Badge className={`mt-0.5 ${TIER_COLORS[a.tier] || 'bg-stone-500 text-white'}`}>{a.tier}</Badge>}
                  </div>
                  {canManage && (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setPts(a); setPForm({ delta: '', reason: '' }) }}>
                      Točke
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
          <DialogHeader><DialogTitle>Nov član zvestobe</DialogTitle></DialogHeader>
          {member && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="lo-name">Ime gosta *</Label>
                <Input id="lo-name" value={member.guestName} onChange={(e) => setMember({ ...member, guestName: e.target.value })} placeholder="npr. Ana Kovač" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lo-phone">Telefon</Label>
                <Input id="lo-phone" value={member.phone} onChange={(e) => setMember({ ...member, phone: e.target.value })} placeholder="041 234 567" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMember(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={mBusy || !member?.guestName} onClick={createMember}>{mBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani člana'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pts} onOpenChange={(v) => !v && setPts(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Točke — {pts?.guestName}</DialogTitle></DialogHeader>
          {pts && (
            <div className="space-y-3">
              <p className="text-xs text-stone-500">Trenutno stanje: <b>{pts.points} točk</b> · tier {pts.tier || 'bronze'}</p>
              <div className="space-y-1.5">
                <Label htmlFor="pt-delta">Točke (+ prihod / − obračun)</Label>
                <Input id="pt-delta" inputMode="numeric" value={pForm.delta} onChange={(e) => setPForm({ ...pForm, delta: e.target.value.replace(/[^\d-]/g, '') })} placeholder="npr. 25 ali -10" />
                <p className="text-[11px] text-stone-400">Tier se preračuna samodejno: silver od 100, gold od 500, platinum od 1000 točk.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pt-reason">Razlog</Label>
                <Input id="pt-reason" value={pForm.reason} onChange={(e) => setPForm({ ...pForm, reason: e.target.value })} placeholder="neobvezno" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPts(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={pBusy || !pForm.delta || Number(pForm.delta) === 0} onClick={savePoints}>{pBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Zapiši točke'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── MNENJA GOSTOV ─────────────────────────── */

export interface FeedbackT { id: string; rating: number; comment?: string | null; tableId?: string | null; createdAt: string }

export function FeedbackTab({ feedback, tables }: { feedback: FeedbackT[]; tables: { id: string; name: string }[] }) {
  const avg = feedback.length > 0 ? feedback.reduce((s, f) => s + f.rating, 0) / feedback.length : 0
  const tableName = (id?: string | null) => (id ? tables.find((t) => t.id === id)?.name || null : null)
  const stars = (r: number) => '★'.repeat(Math.round(r)) + '☆'.repeat(Math.max(0, 5 - Math.round(r)))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Star className="w-4 h-4" /> Povprečna ocena</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{feedback.length > 0 ? avg.toFixed(1) : '—'}<span className="text-base text-amber-500 ml-1.5">{feedback.length > 0 && stars(avg)}</span></p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">Št. mnenj</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{feedback.length}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Mnenja gostov</CardTitle></CardHeader>
        <CardContent>
          {feedback.length === 0 && <p className="text-sm text-stone-500">Ni še mnenj gostov.</p>}
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
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Briefcase className="w-4 h-4" /> Delovna mesta</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {canManage && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 min-w-48 flex-1">
              <Label htmlFor="job-title">Naziv</Label>
              <Input id="job-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="npr. Sommelier" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="job-rate">Urna postavka (€)</Label>
              <Input id="job-rate" inputMode="decimal" value={payRate} onChange={(e) => setPayRate(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="npr. 12.50" className="w-36" />
            </div>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !title} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Dodaj'}</Button>
          </div>
        )}
        {jobs.length === 0 && <p className="text-sm text-stone-500">Ni definiranih delovnih mest.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {jobs.map((j) => (
            <div key={j.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{j.title}</p>
                {j.permissions && <p className="text-xs text-stone-500 truncate">{j.permissions.split(',').join(' · ')}</p>}
              </div>
              <Badge className={j.active ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{j.active ? 'Aktivno' : 'Neaktivno'}</Badge>
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
  const [form, setForm] = useState<SettingsT | null>(settings)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { setForm(settings) }, [settings])

  if (!form) {
    return canManage ? (
      <Card><CardContent className="text-sm text-stone-500">Nastavitve še niso ustvarjene — shrani obrazec za prvo inicializacijo.</CardContent></Card>
    ) : null
  }
  if (!canManage) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Store className="w-4 h-4" /> Podatki lokacije</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1 text-stone-600">
          <p className="font-medium text-stone-800">{form.name}</p>
          <p>{[form.address, form.postCode, form.city].filter(Boolean).join(', ') || '—'}</p>
          <p className="text-xs text-stone-500">{form.phone} · {form.email}{form.web ? ` · ${form.web}` : ''}</p>
          <p className="text-xs text-stone-500">Davčna št. {form.taxId || '—'} · matična št. {form.businessId || '—'} · {form.registerNumber}</p>
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
      setNotice('Nastavitve shranjene ✓')
      await onReload()
    } catch (err) { setNotice(`Napaka: ${(err as Error).message}`) } finally { setSaving(false) }
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
        <CardTitle className="text-base flex items-center gap-1.5"><Store className="w-4 h-4" /> Nastavitve podjetja</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${notice.startsWith('Napaka') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{notice}</p>}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {txt('name', 'Naziv', 'npr. Gostilna pri Jožetu')}
          {txt('address', 'Naslov')}
          {txt('city', 'Kraj')}
          {txt('postCode', 'Poštna številka')}
          {txt('phone', 'Telefon')}
          {txt('email', 'E-pošta')}
          {txt('web', 'Spletna stran')}
          {txt('businessId', 'Matična številka')}
          {txt('taxId', 'Davčna številka')}
          {txt('registerNumber', 'Oznaka poslovnega prostora', 'npr. BLG001')}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> FURS okolje</Label>
            <Select value={form.fursEnvironment || 'test'} onValueChange={(v) => set('fursEnvironment', v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="test">Testno okolje</SelectItem>
                <SelectItem value="production">Produkcijsko okolje</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-amber-600">Produkcijsko okolje izdaja prave FURS račune — preklapljajte previdno.</p>
          </div>
          {txt('receiptFooter', 'Noga računa', 'npr. Hvala za obisk!')}
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {txt('defaultVatRate', 'Osnovni DDV (%)', '22')}
          {txt('reducedVatRate', 'Znižani DDV (%)', '9.5')}
          {txt('currency', 'Valuta', 'EUR')}
          {txt('locale', 'Jezikovna oznaka', 'sl-SI')}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5">
            <div><p className="text-sm font-medium">Program zvestobe</p><p className="text-xs text-stone-500">Zbiranje točk ob plačilu</p></div>
            <Switch checked={form.loyaltyEnabled} onCheckedChange={(v) => set('loyaltyEnabled', v)} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5">
            <div><p className="text-sm font-medium">E-poštna poročila</p><p className="text-xs text-stone-500">Pošiljanje poročil po e-pošti</p></div>
            <Switch checked={form.emailEnabled} onCheckedChange={(v) => set('emailEnabled', v)} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani nastavitve'}
          </Button>
          <span className="text-xs text-stone-400">{form.country || 'SI'} · {form.locale || 'sl-SI'} · {form.currency || 'EUR'}</span>
        </div>
      </CardContent>
    </Card>
  )
}

/* ─────────────────────────── NAPRAVE ─────────────────────────── */

export interface DeviceT { id: string; name: string; type: string; token: string; lastSeen?: string | null; status: string; locationId?: string | null; revoked?: boolean; pairedToDeviceId?: string | null }

const DEVICE_TYPE_LABELS: Record<string, string> = {
  POS: 'POS blagajna', KDS: 'KDS kuhinja', KDS_BAR: 'KDS bar', TABLET: 'Tablica', KIOSK: 'Kiosk', MOBILE: 'Mobilna', CUSTOMER_DISPLAY: 'Customer display',
}

/**
 * Issue #3 — popoln Device Onboarding · Issue #4 §2 — VARNOSTNO HARDENED:
 * - nova naprava → ENKRATNA VPISNA KODA (15 min) — naprava jo unovči JAVNO na /kiosk ali prijavi
 * - žetoni v seznamu so MASKIRANI (poln token se nikoli ne vrača v GET)
 * - CFD paring koda (10 min, enkratna)
 */
export function DevicesCard({ devices, locations, onChanged }: { devices: DeviceT[]; locations: { id: string; name: string }[]; onChanged?: () => void }) {
  const locName = (id?: string | null) => (id ? locations.find((l) => l.id === id)?.name || null : null)
  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState({ name: '', type: 'pos', locationId: locations[0]?.id || 'none' })
  const [busy, setBusy] = useState(false)
  const [newCode, setNewCode] = useState<{ name: string; code: string } | null>(null)
  const [pairCode, setPairCode] = useState<{ device: string; code: string } | null>(null)
  const [notice, setNotice] = useState('')

  async function createEnrollmentCode() {
    if (nf.name.trim().length < 2) { setNotice('Ime naprave: min. 2 znaka.'); return }
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
    if (action === 'delete' && !confirm('Trajno izbrišem napravo?')) return
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
        <CardTitle className="text-base flex items-center gap-1.5"><MonitorSmartphone className="w-4 h-4" /> Naprave — onboarding</CardTitle>
        <Button size="sm" variant="outline" className="gap-1" onClick={() => { setAddOpen((v) => !v); setNewCode(null) }}><Plus className="w-3.5 h-3.5" /> Vpisna koda</Button>
      </CardHeader>
      <CardContent>
        {addOpen && (
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 mb-3 space-y-3">
            <p className="text-xs font-medium text-stone-500">Nova naprava — tip, lokacija in ime. Ustvari se ENKRATNA vpisna koda (15 min), ki jo naprava unovči na svojem zaslonu.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Tip</Label>
                <Select value={nf.type} onValueChange={(v) => setNf((f) => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pos">POS blagajna</SelectItem>
                    <SelectItem value="kds">KDS kuhinja</SelectItem>
                    <SelectItem value="kds_bar">KDS bar</SelectItem>
                    <SelectItem value="tablet">Tablica</SelectItem>
                    <SelectItem value="kiosk">Samopostrežni kiosk</SelectItem>
                    <SelectItem value="mobile">Mobilna naprava</SelectItem>
                    <SelectItem value="customer_display">Customer display (CFD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Lokacija</Label>
                <Select value={nf.locationId} onValueChange={(v) => setNf((f) => ({ ...f, locationId: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Brez lokacije</SelectItem>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Ime</Label>
                <Input value={nf.name} onChange={(e) => setNf((f) => ({ ...f, name: e.target.value }))} placeholder="npr. Blagajna 1" />
              </div>
            </div>
            <Button size="sm" onClick={createEnrollmentCode} disabled={busy}>{busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null} Ustvari vpisno kodo</Button>
          </div>
        )}

        {newCode && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 mb-3">
            <p className="text-sm font-semibold text-amber-900">Vpisna koda za “{newCode.name}” — velja 15 min in je enkratna:</p>
            <p className="text-4xl font-extrabold tracking-[0.3em] my-2 text-center select-all">{newCode.code}</p>
            <p className="text-xs text-amber-700 mt-1">Naprava vpiše kodo na /kiosk oz. prijavni strani (»Aktiviraj napravo«) in samodejno dobi svoj žeton. Žeton se vam ne prikaže — to je po pričakovanju (issue #4 §2).</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => { navigator.clipboard?.writeText(newCode.code); setNotice('Koda kopirana ✓') }}>Kopiraj kodo</Button>
          </div>
        )}

        {pairCode && (
          <div className="rounded-xl border border-stone-300 bg-stone-100 p-4 mb-3 text-center">
            <p className="text-sm text-stone-500">Paring koda za customer display (velja 10 min, POS: {pairCode.device}):</p>
            <p className="text-4xl font-extrabold tracking-[0.3em] my-2 select-all">{pairCode.code}</p>
            <p className="text-xs text-stone-500">Na zaslonu displaya (/display) vnesi to kodo.</p>
          </div>
        )}

        {notice && <p className="text-xs text-emerald-700 mb-2">{notice}</p>}
        {devices.length === 0 && <p className="text-sm text-stone-500">Ni registriranih naprav.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {devices.map((d) => (
            <div key={d.id} className={`rounded-lg border p-3 flex items-center justify-between gap-2 ${d.revoked ? 'border-red-200 bg-red-50' : 'border-stone-200 bg-white'}`}>
              <div className="min-w-0">
                <p className="font-medium truncate">{d.name} <Badge variant="outline" className="ml-1">{DEVICE_TYPE_LABELS[d.type] || d.type}</Badge></p>
                <p className="text-xs text-stone-500 truncate">{locName(d.locationId) || 'brez lokacije'} · žeton {d.token}</p>
                <p className="text-[11px] text-stone-400">zadnja povezava: {d.lastSeen ? new Date(d.lastSeen).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nikoli'}{d.revoked ? ' · REVOKIRANA' : ''}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge className={d.revoked ? 'bg-red-600 text-white' : d.status === 'online' ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{d.revoked ? 'revoked' : d.status}</Badge>
                <div className="flex gap-1">
                  {d.type.toUpperCase() === 'POS' && !d.revoked && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => showPairCode(d)}>CFD koda</Button>
                  )}
                  {d.revoked ? (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => deviceAction(d.id, 'restore')}>Obnovi</Button>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy} onClick={() => deviceAction(d.id, 'revoke')}>Revokiraj</Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 text-[11px] text-red-700" disabled={busy} onClick={() => deviceAction(d.id, 'delete')}>Izbriši</Button>
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

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Nova', CONFIRMED: 'Potrjena', ASSIGNED: 'Dodeljena', PICKED_UP: 'Prevzeta',
  ON_THE_WAY: 'Na poti', DELIVERED: 'Dostavljeno', CANCELLED: 'Preklicana',
}
const DELIVERY_STATUS_BG: Record<string, string> = {
  PENDING: 'bg-amber-500 text-white', CONFIRMED: 'bg-emerald-600 text-white', ASSIGNED: 'bg-teal-600 text-white',
  PICKED_UP: 'bg-cyan-600 text-white', ON_THE_WAY: 'bg-sky-600 text-white',
  DELIVERED: 'bg-stone-500 text-white', CANCELLED: 'bg-red-600 text-white',
}
/** Naslednja tranzicija po toku (enako kot TRANSITIONS na backendu) */
const NEXT_STATUS: Record<string, { to: string; label: string } | null> = {
  PENDING: { to: 'CONFIRMED', label: 'Potrdi' },
  CONFIRMED: { to: 'ASSIGNED', label: 'Dodeli voznika' },
  ASSIGNED: { to: 'PICKED_UP', label: 'Prevzeto' },
  PICKED_UP: { to: 'ON_THE_WAY', label: 'Na poti' },
  ON_THE_WAY: { to: 'DELIVERED', label: 'Dostavljeno' },
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
        <h3 className="text-sm font-semibold text-stone-500 mb-2 flex items-center gap-1.5"><Truck className="w-4 h-4" /> Aktivna dostava ({active.length})</h3>
        {active.length === 0 && (
          <Card><CardContent className="p-6 text-center text-sm text-stone-500">Ni aktivnih dostavnih naročil.</CardContent></Card>
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
                    <Badge className={DELIVERY_STATUS_BG[d.status] || 'bg-stone-400 text-white'}>{DELIVERY_STATUS_LABELS[d.status] || d.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm"><span className="text-stone-500">Prejemnik:</span> {d.recipientName || '—'} {d.recipientPhone && <span className="text-stone-500">· {d.recipientPhone}</span>}</p>
                  <p className="text-sm"><span className="text-stone-500">Naslov:</span> {[d.address, d.postCode, d.city].filter(Boolean).join(', ') || '—'}</p>
                  {d.instructions && <p className="text-xs text-amber-700">Opomba: {d.instructions}</p>}
                  <p className="text-xs text-stone-500">{o.items.length} artiklov · <span className="font-semibold text-stone-900">{fmtEUR(o.total)}</span> (dostava {fmtEUR(d.deliveryFee)})</p>
                  {o.status === 'PAID' && <Badge className="bg-emerald-600 text-white">Plačano</Badge>}
                  {o.fursEor && <p className="text-[11px] text-stone-400">FURS EOR: {o.fursEor}</p>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {next && next.to !== 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => transition(o, next.to)} className="bg-emerald-700 hover:bg-emerald-800 text-white">{next.label}</Button>
                    )}
                    {next && next.to === 'ASSIGNED' && (
                      <Button size="sm" disabled={busy === o.id} onClick={() => { setDriverFor(o); setDriver({ name: d.courierName || d.driver?.name || '', phone: d.courierPhone || d.driver?.phone || '' }) }} className="bg-emerald-700 hover:bg-emerald-800 text-white">Dodeli voznika</Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy === o.id} onClick={() => { if (confirm(`Preklicati dostavo #${o.orderNumber}?`)) transition(o, 'CANCELLED', { note: 'Preklic operaterja' }) }} className="border-red-300 text-red-700 hover:bg-red-50">Prekliči</Button>
                  </div>
                  {d.driver?.name && <p className="text-xs text-stone-500">Voznik: {d.driver.name} {d.driver.phone && `· ${d.driver.phone}`}</p>}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Zgodovina */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Zaključene dostave</CardTitle></CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72">
              <div className="space-y-1.5 pr-3">
                {history.slice(0, 30).map((o) => {
                  const d = o.delivery
                  return (
                    <div key={o.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white p-2.5">
                      <p className="text-sm min-w-0 truncate">#{o.orderNumber} · {d?.recipientName || '—'} · {fmtEUR(o.total)}</p>
                      <Badge className={DELIVERY_STATUS_BG[d?.status || ''] || 'bg-stone-400 text-white'}>{DELIVERY_STATUS_LABELS[d?.status || ''] || d?.status || o.status}</Badge>
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
            <CardTitle className="text-base flex items-center gap-1.5"><Plus className="w-4 h-4" /> Dostavne cone</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setAddZone(true)}>Nova cona</Button>
          </CardHeader>
          <CardContent>
            {zones.length === 0 && <p className="text-sm text-stone-500">Ni con. Dostava brez cone je vedno mogoča.</p>}
            <div className="space-y-1.5">
              {zones.map((z) => (
                <div key={z.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{z.name}</p>
                    <p className="text-xs text-stone-500">pristojbina {fmtEUR(z.deliveryFee)} · min. naročilo {fmtEUR(z.minOrderAmount)} · ~{z.estimatedMinutes} min</p>
                  </div>
                  <Switch checked={z.isActive} disabled={busy === z.id} onCheckedChange={() => toggleZone(z)} aria-label={`Aktivnost cone ${z.name}`} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Platforme + napake webhookov */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><ShieldAlert className="w-4 h-4" /> Platforme — webhooki in napake</CardTitle></CardHeader>
          <CardContent>
            {platformIntegrations.length === 0 && (
              <p className="text-sm text-stone-500">
                Integracija Glovo/Wolt ni registrirana. V Nastavitvah → Integracije dodaj zapisa s
                provider <code className="text-xs bg-stone-100 px-1 rounded">glovo</code> oz.
                <code className="text-xs bg-stone-100 px-1 rounded ml-1">wolt</code> in nastavi apiSecret (webhook podpis).
                Endpointa: <code className="text-xs bg-stone-100 px-1 rounded">/api/delivery/webhook/glovo</code>, <code className="text-xs bg-stone-100 px-1 rounded">/api/delivery/webhook/wolt</code>.
              </p>
            )}
            <div className="space-y-2">
              {platformIntegrations.map((p) => {
                const errors = p.logs.filter((l) => l.status !== 'success')
                return (
                  <div key={p.id} className="rounded-lg border border-stone-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium capitalize">{p.provider}</p>
                      <Badge className={p.isActive ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{p.isActive ? p.connectionStatus || 'aktivna' : 'neaktivna'}</Badge>
                    </div>
                    {errors.length === 0
                      ? <p className="text-xs text-stone-400 mt-1">Ni napak v zadnjih dogodkih.</p>
                      : (
                        <div className="mt-1.5 space-y-1">
                          {errors.slice(0, 5).map((l) => (
                            <p key={l.id} className="text-xs text-red-700 bg-red-50 rounded px-2 py-1 truncate">
                              {l.statusCode} · {l.action}: {l.errorMessage || 'napaka'}
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
          <DialogHeader><DialogTitle>Dodeli voznika — naročilo #{driverFor?.orderNumber}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="drv-name">Ime voznika</Label><Input id="drv-name" value={driver.name} onChange={(e) => setDriver({ ...driver, name: e.target.value })} placeholder="npr. Marko Novak" /></div>
            <div><Label htmlFor="drv-phone">Telefon</Label><Input id="drv-phone" value={driver.phone} onChange={(e) => setDriver({ ...driver, phone: e.target.value })} placeholder="+386 …" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDriverFor(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy !== null || !driver.name.trim()}
              onClick={async () => {
                if (!driverFor) return
                setBusy(driverFor.id)
                try {
                  await api('/api/delivery', { method: 'PATCH', body: JSON.stringify({ orderId: driverFor.id, status: 'ASSIGNED', driverName: driver.name, driverPhone: driver.phone }) })
                  setDriverFor(null); await onReload()
                } catch (err) { alert((err as Error).message) } finally { setBusy(null) }
              }}>Dodeli</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova cona */}
      <Dialog open={addZone} onOpenChange={setAddZone}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Nova dostavna cona</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="z-name">Ime cone</Label><Input id="z-name" value={nz.name} onChange={(e) => setNz({ ...nz, name: e.target.value })} placeholder="npr. Center" /></div>
            <div className="grid grid-cols-3 gap-2">
              <div><Label htmlFor="z-fee">Pristojbina (€)</Label><Input id="z-fee" type="number" step="0.01" value={nz.deliveryFee} onChange={(e) => setNz({ ...nz, deliveryFee: e.target.value })} /></div>
              <div><Label htmlFor="z-min">Min. naročilo (€)</Label><Input id="z-min" type="number" step="0.01" value={nz.minOrderAmount} onChange={(e) => setNz({ ...nz, minOrderAmount: e.target.value })} /></div>
              <div><Label htmlFor="z-mins">Čas (min)</Label><Input id="z-mins" type="number" value={nz.estimatedMinutes} onChange={(e) => setNz({ ...nz, estimatedMinutes: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddZone(false)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy === 'zone' || !nz.name.trim()} onClick={createZone}>Dodaj</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── RAČUNOVODSKI IZVOZ ─────────────────────────── */

export function AccountingExportCard() {
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
        throw new Error((data as { error?: string })?.error || 'Izvoz ni uspel.')
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
        <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Računovodski izvoz</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">
          Prodaja po dnevih (neto/DDV/popusti/napitnine), DDV razčlenba po stopnjah, plačila po načinih,
          računi dobaviteljev in gibanje zalog za izbrano obdobje. CSV je pripravljen za Excel in računovodske programe.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="exp-from" className="text-xs">Od</Label>
            <Input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exp-to" className="text-xs">Do</Label>
            <Input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white min-h-10 gap-1.5" disabled={busy !== null || !from || !to} onClick={() => download('csv')}>
            {busy === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} Izvozi (CSV)
          </Button>
          <Button size="sm" variant="outline" className="min-h-10 gap-1.5" disabled={busy !== null || !from || !to} onClick={() => download('json')}>
            {busy === 'json' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} Izvozi (JSON)
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

  const t = data?.totals
  const pool = data?.pool ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5"><HeartHandshake className="w-4 h-4" /> Napitnine — dnevni bazen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-stone-500">Napitnine iz plačil (Payment.tipAmount) se za izbrani dan zaprejo v bazen in razdelijo zaposlenim po izbrani osnovi. Delitev v centih je točna (brez izgube centov), distribucije so hash-verižene (nespremenljive), izplačila so revidirana. En bazen na dan + lokacijo.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Dan</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Lokacija</Label>
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
              <Label>Osnova delitve</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as 'hours' | 'equal' | 'points')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">Po urah (izmene)</SelectItem>
                  <SelectItem value="equal">Enakovredno</SelectItem>
                  <SelectItem value="points">Po točkah (kmalu)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {t && (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">Zbrane napitnine</p>
                <p className="text-lg font-bold">{fmtEUR(t.totalCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">Gotovina</p>
                <p className="text-lg font-semibold">{fmtEUR(t.cashCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">Kartica/druge</p>
                <p className="text-lg font-semibold">{fmtEUR(t.nonCashCents / 100)}</p>
              </div>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs text-stone-500">Plačila z napitnino</p>
                <p className="text-lg font-semibold">{t.payments}</p>
              </div>
            </div>
          )}
          {data?.fallbackEqual && (
            <p className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Za ta dan ni evidentiranih ur (izmen) — delitev po urah je samodejno padla na enakovredno.</p>
          )}
        </CardContent>
      </Card>

      {pool ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
              Distribucija — {pool.distributionMethod === 'hours' ? 'po urah' : pool.distributionMethod === 'points' ? 'po točkah' : 'enakovredno'}
              <Badge variant={pool.status === 'paid' ? 'default' : 'outline'} className={pool.status === 'paid' ? 'bg-emerald-700' : ''}>
                {pool.status === 'paid' ? 'izplačano' : 'čaka izplačilo'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">Zaposleni</th>
                    <th className="p-2">Osnova</th>
                    <th className="p-2 text-right">Znesek</th>
                    <th className="p-2">Status</th>
                    {canManage && <th className="p-2 text-right">Izplačaj</th>}
                  </tr>
                </thead>
                <tbody>
                  {pool.TipDistribution.map((d) => (
                    <tr key={d.id} className="border-t border-stone-100">
                      <td className="p-2 font-medium">{d.employeeName}</td>
                      <td className="p-2 text-stone-600">
                        {pool.distributionMethod === 'hours' && d.hoursWorked > 0 ? `${d.hoursWorked.toFixed(2)} h` : pool.distributionMethod === 'points' && d.points > 0 ? `${d.points} točk` : 'enako'}
                      </td>
                      <td className="p-2 text-right font-semibold">{fmtEUR(d.amount)}</td>
                      <td className="p-2">
                        {d.status === 'paid'
                          ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">izplačano {d.paidAt ? new Date(d.paidAt).toLocaleString('sl-SI') : ''}</Badge>
                          : <Badge variant="outline">čaka</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          {d.status === 'pending' && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => payout(d.id)}>Označi izplačano</Button>
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
                <Button disabled={busy} onClick={() => payout()} className="bg-emerald-700 hover:bg-emerald-800 text-white">Izplačaj vse čakajoče ({pool.TipDistribution.filter((d) => d.status === 'pending').length})</Button>
              </div>
            )}
            <p className="text-xs text-stone-400">Zneski distribucij so zaščiteni z hash-verigo — vsaka sprememba bi bila vidna. Izplačila so zapisana v revizijski dnevnik (TIP_PAYOUT).</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Predogled delitve za {date}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {data && data.employees.length > 0 ? (
              <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">Zaposleni</th>
                      <th className="p-2">Ure tega dne</th>
                      <th className="p-2 text-right">Predvideni delež</th>
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
              <p className="text-sm text-stone-500">Za ta dan ni napitnin ali zaposlenih z osnovo.</p>
            )}
            {canManage && t && t.totalCents > 0 && data && data.employees.length > 0 && (
              <div className="flex justify-end">
                <Button disabled={busy} onClick={closeDay} className="bg-emerald-700 hover:bg-emerald-800 text-white">Zaključi dan — ustvari bazen ({fmtEUR(t.totalCents / 100)})</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Zgodovina bazenov</CardTitle></CardHeader>
        <CardContent>
          {data && data.history.length > 0 ? (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">Dan</th>
                    <th className="p-2 text-right">Skupaj</th>
                    <th className="p-2">Osnova</th>
                    <th className="p-2 text-right">Zaposleni</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((p) => (
                    <tr key={p.id} className="border-t border-stone-100">
                      <td className="p-2">{new Date(p.date).toLocaleDateString('sl-SI')}</td>
                      <td className="p-2 text-right font-semibold">{fmtEUR(Number(p.totalTips))}</td>
                      <td className="p-2 text-stone-600">{p.distributionMethod === 'hours' ? 'po urah' : p.distributionMethod === 'points' ? 'po točkah' : 'enakovredno'}</td>
                      <td className="p-2 text-right">{p.paid}/{p.employees} izplačano</td>
                      <td className="p-2">
                        <Badge variant={p.status === 'paid' ? 'default' : 'outline'} className={p.status === 'paid' ? 'bg-emerald-700' : ''}>{p.status === 'paid' ? 'izplačano' : 'v obdelavi'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-stone-500">Še ni zaključenih dni.</p>
          )}
        </CardContent>
      </Card>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
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
  draft: { label: 'Osnutek', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  submitted: { label: 'Oddano', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  approved: { label: 'Odobreno', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  partial: { label: 'Delno prevzeto', cls: 'border-orange-300 bg-orange-100 text-orange-800' },
  received: { label: 'Prevzeto', cls: 'border-green-300 bg-green-100 text-green-800' },
  cancelled: { label: 'Preklicano', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const NABAVA_ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'čaka', cls: 'border-stone-300 text-stone-600' },
  partial: { label: 'delno', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  received: { label: 'prejeto', cls: 'border-green-300 bg-green-50 text-green-800' },
}

const nabavaNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
const nabavaDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('sl-SI') : '—')

export function NabavaTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
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
    if (action === 'cancel' && !window.confirm('Res želiš preklicati to nabavno naročilo?')) return
    setBusy(true); setErr(''); setOkMsg('')
    try {
      await api(`/api/purchase-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      setOkMsg(action === 'submit' ? 'Naročilo oddano dobavitelju.' : action === 'approve' ? 'Naročilo odobreno — čaka prevzem.' : 'Naročilo preklicano.')
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
    if (!supDialog.name.trim()) { setSupErr('Naziv dobavitelja je obvezen.'); return }
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
        setOkMsg('Dobavitelj posodobljen.')
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) })
        setOkMsg('Dobavitelj dodan.')
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
    if (!poSupplierId) { setPoErr('Izberi dobavitelja.'); return }
    if (poLines.length === 0) { setPoErr('Dodaj vsaj eno vrstico (artikel zaloge ali ročni vnos).'); return }
    for (let i = 0; i < poLines.length; i++) {
      const l = poLines[i]
      if (!l.inventoryItemId && !l.description.trim()) { setPoErr(`Vrstica ${i + 1}: opis je obvezen.`); return }
      const q = nabavaNum(l.quantity)
      if (!Number.isFinite(q) || q <= 0) { setPoErr(`Vrstica ${i + 1}: količina mora biti večja od 0.`); return }
      const p = nabavaNum(l.unitPrice)
      if (!Number.isFinite(p) || p < 0) { setPoErr(`Vrstica ${i + 1}: cena ne sme biti negativna.`); return }
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
      setPoDialog(false); setPoLines([]); setOkMsg('Nabavno naročilo ustvarjeno (osnutek).')
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
      if (!Number.isFinite(a) || a < 0 || !Number.isFinite(r) || r < 0) { setRecvErr(`Vrstica „${it.description}": količini morata biti števili ≥ 0.`); return }
      if (a === 0 && r === 0) continue
      if (r > 0 && !l.reason.trim()) { setRecvErr(`Vrstica „${it.description}": razlog zavrnitve je obvezen, če je zavrnjeno > 0.`); return }
      payloadLines.push({
        purchaseOrderItemId: it.id,
        quantityAccepted: a,
        quantityRejected: r,
        rejectReason: r > 0 ? l.reason.trim() : undefined,
        expiryDate: l.expiry || undefined,
      })
    }
    if (payloadLines.length === 0) { setRecvErr('Vnesi vsaj eno količino (sprejeto ali zavrnjeno).'); return }
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
      <p className="text-xs text-stone-500">Nabavni tok: dobavitelj → naročilo (osnutek → oddaja → odobritev) → prevzem (delna ali popolna dobava) → primerjava naročeno/prejeto in zgodovina nabavnih cen. Prevzem samodejno posodobi zalogo (uteženo povprečje) in zapiše serijo (batch) ter revizijski sled.</p>

      {/* A — DOBAVITELJI */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Truck className="w-4 h-4" /> Dobavitelji
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => openSupDialog()}>
                <Plus className="w-3.5 h-3.5" /> Nov dobavitelj
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suppliers.length === 0 ? (
            <p className="text-sm text-stone-500">Ni dobaviteljev — {canManage ? 'dodaj prvega.' : 'naroči skrbnika, da doda prvega.'}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">Naziv</th>
                    <th className="p-2">Kontakt</th>
                    <th className="p-2">Telefon / e-pošta</th>
                    <th className="p-2">Kraj</th>
                    <th className="p-2 text-right">Naročila</th>
                    <th className="p-2 text-right">Artikli</th>
                    <th className="p-2">Status</th>
                    {canManage && <th className="p-2 text-right">Uredi</th>}
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
                          ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">aktiven</Badge>
                          : <Badge variant="outline" className="text-stone-500">neaktiven</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => openSupDialog(s)}>Uredi</Button>
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
            <PackageSearch className="w-4 h-4" /> Nabavna naročila
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={openPoDialog}>
                <Plus className="w-3.5 h-3.5" /> Novo naročilo
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="sm:max-w-xs space-y-1.5">
            <Label>Filter statusa</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Vsi statusi</SelectItem>
                {Object.entries(NABAVA_STATUS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalagam nabavne podatke …</p>
          ) : filteredOrders.length === 0 ? (
            <p className="text-sm text-stone-500">{orders.length === 0 ? 'Ni še naročil — ustvari prvo nabavno naročilo.' : 'Ni naročil za izbrani status.'}</p>
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
                        <Badge variant="outline" className={st?.cls || ''}>{st?.label || o.status}</Badge>
                      </div>
                      <span className="font-bold">{fmtEUR(o.totalAmount)}</span>
                    </div>
                    <p className="text-xs text-stone-500 mt-1">
                      {o.supplierName || '—'} · naročeno {nabavaDate(o.orderDate)}
                      {o.expectedDate ? ` · pričakovano ${nabavaDate(o.expectedDate)}` : ''}
                      {' · '}{o.items.length} vrstic · {o.receiptsCount === 1 ? '1 prevzem' : o.receiptsCount === 2 ? '2 prevzema' : `${o.receiptsCount} prevzemov`}
                    </p>
                    {canManage && active && (
                      <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                        {o.status === 'draft' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => poAction(o.id, 'submit')}>Oddaj</Button>
                        )}
                        {o.status === 'submitted' && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => poAction(o.id, 'approve')}>Odobri</Button>
                        )}
                        {(o.status === 'approved' || o.status === 'partial') && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => openReceive(o)}>
                            <Truck className="w-3.5 h-3.5" /> Prevzemi
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy} onClick={() => poAction(o.id, 'cancel')}>Prekliči</Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Dialog: dobavitelj (nov / uredi) */}
      <Dialog open={supDialog !== null} onOpenChange={(v) => { if (!v) setSupDialog(null) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{supDialog?.editingId ? 'Uredi dobavitelja' : 'Nov dobavitelj'}</DialogTitle></DialogHeader>
          {supDialog && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-name">Naziv *</Label>
                <Input id="nb-sup-name" value={supDialog.name} onChange={(e) => setSupDialog({ ...supDialog, name: e.target.value })} placeholder="npr. Mlinarstvo Kranj d.o.o." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-contact">Kontaktna oseba</Label>
                  <Input id="nb-sup-contact" value={supDialog.contact} onChange={(e) => setSupDialog({ ...supDialog, contact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-phone">Telefon</Label>
                  <Input id="nb-sup-phone" value={supDialog.phone} onChange={(e) => setSupDialog({ ...supDialog, phone: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-email">E-pošta</Label>
                  <Input id="nb-sup-email" type="email" value={supDialog.email} onChange={(e) => setSupDialog({ ...supDialog, email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-city">Kraj</Label>
                  <Input id="nb-sup-city" value={supDialog.city} onChange={(e) => setSupDialog({ ...supDialog, city: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-tax">Davčna številka</Label>
                  <Input id="nb-sup-tax" value={supDialog.taxId} onChange={(e) => setSupDialog({ ...supDialog, taxId: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-iban">IBAN</Label>
                  <Input id="nb-sup-iban" value={supDialog.iban} onChange={(e) => setSupDialog({ ...supDialog, iban: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-terms">Plačilni pogoji</Label>
                  <Input id="nb-sup-terms" value={supDialog.paymentTerms} onChange={(e) => setSupDialog({ ...supDialog, paymentTerms: e.target.value })} placeholder="npr. 30 dni" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-addr">Naslov</Label>
                <Input id="nb-sup-addr" value={supDialog.address} onChange={(e) => setSupDialog({ ...supDialog, address: e.target.value })} />
              </div>
              {supErr && <p className="text-sm text-red-600">{supErr}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupDialog(null)} disabled={supBusy}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={saveSupplier} disabled={supBusy}>
              {supBusy && <Loader2 className="w-4 h-4 animate-spin" />} Shrani
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: novo nabavno naročilo */}
      <Dialog open={poDialog} onOpenChange={(v) => { if (!v) setPoDialog(false) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Novo nabavno naročilo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Dobavitelj *</Label>
                <Select value={poSupplierId} onValueChange={setPoSupplierId}>
                  <SelectTrigger><SelectValue placeholder={suppliers[0]?.name || 'Izberi dobavitelja'} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {suppliers.filter((s) => s.isActive).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {suppliers.length === 0 && <p className="text-xs text-amber-700">Ni aktivnih dobaviteljev — najprej dodaj dobavitelja v sekciji zgoraj.</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Lokacija</Label>
                {locations.length > 0 ? (
                  <Select value={poLocationId} onValueChange={setPoLocationId}>
                    <SelectTrigger><SelectValue placeholder="Privzeta (prijava)" /></SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input disabled value="Privzeta (prijava)" />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-expected">Pričakovani datum</Label>
                <Input id="nb-po-expected" type="date" value={poExpected} onChange={(e) => setPoExpected(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-notes">Opomba</Label>
                <Input id="nb-po-notes" value={poNotes} onChange={(e) => setPoNotes(e.target.value)} placeholder="npr. dostava do 8. ure" />
              </div>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1.5 grow min-w-48">
                <Label>Dodaj artikel zaloge</Label>
                <Select value="" onValueChange={addPoLineFromInventory}>
                  <SelectTrigger><SelectValue placeholder="Izberi artikel …" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {invItems.filter((i) => !poLines.some((l) => l.inventoryItemId === i.id)).map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" size="sm" className="h-9" onClick={addManualPoLine}>
                <Plus className="w-3.5 h-3.5" /> Ročna vrstica
              </Button>
            </div>

            {poLines.length === 0 ? (
              <p className="text-xs text-stone-500">Ni vrstic — dodaj artikel zaloge ali ročno vrstico. Artikel samodejno prenese enoto in privzeto nabavno ceno.</p>
            ) : (
              <div className="space-y-2">
                {poLines.map((l, idx) => (
                  <div key={l.inventoryItemId || `m${idx}`} className="rounded-lg border border-stone-200 bg-stone-50 p-2">
                    <div className="grid gap-2 sm:grid-cols-12 items-end">
                      <div className="sm:col-span-4 space-y-1">
                        <Label className="text-xs text-stone-500">Artikel / opis</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm font-medium py-1.5">{l.description}</p>
                        ) : (
                          <Input value={l.description} onChange={(e) => updatePoLine(idx, { description: e.target.value })} placeholder="npr. svež kruh" />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">Količina</Label>
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => updatePoLine(idx, { quantity: e.target.value })} />
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">Enota</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm py-1.5 text-stone-600">{l.unit}</p>
                        ) : (
                          <Input value={l.unit} onChange={(e) => updatePoLine(idx, { unit: e.target.value })} />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">Cena/enota (€)</Label>
                        <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => updatePoLine(idx, { unitPrice: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 space-y-1">
                        <Label className="text-xs text-stone-500">DDV %</Label>
                        <Input inputMode="decimal" value={l.vatRate} onChange={(e) => updatePoLine(idx, { vatRate: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <Button size="sm" variant="outline" className="h-9 w-9 p-0 text-red-600" aria-label="Odstrani vrstico" onClick={() => removePoLine(idx)}>×</Button>
                      </div>
                    </div>
                    <p className="text-xs text-stone-500 mt-1 text-right">Znesek vrstice: <b>{fmtEUR(poLineNet(l))}</b></p>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-stone-600">Skupaj brez DDV</span><span>{fmtEUR(poSubtotal)}</span></div>
              <div className="flex justify-between"><span className="text-stone-600">DDV</span><span>{fmtEUR(poVatTotal)}</span></div>
              <div className="flex justify-between font-bold"><span>Skupaj</span><span>{fmtEUR(poSubtotal + poVatTotal)}</span></div>
            </div>

            {poErr && <p className="text-sm text-red-600">{poErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPoDialog(false)} disabled={poBusy}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={savePo} disabled={poBusy}>
              {poBusy && <Loader2 className="w-4 h-4 animate-spin" />} Ustvari osnutek
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: detajl naročila (naročeno/prejeto/zavrnjeno, prevzemi, zgodovina cen) */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) { setDetailId(null); setDetail(null) } }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              Naročilo {detail?.poNumber || '…'}
              {detail && (
                <Badge variant="outline" className={NABAVA_STATUS[detail.status]?.cls || ''}>
                  {NABAVA_STATUS[detail.status]?.label || detail.status}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailBusy && !detail && (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalagam detajl …</p>
          )}
          {detailErr && <p className="text-sm text-red-600">{detailErr}</p>}
          {detail && (
            <div className="space-y-4">
              <div className="text-xs text-stone-600 space-y-0.5">
                <p>
                  Dobavitelj: <b>{detail.supplier?.name || '—'}</b>
                  {detail.supplier?.contactPerson ? ` · ${detail.supplier.contactPerson}` : ''}
                  {detail.supplier?.phone ? ` · ${detail.supplier.phone}` : ''}
                  {detail.supplier?.email ? ` · ${detail.supplier.email}` : ''}
                </p>
                <p>Naročeno: {nabavaDate(detail.orderDate)} · Pričakovano: {nabavaDate(detail.expectedDate)} · Prevzeto: {nabavaDate(detail.receivedDate)}</p>
                <p>Oddal: {detail.requestedBy || '—'} · Odobril: {detail.approvedBy || '—'}</p>
                {detail.notes && <p>Opomba: {detail.notes}</p>}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">Vrstice — naročeno / prejeto / zavrnjeno</p>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-stone-200">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                      <tr>
                        <th className="p-2">Postavka</th>
                        <th className="p-2 text-right">Naročeno</th>
                        <th className="p-2 text-right">Prejeto</th>
                        <th className="p-2 text-right">Zavrnjeno</th>
                        <th className="p-2 text-right">Cena/en.</th>
                        <th className="p-2 text-right">Skupaj</th>
                        <th className="p-2">Status</th>
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
                              <Badge variant="outline" className={ist?.cls || ''}>{ist?.label || it.status}</Badge>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-stone-600 mt-2 text-right">
                  Brez DDV: {fmtEUR(detail.subtotal)} · DDV: {fmtEUR(detail.vatAmount)} · <b>Skupaj: {fmtEUR(detail.totalAmount)}</b>
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">Prevzemi ({detail.receipts.length})</p>
                {detail.receipts.length === 0 ? (
                  <p className="text-sm text-stone-500">Ni še prevzemov.</p>
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
                        {g.supplierDocNumber && <p className="text-xs text-stone-500">Dokument dobavitelja: {g.supplierDocNumber}</p>}
                        <ul className="text-xs text-stone-600 mt-1 space-y-0.5">
                          {g.items.map((gi, i) => (
                            <li key={i}>
                              {gi.description}: sprejeto {gi.quantityAccepted} {gi.unit}
                              {gi.quantityRejected > 0 ? ` · zavrnjeno ${gi.quantityRejected}${gi.rejectReason ? ` (${gi.rejectReason})` : ''}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">Zgodovina nabavnih cen</p>
                {detail.priceHistory.length === 0 ? (
                  <p className="text-sm text-stone-500">Ni zapisov o cenah za artikle tega naročila.</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded-xl border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">Artikel</th>
                          <th className="p-2 text-right">Cena/en.</th>
                          <th className="p-2 text-right">DDV</th>
                          <th className="p-2">Vir</th>
                          <th className="p-2 text-right">Opazovano</th>
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
                              <td className="p-2 text-stone-600">{h.source === 'goods_receipt' ? 'prevzem' : h.source === 'purchase_order' ? 'naročilo' : h.source}</td>
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
          <DialogHeader><DialogTitle>Prevzem blaga — {recvOrder?.poNumber || ''}</DialogTitle></DialogHeader>
          {recvDone ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
                Prevzem shranjen: <b>{recvDone.grnNumber}</b>. Zaloga je posodobljena (uteženo povprečje), serije in zgodovina cen so zapisane.
              </div>
              {recvDone.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Opozorila</p>
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
                  <Label htmlFor="nb-recv-doc">Dokument dobavitelja</Label>
                  <Input id="nb-recv-doc" value={recvDoc} onChange={(e) => setRecvDoc(e.target.value)} placeholder="npr. št. računa dobavitelja" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-recv-notes">Opomba</Label>
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
                        Naročeno: {it.quantityOrdered} {it.unit} · že prejeto: {it.quantityReceived}
                        {it.quantityRejected > 0 ? ` · zavrnjeno: ${it.quantityRejected}` : ''} · ostane: {remaining} {it.unit}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-4 items-end">
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">Sprejeto</Label>
                          <Input inputMode="decimal" value={l.accept} onChange={(e) => updateRecvLine(it.id, { accept: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">Zavrnjeno</Label>
                          <Input inputMode="decimal" value={l.reject} onChange={(e) => updateRecvLine(it.id, { reject: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">Razlog zavrnitve{rejNum > 0 ? ' *' : ''}</Label>
                          <Input value={l.reason} onChange={(e) => updateRecvLine(it.id, { reason: e.target.value })} placeholder="npr. poškodovano" />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">Datum uporabljivosti</Label>
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
              <Button variant="outline" onClick={() => setRecvOrder(null)}>Zapri</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setRecvOrder(null)} disabled={recvBusy}>Prekliči</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={submitReceive} disabled={recvBusy}>
                  {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} Posreduj prevzem
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
  active: { label: 'Aktivna', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  inactive: { label: 'Deaktivirana', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  exhausted: { label: 'Izčrpana', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  expired: { label: 'Pretekla', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const GC_TX: Record<string, { label: string; cls: string }> = {
  issue: { label: 'Izdaja', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  topup: { label: 'Polnjenje', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  redeem: { label: 'Unovčenje', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  refund: { label: 'Vračilo', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
  adjust: { label: 'Popravek', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
}

const gcEur = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Issue #1 (triage ③): darilne kartice — pregled, izdaja, polnjenje, ledžer, deaktivacija. */
export function DarilneKarticeTab({ canPay, canManage }: { canPay: boolean; canManage: boolean }) {
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
      setErr('Začetni saldo mora biti ne negativno število.')
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
      setOkMsg(d.replayed ? `Kartica je že obstajala (replay): ${d.card.cardNumber}` : `Kartica izdana: ${d.card.cardNumber}`)
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
      setErr('Znesek polnjenja mora biti pozitivno število.')
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
      setOkMsg(d.replayed ? `Polnjenje je že bilo izvedeno (replay) — saldo ${fmtEUR(d.card.balance)}` : `Polnjeno ${fmtEUR(eur)} — nov saldo ${fmtEUR(d.card.balance)}`)
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
    if (!window.confirm(next === 'inactive' ? `Deaktiviram kartico ${c.cardNumber}?` : `Reaktiviram kartico ${c.cardNumber}?`)) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/giftcards/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      setOkMsg(next === 'inactive' ? 'Kartica deaktivirana.' : 'Kartica reaktivirana.')
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
            placeholder="Išči po številki kartice ali lastniku …"
            className="max-w-xs"
            aria-label="Iskanje darilnih kartic"
          />
          <Button variant="outline" onClick={() => void load()} disabled={loading}>Išči</Button>
          {q && <Button variant="ghost" onClick={() => { setQ(''); void load('') }}>Počisti</Button>}
        </div>
        {canPay && (
          <Button className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5" onClick={() => { setErr(''); setOkMsg(''); setIssueOpen(true) }}>
            <Plus className="w-4 h-4" /> Novo kartico
          </Button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            ['Aktivne kartice', String(stats.active), 'aktivne z saldom'],
            ['Skupni saldo', fmtEUR(stats.totalBalance), 'aktivne kartice'],
            ['Izdane (30 dni)', String(stats.issued30), 'nove kartice'],
            ['Unovčeno (30 dni)', fmtEUR(stats.redeemed30), 'plačila s karticami'],
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
        <CardHeader className="pb-2"><CardTitle className="text-base">Kartice {cards.length > 0 && <span className="text-stone-400 font-normal">({cards.length})</span>}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-4 text-sm text-stone-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Nalagam …</p>
          ) : cards.length === 0 ? (
            <p className="p-4 text-sm text-stone-500">Ni kartic{q ? ' za to iskanje' : ''}. {canPay ? 'Izdajte prvo kartico.' : ''}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-stone-500 border-b border-stone-200 sticky top-0 bg-white">
                  <tr>
                    <th className="px-4 py-2 font-medium">Številka</th>
                    <th className="px-4 py-2 font-medium">Lastnik</th>
                    <th className="px-4 py-2 font-medium">Saldo</th>
                    <th className="px-4 py-2 font-medium hidden sm:table-cell">Izdana</th>
                    <th className="px-4 py-2 font-medium hidden md:table-cell">Velja do</th>
                    <th className="px-4 py-2 font-medium">Stanje</th>
                    <th className="px-4 py-2 font-medium text-right">Dejanja</th>
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
                      <td className="px-4 py-2.5"><Badge variant="outline" className={GC_STATUS[c.effectiveStatus]?.cls || ''}>{GC_STATUS[c.effectiveStatus]?.label || c.effectiveStatus}</Badge></td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {canPay && (
                          <Button variant="outline" size="sm" className="h-8 mr-1.5" onClick={() => { setTopupCard(c); setTopupForm({ amount: '', note: '' }); setErr(''); setOkMsg('') }}>
                            Polni
                          </Button>
                        )}
                        {canManage && c.status !== 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8 text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(c)}>
                            Deaktiviraj
                          </Button>
                        )}
                        {canManage && c.status === 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8" onClick={() => void toggleStatus(c)}>
                            Reaktiviraj
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
          <DialogHeader><DialogTitle className="text-lg">Izdaj darilno kartico</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Lastnik (opcijsko)</Label>
              <Input value={issueForm.ownerName} onChange={(e) => setIssueForm((f) => ({ ...f, ownerName: e.target.value }))} placeholder="Ime kupca / prejemnika" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Začetni saldo (EUR)</Label>
              <Input type="number" step="0.01" min="0" value={issueForm.initialBalance} onChange={(e) => setIssueForm((f) => ({ ...f, initialBalance: e.target.value }))} placeholder="0.00 — kartica brez vrednosti" />
              <p className="text-xs text-stone-500">0 € = kartica brez vrednosti (polni se kasneje). Največ 5.000 €.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Velja do (opcijsko)</Label>
              <Input type="date" value={issueForm.expiresAt} onChange={(e) => setIssueForm((f) => ({ ...f, expiresAt: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Opomba (opcijsko)</Label>
              <Input value={issueForm.note} onChange={(e) => setIssueForm((f) => ({ ...f, note: e.target.value }))} placeholder="npr. prodaja na blagajni" />
            </div>
          </div>
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={busy}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitIssue()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Izdaj kartico
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: polnjenje */}
      <Dialog open={!!topupCard} onOpenChange={(v) => !v && setTopupCard(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">Polnjenje {topupCard?.cardNumber}</DialogTitle>
          </DialogHeader>
          {topupCard && (
            <div className="space-y-3">
              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 text-sm space-y-0.5">
                <p>Trenutni saldo: <b>{fmtEUR(topupCard.balance)}</b></p>
                {topupCard.ownerName && <p className="text-stone-500">Lastnik: {topupCard.ownerName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Znesek polnjenja (EUR)</Label>
                <Input type="number" step="0.01" min="0.01" value={topupForm.amount} onChange={(e) => setTopupForm((f) => ({ ...f, amount: e.target.value }))} placeholder="10.00" autoFocus />
                <p className="text-xs text-stone-500">Največ 5.000 € na polnjenje.</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Opomba (opcijsko)</Label>
                <Input value={topupForm.note} onChange={(e) => setTopupForm((f) => ({ ...f, note: e.target.value }))} placeholder="npr. gotovinski vnos" />
              </div>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setTopupCard(null)} disabled={busy}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitTopup()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Polni
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: detalj + ledžer transakcij */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">Kartica {detail?.card.cardNumber}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                  <p className="text-xs text-stone-500">Saldo</p>
                  <p className="text-lg font-bold">{fmtEUR(detail.card.balance)}</p>
                  <p className="text-xs text-stone-400">začetno {fmtEUR(detail.card.initialBalance)}</p>
                </div>
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5 space-y-0.5">
                  <p className="text-xs text-stone-500">Stanje</p>
                  <Badge variant="outline" className={GC_STATUS[detail.card.effectiveStatus]?.cls || ''}>{GC_STATUS[detail.card.effectiveStatus]?.label || detail.card.effectiveStatus}</Badge>
                  <p className="text-xs text-stone-400">{detail.card.ownerName ? `Lastnik: ${detail.card.ownerName}` : 'Brez lastnika'}</p>
                  <p className="text-xs text-stone-400">{detail.card.expiresAt ? `Velja do ${new Date(detail.card.expiresAt).toLocaleDateString('sl-SI')}` : 'Brez roka veljavnosti'}</p>
                </div>
              </div>
              {canManage && detail.card.status !== 'inactive' && (
                <Button variant="outline" size="sm" className="text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(detail.card)}>Deaktiviraj kartico</Button>
              )}
              {canManage && detail.card.status === 'inactive' && (
                <Button variant="outline" size="sm" onClick={() => void toggleStatus(detail.card)}>Reaktiviraj kartico</Button>
              )}
              <div>
                <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1.5">Ledžer transakcij</p>
                {detail.transactions.length === 0 ? (
                  <p className="text-sm text-stone-500">Ni transakcij.</p>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-stone-500 border-b border-stone-200 bg-stone-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 font-medium">Vrsta</th>
                          <th className="px-3 py-2 font-medium text-right">Znesek</th>
                          <th className="px-3 py-2 font-medium text-right">Saldo po</th>
                          <th className="px-3 py-2 font-medium hidden sm:table-cell">Opomba</th>
                          <th className="px-3 py-2 font-medium">Datum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.transactions.map((t) => (
                          <tr key={t.id} className="border-b border-stone-100">
                            <td className="px-3 py-2"><Badge variant="outline" className={GC_TX[t.type]?.cls || ''}>{GC_TX[t.type]?.label || t.type}</Badge></td>
                            <td className={`px-3 py-2 text-right font-semibold ${t.amount < 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{t.amount > 0 ? '+' : ''}{fmtEUR(t.amount)}</td>
                            <td className="px-3 py-2 text-right">{fmtEUR(t.balanceAfter)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell text-xs text-stone-500 max-w-40 truncate" title={t.note}>{t.note}</td>
                            <td className="px-3 py-2 text-xs text-stone-500 whitespace-nowrap">{new Date(t.createdAt).toLocaleString('sl-SI')}</td>
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
            <Button variant="outline" onClick={() => setDetail(null)}>Zapri</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
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
  { value: 'pokvarjeno', label: 'Pokvarjeno' },
  { value: 'preteklo', label: 'Pretekel rok' },
  { value: 'priprava', label: 'Napaka pri pripravi' },
  { value: 'razlitje', label: 'Razlitje / padec' },
  { value: 'hlajenje', label: 'Okvara hladilne verige' },
  { value: 'reklamacija', label: 'Vrnjena postavka (reklamacija)' },
  { value: 'drugo', label: 'Drugo' },
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

const wasteNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Issue #1 (triage ④): odpad hrane — evidenca (zaloga ↓, StockTransaction WASTE), statistika po razlogih, reverzija pomote. */
export function OdpadTab({ canManage }: { canManage: boolean }) {
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
      setErr('Izberi artikel zaloge.')
      return
    }
    const qty = wasteNum(form.quantity)
    if (Number.isNaN(qty) || qty <= 0) {
      setErr('Količina odpada mora biti število večje od 0.')
      return
    }
    if (!form.reason) {
      setErr('Izberi razlog odpada.')
      return
    }
    if (qty > sel.qty) {
      setErr(`Na zalogi je samo ${sel.qty} ${sel.unit} — količino najprej popravi v Zalogah.`)
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
        ? 'Odpad je bil že evidentiran (replay) — zaloga ni bila ponovno odšteta.'
        : `Odpad evidentiran: ${d.record.quantity} ${idx?.unit ?? ''} × ${fmtEUR(idx?.cost ?? 0)} = ${fmtEUR(d.record.totalCost)}${idx && newQty !== undefined ? ` · zaloga ${idx.qty} → ${newQty}` : ''}`)
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
    if (!window.confirm(`Povrnem odpad ${w.itemName} (${w.quantity} ${w.unit})? Količina se vrne na zalogo.`)) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waste/${w.id}/reverse`, { method: 'POST' })
      setOkMsg(`Odpad povrnjen — ${w.quantity} ${w.unit} ${w.itemName} je nazaj na zalogi.`)
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
              <SelectItem value="7">Zadnjih 7 dni</SelectItem>
              <SelectItem value="30">Zadnjih 30 dni</SelectItem>
              <SelectItem value="90">Zadnjih 90 dni</SelectItem>
              <SelectItem value="365">Zadnjih 365 dni</SelectItem>
            </SelectContent>
          </Select>
          <Select value={reasonFilter} onValueChange={(v) => { setReasonFilter(v); void load(days, v) }}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vsi">Vsi razlogi</SelectItem>
              {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5">
            <Plus className="w-4 h-4" /> Nov odpad
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">Odpad v obdobju</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-red-700">{fmtEUR(stats.totalCents / 100)}</p><p className="text-xs text-stone-500">{stats.count} zapisov</p></CardContent>
          </Card>
          {stats.byReason.slice(0, 3).map((r) => (
            <Card key={r.reason}>
              <CardHeader className="pb-2"><CardDescription className="text-xs">{r.label}</CardDescription></CardHeader>
              <CardContent><p className="text-xl font-semibold">{fmtEUR(r.totalCents / 100)}</p><p className="text-xs text-stone-500">{r.count} zapisov</p></CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Zapisi odpada</CardTitle>
          <CardDescription className="text-xs">Odpad odšteje zalogo in se vodi po razlogih; pomota se lahko povrne (zaloga se vrne).</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalagam …</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-stone-500">Ni zapisov odpada v izbranem obdobju.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">Datum</th>
                    <th className="px-3 py-2 font-medium">Artikel</th>
                    <th className="px-3 py-2 font-medium text-right">Količina</th>
                    <th className="px-3 py-2 font-medium">Razlog</th>
                    <th className="px-3 py-2 font-medium text-right">Strošek</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    {canManage && <th className="px-3 py-2"><span className="sr-only">Dejanja</span></th>}
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
                      <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${wasteReasonBadgeCls(w.reason)}`}>{w.reasonLabel}</Badge></td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{fmtEUR(w.totalCost)}</td>
                      <td className="px-3 py-2">
                        {w.reversedAt ? <Badge variant="outline" className="text-xs border-stone-300 bg-stone-50 text-stone-600">Povrnjen</Badge> : <Badge variant="outline" className="text-xs border-emerald-300 bg-emerald-50 text-emerald-800">V veljavi</Badge>}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2 text-right">
                          {!w.reversedAt && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => void reverseRecord(w)}>Povrni</Button>
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
            <DialogTitle>Evidentiraj odpad</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="waste-item">Artikel</Label>
              <Select value={form.itemId} onValueChange={(v) => setForm({ ...form, itemId: v })}>
                <SelectTrigger id="waste-item"><SelectValue placeholder="Izberi artikel …" /></SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name} ({i.qty} {i.unit} na zalogi)</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="waste-qty">Količina {selected ? `(${selected.unit})` : ''}</Label>
                <Input id="waste-qty" inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="npr. 0,5" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="waste-reason">Razlog</Label>
                <Select value={form.reason} onValueChange={(v) => setForm({ ...form, reason: v })}>
                  <SelectTrigger id="waste-reason"><SelectValue placeholder="Izberi razlog …" /></SelectTrigger>
                  <SelectContent>
                    {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="waste-note">Opomba (neobvezno)</Label>
              <Input id="waste-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="npr. poškodovana embalaža" />
            </div>
            {selected && (
              <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 space-y-0.5">
                <p>Na zalogi: <strong>{selected.qty} {selected.unit}</strong> · cena: {fmtEUR(selected.cost)} / {selected.unit}</p>
                {Number.isFinite(selQty) && selQty > 0 && previewCost !== null && (
                  <p className={selOver ? 'text-red-700 font-medium' : ''}>
                    Ocenjeni strošek odpada: <strong>{fmtEUR(previewCost)}</strong>
                    {selOver ? ` — na zalogi je samo ${selected.qty} ${selected.unit}!` : ` · zaloga po odpadu: ${Math.round((selected.qty - selQty) * 1000) / 1000} ${selected.unit}`}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>Prekliči</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.itemId || !form.reason || !form.quantity}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Evidentiraj
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
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
const wlParty = (n: number): string => {
  const v = Math.max(0, Math.floor(n))
  if (v === 1) return '1 oseba'
  if (v === 2) return '2 osebi'
  if (v === 3 || v === 4) return `${v} osebe`
  return `${v} oseb`
}
const wlMin = (s: string, now: number): number => {
  const a = new Date(s).getTime()
  return Number.isFinite(a) && now > a ? Math.floor((now - a) / 60_000) : 0
}
const wlDur = (m: number): string => {
  const v = Math.max(0, Math.floor(m))
  return v < 60 ? `${v} min` : `${Math.floor(v / 60)} h ${v % 60} min`
}
const wlStatusBadge = (status: string): { label: string; cls: string } => ({
  waiting: { label: 'Čaka', cls: 'border-amber-300 bg-amber-50 text-amber-800' },
  notified: { label: 'Obveščen', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  seated: { label: 'Usajen', cls: 'border-green-300 bg-green-50 text-green-800' },
  left: { label: 'Odhod', cls: 'border-stone-300 bg-stone-50 text-stone-600' },
}[status] ?? { label: status, cls: 'border-stone-300 bg-stone-50 text-stone-700' })

/** Issue #1 (triage ⑤): čakalna lista — prijava → obvestilo → usaditev (zaklene mizo) / odhod + statistika. */
export function CakalnaListaTab({ canManage }: { canManage: boolean }) {
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
      setErr('Ime gosta je obvezno.')
      return
    }
    if (!Number.isInteger(party) || party < 1) {
      setErr('Število oseb mora biti celo število vsaj 1.')
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
      setOkMsg(`${form.guestName.trim()} dodan na čakalno listo.`)
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
      if (status === 'notified') setOkMsg(`${w.guestName} obveščen — miza se pripravlja.`)
      else if (status === 'seated') setOkMsg(`${w.guestName} usajen${d.entry.actualWaitMinutes !== null && d.entry.actualWaitMinutes !== undefined ? ` (čakal ${wlDur(d.entry.actualWaitMinutes)})` : ''}.`)
      else setOkMsg(`${w.guestName} — odhod zabeležen.`)
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
      setErr('Izberi mizo za usaditev.')
      return
    }
    await transition(seatFor, 'seated', seatTableId)
  }

  async function deleteEntry(w: WaitlistEntryT) {
    if (!window.confirm(`Izbrišem vnos za ${w.guestName}? Uporabi samo za pomotoma vnesene vnose.`)) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waitlist?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      setOkMsg(`Vnos za ${w.guestName} izbrisan.`)
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
          Gosti brez rezervacije: prijava → obvestilo, ko se miza pripravlja → usaditev (miza se samodejno zaklene) ali odhod.
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5 shrink-0">
            <Plus className="w-4 h-4" /> Nova prijava
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">Trenutno čaka</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-amber-700">{stats.waiting}</p><p className="text-xs text-stone-500">{wlParty(stats.waitingParty)} na listo</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">Obveščeni</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-emerald-700">{stats.notified}</p><p className="text-xs text-stone-500">miza se pripravlja</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">Usajeni danes</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-green-700">{stats.seated}</p><p className="text-xs text-stone-500">{stats.left} odhodov</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">Povprečno čakanje</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold">{wlDur(stats.avgActualWait)}</p><p className="text-xs text-stone-500">najdaljše {wlDur(stats.maxActualWait)}</p></CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Aktivna lista</CardTitle>
          <CardDescription className="text-xs">FIFO po prijavi; rdeče = presežen napovedani čas.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalagam …</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-stone-500">Ni gostov na čakalni listi.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Gost</th>
                    <th className="px-3 py-2 font-medium text-right">Čakanje</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    {canManage && <th className="px-3 py-2 text-right"><span className="sr-only">Dejanja</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {active.map((w, i) => {
                    const mins = wlMin(w.checkedInAt, nowMs)
                    const over = w.quotedWaitMinutes > 0 && mins > w.quotedWaitMinutes
                    const badge = wlStatusBadge(w.status)
                    return (
                      <tr key={w.id} className="border-b last:border-0 align-top">
                        <td className="px-3 py-2 text-xs text-stone-400 font-medium">{i + 1}.</td>
                        <td className="px-3 py-2">
                          <span className="font-medium">{w.guestName}</span>
                          <span className="block text-xs text-stone-500">{wlParty(w.partySize)}{w.guestPhone ? ` · ${w.guestPhone}` : ''}{w.preferredArea ? ` · ${w.preferredArea}` : ''}</span>
                          {(w.specialNeeds || w.notes) && (
                            <span className="block text-xs text-stone-500 max-w-64 truncate" title={w.specialNeeds || w.notes}>ℹ {w.specialNeeds || w.notes}</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${over ? 'text-red-700 font-semibold' : ''}`}>
                          {wlDur(mins)}
                          <span className="block text-xs text-stone-400">napoved {w.quotedWaitMinutes > 0 ? `≈ ${w.quotedWaitMinutes} min` : '—'}</span>
                        </td>
                        <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${badge.cls}`}>{badge.label}</Badge></td>
                        {canManage && (
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {w.status === 'waiting' && (
                                <Button variant="outline" size="sm" disabled={busy} onClick={() => void transition(w, 'notified')} title="Obvesti gosta">
                                  <Bell className="w-3.5 h-3.5" /> Obvesti
                                </Button>
                              )}
                              <Button size="sm" disabled={busy} onClick={() => { setSeatFor(w); setSeatTableId('') }} title="Usadi gosta">
                                <UserCheck className="w-3.5 h-3.5" /> Usadi
                              </Button>
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Zabeležim odhod ${w.guestName}?`)) void transition(w, 'left') }}>
                                Odšel
                              </Button>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deleteEntry(w)} aria-label={`Izbriši vnos ${w.guestName}`} title="Izbriši (samo pomota)">
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
            <CardTitle className="text-base">Zaključeni (danes)</CardTitle>
            <CardDescription className="text-xs">Usaditvi in odhodi iz zadnjih 24 h.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">Gost</th>
                    <th className="px-3 py-2 font-medium text-right">Čakal</th>
                    <th className="px-3 py-2 font-medium">Miza</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {finished.map((w) => {
                    const badge = wlStatusBadge(w.status)
                    return (
                      <tr key={w.id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{w.guestName} <span className="text-xs text-stone-400 font-normal">{wlParty(w.partySize)}</span></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{w.status === 'seated' ? wlDur(w.actualWaitMinutes) : '—'}</td>
                        <td className="px-3 py-2 text-xs text-stone-600">{w.tableNumber ? `Miza ${w.tableNumber}` : '—'}</td>
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
            <DialogTitle>Nova prijava na čakalno listo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-name">Ime gosta *</Label>
                <Input id="wl-name" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} placeholder="npr. Družina Novak" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-phone">Telefon (neobvezno)</Label>
                <Input id="wl-phone" value={form.guestPhone} onChange={(e) => setForm({ ...form, guestPhone: e.target.value })} placeholder="041 234 567" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-party">Število oseb</Label>
                <Input id="wl-party" inputMode="numeric" value={form.partySize} onChange={(e) => setForm({ ...form, partySize: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-quote">Napovedani čas (min)</Label>
                <Input id="wl-quote" inputMode="numeric" value={form.quotedWaitMinutes} onChange={(e) => setForm({ ...form, quotedWaitMinutes: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-area">Željeno območje (neobvezno)</Label>
              <Input id="wl-area" value={form.preferredArea} onChange={(e) => setForm({ ...form, preferredArea: e.target.value })} placeholder="npr. terasa, znotraj, bar" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-needs">Posebne potrebe (neobvezno)</Label>
              <Input id="wl-needs" value={form.specialNeeds} onChange={(e) => setForm({ ...form, specialNeeds: e.target.value })} placeholder="npr. otroški stol, dostop invalidskih vozičkov" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-notes">Opomba (neobvezno)</Label>
              <Input id="wl-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="npr. proslava, miza za 8" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>Prekliči</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.guestName.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Dodaj na listo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Usaditev */}
      <Dialog open={!!seatFor} onOpenChange={(o) => !o && setSeatFor(null)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Usadi {seatFor?.guestName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {seatFor && (
              <p className="text-sm text-stone-600">
                {wlParty(seatFor.partySize)} · čaka že <strong>{wlDur(wlMin(seatFor.checkedInAt, Date.now()))}</strong>
                {seatFor.preferredArea ? ` · želi: ${seatFor.preferredArea}` : ''}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="wl-table">Miza</Label>
              <Select value={seatTableId} onValueChange={setSeatTableId}>
                <SelectTrigger id="wl-table"><SelectValue placeholder="Izberi prosto mizo …" /></SelectTrigger>
                <SelectContent>
                  {freeTables.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.seats} mest · {t.zone}{t.status !== 'FREE' ? ` · ${t.status === 'RESERVED' ? 'rezervirana' : t.status === 'DIRTY' ? 'za čiščenje' : ''}` : ''})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {seatFor && freeTables.length === 0 && (
                <p className="text-xs text-red-600">Ni prostih miz — najprej sprosti/zaključi mizo v pregledu miz.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeatFor(null)}>Prekliči</Button>
            <Button onClick={() => void seatEntry()} disabled={busy || !seatTableId}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />} Usadi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
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
const tcTypeLabel: Record<string, string> = {
  regular: 'Navadno', overtime: 'Nadure', holiday: 'Praznik', sick: 'Bolniška', vacation: 'Dopust',
}
const tcStatusBadge: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  disputed: 'bg-red-100 text-red-800',
}
const tcStatusLabel: Record<string, string> = {
  active: 'V čakanju', approved: 'Potrjeno', disputed: 'Sporno',
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
      if (action === 'clock-in') setOkMsg('Prijava na izmeno zabeležena — ura teče.')
      else if (action === 'break-start') setOkMsg('Odmor začet.')
      else if (action === 'break-end') setOkMsg('Odmor zaključen.')
      else if (action === 'clock-out' && d.summary) setOkMsg(`Odjava zabeležena — skupaj ${d.summary.label}${d.summary.totalPay > 0 ? ` (${tcPay(d.summary.totalPay)})` : ''}.`)
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
      setOkMsg(status === 'approved' ? 'Vnos potrjen.' : 'Vnos označen kot sporen.')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitManual() {
    if (!manual.employeeId) { setErr('Izberi zaposlenega.'); return }
    if (!manual.clockIn || !manual.clockOut) { setErr('Časa prijave in odjave sta obvezna.'); return }
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
      setOkMsg('Ročni vnos dodan (status: v čakanju potrditve).')
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
          <CardTitle className="text-base flex items-center gap-2"><Timer className="w-4 h-4" /> {activeEntry ? 'Izmena v teku' : 'Moj delovni čas'}</CardTitle>
          <CardDescription>{activeEntry ? `Prijava ob ${tcTime(activeEntry.clockIn)}${activeEntry.payRate > 0 ? ` · ura ${tcPay(activeEntry.payRate)}` : ''}` : 'Prijava in odjava izmene — ure so osnova za napitnine po urah in plačilo.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeEntry ? (
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-3xl font-bold tabular-nums">{tcDur(liveMin)}</div>
              {onBreak ? (
                <Badge className="bg-amber-100 text-amber-800">☕ Na odmoru (od {new Date(activeEntry.breakStart!).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })})</Badge>
              ) : (
                <Badge className="bg-emerald-100 text-emerald-800">V teku</Badge>
              )}
              <div className="flex gap-2 ml-auto flex-wrap">
                {!onBreak ? (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-start')}><Coffee className="w-4 h-4 mr-1" /> Odmor</Button>
                ) : (
                  <Button variant="outline" disabled={busy} onClick={() => void act('break-end')}><Coffee className="w-4 h-4 mr-1" /> Konec odmora</Button>
                )}
                <Button className="bg-red-700 hover:bg-red-800" disabled={busy} onClick={() => void act('clock-out')}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4 mr-1" />} Odjava
                </Button>
              </div>
            </div>
          ) : (
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={() => void act('clock-in')}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4 mr-1" />} Prijava na izmeno
            </Button>
          )}
          {myStats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-stone-100">
              <div><p className="text-xs text-stone-500">Zadnjih 30 dni</p><p className="font-bold">{tcDur(myStats.totalMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">Potrjeno</p><p className="font-bold">{tcDur(myStats.approvedMinutes)}</p></div>
              <div><p className="text-xs text-stone-500">Vnosov</p><p className="font-bold">{mine.length}</p></div>
              <div><p className="text-xs text-stone-500">Status</p><p className="font-bold">{activeEntry ? 'Na izmeni' : 'Izven izmene'}</p></div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Moja zgodovina */}
      <Card>
        <CardHeader><CardTitle className="text-base">Moja zgodovina (30 dni)</CardTitle></CardHeader>
        <CardContent>
          {mine.length === 0 && <p className="text-sm text-stone-500">Ni zapisov — prijavi se na izmeno.</p>}
          {mine.length > 0 && (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                  <th className="py-2 pr-3">Prijava</th><th className="py-2 pr-3">Odjava</th><th className="py-2 pr-3">Odmor</th>
                  <th className="py-2 pr-3">Skupaj</th><th className="py-2 pr-3">Plačilo</th><th className="py-2 pr-3">Tip</th><th className="py-2">Status</th>
                </tr></thead>
                <tbody>
                  {mine.map((e) => (
                    <tr key={e.id} className="border-b border-stone-100">
                      <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">teče</span>}</td>
                      <td className="py-2 pr-3">{e.breakMinutes > 0 ? tcDur(e.breakMinutes) : '—'}</td>
                      <td className="py-2 pr-3 font-semibold">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                      <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                      <td className="py-2 pr-3"><Badge className={tcTypeBadge[e.type] || 'bg-stone-100 text-stone-700'}>{tcTypeLabel[e.type] || e.type}</Badge></td>
                      <td className="py-2"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusLabel[e.status] || e.status}</Badge></td>
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
              <CardTitle className="text-base flex items-center gap-2"><UserCheck className="w-4 h-4" /> Ekipa — vpogled in potrditev</CardTitle>
              <CardDescription>Potrdi/sporen označi vnose zaposlenih; dodaj ročni vnos (popravek zgrešene ure).</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={teamDays} onValueChange={setTeamDays}>
                <SelectTrigger className="w-32 h-8 text-xs" aria-label="Obdobje"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Danes</SelectItem>
                  <SelectItem value="7">7 dni</SelectItem>
                  <SelectItem value="14">14 dni</SelectItem>
                  <SelectItem value="31">31 dni</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setManualOpen(true)}><Plus className="w-4 h-4 mr-1" /> Ročni vnos</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">Skupaj (obdobje)</p><p className="text-lg font-bold">{tcDur(team.stats.totalMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">Potrjeno</p><p className="text-lg font-bold">{tcDur(team.stats.approvedMinutes)}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">V čakanju potrditve</p><p className="text-lg font-bold">{team.stats.activeCount}</p></div>
              <div className="rounded-lg border border-stone-200 p-3"><p className="text-xs text-stone-500">Trenutno na izmeni</p><p className="text-lg font-bold">{team.activeNow.length}</p></div>
            </div>
            {team.activeNow.length > 0 && (
              <div className="text-sm text-stone-600">
                <span className="font-semibold">Na izmeni: </span>
                {team.activeNow.map((a) => `${a.employeeName}${a.breakStart ? ' ☕' : ''}`).join(', ')}
              </div>
            )}
            {team.entries.length === 0 && <p className="text-sm text-stone-500">Ni vnosov v izbranem obdobju.</p>}
            {team.entries.length > 0 && (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                    <th className="py-2 pr-3">Zaposleni</th><th className="py-2 pr-3">Prijava</th><th className="py-2 pr-3">Odjava</th>
                    <th className="py-2 pr-3">Skupaj</th><th className="py-2 pr-3">Plačilo</th><th className="py-2 pr-3">Status</th><th className="py-2">Dejanja</th>
                  </tr></thead>
                  <tbody>
                    {team.entries.map((e) => (
                      <tr key={e.id} className="border-b border-stone-100">
                        <td className="py-2 pr-3 font-medium">{e.employeeName}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{tcTime(e.clockIn)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{e.clockOut ? tcTime(e.clockOut) : <span className="text-emerald-700 font-semibold">teče</span>}</td>
                        <td className="py-2 pr-3">{e.clockOut ? tcDur(e.totalMinutes) : '—'}</td>
                        <td className="py-2 pr-3">{e.totalPay > 0 ? tcPay(e.totalPay) : '—'}</td>
                        <td className="py-2 pr-3"><Badge className={tcStatusBadge[e.status] || 'bg-stone-100 text-stone-700'}>{tcStatusLabel[e.status] || e.status}</Badge></td>
                        <td className="py-2">
                          {e.status !== 'approved' && e.clockOut && (
                            <Button size="sm" variant="outline" className="h-7 mr-1" disabled={busy} onClick={() => void review(e.id, 'approved')} title="Potrdi vnos"><CheckCircle2 className="w-3.5 h-3.5" /><span className="sr-only">Potrdi</span></Button>
                          )}
                          {e.status !== 'disputed' && (
                            <Button size="sm" variant="outline" className="h-7 text-red-700" disabled={busy} onClick={() => void review(e.id, 'disputed')} title="Označi sporno"><XCircle className="w-3.5 h-3.5" /><span className="sr-only">Označi sporno</span></Button>
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
          <DialogHeader><DialogTitle>Ročni vnos delovnega časa</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tc-employee">Zaposleni</Label>
              <Select value={manual.employeeId} onValueChange={(v) => setManual((m) => ({ ...m, employeeId: v }))}>
                <SelectTrigger id="tc-employee"><SelectValue placeholder="Izberi zaposlenega …" /></SelectTrigger>
                <SelectContent>
                  {(team?.employees || []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name} ({e.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-in">Prijava</Label>
                <Input id="tc-in" type="datetime-local" value={manual.clockIn} onChange={(e) => setManual((m) => ({ ...m, clockIn: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-out">Odjava</Label>
                <Input id="tc-out" type="datetime-local" value={manual.clockOut} onChange={(e) => setManual((m) => ({ ...m, clockOut: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="tc-break">Odmor (min)</Label>
                <Input id="tc-break" type="number" min="0" value={manual.breakMinutes} onChange={(e) => setManual((m) => ({ ...m, breakMinutes: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-type">Tip</Label>
                <Select value={manual.type} onValueChange={(v) => setManual((m) => ({ ...m, type: v }))}>
                  <SelectTrigger id="tc-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="regular">Navadno</SelectItem>
                    <SelectItem value="overtime">Nadure</SelectItem>
                    <SelectItem value="holiday">Praznik</SelectItem>
                    <SelectItem value="sick">Bolniška</SelectItem>
                    <SelectItem value="vacation">Dopust</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tc-note">Opomba</Label>
              <Input id="tc-note" value={manual.note} onChange={(e) => setManual((m) => ({ ...m, note: e.target.value }))} placeholder="npr. pozabil prijavit" />
            </div>
            <p className="text-xs text-stone-500">Vnos se ustvari s statusom »v čakanju« — potrdi ga v tabeli zgoraj (potek: do 31 dni nazaj, ne v prihodnost).</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>Prekliči</Button>
            <Button onClick={() => void submitManual()} disabled={busy || !manual.employeeId || !manual.clockIn || !manual.clockOut}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Dodaj vnos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalaganje …</p>}
      {busy && !loading && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Obdelava …</p>}
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
      setMsg('Odpiralni čas shranjen.')
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addSpecial() {
    setBusy(true); setMsg('')
    try {
      await api('/api/opening-hours/special', { method: 'POST', body: JSON.stringify(sp) })
      setSpOpen(false)
      setSp({ date: '', isClosed: true, openTime: '', closeTime: '', note: '' })
      setMsg('Poseben dan dodan.')
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function deleteSpecial(id: string) {
    if (!confirm('Izbrišem posebni dan?')) return
    setBusy(true)
    try {
      await api(`/api/opening-hours/special?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setMsg('Poseben dan izbrisan.')
      await load()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function addHolidays() {
    if (!data?.holidays?.length) return
    if (!confirm(`Dodam ${data.holidays.length} slovenskih praznikov za ${data.holidaysYear} (zaprti dnevi)? Obstojeci datumi se preskocijo.`)) return
    setBusy(true); setMsg('')
    try {
      const res = await api<{ added: number; skipped: string[] }>('/api/opening-hours/special', {
        method: 'POST', body: JSON.stringify({ holidays: data.holidays.map((h) => ({ date: h.date, name: h.name })) }),
      })
      setMsg(`Prazniki: dodanih ${res.added}, obstoječih preskočenih ${res.skipped.length}.`)
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
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalaganje statusa …</p>
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
                <Badge variant="outline" className="ml-auto shrink-0">Privzeti urnik organizacije — lokacija nima svojega</Badge>
              )}
            </div>
          ) : (
            <p className="text-sm text-stone-500">Status ni na voljo.</p>
          )}
        </CardContent>
      </Card>

      {/* tedenski urnik */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-1.5"><CalendarClock className="w-4 h-4 text-emerald-700" /> Tedenski urnik</CardTitle>
            {canManage && <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void save()} disabled={busy}><CheckCircle2 className="w-3.5 h-3.5" /> Shrani urnik</Button>}
          </div>
          <CardDescription>Časi so lokalni (24-urni). Zapiralni čas pred odpiralnim pomeni delo čez polnoč. Odmor je izbirzen.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {edit.map((r) => (
            <div key={r.dayOfWeek} className="rounded-lg border border-stone-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-sm font-medium text-stone-700 shrink-0">{DAY_NAMES_SL[r.dayOfWeek]}</span>
                <Switch checked={!r.isClosed} onCheckedChange={(v) => setRow(r.dayOfWeek, v ? { isClosed: false, openTime: r.openTime || '08:00', closeTime: r.closeTime || '22:00' } : { isClosed: true, breakStart: '', breakEnd: '' })} disabled={!canManage} aria-label={`${DAY_NAMES_SL[r.dayOfWeek]}: odprto`} />
                {r.isClosed ? (
                  <Badge variant="outline" className="text-red-600 border-red-200">Zaprto</Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input type="time" className="w-28 h-8" value={r.openTime} onChange={(e) => setRow(r.dayOfWeek, { openTime: e.target.value })} disabled={!canManage} aria-label={`${DAY_NAMES_SL[r.dayOfWeek]}: odpre se`} />
                    <span className="text-stone-400 text-sm">–</span>
                    <Input type="time" className="w-28 h-8" value={r.closeTime} onChange={(e) => setRow(r.dayOfWeek, { closeTime: e.target.value })} disabled={!canManage} aria-label={`${DAY_NAMES_SL[r.dayOfWeek]}: zapre se`} />
                    {canManage && (
                      <Button size="sm" variant={showBreak[r.dayOfWeek] ? 'secondary' : 'outline'} className="h-8 px-2 text-xs" onClick={() => setShowBreak((b) => b.map((v, i) => (i === r.dayOfWeek ? !v : v)))}>
                        <Coffee className="w-3.5 h-3.5" /> Odmor
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {!r.isClosed && showBreak[r.dayOfWeek] && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pl-1 sm:pl-28">
                  <span className="text-xs text-stone-500 w-auto">Odmor:</span>
                  <Input type="time" className="w-28 h-8" value={r.breakStart} onChange={(e) => setRow(r.dayOfWeek, { breakStart: e.target.value })} disabled={!canManage} aria-label={`${DAY_NAMES_SL[r.dayOfWeek]}: odmor od`} />
                  <span className="text-stone-400 text-sm">–</span>
                  <Input type="time" className="w-28 h-8" value={r.breakEnd} onChange={(e) => setRow(r.dayOfWeek, { breakEnd: e.target.value })} disabled={!canManage} aria-label={`${DAY_NAMES_SL[r.dayOfWeek]}: odmor do`} />
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
              <CardTitle className="text-base flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-emerald-700" /> Posebni dnevi in prazniki</CardTitle>
              <CardDescription>Posebni dan prevlada nad tedenskim urnikom (zaprt ali drugačen čas).</CardDescription>
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1" onClick={() => void addHolidays()} disabled={busy || !data?.holidays?.length}>
                  <Plus className="w-3.5 h-3.5" /> Slovenski prazniki {data?.holidaysYear}
                </Button>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setSpOpen(true)} disabled={busy}>
                  <Plus className="w-3.5 h-3.5" /> Poseben dan
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {(data?.specialDays?.length ?? 0) === 0 ? (
            <p className="text-sm text-stone-500">Ni posebnih dni. Rezervacije sledijo tedenskemu urniku.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {data!.specialDays.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800">{fmtDateSL(s.date)}</p>
                    <p className="text-xs text-stone-500">
                      {s.isClosed ? 'Zaprto cel dan' : `Odprto ${s.openTime}–${s.closeTime}`}
                      {s.note ? ` · ${s.note}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant={s.isClosed ? 'destructive' : 'outline'}>{s.isClosed ? 'Zaprto' : 'Poseben urnik'}</Badge>
                    {canManage && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-red-600 border-red-200 hover:bg-red-50" disabled={busy} onClick={() => void deleteSpecial(s.id)}>
                        <Trash2 className="w-3.5 h-3.5" /><span className="sr-only">Izbriši poseben dan {s.date}</span>
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
          <DialogHeader><DialogTitle>Poseben dan / praznik</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="sp-date">Datum</Label>
              <Input id="sp-date" type="date" value={sp.date} onChange={(e) => setSp({ ...sp, date: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
              <Label htmlFor="sp-closed" className="font-normal">Zaprto cel dan</Label>
              <Switch id="sp-closed" checked={sp.isClosed} onCheckedChange={(v) => setSp({ ...sp, isClosed: v })} />
            </div>
            {!sp.isClosed && (
              <div className="flex items-center gap-2">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-open">Odpre se</Label>
                  <Input id="sp-open" type="time" value={sp.openTime} onChange={(e) => setSp({ ...sp, openTime: e.target.value })} />
                </div>
                <div className="space-y-1 flex-1">
                  <Label htmlFor="sp-close">Zapre se</Label>
                  <Input id="sp-close" type="time" value={sp.closeTime} onChange={(e) => setSp({ ...sp, closeTime: e.target.value })} />
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="sp-note">Opomba (razlog)</Label>
              <Input id="sp-note" value={sp.note} onChange={(e) => setSp({ ...sp, note: e.target.value })} placeholder="npr. Praznik dela, zaprt zaradi dogodka" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpOpen(false)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={() => void addSpecial()} disabled={busy || !sp.date}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Dodaj
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && !data && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> Nalaganje …</p>}
    </div>
  )
}
