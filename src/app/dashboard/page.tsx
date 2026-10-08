'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getUser } from '@/lib/client'
import { APP_VERSION } from '@/lib/api'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, Users, Settings,
  LogOut, Plus, Minus, Loader2, ReceiptText, RefreshCw, Banknote, CalendarDays,
  ShieldCheck, UserCog, Search, Star, KeyRound, Dices, Printer, Wifi, WifiOff, CloudUpload,
  QrCode,
  MoreVertical,
  ShoppingCart,
  Gift,
  Trash2,
  Hourglass,
  Timer,
} from 'lucide-react'
import { CommandPalette, PaletteButton } from '@/components/command-palette'
import { ThemeToggle } from '@/components/theme-toggle'
import { downloadCSV } from '@/lib/client'
import { printReceipt, type ReceiptDetailT } from '@/lib/receipt'
import {
  enqueueOp, flushQueue, getQueue, isNetworkError, newOperationId, subscribeQueue,
  type QueuedOp,
} from '@/lib/offline-queue'
import {
  printLines, buildKitchenTicketLines, getPrintConfig, savePrintConfig,
  type PrintConfig, type PrintLine, type PrintTarget,
} from '@/lib/devices/print'
import { getTerminalConfig, saveTerminalConfig, processTerminalPayment, type TerminalMode } from '@/lib/devices/terminal'
import { PERMISSION_LABELS } from '@/lib/permissions'
import {
  InventoryTab, ShiftsTab, HaccpTab, ExpensesTab, LoyaltyTab, FeedbackTab, JobsCard, SettingsEditor, DevicesCard, DeliveryTab, AccountingExportCard, NapitnineTab, NabavaTab, DarilneKarticeTab, OdpadTab, CakalnaListaTab, DelovniCasTab,
  type InventoryT, type ShiftT, type FinancialT, type HaccpT, type ExpenseT, type LoyaltyT,
  type SupplierT, type RecipeT, type FeedbackT, type JobT, type SettingsT, type DeviceT,
  type DeliveryOrderT, type DeliveryZoneT, type PlatformIntegrationT,
} from '@/components/dashboard-tabs'
import { PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, Briefcase, MapPin, Plug, Webhook, Bug, Truck, Coins } from 'lucide-react'

interface LocationStatT { id: string; name: string; tables: number; employees: number; orders: number; todayOrders: number; todayRevenue: number }
interface IntegrationT { id: string; name: string; type: string; provider: string; syncEnabled: boolean; connectionStatus: string; lastSyncAt?: string | null }
interface WebhookT { id: string; name: string; url: string; events: string[]; isActive: boolean; lastTriggered?: string | null; failureCount: number }
interface ErrLogT { id: string; employeeId?: string | null; action: string; entity: string; entityId?: string | null; data?: string | null; createdAt: string }
interface AuditT { id: string; timestamp: string; action: string; entityType: string; entityId?: string | null; userId?: string | null; details: Record<string, unknown> }

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; employees: number; menuItems: number }
interface TableT { id: string; name: string; zone: string; seats: number; status: string; activeOrder: { id: string; total: number; guests: number; itemCount: number } | null }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { name: string } | null; items: OrderItemT[] }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean; phone?: string | null; permissionOverrides: string[] }
interface ReservationT { id: string; guestName: string; phone?: string | null; guests: number; reservedAt: string; status: string; note?: string | null }
interface ReceiptT { id: string; invoiceNumber: string; eor: string; zoi: string; fiscalVerified: boolean; fiscalStatus: string; total: number; paymentMethod: string; orderId?: string | null; createdAt: string; tableName?: string | null; orderNumber?: number | null }

// Issue #1 §6: kanonični račun (billing.ts) — popusti, zvestoba, deljeno plačilo
interface BillAutoDisc { discountId: string; name: string; amount: number }
interface BillT { subtotal: number; tax: number; grossTotal: number; manualDiscount: number; autoDiscounts: BillAutoDisc[]; discountTotal: number; totalDue: number; loyalty: { enabled: boolean; pointsPerEuro: number; pointsValue: number; maxRedeemablePoints: number } }
interface DiscountT { id: string; name: string; type: string; amount: number; triggerType: string; isActive: boolean; happyFromHour?: number | null; happyToHour?: number | null }
interface LoyaltyAccT { id: string; customerName: string; customerPhone: string; pointsBalance: number; lifetimePoints: number; tier: string }
interface PayPart { type: 'cash' | 'card' | 'mobile' | 'giftcard'; amount: number }
/** Issue #1 triage ③: izbrana darilna kartica (POS plačilo) */
interface GiftCardSelT { id: string; cardNumber: string; ownerName: string; balance: number; effectiveStatus: string }

const r2v = (v: number) => Math.round(v * 100) / 100

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

/* EMPLOYEE CONTROL CENTER (R265) — kanonska dovoljenja sedaj v src/lib/permissions.ts */
const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Lastnik', ADMIN: 'Administrator', MANAGER: 'Vodja', WAITER: 'Natakar', BAR: 'Bar', KITCHEN: 'Kuhinja',
}
const RES_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Potrjena', SEATED: 'Gost prišel', COMPLETED: 'Zaključena', CANCELLED: 'Preklicana', NO_SHOW: 'Ni prišel',
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
  const [auditLog, setAuditLog] = useState<AuditT[]>([])
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [devices, setDevices] = useState<DeviceT[]>([])
  const [newOrderTable, setNewOrderTable] = useState<TableT | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const [payingOrder, setPayingOrder] = useState<OrderT | null>(null)
  const [invoice, setInvoice] = useState<{ eor: string; invoiceNumber: string; id?: string } | null>(null)
  /** Natisljivi račun (FURS) — busy indikator za gumb Natisni */
  const [printing, setPrinting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [activeTab, setActiveTab] = useState('pregled')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  // Offline/local-first + pravice (issue #1)
  const [perms, setPerms] = useState<string[]>([])
  const [online, setOnline] = useState(true)
  const [queueOps, setQueueOps] = useState<QueuedOp[]>([])
  const [syncing, setSyncing] = useState(false)
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'mobile' | 'giftcard'>('cash')
  // Issue #1 §6: plačilni dialog — kanonični račun, popusti, zvestoba, deljeno plačilo
  const [bill, setBill] = useState<BillT | null>(null)
  const [manualDiscounts, setManualDiscounts] = useState<DiscountT[]>([])
  const [selDiscountId, setSelDiscountId] = useState('')
  const [loyaltyResults, setLoyaltyResults] = useState<LoyaltyAccT[]>([])
  const [loyaltySel, setLoyaltySel] = useState<LoyaltyAccT | null>(null)
  const [redeemPoints, setRedeemPoints] = useState(0)
  const [parts, setParts] = useState<PayPart[]>([])
  const [tipEur, setTipEur] = useState('')
  // Issue #1 triage ③: darilna kartica pri plačilu — eno plačilo + deli
  const [gcSel, setGcSel] = useState<GiftCardSelT | null>(null)
  const [gcQuery, setGcQuery] = useState('')
  const [gcBusy, setGcBusy] = useState(false)
  const [gcErr, setGcErr] = useState('')
  const [gcPartSel, setGcPartSel] = useState<Record<number, GiftCardSelT | null>>({})
  const [gcPartQuery, setGcPartQuery] = useState<Record<number, string>>({})
  const [loyaltySummary, setLoyaltySummary] = useState<{ redeemedPoints: number; earnedPoints: number } | null>(null)
  const [pcfg, setPcfg] = useState<PrintConfig>({ target: 'browser', host: '192.168.1.100', port: 9100 })
  const [termMode, setTermMode] = useState<TerminalMode>('none')

  // Employee Control Center stanje
  const [editEmployee, setEditEmployee] = useState<EmployeeT | null>(null)
  /** Vaja PIN-ov: ali je trenutna seja prijavljena prek začasnega bootstrap dostopa (2 h)? */
  const [bootstrapLogin, setBootstrapLogin] = useState(false)
  /** Vaja PIN-ov: ustvarjanje trajnega profila za bootstrap e-pošto (ce profil se ne obstaja) */
  const [bootName, setBootName] = useState('')
  const [bootPin, setBootPin] = useState('')
  const [bootBusy, setBootBusy] = useState(false)
  const [bootNotice, setBootNotice] = useState('')
  const [empPerms, setEmpPerms] = useState<string[]>([])
  const [empRole, setEmpRole] = useState('WAITER')
  const [empActive, setEmpActive] = useState(true)
  const [empPin, setEmpPin] = useState('')
  const [empSaving, setEmpSaving] = useState(false)
  const [empNotice, setEmpNotice] = useState('')
  const [confirmPinReset, setConfirmPinReset] = useState(false)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)

  // Dostava (issue #2)
  const [deliveryOrders, setDeliveryOrders] = useState<DeliveryOrderT[]>([])
  const [deliveryZones, setDeliveryZones] = useState<DeliveryZoneT[]>([])
  const [deliveryIntegrations, setDeliveryIntegrations] = useState<PlatformIntegrationT[]>([])

  // Issue #3 — QR meni po mizah + POS → customer display push
  const [qrTable, setQrTable] = useState<{ id: string; name: string } | null>(null)
  const [qrData, setQrData] = useState<{ dataUrl: string; url: string; qrEnabled: boolean } | null>(null)
  const [qrBusy, setQrBusy] = useState(false)

  // Rezervacije — nov vnos
  const [newRes, setNewRes] = useState<{ guestName: string; phone: string; guests: number; reservedAt: string; note: string } | null>(null)

  const canManage = user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'
  // UI gating po dovoljenjih (backend uveljavlja neodvisno) — admin/manager vedno vse;
  // pred nalaganjem dovoljenj pokaži vse (permisivno, da ne utripa)
  const hasPerm = (p?: string) => !p || canManage || perms.length === 0 || perms.includes(p)
  const canRes = canManage || perms.includes('reservations.manage')

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      // sveža dovoljenja (spremembe pravic/uveljavitve delujejo takoj — issue #1)
      try {
        const me = await api<{ employee: { permissions?: string[] } }>('/api/auth/me')
        if (me.employee?.permissions) setPerms(me.employee.permissions)
      } catch { /* ne blokiraj nalaganja */ }
      // posamezne napake ne smejo pobrisati celotnega stanja (stabilnost)
      const soft = async <T,>(p: Promise<T>): Promise<T | undefined> => {
        try { return await p } catch (e) { if ((e as Error).message === 'unauthorized') throw e; return undefined }
      }
      const [d, t, o, k, m, e, r, rec, inv, sh, fin, haccpRows, ex, loy, sup, recp, jb, fb, ls, ig, wb, el, se, dv, au, dl] = await Promise.all([
        soft(api<{ stats: Stats }>('/api/dashboard')),
        soft(api<{ tables: TableT[] }>('/api/tables')),
        soft(api<{ orders: OrderT[] }>('/api/orders')),
        soft(api<{ queue: OrderT[] }>('/api/kitchen')),
        soft(api<{ items: MenuT[]; categories: CategoryT[] }>('/api/menus')),
        soft(api<{ employees: EmployeeT[] }>('/api/employees')),
        soft(api<{ reservations: ReservationT[] }>('/api/reservations')),
        soft(api<{ receipts: ReceiptT[] }>('/api/furs')),
        soft(api<{ inventory: InventoryT[] }>('/api/inventory')),
        soft(api<{ shifts: ShiftT[] }>('/api/shifts')),
        soft(api<FinancialT>('/api/reports/financial')),
        soft(api<{ haccpChecks: HaccpT[] }>('/api/haccp')),
        soft(api<{ expenses: ExpenseT[] }>('/api/expenses')),
        soft(api<{ accounts: LoyaltyT[] }>('/api/loyalty')),
        soft(api<{ suppliers: SupplierT[] }>('/api/suppliers')),
        soft(api<{ recipes: RecipeT[] }>('/api/recipes')),
        soft(api<{ jobContexts: JobT[] }>('/api/jobs')),
        soft(api<{ feedback: FeedbackT[] }>('/api/guests/feedback')),
        soft(api<{ stats: LocationStatT[] }>('/api/locations/stats')),
        soft(api<{ integrations: IntegrationT[] }>('/api/integrations')),
        soft(api<{ webhookEndpoints: WebhookT[] }>('/api/webhooks')),
        soft(api<{ errors: ErrLogT[] }>('/api/monitoring/errors')),
        soft(api<{ settings: Record<string, unknown> | null }>('/api/settings')),
        soft(api<{ devices: DeviceT[] }>('/api/devices')),
        soft(api<{ entries: AuditT[] }>('/api/audit')),
        soft(api<{ orders: DeliveryOrderT[]; zones: DeliveryZoneT[]; platformIntegrations: PlatformIntegrationT[] }>('/api/delivery')),
      ])
      if (d) setStats(d.stats)
      if (t) setTables(t.tables)
      if (o) setOrders(o.orders)
      if (k) setKitchen(k.queue)
      if (m) { setMenu(m.items); setCategories(m.categories) }
      if (e) setEmployees(e.employees)
      if (r) setReservations(r.reservations)
      if (rec) setReceipts(rec.receipts)
      if (inv) setInventory(inv.inventory)
      if (sh) setShifts(sh.shifts)
      if (fin) setFinancial(fin)
      if (haccpRows) setHaccp(haccpRows.haccpChecks)
      if (ex) setExpenses(ex.expenses)
      if (loy) setLoyalty(loy.accounts)
      if (sup) setSuppliers(sup.suppliers)
      if (recp) setRecipes(recp.recipes)
      if (jb) setJobs(jb.jobContexts)
      if (fb) setFeedback(fb.feedback)
      if (ls) setLocStats(ls.stats)
      if (ig) setIntegrations(ig.integrations)
      if (wb) setWebhooks(wb.webhookEndpoints)
      if (el) setErrLog(el.errors)
      if (se) {
        const s = se.settings
        const num = (v: unknown, def: number) => { const x = Number(v); return Number.isFinite(x) ? x : def }
        const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
        setSettings(s ? {
          name: str(s.name), address: str(s.address), city: str(s.city), postCode: str(s.postCode),
          phone: str(s.phone), email: str(s.email), web: str(s.web), businessId: str(s.businessId),
          taxId: str(s.taxId), registerNumber: str(s.registerNumber), fursEnvironment: str(s.fursEnvironment) || 'test',
          defaultVatRate: String(num(s.defaultVatRate, 22)), reducedVatRate: String(num(s.reducedVatRate, 9.5)),
          loyaltyEnabled: !!s.loyaltyEnabled, receiptFooter: str(s.receiptFooter), currency: str(s.currency) || 'EUR',
          locale: str(s.locale) || 'sl-SI', country: str(s.country) || 'SI', emailEnabled: !!s.emailEnabled,
        } : null)
      }
      if (dv) setDevices(dv.devices)
      if (au) setAuditLog(au.entries)
      if (dl) { setDeliveryOrders(dl.orders); setDeliveryZones(dl.zones); setDeliveryIntegrations(dl.platformIntegrations) }
    } catch { /* 401 → redirect handled in api() */ } finally { setRefreshing(false) }
  }, [])

  useEffect(() => {
    load()
    setBootstrapLogin(localStorage.getItem('ro_bootstrap') === '1')
    setPcfg(getPrintConfig())
    setTermMode(getTerminalConfig().mode)
    const iv = setInterval(load, 15000)
    return () => clearInterval(iv)
  }, [load])

  // online/offline status + offline vrsta (issue #1)
  useEffect(() => {
    setOnline(navigator.onLine)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    const unsub = subscribeQueue(setQueueOps)
    setQueueOps(getQueue())
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
      unsub()
    }
  }, [])

  const doSync = useCallback(async () => {
    setSyncing((busy) => {
      if (busy) return busy
      void (async () => {
        try {
          const res = await flushQueue()
          if (res.flushed > 0 || res.failed > 0) await load()
        } catch { /* vrsta ostane ohranjena */ } finally { setSyncing(false) }
      })()
      return true
    })
  }, [load])

  // flush ob povratku povezave IN ob zagonu (recovery po refresh/crash)
  useEffect(() => {
    if (online) void doSync()
  }, [online, doSync])

  /** Odjava NE SME izgubiti offline vrste in konfiguracije naprave (issue #1) */
  function logout() {
    const preserve: [string, string | null][] = [
      ['ro_offline_queue', localStorage.getItem('ro_offline_queue')],
      ['ro_device_id', localStorage.getItem('ro_device_id')],
      ['ro_print_config', localStorage.getItem('ro_print_config')],
      ['ro_terminal_config', localStorage.getItem('ro_terminal_config')],
    ]
    localStorage.clear()
    for (const [k, v] of preserve) if (v !== null) localStorage.setItem(k, v)
    router.push('/')
  }

  async function createOrder() {
    if (!newOrderTable) return
    setSending(true)
    try {
      const items = Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
      if (items.length === 0) return
      // idempotencija: isti clientOperationId ob replayu ne ustvari dvojnega naročila
      const clientOperationId = newOperationId()
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: newOrderTable.id, items, guests: 2, clientOperationId }) })
      setCart({}); setNewOrderTable(null); await load()
    } catch (err) {
      if (isNetworkError(err)) {
        // offline → naročilo se NE IZGUBI, gre v lokalno vrsto za sinhronizacijo
        enqueueOp('order.create', { tableId: newOrderTable.id, items: Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty })), guests: 2, note: '' })
        setCart({}); setNewOrderTable(null)
        alert('Brez povezave — naročilo je shranjeno lokalno in se bo samodejno sinhroniziralo.')
      } else {
        alert((err as Error).message)
      }
    } finally { setSending(false) }
  }

  async function setItemStatus(itemId: string, status: string) {
    try {
      await api('/api/kitchen', { method: 'PATCH', body: JSON.stringify({ itemId, status }) })
      await load()
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp('kitchen.status', { itemId, status })
        alert('Brez povezave — sprememba statusa je v vrsti za sinhronizacijo.')
      } else {
        alert((err as Error).message)
      }
    }
  }

  /** Gumb "Izdaj račun" aktiven: račun naložen in (ob delitvi) vsota delov pokrije znesek */
  const payOrderReady = (() => {
    if (!bill) return false
    const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
    const due = r2v(bill.totalDue - redeemValue)
    if (parts.length === 0) {
      // implicitno eno plačilo preostanka — pri darilni kartici zahteva izbrano kartico z dovolj sredstev
      if (payMethod === 'giftcard') {
        if (!gcSel) return false
        if (gcSel.effectiveStatus !== 'active') return false
        return due <= gcSel.balance + 0.004
      }
      return true
    }
    const covered = r2v(parts.reduce((s, x) => s + x.amount, 0))
    if (Math.abs(due - covered) >= 0.005) return false
    // vsak giftcard del MORA imeti izbrano kartico z zadostnim saldom
    return parts.every((x, i) => x.type !== 'giftcard' || (gcPartSel[i] && x.amount <= gcPartSel[i]!.balance + 0.004))
  })()

  /** Issue #1 §6: odpri plačilni dialog — kanonični predogled računa (popusti, zvestoba) prek /api/orders/[id]/bill */
  async function openPayment(o: OrderT) {
    setPayingOrder(o)
    setInvoice(null)
    setLoyaltySel(null)
    setRedeemPoints(0)
    setLoyaltyResults([])
    setParts([])
    setTipEur('')
    setSelDiscountId('none')
    setLoyaltySummary(null)
    setBill(null)
    // Issue #1 triage ③: ponastavi darilno kartico
    setPayMethod('cash')
    setGcSel(null)
    setGcQuery('')
    setGcErr('')
    setGcPartSel({})
    setGcPartQuery({})
    try {
      const [b, ds] = await Promise.all([
        api<{ bill: BillT }>(`/api/orders/${o.id}/bill`),
        api<{ discounts: DiscountT[] }>('/api/discounts'),
      ])
      setBill(b.bill)
      setManualDiscounts(ds.discounts.filter((d) => d.triggerType !== 'auto' && d.isActive))
    } catch (err) {
      alert((err as Error).message)
    }
  }

  /** Issue #1 §6: ročni popust (iz registra) — uporabi ali odstrani, nato osveži kanonični račun */
  async function applyManualDiscount(discountId: string) {
    if (!payingOrder) return
    try {
      if (!discountId || discountId === 'none') {
        await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE' })
      } else {
        await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ discountId }) })
      }
      setSelDiscountId(discountId)
      const b = await api<{ bill: BillT }>(`/api/orders/${payingOrder.id}/bill`)
      setBill(b.bill)
      await load()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  /** Issue #1 §6: identifikacija gosta (program zvestobe) — iskanje po imenu/telefonu */
  async function searchLoyalty(q: string) {
    if (q.trim().length < 2) {
      setLoyaltyResults([])
      return
    }
    try {
      const d = await api<{ results: LoyaltyAccT[] }>(`/api/loyalty/lookup?q=${encodeURIComponent(q)}`)
      setLoyaltyResults(d.results)
    } catch {
      setLoyaltyResults([])
    }
  }

  /** Issue #1 triage ③: iskanje darilne kartice po številki (POS plačilo) */
  async function lookupGiftCard(query: string, apply: (c: GiftCardSelT) => void) {
    const qs = query.trim()
    if (qs.length < 4) {
      setGcErr('Vpišite vsaj zadnjih 6 znakov številke kartice.')
      return
    }
    setGcBusy(true)
    setGcErr('')
    try {
      const d = await api<{ card: GiftCardSelT }>(`/api/giftcards/lookup?q=${encodeURIComponent(qs)}`)
      apply(d.card)
    } catch (e) {
      setGcErr((e as Error).message)
    } finally {
      setGcBusy(false)
    }
  }

  /** Issue #1 §6: status mize (con/status upravljanje) — na voljo / rezervirana / za pospravit */
  async function setTableStatus(t: TableT, status: 'FREE' | 'RESERVED' | 'DIRTY') {
    try {
      await api(`/api/tables/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      await load()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  async function payOrder() {
    if (!payingOrder || !bill) return
    setSending(true)
    try {
      // Issue #1 §6: kanonični zneski iz strežniškega računa — UI nikoli ne odloča o znesku
      const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
      const due = r2v(bill.totalDue - redeemValue)
      const bodyParts: { type: string; amount: number; terminal?: { approvalCode: string }; giftCardId?: string }[] = []
      if (parts.length > 0) {
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]
          if (p.type === 'giftcard') {
            // Issue #1 triage ③: darilna kartica — brez terminala, zahteva izbrano kartico
            const sel = gcPartSel[i]
            if (!sel) {
              alert(`Del ${i + 1}: izberite darilno kartico.`)
              return
            }
            bodyParts.push({ type: 'giftcard', amount: r2v(p.amount), giftCardId: sel.id })
            continue
          }
          if (p.type === 'cash' || p.amount <= 0) {
            bodyParts.push({ type: p.type, amount: r2v(p.amount) })
            continue
          }
          const t = await processTerminalPayment(p.amount)
          if (!t.approved) {
            alert(t.error || `Terminal ni odobril plačila (${fmtEUR(p.amount)}).`)
            return
          }
          bodyParts.push({ type: p.type, amount: r2v(p.amount), terminal: { approvalCode: t.approvalCode as string } })
        }
      } else if (due > 0) {
        // klasična pot — eno plačilo preostanka
        if (payMethod === 'giftcard') {
          // Issue #1 triage ③: plačilo z darilno kartico (celoten preostanek)
          if (!gcSel) {
            alert('Najprej poiščite in izberite darilno kartico.')
            return
          }
          bodyParts.push({ type: 'giftcard', amount: due, giftCardId: gcSel.id })
        } else if (payMethod !== 'cash') {
          const t = await processTerminalPayment(due)
          if (!t.approved) {
            alert(t.error || 'Plačilo na terminalu ni bilo odobreno.')
            return
          }
          bodyParts.push({ type: payMethod, amount: due, terminal: { approvalCode: t.approvalCode as string } })
        } else {
          bodyParts.push({ type: 'cash', amount: due })
        }
      }
      const d = await api<{ invoice: { eor: string; invoiceNumber: string; id?: string }; loyalty: { redeemedPoints: number; earnedPoints: number } | null }>('/api/furs', {
        method: 'POST',
        body: JSON.stringify({
          orderId: payingOrder.id,
          clientOperationId: newOperationId(),
          ...(Number(tipEur) > 0 ? { tip: Number(tipEur) } : {}),
          ...(bodyParts.length === 1
            ? {
                type: bodyParts[0].type,
                terminal: bodyParts[0].terminal,
                // Issue #1 triage ③: darilna kartica — pošlji giftCardId (legacy enodelna pot)
                ...(bodyParts[0].giftCardId ? { giftCardId: bodyParts[0].giftCardId } : {}),
              }
            : bodyParts.length > 1
              ? { parts: bodyParts }
              : {}),
          ...(loyaltySel && redeemPoints > 0 ? { loyaltyAccountId: loyaltySel.id, loyaltyPointsUsed: redeemPoints } : {}),
        }),
      })
      setInvoice(d.invoice)
      if (d.loyalty) setLoyaltySummary(d.loyalty)
      // Issue #3: CFD pokaže "Hvala" z zneskom in številko naročila
      void pushDisplay({ state: 'paid', orderNumber: payingOrder.orderNumber, total: bill.totalDue, message: 'Plačilo uspešno — hvala!' })
      await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  /** Natisljivi FURS račun — prek konfiguriranega cilja (brskalnik / agent ESC-POS / simulator) */
  async function printInvoice(id: string) {
    setPrinting(true)
    try {
      const d = await api<{ receipt: ReceiptDetailT }>(`/api/furs/${id}`)
      const r = d.receipt
      const cfg = getPrintConfig()
      if (cfg.target === 'browser') {
        if (!printReceipt(r, settings?.receiptFooter)) {
          alert('Brskalnik je zavrzel pojavno okno — dovoli pojavna okna za tiskanje računov.')
        }
        return
      }
      const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
      const lines: PrintLine[] = [
        { text: r.businessAddress || '' },
        ...(r.taxId ? [{ text: `ID za DDV: ${r.taxId}` } as PrintLine] : []),
        { text: '· · · · · · · · · · · · · · · · · ·' },
        ...(r.tableName ? [{ text: `Miza: ${r.tableName}` } as PrintLine] : []),
        { text: '--------------------------------' },
        ...r.items.map((it) => ({ text: `${it.qty}x ${it.name}` } as PrintLine)),
        ...r.items.map((it) => ({ text: `   ${money(it.amount)}`, align: 'right' } as PrintLine)),
        { text: '--------------------------------' },
        { text: `DDV: ${money(r.totalVat)}`, align: 'right' },
        { text: `SKUPAJ: ${money(r.total)}`, align: 'right', bold: true, size: 'large' },
        { text: `Plačilo: ${r.paymentMethod.toUpperCase()}` },
        ...(r.zoi ? [{ text: `ZOI: ${r.zoi}` } as PrintLine] : []),
        ...(r.eor ? [{ text: `EOR: ${r.eor}` } as PrintLine] : []),
        { text: r.fiscalVerified ? 'FURS: fiskalizirano' : `FURS: ${r.fiscalStatus}` },
        ...(settings?.receiptFooter ? [{ text: settings.receiptFooter, align: 'center' } as PrintLine] : []),
      ]
      const res = await printLines(`Racun ${r.invoiceNumber}`, lines)
      if (!res.ok) alert(`Tisk ni uspel: ${res.error}`)
      else if (res.simulated) alert('SIMULACIJA tiska — vrstice so pripravljene (vidne v konzoli brskalnika).')
    } catch (err) { alert(`Napaka pri pripravi računa: ${(err as Error).message}`) } finally { setPrinting(false) }
  }

  /** Miza za pospravit → znova na voljo (issue #1: e2e zaključek) */
  async function markClean(t: TableT) {
    try {
      await api(`/api/tables/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FREE' }) })
      await load()
    } catch (err) { alert((err as Error).message) }
  }

  /* ── Issue #3: QR meni po mizah ── */
  async function openQr(t: TableT) {
    setQrTable({ id: t.id, name: t.name }); setQrData(null); setQrBusy(true)
    try {
      const d = await api<{ dataUrl: string; url: string; qrEnabled: boolean }>(`/api/tables/${t.id}/qr`)
      setQrData(d)
    } catch (e) { alert((e as Error).message); setQrTable(null) } finally { setQrBusy(false) }
  }
  async function qrAction(action: 'rotate' | 'toggle', enabled?: boolean) {
    if (!qrTable) return
    setQrBusy(true)
    try {
      await api(`/api/tables/${qrTable.id}/qr`, { method: 'POST', body: JSON.stringify({ action, enabled }) })
      const d = await api<{ dataUrl: string; url: string; qrEnabled: boolean }>(`/api/tables/${qrTable.id}/qr`)
      setQrData(d)
    } catch (e) { alert((e as Error).message) } finally { setQrBusy(false) }
  }

  /* ── Issue #3: POS → customer display (CFD) push ── */
  const pushDisplay = useCallback(async (payload: Record<string, unknown>) => {
    try {
      await api('/api/devices/display', { method: 'POST', body: JSON.stringify({ action: 'push', payload }) })
    } catch { /* display push ne sme blokirati POS toka */ }
  }, [])

  /** Kuhinjski/bar list prek naprave (issue #1: kuhinjski tisk) */
  async function printKitchenTicket(o: OrderT, station: 'KITCHEN' | 'BAR') {
    const res = await printLines(`Narocilo #${o.orderNumber ?? '?'}`, buildKitchenTicketLines({
      orderNumber: o.orderNumber ?? undefined,
      tableName: o.table?.name || null,
      type: o.type,
      employeeName: o.employee?.name || null,
      items: o.items.map((it) => ({ name: it.name, qty: it.qty, note: it.note, station: it.station })),
    }, station))
    if (!res.ok) alert(`Tisk ni uspel: ${res.error}`)
    else if (res.simulated) alert(`SIMULACIJA ${station === 'BAR' ? 'bar' : 'kuhinjskega'} lista — vsebina v konzoli.`)
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

  async function setReservationStatus(id: string, status: string) {
    setSending(true)
    try {
      await api('/api/reservations', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      await load()
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

  /** Vaja PIN-ov: bootstrap seja ustvari trajen admin profil z PIN-om (prehod iz env dostopa na bazo) */
  async function createBootstrapProfile() {
    if (!user?.email) return
    setBootBusy(true); setBootNotice('')
    try {
      await api('/api/employees', { method: 'POST', body: JSON.stringify({ email: user.email, name: bootName, pin: bootPin, role: 'ADMIN' }) })
      setBootNotice(`Profil ustvarjen ✓ — odjavi se in prijavi z naslovom ${user.email} in novim PIN-om.`)
      setBootPin(''); await load()
    } catch (err) { setBootNotice(`Napaka: ${(err as Error).message}`) } finally { setBootBusy(false) }
  }

  const cartTotal = Object.entries(cart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)

  // Issue #3: POS → customer display — trenutna transakcija v realnem času (debounce 800 ms)
  useEffect(() => {
    if (!newOrderTable) return
    const t = setTimeout(() => {
      const lines = Object.entries(cart).map(([id, qty]) => {
        const m = menu.find((x) => x.id === id)
        const price = (m?.price || 0) * qty
        return { name: m?.name || id, qty, price }
      })
      const subtotal = lines.reduce((s, l) => s + l.price, 0)
      const tax = Math.round(subtotal * 0.22 * 100) / 100
      void pushDisplay({
        state: lines.length ? 'ordering' : 'idle',
        tableName: newOrderTable.name,
        lines,
        subtotal: Math.round((subtotal - tax) * 100) / 100,
        tax,
        vatBreakdown: lines.length ? [{ rate: 22, amount: tax }] : [],
        total: subtotal,
      })
    }, 800)
    return () => clearTimeout(t)
  }, [cart, newOrderTable, menu, pushDisplay])

  const menuByCat = categories.map((c) => ({ cat: c, items: menu.filter((m) => m.categoryId === c.id) }))
    .concat({ cat: { id: 'ostalo', name: 'Ostalo' }, items: menu.filter((m) => !m.categoryId) })
    .filter((g) => g.items.length > 0)
  // cone dinamično iz podatkov (produkcija: main/bar/patio/private; rekonstrukcija: Glavna dvorana/Bar/Terasa)
  const ZONE_LABELS: Record<string, string> = { main: 'Glavna dvorana', bar: 'Bar', patio: 'Terasa', private: 'Zasebna soba' }
  const zones = [...new Set(tables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b))

  const upcomingRes = reservations
    .filter((r) => new Date(r.reservedAt).getTime() >= Date.now() - 36e5 && r.status !== 'CANCELLED')
    .sort((a, b) => +new Date(a.reservedAt) - +new Date(b.reservedAt))

  /** Tab → zahtevano dovoljenje (issue #1, naloga 3) */
  const TAB_PERM: Record<string, string> = {
    mize: 'orders.create', narocila: 'orders.create', kuhinja: 'kitchen.update',
    meni: 'menu.manage', rezervacije: 'reservations.manage', racuni: 'reports.view',
    zaloge: 'inventory.manage', izmene: 'orders.pay', haccp: 'settings.manage',
    stroski: 'reports.view', zvestoba: 'reports.view', mnenja: 'reservations.manage',
    dostava: 'orders.create',
    napitnine: 'reports.view',
    nabava: 'inventory.manage',
    darilne: 'reports.view',
    odpad: 'inventory.manage',
    cakalna: 'reservations.manage',
    zaposleni: 'employees.manage', nastavitve: 'settings.manage',
  }

  return (
    <main className="min-h-screen flex flex-col bg-stone-100">
      <header className="sticky top-0 z-20 bg-white border-b border-stone-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <Utensils className="w-4 h-4" />
            </div>
            <span className="font-bold truncate">RestavrantOS</span>
            <Badge variant="outline" className="hidden md:inline-flex shrink-0">1.41.0</Badge>
          </div>
          <div className="flex items-center gap-2">
            {/* online/offline/sync status (issue #1) — klik za ročno sinhronizacijo */}
            <button
              type="button"
              onClick={() => void doSync()}
              title="Sinhronizacija offline sprememb — klikni za ročni poskus"
              aria-live="polite"
              className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium transition ${
                !online
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : syncing
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : queueOps.length > 0
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
              }`}
            >
              {syncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : !online ? (
                <WifiOff className="w-3.5 h-3.5" />
              ) : queueOps.length > 0 ? (
                <CloudUpload className="w-3.5 h-3.5" />
              ) : (
                <Wifi className="w-3.5 h-3.5" />
              )}
              <span>{!online ? `Offline${queueOps.length ? ` · ${queueOps.length}` : ''}` : syncing ? 'Sinhroniziram…' : queueOps.length > 0 ? `${queueOps.length} v vrsti` : 'Online'}</span>
            </button>
            <ThemeToggle />
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
            {([
              ['pregled', 'Pregled', LayoutDashboard], ['mize', 'Mize', Utensils], ['narocila', 'Naročila', ClipboardList],
              ['kuhinja', 'Kuhinja', ChefHat], ['meni', 'Meni', BookOpen], ['rezervacije', 'Rezervacije', CalendarDays],
              ['racuni', 'Računi', ReceiptText], ['zaloge', 'Zaloge', PackageSearch], ['izmene', 'Izmene', Clock],
              ['delovnicas', 'Delovni čas', Timer],
              ['haccp', 'HACCP', Thermometer], ['stroski', 'Stroški', Wallet], ['zvestoba', 'Zvestoba', HeartHandshake],
              ['mnenja', 'Mnenja', Star], ['dostava', 'Dostava', Truck], ['napitnine', 'Napitnine', Coins], ['nabava', 'Nabava', ShoppingCart], ['darilne', 'Darilne kartice', Gift], ['odpad', 'Odpad', Trash2], ['cakalna', 'Čakalna lista', Hourglass], ['zaposleni', 'Zaposleni', Users], ['nastavitve', 'Nastavitve', Settings],
            ] as [string, string, typeof LayoutDashboard | null][])
              // UI gating po dovoljenjih (issue #1, naloga 3) — backend uveljavlja neodvisno
              .filter(([v]) => hasPerm(TAB_PERM[v]))
              .map(([v, label, Icon]) => (
              <TabsTrigger key={v} value={v} className="gap-1.5 data-[state=active]:bg-emerald-700 data-[state=active]:text-white whitespace-nowrap">
                {Icon && <Icon className="w-4 h-4" />} {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="pregled" className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                ['Aktivna naročila', stats?.activeOrders, ClipboardList], ['Zasedene mize', stats?.openTables, Utensils],
                ['Današnji promet', stats ? fmtEUR(stats.todayRevenue) : undefined, Banknote], ['Današnja naročila', stats?.todayOrders, ReceiptText],
              ].map(([label, value, Icon], i) => {
                const Ic = Icon as React.ComponentType<{ className?: string }> | undefined
                return (
                <Card key={i}>
                  <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5">{Ic && <Ic className="w-4 h-4" />} {label as string}</CardTitle></CardHeader>
                  <CardContent><p className="text-2xl font-bold">{(value as React.ReactNode) ?? '—'}</p></CardContent>
                </Card>
                )
              })}
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
                      <div key={t.id} className="relative">
                        <button
                          onClick={() => {
                            // miza za pospravit → en klik = očisti (issue #1: e2e zaključek)
                            if (t.status === 'DIRTY' && !t.activeOrder) { void markClean(t); return }
                            if (!t.activeOrder) { setCart({}); setNewOrderTable(t) } else { const o = orders.find((x) => x.id === t.activeOrder!.id); if (o) void openPayment(o) }
                          }}
                          className={`w-full rounded-xl p-4 text-left shadow transition ${statusColors[t.status]} min-h-20`}
                        >
                          <p className="font-bold text-lg">{t.name}</p>
                          <p className="text-xs opacity-90">{t.seats} mest</p>
                          {t.activeOrder && <p className="text-xs mt-1 font-semibold">{fmtEUR(t.activeOrder.total)}</p>}
                          <p className="text-[11px] mt-1 opacity-80">{t.activeOrder ? statusLabels.OCCUPIED : t.status === 'DIRTY' ? 'Klikni — očisti' : statusLabels[t.status]}</p>
                        </button>
                        {/* Issue #3: QR meni za to mizo — (span, ker gosta ne sme biti gnezdena v gumbu) */}
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`QR meni — ${t.name}`}
                          onClick={(e) => { e.stopPropagation(); void openQr(t) }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void openQr(t) } }}
                          className="absolute top-1.5 right-1.5 rounded-md bg-white/85 p-1 text-stone-600 hover:bg-white hover:text-stone-900 cursor-pointer shadow-sm"
                        >
                          <QrCode className="w-4 h-4" />
                        </span>
                        {/* Issue #1 §6: status mize — upravljanje (na voljo / rezervirana / za pospravit) */}
                        {!t.activeOrder && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label={`Status mize — ${t.name}`}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
                                className="absolute bottom-1.5 right-1.5 rounded-md bg-white/85 p-1 text-stone-600 hover:bg-white hover:text-stone-900 cursor-pointer shadow-sm"
                              >
                                <MoreVertical className="w-4 h-4" />
                              </span>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={() => void setTableStatus(t, 'FREE')}>Na voljo</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void setTableStatus(t, 'RESERVED')}>Rezervirana</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void setTableStatus(t, 'DIRTY')}>Za pospravit</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </TabsContent>

          {/* Issue #3: QR meni dialog — QR slika, URL, izklop/vklop naročanja, regeneracija (revokacija) */}
          <Dialog open={!!qrTable} onOpenChange={(o) => !o && setQrTable(null)}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><QrCode className="w-4 h-4" /> QR meni — {qrTable?.name}</DialogTitle>
              </DialogHeader>
              {qrBusy || !qrData ? (
                <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>
              ) : (
                <div className="space-y-3 text-sm">
                  <img src={qrData.dataUrl} alt={`QR meni — ${qrTable?.name}`} className="mx-auto rounded-xl border border-stone-200 w-52 h-52" />
                  <p className="text-xs text-stone-500 break-all text-center select-all">{qrData.url}</p>
                  <div className="flex items-center justify-between rounded-lg border border-stone-200 p-2.5">
                    <span className="font-medium">QR naročanje</span>
                    <Switch checked={qrData.qrEnabled} onCheckedChange={(v) => void qrAction('toggle', v)} />
                  </div>
                  <Button variant="outline" className="w-full" disabled={qrBusy} onClick={() => void qrAction('rotate')}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> Nov QR (revokiraj stare povezave)
                  </Button>
                  <p className="text-[11px] text-stone-400">Gost skenira kodo → javni meni → samopostrežno naročilo. Naročilo pride v KDS po istem toku kot POS.</p>
                </div>
              )}
            </DialogContent>
          </Dialog>

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
                        <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void openPayment(o)}>
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
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    {o.table?.name || o.type} <span className="text-xs font-normal text-stone-500">#{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI')}</span>
                    <span className="ml-auto flex gap-1.5">
                      <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => void printKitchenTicket(o, 'KITCHEN')} title="Natisni kuhinjski list (ESC/POS agent ali simulator)">
                        <Printer className="w-3 h-3" /> Kuhinjski list
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => void printKitchenTicket(o, 'BAR')} title="Natisni bar list">
                        <Printer className="w-3 h-3" /> Bar list
                      </Button>
                    </span>
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
              {canRes && (
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
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline">{RES_STATUS_LABELS[r.status] || r.status}</Badge>
                        {canRes && (
                          <>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={sending} onClick={() => setReservationStatus(r.id, 'SEATED')}>Prišel</Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-amber-700 border-amber-200 hover:bg-amber-50" disabled={sending} onClick={() => setReservationStatus(r.id, 'CANCELLED')}>Prekliči</Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="racuni" className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => {
                const d = new Date()
                downloadCSV(`racuni-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
                  ['St. racuna', 'Datum', 'Miza', 'Narocilo', 'Nacin placila', 'Znesek (EUR)', 'EOR', 'FURS'],
                  ...receipts.map((r) => [r.invoiceNumber, new Date(r.createdAt).toLocaleString('sl-SI'), r.tableName || '', r.orderNumber ?? '', r.paymentMethod.toUpperCase(), r.total, r.eor, r.fiscalVerified ? 'verified' : r.fiscalStatus]),
                ])
              }}>
                Izvozi račune (CSV)
              </Button>
            </div>
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
                        <div className="shrink-0 flex items-center gap-1 w-full sm:w-auto justify-end">
                          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={printing} onClick={() => printInvoice(r.id)} title="Natisni račun (ali shrani kot PDF)">
                            <Printer className="w-3.5 h-3.5" /> Natisni
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
            <AccountingExportCard />
          </TabsContent>

          <TabsContent value="zaloge">
            <InventoryTab items={inventory} suppliers={suppliers} recipes={recipes} menuItems={menu.map((m) => ({ id: m.id, name: m.name }))} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="izmene">
            <ShiftsTab shifts={shifts} financial={financial} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="delovnicas">
            {/* ura je za VSE zaposlene (brez TAB_PERM vnosa); ekipni del je gating employees.manage */}
            <DelovniCasTab canManage={hasPerm('employees.manage')} />
          </TabsContent>

          <TabsContent value="haccp">
            <HaccpTab checks={haccp} onReload={load} />
          </TabsContent>

          <TabsContent value="stroski">
            <ExpensesTab expenses={expenses} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="zvestoba">
            <LoyaltyTab accounts={loyalty} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="mnenja">
            <FeedbackTab feedback={feedback} tables={tables.map((t) => ({ id: t.id, name: t.name }))} />
          </TabsContent>

          <TabsContent value="dostava">
            <DeliveryTab
              orders={deliveryOrders}
              zones={deliveryZones}
              platformIntegrations={deliveryIntegrations}
              onReload={load}
            />
          </TabsContent>

          <TabsContent value="napitnine">
            <NapitnineTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={canManage} />
          </TabsContent>

          <TabsContent value="nabava">
            <NabavaTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={canManage} />
          </TabsContent>

          <TabsContent value="darilne">
            <DarilneKarticeTab canPay={hasPerm('orders.pay')} canManage={hasPerm('settings.manage')} />
          </TabsContent>

          <TabsContent value="odpad">
            <OdpadTab canManage={hasPerm('inventory.manage')} />
          </TabsContent>

          <TabsContent value="cakalna">
            <CakalnaListaTab canManage={hasPerm('reservations.manage')} />
          </TabsContent>

          <TabsContent value="zaposleni" className="space-y-4">
            {canManage && bootstrapLogin && (
              <Card className="border-amber-300 bg-amber-50">
                <CardContent className="py-3 flex items-start gap-2.5">
                  <KeyRound className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                  <div className="text-sm text-amber-800 min-w-0 space-y-2">
                    <p className="font-medium">Aktiven je začasni (bootstrap) dostop — seja poteče po 2 urah.</p>
                    {bootNotice && <p className={`text-xs font-medium rounded-md px-2 py-1 ${bootNotice.startsWith('Napaka') ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>{bootNotice}</p>}
                    {employees.every((e) => e.email?.toLowerCase() !== user?.email?.toLowerCase()) ? (
                      <>
                        <p className="text-xs text-amber-700">E-poštni naslov <span className="font-medium">{user?.email}</span> še nima profila med zaposlenimi. Ustvari trajen admin profil s PIN-om, da bo prijava potekala neposredno iz baze:</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Input value={bootName} onChange={(e) => setBootName(e.target.value)} placeholder="Ime in priimek" className="max-w-48 h-9 bg-white" />
                          <Input inputMode="numeric" maxLength={8} value={bootPin} onChange={(e) => setBootPin(e.target.value.replace(/\D/g, ''))} placeholder="PIN (4–8)" className="max-w-28 h-9 bg-white" />
                          <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100 h-9" title="Naključni 6-mestni PIN" onClick={() => setBootPin(String(Math.floor(100000 + Math.random() * 900000)))}>
                            <Dices className="w-4 h-4" />
                          </Button>
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 h-9" disabled={bootBusy || !bootName || bootPin.length < 4} onClick={createBootstrapProfile}>
                            {bootBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Ustvari trajen profil'}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-amber-700">Klikni svoj profil spodaj, nastavi si trajen PIN (lahko isti kot zdaj) ter se nato odjavi in znova prijavi. Po ponovni prijavi to opozorilo izgine.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
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
            <SettingsEditor settings={settings} canManage={canManage} onReload={load} />
            <DevicesCard devices={devices} locations={locStats.map((l) => ({ id: l.id, name: l.name }))} onChanged={load} />
            {/* Naprave te naprave (issue #1, naloga 2) — tiskalnik + plačilni terminal */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Printer className="w-4 h-4" /> Tiskalnik in terminal — ta naprava</CardTitle></CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="text-xs text-stone-500">Konfiguracija je vezana na to napravo (localStorage). Cilj “Lokalni agent” pošilja ESC/POS (CP852 — č/š/ž) prek print-agent strežnika na omrežni tiskalnik (TCP 9100).</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>Cilj tiskanja</Label>
                    <Select value={pcfg.target} onValueChange={(v) => setPcfg((c) => ({ ...c, target: v as PrintTarget }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="browser">Brskalnik (okno/PDF)</SelectItem>
                        <SelectItem value="agent">Lokalni agent (ESC/POS)</SelectItem>
                        <SelectItem value="simulator">Simulator (brez naprave)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tiskalnik — IP gostitelj</Label>
                    <Input value={pcfg.host} onChange={(e) => setPcfg((c) => ({ ...c, host: e.target.value }))} placeholder="npr. 192.168.1.100" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Tiskalnik — vrata</Label>
                    <Input inputMode="numeric" value={String(pcfg.port)} onChange={(e) => setPcfg((c) => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 9100 }))} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Plačilni terminal</Label>
                    <Select value={termMode} onValueChange={(v) => setTermMode(v as TerminalMode)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Brez terminala</SelectItem>
                        <SelectItem value="simulator">Simulator (avtomatska odobritev)</SelectItem>
                        <SelectItem value="manual">Ročno (koda odobritve s terminala)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => { savePrintConfig(pcfg); saveTerminalConfig({ mode: termMode }); alert('Konfiguracija naprave shranjena ✓') }}>Shrani</Button>
                    <Button size="sm" variant="outline" className="gap-1" onClick={async () => {
                      const res = await printLines('Testni tisk', [
                        { text: 'RestavrantOS — test tiskalnika' },
                        { text: 'Č Š Ž č š ž — CP852 preverjanje', bold: true },
                        { text: new Date().toLocaleString('sl-SI') },
                      ])
                      if (!res.ok) alert(`Tisk ni uspel: ${res.error}`)
                      else if (res.simulated) alert('SIMULACIJA — testne vrstice v konzoli.')
                      else alert('Poslano na tiskalnik ✓')
                    }}>
                      <Printer className="w-3.5 h-3.5" /> Testni tisk
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
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
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> Revizijski dnevnik</CardTitle></CardHeader>
                <CardContent>
                  {auditLog.length === 0 && <p className="text-sm text-stone-500">Ni revizijskih vnosov.</p>}
                  <ScrollArea className="max-h-72">
                    <div className="space-y-2">
                      {auditLog.map((a) => (
                        <div key={a.id} className="rounded-lg border border-stone-200 bg-white p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium truncate">{a.action} <span className="text-xs font-normal text-stone-400">· {a.entityType}</span></p>
                            <span className="text-xs text-stone-400 shrink-0">{new Date(a.timestamp).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          {Object.keys(a.details || {}).length > 0 && <p className="text-xs text-stone-500 break-all mt-0.5">{JSON.stringify(a.details).slice(0, 160)}</p>}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
            <Card><CardHeader><CardTitle className="text-base">O sistemu</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1.5 text-stone-600">
                <p>RestavrantOS — različica {APP_VERSION} (offline-first rekonstrukcija)</p>
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

      {/* ── Plačilo + FURS (issue #1 §6: kanonični račun, popusti, zvestoba, deljeno plačilo; §7: večji gumbi) ── */}
      <Dialog open={!!payingOrder} onOpenChange={(v) => { if (!v) { setPayingOrder(null); setInvoice(null) } }}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader><DialogTitle className="text-lg">Plačilo {payingOrder?.table?.name || ''}</DialogTitle></DialogHeader>
          {!bill && payingOrder && (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>
          )}
          {bill && payingOrder && (
            <div className="space-y-3 text-sm">
              {/* postavke + zneski (kanonično iz /api/orders/[id]/bill) */}
              <ul className="space-y-1 max-h-36 overflow-y-auto pr-1">{payingOrder.items.map((it) => <li key={it.id} className="flex justify-between"><span>{it.qty}× {it.name}</span><span>{fmtEUR(it.qty * it.unitPrice)}</span></li>)}</ul>
              <div className="rounded-xl border border-stone-200 p-3 space-y-1">
                <div className="flex justify-between"><span>Skupaj (z DDV)</span><span>{fmtEUR(bill.grossTotal)}</span></div>
                {bill.manualDiscount > 0 && (
                  <div className="flex justify-between text-stone-600"><span>Ročni popust</span><span>−{fmtEUR(bill.manualDiscount)}</span></div>
                )}
                {bill.autoDiscounts.map((ad) => (
                  <div key={ad.discountId} className="flex justify-between text-emerald-700"><span>🎉 {ad.name}</span><span>−{fmtEUR(ad.amount)}</span></div>
                ))}
                {bill.discountTotal > 0 && (
                  <div className="flex justify-between font-medium border-t border-stone-100 pt-1"><span>Popust skupaj</span><span>−{fmtEUR(bill.discountTotal)}</span></div>
                )}
                <div className="flex justify-between font-bold text-lg pt-1 border-t border-stone-200"><span>ZA PLAČATI</span><span>{fmtEUR(bill.totalDue)}</span></div>
              </div>

              {/* Issue #1 (triage ①): napitnina pri plačilu — gre v Payment.tipAmount → dnevni bazen napitnin */}
              {!invoice && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs shrink-0">Napitnina (EUR):</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.5"
                    inputMode="decimal"
                    value={tipEur}
                    onChange={(e) => setTipEur(e.target.value)}
                    placeholder="0.00"
                    className="h-9 w-28"
                    aria-label="Napitnina v EUR"
                  />
                  {Number(tipEur) > 0 && (
                    <span className="text-xs text-stone-500">→ skupaj gost: <b>{fmtEUR(bill.totalDue + Number(tipEur))}</b></span>
                  )}
                </div>
              )}

              {!invoice && (
                <>
                  {/* ročni popust (registr) — samo z dovoljenjem apply_discounts */}
                  {hasPerm('apply_discounts') && manualDiscounts.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs shrink-0">Popust:</Label>
                      <Select value={selDiscountId} onValueChange={(v) => void applyManualDiscount(v)}>
                        <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Brez popusta" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Brez popusta</SelectItem>
                          {manualDiscounts.map((d) => (
                            <SelectItem key={d.id} value={d.id}>{d.name} ({(d.type === 'percent' || d.type === 'percentage') ? `${d.amount} %` : fmtEUR(d.amount)})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* zvestoba — iskanje gosta + unovčenje točk */}
                  {bill.loyalty.enabled && (
                    <div className="rounded-xl border border-stone-200 p-3 space-y-2">
                      {loyaltySel ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold truncate">{loyaltySel.customerName}</p>
                            <p className="text-xs text-stone-500">{loyaltySel.pointsBalance} točk · {loyaltySel.tier}</p>
                          </div>
                          <Button variant="outline" size="sm" className="h-8" onClick={() => { setLoyaltySel(null); setRedeemPoints(0) }}>Odstrani</Button>
                        </div>
                      ) : (
                        <div className="relative">
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                            <Input
                              className="h-9 pl-8"
                              placeholder="Gost (ime ali telefon)…"
                              aria-label="Iskanje gosta zvestobe"
                              onChange={(e) => void searchLoyalty(e.target.value)}
                            />
                          </div>
                          {loyaltyResults.length > 0 && (
                            <div className="absolute z-20 mt-1 w-full rounded-lg border border-stone-200 bg-white shadow-lg overflow-hidden">
                              {loyaltyResults.map((a) => (
                                <button
                                  key={a.id}
                                  type="button"
                                  className="w-full text-left px-3 py-2.5 hover:bg-stone-50 active:bg-stone-100"
                                  onClick={() => { setLoyaltySel(a); setLoyaltyResults([]) }}
                                >
                                  <p className="font-medium">{a.customerName}</p>
                                  <p className="text-xs text-stone-500">{a.customerPhone || '—'} · {a.pointsBalance} točk · {a.tier}</p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {loyaltySel && (
                        <div className="flex items-center gap-2">
                          <Label className="text-xs shrink-0">Unovči:</Label>
                          <Input
                            type="number"
                            min={0}
                            max={Math.min(loyaltySel.pointsBalance, bill.loyalty.maxRedeemablePoints)}
                            value={redeemPoints || ''}
                            onChange={(e) => setRedeemPoints(Math.max(0, Math.min(Math.min(loyaltySel!.pointsBalance, bill!.loyalty.maxRedeemablePoints), Math.round(Number(e.target.value) || 0))))}
                            className="h-9 w-28"
                          />
                          <span className="text-xs text-stone-500">
                            točk {redeemPoints > 0 && <>→ <b className="text-emerald-700">−{fmtEUR(r2v(redeemPoints * bill.loyalty.pointsValue))}</b></>}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* način plačila / deljeno plačilo */}
                  {parts.length === 0 ? (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Način plačila:</Label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {(['cash', 'card', 'mobile', 'giftcard'] as const).map((pm) => (
                          <button
                            key={pm}
                            type="button"
                            onClick={() => setPayMethod(pm)}
                            className={`min-h-11 rounded-xl border px-2 py-2.5 text-sm font-semibold transition ${payMethod === pm ? 'border-emerald-700 bg-emerald-700 text-white shadow' : 'border-stone-200 bg-white text-stone-700 hover:border-emerald-400'}`}
                          >
                            {pm === 'cash' ? '💵 Gotovina' : pm === 'card' ? '💳 Kartica' : pm === 'mobile' ? '📱 Mobilno' : '🎁 Darilna'}
                          </button>
                        ))}
                      </div>
                      {/* Issue #1 triage ③: plačilo z darilno kartico — iskanje + izbira */}
                      {payMethod === 'giftcard' && (
                        <div className="rounded-xl border border-stone-200 bg-stone-50 p-2.5 space-y-2">
                          {!gcSel ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={gcQuery}
                                onChange={(e) => setGcQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && void lookupGiftCard(gcQuery, setGcSel)}
                                placeholder="Št. kartice (ali zadnjih 6 znakov)"
                                className="h-9 flex-1 font-mono"
                                aria-label="Številka darilne kartice"
                              />
                              <Button variant="outline" className="h-9" disabled={gcBusy} onClick={() => void lookupGiftCard(gcQuery, setGcSel)}>
                                {gcBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Poišči'}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-sm min-w-0">
                                <p className="font-mono text-xs font-semibold truncate">{gcSel.cardNumber}</p>
                                <p className="text-xs text-stone-500 truncate">{gcSel.ownerName || 'Brez lastnika'} · saldo <b className="text-emerald-700">{fmtEUR(gcSel.balance)}</b></p>
                              </div>
                              <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => { setGcSel(null); setGcQuery('') }}>Zamenjaj</Button>
                            </div>
                          )}
                          {gcErr && <p className="text-xs text-red-600">{gcErr}</p>}
                          {gcSel && gcSel.effectiveStatus !== 'active' && <p className="text-xs text-red-600">Kartica ni aktivna ({gcSel.effectiveStatus}) — plačilo ni mogoče.</p>}
                          {gcSel && gcSel.effectiveStatus === 'active' && bill && (() => {
                            const dv = loyaltySel && redeemPoints > 0 ? r2v(bill.loyalty.pointsValue * redeemPoints) : 0
                            const dueNow = r2v(bill.totalDue - dv)
                            if (dueNow > gcSel.balance + 0.004) {
                              return <p className="text-xs text-amber-700">Na kartici manjka {fmtEUR(r2v(dueNow - gcSel.balance))} — uporabite deljeno plačilo.</p>
                            }
                            return <p className="text-xs text-emerald-700">✓ Kartica pokrije znesek {fmtEUR(dueNow)}</p>
                          })()}
                        </div>
                      )}
                      <Button
                        variant="outline"
                        className="w-full min-h-10"
                        onClick={() => {
                          const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
                          const due = r2v(bill.totalDue - redeemValue)
                          const half = r2v(due / 2)
                          setParts([{ type: payMethod === 'cash' ? 'cash' : payMethod, amount: half }, { type: 'cash', amount: r2v(due - half) }])
                          if (payMethod === 'giftcard' && gcSel) setGcPartSel({ 0: gcSel })
                        }}
                      >
                        ➗ Deljeno plačilo (razdeli na 2 dela)
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-xs">Deljeno plačilo — deli:</Label>
                      {parts.map((p, i) => (
                        <Fragment key={i}>
                        <div className="flex items-center gap-2">
                          <Select value={p.type} onValueChange={(v) => setParts((ps) => ps.map((x, j) => j === i ? { ...x, type: v as PayPart['type'] } : x))}>
                            <SelectTrigger className="h-10 w-32"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cash">💵 Gotovina</SelectItem>
                              <SelectItem value="card">💳 Kartica</SelectItem>
                              <SelectItem value="mobile">📱 Mobilno</SelectItem>
                              <SelectItem value="giftcard">🎁 Darilna</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            value={p.amount ? p.amount.toFixed(2) : ''}
                            onChange={(e) => setParts((ps) => ps.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) || 0 } : x))}
                            className="h-10"
                            aria-label={`Znesek dela ${i + 1}`}
                          />
                          <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} aria-label="Odstrani del">×</Button>
                        </div>
                        {/* Issue #1 triage ③: giftcard del zahteva izbrano kartico */}
                        {p.type === 'giftcard' && (
                          <div className="ml-0 sm:ml-36 rounded-lg border border-stone-200 bg-stone-50 p-2 space-y-1.5">
                            {!gcPartSel[i] ? (
                              <div className="flex items-center gap-2">
                                <Input
                                  value={gcPartQuery[i] || ''}
                                  onChange={(e) => setGcPartQuery((m) => ({ ...m, [i]: e.target.value }))}
                                  onKeyDown={(e) => e.key === 'Enter' && void lookupGiftCard(gcPartQuery[i] || '', (c) => setGcPartSel((m) => ({ ...m, [i]: c })))}
                                  placeholder="Št. kartice za ta del"
                                  className="h-8 flex-1 font-mono text-xs"
                                  aria-label={`Darilna kartica za del ${i + 1}`}
                                />
                                <Button variant="outline" size="sm" className="h-8" disabled={gcBusy} onClick={() => void lookupGiftCard(gcPartQuery[i] || '', (c) => setGcPartSel((m) => ({ ...m, [i]: c })))}>
                                  {gcBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Poišči'}
                                </Button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-mono truncate">{gcPartSel[i]!.cardNumber} · saldo <b className="text-emerald-700">{fmtEUR(gcPartSel[i]!.balance)}</b>{p.amount > gcPartSel[i]!.balance + 0.004 && <b className="text-red-600"> · premalo za {fmtEUR(p.amount)}</b>}</p>
                                <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => setGcPartSel((m) => ({ ...m, [i]: null }))}>Zamenjaj</Button>
                              </div>
                            )}
                          </div>
                        )}
                        </Fragment>
                      ))}
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 min-h-10"
                          onClick={() => {
                            const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
                            const due = r2v(bill.totalDue - redeemValue)
                            const covered = r2v(parts.reduce((s, x) => s + x.amount, 0))
                            setParts((ps) => [...ps, { type: 'cash', amount: Math.max(0, r2v(due - covered)) }])
                          }}
                        >
                          + Dodaj del
                        </Button>
                        <Button variant="outline" className="flex-1 min-h-10" onClick={() => setParts([])}>Eno plačilo</Button>
                      </div>
                      {(() => {
                        const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
                        const due = r2v(bill.totalDue - redeemValue)
                        const covered = r2v(parts.reduce((s, x) => s + x.amount, 0))
                        const rest = r2v(due - covered)
                        const balanced = Math.abs(rest) < 0.005
                        return (
                          <p className={`text-center font-semibold ${balanced ? 'text-emerald-700' : rest > 0 ? 'text-stone-600' : 'text-red-600'}`}>
                            {balanced ? '✓ Razdeljeno' : rest > 0 ? `Manjka: ${fmtEUR(rest)}` : `Preveč: ${fmtEUR(-rest)}`}
                          </p>
                        )
                      })()}
                    </div>
                  )}
                </>
              )}

              {invoice && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm space-y-0.5">
                  <p className="font-semibold text-emerald-800">✅ Račun izdan (FURS {bill ? (bill.discountTotal > 0 ? '· popust uporabljen' : 'simulacija') : 'simulacija'})</p>
                  <p className="text-emerald-700">Št.: {invoice.invoiceNumber}</p>
                  <p className="text-emerald-700 break-all">EOR: {invoice.eor}</p>
                  {loyaltySummary && (
                    <p className="text-emerald-700">{loyaltySummary.redeemedPoints > 0 ? `Unovčeno ${loyaltySummary.redeemedPoints} točk · ` : ''}Prisluženo {loyaltySummary.earnedPoints} točk ⭐</p>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="sm:items-center">
            {invoice?.id && (
              <Button variant="outline" className="mr-auto gap-1.5 min-h-11" disabled={printing} onClick={() => printInvoice(invoice.id!)}>
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} Natisni račun
              </Button>
            )}
            <Button variant="outline" className="min-h-11" onClick={() => { setPayingOrder(null); setInvoice(null) }}>Zapri</Button>
            {!invoice && <Button className="bg-emerald-700 hover:bg-emerald-800 min-h-12 px-6 text-base font-bold" disabled={sending || !bill || !payOrderReady} onClick={() => void payOrder()}>{sending ? <Loader2 className="w-5 h-5 animate-spin" /> : payMethod === 'cash' && parts.length === 0 ? 'Izdaj račun' : 'Izdaj račun (POS)'}</Button>}
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
                        {['OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'BAR', 'KITCHEN'].map((r) => (
                          <SelectItem key={r} value={r} disabled={(user?.role === 'MANAGER' && r === 'ADMIN') || (user?.role !== 'OWNER' && r === 'OWNER')}>{ROLE_LABELS[r]}</SelectItem>
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
                  {editEmployee.email?.toLowerCase() === user?.email?.toLowerCase() && (
                    <p className="text-xs font-medium text-amber-900">To je tvoj profil — s tem PIN-om bo prijava potekala neposredno iz baze (brez začasnega bootstrap dostopa).</p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      inputMode="numeric"
                      maxLength={8}
                      value={empPin}
                      onChange={(e) => setEmpPin(e.target.value.replace(/\D/g, ''))}
                      placeholder="4–8 številk"
                      className="max-w-40 bg-white"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-300 text-amber-800 hover:bg-amber-100"
                      title="Naključni 6-mestni PIN"
                      onClick={() => setEmpPin(String(Math.floor(100000 + Math.random() * 900000)))}
                    >
                      <Dices className="w-4 h-4" />
                    </Button>
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
            <AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => {
              setConfirmPinReset(false)
              const self = editEmployee?.email?.toLowerCase() === user?.email?.toLowerCase()
              patchEmployee({ pin: empPin }, self ? 'PIN nastavljen ✓ — odjavi se in prijavi z novim PIN-om' : 'PIN ponastavljen ✓')
            }}>
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
        RestavrantOS rekonstrukcija {APP_VERSION} · offline-first + FURS (sim/produkcija ločena) · EUR
      </footer>
    </main>
  )
}
