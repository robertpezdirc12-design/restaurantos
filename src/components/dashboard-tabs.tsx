'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus } from 'lucide-react'

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
