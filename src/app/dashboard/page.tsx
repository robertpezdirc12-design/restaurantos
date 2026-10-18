'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, fmtPctSigned, getUser } from '@/lib/client'
import { vatFromGross } from '@/lib/billing'
import { toast } from '@/hooks/use-toast'
import { APP_VERSION } from '@/lib/version'
/* ISSUE #74 V-3 (v1.135.0): pet razredov starosti listka + nastavljivi pragovi —
   enoten vir (kds-delays.ts) za page.tsx IN kds-station-board (prej dve ločeni
   kopiji iste logike z dvema različnima pragoma). */
import {
  KDS_AGE_DEFAULTS, KDS_AGE_THRESHOLD_LS_KEY, KDS_DELAY_REASONS, delayThresholdForTarget,
  isLatePrep, isStaleKdsTicket, kdsAgeBorderCls, kdsAgeClass, kdsAgePillCls,
  normalizeKdsAgeThresholds, staleTicketHours, type KdsAgeThresholds,
} from '@/lib/kds-delays'
import { FLOOR_PLAN_W, FLOOR_PLAN_H, floorPlanUnitIsPercent, planPositionOf } from '@/lib/floor-plan'
import { tabHasPerm, TAB_PERM } from '@/lib/tab-permissions'
import { normItemName } from '@/lib/menu-dup'
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger,
} from '@/components/ui/drawer'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, Users, Settings,
  LogOut, Plus, Minus, Loader2, ReceiptText, RefreshCw, Banknote, CalendarDays,
  ShieldCheck, UserCog, Search, Star, KeyRound, Dices, Printer, Wifi, WifiOff, CloudUpload,
  AlertTriangle, Download,
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
  ArrowLeftRight,
  GitMerge,
  Flame,
  Pencil,
  Split,
  Bell,
  CalendarRange,
  ChartScatter,
  ChevronDown,
  SprayCan,
  Eye,
  CheckCircle2,
} from 'lucide-react'
import { CommandPalette, PaletteButton } from '@/components/command-palette'
import { ThemeToggle } from '@/components/theme-toggle'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'
import { downloadCSV } from '@/lib/client'
import { printReceipt, type ReceiptDetailT } from '@/lib/receipt'
import {
  enqueueOp, flushQueue, getQueue, getDeviceId, isNetworkError, newOperationId, subscribeQueue,
  clearDeadOps, resetDeadOp,
  type QueuedOp,
} from '@/lib/offline-queue'
import {
  printLines, buildKitchenTicketLines, getPrintConfig, savePrintConfig,
  type PrintConfig, type PrintLine, type PrintTarget,
} from '@/lib/devices/print'
import { getTerminalConfig, saveTerminalConfig, processTerminalPayment, type TerminalMode } from '@/lib/devices/terminal'
import { PERMISSION_LABELS, effectivePermissionSets, FULL_ONLY_PERMISSIONS, permissionTierFor, PERMISSION_TIER_LABELS } from '@/lib/permissions'
import { filterByLocation, isCentralUIRole } from '@/lib/multilocation'
import { filterReservations, type ReservationFilter } from '@/lib/reservation-filters'
import { AllergenDialog } from '@/components/allergen-dialog'
import { ALLERGEN_CODES, allergenLabel, type AllergenCode, type AllergenLocale } from '@/lib/allergen-catalog'
import {
  InventoryTab, ShiftsTab, HaccpTab, ExpensesTab, LoyaltyTab, FeedbackTab, JobsCard, SettingsEditor, DevicesCard, DeliveryTab, AccountingExportCard, GlJournalCard, NapitnineTab, NabavaTab, DarilneKarticeTab, OdpadTab, CakalnaListaTab, DelovniCasTab, OdpiralniCasTab, DiscountsTab, IntegracijeTab, EnterpriseTab, StaffScheduleTab, MenuEngineeringTab, FoodCostVarianceCard, ExceptionsReportCard, KdsStatsSection, NotificationsCard, SalesByHourCard, LaborCostCard, LaborCoverageCard, UpsellCard, DisplayPromosCard, MfaCard, ReservationWidgetCard, ManagerCallsCard, ManagerCallSettingsCard, PrepStationsCard, LabelRulesCard, PayrollTab, TransfersTab, CrmTab,
  type InventoryT, type ShiftT, type FinancialT, type HaccpT, type ExpenseT, type LoyaltyT,
  type SupplierT, type RecipeT, type FeedbackT, type JobT, type SettingsT, type DeviceT,
  type DeliveryOrderT, type DeliveryZoneT, type PlatformIntegrationT,
} from '@/components/dashboard-tabs'
import { ManagerCallButton } from '@/components/manager-call-dialog'
/* Issue #14 (v1.112.0) — KDS station views: task board + expo dispatch board
   (component lives in src/components/ — outside the i18n scan family). */
import { KdsStationBoard, KDS_TASK_STATUS, type KdsStationT, type KdsTaskT, type KdsStationStatT } from '@/components/kds-station-board'
/* ISSUE #74 V-7: fotografije kategorij na POS ploščicah (skupni vir za dashboard
   in handheld — čista preslikava v lib, brez per-artikel slik v bazi) */
import { CATEGORY_IMAGE_DEFAULT, categoryImageForCategory } from '@/lib/category-images'
import { stationViewKey } from '@/lib/kds-station-routing'
import { PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, Briefcase, MapPin, Plug, Webhook, Bug, Truck, Coins, Ban, Percent, Building2, Zap, EyeOff, Volume2, Maximize2, Ship, Lock, Check, Megaphone, ChevronUp, CreditCard, Settings2, Columns3, List } from 'lucide-react'

const DASHBOARD_TABS: [string, typeof LayoutDashboard | null][] = [
  ['pregled', LayoutDashboard], ['mize', Utensils], ['narocila', ClipboardList],
  ['prodaja', Zap], ['kuhinja', ChefHat], ['meni', BookOpen], ['rezervacije', CalendarDays],
  ['racuni', ReceiptText], ['inzeniring', ChartScatter], ['popusti', Percent], ['integracije', Plug],
  ['zaloge', PackageSearch], ['izmene', Clock], ['delovnicas', Timer], ['urnik', CalendarRange],
  ['haccp', Thermometer], ['stroski', Wallet], ['zvestoba', HeartHandshake], ['mnenja', Star], ['crm', Megaphone],
  ['dostava', Truck], ['napitnine', Coins], ['obracun', ReceiptText], ['nabava', ShoppingCart],
  ['prenosi', ArrowLeftRight], ['darilne', Gift], ['odpad', Trash2], ['cakalna', Hourglass],
  ['odpiralnicas', CalendarClock], ['zaposleni', Users], ['nastavitve', Settings], ['enterprise', Building2],
];
const DASHBOARD_PRIMARY_TABS = new Set(['pregled', 'mize', 'narocila', 'prodaja', 'kuhinja', 'meni', 'rezervacije', 'racuni']);
const DASHBOARD_MOBILE_PRIMARY_TABS = new Set(['pregled', 'mize', 'narocila', 'prodaja', 'kuhinja']);
const DASHBOARD_PRIMARY_TABS_HIDDEN_BELOW_LG = new Set(['meni', 'rezervacije', 'racuni']);

/* ISSUE #74 V-17: meni »Več« dobi RAZDELKE — 27 ciljev v ravnem seznamu je bilo
   nepregledno (issue: »32 ciljev, 24 brez razdelkov, brez iskalnika«). Skupine
   po vsebini dela (Toast/Square vzorec: Operativa / Gostje / Zaloge in
   finance / Ekipa / Sistem); nepoznani zavihki padejo v Operativo (fail-safe). */
const TAB_GROUP_KEYS = ['ops', 'guests', 'finance', 'staff', 'system'] as const
type TabGroupKeyT = (typeof TAB_GROUP_KEYS)[number]
const TAB_GROUP_LABEL_KEY: Record<TabGroupKeyT, string> = {
  ops: 'tabs.groupOps', guests: 'tabs.groupGuests', finance: 'tabs.groupFinance', staff: 'tabs.groupStaff', system: 'tabs.groupSystem',
}
const TAB_GROUP_OF: Record<string, TabGroupKeyT> = {
  meni: 'ops', rezervacije: 'ops', dostava: 'ops', cakalna: 'ops',
  zvestoba: 'guests', mnenja: 'guests', crm: 'guests', darilne: 'guests',
  racuni: 'finance', obracun: 'finance', stroski: 'finance', napitnine: 'finance',
  zaloge: 'finance', nabava: 'finance', odpad: 'finance', prenosi: 'finance',
  inzeniring: 'finance', popusti: 'finance',
  zaposleni: 'staff', izmene: 'staff', delovnicas: 'staff', urnik: 'staff', odpiralnicas: 'staff', haccp: 'staff',
  nastavitve: 'system', integracije: 'system', enterprise: 'system',
}

interface LocationStatT { id: string; name: string; tables: number; employees: number; orders: number; todayOrders: number; todayRevenue: number }
/** triage ⑧ — polna vrstica lokacije (GET /api/locations, centralne vloge vidijo vse) */
interface LocationRowT { id: string; name: string; code: string; address: string; city: string; postCode: string; country: string; phone: string; email: string; premisesId: string | null; timezone: string; currency: string; isActive: boolean }
interface IntegrationT { id: string; name: string; type: string; provider: string; syncEnabled: boolean; connectionStatus: string; lastSyncAt?: string | null }
interface WebhookT { id: string; name: string; url: string; events: string[]; isActive: boolean; lastTriggered?: string | null; failureCount: number }
interface ErrLogT { id: string; employeeId?: string | null; action: string; entity: string; entityId?: string | null; data?: string | null; createdAt: string }
interface AuditT { id: string; timestamp: string; action: string; entityType: string; entityId?: string | null; userId?: string | null; details: Record<string, unknown> }

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; yesterdayRevenue: number | null; paidToday: { count: number; total: number }; financialPerm: boolean; employees: number; menuItems: number }
interface TableT { id: string; name: string; zone: string; seats: number; status: string; locationId?: string | null; activeOrder: { id: string; total: number; guests: number; itemCount: number } | null; posX?: number; posY?: number }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null; voided?: boolean; courseId?: string | null; firedAt?: string | null; allergenWarning?: string | null; allergenCodes?: string[]; allergenStatus?: string | null }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; locationId?: string | null; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { name: string } | null; items: OrderItemT[]; paymentStatus?: string | null }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null; locationId?: string | null; vatRate?: number; allergenStatus?: string; allergenCodes?: string[]; allergenReviewFlag?: boolean }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean; phone?: string | null; locationId?: string | null; permissionOverrides: string[] }
/** OPS-8 val 3 (v1.73.0): + email/duration/specialRequests/source (additive API fields) */
interface ReservationT { id: string; guestName: string; phone?: string | null; guests: number; reservedAt: string; status: string; note?: string | null; reminderSent?: boolean; email?: string | null; duration?: number | null; specialRequests?: string | null; source?: string | null }
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

// Naloga #11 (WCAG 1.4.3): -600/stone-400 ozadja z belim textom dajejo 2.0–4.0:1
// na 12 px — na KDS tabli neberljivo. Familija barv ostane, temnjena je svetlost.
const statusColors: Record<string, string> = {
  FREE: 'bg-emerald-700 text-white hover:bg-emerald-800',
  OCCUPIED: 'bg-amber-700 text-white hover:bg-amber-800',
  /* Issue #71 audit-21: rezervirana = lastni akcent (bele ploščice s PREKINJENIM robom +
     temnim besedilom) — prej stone-200 s text-stone-800 je imel kontrast ~2,6:1 in je
     na sončni tablici izginil. Barva NI edini nosilec pomena — ploščica nosi tudi
     besedilo »Rezervirana« (statusLabels). */
  RESERVED: 'bg-white text-stone-900 border-2 border-dashed border-stone-500 hover:bg-stone-50 shadow-sm',
  DIRTY: 'bg-stone-700 text-white hover:bg-stone-800',
  OPEN: 'bg-amber-700 text-white', SENT: 'bg-orange-700 text-white',
  PREPARED: 'bg-emerald-700 text-white', PAID: 'bg-teal-700 text-white',
  CANCELLED: 'bg-red-700 text-white',
  PENDING: 'bg-amber-700 text-white', PREPARING: 'bg-orange-700 text-white', READY: 'bg-emerald-700 text-white',
}
const statusLabels: Record<string, string> = {
  FREE: 'Prosta', OCCUPIED: 'Zasedena', RESERVED: 'Rezervirana', DIRTY: 'Za pospravit',
  OPEN: 'Odprto', SENT: 'Poslano v kuhinjo', PREPARED: 'Pripravljeno', PAID: 'Plačano', CANCELLED: 'Preklicano',
  PENDING: 'V vrsti', PREPARING: 'V pripravi', READY: 'Pripravljeno',
}

/* EMPLOYEE CONTROL CENTER (R265) — kanonska dovoljenja sedaj v src/lib/permissions.ts */
const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Lastnik', ADMIN: 'Administrator', MANAGER: 'Vodja', WAITER: 'Natakar', BAR: 'Bar', KITCHEN: 'Kuhinja', CLEANER: 'Čistilka',
  // Issue #71 audit-5: vse vloge iz baze imajo čLOVEŠKO oznako — ne surovi enum
  STAFF: 'Natakar', CHEF: 'Kuhar', WAREHOUSE: 'Skladiščnik', ACCOUNTING: 'Računovodstvo',
  GROUP_OWNER: 'Lastnik skupine', ORG_ADMIN: 'Administrator organizacije', PROPERTY_MANAGER: 'Upravnik objekta',
}
/* Issue #71 audit-5: revizijski dogodki govorijo jezik vloge, ne razvijalski jezik.
   Znani dogodki imajo izrecen prevod; neznan se OLEPI (podčrtaj → presledek,
   velika začetnica) — nikoli več gol `SCHEMA_MIGRATION_CRM_CAMPAIGNS`. */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  DEMO_LOGIN: 'Prijava brez gesla (demo)',
  ERROR_REPORT: 'Poročilo o napaki',
  AUDIT_DEMO_CLEANUP: 'Čiščenje demo podatkov',
}
const auditActionL = (a: string): string => {
  if (AUDIT_ACTION_LABELS[a]) return AUDIT_ACTION_LABELS[a]
  if (a.startsWith('SCHEMA_MIGRATION_')) return `Migracija sheme: ${a.replace('SCHEMA_MIGRATION_', '').toLowerCase().replace(/_/g, ' ')}`
  if (/^[A-Z0-9_]+$/.test(a)) return a.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  return a
}
const auditEntityL = (e: string): string => {
  const map: Record<string, string> = {
    Order: 'Naročilo', Employee: 'Zaposleni', Table: 'Miza', Reservation: 'Rezervacija',
    Schema: 'Shema baze', Maintenance: 'Vzdrževanje', Settings: 'Nastavitve', Menu: 'Meni',
  }
  return map[e] ?? e
}
const RES_STATUS_KEYS: Record<string, string> = {
  CONFIRMED: 'resv.stConfirmed', SEATED: 'resv.stSeated', COMPLETED: 'resv.stCompleted', CANCELLED: 'resv.stCancelled', NO_SHOW: 'resv.stNoShow',
}

/* Issue #14 (v1.112.0) — station progress chip for a TASKED legacy item: the legacy
   order queue replaces the raw status buttons with per-station sync chips so the
   ALL/KITCHEN/BAR views never fire a 409 (item is managed by the station flow).
   Style map + label keys are shared with the task board (single source). */
function KdsTaskChip({ task }: { task: KdsTaskT }) {
  const { t } = useI18n()
  const st = KDS_TASK_STATUS[task.status] ?? KDS_TASK_STATUS.pending
  const icon =
    task.kind === 'expo' ? <Ship className="w-3 h-3" aria-hidden />
      : task.status === 'waiting' ? <Lock className="w-3 h-3" aria-hidden />
        : task.status === 'pending' ? <Clock className="w-3 h-3" aria-hidden />
          : task.status === 'preparing' ? <Loader2 className="w-3 h-3 animate-pulse" aria-hidden />
            : <Check className="w-3 h-3" aria-hidden />
  return (
    <span
      title={`${task.stationName} — ${t(st.labelKey)}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold shrink-0 ${st.cls}`}
    >
      {icon}
      <span className="max-w-24 truncate">{task.stationName}</span>
    </span>
  )
}

/* Issue #69 (2. val): sidro kategorije menija — determinističen slug iz id-ja
   kategorije za čiste sidrske skoke (#cat-…). Čista preslikava niza, brez stanja. */
const catAnchor = (id: string): string => `cat-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

/* ═══ ISSUE #74 (v1.135.0) Stopnja 2+3 — KDS ergonomija in statusni jezik ═══ */

/** V-11: število listkov po slovensko — dvojina/množina (ne "2 LISTKOV"). */
function listekCountKey(n: number): 'kds.countOne' | 'kds.countTwo' | 'kds.countFew' | 'kds.countMany' {
  if (n === 1) return 'kds.countOne'
  if (n === 2) return 'kds.countTwo'
  if (n >= 3 && n <= 4) return 'kds.countFew'
  return 'kds.countMany'
}

/** V-8: velikost pisave listka S/M/L/XL (Toast "do Enormous" vzorec). Nazivna
    vrstica + postavke + starostne pili sorazmerno; dejanja (44 px cilji) ostanejo. */
export type KdsFontSizeT = 'S' | 'M' | 'L' | 'XL'
const KDS_FONT_SIZES: KdsFontSizeT[] = ['S', 'M', 'L', 'XL']
const KDS_FONT_CLS: Record<KdsFontSizeT, { title: string; item: string; timer: string }> = {
  S: { title: 'text-[13px]', item: 'text-[13px]', timer: 'text-xs' },
  M: { title: 'text-[15px]', item: 'text-[15px]', timer: 'text-sm' },
  L: { title: 'text-lg', item: 'text-base', timer: 'text-base' },
  XL: { title: 'text-2xl', item: 'text-xl', timer: 'text-lg' },
}
const KDS_FONT_LABEL_KEY: Record<KdsFontSizeT, string> = {
  S: 'kds.fontS', M: 'kds.fontM', L: 'kds.fontL', XL: 'kds.fontXL',
}

/** V-8: gostota listka — kompaktno (mala plošča, več listkov) ali normalno. */
export type KdsDensityT = 'compact' | 'normal'
const KDS_DENSITY_CLS: Record<KdsDensityT, { card: string; items: string; item: string }> = {
  compact: { card: 'min-w-0 gap-1.5 py-2 sm:py-2.5', items: 'space-y-1 px-4 pb-1 sm:px-6 sm:pb-1.5', item: 'px-3 py-1 space-y-1' },
  normal: { card: 'min-w-0 gap-2 py-3 sm:py-4', items: 'space-y-1.5 px-4 pb-1 sm:px-6 sm:pb-2', item: 'px-3 py-1.5 space-y-1.5' },
}

/** V-8: število stolpcev NAVPIČNEGA SEZNAMA (4/6/8/10 — Square 4–10 stolpcev).
    Stolpci krmilijo mrežo listkov v "Seznam" pogledu; "Stolpci" (board) ima
    fiksnih 3 statusne stolpce (Novi/V pripravi/Pripravljeni). */
const KDS_COLUMN_OPTIONS = [4, 6, 8, 10] as const
type KdsColumnsT = (typeof KDS_COLUMN_OPTIONS)[number]
const KDS_COLUMN_CLS: Record<KdsColumnsT, string> = {
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
  6: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6',
  8: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8',
  10: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 2xl:grid-cols-10',
}

/** V-12: širina ploščice mize ∝ številu sedežev (2–3 / 4–6 / 7+) — fiksna
    višina vseh stanj preprečuje nazobčane vrstice v coni. */
const tableTileWidthCls = (seats: number): string => (seats <= 3 ? 'w-44' : seats <= 6 ? 'w-52' : 'w-60')

/* Issue #69 (2. val): vizualni razdelek nastavitev — naslov + sidro (#set-…) za
   hitri skok po dolgi strani. Čisto dekorativna lupina: vsebine kartic (njihovi
   kontrolniki, stanja, dovoljenja) ostanejo nedotaknjene. */
function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`set-${id}`} data-region="settings-section" className="space-y-3 scroll-mt-40">
      <h2 data-region="settings-section-header" className="text-sm font-bold uppercase tracking-wider text-stone-500 border-b border-stone-200 pb-1.5">
        {title}
      </h2>
      {children}
    </section>
  )
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
  // OPS-11 val 1 (v1.80.0): per-station delay targets from GET /api/kitchen (PrepStation.avgPrepTime
  // by KDS bucket) — the live timer / bump dialog resolve the threshold client-side via isLatePrep.
  const [stationTargets, setStationTargets] = useState<Record<string, number | null>>({})
  // Issue #14 (v1.112.0): ADDITIVE GET /api/kitchen fields — named stations, active station tasks
  // (the client filters per station view; the expo board also needs sibling tasks) and per-station
  // queue stats (issue §4). Empty arrays pre-DDL (server degrades gracefully).
  const [kdsStations, setKdsStations] = useState<KdsStationT[]>([])
  const [kdsTasks, setKdsTasks] = useState<KdsTaskT[]>([])
  const [kdsStationStats, setKdsStationStats] = useState<KdsStationStatT[]>([])
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
  /** Natisljivi račun (FURS) — busy indikator za gumb za tiskanje (common.print) */
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
  // FIX (E2E 8-e2e): hydration-safe init — the old lazy initializer read
  // window.location on the client (server always got 'pregled') → the Tabs
  // aria-selected tree mismatched on every deep link (?tab=zaloge …). The URL
  // param is applied by the dedicated effect below (line ~419), which already
  // handles the router.push-after-render timing; direct loads switch after mount.
  const [activeTab, setActiveTab] = useState('pregled')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  // Offline/local-first + pravice (issue #1)
  // Issue #5 (P1-A): inicializacija iz localStorage (login vrača resolved permissions
  // in jih page.tsx shrani) — prvi izris ŽE ve, kdo je prijavljen → zavihki ne
  // utripajo skozi permisivno stanje (prej perms=[] → tabHasPerm dovolil VSE do /me).
  // /api/auth/me v load() ostaja kot osvežitev (takojšen učinek spremembe pravic).
  // FIX (E2E 8-e2e): hydration-safe — the lazy initializer read localStorage on the
  // client (server always got perms=[]) so the permission-gated TabsList rendered
  // a different tab set during hydration (console error + full client re-render).
  // Permissions now hydrate from localStorage in the effect below (same-frame,
  // before /me — the anti-flicker goal of P1-A is preserved, only one paint later).
  const [perms, setPerms] = useState<string[]>([])
  useEffect(() => {
    try {
      const raw = localStorage.getItem('ro_user')
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed?.permissions)) setPerms(parsed.permissions)
    } catch {
      /* leave empty — /me refresh in load() is authoritative */
    }
  }, [])
  const [online, setOnline] = useState(true)
  const [queueOps, setQueueOps] = useState<QueuedOp[]>([])
  const [syncing, setSyncing] = useState(false)
  // Issue #3 §A (P0): dead-letter offline operacije — intervencijski pogled (badge → dialog)
  const [deadOpen, setDeadOpen] = useState(false)
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
  // Issue #5 (komentar #3): preklic posamezne postavke (orders.void) — dialog + razlog
  const [voidItem, setVoidItem] = useState<OrderItemT | null>(null)
  const [voidReasons, setVoidReasons] = useState<{ id: string; name: string }[]>([])
  const [voidReasonId, setVoidReasonId] = useState('')
  const [voidReasonText, setVoidReasonText] = useState('')
  // Issue #19 (v1.107.0): politika finančnih izjem + generični dialog razloga/odobritve
  const [excPolicy, setExcPolicy] = useState<{ policy: { discountApprovalPct: number; discountApprovalAmountCents: number; voidApprovalAmountCents: number; requireReasonDiscount: boolean }; isManagerial: boolean } | null>(null)
  const [excAction, setExcAction] = useState<
    | { type: 'discount-apply'; discountId: string; switching: boolean }
    | { type: 'discount-remove' }
    | { type: 'storno'; receipt: ReceiptT }
    | null
  >(null)
  const [excTitleKey, setExcTitleKey] = useState('exc.title')
  const [excNeedsReason, setExcNeedsReason] = useState(true)
  const [excNeedsApprover, setExcNeedsApprover] = useState(false)
  const [excReasons, setExcReasons] = useState<{ id: string; name: string }[]>([])
  const [excReasonId, setExcReasonId] = useState('')
  const [excReasonText, setExcReasonText] = useState('')
  const [excComment, setExcComment] = useState('')
  const [excApproverEmail, setExcApproverEmail] = useState('')
  const [excApproverPin, setExcApproverPin] = useState('')
  const [payCheckId, setPayCheckId] = useState<string | null>(null)
  const [payCheckNum, setPayCheckNum] = useState(0)
  const [checksData, setChecksData] = useState<ChecksT | null>(null)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitSel, setSplitSel] = useState<Record<string, boolean>>({})
  // OPS-7 (v1.70.0): Web Push stanje + omogočanje (zvonček v glavi)
  // FIX (E2E 8-e2e): the old lazy initializer read window/Notification during
  // render — SSR rendered the header WITHOUT the bell button while the client
  // hydrated WITH it (hydration mismatch console error on every load). Push
  // state is now computed after mount (SSV renders 'unsupported').
  const [pushState, setPushState] = useState<'unsupported' | 'default' | 'granted' | 'denied'>('unsupported')
  useEffect(() => {
    setPushState(
      !('serviceWorker' in navigator && 'PushManager' in window)
        ? 'unsupported'
        : typeof Notification !== 'undefined'
          ? Notification.permission === 'granted'
            ? 'granted'
            : Notification.permission === 'denied'
              ? 'denied'
              : 'default'
          : 'unsupported',
    )
  }, [])

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
  // Issue #71 audit-25: iskalnik po zaposlenih + gumb/dialog »Nov zaposleni«
  const [empSearch, setEmpSearch] = useState('')
  const [newEmpDlg, setNewEmpDlg] = useState(false)
  const [newEmp, setNewEmp] = useState({ name: '', email: '', pin: '', role: 'WAITER' })
  const [newEmpBusy, setNewEmpBusy] = useState(false)
  const [newEmpErr, setNewEmpErr] = useState('')
  /** Vaja PIN-ov: ali je trenutna seja prijavljena prek začasnega bootstrap dostopa (2 h)? */
  const [bootstrapLogin, setBootstrapLogin] = useState(false)
  /** Vaja PIN-ov: ustvarjanje trajnega profila za bootstrap e-pošto (ce profil se ne obstaja) */
  const [bootName, setBootName] = useState('')
  const [bootPin, setBootPin] = useState('')
  const [bootBusy, setBootBusy] = useState(false)
  const [bootNotice, setBootNotice] = useState('')
  const [empPerms, setEmpPerms] = useState<string[]>([])
  const [empRole, setEmpRole] = useState('WAITER')
  // ISSUE #72 A1: efektivni nabor za PRIKAZ — pravice iz vloge (brane) + dodani
  const empEffective = effectivePermissionSets(empRole.toLowerCase(), empPerms)
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
  const [newRes, setNewRes] = useState<{ guestName: string; phone: string; guests: number; reservedAt: string; note: string; tableId: string; source: string; email: string; duration: number; specialRequests: string } | null>(null)
  // OPS-8 val 3 (v1.73.0): status filter chips for the reservation list
  const [resFilter, setResFilter] = useState<ReservationFilter>('UPCOMING')

  // ISSUE #72 A4/C1: canManage je OD SEDAJ CENTRALNA vloga (OWNER/ADMIN/enterprise).
  // MANAGER ima od v1.133.0 OMEJEN nabor (19 ključev) in zavihke vidi SKOZ SVOJE
  // PRICE — nastavitve/integracije/enterprise (settings.manage) mu izginejo iz
  // navigacije, enakovredno backendu. Prej: canManage vključeval MANAGERJA in bil
  // hkrati bypass v hasPerm → vodja je videl vse, kar backend 403-a (anti-pattern
  // »vmesnik prikaže več, kot sme«).
  const canManage = isCentralUIRole(user?.role)
  // Issue #6 §F: PRAZNA dovoljenja = fail-closed (prej: perms.length === 0 → vsa
  // dovoljenja odprta, da UI ne utripa — v1.88.0 inicializacija iz localStorage je
  // sinhrona, utripanja ni več; prazen seznam pomeni RESNIČNO brez dovoljenj).
  // N8 fail-closed: neznano/undefined dovoljenje → false (prej `!p` → true)
  // ISSUE #72: canManage bypass ODSTRANJEN — centralne vloge imajo vse ključe v
  // razrešenem naboru (CANONICAL), vodja pa svojih 19; UI === backend resnica.
  const hasPerm = (p?: string) => !!p && perms.includes(p)
  // Issue #6 §F: zrcalo za load() useCallback (endpoint-on-demand brez stale closure)
  const gateRef = useRef({ canManage, perms })
  gateRef.current = { canManage, perms }
  // Issue #5 (P1-B): clamp aktivnega zavihka — URL ?tab=<privilegiran> za vlogo brez
  // dovoljenja se spravi na 'pregled' takoj, ko so perms znani (paneli sicer ostanejo
  // izrisani brez podatkov — backend 403; to je UI-hardening, ne varnostna plast)
  // Issue #71 audit-27: clamp je ZDAJ GLASEN — uporabnik izve, zakaj je pristal na
  // pregledu, ne da bi mislil, da mu je aplikacija »vzela« zavihek.
  useEffect(() => {
    if (canManage) return
    // issue #6 §F: tudi PRAZNA dovoljenja se clampajo (tabHasPerm fail-closed →
    // privilegiran ?tab= pristane na 'pregled', ne da bi čakal na /me)
    if (activeTab !== 'pregled' && !tabHasPerm(activeTab, { canManage, perms })) {
      toast({ title: t('tabs.noPerm') })
      setActiveTab('pregled')
    }
  }, [perms, canManage, activeTab, t])

  // Issue #5 (P1-A lekcija): pri router.push iz prijave App Router posodobi URL ŠELE
  // PO prvem renderu nove strani → useState inicializator je prebral STAR URL ('').
  // Ta effect po umirjenju navigacije prebere ?tab= in sinhronizira aktivni zavihek
  // (varnost: clamp effect zgoraj neodvisno preveri dovoljenje — tuji param ne poviša).
  useEffect(() => {
    const tabParam = new URLSearchParams(window.location.search).get('tab')
    if (!tabParam || tabParam === activeTab) return
    // Issue #71 audit-27: ?tab=neobstoječi je prej pustil PRAZNO ploščo brez sporočila —
    // izmerjeno ?tab=hitra-prodaja (pravi id: prodaja). Zdaj: obvestilo + preusmeritev.
    if (!TAB_PERM[tabParam]) {
      toast({ title: t('tabs.unknown') })
      setActiveTab('pregled')
      return
    }
    setActiveTab(tabParam)
  }, [])

  // Naloga #10: ?tab= se je samo BRALO. Preklop zavihka je URL pustil na
  // /dashboard, zato osveži, nazaj in deljenje povezave vrnejo na 'pregled'
  // (kuhinja/KDS naprava, ki jo natakar zapusti, izgine). Zapis z
  // replaceState — brez router navigacije, ki bi znova naložila podatke.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('tab') === activeTab) return
    if (activeTab === 'pregled') url.searchParams.delete('tab')
    else url.searchParams.set('tab', activeTab)
    window.history.replaceState(window.history.state, '', url)
  }, [activeTab])
  const canRes = perms.includes('reservations.manage')

  // Naloga #11 (polling): 'hot' = operativni krog (mize/naročila/kuhinja/meni/
  // rezervacije/računi/izmene/zaloge/statistika), 'full' doda še počasne vire
  // (finančne, konfiguracija, audit, log napak, dobavitelji, recepti, naprave,
  // dostava, lokacije). Interval klicuje hot, vsak 4. cikel full — pred tem je
  // 27 končnih točk × 15 s pomenilo ~1,9 zahteve/s v mirujočem zavihku.
  const load = useCallback(async (scope: 'hot' | 'full' = 'full') => {
    const full = scope === 'full'
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
      // Issue #6 §F: endpoint-on-demand — dashboard NE zahteva finančnih/konfiguracijskih
      // API-jev za vlogo, ki jih ne sme uporabljati (backend UVEJEJA pravice neodvisno —
      // to je le odprava brezpotrebnih 403 klicev ob vsakem load; mapa = dovoljenja
      // samih API rut iz v1.88.0: employees/jobs/devices = employees.manage,
      // financial/expenses/audit = reports.view, loyalty/integrations/webhooks/
      // monitoring/settings/locations = settings.manage, suppliers = inventory.manage
      // | reports.view | settings.manage, recipes = inventory.manage, haccp =
      // haccp.execute | settings.manage, feedback = reservations.manage,
      // delivery = delivery.manage; operativni klici (mize/naročila/kuhinja/meni/
      // rezervacije/računi/zaloge/izmene) ostanejo za vse — mehki 403 catch).
      const { canManage: manage, perms: curPerms } = gateRef.current
      const hp = (p: string) => manage || curPerms.includes(p)
      const hpAny = (...ps: string[]) => manage || ps.some((x) => curPerms.includes(x))
      const [d, t, o, k, m, e, r, rec, inv, sh, fin, haccpRows, ex, loy, sup, recp, jb, fb, ls, ig, wb, el, se, dv, au, dl, lc] = await Promise.all([
        soft(api<{ stats: Stats }>(`/api/dashboard${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)),
        soft(api<{ tables: TableT[] }>('/api/tables')),
        soft(api<{ orders: OrderT[] }>('/api/orders')),
        // Issue #5 §C: postaja gre NA STREŽNIK (?station=) — KDS naprava dobi SAMO
        // svojo postajo (kdsStationRef mirror za poll closure). Issue #14: custom
        // station ids are ADDITIVE (server ignores unknown values for the legacy
        // queue filter — the task board does its own client-side filtering).
        soft(api<{ queue: OrderT[]; stationTargets?: Record<string, number | null>; stations?: KdsStationT[]; tasks?: KdsTaskT[]; stationStats?: KdsStationStatT[] }>(`/api/kitchen${kdsStationRef.current && kdsStationRef.current !== 'ALL' ? `?station=${kdsStationRef.current}` : ''}`)),
        soft(api<{ items: MenuT[]; categories: CategoryT[] }>(`/api/menus${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)),
        full && hp('employees.manage') ? soft(api<{ employees: EmployeeT[] }>('/api/employees')) : undefined,
        soft(api<{ reservations: ReservationT[] }>('/api/reservations')),
        soft(api<{ receipts: ReceiptT[] }>('/api/furs')),
        full ? soft(api<{ inventory: InventoryT[] }>('/api/inventory')) : undefined,
        soft(api<{ shifts: ShiftT[] }>('/api/shifts')),
        full && hp('reports.sales') ? soft(api<FinancialT>('/api/reports/financial')) : undefined,
        full && hpAny('haccp.execute', 'settings.manage') ? soft(api<{ haccpChecks: HaccpT[] }>('/api/haccp')) : undefined,
        full && hp('reports.sales') ? soft(api<{ expenses: ExpenseT[]; categoriesEnabled?: boolean }>('/api/expenses')) : undefined,
        full && hp('settings.manage') ? soft(api<{ accounts: LoyaltyT[] }>('/api/loyalty')) : undefined,
        full && hpAny('inventory.manage', 'reports.sales', 'settings.manage') ? soft(api<{ suppliers: SupplierT[] }>('/api/suppliers')) : undefined,
        full && hp('inventory.manage') ? soft(api<{ recipes: RecipeT[] }>('/api/recipes')) : undefined,
        full && hp('employees.manage') ? soft(api<{ jobContexts: JobT[] }>('/api/jobs')) : undefined,
        full && hp('reservations.manage') ? soft(api<{ feedback: FeedbackT[] }>('/api/guests/feedback')) : undefined,
        full && manage ? soft(api<{ stats: LocationStatT[] }>('/api/locations/stats')) : undefined,
        full && hp('settings.manage') ? soft(api<{ integrations: IntegrationT[] }>('/api/integrations')) : undefined,
        full && hp('settings.manage') ? soft(api<{ webhookEndpoints: WebhookT[] }>('/api/webhooks')) : undefined,
        full && hp('settings.manage') ? soft(api<{ errors: ErrLogT[] }>('/api/monitoring/errors')) : undefined,
        full && hp('settings.manage') ? soft(api<{ settings: Record<string, unknown> | null }>('/api/settings')) : undefined,
        full && hp('employees.manage') ? soft(api<{ devices: DeviceT[] }>('/api/devices')) : undefined,
        full && hp('reports.sales') ? soft(api<{ entries: AuditT[] }>('/api/audit')) : undefined,
        full && hp('delivery.manage') ? soft(api<{ orders: DeliveryOrderT[]; zones: DeliveryZoneT[]; platformIntegrations: PlatformIntegrationT[] }>('/api/delivery')) : undefined,
        full && hp('settings.manage') ? soft(api<{ locations: LocationRowT[] }>('/api/locations')) : undefined,
      ])
      if (d) setStats(d.stats)
      if (t) setTables(t.tables)
      if (o) setOrders(o.orders)
      if (k) {
        setKitchen(k.queue)
        setStationTargets(k.stationTargets ?? {})
        // Issue #14: additive fields (pre-DDL → undefined → keep empty = legacy behavior)
        setKdsStations(k.stations ?? [])
        setKdsTasks(k.tasks ?? [])
        setKdsStationStats(k.stationStats ?? [])
      }
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

  // Naloga #7: privzeti pogled čez vse lokacije (glava → preklop lokacije) je
  // pokazal 437 postavk menija
  // (mešanica cen, alergenov in razpoložljivosti). POS dejavno potrebuje
  // en pogled na lastno lokacijo. Izberemo samo ob prvem zagonu in samo enoznačno
  // (uporabnikova lastna lokacija; sicer natanko ena lokacija). Centralni
  // uporabniki z več lokacijami ostanejo pri "Vse", dokler ne izberejo.
  const locAutoPicked = useRef(false)
  useEffect(() => {
    if (locAutoPicked.current || viewLoc || locList.length === 0) return
    locAutoPicked.current = true
    const own = user?.locationId && locList.some((l) => l.id === user.locationId) ? user.locationId : ''
    if (own) setViewLoc(own)
    else if (locList.length === 1) setViewLoc(locList[0].id)
  }, [locList, user, viewLoc])

  useEffect(() => {
    void load()
    setBootstrapLogin(localStorage.getItem('ro_bootstrap') === '1')
    setPcfg(getPrintConfig())
    setTermMode(getTerminalConfig().mode)
    // Naloga #11: hot poll na 15 s (operativni pregled), en cikel na štiri (60 s)
    // povsežni; v skritem zavihku se poll ustavi (brskalnik ga itak duši).
    let tick = 0
    const iv = setInterval(() => {
      if (document.hidden) return
      tick = (tick + 1) % 4
      void load(tick === 0 ? 'full' : 'hot')
    }, 15000)
    const onVis = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
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

  // ── Issue #3 §A (P0): dead-letter intervencija ──
  const deadOps = useMemo(() => queueOps.filter((o) => o.status === 'dead'), [queueOps])

  /** Ponovno pošlji eno dead operacijo (reset attempts → flush). */
  const retryDead = useCallback((clientOperationId: string) => {
    resetDeadOp(clientOperationId)
    void doSync()
  }, [doSync])

  /** Zavrzi VSE dead operacije (izguba ni več tiha — drop je bil že zabeležen prek /api/sync/drop). */
  const discardDead = useCallback(() => {
    const n = clearDeadOps()
    if (n > 0) toast({ title: t('sync.deadTitle'), description: t('sync.deadDone') })
  }, [t])

  /** Izvoz diagnostike BREZ vsebine payload (skrivnosti/količine ostanejo lokalne). */
  const exportDead = useCallback(() => {
    const diag = deadOps.map((o) => ({
      clientOperationId: o.clientOperationId,
      kind: o.kind,
      createdAt: o.createdAt,
      attempts: o.attempts,
      lastError: o.lastError || '',
    }))
    const blob = new Blob([JSON.stringify({ device: getDeviceId(), exportedAt: new Date().toISOString(), ops: diag }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `offline-diag-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [deadOps])

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
      // v1.86.2: lokacija iz mize za centralno vlogo brez lokacije (server ignorira za osebje)
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: newOrderTable.id, items, guests: 2, clientOperationId, locationId: newOrderTable.locationId || undefined }) })
      setCart({}); setNewOrderTable(null); await load()
    } catch (err) {
      if (isNetworkError(err)) {
        // offline → naročilo se NE IZGUBI, gre v lokalno vrsto za sinhronizacijo
        enqueueOp('order.create', { tableId: newOrderTable.id, items: Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty })), guests: 2, note: '', locationId: newOrderTable.locationId || undefined })
        setCart({}); setNewOrderTable(null)
        toast({ title: t('net.offlineOrderQueued') })
      } else {
        toast({ title: (err as Error).message, variant: 'destructive' })
      }
    } finally { setSending(false) }
  }

  async function setItemStatus(itemId: string, status: string, delayReason?: string) {
    try {
      await api('/api/kitchen', { method: 'PATCH', body: JSON.stringify({ itemId, status, ...(delayReason ? { delayReason } : {}) }) })
      await load()
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOp('kitchen.status', { itemId, status, ...(delayReason ? { delayReason } : {}) })
        toast({ title: t('net.offlineStatusQueued') })
      } else {
        toast({ title: (err as Error).message, variant: 'destructive' })
      }
    }
  }

  /**
   * v1.129.0 (Toast/Square benchmark): bump CELEGA LISTKA — kuhar označi vse odprte
   * postavke (PENDING/PREPARING → READY) v enem pritisku (Toast: dvoklik = fulfill,
   * BOA: vsi odkljukani = samodejni bump). Delay-reason dialog se NE sproži — to je
   * eksplicitno dejanje »vse je pripravljeno«; posamezne zamude se zapišejo prek
   * obstoječe postavkne poti. En load() na koncu (ne po vsaki postavki).
   */
  async function bumpWholeTicket(o: OrderT) {
    const targets = o.items.filter((it) => !it.voided && (it.status === 'PENDING' || it.status === 'PREPARING'))
    if (targets.length === 0) return
    setKdsBumpBusy(o.id)
    try {
      for (const it of targets) {
        await api('/api/kitchen', { method: 'PATCH', body: JSON.stringify({ itemId: it.id, status: 'READY' }) })
      }
      await load()
    } catch (err) {
      if (isNetworkError(err)) {
        for (const it of targets) enqueueOp('kitchen.status', { itemId: it.id, status: 'READY' })
        toast({ title: t('net.offlineStatusQueued') })
      } else {
        toast({ title: (err as Error).message, variant: 'destructive' })
      }
    } finally {
      setKdsBumpBusy('')
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

  /** Issue #5: odpri dialog preklica postavke (razlogi se naložijo enkrat, 403 → prazno)
   *  Issue #19: + politika (ali prikazati polja odobritelja). */
  async function openVoidDialog(it: OrderItemT) {
    setVoidItem(it)
    setVoidReasonId('')
    setVoidReasonText('')
    setExcComment('')
    setExcApproverEmail('')
    setExcApproverPin('')
    void ensureExcPolicy()
    if (voidReasons.length === 0) {
      try {
        const d = await api<{ voidReasons: { id: string; name: string }[] }>('/api/void-reasons')
        setVoidReasons(d.voidReasons || [])
      } catch {
        /* brez kataloga (npr. prazna DB) — prosta beseda ostane edina možnost */
      }
    }
  }

  /** Issue #5: potrdi preklic postavke (orders.void + obvezen razlog; plačano → 409 toast)
   *  Issue #19: + komentar + morebitna odobritev (prag excVoidApprovalAmountCents). */
  async function confirmVoidItem() {
    if (!voidItem || !orderSheet) return
    if (!voidReasonId && voidReasonText.trim().length < 3) {
      toast({ title: t('void.reasonLabel'), variant: 'destructive' })
      return
    }
    // #19: prag preklica aktiven in ne-vodstveni izvajalec → obvezna poverilnica
    const voidNeedsApprover =
      !!excPolicy && !excPolicy.isManagerial && excPolicy.policy.voidApprovalAmountCents > 0 &&
      Math.round(voidItem.qty * voidItem.unitPrice * 100) > excPolicy.policy.voidApprovalAmountCents
    if (voidNeedsApprover && (!excApproverEmail.trim() || !excApproverPin)) {
      toast({ title: t('exc.approverMissing'), variant: 'destructive' })
      return
    }
    setSending(true)
    try {
      // #39: amountRemovedFromOrder (neto) — zmanjšanje vrednosti NEPLAČANEGA naročila (ni vračilo denarja)
      const d = await api<{ voided: { amountRemovedFromOrder: number }; order: OrderT | null }>(`/api/orders/${orderSheet.id}/void`, {
        method: 'POST',
        body: JSON.stringify({
          itemId: voidItem.id,
          ...(voidReasonId ? { reasonId: voidReasonId } : {}),
          ...(voidReasonText.trim() ? { reason: voidReasonText.trim() } : {}),
          ...(excComment.trim() ? { comment: excComment.trim() } : {}),
          ...(voidNeedsApprover && excApproverEmail.trim() ? { approverEmail: excApproverEmail.trim() } : {}),
          ...(voidNeedsApprover && excApproverPin ? { approverPin: excApproverPin } : {}),
        }),
      })
      setVoidItem(null)
      if (d.order) setOrderSheet(d.order)
      toast({ title: t('void.done') })
      void load()
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' })
    } finally {
      setSending(false)
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
      toast({ title: (err as Error).message, variant: 'destructive' })
    }
  }

  /** Issue #19: politika izjem (brez skrivnosti; requireAuth) — POS ve, kdaj
   *  odpreti dialog razloga/odobritve. Strežnik ostaja avtoritativen (vsak klic
   *  validira sam) — ta preber je SAMO za prikaz. */
  async function ensureExcPolicy() {
    if (excPolicy) return excPolicy
    try {
      const d = await api<{ policy: { discountApprovalPct: number; discountApprovalAmountCents: number; voidApprovalAmountCents: number; requireReasonDiscount: boolean }; isManagerial: boolean }>('/api/exception-policy')
      setExcPolicy(d)
      return d
    } catch {
      return null // nedosegljivo → direktni klic; strežnik bo odgovoril s 400/403
    }
  }

  /** Issue #19: odpri generični dialog izjeme (razlog + morebitna odobritev).
   *  kindCatalog: 'discount' | 'storno' — naloži pripadajoče katalog razloge. */
  async function openExceptionDialog(opts: {
    titleKey: string
    needsReason: boolean
    needsApprover: boolean
    kindCatalog: 'discount' | 'storno'
  }) {
    setExcTitleKey(opts.titleKey)
    setExcNeedsReason(opts.needsReason)
    setExcNeedsApprover(opts.needsApprover)
    setExcReasonId('')
    setExcReasonText('')
    setExcComment('')
    setExcApproverPin('')
    if (excReasons.length === 0 && opts.needsReason) {
      try {
        const d = await api<{ voidReasons: { id: string; name: string }[] }>(`/api/void-reasons?kind=${opts.kindCatalog}`)
        setExcReasons((d.voidReasons || []).map((r) => ({ id: r.id, name: r.name })))
      } catch {
        /* brez kataloga — prosta beseda */
      }
    }
  }

  /** Issue #19: skupno telo razloga/odobritve za vse izjeme (strežnik validira). */
  function excBody() {
    return {
      ...(excReasonId ? { reasonId: excReasonId } : {}),
      ...(excReasonText.trim() ? { reason: excReasonText.trim() } : {}),
      ...(excComment.trim() ? { comment: excComment.trim() } : {}),
      ...(excNeedsApprover && excApproverEmail.trim() ? { approverEmail: excApproverEmail.trim() } : {}),
      ...(excNeedsApprover && excApproverPin ? { approverPin: excApproverPin } : {}),
    }
  }

  /** Issue #19: potrdi izjemo (razlog + odobritev) → izvedi naloženo akcijo. */
  async function confirmException() {
    if (!excAction || !payingOrder) return
    if (excNeedsReason && !excReasonId && excReasonText.trim().length < 3) {
      toast({ title: t('exc.reasonMissing'), variant: 'destructive' })
      return
    }
    if (excNeedsApprover && (!excApproverEmail.trim() || !excApproverPin)) {
      toast({ title: t('exc.approverMissing'), variant: 'destructive' })
      return
    }
    setSending(true)
    try {
      if (excAction.type === 'storno') {
        const r = excAction.receipt
        setStornoing(r.id)
        try {
          const d = await api<{ invoice: { invoiceNumber: string }; storno: { restoredStockItems: number } }>(`/api/receipts/${r.id}/storno`, { method: 'POST', body: JSON.stringify(excBody()) })
          await load()
          toast({ title: t('rcpt.stornoDone', { n: d.invoice.invoiceNumber, s: d.storno.restoredStockItems }) })
        } finally { setStornoing(null) }
      } else {
        // discount-apply / discount-remove — #45: zamenjava je eksplicitna
        // (najprej DELETE z razlogom, nato POST); oba koraka nosita ISTI razlog
        const body = excBody()
        if (excAction.type === 'discount-apply' && excAction.switching) {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE', body: JSON.stringify(body) })
        } else if (excAction.type === 'discount-remove') {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE', body: JSON.stringify(body) })
        }
        if (excAction.type === 'discount-apply') {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ ...body, discountId: excAction.discountId }) })
          setSelDiscountId(excAction.discountId)
        } else {
          setSelDiscountId('none')
        }
        const b = await api<{ bill: BillT }>(`/api/orders/${payingOrder.id}/bill`)
        setBill(b.bill)
        await load()
      }
      setExcAction(null)
      toast({ title: t('exc.done') })
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  /** Issue #1 §6 + #19: ročni popust (iz registra). Konfigurirana promocija pod
   *  pragom gre DIREKTNO (brez trenja); nad pragom ali ko politika zahteva razlog
   *  → dialog izjeme (razlog + odobritev DRUGE osebe za ne-vodstvene). */
  async function applyManualDiscount(discountId: string) {
    if (!payingOrder) return
    const pol = await ensureExcPolicy()
    const d = manualDiscounts.find((x) => x.id === discountId)
    const switching = !!selDiscountId && selDiscountId !== 'none'

    // #19: odstranitev/zamenjava uporabljenega popusta = izjema (razlog obvezen)
    if (!discountId || discountId === 'none') {
      if (switching || (bill?.manualDiscount ?? 0) > 0) {
        setExcAction({ type: 'discount-remove' })
        await openExceptionDialog({ titleKey: 'exc.discountRemoveTitle', needsReason: true, needsApprover: false, kindCatalog: 'discount' })
      }
      return
    }
    if (!d) return
    const pctAbove = d.type === 'percent' && pol ? Number(d.amount) > pol.policy.discountApprovalPct : false
    const amountAbove = d.type === 'fixed' && pol && pol.policy.discountApprovalAmountCents > 0 ? Math.round(Number(d.amount) * 100) > pol.policy.discountApprovalAmountCents : false
    const needsReason = (pol?.policy.requireReasonDiscount ?? false) || pctAbove || amountAbove
    const needsApprover = (pctAbove || amountAbove) && !(pol?.isManagerial ?? false)
    if (needsReason || switching) {
      // zamenjava obstoječega (409 #45) ali razlog/odobritev → dialog z istim razlogom
      setExcAction({ type: 'discount-apply', discountId, switching })
      await openExceptionDialog({ titleKey: 'exc.discountTitle', needsReason: true, needsApprover, kindCatalog: 'discount' })
      return
    }
    // pod pragom, brez politike razloga, brez zamenjave → direktna prijava (dosedanji tok)
    try {
      await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ discountId }) })
      setSelDiscountId(discountId)
      const b = await api<{ bill: BillT }>(`/api/orders/${payingOrder.id}/bill`)
      setBill(b.bill)
      await load()
    } catch (err) {
      // 400 (razlog obvezen — politika se je medtem spremenila) → odpri dialog
      const msg = String((err as Error).message || '')
      if (/razlog|odobrit/i.test(msg)) {
        setExcAction({ type: 'discount-apply', discountId, switching: false })
        await openExceptionDialog({ titleKey: 'exc.discountTitle', needsReason: true, needsApprover: false, kindCatalog: 'discount' })
      } else {
        toast({ title: msg, variant: 'destructive' })
      }
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
      toast({ title: (err as Error).message, variant: 'destructive' })
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
              toast({ title: t('payment.partGcRequired', { n: i + 1 }), variant: 'destructive' })
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
            toast({ title: term.error || t('payment.terminalDeclined', { amount: fmtEUR(p.amount) }), variant: 'destructive' })
            return
          }
          bodyParts.push({ type: p.type, amount: r2v(p.amount), terminal: { approvalCode: term.approvalCode as string } })
        }
      } else if (due > 0) {
        // klasična pot — eno plačilo preostanka
        if (payMethod === 'giftcard') {
          // Issue #1 triage ③: plačilo z darilno kartico (celoten preostanek)
          if (!gcSel) {
            toast({ title: t('payment.gcChooseFirst'), variant: 'destructive' })
            return
          }
          bodyParts.push({ type: 'giftcard', amount: due, giftCardId: gcSel.id })
        } else if (payMethod !== 'cash') {
          const term = await processTerminalPayment(due)
          if (!term.approved) {
            toast({ title: term.error || t('payment.terminalNotApproved'), variant: 'destructive' })
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
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
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
          toast({ title: t('print.popupBlocked'), variant: 'destructive' })
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
      if (!res.ok) toast({ title: t('print.failed', { error: res.error ?? '' }), variant: 'destructive' })
      else if (res.simulated) toast({ title: t('print.simInvoice') })
    } catch (err) { toast({ title: t('print.prepareError', { error: (err as Error).message }), variant: 'destructive' }) } finally { setPrinting(false) }
  }

  /** Fiskalni storno računa (P1 audit točka 1) — storno račun + povračilo zaloge
   *  + revizija. Issue #19: obvezen RAZLOG (dialog) pred izvedbo; prag odobritve
   *  je privzeto izklopljen (receipts.storno je vodstveno dovoljenje) — če politika
   *  sproži odobritev, strežnik odgovori 403 in dialog ponudi polja odobritelja. */
  async function stornoReceipt(r: ReceiptT) {
    if (!confirm(t('rcpt.stornoConfirm', { n: r.invoiceNumber, a: fmtEUR(Math.abs(r.total)) }))) return
    setExcAction({ type: 'storno', receipt: r })
    await openExceptionDialog({ titleKey: 'exc.stornoTitle', needsReason: true, needsApprover: false, kindCatalog: 'storno' })
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
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) }
  }

  /* ── Issue #3: QR meni po mizah ── */
  async function openQr(t: TableT) {
    setQrTable({ id: t.id, name: t.name }); setQrData(null); setQrBusy(true)
    try {
      const d = await api<{ dataUrl: string; url: string; qrEnabled: boolean }>(`/api/tables/${t.id}/qr`)
      setQrData(d)
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }); setQrTable(null) } finally { setQrBusy(false) }
  }
  async function qrAction(action: 'rotate' | 'toggle', enabled?: boolean) {
    if (!qrTable) return
    setQrBusy(true)
    try {
      await api(`/api/tables/${qrTable.id}/qr`, { method: 'POST', body: JSON.stringify({ action, enabled }) })
      const d = await api<{ dataUrl: string; url: string; qrEnabled: boolean }>(`/api/tables/${qrTable.id}/qr`)
      setQrData(d)
    } catch (e) { toast({ title: (e as Error).message, variant: 'destructive' }) } finally { setQrBusy(false) }
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
      items: o.items.map((it) => ({ name: it.name, qty: it.qty, note: it.note, station: it.station, allergenWarning: it.allergenWarning || '', allergenCodes: it.allergenCodes || [] })),
    }, station))
    if (!res.ok) toast({ title: t('print.failed', { error: res.error ?? '' }), variant: 'destructive' })
    else if (res.simulated) toast(station === 'BAR' ? { title: t('print.simBar') } : { title: t('print.simKitchen') })
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
        // OPS-8 val 3 (v1.73.0): + tableId/source/customerEmail/duration/specialRequests
        body: JSON.stringify({
          guestName: newRes.guestName, phone: newRes.phone, guests: newRes.guests,
          reservedAt: new Date(newRes.reservedAt).toISOString(), note: newRes.note, allowOutsideHours,
          ...(newRes.tableId ? { tableId: newRes.tableId } : {}),
          source: newRes.source || 'phone',
          ...(newRes.email ? { customerEmail: newRes.email } : {}),
          duration: newRes.duration || 120,
          ...(newRes.specialRequests ? { specialRequests: newRes.specialRequests } : {}),
        }),
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
      toast({ title: msg, variant: 'destructive' })
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
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setSending(false) }
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
    } catch (err) { toast({ title: t('common.error'), description: (err as Error).message, variant: 'destructive' }) }
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

  /** Issue #71 audit-25: ustvarjanje zaposlenega neposredno s plošče (prej samo delovna mesta). */
  async function createEmployee() {
    setNewEmpBusy(true); setNewEmpErr('')
    try {
      const d = await api<{ employee: EmployeeT }>('/api/employees', {
        method: 'POST',
        body: JSON.stringify({ name: newEmp.name.trim(), email: newEmp.email.trim(), pin: newEmp.pin, role: newEmp.role, locationId: viewLoc || user?.locationId || locList[0]?.id || undefined }),
      })
      setEmployees((list) => [...list, d.employee])
      toast({ title: t('emp.created'), description: d.employee.name })
      setNewEmpDlg(false)
      setNewEmp({ name: '', email: '', pin: '', role: 'WAITER' })
    } catch (err) {
      const msg = (err as Error).message
      setNewEmpErr(/že obstaja/i.test(msg) ? t('emp.exists') : msg)
    } finally { setNewEmpBusy(false) }
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
        return { name: m?.name || id, qty, price, vatRate: Number(m?.vatRate) || 22 }
      })
      // Naloga #6: prikazane cene so končne → DDV se izvleče po stopnji posameznega artikla
      const gross = lines.reduce((s, l) => s + l.price, 0)
      const byRate = new Map<number, { rate: number; amount: number }>()
      let netTotal = 0
      for (const l of lines) {
        const vat = vatFromGross(l.price, l.vatRate)
        netTotal += l.price - vat
        const cur = byRate.get(l.vatRate) || { rate: l.vatRate, amount: 0 }
        cur.amount = r2v(cur.amount + vat)
        byRate.set(l.vatRate, cur)
      }
      void pushDisplay({
        state: lines.length ? 'ordering' : 'idle',
        tableName: newOrderTable.name,
        lines: lines.map(({ vatRate: _r, ...rest }) => rest),
        subtotal: r2v(netTotal),
        tax: r2v(gross - netTotal),
        vatBreakdown: [...byRate.values()].filter((v) => v.amount > 0),
        total: r2v(gross),
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
  // Issue #71 audit-2/audit-5: tip naročila v ČLOVEŠKI obliki — naslov listka/kartice je
  // ime mize, fallback pa "Na mestu"/"Odnes"/"Dostava", NE surovi enum DINE_IN.
  const orderTypeL = (ty: string): string => { const v = t(`order.type.${ty}`); return v === `order.type.${ty}` ? ty : v }
  // Triage ⑧ — pogledi: preklopnik filtrira sezname (viri brez locationId ostanejo vidni)
  const viewTables = filterByLocation(tables, viewLoc)
  const viewOrders = filterByLocation(orders, viewLoc)
  const viewKitchen = filterByLocation(kitchen, viewLoc)
  const viewEmployees = filterByLocation(employees, viewLoc)
  // Issue #71 audit-18: kandidati za množični opomnik — ZRCALI strežniško logiko
  // (status=confirmed, začetek v naslednjih 24 h, reminderSent=false), da potrditveno
  // okno pokaže TOČNO število, ki ga bo strežnik poslal. (Rezervacije API že vrača
  // obseg lokacije uporabnika — brez dodatnega filterByLocation.)
  const reminderCandidates = reservations.filter((r) => {
    if (r.reminderSent || r.status !== 'confirmed') return false
    const start = new Date(r.reservedAt).getTime()
    const now = Date.now()
    return start >= now && start <= now + 24 * 3600 * 1000
  })
  // OPS-4 v1.67.0 — KDS: stanje postaje/zvoka + hitra prodaja (sank)
  // Issue #14 (v1.112.0): kdsStation accepts CUSTOM station ids too — 'ALL' plus
  // the two legacy buckets plus any id of a configured named station. The URL
  // ?station= initializer stays pure: it accepts the legacy values or any slug
  // candidate; a stale/unknown id gracefully falls back to the legacy view
  // (kdsCustomView below resolves against the loaded station list).
  const [kdsStation, setKdsStation] = useState<string>(() => {
    if (typeof window === 'undefined') return 'ALL'
    const s = new URLSearchParams(window.location.search).get('station')
    if (s === 'KITCHEN' || s === 'BAR') return s
    if (s && /^[A-Za-z0-9_-]{1,64}$/.test(s)) return s
    return 'ALL'
  })
  // Issue #5: mirror za poll closure (load() bere ref, state ostane za UI)
  const kdsStationRef = useRef<string>(kdsStation)
  useEffect(() => { kdsStationRef.current = kdsStation }, [kdsStation])
  const [kdsSound, setKdsSound] = useState(true)
  /* ISSUE #74 V-3/V-8/V-9 (v1.135.0) — KDS ergonomija, shranjena NA NAPRAVO
     (localStorage — isto kot jezik/tisk konfig; vloga/dovoljenja niso prizadeta):
      - starostni pragovi (ro_kds_age_thresholds): siva/emerald/amber/utrip/rdeča
      - velikost pisave listka (ro_kds_font_size): S/M/L/XL
      - gostota (ro_kds_density): kompaktno/normalno
      - stolpci navpičnega seznama (ro_kds_columns): 4/6/8/10
      - pogled (ro_kds_view): 'columns' (board po statusu) | 'list'
     Hidracija: vse vrednosti se preberejo TEKOM mount efekta (SSR izriše privzete —
     enak vzorec kot ro_user perms — brez hidracijskega razpada). */
  const [kdsAgeTh, setKdsAgeTh] = useState<KdsAgeThresholds>(KDS_AGE_DEFAULTS)
  const [kdsAgeDraft, setKdsAgeDraft] = useState<KdsAgeThresholds>(KDS_AGE_DEFAULTS)
  const [kdsFontSize, setKdsFontSize] = useState<KdsFontSizeT>('M')
  const [kdsDensity, setKdsDensity] = useState<KdsDensityT>('normal')
  const [kdsColumns, setKdsColumns] = useState<KdsColumnsT>(6)
  const [kdsView, setKdsView] = useState<'columns' | 'list'>('columns')
  useEffect(() => {
    try {
      const rawTh = localStorage.getItem(KDS_AGE_THRESHOLD_LS_KEY)
      if (rawTh) {
        const th = normalizeKdsAgeThresholds(JSON.parse(rawTh))
        setKdsAgeTh(th); setKdsAgeDraft(th)
      }
      const fs = localStorage.getItem('ro_kds_font_size')
      if (fs === 'S' || fs === 'M' || fs === 'L' || fs === 'XL') setKdsFontSize(fs)
      const dn = localStorage.getItem('ro_kds_density')
      if (dn === 'compact' || dn === 'normal') setKdsDensity(dn)
      const cl = Number(localStorage.getItem('ro_kds_columns'))
      if ((KDS_COLUMN_OPTIONS as readonly number[]).includes(cl)) setKdsColumns(cl as KdsColumnsT)
      const vw = localStorage.getItem('ro_kds_view')
      if (vw === 'columns' || vw === 'list') setKdsView(vw)
    } catch { /* zasebni način — privzete vrednosti ostanejo */ }
  }, [])
  /** V-3: takojšen učinek + persist (ob obnovitvi zaslona se pragovi spomnijo). */
  const kdsSaveAgeThresholds = (th: KdsAgeThresholds) => {
    const norm = normalizeKdsAgeThresholds(th)
    setKdsAgeTh(norm); setKdsAgeDraft(norm)
    try { localStorage.setItem(KDS_AGE_THRESHOLD_LS_KEY, JSON.stringify(norm)) } catch { /* brez shramve — velja do osvežitve */ }
    toast({ title: t('kds.settingsSaved') })
  }
  /** V-8/V-9: persist pomočnik za preproste izbire. */
  const kdsPersist = (key: string, value: string) => {
    try { localStorage.setItem(key, value) } catch { /* brez shramve */ }
  }
  // izpeljenke (SSR-varne privzete vrednosti izračunamo tik pred izrisom)
  const kdsFont = KDS_FONT_CLS[kdsFontSize] ?? KDS_FONT_CLS.M
  const kdsDensityCls = KDS_DENSITY_CLS[kdsDensity] ?? KDS_DENSITY_CLS.normal
  // P0-3 (v1.83.0): 86 plošča — iskanje za hiter proaktiven 86 (TRZNA-VRZELI-2026 §4 P0-3)
  const [kds86Search, setKds86Search] = useState('')
  // v1.129.0 (Toast benchmark): 86 plošča skrčena — privzeto ZAPRTO (števec viden v vrstici)
  const [kdsBoardOpen, setKdsBoardOpen] = useState(false)
  // v1.129.0: bumpWholeTicket — zaklep proti dvojnemu pritisku (id listka med izvajanjem)
  const [kdsBumpBusy, setKdsBumpBusy] = useState('')
  // Issue #71 audit-1: zastareli listki — LOČEN oddelek, privzeto ZLOŽEN (števec viden)
  const [kdsStaleOpen, setKdsStaleOpen] = useState(false)
  // Issue #71 audit-23: zgoščene postavke naročil — razširjeni seznami po id-ju
  const [expandedOrderItems, setExpandedOrderItems] = useState<Record<string, boolean>>({})
  // Issue #71 audit-18: potrditveno okno za množične opomnike (neponovljivo dejanje)
  const [reminderConfirmOpen, setReminderConfirmOpen] = useState(false)
  const kdsPrevPendingRef = useRef(0)
  // OPS-9 val 3 (v1.76.0): delay-reason dialog — opens when a LATE item (>10 min) is bumped
  const [delayAsk, setDelayAsk] = useState<{ itemId: string; name: string; min: number } | null>(null)
  // Issue #7 (P1, v1.104.0): alergenski dialog (meni tab → potrditev/popravek profila)
  const [allergenDlg, setAllergenDlg] = useState<{ id: string; name: string } | null>(null)
  const allergenLocale: AllergenLocale = locale === 'hr' ? 'hr' : 'sl'
  const allergenLbl = (code: string) =>
    (ALLERGEN_CODES as readonly string[]).includes(code) ? allergenLabel(code, allergenLocale) : code
  const [saleCart, setSaleCart] = useState<Record<string, number>>({})
  // Issue #71 audit-32: privzeta izbira = PRAVA KATEGORIJA (ne »Vse« — 436 ploščic naenkrat
  // redči mrežo in zatika drsenje na tablici). Uporabnikov izbor vedno premaga privzeto.
  const [saleCat, setSaleCat] = useState('ALL')
  const saleCatTouched = useRef(false)
  useEffect(() => {
    if (saleCatTouched.current || saleCat !== 'ALL' || categories.length === 0) return
    setSaleCat(categories[0].id)
  }, [categories, saleCat])
  const [saleSearch, setSaleSearch] = useState('')
  const [saleSending, setSaleSending] = useState(false)
  const [saleErr, setSaleErr] = useState('')
  // v1.128.0 — list košare (bottom sheet) za mobilni tok: artikli gredo V KOŠARICO,
  // ne vsebina, ki se nabira pod mrežo (Square/Toast vzorec vrstice + lista)
  const [saleCartOpen, setSaleCartOpen] = useState(false)
  const saleIsMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches

  const kdsMinutes = (iso: string): number => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  /* ISSUE #74 V-3: starostni razred listka — PET stopenj (siva/emerald/amber/
     oranžni utrip/rdeča) z NASTAVLJIVIMI pragovi (kdsAgeTh iz localStorage) in
     per-postajnim ciljem (OPS-11: max(10, ceil(cilj×1.25)) prag lahko samo dvigne).
     Zamenjava lokalne kdsAgeClass (siva/emerald/amber/rdeča, prag 5/10) — enoten
     vir v kds-delays.ts skupaj s kds-station-board. */
  const kdsAgeCls = (m: number, targetMin?: number | null) => kdsAgeClass(m, targetMin, kdsAgeTh)
  // OPS-11 val 1: station prep target of an item (bucket from mapOrderItem) — null → global 10 min
  const kdsTargetOf = (it: OrderItemT): number | null => stationTargets?.[it.station || 'KITCHEN'] ?? null
  // OPS-9 val 3: per-item live timer — firedAt when present (matches server prepMin), else order clock
  const kdsItemAge = (it: OrderItemT, o: OrderT): number => kdsMinutes(it.firedAt || o.createdAt)
  /** Bump to READY: late item (> per-station threshold, default 10 min) asks for a delay reason first (Lightspeed pattern). */
  const bumpReady = (it: OrderItemT, o: OrderT) => {
    const age = kdsItemAge(it, o)
    if (isLatePrep(age, kdsTargetOf(it))) setDelayAsk({ itemId: it.id, name: it.name, min: age })
    else void setItemStatus(it.id, 'READY')
  }

  // ── Issue #14 (v1.112.0): named-station view resolution ──
  // custom stations = every type that is NOT one of the two legacy buckets; they
  // get their own picker button and the task board instead of the order queue.
  const kdsCustomStations = kdsStations.filter((s) => {
    const ty = (s.type || '').toLowerCase()
    return ty !== 'bar' && ty !== 'kitchen'
  })
  // selected station object (undefined = legacy view, incl. stale ids pre-DDL)
  const kdsCustomStation = kdsCustomStations.find((s) => s.id === kdsStation)
  const kdsCustomView = kdsCustomStation !== undefined
  // legacy queue/86 filters use ONLY the two buckets — an unknown/custom id must
  // not silently empty the queue (it renders the task board instead)
  const kdsLegacyBucket: 'ALL' | 'KITCHEN' | 'BAR' = kdsStation === 'KITCHEN' || kdsStation === 'BAR' ? kdsStation : 'ALL'

  // OPS-4: zvok ob novem cakajocem artiklu na izbrani postaji (WebAudio, brez sredstev)
  // Issue #14: a custom station view counts NEW PENDING tasks of that station
  // (kdsTasks) instead of legacy queue items — the semantics stay the same.
  useEffect(() => {
    const pending = kdsCustomView
      ? kdsTasks
          .filter((task) => task.stationId === kdsStation && task.status === 'pending')
          .reduce((s, task) => s + task.quantity, 0)
      : viewKitchen
          .flatMap((o) => o.items.filter((it) => !it.voided && it.status === 'PENDING' && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
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
  }, [viewKitchen, kdsStation, kdsSound, kdsTasks, kdsCustomView])

  // OPS-4: 86 (razprodano) iz KDS — ozek endpoint menu.availability (ločen od Meni urejanja = menu.manage)
  const kdsToggleAvailable = async (mi: MenuT) => {
    try {
      await api(`/api/menus/${mi.id}/availability`, { method: 'PATCH', body: JSON.stringify({ available: !mi.available }) })
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) }
  }

  // P0-3 (v1.83.0) — 86 PLOŠČA (Toast/Square vzorec): proaktivni 86 katerega koli artikla,
  // obnova z enim klikom + avtomatski nadomestki iz iste kategorije (kuhinja/šank jih
  // pove natakarju/gostu). OPS-4 je dal gumb samo ZNOTRAJ listk aktivnih naročil — za
  // artikle izven vrste je bilo treba v zavihek Meni. Plošča spoštuje pogled lokacije
  // (triaža ⑧) in postajni filter za iskalne zadetke; seznam razprodanega je viden
  // vsem postajam (natakar mora vedeti za 86 tudi iz tuje postaje).
  const kdsBoardMenu = filterByLocation(menu, viewLoc)
  const kdsSoldOut = kdsBoardMenu.filter((mi) => !mi.available)
  const kdsSubstitutesFor = (mi: MenuT): MenuT[] =>
    kdsBoardMenu
      .filter((x) => x.available && x.id !== mi.id && !!mi.categoryId && x.categoryId === mi.categoryId)
      .sort((a, b) => (a.station === mi.station ? 0 : 1) - (b.station === mi.station ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 3)
  const kds86Candidates = kds86Search.trim()
    ? kdsBoardMenu.filter((mi) =>
        mi.available
        && (kdsLegacyBucket === 'ALL' || (mi.station || 'KITCHEN') === kdsLegacyBucket)
        && mi.name.toLowerCase().includes(kds86Search.trim().toLowerCase()))
    : []

  // OPS-4 hitra prodaja (sank): izbira -> kosarica -> POST (TAKEOUT) -> placilni dialog
  // ISSUE #73 audit-15: ploščica »jed · različica · velikost« — v MEŠANEM pogledu
  // (Vse kategorije / iskanje čez kategorije) ploščica dobi OVERLINE s kategorijo
  // (jed), ime artikla je različica, velikost je del imena (»0,5 l«). Golih imen
  // prilagodb (»Z gobami«) in podvojenih imen z različnima cenama (»Bolognese
  // 10,90/12,50«) v mešanem pogledu ni več mogoče zamenjati.
  const saleMixed = saleCat === 'ALL' || saleSearch.trim() !== ''
  const saleCatNameOf = (mi: MenuT) => categories.find((c) => c.id === mi.categoryId)?.name ?? ''
  // iskanje po ŽETONIH: vsaka beseda poizvedbe mora biti v (ime + kategorija)
  // (»pizze bolognese«, »testenine gobami«) — nadloga poišče artikel tudi po
  // kontekstu jedi; ŽETONI, ne sosednji podniz, da preskočijo ločila
  const saleQ = saleSearch.trim().toLowerCase()
  const saleTokens = saleQ ? saleQ.split(/\s+/).filter(Boolean) : []
  const saleItems = menu.filter((mi) =>
    mi.available
    && (saleCat === 'ALL' || mi.categoryId === saleCat)
    && (saleTokens.length === 0
      || saleTokens.every((tok) => `${mi.name} ${saleCatNameOf(mi)}`.toLowerCase().includes(tok))))
  const saleTotal = Object.entries(saleCart).reduce((s, [id, qty]) => s + (menu.find((x) => x.id === id)?.price ?? 0) * qty, 0)
  // vizualni benchmark (Toast/Square): skupno število kosov za oznako v glavi košare
  const saleCartCount = Object.values(saleCart).reduce((s, q) => s + q, 0)
  // ISSUE #73 audit-15: podvojena prikazna imena ČEZ kategorije (isti niz,
  // različna artikla — »Bolognese« testenina/pica) — v košari morajo biti
  // RAZLOČNA: −1 na napačni vrstici v naglici pomeni izgubljen račun.
  // Kontekst kategorije se prikaže SAMO pri dvoumnih imenih (ne vsi).
  const saleAmbiguous = useMemo(() => {
    const cnt = new Map<string, number>()
    for (const mi of menu) {
      const k = normItemName(mi.name)
      cnt.set(k, (cnt.get(k) ?? 0) + 1)
    }
    return new Set([...cnt.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  }, [menu])
  // ISSUE #73 audit-15 (dopolnitev po E2E): enovrstični »ime · kategorija« v
  // ozkem desnem tiru košare TRUNCIRA kontekst stran (VLM preverba: vidno je
  // bilo »1× Bolognese …«) — razločitev mora biti VIDNA, ne odrezana. Zato
  // dvovrstična postavitev: ime v 1. vrstici, kontekst kategorije v 2. (samo
  // pri dvoumnih imenih). −1 na napačni vrstici v naglici = izgubljen račun.
  const SaleCartLineName = ({ mi, qty }: { mi: MenuT; qty: number }) => {
    const cn = saleAmbiguous.has(normItemName(mi.name)) ? saleCatNameOf(mi) : ''
    return (
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate font-medium leading-tight">{qty}× {mi.name}</span>
        {cn ? <span className="min-w-0 truncate text-xs leading-tight text-stone-400">{cn}</span> : null}
      </span>
    )
  }

  // OPS-4 v1.67.0 — tloris lokala (Mize): pogled + vlečenje miz (posX/posY v %)
  const [tableView, setTableView] = useState<'grid' | 'plan'>('grid')
  const [planPos, setPlanPos] = useState<Record<string, { x: number; y: number }>>({})
  const dragIdRef = useRef<string | null>(null)
  const draggedRef = useRef(false)
  // tloris platno: posX/posY ima DVE zgodovinski enoti — seed + trenutni PATCH
  // shranjujeta PX na dizajn-platnu 440×380 (40..400/40..340), starejši demo zapisi
  // v produkciji pa ODSTOTKE (8..70). Issue #70 §4: pozicije razrešuje skupna čista
  // preslikava src/lib/floor-plan.ts (detekcija enote NABORA + avto-mreža za mize
  // brez pozicije) — brez mutacije obstoječih DB vrednosti; v UI delamo z %.
  const PLAN_W = FLOOR_PLAN_W
  const PLAN_H = FLOOR_PLAN_H
  const planPosOf = (tb: TableT): { x: number; y: number } =>
    planPos[tb.id] ?? planPositionOf({ id: tb.id, zone: tb.zone, posX: tb.posX ?? 0, posY: tb.posY ?? 0 }, viewTables.map((x) => ({ id: x.id, zone: x.zone, posX: x.posX ?? 0, posY: x.posY ?? 0 })))
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
    // Issue #70 §4: persist v ENOTO NABORA — odstotkovski (stari demo) nabor ostane
    // homogen odstotkovski, px nabor (seed) ostane px; mešanje enot ne nastane.
    const percent = floorPlanUnitIsPercent(viewTables.map((x) => ({ id: x.id, zone: x.zone, posX: x.posX ?? 0, posY: x.posY ?? 0 })))
    const body = percent
      ? { posX: Math.round(pos.x), posY: Math.round(pos.y) }
      : { posX: Math.round(pos.x / 100 * PLAN_W), posY: Math.round(pos.y / 100 * PLAN_H) }
    void api(`/api/tables/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).catch(() => null)
  }

  async function submitSale() {
    const items = Object.entries(saleCart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
    if (items.length === 0) return
    // Naloga #7: lokacija je obvezen parameter CREATE (requireUserLocation). Osebje
    // jo ima v seji; centralna vloga brez sejske lokacije jo mora izbrati v glavi.
    // Preverimo PRED oddajo — strežnikova 400 se je doslej pokazala kot blokirni
    // window.alert šele po kliku, ko je gost že čakal.
    if (locList.length > 0 && isCentralUIRole(user?.role) && !user?.locationId && !viewLoc) {
      setSaleErr(t('sale.noLocation'))
      // v1.128.0: napaka mora biti VIDNA — na mobilnem odpri list košare (in s tem sporočilo)
      if (saleIsMobile()) setSaleCartOpen(true)
      return
    }
    setSaleErr('')
    setSaleSending(true)
    try {
      const j = await api<{ order: { id: string } }>('/api/orders', {
        method: 'POST',
        // v1.86.2: centralna vloga brez lokacije → lokacija iz preklopnika pogleda (viewLoc);
        // JSON.stringify izpušče undefined → za osebje/lokalizirane vloge se nič ne spremeni
        body: JSON.stringify({ items, type: 'TAKEOUT', guests: 1, clientOperationId: newOperationId(), locationId: viewLoc || undefined }),
      })
      setSaleCart({})
      // v1.128.0: uspešno plačilo zapre list košare (odpre se plačilni dialog naročila)
      setSaleCartOpen(false)
      const fresh = await api<{ orders: OrderT[] }>('/api/orders')
      setOrders(fresh.orders)
      await load()
      const created = fresh.orders.find((x) => x.id === j.order?.id)
      if (created) void openPayment(created)
    } catch (err) {
      setSaleErr((err as Error).message)
      // v1.128.0: napaka iz plačila v vrstici → odpri list, da je sporočilo vidno
      if (saleIsMobile()) setSaleCartOpen(true)
    } finally { setSaleSending(false) }
  }
  const zones = [...new Set(viewTables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b))

  // OPS-8 val 3 (v1.73.0): status filter chips — client-side filtering via lib/reservation-filters
  const filteredRes = filterReservations(reservations, resFilter, Date.now())

  return (
    <main data-screen="dashboard" className="min-h-screen flex flex-col bg-stone-50">
      {/* Naloga #11 (WCAG 2.4.1): 31 zavihkov + glava sta pred vsebino — tipkovnica
          mora preskočiti na vsebino z enim Tab namesto z 40. */}
      <a
        href="#dash-vsebina"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-stone-900 focus:shadow-lg focus:outline focus:outline-2 focus:outline-emerald-700"
      >
        {t('a11y.skipToContent')}
      </a>
      <header data-region="dashboard-header" className="sticky top-0 z-20 bg-white border-b border-stone-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <Utensils className="w-4 h-4" />
            </div>
            <span className="font-bold truncate">RestaurantOS</span>
            {/* ISSUE #74 V-16: verzija iz glave ODSTRANJENA — ostaja samo v
                Nastavitve → Sistem (sys.version) in /api/health; lastnik ne potrebuje
                razvojne oznake ob vsakem pogledu */}
            {/* Triage ⑧ — pogledi: preklopnik lokacije za centralne vloge (OWNER/ADMIN) */}
            {isCentralUIRole(user?.role) && locList.length > 0 && (
              <Select value={viewLoc || 'all'} onValueChange={(v) => setViewLoc(v === 'all' ? '' : v)}>
                {/* ISSUE #74 V-18: ime lokacije se ne reže več brez okrajšave
                    (»Restaur«) — vsebina sprožilca je truncatirana na mobilnem */}
                <SelectTrigger className="h-8 w-[120px] sm:w-[190px] gap-1.5 text-xs min-w-0 [&>span]:truncate" aria-label={t('header.viewAria')}>
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
            {/* online/offline/sync status (issue #1) — klik za ročno sinhronizacijo;
                Issue #3 §A (P0): dead operacije → rdeča intervencija (klik odpri pogled) */}
            {deadOps.length > 0 ? (
              <button
                type="button"
                onClick={() => setDeadOpen(true)}
                title={t('sync.deadTitle')}
                aria-live="polite"
                className="flex items-center gap-1 rounded-full border border-red-300 bg-red-100 text-red-800 px-2 py-1 text-xs font-semibold transition hover:bg-red-200"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{t('header.netDead', { n: deadOps.length })}</span>
              </button>
            ) : (
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
            )}
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
            <Button variant="ghost" size="icon" onClick={() => void load()} aria-label={t('common.refresh')}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <span className="text-sm text-stone-600 hidden sm:block truncate max-w-40">{user?.name}</span>
            <Button variant="ghost" size="icon" onClick={() => setConfirmLogout(true)} aria-label={t('header.logout')}><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      <div id="dash-vsebina" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 py-6 outline-none">
        <h1 className="sr-only">{t('dash.h1')}</h1>
        {/* ISSUE #72 B1: uporabnik brez dodeljene lokacije vidi ČISTO STANJE z razlogom
            (»pokličite vodjo«) namesto praznih seznamov brez sporočila — locationScope
            senčilo '__no_location__' vrne []/ničle, kar je brez tega videti kot prazen local. */}
        {user && !user.locationId && !isCentralUIRole(user.role) && (
          <div role="alert" data-region="no-location-banner" className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <MapPin className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-800">{t('emp.noLocTitle')}</p>
              <p className="text-xs text-amber-700">{t('emp.noLocBody')}</p>
            </div>
          </div>
        )}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <div data-region="dashboard-nav" className="flex min-w-0 items-center gap-2">
            <TabsList data-region="dashboard-tabs" className="min-w-0 flex-1 justify-start overflow-hidden h-auto flex-nowrap bg-white border border-stone-200 p-1">
              {DASHBOARD_TABS
                // v1.129.0 (POS benchmark, POPRAVEK): AKTIVEN zavihek je VEDNO viden v vrstici —
                // čistilka (haccp) in skladiščnik (zaloge) prej niso videli svojega pristajalnega
                // zavihka, ker ni v trdnem naboru DASHBOARD_PRIMARY_TABS (bil samo v meniju Več).
                .filter(([v]) => DASHBOARD_PRIMARY_TABS.has(v) || v === activeTab)
                // UI gating po dovoljenjih — backend uveljavlja neodvisno; neznan zavihek ostane skrit.
                .filter(([v]) => tabHasPerm(v, { canManage, perms }))
                .map(([v, Icon]) => (
                  <TabsTrigger
                    key={v}
                    value={v}
                    aria-label={t(`tabs.${v}`)}
                    title={t(`tabs.${v}`)}
                    /* ISSUE #74 V-18: mobilna navigacija ni več »same ikone« — napis POD
                       ikono (flex-col, text-xs, truncate 64 px) na <sm, običajna vodoravna
                       vrstica od sm. Prej: 5 gumbov brez besedilnih oznak pri 390 px. */
                    className={`min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-1.5 items-center data-[state=active]:bg-emerald-700 data-[state=active]:text-white dark:data-[state=active]:bg-emerald-700 dark:data-[state=active]:text-white whitespace-nowrap ${DASHBOARD_MOBILE_PRIMARY_TABS.has(v) || v === activeTab ? 'inline-flex' : 'hidden lg:inline-flex'}`}
                  >
                    {Icon && <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    <span className="max-w-16 truncate text-xs sm:max-w-none sm:text-sm">{v === 'prodaja' ? (t('tabs.prodajaShort') || t('tabs.prodaja')) : t(`tabs.${v}`)}</span>
                  </TabsTrigger>
                ))}
            </TabsList>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={t('tabs.more')}
                  title={t('tabs.more')}
                  className="h-10 shrink-0 gap-1.5 rounded-xl px-3"
                >
                  <MoreVertical className="w-4 h-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{t('tabs.more')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
                {/* ISSUE #74 V-17: razdelki — Operativa / Gostje / Zaloge in finance /
                    Ekipa / Sistem (prej 27 ciljev v ravnem seznamu brez razdelkov) */}
                {TAB_GROUP_KEYS.map((g, gi) => {
                  const groupTabs = DASHBOARD_TABS
                    .filter(([v]) => !DASHBOARD_MOBILE_PRIMARY_TABS.has(v))
                    .filter(([v]) => tabHasPerm(v, { canManage, perms }))
                    .filter(([v]) => (TAB_GROUP_OF[v] ?? 'ops') === g)
                  if (groupTabs.length === 0) return null
                  return (
                    <DropdownMenuGroup key={g}>
                      {gi > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-[11px] font-bold uppercase tracking-wider text-stone-400">{t(TAB_GROUP_LABEL_KEY[g])}</DropdownMenuLabel>
                      {groupTabs.map(([v, Icon]) => (
                        <DropdownMenuItem
                          key={v}
                          onSelect={() => setActiveTab(v)}
                          className={`${activeTab === v ? 'bg-emerald-50 text-emerald-900 focus:bg-emerald-100' : ''} ${DASHBOARD_PRIMARY_TABS_HIDDEN_BELOW_LG.has(v) ? 'lg:hidden' : ''}`}
                        >
                          {Icon && <Icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />}
                          <span>{t(`tabs.${v}`)}</span>
                          {activeTab === v && <Check className="ml-auto h-4 w-4" aria-hidden="true" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <TabsContent value="pregled" className="space-y-6">
            {viewLoc && (
              <p className="text-sm text-stone-500 flex items-center gap-1.5" aria-live="polite">
                <MapPin className="w-4 h-4 text-emerald-700" /> {t('dash.viewLabel', { name: locList.find((l) => l.id === viewLoc)?.name || t('dash.locationFallback') })}
              </p>
            )}
            {/* v1.129.0 (Toast/Square benchmark): finančni kazalniki PRVI (promet + Δ% vs
                včeraj + povprečni račun), operativni števci za njimi; vsaka kartica je
                KLIKLJIVA in vodi v pripadajoči zavihek (Toast: »every number is clickable«).
                financialPerm (reports.view) določa, ali se finančne kartice sploh pokažejo. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {([
                {
                  label: t('dash.todayRevenue'), value: stats && stats.financialPerm ? fmtEUR(stats.todayRevenue) : undefined, Icon: Banknote,
                  sub: stats && stats.financialPerm
                    ? `${stats.todayOrders}× · ${stats.yesterdayRevenue !== null && stats.yesterdayRevenue > 0
                        ? `${t('dash.vsYesterday')} ${fmtPctSigned((stats.todayRevenue - stats.yesterdayRevenue) / stats.yesterdayRevenue)}`
                        : t('dash.vsYesterdayNoData')}`
                    : undefined,
                  tab: 'racuni',
                },
                {
                  label: t('dash.avgTicket'), value: stats && stats.financialPerm && stats.todayOrders > 0 ? fmtEUR(stats.todayRevenue / stats.todayOrders) : undefined, Icon: ReceiptText,
                  tab: 'racuni',
                },
                { label: t('dash.activeOrders'), value: stats?.activeOrders, Icon: ClipboardList, tab: 'narocila' },
                { label: t('dash.openTables'), value: stats?.openTables, Icon: Utensils, tab: 'mize' },
              ] as { label: string; value: React.ReactNode; Icon: typeof Banknote; sub?: string; tab: string }[])
                .filter((k) => k.value !== undefined)
                .map((k) => {
                  const Ic = k.Icon
                  return (
                    <button
                      key={k.label}
                      type="button"
                      onClick={() => { setActiveTab(k.tab); history.replaceState(null, '', `/dashboard?tab=${k.tab}`) }}
                      aria-label={t('dash.kpiAria', { label: k.label })}
                      title={t('dash.kpiAria', { label: k.label })}
                      className="text-left rounded-xl border border-stone-200 bg-white shadow-sm hover:border-emerald-400 hover:shadow transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                    >
                      <div className="p-4 sm:p-6">
                        <p className="text-sm font-medium text-stone-500 flex items-center gap-1.5">{Ic && <Ic className="w-4 h-4" />} {k.label}</p>
                        <p className="text-2xl font-bold tabular-nums">{k.value ?? '—'}</p>
                        {k.sub && <p className="text-xs text-stone-500 mt-1">{k.sub}</p>}
                      </div>
                    </button>
                  )
                })}
            </div>
            {/* Issue #21 (v1.111.0) — plošča klicev vodje (15 s polling = pogon lenih
                eskalacij). ISSUE #74 V-14: nad gubo NISTA več dva nalogena modula —
                klici in aktivna naročila sta v ENI vrstici (lg 2 stolpca), prazen
                modul klicev se skrči na glavo z enovrstičnim »ni aktivnih«. */}
            <div className="grid gap-4 lg:grid-cols-2">
              {hasPerm('employees.manage') && <ManagerCallsCard />}
              <Card>
                <CardHeader><CardTitle className="text-base">{t('dash.activeOrders')}</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {viewOrders.slice(0, 6).map((o) => (
                      <div key={o.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold truncate">{o.table?.name || orderTypeL(o.type)}</p>
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
            </div>
            {/* OPS-10 val 1 (v1.77.0) — analitika: prodaja po urah + labor stroški (lazy fetch ko sta vidna) */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <SalesByHourCard />
              <LaborCostCard />
            </div>
            {/* Issue #10 (v1.117.0) — Strošek dela in pokritost izmen: načrtovano vs.
                dejansko + urna matrika + napoved pokritosti (isti 'pregled' blok kot
                LaborCostCard — backend varuje reports.view; lazy fetch ko je vidna). */}
            <LaborCoverageCard locations={locStats.map((l) => ({ id: l.id, name: l.name }))} />
          </TabsContent>

          <TabsContent value="mize" className="space-y-6">
            {/* OPS-4 v1.67.0 — tloris lokala: vizualni prikaz miz + vlečenje (shema posX/posY) */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button size="sm" variant={tableView === 'grid' ? 'default' : 'outline'} className={tableView === 'grid' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('grid')}>{t('tables.gridView')}</Button>
              <Button size="sm" variant={tableView === 'plan' ? 'default' : 'outline'} className={tableView === 'plan' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('plan')}>{t('tables.planView')}</Button>
              {tableView === 'plan' && <span className="text-xs text-stone-500">{t('tables.planHint')}</span>}
              {/* Issue #21 (v1.111.0) — klic vodje (osebje vseh vlog) */}
              <ManagerCallButton size="sm" className="ml-auto" />
            </div>
            {/* Vizualni benchmark (Toast/Lightspeed): trajna legenda statusov — barvne pike
                z besedilom, da nov sla takoj ve, kaj pomeni barva mize (brez ugibanja). */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-stone-600" role="group" aria-label={t('tables.legend')}>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-emerald-700" aria-hidden /> {stL('FREE')}</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-amber-700" aria-hidden /> {stL('OCCUPIED')}</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-stone-400 bg-stone-200" aria-hidden /> {stL('RESERVED')}</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-stone-700" aria-hidden /> {stL('DIRTY')}</span>
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
                      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-lg shadow px-2 py-1.5 text-xs font-bold cursor-grab active:cursor-grabbing ${statusColors[tb.status] ?? 'bg-stone-500 text-white'}`}
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
                  {/* ISSUE #74 V-12: prej rigidna mreža (vse ploščice 197 px ne glede na
                      2–10 sedežev) + višina odvisna od stanja (97 proti 115–119 px) →
                      nazobčane vrstice, gumb je padal iz kartice. Zdaj: FLEX vrstice s
                      širino ∝ sedežem (tableTileWidthCls: w-44/w-52/w-60) + FIKSNA
                      višina h-32 vseh stanj — QR/⋮ ostane VZNOTRIJ kartice. */}
                  <div className="flex flex-wrap gap-3">
                    {zt.map((tb) => (
                      <div key={tb.id} className={`relative ${tableTileWidthCls(tb.seats)}`}>
                        <button
                          onClick={() => {
                            // miza za pospravit → en klik = očisti (issue #1: e2e zaključek)
                            if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
                            if (!tb.activeOrder) { setCart({}); setNewOrderTable(tb) } else { const o = orders.find((x) => x.id === tb.activeOrder!.id); if (o) void openOrderSheet(o) }
                          }}
                          className={`flex h-32 w-full flex-col rounded-xl p-3 text-left shadow transition ${statusColors[tb.status]} overflow-hidden`}
                        >
                          <p className="font-bold text-lg flex items-center gap-2">
                            {tb.name}
                            {tb.status === 'DIRTY' && <SprayCan className="w-5 h-5 shrink-0 opacity-90" aria-hidden />}
                          </p>
                          <p className="text-xs opacity-90">{t('tables.seats', { n: tb.seats })}</p>
                          {/* Issue #71 audit-21: status je BESEDILO, ne samo barva (barvna slepota,\n                              sončna svetloba na tablici) */}
                          {tb.status !== 'FREE' && (
                            <p className="mt-0.5 text-xs font-bold uppercase tracking-wide opacity-95">{stL(tb.status)}</p>
                          )}
                          {/* v1.129.0 (Toast/Square benchmark): zasedena ploščica nosi ČAS (min
                              od naročila) in FAZO naročila (poslano/v pripravi/pripravljeno),
                              ne samo znesek — natakar naletu vidi, katera miza čaka hrano.
                              Toast: elapsed time; Square: turn-yellow-after-X-min prag.
                              ISSUE #74 V-13: dodana št. naročila in gostje — ploščica je
                              samozadosten vir (prej: znesek + čas, brez identitete naročila). */}
                          {tb.activeOrder && (() => {
                            const ao = orders.find((x) => x.id === tb.activeOrder!.id)
                            const elapsed = ao ? kdsMinutes(ao.createdAt) : null
                            return (
                              <div className="min-w-0">
                                {ao && (
                                  <p className="text-xs font-semibold tabular-nums opacity-95 truncate">
                                    #{ao.orderNumber ?? '?'}{ao.guests > 0 ? ` · ${ao.guests} ${t('orders.persons')}` : ''}
                                  </p>
                                )}
                                <div className="flex items-baseline justify-between gap-2 mt-0.5 min-w-0">
                                  {elapsed !== null && (
                                    <span className="text-sm font-extrabold tabular-nums shrink-0" title={t('tables.sinceOrder', { m: elapsed })}>
                                    ⏱ {t('tables.elapsedMin', { m: elapsed })}
                                  </span>
                                )}
                                <span className="text-sm font-bold tabular-nums ml-auto">{fmtEUR(tb.activeOrder.total)}</span>
                                </div>
                              </div>
                            )
                          })()}
                          <p className="text-xs pt-1 opacity-80 mt-auto">
                            {/* Issue #70 §1: oznaka IZKLJUČNO iz kanonskega statusa (/api/tables) —
                                OCCUPIED iz statusa pomeni isto kot activeOrder (mapTable), zato sta
                                plosci (grid) in handheld/tablica vedno usklajena.
                                v1.129.0: oznaka ostaja na kanoničnem statusu (faza naročila
                                je že vidna v vrstici zneska/časa zgoraj) — Toast order-stage vzorec. */}
                            {tb.status === 'DIRTY' ? t('tables.clickClean') : stL(tb.status)}
                          </p>
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

          {/* Issue #3 §A (P0): dead-letter offline operacije — intervencijski pogled (retry / zavzi / izvoz) */}
          <Dialog open={deadOpen} onOpenChange={setDeadOpen}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 text-red-600" /> {t('sync.deadTitle')}</DialogTitle>
                <DialogDescription>{t('sync.deadHint')}</DialogDescription>
              </DialogHeader>
              <div className="max-h-72 overflow-y-auto space-y-2">
                {deadOps.length === 0 ? (
                  <p className="text-sm text-stone-500 py-4 text-center">{t('sync.deadDone')}</p>
                ) : deadOps.map((o) => (
                  <div key={o.clientOperationId} className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t(`sync.deadKind.${o.kind}`)}</span>
                      <Button size="sm" variant="outline" onClick={() => retryDead(o.clientOperationId)}>
                        <RefreshCw className="w-3.5 h-3.5" /> {t('sync.deadRetry')}
                      </Button>
                    </div>
                    <div className="text-xs text-stone-600">
                      {t('sync.deadAttempts', { n: o.attempts })} · {new Date(o.createdAt).toLocaleString()}
                    </div>
                    {o.lastError && <div className="text-xs text-red-700 break-all">{t('sync.deadLast', { err: o.lastError })}</div>}
                  </div>
                ))}
              </div>
              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="outline" size="sm" onClick={exportDead} disabled={deadOps.length === 0}>
                  <Download className="w-3.5 h-3.5" /> {t('sync.deadExport')}
                </Button>
                <Button variant="destructive" size="sm" onClick={discardDead} disabled={deadOps.length === 0}>
                  <Trash2 className="w-3.5 h-3.5" /> {t('sync.deadClear')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

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
                  <p className="text-xs text-stone-400">{t('tables.qrHint')}</p>
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
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{o.table?.name || orderTypeL(o.type)} · {o.guests} {t('orders.persons')}</p>
                        {/* ISSUE #74 V-22: kartica naročila ima IDENTITETO — miza je že v
                            naslovu, tu pa številka naročila, ura in natakar (prej sta se
                            obe karti glasili enako »Na mesto · 1 osebi« brez razlike). */}
                        <p className="text-xs text-stone-500 truncate">
                          #{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}
                          {o.employee?.name ? ` · ${o.employee.name}` : ''}
                        </p>
                      </div>
                      <Badge className={statusColors[o.status]}>{stL(o.status)}</Badge>
                    </div>
                    {/* Issue #71 audit-23: privzeto 3 postavke + »＋ N ostalih« — naročilo z 27
                        postavicami ne sme biti neskončno drsenje; število in vsota ostaneta vidni. */}
                    {(() => {
                      const expanded = expandedOrderItems[o.id]
                      const shown = expanded ? o.items : o.items.slice(0, 3)
                      const rest = o.items.length - shown.length
                      return (
                        <div className="text-sm">
                          <ul className="space-y-1">{shown.map((it) => <li key={it.id} className="flex justify-between"><span>{it.qty}× {it.name}</span><span>{fmtEUR(it.qty * it.unitPrice)}</span></li>)}</ul>
                          {rest > 0 && (
                            <button type="button" onClick={() => setExpandedOrderItems((pr) => ({ ...pr, [o.id]: true }))} className="mt-1 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition-colors">
                              {t('orders.moreItems', { n: rest })}
                            </button>
                          )}
                          {expanded && o.items.length > 3 && (
                            <button type="button" onClick={() => setExpandedOrderItems((pr) => ({ ...pr, [o.id]: false }))} className="mt-1 min-h-11 w-full rounded-md text-xs font-medium text-stone-500 hover:text-stone-800 transition-colors">
                              {t('orders.showLessItems')}
                            </button>
                          )}
                        </div>
                      )
                    })()}
                    <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                      <p className="font-bold">{fmtEUR(o.total)}</p>
                      {o.status !== 'PAID' && (
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="outline" className="h-10 gap-1" onClick={() => void openOrderSheet(o)} title={t('orders.edit')}>
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
                          <Button size="sm" variant="outline" className="h-10 gap-1 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                            disabled={mmvBusy} onClick={() => void fireOrder(o)} title={t('mmv.fire')}>
                            <Flame className="w-3 h-3" /> {t('mmv.fire')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-10 gap-1 text-xs" disabled={mmvBusy}
                          onClick={() => { setMoveTableId(''); setMoveOrder(o) }} title={t('mmv.move')}>
                          <ArrowRightLeft className="w-3 h-3" /> {t('mmv.move')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-10 gap-1 text-xs"
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
            {/* v1.127.0 (vizualni benchmark Toast/Square): čipi kategorij (en dotik),
                trajna desna košara z lepljivo vsoto, krepka tipografija cen. */}
            {/* v1.128.0 — POPRAVEK »artikli gredo v košaro, ne spodaj« (Square/Toast vzorec):
                • ZAHTA: klik na artikel mora biti VIDEN — prej je spodnja kartica (position:sticky
                  v staršu brez višine) ostala na dnu DOKUMENTA, pod mrežo, izven zaslona.
                • ≥md (tablica/namizje): desna košara že od 768px (prej šele 1024px).
                • <md: FIKSNA vrstica košare (en same višina — mreža NIKOLI pokrita, spodnja
                  razdalja pb-20 drsi čez njo) + list košare (bottom sheet) s postavkami;
                  značka količine na ploščici artikla = takojšen povratni signal vnosa. */}
            <div className="md:grid md:grid-cols-[minmax(0,1fr)_17rem] md:items-start md:gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
              {/* LEVO: iskanje + čipi kategorij + mreža izbire */}
              {/* ISSUE #74 V-6 (blocker): prej 40 gumbov kategorij v 6 ovitih vrstah —
                mreža izbire se je začela šele pri y=429/860 px (na mobilnem 61 % višine).
                Toast/Square vzorec: iskanje VEDNO v svoji vrstici + ENA vodoravno drsna
                vrstica kategorij (flex-nowrap + overflow-x-auto) — mreža pri y≈140. */}
            <div className="min-w-0 space-y-3 pb-20 md:pb-0">
              <div className="flex items-center gap-2">
                <Input value={saleSearch} onChange={(e) => setSaleSearch(e.target.value)} placeholder={t('sale.search')} className="h-11 w-full sm:w-56" aria-label={t('sale.search')} />
              </div>
              {/* V-6: horizontalni TRAK kategorij (nowrap) — gumbi se nikoli ne ovijejo;
                  V-19: cilji 44 px (h-11) na POS, rounded-full chip videz (Square) */}
              <div
                className="flex items-center gap-1.5 overflow-x-auto flex-nowrap -mx-1 px-1 pb-1 [scrollbar-width:thin]"
                role="group" aria-label={t('sale.allCat')} tabIndex={0}
              >
                <Button size="sm" variant={saleCat === 'ALL' ? 'default' : 'outline'} className={`h-11 shrink-0 rounded-full whitespace-nowrap ${saleCat === 'ALL' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`} onClick={() => { saleCatTouched.current = true; setSaleCat('ALL') }}>
                  {t('sale.allCat')}
                </Button>
                {categories.map((c) => (
                  <Button key={c.id} size="sm" variant={saleCat === c.id ? 'default' : 'outline'} className={`h-11 max-w-44 shrink-0 rounded-full whitespace-nowrap ${saleCat === c.id ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`} onClick={() => { saleCatTouched.current = true; setSaleCat(c.id) }} title={c.name}>
                    <span className="truncate">{c.name}</span>
                  </Button>
                ))}
              </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                  {saleItems.map((mi) => {
                    const inCart = saleCart[mi.id] || 0
                    /* ISSUE #74 V-7 (blocker): FOTOGRAFIJA na ploščici artikla — prej
                       imgCount=0 v celem POS (bele kartice z imenom in ceno); slika 4:3
                       iz kategorije artikla (categoryImageForCategory), lazy loading. */
                    const img = mi.categoryId
                      ? categoryImageForCategory(categories.find((c) => c.id === mi.categoryId)?.name)
                      : CATEGORY_IMAGE_DEFAULT
                    // ISSUE #73 audit-15: overline »jed« = kategorija (samo v mešanem
                    // pogledu — znotraj izbrane kategorije je kontekst že v čipu)
                    const catOverline = saleMixed ? saleCatNameOf(mi) : ''
                    return (
                      <button key={mi.id} disabled={!mi.available} onClick={() => setSaleCart((pr) => ({ ...pr, [mi.id]: (pr[mi.id] || 0) + 1 }))}
                        aria-label={`${catOverline ? `${catOverline} · ` : ''}${mi.name} ${fmtEUR(mi.price)}${inCart > 0 ? ` · ${inCart}× ${t('sale.inCart')}` : ''}${!mi.available ? ` · ${t('sale.soldOut')}` : ''}`}
                        className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition ${mi.available
                          ? inCart > 0
                            ? 'border-emerald-600 bg-white hover:border-emerald-600 hover:shadow-md'
                            : 'border-stone-200 bg-white hover:border-emerald-600 hover:shadow-md'
                          : 'cursor-not-allowed border-red-200 bg-red-50/70'}`}>
                        <span className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden bg-stone-100" aria-hidden="true">
                          <img src={img} alt="" loading="lazy" draggable={false}
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04] group-active:scale-[0.97]" />
                          {inCart > 0 && (
                            <span key={inCart} aria-hidden="true" className="absolute right-1.5 top-1.5 z-10 flex h-6 min-w-6 items-center justify-center rounded-full bg-emerald-700 px-1.5 text-xs font-bold tabular-nums text-white shadow-sm animate-in zoom-in-75 duration-150">
                              {inCart}×
                            </span>
                          )}
                          {/* Issue #71 audit-16: 86 iz KDS-a je viden NA PLOŠČICI (rdeči trak),
                              ne tiho mrk — natakar NE proda artikla, ki ga je kuhinja že umaknila */}
                          {!mi.available && (
                            <>
                              <span className="absolute inset-0 bg-stone-100/60" />
                              <span className="absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full border border-red-300 bg-red-100 px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wider text-red-800 shadow-sm">86</span>
                            </>
                          )}
                        </span>
                        <span className="flex min-h-16 flex-1 flex-col p-2.5">
                          {/* ISSUE #73 audit-15: ploščica »jed · različica · velikost« —
                              overline (kategorija/jed) loči isto ime dveh različnih jedi
                              (»Bolognese« testenina/pica) in da starša golim imenom
                              prilagodb (»Z gobami« → »Testenine, njoki · Z gobami«). */}
                          {catOverline && (
                            <span className="mb-0.5 truncate text-[10px] font-semibold uppercase leading-tight tracking-wider text-stone-400" aria-hidden="true">{catOverline}</span>
                          )}
                          <p className="min-w-0 text-sm font-semibold leading-tight line-clamp-2">{mi.name}</p>
                          <p className={`mt-auto self-end pt-1 text-sm font-bold tabular-nums ${mi.available ? 'text-stone-900' : 'text-red-700/70 line-through'}`}>{fmtEUR(mi.price)}</p>
                        </span>
                      </button>
                    )
                  })}
                </div>
                {saleItems.length === 0 && <p className="text-sm text-stone-500">{t('sale.empty')}</p>}
              </div>

              {/* DESNO (≥md, tablica/namizje): trajna košara — Toast/Square vzorec »right rail«:
                  glava s števcem, drsni seznam postavk, vsota + Plačaj VEDNO pritrjena spodaj */}
              <aside className="hidden md:block" aria-label={t('sale.cartTitle')}>
                <Card className="sticky top-20 flex max-h-[calc(100vh-6.25rem)] flex-col shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between gap-2 text-base">
                      <span className="flex min-w-0 items-center gap-2">
                        <ShoppingCart className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
                        {t('sale.cartTitle')}
                        {saleCartCount > 0 && <Badge className="shrink-0 bg-emerald-700 tabular-nums text-white">{saleCartCount}</Badge>}
                      </span>
                      {saleCartCount > 0 && (
                        <Button size="sm" variant="ghost" className="h-10 shrink-0 px-2 text-xs text-stone-500 hover:text-red-700" onClick={() => setSaleCart({})} title={t('sale.clearCart')} aria-label={t('sale.clearCart')}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-2">
                    {saleCartCount === 0 ? (
                      <div className="flex min-h-36 flex-col items-center justify-center gap-1.5 text-center">
                        <ShoppingCart className="h-8 w-8 text-stone-300" aria-hidden />
                        <p className="text-sm font-medium text-stone-500">{t('sale.cartEmpty')}</p>
                        <p className="text-xs text-stone-400">{t('sale.cartEmptyHint')}</p>
                      </div>
                    ) : (
                      Object.entries(saleCart).map(([id, qty]) => {
                        const mi = menu.find((x) => x.id === id)
                        if (!mi) return null
                        return (
                          <div key={id} className="flex items-center gap-1.5 rounded-lg border border-stone-100 bg-stone-50/60 px-2 py-1.5 text-sm">
                            <SaleCartLineName mi={mi} qty={qty} />
                            <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="-1" onClick={() => setSaleCart((pr) => { const q = (pr[id] || 0) - 1; const nx = { ...pr }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })}>−</Button>
                            <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="+1" onClick={() => setSaleCart((pr) => ({ ...pr, [id]: (pr[id] || 0) + 1 }))}>+</Button>
                            <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{fmtEUR(mi.price * qty)}</span>
                          </div>
                        )
                      })
                    )}
                  </CardContent>
                  <div className="space-y-2 border-t border-stone-200 p-4">
                    <div className="flex items-center justify-between text-base font-bold">
                      <span>{t('sale.total')}</span>
                      <span className="tabular-nums">{fmtEUR(saleTotal)}</span>
                    </div>
                    <Button className="min-h-12 w-full bg-emerald-700 text-base font-bold hover:bg-emerald-800 disabled:bg-stone-200 disabled:text-stone-500 disabled:font-medium disabled:hover:bg-stone-200" disabled={saleSending || saleCartCount === 0} onClick={() => void submitSale()}>
                      {saleSending ? <Loader2 className="h-5 w-5 animate-spin" /> : t('sale.payNow')}
                    </Button>
                    {saleErr && (
                      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                        {saleErr}
                      </p>
                    )}
                  </div>
                </Card>
              </aside>
            </div>

            {/* MOBILNI (<md) — v1.128.0 Square/Toast vzorec: FIKSNA vrstica košare (vedno
                ena višina: ikona + števec, kosi in vsota, gumb Plačaj) + list košare
                (bottom sheet) s postavkami. Klik na artikel → značka na ploščici + števec
                vrstice POSKOČITA (košara JASNO prejme artikel); tap vrstice odpere list. */}
            <div className="md:hidden">
              <Drawer open={saleCartOpen} onOpenChange={setSaleCartOpen}>
                {saleCartCount > 0 && (
                  <div className="fixed inset-x-0 bottom-0 z-30 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                    <div className="animate-in slide-in-from-bottom-4 duration-200 flex items-stretch gap-2 rounded-2xl bg-white p-2 shadow-2xl ring-1 ring-stone-900/10">
                      <DrawerTrigger asChild>
                        <button type="button" className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left active:bg-stone-100"
                          aria-label={`${t('sale.openCart')} · ${saleCartCount}× · ${fmtEUR(saleTotal)}`}>
                          <span className="relative shrink-0">
                            <ShoppingCart className="h-6 w-6 text-emerald-700" aria-hidden />
                            <span key={saleCartCount} className="absolute -right-2 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-700 px-1 text-xs font-bold tabular-nums text-white shadow animate-in zoom-in-75 duration-150">{saleCartCount}</span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium uppercase tracking-wide text-stone-500">{t('sale.cartTitle')} · {saleCartCount}×</span>
                            <span className="block truncate text-lg font-bold leading-tight tabular-nums text-stone-900">{fmtEUR(saleTotal)}</span>
                          </span>
                          <ChevronUp className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />
                        </button>
                      </DrawerTrigger>
                      <Button className="h-12 shrink-0 gap-1.5 rounded-xl bg-emerald-700 px-4 text-sm font-bold hover:bg-emerald-800" disabled={saleSending} onClick={() => void submitSale()} aria-label={`${t('sale.pay')} ${fmtEUR(saleTotal)}`}>
                        {saleSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" aria-hidden />}
                        {t('sale.pay')}
                      </Button>
                    </div>
                  </div>
                )}
                <DrawerContent className="max-h-[85vh]">
                  <DrawerHeader className="pb-2">
                    <DrawerTitle asChild>
                      <div className="flex items-center justify-between gap-2 text-base font-semibold">
                        <span className="flex min-w-0 items-center gap-2">
                          <ShoppingCart className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
                          {t('sale.cartTitle')}
                          {saleCartCount > 0 && <Badge className="shrink-0 bg-emerald-700 tabular-nums text-white">{saleCartCount}</Badge>}
                        </span>
                        {saleCartCount > 0 && (
                          <Button size="sm" variant="ghost" className="h-9 w-9 shrink-0 p-0 text-stone-500 hover:text-red-700" onClick={() => setSaleCart({})} title={t('sale.clearCart')} aria-label={t('sale.clearCart')}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </DrawerTitle>
                    <DrawerDescription className="sr-only">{t('sale.drawerDesc')}</DrawerDescription>
                  </DrawerHeader>
                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-4 pb-2">
                    {saleCartCount === 0 ? (
                      <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 py-6 text-center">
                        <ShoppingCart className="h-8 w-8 text-stone-300" aria-hidden />
                        <p className="text-sm font-medium text-stone-500">{t('sale.cartEmpty')}</p>
                        <p className="text-xs text-stone-400">{t('sale.cartEmptyHint')}</p>
                      </div>
                    ) : (
                      Object.entries(saleCart).map(([id, qty]) => {
                        const mi = menu.find((x) => x.id === id)
                        if (!mi) return null
                        return (
                          <div key={id} className="flex items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/60 px-3 py-2.5 text-sm">
                            <SaleCartLineName mi={mi} qty={qty} />
                            <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="-1" onClick={() => setSaleCart((pr) => { const q = (pr[id] || 0) - 1; const nx = { ...pr }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })}>−</Button>
                            <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="+1" onClick={() => setSaleCart((pr) => ({ ...pr, [id]: (pr[id] || 0) + 1 }))}>+</Button>
                            <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{fmtEUR(mi.price * qty)}</span>
                          </div>
                        )
                      })
                    )}
                  </div>
                  <DrawerFooter className="gap-2 border-t border-stone-200 pt-3">
                    <div className="flex items-center justify-between text-base font-bold">
                      <span>{t('sale.total')}</span>
                      <span className="tabular-nums">{fmtEUR(saleTotal)}</span>
                    </div>
                    <Button className="min-h-12 w-full bg-emerald-700 text-base font-bold hover:bg-emerald-800 disabled:bg-stone-200 disabled:text-stone-500 disabled:font-medium disabled:hover:bg-stone-200" disabled={saleSending || saleCartCount === 0} onClick={() => void submitSale()}>
                      {saleSending ? <Loader2 className="h-5 w-5 animate-spin" /> : t('sale.payNow')}
                    </Button>
                    {saleErr && (
                      <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                        {saleErr}
                      </p>
                    )}
                  </DrawerFooter>
                </DrawerContent>
              </Drawer>
            </div>
          </TabsContent>

          <TabsContent value="kuhinja" className="space-y-4">
            {/* OPS-4 v1.67.0 — KDS upgrade: filtri postaj (zaslon sank = BAR), casovniki, zvok, 86 */}
            {/* Issue #14: named stations join the picker (type ≠ legacy buckets); the
                expo station carries a Ship badge (dispatch view) — small, wraps on mobile. */}
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('kds.stView')}>
              {(['ALL', 'KITCHEN', 'BAR'] as const).map((st) => (
                <Button key={st} size="sm" variant={kdsStation === st ? 'default' : 'outline'} className={kdsStation === st ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setKdsStation(st)}>
                  {st === 'ALL' ? t('kds.all') : st === 'KITCHEN' ? t('menu.stationKitchen') : t('menu.stationBar')}
                </Button>
              ))}
              {kdsCustomStations.map((st) => (
                <Button
                  key={st.id}
                  size="sm"
                  variant={kdsStation === st.id ? 'default' : 'outline'}
                  className={`gap-1 max-w-44 ${kdsStation === st.id ? 'bg-emerald-700 hover:bg-emerald-800' : ''} ${st.isExpo ? 'border-emerald-300' : ''}`}
                  onClick={() => setKdsStation(st.id)}
                  aria-label={st.isExpo ? `${st.name} · ${t('kds.stExpo')}` : st.name}
                  title={st.isExpo ? `${st.name} · ${t('kds.stExpo')}` : st.name}
                >
                  {st.isExpo && <Ship className="w-3.5 h-3.5 shrink-0" aria-hidden />}
                  <span className="truncate">{st.name}</span>
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
              {/* ISSUE #74 V-9: preklop pogleda — STOLPCI po statusu (board, privzeto)
                  ali navpičen SEZNAM (vprašljiva nega Toastova "radikalna sprememba"
                  — obstoječa postavitev ostane kot opcija, geste se ne prestavijo). */}
              {!kdsCustomView && (
                <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5" role="group" aria-label={t('kds.stView')}>
                  {(['columns', 'list'] as const).map((vw) => (
                    <button
                      key={vw}
                      type="button"
                      aria-pressed={kdsView === vw}
                      aria-label={vw === 'columns' ? t('kds.viewBoard') : t('kds.viewList')}
                      title={vw === 'columns' ? t('kds.viewBoard') : t('kds.viewList')}
                      onClick={() => { setKdsView(vw); kdsPersist('ro_kds_view', vw) }}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                        kdsView === vw ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                      }`}
                    >
                      {vw === 'columns' ? <Columns3 className="w-3.5 h-3.5" aria-hidden /> : <List className="w-3.5 h-3.5" aria-hidden />}
                      <span className="hidden sm:inline">{vw === 'columns' ? t('kds.viewBoard') : t('kds.viewList')}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* ISSUE #74 V-3/V-8: ⚙ NASTAVITVE ZASLONA (popover) — starostni pragovi
                  (siva→emerald→amber→utrip→rdeča), velikost pisave S/M/L/XL, gostota,
                  stolpci seznama. Toast/Square/Lightspeed reference: operater nastavi
                  ergonomske razrede, ker jih oblikovalec ne more uganiti. */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="gap-1" aria-label={t('kds.settings')} title={t('kds.settings')}>
                    <Settings2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t('kds.settings')}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 space-y-4">
                  {/* V-3: starostni pragovi */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{t('kds.settingsAgeTitle')}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {(['warn', 'urgent', 'late'] as const).map((k) => (
                        <label key={k} className="space-y-1">
                          <span className="block text-xs font-medium text-stone-600">
                            {k === 'warn' ? t('kds.ageFreshUntil') : k === 'urgent' ? t('kds.ageWarnFrom') : t('kds.ageLateFrom')}
                          </span>
                          <Input
                            type="number" min={1} max={600} inputMode="numeric"
                            value={kdsAgeDraft[k]}
                            onChange={(e) => setKdsAgeDraft({ ...kdsAgeDraft, [k]: Number(e.target.value) })}
                            aria-label={k === 'warn' ? t('kds.ageFreshUntil') : k === 'urgent' ? t('kds.ageWarnFrom') : t('kds.ageLateFrom')}
                            className="h-9 tabular-nums"
                          />
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-stone-500">{t('kds.settingsAgeHint')}</p>
                    <Button size="sm" className="h-9 w-full bg-emerald-700 hover:bg-emerald-800" onClick={() => kdsSaveAgeThresholds(kdsAgeDraft)}>
                      <Check className="w-3.5 h-3.5" /> {t('common.save')}
                    </Button>
                  </div>
                  {/* V-8: velikost pisave (A− A A+ A++ — velikost vidna NA gumbu, Toast vzorec) */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{t('kds.settingsFont')}</p>
                    <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t('kds.settingsFont')}>
                      {KDS_FONT_SIZES.map((fs) => (
                        <button
                          key={fs}
                          type="button"
                          aria-pressed={kdsFontSize === fs}
                          aria-label={t(KDS_FONT_LABEL_KEY[fs])}
                          title={t(KDS_FONT_LABEL_KEY[fs])}
                          onClick={() => { setKdsFontSize(fs); kdsPersist('ro_kds_font_size', fs) }}
                          className={`rounded-lg border py-2 font-bold transition ${
                            kdsFontSize === fs
                              ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-400'
                          } ${fs === 'S' ? 'text-xs' : fs === 'M' ? 'text-sm' : fs === 'L' ? 'text-base' : 'text-lg'}`}
                        >
                          {fs === 'S' ? 'A−' : fs === 'M' ? 'A' : fs === 'L' ? 'A+' : 'A++'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* V-8: gostota */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{t('kds.settingsDensity')}</p>
                    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('kds.settingsDensity')}>
                      {(['compact', 'normal'] as const).map((dn) => (
                        <button
                          key={dn}
                          type="button"
                          aria-pressed={kdsDensity === dn}
                          onClick={() => { setKdsDensity(dn); kdsPersist('ro_kds_density', dn) }}
                          className={`rounded-lg border py-2 text-xs font-semibold transition ${
                            kdsDensity === dn
                              ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-400'
                          }`}
                        >
                          {dn === 'compact' ? t('kds.densityCompact') : t('kds.densityNormal')}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* V-8: stolpci NAVPIČNEGA SEZNAMA (board ima fiksne 3 statusne) */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{t('kds.settingsColumns')}</p>
                    <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t('kds.settingsColumns')}>
                      {KDS_COLUMN_OPTIONS.map((cl) => (
                        <button
                          key={cl}
                          type="button"
                          aria-pressed={kdsColumns === cl}
                          onClick={() => { setKdsColumns(cl); kdsPersist('ro_kds_columns', String(cl)) }}
                          className={`rounded-lg border py-2 text-sm font-bold tabular-nums transition ${
                            kdsColumns === cl
                              ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-400'
                          }`}
                        >
                          {cl}
                        </button>
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {/* v1.129.0 (Toast benchmark): 86 PLOŠČA je premaknjena POD vrsto listkov in
                SKRČENA v eno vrstico — listki dobijo celoten zaslon na vrhu (prej je plošča
                porabila ~200px najboljšega prostora nad aktivnimi naročili). Odpri/skrij na klik. */}
            {/* Issue #14 (issue §4): per-station queue load chips on the ALL view —
                compact badges above the queue; tap switches to that station view
                (legacy types resolve to their bucket via stationViewKey). */}
            {kdsStation === 'ALL' && kdsStationStats.length > 0 && (
              <div role="group" aria-label={t('kds.stStatsTitle')} aria-live="polite" className="flex flex-wrap gap-1.5">
                {kdsStationStats.map((s) => {
                  const active = s.waiting + s.pending + s.preparing
                  const st = kdsStations.find((x) => x.id === s.stationId)
                  return (
                    <button
                      key={s.stationId}
                      type="button"
                      onClick={() => st && setKdsStation(stationViewKey(st))}
                      title={st?.isExpo ? `${s.stationName} · ${t('kds.stExpo')}` : s.stationName}
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition ${
                        active > 0
                          ? 'bg-amber-50 text-amber-800 border-amber-300 hover:border-amber-500'
                          : 'bg-stone-50 text-stone-500 border-stone-200 hover:border-stone-400'
                      }`}
                    >
                      {st?.isExpo && <Ship className="w-3 h-3 shrink-0" aria-hidden />}
                      <span className="max-w-28 truncate">{s.stationName}</span>
                      <span className="font-bold">{active}</span>
                      {s.ready > 0 && <span className="text-emerald-700">{s.ready}✓</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {/* Issue #14: custom station view → TASK BOARD (orders are managed by the
                station flow; the legacy queue stays for ALL/KITCHEN/BAR views). */}
            {kdsCustomView && kdsCustomStation && (
              <KdsStationBoard
                station={kdsCustomStation}
                tasks={kdsTasks}
                onDone={load}
                onPrintOrder={(orderId) => {
                  const o = kitchen.find((x) => x.id === orderId)
                  if (o) void printKitchenTicket(o, 'KITCHEN')
                }}
              />
            )}
            {/* Issue #70 §2: zastareli listki (> 8 h — demo/prejšnja izmena) so NA KONCU vrste
                (stabilno sortiranje ohrani createdAt ASC znotraj skupine), vizualno ločeni in
                označeni ZASTARELO z starostjo v urah — ne preglasijo prioritete aktivnih listkov,
                ostanejo pa vidni/operabilni za revizijo (kuhinja jih lahko zaključi). */}
            {/* Issue #71 audit-1: DVE LOCI — »Aktivna izmena« in »Zastarelo« (ločen oddelek,
                privzeto ZLOŽEN s števcem). Kuhar vidi, kaj je ZDAJ na vrsti; ostanki
                prejšnjih izmen/demo ostanejo dosegljivi za revizijo, a IZVEN aktivne vrste. */}
            {!kdsCustomView && (() => {
              const kdsQueue = viewKitchen
                .filter((o) => o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
                .slice()
                .sort((a, b) => Number(isStaleKdsTicket(kdsMinutes(a.createdAt))) - Number(isStaleKdsTicket(kdsMinutes(b.createdAt))))
              const kdsActive = kdsQueue.filter((o) => !isStaleKdsTicket(kdsMinutes(o.createdAt)))
              const kdsStale = kdsQueue.filter((o) => isStaleKdsTicket(kdsMinutes(o.createdAt)))
              const renderKdsTicket = (o: (typeof viewKitchen)[number]) => {
                const items = o.items.filter((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
                const ageMin = kdsMinutes(o.createdAt)
                const stale = isStaleKdsTicket(ageMin)
                /* ISSUE #74 V-3: starostni razred listka (5 stopenj) — en vir za LEVI ROB
                   (kdsAgeBorderCls) in PILL (kdsAgePillCls); oranžni utrip = urgent. */
                const ageCls = kdsAgeCls(ageMin)
                // Issue #71 audit-14 → #74 V-10: alergeni — hierarhija resnosti. RESNIČNI
                // alarm (alergijsko opozorilo) = RDEČ pas na vrhu listka; manjkajoči
                // podatki = RDEČ PAS z ikono (zakonsko obvezen podatek — uredba EU
                // 1169/2011; Lightspeed: alergen ima svojo fiksno rdečo vejo, ne sivo
                // mikroskupino, ki je bila najtjiša stvar na zaslonu).
                const allergyItems = items.filter((it) => it.allergenWarning)
                const unconfirmedCount = items.filter((it) => it.allergenStatus && it.allergenStatus !== 'confirmed' && !it.allergenWarning).length
                return (
                  /* Issue #69 (2. val): gostota listka — glava v dveh vrsticah (identiteta +
                     PRIMARNI STATUS listka, nato ČASOVNIK + tiskanje), postavke v kompaktne
                     vrstice z ločenimi čipi (postaja / alergeni / opomba) in lastno vrstico
                     dejanj. ISSUE #74 V-8: gostota (kompaktno/normalno) in velikost pisave
                     (S/M/L/XL — kdsFont) iz nastavitev zaslona. */
                  <Card
                    key={o.id}
                    data-region="kds-ticket"
                    /* v1.129.0 (Toast/Square): starost → BARVNI LEVI ROB listka.
                       ISSUE #74 V-3: rob sedaj po RAZREDU starosti (5 stopenj), ne prag 5/10.
                       VRSTNI RED razredov je KLJUČEN: cn() (tailwind-merge)
                       odstrani stransko-specifičen border-l-{color}, če celovit
                       border-{color} pride ZA njim — najprej nevtralen border, nato leva. */
                    className={`${kdsDensityCls.card} border-l-4 ${stale ? 'border-dashed border-stone-300 border-l-stone-300 bg-stone-50' : kdsAgeBorderCls(ageCls)}`}
                  >
                    <CardHeader data-region="kds-ticket-header" className="gap-2 px-4 pt-0 pb-0 sm:px-6">
                      <CardTitle className="text-base flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                        {/* ISSUE #74 V-8: nazivna vrstica sledi velikosti pisave (S=13 → XL=22 px) */}
                        <span className={`font-bold truncate max-w-full min-w-0 ${kdsFont.title}`}>{o.table?.name || orderTypeL(o.type)}</span>
                        {/* Issue #71 audit-2: tip naročila je ZNAČKA ob naslovu (miza = identiteta),
                            ne surovi enum; podnaslov #num + ura brez sekund + osebe + natakar */}
                        <span className="inline-flex shrink-0 items-center rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-xs font-semibold text-stone-600">{orderTypeL(o.type)}</span>
                        {o.employee?.name && <span className="text-xs font-normal text-stone-400 min-w-0 shrink truncate" title={o.employee.name}>· {o.employee.name}</span>}
                        <span className="text-xs font-normal text-stone-500 min-w-0 shrink">#{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })} · {t('kds.guestsShort', { n: o.guests })}</span>
                        {/* PRIMARNI STATUS — v1.129.0 (Toast/Square): NEVTRALEN obrobec (stone)
                            — RDEČA je rezervirana IZKLJUČNO za zamudo (starost listka),
                            polnjena barva statusa se je kuharjem zlivala z alarmno barvo. */}
                        <span className={`ml-auto inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide border ${o.status === 'SENT' ? 'border-stone-300 bg-stone-50 text-stone-700' : o.status === 'PREPARED' || o.status === 'READY' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-stone-300 bg-stone-50 text-stone-700'}`} title={stL(o.status)}>
                          {stL(o.status)}
                        </span>
                      </CardTitle>
                      <div data-region="kds-ticket-timer-row" className="flex items-center gap-2 flex-wrap">
                        {/* ČASOVNIK — starost listka, vidna na fiksni legi v glavi (ne zakopana med postavke) */}
                        {stale ? (
                          <span
                            data-region="kds-ticket-timer"
                            className="text-sm font-extrabold tabular-nums px-2.5 py-1 rounded-full border bg-stone-100 text-stone-600 border-stone-300"
                            title={`${t('kds.stale')} — ${t('kds.minutes', { m: ageMin })}`}
                          >
                            {t('kds.stale')}: {t('kds.staleHours', { h: staleTicketHours(ageMin) })}
                          </span>
                        ) : (
                          <span data-region="kds-ticket-timer" className={`${kdsFont.timer} font-extrabold tabular-nums px-2.5 py-1 rounded-full border ${kdsAgePillCls(ageCls)}`}>{t('kds.minutes', { m: ageMin })}</span>
                        )}
                        <span className="ml-auto flex gap-1.5 shrink-0">
                          <Button size="sm" variant="outline" className="gap-1 h-11 text-xs" onClick={() => void printKitchenTicket(o, 'KITCHEN')} title={t('kitchen.printKitchenTitle')}>
                            <Printer className="w-3.5 h-3.5" /> {t('kitchen.kitchenTicket')}
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1 h-11 text-xs" onClick={() => void printKitchenTicket(o, 'BAR')} title={t('kitchen.printBarTitle')}>
                            <Printer className="w-3.5 h-3.5" /> {t('kitchen.barTicket')}
                          </Button>
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent data-region="kds-ticket-items" className={kdsDensityCls.items}>
                      {stale && (
                        <p className="rounded-sm border border-stone-300 bg-stone-100 px-2 py-1 text-xs text-stone-600">
                          {t('kds.staleHint')}
                        </p>
                      )}
                      {/* Issue #71 audit-14: RDEČ PAS za resnične alergije — živilska varnost gostov.
                          Edini alergijski alarm, ki si zasluži rdečo, je potrjeno opozorilo. */}
                      {allergyItems.length > 0 && (
                        <div data-region="kds-ticket-allergies" className="rounded-sm border-l-4 border-red-600 bg-red-50 px-2.5 py-1.5" role="alert">
                          <p className="text-xs font-extrabold uppercase tracking-wide text-red-800">⚠ {t('kds.allergyBand')}</p>
                          <ul className="mt-0.5 space-y-0.5">
                            {allergyItems.map((ait) => (
                              <li key={ait.id} className="text-xs font-bold text-red-800 break-words">{ait.qty}× {ait.name} — {ait.allergenWarning}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {/* ISSUE #74 V-10 (blocker): manjkajoči alergenski podatki so ZAKONSKO
                          obvezen podatek (Uredba EU 1169/2011) — RDEČI PAS z ikono (Lightspeed:
                          alergen ima svojo fiksno rdečo vejo), ne utišana siva mikroskupina,
                          ki je bila najtišja stvar na zaslonu. Isti vizualni jezik kot
                          potrjena alergijska opozorila (role=alert, border-l-4). */}
                      {unconfirmedCount > 0 && (
                        <div data-region="kds-ticket-allergen-unconfirmed" role="alert" className="rounded-sm border-l-4 border-red-600 bg-red-50 px-2.5 py-1.5">
                          <p className="flex items-center gap-1.5 text-xs font-bold text-red-800">
                            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-red-300 bg-red-100 text-xs font-extrabold text-red-700" aria-hidden>?</span>
                            {t('kds.unconfirmedAllergens', { n: unconfirmedCount, m: items.length })}
                          </p>
                        </div>
                      )}
                      {items.map((it) => {
                        const mi = menu.find((x) => x.name === it.name && (x.station || 'KITCHEN') === (it.station || 'KITCHEN'))
                        const itAge = kdsItemAge(it, o)
                        // Issue #14: tasked items are managed by the station flow — the legacy
                        // queue shows per-station sync chips instead of status buttons (no 409s)
                        const itemTasks = kdsTasks.filter((task) => task.itemId === it.id)
                        return (
                          <div key={it.id} data-region="kds-ticket-item" className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 space-y-1.5 min-w-0">
                            {/* A: količina + ime (levo) / starost postavke (desno) — hitro skeniranje */}
                            <div className="flex items-baseline justify-between gap-2 min-w-0">
                              <p className="text-sm sm:text-base font-semibold truncate min-w-0">{it.qty}× {it.name}</p>
                              {/* OPS-9 val 3: per-item live timer (firedAt → order clock); OPS-11 val 1: red escalation per station (target → max(10, ceil(target×1.25))) */}
                              {/* Issue #70 §2: zastareli listki — starost postavke v urah (ne "13.496′") */}
                              <span className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-full border shrink-0 ${stale ? 'bg-stone-100 text-stone-600 border-stone-300' : kdsAgeClass(itAge, delayThresholdForTarget(kdsTargetOf(it)))}`}>{stale ? t('kds.staleHours', { h: staleTicketHours(itAge) }) : `${itAge}′`}</span>
                            </div>
                            {/* B: postaja + potrjeni alergeni (jantorni čipi) + opomba — ločena vrstica.
                                Issue #71 audit-14: RDEČ pas je ZDAJ samo na vrhu listka (resnične alergije);
                                per-item opozorilo ostane rdeče, vendar kot pas, ne majhen čip. */}
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <Badge variant="outline" className="shrink-0">{it.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</Badge>
                              {(it.allergenCodes ?? []).length > 0 && (it.allergenCodes ?? []).map((code) => (
                                <span
                                  key={code}
                                  data-region="kds-allergen-chip"
                                  title={t('kds.allergenCodes')}
                                  className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 shrink-0"
                                >
                                  {allergenLbl(code)}
                                </span>
                              ))}
                              {it.note && <span className="text-xs text-stone-500 min-w-0 truncate" title={it.note}>ℹ {it.note}</span>}
                            </div>
                            {/* Issue #7 (P1, v1.104.0) → Issue #71 audit-14: izrecno alergensko
                                opozorilo na postavki — RDEČ PAS (44 px vrstica, oster kontrast) */}
                            {it.allergenWarning && (
                              <p className="rounded-sm border-l-4 border-red-600 bg-red-50 px-2 py-1 text-xs font-bold text-red-800 break-words min-w-0" role="alert">⚠ {t('kds.allergenWarning')}: {it.allergenWarning}</p>
                            )}
                            {/* C: dejanja — lastna vrstica; v1.129.0: cilji ≥ 44 px VEDNO
                                (tudi na velikem zaslonu — KDS JE dotik, tudi na namizju;
                                prej je sm:h-8 gumb krčil na 32 px ravno tam, kjer je kuhinja) */}
                            <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
                              {perms.includes('menu.availability') && mi && (
                                <Button size="sm" variant="ghost" className="h-11 px-2 text-xs gap-1 text-stone-500 hover:text-red-700" title={mi.available ? t('kds.markUnavailable') : t('kds.markAvailable')} onClick={() => void kdsToggleAvailable(mi)}>
                                  <EyeOff className="w-3.5 h-3.5" />{mi.available ? '' : '86'}
                                </Button>
                              )}
                              {itemTasks.length > 0 ? (
                                <span className="flex flex-wrap gap-1 justify-end" role="group" aria-label={t('kds.stStatsTitle')}>
                                  {itemTasks.map((task) => <KdsTaskChip key={task.id} task={task} />)}
                                </span>
                              ) : (
                                <>
                              {it.status === 'PENDING' && <Button size="sm" variant="outline" className="h-11 text-sm font-semibold" onClick={() => setItemStatus(it.id, 'PREPARING')}>{t('kitchen.start')}</Button>}
                              {(it.status === 'PENDING' || it.status === 'PREPARING') && <Button size="sm" className="h-11 text-sm font-semibold bg-emerald-700 hover:bg-emerald-800" onClick={() => bumpReady(it, o)}>{t('status.PREPARED')}</Button>}
                              {it.status === 'READY' && (
                                <div className="flex items-center gap-1.5">
                                  <Badge className={statusColors.READY}>{t('status.READY')}</Badge>
                                  {/* OPS-7 (v1.70.0): SERVED bump (Lightspeed vzorec — izloči iz vrste) */}
                                  <Button size="sm" variant="outline" className="h-11" onClick={() => setItemStatus(it.id, 'SERVED')}>{t('status.SERVED')}</Button>
                                </div>
                              )}
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {/* v1.129.0 (Toast/Square benchmark): bump CELEGA LISTKA — en velik
                          celoširinski gumb (kitchenski dotik, Toast: dvoklik/fulfill listka).
                          Prikazan samo, če so vse odprte postavke LEGACY (brez postajnih
                          nalogov — te upravlja postajni tok) in vsaj ena ni pripravljena. */}
                      {(() => {
                        const anyTasked = items.some((it) => kdsTasks.some((task) => task.itemId === it.id))
                        const openItems = items.filter((it) => !it.voided && (it.status === 'PENDING' || it.status === 'PREPARING'))
                        if (anyTasked || openItems.length === 0) return null
                        return (
                          <Button
                            data-region="kds-bump-all"
                            className="w-full h-12 mt-1 text-base font-bold gap-2 bg-emerald-700 hover:bg-emerald-800"
                            disabled={!!kdsBumpBusy}
                            onClick={() => void bumpWholeTicket(o)}
                            aria-label={t('kds.bumpAllAria')}
                          >
                            {kdsBumpBusy === o.id ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden /> : <Check className="w-5 h-5" aria-hidden />}
                            {t('kds.bumpAll')} · {openItems.length}
                          </Button>
                        )
                      })()}
                    </CardContent>
                  </Card>
                )
              }
              return (
                <>
                  {kdsActive.length > 0 && (
                    <p data-region="kds-section-active" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-500 px-1">
                      {t('kds.activeShift')}
                      <span className="rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 tabular-nums font-semibold">{t('kds.staleCount', { n: kdsActive.length })}</span>
                    </p>
                  )}
                  {kdsActive.map(renderKdsTicket)}
                  {kdsStale.length > 0 && (
                    <section data-region="kds-section-stale" className="space-y-2 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-2.5" aria-label={t('kds.staleSection')}>
                      <button
                        type="button"
                        onClick={() => setKdsStaleOpen((v) => !v)}
                        aria-expanded={kdsStaleOpen}
                        aria-label={t('kds.staleToggle')}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-stone-500 hover:bg-stone-100 hover:text-stone-800 transition-colors min-h-11"
                      >
                        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${kdsStaleOpen ? '' : '-rotate-90'}`} aria-hidden />
                        <span className="truncate min-w-0">{t('kds.staleSection')}</span>
                        <span className="ml-auto shrink-0 rounded-full border border-stone-300 bg-stone-200 px-2 py-0.5 tabular-nums font-semibold">{t('kds.staleCount', { n: kdsStale.length })}</span>
                      </button>
                      {kdsStaleOpen && kdsStale.map(renderKdsTicket)}
                    </section>
                  )}
                </>
              )
            })()}
            {!kdsCustomView && viewKitchen.filter((o) => o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))).length === 0 && (
              /* Vizualni benchmark (Toast KDS): prazno stanje = velik jasni status »kuhinja
                 čista«, ne iskalna vrstica — ko pride listek, dobi 100 % pozornosti. */
              <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 py-10 text-center" role="status">
                <CheckCircle2 className="h-10 w-10 text-emerald-700" aria-hidden />
                <p className="text-base font-bold text-stone-800">{t('kitchen.queueClearTitle')}</p>
                <p className="text-sm text-stone-500">{t('kitchen.queueEmpty')}</p>
              </div>
            )}
            {/* v1.129.0 (Toast/Square benchmark): VRSTICA »V PRIPRAVI — SKUPAJ PO ARTIKLIH«
                (all-day/production view) — skupne količine ODprtih postavk (PENDING/PREPARING,
                ne pripravljenih) vseh listkov trenutnega pogleda. Toast jo ima v dnu ekrana,
                Square v stranski vrstici; kuhar vidi brez lista, kaj je v delu. */}
            {!kdsCustomView && (() => {
              const openItems = viewKitchen
                .filter((o) => o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
                .flatMap((o) => o.items.filter((it) => !it.voided && (it.status === 'PENDING' || it.status === 'PREPARING') && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
              const byName = new Map<string, number>()
              for (const it of openItems) byName.set(it.name, (byName.get(it.name) ?? 0) + it.qty)
              const rows = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              if (rows.length === 0) return null
              return (
                <div data-region="kds-allday" className="sticky bottom-0 z-10 rounded-xl border border-amber-300 bg-amber-50/95 backdrop-blur px-3 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]" role="status" aria-label={t('kds.allDayTitle')}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-900 min-w-0 shrink-0">{t('kds.allDayTitle')}</p>
                    <p className="text-xs font-medium text-amber-700/80 ml-auto shrink-0" aria-hidden>{rows.length}</p>
                  </div>
                  {/* Toast production view: ENA vrstica z horizontalnim drsenjem (nowrap) —
                      ovijanje čipov je na mobilnem naredilo 800px+ blok, višji od zaslona,
                      in sticky ni mogel prilepiti na dno (izmerjeno: bottom 1137 > vh 844). */}
                  <div className="flex gap-1.5 overflow-x-auto flex-nowrap [scrollbar-width:thin]">
                    {rows.map(([name, qty]) => (
                      <span key={name} className="inline-flex items-baseline gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1 shrink-0 whitespace-nowrap">
                        <span className="text-base font-extrabold tabular-nums text-amber-900">{qty}×</span>
                        <span className="text-sm font-semibold text-stone-800">{name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )
            })()}
            {/* v1.129.0 (Toast benchmark): 86 PLOŠČA — SKRČENA vrstica pod listki (odpri na
                klik); števec razprodanih je viden TUDI zaprto, vsebina (iskanje + obnova)
                se razpre šele na zahtevo. Listki zgoraj tako vedno dobijo prvi zaslon. */}
            {!kdsCustomView && (() => {
              const open = kdsBoardOpen
              return (
                <Card data-region="kds-86board" className={`border-stone-200 ${open ? '' : 'py-0'}`}>
                  <button
                    type="button"
                    onClick={() => setKdsBoardOpen(!open)}
                    aria-expanded={open}
                    aria-controls="kds-86board-content"
                    aria-label={t('kds.boardToggleAria')}
                    className="w-full flex items-center gap-2 px-4 sm:px-6 text-left min-h-11"
                  >
                    <EyeOff className="w-4 h-4 text-stone-500 shrink-0" aria-hidden />
                    <span className="text-sm font-semibold truncate">{t('kds.boardTitle')}</span>
                    {kdsSoldOut.length > 0 && (
                      <Badge variant="outline" className="text-xs px-1.5 py-0 font-bold border-amber-400 bg-amber-50 text-amber-900 shrink-0">{kdsSoldOut.length}</Badge>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-xs text-stone-500 shrink-0">
                      {open ? t('kds.boardOpenHint') : kdsSoldOut.length > 0 ? `${kdsSoldOut.length}` : t('kds.boardEmpty')}
                      <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
                    </span>
                  </button>
                  {open && (
                    <div id="kds-86board-content" className="space-y-3 px-4 pb-4 sm:px-6">
                      {kdsSoldOut.length === 0 ? (
                        <p className="text-xs text-stone-500">{t('kds.boardEmpty')}</p>
                      ) : (
                        <div className="space-y-1.5">
                          {kdsSoldOut.map((mi) => (
                            <div key={mi.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {mi.name}
                                  <Badge variant="outline" className="ml-1.5 text-xs px-1.5 py-0">{mi.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</Badge>
                                </p>
                                <p className="text-xs text-stone-500 truncate">
                                  {t('kds.substitutes')}: {kdsSubstitutesFor(mi).map((s) => s.name).join(' · ') || t('kds.noSubstitutes')}
                                </p>
                              </div>
                              {perms.includes('menu.availability') && (
                                <Button size="sm" variant="outline" className="h-9 gap-1 text-xs shrink-0" title={t('kds.markAvailable')} onClick={() => void kdsToggleAvailable(mi)}>
                                  <Eye className="w-3.5 h-3.5" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {perms.includes('menu.availability') && (
                        <div>
                          <Input value={kds86Search} onChange={(e) => setKds86Search(e.target.value)} placeholder={t('kds.boardSearch')} className="h-9 text-xs" aria-label={t('kds.boardSearch')} />
                          {kds86Search.trim() && (
                            <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto">
                              {kds86Candidates.map((mi) => (
                                <div key={mi.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-100 px-2.5 py-1.5">
                                  <span className="text-xs truncate min-w-0">{mi.name} · <b>{fmtEUR(mi.price)}</b></span>
                                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs gap-1 text-stone-500 hover:text-red-700 shrink-0" title={t('kds.markUnavailable')} onClick={() => void kdsToggleAvailable(mi)}>
                                    <EyeOff className="w-3 h-3" /> 86
                                  </Button>
                                </div>
                              ))}
                              {kds86Candidates.length === 0 && <p className="text-xs text-stone-400 px-1">{t('kds.boardNoHit')}</p>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              )
            })()}
            {/* OPS-8 v1.71.0 — KDS statistika (leni doseg; live plošča ostaja nedotaknjena) */}
            {/* OPS-10 v1.77.0 — per-station targets: urejanje samo s settings.manage */}
            <KdsStatsSection canEditTargets={hasPerm('settings.manage')} />

            {/* OPS-9 val 3 (v1.76.0): delay-reason dialog when a LATE item (>10 min) is bumped */}
            <Dialog open={!!delayAsk} onOpenChange={(v) => !v && setDelayAsk(null)}>
              <DialogContent className="sm:max-w-xs">
                <DialogHeader>
                  <DialogTitle className="text-base">{t('kds.delay.title')}</DialogTitle>
                  {delayAsk && (
                    <p className="text-sm text-stone-500">
                      {t('kds.delay.dialogInfo', { name: delayAsk.name, m: delayAsk.min })}
                    </p>
                  )}
                </DialogHeader>
                <div className="grid grid-cols-1 gap-2">
                  {KDS_DELAY_REASONS.map((r) => (
                    <Button
                      key={r}
                      variant="outline"
                      className="min-h-11 justify-start text-base font-medium"
                      onClick={() => { const cur = delayAsk; setDelayAsk(null); if (cur) void setItemStatus(cur.itemId, 'READY', r) }}
                    >
                      {t(`kds.delay.${r}`)}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    className="min-h-11 text-stone-500"
                    onClick={() => { const cur = delayAsk; setDelayAsk(null); if (cur) void setItemStatus(cur.itemId, 'READY') }}
                  >
                    {t('kds.delay.skip')}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </TabsContent>

          {/* Issue #7 (P1, v1.104.0): alergenski dialog (potrditev profila / ročni popravek / sestavine) */}
          <AllergenDialog
            itemId={allergenDlg?.id ?? null}
            itemName={allergenDlg?.name ?? ''}
            canManageMenu={hasPerm('menu.manage')}
            canManageInventory={hasPerm('inventory.manage')}
            onClose={() => setAllergenDlg(null)}
            onChanged={() => void load()}
          />

          <TabsContent value="meni" className="space-y-4">
            {/* OPS-10 val 2 (v1.78.0): per-item kiosk upsell suggestions ("Dodaj še") */}
            <UpsellCard menuItems={menu.map((m) => ({ id: m.id, name: m.name, price: m.price, available: m.available }))} canManage={hasPerm('menu.manage')} />
            {/* Issue #69 (2. val): hitri skok po kategorijah — lepljiva vrstica čipov nad dolgim
                seznamom (čista sidra href="#cat-…" → id na glavi razdelka; BREZ stanja/JS logike) */}
            {menuByCat.length > 0 && (
              <nav data-region="menu-quickjump" aria-label={t('menu.jumpAria')} className="sticky top-14 z-20 rounded-xl border border-stone-200 p-1.5 shadow-sm">
                <div className="os-quickjump-track flex gap-1 overflow-x-auto" role="list">
                  {menuByCat.map((g) => (
                    <a
                      key={g.cat.id}
                      href={`#${catAnchor(g.cat.id)}`}
                      role="listitem"
                      className="shrink-0 min-h-11 inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800"
                    >
                      <span className="whitespace-nowrap">{g.cat.name}</span>
                      <span className="text-xs font-normal text-stone-500 tabular-nums">{g.items.length}</span>
                    </a>
                  ))}
                </div>
              </nav>
            )}
            {menuByCat.map((g) => (
              <section key={g.cat.id} id={catAnchor(g.cat.id)} data-region="menu-category" className="space-y-2 scroll-mt-40">
                {/* Issue #69: lepljiva glava kategorije — naslov ostane viden med dolgim pomikanjem */}
                <div data-region="menu-category-header" className="sticky top-[7.125rem] z-10 py-1.5 border-b border-stone-200 bg-stone-50/95 backdrop-blur">
                  <h2 className="font-semibold text-stone-700 flex items-baseline gap-2 min-w-0">
                    <span className="truncate">{g.cat.name}</span>
                    <span className="text-xs font-normal text-stone-500 shrink-0">{t('menu.catCount', { n: g.items.length })}</span>
                  </h2>
                </div>
                <div data-region="menu-category-items" className="grid grid-cols-1 gap-2 md:gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {g.items.map((m) => (
                    <div key={m.id} className="rounded-lg border border-stone-200 bg-white p-3 md:p-2.5 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{m.name}</p>
                        <p className="text-sm text-stone-500">{fmtEUR(m.price)} · {m.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</p>
                        {/* Issue #7 (P1, v1.104.0): alergenski status + kode na kartici menija */}
                        <p className="mt-0.5 flex flex-wrap items-center gap-1">
                          {m.allergenStatus && (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
                              m.allergenStatus === 'confirmed' ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                : m.allergenStatus === 'review_required' ? 'border-amber-300 bg-amber-50 text-amber-800'
                                  : 'border-red-300 bg-red-50 text-red-800'
                            }`}>{t(`menu.allergenStatus.${m.allergenStatus}`)}</span>
                          )}
                          {(m.allergenCodes ?? []).length > 0 && (
                            <span className="text-xs text-stone-500">{(m.allergenCodes ?? []).map(allergenLbl).slice(0, 4).join(', ')}{(m.allergenCodes ?? []).length > 4 ? ' …' : ''}</span>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-col shrink-0 gap-1.5">
                        {hasPerm('menu.manage') && (
                          <Button size="sm" variant="outline" className="h-11 sm:h-8 md:h-7 px-2 text-xs" onClick={() => setAllergenDlg({ id: m.id, name: m.name })}>
                            ⚠ {t('menu.allergenBtn')}
                          </Button>
                        )}
                        <Button size="sm" variant={m.available ? 'outline' : 'secondary'} className="h-11 sm:h-8 md:h-8" onClick={() => toggleAvailable(m)}>{m.available ? t('menu.inStock') : t('menu.outOfStock')}</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </TabsContent>

          <TabsContent value="rezervacije" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-stone-700 min-w-0">{t('resv.upcoming')}</h2>
              {canRes && (
                <div className="flex flex-wrap gap-2">
                  {/* Issue #71 audit-18: množični opomnik = neponovljivo javno dejanje —
                      POTRDITVENO okno s številom prizadetih (samo vodja) NE neposredni klic.
                      ISSUE #74 V-24: gumb je ONEMOGOČEN, ko ni kandidatov (prej omogočen
                      kljub 0 rezervacijam — 85 % praznega zaslona je bilo klikabilno). */}
                  <Button size="sm" variant="outline" className="h-11 gap-1" disabled={sending || reminderCandidates.length === 0} onClick={() => setReminderConfirmOpen(true)}>
                    <Bell className="w-3.5 h-3.5" /> {t('resv.reminderAll')}
                  </Button>
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setNewRes({ guestName: '', phone: '', guests: 2, reservedAt: '', note: '', tableId: '', source: 'phone', email: '', duration: 120, specialRequests: '' })}>
                    <Plus className="w-3.5 h-3.5" /> {t('resv.new')}
                  </Button>
                </div>
              )}
            </div>
            {/* Issue #71 audit-18: potrditveno okno — predogled prizadetih rezervacij +
                nedvoumen izpis, da dejanja NI mogoče razveljaviti (e-pošta/SMS gostom) */}
            <Dialog open={reminderConfirmOpen} onOpenChange={setReminderConfirmOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>{t('resv.reminderConfirmTitle')}</DialogTitle>
                  <DialogDescription>{t('resv.reminderConfirmBody', { n: reminderCandidates.length })}</DialogDescription>
                </DialogHeader>
                {reminderCandidates.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('resv.reminderNoneCandidates')}</p>
                ) : (
                  <ScrollArea className="max-h-48">
                    <ul className="space-y-1.5 pr-2">
                      {reminderCandidates.map((r) => (
                        <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-stone-200 px-2.5 py-2 text-sm">
                          <span className="font-medium truncate min-w-0">{r.guestName} · {r.guests} {t('orders.persons')}</span>
                          <span className="text-xs text-stone-500 shrink-0">{new Date(r.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReminderConfirmOpen(false)}>{t('common.cancel')}</Button>
                  <Button
                    className="bg-emerald-700 hover:bg-emerald-800"
                    disabled={sending || reminderCandidates.length === 0}
                    onClick={() => { setReminderConfirmOpen(false); void sendAllReservationReminders() }}
                  >
                    {t('resv.reminderConfirmSend', { n: reminderCandidates.length })}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {/* OPS-8 val 3 (v1.73.0): status filter chips (client-side) */}
            <div className="flex flex-wrap gap-1.5">
              {([
                ['ALL', t('common.all')],
                ['UPCOMING', t('resv.filterUpcoming')],
                ['TODAY', t('resv.filterToday')],
                ['SEATED', t('resv.stSeated')],
                ['NO_SHOW', t('resv.stNoShow')],
                ['CANCELLED', t('resv.stCancelled')],
              ] as [ReservationFilter, string][]).map(([key, label]) => (
                <Button key={key} size="sm" variant="outline" className={`h-10 px-3 text-xs ${resFilter === key ? 'bg-emerald-700 text-white border-emerald-700 hover:bg-emerald-700' : 'text-stone-600'}`} onClick={() => setResFilter(key)}>
                  {label}
                </Button>
              ))}
            </div>
            <Card>
              <CardContent className="pt-4">
                {/* ISSUE #74 V-24: prazno stanje ima poziv ZNOTRAJ kartice (ikona + CTA
                    besedilo) — prej gola siva vrstica na 85 % praznem zaslonu */}
                {filteredRes.length === 0 && (
                  <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-6 text-center">
                    <CalendarClock className="h-10 w-10 text-stone-300" aria-hidden />
                    <p className="max-w-sm text-sm text-stone-500">{resFilter === 'UPCOMING' ? t('resv.empty') : t('resv.emptyGeneric')}</p>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredRes.map((r) => (
                    <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium truncate">
                          {r.guestName} <span className="text-xs text-stone-400">· {r.guests} {t('orders.persons')}</span>
                          {/* Issue #13: vir rezervacije (spletna povezava = takoj prepoznavna) */}
                          {r.source === 'website' && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-xs bg-sky-50 text-sky-800 border-sky-200">🌐 {t('resv.srcWebsite')}</Badge>}
                          {r.source === 'app' && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-xs bg-stone-50 text-stone-600 border-stone-200">{t('resv.srcApp')}</Badge>}
                        </p>
                        <p className="text-xs text-stone-500">{new Date(r.reservedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{r.phone ? ` · ${r.phone}` : ''}</p>
                        {r.note && <p className="text-xs text-stone-400 truncate">ℹ {r.note}</p>}
                        {r.specialRequests && <p className="text-xs text-amber-700 truncate">★ {r.specialRequests}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline">{RES_STATUS_KEYS[r.status] ? t(RES_STATUS_KEYS[r.status]) : r.status}</Badge>
                        {canRes && (
                          <>
                            {r.reminderSent ? (
                              <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 gap-1"><Bell className="w-3 h-3" /> {t('resv.reminderSent')}</Badge>
                            ) : (
                              <Button size="sm" variant="outline" className="h-10 px-2 text-xs gap-1" disabled={sending} onClick={() => void sendReservationReminder(r.id, r.guestName)} title={t('resv.reminderSend')}>
                                <Bell className="w-3 h-3" /> {t('resv.reminderSend')}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-10 px-2 text-xs" disabled={sending} onClick={() => setReservationStatus(r.id, 'SEATED')}>{t('resv.seatedBtn')}</Button>
                            {/* OPS-8 val 3 (v1.73.0): NO_SHOW on upcoming reservations (confirm-guarded) */}
                            {r.status === 'CONFIRMED' && (
                              <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-rose-700 border-rose-200 hover:bg-rose-50" disabled={sending} onClick={() => { if (confirm(t('resv.noShowConfirm'))) void setReservationStatus(r.id, 'NO_SHOW') }} title={t('resv.stNoShow')}>
                                {t('resv.stNoShow')}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-10 px-2 text-xs text-amber-700 border-amber-200 hover:bg-amber-50" disabled={sending} onClick={() => setReservationStatus(r.id, 'CANCELLED')}>{t('common.cancel')}</Button>
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
            <DiscountsTab canManage={hasPerm('discounts.manage')} />
          </TabsContent>
          <TabsContent value="integracije" className="space-y-4">
            <IntegracijeTab canManage={hasPerm('settings.manage')} />
          </TabsContent>
          <TabsContent value="enterprise" className="space-y-4">
            <EnterpriseTab canManage={hasPerm('settings.manage')} />
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
                          <p className="text-xs text-stone-400 font-mono truncate max-w-xs sm:max-w-md">EOR: {r.eor}</p>
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
                          {!r.isStorno && !isStorned(r.id) && hasPerm('receipts.storno') && (
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
            {/* OPS-8 val 3 (v1.73.0) — GL dnevnik (orientacijsko) */}
            <GlJournalCard />
            {/* Issue #19 (v1.107.0) — poročilo finančnih izjem (razlog + odobritev) */}
            <ExceptionsReportCard />
          </TabsContent>

          <TabsContent value="inzeniring" className="space-y-4">
            {/* OPS-8 v1.71.0 — menu engineering (Kasavana-Smith kvadrant) */}
            <MenuEngineeringTab />
            {/* Issue #17 (v1.106.0) — food-cost varianca (dejanska proti teoretični porabi) */}
            <FoodCostVarianceCard />
          </TabsContent>

          <TabsContent value="zaloge">
            <InventoryTab items={inventory} suppliers={suppliers} recipes={recipes} menuItems={menu.map((m) => ({ id: m.id, name: m.name }))} canManage={hasPerm('inventory.manage')} onReload={load} onNavigate={(tab) => setActiveTab(tab)} />
          </TabsContent>

          {/* Issue #8 (v1.116.0) — medlokacijski prenosi zalog (backend: requirePermission
              inventory.manage — enako kot gating tukaj; TAB_PERM vnos že obstane v tab-permissions) */}
          <TabsContent value="prenosi">
            <TransfersTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={hasPerm('inventory.manage')} />
          </TabsContent>

          <TabsContent value="izmene">
            <ShiftsTab shifts={shifts} financial={financial} canManage={hasPerm('cash.manage')} onReload={load} />
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
            {/* v1.129.0 (FoodDocs/SafetyCulture benchmark): čistilka (haccp.execute BREZ
                settings.manage) dobi IZVEDBENI vmesnik — termini + hiter vnos + zadnje kontrole.
                Upravljanje načrtov (nov načrt, DDL, CSV izvoz) ostaja vodstvu; prej je
                urejevalnik načrtov vizualno dostopen tudi izključno izvajalki. */}
            <HaccpTab checks={haccp} onReload={load} canManagePlans={hasPerm('settings.manage')} />
          </TabsContent>

          <TabsContent value="stroski">
            <ExpensesTab expenses={expenses} canManage={hasPerm('settings.manage')} onReload={load} categoriesEnabled={expCatsEnabled} />
          </TabsContent>

          <TabsContent value="zvestoba">
            {/* v1.97.0 (#43): centralna vloga pošlje izbrano lokacijo pogleda (viewLoc) —
                strežnik jo validira (org obseg); staff lokacija ostaja strežniško določena */}
            <LoyaltyTab accounts={loyalty} canManage={hasPerm('settings.manage')} onReload={load} centralLocationId={viewLoc || ''} />
          </TabsContent>

          <TabsContent value="mnenja">
            <FeedbackTab feedback={feedback} tables={viewTables.map((t) => ({ id: t.id, name: t.name }))} />
          </TabsContent>

          <TabsContent value="crm">
            {/* Issue #11 (v1.126.0) — CRM gostov: segmenti, soglasje (email/sms
                LOČENO, z dokazom izrecnega dejanja), podvojeni profili, kampanje
                (življenjski cikel + meritve). Podatke si naloži SAM (api klici) —
                mutacije gating settings.manage strežniško, ogled reports.view. */}
            <CrmTab canManage={hasPerm('settings.manage')} centralLocationId={viewLoc || ''} />
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
            <NapitnineTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={hasPerm('employees.manage')} />
          </TabsContent>

          <TabsContent value="obracun">
            {/* Issue #22 (v1.115.0) — obračun plač: obdobja + zaklep + izvozi + plačne postavke
                (backend: requirePermission employees.manage — enako kot gating tukaj) */}
            <PayrollTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={hasPerm('employees.manage')} />
          </TabsContent>

          <TabsContent value="nabava">
            <NabavaTab locations={locStats.map((l) => ({ id: l.id, name: l.name }))} canManage={hasPerm('inventory.manage')} />
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
            {isCentralUIRole(user?.role) && bootstrapLogin && (
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
                <CardTitle className="text-base flex items-center gap-1.5"><UserCog className="w-4 h-4" /> {t('tabs.zaposleni')}{hasPerm('employees.manage') ? t('emp.controlCenter') : ''}</CardTitle>
                {hasPerm('employees.manage') && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-stone-400 hidden lg:inline">{t('emp.clickToEdit')}</span>
                    {/* Issue #71 audit-25: viden gumb »Nov zaposleni« (dodajanje je bilo
                        dosegljivo samo prek delovnih mest) */}
                    <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => { setNewEmp({ name: '', email: '', pin: '', role: 'WAITER' }); setNewEmpErr(''); setNewEmpDlg(true) }}>
                      <Plus className="w-3.5 h-3.5" /> {t('emp.new')}
                    </Button>
                  </div>
                )}
              </CardHeader>
              {/* Issue #71 audit-25: iskalnik po imenu/vlogi/e-pošti (28+ profilov brez njega) */}
              <CardContent className="pb-3 pt-0">
                <Input value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} placeholder={t('emp.search')} className="h-9 max-w-xs" aria-label={t('emp.search')} />
              </CardContent>
              <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(() => {
                  /* Issue #71 audit-25: filtriran po iskalniku (ime / vloga / e-pošta) */
                  const q = empSearch.trim().toLowerCase()
                  const shownEmps = q
                    ? viewEmployees.filter((e) => e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q) || e.role.toLowerCase().includes(q))
                    : viewEmployees
                  if (shownEmps.length === 0) return <p className="text-sm text-stone-500">{t('emp.searchNone')}</p>
                  return shownEmps.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => hasPerm('employees.manage') && openEmployee(e)}
                    disabled={!hasPerm('employees.manage')}
                    className={`flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 bg-white text-left ${hasPerm('employees.manage') ? 'hover:border-emerald-600 hover:shadow-sm transition' : 'cursor-default'}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.name}{!e.active && <span className="ml-1.5 text-xs text-red-600">{t('emp.inactiveSuffix')}</span>}</p>
                      <p className="text-xs text-stone-500 truncate">{e.email}</p>
                      {locList.find((l) => l.id === e.locationId)?.name ? (
                        <p className="text-xs text-stone-400 flex items-center gap-0.5"><MapPin className="w-3 h-3" /> {locList.find((l) => l.id === e.locationId)?.name}</p>
                      ) : (
                        /* ISSUE #72 E5/B2: brez lokacije je OPERATIVNA težava (prazni seznami,
                           prazna plošča) — rdeče vidna, ne tiho skrita */
                        <p className="text-xs text-red-600 flex items-center gap-0.5 font-medium"><MapPin className="w-3 h-3" /> {t('emp.noLocation')}</p>
                      )}
                      {(e.permissionOverrides?.length || 0) > 0 && (
                        <p className="text-xs text-emerald-700 flex items-center gap-0.5"><ShieldCheck className="w-3 h-3" /> {t('emp.permsCount', { n: e.permissionOverrides.length })}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge variant="outline">{roleL(e.role)}</Badge>
                      {hasPerm('employees.manage') && <UserCog className="w-3.5 h-3.5 text-stone-300" />}
                    </div>
                  </button>
                  ))
                })()}
              </CardContent>
            </Card>
            <JobsCard jobs={jobs} canManage={hasPerm('inventory.manage')} onReload={load} />
          </TabsContent>

          <TabsContent value="nastavitve" className="space-y-4">
            {/* Issue #69 (2. val): hitri skok po razdelkih nastavitev — dolga stran (~6.190 px
                pri 1440 px) dobi vizualno segmentacijo + statična sidra (#set-…), brez logike. */}
            <nav data-region="settings-quickjump" aria-label={t('settings.jumpAria')} className="sticky top-14 z-20 rounded-xl border border-stone-200 p-1.5 shadow-sm">
              <div className="os-quickjump-track flex gap-1 overflow-x-auto" role="list">
                {([
                  ['general', t('settings.secGeneral')],
                  ['ops', t('settings.secOps')],
                  ['security', t('settings.secSecurity')],
                  ['notifications', t('settings.secNotifications')],
                  ['devices', t('settings.secDevices')],
                  ['logs', t('settings.secLogs')],
                  ['system', t('settings.secSystem')],
                ] as const).map(([id, label]) => (
                  <a
                    key={id}
                    href={`#set-${id}`}
                    role="listitem"
                    className="shrink-0 min-h-11 inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800"
                  >
                    <span className="whitespace-nowrap">{label}</span>
                  </a>
                ))}
              </div>
            </nav>
            <SettingsSection id="general" title={t('settings.secGeneral')}>
              <SettingsEditor settings={settings} canManage={hasPerm('settings.manage')} onReload={load} />
              {/* Issue #13 (v1.110.0) — javni rezervacijski widget (povezava /r/<token>) */}
              <ReservationWidgetCard />
            </SettingsSection>
            <SettingsSection id="ops" title={t('settings.secOps')}>
              {/* Issue #21 (v1.111.0) — nastavitve klica vodje (dovoljene vrste + čas eskalacije) */}
              <ManagerCallSettingsCard />
              {/* Issue #24 (v1.114.0) — potrjena etiketna pravila roka uporabe (inventory.manage) */}
              <LabelRulesCard />
              {/* Issue #14 (v1.112.0) — KDS named stations config + item routing editor
                  (settings.manage render gate inside the card; menu.manage gates routing) */}
              <PrepStationsCard />
            </SettingsSection>
            <SettingsSection id="security" title={t('settings.secSecurity')}>
              {/* v1.94.0 (issue #31–#33): samo-oskrbni MFA (TOTP) upravitelj za
                  prijavljenega uporabnika — step-up PIN, recovery kode, enforcement */}
              <MfaCard />
            </SettingsSection>
            <SettingsSection id="notifications" title={t('settings.secNotifications')}>
              {/* OPS-8 v1.72.0 — notifikacijska matrika (RoxPos: 11 dogodkov x vsi/vloge/izklopno) */}
              <NotificationsCard />
              {/* OPS-10 val 2 (v1.78.0) — promocije za customer display (idle carousel) */}
              <DisplayPromosCard />
            </SettingsSection>
            <SettingsSection id="devices" title={t('settings.secDevices')}>
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
                    <Button size="sm" variant="outline" onClick={() => { savePrintConfig(pcfg); saveTerminalConfig({ mode: termMode }); toast({ title: t('print.saved') }) }}>{t('common.save')}</Button>
                    <Button size="sm" variant="outline" className="gap-1" onClick={async () => {
                      const res = await printLines(t('print.testBtn'), [
                        { text: t('print.testLine1') },
                        { text: t('print.testLine2'), bold: true },
                        { text: new Date().toLocaleString('sl-SI') },
                      ])
                      if (!res.ok) toast({ title: t('print.failed', { error: res.error ?? '' }), variant: 'destructive' })
                      else if (res.simulated) toast({ title: t('print.simTest') })
                      else toast({ title: t('print.sent') })
                    }}>
                      <Printer className="w-3.5 h-3.5" /> {t('print.testBtn')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            {/* Issue #69 (2. val): mreža lokacij/integracij/webhookov ostaja v razdelku naprav */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                            {!l.isActive && <Badge variant="outline" className="ml-1.5 text-xs">{t('dost.inactiveF')}</Badge>}
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
                      <p className="text-xs text-stone-400">{w.events.length > 0 ? w.events.join(' · ') : t('integ.noEvents')}{w.failureCount > 0 ? t('integ.errorsCount', { n: w.failureCount }) : ''}{w.lastTriggered ? t('integ.lastTriggered', { when: new Date(w.lastTriggered).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : ''}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
            </SettingsSection>
            <SettingsSection id="logs" title={t('settings.secLogs')}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1.5"><Bug className="w-4 h-4" /> {t('errlog.title')}</CardTitle></CardHeader>
                <CardContent>
                  {errLog.length === 0 && <p className="text-sm text-stone-500">{t('errlog.none')}</p>}
                  <ScrollArea className="max-h-72">
                    <div className="space-y-2">
                      {/* Issue #71 audit-28: napake ZDRUŽENE po podpisu (vrsta + začetek sporočila) —
                          »x pojavitev, zadnji ob …« namesto 20 identičnih vrstic surovega JSON-a.
                          audit-5: vrsta napake v jeziku vloge; tehnični payload skrit pod »Podrobnosti«. */}
                      {(() => {
                        const groups = new Map<string, { count: number; last: (typeof errLog)[number] }>()
                        for (const l of errLog) {
                          const firstLine = (l.data ?? '').split(/[\n{]/)[0].slice(0, 90)
                          const key = `${l.action}·${l.entity}·${firstLine}`
                          const g = groups.get(key)
                          if (g) { g.count++; if (new Date(l.createdAt) > new Date(g.last.createdAt)) g.last = l } else groups.set(key, { count: 1, last: l })
                        }
                        return [...groups.values()].sort((a, b) => new Date(b.last.createdAt).getTime() - new Date(a.last.createdAt).getTime()).map((g) => {
                          const l = g.last
                          return (
                            <div key={`${l.id}-g`} className="rounded-lg border border-stone-200 bg-white p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="font-medium truncate min-w-0">{auditActionL(l.action)} <span className="text-xs font-normal text-stone-400">· {auditEntityL(l.entity)}</span></p>
                                <span className="text-xs text-stone-400 shrink-0 tabular-nums">{g.count > 1 ? `${t('errlog.occurrences', { n: g.count })} · ` : ''}{new Date(l.createdAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                              </div>
                              {l.data && (
                                <details className="mt-1">
                                  <summary className="text-xs text-stone-500 cursor-pointer select-none hover:text-stone-700">{t('errlog.details')}</summary>
                                  <p className="text-xs text-stone-500 break-all mt-1">{l.data.length > 400 ? `${l.data.slice(0, 400)}…` : l.data}</p>
                                </details>
                              )}
                            </div>
                          )
                        })
                      })()}
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
                            {/* Issue #71 audit-5: dogodek + entiteta v jeziku vloge (ne DEMO_LOGIN/Schema) */}
                            <p className="font-medium truncate">{auditActionL(a.action)} <span className="text-xs font-normal text-stone-400">· {auditEntityL(a.entityType)}</span></p>
                            <span className="text-xs text-stone-400 shrink-0">{new Date(a.timestamp).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          {/* Issue #71 audit-5/28: tehnični payload skrit pod »Podrobnosti« (details) */}
                          {Object.keys(a.details || {}).length > 0 && (
                            <details className="mt-1">
                              <summary className="text-xs text-stone-500 cursor-pointer select-none hover:text-stone-700">{t('errlog.details')}</summary>
                              <p className="text-xs text-stone-500 break-all mt-1">{JSON.stringify(a.details).slice(0, 400)}</p>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
            </SettingsSection>
            <SettingsSection id="system" title={t('settings.secSystem')}>
            <Card><CardHeader><CardTitle className="text-base">{t('sys.title')}</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1.5 text-stone-600">
                <p>{t('sys.version', { v: APP_VERSION })}</p>
                <p>{t('sys.modules')}</p>
                <p>{t('sys.db')}</p>
              </CardContent>
            </Card>
            </SettingsSection>
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
                      /* P0-3 (v1.83.0): razprodani artikli so VIDNI (sivi, 86, nadomestki) namesto
                         naročljivih do strežniške zavrnitve; Minus ostaja aktiven (izdelek je lahko
                         že v košarici izpred 86). Nadomestki = ista kategorija (g.items). */
                      <div key={m.id} className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${m.available ? 'border-stone-200' : 'border-stone-200 bg-stone-100 opacity-70'}`}>
                        <div className="min-w-0">
                          <p className="text-sm truncate">{m.name} · <b>{fmtEUR(m.price)}</b>{!m.available && <Badge variant="outline" className="ml-1 text-xs px-1.5 py-0">86</Badge>}</p>
                          {!m.available && (
                            <p className="text-xs text-stone-500 truncate">
                              {t('kds.substitutes')}: {g.items.filter((x) => x.available && x.id !== m.id).slice(0, 2).map((x) => x.name).join(' · ') || t('kds.noSubstitutes')}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                          <span className="w-6 text-center text-sm font-semibold">{cart[m.id] || 0}</span>
                          <Button size="icon" variant="outline" className="h-7 w-7" disabled={!m.available} title={m.available ? undefined : t('kds.markUnavailable')} onClick={() => setCart((c) => ({ ...c, [m.id]: (c[m.id] || 0) + 1 }))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
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
            <Button className="bg-emerald-700 hover:bg-emerald-800 disabled:bg-stone-200 disabled:text-stone-500 disabled:hover:bg-stone-200" disabled={sending || cartTotal === 0} onClick={createOrder}>
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
                  <Button size="sm" variant="outline" className="h-10 gap-1 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
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
                        <Badge variant="outline" className="text-xs px-1.5 py-0">{it.status}</Badge>
                        {hasPerm('orders.void') && orderSheet.paymentStatus !== 'paid' && (
                          <Button size="icon" variant="outline" className="h-6 w-6 text-red-700 hover:bg-red-50 hover:text-red-800" disabled={sending} onClick={() => void openVoidDialog(it)} title={t('sheet.void')} aria-label={t('sheet.void')}>
                            <Ban className="w-3 h-3" />
                          </Button>
                        )}
                        {hasPerm('orders.create') && it.status === 'PENDING' && (
                          <Select value={it.courseId || 'none'}
                            onValueChange={(v) => void assignCourse(it.id, v)}>
                            <SelectTrigger className="h-6 w-[104px] text-xs gap-1"><SelectValue placeholder={t('sheet.noCourse')} /></SelectTrigger>
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
                        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-xs gap-0.5" disabled={sending} onClick={() => void fireCourse(c.id)}>
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
                      <p className="text-xs font-semibold uppercase text-stone-400 mb-1">{g.cat.name}</p>
                      <div className="space-y-1">
                        {g.items.map((m) => (
                          /* P0-3 (v1.83.0): prej tiho skrito (filter available) — natakar ni vedel,
                             DA artikel obstaja in je razprodan; zdaj sivi + 86 + nadomestki. */
                          <div key={m.id} className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${m.available ? 'border-stone-100' : 'border-stone-100 bg-stone-100 opacity-70'}`}>
                            <div className="min-w-0">
                              <p className="text-sm truncate">{m.name} · <b>{fmtEUR(m.price)}</b>{!m.available && <Badge variant="outline" className="ml-1 text-xs px-1.5 py-0">86</Badge>}</p>
                              {!m.available && (
                                <p className="text-xs text-stone-500 truncate">
                                  {t('kds.substitutes')}: {g.items.filter((x) => x.available && x.id !== m.id).slice(0, 2).map((x) => x.name).join(' · ') || t('kds.noSubstitutes')}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                              <span className="w-5 text-center text-sm font-semibold">{sheetCart[m.id] || 0}</span>
                              <Button size="icon" variant="outline" className="h-6 w-6" disabled={!m.available} title={m.available ? undefined : t('kds.markUnavailable')} onClick={() => setSheetCart((c) => ({ ...c, [m.id]: (c[m.id] || 0) + 1 }))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
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
            {/* Issue #21 (v1.111.0) — klic vodje s kontekstom tega naročila (mizo izpelje strežnik) */}
            {orderSheet && <ManagerCallButton size="sm" orderId={orderSheet.id} orderNumber={orderSheet.orderNumber ?? undefined} />}
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

      {/* ── Issue #5: preklic posamezne postavke (orders.void + obvezen razlog; plačano zavrnjeno) ── */}
      <Dialog open={!!voidItem} onOpenChange={(v) => { if (!v) setVoidItem(null) }}>
        <DialogContent aria-describedby={undefined} className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('void.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="rounded-lg border border-stone-200 px-3 py-2">{voidItem?.qty}× {voidItem?.name}</p>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="void-reason-text">{t('void.reasonLabel')}</label>
              {voidReasons.length > 0 ? (
                <Select value={voidReasonId} onValueChange={setVoidReasonId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {voidReasons.map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              ) : null}
              <input
                id="void-reason-text"
                value={voidReasonText}
                onChange={(e) => setVoidReasonText(e.target.value.slice(0, 200))}
                placeholder={t('void.reasonPlaceholder')}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
                maxLength={200}
              />
            </div>
            {/* #19: komentar + polja odobritelja (prag preklica aktiven) */}
            <input
              value={excComment}
              onChange={(e) => setExcComment(e.target.value.slice(0, 500))}
              placeholder={t('exc.commentPlaceholder')}
              aria-label={t('exc.commentLabel')}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
              maxLength={500}
            />
            {excPolicy && !excPolicy.isManagerial && excPolicy.policy.voidApprovalAmountCents > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 space-y-1.5">
                <p className="text-xs text-amber-800">{t('exc.approverHint')}</p>
                <input
                  value={excApproverEmail}
                  onChange={(e) => setExcApproverEmail(e.target.value)}
                  placeholder={t('exc.approverLabel')}
                  aria-label={t('exc.approverLabel')}
                  type="email"
                  className="w-full rounded-lg border border-amber-200 px-3 py-2 text-sm"
                />
                <input
                  value={excApproverPin}
                  onChange={(e) => setExcApproverPin(e.target.value)}
                  placeholder={t('exc.approverPinLabel')}
                  aria-label={t('exc.approverPinLabel')}
                  inputMode="numeric"
                  className="w-full rounded-lg border border-amber-200 px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-9" onClick={() => setVoidItem(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" className="h-9" disabled={sending} onClick={() => void confirmVoidItem()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} {t('void.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Issue #19: generični dialog finančne izjeme (razlog + odobritev) —
          popust (prijava/odstranitev) in fiskalni storno ── */}
      <Dialog open={!!excAction} onOpenChange={(v) => { if (!v) setExcAction(null) }}>
        <DialogContent aria-describedby={undefined} className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-lg">{t(excTitleKey)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {excAction?.type === 'storno' && (
              <p className="rounded-lg border border-stone-200 px-3 py-2">
                {excAction.receipt.invoiceNumber} · {fmtEUR(Math.abs(excAction.receipt.total))}
              </p>
            )}
            {excAction?.type === 'discount-apply' && (
              <p className="rounded-lg border border-stone-200 px-3 py-2">
                {manualDiscounts.find((x) => x.id === excAction.discountId)?.name || ''}
                {excAction.switching ? ` · ${t('exc.discountRemoveTitle')}` : ''}
              </p>
            )}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="exc-reason-text">{t('exc.reasonLabel')}</label>
              {excReasons.length > 0 ? (
                <Select value={excReasonId} onValueChange={setExcReasonId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {excReasons.map((r) => (<SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              ) : null}
              <input
                id="exc-reason-text"
                value={excReasonText}
                onChange={(e) => setExcReasonText(e.target.value.slice(0, 200))}
                placeholder={t('exc.reasonPlaceholder')}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
                maxLength={200}
              />
            </div>
            <input
              value={excComment}
              onChange={(e) => setExcComment(e.target.value.slice(0, 500))}
              placeholder={t('exc.commentLabel')}
              aria-label={t('exc.commentLabel')}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
              maxLength={500}
            />
            {excNeedsApprover && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 space-y-1.5">
                <p className="text-xs text-amber-800">{t('exc.approverHint')}</p>
                <input
                  value={excApproverEmail}
                  onChange={(e) => setExcApproverEmail(e.target.value)}
                  placeholder={t('exc.approverLabel')}
                  aria-label={t('exc.approverLabel')}
                  type="email"
                  className="w-full rounded-lg border border-amber-200 px-3 py-2 text-sm"
                />
                <input
                  value={excApproverPin}
                  onChange={(e) => setExcApproverPin(e.target.value)}
                  placeholder={t('exc.approverPinLabel')}
                  aria-label={t('exc.approverPinLabel')}
                  inputMode="numeric"
                  className="w-full rounded-lg border border-amber-200 px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-9" onClick={() => setExcAction(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" className="h-9 bg-amber-700 hover:bg-amber-800" disabled={sending} onClick={() => void confirmException()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} {t('exc.approve')}
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
                    <Button size="sm" variant="outline" className="h-10 gap-1 text-xs" onClick={() => { const nx = !splitOpen; setSplitOpen(nx); if (nx && payingOrder && !checksData) void refreshChecks(payingOrder.id).catch(() => undefined) }}>
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
              {/* OPS-8 val 3 (v1.73.0): miza / vir / e-pošta / trajanje / posebne zahteve */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="res-table">{t('resv.table')}</Label>
                  <Select value={newRes.tableId || 'NONE'} onValueChange={(v) => setNewRes({ ...newRes, tableId: v === 'NONE' ? '' : v })}>
                    <SelectTrigger id="res-table" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64 overflow-y-auto">
                      <SelectItem value="NONE">{t('resv.tableNone')}</SelectItem>
                      {viewTables.map((tb) => (
                        <SelectItem key={tb.id} value={tb.id}>{tb.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="res-source">{t('resv.source')}</Label>
                  <Select value={newRes.source || 'phone'} onValueChange={(v) => setNewRes({ ...newRes, source: v })}>
                    <SelectTrigger id="res-source" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="phone">{t('resv.sourcePhone')}</SelectItem>
                      <SelectItem value="walk_in">{t('resv.sourceWalkIn')}</SelectItem>
                      <SelectItem value="website">{t('resv.sourceWebsite')}</SelectItem>
                      <SelectItem value="app">{t('resv.sourceApp')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="res-email">{t('resv.email')}</Label>
                  <Input id="res-email" type="email" value={newRes.email} onChange={(e) => setNewRes({ ...newRes, email: e.target.value })} placeholder="gost@e-pošta.si" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="res-duration">{t('resv.duration')}</Label>
                  <Input id="res-duration" type="number" min={15} max={600} step={15} value={newRes.duration} onChange={(e) => setNewRes({ ...newRes, duration: Number(e.target.value) || 120 })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="res-special">{t('resv.specialRequests')}</Label>
                <Textarea id="res-special" rows={2} value={newRes.specialRequests} onChange={(e) => setNewRes({ ...newRes, specialRequests: e.target.value })} placeholder={t('resv.specialPlaceholder')} />
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
      {/* Issue #71 audit-25: dialog NOV zaposleni (prej samo urejanje + delovna mesta) */}
      <Dialog open={newEmpDlg} onOpenChange={setNewEmpDlg}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Plus className="w-5 h-5" /> {t('emp.newTitle')}</DialogTitle>
            <DialogDescription>{t('emp.newDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {newEmpErr && <p className="text-xs rounded-md bg-red-50 px-2.5 py-1.5 text-red-700">{newEmpErr}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="ne-name">{t('emp.newName')}</Label>
              <Input id="ne-name" value={newEmp.name} onChange={(e) => setNewEmp((f) => ({ ...f, name: e.target.value }))} placeholder="Ana Novak" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ne-email">{t('emp.newEmail')}</Label>
              <Input id="ne-email" type="email" value={newEmp.email} onChange={(e) => setNewEmp((f) => ({ ...f, email: e.target.value }))} placeholder="ana@restavracija.si" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ne-pin">{t('emp.newPin')}</Label>
              <Input id="ne-pin" inputMode="numeric" maxLength={8} value={newEmp.pin} onChange={(e) => setNewEmp((f) => ({ ...f, pin: e.target.value.replace(/\D/g, '') }))} placeholder="1234" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('emp.newRole')}</Label>
              <Select value={newEmp.role} onValueChange={(v) => setNewEmp((f) => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['WAITER', 'BAR', 'KITCHEN', 'CHEF', 'MANAGER', 'CLEANER', 'WAREHOUSE'].map((r) => (
                    <SelectItem key={r} value={r}>{roleL(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewEmpDlg(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={newEmpBusy || !newEmp.name.trim() || !newEmp.email.trim() || !/^\d{4,8}$/.test(newEmp.pin)} onClick={() => void createEmployee()}>
              {newEmpBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('emp.newCreate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                        {/* ISSUE #72 E4: WAREHOUSE/ACCOUNTING dodani v izbor (bili samo v
                            DB/izračunu); enterprise vloge ostanejo centralna pridržana pravica */}
                        {['OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'BAR', 'KITCHEN', 'CLEANER', 'WAREHOUSE', 'ACCOUNTING'].map((r) => (
                          <SelectItem key={r} value={r} disabled={(user?.role !== 'OWNER' && r === 'OWNER') || (r !== 'WAITER' && r !== 'BAR' && r !== 'KITCHEN' && r !== 'CLEANER' && !isCentralUIRole(user?.role))}>{roleL(r)}</SelectItem>
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
                  {/* ISSUE #72 A1: povzetek efektivnega nabora — vloga je BRAN vir (N),
                      tu se dodaja samo M dodatkov; odvzem ni mogoč (A2 besedilo).
                      ISSUE #75 5.1: značka RAVNI vloge (Standard/Razširjena/Polna) —
                      tri ravni po vzoru Square, viden vir resnice o hierarhiji. */}
                  <p className="text-xs text-stone-600 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center rounded-full border border-stone-300 bg-white px-2 py-0.5 font-semibold">{t('emp.tierBadge')}: {PERMISSION_TIER_LABELS[permissionTierFor(empRole)]}</span>
                    <span className="min-w-0">{t('emp.permsSummary', { role: roleL(empRole), n: empEffective.fromRole.length, m: empEffective.added.length })}</span>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {Object.entries(PERMISSION_LABELS).map(([perm, label]) => {
                      // A1: pravica iz vloge = ZAKLENJENA (brano, neodstranljivo); dodatki = odstranljivi
                      const fromRole = (empEffective.fromRole as readonly string[]).includes(perm)
                      // C2 + issue #75 5.1: lastniške ključe (FULL_ONLY) in employees.manage
                      // sme DODATI samo centralna vloga (backend 403 sicer)
                      const privileged = (FULL_ONLY_PERMISSIONS as readonly string[]).includes(perm) || perm === 'employees.manage'
                      const cantGrant = privileged && !fromRole && !isCentralUIRole(user?.role)
                      return (
                      <label
                        key={perm}
                        title={fromRole ? t('emp.permFromRole') : cantGrant ? t('emp.permCentralOnly') : undefined}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm ${fromRole ? 'border-stone-200 bg-stone-50 cursor-default' : 'border-stone-200 cursor-pointer hover:bg-stone-50'} ${cantGrant && !fromRole ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <Checkbox
                          checked={fromRole || empPerms.includes(perm)}
                          disabled={fromRole || cantGrant}
                          onCheckedChange={fromRole || cantGrant ? undefined : (v) => setEmpPerms((p) => (v ? [...p, perm] : p.filter((x) => x !== perm)))}
                          aria-label={`${label}${fromRole ? ` — ${t('emp.permFromRole')}` : ''}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {fromRole && <span className="ml-auto shrink-0 text-xs font-semibold uppercase tracking-wide text-stone-400">{t('emp.permFromRoleTag')}</span>}
                      </label>
                      )
                    })}
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
        {/* ISSUE #74 V-16: noga brez verzije/besed rekonstrukcija/simulacija —
            tehnične podrobnosti živijo v Nastavitve → Sistem */}
        {t('dash.footer')}
      </footer>
    </main>
  )
}
