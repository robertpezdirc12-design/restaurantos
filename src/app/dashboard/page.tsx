'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getUser } from '@/lib/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, Users, Settings,
  LogOut, Plus, Minus, Loader2, ReceiptText, RefreshCw, Banknote, CalendarDays,
  ShieldCheck, UserCog, Search, Star,
} from 'lucide-react'
import { CommandPalette, PaletteButton } from '@/components/command-palette'
import {
  InventoryTab, ShiftsTab, HaccpTab, ExpensesTab, LoyaltyTab, FeedbackTab, JobsCard,
  type InventoryT, type ShiftT, type FinancialT, type HaccpT, type ExpenseT, type LoyaltyT,
  type SupplierT, type RecipeT, type FeedbackT, type JobT,
} from '@/components/dashboard-tabs'
import { PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, Briefcase, MapPin, Plug, Webhook, Bug } from 'lucide-react'

interface LocationStatT { id: string; name: string; tables: number; employees: number; orders: number; todayOrders: number; todayRevenue: number }
interface IntegrationT { id: string; name: string; type: string; provider: string; syncEnabled: boolean; connectionStatus: string; lastSyncAt?: string | null }
interface WebhookT { id: string; name: string; url: string; events: string[]; isActive: boolean; lastTriggered?: string | null; failureCount: number }
interface ErrLogT { id: string; employeeId?: string | null; action: string; entity: string; entityId?: string | null; data?: string | null; createdAt: string }

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; employees: number; menuItems: number }
interface TableT { id: string; name: string; zone: string; seats: number; status: string; activeOrder: { id: string; total: number; guests: number; itemCount: number } | null }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null }
interface OrderT { id: string; type: string; status: string; guests: number; total: number; createdAt: string; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { name: string } | null; items: OrderItemT[] }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean; phone?: string | null; permissionOverrides: string[] }
interface ReservationT { id: string; guestName: string; phone?: string | null; guests: number; reservedAt: string; status: string; note?: string | null }
interface ReceiptT { id: string; invoiceNumber: string; eor: string; zoi: string; fiscalVerified: boolean; fiscalStatus: string; total: number; paymentMethod: string; orderId?: string | null; createdAt: string; tableName?: string | null; orderNumber?: number | null }

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

/* EMPLOYEE CONTROL CENTER (R265) — kanonska dovoljenja (R263/R264) */
const PERMISSION_LABELS: Record<string, string> = {
  'orders.create': 'Nove naročila',
  'orders.pay': 'Plačila + računi',
  'kitchen.update': 'Kuhinja — status postavk',
  'reservations.manage': 'Rezervacije',
  'menu.manage': 'Urejanje menija',
  'inventory.manage': 'Zaloge',
  'reports.view': 'Poročila',
  'employees.manage': 'Upravljanje zaposlenih',
  'settings.manage': 'Nastavitve',
  'furs.issue': 'Izdaja FURS računov',
}
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrator', MANAGER: 'Vodja', WAITER: 'Natakar', KITCHEN: 'Kuhinja',
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
  const [reservations, setReservations] = useState<ReservationT[]>([])
  const [receipts, setReceipts] = useState<ReceiptT[]>([])
  const [inventory, setInventory] = useState<InventoryT[]>([])
  const [shifts, setShifts] = useState<ShiftT[]>([])
  const [financial, setFinancial] = useState<FinancialT | null>(null)
  const [haccp, setHaccp] = useState<HaccpT[]>([])
  const [expenses, setExpenses] = useState<ExpenseT[]>([])
  const [loyalty, setLoyalty] = useState<LoyaltyT[]>([])
  const [suppliers, setSuppliers] = useState<SupplierT[]>([])
  const [recipes, setRecipes] = useState<RecipeT[]>([])
  const [jobs, setJobs] = useState<JobT[]>([])
  const [feedback, setFeedback] = useState<FeedbackT[]>([])
  const [locStats, setLocStats] = useState<LocationStatT[]>([])
  const [integrations, setIntegrations] = useState<IntegrationT[]>([])
  const [webhooks, setWebhooks] = useState<WebhookT[]>([])
  const [errLog, setErrLog] = useState<ErrLogT[]>([])
  const [newOrderTable, setNewOrderTable] = useState<TableT | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const [payingOrder, setPayingOrder] = useState<OrderT | null>(null)
  const [invoice, setInvoice] = useState<{ eor: string; invoiceNumber: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeTab, setActiveTab] = useState('pregled')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  // Employee Control Center stanje
  const [editEmployee, setEditEmployee] = useState<EmployeeT | null>(null)
  const [empPerms, setEmpPerms] = useState<string[]>([])
  const [empRole, setEmpRole] = useState('WAITER')
  const [empActive, setEmpActive] = useState(true)
  const [empPin, setEmpPin] = useState('')
  const [empSaving, setEmpSaving] = useState(false)
  const [empNotice, setEmpNotice] = useState('')
  const [confirmPinReset, setConfirmPinReset] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)

  // Rezervacije — nov vnos
  const [newRes, setNewRes] = useState<{ guestName: string; phone: string; guests: number; reservedAt: string; note: string } | null>(null)

  const canManage = user?.role === 'ADMIN' || user?.role === 'MANAGER'

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const [d, t, o, k, m, e, r, rec, inv, sh, fin, haccpRows, ex, loy, sup, recp, jb, fb, ls, ig, wb, el] = await Promise.all([
        api<{ stats: Stats }>('/api/dashboard'),
        api<{ tables: TableT[] }>('/api/tables'),
        api<{ orders: OrderT[] }>('/api/orders'),
        api<{ queue: OrderT[] }>('/api/kitchen'),
        api<{ items: MenuT[]; categories: CategoryT[] }>('/api/menus'),
        api<{ employees: EmployeeT[] }>('/api/employees'),
        api<{ reservations: ReservationT[] }>('/api/reservations'),
        api<{ receipts: ReceiptT[] }>('/api/furs'),
        api<{ inventory: InventoryT[] }>('/api/inventory'),
        api<{ shifts: ShiftT[] }>('/api/shifts'),
        api<FinancialT>('/api/reports/financial'),
        api<{ haccpChecks: HaccpT[] }>('/api/haccp'),
        api<{ expenses: ExpenseT[] }>('/api/expenses'),
        api<{ accounts: LoyaltyT[] }>('/api/loyalty'),
        api<{ suppliers: SupplierT[] }>('/api/suppliers'),
        api<{ recipes: RecipeT[] }>('/api/recipes'),
        api<{ jobContexts: JobT[] }>('/api/jobs'),
        api<{ feedback: FeedbackT[] }>('/api/guests/feedback'),
        api<{ stats: LocationStatT[] }>('/api/locations/stats'),
        api<{ integrations: IntegrationT[] }>('/api/integrations'),
        api<{ webhookEndpoints: WebhookT[] }>('/api/webhooks'),
        api<{ errors: ErrLogT[] }>('/api/monitoring/errors'),
      ])
      setStats(d.stats); setTables(t.tables); setOrders(o.orders)
      setKitchen(k.queue); setMenu(m.items); setCategories(m.categories); setEmployees(e.employees)
      setReservations(r.reservations); setReceipts(rec.receipts)
      setInventory(inv.inventory); setShifts(sh.shifts); setFinancial(fin)
      setHaccp(haccpRows.haccpChecks); setExpenses(ex.expenses); setLoyalty(loy.accounts)
      setSuppliers(sup.suppliers); setRecipes(recp.recipes); setJobs(jb.jobContexts); setFeedback(fb.feedback)
      setLocStats(ls.stats); setIntegrations(ig.integrations); setWebhooks(wb.webhookEndpoints); setErrLog(el.errors)
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
      setInvoice(d.invoice); await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  async function toggleAvailable(m: MenuT) {
    await api(`/api/menus/${m.id}`, { method: 'PATCH', body: JSON.stringify({ available: !m.available }) })
    await load()
  }

  async function createReservation() {
    if (!newRes?.guestName || !newRes.reservedAt) return
    setSending(true)
    try {
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({ guestName: newRes.guestName, phone: newRes.phone, guests: newRes.guests, reservedAt: new Date(newRes.reservedAt).toISOString(), note: newRes.note }),
      })
      setNewRes(null); await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  /* ── Employee Control Center akcije ── */

  function openEmployee(e: EmployeeT) {
    setEditEmployee(e)
    setEmpPerms(e.permissionOverrides || [])
    setEmpRole(e.role)
    setEmpActive(e.active)
    setEmpPin('')
    setEmpNotice('')
  }

  async function patchEmployee(payload: Record<string, unknown>, okMsg: string) {
    if (!editEmployee) return
    setEmpSaving(true)
    try {
      const d = await api<{ employee: EmployeeT }>(`/api/employees/${editEmployee.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      setEmpNotice(okMsg)
      setEmployees((list) => list.map((x) => (x.id === d.employee.id ? d.employee : x)))
      setEditEmployee(d.employee)
    } catch (err) { setEmpNotice(`Napaka: ${(err as Error).message}`) } finally { setEmpSaving(false) }
  }

  const cartTotal = Object.entries(cart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)
  const menuByCat = categories.map((c) => ({ cat: c, items: menu.filter((m) => m.categoryId === c.id) }))
    .concat({ cat: { id: 'ostalo', name: 'Ostalo' }, items: menu.filter((m) => !m.categoryId) })
    .filter((g) => g.items.length > 0)
  // cone dinamično iz podatkov (produkcija: main/bar/patio/private; rekonstrukcija: Glavna dvorana/Bar/Terasa)
  const ZONE_LABELS: Record<string, string> = { main: 'Glavna dvorana', bar: 'Bar', patio: 'Terasa', private: 'Zasebna soba' }
  const zones = [...new Set(tables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b))

  const upcomingRes = reservations
    .filter((r) => new Date(r.reservedAt).getTime() >= Date.now() - 36e5 && r.status !== 'CANCELLED')
    .sort((a, b) => +new Date(a.reservedAt) - +new Date(b.reservedAt))

  return (
    <main className="min-h-screen flex flex-col bg-stone-100">
      <header className="sticky top-0 z-20 bg-white border-b border-stone-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <Utensils className="w-4 h-4" />
            </div>
            <span className="font-bold truncate">RestavrantOS</span>
            <Badge variant="outline" className="hidden md:inline-flex shrink-0">1.26.0</Badge>
          </div>
          <div className="flex items-center gap-2">
            <PaletteButton onClick={() => setPaletteOpen(true)} />
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPaletteOpen(true)} aria-label="Ukazi">
              <Search className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={load} aria-label="Osveži">
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <span className="text-sm text-stone-600 hidden sm:block truncate max-w-40">{user?.name}</span>
            <Button variant="ghost" size="icon" onClick={() => setConfirmLogout(true)} aria-label="Odjava"><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="w-full justify-start overflow-x-auto h-auto flex-nowrap bg-white border border-stone-200 p-1">
            {[
              ['pregled', 'Pregled', LayoutDashboard], ['mize', 'Mize', Utensils], ['narocila', 'Naročila', ClipboardList],
              ['kuhinja', 'Kuhinja', ChefHat], ['meni', 'Meni', BookOpen], ['rezervacije', 'Rezervacije', CalendarDays],
              ['racuni', 'Računi', ReceiptText], ['zaloge', 'Zaloge', PackageSearch], ['izmene', 'Izmene', Clock],
              ['haccp', 'HACCP', Thermometer], ['stroski', 'Stroški', Wallet], ['zvestoba', 'Zvestoba', HeartHandshake],
              ['mnenja', 'Mnenja', Star], ['zaposleni', 'Zaposleni', Users], ['nastavitve', 'Nastavitve', Settings],
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
            {zones.map((zone) => {
              const zt = tables.filter((t) => t.zone === zone)
              if (zt.length === 0) return null
              return (
                <section key={zone} className="space-y-3">
                  <h2 className="font-semibold text-stone-700">{ZONE_LABELS[zone] || zone}</h2>
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

          <TabsContent value="rezervacije" className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-stone-700">Prihajajoče rezervacije</h2>
              {canManage && (
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setNewRes({ guestName: '', phone: '', guests: 2, reservedAt: '', note: '' })}>
                  <Plus className="w-3.5 h-3.5" /> Nova rezervacija
                </Button>
              )}
            </div>
            <Card>
              <CardContent className="pt-4">
                {upcomingRes.length === 0 && <p className="text-sm text-stone-500">Ni prihajajočih rezervacij.</p>}
                <div className="grid gap-2 sm:grid-cols-2">
                  {upcomingRes.map((r) => (
                    <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{r.guestName} <span className="text-xs text-stone-400">· {r.guests} osebi</span></p>
                        <p className="text-xs text-stone-500">{new Date(r.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{r.phone ? ` · ${r.phone}` : ''}</p>
                        {r.note && <p className="text-xs text-stone-400 truncate">ℹ {r.note}</p>}
                      </div>
                      <Badge variant="outline" className="shrink-0">{r.status}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="racuni" className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Izdani računi (FURS)</CardTitle></CardHeader>
              <CardContent>
                {receipts.length === 0 && <p className="text-sm text-stone-500">Ni izdanih računov.</p>}
                <ScrollArea className="max-h-[60vh]">
                  <div className="space-y-2">
                    {receipts.map((r) => (
                      <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.invoiceNumber}{r.tableName ? ` · ${r.tableName}` : ''}</p>
                          <p className="text-xs text-stone-500">{new Date(r.createdAt).toLocaleString('sl-SI')} · {r.paymentMethod.toUpperCase()}{r.orderNumber ? ` · naročilo #${r.orderNumber}` : ''}</p>
                          <p className="text-[11px] text-stone-400 font-mono truncate max-w-xs sm:max-w-md">EOR: {r.eor}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold">{fmtEUR(r.total)}</p>
                          {r.fiscalVerified ? (
                            <Badge className="bg-emerald-600 text-white">FURS ✓</Badge>
                          ) : (
                            <Badge variant="outline">{r.fiscalStatus || 'neoverjeno'}</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="zaloge">
            <InventoryTab items={inventory} suppliers={suppliers} recipes={recipes} />
          </TabsContent>

          <TabsContent value="izmene">
            <ShiftsTab shifts={shifts} financial={financial} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="haccp">
            <HaccpTab checks={haccp} onReload={load} />
          </TabsContent>

          <TabsContent value="stroski">
            <ExpensesTab expenses={expenses} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="zvestoba">
            <LoyaltyTab accounts={loyalty} />
          </TabsContent>

          <TabsContent value="mnenja">
            <FeedbackTab feedback={feedback} tables={tables.map((t) => ({ id: t.id, name: t.name }))} />
          </TabsContent>

          <TabsContent value="zaposleni" className="space-y-4">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-1.5"><UserCog className="w-4 h-4" /> Zaposleni{canManage ? ' — Control Center' : ''}</CardTitle>
                {canManage && <span className="text-xs text-stone-400 hidden sm:inline">klikni profil za urejanje</span>}
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {employees.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => canManage && openEmployee(e)}
                    disabled={!canManage}
                    className={`flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 bg-white text-left ${canManage ? 'hover:border-emerald-600 hover:shadow-sm transition' : 'cursor-default'}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.name}{!e.active && <span className="ml-1.5 text-xs text-red-600">(neaktiven)</span>}</p>
                      <p className="text-xs text-stone-500 truncate">{e.email}</p>
                      {(e.permissionOverrides?.length || 0) > 0 && (
                        <p className="text-[11px] text-emerald-700 flex items-center gap-0.5"><ShieldCheck className="w-3 h-3" /> {e.permissionOverrides.length} dovoljenj</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline">{ROLE_LABELS[e.role] || e.role}</Badge>
                      {canManage && <UserCog className="w-3.5 h-3.5 text-stone-300" />}
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>
            <JobsCard jobs={jobs} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="nastavitve" className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><MapPin className="w-4 h-4" /> Lokacije</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {locStats.length === 0 && <p className="text-sm text-stone-500">Ni lokacij.</p>}
                  {locStats.map((l) => (
                    <div key={l.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{l.name}</p>
                        <p className="text-xs text-stone-500">{l.tables} miz · {l.employees} zaposlenih · {l.orders} naročil skupaj</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold">{fmtEUR(l.todayRevenue)}</p>
                        <p className="text-xs text-stone-400">danes {l.todayOrders} naročil</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Plug className="w-4 h-4" /> Integracije</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {integrations.length === 0 && <p className="text-sm text-stone-500">Ni integracij.</p>}
                  {integrations.map((i) => (
                    <div key={i.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{i.name} <span className="text-xs text-stone-400">· {i.provider}</span></p>
                        <p className="text-xs text-stone-500">{i.type}{i.syncEnabled ? ' · sinhronizacija vključena' : ''}{i.lastSyncAt ? ` · zadnja: ${new Date(i.lastSyncAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                      </div>
                      <Badge className={i.connectionStatus === 'connected' ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{i.connectionStatus}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Webhook className="w-4 h-4" /> Webhooki</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {webhooks.length === 0 && <p className="text-sm text-stone-500">Ni registriranih webhookov.</p>}
                  {webhooks.map((w) => (
                    <div key={w.id} className="rounded-lg border border-stone-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate">{w.name}</p>
                        <Badge className={w.isActive ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{w.isActive ? 'Aktiven' : 'Izklopljen'}</Badge>
                      </div>
                      <p className="text-xs text-stone-500 truncate">{w.url}</p>
                      <p className="text-[11px] text-stone-400">{w.events.length > 0 ? w.events.join(' · ') : 'brez dogodkov'}{w.failureCount > 0 ? ` · ${w.failureCount} napak` : ''}{w.lastTriggered ? ` · nazadnje sprožen ${new Date(w.lastTriggered).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Bug className="w-4 h-4" /> Dnevnik napak</CardTitle></CardHeader>
                <CardContent>
                  {errLog.length === 0 && <p className="text-sm text-stone-500">Ni zabeleženih napak.</p>}
                  <ScrollArea className="max-h-72">
                    <div className="space-y-2">
                      {errLog.map((l) => (
                        <div key={l.id} className="rounded-lg border border-stone-200 bg-white p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium truncate">{l.action} <span className="text-xs font-normal text-stone-400">· {l.entity}</span></p>
                            <span className="text-xs text-stone-400 shrink-0">{new Date(l.createdAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          {l.data && <p className="text-xs text-stone-500 break-all mt-0.5">{l.data.length > 160 ? `${l.data.slice(0, 160)}…` : l.data}</p>}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
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

      {/* ── Novo naročilo ── */}
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

      {/* ── Plačilo + FURS ── */}
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

      {/* ── Nova rezervacija ── */}
      <Dialog open={!!newRes} onOpenChange={(v) => !v && setNewRes(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nova rezervacija</DialogTitle></DialogHeader>
          {newRes && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="res-name">Ime gosta *</Label>
                <Input id="res-name" value={newRes.guestName} onChange={(e) => setNewRes({ ...newRes, guestName: e.target.value })} placeholder="npr. Družina Novak" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="res-phone">Telefon</Label>
                  <Input id="res-phone" value={newRes.phone} onChange={(e) => setNewRes({ ...newRes, phone: e.target.value })} placeholder="041 234 567" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="res-guests">Št. oseb</Label>
                  <Input id="res-guests" type="number" min={1} value={newRes.guests} onChange={(e) => setNewRes({ ...newRes, guests: Number(e.target.value) || 2 })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-time">Datum in čas *</Label>
                <Input id="res-time" type="datetime-local" value={newRes.reservedAt} onChange={(e) => setNewRes({ ...newRes, reservedAt: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-note">Opomba</Label>
                <Input id="res-note" value={newRes.note} onChange={(e) => setNewRes({ ...newRes, note: e.target.value })} placeholder="npr. otroški stol" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewRes(null)}>Prekliči</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending || !newRes?.guestName || !newRes?.reservedAt} onClick={createReservation}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani rezervacijo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── EMPLOYEE CONTROL CENTER (R265) ── */}
      <Dialog open={!!editEmployee} onOpenChange={(v) => { if (!v) { setEditEmployee(null); setEmpNotice('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserCog className="w-5 h-5" /> {editEmployee?.name}</DialogTitle>
          </DialogHeader>
          {editEmployee && (
            <ScrollArea className="max-h-[60vh] pr-2">
              <div className="space-y-5">
                {empNotice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${empNotice.startsWith('Napaka') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{empNotice}</p>}
                <p className="text-xs text-stone-500">{editEmployee.email}</p>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Vloga</Label>
                    <Select value={empRole} onValueChange={(v) => setEmpRole(v)} disabled={user?.role === 'MANAGER' && empRole === 'ADMIN'}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {['ADMIN', 'MANAGER', 'WAITER', 'KITCHEN'].map((r) => (
                          <SelectItem key={r} value={r} disabled={user?.role === 'MANAGER' && r === 'ADMIN'}>{ROLE_LABELS[r]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Status</Label>
                    <div className="flex items-center gap-2 h-9">
                      <Switch id="emp-active" checked={empActive} onCheckedChange={(v) => { if (!v) setConfirmDeactivate(true); else setEmpActive(true) }} />
                      <Label htmlFor="emp-active" className="text-sm font-normal">{empActive ? 'Aktiven' : 'Neaktiven'}</Label>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> Dovoljenja (override-ji)</Label>
                  <p className="text-xs text-stone-400">Kanonska avtorizacija: prazno = privzeto po vlogi.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {Object.entries(PERMISSION_LABELS).map(([perm, label]) => (
                      <label key={perm} className="flex items-center gap-2 rounded-md border border-stone-200 px-2.5 py-2 text-sm cursor-pointer hover:bg-stone-50">
                        <Checkbox
                          checked={empPerms.includes(perm)}
                          onCheckedChange={(v) => setEmpPerms((p) => (v ? [...p, perm] : p.filter((x) => x !== perm)))}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={empSaving} onClick={() => patchEmployee({ permissionOverrides: empPerms, role: empRole, status: empActive ? 'active' : 'inactive' }, 'Shranjeno ✓')}>
                    {empSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Shrani profil'}
                  </Button>
                </div>

                <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <Label className="text-amber-800">Ponastavi PIN</Label>
                  <p className="text-xs text-amber-700">Občutljiva akcija: obstoječe seje postanejo neveljavne, akcija se zapiše v reviji (audit).</p>
                  <div className="flex gap-2">
                    <Input
                      inputMode="numeric"
                      maxLength={8}
                      value={empPin}
                      onChange={(e) => setEmpPin(e.target.value.replace(/\D/g, ''))}
                      placeholder="4–8 številk"
                      className="max-w-40 bg-white"
                    />
                    <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100" disabled={empPin.length < 4} onClick={() => setConfirmPinReset(true)}>
                      Ponastavi PIN
                    </Button>
                  </div>
                </div>
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditEmployee(null); setEmpNotice('') }}>Zapri</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SENSITIVE ACTION UX (R266) — potrditve z razlago ── */}
      <AlertDialog open={confirmPinReset} onOpenChange={setConfirmPinReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ponastavim PIN za {editEmployee?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              To je občutljiva akcija: nov PIN bo edini način prijave za tega zaposlenega, vse obstoječe seje bodo preklicane, akcija pa bo zapisana v reviji sprememb.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Prekliči</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => { setConfirmPinReset(false); patchEmployee({ pin: empPin }, 'PIN ponastavljen ✓') }}>
              Razumem, ponastavi PIN
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeactivate} onOpenChange={setConfirmDeactivate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deaktiviram račun {editEmployee?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              To je občutljiva akcija: zaposleni ne bo se mogel več prijaviti, odprte izmene ostanejo odprte. Akcija se zapiše v reviji sprememb.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Prekliči</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => { setConfirmDeactivate(false); setEmpActive(false); patchEmployee({ status: 'inactive' }, 'Račun deaktiviran ✓') }}>
              Razumem, deaktiviraj
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Odjava iz sistema?</AlertDialogTitle>
            <AlertDialogDescription>
              Odjava zapre vašo sejo na tej napravi. Odprta naročila ostanejo aktivna — ne izgubijo se.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Ostani</AlertDialogCancel>
            <AlertDialogAction className="bg-emerald-700 hover:bg-emerald-800" onClick={logout}>Odjavi me</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── COMMAND PALETTE (R268) ── */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        user={user}
        onNavigate={(t) => setActiveTab(t)}
        onRefresh={load}
        onNewOrder={() => { setActiveTab('mize'); document.getElementById('mize')?.scrollIntoView({ behavior: 'smooth' }) }}
        onLogout={() => setConfirmLogout(true)}
      />

      <footer className="mt-auto bg-white border-t border-stone-200 py-3 text-center text-xs text-stone-400 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        RestavrantOS rekonstrukcija 1.26.0 · FURS simulacija · EUR · prijava: admin@restaurantos.app / 1234
      </footer>
    </main>
  )
}
