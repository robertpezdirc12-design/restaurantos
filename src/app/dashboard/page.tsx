'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getUser } from '@/lib/client'
import { toast } from '@/hooks/use-toast'
import { APP_VERSION } from '@/lib/version'
import { tabHasPerm } from '@/lib/tab-permissions'
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
  CalendarClock,
  Power,
  ArrowRightLeft,
  GitMerge,
  Flame,
  Pencil,
  Split,
  Bell,
  CalendarRange,
  ChartScatter,
} from 'lucide-react'
import { CommandPalette, PaletteButton } from '@/components/command-palette'
import { ThemeToggle } from '@/components/theme-toggle'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'
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
import { filterByLocation, isCentralUIRole } from '@/lib/multilocation'
import {
  InventoryTab, ShiftsTab, HaccpTab, ExpensesTab, LoyaltyTab, FeedbackTab, JobsCard, SettingsEditor, DevicesCard, DeliveryTab, AccountingExportCard, NapitnineTab, NabavaTab, DarilneKarticeTab, OdpadTab, CakalnaListaTab, DelovniCasTab, OdpiralniCasTab, DiscountsTab, IntegracijeTab, EnterpriseTab, StaffScheduleTab, MenuEngineeringTab, KdsStatsSection,
  type InventoryT, type ShiftT, type FinancialT, type HaccpT, type ExpenseT, type LoyaltyT,
  type SupplierT, type RecipeT, type FeedbackT, type JobT, type SettingsT, type DeviceT,
  type DeliveryOrderT, type DeliveryZoneT, type PlatformIntegrationT,
} from '@/components/dashboard-tabs'
import { PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, Briefcase, MapPin, Plug, Webhook, Bug, Truck, Coins, Ban, Percent, Building2, Zap, EyeOff, Volume2, Maximize2 } from 'lucide-react'

interface LocationStatT { id: string; name: string; tables: number; employees: number; orders: number; todayOrders: number; todayRevenue: number }
/** triage ⑧ — polna vrstica lokacije (GET /api/locations, centralne vloge vidijo vse) */
interface LocationRowT { id: string; name: string; code: string; address: string; city: string; postCode: string; country: string; phone: string; email: string; premisesId: string | null; timezone: string; currency: string; isActive: boolean }
interface IntegrationT { id: string; name: string; type: string; provider: string; syncEnabled: boolean; connectionStatus: string; lastSyncAt?: string | null }
interface WebhookT { id: string; name: string; url: string; events: string[]; isActive: boolean; lastTriggered?: string | null; failureCount: number }
interface ErrLogT { id: string; employeeId?: string | null; action: string; entity: string; entityId?: string | null; data?: string | null; createdAt: string }
interface AuditT { id: string; timestamp: string; action: string; entityType: string; entityId?: string | null; userId?: string | null; details: Record<string, unknown> }

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; employees: number; menuItems: number }
interface TableT { id: string; name: string; zone: string; seats: number; status: string; locationId?: string | null; activeOrder: { id: string; total: number; guests: number; itemCount: number } | null; posX?: number; posY?: number }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null; voided?: boolean; courseId?: string | null }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; locationId?: string | null; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { name: string } | null; items: OrderItemT[]; paymentStatus?: string | null }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null; locationId?: string | null }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean; phone?: string | null; locationId?: string | null; permissionOverrides: string[] }
interface ReservationT { id: string; guestName: string; phone?: string | null; guests: number; reservedAt: string; status: string; note?: string | null; reminderSent?: boolean }
interface ReceiptT { id: string; invoiceNumber: string; eor: string; zoi: string; fiscalVerified: boolean; fiscalStatus: string; total: number; paymentMethod: string; orderId?: string | null; createdAt: string; tableName?: string | null; orderNumber?: number | null; isStorno?: boolean; stornoOf?: string | null }

// Issue #1 §6: kanonični račun (billing.ts) — popusti, zvestoba, deljeno plačilo
interface BillAutoDisc { discountId: string; name: string; amount: number }
interface BillT { subtotal: number; tax: number; grossTotal: number; manualDiscount: number; autoDiscounts: BillAutoDisc[]; discountTotal: number; totalDue: number; loyalty: { enabled: boolean; pointsPerEuro: number; pointsValue: number; maxRedeemablePoints: number }; items?: { id: string; name: string; quantity: number; unitPrice: number }[] }
interface DiscountT { id: string; name: string; type: string; amount: number; triggerType: string; isActive: boolean; happyFromHour?: number | null; happyToHour?: number | null }
interface LoyaltyAccT { id: string; customerName: string; customerPhone: string; pointsBalance: number; lifetimePoints: number; tier: string }
interface PayPart { type: 'cash' | 'card' | 'mobile' | 'giftcard'; amount: number }
/** OPS-7 (v1.68.0) — coursing (tečaji jedi) + split po izstavkih (Check) */
interface CourseT { id: string; courseNumber: number; name: string; status: string; firedAt?: string | null }
interface ChecksT { checks: { id: string; checkNumber: number; paymentStatus: string; payments: number }[]; items: { id: string; name: string; quantity: number; lineTotal: number; checkId: string | null; checkNumber: number | null }[]; checkCount: number }
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
  OWNER: 'Lastnik', ADMIN: 'Administrator', MANAGER: 'Vodja', WAITER: 'Natakar', BAR: 'Bar', KITCHEN: 'Kuhinja', CLEANER: 'Čistilka',
}
const RES_STATUS_KEYS: Record<string, string> = {
  CONFIRMED: 'resv.stConfirmed', SEATED: 'resv.stSeated', COMPLETED: 'resv.stCompleted', CANCELLED: 'resv.stCancelled', NO_SHOW: 'resv.stNoShow',
}

export default function DashboardPage() {
  return (
    <I18nProvider>
      <DashboardInner />
    </I18nProvider>
  )
}

function DashboardInner() {
  const router = useRouter()
  const { t, locale } = useI18n()
  // Hydration-safe (Task 41): localStorage ni dosegljiv na strežniku, zato se uporabnik
  // prebere šele po mountu — sicer SSR naredi null, klient ime → hydration mismatch
  // (span z imenom uporabnika v headerju). Varen, ker ta komponenta nima redirecta na !user.
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null)
  useEffect(() => { setUser(getUser()) }, [])
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
  const [expCatsEnabled, setExpCatsEnabled] = useState(false)
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
  const [stornoing, setStornoing] = useState<string | null>(null)
  // ==== 33-a: selitev/združevanje/fire (P2 audit §54/§57) ====
  const [mmvBusy, setMmvBusy] = useState(false)
  const [moveOrder, setMoveOrder] = useState<OrderT | null>(null)
  const [moveTableId, setMoveTableId] = useState('')
  const [mergeOrder, setMergeOrder] = useState<OrderT | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // OPS-4 v1.67.0: zacetni zavihek iz URL (?tab=) — zaslon sank/kuhinje na svoji napravi
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === 'undefined') return 'pregled'
    return new URLSearchParams(window.location.search).get('tab') ?? 'pregled'
  })
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
  // OPS-7 (v1.68.0): urejevalnik naročila (NaročiloSheet) + split po izstavkih + coursing
  const [orderSheet, setOrderSheet] = useState<OrderT | null>(null)
  const [sheetCourses, setSheetCourses] = useState<CourseT[]>([])
  const [sheetCart, setSheetCart] = useState<Record<string, number>>({})
  const [payCheckId, setPayCheckId] = useState<string | null>(null)
  const [payCheckNum, setPayCheckNum] = useState(0)
  const [checksData, setChecksData] = useState<ChecksT | null>(null)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitSel, setSplitSel] = useState<Record<string, boolean>>({})
  // OPS-7 (v1.70.0): Web Push stanje + omogočanje (zvonček v glavi)
  const [pushState, setPushState] = useState<'unsupported' | 'default' | 'granted' | 'denied'>(() => (typeof window !== 'undefined' && !('serviceWorker' in navigator && 'PushManager' in window) ? 'unsupported' : typeof Notification !== 'undefined' ? (Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'default') : 'unsupported'))

  async function enablePush() {
    try {
      if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return
      const perm = await Notification.requestPermission()
      setPushState(perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : 'default')
      if (perm !== 'granted') return
      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await api<{ publicKey: string }>('/api/push/key')
      const existing = await reg.pushManager.getSubscription()
      const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
      const j = sub.toJSON()
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(j) })
      void api('/api/push/test', { method: 'POST' }).catch(() => undefined)
      toast({ title: t('push.enabled') })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    }
  }
  const [tipEur, setTipEur] = useState('')
  // OPS-7 (v1.70.0): filter stanj v Naročila zavihku
  const [orderFilter, setOrderFilter] = useState<'ALL' | 'OPEN' | 'SENT' | 'PREPARED'>('ALL')
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

  // Triage ⑧ — več poslovalnic: preklopnik pogleda + CRUD lokacij + dodelitev lokacije zaposlenemu
  const [viewLoc, setViewLoc] = useState('')
  const viewLocRef = useRef('')
  const firstRunLoc = useRef(true)
  const [locList, setLocList] = useState<LocationRowT[]>([])
  const [locDialogOpen, setLocDialogOpen] = useState(false)
  const [locEditing, setLocEditing] = useState<LocationRowT | null>(null)
  const [locForm, setLocForm] = useState<{ name: string; code: string; address: string; city: string; postCode: string; country: string; phone: string; email: string; premisesId: string; timezone: string; currency: string; isActive: boolean }>({ name: '', code: '', address: '', city: '', postCode: '', country: 'SI', phone: '', email: '', premisesId: '', timezone: 'Europe/Ljubljana', currency: 'EUR', isActive: true })
  const [locSaving, setLocSaving] = useState(false)
  const [locNotice, setLocNotice] = useState('')
  const [confirmLocToggle, setConfirmLocToggle] = useState<LocationRowT | null>(null)
  const [empLoc, setEmpLoc] = useState('')

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
  // pred nalaganjem dovoljenj pokaži vse (permisivno, da ne utripa);
  // N8 fail-closed: neznano/undefined dovoljenje → false (prej `!p` → true)
  const hasPerm = (p?: string) => !!p && (canManage || perms.length === 0 || perms.includes(p))
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
      const [d, t, o, k, m, e, r, rec, inv, sh, fin, haccpRows, ex, loy, sup, recp, jb, fb, ls, ig, wb, el, se, dv, au, dl, lc] = await Promise.all([
        soft(api<{ stats: Stats }>(`/api/dashboard${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)),
        soft(api<{ tables: TableT[] }>('/api/tables')),
        soft(api<{ orders: OrderT[] }>('/api/orders')),
        soft(api<{ queue: OrderT[] }>('/api/kitchen')),
        soft(api<{ items: MenuT[]; categories: CategoryT[] }>(`/api/menus${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)),
        soft(api<{ employees: EmployeeT[] }>('/api/employees')),
        soft(api<{ reservations: ReservationT[] }>('/api/reservations')),
        soft(api<{ receipts: ReceiptT[] }>('/api/furs')),
        soft(api<{ inventory: InventoryT[] }>('/api/inventory')),
        soft(api<{ shifts: ShiftT[] }>('/api/shifts')),
        soft(api<FinancialT>('/api/reports/financial')),
        soft(api<{ haccpChecks: HaccpT[] }>('/api/haccp')),
        soft(api<{ expenses: ExpenseT[]; categoriesEnabled?: boolean }>('/api/expenses')),
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
        soft(api<{ locations: LocationRowT[] }>('/api/locations')),
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
      if (ex) { setExpenses(ex.expenses); setExpCatsEnabled(ex.categoriesEnabled === true) }
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
      if (lc) setLocList(lc.locations)
    } catch { /* 401 → redirect handled in api() */ } finally { setRefreshing(false) }
  }, [])

  // Triage ⑧ — preklop lokacije v glavi: takojšen refetch Pregled statistike
  useEffect(() => {
    if (firstRunLoc.current) { firstRunLoc.current = false; return }
    viewLocRef.current = viewLoc
    api<{ stats: Stats }>(`/api/dashboard${viewLoc ? `?locationId=${viewLoc}` : ''}`)
      .then((d) => setStats(d.stats))
      .catch(() => { /* stabilnost — naslednji load osveži */ })
  }, [viewLoc])

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
        alert(t('net.offlineOrderQueued'))
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
        alert(t('net.offlineStatusQueued'))
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

  /** OPS-7: odpri urejevalnik naročila (Toast vzorec — klik na zasedeno mizo NE gre direktno v plačilo) */
  async function openOrderSheet(o: OrderT) {
    setOrderSheet(o)
    setSheetCart({})
    setSheetCourses([])
    try {
      const d = await api<{ courses: CourseT[] }>(`/api/orders/${o.id}/courses`)
      setSheetCourses(d.courses)
    } catch {
      /* tečaji so opcijski — napaka ne blokira urejevalnika */
    }
  }

  /** OPS-7: osveži urejevalnik naročila s svežimi podatki (po addItems/fire) */
  async function refreshSheetOrder(orderId: string) {
    try {
      const d = await api<{ order: OrderT }>(`/api/orders/${orderId}`)
      setOrderSheet(d.order)
    } catch {
      /* pusti obstoječe stanje urejevalnika */
    }
  }

  /** OPS-7: pošlji dodatek obstoječemu naročilu (PATCH addItems) */
  async function sendSheetItems() {
    if (!orderSheet) return
    const items = Object.entries(sheetCart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
    if (items.length === 0) return
    setSending(true)
    try {
      const clientOperationId = newOperationId()
      await api(`/api/orders/${orderSheet.id}`, { method: 'PATCH', body: JSON.stringify({ addItems: items, clientOperationId }) })
      setSheetCart({})
      await load()
      void refreshSheetOrder(orderSheet.id)
    } catch (err) {
      alert((err as Error).message)
    } finally { setSending(false) }
  }

  /** OPS-7: fire vseh pending postavk naročila */
  async function fireSheetAll() {
    if (!orderSheet) return
    setSending(true)
    try {
      await api(`/api/orders/${orderSheet.id}/fire`, { method: 'POST' })
      await load()
      void refreshSheetOrder(orderSheet.id)
    } catch (err) {
      alert((err as Error).message)
    } finally { setSending(false) }
  }

  /** OPS-7 coursing: fire SAMO tečaja (ostale postavke ostanejo pending) */
  async function fireCourse(courseId: string) {
    if (!orderSheet) return
    setSending(true)
    try {
      await api(`/api/orders/${orderSheet.id}/fire`, { method: 'POST', body: JSON.stringify({ courseId }) })
      const d = await api<{ courses: CourseT[] }>(`/api/orders/${orderSheet.id}/courses`)
      setSheetCourses(d.courses)
      await load()
      void refreshSheetOrder(orderSheet.id)
    } catch (err) {
      alert((err as Error).message)
    } finally { setSending(false) }
  }

  /** OPS-7 coursing: dodeli postavko tečaju (ali ustvari nov tečaj) */
  async function assignCourse(itemId: string, v: string) {
    if (!orderSheet || v === 'none') return
    try {
      if (v === '__new') {
        await api(`/api/orders/${orderSheet.id}/courses`, { method: 'POST', body: JSON.stringify({ itemIds: [itemId] }) })
      } else {
        await api(`/api/orders/${orderSheet.id}/courses`, { method: 'PATCH', body: JSON.stringify({ courseId: v, itemIds: [itemId] }) })
      }
      const d = await api<{ courses: CourseT[] }>(`/api/orders/${orderSheet.id}/courses`)
      setSheetCourses(d.courses)
    } catch (err) {
      alert((err as Error).message)
    }
  }

  /** OPS-7 split: osveži izstavke (GET checks) */
  async function refreshChecks(orderId: string) {
    const d = await api<ChecksT>(`/api/orders/${orderId}/checks`)
    setChecksData(d)
    return d
  }

  /** OPS-7 split: razdeli izbrane postavke v nov izstavek */
  async function splitCheck() {
    if (!payingOrder) return
    const itemIds = Object.entries(splitSel).filter(([, v]) => v).map(([k]) => k)
    if (itemIds.length === 0) return
    setSending(true)
    try {
      await api(`/api/orders/${payingOrder.id}/checks`, { method: 'POST', body: JSON.stringify({ itemIds }) })
      setSplitSel({})
      const d = await refreshChecks(payingOrder.id)
      setSplitOpen(d.checkCount > 1)
    } catch (err) {
      alert((err as Error).message)
    } finally { setSending(false) }
  }

  /** Issue #1 §6: odpri plačilni dialog — kanonični predogled računa (popusti, zvestoba) prek /api/orders/[id]/bill
   *  OPS-7: checkId → predogled PER IZSTAVEK; openSplit → takoj prikaži upravljanje izstavkov */
  async function openPayment(o: OrderT, checkId?: string, openSplit = false) {
    setPayingOrder(o)
    setInvoice(null)
    setPayCheckId(checkId ?? null)
    setPayCheckNum(0)
    setChecksData(null)
    setSplitOpen(openSplit)
    setSplitSel({})
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
        api<{ bill: BillT; checkBill?: BillT; check?: { checkNumber: number } }>(`/api/orders/${o.id}/bill${checkId ? `?checkId=${checkId}` : ''}`),
        api<{ discounts: DiscountT[] }>('/api/discounts'),
      ])
      if (checkId && b.checkBill && b.check) {
        setBill(b.checkBill)
        setPayCheckNum(b.check.checkNumber)
      } else {
        setBill(b.bill)
      }
      setManualDiscounts(ds.discounts.filter((d) => d.triggerType !== 'auto' && d.isActive))
      if (openSplit) void refreshChecks(o.id).catch(() => undefined)
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
      setGcErr(t('payment.gcMinChars'))
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
              alert(t('payment.partGcRequired', { n: i + 1 }))
              return
            }
            bodyParts.push({ type: 'giftcard', amount: r2v(p.amount), giftCardId: sel.id })
            continue
          }
          if (p.type === 'cash' || p.amount <= 0) {
            bodyParts.push({ type: p.type, amount: r2v(p.amount) })
            continue
          }
          const term = await processTerminalPayment(p.amount)
          if (!term.approved) {
            alert(term.error || t('payment.terminalDeclined', { amount: fmtEUR(p.amount) }))
            return
          }
          bodyParts.push({ type: p.type, amount: r2v(p.amount), terminal: { approvalCode: term.approvalCode as string } })
        }
      } else if (due > 0) {
        // klasična pot — eno plačilo preostanka
        if (payMethod === 'giftcard') {
          // Issue #1 triage ③: plačilo z darilno kartico (celoten preostanek)
          if (!gcSel) {
            alert(t('payment.gcChooseFirst'))
            return
          }
          bodyParts.push({ type: 'giftcard', amount: due, giftCardId: gcSel.id })
        } else if (payMethod !== 'cash') {
          const term = await processTerminalPayment(due)
          if (!term.approved) {
            alert(term.error || t('payment.terminalNotApproved'))
            return
          }
          bodyParts.push({ type: payMethod, amount: due, terminal: { approvalCode: term.approvalCode as string } })
        } else {
          bodyParts.push({ type: 'cash', amount: due })
        }
      }
      const d = await api<{ invoice: { eor: string; invoiceNumber: string; id?: string }; loyalty: { redeemedPoints: number; earnedPoints: number } | null }>('/api/furs', {
        method: 'POST',
        body: JSON.stringify({
          orderId: payingOrder.id,
          clientOperationId: newOperationId(),
          ...(payCheckId ? { checkId: payCheckId } : {}),
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
      void pushDisplay({ state: 'paid', orderNumber: payingOrder.orderNumber, total: bill.totalDue, message: t('payment.pushPaid') })
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
        if (!printReceipt(r, settings?.receiptFooter, locale)) {
          alert(t('print.popupBlocked'))
        }
        return
      }
      const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
      const lines: PrintLine[] = [
        { text: r.businessAddress || '' },
        ...(r.taxId ? [{ text: t('print.taxIdLine', { tax: r.taxId }) } as PrintLine] : []),
        { text: '· · · · · · · · · · · · · · · · · ·' },
        ...(r.tableName ? [{ text: t('print.tableLine', { name: r.tableName }) } as PrintLine] : []),
        { text: '--------------------------------' },
        ...r.items.map((it) => ({ text: `${it.qty}x ${it.name}` } as PrintLine)),
        ...r.items.map((it) => ({ text: `   ${money(it.amount)}`, align: 'right' } as PrintLine)),
        { text: '--------------------------------' },
        { text: t('print.vatLine', { amount: money(r.totalVat) }), align: 'right' },
        { text: t('print.totalLine', { amount: money(r.total) }), align: 'right', bold: true, size: 'large' },
        { text: t('print.payLine', { method: r.paymentMethod.toUpperCase() }) },
        ...(r.zoi ? [{ text: `ZOI: ${r.zoi}` } as PrintLine] : []),
        ...(r.eor ? [{ text: `EOR: ${r.eor}` } as PrintLine] : []),
        ...(r.zki ? [{ text: `ZKI: ${r.zki}` } as PrintLine] : []),
        ...(r.jir ? [{ text: `JIR: ${r.jir}` } as PrintLine] : []),
        ...(r.qr ? [{ text: r.qr } as PrintLine] : []),
        { text: r.fiscalVerified ? t('print.fursOk') : t('print.fursColon', { status: r.fiscalStatus }) },
        ...(settings?.receiptFooter ? [{ text: settings.receiptFooter, align: 'center' } as PrintLine] : []),
      ]
      const res = await printLines(`Racun ${r.invoiceNumber}`, lines)
      if (!res.ok) alert(t('print.failed', { error: res.error ?? '' }))
      else if (res.simulated) alert(t('print.simInvoice'))
    } catch (err) { alert(t('print.prepareError', { error: (err as Error).message })) } finally { setPrinting(false) }
  }

  /** Fiskalni storno računa (P1 audit točka 1) — storno račun + povračilo zaloge + revizija */
  async function stornoReceipt(r: ReceiptT) {
    if (!confirm(t('rcpt.stornoConfirm', { n: r.invoiceNumber, a: fmtEUR(Math.abs(r.total)) }))) return
    setStornoing(r.id)
    try {
      const d = await api<{ invoice: { invoiceNumber: string }; storno: { restoredStockItems: number } }>(`/api/receipts/${r.id}/storno`, { method: 'POST' })
      await load()
      alert(t('rcpt.stornoDone', { n: d.invoice.invoiceNumber, s: d.storno.restoredStockItems }))
    } catch (err) { alert((err as Error).message) } finally { setStornoing(null) }
  }

  /** Ali je ta original že storniran (storno račun je med izdanimi)? — skrije Storno akcijo */
  const isStorned = (id: string) => receipts.some((x) => x.stornoOf === id)

  /* ── 33-a: fire / move / merge (P2 audit §54/§57) ── */
  /** UI odprto naročilo: status != PAID/CANCELLED in ni plačano (paymentStatus iz mapOrder) */
  const isOrderOpenUi = (o: OrderT) => o.status !== 'PAID' && o.status !== 'CANCELLED' && (o.paymentStatus ?? 'unpaid') !== 'paid'
  /** Proste mize iste lokacije (za selitev) — obstoječi `tables` state (statusi UI oblike) */
  const freeTablesFor = (o: OrderT | null) => o
    ? tables.filter((tb) => tb.status === 'FREE' && tb.id !== o.tableId && (!o.locationId || !tb.locationId || tb.locationId === o.locationId))
    : []
  /** Druga odprta naročila iste lokacije (za združevanje) */
  const mergeTargetsFor = (o: OrderT) => orders.filter((x) =>
    x.id !== o.id && isOrderOpenUi(x) && (!o.locationId || !x.locationId || x.locationId === o.locationId))

  /** Fire: pošlje vse pending postavke na kuhinjo (Order.firedAt + OrderItem.status='fired') */
  async function fireOrder(o: OrderT) {
    setMmvBusy(true)
    try {
      const d = await api<{ firedCount: number }>(`/api/orders/${o.id}/fire`, { method: 'POST' })
      await load()
      toast({ title: t('mmv.fireDone', { n: d.firedCount }) })
    } catch (err) {
      toast({ title: t('common.error'), description: (err as Error).message, variant: 'destructive' })
    } finally { setMmvBusy(false) }
  }

  /** Move: selitev naročila na izbrano prosto mizo (stara miza se sprosti) */
  async function moveOrderToTable() {
    if (!moveOrder || !moveTableId) return
    setMmvBusy(true)
    try {
      await api(`/api/orders/${moveOrder.id}/move`, { method: 'POST', body: JSON.stringify({ tableId: moveTableId }) })
      setMoveOrder(null); setMoveTableId('')
      await load()
      toast({ title: t('mmv.moveDone') })
    } catch (err) {
      toast({ title: t('common.error'), description: (err as Error).message, variant: 'destructive' })
    } finally { setMmvBusy(false) }
  }

  /** Merge: postavke tega naročila (vira) se prenesejo na izbrano ciljno naročilo, vir se prekliče */
  async function mergeOrderInto() {
    if (!mergeOrder || !mergeTargetId) return
    setMmvBusy(true)
    try {
      const d = await api<{ mergedItems: number }>(`/api/orders/${mergeOrder.id}/merge`, { method: 'POST', body: JSON.stringify({ targetOrderId: mergeTargetId }) })
      setMergeOrder(null); setMergeTargetId('')
      await load()
      toast({ title: t('mmv.mergeDone', { n: d.mergedItems }) })
    } catch (err) {
      toast({ title: t('common.error'), description: (err as Error).message, variant: 'destructive' })
    } finally { setMmvBusy(false) }
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
    if (!res.ok) alert(t('print.failed', { error: res.error ?? '' }))
    else if (res.simulated) alert(station === 'BAR' ? t('print.simBar') : t('print.simKitchen'))
  }

  async function toggleAvailable(m: MenuT) {
    await api(`/api/menus/${m.id}`, { method: 'PATCH', body: JSON.stringify({ available: !m.available }) })
    await load()
  }

  async function createReservation(allowOutsideHours = false) {
    if (!newRes?.guestName || !newRes.reservedAt) return
    setSending(true)
    try {
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({ guestName: newRes.guestName, phone: newRes.phone, guests: newRes.guests, reservedAt: new Date(newRes.reservedAt).toISOString(), note: newRes.note, allowOutsideHours }),
      })
      setNewRes(null); await load()
    } catch (err) {
      const msg = (err as Error).message
      // triage ⑦: izven odpiralnega časa → ponudi izrecen pregled (audit RESERVATION_OUTSIDE_HOURS)
      if (msg.includes('izven odpiralnega časa')) {
        setSending(false)
        if (confirm(`${msg}\n\n${t('resv.confirmOutside')}`)) {
          await createReservation(true)
        }
        return
      }
      alert(msg)
    } finally { setSending(false) }
  }

  /** OPS-7 (v1.69.0): opomnik rezervaciji (e-mail/SMS) — fail-soft, rezultat v toast */
  async function sendReservationReminder(id: string, guestName: string) {
    setSending(true)
    try {
      const d = await api<{ sent: boolean; channels: { email: { ok: boolean; detail: string }; sms: { ok: boolean; detail: string } } }>(`/api/reservations/${id}/reminder`, { method: 'POST' })
      await load()
      if (d.sent) toast({ title: t('resv.reminderDone'), description: guestName })
      else toast({ title: t('resv.reminderFailed'), description: `${d.channels.email.detail} / ${d.channels.sms.detail}`, variant: 'destructive' })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
  }

  /** OPS-7: serijski opomniki (vseh 24 h) */
  async function sendAllReservationReminders() {
    setSending(true)
    try {
      const d = await api<{ processed: number; sent: number; skipped: number; errors: number }>('/api/reservations/reminders', { method: 'POST', body: JSON.stringify({ hoursBefore: 24 }) })
      await load()
      if (d.processed === 0) toast({ title: t('resv.reminderNone') })
      else toast({ title: t('resv.reminderDone'), description: `${d.sent}/${d.processed}` })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
  }

  async function setReservationStatus(id: string, status: string) {
    setSending(true)
    try {
      await api('/api/reservations', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      await load()
    } catch (err) { alert((err as Error).message) } finally { setSending(false) }
  }

  /** Triage ⑧ — lokacije: shrani (POST nova / PATCH urejanje) */
  async function saveLocation() {
    setLocSaving(true); setLocNotice('')
    try {
      if (locEditing) {
        await api(`/api/locations/${locEditing.id}`, { method: 'PATCH', body: JSON.stringify(locForm) })
      } else {
        await api('/api/locations', { method: 'POST', body: JSON.stringify(locForm) })
      }
      setLocDialogOpen(false)
      await load()
    } catch (err) { setLocNotice(`${t('common.error')}: ${(err as Error).message}`) } finally { setLocSaving(false) }
  }

  /** Triage ⑧ — lokacije: aktivacija/deaktivacija (podatki ostanejo) */
  async function toggleLocationActive(l: LocationRowT) {
    setConfirmLocToggle(null)
    try {
      await api(`/api/locations/${l.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !l.isActive }) })
      await load()
    } catch (err) { alert(`${t('common.error')}: ${(err as Error).message}`) }
  }

  /* ── Employee Control Center akcije ── */

  function openEmployee(e: EmployeeT) {
    setEditEmployee(e)
    setEmpPerms(e.permissionOverrides || [])
    setEmpRole(e.role)
    setEmpActive(e.active)
    setEmpPin('')
    setEmpNotice('')
    setEmpLoc(e.locationId || '')
  }

  async function patchEmployee(payload: Record<string, unknown>, okMsg: string) {
    if (!editEmployee) return
    setEmpSaving(true)
    try {
      const d = await api<{ employee: EmployeeT }>(`/api/employees/${editEmployee.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      setEmpNotice(okMsg)
      setEmployees((list) => list.map((x) => (x.id === d.employee.id ? d.employee : x)))
      setEditEmployee(d.employee)
    } catch (err) { setEmpNotice(`${t('common.error')}: ${(err as Error).message}`) } finally { setEmpSaving(false) }
  }

  /** Vaja PIN-ov: bootstrap seja ustvari trajen admin profil z PIN-om (prehod iz env dostopa na bazo) */
  async function createBootstrapProfile() {
    if (!user?.email) return
    setBootBusy(true); setBootNotice('')
    try {
      await api('/api/employees', { method: 'POST', body: JSON.stringify({ email: user.email, name: bootName, pin: bootPin, role: 'ADMIN' }) })
      setBootNotice(t('emp.bootCreated', { email: user.email }))
      setBootPin(''); await load()
    } catch (err) { setBootNotice(`${t('common.error')}: ${(err as Error).message}`) } finally { setBootBusy(false) }
  }

  const cartTotal = Object.entries(cart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)
  // OPS-7: košarica urejevalnika naročila (NaročiloSheet)
  const sheetCartTotal = Object.entries(sheetCart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)

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

  const menuByCat = categories
    .map((c) => ({ cat: c, items: menu.filter((m) => m.categoryId === c.id) }))
    .concat({ cat: { id: 'ostalo', name: t('menu.other') }, items: menu.filter((m) => !m.categoryId) })
    .filter((g) => g.items.length > 0)
  // Task 51 (UX pregled): naročilni dialog pokaže SAMO artikle lokacije mize —
  // v pogledu vseh lokacij je prej mešal menije različnih lokacij (naročanje
  // tujega artikla = zavrnjeno šele na strežniku → izgubljen klik). Server
  // (ops.ts) ostane avtoritativa; to je UX scoping. Artikli brez lokacije
  // (legacy) ostanejo.
  const orderDialogMenu = useMemo(() => {
    const loc = newOrderTable?.locationId
    if (!loc) return menuByCat
    return menuByCat
      .map((g) => ({ cat: g.cat, items: g.items.filter((m) => !m.locationId || m.locationId === loc) }))
      .filter((g) => g.items.length > 0)
  }, [menuByCat, newOrderTable])
  // cone dinamično iz podatkov (produkcija: main/bar/patio/private; rekonstrukcija: Glavna dvorana/Bar/Terasa)
  const ZONE_LABELS: Record<string, string> = { main: 'Glavna dvorana', bar: 'Bar', patio: 'Terasa', private: 'Zasebna soba' }
  // Dvojezičnost SL/HR — pomožne pretvorbe z SL fallbackom (nedefinirani statusi/vloge/zone ostanejo berljivi)
  const stL = (s: string): string => { const v = t(`status.${s}`); return v === `status.${s}` ? (statusLabels[s] || s) : v }
  const roleL = (r: string): string => { const v = t(`roles.${r}`); return v === `roles.${r}` ? (ROLE_LABELS[r] || r) : v }
  const zoneL = (z: string): string => { const v = t(`zones.${z}`); return v === `zones.${z}` ? (ZONE_LABELS[z] || z) : v }
  // Triage ⑧ — pogledi: preklopnik filtrira sezname (viri brez locationId ostanejo vidni)
  const viewTables = filterByLocation(tables, viewLoc)
  const viewOrders = filterByLocation(orders, viewLoc)
  const viewKitchen = filterByLocation(kitchen, viewLoc)
  const viewEmployees = filterByLocation(employees, viewLoc)
  // OPS-4 v1.67.0 — KDS: stanje postaje/zvoka + hitra prodaja (sank)
  const [kdsStation, setKdsStation] = useState<'ALL' | 'KITCHEN' | 'BAR'>(() => {
    if (typeof window === 'undefined') return 'ALL'
    const s = new URLSearchParams(window.location.search).get('station')
    return s === 'KITCHEN' || s === 'BAR' ? s : 'ALL'
  })
  const [kdsSound, setKdsSound] = useState(true)
  const kdsPrevPendingRef = useRef(0)
  const [saleCart, setSaleCart] = useState<Record<string, number>>({})
  const [saleCat, setSaleCat] = useState('ALL')
  const [saleSearch, setSaleSearch] = useState('')
  const [saleSending, setSaleSending] = useState(false)

  const kdsMinutes = (iso: string): number => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  const kdsAgeClass = (m: number): string => (m >= 10 ? 'bg-red-100 text-red-700 border-red-200' : m >= 5 ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')

  // OPS-4: zvok ob novem cakajocem artiklu na izbrani postaji (WebAudio, brez sredstev)
  useEffect(() => {
    const pending = viewKitchen
      .flatMap((o) => o.items.filter((it) => !it.voided && it.status === 'PENDING' && (kdsStation === 'ALL' || (it.station || 'KITCHEN') === kdsStation)))
      .reduce((s, it) => s + it.qty, 0)
    if (pending > kdsPrevPendingRef.current && kdsSound) {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (Ctx) {
          const ctx = new Ctx()
          const osc = ctx.createOscillator(); const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.frequency.value = 880; gain.gain.value = 0.08
          osc.start()
          setTimeout(() => { try { osc.stop(); void ctx.close() } catch { /* nic kriticnega */ } }, 180)
        }
      } catch { /* zvok ni kriticen */ }
    }
    kdsPrevPendingRef.current = pending
  }, [viewKitchen, kdsStation, kdsSound])

  // OPS-4: 86 (razprodano) iz KDS — ozek endpoint menu.availability (ločen od Meni urejanja = menu.manage)
  const kdsToggleAvailable = async (mi: MenuT) => {
    try {
      await api(`/api/menus/${mi.id}/availability`, { method: 'PATCH', body: JSON.stringify({ available: !mi.available }) })
      await load()
    } catch (err) { alert((err as Error).message) }
  }

  // OPS-4 hitra prodaja (sank): izbira -> kosarica -> POST (TAKEOUT) -> placilni dialog
  const saleItems = menu.filter((mi) =>
    mi.available
    && (saleCat === 'ALL' || mi.categoryId === saleCat)
    && mi.name.toLowerCase().includes(saleSearch.trim().toLowerCase()))
  const saleTotal = Object.entries(saleCart).reduce((s, [id, qty]) => s + (menu.find((x) => x.id === id)?.price ?? 0) * qty, 0)

  // OPS-4 v1.67.0 — tloris lokala (Mize): pogled + vlečenje miz (posX/posY v %)
  const [tableView, setTableView] = useState<'grid' | 'plan'>('grid')
  const [planPos, setPlanPos] = useState<Record<string, { x: number; y: number }>>({})
  const dragIdRef = useRef<string | null>(null)
  const draggedRef = useRef(false)
  // tloris platno: seed/hramba posX/posY je v px na dizajn-platnu 440x380 (prgmta 40..400/40..340);
  // v UI delamo z % in pretvorimo v obe smeri, da je vlečenje perzistentno v istih enotah.
  const PLAN_W = 440
  const PLAN_H = 380
  const planPosOf = (tb: TableT): { x: number; y: number } => {
    const clampPct = (v: number): number => Math.min(97, Math.max(3, v))
    const cached = planPos[tb.id]
    if (cached) return cached
    if (tb.posX || tb.posY) return { x: clampPct((tb.posX ?? 0) / PLAN_W * 100), y: clampPct((tb.posY ?? 0) / PLAN_H * 100) }
    // privzeto (novi mizi brez pozicije): cona = stolpec, miza znotraj cone = vrstica (5 vrst)
    const zi = Math.max(0, [...new Set(viewTables.map((x) => x.zone))].sort().indexOf(tb.zone))
    const zoneTables = viewTables.filter((x) => x.zone === tb.zone)
    const idx = Math.max(0, zoneTables.findIndex((x) => x.id === tb.id))
    return { x: clampPct(15 + (zi % 5) * 17), y: clampPct(16 + (idx % 5) * 18) }
  }
  const planPointerDown = (tb: TableT) => (e: React.PointerEvent<HTMLButtonElement>) => {
    dragIdRef.current = tb.id; draggedRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const planPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const id = dragIdRef.current
    if (!id) return
    draggedRef.current = true
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.round(Math.min(96, Math.max(4, ((e.clientX - rect.left) / rect.width) * 100)))
    const y = Math.round(Math.min(94, Math.max(6, ((e.clientY - rect.top) / rect.height) * 100)))
    setPlanPos((p) => ({ ...p, [id]: { x, y } }))
  }
  const planPointerUp = () => {
    const id = dragIdRef.current
    dragIdRef.current = null
    if (!id || !draggedRef.current) return
    const pos = planPos[id]
    if (!pos) return
    void api(`/api/tables/${id}`, { method: 'PATCH', body: JSON.stringify({ posX: Math.round(pos.x / 100 * PLAN_W), posY: Math.round(pos.y / 100 * PLAN_H) }) }).catch(() => null)
  }

  async function submitSale() {
    const items = Object.entries(saleCart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
    if (items.length === 0) return
    setSaleSending(true)
    try {
      const j = await api<{ order: { id: string } }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ items, type: 'TAKEOUT', guests: 1, clientOperationId: newOperationId() }),
      })
      setSaleCart({})
      const fresh = await api<{ orders: OrderT[] }>('/api/orders')
      setOrders(fresh.orders)
      await load()
      const created = fresh.orders.find((x) => x.id === j.order?.id)
      if (created) void openPayment(created)
    } catch (err) {
      alert((err as Error).message)
    } finally { setSaleSending(false) }
  }
  const zones = [...new Set(viewTables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b))

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
            <Badge variant="outline" className="hidden md:inline-flex shrink-0">{APP_VERSION}</Badge>
            {/* Triage ⑧ — pogledi: preklopnik lokacije za centralne vloge (OWNER/ADMIN) */}
            {isCentralUIRole(user?.role) && locList.length > 0 && (
              <Select value={viewLoc || 'all'} onValueChange={(v) => setViewLoc(v === 'all' ? '' : v)}>
                <SelectTrigger className="h-8 w-[120px] sm:w-[190px] gap-1.5 text-xs" aria-label={t('header.viewAria')}>
                  <MapPin className="w-3.5 h-3.5 shrink-0 text-emerald-700" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('header.allLocations')}</SelectItem>
                  {locList.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}{!l.isActive ? t('header.inactive') : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* online/offline/sync status (issue #1) — klik za ročno sinhronizacijo */}
            <button
              type="button"
              onClick={() => void doSync()}
              title={t('header.syncHint')}
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
              <span>{!online ? `${t('header.offline')}${queueOps.length ? ` · ${queueOps.length}` : ''}` : syncing ? t('header.syncing') : queueOps.length > 0 ? t('header.queued', { n: queueOps.length }) : t('header.online')}</span>
            </button>
            <ThemeToggle />
            <LanguageToggle />
            {/* OPS-7 (v1.70.0): push obvestila — en klik za omogočitev (nova naročila → kuhinja, pripravljeno → natakar) */}
            {pushState !== 'granted' && pushState !== 'unsupported' && (
              <Button variant="ghost" size="icon" onClick={() => void enablePush()} aria-label={t('push.enable')} title={t('push.enable')}>
                <Bell className="w-4 h-4" />
              </Button>
            )}
            <PaletteButton onClick={() => setPaletteOpen(true)} />
            <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPaletteOpen(true)} aria-label={t('header.commands')}>
              <Search className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={load} aria-label={t('common.refresh')}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <span className="text-sm text-stone-600 hidden sm:block truncate max-w-40">{user?.name}</span>
            <Button variant="ghost" size="icon" onClick={() => setConfirmLogout(true)} aria-label={t('header.logout')}><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="w-full justify-start overflow-x-auto h-auto flex-nowrap bg-white border border-stone-200 p-1">
            {([
              ['pregled', t('tabs.pregled'), LayoutDashboard], ['mize', t('tabs.mize'), Utensils], ['narocila', t('tabs.narocila'), ClipboardList],
              ['prodaja', t('tabs.prodaja'), Zap], ['kuhinja', t('tabs.kuhinja'), ChefHat], ['meni', t('tabs.meni'), BookOpen], ['rezervacije', t('tabs.rezervacije'), CalendarDays],
              ['racuni', t('tabs.racuni'), ReceiptText], ['inzeniring', t('tabs.inzeniring'), ChartScatter], ['popusti', t('tabs.popusti'), Percent], ['integracije', t('tabs.integracije'), Plug], ['zaloge', t('tabs.zaloge'), PackageSearch], ['izmene', t('tabs.izmene'), Clock],
              ['delovnicas', t('tabs.delovnicas'), Timer],
              ['urnik', t('tabs.urnik'), CalendarRange],
              ['haccp', t('tabs.haccp'), Thermometer], ['stroski', t('tabs.stroski'), Wallet], ['zvestoba', t('tabs.zvestoba'), HeartHandshake],
              ['mnenja', t('tabs.mnenja'), Star], ['dostava', t('tabs.dostava'), Truck], ['napitnine', t('tabs.napitnine'), Coins], ['nabava', t('tabs.nabava'), ShoppingCart], ['darilne', t('tabs.darilne'), Gift], ['odpad', t('tabs.odpad'), Trash2], ['cakalna', t('tabs.cakalna'), Hourglass], ['odpiralnicas', t('tabs.odpiralnicas'), CalendarClock], ['zaposleni', t('tabs.zaposleni'), Users], ['nastavitve', t('tabs.nastavitve'), Settings], ['enterprise', t('tabs.enterprise'), Building2],
            ] as [string, string, typeof LayoutDashboard | null][])
              // UI gating po dovoljenjih (issue #1, naloga 3) — backend uveljavlja neodvisno;
              // N8 fail-closed: vsak zavihek ima izrecen vnos v TAB_PERM (src/lib/tab-permissions.ts),
              // neznan/undefined id → zavihek NI viden
              .filter(([v]) => tabHasPerm(v, { canManage, perms }))
              .map(([v, , Icon]) => (
              <TabsTrigger key={v} value={v} className="gap-1.5 data-[state=active]:bg-emerald-700 data-[state=active]:text-white whitespace-nowrap">
                {Icon && <Icon className="w-4 h-4" />} {t(`tabs.${v}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="pregled" className="space-y-6">
            {viewLoc && (
              <p className="text-sm text-stone-500 flex items-center gap-1.5" aria-live="polite">
                <MapPin className="w-4 h-4 text-emerald-700" /> {t('dash.viewLabel', { name: locList.find((l) => l.id === viewLoc)?.name || t('dash.locationFallback') })}
              </p>
            )}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                [t('dash.activeOrders'), stats?.activeOrders, ClipboardList], [t('dash.openTables'), stats?.openTables, Utensils],
                [t('dash.todayRevenue'), stats ? fmtEUR(stats.todayRevenue) : undefined, Banknote], [t('dash.todayOrders'), stats?.todayOrders, ReceiptText],
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
              <CardHeader><CardTitle className="text-base">{t('dash.activeOrders')}</CardTitle></CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {viewOrders.slice(0, 6).map((o) => (
                    <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{o.table?.name || o.type}</p>
                        <p className="text-xs text-stone-500">{t('dash.itemsCount', { n: o.items.length, name: o.employee?.name || '—' })}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-bold">{fmtEUR(o.total)}</p>
                        <Badge className={`mt-1 ${statusColors[o.status]}`}>{stL(o.status)}</Badge>
                      </div>
                    </div>
                  ))}
                  {viewOrders.length === 0 && <p className="text-sm text-stone-500">{t('orders.none')}</p>}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="mize" className="space-y-6">
            {/* OPS-4 v1.67.0 — tloris lokala: vizualni prikaz miz + vlečenje (shema posX/posY) */}
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant={tableView === 'grid' ? 'default' : 'outline'} className={tableView === 'grid' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('grid')}>{t('tables.gridView')}</Button>
              <Button size="sm" variant={tableView === 'plan' ? 'default' : 'outline'} className={tableView === 'plan' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('plan')}>{t('tables.planView')}</Button>
              {tableView === 'plan' && <span className="text-xs text-stone-500">{t('tables.planHint')}</span>}
            </div>
            {tableView === 'plan' && (
              <div
                className="relative w-full rounded-xl border border-stone-200 bg-stone-100/70 overflow-hidden touch-none"
                style={{ aspectRatio: '16 / 10' }}
                onPointerMove={planPointerMove}
                onPointerUp={planPointerUp}
              >
                {viewTables.map((tb) => {
                  const pos = planPosOf(tb)
                  return (
                    <button
                      key={tb.id}
                      onPointerDown={planPointerDown(tb)}
                      onClick={() => {
                        if (draggedRef.current) { draggedRef.current = false; return }
                        if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
                        if (!tb.activeOrder) { setCart({}); setNewOrderTable(tb) } else { const o = orders.find((x) => x.id === tb.activeOrder!.id); if (o) void openOrderSheet(o) }
                      }}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-lg shadow px-2 py-1.5 text-[11px] font-bold cursor-grab active:cursor-grabbing ${statusColors[tb.status] ?? 'bg-stone-500 text-white'}`}
                      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                      aria-label={tb.name}
                    >
                      {tb.name}{tb.activeOrder ? ` · ${fmtEUR(tb.activeOrder.total)}` : ''}
                    </button>
                  )
                })}
              </div>
            )}
            {zones.map((zone) => {
              const zt = viewTables.filter((t) => t.zone === zone)
              if (zt.length === 0) return null
              return (
                <section key={zone} className="space-y-3">
                  <h2 className="font-semibold text-stone-700">{zoneL(zone)}</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {zt.map((tb) => (
                      <div key={tb.id} className="relative">
                        <button
                          onClick={() => {
                            // miza za pospravit → en klik = očisti (issue #1: e2e zaključek)
                            if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
                            if (!tb.activeOrder) { setCart({}); setNewOrderTable(tb) } else { const o = orders.find((x) => x.id === tb.activeOrder!.id); if (o) void openOrderSheet(o) }
                          }}
                          className={`w-full rounded-xl p-4 text-left shadow transition ${statusColors[tb.status]} min-h-20`}
                        >
                          <p className="font-bold text-lg">{tb.name}</p>
                          <p className="text-xs opacity-90">{t('tables.seats', { n: tb.seats })}</p>
                          {tb.activeOrder && <p className="text-xs mt-1 font-semibold">{fmtEUR(tb.activeOrder.total)}</p>}
                          <p className="text-[11px] mt-1 opacity-80">{tb.activeOrder ? stL('OCCUPIED') : tb.status === 'DIRTY' ? t('tables.clickClean') : stL(tb.status)}</p>
                        </button>
                        {/* Issue #3: QR meni za to mizo — (span, ker gosta ne sme biti gnezdena v gumbu) */}
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('tables.qrAria', { name: tb.name })}
                          onClick={(e) => { e.stopPropagation(); void openQr(tb) }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void openQr(tb) } }}
                          className="absolute top-1.5 right-1.5 rounded-md bg-white/85 p-1 text-stone-600 hover:bg-white hover:text-stone-900 cursor-pointer shadow-sm"
                        >
                          <QrCode className="w-4 h-4" />
                        </span>
                        {/* Issue #1 §6: status mize — upravljanje (na voljo / rezervirana / za pospravit) */}
                        {!tb.activeOrder && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label={t('tables.statusAria', { name: tb.name })}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
                                className="absolute bottom-1.5 right-1.5 rounded-md bg-white/85 p-1 text-stone-600 hover:bg-white hover:text-stone-900 cursor-pointer shadow-sm"
                              >
                                <MoreVertical className="w-4 h-4" />
                              </span>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={() => void setTableStatus(tb, 'FREE')}>{t('tables.available')}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void setTableStatus(tb, 'RESERVED')}>{t('tables.reserved')}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void setTableStatus(tb, 'DIRTY')}>{t('tables.dirty')}</DropdownMenuItem>
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
                <DialogTitle className="flex items-center gap-1.5"><QrCode className="w-4 h-4" /> {t('tables.qrMenu')} — {qrTable?.name}</DialogTitle>
              </DialogHeader>
              {qrBusy || !qrData ? (
                <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>
              ) : (
                <div className="space-y-3 text-sm">
                  <img src={qrData.dataUrl} alt={t('tables.qrAria', { name: qrTable?.name || '' })} className="mx-auto rounded-xl border border-stone-200 w-52 h-52" />
                  <p className="text-xs text-stone-500 break-all text-center select-all">{qrData.url}</p>
                  <div className="flex items-center justify-between rounded-lg border border-stone-200 p-2.5">
                    <span className="font-medium">{t('tables.qrOrdering')}</span>
                    <Switch checked={qrData.qrEnabled} onCheckedChange={(v) => void qrAction('toggle', v)} />
                  </div>
                  <Button variant="outline" className="w-full" disabled={qrBusy} onClick={() => void qrAction('rotate')}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> {t('tables.qrNew')}
                  </Button>
                  <p className="text-[11px] text-stone-400">{t('tables.qrHint')}</p>
                </div>
              )}
            </DialogContent>
          </Dialog>

          <TabsContent value="narocila">
            <Card>
              <CardHeader><CardTitle className="text-base">{t('orders.allActive')}</CardTitle></CardHeader>
              <CardContent>
                {/* OPS-7 (v1.70.0): filtri stanj (Lightspeed/Square vzorec — hiter pregled vrste) */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {(['ALL', 'OPEN', 'SENT', 'PREPARED'] as const).map((f) => (
                    <Button key={f} size="sm" variant={orderFilter === f ? 'default' : 'outline'}
                      className={orderFilter === f ? 'h-7 text-xs bg-emerald-700 hover:bg-emerald-800 text-white' : 'h-7 text-xs'}
                      onClick={() => setOrderFilter(f)}>
                      {f === 'ALL' ? t('orders.filterAll') : stL(f)}
                    </Button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                {viewOrders.filter((o) => orderFilter === 'ALL' || o.status === orderFilter).map((o) => (
                  <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">{o.table?.name || o.type} · {o.guests} {t('orders.persons')}</p>
                      <Badge className={statusColors[o.status]}>{stL(o.status)}</Badge>
                    </div>
                    <ScrollArea className="max-h-32">
                      <ul className="text-sm space-y-1">{o.items.map((it) => <li key={it.id} className="flex justify-between"><span>{it.qty}× {it.name}</span><span>{fmtEUR(it.qty * it.unitPrice)}</span></li>)}</ul>
                    </ScrollArea>
                    <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                      <p className="font-bold">{fmtEUR(o.total)}</p>
                      {o.status !== 'PAID' && (
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => void openOrderSheet(o)} title={t('orders.edit')}>
                            <Pencil className="w-3.5 h-3.5" /> {t('orders.edit')}
                          </Button>
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void openPayment(o)}>
                            <Banknote className="w-3.5 h-3.5" /> {t('orders.payFurs')}
                          </Button>
                        </div>
                      )}
                    </div>
                    {/* 33-a: fire / move / merge — samo za odprta, neplačana naročila (backend uveljavlja orders.create) */}
                    {hasPerm('orders.create') && isOrderOpenUi(o) && (
                      <div className="flex flex-wrap gap-1.5">
                        {o.items.some((it) => it.status === 'PENDING' && !it.voided) && (
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                            disabled={mmvBusy} onClick={() => void fireOrder(o)} title={t('mmv.fire')}>
                            <Flame className="w-3 h-3" /> {t('mmv.fire')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={mmvBusy}
                          onClick={() => { setMoveTableId(''); setMoveOrder(o) }} title={t('mmv.move')}>
                          <ArrowRightLeft className="w-3 h-3" /> {t('mmv.move')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"
                          disabled={mmvBusy || mergeTargetsFor(o).length === 0}
                          onClick={() => { setMergeTargetId(''); setMergeOrder(o) }} title={t('mmv.merge')}>
                          <GitMerge className="w-3 h-3" /> {t('mmv.merge')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {viewOrders.length === 0 && <p className="text-sm text-stone-500">{t('orders.none')}</p>}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 33-a: selitev naročila na drugo mizo (P2 audit §54) */}
          <Dialog open={!!moveOrder} onOpenChange={(op) => { if (!op) { setMoveOrder(null); setMoveTableId('') } }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><ArrowRightLeft className="w-4 h-4" /> {t('mmv.moveTitle')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-stone-500">{t('mmv.moveHint', { name: moveOrder?.table?.name || moveOrder?.type || '' })}</p>
                <Select value={moveTableId} onValueChange={setMoveTableId}>
                  <SelectTrigger aria-label={t('mmv.targetPlaceholder')}><SelectValue placeholder={t('mmv.targetPlaceholder')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {freeTablesFor(moveOrder).map((tb) => (
                      <SelectItem key={tb.id} value={tb.id}>{tb.name} · {t('tables.seats', { n: tb.seats })}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {moveOrder && freeTablesFor(moveOrder).length === 0 && <p className="text-xs text-stone-400">{t('mmv.noFreeTables')}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setMoveOrder(null); setMoveTableId('') }}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={mmvBusy || !moveTableId} onClick={() => void moveOrderToTable()}>
                  {mmvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mmv.moveConfirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* 33-a: združevanje naročil (P2 audit §54) — vir (ta kartica) se prenese na izbrano ciljno naročilo */}
          <Dialog open={!!mergeOrder} onOpenChange={(op) => { if (!op) { setMergeOrder(null); setMergeTargetId('') } }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><GitMerge className="w-4 h-4" /> {t('mmv.mergeTitle')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-stone-500">{t('mmv.mergeHint')}</p>
                <Select value={mergeTargetId} onValueChange={setMergeTargetId}>
                  <SelectTrigger aria-label={t('mmv.mergePlaceholder')}><SelectValue placeholder={t('mmv.mergePlaceholder')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {mergeOrder && mergeTargetsFor(mergeOrder).map((x) => (
                      <SelectItem key={x.id} value={x.id}>{x.table?.name || x.type} · {fmtEUR(x.total)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {mergeOrder && mergeTargetsFor(mergeOrder).length === 0 && <p className="text-xs text-stone-400">{t('mmv.noOtherOrders')}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setMergeOrder(null); setMergeTargetId('') }}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={mmvBusy || !mergeTargetId} onClick={() => void mergeOrderInto()}>
                  {mmvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('mmv.mergeConfirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <TabsContent value="prodaja" className="space-y-4">
            {/* OPS-4 v1.67.0 — Hitra prodaja (sank): izbira -> kosarica -> racun (FURS) */}
            <div className="flex flex-wrap items-center gap-2">
              <Input value={saleSearch} onChange={(e) => setSaleSearch(e.target.value)} placeholder={t('sale.search')} className="w-full sm:w-64" />
              <Select value={saleCat} onValueChange={setSaleCat}>
                <SelectTrigger className="w-full sm:w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('sale.allCat')}</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {saleItems.map((mi) => (
                <button key={mi.id} disabled={!mi.available} onClick={() => setSaleCart((pr) => ({ ...pr, [mi.id]: (pr[mi.id] || 0) + 1 }))}
                  className={`rounded-xl border p-3 text-left min-h-16 transition ${mi.available ? 'border-stone-200 bg-white hover:border-emerald-600 hover:shadow' : 'border-stone-200 bg-stone-100 opacity-60 cursor-not-allowed'}`}>
                  <p className="font-medium text-sm leading-tight">{mi.name}</p>
                  <p className="text-xs text-stone-500 mt-1">{fmtEUR(mi.price)}</p>
                  {!mi.available && <Badge variant="outline" className="mt-1 text-[10px]">86</Badge>}
                </button>
              ))}
            </div>
            {saleItems.length === 0 && <p className="text-sm text-stone-500">{t('sale.empty')}</p>}
            {Object.keys(saleCart).length > 0 && (
              <Card className="sticky bottom-4 shadow-lg">
                <CardContent className="p-4 space-y-2">
                  {Object.entries(saleCart).map(([id, qty]) => {
                    const mi = menu.find((x) => x.id === id)
                    if (!mi) return null
                    return (
                      <div key={id} className="flex items-center gap-2 text-sm">
                        <span className="flex-1 truncate">{qty}× {mi.name}</span>
                        <Button size="sm" variant="outline" className="h-7 w-7 p-0" aria-label="-1" onClick={() => setSaleCart((pr) => { const q = (pr[id] || 0) - 1; const nx = { ...pr }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })}>−</Button>
                        <Button size="sm" variant="outline" className="h-7 w-7 p-0" aria-label="+1" onClick={() => setSaleCart((pr) => ({ ...pr, [id]: (pr[id] || 0) + 1 }))}>+</Button>
                        <span className="w-20 text-right font-medium">{fmtEUR(mi.price * qty)}</span>
                      </div>
                    )
                  })}
                  <div className="flex items-center justify-between border-t border-stone-200 pt-2 font-bold">
                    <span>{t('sale.total')}</span><span>{fmtEUR(saleTotal)}</span>
                  </div>
                  <Button className="w-full bg-emerald-700 hover:bg-emerald-800 min-h-12 text-base font-bold" disabled={saleSending} onClick={() => void submitSale()}>
                    {saleSending ? <Loader2 className="w-5 h-5 animate-spin" /> : t('sale.payNow')}
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="kuhinja" className="space-y-4">
            {/* OPS-4 v1.67.0 — KDS upgrade: filtri postaj (zaslon sank = BAR), casovniki, zvok, 86 */}
            <div className="flex flex-wrap items-center gap-2">
              {(['ALL', 'KITCHEN', 'BAR'] as const).map((st) => (
                <Button key={st} size="sm" variant={kdsStation === st ? 'default' : 'outline'} className={kdsStation === st ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setKdsStation(st)}>
                  {st === 'ALL' ? t('kds.all') : st === 'KITCHEN' ? t('menu.stationKitchen') : t('menu.stationBar')}
                </Button>
              ))}
              <span className="flex-1" />
              <label className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
                <Switch checked={kdsSound} onCheckedChange={setKdsSound} aria-label={t('kds.sound')} />
                <Volume2 className="w-3.5 h-3.5" /> {t('kds.sound')}
              </label>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.() }}>
                <Maximize2 className="w-3.5 h-3.5" /> {t('kds.fullscreen')}
              </Button>
            </div>
            {viewKitchen
              .filter((o) => o.items.some((it) => !it.voided && (kdsStation === 'ALL' || (it.station || 'KITCHEN') === kdsStation)))
              .map((o) => {
                const items = o.items.filter((it) => !it.voided && (kdsStation === 'ALL' || (it.station || 'KITCHEN') === kdsStation))
                const ageMin = kdsMinutes(o.createdAt)
                return (
                  <Card key={o.id}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                        {o.table?.name || o.type} <span className="text-xs font-normal text-stone-500">#{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI')}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${kdsAgeClass(ageMin)}`}>{t('kds.minutes', { m: ageMin })}</span>
                        <span className="ml-auto flex gap-1.5">
                          <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => void printKitchenTicket(o, 'KITCHEN')} title={t('kitchen.printKitchenTitle')}>
                            <Printer className="w-3 h-3" /> {t('kitchen.kitchenTicket')}
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1 h-7 text-xs" onClick={() => void printKitchenTicket(o, 'BAR')} title={t('kitchen.printBarTitle')}>
                            <Printer className="w-3 h-3" /> {t('kitchen.barTicket')}
                          </Button>
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {items.map((it) => {
                        const mi = menu.find((x) => x.name === it.name && (x.station || 'KITCHEN') === (it.station || 'KITCHEN'))
                        return (
                          <div key={it.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2">
                            <div className="min-w-0">
                              <p className="font-medium truncate">{it.qty}× {it.name} <Badge variant="outline" className="ml-1">{it.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</Badge></p>
                              {it.note && <p className="text-xs text-stone-500">ℹ {it.note}</p>}
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              {perms.includes('menu.availability') && mi && (
                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-stone-500 hover:text-red-700" title={mi.available ? t('kds.markUnavailable') : t('kds.markAvailable')} onClick={() => void kdsToggleAvailable(mi)}>
                                  <EyeOff className="w-3.5 h-3.5" />{mi.available ? '' : '86'}
                                </Button>
                              )}
                              {it.status === 'PENDING' && <Button size="sm" variant="outline" onClick={() => setItemStatus(it.id, 'PREPARING')}>{t('kitchen.start')}</Button>}
                              {(it.status === 'PENDING' || it.status === 'PREPARING') && <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" onClick={() => setItemStatus(it.id, 'READY')}>{t('status.PREPARED')}</Button>}
                              {it.status === 'READY' && (
                                <div className="flex items-center gap-1.5">
                                  <Badge className={statusColors.READY}>{t('status.READY')}</Badge>
                                  {/* OPS-7 (v1.70.0): SERVED bump (Lightspeed vzorec — izloči iz vrste) */}
                                  <Button size="sm" variant="outline" onClick={() => setItemStatus(it.id, 'SERVED')}>{t('status.SERVED')}</Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </CardContent>
                  </Card>
                )
              })}
            {viewKitchen.filter((o) => o.items.some((it) => !it.voided && (kdsStation === 'ALL' || (it.station || 'KITCHEN') === kdsStation))).length === 0 && <p className="text-sm text-stone-500">{t('kitchen.queueEmpty')}</p>}
            {/* OPS-8 v1.71.0 — KDS statistika (leni doseg; live plošča ostaja nedotaknjena) */}
            <KdsStatsSection />
          </TabsContent>

          <TabsContent value="meni" className="space-y-4">
            {menuByCat.map((g) => (
              <section key={g.cat.id} className="space-y-2">
                <h2 className="font-semibold text-stone-700">{g.cat.name}</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((m) => (
                    <div key={m.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0"><p className="font-medium truncate">{m.name}</p><p className="text-sm text-stone-500">{fmtEUR(m.price)} · {m.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</p></div>
                      <Button size="sm" variant={m.available ? 'outline' : 'secondary'} onClick={() => toggleAvailable(m)}>{m.available ? t('menu.inStock') : t('menu.outOfStock')}</Button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </TabsContent>

          <TabsContent value="rezervacije" className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-stone-700">{t('resv.upcoming')}</h2>
              {canRes && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="gap-1" disabled={sending} onClick={() => void sendAllReservationReminders()}>
                    <Bell className="w-3.5 h-3.5" /> {t('resv.reminderAll')}
                  </Button>
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setNewRes({ guestName: '', phone: '', guests: 2, reservedAt: '', note: '' })}>
                    <Plus className="w-3.5 h-3.5" /> {t('resv.new')}
                  </Button>
                </div>
              )}
            </div>
            <Card>
              <CardContent className="pt-4">
                {upcomingRes.length === 0 && <p className="text-sm text-stone-500">{t('resv.empty')}</p>}
                <div className="grid gap-2 sm:grid-cols-2">
                  {upcomingRes.map((r) => (
                    <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{r.guestName} <span className="text-xs text-stone-400">· {r.guests} {t('orders.persons')}</span></p>
                        <p className="text-xs text-stone-500">{new Date(r.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{r.phone ? ` · ${r.phone}` : ''}</p>
                        {r.note && <p className="text-xs text-stone-400 truncate">ℹ {r.note}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline">{RES_STATUS_KEYS[r.status] ? t(RES_STATUS_KEYS[r.status]) : r.status}</Badge>
                        {canRes && (
                          <>
                            {r.reminderSent ? (
                              <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 gap-1"><Bell className="w-3 h-3" /> {t('resv.reminderSent')}</Badge>
                            ) : (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" disabled={sending} onClick={() => void sendReservationReminder(r.id, r.guestName)} title={t('resv.reminderSend')}>
                                <Bell className="w-3 h-3" /> {t('resv.reminderSend')}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={sending} onClick={() => setReservationStatus(r.id, 'SEATED')}>{t('resv.seatedBtn')}</Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-amber-700 border-amber-200 hover:bg-amber-50" disabled={sending} onClick={() => setReservationStatus(r.id, 'CANCELLED')}>{t('common.cancel')}</Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="popusti" className="space-y-4">
            <DiscountsTab canManage={canManage} />
          </TabsContent>
          <TabsContent value="integracije" className="space-y-4">
            <IntegracijeTab canManage={canManage} />
          </TabsContent>
          <TabsContent value="enterprise" className="space-y-4">
            <EnterpriseTab canManage={canManage} />
          </TabsContent>

          <TabsContent value="racuni" className="space-y-4">
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => {
                const d = new Date()
                downloadCSV(`racuni-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
                  [t('rcpt.csvNumber'), t('exp.csvDate'), t('wl.thTable'), t('rcpt.csvOrder'), t('rcpt.csvPayMethod'), t('exp.csvAmount'), 'EOR', 'FURS'],
                  ...receipts.map((r) => [r.invoiceNumber, new Date(r.createdAt).toLocaleString('sl-SI'), r.tableName || '', r.orderNumber ?? '', r.paymentMethod.toUpperCase(), r.total, r.eor, r.fiscalVerified ? 'verified' : r.fiscalStatus]),
                ])
              }}>
                {t('rcpt.exportCsv')}
              </Button>
            </div>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t('rcpt.title')}</CardTitle></CardHeader>
              <CardContent>
                {receipts.length === 0 && <p className="text-sm text-stone-500">{t('rcpt.none')}</p>}
                <ScrollArea className="max-h-[60vh]">
                  <div className="space-y-2">
                    {receipts.map((r) => (
                      <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.invoiceNumber}{r.tableName ? ` · ${r.tableName}` : ''}</p>
                          <p className="text-xs text-stone-500">{new Date(r.createdAt).toLocaleString('sl-SI')} · {r.paymentMethod.toUpperCase()}{r.orderNumber ? ` · ${t('rcpt.orderShort', { n: r.orderNumber })}` : ''}</p>
                          <p className="text-[11px] text-stone-400 font-mono truncate max-w-xs sm:max-w-md">EOR: {r.eor}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold">{fmtEUR(r.total)}</p>
                          {r.fiscalVerified ? (
                            <Badge className="bg-emerald-600 text-white">FURS ✓</Badge>
                          ) : (
                            <Badge variant="outline">{r.fiscalStatus || t('rcpt.unverified')}</Badge>
                          )}
                        </div>
                        <div className="shrink-0 flex items-center gap-1 w-full sm:w-auto justify-end">
                          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={printing} onClick={() => printInvoice(r.id)} title={t('payment.printTitle')}>
                            <Printer className="w-3.5 h-3.5" /> {t('common.print')}
                          </Button>
                          {!r.isStorno && !isStorned(r.id) && hasPerm('furs.issue') && (
                            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-red-700 border-red-200 hover:bg-red-50" disabled={stornoing === r.id}
                              onClick={() => stornoReceipt(r)} title={t('rcpt.stornoBtn')}>
                              <Ban className="w-3.5 h-3.5" /> {stornoing === r.id ? t('common.processing') : t('rcpt.stornoBtn')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
            <AccountingExportCard />
          </TabsContent>

          <TabsContent value="inzeniring" className="space-y-4">
            {/* OPS-8 v1.71.0 — menu engineering (Kasavana-Smith kvadrant) */}
            <MenuEngineeringTab />
          </TabsContent>

          <TabsContent value="zaloge">
            <InventoryTab items={inventory} suppliers={suppliers} recipes={recipes} menuItems={menu.map((m) => ({ id: m.id, name: m.name }))} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="izmene">
            <ShiftsTab shifts={shifts} financial={financial} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="delovnicas">
            {/* ura je za VSE zaposlene (TAB_PERM: '*'); ekipni del je gating employees.manage */}
            <DelovniCasTab canManage={hasPerm('employees.manage')} />
          </TabsContent>

          <TabsContent value="urnik">
            {/* OPS-7: urnik izmen — pogled za vse (svoje izmene), urejanje gating timeclock.manage */}
            <StaffScheduleTab employees={employees.map((e) => ({ id: e.id, name: e.name, role: e.role, active: e.active }))} canManage={hasPerm('timeclock.manage')} />
          </TabsContent>

          <TabsContent value="haccp">
            <HaccpTab checks={haccp} onReload={load} />
          </TabsContent>

          <TabsContent value="stroski">
            <ExpensesTab expenses={expenses} canManage={canManage} onReload={load} categoriesEnabled={expCatsEnabled} />
          </TabsContent>

          <TabsContent value="zvestoba">
            <LoyaltyTab accounts={loyalty} canManage={canManage} onReload={load} />
          </TabsContent>

          <TabsContent value="mnenja">
            <FeedbackTab feedback={feedback} tables={viewTables.map((t) => ({ id: t.id, name: t.name }))} />
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

          <TabsContent value="odpiralnicas">
            {/* status viden vsem; urejanje je gating settings.manage */}
            <OdpiralniCasTab canManage={hasPerm('settings.manage')} />
          </TabsContent>

          <TabsContent value="zaposleni" className="space-y-4">
            {canManage && bootstrapLogin && (
              <Card className="border-amber-300 bg-amber-50">
                <CardContent className="py-3 flex items-start gap-2.5">
                  <KeyRound className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                  <div className="text-sm text-amber-800 min-w-0 space-y-2">
                    <p className="font-medium">{t('emp.bootstrapActive')}</p>
                    {bootNotice && <p className={`text-xs font-medium rounded-md px-2 py-1 ${bootNotice.startsWith(t('common.error')) ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}`}>{bootNotice}</p>}
                    {employees.every((e) => e.email?.toLowerCase() !== user?.email?.toLowerCase()) ? (
                      <>
                        <p className="text-xs text-amber-700">{t('emp.bootNoProfileA')} <span className="font-medium">{user?.email}</span> {t('emp.bootNoProfileB')}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Input value={bootName} onChange={(e) => setBootName(e.target.value)} placeholder={t('emp.bootNamePlaceholder')} className="max-w-48 h-9 bg-white" />
                          <Input inputMode="numeric" maxLength={8} value={bootPin} onChange={(e) => setBootPin(e.target.value.replace(/\D/g, ''))} placeholder={t('emp.bootPinPlaceholder')} className="max-w-28 h-9 bg-white" />
                          <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100 h-9" title={t('emp.randomPinTitle')} onClick={() => setBootPin(String(Math.floor(100000 + Math.random() * 900000)))}>
                            <Dices className="w-4 h-4" />
                          </Button>
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 h-9" disabled={bootBusy || !bootName || bootPin.length < 4} onClick={createBootstrapProfile}>
                            {bootBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('emp.bootCreate')}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-amber-700">{t('emp.bootExisting')}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-1.5"><UserCog className="w-4 h-4" /> {t('tabs.zaposleni')}{canManage ? t('emp.controlCenter') : ''}</CardTitle>
                {canManage && <span className="text-xs text-stone-400 hidden sm:inline">{t('emp.clickToEdit')}</span>}
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                {viewEmployees.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => canManage && openEmployee(e)}
                    disabled={!canManage}
                    className={`flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 bg-white text-left ${canManage ? 'hover:border-emerald-600 hover:shadow-sm transition' : 'cursor-default'}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.name}{!e.active && <span className="ml-1.5 text-xs text-red-600">{t('emp.inactiveSuffix')}</span>}</p>
                      <p className="text-xs text-stone-500 truncate">{e.email}</p>
                      {locList.find((l) => l.id === e.locationId)?.name && (
                        <p className="text-[11px] text-stone-400 flex items-center gap-0.5"><MapPin className="w-3 h-3" /> {locList.find((l) => l.id === e.locationId)?.name}</p>
                      )}
                      {(e.permissionOverrides?.length || 0) > 0 && (
                        <p className="text-[11px] text-emerald-700 flex items-center gap-0.5"><ShieldCheck className="w-3 h-3" /> {t('emp.permsCount', { n: e.permissionOverrides.length })}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline">{roleL(e.role)}</Badge>
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
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Printer className="w-4 h-4" /> {t('print.deviceTitle')}</CardTitle></CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="text-xs text-stone-500">{t('print.deviceDesc')}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>{t('print.target')}</Label>
                    <Select value={pcfg.target} onValueChange={(v) => setPcfg((c) => ({ ...c, target: v as PrintTarget }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="browser">{t('print.targetBrowser')}</SelectItem>
                        <SelectItem value="agent">{t('print.targetAgent')}</SelectItem>
                        <SelectItem value="simulator">{t('print.targetSim')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('print.hostLabel')}</Label>
                    <Input value={pcfg.host} onChange={(e) => setPcfg((c) => ({ ...c, host: e.target.value }))} placeholder={t('print.hostPlaceholder')} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('print.portLabel')}</Label>
                    <Input inputMode="numeric" value={String(pcfg.port)} onChange={(e) => setPcfg((c) => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 9100 }))} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('print.terminal')}</Label>
                    <Select value={termMode} onValueChange={(v) => setTermMode(v as TerminalMode)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('print.termNone')}</SelectItem>
                        <SelectItem value="simulator">{t('print.termSim')}</SelectItem>
                        <SelectItem value="manual">{t('print.termManual')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => { savePrintConfig(pcfg); saveTerminalConfig({ mode: termMode }); alert(t('print.saved')) }}>{t('common.save')}</Button>
                    <Button size="sm" variant="outline" className="gap-1" onClick={async () => {
                      const res = await printLines(t('print.testBtn'), [
                        { text: t('print.testLine1') },
                        { text: t('print.testLine2'), bold: true },
                        { text: new Date().toLocaleString('sl-SI') },
                      ])
                      if (!res.ok) alert(t('print.failed', { error: res.error ?? '' }))
                      else if (res.simulated) alert(t('print.simTest'))
                      else alert(t('print.sent'))
                    }}>
                      <Printer className="w-3.5 h-3.5" /> {t('print.testBtn')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-base flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {t('loc.title')}</CardTitle>
                  {hasPerm('settings.manage') && (
                    <Button size="sm" variant="outline" className="gap-1 h-8" onClick={() => { setLocEditing(null); setLocForm({ name: '', code: '', address: '', city: '', postCode: '', country: 'SI', phone: '', email: '', premisesId: '', timezone: 'Europe/Ljubljana', currency: 'EUR', isActive: true }); setLocNotice(''); setLocDialogOpen(true) }}>
                      <Plus className="w-3.5 h-3.5" /> {t('loc.new')}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-2">
                  {locList.length === 0 && locStats.length === 0 && <p className="text-sm text-stone-500">{t('loc.none')}</p>}
                  {(locList.length > 0 ? locList : locStats.map((s) => ({ id: s.id, name: s.name, code: '', address: '', city: '', postCode: '', country: '', phone: '', email: '', premisesId: '', timezone: '', currency: '', isActive: true }))).map((l) => {
                    const st = locStats.find((s) => s.id === l.id)
                    return (
                      <div key={l.id} className={`rounded-lg border p-3 flex items-center justify-between gap-2 ${l.isActive ? 'border-stone-200 bg-white' : 'border-stone-200 bg-stone-50'}`}>
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {l.name}
                            {!l.isActive && <Badge variant="outline" className="ml-1.5 text-[10px]">{t('dost.inactiveF')}</Badge>}
                          </p>
                          <p className="text-xs text-stone-500 truncate">
                            {st ? t('loc.meta', { tables: st.tables, employees: st.employees, orders: st.orders }) : [l.city, l.country].filter(Boolean).join(' · ') || l.code}
                          </p>
                        </div>
                        <div className="text-right shrink-0 flex items-center gap-1.5">
                          <div>
                            <p className="font-bold">{st ? fmtEUR(st.todayRevenue) : '—'}</p>
                            <p className="text-xs text-stone-400">{t('loc.today', { n: st ? st.todayOrders : '—' })}</p>
                          </div>
                          {hasPerm('settings.manage') && (
                            <div className="flex flex-col gap-0.5">
                              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`${t('common.edit')} ${l.name}`} onClick={() => { setLocEditing(l); setLocForm({ name: l.name, code: l.code, address: l.address, city: l.city, postCode: l.postCode, country: l.country || 'SI', phone: l.phone, email: l.email, premisesId: l.premisesId || '', timezone: l.timezone || 'Europe/Ljubljana', currency: l.currency || 'EUR', isActive: l.isActive }); setLocNotice(''); setLocDialogOpen(true) }}>
                                <Settings className="w-3.5 h-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`${l.isActive ? t('loc.deactivate') : t('loc.activate')} ${l.name}`} onClick={() => setConfirmLocToggle(l)}>
                                <Power className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Plug className="w-4 h-4" /> {t('integ.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {integrations.length === 0 && <p className="text-sm text-stone-500">{t('integ.none')}</p>}
                  {integrations.map((i) => (
                    <div key={i.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{i.name} <span className="text-xs text-stone-400">· {i.provider}</span></p>
                        <p className="text-xs text-stone-500">{i.type}{i.syncEnabled ? t('integ.syncOn') : ''}{i.lastSyncAt ? t('integ.lastSync', { when: new Date(i.lastSyncAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : ''}</p>
                      </div>
                      <Badge className={i.connectionStatus === 'connected' ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{i.connectionStatus}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Webhook className="w-4 h-4" /> {t('integ.webhooks')}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {webhooks.length === 0 && <p className="text-sm text-stone-500">{t('integ.noWebhooks')}</p>}
                  {webhooks.map((w) => (
                    <div key={w.id} className="rounded-lg border border-stone-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate">{w.name}</p>
                        <Badge className={w.isActive ? 'bg-emerald-600 text-white' : 'bg-stone-400 text-white'}>{w.isActive ? t('integ.activeF') : t('integ.offF')}</Badge>
                      </div>
                      <p className="text-xs text-stone-500 truncate">{w.url}</p>
                      <p className="text-[11px] text-stone-400">{w.events.length > 0 ? w.events.join(' · ') : t('integ.noEvents')}{w.failureCount > 0 ? t('integ.errorsCount', { n: w.failureCount }) : ''}{w.lastTriggered ? t('integ.lastTriggered', { when: new Date(w.lastTriggered).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : ''}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Bug className="w-4 h-4" /> {t('errlog.title')}</CardTitle></CardHeader>
                <CardContent>
                  {errLog.length === 0 && <p className="text-sm text-stone-500">{t('errlog.none')}</p>}
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
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> {t('audit.title')}</CardTitle></CardHeader>
                <CardContent>
                  {auditLog.length === 0 && <p className="text-sm text-stone-500">{t('audit.none')}</p>}
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
            <Card><CardHeader><CardTitle className="text-base">{t('sys.title')}</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1.5 text-stone-600">
                <p>{t('sys.version', { v: APP_VERSION })}</p>
                <p>{t('sys.modules')}</p>
                <p>{t('sys.db')}</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Novo naročilo ── */}
      <Dialog open={!!newOrderTable} onOpenChange={(v) => !v && setNewOrderTable(null)}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('orders.newTitle')} — {newOrderTable?.name}</DialogTitle></DialogHeader>
          <ScrollArea className="max-h-[50vh] pr-2">
            <div className="space-y-4">
              {orderDialogMenu.length === 0 && (
                <p className="py-6 text-center text-sm text-stone-500">{t('orders.noMenuItems')}</p>
              )}
              {orderDialogMenu.map((g) => (
                <div key={g.cat.id}>
                  <p className="text-xs font-semibold uppercase text-stone-400 mb-1.5">{g.cat.name}</p>
                  <div className="space-y-1.5">
                    {g.items.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2">
                        <span className="text-sm min-w-0 truncate">{m.name} · <b>{fmtEUR(m.price)}</b></span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                          <span className="w-6 text-center text-sm font-semibold">{cart[m.id] || 0}</span>
                          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: (c[m.id] || 0) + 1 }))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="items-center gap-2 sm:gap-0">
            <span className="mr-auto font-bold">{t('orders.total', { amount: fmtEUR(cartTotal) })}</span>
            <Button variant="outline" onClick={() => setNewOrderTable(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending || cartTotal === 0} onClick={createOrder}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('orders.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OPS-7 (v1.68.0): UREJEVALNIK NAROČILA (Toast vzorec) — klik na zasedeno mizo ── */}
      <Dialog open={!!orderSheet} onOpenChange={(v) => { if (!v) { setOrderSheet(null); setSheetCart({}) } }}>
        <DialogContent aria-describedby={undefined} className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg">
              {t('sheet.title', { n: String(orderSheet?.orderNumber ?? ''), name: orderSheet?.table?.name || orderSheet?.type || '' })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {/* postavke + tečaji */}
            <div className="rounded-xl border border-stone-200 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-stone-400">{t('sheet.items')}</p>
                {orderSheet?.items.some((it) => it.status === 'PENDING' && !it.voided) && (
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                    disabled={sending} onClick={() => void fireSheetAll()}>
                    <Flame className="w-3 h-3" /> {t('sheet.fire')}
                  </Button>
                )}
              </div>
              <ScrollArea className="max-h-44">
                <div className="space-y-1 pr-1">
                  {orderSheet?.items.filter((it) => !it.voided).map((it) => (
                    <div key={it.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-100 px-2 py-1.5">
                      <span className="min-w-0 truncate">{it.qty}× {it.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">{it.status}</Badge>
                        {hasPerm('orders.create') && it.status === 'PENDING' && (
                          <Select value={it.courseId || 'none'}
                            onValueChange={(v) => void assignCourse(it.id, v)}>
                            <SelectTrigger className="h-6 w-[104px] text-[11px] gap-1"><SelectValue placeholder={t('sheet.noCourse')} /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('sheet.noCourse')}</SelectItem>
                              {sheetCourses.filter((c) => c.status === 'pending').map((c) => (
                                <SelectItem key={c.id} value={String(c.courseNumber)}>{c.courseNumber}. {c.name}</SelectItem>
                              ))}
                              <SelectItem value="__new">{t('sheet.newCourse')}</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {sheetCourses.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {sheetCourses.map((c) => (
                    <div key={c.id} className="flex items-center gap-1 rounded-full border border-stone-200 pl-2 pr-1 py-0.5 text-xs">
                      <span className={c.status === 'fired' ? 'text-emerald-700' : ''}>{c.courseNumber}. {c.name} {c.status === 'fired' ? '🔥' : ''}</span>
                      {c.status === 'pending' && hasPerm('orders.create') && (
                        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[11px] gap-0.5" disabled={sending} onClick={() => void fireCourse(c.id)}>
                          <Flame className="w-3 h-3" /> {t('sheet.fireCourse')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* dodaj artikle (Toast: urejevalnik = naročanje + dodajanje) */}
            <div className="rounded-xl border border-stone-200 p-3">
              <p className="text-xs font-semibold uppercase text-stone-400 mb-1.5">{t('sheet.addItems')}</p>
              <ScrollArea className="max-h-36">
                <div className="space-y-3 pr-2">
                  {orderDialogMenu.map((g) => (
                    <div key={g.cat.id}>
                      <p className="text-[11px] font-semibold uppercase text-stone-400 mb-1">{g.cat.name}</p>
                      <div className="space-y-1">
                        {g.items.filter((m) => m.available).map((m) => (
                          <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-100 px-2 py-1.5">
                            <span className="text-sm min-w-0 truncate">{m.name} · <b>{fmtEUR(m.price)}</b></span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                              <span className="w-5 text-center text-sm font-semibold">{sheetCart[m.id] || 0}</span>
                              <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetCart((c) => ({ ...c, [m.id]: (c[m.id] || 0) + 1 }))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:gap-0 flex-wrap">
            <span className="mr-auto font-bold">{t('orders.total', { amount: fmtEUR(sheetCartTotal) })}</span>
            {Object.values(sheetCart).some((q) => q > 0) && (
              <Button className="bg-emerald-700 hover:bg-emerald-800 h-9" disabled={sending} onClick={() => void sendSheetItems()}>
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('sheet.sendItems')}
              </Button>
            )}
            <Button variant="outline" className="h-9" onClick={() => { if (orderSheet) { setMoveTableId(''); const mv = orderSheet; setOrderSheet(null); setMoveOrder(mv) } }} title={t('mmv.move')}>
              <ArrowRightLeft className="w-4 h-4" />
            </Button>
            <Button variant="outline" className="h-9" onClick={() => { if (orderSheet) { const mg = orderSheet; setOrderSheet(null); setMergeOrder(mg) } }} title={t('mmv.merge')}>
              <GitMerge className="w-4 h-4" />
            </Button>
            <Button variant="outline" className="h-9" onClick={() => { if (orderSheet) { const sp = orderSheet; setOrderSheet(null); void openPayment(sp, undefined, true) } }} title={t('sheet.split')}>
              <Split className="w-4 h-4" />
            </Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 h-9" onClick={() => { if (orderSheet) { const py = orderSheet; setOrderSheet(null); void openPayment(py) } }}>
              <Banknote className="w-4 h-4" /> {t('sheet.pay')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Plačilo + FURS (issue #1 §6: kanonični račun, popusti, zvestoba, deljeno plačilo; §7: večji gumbi) ── */}
      <Dialog open={!!payingOrder} onOpenChange={(v) => { if (!v) { setPayingOrder(null); setInvoice(null) } }}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader><DialogTitle className="text-lg">{t('payment.title', { name: payingOrder?.table?.name || '' })}{payCheckNum ? ` — ${t('payment.checkLabel', { n: payCheckNum })}` : ''}</DialogTitle></DialogHeader>
          {!bill && payingOrder && (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>
          )}
          {bill && payingOrder && (
            <div className="space-y-3 text-sm">
              {/* postavke + zneski (kanonično iz /api/orders/[id]/bill; split: samo izstavek) */}
              <ul className="space-y-1 max-h-36 overflow-y-auto pr-1">{(payCheckId && bill.items ? bill.items : payingOrder.items.map((it) => ({ id: it.id, name: it.name, quantity: it.qty, unitPrice: it.unitPrice, voided: it.voided }))).map((it) => (
                <li key={it.id} className="flex justify-between"><span>{it.quantity}× {it.name}</span><span>{fmtEUR(it.quantity * it.unitPrice)}</span></li>
              ))}</ul>

              {/* OPS-7: razdeli račun po postavkah (Check) — Toast/Lightspeed vzorec */}
              {!invoice && !payCheckId && (
                <div className="rounded-xl border border-stone-200 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase text-stone-400">{t('payment.splitTitle')}</p>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => { const nx = !splitOpen; setSplitOpen(nx); if (nx && payingOrder && !checksData) void refreshChecks(payingOrder.id).catch(() => undefined) }}>
                      <Split className="w-3 h-3" /> {splitOpen ? t('common.close') : t('payment.splitManage')}
                    </Button>
                  </div>
                  {splitOpen && checksData && (
                    <div className="space-y-2">
                      {checksData.checks.some((c) => c.paymentStatus === 'paid') ? (
                        <p className="text-xs text-stone-500">{t('payment.splitLocked')}</p>
                      ) : (
                        <>
                          <p className="text-xs text-stone-500">{t('payment.splitHint')}</p>
                          <div className="max-h-40 overflow-y-auto pr-1 space-y-1">
                            {checksData.items.map((it) => (
                              <label key={it.id} className="flex items-center gap-2 rounded-lg border border-stone-100 px-2 py-1.5 cursor-pointer hover:bg-stone-50">
                                <Checkbox checked={!!splitSel[it.id]} onCheckedChange={(v) => setSplitSel((s) => ({ ...s, [it.id]: v === true }))} aria-label={it.name} />
                                <span className="text-xs flex-1 truncate">{it.quantity}× {it.name}</span>
                                <span className="text-xs text-stone-400">{t('payment.checkShort', { n: it.checkNumber ?? 1 })}</span>
                                <span className="text-xs">{fmtEUR(it.lineTotal)}</span>
                              </label>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" className="h-7 text-xs bg-emerald-700 hover:bg-emerald-800" disabled={sending || !Object.values(splitSel).some(Boolean)}
                              onClick={() => void splitCheck()}>
                              {t('payment.splitSelected', { n: Object.values(splitSel).filter(Boolean).length })}
                            </Button>
                          </div>
                        </>
                      )}
                      {checksData.checkCount > 1 && (
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {checksData.checks.filter((c) => c.paymentStatus !== 'paid').map((c) => (
                            <Button key={c.id} size="sm" variant="outline" className="h-8 justify-between text-xs"
                              onClick={() => { if (payingOrder) void openPayment(payingOrder, c.id) }}>
                              <span>{t('payment.checkLabel', { n: c.checkNumber })}</span>
                              <Banknote className="w-3.5 h-3.5" /> {t('payment.checkPay')}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {payCheckId && (
                <div className="rounded-lg bg-stone-100 px-3 py-2 text-xs font-medium">{t('payment.checkBanner', { n: payCheckNum })}</div>
              )}
              <div className="rounded-xl border border-stone-200 p-3 space-y-1">
                <div className="flex justify-between"><span>{t('payment.grossTotal')}</span><span>{fmtEUR(bill.grossTotal)}</span></div>
                {bill.manualDiscount > 0 && (
                  <div className="flex justify-between text-stone-600"><span>{t('payment.manualDiscount')}</span><span>−{fmtEUR(bill.manualDiscount)}</span></div>
                )}
                {bill.autoDiscounts.map((ad) => (
                  <div key={ad.discountId} className="flex justify-between text-emerald-700"><span>🎉 {ad.name}</span><span>−{fmtEUR(ad.amount)}</span></div>
                ))}
                {bill.discountTotal > 0 && (
                  <div className="flex justify-between font-medium border-t border-stone-100 pt-1"><span>{t('payment.discountTotal')}</span><span>−{fmtEUR(bill.discountTotal)}</span></div>
                )}
                <div className="flex justify-between font-bold text-lg pt-1 border-t border-stone-200"><span>{t('payment.due')}</span><span>{fmtEUR(bill.totalDue)}</span></div>
              </div>

              {/* Issue #1 (triage ①): napitnina pri plačilu — gre v Payment.tipAmount → dnevni bazen napitnin */}
              {!invoice && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs shrink-0">{t('payment.tipLabel')}</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.5"
                    inputMode="decimal"
                    value={tipEur}
                    onChange={(e) => setTipEur(e.target.value)}
                    placeholder="0.00"
                    className="h-9 w-28"
                    aria-label={t('payment.tipAria')}
                  />
                  {Number(tipEur) > 0 && (
                    <span className="text-xs text-stone-500">{t('payment.tipGuest', { amount: fmtEUR(bill.totalDue + Number(tipEur)) })}</span>
                  )}
                </div>
              )}

              {!invoice && (
                <>
                  {/* ročni popust (registr) — samo z dovoljenjem apply_discounts */}
                  {hasPerm('apply_discounts') && manualDiscounts.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs shrink-0">{t('payment.discountLabel')}</Label>
                      <Select value={selDiscountId} onValueChange={(v) => void applyManualDiscount(v)}>
                        <SelectTrigger className="h-9 flex-1"><SelectValue placeholder={t('payment.noDiscount')} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t('payment.noDiscount')}</SelectItem>
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
                            <p className="text-xs text-stone-500">{t('payment.pointsOf', { n: loyaltySel.pointsBalance })} · {loyaltySel.tier}</p>
                          </div>
                          <Button variant="outline" size="sm" className="h-8" onClick={() => { setLoyaltySel(null); setRedeemPoints(0) }}>{t('payment.remove')}</Button>
                        </div>
                      ) : (
                        <div className="relative">
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                            <Input
                              className="h-9 pl-8"
                              placeholder={t('payment.guestSearch')}
                              aria-label={t('payment.guestSearchAria')}
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
                                  <p className="text-xs text-stone-500">{a.customerPhone || '—'} · {t('payment.pointsOf', { n: a.pointsBalance })} · {a.tier}</p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {loyaltySel && (
                        <div className="flex items-center gap-2">
                          <Label className="text-xs shrink-0">{t('payment.redeem')}</Label>
                          <Input
                            type="number"
                            min={0}
                            max={Math.min(loyaltySel.pointsBalance, bill.loyalty.maxRedeemablePoints)}
                            value={redeemPoints || ''}
                            onChange={(e) => setRedeemPoints(Math.max(0, Math.min(Math.min(loyaltySel!.pointsBalance, bill!.loyalty.maxRedeemablePoints), Math.round(Number(e.target.value) || 0))))}
                            className="h-9 w-28"
                          />
                          <span className="text-xs text-stone-500">
                            {t('payment.pointsSuffix')} {redeemPoints > 0 && <>→ <b className="text-emerald-700">−{fmtEUR(r2v(redeemPoints * bill.loyalty.pointsValue))}</b></>}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* način plačila / deljeno plačilo */}
                  {parts.length === 0 ? (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('payment.method')}</Label>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {(['cash', 'card', 'mobile', 'giftcard'] as const).map((pm) => (
                          <button
                            key={pm}
                            type="button"
                            onClick={() => setPayMethod(pm)}
                            className={`min-h-11 rounded-xl border px-2 py-2.5 text-sm font-semibold transition ${payMethod === pm ? 'border-emerald-700 bg-emerald-700 text-white shadow' : 'border-stone-200 bg-white text-stone-700 hover:border-emerald-400'}`}
                          >
                            {pm === 'cash' ? t('payment.cash') : pm === 'card' ? t('payment.card') : pm === 'mobile' ? t('payment.mobile') : t('payment.giftcard')}
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
                                placeholder={t('payment.gcPlaceholder')}
                                className="h-9 flex-1 font-mono"
                                aria-label={t('payment.gcAria')}
                              />
                              <Button variant="outline" className="h-9" disabled={gcBusy} onClick={() => void lookupGiftCard(gcQuery, setGcSel)}>
                                {gcBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('payment.search')}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-sm min-w-0">
                                <p className="font-mono text-xs font-semibold truncate">{gcSel.cardNumber}</p>
                                <p className="text-xs text-stone-500 truncate">{gcSel.ownerName || t('payment.noOwner')} · {t('common.saldo')} <b className="text-emerald-700">{fmtEUR(gcSel.balance)}</b></p>
                              </div>
                              <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => { setGcSel(null); setGcQuery('') }}>{t('payment.swap')}</Button>
                            </div>
                          )}
                          {gcErr && <p className="text-xs text-red-600">{gcErr}</p>}
                          {gcSel && gcSel.effectiveStatus !== 'active' && <p className="text-xs text-red-600">{t('payment.gcInactive', { status: gcSel.effectiveStatus })}</p>}
                          {gcSel && gcSel.effectiveStatus === 'active' && bill && (() => {
                            const dv = loyaltySel && redeemPoints > 0 ? r2v(bill.loyalty.pointsValue * redeemPoints) : 0
                            const dueNow = r2v(bill.totalDue - dv)
                            if (dueNow > gcSel.balance + 0.004) {
                              return <p className="text-xs text-amber-700">{t('payment.gcMissing', { amount: fmtEUR(r2v(dueNow - gcSel.balance)) })}</p>
                            }
                            return <p className="text-xs text-emerald-700">{t('payment.gcCovers', { amount: fmtEUR(dueNow) })}</p>
                          })()}
                        </div>
                      )}
                      {/* OPS-4 v1.67.0: razdeli enakomerno na N delov (gostje) — Toast "split evenly" */}
                      <div className="flex gap-1.5">
                        {[2, 3, 4, 5].map((n) => (
                          <Button key={n} variant="outline" className="min-h-10 flex-1" onClick={() => {
                            const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
                            const due = r2v(bill.totalDue - redeemValue)
                            const per = r2v(due / n)
                            const arr: PayPart[] = []
                            let left = due
                            for (let i = 0; i < n; i++) {
                              const amount = i === n - 1 ? r2v(left) : per
                              arr.push({ type: i === 0 ? (payMethod === 'cash' ? 'cash' : payMethod) : 'cash', amount })
                              left = r2v(left - amount)
                            }
                            setParts(arr)
                            if (payMethod === 'giftcard' && gcSel) setGcPartSel({ 0: gcSel })
                          }}>
                            {n}×
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-xs">{t('payment.splitParts')}</Label>
                      {parts.map((p, i) => (
                        <Fragment key={i}>
                        <div className="flex items-center gap-2">
                          <Select value={p.type} onValueChange={(v) => setParts((ps) => ps.map((x, j) => j === i ? { ...x, type: v as PayPart['type'] } : x))}>
                            <SelectTrigger className="h-10 w-32"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cash">{t('payment.cash')}</SelectItem>
                              <SelectItem value="card">{t('payment.card')}</SelectItem>
                              <SelectItem value="mobile">{t('payment.mobile')}</SelectItem>
                              <SelectItem value="giftcard">{t('payment.giftcard')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            value={p.amount ? p.amount.toFixed(2) : ''}
                            onChange={(e) => setParts((ps) => ps.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) || 0 } : x))}
                            className="h-10"
                            aria-label={t('payment.partAmount', { n: i + 1 })}
                          />
                          <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))} aria-label={t('payment.removePart')}>×</Button>
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
                                  placeholder={t('payment.gcPartPlaceholder')}
                                  className="h-8 flex-1 font-mono text-xs"
                                  aria-label={t('payment.gcForPart', { n: i + 1 })}
                                />
                                <Button variant="outline" size="sm" className="h-8" disabled={gcBusy} onClick={() => void lookupGiftCard(gcPartQuery[i] || '', (c) => setGcPartSel((m) => ({ ...m, [i]: c })))}>
                                  {gcBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('payment.search')}
                                </Button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-mono truncate">{gcPartSel[i]!.cardNumber} · saldo <b className="text-emerald-700">{fmtEUR(gcPartSel[i]!.balance)}</b>{p.amount > gcPartSel[i]!.balance + 0.004 && <b className="text-red-600"> · premalo za {fmtEUR(p.amount)}</b>}</p>
                                <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => setGcPartSel((m) => ({ ...m, [i]: null }))}>{t('payment.swap')}</Button>
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
                          {t('payment.addPart')}
                        </Button>
                        <Button variant="outline" className="flex-1 min-h-10" onClick={() => setParts([])}>{t('payment.single')}</Button>
                      </div>
                      {(() => {
                        const redeemValue = loyaltySel && redeemPoints > 0 ? r2v(redeemPoints * bill.loyalty.pointsValue) : 0
                        const due = r2v(bill.totalDue - redeemValue)
                        const covered = r2v(parts.reduce((s, x) => s + x.amount, 0))
                        const rest = r2v(due - covered)
                        const balanced = Math.abs(rest) < 0.005
                        return (
                          <p className={`text-center font-semibold ${balanced ? 'text-emerald-700' : rest > 0 ? 'text-stone-600' : 'text-red-600'}`}>
                            {balanced ? t('payment.splitBalanced') : rest > 0 ? t('payment.splitMissing', { amount: fmtEUR(rest) }) : t('payment.splitOver', { amount: fmtEUR(-rest) })}
                          </p>
                        )
                      })()}
                    </div>
                  )}
                </>
              )}

              {invoice && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm space-y-0.5">
                  <p className="font-semibold text-emerald-800">{t('payment.issued', { detail: bill ? (bill.discountTotal > 0 ? t('payment.issuedDiscount') : t('payment.issuedSim')) : t('payment.issuedSim') })}</p>
                  <p className="text-emerald-700">{t('payment.number', { number: invoice.invoiceNumber })}</p>
                  <p className="text-emerald-700 break-all">{t('payment.eor', { code: invoice.eor })}</p>
                  {loyaltySummary && (
                    <p className="text-emerald-700">{loyaltySummary.redeemedPoints > 0 ? t('payment.loyalty', { redeemed: loyaltySummary.redeemedPoints, earned: loyaltySummary.earnedPoints }) : t('payment.loyaltyEarned', { earned: loyaltySummary.earnedPoints })}</p>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="sm:items-center">
            {invoice?.id && (
              <Button variant="outline" className="mr-auto gap-1.5 min-h-11" disabled={printing} onClick={() => printInvoice(invoice.id!)}>
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} {t('payment.print')}
              </Button>
            )}
            <Button variant="outline" className="min-h-11" onClick={() => { setPayingOrder(null); setInvoice(null) }}>{t('common.close')}</Button>
            {!invoice && <Button className="bg-emerald-700 hover:bg-emerald-800 min-h-12 px-6 text-base font-bold" disabled={sending || !bill || !payOrderReady} onClick={() => void payOrder()}>{sending ? <Loader2 className="w-5 h-5 animate-spin" /> : payMethod === 'cash' && parts.length === 0 ? t('payment.issue') : t('payment.issuePos')}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Nova rezervacija ── */}
      <Dialog open={!!newRes} onOpenChange={(v) => !v && setNewRes(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('resv.new')}</DialogTitle></DialogHeader>
          {newRes && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="res-name">{t('loy.guestName')}</Label>
                <Input id="res-name" value={newRes.guestName} onChange={(e) => setNewRes({ ...newRes, guestName: e.target.value })} placeholder={t('wl.namePlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="res-phone">{t('inv.phone')}</Label>
                  <Input id="res-phone" value={newRes.phone} onChange={(e) => setNewRes({ ...newRes, phone: e.target.value })} placeholder={t('loy.phonePlaceholder')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="res-guests">{t('resv.guestsLabel')}</Label>
                  <Input id="res-guests" type="number" min={1} value={newRes.guests} onChange={(e) => setNewRes({ ...newRes, guests: Number(e.target.value) || 2 })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-time">{t('resv.dateTime')}</Label>
                <Input id="res-time" type="datetime-local" value={newRes.reservedAt} onChange={(e) => setNewRes({ ...newRes, reservedAt: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-note">{t('proc.note')}</Label>
                <Input id="res-note" value={newRes.note} onChange={(e) => setNewRes({ ...newRes, note: e.target.value })} placeholder={t('resv.notePlaceholder')} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewRes(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending || !newRes?.guestName || !newRes?.reservedAt} onClick={() => void createReservation()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : t('resv.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── EMPLOYEE CONTROL CENTER (R265) ── */}
      <Dialog open={!!editEmployee} onOpenChange={(v) => { if (!v) { setEditEmployee(null); setEmpNotice('') } }}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserCog className="w-5 h-5" /> {editEmployee?.name}</DialogTitle>
          </DialogHeader>
          {editEmployee && (
            <ScrollArea className="max-h-[60vh] pr-2">
              <div className="space-y-5">
                {empNotice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${empNotice.startsWith(t('common.error')) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{empNotice}</p>}
                <p className="text-xs text-stone-500">{editEmployee.email}</p>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t('shifts.csvRole')}</Label>
                    <Select value={empRole} onValueChange={(v) => setEmpRole(v)} disabled={user?.role === 'MANAGER' && empRole === 'ADMIN'}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {['OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'BAR', 'KITCHEN', 'CLEANER'].map((r) => (
                          <SelectItem key={r} value={r} disabled={(user?.role === 'MANAGER' && r === 'ADMIN') || (user?.role !== 'OWNER' && r === 'OWNER')}>{roleL(r)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('shifts.csvStatus')}</Label>
                    <div className="flex items-center gap-2 h-9">
                      <Switch id="emp-active" checked={empActive} onCheckedChange={(v) => { if (!v) setConfirmDeactivate(true); else setEmpActive(true) }} />
                      <Label htmlFor="emp-active" className="text-sm font-normal">{empActive ? t('emp.activeF') : t('emp.inactiveF')}</Label>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> {t('emp.permsLabel')}</Label>
                  <p className="text-xs text-stone-400">{t('emp.permsHint')}</p>
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
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800" disabled={empSaving} onClick={() => patchEmployee({ permissionOverrides: empPerms, role: empRole, status: empActive ? 'active' : 'inactive', ...(empLoc ? { locationId: empLoc } : {}) }, t('emp.savedOk'))}>
                    {empSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('emp.saveProfile')}
                  </Button>
                </div>

                {/* Triage ⑧ — pravice po lokaciji: dodelitev poslovalnice zaposlenemu */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {t('emp.locationLabel')}</Label>
                  <Select value={empLoc} onValueChange={setEmpLoc}>
                    <SelectTrigger aria-label={t('emp.locAria')}><SelectValue placeholder={t('emp.unassigned')} /></SelectTrigger>
                    <SelectContent>
                      {locList.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name}{!l.isActive ? t('emp.locInactiveSuffix') : ''}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-stone-400">{t('emp.locHint')}</p>
                </div>

                <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <Label className="text-amber-800">{t('emp.pinResetLabel')}</Label>
                  <p className="text-xs text-amber-700">{t('emp.pinResetHint')}</p>
                  {editEmployee.email?.toLowerCase() === user?.email?.toLowerCase() && (
                    <p className="text-xs font-medium text-amber-900">{t('emp.pinSelfHint')}</p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      inputMode="numeric"
                      maxLength={8}
                      value={empPin}
                      onChange={(e) => setEmpPin(e.target.value.replace(/\D/g, ''))}
                      placeholder={t('emp.pinPlaceholder')}
                      className="max-w-40 bg-white"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-300 text-amber-800 hover:bg-amber-100"
                      title={t('emp.randomPinTitle')}
                      onClick={() => setEmpPin(String(Math.floor(100000 + Math.random() * 900000)))}
                    >
                      <Dices className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100" disabled={empPin.length < 4} onClick={() => setConfirmPinReset(true)}>
                      {t('emp.pinResetLabel')}
                    </Button>
                  </div>
                </div>
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditEmployee(null); setEmpNotice('') }}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Triage ⑧ — lokacije: nova / urejanje ── */}
      <Dialog open={locDialogOpen} onOpenChange={(v) => !v && setLocDialogOpen(false)}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><MapPin className="w-5 h-5" /> {locEditing ? t('loc.editTitle', { name: locEditing.name }) : t('loc.new')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {locNotice && <p className={`text-xs rounded-md px-2.5 py-1.5 ${locNotice.startsWith(t('common.error')) ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{locNotice}</p>}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('loc.nameLabel')}</Label>
                <Input value={locForm.name} onChange={(e) => setLocForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('loc.namePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('loc.codeLabel')}</Label>
                <Input value={locForm.code} onChange={(e) => setLocForm((f) => ({ ...f, code: e.target.value.toUpperCase().slice(0, 20) }))} placeholder={t('loc.codePlaceholder')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('set.address')}</Label>
              <Input value={locForm.address} onChange={(e) => setLocForm((f) => ({ ...f, address: e.target.value }))} placeholder={t('loc.addressPlaceholder')} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>{t('loc.cityLabel')}</Label>
                <Input value={locForm.city} onChange={(e) => setLocForm((f) => ({ ...f, city: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('loc.postCode')}</Label>
                <Input value={locForm.postCode} onChange={(e) => setLocForm((f) => ({ ...f, postCode: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('loc.country')}</Label>
                <Select value={locForm.country} onValueChange={(v) => setLocForm((f) => ({ ...f, country: v }))}>
                  <SelectTrigger aria-label={t('loc.country')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SI">{t('loc.countrySI')}</SelectItem>
                    <SelectItem value="HR">{t('loc.countryHR')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('inv.phone')}</Label>
                <Input value={locForm.phone} onChange={(e) => setLocForm((f) => ({ ...f, phone: e.target.value }))} placeholder={t('dost.phonePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('set.email')}</Label>
                <Input value={locForm.email} onChange={(e) => setLocForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('loc.premisesLabel')}</Label>
                <Input value={locForm.premisesId} onChange={(e) => setLocForm((f) => ({ ...f, premisesId: e.target.value.toUpperCase().slice(0, 40) }))} placeholder={t('loc.premisesPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('set.currency')}</Label>
                <Input value={locForm.currency} onChange={(e) => setLocForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))} />
              </div>
            </div>
            {locEditing && (
              <div className="flex items-center justify-between rounded-lg border border-stone-200 p-2.5">
                <div className="pr-2">
                  <Label className="text-sm">{t('gc.stActive')}</Label>
                  <p className="text-xs text-stone-400">{t('loc.activeHint')}</p>
                </div>
                <Switch checked={locForm.isActive} onCheckedChange={(v) => setLocForm((f) => ({ ...f, isActive: v }))} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLocDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={locSaving || !locForm.name.trim()} onClick={() => void saveLocation()}>
              {locSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('loc.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Triage ⑧ — potrditev aktivacije/deaktivacije lokacije ── */}
      <AlertDialog open={!!confirmLocToggle} onOpenChange={(v) => !v && setConfirmLocToggle(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmLocToggle?.isActive ? t('loc.confirmDeactivate', { name: confirmLocToggle?.name || '' }) : t('loc.confirmActivate', { name: confirmLocToggle?.name || '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmLocToggle?.isActive
                ? t('loc.deactivateDesc')
                : t('loc.activateDesc')}
              {t('loc.auditNote')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmLocToggle && void toggleLocationActive(confirmLocToggle)}>
              {confirmLocToggle?.isActive ? t('loc.deactivate') : t('loc.activate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── SENSITIVE ACTION UX (R266) — potrditve z razlago ── */}
      <AlertDialog open={confirmPinReset} onOpenChange={setConfirmPinReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('emp.confirmPinReset', { name: editEmployee?.name || '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('emp.pinResetDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-amber-600 hover:bg-amber-700" onClick={() => {
              setConfirmPinReset(false)
              const self = editEmployee?.email?.toLowerCase() === user?.email?.toLowerCase()
              patchEmployee({ pin: empPin }, self ? t('emp.pinSelfOk') : t('emp.pinResetOk'))
            }}>
              {t('emp.pinResetConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDeactivate} onOpenChange={setConfirmDeactivate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('emp.confirmDeactivate', { name: editEmployee?.name || '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('emp.deactivateDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => { setConfirmDeactivate(false); setEmpActive(false); patchEmployee({ status: 'inactive' }, t('emp.deactivatedOk')) }}>
              {t('emp.deactivateConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('logout.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('logout.desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('logout.stay')}</AlertDialogCancel>
            <AlertDialogAction className="bg-emerald-700 hover:bg-emerald-800" onClick={logout}>{t('logout.doIt')}</AlertDialogAction>
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
        {t('dash.footer', { v: APP_VERSION })}
      </footer>
    </main>
  )
}
