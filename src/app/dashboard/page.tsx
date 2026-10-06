'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getUser } from '@/lib/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, Users, Settings,
  LogOut, Plus, Minus, Loader2, ReceiptText, RefreshCw, Banknote,
} from 'lucide-react'

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; employees: number; menuItems: number }
interface TableT { id: string; name: string; zone: string; seats: number; status: string; activeOrder: { id: string; total: number; guests: number; itemCount: number } | null }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null }
interface OrderT { id: string; type: string; status: string; guests: number; total: number; createdAt: string; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { name: string } | null; items: OrderItemT[] }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean }

const statusColors: Record<string, string> = {
  FREE: 'bg-emerald-600 text-white hover:bg-emerald-700',
  OCCUPIED: 'bg-amber-600 text-white hover:bg-amber-700',
  RESERVED: 'bg-stone-400 text-white hover:bg-stone-500',
  DIRTY: 'bg-stone-600 text-white hover:bg-stone-700',
  OPEN: 'bg-amber-600 text-white', SENT: 'bg-orange-600 text-white',
  PREPARED: 'bg-emerald-600 text-white', PAID: 'bg-stone-500 text-white',
  CANCELLED: 'bg-red-600 text-white',
  PENDING: 'bg-amber-600 text-white', PREPARING: 'bg-orange-600 text-white', READY: 'bg-emerald-600 text-white',
}
const statusLabels: Record<string, string> = {
  FREE: 'Prosta', OCCUPIED: 'Zasedena', RESERVED: 'Rezervirana', DIRTY: 'Za pospravit',
  OPEN: 'Odprto', SENT: 'Poslano v kuhinjo', PREPARED: 'Pripravljeno', PAID: 'Plačano', CANCELLED: 'Preklicano',
  PENDING: 'V vrsti', PREPARING: 'V pripravi', READY: 'Pripravljeno',
}

export default function DashboardPage() {
  const router = useRouter()
  const user = getUser()
  const [stats, setStats] = useState<Stats | null>(null)
  const [tables, setTables] = useState<TableT[]>([])
  const [orders, setOrders] = useState<OrderT[]>([])
  const [kitchen, setKitchen] = useState<OrderT[]>([])
  const [menu, setMenu] = useState<MenuT[]>([])
  const [categories, setCategories] = useState<CategoryT[]>([])
  const [employees, setEmployees] = useState<EmployeeT[]>([])
  const [newOrderTable, setNewOrderTable] = useState<TableT | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const [payingOrder, setPayingOrder] = useState<OrderT | null>(null)
  const [invoice, setInvoice] = useState<{ eor: string; invoiceNumber: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const [d, t, o, k, m, e] = await Promise.all([
        api<{ stats: Stats }>('/api/dashboard'),
        api<{ tables: TableT[] }>('/api/tables'),
        api<{ orders: OrderT[] }>('/api/orders'),
        api<{ queue: OrderT[] }>('/api/kitchen'),
        api<{ items: MenuT[]; categories: CategoryT[] }>('/api/menus'),
        api<{ employees: EmployeeT[] }>('/api/employees'),
      ])
      setStats(d.stats); setTables(t.tables); setOrders(o.orders)
      setKitchen(k.queue); setMenu(m.items); setCategories(m.categories); setEmployees(e.employees)
    } catch { /* 401 → redirect handled in api() */ } finally { setRefreshing(false) }
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 15000)
    return () => clearInterval(iv)
  }, [load])

  function logout() {
    localStorage.clear(); router.push('/')
  }

  async function createOrder() {
    if (!newOrderTable) return
    setSending(true)
    try {
      const items = Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
      if (items.length === 0) return
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: newOrderTable.id, items, guests: 2 }) })
      setCart({}); setNewOrderTable(null); await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  async function setItemStatus(itemId: string, status: string) {
    await api('/api/kitchen', { method: 'PATCH', body: JSON.stringify({ itemId, status }) })
    await load()
  }

  async function payOrder() {
    if (!payingOrder) return
    setSending(true)
    try {
      const d = await api<{ invoice: { eor: string; invoiceNumber: string } }>('/api/furs', { method: 'POST', body: JSON.stringify({ orderId: payingOrder.id }) })
      setInvoice(d.invoice); setPayingOrder(null); await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  async function toggleAvailable(m: MenuT) {
    await api(`/api/menus/${m.id}`, { method: 'PATCH', body: JSON.stringify({ available: !m.available }) })
    await load()
  }

  const cartTotal = Object.entries(cart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)
  const menuByCat = categories.map((c) => ({ cat: c, items: menu.filter((m) => m.categoryId === c.id) }))
    .concat({ cat: { id: 'ostalo', name: 'Ostalo' }, items: menu.filter((m) => !m.categoryId) })
    .filter((g) => g.items.length > 0)

  return (
    <main className="min-h-screen flex flex-col bg-stone-100">
      <header className="sticky top-0 z-20 bg-white border-b border-stone-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <Utensils className="w-4 h-4" />
            </div>
            <span className="font-bold truncate">RestavrantOS</span>
            <Badge variant="outline" className="hidden sm:inline-flex shrink-0">1.26.0</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={load} aria-label="Osveži">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <span className="text-sm text-stone-600 hidden sm:block truncate max-w-40">{user?.name}</span>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="Odjava"><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Tabs defaultValue="pregled" className="space-y-6">
          <TabsList className="w-full justify-start overflow-x-auto h-auto flex-nowrap bg-white border border-stone-200 p-1">
            {[
              ['pregled', 'Pregled', LayoutDashboard], ['mize', 'Mize', Utensils], ['narocila', 'Naročila', ClipboardList],
              ['kuhinja', 'Kuhinja', ChefHat], ['meni', 'Meni', BookOpen], ['zaposleni', 'Zaposleni', Users], ['nastavitve', 'Nastavitve', Settings],
            ].map(([v, label, Icon]) => (
              <TabsTrigger key={v as string} value={v as string} className="gap-1.5 data-[state=active]:bg-emerald-700 data-[state=active]:text-white whitespace-nowrap">
                {Icon && <Icon className="w-4 h-4" />} {label as string}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="pregled" className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                ['Aktivna naročila', stats?.activeOrders, ClipboardList], ['Zasedene mize', stats?.openTables, Utensils],
                ['Današnji promet', stats ? fmtEUR(stats.todayRevenue) : undefined, Banknote], ['Današnja naročila', stats?.todayOrders, ReceiptText],
              ].map(([label, value, Icon], i) => (
                <Card key={i}>
                  <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5">{Icon && <Icon className="w-4 h-4" />} {label as string}</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{value ?? '—'}</p></CardContent>
                </Card>
              ))}
            </div>
            <Card>
              <CardHeader><CardTitle className="text-base">Aktivna naročila</CardTitle></CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {orders.slice(0, 6).map((o) => (
                    <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{o.table?.name || o.type}</p>
                        <p className="text-xs text-stone-500">{o.items.length} artiklov · {o.employee?.name || '—'}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold">{fmtEUR(o.total)}</p>
                        <Badge className={`mt-1 ${statusColors[o.status]}`}>{statusLabels[o.status]}</Badge>
                      </div>
                    </div>
                  ))}
                  {orders.length === 0 && <p className="text-sm text-stone-500">Ni aktivnih naročil.</p>}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="mize" className="space-y-6">
            {['Glavna dvorana', 'Bar', 'Terasa'].map((zone) => {
              const zt = tables.filter((t) => t.zone === zone)
              if (zt.length === 0) return null
              return (
                <section key={zone} className="space-y-3">
                  <h2 className="font-semibold text-stone-700">{zone}</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {zt.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { if (!t.activeOrder) { setCart({}); setNewOrderTable(t) } else { const o = orders.find((x) => x.id === t.activeOrder!.id); if (o) setPayingOrder(o) } }}
                        className={`rounded-xl p-4 text-left shadow transition ${statusColors[t.status]} min-h-20`}
                      >
                        <p className="font-bold text-lg">{t.name}</p>
                        <p className="text-xs opacity-90">{t.seats} mest</p>
                        {t.activeOrder && <p className="text-xs mt-1 font-semibold">{fmtEUR(t.activeOrder.total)}</p>}
                        <p className="text-[11px] mt-1 opacity-80">{t.activeOrder ? statusLabels.OCCUPIED : statusLabels[t.status]}</p>
                      </button>
                    ))}
                  </div>
                </section>
              )
            })}
          </TabsContent>

          <TabsContent value="narocila">
            <Card>
              <CardHeader><CardTitle className="text-base">Vsa aktivna naročila</CardTitle></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                {orders.map((o) => (
                  <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">{o.table?.name || o.type} · {o.guests} osebi</p>
                      <Badge className={statusColors[o.status]}>{statusLabels[o.status]}</Badge>
                    </div>
                    <ScrollArea className="max-h-32">
                      <ul className="text-sm space-y-1">{o.items.map((it) => <li key={it.id} className="flex justify-between"><span>{it.qty}× {it.name}</span><span>{fmtEUR(it.qty * it.unitPrice)}</span></li>)}</ul>
                    </ScrollArea>
                    <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                      <p className="font-bold">{fmtEUR(o.total)}</p>
                      {o.status !== 'PAID' && (
                        <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setPayingOrder(o)}>
                          <Banknote className="w-3.5 h-3.5" /> Plačilo + FURS
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {orders.length === 0 && <p className="text-sm text-stone-500">Ni aktivnih naročil.</p>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="kuhinja" className="space-y-4">
            {kitchen.map((o) => (
              <Card key={o.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {o.table?.name || o.type} <span className="text-xs font-normal text-stone-500">{new Date(o.createdAt).toLocaleTimeString('sl-SI')}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {o.items.map((it) => (
                    <div key={it.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{it.qty}× {it.name} <Badge variant="outline" className="ml-1">{it.station === 'BAR' ? 'Bar' : 'Kuhinja'}</Badge></p>
                        {it.note && <p className="text-xs text-stone-500">ℹ {it.note}</p>}
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {it.status === 'PENDING' && <Button size="sm" variant="outline" onClick={() => setItemStatus(it.id, 'PREPARING')}>Začni</Button>}
                        {(it.status === 'PENDING' || it.status === 'PREPARING') && <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setItemStatus(it.id, 'READY')}>Pripravljeno</Button>}
                        {it.status === 'READY' && <Badge className={statusColors.READY}>{statusLabels.READY}</Badge>}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
            {kitchen.length === 0 && <p className="text-sm text-stone-500">Kuhinjska vrsta je prazna. 🎉</p>}
          </TabsContent>

          <TabsContent value="meni" className="space-y-4">
            {menuByCat.map((g) => (
              <section key={g.cat.id} className="space-y-2">
                <h2 className="font-semibold text-stone-700">{g.cat.name}</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((m) => (
                    <div key={m.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0"><p className="font-medium truncate">{m.name}</p><p className="text-sm text-stone-500">{fmtEUR(m.price)} · {m.station === 'BAR' ? 'Bar' : 'Kuhinja'}</p></div>
                      <Button size="sm" variant={m.available ? 'outline' : 'secondary'} onClick={() => toggleAvailable(m)}>{m.available ? 'Na zalogi' : 'Ni na voljo'}</Button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </TabsContent>

          <TabsContent value="zaposleni">
            <Card><CardHeader><CardTitle className="text-base">Zaposleni</CardTitle></CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {employees.map((e) => (
                  <div key={e.id} className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 bg-white">
                    <div><p className="font-medium">{e.name}</p><p className="text-xs text-stone-500">{e.email}</p></div>
                    <Badge variant="outline">{e.role}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="nastavitve">
            <Card><CardHeader><CardTitle className="text-base">O sistemu</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1.5 text-stone-600">
                <p>RestavrantOS — rekonstrukcija 1.26.0 (iz Vercel deploymenta dpl_DLuMxkW…)</p>
                <p>Moduli: blagajna, naročila, mize, kuhinja (KDS), meni, izmene, FURS (simulacija), HACCP, zaloge, zvestoba, rezervacije, poročila.</p>
                <p>Baza: Neon PostgreSQL (podedovane env spremenljivke ostajajo na Vercel projektu).</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={!!newOrderTable} onOpenChange={(v) => !v && setNewOrderTable(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Novo naročilo — {newOrderTable?.name}</DialogTitle></DialogHeader>
          <ScrollArea className="max-h-[50vh] pr-2">
            <div className="space-y-4">
              {menuByCat.map((g) => (
                <div key={g.cat.id}>
                  <p className="text-xs font-semibold uppercase text-stone-400 mb-1.5">{g.cat.name}</p>
                  <div className="space-y-1.5">
                    {g.items.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2">
                        <span className="text-sm min-w-0 truncate">{m.name} · <b>{fmtEUR(m.price)}</b></span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label="Manj"><Minus className="w-3 h-3" /></Button>
                          <span className="w-6 text-center text-sm font-semibold">{cart[m.id] || 0}</span>
                          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: (c[m.id] || 0) + 1 }))} aria-label="Več"><Plus className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="items-center gap-2 sm:gap-0">
            <span className="mr-auto font-bold">Skupaj: {fmtEUR(cartTotal)}</span>
            <Button variant="outline" onClick={() => setNewOrderTable(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending || cartTotal === 0} onClick={createOrder}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Oddaj naročilo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payingOrder} onOpenChange={(v) => { if (!v) { setPayingOrder(null); setInvoice(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Plačilo {payingOrder?.table?.name || ''}</DialogTitle></DialogHeader>
          {payingOrder && (
            <div className="space-y-2 text-sm">
              <ul className="space-y-1">{payingOrder.items.map((it) => <li key={it.id} className="flex justify-between"><span>{it.qty}× {it.name}</span><span>{fmtEUR(it.qty * it.unitPrice)}</span></li>)}</ul>
              <div className="flex justify-between font-bold text-base pt-2 border-t border-stone-100"><span>SKUPAJ</span><span>{fmtEUR(payingOrder.total)}</span></div>
            </div>
          )}
          {invoice && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm space-y-0.5">
              <p className="font-semibold text-emerald-800">✅ Račun izdan (FURS simulacija)</p>
              <p className="text-emerald-700">Št.: {invoice.invoiceNumber}</p>
              <p className="text-emerald-700 break-all">EOR: {invoice.eor}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPayingOrder(null); setInvoice(null) }}>Zapri</Button>
            {!invoice && <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending} onClick={payOrder}>{sending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Izdaj račun'}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <footer className="mt-auto bg-white border-t border-stone-200 py-3 text-center text-xs text-stone-400 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        RestavrantOS rekonstrukcija 1.26.0 · FURS simulacija · EUR · prijava: admin@restaurantos.app / 1234
      </footer>
    </main>
  )
}
