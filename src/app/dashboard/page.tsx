'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, fmtFixedSI, fmtPctSigned, getUser } from '@/lib/client'
import { vatFromGross, isHappyActive } from '@/lib/billing'
import { toast } from '@/hooks/use-toast'
import { APP_VERSION } from '@/lib/version'
import { dashboardPollIncludes } from '@/lib/poll-plan'
/* ISSUE #74 V-3 (v1.135.0): pet razredov starosti listka + nastavljivi pragovi —
   enoten vir (kds-delays.ts) za page.tsx IN kds-station-board (prej dve ločeni
   kopiji iste logike z dvema različnima pragoma). */
import {
  KDS_AGE_DEFAULTS, KDS_AGE_THRESHOLD_LS_KEY, KDS_DELAY_REASONS, delayThresholdForTarget,
  isLatePrep, isStaleKdsTicket, kdsAgeBorderCls, kdsAgeClass, kdsAgePillCls, kdsLateThreshold,
  normalizeKdsAgeThresholds, staleTicketHours, type KdsAgeThresholds,
} from '@/lib/kds-delays'
import { applyManualTicketOrder } from '@/lib/kds-ticket-order'
import { KDS_PROFILE_LS_KEYS, type KdsStationProfile } from '@/lib/kds-station-profile'
import { FLOOR_PLAN_W, FLOOR_PLAN_H, floorPlanUnitIsPercent, planPositionOf } from '@/lib/floor-plan'
import { tabHasPerm, TAB_PERM } from '@/lib/tab-permissions'
import { normItemName } from '@/lib/menu-dup'
// OSS-10 B-del (v1.210.0): izbira variante osebja — čisti sloj košarice variant (0 stranskih učinkov)
import {
  addPosVariantLine,
  changePosVariantLineQty,
  orderItemDisplayName,
  posVariantItemsPayload,
  posVariantLinesTotal,
  requiredVariantGroupsForItem,
  type PosVariantGroupView,
  type PosVariantLine,
} from '@/lib/item-variants'
// PRIMERJAVA §28 (v1.254.0): REAL-TIME CHECK VIEW — živi predogled računa zraven
// urejevalca (čista lib + plošča; Square oktober 2026 »Edit items with the check in view«)
import {
  LIVE_CHECK_EMPTY,
  buildLiveCheck,
  cartPreviewLines,
  orderPreviewLines,
  parsePriceInput,
  variantPendingLine,
  withLineUpdate,
} from '@/lib/live-check'
import { ConfirmBannerView } from '@/components/confirm-banner'
import {
  addItemsBanner,
  courseAssignBanner,
  discountBanner,
  fireAllBanner,
  fireCourseBanner,
} from '@/lib/confirm-banner'
import type { ConfirmBanner } from '@/lib/confirm-banner'
import { LiveCheckAside } from '@/components/live-check-aside'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent } from '@/components/ui/tabs'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  LayoutDashboard, Utensils, ClipboardList, ChefHat, BookOpen, Users, Settings,
  LogOut, Plus, Minus, Loader2, ReceiptText, RefreshCw, Banknote, CalendarDays, MessageSquareText,
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
  Pause,
  RotateCcw,
} from 'lucide-react'
import { CommandPalette, PaletteButton } from '@/components/command-palette'
import { DashboardSidebar, MobileBottomNav, MobileNavDrawer } from '@/components/dashboard-nav'
import { ThemeToggle } from '@/components/theme-toggle'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'
import { downloadCSV } from '@/lib/client'
import { printReceipt, receiptDisplayItems, type ReceiptDetailT } from '@/lib/receipt'
import {
  flushQueue, getQueue, getDeviceId, isNetworkError, newOperationId, subscribeQueue, tryEnqueueOp,
  clearDeadOps, resetDeadOp,
  type QueuedOp,
} from '@/lib/offline-queue'
import {
  printLines, buildKitchenTicketLines, filterTicketItems, getPrintConfig, savePrintConfig,
  type PrintConfig, type PrintLine, type PrintTarget,
} from '@/lib/devices/print'
import { getTerminalConfig, saveTerminalConfig, processTerminalPayment, type TerminalMode } from '@/lib/devices/terminal'
import { PERMISSION_LABELS, effectivePermissionSets, FULL_ONLY_PERMISSIONS, permissionTierFor, PERMISSION_TIER_LABELS } from '@/lib/permissions'
import { filterByLocation, isCentralUIRole } from '@/lib/multilocation'
import { filterReservations, type ReservationFilter } from '@/lib/reservation-filters'
import { coversByWindow } from '@/lib/reservation-pacing'
import { seatCandidatesForParty } from '@/lib/table-combos'
import { composeItemNote } from '@/lib/preset-notes'
import { AllergenDialog } from '@/components/allergen-dialog'
import { ALLERGEN_CODES, allergenLabel, type AllergenCode, type AllergenLocale } from '@/lib/allergen-catalog'
import {
  InventoryTab, ShiftsTab, HaccpTab, OpravilaTab, ExpensesTab, LoyaltyTab, FeedbackTab, JobsCard, SettingsEditor, DevicesCard, DeliveryTab, AccountingExportCard, GlJournalCard, NapitnineTab, NabavaTab, DarilneKarticeTab, OdpadTab, CakalnaListaTab, DelovniCasTab, OdpiralniCasTab, DiscountsTab, IntegracijeTab, EnterpriseTab, StaffScheduleTab, MenuEngineeringTab, FoodCostVarianceCard, PourCostCard, ExceptionsReportCard, KdsStatsSection, NotificationsCard, SalesByHourCard, LaborCostCard, LaborCoverageCard, LaborForecastCard, AiInsightsCard, UpsellCard, DisplayPromosCard, MfaCard, ReservationWidgetCard, ReservationPacingCard, ReservationCombosCard, WebPortalCard, ManagerCallsCard, ManagerCallSettingsCard, PrepStationsCard, EquipmentCard, DocumentsCard, LabelRulesCard, PayrollTab, TransfersTab, CrmTab, AccountingPortalCard, MenuModifiersCard, PresetNotesCard, StaffPerformanceCard, SavedViewsCard, TempoInsightsCard, RevenueCentersCard,
  type InventoryT, type ShiftT, type FinancialT, type HaccpT, type ExpenseT, type LoyaltyT,
  type SupplierT, type RecipeT, type FeedbackT, type JobT, type SettingsT, type DeviceT,
  type DeliveryOrderT, type DeliveryZoneT, type PlatformIntegrationT,
} from '@/components/dashboard-tabs'
import { ManagerCallButton } from '@/components/manager-call-dialog'
/* Issue #14 (v1.112.0) — KDS station views: task board + expo dispatch board
   (component lives in src/components/ — outside the i18n scan family). */
import { KdsStationBoard, KDS_TASK_STATUS, type KdsStationT, type KdsTaskT, type KdsStationStatT } from '@/components/kds-station-board'
/* ISSUE #73 audit-22 (v1.139.0) — KDS row as a tap-card (progress on tap,
   sold-out toggle on long-press). */
import { KdsTapCard } from '@/components/kds-tap-card'
/* ISSUE #73 audit-33 (v1.139.0) — one-time module intro (KDS jargon + gestures). */
import { ModuleIntro } from '@/components/module-intro'
/* v1.234.0: fotografije kategorij na POS ploščicah ODSTRANJENE (lastnikova
   odločitev po produkciji — vse ploščice so prikazovale isto sliko, ki ni
   odražala artikla; Square/Toast: fotografija je per-artikel podatek). */
import { stationViewKey } from '@/lib/kds-station-routing'
/* v1.232.0 (PRIMERJAVA §3, Toast/Square »course grouping«): skupine postavk listka
   po tečajih — čista preslikava (lib/kds-courses), izris v renderKdsTicket. */
import { groupKdsItemsByCourse, KDS_EXPO_FIRE_COUNTDOWN_MS, KDS_EXPO_FIRE_TICK_MS, expoFireCountdownSeconds } from '@/lib/kds-courses'
import { getPaymentCueEnabled, playPaymentCue, setPaymentCueEnabled } from '@/lib/audio-cue'
import { PackageSearch, Clock, Thermometer, ClipboardCheck, Wallet, HeartHandshake, Briefcase, MapPin, Plug, Webhook, Bug, Truck, Coins, Ban, Percent, Building2, Zap, EyeOff, Volume2, VolumeX, Maximize2, Ship, Lock, LockOpen, Check, Megaphone, ChevronUp, CreditCard, Settings2, Save, History, Columns3, List, Play, LayoutGrid, Rows3, TimerReset, Wand2, ScanBarcode, PanelLeft, PanelRight, GripVertical, ListOrdered } from 'lucide-react'

const DASHBOARD_TABS: [string, typeof LayoutDashboard | null][] = [
  ['pregled', LayoutDashboard], ['mize', Utensils], ['narocila', ClipboardList],
  ['prodaja', Zap], ['kuhinja', ChefHat], ['meni', BookOpen], ['rezervacije', CalendarDays],
  ['racuni', ReceiptText], ['inzeniring', ChartScatter], ['popusti', Percent], ['integracije', Plug],
  ['zaloge', PackageSearch], ['izmene', Clock], ['delovnicas', Timer], ['urnik', CalendarRange],
  ['haccp', Thermometer], ['opravila', ClipboardCheck], ['stroski', Wallet], ['zvestoba', HeartHandshake], ['mnenja', Star], ['crm', Megaphone],
  ['dostava', Truck], ['napitnine', Coins], ['obracun', ReceiptText], ['nabava', ShoppingCart],
  ['prenosi', ArrowLeftRight], ['darilne', Gift], ['odpad', Trash2], ['cakalna', Hourglass],
  ['odpiralnicas', CalendarClock], ['zaposleni', Users], ['nastavitve', Settings], ['enterprise', Building2],
];
/* ISSUE #73 audit-10 (v1.138.0): horizontalna vrstica zavihkov + gumb ⋮ »Več«
   (27 ciljev v spustnem meniju) je ZAMENJANA z navigacijskim stolpcem:
   - ≥ lg: levi steber s skupinami + iskalnik zavihkov (DashboardSidebar),
   - < lg: spodnja vrstica z 4–5 zavihki DEJANSKE vloge + predal »Več«
     (MobileBottomNav + MobileNavDrawer).
   Skupine/loge/iskanje: src/lib/nav-groups.ts; besednjak: t(`tabs.${id}`). */

interface LocationStatT { id: string; name: string; tables: number; employees: number; orders: number; todayOrders: number; todayRevenue: number }
/** triage ⑧ — polna vrstica lokacije (GET /api/locations, centralne vloge vidijo vse) */
interface LocationRowT { id: string; name: string; code: string; address: string; city: string; postCode: string; country: string; phone: string; email: string; premisesId: string | null; timezone: string; currency: string; isActive: boolean; kdsExpoFireEnabled?: boolean }
interface IntegrationT { id: string; name: string; type: string; provider: string; syncEnabled: boolean; connectionStatus: string; lastSyncAt?: string | null }
interface WebhookT { id: string; name: string; url: string; events: string[]; isActive: boolean; lastTriggered?: string | null; failureCount: number }
interface ErrLogT { id: string; employeeId?: string | null; action: string; entity: string; entityId?: string | null; data?: string | null; createdAt: string }
interface AuditT { id: string; timestamp: string; action: string; entityType: string; entityId?: string | null; userId?: string | null; details: Record<string, unknown> }

/** R4b-1 (v1.216.0): odgovor GET /api/update-check — strukturni tip (LOKALEN, ne iz
 *  strežniškega sloja: uvoz tipa iz update-check-server bi v client bundle vlekel
 *  node:http/dns graf — isto higiena kot APP_VERSION v1.124.0). reason je string,
 *  ker klient razlikuje SAMO ''/'off'/'invalid_url' — ostalo je »nedosegljivo«. */
interface UpdateCheckT { current: string; latest: string | null; updateAvailable: boolean; source: 'default' | 'env' | 'disabled' | 'invalid'; reason: string }

interface Stats { activeOrders: number; openTables: number; todayOrders: number; todayRevenue: number; yesterdayRevenue: number | null; paidToday: { count: number; total: number }; financialPerm: boolean; employees: number; menuItems: number }
interface TableT { id: string; name: string; number?: number; zone: string; seats: number; status: string; shape?: string; locationId?: string | null; activeOrder: { id: string; total: number; guests: number; itemCount: number; waiterName?: string | null; openedAt?: string | null } | null; heldOrderId?: string | null; posX?: number; posY?: number; seatedGuest?: { guestName: string; party: number } | null }
interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null; voided?: boolean; courseId?: string | null; firedAt?: string | null; allergenWarning?: string | null; allergenCodes?: string[]; allergenStatus?: string | null; modifiers?: string[]; voidReasonName?: string | null; checkId?: string | null; checkPaid?: boolean; seat?: number | null; priceOverride?: { from: number; to: number; at: string; by: string } | null }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; locationId?: string | null; table?: { name: string; zone: string } | null; tableId?: string | null; employee?: { id?: string; name: string } | null; items: OrderItemT[]; paymentStatus?: string | null; courses?: CourseT[]; voidedItems?: OrderItemT[] }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null; locationId?: string | null; vatRate?: number; allergenStatus?: string; allergenCodes?: string[]; allergenReviewFlag?: boolean }
interface CategoryT { id: string; name: string }
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean; phone?: string | null; locationId?: string | null; permissionOverrides: string[] }
/** OPS-8 val 3 (v1.73.0): + email/duration/specialRequests/source (additive API fields) */
interface ReservationT { id: string; guestName: string; phone?: string | null; guests: number; reservedAt: string; status: string; note?: string | null; reminderSent?: boolean; email?: string | null; duration?: number | null; specialRequests?: string | null; source?: string | null; tableId?: string | null; tableIds?: string[]; locationId?: string | null }
interface ReceiptT { id: string; invoiceNumber: string; eor: string; zoi: string; fiscalVerified: boolean; fiscalStatus: string; total: number; paymentMethod: string; orderId?: string | null; createdAt: string; tableName?: string | null; orderNumber?: number | null; isStorno?: boolean; stornoOf?: string | null }

// Issue #1 §6: kanonični račun (billing.ts) — popusti, zvestoba, deljeno plačilo
interface BillAutoDisc { discountId: string; name: string; amount: number }
interface BillT { subtotal: number; tax: number; grossTotal: number; manualDiscount: number; autoDiscounts: BillAutoDisc[]; discountTotal: number; totalDue: number; loyalty: { enabled: boolean; pointsPerEuro: number; pointsValue: number; maxRedeemablePoints: number }; items?: { id: string; name: string; quantity: number; unitPrice: number }[]; /** v1.238.0 §15: prek plačilnih povezav (QR) že pobrani deleži — odprti balance */ linkPaidTotal?: number }
interface DiscountT { id: string; name: string; type: string; amount: number; triggerType: string; isActive: boolean; happyFromHour?: number | null; happyToHour?: number | null; happyDays?: string | null; targetCategoryIds?: string | null; validFrom?: string | null; validTo?: string | null }
interface LoyaltyAccT { id: string; customerName: string; customerPhone: string; pointsBalance: number; lifetimePoints: number; tier: string }
interface PayPart { type: 'cash' | 'card' | 'mobile' | 'giftcard'; amount: number }
/** OPS-7 (v1.68.0) — coursing (tečaji jedi) + split po izstavkih (Check) */
interface CourseT { id: string; courseNumber: number; name: string; status: string; firedAt?: string | null }
interface ChecksT { checks: { id: string; checkNumber: number; paymentStatus: string; payments: number }[]; items: { id: string; name: string; quantity: number; lineTotal: number; checkId: string | null; checkNumber: number | null; seat: number | null }[]; checkCount: number }
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
  /* OSS-4 (v1.204.0): zadržano = nevtralni kamen (parkirano pred kuhinjo — ni ne
     urgente, ni zaključka; barva ni edini nosilec pomena, ploščica nosi »Zadržano«). */
  HOLD: 'bg-stone-600 text-white',
  PENDING: 'bg-amber-700 text-white', PREPARING: 'bg-orange-700 text-white', READY: 'bg-emerald-700 text-white',
}
const statusLabels: Record<string, string> = {
  FREE: 'Prosta', OCCUPIED: 'Zasedena', RESERVED: 'Rezervirana', DIRTY: 'Za pospravit',
  OPEN: 'Odprto', SENT: 'Poslano v kuhinjo', PREPARED: 'Pripravljeno', PAID: 'Plačano', CANCELLED: 'Preklicano',
  HOLD: 'Zadržano',
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

/* v1.141.0 (Toast/professionalski KDS benchmark): ODBROJEVALNI ČASOVNIK.
   Prej je listek kazal SAMO pretečene minute (»109 min«) — kuhar mora v glavi
   računati, kdaj bo zamuda. Zdaj pila kaže koliko časa je OSTALO do praga
   zamude (MM:SS), ob presegu pa ZAMUDA +MM:SS (rdeče, utripanje).
   Tik vsako sekundo (ločeno od poll cikla — ura teče tudi med molkom API-ja). */
function KdsCountdownPill({ createdAt, lateMin, staleNode, stale, fontCls, pillCls, ageMin }: {
  createdAt: string
  lateMin: number
  staleNode: ReactNode
  stale: boolean
  fontCls: string
  pillCls: string
  ageMin: number
}) {
  const { t } = useI18n()
  const [nowMs, setNowMs] = useState(() => Date.now()) // tik vsako sekundo — ura teče tudi med molkom API-ja
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (stale) return <>{staleNode}</>
  const elapsedS = Math.max(0, (nowMs - new Date(createdAt).getTime()) / 1000)
  const rem = lateMin * 60 - elapsedS
  const two = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const overdue = rem <= 0
  const mm = overdue ? two((rem * -1) / 60) : two(rem / 60)
  const ss = overdue ? two((rem * -1) % 60) : two(rem % 60)
  return (
    <span
      data-region="kds-ticket-timer"
      className={`${fontCls} font-extrabold tabular-nums px-2.5 py-1 rounded-full border inline-flex items-center gap-1.5 ${
        overdue ? 'bg-red-600 text-white border-red-700 animate-pulse' : pillCls
      }`}
      title={`${t('kds.minutes', { m: ageMin })} · ${overdue ? t('kds.overdue') : t('kds.remaining')}`}
    >
      <TimerReset className="w-4 h-4 shrink-0" aria-hidden />
      {overdue
        ? <>{t('kds.overdue')} +{mm}:{ss}</>
        : <>{t('kds.remaining')} {mm}:{ss}</>}
    </span>
  )
}

/* ═══ ISSUE #74 (v1.135.0) Stopnja 2+3 — KDS ergonomija in statusni jezik ═══ */

// v1.269.0: listekCountKey (4 ročne oblike kds.count*) je bil MRTVA KODA (ni bil
// nikoli klican od preureditve KDS števca) — upokojen skupaj s ključi; števec
// listkov sedaj nosi tN('kds.staleCount', 'listek', n) prek nounKey.

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

/* v1.141.0 (Toast/Square benchmark) — barvno kodiranje KATEGORIJ v kompaktnem
   POS gridu: deterministični hash ključa → barvni levi rob ploščice (8-barvna
   toplo-hladna paleta brez indigo/modre). Natakar na prvi pogled loči skupine
   artikelov (Toast: barva = kategorija). */
const SALE_CAT_BORDER = [
  'border-l-emerald-600', 'border-l-amber-500', 'border-l-orange-600', 'border-l-rose-500',
  'border-l-violet-500', 'border-l-teal-600', 'border-l-lime-600', 'border-l-yellow-500',
] as const
const saleCatBorderCls = (key: string): string => {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 9973
  return SALE_CAT_BORDER[h % SALE_CAT_BORDER.length]
}

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
  const { t, tN, tN2, locale } = useI18n()
  // Hydration-safe (Task 41): localStorage ni dosegljiv na strežniku, zato se uporabnik
  // prebere šele po mountu — sicer SSR naredi null, klient ime → hydration mismatch
  // (span z imenom uporabnika v headerju). Varen, ker ta komponenta nima redirecta na !user.
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null)
  // mikrotaska: setUser iz telesa efekta izmaknjen iz sinhronne poti (isti prvi izris,
  // zapis še vedno pred prvim izrisom po mountu — hydration-safe vzorec ohranjen)
  useEffect(() => { queueMicrotask(() => { setUser(getUser()) }) }, [])
  const [stats, setStats] = useState<Stats | null>(null)
  const [tables, setTables] = useState<TableT[]>([])
  const [orders, setOrders] = useState<OrderT[]>([])
  const [kitchen, setKitchen] = useState<OrderT[]>([])
  /* §39 (v1.265.0, Square Vol 16 »Fire held courses from an Expo KDS«):
     per-lokacijska nastavitev »Dovoli požig s KDS« — mapa {locationId: bool}
     iz GET /api/kitchen polla (pre-DDL → prazna → glave tečajev povsod
     nedejavne, požig ostane POS pristojnost — graceful). */
  const [kdsExpoFireLocs, setKdsExpoFireLocs] = useState<Record<string, boolean>>({})
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
  // v1.245.0 (§19): registrirane kombinacije miz (dialog + avtododelitev;
  // /api/tables/combos — isti poll vratar kot rezervacije)
  const [tableCombos, setTableCombos] = useState<{ id: string; tableIds: string[] }[]>([])
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
  /* §40 (v1.266.0): ali je DDL Job.tipPoints aplikiran (JobsCard pokaže urejanje
     napitninskih točk vloge SAMO po DDL koraku — graceful pre-DDL) */
  const [jobsTipDdl, setJobsTipDdl] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackT[]>([])
  const [locStats, setLocStats] = useState<LocationStatT[]>([])
  const [integrations, setIntegrations] = useState<IntegrationT[]>([])
  const [webhooks, setWebhooks] = useState<WebhookT[]>([])
  const [errLog, setErrLog] = useState<ErrLogT[]>([])
  const [auditLog, setAuditLog] = useState<AuditT[]>([])
  const [settings, setSettings] = useState<SettingsT | null>(null)
  // §37: ali je DDL stolpca prikazovne politike računa že apliciran
  // (preklop v Nastavitvah je do tedaj onemogočen; politika se bere
  // prek raw+probe — false pomeni izklopljeno tudi v izrisu).
  const [receiptPolicyDdlActive, setReceiptPolicyDdlActive] = useState(false)
  const [devices, setDevices] = useState<DeviceT[]>([])
  const [newOrderTable, setNewOrderTable] = useState<TableT | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [sending, setSending] = useState(false)
  const [payingOrder, setPayingOrder] = useState<OrderT | null>(null)
  const [invoice, setInvoice] = useState<{ eor: string; invoiceNumber: string; id?: string } | null>(null)
  /* OSS-15 (v1.201.0): zvočna potrditev plačila — nastavitev NA NAPRAVO
     (localStorage ro_payment_cue; vzorec kdsSound). Privzeto vklopljeno;
     hydration v mount mikrotaski spodaj (SSR izriše privzeto — brez razpada). */
  const [payCue, setPayCue] = useState(true)
  useEffect(() => {
    // mikrotaska — odčitek konfiga naprave brez sinhronnega setState v telesu efekta
    queueMicrotask(() => { setPayCue(getPaymentCueEnabled()) })
  }, [])
  /** OSS-15: flip + persist na napravi (takojšen učinek za naslednje plačilo). */
  const togglePayCue = () => {
    const next = !payCue
    setPayCue(next)
    setPaymentCueEnabled(next)
  }
  /* R4b-1 (v1.216.0): preverjanje novih različic — EN klic ob odprtju dashboarda;
     strežniška predpomnilnica (uspeh 1 h / odpoved 60 s) nosi ceno odhodnega
     klica. Fail-soft: vrstica se nariše SAMO ob znanim izidu — med nalaganjem
     in ob napaki kartica ostane brez vrstice (neznano ≠ alarm). */
  const [updCheck, setUpdCheck] = useState<UpdateCheckT | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await api<UpdateCheckT>('/api/update-check')
        if (!cancelled) setUpdCheck(r)
      } catch { /* tiho — vrstica se ne nariše (pošteno) */ }
    })()
    return () => { cancelled = true }
  }, [])
  /** Natisljivi račun (FURS) — busy indikator za gumb za tiskanje (common.print) */
  const [printing, setPrinting] = useState(false)
  const [stornoing, setStornoing] = useState<string | null>(null)
  // ==== 33-a: selitev/združevanje/fire (P2 audit §54/§57) ====
  const [mmvBusy, setMmvBusy] = useState(false)
  const [moveOrder, setMoveOrder] = useState<OrderT | null>(null)
  const [moveTableId, setMoveTableId] = useState('')
  const [mergeOrder, setMergeOrder] = useState<OrderT | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState('')
  // OSS-4 (v1.204.0): zadržanje naročila — cilj + neobvezen razlog (dialog)
  const [holdTarget, setHoldTarget] = useState<OrderT | null>(null)
  const [holdTargetReason, setHoldTargetReason] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // OPS-4 v1.67.0: zacetni zavihek iz URL (?tab=) — zaslon sank/kuhinje na svoji napravi
  // FIX (E2E 8-e2e): hydration-safe init — the old lazy initializer read
  // window.location on the client (server always got 'pregled') → the Tabs
  // aria-selected tree mismatched on every deep link (?tab=zaloge …). The URL
  // param is applied by the dedicated effect below (line ~419), which already
  // handles the router.push-after-render timing; direct loads switch after mount.
  const [activeTab, setActiveTab] = useState('pregled')
  /* QA najdba #1 (v1.218.0): URL-sync efekt (replaceState spodaj) je ob prvem
     zagonu SINHRONO izbrisal ?tab= ŠE PRED mikrotasko, ki ga prebere (?tab=
     efekt zgoraj) → vsak deep-link/refresh je pristal na 'pregled'. Zastavica
     se dvigne v tisti mikrotaski; do takrat URL-sync NE piše (StrictMode-varen:
     ref preživi dvojni mount, mikrotaska pa vedno steče po vseh efektih). */
  const initialTabRead = useRef(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  /* Issue #73 audit-10: predal »Več« mobilne spodnje vrstice (celotno drevo + iskalnik) */
  const [navMoreOpen, setNavMoreOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  // Offline/local-first + pravice (issue #1)
  // Issue #5 (P1-A): inicializacija iz localStorage (login vrača resolved permissions
  // in jih page.tsx shrani) — prvi izris ŽE ve, kdo je prijavljen → zavihki ne
  // utripajo skozi permisivno stanje (prej perms=[] → tabHasPerm dovolil VSE do /me).
  // /api/auth/me v load() ostaja kot osvežitev (takojšen učinek spremembe pravic).
  // FIX (E2E 8-e2e): hydration-safe — the lazy initializer read localStorage on the
  // client (server always got perms=[]) so the permission-gated navigation rendered
  // a different tab set during hydration (console error + full client re-render).
  // Permissions now hydrate from localStorage in the effect below (same-frame,
  // before /me — the anti-flicker goal of P1-A is preserved, only one paint later).
  const [perms, setPerms] = useState<string[]>([])
  useEffect(() => {
    // mikrotaska — obnova iz localStorage brez sinhronnega setState v efektu
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem('ro_user')
        const parsed = raw ? JSON.parse(raw) : null
        if (Array.isArray(parsed?.permissions)) setPerms(parsed.permissions)
      } catch {
        /* leave empty — /me refresh in load() is authoritative */
      }
    })
  }, [])
  // online/offline status — zunanja vrednost prek useSyncExternalStore
  // (getServerSnapshot = true, isti prvi izris kot prejšnji useState(true))
  const subscribeOnline = useCallback((cb: () => void) => {
    window.addEventListener('online', cb)
    window.addEventListener('offline', cb)
    return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) }
  }, [])
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const [queueOps, setQueueOps] = useState<QueuedOp[]>([])
  const [syncing, setSyncing] = useState(false)
  // Issue #3 §A (P0): dead-letter offline operacije — intervencijski pogled (badge → dialog)
  const [deadOpen, setDeadOpen] = useState(false)
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'mobile' | 'giftcard'>('cash')
  // Issue #1 §6: plačilni dialog — kanonični račun, popusti, zvestoba, deljeno plačilo
  const [bill, setBill] = useState<BillT | null>(null)
  const [manualDiscounts, setManualDiscounts] = useState<DiscountT[]>([])
  const [selDiscountId, setSelDiscountId] = useState('')
  // P2-10b (v1.187.0): osebni kupon — vnos kode v plačilnem dialogu (apply_discounts)
  const [couponCode, setCouponCode] = useState('')
  const [loyaltyResults, setLoyaltyResults] = useState<LoyaltyAccT[]>([])
  const [loyaltySel, setLoyaltySel] = useState<LoyaltyAccT | null>(null)
  const [redeemPoints, setRedeemPoints] = useState(0)
  const [parts, setParts] = useState<PayPart[]>([])
  // OPS-7 (v1.68.0): urejevalnik naročila (NaročiloSheet) + split po izstavkih + coursing
  const [orderSheet, setOrderSheet] = useState<OrderT | null>(null)
  const [sheetCourses, setSheetCourses] = useState<CourseT[]>([])
  // v1.255.0 (PRIMERJAVA-VMESNIKOV-2026 §29): potrditveni banner na vrhu urejevalnika
  // naročila in plačilnega dialoga (Lightspeed »Order view confirmation banner«) —
  // povratni odziv po TIHIH uspehih (dodatek/fire vseh/fire tečaja/dodelitev tečaja/popust).
  const [sheetBanner, setSheetBanner] = useState<ConfirmBanner | null>(null)
  const [payBanner, setPayBanner] = useState<ConfirmBanner | null>(null)
  const [sheetCart, setSheetCart] = useState<Record<string, number>>({})
  // OSS-10 B-del (v1.210.0): izbira variante OSEBJA — skupine opcij (razred `variant`
  // prihaja s strežnika) + vrstice variant za VSE TRI košarice POS (novo naročilo /
  // hitra prodaja / urejevalnik naročila) + skupni dialog izbire variante.
  const [variantGroups, setVariantGroups] = useState<PosVariantGroupView[]>([])
  const [cartVariants, setCartVariants] = useState<PosVariantLine[]>([])
  const [saleVariants, setSaleVariants] = useState<PosVariantLine[]>([])
  const [sheetVariants, setSheetVariants] = useState<PosVariantLine[]>([])
  const [variantPick, setVariantPick] = useState<{ mode: 'cart' | 'sale' | 'sheet'; item: MenuT; selections: Record<string, string> } | null>(null)
  /* STREŽNI VAL v1.248.0 (§22 B — Lightspeed maj 2026 »preset notes«):
     PREDNASTAVLJENE OPOMBE ZA KUHINJO — register (menu.manage v Meni zavihku)
     + izbira na vrstici košarice (vse tri košarice delijo skupni dialog po
     vzorcu variantPick). Opomba gre v items[].note → createOrderCore zapiše
     OrderItem.notes → KDS listek (ℹ) + postajni nalogi + kuhinjski/bar list
     (»opomba: …«) — CELA obstoječa cev, do zdaj brez vnosa. */
  const [presetNotes, setPresetNotes] = useState<{ id: string; label: string; sortOrder: number }[]>([])
  const [cartNotes, setCartNotes] = useState<Record<string, string>>({})
  const [saleNotes, setSaleNotes] = useState<Record<string, string>>({})
  const [sheetNotes, setSheetNotes] = useState<Record<string, string>>({})
  const [notePick, setNotePick] = useState<{ mode: 'cart' | 'sale' | 'sheet'; key: string; name: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteChips, setNoteChips] = useState<Set<string>>(new Set())
  /** trenutna vrednost ključa v izbrani košarici (gumb »Počisti« + indikator) */
  const notePickValue = notePick
    ? (notePick.mode === 'cart' ? cartNotes[notePick.key] : notePick.mode === 'sale' ? saleNotes[notePick.key] : sheetNotes[notePick.key]) ?? ''
    : ''
  /** Odpri dialog opombe: razpusti obstoječo vrednost na čipe + prosto besedilo. */
  function openNotePick(mode: 'cart' | 'sale' | 'sheet', key: string, name: string) {
    const existing = (mode === 'cart' ? cartNotes[key] : mode === 'sale' ? saleNotes[key] : sheetNotes[key]) ?? ''
    const parts = existing ? existing.split('; ').filter(Boolean) : []
    const labels = new Set(presetNotes.map((n) => n.label))
    setNoteChips(new Set(parts.filter((p) => labels.has(p))))
    setNoteText(parts.filter((p) => !labels.has(p)).join('; '))
    setNotePick({ mode, key, name })
  }
  /** Potrdi izbiro: sestavljena opomba (čipi + besedilo) ali odstranitev. */
  function applyNotePick(clear = false) {
    if (!notePick) return
    const value = clear ? '' : composeItemNote([...noteChips], noteText)
    const setter = notePick.mode === 'cart' ? setCartNotes : notePick.mode === 'sale' ? setSaleNotes : setSheetNotes
    setter((m) => {
      const nx = { ...m }
      if (value) nx[notePick.key] = value
      else delete nx[notePick.key]
      return nx
    })
    setNotePick(null)
  }
  // N-27-1 (v1.195.0): aktivni sedež v urejevalniku naročila (OPS-7) —
  // postavke, dodane medtem, ko je sedež aktiven, ga nosijo (null = brez).
  const [sheetSeat, setSheetSeat] = useState<number | null>(null)
  // Issue #5 (komentar #3): preklic posamezne postavke (orders.void) — dialog + razlog
  const [voidItem, setVoidItem] = useState<OrderItemT | null>(null)
  const [voidReasons, setVoidReasons] = useState<{ id: string; name: string }[]>([])
  const [voidReasonId, setVoidReasonId] = useState('')
  const [voidReasonText, setVoidReasonText] = useState('')
  // PRIMERJAVA §23 (v1.249.0): sprememba cene postavke na POS (orders.priceOverride)
  // — dialog + nova cena + OBVEZEN razlog (denarni poseg)
  const [priceItem, setPriceItem] = useState<OrderItemT | null>(null)
  const [priceNew, setPriceNew] = useState('')
  const [priceReason, setPriceReason] = useState('')
  // Issue #19 (v1.107.0): politika finančnih izjem + generični dialog razloga/odobritve
  const [excPolicy, setExcPolicy] = useState<{ policy: { discountApprovalPct: number; discountApprovalAmountCents: number; voidApprovalAmountCents: number; requireReasonDiscount: boolean }; isManagerial: boolean } | null>(null)
  const [excAction, setExcAction] = useState<
    | { type: 'discount-apply'; discountId: string; switching: boolean }
    | { type: 'coupon-apply'; couponCode: string; switching: boolean }
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
    // mikrotaska — odčitek Notification.permission brez sinhronnega setState v efektu
    // (isti prvi izris 'unsupported', snapshota se ne spremeni med hidracijo)
    queueMicrotask(() => {
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
    })
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
  const [orderFilter, setOrderFilter] = useState<'ALL' | 'OPEN' | 'SENT' | 'PREPARED' | 'HOLD'>('ALL')
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
  // Issue #93 (QA): demo seja (prijava z gumba »Vstop brez gesla«) je vidno
  // označena v glavi — meja demo/produkcija mora biti jasna uporabniku,
  // ne samo v dokumentaciji.
  const [demoLogin, setDemoLogin] = useState(false)
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
  /* §39 (v1.265.0): per-lokacijska nastavitev »Dovoli požig s KDS« — DDL
     zastavica (GET /api/locations) + vrednost v dialogu (ločena od locForm:
     pošlje se SAMO ob spremembi, da shranjevanje lokacije pre-DDL ostane čisto). */
  const [kdsExpoFireDdlActive, setKdsExpoFireDdlActive] = useState(false)
  const [locKdsExpoFire, setLocKdsExpoFire] = useState(false)
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
  const [newRes, setNewRes] = useState<{ guestName: string; phone: string; guests: number; reservedAt: string; note: string; tableId: string; source: string; email: string; duration: number; specialRequests: string; locationId: string; autoTable: boolean } | null>(null)
  /* v1.245.0 (§19): kombinacije osvežimo OB ODPRTJU dialoga Nova rezervacija —
     nastavitvena kartica jih lahko spremeni med sejo (poll prinese sveže šele
     čez 15 s); en fetch na odprtje, fail-soft (starejši seznam ostane). */
  const resvDialogOpen = newRes !== null
  useEffect(() => {
    if (!resvDialogOpen) return
    void (async () => {
      try {
        const d = await api<{ combos: { id: string; tableIds: string[] }[] }>(`/api/tables/combos${viewLoc ? `?locationId=${viewLoc}` : ''}`)
        setTableCombos(d.combos ?? [])
      } catch { /* fail-soft — uporabi zadnji znani seznam */ }
    })()
  }, [resvDialogOpen, viewLoc])
  // OPS-8 val 3 (v1.73.0): status filter chips for the reservation list
  const [resFilter, setResFilter] = useState<ReservationFilter>('UPCOMING')
  // Issue #94 (QA): datumski filter zavihka Računi — SKUPEN za knjigovodski
  // portal in seznam izdanih računov (prej je imela kartica lastna from/to,
  // seznam spodaj pa je kazal VSE račune ne glede na izbor).
  const [rcptFrom, setRcptFrom] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) })
  const [rcptTo, setRcptTo] = useState(() => new Date().toISOString().slice(0, 10))

  // v1.251.0 (PRIMERJAVA §25): ISKANJE RAČUNA PO ČRTNI KODI — skener je
  // tipkovnica (keyboard wedge: koda + Enter, isti paradigma kao EAN v1.229);
  // rezultati so vrstice istega tipa kao seznam (natisni ponovitev / storno).
  const [rcptScanCode, setRcptScanCode] = useState('')
  const [rcptScanResults, setRcptScanResults] = useState<ReceiptT[] | null>(null)
  const [rcptScanning, setRcptScanning] = useState(false)
  async function rcptScanSubmit() {
    const code = rcptScanCode.trim()
    if (!code) return
    setRcptScanning(true)
    try {
      const d = await api<{ receipts: ReceiptT[] }>(`/api/furs/lookup?code=${encodeURIComponent(code)}`)
      setRcptScanResults(d.receipts)
    } catch {
      setRcptScanResults([])
    } finally {
      setRcptScanning(false)
    }
  }

  /* ── v1.256.0 (PRIMERJAVA §30; Lightspeed maj 2026 »Reprint orders«):
        PONATIS LISTKOV ZAPRTEGA NAROČILA z izbiro produkcijskega središča ── */
  const [reprintTarget, setReprintTarget] = useState<ReceiptT | null>(null)
  const [reprintOrder, setReprintOrder] = useState<OrderT | null>(null)
  const [reprintStation, setReprintStation] = useState<'KITCHEN' | 'BAR' | 'ALL'>('ALL')
  const [reprintBusy, setReprintBusy] = useState(false)
  /** Odpre dialog: naloži povezano naročilo (GET /api/orders/[id] — requireAuth +
   *  lokacijska vrata strežnika) za števce postavk po središčih. */
  async function openReprint(r: ReceiptT) {
    if (!r.orderId) { toast({ title: t('rcpt.reprintNoOrder'), variant: 'destructive' }); return }
    setReprintTarget(r)
    setReprintOrder(null)
    setReprintStation('ALL')
    try {
      const d = await api<{ order: OrderT }>(`/api/orders/${r.orderId}`)
      setReprintOrder(d.order)
    } catch {
      toast({ title: t('rcpt.reprintLoadFail'), variant: 'destructive' })
      setReprintTarget(null)
    }
  }
  /** Potrdi ponatis: POST (revizija ORDER_TICKET_REPRINT na strežniku) → tisk po
   *  obstoječi cevi (buildKitchenTicketLines + printLines, enako kot KDS). */
  async function confirmReprint() {
    if (!reprintOrder || !reprintTarget) return
    setReprintBusy(true)
    try {
      const d = await api<{ order: OrderT }>(`/api/orders/${reprintOrder.id}/reprint-ticket`, {
        method: 'POST',
        body: JSON.stringify({ station: reprintStation }),
      })
      const o = d.order
      // iskrenost: samo produkcija, ki je nastala (preklicane/umaknjene izpustimo)
      const live = filterTicketItems(o.items)
      const res = await printLines(`Naročilo #${o.orderNumber ?? '?'}`, buildKitchenTicketLines({
        orderNumber: o.orderNumber ?? undefined,
        tableName: o.table?.name || null,
        type: o.type,
        createdAt: o.createdAt,
        employeeName: o.employee?.name || null,
        items: live.map((it) => ({ name: it.name, qty: it.qty, note: it.note, station: it.station, allergenWarning: it.allergenWarning || '', allergenCodes: it.allergenCodes || [], modifiers: it.modifiers ?? [], seat: it.seat ?? null })),
      }, reprintStation === 'ALL' ? undefined : reprintStation, { by: user?.name || null }))
      if (!res.ok) toast({ title: t('print.failed', { error: res.error ?? '' }), variant: 'destructive' })
      else if (res.simulated) {
        toast({ title: reprintStation === 'BAR' ? t('print.simBar') : reprintStation === 'KITCHEN' ? t('print.simKitchen') : t('print.simAll') })
      }
      setReprintTarget(null)
      setReprintOrder(null)
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' })
    } finally {
      setReprintBusy(false)
    }
  }
  /** Števci postavk po središčih za izbirnik (isti kanon kot strežniška revizija). */
  const reprintCounts = useMemo(() => {
    const live = reprintOrder ? filterTicketItems(reprintOrder.items) : []
    const qty = (st: string) => live.filter((it) => (it.station || '').toUpperCase() === st).reduce((s, it) => s + it.qty, 0)
    return { KITCHEN: qty('KITCHEN'), BAR: qty('BAR'), ALL: live.reduce((s, it) => s + it.qty, 0) }
  }, [reprintOrder])

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
    // mikrotaska — clamp (in toast) brez sinhronnega setState v telesu efekta;
    // odločitev se oceni z istimi vrednostmi closure-a, še pred naslednjim izrisom
    queueMicrotask(() => {
      if (canManage) return
      // issue #6 §F: tudi PRAZNA dovoljenja se clampajo (tabHasPerm fail-closed →
      // privilegiran ?tab= pristane na 'pregled', ne da bi čakal na /me)
      if (activeTab !== 'pregled' && !tabHasPerm(activeTab, { canManage, perms })) {
        toast({ title: t('tabs.noPerm') })
        setActiveTab('pregled')
      }
    })
  }, [perms, canManage, activeTab, t])

  // Issue #5 (P1-A lekcija): pri router.push iz prijave App Router posodobi URL ŠELE
  // PO prvem renderu nove strani → useState inicializator je prebral STAR URL ('').
  // Ta effect po umirjenju navigacije prebere ?tab= in sinhronizira aktivni zavihek
  // (varnost: clamp effect zgoraj neodvisno preveri dovoljenje — tuji param ne poviša).
  useEffect(() => {
    // mikrotaska — ?tab= apliciran brez sinhronnega setState v telesu efekta
    // (isti odčitek URL-ja, še vedno pred naslednjim izrisom)
    queueMicrotask(() => {
      const tabParam = new URLSearchParams(window.location.search).get('tab')
      // QA najdba #1 (v1.218.0): od zdaj naprej sme URL-sync efekt pisati — ?tab=
      // je POBRAN (tudi kadar ga ni); prej ga je sinhroni replaceState tega efekta
      // uspel izbrisati ŠE PRED to mikrotasko (deep-link/refresh → 'pregled').
      initialTabRead.current = true
      if (!tabParam || tabParam === activeTab) return
      // Issue #71 audit-27: ?tab=neobstoječi je prej pustil PRAZNO ploščo brez sporočila —
      // izmerjeno ?tab=hitra-prodaja (pravi id: prodaja). Zdaj: obvestilo + preusmeritev.
      if (!TAB_PERM[tabParam]) {
        toast({ title: t('tabs.unknown') })
        setActiveTab('pregled')
        // QA najdba #1 (v1.218.0): počisti neveljaven ?tab= iz URL-ja — URL-sync
        // efekt se ne bo pognal (activeTab se ni spremenil → ni re-renderja),
        // dvoumen parameter pa ne sme ostati (osvežitev bi spet sprožila toast).
        const u = new URL(window.location.href)
        u.searchParams.delete('tab')
        window.history.replaceState(window.history.state, '', u)
        return
      }
      setActiveTab(tabParam)
    })
  }, [])

  // Naloga #10: ?tab= se je samo BRALO. Preklop zavihka je URL pustil na
  // /dashboard, zato osveži, nazaj in deljenje povezave vrnejo na 'pregled'
  // (kuhinja/KDS naprava, ki jo natakar zapusti, izgine). Zapis z
  // replaceState — brez router navigacije, ki bi znova naložila podatke.
  // FIX QA najdba #1 (v1.218.0): prvi zagon tega efekta je URL posodobil
  // SINHRONO (activeTab='pregled' → izbris ?tab=), mikrotaska ?tab= efekta
  // pa se izvede ŠELE PO vseh efektih → parameter je bil že izbrisan.
  // Zdaj zapis čaka na initialTabRead (mikrotaska zgoraj ga dvigne); nato
  // deluje kot prej (vsak preklop zavihka osveži ?tab=, 'pregled' ga pobriše).
  useEffect(() => {
    if (!initialTabRead.current) return // ?tab= še ni pobran — NE piši URL-ja
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
      // QA-val v1.222.0 (najdba #4): setPerms je asinhron — gateRef.current se
      // osveži šele na naslednjem renderju, zato je PRVI load('full') po prijavi
      // za ne-centralne vloge videl PRAZEN nabor in preskočil vse hp()-gated
      // vire (finance, zaposlene, dobavitelje …) do 60-sekundnega poll cikla.
      // Svež nabor iz /api/auth/me zato uporabi TAKOJ v isti iteraciji.
      let freshPerms: string[] | null = null
      try {
        const me = await api<{ employee: { permissions?: string[] } }>('/api/auth/me')
        if (me.employee?.permissions) { freshPerms = me.employee.permissions; setPerms(me.employee.permissions) }
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
      // QA-val v1.222.0 (najdba #4): sveža dovoljenja iz /api/auth/me imajo
      // prednost pred (zastarelim) gateRef zrcalom — prvi load po prijavi sicer
      // preskoči finančne/kadrovske vire do naslednjega 60-s cikla.
      const effPerms = freshPerms ?? curPerms
      const hp = (p: string) => manage || effPerms.includes(p)
      const hpAny = (...ps: string[]) => manage || ps.some((x) => effPerms.includes(x))
      const [d, t, o, oh, k, m, e, r, rec, inv, sh, fin, haccpRows, ex, loy, sup, recp, jb, fb, ls, ig, wb, el, se, dv, au, dl, lc, vg, tc, pn] = await Promise.all([
        soft(api<{ stats: Stats }>(`/api/dashboard${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)),
        soft(api<{ tables: TableT[] }>('/api/tables')),
        soft(api<{ orders: OrderT[] }>('/api/orders')),
        // OSS-4 (v1.204.0): zadržana naročila prihajajo iz LOČENega pridobivanja —
        // privzeti GET /api/orders vrne samo ORDER_ACTIVE_DB ('hold' ni aktiven tok);
        // pridobivanje ?status=hold je dovoljeno prek obstoječega status-filtra rute.
        soft(api<{ orders: OrderT[] }>('/api/orders?status=hold')),
        // Issue #5 §C: postaja gre NA STREŽNIK (?station=) — KDS naprava dobi SAMO
        // svojo postajo (kdsStationRef mirror za poll closure). Issue #14: custom
        // station ids are ADDITIVE (server ignores unknown values for the legacy
        // queue filter — the task board does its own client-side filtering).
        soft(api<{ queue: OrderT[]; stationTargets?: Record<string, number | null>; stations?: KdsStationT[]; tasks?: KdsTaskT[]; stationStats?: KdsStationStatT[]; ticketSequences?: Record<string, number>; ticketSequenceDdlActive?: boolean; expoFireLocations?: Record<string, boolean> }>(`/api/kitchen${kdsStationRef.current && kdsStationRef.current !== 'ALL' ? `?station=${kdsStationRef.current}` : ''}`)),
        // v1.164.0 (Neon egress): počasni viri samo v polnem 60-sekundnem ciklu
        // v1.164.0 (Neon egress): počasni viri samo v polnem 60-sekundnem ciklu
        dashboardPollIncludes(scope, 'menus') ? soft(api<{ items: MenuT[]; categories: CategoryT[] }>(`/api/menus${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`)) : undefined,
        full && hp('employees.manage') ? soft(api<{ employees: EmployeeT[] }>('/api/employees')) : undefined,
        dashboardPollIncludes(scope, 'reservations') ? soft(api<{ reservations: ReservationT[] }>('/api/reservations')) : undefined,
        dashboardPollIncludes(scope, 'furs') ? soft(api<{ receipts: ReceiptT[] }>('/api/furs')) : undefined,
        full ? soft(api<{ inventory: InventoryT[] }>('/api/inventory')) : undefined,
        dashboardPollIncludes(scope, 'shifts') ? soft(api<{ shifts: ShiftT[] }>('/api/shifts')) : undefined,
        full && hp('reports.sales') ? soft(api<FinancialT>('/api/reports/financial')) : undefined,
        full && hpAny('haccp.execute', 'settings.manage') ? soft(api<{ haccpChecks: HaccpT[] }>('/api/haccp')) : undefined,
        full && hp('reports.sales') ? soft(api<{ expenses: ExpenseT[]; categoriesEnabled?: boolean }>('/api/expenses')) : undefined,
        full && hp('settings.manage') ? soft(api<{ accounts: LoyaltyT[] }>('/api/loyalty')) : undefined,
        full && hpAny('inventory.manage', 'reports.sales', 'settings.manage') ? soft(api<{ suppliers: SupplierT[] }>('/api/suppliers')) : undefined,
        full && hp('inventory.manage') ? soft(api<{ recipes: RecipeT[] }>('/api/recipes')) : undefined,
        full && hp('employees.manage') ? soft(api<{ jobContexts: JobT[]; tipPointsDdlActive?: boolean }>('/api/jobs')) : undefined,
        full && hp('reservations.manage') ? soft(api<{ feedback: FeedbackT[] }>('/api/guests/feedback')) : undefined,
        full && manage ? soft(api<{ stats: LocationStatT[] }>('/api/locations/stats')) : undefined,
        full && hp('settings.manage') ? soft(api<{ integrations: IntegrationT[] }>('/api/integrations')) : undefined,
        full && hp('settings.manage') ? soft(api<{ webhookEndpoints: WebhookT[] }>('/api/webhooks')) : undefined,
        full && hp('settings.manage') ? soft(api<{ errors: ErrLogT[] }>('/api/monitoring/errors')) : undefined,
        full && hp('settings.manage') ? soft(api<{ settings: Record<string, unknown> | null }>('/api/settings')) : undefined,
        full && hp('employees.manage') ? soft(api<{ devices: DeviceT[] }>('/api/devices')) : undefined,
        full && hp('reports.sales') ? soft(api<{ entries: AuditT[] }>('/api/audit')) : undefined,
        full && hp('delivery.manage') ? soft(api<{ orders: DeliveryOrderT[]; zones: DeliveryZoneT[]; platformIntegrations: PlatformIntegrationT[] }>('/api/delivery')) : undefined,
        full && hp('settings.manage') ? soft(api<{ locations: LocationRowT[]; kdsExpoFireDdlActive?: boolean }>('/api/locations')) : undefined,
        // OSS-10 B-del (v1.210.0): skupine opcij — vir razreda `variant` za POS
        // (requireAuth — za vse vloge, kot meni; isti poll vratarj 'menus').
        dashboardPollIncludes(scope, 'menus') ? soft(api<{ groups: PosVariantGroupView[] }>('/api/modifier-groups')) : undefined,
        // v1.245.0 (§19): kombinacije miz za velike družbe (dialog + avtododelitev;
        // isti lastnik kot rezervacije — vratar 'reservations')
        dashboardPollIncludes(scope, 'reservations') && hp('reservations.manage')
          ? soft(api<{ combos: { id: string; tableIds: string[] }[]; excludedTableIds: string[] }>(`/api/tables/combos${viewLocRef.current ? `?locationId=${viewLocRef.current}` : ''}`))
          : undefined,
        // STREŽNI VAL v1.248.0 (§22 B): prednastavljene opombe (requireAuth — vse
        // vloge; isti vratar 'menus' kot skupine opcij — POS izbira v košaricah)
        dashboardPollIncludes(scope, 'menus') ? soft(api<{ notes: { id: string; label: string; sortOrder: number }[] }>('/api/preset-notes')) : undefined,
      ])
      if (d) setStats(d.stats)
      if (t) setTables(t.tables)
      // OSS-4 (v1.204.0): aktivni tok + zadržani (različna stanja — brez prekrivanja)
      if (o || oh) setOrders([...(o?.orders ?? []), ...(oh?.orders ?? [])])
      if (k) {
        setKitchen(k.queue)
        setStationTargets(k.stationTargets ?? {})
        // Issue #14: additive fields (pre-DDL → undefined → keep empty = legacy behavior)
        setKdsStations(k.stations ?? [])
        setKdsTasks(k.tasks ?? [])
        setKdsStationStats(k.stationStats ?? [])
        // §38 (v1.264.0): ročna zaporedja listkov — mapa samo ZA VPISANA mesta
        // (pre-DDL → prazna → vrsta enaka default, graceful) + DDL zastavica
        setKdsSequences(k.ticketSequences ?? {})
        setKdsSeqDdlActive(k.ticketSequenceDdlActive === true)
        // §39 (v1.265.0): per-lokacijska nastavitev expo požiga — mapa iz polla
        // (pre-DDL → prazna → glave tečajev nedejavne, graceful)
        setKdsExpoFireLocs(k.expoFireLocations ?? {})
      }
      if (m) { setMenu(m.items); setCategories(m.categories) }
      if (e) setEmployees(e.employees)
      if (r) setReservations(r.reservations)
      // v1.245.0 (§19): kombinacije miz (dialog Nova rezervacija + avtododelitev)
      if (tc) setTableCombos(tc.combos)
      if (rec) setReceipts(rec.receipts)
      if (inv) setInventory(inv.inventory)
      if (sh) setShifts(sh.shifts)
      if (fin) setFinancial(fin)
      if (haccpRows) setHaccp(haccpRows.haccpChecks)
      if (ex) { setExpenses(ex.expenses); setExpCatsEnabled(ex.categoriesEnabled === true) }
      if (loy) setLoyalty(loy.accounts)
      if (sup) setSuppliers(sup.suppliers)
      if (recp) setRecipes(recp.recipes)
      if (jb) { setJobs(jb.jobContexts); setJobsTipDdl(jb.tipPointsDdlActive === true) }
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
          // §37: prikazovna politika (policy objekt ločeno od settings DTO;
          // pre-DDL → undefined → false — preklop v UI onemogočen)
          hideZeroReceiptItems: !!(se as { receiptDisplayPolicy?: { hideZeroItems?: boolean } }).receiptDisplayPolicy?.hideZeroItems,
        } : null)
        setReceiptPolicyDdlActive(!!(se as { receiptDisplayPolicyDdlActive?: boolean }).receiptDisplayPolicyDdlActive)
      }
      if (dv) setDevices(dv.devices)
      if (au) setAuditLog(au.entries)
      if (dl) { setDeliveryOrders(dl.orders); setDeliveryZones(dl.zones); setDeliveryIntegrations(dl.platformIntegrations) }
      if (lc) {
        setLocList(lc.locations)
        // §39: DDL zastavica nastavitve expo požiga (migrBox vzorec — preklop
        // v dialogu lokacije je onemogočen do migracije kds-expo-fire)
        setKdsExpoFireDdlActive(lc.kdsExpoFireDdlActive === true)
      }
      // OSS-10 B-del (v1.210.0): skupine opcij (fail-soft: padec → [] → UI se obnaša
      // kot prej, strežnik ostane varovalka z 400 »Skupina … je obvezna«)
      if (vg) setVariantGroups(vg.groups || [])
      // §22 B: prednastavljene opombe (fail-soft — brez registra dialog ponudi
      // SAMO prosto besedilo, kar je nadgradnja obstoječega stanja brez njega)
      if (pn) setPresetNotes(pn.notes || [])
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
    // mikrotaska — samodejna izbira lokacije brez sinhronnega setState v telesu efekta
    // (stražarski ref zapeči enkratnost enako kot prej; odločitev še pred naslednjim izrisom)
    queueMicrotask(() => {
      if (locAutoPicked.current || viewLoc || locList.length === 0) return
      locAutoPicked.current = true
      const own = user?.locationId && locList.some((l) => l.id === user.locationId) ? user.locationId : ''
      if (own) setViewLoc(own)
      else if (locList.length === 1) setViewLoc(locList[0].id)
    })
  }, [locList, user, viewLoc])

  useEffect(() => {
    // mikrotaska — začetni load + odčitki konfigov brez sinhronnega setState v telesu
    // efekta (load sinhrono postavlja refreshing; interval/listenerji ostanejo sinhronni)
    queueMicrotask(() => {
      void load()
      setBootstrapLogin(localStorage.getItem('ro_bootstrap') === '1')
      setDemoLogin(localStorage.getItem('ro_demo') === '1')
      setPcfg(getPrintConfig())
      setTermMode(getTerminalConfig().mode)
    })
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
  /* v1.232.0 (PRIMERJAVA §3 »Push (ne polling)«, Toast/Square KDS realtime): SSE
     PRETOK ZA KUHINJO — na zavihku kuhinja odpre EventSource na /api/kitchen/stream;
     dogodek `changed` (nov listek/prehod postavke/postajna naloga — podpis iz
     MAX(updatedAt)) TAKOJU sproži load('hot'). Svežina ~3–5 s namesto do 15 s.
     DISCIPLINA (iskrenost + vzdržljivost):
      - odpre se SAMO na zavihku kuhinja in SAMO vlogam, ki zavihek vidijo
        (tabHasPerm — sicer bi EventSource v krogu ponavljal 403);
      - ODVISNOST efekta je IZPELJANI BOOLEAN kdsSseOpen (ne array perms!) — setPerms
        v load() ustvari NOVO referenco arraya na vsakem pollu, kar bi efektu
        razstrelilo identiteto odvisnosti in povzročilo neprekinjen close/open krog
        (E2E najdba: povezava se je obnavljala vsakih ~1,6 s — changed → load →
        setPerms → re-run efekta → nova povezava → changed …);
      - polling 15 s ostaja NEPREKINJENO kot fallback (padec SSE/proxy/stari
        brskalnik → nič se ne spremeni; strežnik tok po 55 s zapre sam in se
        EventSource poveže nazaj — retry hint 5 s);
      - dvojni sprožitelj je dušen (≥ 2,5 s med reloadi — sprememba v hitrem
        zaporedju sproži ENO osvežitev, ne kotovada);
      - LIVE oznaka (kdsLive) se prikaže SAMO po dogodku hello/povezavi — ob
        napaki izklopi (ne laže, da je pretok živ). */
  const kdsSseOpen = activeTab === 'kuhinja' && tabHasPerm('kuhinja', { canManage, perms })
  const [kdsLive, setKdsLive] = useState(false)
  useEffect(() => {
    if (!kdsSseOpen) return
    let lastTrig = 0
    const es = (() => { try { return new EventSource('/api/kitchen/stream') } catch { return null } })()
    if (!es) return
    es.onopen = () => setKdsLive(true)
    es.addEventListener('hello', () => setKdsLive(true))
    es.addEventListener('changed', () => {
      const now = Date.now()
      if (now - lastTrig < 2500) return
      lastTrig = now
      void load('hot')
    })
    es.onerror = () => setKdsLive(false)
    return () => { es.close(); setKdsLive(false) }
  }, [kdsSseOpen, load])
  // offline vrsta (issue #1) — online/offline status je zgoraj prek useSyncExternalStore
  useEffect(() => {
    const unsub = subscribeQueue(setQueueOps)
    // mikrotaska — začetni odčitek vrste brez sinhronnega setState v telesu efekta
    queueMicrotask(() => { setQueueOps(getQueue()) })
    return () => { unsub() }
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
    // mikrotaska — doSync sinhrono zapre setSyncing (setState) iz sinhronne poti efekta
    if (online) queueMicrotask(() => { void doSync() })
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
    // Issue #90 (QA): httpOnly piškotek seje lahko pobriše SAMO strežnik —
    // fire-and-forget POST /api/auth/logout (idempotenten; tudi brez seje 200).
    // Lokalno stanje počistimo takoj (nalaganje '/' ne čaka omrežja).
    void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
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
    // v1.170.0: `items` in `clientOperationId` sta MORATA biti vidna v obeh vejeh —
    // offline veja pošlje enake postavke pod istim id-jem, da strežnik ob replayu
    // ne ustvari dvojnega naročila.
    // OSS-10 B-del (v1.210.0): + vrstice variant (modifierji tečejo v istem items
    // nizu — createOrderCore jih validira in oceni iz DB; offline replay jih nosi).
    // §22 B: opombe vrstic (artikel + varianta) — note gre v items[].note,
    // createOrderCore zapiše OrderItem.notes (kuhinja/list ju že prikazujeta)
    const items = [
      ...Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty, ...(cartNotes[menuItemId] ? { note: cartNotes[menuItemId] } : {}) })),
      ...posVariantItemsPayload(cartVariants).map((it, i) => ({ ...it, ...(cartNotes[cartVariants[i].key] ? { note: cartNotes[cartVariants[i].key] } : {}) })),
    ]
    if (items.length === 0) return
    // idempotencija: isti clientOperationId ob replayu ne ustvari dvojnega naročila
    const clientOperationId = newOperationId()
    try {
      // v1.86.2: lokacija iz mize za centralno vlogo brez lokacije (server ignorira za osebje)
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: newOrderTable.id, items, guests: 2, clientOperationId, locationId: newOrderTable.locationId || undefined }) })
      setCart({}); setCartVariants([]); setCartNotes({}); setNewOrderTable(null); await load()
    } catch (err) {
      if (isNetworkError(err)) {
        // offline → naročilo se NE IZGUBI, gre v lokalno vrsto za sinhronizacijo
        // v1.170.0: zavrnitev (polna vrsta / kvota) pomeni, da naročilo NI shranjeno
        const rezultat = tryEnqueueOp('order.create', { tableId: newOrderTable.id, items, guests: 2, note: '', locationId: newOrderTable.locationId || undefined }, clientOperationId)
        if (!rezultat.ok) { toast({ title: t('net.queueFull'), variant: 'destructive' }); return }
        setCart({}); setCartVariants([]); setCartNotes({}); setNewOrderTable(null)
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
        const rezultat = tryEnqueueOp('kitchen.status', { itemId, status, ...(delayReason ? { delayReason } : {}) })
        if (!rezultat.ok) { toast({ title: t('net.queueFull'), variant: 'destructive' }); return }
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
        // v1.170.0: serija se lahko odbije DELNO (vrsta se zapolni sredi zanke).
        // Če o tem molčimo, kuhar vidi "v vrsti za sinhronizacijo" in misli, da je
        // cel listek oddan — tiste postavke pa v vrsti NI.
        let odbite = 0
        for (const it of targets) {
          const rezultat = tryEnqueueOp('kitchen.status', { itemId: it.id, status: 'READY' })
          if (!rezultat.ok) odbite += 1
        }
        if (odbite > 0) toast({ title: t('net.queuePartial'), variant: 'destructive' })
        else toast({ title: t('net.offlineStatusQueued') })
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
    setSheetNotes({})
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

  /**
   * PRIMERJAVA §23 (v1.249.0): potrdi spremembo cene postavke (denarni
   * poseg — razlog OBVEZEN vedno, strežnik ga zahteva neodvisno od politike
   * izjem). Vnos preverimo pred pošiljanjem (priazna sporočila), avtoriteta
   * je strežnik (CAS + transakcija).
   */
  async function confirmPriceOverride() {
    if (!priceItem || !orderSheet) return
    const parsed = Number(priceNew.trim().replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast({ title: t('prc.invalid'), variant: 'destructive' })
      return
    }
    if (priceReason.trim().length < 3) {
      toast({ title: t('prc.reasonMissing'), variant: 'destructive' })
      return
    }
    setSending(true)
    try {
      const d = await api<{ overridden: { oldPrice: number; newPrice: number; delta: number }; order: OrderT | null }>(`/api/orders/${orderSheet.id}/price-override`, {
        method: 'POST',
        body: JSON.stringify({ itemId: priceItem.id, price: parsed, reason: priceReason.trim() }),
      })
      setPriceItem(null)
      if (d.order) setOrderSheet(d.order)
      toast({ title: t('prc.done'), description: `${fmtEUR(d.overridden.oldPrice)} → ${fmtEUR(d.overridden.newPrice)}` })
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
    // OSS-10 B-del (v1.210.0): + vrstice variant z modifierji (backend addItems jih
    // validira z ISTO logiko kot createOrderCore — cena doplačila teče v vrstico).
    const seatField = sheetSeat != null ? { seat: sheetSeat } : {} // N-27-1: aktivni sedež
    const items = [
      ...Object.entries(sheetCart).map(([menuItemId, qty]) => ({ menuItemId, qty, ...seatField, ...(sheetNotes[menuItemId] ? { note: sheetNotes[menuItemId] } : {}) })),
      ...posVariantItemsPayload(sheetVariants).map((it, i) => ({ ...it, ...seatField, ...(sheetNotes[sheetVariants[i].key] ? { note: sheetNotes[sheetVariants[i].key] } : {}) })),
    ]
    if (items.length === 0) return
    setSending(true)
    try {
      const clientOperationId = newOperationId()
      await api(`/api/orders/${orderSheet.id}`, { method: 'PATCH', body: JSON.stringify({ addItems: items, clientOperationId }) })
      setSheetCart({}); setSheetVariants([]); setSheetNotes({})
      // v1.255.0 §29: dodatek je bil TIHO uspešen — banner potrdi število (Lightspeed
      // »confirmation banner … when a task is complete«); vrata ostanejo na strežniku.
      setSheetBanner(addItemsBanner(items.length))
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
      const d = await api<{ firedCount: number }>(`/api/orders/${orderSheet.id}/fire`, { method: 'POST' })
      // v1.255.0 §29: streljanje vseh pending postavk je bilo TIHO — banner
      // potrdi koliko jih je šlo v kuhinjo (firedCount iz strežniškega odgovora).
      setSheetBanner(fireAllBanner(d.firedCount))
      await load()
      void refreshSheetOrder(orderSheet.id)
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
  }

  /** v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4): PRENOS NAROČILA NA DRUGEGA ZAPOSLEGA
   *  (Lightspeed »transfer user«) — izmena si izmenjuje naročila brez vsebinskih
   *  sprememb. Strežnik: orders.create + samo aktivna naročila + lokacijski gate +
   *  revizija ORDER_TRANSFER. UI: izbira v glavi NaročiloSheeta. */
  async function transferOrder(employeeId: string) {
    if (!orderSheet) return
    setSending(true)
    try {
      const d = await api<{ order: OrderT }>(`/api/orders/${orderSheet.id}`, { method: 'PATCH', body: JSON.stringify({ employeeId }) })
      toast({ title: t('sheet.transferred', { name: d.order.employee?.name || employeeId }) })
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
      // identiteta tečaja iz ZNANEGA stanja (pred osvežitvijo) — banner pove kdo je šel
      const course = sheetCourses.find((c) => c.id === courseId)
      await api(`/api/orders/${orderSheet.id}/fire`, { method: 'POST', body: JSON.stringify({ courseId }) })
      const d = await api<{ courses: CourseT[] }>(`/api/orders/${orderSheet.id}/courses`)
      setSheetCourses(d.courses)
      // v1.255.0 §29: fire tečaja je bil TIH — banner potrdi številko in ime tekme.
      setSheetBanner(fireCourseBanner(course?.courseNumber, course?.name))
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
      const course = sheetCourses.find((c) => c.id === v)
      if (v === '__new') {
        await api(`/api/orders/${orderSheet.id}/courses`, { method: 'POST', body: JSON.stringify({ itemIds: [itemId] }) })
      } else {
        await api(`/api/orders/${orderSheet.id}/courses`, { method: 'PATCH', body: JSON.stringify({ courseId: v, itemIds: [itemId] }) })
      }
      const d = await api<{ courses: CourseT[] }>(`/api/orders/${orderSheet.id}/courses`)
      setSheetCourses(d.courses)
      // v1.255.0 §29: dodelitev h tečaju je bila TIHA — nov tečaj nosi svoje
      // številko iz odgovora, obstoječi pa identiteto iz znanega stanja.
      if (v === '__new') {
        const created = d.courses.length > 0 ? d.courses[d.courses.length - 1] : undefined
        setSheetBanner(courseAssignBanner(created?.courseNumber, created?.name))
      } else {
        setSheetBanner(courseAssignBanner(course?.courseNumber, course?.name))
      }
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

  /** P1-6 split po gostih: poštena (LPT po znesku) porazdelitev postavk na N izstavkov.
   *  Zraven obstoječega ročnega splita po izstavkih — en klik za "2 gosta na računu";
   *  vsak gost dobi svoj izstavek → svoje plačilo → svoj račun. Ponoven klic prebalansira. */
  async function splitByGuests(guestCount: number) {
    if (!payingOrder || sending) return
    setSending(true)
    try {
      await api(`/api/orders/${payingOrder.id}/checks/guests`, { method: 'POST', body: JSON.stringify({ guestCount }) })
      toast({ title: t('payment.splitGuestsDone', { n: guestCount }) })
      setSplitSel({})
      const d = await refreshChecks(payingOrder.id)
      setSplitOpen(d.checkCount > 1)
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
  }

  /** P3 #20 (v1.193.0) sedeži: označene postavke dodeli sedežu (null = počisti).
   *  POLNI nadomestni načrt: neoznačene postavke obdržijo svoj trenutni sedež
   *  (odjemalec pošlje celotno razporeditev — idempotentno, strežnik je vir resnice). */
  async function assignSeats(seat: number | null) {
    if (!payingOrder || !checksData || sending) return
    const target = Object.entries(splitSel).filter(([, v]) => v).map(([k]) => k)
    if (target.length === 0) return
    setSending(true)
    try {
      const bySeat = new Map<number, string[]>()
      for (const it of checksData.items) {
        const s = target.includes(it.id) ? seat : it.seat
        if (s === null) continue
        const arr = bySeat.get(s) ?? []
        arr.push(it.id)
        bySeat.set(s, arr)
      }
      await api(`/api/orders/${payingOrder.id}/seats`, {
        method: 'PUT',
        body: JSON.stringify({ assignments: [...bySeat.entries()].map(([s, ids]) => ({ seat: s, itemIds: ids })) }),
      })
      toast({ title: t('payment.seatsDone') })
      setSplitSel({})
      await refreshChecks(payingOrder.id)
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setSending(false) }
  }

  /** P3 #20 (v1.193.0): razdeli izstavke po sedežih — vsak zaseden sedež dobi svoj
   *  izstavek, postavke brez sedeža ostanejo na baznem izstavku #1 (rebalans). */
  async function splitBySeats() {
    if (!payingOrder || sending) return
    setSending(true)
    try {
      await api(`/api/orders/${payingOrder.id}/checks/seats`, { method: 'POST' })
      toast({ title: t('payment.seatsSplitDone') })
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
    setPayBanner(null) // v1.255.0 §29: vsak plačilni pogled začne čist (brez tujih potrditev)
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
    // Issue #97 (QA P1): fiskalni storno IZ SEZNAMA računov nima payingOrder
    // (ves kontekst je v excAction.receipt) — prej je ta pogoj tiho obstavil
    // celoten klik »Potrdi izjemo« (0 omrežnih zahtev, 0 toastov, dialog odprt).
    // payingOrder ostaja OBVEZEN za popuste/kupone (veja spodaj ga bere).
    if (!excAction) return
    if (excAction.type !== 'storno' && !payingOrder) return
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
        // Tipovna varovalka: zgornji pogoj (#97) za ne-storno veje ŽE zahteva
        // payingOrder — ta vrstica samo razcepi tip za nadaljevanje veje.
        if (!payingOrder) return
        const body = excBody()
        if (excAction.type === 'discount-apply' && excAction.switching) {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE', body: JSON.stringify(body) })
        } else if (excAction.type === 'coupon-apply' && excAction.switching) {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE', body: JSON.stringify(body) })
        } else if (excAction.type === 'discount-remove') {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'DELETE', body: JSON.stringify(body) })
        }
        if (excAction.type === 'discount-apply') {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ ...body, discountId: excAction.discountId }) })
          setSelDiscountId(excAction.discountId)
        } else if (excAction.type === 'coupon-apply') {
          await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ ...body, couponCode: excAction.couponCode }) })
          setCouponCode('')
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
      // v1.255.0 §29: popust pod pragom je bil TIH — banner potrdi ime in znesek
      // (Lightspeed »every discount added will be clear«); znesek iz OSVEŽENEGA računa.
      setPayBanner(discountBanner(d.name, b.bill.manualDiscount))
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

  /** P2-10b (v1.187.0): odkup osebnega kupona — gre skozi isto discount jedro.
   *  Pod pragom (privzeto 15 %) brez trenja; nad pragom/politika razloga →
   *  dialog izjeme z ISTIM razlogom (kot ročni popust). */
  async function applyCoupon() {
    if (!payingOrder) return
    const code = couponCode.trim().toUpperCase()
    if (!code) return
    const pol = await ensureExcPolicy()
    const switching = !!selDiscountId && selDiscountId !== 'none'
    const needsReason = (pol?.policy.requireReasonDiscount ?? false) || switching
    if (needsReason) {
      setExcAction({ type: 'coupon-apply', couponCode: code, switching })
      await openExceptionDialog({ titleKey: 'exc.discountTitle', needsReason: true, needsApprover: false, kindCatalog: 'discount' })
      return
    }
    try {
      await api(`/api/orders/${payingOrder.id}/discount`, { method: 'POST', body: JSON.stringify({ couponCode: code }) })
      setCouponCode('')
      const b = await api<{ bill: BillT }>(`/api/orders/${payingOrder.id}/bill`)
      setBill(b.bill)
      await load()
      toast({ title: t('cp.applied') })
    } catch (err) {
      const msg = String((err as Error).message || '')
      if (/razlog|odobrit/i.test(msg)) {
        setExcAction({ type: 'coupon-apply', couponCode: code, switching: false })
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
      // v1.238.0 §15 (P0): ODPRTI BALANCE — prek plačilnih povezav (QR) že pobrani
      // deleži se odštejejo PRED bremenitvijo terminala. PREJ je POS naročil terminalu
      // CELOTEN znesk (strežnik bi pri zaključku vzel samo preostanek — gost bi bil
      // fizično obremenjen dvakrat). Toast/Square: terminal vedno dobi samo open balance.
      const linkPaid = bill.linkPaidTotal && bill.linkPaidTotal > 0 ? bill.linkPaidTotal : 0
      const due = r2v(bill.totalDue - redeemValue - linkPaid)
      // v1.238.0 §15 (P0): napitnina pri kartičnem/mobilnem plačilu gre NA TERMINAL
      // (due + tip) — enako kot handheld (referenčna implementacija). PREJ je POS
      // terminalu naročil SAMO due, napitnino pa zapisal v knjige/bazen — osebje bi
      // dobilo izplačilo denarja, ki nikoli ni bil pobran.
      const tipNum = Number(tipEur) > 0 ? r2v(Number(tipEur)) : 0
      // v deljenem načinu napitnino (enkrat) nosi prvi kartični/mobilni del
      let tipOnTerminal = tipNum
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
          // v1.238.0 §15: napitnino (enkrat) pripnemo prvemu kartičnemu/mobilnemu delu —
          // fizična bremenitev = del + tip, strežniku pošljemo SAMO del (tip gre ločeno
          // v body.tip; vsota delov mora ostati = znesek računa)
          const chargeAmount = r2v(p.amount + tipOnTerminal)
          tipOnTerminal = 0
          const term = await processTerminalPayment(chargeAmount)
          if (!term.approved) {
            toast({ title: term.error || t('payment.terminalDeclined', { amount: fmtEUR(chargeAmount) }), variant: 'destructive' })
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
          // v1.238.0 §15: terminal bremeni due + tip (handheld vzorec); body tip ostane ločen
          const chargeAmount = r2v(due + tipNum)
          const term = await processTerminalPayment(chargeAmount)
          if (!term.approved) {
            toast({ title: term.error || t('payment.terminalNotApproved'), variant: 'destructive' })
            return
          }
          bodyParts.push({ type: payMethod, amount: due, terminal: { approvalCode: term.approvalCode as string } })
        } else {
          bodyParts.push({ type: 'cash', amount: due })
        }
      }
      const d = await api<{ invoice: { eor: string; invoiceNumber: string; id?: string }; loyalty: { redeemedPoints: number; earnedPoints: number } | null; auto86?: { name: string; inventoryItem: string }[] }>('/api/furs', {
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
          /* QA-val v1.221.0 (najdba): loyaltyAccountId se pošlje VEDNO, ko je gost
             izbran — prej je bil pogojen na redeemPoints > 0, zato NOVI član (0 točk)
             pri plačilu NI bil poslan strežniku in NI zaslužil prvih točk ( zaslužek
             zahteva loyaltyAccount glej issue.ts earnedPoints). loyaltyPointsUsed
             ostaja pogojen — 0 pomeni samo zaslužek, brez unovčenja. */
          ...(loyaltySel
            ? {
                loyaltyAccountId: loyaltySel.id,
                ...(redeemPoints > 0 ? { loyaltyPointsUsed: redeemPoints } : {}),
              }
            : {}),
        }),
      })
      setInvoice(d.invoice)
      if (d.loyalty) setLoyaltySummary(d.loyalty)
      // v1.230.0 — samodejni 86: če je plačilo spraznilo zalogo, natakar to VE takoj
      // (ploscica 86 pride z naslednjo osvežitvijo menija; toast je neposredna povratna informacija)
      if (d.auto86 && d.auto86.length > 0) {
        toast({ title: t('sale.auto86Toast'), description: d.auto86.map((a) => a.name).join(', ') })
      }
      // Issue #3: CFD pokaže "Hvala" z zneskom in številko naročila
      void pushDisplay({ state: 'paid', orderNumber: payingOrder.orderNumber, total: bill.totalDue, message: t('payment.pushPaid') })
      // OSS-15 (v1.201.0): zvočna potrditev plačila na napravi osebja — natakar
      // sliši "di-dii" brez gledanja v zaslon; lib sama preveri nastavitev naprave
      // in je NIKOLI kritična (napake pogoltne — plačilni tok je nad zvokom).
      playPaymentCue()
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
      // §37: ESC-POS/agent pot teče čez ISTI čisti pomočnik kot browser
      // izris (receiptDisplayItems) — ena resnica obeh tiskalnih ciljev;
      // posnetek/kuhinja ostanejo popolni (Square: transaction records).
      const displayItems = receiptDisplayItems(r)
      const lines: PrintLine[] = [
        { text: r.businessAddress || '' },
        ...(r.taxId ? [{ text: t('print.taxIdLine', { tax: r.taxId }) } as PrintLine] : []),
        { text: '· · · · · · · · · · · · · · · · · ·' },
        ...(r.tableName ? [{ text: t('print.tableLine', { name: r.tableName }) } as PrintLine] : []),
        { text: '--------------------------------' },
        ...displayItems.map((it) => ({ text: `${it.qty}x ${it.name}` } as PrintLine)),
        ...displayItems.map((it) => ({ text: `   ${money(it.amount)}`, align: 'right' } as PrintLine)),
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
      const res = await printLines(`Račun ${r.invoiceNumber}`, lines)
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

  /** Issue #94 (QA): računi iz obdobja pred novo številčno shemo (R-YYYY-NNNNN)
   *  se v seznamu označijo — računovodja ne ugiba, zakaj sta v seznamu dva formata.
   *  (Migracija/preštevilčenje je lastnikova B-odločitev — FURS izdanih številk
   *  ne dovoljuje preštevilčiti nazaj.) */
  const legacyInvoiceNumber = (n: string) => /^R-\d{4}-\d+$/.test(n)

  /** Issue #94 (QA): seznam izdanih računov spošuje datumsko obdobje zavihka
   *  (Od/Do v knjigovodskem portalu zgoraj) — prej je kazal vse račune ne glede
   *  na izbor. Meja ostaja pošteno zapisana: nalojenih je zadnjih 100 računov
   *  (/api/furs), starejša obdobja izven tega okvira so prazna. */
  const receiptsInRange = receipts.filter((r) => {
    if (!rcptFrom && !rcptTo) return true
    const d = new Date(r.createdAt)
    if (rcptFrom && d < new Date(`${rcptFrom}T00:00:00`)) return false
    if (rcptTo && d > new Date(`${rcptTo}T23:59:59.999`)) return false
    return true
  })

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

  /* OSS-4 (v1.204.0): zadržanje/nadaljevanje — parkiranje nedokončanega naročila brez
     zaključka. Strežnik je avtoriteta (canHoldOrder: samo open+unpaid+brez poslanih);
     UI zrcali pravilo za skrivanje gumba, 409 od garde pa ostane uporabniku viden. */
  /** UI zrcali strežniško pravilo !firedAt: vsa ne-voided postavka mora biti še PENDING
      (PREPARING/READY/SERVED v UI preslikavi pomeni pošiljanje na kuhinjo). */
  const holdableUi = (o: OrderT) => o.items.every((it) => it.voided || it.status === 'PENDING' || it.status === 'CANCELLED')

  /** OSS-4 (v1.204.0): besedilo statusa na ploščici mize — miza z ZADRŽANIM naročilom
      nosi »Zadržano« (barva ostane zasedena — miza JE zasedena, Issue #70). Enotno na
      obeh vrsticah ploščice + aria/title, da se parkirano razloči od aktivnega toka. */
  const tileStatusL = (tb: TableT): string => (tb.heldOrderId && !tb.activeOrder ? stL('HOLD') : stL(tb.status))
  /* v1.244.0 (§18 C): inicialki natakarja za ploščice (mreža + tloris) —
     Lightspeed »server ownership badges«: ekipa vidi, ČIGAVA je miza.
     Prazno ime (naročilo brez natakarja) → iskreno nič, ne »?«. */
  const tileWaiterInitials = (tb: TableT): string | null => {
    const n = tb.activeOrder?.waiterName?.trim()
    if (!n) return null
    const parts = n.split(/\s+/).filter(Boolean)
    return (parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : n.slice(0, 2)).toUpperCase()
  }
  /* QA-val v1.220.0: gost s čakalne liste na ploščici (SAMO brez naročila —
     z activeOrder ploščica že kaže naročilo). Handheld/tablica kažeta samo status. */
  const seatedGuestL = (tb: TableT): string | null => (!tb.activeOrder && tb.seatedGuest ? `${tb.seatedGuest.guestName} · ${tb.seatedGuest.party}` : null)

  /** Zadrži: odpre dialog z neobveznim razlogom (posnetek gre v revizijo ORDER_HOLD) */
  function holdOrder(o: OrderT) { setHoldTargetReason(''); setHoldTarget(o) }

  /** Potrditev zadržanja: POST /hold → naročilo izgine iz aktivnega toka, ostane vidno
      pod filtrom HOLD z gumbom Nadaljuj (edina pot ven iz zadržanega). */
  async function holdOrderConfirm() {
    if (!holdTarget) return
    setMmvBusy(true)
    try {
      await api(`/api/orders/${holdTarget.id}/hold`, { method: 'POST', body: JSON.stringify({ reason: holdTargetReason || undefined }) })
      setHoldTarget(null); setHoldTargetReason('')
      await load()
      toast({ title: t('order.holdDone') })
    } catch (err) {
      toast({ title: t('common.error'), description: (err as Error).message, variant: 'destructive' })
    } finally { setMmvBusy(false) }
  }

  /** Nadaljuj: POST /resume (hold → open) — naročilo je spet polno mutabilno. */
  async function resumeOrder(o: OrderT) {
    setMmvBusy(true)
    try {
      await api(`/api/orders/${o.id}/resume`, { method: 'POST' })
      await load()
      toast({ title: t('order.resumeDone') })
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
    const res = await printLines(`Naročilo #${o.orderNumber ?? '?'}`, buildKitchenTicketLines({
      orderNumber: o.orderNumber ?? undefined,
      tableName: o.table?.name || null,
      type: o.type,
      employeeName: o.employee?.name || null,
      items: o.items.map((it) => ({ name: it.name, qty: it.qty, note: it.note, station: it.station, allergenWarning: it.allergenWarning || '', allergenCodes: it.allergenCodes || [], modifiers: it.modifiers ?? [], seat: it.seat ?? null })),
    }, station))
    if (!res.ok) toast({ title: t('print.failed', { error: res.error ?? '' }), variant: 'destructive' })
    else if (res.simulated) toast(station === 'BAR' ? { title: t('print.simBar') } : { title: t('print.simKitchen') })
  }

  async function toggleAvailable(m: MenuT) {
    await api(`/api/menus/${m.id}`, { method: 'PATCH', body: JSON.stringify({ available: !m.available }) })
    await load()
  }

  /** Issue #96 (QA P1): izbor lokacije nove rezervacije. Centralna vloga brez
   *  dodeljene lokacije (demo račun, novi upravitelji) prej ni imela KAKO
   *  poslati locationId — POST je padel s 400 po oddaji. Vir: locStats (glava,
   *  centralne vloge) z lokalist fallbackom; lokalnim vlogam strežnik lokacijo
   *  prepiše z user.loc, zato izbirnika sploh ne potrebujejo. */
  const resvLocationChoices: { id: string; name: string }[] = locStats.length > 0
    ? locStats.map((l) => ({ id: l.id, name: l.name }))
    : locList.map((l) => ({ id: l.id, name: l.name }))
  const resvNeedsLocation = isCentralUIRole(user?.role) && !user?.locationId
  const resvLocationMissing = resvNeedsLocation && resvLocationChoices.length > 1
    && !(newRes?.locationId || viewLoc)

  /* v1.231.0 — SAMODEJNA DODELITEV MIZE (OpenTable/Toast vzorec; PRIMERJAVA-
     VMESNIKOV-2026 §4 C-seznam): izberi NAJMANJŠO prosto mizo, ki ustreza
     številu oseb, brez prekrivanja z drugo AKTIVNO rezervacijo (CONFIRMED/
     SEATED/COMPLETED zavirajo; CANCELLED/NO_SHOW ne). Časovno okno = datum +
     trajanje rezervacije. Klient ima vse podatke že naložene (mize + rezervacije
     z tableId/duration iz /api/reservations) — čista posodobitev obrazca, brez
     novih backend poti. Strežnik ob oddaji še vedno varuje unikat
     (@@unique [tableId, dateTime]) — to je pomoč pri izbiri, ne obveza.
     v1.245.0 (§19): iskanje teče skozi seatCandidatesForParty (skupni čisti
     helper z lib/testi) — enojne mize + REGISTRIRANE KOMBINACIJE (družba,
     večja od največje mize → Miza 5+6); zasedene so tudi ČLANICE kombinacijskih
     rezervacij (r.tableIds). */
  function autoAssignTable() {
    if (!newRes) return
    if (!newRes.reservedAt) { toast({ title: t('resv.autoAssignNeedTime'), variant: 'destructive' }); return }
    const start = new Date(newRes.reservedAt).getTime()
    if (!Number.isFinite(start)) { toast({ title: t('resv.autoAssignNeedTime'), variant: 'destructive' }); return }
    const durMs = (newRes.duration || 120) * 60_000
    const end = start + durMs
    const dialogLoc = newRes.locationId || viewLoc
    const busyTables = new Set(
      reservations
        .filter((r) => (r.tableId || (r.tableIds?.length ?? 0) > 0) && r.status !== 'CANCELLED' && r.status !== 'NO_SHOW')
        .filter((r) => {
          const s = new Date(r.reservedAt).getTime()
          const e = s + ((r.duration ?? 120) * 60_000)
          return s < end && start < e // prekrivanje oken [s,e) ∩ [start,end)
        })
        .flatMap((r) => ((r.tableIds?.length ?? 0) >= 2 ? r.tableIds! : (r.tableId ? [r.tableId] : []))),
    )
    const candidates = seatCandidatesForParty({
      tables: viewTables, combos: tableCombos, party: newRes.guests,
      busyTableIds: busyTables, locationId: dialogLoc,
    })
    if (candidates.length === 0) {
      toast({ title: t('resv.autoAssignNone', { n: newRes.guests }), variant: 'destructive' })
      return
    }
    const pick = candidates[0]
    // kombinacija se v obrazcu nosi kot 'combo:<id>' (izbira v Selectu + oddaja)
    setNewRes({ ...newRes, tableId: pick.comboId ? `combo:${pick.comboId}` : pick.tableIds[0] })
    if (pick.comboId) toast({ title: t('resv.comboAutoOk', { table: pick.label, seats: pick.seats }) })
    else toast({ title: t('resv.autoAssignOk', { table: pick.label, seats: pick.seats }) })
  }

  async function createReservation(allowOutsideHours = false, forcePacing = false) {
    if (!newRes?.guestName || !newRes.reservedAt) return
    // Issue #96 (QA P1): centralna vloga BREZ dodeljene lokacije MORA izbrati
    // lokacijo v dialogu — sicer strežnik vrne 400 »Lokacija ni določena« ŠELE
    // po oddaji. Preverba PRED pošiljanjem (isti pogoj kot strežniški
    // requireUserLocation za centralne vloge brez user.loc).
    if (resvLocationMissing) {
      toast({ title: t('resv.locationMissing'), variant: 'destructive' })
      return
    }
    setSending(true)
    try {
      // v1.252.0 (§26): ali je osebje IZRECNO izbralo mizo? (izrecna izbira
      // vedno zmaga nad avtododelitvijo; samo v tem primeru strežnik ne izbira)
      const hadExplicitTable = !!newRes.tableId
      const data = await api<{ autoAssignedTable?: string | null }>('/api/reservations', {
        method: 'POST',
        // OPS-8 val 3 (v1.73.0): + tableId/source/customerEmail/duration/specialRequests
        // Issue #96: + locationId (samo centralnim vlogam brez lastne lokacije
        // strežnik sploh pripise telu; lokalnim vlogam ga strežnik prepiše z
        // user.loc — requireUserLocation ne glede na telo)
        body: JSON.stringify({
          guestName: newRes.guestName, phone: newRes.phone, guests: newRes.guests,
          reservedAt: new Date(newRes.reservedAt).toISOString(), note: newRes.note, allowOutsideHours, forcePacing,
          ...(resvNeedsLocation && (newRes.locationId || viewLoc) ? { locationId: newRes.locationId || viewLoc } : {}),
          // v1.252.0: izrecen izklop avtododelitve (checkbox v dialogu —
          // vzorec allowOutsideHours: privzeto VKLOP, izklop je zavedna odločitev)
          ...(newRes.autoTable === false ? { skipAutoAssign: true } : {}),
          // v1.245.0 (§19): kombinacija mize se v obrazcu nosi kot 'combo:<id>' —
          // ob oddaji se razplete v tableIds[] (strežnik preveri vsako članico)
          ...(newRes.tableId?.startsWith('combo:')
            ? (() => { const c = tableCombos.find((x) => x.id === newRes.tableId!.slice(6)); return c ? { tableIds: c.tableIds } : {} })()
            : newRes.tableId ? { tableId: newRes.tableId } : {}),
          source: newRes.source || 'phone',
          ...(newRes.email ? { customerEmail: newRes.email } : {}),
          duration: newRes.duration || 120,
          ...(newRes.specialRequests ? { specialRequests: newRes.specialRequests } : {}),
        }),
      })
      // v1.252.0 (§26): strežniška avtododelitev — iskren odgovor uporabniku
      // (miza NI bila človeška izbira; če je ni bilo mogoče najti, tudi to
      // povej — ne tiho zamolčaj)
      if (!hadExplicitTable && newRes.autoTable !== false) {
        if (data?.autoAssignedTable) {
          toast({ title: t('resv.autoServerOk', { table: data.autoAssignedTable }) })
        } else {
          toast({ title: t('resv.autoServerNone', { n: newRes.guests }) })
        }
      }
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
      // v1.244.0 (§18 A): ritem prihodov presežen → ponudi izrecen pregled
      // (audit RESERVATION_PACING_OVERRIDE — isti potek kot odpiralni čas)
      if (msg.includes('Ritem prihodov')) {
        setSending(false)
        if (confirm(`${msg}\n\n${t('resv.confirmPacing')}`)) {
          await createReservation(false, true)
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
        // §39: nastavitev expo požiga se pošlje SAMO ob spremembi in SAMO
        // ob aktivnem DDL (pre-DDL je preklop v dialogu onemogočen — tu je
        // obramba v globini, da shranjevanje lokacije ostane čisto)
        const expoFireChanged = kdsExpoFireDdlActive && locKdsExpoFire !== (locEditing.kdsExpoFireEnabled === true)
        await api(`/api/locations/${locEditing.id}`, { method: 'PATCH', body: JSON.stringify({
          ...locForm,
          ...(expoFireChanged ? { kdsExpoFireEnabled: locKdsExpoFire } : {}),
        }) })
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

  // OSS-10 B-del (v1.210.0): artikel → obvezne skupine VARIANTE (razred `variant`
  // s strežnika, pripete artikle, ≥1 razpoložljiva opcija) — Map za hitro vprašanje
  // iz ploščic/vrstic POS.
  const variantReqMap = useMemo(() => {
    const map = new Map<string, PosVariantGroupView[]>()
    for (const g of variantGroups) {
      // ISTA merila kot requiredVariantGroupsForItem (razred + ≥1 razpoložljiva
      // opcija); povezava artikel↔skupina se razpne po posameznem id-ju spodaj.
      if (!g || !g.variant || !Array.isArray(g.linkedMenuItemIds) || !Array.isArray(g.modifiers) || !g.modifiers.some((m) => m?.isAvailable)) continue
      for (const id of g.linkedMenuItemIds) {
        const list = map.get(id) || []
        list.push(g)
        map.set(id, list)
      }
    }
    return map
  }, [variantGroups])
  /** Skupna vstopna točka »dodaj artikel« za vse tri košarice POS: artikel z
   *  obvezno varianto PRVÉ odpre izbiro (brez izbire bi strežnik vrnil 400),
   *  prosti artikel gre direktno v košarico (obnašanje nespremenjeno). */
  function posAddClick(mode: 'cart' | 'sale' | 'sheet', mi: MenuT) {
    if (!mi.available) return
    if ((variantReqMap.get(mi.id)?.length ?? 0) > 0) { setVariantPick({ mode, item: mi, selections: {} }); return }
    if (mode === 'cart') setCart((c) => ({ ...c, [mi.id]: (c[mi.id] || 0) + 1 }))
    else if (mode === 'sale') setSaleCart((c) => ({ ...c, [mi.id]: (c[mi.id] || 0) + 1 }))
    else setSheetCart((c) => ({ ...c, [mi.id]: (c[mi.id] || 0) + 1 }))
  }
  const variantPickGroups = variantPick ? (variantReqMap.get(variantPick.item.id) || []) : []
  const variantPickComplete = !!variantPick && variantPickGroups.every((g) => !!variantPick.selections[g.id] && g.modifiers.some((m) => m.id === variantPick.selections[g.id] && m.isAvailable))
  function confirmVariantPick() {
    if (!variantPick || !variantPickComplete) return
    const { mode, item, selections } = variantPick
    const ids: string[] = []
    const names: string[] = []
    let surcharge = 0
    for (const g of variantPickGroups) {
      const opt = g.modifiers.find((m) => m.id === selections[g.id])
      if (opt) { ids.push(opt.id); names.push(opt.name); surcharge += opt.price }
    }
    const line = { menuItemId: item.id, modifierIds: ids, optionNames: names, optionPrice: surcharge }
    if (mode === 'cart') setCartVariants((p) => addPosVariantLine(p, line))
    else if (mode === 'sale') setSaleVariants((p) => addPosVariantLine(p, line))
    else setSheetVariants((p) => addPosVariantLine(p, line))
    setVariantPick(null)
  }

  // OSS-10 B-del: skupni zneski vključujejo doplačila variant (osnova + opcija × količina)
  const variantBasePriceOf = (menuItemId: string) => menu.find((m) => m.id === menuItemId)?.price || 0
  const cartTotal = Object.entries(cart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)
    + posVariantLinesTotal(cartVariants, variantBasePriceOf)
  // OPS-7: košarica urejevalnika naročila (NaročiloSheet)
  const sheetCartTotal = Object.entries(sheetCart).reduce((s, [id, qty]) => s + (menu.find((m) => m.id === id)?.price || 0) * qty, 0)
    + posVariantLinesTotal(sheetVariants, variantBasePriceOf)
  // OSS-10 B-del: »ima vsebino« = navadne postavke ALI vrstice variant (sedežna vrstica + gumb Pošlji)
  const sheetHasItems = Object.values(sheetCart).some((q) => q > 0) || sheetVariants.some((l) => l.qty > 0)

  // Issue #3: POS → customer display — trenutna transakcija v realnem času (debounce 800 ms)
  useEffect(() => {
    if (!newOrderTable) return
    const t = setTimeout(() => {
      // OSS-10 B-del: vrstice variant na zaslonu gosta — sestavljeno ime (»Pizza · 0,5 L«)
      // + doplačilo v ceni vrstice (isti izračun kot naročilo)
      const lines = [
        ...Object.entries(cart).map(([id, qty]) => {
          const m = menu.find((x) => x.id === id)
          const price = (m?.price || 0) * qty
          return { name: m?.name || id, qty, price, vatRate: Number(m?.vatRate) || 22 }
        }),
        ...cartVariants.map((l) => {
          const m = menu.find((x) => x.id === l.menuItemId)
          const price = ((m?.price || 0) + l.optionPrice) * l.qty
          return { name: orderItemDisplayName(m?.name || '', l.optionNames), qty: l.qty, price, vatRate: Number(m?.vatRate) || 22 }
        }),
      ]
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
  }, [cart, cartVariants, newOrderTable, menu, pushDisplay])

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
  // v1.232.0 P3 popravek: primerjava je zdaj na UI obliki statusa ('CONFIRMED' —
  // mapReservation preslika DB 'confirmed' v velike črke); prej je mirror gledal
  // maločrkovno DB vrednost, ki je klient NIKOLI ni videl → števec v potrditvenem
  // dialogu je bil vedno 0 (strežnik je ob kliku vseeno poslal pravilno).
  const reminderCandidates = reservations.filter((r) => {
    if (r.reminderSent || r.status !== 'CONFIRMED') return false
    const start = new Date(r.reservedAt).getTime()
    const now = Date.now()
    return start >= now && start <= now + 24 * 3600 * 1000
  })
  /* v1.232.0 (PRIMERJAVA §4, Toast/TouchBistro »reservations on floor plan«) —
     OVERLAY REZERVACIJ NA TLORISU: naslednja PRIHODNJA potrdjena rezervacija po
     mizi (ura · gostje · ime). Čista klient agregacija že naloženih podatkov
     (reservations imajo tableId od OPS-8) — 0 novih backend poti. Vlogam brez
     reservations.manage seznama rezervacij API ne vrne (soft 403) → overlay
     iskreno izostane. Zasedena miza s prihajajočo rezervacijo je prav tako
     pomemben signal (miza se mora obrniti do ure) — overlay kažemo na VSEH
     mizah, ne samo prostih. */
  const nextResvByTable = useMemo(() => {
    const now = Date.now()
    const m = new Map<string, ReservationT>()
    for (const r of reservations) {
      if (r.status !== 'CONFIRMED' || !r.tableId) continue
      const at = new Date(r.reservedAt).getTime()
      if (!Number.isFinite(at) || at < now) continue
      // v1.245.0 (§19): kombinacijska rezervacija obljublja VSE članice —
      // overlay na vsaki ploščici (miza se mora obrniti do te ure)
      const ids: string[] = (r.tableIds?.length ?? 0) >= 2 ? r.tableIds! : (r.tableId ? [r.tableId] : [])
      for (const tid of ids) {
        const cur = m.get(tid)
        if (!cur || at < new Date(cur.reservedAt).getTime()) m.set(tid, r)
      }
    }
    return m
  }, [reservations])
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
  // v1.244.0 (§18 B): ZAKLEP ZASLONA KDS (view-only) — per naprava (localStorage),
  // privzeto IZKLOPLJENO. Zaščita pred pomotičnimi bumpi (Lightspeed »Lock prep
  // station displays« nov 2026): vrstice nedejavne, izdaja blokirana; strežnik
  // ostaja avtoritativa (presentacijska plast, ne varnostna).
  const [kdsViewOnly, setKdsViewOnly] = useState(false)
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
  const [kdsDensity, setKdsDensity] = useState<KdsDensityT>('compact')
  const [kdsColumns, setKdsColumns] = useState<KdsColumnsT>(6)
  const [kdsView, setKdsView] = useState<'columns' | 'list'>('columns')
  useEffect(() => {
    // mikrotaska — obnova KDS nastavitev iz localStorage brez sinhronnega setState
    // v telesu efekta (hidracija: SSR izriše privzete, kot prej)
    queueMicrotask(() => {
      try {
        /* §41 (v1.267.0): snapshot SVEŽE NAPRAVE — obrezena/zamenjana tablica nima
           NOBENEGA ro_kds_* ključa; samo takšni zasloni samodejno obnovijo strežniški
           profil postaje ob izbiri (naprava z lastnimi nastavitvami jih NE preglasi). */
        kdsProfileFreshRef.current = !KDS_PROFILE_LS_KEYS.some((k) => localStorage.getItem(k) !== null)
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
        if (localStorage.getItem('ro_kds_view_only') === '1') setKdsViewOnly(true)
      } catch { /* zasebni način — privzete vrednosti ostanejo */ }
    })
  }, [])
  /** V-3: takojšen učinek + persist (ob obnovitvi zaslona se pragovi spomnijo). */
  const kdsSaveAgeThresholds = (th: KdsAgeThresholds) => {
    const norm = normalizeKdsAgeThresholds(th)
    setKdsAgeTh(norm); setKdsAgeDraft(norm)
    kdsUserTouchedRef.current = true // §41: ročna sprememba izklopi samodejno obnovo
    try { localStorage.setItem(KDS_AGE_THRESHOLD_LS_KEY, JSON.stringify(norm)) } catch { /* brez shramve — velja do osvežitve */ }
    toast({ title: t('kds.settingsSaved') })
  }
  /** V-8/V-9: persist pomočnik za preproste izbire. */
  const kdsPersist = (key: string, value: string) => {
    kdsUserTouchedRef.current = true // §41: ročna sprememba izklopi samodejno obnovo (vsi preklopniki: pisava/gostota/stolpci/pogled/zaklep/vrstni red)
    try { localStorage.setItem(key, value) } catch { /* brez shramve */ }
  }
  /* ── §38 (v1.264.0, Square Vol 16 »Draggable ticket reordering on KDS«):
     ROČNO ZAPOREDJE LISTKOV. Način vrstnega reda je PER NAPRAVA
     (ro_kds_ticket_order — Issue #74 družina, hidracija v mikrotaski);
     ročna mesta pa so STREŽNIŠKA (mapa aktivnih listkov + DDL zastavica iz
     GET /api/kitchen; pre-DDL → prazna mapa → vrsta enaka default, vlečenje
     onemogočeno z nasvetom — migrBox vzorec v1.197/§37). Zaklep zaslona
     (viewOnly, §18 B) blokira tudi reorder — dosledno z bumpi. ── */
  const [kdsTicketOrder, setKdsTicketOrder] = useState<'default' | 'manual'>('default')
  const [kdsSequences, setKdsSequences] = useState<Record<string, number>>({})
  const [kdsSeqDdlActive, setKdsSeqDdlActive] = useState(false)
  /* §39 (v1.265.0, Square Vol 16 »Fire held courses from an Expo KDS«):
     EXPO POŽIG ZADRŽANIH TEČAJS — dvotapna potrditev z ODŠTEVANJEM na glavah
     pending tečajev ŽIVIH listkov (ne osnutki §32, ne zastareli #70, ne viewOnly
     §18 B). Prvi tap glavo OBOROŽI (3 s jantrobno odštevanje), drugi tap
     PREKLIČE, potek pa pošlje POST /api/orders/[id]/fire {courseId} (dvojna
     avtorizacija na strežniku: orders.create ALI kitchen.update + nastavitev
     lokacije). Arm je enočasno SAMO EN (zamenjava tečaja preklopi cilj). */
  const [kdsFireArm, setKdsFireArm] = useState<{ orderId: string; courseId: string; label: string; until: number } | null>(null)
  /* OBOROŽEN tečaj velja samo, dokler je ŠE pending (izpeljano ob vsakem
     renderu — druga naprava ali natakar v POS ga lahko požge med odštevanjem;
     takrat arm UMRÉ: interval se počisti, potek NE kliče fire → brez 409.
     Izpeljava namesto efekta + setState — react-hooks/set-state-in-effect;
     raw stanje zamenja naslednji tap ali potek). */
  const kdsFireArmLive = (() => {
    if (!kdsFireArm) return null
    const o = kitchen.find((x) => x.id === kdsFireArm.orderId)
    const c = o?.courses?.find((x) => x.id === kdsFireArm.courseId)
    if (!o || !c || c.status !== 'pending') return null
    return kdsFireArm
  })()
  /* ── §41 (v1.267.0, Lightspeed julij 2026 »Restore KDS stations in
     seconds«): STREŽNIŠKI PROFIL KDS POSTAJE. Nastavitve zaslona ostanejo
     PER NAPRAVA (localStorage, Issue #74 družina) — profil jih prinese nazaj
     na obrezano/zamenjano tablico: SVEŽA naprava (noben ro_kds_* ključ) ob
     izbiri postaje SAMODEJNO aplicira zadnji shranjen profil te postaje;
     naprava, na kateri je uporabnik karkoli spremenil (kdsUserTouchedRef),
     samodejne obnove NE dobi — njegova izbira vedno zmaga. Ročna pot je
     vedno na voljo: gumb v nastavitvah KDS (Shrani/Obnovi profil postaje).
     NOSILEC: Integration vrstica kds-station-profile PER LOKACIJA (0 DDL,
     vzorec resv-pacing §18 A); API /api/kitchen/profile (kitchen.update). ── */
  const [kdsProfiles, setKdsProfiles] = useState<Record<string, KdsStationProfile>>({})
  const kdsProfileFreshRef = useRef(true)
  const kdsUserTouchedRef = useRef(false)
  const kdsAutoRestoredRef = useRef<Set<string>>(new Set())
  const [kdsProfileBusy, setKdsProfileBusy] = useState(false)
  /** §41: aplicira profil na VSE KDS prikaze + zapiše localStorage (ista
      ključ kot hidracija — po obnovitvi ni več »sveža naprava«). NE gre
      skozi kdsPersist (obnova NI uporabniška sprememba — ne postavi touched). */
  const applyKdsProfile = useCallback((p: KdsStationProfile, msgKey: 'kds.profileRestored' | 'kds.profileAuto') => {
    setKdsFontSize(p.fontSize); setKdsDensity(p.density); setKdsColumns(p.columns)
    setKdsView(p.view); setKdsViewOnly(p.viewOnly); setKdsTicketOrder(p.ticketOrder)
    setKdsAgeTh(p.ageThresholds); setKdsAgeDraft(p.ageThresholds)
    try {
      localStorage.setItem('ro_kds_font_size', p.fontSize)
      localStorage.setItem('ro_kds_density', p.density)
      localStorage.setItem('ro_kds_columns', String(p.columns))
      localStorage.setItem('ro_kds_view', p.view)
      localStorage.setItem('ro_kds_view_only', p.viewOnly ? '1' : '0')
      localStorage.setItem('ro_kds_ticket_order', p.ticketOrder)
      localStorage.setItem(KDS_AGE_THRESHOLD_LS_KEY, JSON.stringify(p.ageThresholds))
    } catch { /* zasebni način — velja do osvežitve */ }
    toast({ title: t(msgKey) })
  }, [t])
  /** §41: nalozže profile lokacije (enkrat — ko so pravice znane; kitchen.update
      je ista vrata kot KDS zaslon). Napaka = tiho: brez profilov KDS deluje naprej. */
  useEffect(() => {
    if (!perms.length) return
    const { canManage: mg, perms: pm } = gateRef.current
    if (!mg && !pm.includes('kitchen.update')) return
    let cancelled = false
    void (async () => {
      try {
        // E2E najdba #1: GLOBALNA vrstica (vzorec auto86) — KDS zaslon teče v
        // org-obsegu, profil je lastnost postaje/zaslona, ne lokacije.
        const res = await api<{ profiles?: Record<string, KdsStationProfile> }>('/api/kitchen/profile')
        if (!cancelled && res?.profiles) setKdsProfiles(res.profiles)
      } catch { /* 403/omrežje — KDS brez profilov deluje naprej */ }
    })()
    return () => { cancelled = true }
  }, [perms])
  /** §41: SAMODEJNA OBNOVA — sveža naprava + izbrana postaja ima shranjen
      profil (in ga ta seansa še ni že aplicirala) → apliciraj. Uporabniške
      spremembe (touched) izklopijo obnovo za CELO seanso — predvidljivo. */
  useEffect(() => {
    if (!kdsProfileFreshRef.current || kdsUserTouchedRef.current) return
    if (kdsAutoRestoredRef.current.has(kdsStation)) return
    const p = kdsProfiles[kdsStation]
    if (!p) return
    kdsAutoRestoredRef.current.add(kdsStation)
    // mikrotaska — aplikacija profila BREZ sinhronnega setState v telesu efekta
    // (isti vzorec kot hidracijska mikrotakta Issue #74; react-hooks/
    // set-state-in-effect — CI lint najdba, lokalni OOM je zakril datoteko)
    queueMicrotask(() => applyKdsProfile(p, 'kds.profileAuto'))
  }, [kdsStation, kdsProfiles, applyKdsProfile])
  /** §41: shrani trenutne nastavitve zaslona kot profil IZBRANE postaje. */
  const saveKdsStationProfile = useCallback(async () => {
    if (kdsProfileBusy) return
    setKdsProfileBusy(true)
    try {
      const profile: KdsStationProfile = {
        fontSize: kdsFontSize, density: kdsDensity, columns: kdsColumns, view: kdsView,
        viewOnly: kdsViewOnly, ageThresholds: kdsAgeTh, ticketOrder: kdsTicketOrder,
        savedAt: new Date().toISOString(), savedBy: '',
      }
      const res = await api<{ profiles?: Record<string, KdsStationProfile> }>('/api/kitchen/profile', {
        method: 'PUT',
        body: JSON.stringify({ station: kdsStationRef.current, profile }),
      })
      if (res?.profiles) setKdsProfiles(res.profiles)
      toast({ title: t('kds.profileSaved') })
    } catch {
      toast({ title: t('common.error'), description: t('kds.profileSaveFail') })
    } finally {
      setKdsProfileBusy(false)
    }
  }, [kdsProfileBusy, kdsFontSize, kdsDensity, kdsColumns, kdsView, kdsViewOnly, kdsAgeTh, kdsTicketOrder, t])
  /** §41: ročna obnova — izrecna izbira uporabnika (ne glede na touched). */
  const restoreKdsStationProfile = useCallback(() => {
    const p = kdsProfiles[kdsStationRef.current]
    if (p) applyKdsProfile(p, 'kds.profileRestored')
  }, [kdsProfiles, applyKdsProfile])
  /* risalni tick odštevanja (250 ms) — preostanek se izračuna ob vsakem renderu */
  const [, setKdsFireTick] = useState(0)
  useEffect(() => {
    if (!kdsFireArmLive) return
    const iv = setInterval(() => {
      if (Date.now() >= kdsFireArmLive.until) {
        const { orderId, courseId, label } = kdsFireArmLive
        setKdsFireArm(null)
        void kdsFireCourseRef.current(orderId, courseId, label)
      } else {
        setKdsFireTick((x) => (x + 1) % 1000000)
      }
    }, KDS_EXPO_FIRE_TICK_MS)
    return () => clearInterval(iv)
  }, [kdsFireArmLive])
  useEffect(() => {
    // mikrotaska — obnova iz localStorage brez sinhronnega setState v telesu efekta
    queueMicrotask(() => {
      try {
        const m = localStorage.getItem('ro_kds_ticket_order')
        if (m === 'manual') setKdsTicketOrder('manual')
      } catch { /* zasebni način — privzeti default ostane */ }
    })
  }, [])
  const kdsTicketDragAllowed = !kdsViewOnly && kdsSeqDdlActive
  /** Optimistični persist novega vrstnega reda (napaka → toast + resnica s strežnika). */
  const kdsPersistTicketOrder = async (newIds: string[]) => {
    const next: Record<string, number> = {}
    newIds.forEach((id, i) => { next[id] = i })
    setKdsSequences(next)
    try {
      await api('/api/kitchen', { method: 'PATCH', body: JSON.stringify({ reorder: newIds }) })
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
      void load('hot')
    }
  }
  /** Premik listka za eno mesto (tipki ↑/↓ — tipkovnica/dotik alternativa vlečenju). */
  const kdsTicketMove = (ids: string[], id: string, dir: -1 | 1) => {
    if (!kdsTicketDragAllowed) return
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    next.splice(j, 0, next.splice(i, 1)[0])
    void kdsPersistTicketOrder(next)
  }
  /* §39 (v1.265.0): IZVEDBA EXPO POŽIGA — potek odštevanja pošlje POST fire
     {courseId} (isti jedrni klic kot POS pot — fireOrderCore pod kapo). Toast
     potrdi (število kosov) ali pokaže strežniško resnico (409 že poslan /
     403 izklopljena nastavitev / mreža); sledi svež load() — vrsta, tečaji in
     postaje se osvežijo iz enega vira resnice (ref: countdown effect teče
     nad stale closure — zato ref na svežo funkcijo). */
  const kdsFireCourse = async (orderId: string, courseId: string, label: string) => {
    try {
      const d = await api<{ firedCount: number }>(`/api/orders/${orderId}/fire`, { method: 'POST', body: JSON.stringify({ courseId }) })
      toast({ description: t('kds.expoFireDone', { name: label, n: d.firedCount }) })
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      void load('hot')
    }
  }
  const kdsFireCourseRef = useRef(kdsFireCourse)
  useEffect(() => { kdsFireCourseRef.current = kdsFireCourse })
  /* Vlečenje POIINTER dogodki (miška + dotik — HTML5 draggable na tablicah
     NE deluje; tloris OPS-4 v1.67 vzorec: ročaj → window move/up → drop).
     State je SAMO za izris (zarisani listek + drop indikator); odločitve
     ob spustu berejo ref-e (brez zaprtja nad stale state). */
  const [kdsDragUi, setKdsDragUi] = useState<{ id: string; dropIndex: number | null } | null>(null)
  const kdsDragStartYRef = useRef(0)
  const kdsDragIdRef = useRef<string | null>(null)
  const kdsDropIndexRef = useRef<number | null>(null)
  const kdsComputeDropIndex = (y: number): number | null => {
    if (typeof document === 'undefined') return null
    const wrap = document.querySelector('[data-region="kds-active-list"]')
    if (!wrap) return null
    const els = Array.from(wrap.querySelectorAll('[data-order-id]'))
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) return i
    }
    return els.length
  }
  const kdsTicketPointerDown = (e: React.PointerEvent, id: string, ids: string[]) => {
    if (!kdsTicketDragAllowed) return
    e.preventDefault()
    kdsDragStartYRef.current = e.clientY
    kdsDragIdRef.current = null
    kdsDropIndexRef.current = null
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - kdsDragStartYRef.current) > 8) {
        kdsDragIdRef.current = id
        const di = kdsComputeDropIndex(ev.clientY)
        kdsDropIndexRef.current = di
        setKdsDragUi({ id, dropIndex: di })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const did = kdsDragIdRef.current
      const di = kdsDropIndexRef.current
      kdsDragIdRef.current = null
      kdsDropIndexRef.current = null
      setKdsDragUi(null)
      if (!did || di === null) return
      // vstavi PRED di-ti element (kot viden med vlečenjem); konec → push
      const targetEl = ids[di]
      const rest = ids.filter((x) => x !== did)
      const at = targetEl && targetEl !== did ? Math.max(0, rest.indexOf(targetEl)) : rest.length
      const next = [...rest]
      next.splice(at, 0, did)
      if (next.join('|') !== ids.join('|')) void kdsPersistTicketOrder(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
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
  // v1.258.0 (PRIMERJAVA §32, Square Vol 13 »KDS draft tickets«): OSNUTKI — ločen
  // zložljiv oddelek, privzeto ZLOŽEN (vidne pilule VRSTE v1.233.0, ničelna regresija
  // gostote); razpenjanje razkrije polne osnutek listke (Square predogled).
  const [kdsDraftsOpen, setKdsDraftsOpen] = useState(false)
  // Issue #71 audit-23: zgoščene postavke naročil — razširjeni seznami po id-ju
  const [expandedOrderItems, setExpandedOrderItems] = useState<Record<string, boolean>>({})
  // Issue #71 audit-18: potrditveno okno za množične opomnike (neponovljivo dejanje)
  const [reminderConfirmOpen, setReminderConfirmOpen] = useState(false)
  // OPS-9 val 3 (v1.76.0): delay-reason dialog — opens when a LATE item (>10 min) is bumped
  const [delayAsk, setDelayAsk] = useState<{ itemId: string; name: string; min: number } | null>(null)
  // Issue #7 (P1, v1.104.0): alergenski dialog (meni tab → potrditev/popravek profila)
  const [allergenDlg, setAllergenDlg] = useState<{ id: string; name: string } | null>(null)
  const allergenLocale: AllergenLocale = locale === 'hr' ? 'hr' : locale === 'en' ? 'en' : locale === 'de' ? 'de' : locale === 'it' ? 'it' : 'sl'
  const allergenLbl = (code: string) =>
    (ALLERGEN_CODES as readonly string[]).includes(code) ? allergenLabel(code, allergenLocale) : code
  const [saleCart, setSaleCart] = useState<Record<string, number>>({})
  /* v1.141.0 (Toast benchmark): način prikaza mreže — 'cards' (foto
     kartice, 1–2 na ekran) ali 'compact' (gost tekstovni grid, 12–20 ploščic
     hkrati, barvno kodirana kategorija) — persist v localStorage. */
  const [saleView, setSaleView] = useState<'cards' | 'compact'>('cards')
  useEffect(() => {
    // mikrotaska — obnova iz localStorage brez sinhronnega setState v telesu efekta
    queueMicrotask(() => {
      try {
        const v = localStorage.getItem('ro_sale_view')
        if (v === 'cards' || v === 'compact') setSaleView(v)
      } catch { /* zasebni način */ }
    })
  }, [])
  const saleViewSet = (v: 'cards' | 'compact') => {
    setSaleView(v)
    try { localStorage.setItem('ro_sale_view', v) } catch { /* brez shramve */ }
  }
  /* v1.257.0 (PRIMERJAVA-VMESNIKOV-2026 §31, Square Vol 15 oktober 2026
     »Choose the cart's side of the checkout screen«): stran košare na
     prodaji — per-naprava izbira LEVO/DESP. Naša lastna zgodovina je bila
     razprava benchmarkov (v1.127 desno po Square → v1.141 levo po Toast
     »left rail«); Vol 15 jo razreši odločitvijo NAPRAVE, ne sistema:
     levo = desničarjem lažji dostop do mreže, desno = levičarjem.
     Privzeto 'left' ohranja v1.141 status quo; persist po vzorcu
     ro_sale_view (queueMicrotask restore + validacija vrednosti). */
  const [saleCartSide, setSaleCartSide] = useState<'left' | 'right'>('left')
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const v = localStorage.getItem('ro_sale_cart_side')
        if (v === 'left' || v === 'right') setSaleCartSide(v)
      } catch { /* zasebni način */ }
    })
  }, [])
  const saleCartSideSet = (v: 'left' | 'right') => {
    setSaleCartSide(v)
    try { localStorage.setItem('ro_sale_cart_side', v) } catch { /* brez shramve */ }
  }
  /* v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §1–2, Toast/Clover benchmark): PRILJUBLJENO ★ —
     per-naprava persist (ro_sale_favs); zvezdica v pogledu KARTICE (kompaktni grid je
     premajhen za še en gumb — upravljanje ★ je v karticah, FILTER ★ deluje povsod). */
  const [saleFavs, setSaleFavs] = useState<string[]>([])
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const v = JSON.parse(localStorage.getItem('ro_sale_favs') || '[]')
        if (Array.isArray(v)) setSaleFavs(v.filter((x): x is string => typeof x === 'string').slice(0, 60))
      } catch { /* zasebni način */ }
    })
  }, [])
  const saleFavToggle = (id: string) => {
    setSaleFavs((pr) => {
      const nx = pr.includes(id) ? pr.filter((x) => x !== id) : [...pr, id].slice(0, 60)
      try { localStorage.setItem('ro_sale_favs', JSON.stringify(nx)) } catch { /* brez shramve */ }
      return nx
    })
  }
  /* v1.229.0: AUTO popusti (Happy Hour) za ⚡ znak na ploščicah
     vstopu v zavihek prodaja (max 1× na 5 min; plačilni dialog si jih že prinese svojih).
     KANONIČNI obračun ostaja v billing.ts / computeBill — tukaj je SAMO prikaz. */
  const [autoDiscounts, setAutoDiscounts] = useState<DiscountT[]>([])
  const autoDiscAtRef = useRef(0)
  useEffect(() => {
    if (activeTab !== 'prodaja') return
    if (Date.now() - autoDiscAtRef.current < 300_000) return
    autoDiscAtRef.current = Date.now()
    void api<{ discounts: DiscountT[] }>('/api/discounts')
      .then((ds) => setAutoDiscounts((ds.discounts || []).filter((d) => d.triggerType === 'auto' && d.isActive)))
      .catch(() => undefined)
  }, [activeTab])
  // urni tiktak: ⚡ okno se preklopi na polno uro — brez tiktaka bi znak obstal do naslednjega renderja
  const [hhNow, setHhNow] = useState(() => new Date())
  useEffect(() => {
    const iv = setInterval(() => setHhNow(new Date()), 60_000)
    return () => clearInterval(iv)
  }, [])
  /** Aktivni Happy Hour za artikel (ali null): veljavno okno + pokritost kategorije.
      Prikazna akcijska cena = ista formula kot discountAmountOf na ENOTI (percent % od
      cene / fiksni znesek) — račun izračuna strežnik kanonično; ta vrednost je vizualni
      namig »koliko bo na računu«. */
  const hhOf = (mi: MenuT): { price: number; name: string } | null => {
    for (const d of autoDiscounts) {
      if (!isHappyActive(d, hhNow)) continue
      if (d.validFrom && new Date(d.validFrom) > hhNow) continue
      if (d.validTo && new Date(d.validTo) < hhNow) continue
      const cats = (d.targetCategoryIds || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (cats.length > 0 && (!mi.categoryId || !cats.includes(mi.categoryId))) continue
      const amt = (d.type === 'percent' || d.type === 'percentage') ? mi.price * (Number(d.amount) / 100) : Number(d.amount)
      const price = Math.max(0, Math.round((mi.price - amt) * 100) / 100)
      if (price >= mi.price) continue
      return { price, name: d.name }
    }
    return null
  }
  // Issue #71 audit-32: privzeta izbira = PRAVA KATEGORIJA (ne »Vse« — 436 ploščic naenkrat
  // redči mrežo in zatika drsenje na tablici). Uporabnikov izbor vedno premaga privzeto.
  const [saleCat, setSaleCat] = useState('ALL')
  const saleCatTouched = useRef(false)
  useEffect(() => {
    if (saleCatTouched.current || saleCat !== 'ALL' || categories.length === 0) return
    /* v1.141.0 (Toast vzorec): privzeta kategorija = NAJBOLJ POLNA (z največ
       razpoložljivimi artikli), ne slučajno prva po sortOrder — natakar začne
       takoj v delovni kategoriji (pijače/vroče jedi), ne v prazni robinji. */
    let best = categories[0]
    let bestN = -1
    for (const c of categories) {
      const n = menu.filter((mi) => mi.categoryId === c.id && mi.available).length
      if (n > bestN) { bestN = n; best = c }
    }
    if (bestN > 0) setSaleCat(best.id)
  }, [categories, saleCat, menu])
  const [saleSearch, setSaleSearch] = useState('')
  /* v1.229.0 (§1, PRIMERJAVA-VMESNIKOV-2026): EAN ČITALNIK — scanner je tipkovnica, ki
     konča z Enter. Če je vnos ČISTO številski (4–14 znakov), gre po poti iskanja po
     črtti kodi (GET /api/menus?ean= — InventoryItem.ean → povezani meni artikel OSS-9);
     zadetek = dodaj v košaro + počisti polje, nezadetek = opozorilo. Besedne poizvedbe
     (vsebujejo črke) se NE sprožijo — iskanje po imenu ostane nespremenjeno. */
  const saleEanSubmittingRef = useRef(false)
  const saleEanSubmit = async (): Promise<void> => {
    const code = saleSearch.trim()
    if (!/^\d{4,14}$/.test(code)) return
    if (saleEanSubmittingRef.current) return
    saleEanSubmittingRef.current = true
    try {
      const d = await api<{ eanItem: MenuT | null }>(`/api/menus?ean=${encodeURIComponent(code)}`)
      if (d.eanItem) {
        posAddClick('sale', d.eanItem)
        setSaleSearch('')
        toast({ title: t('sale.eanAdded', { name: d.eanItem.name }) })
      } else {
        toast({ title: t('sale.eanUnknown'), variant: 'destructive' })
      }
    } catch {
      /* omrežje — tiho: iskanje po imenu še vedno deluje */
    } finally {
      saleEanSubmittingRef.current = false
    }
  }
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

  /* v1.258.0 (PRIMERJAVA §32, Square Vol 13 »KDS draft tickets«): OSNUTEK predikat
     (isti kot VRSTA v1.233.0, per pogled postaje) + množica id-jev na ravni komponente —
     DELJENA med odsekom OSNUTKOV, aktivno vrsto, praznim stanjem in all-day vrstico
     (en vir resnice). Zastareli osnutki izpadejo iz množice (ostanejo v ZASTARELO
     revizijski veji). Požig ali zgodnji začetek kuharja listek organično prestavi
     iz OSNUTKOV v aktivno vrsto (predikat se računa ob vsakem izrisu). */
  const kdsIsDraftOrder = (o: (typeof viewKitchen)[number]): boolean => {
    const its = o.items.filter((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
    return its.length > 0 && its.every((it) => it.status === 'PENDING')
  }
  const kdsDraftIdSet = new Set(viewKitchen.filter((o) => kdsIsDraftOrder(o) && !isStaleKdsTicket(kdsMinutes(o.createdAt))).map((o) => o.id))

  // OPS-4 + v1.236.0 (PRIMERJAVA §13, Toast KDS »Flash Changes«): zvok + UTRIP ne samo
  // ob NOVEM listku, temveč tudi ob SPREMEMBI obstoječega (dodatek postavk — Toast:
  // »flash animation to indicate a ticket is new or was changed« + zvok ob spremembi
  // postavk). Diferencialni pogon: SSE pretok / 15 s polling prinese celo vrsto —
  // primerjamo IDENTITETO (id-ji listkov + postavk) s prejšnjim posnetkom:
  //   nov listek   → 880 Hz enojni pisk (obstoječe obnašanje) + amber obroč + NOVO
  //   dodane vrstice na obstoječem listku → 660 Hz dvojni pisk + utrip vrstice + +n
  //   PREKLIC postavke (voidedItems, Toast: voided item ostane prečrtan + alarm)
  //     → 392 Hz trojni pisk + prečrtana vrstica na listku
  // Prvi posnetek in preklop postaje = novo izhodišče (brez lažnega utripanja).
  const kdsPrevPendingRef = useRef(0)
  const kdsSeenRef = useRef<{ tickets: Set<string>; items: Set<string>; voids: Set<string>; station: string | null; primed: boolean }>({ tickets: new Set(), items: new Set(), voids: new Set(), station: null, primed: false })
  const [kdsFlash, setKdsFlash] = useState<{ tickets: Record<string, number>; items: Record<string, number>; voids: Record<string, number> }>({ tickets: {}, items: {}, voids: {} })
  const kdsFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const kdsBeep = (freq: number, ms: number, delayMs = 0) => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.value = freq; gain.gain.value = 0.08
      const at = ctx.currentTime + delayMs / 1000
      osc.start(at)
      setTimeout(() => { try { osc.stop(); void ctx.close() } catch { /* nic kriticnega */ } }, delayMs + ms)
    } catch { /* zvok ni kriticen */ }
  }
  useEffect(() => {
    const seen = kdsSeenRef.current
    if (kdsCustomView) {
      // Issue #14: poimenovana postaja — njen pogled je ODLOŽIŠČE nalog, ne vrsta
      // listkov; zvok ostaja na števcu čakajočih nalog (obstoječa semantika).
      const pending = kdsTasks
        .filter((task) => task.stationId === kdsStation && task.status === 'pending')
        .reduce((s, task) => s + task.quantity, 0)
      if (pending > kdsPrevPendingRef.current && kdsSound) kdsBeep(880, 180)
      kdsPrevPendingRef.current = pending
      return
    }
    // viden posnetek v izbranem vedru (ISTI filter kot izris vrste)
    const vis = viewKitchen.map((o) => ({
      id: o.id,
      items: o.items.filter((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)),
      voids: (o.voidedItems ?? []).filter((it) => kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket),
    }))
    if (!seen.primed || seen.station !== kdsStation) {
      // izhodišče: prvi odčitek ali preklop postaje ne utripa ničesar
      seen.tickets = new Set(vis.map((o) => o.id))
      seen.items = new Set(vis.flatMap((o) => o.items.map((it) => it.id)))
      seen.voids = new Set(vis.flatMap((o) => o.voids.map((it) => it.id)))
      seen.station = kdsStation
      seen.primed = true
      return
    }
    const newTickets = vis.filter((o) => !seen.tickets.has(o.id))
    const newItems = vis.flatMap((o) => o.items.filter((it) => !seen.items.has(it.id)).map((it) => ({ orderId: o.id, item: it })))
    const newVoids = vis.flatMap((o) => o.voids.filter((it) => !seen.voids.has(it.id)))
    seen.tickets = new Set(vis.map((o) => o.id))
    seen.items = new Set(vis.flatMap((o) => o.items.map((it) => it.id)))
    seen.voids = new Set(vis.flatMap((o) => o.voids.map((it) => it.id)))
    if (newTickets.length === 0 && newItems.length === 0 && newVoids.length === 0) return
    const now = Date.now()
    setKdsFlash((prev) => ({
      tickets: { ...prev.tickets, ...Object.fromEntries(newTickets.map((o) => [o.id, now])) },
      items: { ...prev.items, ...Object.fromEntries(newItems.map((x) => [x.item.id, now])) },
      voids: { ...prev.voids, ...Object.fromEntries(newVoids.map((it) => [it.id, now])) },
    }))
    if (kdsFlashTimerRef.current) clearTimeout(kdsFlashTimerRef.current)
    kdsFlashTimerRef.current = setTimeout(() => setKdsFlash({ tickets: {}, items: {}, voids: {} }), 10_500)
    if (kdsSound) {
      if (newVoids.length > 0) {
        // preklic: nizki trojni ton — kuhinja mora PRESTHITI pripravo
        kdsBeep(392, 140); kdsBeep(392, 140, 200); kdsBeep(392, 140, 400)
      } else if (newTickets.length > 0) {
        kdsBeep(880, 180)
      } else {
        kdsBeep(660, 110); kdsBeep(660, 110, 170)
      }
    }
  }, [viewKitchen, kdsStation, kdsSound, kdsTasks, kdsCustomView, kdsLegacyBucket])
  // časovnik utripa se počisti ob odhodu z zavihka (tudi ločeno od efekta —
  // effect se poganja ob vsaki spremembi vrste, timer pa živi samostojno)
  useEffect(() => () => { if (kdsFlashTimerRef.current) clearTimeout(kdsFlashTimerRef.current) }, [])

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
      .sort((a, b) => (a.station === mi.station ? 0 : 1) - (b.station === mi.station ? 0 : 1) || a.name.localeCompare(b.name, 'sl'))
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
  const saleMixed = saleCat === 'ALL' || saleCat === 'FAVS' || saleSearch.trim() !== ''
  const saleCatNameOf = (mi: MenuT) => categories.find((c) => c.id === mi.categoryId)?.name ?? ''
  // iskanje po ŽETONIH: vsaka beseda poizvedbe mora biti v (ime + kategorija)
  // (»pizze bolognese«, »testenine gobami«) — nadloga poišče artikel tudi po
  // kontekstu jedi; ŽETONI, ne sosednji podniz, da preskočijo ločila
  const saleQ = saleSearch.trim().toLowerCase()
  const saleTokens = saleQ ? saleQ.split(/\s+/).filter(Boolean) : []
  const saleItems = menu.filter((mi) =>
    mi.available
    && (saleCat === 'ALL' || (saleCat === 'FAVS' ? saleFavs.includes(mi.id) : mi.categoryId === saleCat))
    && (saleTokens.length === 0
      || saleTokens.every((tok) => `${mi.name} ${saleCatNameOf(mi)}`.toLowerCase().includes(tok))))
  // v1.229.0: prazna ★ kategorija — iskren namig (označi v pogledu kartic), ne prazen zaslon
  const saleTotal = Object.entries(saleCart).reduce((s, [id, qty]) => s + (menu.find((x) => x.id === id)?.price ?? 0) * qty, 0)
    + posVariantLinesTotal(saleVariants, variantBasePriceOf)
  // vizualni benchmark (Toast/Square): skupno število kosov za oznako v glavi košare
  // (OSS-10 B-del: + količine vrstic variant)
  const saleCartCount = Object.values(saleCart).reduce((s, q) => s + q, 0) + saleVariants.reduce((s, l) => s + l.qty, 0)
  /* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: živi modeli plošč za vse
     ŠTIRI urejevalne dialoge POS (izbira variante / opomba vrstice / sprememba
     cene / preklic postavke). Vsak se preračuna ob VSAKI spremembi stanja —
     plošča zraven urejevalca se posodablja z vsako izbiro (Square oktober 2026
     »the check updates with each choice as staff edit«). Zapis ostane na Potrdi
     (dialogi omogočajo umik spremembe — predogled ne piše). */
  /** stanje ene od treh košaric POS po načinu (cart / sale / sheet) */
  const posCartOf = useCallback((mode: 'cart' | 'sale' | 'sheet') =>
    mode === 'cart'
      ? { cart, variants: cartVariants, notes: cartNotes }
      : mode === 'sale'
        ? { cart: saleCart, variants: saleVariants, notes: saleNotes }
        : { cart: sheetCart, variants: sheetVariants, notes: sheetNotes },
    [cart, cartVariants, cartNotes, saleCart, saleVariants, saleNotes, sheetCart, sheetVariants, sheetNotes])
  /** plošča izbire variante: obstoječe + nova vrstica iz TRENUTNIH izbir (pending) */
  const variantAsideModel = useMemo(() => {
    if (!variantPick) return LIVE_CHECK_EMPTY
    const mc = posCartOf(variantPick.mode)
    const base = variantPick.mode === 'sheet' && orderSheet ? orderPreviewLines(orderSheet.items) : []
    const pending = variantPendingLine(variantPick.item, variantPickGroups, variantPick.selections)
    return buildLiveCheck([
      ...base,
      ...cartPreviewLines(mc.cart, mc.variants, mc.notes, menu),
      ...(pending ? [pending] : []),
    ])
  }, [variantPick, variantPickGroups, posCartOf, orderSheet, menu])
  /** plošča opombe vrstice: vrstica v urejanju nosi ŽIVO sestavljeno opombo (čipi + besedilo) */
  const noteAsideModel = useMemo(() => {
    if (!notePick) return LIVE_CHECK_EMPTY
    const mc = posCartOf(notePick.mode)
    const live = composeItemNote([...noteChips], noteText)
    const base = notePick.mode === 'sheet' && orderSheet ? orderPreviewLines(orderSheet.items) : []
    return buildLiveCheck(withLineUpdate(
      [...base, ...cartPreviewLines(mc.cart, mc.variants, mc.notes, menu)],
      notePick.key,
      { note: live },
    ))
  }, [notePick, noteChips, noteText, posCartOf, orderSheet, menu])
  /** plošča spremembe cene: vrstica pokaže prej → novo (živo iz tipkanja), skupaj sledi */
  const priceAsideModel = useMemo(() => {
    if (!priceItem || !orderSheet) return LIVE_CHECK_EMPTY
    const parsed = parsePriceInput(priceNew)
    return buildLiveCheck(withLineUpdate(
      orderPreviewLines(orderSheet.items),
      priceItem.id,
      { unitPrice: parsed ?? priceItem.unitPrice, prevPrice: priceItem.unitPrice },
    ))
  }, [priceItem, priceNew, orderSheet])
  /** plošča preklica: vrstica prečrtana (pending + voided), skupaj brez nje */
  const voidAsideModel = useMemo(() => {
    if (!voidItem || !orderSheet) return LIVE_CHECK_EMPTY
    return buildLiveCheck(withLineUpdate(orderPreviewLines(orderSheet.items), voidItem.id, { voided: true }))
  }, [voidItem, orderSheet])
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
  /* §22 B: gumb opombe vrstice — enako obnašanje v vseh treh košaricah;
     jantarno polnilo + opomba pod vrstico, ko opomba obstaja (kuhinja jo
     vidi na KDS/listu — POS naj jo vidi PRI VNOSU). */
  const CartNoteButton = ({ mode, k, name }: { mode: 'cart' | 'sale' | 'sheet'; k: string; name: string }) => {
    const cur = mode === 'cart' ? cartNotes[k] : mode === 'sale' ? saleNotes[k] : sheetNotes[k]
    return (
      <button
        type="button"
        data-region="pos-note-btn"
        onClick={() => openNotePick(mode, k, name)}
        aria-label={cur ? t('posn.edit', { note: cur.slice(0, 40) }) : t('posn.add', { name })}
        title={cur || t('posn.add', { name })}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${cur ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-stone-200 bg-white text-stone-500 hover:bg-stone-50'}`}
      >
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
      </button>
    )
  }
  /* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: TAP na vrstico košarice
     odpre podrobnosti (opombo) — cela vrstica je tarča (44px+), ne samo 7×7 ℹ
     ikona (Square: »A tap on a check item opens its details«). Uporabljeno v
     namiznem in mobilnem tiru hitre prodaje. */
  const SaleCartLineName = ({ mi, qty }: { mi: MenuT; qty: number }) => {
    const cn = saleAmbiguous.has(normItemName(mi.name)) ? saleCatNameOf(mi) : ''
    const cur = saleNotes[mi.id]
    return (
      <button
        type="button"
        onClick={() => openNotePick('sale', mi.id, mi.name)}
        aria-label={cur ? t('posn.edit', { note: cur.slice(0, 40) }) : t('posn.add', { name: mi.name })}
        title={cur || t('posn.add', { name: mi.name })}
        className="flex min-h-11 min-w-0 flex-1 flex-col rounded-md px-1 py-1 text-left hover:bg-stone-100"
      >
        <span className="min-w-0 truncate font-medium leading-tight">{qty}× {mi.name}</span>
        {cn ? <span className="min-w-0 truncate text-xs leading-tight text-stone-400">{cn}</span> : null}
        {cur ? <span className="min-w-0 truncate text-xs leading-tight text-amber-800">ℹ {cur}</span> : null}
      </button>
    )
  }

  // OPS-4 v1.67.0 — tloris lokala (Mize): pogled + vlečenje miz (posX/posY v %)
  const [tableView, setTableView] = useState<'grid' | 'plan'>('grid')
  /* v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4, Toast/TouchBistro/Lightspeed benchmark):
     UREJEVALNIK MIZ — do zdaj je bil edini vir miz seed/API (TABLE_CREATE je obstajal
     samo v reviziji). Vrstica po mizo: številka + sedeži + cona; dodajanje/brisanje;
     brisanje blokirano ob aktivnem/zadržanem naročilu (isti pogoj kot tloris klik). */
  const [tablesEditOpen, setTablesEditOpen] = useState(false)
  const [teRows, setTeRows] = useState<{ id: string; number: string; seats: string; zone: string }[]>([])
  const [teNew, setTeNew] = useState({ number: '', seats: '4', zone: '' })
  const [teBusy, setTeBusy] = useState(false)
  const teOpen = () => {
    setTeRows(viewTables.map((tb) => ({ id: tb.id, number: String(tb.number ?? (tb.name.replace(/\D+/g, '') || '')), seats: String(tb.seats || 1), zone: tb.zone || '' })))
    setTeNew({ number: '', seats: '4', zone: '' })
    setTablesEditOpen(true)
  }
  /** Shrani ENO vrstico (PATCH number/seats/zone — konfiguracija prostora = menu.manage
      na strežniku). Konflikt številke (409) in druge napake se pokažejo ob vrstici. */
  const teSave = async (row: { id: string; number: string; seats: string; zone: string }) => {
    const number = Number(row.number)
    const seats = Number(row.seats)
    if (!Number.isInteger(number) || number < 1) { toast({ title: t('tables.number'), description: '≥ 1', variant: 'destructive' }); return }
    if (!Number.isInteger(seats) || seats < 1 || seats > 30) { toast({ title: t('tables.seatsShort'), description: '1–30', variant: 'destructive' }); return }
    setTeBusy(true)
    try {
      await api(`/api/tables/${row.id}`, { method: 'PATCH', body: JSON.stringify({ number, seats, zone: row.zone.trim() || 'Glavna dvorana' }) })
      await load()
      toast({ title: `✓ ${t('tables.saveRow')}` })
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setTeBusy(false) }
  }
  /** Izbriši mizo (potrjitev + varovalka aktivnega naročila v UI; ostalo strežnik). */
  const teDelete = async (row: { id: string; number: string; seats: string; zone: string }) => {
    const tb = viewTables.find((x) => x.id === row.id)
    if (tb && (tb.activeOrder || tb.heldOrderId)) { toast({ title: t('tables.deleteBlocked'), variant: 'destructive' }); return }
    if (!window.confirm(t('tables.deleteConfirm', { name: `Miza ${row.number}` }))) return
    setTeBusy(true)
    try {
      await api(`/api/tables/${row.id}`, { method: 'DELETE' })
      setTeRows((pr) => pr.filter((r) => r.id !== row.id))
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setTeBusy(false) }
  }
  /** Dodaj novo mizo (POST — enaka vrata kot seed: number, seats, zone +
   *  locationId IZ POGLEDA: centralna vloga brez dodeljene lokacije ga MORA poslati
   *  (requireUserLocation sicer poštenno zavrne — enaka disciplina kot prodaja). */
  const teAdd = async () => {
    const number = Number(teNew.number)
    const seats = Number(teNew.seats)
    if (!Number.isInteger(number) || number < 1) { toast({ title: t('tables.number'), description: '≥ 1', variant: 'destructive' }); return }
    if (!Number.isInteger(seats) || seats < 1 || seats > 30) { toast({ title: t('tables.seatsShort'), description: '1–30', variant: 'destructive' }); return }
    if (!viewLoc) { toast({ title: t('sale.noLocation'), variant: 'destructive' }); return }
    setTeBusy(true)
    try {
      await api('/api/tables', { method: 'POST', body: JSON.stringify({ number, seats, zone: teNew.zone.trim() || 'Glavna dvorana', locationId: viewLoc }) })
      setTeNew({ number: '', seats: '4', zone: teNew.zone })
      await load()
      await teRefreshRows()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setTeBusy(false) }
  }
  /** Osveži vrstice dialoga po spremembi (svež GET — ne odvisen od stale closure-a
      dashboard stanja, ki se posodobi šele naslednji render). Centralna vloga brez
      filtra vidi vse lokacije organizacije — vrstice omejimo na POGLED lokacije
      (isti obseg kot teOpen: viewTables). */
  const teRefreshRows = async () => {
    try {
      const d = await api<{ tables: TableT[] }>('/api/tables')
      const scoped = viewLoc ? d.tables.filter((tb) => tb.locationId === viewLoc) : d.tables
      setTeRows(scoped.map((tb) => ({ id: tb.id, number: String(tb.number ?? (tb.name.replace(/\D+/g, '') || '')), seats: String(tb.seats || 1), zone: tb.zone || '' })))
    } catch { /* ostanejo stare vrstice */ }
  }
  /* v1.233.0 (PRIMERJAVA-VMESNIKOV-2026 §4 — ZADNJA vrzel restavracije 21/22 → 22/22):
     UREDJEVALNIK CON kot samostojen objekt (Toast/TouchBistro praksa — vodilni
     upravljajo cone kot celoto, ne miza-po-mizi). Cona ostaja prostost besedila
     na mizi (0 DDL); POVEDEK je nov: preimenuj/združi VSE mize cone v eni
     operaciji (POST /api/tables/zones — updateMany + revizija ZONE_RENAME). */
  const [zonesEditOpen, setZonesEditOpen] = useState(false)
  const [zeRename, setZeRename] = useState<Record<string, string>>({})
  const [zeMerge, setZeMerge] = useState<Record<string, string>>({})
  const [zeBusy, setZeBusy] = useState(false)
  const zeOpen = () => { setZeRename({}); setZeMerge({}); setZonesEditOpen(true) }
  /** Cone poglede (viewTables — isti obseg kot teOpen): { ime, mize, sedežev },
      padajoče po številu miz. Prazna cona ('') je POŠTENA vrstica — preimenovanje
      v resnici razdeli mize brez cone. */
  const zeZones = () => {
    const m = new Map<string, { zone: string; count: number; seats: number; tables: string[] }>()
    for (const tb of viewTables) {
      const z = tb.zone || ''
      const agg = m.get(z) ?? { zone: z, count: 0, seats: 0, tables: [] }
      agg.count += 1
      agg.seats += tb.seats || 0
      agg.tables.push(tb.name)
      m.set(z, agg)
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone, 'sl'))
  }
  /** Ena operacija nad vsemi mizami cone (preimenuj ALI združi — za DB ista
      sprememba area). Lokacijska disciplina enaka teAdd: locationId iz pogleda. */
  const zeApply = async (from: string, to: string) => {
    const target = to.trim()
    if (!target) { toast({ title: t('zones.newName'), variant: 'destructive' }); return }
    if (target === from) { toast({ title: t('zones.sameName'), variant: 'destructive' }); return }
    if (!viewLoc) { toast({ title: t('sale.noLocation'), variant: 'destructive' }); return }
    setZeBusy(true)
    try {
      const d = await api<{ updated: number }>('/api/tables/zones', { method: 'POST', body: JSON.stringify({ from, to: target, locationId: viewLoc }) })
      await load()
      setZeRename((p) => { const q = { ...p }; delete q[from]; return q })
      setZeMerge((p) => { const q = { ...p }; delete q[from]; return q })
      toast({ title: t('zones.updated', { from, to: target, n: String(d.updated) }) })
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setZeBusy(false) }
  }
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
    // OSS-10 B-del (v1.210.0): + vrstice variant (modifierji → createOrderCore validira)
    const items = [
      ...Object.entries(saleCart).map(([menuItemId, qty]) => ({ menuItemId, qty, ...(saleNotes[menuItemId] ? { note: saleNotes[menuItemId] } : {}) })),
      ...posVariantItemsPayload(saleVariants).map((it, i) => ({ ...it, ...(saleNotes[saleVariants[i].key] ? { note: saleNotes[saleVariants[i].key] } : {}) })),
    ]
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
        // v1.238.0 §15 (P1): 'TAKEOUT' → 'TAKEAWAY' — preslikava TYPE_TO_DB te vrednosti
        // NI poznala, zato je vsa hitra prodaja (šank) tiho pristala kot dine-in brez mize
        // in poročila po kanalih lažala; strežnik zdaj neznane tipe tudi zavre (400).
        body: JSON.stringify({ items, type: 'TAKEAWAY', guests: 1, clientOperationId: newOperationId(), locationId: viewLoc || undefined }),
      })
      setSaleCart({}); setSaleVariants([]); setSaleNotes({})
      // v1.128.0: uspešno plačilo zapre list košare (odpre se plačilni dialog naročila)
      setSaleCartOpen(false)
      // OSS-4 (v1.204.0): sveže pridobivanje vključi tudi zadržane (merge, kot v loadAll)
      const [fresh, freshHeld] = await Promise.all([
        api<{ orders: OrderT[] }>('/api/orders'),
        api<{ orders: OrderT[] }>('/api/orders?status=hold').catch(() => ({ orders: [] as OrderT[] })),
      ])
      setOrders([...fresh.orders, ...(freshHeld.orders ?? [])])
      await load()
      const created = fresh.orders.find((x) => x.id === j.order?.id)
      if (created) void openPayment(created)
    } catch (err) {
      setSaleErr((err as Error).message)
      // v1.128.0: napaka iz plačila v vrstici → odpri list, da je sporočilo vidno
      if (saleIsMobile()) setSaleCartOpen(true)
    } finally { setSaleSending(false) }
  }
  const zones = [...new Set(viewTables.map((t) => t.zone))].sort((a, b) => a.localeCompare(b, 'sl'))

  // OPS-8 val 3 (v1.73.0): status filter chips — client-side filtering via lib/reservation-filters
  const filteredRes = filterReservations(reservations, resFilter, Date.now())

  // v1.244.0 (§18 D) — PRIČAKOVANI GOSTI ČEZ DAN: pokritost po 30-min oknih
  // (ista mreža kot strežniški varovalo ritma — ena resnica o »oknu prihodov«).
  // Čista klient agregacija že naloženih rezervacij (Lightspeed »expected
  // covers« april 2026 — »start each shift with a clear overview of expected
  // covers to support better planning and preparation«).
  const todayCovers = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const end = start.getTime() + 86_400_000
    const active = reservations.filter((r) => {
      if (r.status !== 'CONFIRMED' && r.status !== 'SEATED') return false
      const at = new Date(r.reservedAt).getTime()
      return Number.isFinite(at) && at >= start.getTime() && at < end
    })
    const slots = coversByWindow(active.map((r) => ({ reservedAt: r.reservedAt, guests: r.guests })), 30).filter((s) => s.guests > 0)
    return { guests: active.reduce((s, r) => s + (r.guests || 0), 0), count: active.length, slots }
  }, [reservations])

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
      <header data-region="dashboard-header" className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground border-b border-sidebar-border shadow-sm">
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
                <SelectContent data-region="location-select" className="bg-sidebar text-sidebar-foreground">
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
            {demoLogin && (
              /* Issue #93 (QA): jasna oznaka demo seje (testni podatki) v glavi. */
              <Badge variant="outline" className="hidden sm:inline-flex h-6 bg-amber-50 text-amber-800 border-amber-300" title={t('header.demoTitle')}>{t('header.demoBadge')}</Badge>
            )}
            <span className="text-sm text-stone-600 hidden sm:block truncate max-w-40">{user?.name}</span>
            <Button variant="ghost" size="icon" onClick={() => setConfirmLogout(true)} aria-label={t('header.logout')}><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      {/* ISSUE #73 audit-10 (v1.138.0): Tabs je zdaj nosilec LAYOUTA — navigacijski
          steber (≥ lg) + vsebina + mobilna spodnja vrstica (< lg) sestavljajo eno
          celoto; TabsContent ploskosti ŽIVIJO neposredno v dash-vsebina. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex min-h-0 flex-col">
        <div className="flex min-w-0 flex-1">
          <DashboardSidebar tabs={DASHBOARD_TABS} activeTab={activeTab} onSelect={setActiveTab} ctx={{ canManage, perms }} />
          <div id="dash-vsebina" tabIndex={-1} className="flex-1 min-w-0 max-w-7xl w-full mx-auto px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-6 outline-none">
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
                          <p className="text-xs text-stone-500">{tN('dash.itemsCount', 'artikel', o.items.length, { name: o.employee?.name || '—' })}</p>
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
            {/* OPS-10 val 1 (v1.77.0) — analitika: prodaja po urah + labor stroški (lazy fetch ko sta vidna)
                QA-val v1.222.0 (najdba #2): kartice se izrišejo SAMO vlogam z ustreznimi
                dovoljenji — prej je natakar na Pregledu videl 5 razbitih panelov z
                »Ponovno poskusi« (403 poročila, ki jih operativna vloga nikoli ne dobi). */}
            {(hasPerm('reports.sales') || hasPerm('reports.labour')) && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {hasPerm('reports.sales') && <SalesByHourCard />}
                {hasPerm('reports.labour') && <LaborCostCard />}
              </div>
            )}
            {/* v1.233.0 (PRIMERJAVA §11; Lightspeed nov 2025 »staff performance
                insights« / Toast »server scorecards«): prodaja po natakarju —
                naročila, prihodek, povprečje, napitnine, delež; lazy fetch,
                ista pravica kot ostala prodajna poročila (reports.sales). */}
            {hasPerm('reports.sales') && <StaffPerformanceCard />}
            {/* v1.250.0 (PRIMERJAVA §24 — TEMPO INSIGHTS VAL; Lightspeed junij
                2026 Tempo »service insights«): mize z največ praznim časom +
                najdaljše servisne luknje — lazy fetch, ista pravica kot ostala
                prodajna poročila (reports.sales); dopolnilo KDS statistikam
                (postavka/postaja → miza/naročilo end-to-end). */}
            {hasPerm('reports.sales') && <TempoInsightsCard />}
            {/* Issue #10 (v1.117.0) — Strošek dela in pokritost izmen: načrtovano vs.
                dejansko + urna matrika + napoved pokritosti (isti 'pregled' blok kot
                LaborCostCard — backend varuje reports.view; lazy fetch ko je vidna). */}
            {hasPerm('reports.labour') && <LaborCoverageCard locations={locStats.map((l) => ({ id: l.id, name: l.name }))} />}
            {/* P1-4 (v1.186.0) — napoved dela (priporočene ure/osebje + vrzeli vs.
                načrt) in P2-9 — AI vpogledi (deterministični motor + AIConversation
                log); isti 'pregled' blok, lazy fetch ko je vidno, reports.* pravice. */}
            {hasPerm('reports.labour') && <LaborForecastCard />}
            {(hasPerm('reports.sales') || hasPerm('reports.labour')) && <AiInsightsCard />}
          </TabsContent>

          <TabsContent value="mize" className="space-y-6">
            {/* OPS-4 v1.67.0 — tloris lokala: vizualni prikaz miz + vlečenje (shema posX/posY) */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button size="sm" variant={tableView === 'grid' ? 'default' : 'outline'} className={tableView === 'grid' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('grid')}>{t('tables.gridView')}</Button>
              <Button size="sm" variant={tableView === 'plan' ? 'default' : 'outline'} className={tableView === 'plan' ? 'bg-emerald-700 hover:bg-emerald-800' : ''} onClick={() => setTableView('plan')}>{t('tables.planView')}</Button>
              {tableView === 'plan' && <span className="text-xs text-stone-500">{t('tables.planHint')}</span>}
              {/* v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4): UREDI MIZE — Toast/TouchBistro
                  imajo urejevalnik miz v UI; naš API (POST/PATCH/DELETE + revizija) je
                  obstajal, UI pa ne. Viden samo vlogam z menu.manage (strežnik enako). */}
              {hasPerm('menu.manage') && (
                <Button size="sm" variant="outline" className="gap-1" onClick={teOpen} title={t('tables.editHint')}>
                  <Settings2 className="w-3.5 h-3.5" aria-hidden /> {t('tables.edit')}
                </Button>
              )}
              {/* v1.233.0 (PRIMERJAVA §4): UREDI CONE — cone kot samostojen objekt
                  (Toast/TouchBistro); ista pravica kot urejevalnik miz (menu.manage). */}
              {hasPerm('menu.manage') && (
                <Button size="sm" variant="outline" className="gap-1" onClick={zeOpen} title={t('zones.editHint')} data-region="zones-edit-btn">
                  <LayoutGrid className="w-3.5 h-3.5" aria-hidden /> {t('zones.edit')}
                </Button>
              )}
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
              /* v1.141.0 (Lightspeed benchmark) — PROSTORSKI TLORIS: mize so
                 OBLIKE (kvadrat/pravokotnik/okrogel/barski stol), ne besedilne
                 ploščice; cone imajo svoje ozadje z oznako; sedeži so PIKE.
                 Direktno barvanje po statusu (statusColors) ostaja. */
              <div
                data-region="pos-floor-plan"
                className="relative w-full rounded-xl border border-stone-200 bg-stone-100/70 overflow-hidden touch-none"
                style={{ aspectRatio: '16 / 10' }}
                onPointerMove={planPointerMove}
                onPointerUp={planPointerUp}
              >
                {/* cone — označena območja (bounding box miz cone + 6 % blazine) */}
                {[...new Set(viewTables.map((t) => t.zone))].map((zone) => {
                  const zt = viewTables.filter((t) => t.zone === zone)
                  if (zt.length === 0) return null
                  const ps = zt.map(planPosOf)
                  const minX = Math.max(0, Math.min(...ps.map((p) => p.x)) - 9)
                  const minY = Math.max(0, Math.min(...ps.map((p) => p.y)) - 10)
                  const maxX = Math.min(100, Math.max(...ps.map((p) => p.x)) + 9)
                  const maxY = Math.min(100, Math.max(...ps.map((p) => p.y)) + 10)
                  return (
                    <div
                      key={`zone-${zone}`}
                      aria-hidden
                      className="pointer-events-none absolute rounded-xl border-2 border-dashed border-stone-300/80 bg-stone-200/40"
                      style={{ left: `${minX}%`, top: `${minY}%`, width: `${maxX - minX}%`, height: `${maxY - minY}%` }}
                    >
                      <span className="absolute left-2 top-1.5 rounded-full bg-stone-200/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stone-500 shadow-sm">
                        {zoneL(zone)}
                      </span>
                    </div>
                  )
                })}
                {/* v1.235.0: prazno stanje tlorisa — isto sporočilo kot mrežni pogled,
                    a brez CTA (platno ima vlečne geste; gumb bi motil). Besedilo
                    usmeri v mrežni pogled, kjer je dodajanje miz. */}
                {viewTables.length === 0 && (
                  <div data-region="plan-empty" role="status" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
                    <Utensils className="h-8 w-8 text-stone-300" aria-hidden />
                    <p className="text-sm font-bold text-stone-700">{t('tables.emptyTitle')}</p>
                    <p className="max-w-xs text-xs text-stone-500">{t('tables.planEmpty')}</p>
                  </div>
                )}
                {viewTables.map((tb) => {
                  const pos = planPosOf(tb)
                  /* v1.141.0: oblika ∝ sedežem/podatku — 1 sedež = barski STOL
                     (mali krog), okrogla (shape=round ali ≥6 sedežev) = KROG,
                     2–3 sedeža = mali kvadrat, 4–5 = pravokotnik. */
                  const shape = tb.shape || (tb.seats <= 1 ? 'stool' : tb.seats >= 6 ? 'round' : 'square')
                  const shapeCls =
                    shape === 'stool'
                      ? 'w-9 h-9 rounded-full text-[10px]'
                      : shape === 'round'
                        ? 'w-16 h-16 rounded-full'
                        : tb.seats <= 3
                          ? 'w-12 h-12 rounded-xl'
                          : 'w-20 h-14 rounded-xl'
                  return (
                    <button
                      key={tb.id}
                      onPointerDown={planPointerDown(tb)}
                      onClick={() => {
                        if (draggedRef.current) { draggedRef.current = false; return }
                        if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
                        // OSS-4 (v1.204.0): miza z ZADRŽANIM naročilom → skok na seznam
                        // zadržanih (urejevalnik se zadržanega ne odpre — urejanje je 409)
                        if (!tb.activeOrder && tb.heldOrderId) { setOrderFilter('HOLD'); setActiveTab('narocila'); return }
                        if (!tb.activeOrder) { setCart({}); setCartVariants([]); setCartNotes({}); setNewOrderTable(tb) } else { const o = orders.find((x) => x.id === tb.activeOrder!.id); if (o) void openOrderSheet(o) }
                      }}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center gap-0.5 shadow text-xs font-bold cursor-grab active:cursor-grabbing ${shapeCls} ${statusColors[tb.status] ?? 'bg-stone-500 text-white'}`}
                      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                      aria-label={`${tb.name} · ${tileStatusL(tb)} · ${tb.seats}${nextResvByTable.get(tb.id) ? ` · ${t('tables.resvNext')} ${new Date(nextResvByTable.get(tb.id)!.reservedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}` : ''}`}
                      title={`${tb.name} · ${tileStatusL(tb)}${nextResvByTable.get(tb.id) ? ` · ${t('tables.resvNext')}: ${new Date(nextResvByTable.get(tb.id)!.reservedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })} (${nextResvByTable.get(tb.id)!.guests}× ${nextResvByTable.get(tb.id)!.guestName})` : ''}`}
                    >
                      <span className="leading-none">{tb.name.replace('Miza ', '')}</span>
                      {tb.activeOrder ? (
                        <span className="text-[10px] font-semibold leading-none tabular-nums">{fmtEUR(tb.activeOrder.total)}</span>
                      ) : (
                        /* sedeži kot PIKE (Lightspeed: hitri pregled kapacitete) */
                        <span className="flex gap-0.5 leading-none" aria-hidden>
                          {Array.from({ length: Math.min(tb.seats, 8) }).map((_, i) => (
                            <span key={i} className="size-1 rounded-full bg-current opacity-70" />
                          ))}
                        </span>
                      )}
                      {/* v1.244.0 (§18 C): inicialke natakarja na obliki mize (tloris) —
                          mali prostor, eno Same besedilo: badge; polno ime v aria/title. */}
                      {tb.activeOrder && tileWaiterInitials(tb) && (
                        <span
                          data-region="plan-waiter"
                          className="rounded bg-black/25 px-1 text-[9px] font-extrabold leading-none"
                          aria-label={t('tables.waiterAria', { name: tb.activeOrder.waiterName ?? '' })}
                        >
                          {tileWaiterInitials(tb)}
                        </span>
                      )}
                      {/* v1.232.0: ura prihajajoče rezervacije na obliki mize (tooltip
                          nosi ime gosta/število) — prosti prostor na tlorisu za ta
                          signal je minimalen, zato samo 🕒 + ura. */}
                      {nextResvByTable.get(tb.id) && (
                        <span data-region="plan-resv" className="text-[9px] font-extrabold leading-none tabular-nums">
                          🕒 {new Date(nextResvByTable.get(tb.id)!.reservedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            {/* v1.235.0 (raziskava nov 2026 — Toast onboarding vzorec): PRAZNO STANJE
                mrežnega pogleda. Lokacija brez miz je prej pokazala GOL prazen
                prostor pod legendo (0 con = 0 odsekov) — uporabnik ni vedel, kaj storiti.
                Iskren vzorec je že obstajal (Rezervacije V-24, KDS »kuhinja čista«);
                Mize ga niso nikoli dobile. CTA odpre urejevalnik miz (isti teOpen),
                brez pravice pa pošteno pove, kdo mize ureja. */}
            {viewTables.length === 0 && (
              <div data-region="tables-empty" role="status" className="flex min-h-48 flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-6 text-center">
                <Utensils className="h-10 w-10 text-stone-300" aria-hidden />
                <p className="text-base font-bold text-stone-800">{t('tables.emptyTitle')}</p>
                <p className="max-w-md text-sm text-stone-500">{hasPerm('menu.manage') ? t('tables.emptyHint') : t('tables.emptyNoPerm')}</p>
                {hasPerm('menu.manage') && (
                  <Button size="sm" className="mt-1 min-h-11 gap-1 bg-emerald-700 hover:bg-emerald-800" onClick={teOpen}>
                    <Plus className="w-3.5 h-3.5" aria-hidden /> {t('tables.emptyAdd')}
                  </Button>
                )}
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
                      višina h-40 vseh stanj — QR/⋮ ostane VZNOTRIJ kartice.
                      QA-val v1.268.0: h-32 → h-40 — polna ploščica je s h-32 obrezovala
                      NOGO (mt-auto spodaj; izmera scrollHeight 144 > clientHeight 128 +
                      VLM potrditev). h-36 je zalegel za 👤+⏱, a NE za 🕒 rezervacijski znak
                      v nogi (v1.232 — aktivno naročilo + prihajajoča rezervacija = 160 px;
                      E2E izmera Miza 3: sh 160 > 144). Usajeni gost izključuje aktivno
                      naročilo → najslabši primer je 158 px, h-40 ga pokrije z rezervo. */}
                  <div className="flex flex-wrap gap-3">
                    {zt.map((tb) => (
                      <div key={tb.id} className={`relative ${tableTileWidthCls(tb.seats)}`}>
                        <button
                          onClick={() => {
                            // miza za pospravit → en klik = očisti (issue #1: e2e zaključek)
                            if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
                            // OSS-4 (v1.204.0): miza z ZADRŽANIM naročilom → seznam zadržanih
                            if (!tb.activeOrder && tb.heldOrderId) { setOrderFilter('HOLD'); setActiveTab('narocila'); return }
                            if (!tb.activeOrder) { setCart({}); setCartVariants([]); setCartNotes({}); setNewOrderTable(tb) } else { const o = orders.find((x) => x.id === tb.activeOrder!.id); if (o) void openOrderSheet(o) }
                          }}
                          className={`flex h-40 w-full flex-col rounded-xl p-3 text-left shadow transition ${statusColors[tb.status]} overflow-hidden`}
                        >
                          <p className="font-bold text-lg flex items-center gap-2">
                            {tb.name}
                            {tb.status === 'DIRTY' && <SprayCan className="w-5 h-5 shrink-0 opacity-90" aria-hidden />}
                          </p>
                          <p className="text-xs opacity-90">{tN('tables.seats', 'mesto', tb.seats)}</p>
                          {/* Issue #71 audit-21: status je BESEDILO, ne samo barva (barvna slepota,\n                              sončna svetloba na tablici) */}
                          {tb.status !== 'FREE' && (
                            /* OSS-4 (v1.204.0): enotno besedilo prek tileStatusL — zadržana
                               miza nosi »Zadržano« namesto »Zasedena«; barva ne laže: je
                               zasedena barva, ker miza JE zasedena (Issue #70). */
                            <>
                              <p className="mt-0.5 text-xs font-bold uppercase tracking-wide opacity-95">{tileStatusL(tb)}</p>
                              {/* QA-val v1.220.0: usajeni gost s čakalne liste — identiteta na ploščici (mreža) */}
                              {seatedGuestL(tb) && <p className="text-xs normal-case tracking-normal opacity-95">{seatedGuestL(tb)}</p>}
                            </>
                          )}
                          {/* v1.232.0 (PRIMERJAVA §4, Toast/TouchBistro »reservations on
                              floor plan«): NASLEDNJA REZERVACIJA na ploščici — prosta miza
                              z rezervacijo je informativna (ne zasedaj!), zasedena pa
                              opozarja na obrat do ure. Celotna vrstica samo brez naročila
                              (fiksna višina h-40 — polna ploščica dobi kompakt znak v nogi). */}
                          {(() => {
                            const rv = nextResvByTable.get(tb.id)
                            if (!rv || tb.activeOrder) return null
                            const rvTime = new Date(rv.reservedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
                            return (
                              <p
                                data-region="tile-resv"
                                className="mt-0.5 text-xs font-semibold opacity-95 truncate"
                                title={`${t('tables.resvNext')}: ${rvTime} · ${rv.guests}× ${rv.guestName}`}
                              >
                                🕒 {rvTime} · {rv.guests}× {rv.guestName}
                              </p>
                            )
                          })()}
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
                                {/* v1.244.0 (§18 C): STREŽNIŠKA ZNAČKA — inicialke natakarja,
                                    ki je odprl naročilo (Lightspeed »server ownership«). */}
                                {tb.activeOrder?.waiterName && (
                                  <p className="text-xs font-semibold opacity-95 truncate" title={t('tables.waiterAria', { name: tb.activeOrder.waiterName })}>
                                    👤 {tb.activeOrder.waiterName}
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
                                je že vidna v vrstici zneska/časa zgoraj) — Toast order-stage vzorec.
                                QA-val v1.268.0: noga nosi status SAMO kjer je UNIKATEN — prosta
                                miza (edini status na ploščici) in za pospravit (navodilo klika);
                                zasedena/rezervirana ga ŽE ima v telesu (tileStatusL zgoraj) —
                                dvojnik je polnil fiksno višino in obrezoval 👤/⏱ vrstici. Usajeni
                                gost je prav tako že v telesu (QA-val v1.220.0) — nogova kopija
                                umaknjena. */}
                            {(tb.status === 'FREE' || tb.status === 'DIRTY') &&
                              (tb.status === 'DIRTY' ? t('tables.clickClean') : tileStatusL(tb))}
                            {/* v1.232.0: zasedena miza s prihajajočo rezervacijo — kompakt znak
                                🕒 ura v nogi (miza se mora obrniti do te ure; podrobnosti v
                                tooltipu — polna vrstica ne gre več v fiksno višino h-40). */}
                            {tb.activeOrder && (() => {
                              const rv = nextResvByTable.get(tb.id)
                              if (!rv) return null
                              const rvTime = new Date(rv.reservedAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
                              return (
                                <span data-region="tile-resv-compact" className="block font-semibold" title={`${t('tables.resvNext')}: ${rvTime} · ${rv.guests}× ${rv.guestName}`}>
                                  🕒 {rvTime} · {rv.guests}× {rv.guestName}
                                </span>
                              )
                            })()}
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
                      {t('sync.deadAttempts', { n: o.attempts })} · {new Date(o.createdAt).toLocaleString('sl-SI')}
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
                  {(['ALL', 'OPEN', 'SENT', 'PREPARED', 'HOLD'] as const).map((f) => (
                    <Button key={f} size="sm" variant={orderFilter === f ? 'default' : 'outline'}
                      className={orderFilter === f ? 'h-7 text-xs bg-emerald-700 hover:bg-emerald-800 text-white' : 'h-7 text-xs'}
                      onClick={() => setOrderFilter(f)}>
                      {f === 'ALL' ? t('orders.filterAll') : stL(f)}
                    </Button>
                  ))}
                </div>
                {/* v1.235.0 (raziskava nov 2026): PRAZNO STANJE seznama naročil.
                    Filtri so prisotni od OPS-7, a pogled brez zadetkov (zastarel filter
                    ali mirna lokacija) je prej pustil GOL prostor — uporabnik ni vedel,
                    ali je napaka ali res ni nič. Vzorec Rezervacij V-24: ikona + pošteno
                    kontekstno sporočilo; pri specifičnem filtru pove KATERI filter je prazen
                    (Square avg 2026 pritožba #1: uporabnik ne sme ostati v zagoni). */}
                {viewOrders.filter((o) => orderFilter === 'ALL' || o.status === orderFilter).length === 0 && (
                  <div data-region="orders-empty" role="status" className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-6 text-center">
                    <ReceiptText className="h-10 w-10 text-stone-300" aria-hidden />
                    <p className="max-w-md text-sm text-stone-500">
                      {orderFilter === 'ALL' ? t('orders.emptyAll') : t('orders.emptyFilter', { status: stL(orderFilter) })}
                    </p>
                  </div>
                )}
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
                              {tN('orders.moreItems', 'ostal', rest)}
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
                      {/* OSS-4 (v1.204.0): zadržano naročilo — Uredi/Plačaj skrita (strežnik bi
                          vseeno 409); namesto njiju gumb Nadaljuj v akcijski vrstici spodaj. */}
                      {o.status !== 'PAID' && o.status !== 'HOLD' && (
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
                    {/* 33-a: fire / move / merge — samo za odprta, neplačana naročila (backend uveljavlja orders.create)
                        OSS-4 (v1.204.0): zadržano naročilo dobi SAMO Nadaljuj (parkirano — ni fire/move/merge); */}
                    {hasPerm('orders.create') && isOrderOpenUi(o) && o.status === 'HOLD' && (
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" className="h-10 gap-1 bg-emerald-700 hover:bg-emerald-800 text-xs" disabled={mmvBusy}
                          onClick={() => void resumeOrder(o)} title={t('order.resumeBtn')}>
                          <Play className="w-3 h-3" /> {t('order.resumeBtn')}
                        </Button>
                      </div>
                    )}
                    {hasPerm('orders.create') && isOrderOpenUi(o) && o.status !== 'HOLD' && (
                      <div className="flex flex-wrap gap-1.5">
                        {o.items.some((it) => it.status === 'PENDING' && !it.voided) && (
                          <Button size="sm" variant="outline" className="h-10 gap-1 text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                            disabled={mmvBusy} onClick={() => void fireOrder(o)} title={t('mmv.fire')}>
                            <Flame className="w-3 h-3" /> {t('mmv.fire')}
                          </Button>
                        )}
                        {holdableUi(o) && (
                          <Button size="sm" variant="outline" className="h-10 gap-1 text-xs border-stone-300 text-stone-700 hover:bg-stone-50"
                            disabled={mmvBusy} onClick={() => holdOrder(o)} title={t('order.holdBtn')}>
                            <Pause className="w-3 h-3" /> {t('order.holdBtn')}
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
                      <SelectItem key={tb.id} value={tb.id}>{tb.name} · {tN('tables.seats', 'mesto', tb.seats)}</SelectItem>
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

          {/* OSS-4 (v1.204.0): zadržanje naročila — neobvezen razlog (posnetek v reviziji ORDER_HOLD) */}
          <Dialog open={!!holdTarget} onOpenChange={(op) => { if (!op) { setHoldTarget(null); setHoldTargetReason('') } }}>
            {/* aria-describedby={undefined} — vzorec v1.202.0/v1.203.0: dialog brez Description
                sicer sproži radix »Missing Description« warning (čista konsola po vzorcu) */}
            <DialogContent aria-describedby={undefined} className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><Pause className="w-4 h-4" /> {t('order.holdTitle')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-stone-500">{t('order.holdHint', { name: holdTarget?.table?.name || orderTypeL(holdTarget?.type || '') })}</p>
                <div className="space-y-1.5">
                  <Label htmlFor="hold-reason">{t('order.holdReason')}</Label>
                  <Input id="hold-reason" value={holdTargetReason} maxLength={200}
                    onChange={(e) => setHoldTargetReason(e.target.value)} placeholder={t('order.holdReasonPh')} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setHoldTarget(null); setHoldTargetReason('') }}>{t('common.cancel')}</Button>
                <Button className="bg-stone-600 hover:bg-stone-700" disabled={mmvBusy} onClick={() => void holdOrderConfirm()}>
                  {mmvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('order.holdConfirm')}
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
            {/* v1.141.0 (Toast benchmark): KOŠARA LEVO — natakarjevo oko ostaja na
                mreži izdelkov, košara pa v levem robu kot Toast »left rail« (prej
                desno — oko je moralo potovati čez cel zaslon). Vrstni red = grid
                order (1=košara, 2=mreža) — mobilna postavitev (fiksna vrstica
                spodaj) je NEODVISNA od tega (aside skrit < md). */}
            {/* v1.141.0 (Toast benchmark): KOŠARA LEVO — v1.257.0 (§31, Square
                Vol 15 »Choose the cart's side«) stran postane PER-NAPRAVA izbira:
                predloga mreže + order-1/order-2 se zrcalita; mobilna (<md)
                postavitev NEODVISNA (aside hidden md:block, fiksna vrstica). */}
            <div className={`md:grid md:items-start md:gap-4 ${
              saleCartSide === 'left'
                ? 'md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]'
                : 'md:grid-cols-[minmax(0,1fr)_17rem] lg:grid-cols-[minmax(0,1fr)_21rem]'
            }`}>
              {/* LEVO: iskanje + čipi kategorij + mreža izbire (order-2 za md+) */}
              {/* ISSUE #74 V-6 (blocker): prej 40 gumbov kategorij v 6 ovitih vrstah —
                mreža izbire se je začela šele pri y=429/860 px (na mobilnem 61 % višine).
                Toast/Square vzorec: iskanje VEDNO v svoji vrstici + ENA vodoravno drsna
                vrstica kategorij (flex-nowrap + overflow-x-auto) — mreža pri y≈140. */}
            <div className={`min-w-0 space-y-3 pb-20 md:pb-0 ${saleCartSide === 'left' ? 'md:order-2' : 'md:order-1'}`}>
              <div className="flex items-center gap-2">
                {/* v1.229.0: Enter v iskalnem polju = EAN čitalnik (scanner pošlje Enter);
                    besedne poizvedbe se ne sprožijo (regex samo številke). */}
                <Input value={saleSearch} onChange={(e) => setSaleSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saleEanSubmit() } }} placeholder={t('sale.search')} className="h-11 w-full sm:w-56" aria-label={t('sale.search')} />
                {/* v1.141.0 (Toast gostota): preklop KARTICE ↔ KOMPAKTNO — velike
                    besedilne ploščice (1–4 na vrstico) ali gost tekstovni grid
                    (12–20 ploščic hkrati, barvno kodirane kategorije, mišični
                    spomin). Persist v localStorage. v1.234.0: brez fotografij. */}
                <div className="ml-auto inline-flex shrink-0 rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-950 p-0.5" role="group" aria-label={t('sale.viewMode')}>
                  <button
                    type="button"
                    aria-pressed={saleView === 'cards'}
                    aria-label={t('sale.viewCards')}
                    title={t('sale.viewCards')}
                    onClick={() => saleViewSet('cards')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold transition ${
                      saleView === 'cards' ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    <LayoutGrid className="w-4 h-4" aria-hidden />
                    <span className="hidden lg:inline">{t('sale.viewCards')}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={saleView === 'compact'}
                    aria-label={t('sale.viewCompact')}
                    title={t('sale.viewCompact')}
                    onClick={() => saleViewSet('compact')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold transition ${
                      saleView === 'compact' ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    <Rows3 className="w-4 h-4" aria-hidden />
                    <span className="hidden lg:inline">{t('sale.viewCompact')}</span>
                  </button>
                </div>
                {/* v1.257.0 (§31, Square Vol 15 »Choose the cart's side«): stran
                    košare — segmentirana kontrola ob gostoti; 44 px dotik,
                    aria-pressed, per-naprava persist. Vzorec zgornje skupine
                    (ikona vedno, besedilo od lg). */}
                <div data-region="sale-cart-side" className="inline-flex shrink-0 rounded-lg border border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-950 p-0.5" role="group" aria-label={t('sale.cartSide')}>
                  <button
                    type="button"
                    aria-pressed={saleCartSide === 'left'}
                    aria-label={t('sale.cartSideLeft')}
                    title={t('sale.cartSideLeft')}
                    onClick={() => saleCartSideSet('left')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold transition ${
                      saleCartSide === 'left' ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    <PanelLeft className="w-4 h-4" aria-hidden />
                    <span className="hidden lg:inline">{t('sale.cartSideLeftShort')}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={saleCartSide === 'right'}
                    aria-label={t('sale.cartSideRight')}
                    title={t('sale.cartSideRight')}
                    onClick={() => saleCartSideSet('right')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold transition ${
                      saleCartSide === 'right' ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    <PanelRight className="w-4 h-4" aria-hidden />
                    <span className="hidden lg:inline">{t('sale.cartSideRightShort')}</span>
                  </button>
                </div>
              </div>
              {/* V-6: horizontalni TRAK kategorij (nowrap) — gumbi se nikoli ne ovijejo;
                  V-19: cilji 44 px (h-11) na POS, rounded-full chip videz (Square) */}
              <div
                className="flex items-center gap-1.5 overflow-x-auto flex-nowrap -mx-1 px-1 pb-1 [scrollbar-width:thin]"
                role="group" aria-label={t('sale.allCat')} tabIndex={0}
              >
                {/* v1.229.0 (Toast benchmark): ★ PRILJUBLJENO — vodi tudi ko je prazno (iskren
                    namig namesto skrite funkcije); filter deluje v OBEH pogledih mreže. */}
                <Button size="sm" variant={saleCat === 'FAVS' ? 'default' : 'outline'} className={`h-11 shrink-0 rounded-full whitespace-nowrap gap-1 ${saleCat === 'FAVS' ? 'bg-amber-500 hover:bg-amber-600' : ''}`} onClick={() => { saleCatTouched.current = true; setSaleCat('FAVS') }} title={t('sale.favs')}>
                  <Star className="w-3.5 h-3.5" aria-hidden /> {t('sale.favs')}
                </Button>
                <Button size="sm" variant={saleCat === 'ALL' ? 'default' : 'outline'} className={`h-11 shrink-0 rounded-full whitespace-nowrap ${saleCat === 'ALL' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`} onClick={() => { saleCatTouched.current = true; setSaleCat('ALL') }}>
                  {t('sale.allCat')}
                </Button>
                {categories.map((c) => (
                  <Button key={c.id} size="sm" variant={saleCat === c.id ? 'default' : 'outline'} className={`h-11 max-w-44 shrink-0 rounded-full whitespace-nowrap ${saleCat === c.id ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`} onClick={() => { saleCatTouched.current = true; setSaleCat(c.id) }} title={c.name}>
                    <span className="truncate">{c.name}</span>
                  </Button>
                ))}
              </div>
                {/* v1.141.0 (Toast gostota) — DVA načina mreže: KARTICE (velike
                    ploščice, ime + cena + barvni rob) ali KOMPAKTNO (12–20 ploščic
                    na ekran). v1.234.0: fotografije kategorij ODSTRANJENE — vse
                    ploščice so besedilne (Square/Toast: fotografija je per-artikel
                    podatek, nikoli ugibanje iz kategorije — zavajujoča slika je
                    hujša od nje). */}
                {saleView === 'compact' ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5">
                  {saleItems.map((mi) => {
                    // OSS-10 B-del: značka na ploščici šteje TUDI vrstice variant tega artikla
                    const inCart = (saleCart[mi.id] || 0) + saleVariants.filter((l) => l.menuItemId === mi.id).reduce((s, l) => s + l.qty, 0)
                    const catKey = mi.categoryId || (categories.find((c) => c.name === saleCatNameOf(mi))?.id ?? mi.name)
                    const catOverline = saleMixed ? saleCatNameOf(mi) : ''
                    // v1.229.0: ⚡ Happy Hour — akcijska cena na ploščici med aktivnim oknom
                    const hh = hhOf(mi)
                    return (
                      <button key={mi.id} disabled={!mi.available} onClick={() => posAddClick('sale', mi)}
                        aria-label={`${catOverline ? `${catOverline} · ` : ''}${mi.name} ${fmtEUR(mi.price)}${hh ? ` · ${t('sale.hhAria', { price: fmtEUR(hh.price) })}` : ''}${inCart > 0 ? ` · ${inCart}× ${t('sale.inCart')}` : ''}${!mi.available ? ` · ${t('sale.soldOut')}` : ''}`}
                        title={hh ? hh.name : undefined}
                        className={`relative flex h-20 flex-col items-start justify-between border-l-4 px-2.5 py-2 text-left transition ${
                          mi.available
                            ? `${saleCatBorderCls(catKey)} border-y-stone-200 border-r-stone-200 dark:border-y-stone-700 dark:border-r-stone-700 bg-white dark:bg-stone-800 shadow-sm hover:bg-stone-50 dark:hover:bg-stone-700 hover:shadow active:scale-[0.98] ${inCart > 0 ? 'ring-2 ring-emerald-600' : ''}`
                            : 'cursor-not-allowed border-l-red-400 border-y-red-200 border-r-red-200 dark:border-y-red-900 dark:border-r-red-900 bg-red-50/70 dark:bg-red-950/40'
                        }`}
                      >
                        {inCart > 0 && (
                          <span key={inCart} aria-hidden className="absolute right-1 top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-700 px-1 text-xs font-bold tabular-nums text-white shadow-sm animate-in zoom-in-75 duration-150">
                            {inCart}×
                          </span>
                        )}
                        {!mi.available && (
                          <span className="absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-red-800 shadow-sm">86</span>
                        )}
                        <p className={`min-w-0 self-stretch pr-6 text-[13px] font-semibold leading-tight line-clamp-2 break-words ${mi.available ? 'text-stone-900' : 'text-red-700/60 dark:text-red-400/70 line-through'}`}>{mi.name}</p>
                        <span className="flex w-full items-baseline justify-between gap-1">
                          {catOverline && <span className="truncate text-[10px] font-medium uppercase tracking-wide text-stone-400" aria-hidden>{catOverline}</span>}
                          {hh ? (
                            <span className="ml-auto flex shrink-0 items-baseline gap-1">
                              <Zap className="w-3 h-3 self-center text-amber-500" aria-hidden />
                              <span className="text-sm font-extrabold tabular-nums text-amber-700 dark:text-amber-400">{fmtEUR(hh.price)}</span>
                              <span className={`text-[11px] font-medium tabular-nums line-through ${mi.available ? 'text-stone-400' : 'text-red-700/70 dark:text-red-400'}`}>{fmtEUR(mi.price)}</span>
                            </span>
                          ) : (
                            <span className={`ml-auto shrink-0 text-sm font-bold tabular-nums ${mi.available ? 'text-stone-900' : 'text-red-700/70 dark:text-red-400'}`}>{fmtEUR(mi.price)}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
                ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                  {saleItems.map((mi) => {
                    // OSS-10 B-del: značka na ploščici šteje TUDI vrstice variant tega artikla
                    const inCart = (saleCart[mi.id] || 0) + saleVariants.filter((l) => l.menuItemId === mi.id).reduce((s, l) => s + l.qty, 0)
                    /* v1.234.0 (lastnikova odločitev): FOTOGRAFIJA ODSTRANJENA s ploščice.
                       Produkcija je pokazala, da preslikava KATEGORIJA → slika da VSEM
                       artiklom kategorije isto sliko (16 ploščic »Glavne jedi« = ista
                       klobasa) — zavajujoča slika je hujša od brez nje (Square/Toast:
                       slika je per-artikel podatek ali je ni). Namesto nje: BARVNI LEVI
                       ROB kategorije (enak hash kot kompaktni grid) — hitra orientacija
                       brez laži. Vsa obstoječa logika (86, Happy Hour, priljubljene,
                       variante) ostaja nedotaknjena. */
                    const catKey = mi.categoryId || (categories.find((c) => c.name === saleCatNameOf(mi))?.id ?? mi.name)
                    // ISSUE #73 audit-15: overline »jed« = kategorija (samo v mešanem
                    // pogledu — znotraj izbrane kategorije je kontekst že v čipu)
                    const catOverline = saleMixed ? saleCatNameOf(mi) : ''
                    // v1.229.0: ⚡ Happy Hour (akcijska cena) + ★ zvezdica (samo kartice —
                    // ovoj je RELATIVE div, zvezdica je SESTRINSKI gumb zunaj ploščice:
                    // gumb v gumbu je neveljaven HTML)
                    const hh = hhOf(mi)
                    const fav = saleFavs.includes(mi.id)
                    return (
                      <div key={mi.id} className="relative">
                      <button disabled={!mi.available} onClick={() => posAddClick('sale', mi)}
                        aria-label={`${catOverline ? `${catOverline} · ` : ''}${mi.name} ${fmtEUR(mi.price)}${hh ? ` · ${t('sale.hhAria', { price: fmtEUR(hh.price) })}` : ''}${inCart > 0 ? ` · ${inCart}× ${t('sale.inCart')}` : ''}${!mi.available ? ` · ${t('sale.soldOut')}` : ''}`}
                        title={hh ? hh.name : undefined}
                        className={`group relative flex min-h-24 w-full flex-col justify-between border-l-4 px-3 py-2.5 text-left transition ${mi.available
                          ? `${saleCatBorderCls(catKey)} border-y-stone-200 border-r-stone-200 dark:border-y-stone-700 dark:border-r-stone-700 bg-white dark:bg-stone-800 shadow-sm hover:bg-stone-50 dark:hover:bg-stone-700 hover:shadow active:scale-[0.98] ${inCart > 0 ? 'ring-2 ring-emerald-600' : ''}`
                          : 'cursor-not-allowed border-l-red-400 border-y-red-200 border-r-red-200 dark:border-l-red-500 dark:border-y-red-900 dark:border-r-red-900 bg-red-50/70 dark:bg-red-950/40'}`}>
                        {inCart > 0 && (
                          <span key={inCart} aria-hidden="true" className="absolute left-1.5 top-1.5 z-10 flex h-6 min-w-6 items-center justify-center rounded-full bg-emerald-700 px-1.5 text-xs font-bold tabular-nums text-white shadow-sm animate-in zoom-in-75 duration-150">
                            {inCart}×
                          </span>
                        )}
                        {/* Issue #71 audit-16: 86 iz KDS-a je viden NA PLOŠČICI (rdeči trak),
                            ne tiho mrk — natakar NE proda artikla, ki ga je kuhinja že umaknila */}
                        {!mi.available && (
                          <span className="absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full border border-red-300 bg-red-100 px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wider text-red-800 shadow-sm">86</span>
                        )}
                        <span className="flex min-h-14 flex-1 flex-col">
                          {/* ISSUE #73 audit-15: ploščica »jed · različica · velikost« —
                              overline (kategorija/jed) loči isto ime dveh različnih jedi
                              (»Bolognese« testenina/pica) in da starša golim imenom
                              prilagodb (»Z gobami« → »Testenine, njoki · Z gobami«).
                              pr-12: ime ne teče pod ★ zvezdico (zgornji desni kot). */}
                          {catOverline && (
                            <span className="mb-0.5 truncate text-[10px] font-semibold uppercase leading-tight tracking-wider text-stone-400" aria-hidden="true">{catOverline}</span>
                          )}
                          <p className={`min-w-0 self-stretch pr-12 text-sm font-semibold leading-tight line-clamp-2 break-words ${mi.available ? 'text-stone-900 dark:text-stone-100' : 'text-red-700/60 dark:text-red-400/70 line-through'}`}>{mi.name}</p>
                          {hh ? (
                            <span className="mt-auto flex items-baseline justify-end gap-1 pt-1">
                              <Zap className="w-3.5 h-3.5 self-center text-amber-500" aria-hidden />
                              <span className="text-sm font-extrabold tabular-nums text-amber-700 dark:text-amber-400">{fmtEUR(hh.price)}</span>
                              <span className={`text-xs font-medium tabular-nums line-through ${mi.available ? 'text-stone-400' : 'text-red-700/70'}`}>{fmtEUR(mi.price)}</span>
                            </span>
                          ) : (
                            <p className={`mt-auto self-end pt-1 text-sm font-bold tabular-nums ${mi.available ? 'text-stone-900 dark:text-stone-100' : 'text-red-700/70 line-through'}`}>{fmtEUR(mi.price)}</p>
                          )}
                        </span>
                      </button>
                      {/* v1.229.0: ★ zvezdica (SESTRINSKI gumb — veljaven HTML) v zgornjem
                          desnem kotu ploščice; 44-pikselna cona (h-11 w-11) za dotik. */}
                      <button
                        type="button"
                        aria-pressed={fav}
                        aria-label={fav ? `${t('sale.favRemove')} — ${mi.name}` : `${t('sale.favAdd')} — ${mi.name}`}
                        title={fav ? t('sale.favRemove') : t('sale.favAdd')}
                        onClick={() => saleFavToggle(mi.id)}
                        className="absolute right-1 top-1 z-20 flex h-11 w-11 items-center justify-center rounded-full text-stone-300 transition hover:text-amber-500 active:scale-95 dark:text-stone-600 dark:hover:text-amber-400"
                      >
                        <Star className={`w-4 h-4 ${fav ? 'fill-amber-400 text-amber-500' : ''}`} aria-hidden />
                      </button>
                      </div>
                    )
                  })}
                </div>
                )}
                {saleItems.length === 0 && (
                  <p className="text-sm text-stone-500">{saleCat === 'FAVS' && saleSearch.trim() === '' ? t('sale.favsEmpty') : t('sale.empty')}</p>
                )}
              </div>

              {/* KOŠARA — Toast »left rail« (v1.141.0): trajna košara LEVO (md:order-1)
                  — natakarjevo oko ostaja na mreži; glava s števcem, drsni seznam
                  postavk, vsota + Plačaj VEDNO pritrjena spodaj. v1.257.0 (§31):
                  DESNO = zrcaljeno (md:order-2) — izbira naprave po Square Vol 15. */}
              <aside className={`hidden md:block ${saleCartSide === 'left' ? 'md:order-1' : 'md:order-2'}`} aria-label={t('sale.cartTitle')}>
                <Card className="sticky top-20 flex max-h-[calc(100vh-6.25rem)] flex-col shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between gap-2 text-base">
                      <span className="flex min-w-0 items-center gap-2">
                        <ShoppingCart className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
                        {t('sale.cartTitle')}
                        {saleCartCount > 0 && <Badge className="shrink-0 bg-emerald-700 tabular-nums text-white">{saleCartCount}</Badge>}
                      </span>
                      {saleCartCount > 0 && (
                        <Button size="sm" variant="ghost" className="h-10 shrink-0 px-2 text-xs text-stone-500 hover:text-red-700" onClick={() => { setSaleCart({}); setSaleVariants([]); setSaleNotes({}) }} title={t('sale.clearCart')} aria-label={t('sale.clearCart')}>
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
                      [
                        ...Object.entries(saleCart).map(([id, qty]) => {
                          const mi = menu.find((x) => x.id === id)
                          if (!mi) return null
                          return (
                            <div key={id} className="flex items-center gap-1.5 rounded-lg border border-stone-100 bg-stone-50/60 px-2 py-1.5 text-sm">
                              <SaleCartLineName mi={mi} qty={qty} />
                              <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="-1" onClick={() => setSaleCart((pr) => { const q = (pr[id] || 0) - 1; const nx = { ...pr }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })}>−</Button>
                              <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="+1" onClick={() => setSaleCart((pr) => ({ ...pr, [id]: (pr[id] || 0) + 1 }))}>+</Button>
                              <CartNoteButton mode="sale" k={id} name={mi.name} />
                              <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{fmtEUR(mi.price * qty)}</span>
                            </div>
                          )
                        }),
                        // OSS-10 B-del (v1.210.0): vrstice variant — sestavljeno ime + doplačilo,
                        // ločeno −/+ (ista izbira = ista vrstica, +1 je ista izbira)
                        ...saleVariants.map((l) => {
                          const mi = menu.find((x) => x.id === l.menuItemId)
                          if (!mi) return null
                          return (
                            <div key={l.key} className="flex items-center gap-1.5 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-2 py-1.5 text-sm">
                              {/* §28: tap na vrstico = podrobnosti (opomba) */}
                              <button type="button" onClick={() => openNotePick('sale', l.key, orderItemDisplayName(mi.name, l.optionNames))} title={saleNotes[l.key] || t('posn.add', { name: orderItemDisplayName(mi.name, l.optionNames) })} aria-label={saleNotes[l.key] ? t('posn.edit', { note: saleNotes[l.key].slice(0, 40) }) : t('posn.add', { name: orderItemDisplayName(mi.name, l.optionNames) })} className="flex min-h-11 min-w-0 flex-1 flex-col rounded-md px-1 py-1 text-left hover:bg-stone-100">
                                <span className="min-w-0 truncate font-medium leading-tight">{l.qty}× {orderItemDisplayName(mi.name, l.optionNames)}</span>
                                {l.optionPrice > 0 ? <span className="min-w-0 truncate text-xs leading-tight text-stone-400">{t('orders.variantSurcharge')}: +{fmtEUR(l.optionPrice)}</span> : null}
                                {saleNotes[l.key] ? <span className="min-w-0 truncate text-xs leading-tight text-amber-800">ℹ {saleNotes[l.key]}</span> : null}
                              </button>
                              <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="-1" onClick={() => setSaleVariants((pr) => changePosVariantLineQty(pr, l.key, -1))}>−</Button>
                              <Button size="sm" variant="outline" className="h-10 w-10 shrink-0 p-0" aria-label="+1" onClick={() => setSaleVariants((pr) => addPosVariantLine(pr, l))}>+</Button>
                              <CartNoteButton mode="sale" k={l.key} name={orderItemDisplayName(mi.name, l.optionNames)} />
                              <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{fmtEUR((mi.price + l.optionPrice) * l.qty)}</span>
                            </div>
                          )
                        }),
                      ]
                    )}
                  </CardContent>
                  <div className="space-y-2 border-t border-stone-200 p-4">
                    <div className="flex items-center justify-between text-base font-bold">
                      <span>{t('sale.total')}</span>
                      <span className="tabular-nums">{fmtEUR(saleTotal)}</span>
                    </div>
                    <Button className="min-h-12 w-full bg-emerald-700 text-base font-bold hover:bg-emerald-800 disabled:bg-stone-200 disabled:text-stone-500 disabled:font-medium disabled:hover:bg-stone-200 dark:disabled:bg-stone-800 dark:disabled:text-stone-400 dark:disabled:hover:bg-stone-800" disabled={saleSending || saleCartCount === 0} onClick={() => void submitSale()}>
                      {saleSending ? <Loader2 className="h-5 w-5 animate-spin" /> : t('sale.payNow')}
                    </Button>
                    {saleErr && (
                      <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
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
                          <Button size="sm" variant="ghost" className="h-9 w-9 shrink-0 p-0 text-stone-500 hover:text-red-700" onClick={() => { setSaleCart({}); setSaleVariants([]); setSaleNotes({}) }} title={t('sale.clearCart')} aria-label={t('sale.clearCart')}>
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
                      [
                        ...Object.entries(saleCart).map(([id, qty]) => {
                          const mi = menu.find((x) => x.id === id)
                          if (!mi) return null
                          return (
                            <div key={id} className="flex items-center gap-2 rounded-xl border border-stone-100 bg-stone-50/60 px-3 py-2.5 text-sm">
                              <SaleCartLineName mi={mi} qty={qty} />
                              <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="-1" onClick={() => setSaleCart((pr) => { const q = (pr[id] || 0) - 1; const nx = { ...pr }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })}>−</Button>
                              <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="+1" onClick={() => setSaleCart((pr) => ({ ...pr, [id]: (pr[id] || 0) + 1 }))}>+</Button>
                              <CartNoteButton mode="sale" k={id} name={mi.name} />
                              <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{fmtEUR(mi.price * qty)}</span>
                            </div>
                          )
                        }),
                        // OSS-10 B-del (v1.210.0): vrstice variant (mobilni list košare)
                        ...saleVariants.map((l) => {
                          const mi = menu.find((x) => x.id === l.menuItemId)
                          if (!mi) return null
                          return (
                            <div key={l.key} className="flex items-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-3 py-2.5 text-sm">
                              {/* §28: tap na vrstico = podrobnosti (opomba) */}
                              <button type="button" onClick={() => openNotePick('sale', l.key, orderItemDisplayName(mi.name, l.optionNames))} title={saleNotes[l.key] || t('posn.add', { name: orderItemDisplayName(mi.name, l.optionNames) })} aria-label={saleNotes[l.key] ? t('posn.edit', { note: saleNotes[l.key].slice(0, 40) }) : t('posn.add', { name: orderItemDisplayName(mi.name, l.optionNames) })} className="flex min-h-11 min-w-0 flex-1 flex-col rounded-md px-1 py-1 text-left hover:bg-stone-100">
                                <span className="min-w-0 truncate font-medium leading-tight">{l.qty}× {orderItemDisplayName(mi.name, l.optionNames)}</span>
                                {l.optionPrice > 0 ? <span className="min-w-0 truncate text-xs leading-tight text-stone-400">{t('orders.variantSurcharge')}: +{fmtEUR(l.optionPrice)}</span> : null}
                                {saleNotes[l.key] ? <span className="min-w-0 truncate text-xs leading-tight text-amber-800">ℹ {saleNotes[l.key]}</span> : null}
                              </button>
                              <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="-1" onClick={() => setSaleVariants((pr) => changePosVariantLineQty(pr, l.key, -1))}>−</Button>
                              <Button size="sm" variant="outline" className="h-9 w-9 shrink-0 p-0 text-base" aria-label="+1" onClick={() => setSaleVariants((pr) => addPosVariantLine(pr, l))}>+</Button>
                              <CartNoteButton mode="sale" k={l.key} name={orderItemDisplayName(mi.name, l.optionNames)} />
                              <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{fmtEUR((mi.price + l.optionPrice) * l.qty)}</span>
                            </div>
                          )
                        }),
                      ]
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
            {/* ISSUE #73 audit-33: kratka pomoč ob prvem vhodu v KDS modul —
                geste (tap = napredek, dolg pritisk = razprodano) in izrazi
                (izdajna postaja), ki jih ni moglo biti na gumbe. Odpoved
                (X) se zapomni v localStorage. */}
            <ModuleIntro module="kds" titleKey="intro.kds.title" bodyKey="intro.kds.body" />
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
              {/* v1.232.0: LIVE oznaka — SSE pretok je povezan (spremembe v ~3–5 s;
                  polling 15 s ostaja kot fallback, oznaka ne laže ob padcu). */}
              {kdsLive && (
                <span data-region="kds-live" className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800" title={t('kds.liveTitle')}>
                  <span className="relative flex size-2" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-600" />
                  </span>
                  {t('kds.live')}
                </span>
              )}
              <label className="flex items-center gap-1.5 text-xs text-stone-600 cursor-pointer">
                <Switch checked={kdsSound} onCheckedChange={setKdsSound} aria-label={t('kds.sound')} />
                <Volume2 className="w-3.5 h-3.5" /> {t('kds.sound')}
              </label>
              {/* v1.244.0 (§18 B): ZAKLEP ZASLONA — vrstice nedejavne, izdaja blokirana
                  (pomotični bumpi; Lightspeed »Lock prep station displays« nov 2026). */}
              <Button
                size="sm"
                variant={kdsViewOnly ? 'default' : 'outline'}
                className={`gap-1 ${kdsViewOnly ? 'bg-amber-600 hover:bg-amber-700' : ''}`}
                aria-pressed={kdsViewOnly}
                aria-label={t('kds.viewOnlyOn')}
                title={kdsViewOnly ? t('kds.viewOnlyHint') : t('kds.viewOnlyOn')}
                onClick={() => { const v = !kdsViewOnly; setKdsViewOnly(v); kdsPersist('ro_kds_view_only', v ? '1' : '0') }}
              >
                {kdsViewOnly ? <Lock className="w-3.5 h-3.5" aria-hidden /> : <LockOpen className="w-3.5 h-3.5" aria-hidden />}
                <span className="hidden sm:inline">{kdsViewOnly ? t('kds.viewOnly') : t('kds.viewOnlyOn')}</span>
              </Button>
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
              {/* §38 (v1.264.0, Square Vol 16 »Draggable ticket reordering on KDS«):
                  NAČIN ZAPOREDJA — Default (izpeljani časovni red) ali Manual (ročno
                  razvrščeni listki po strežniški sekvenci; na listkih se pokažeta ročaj
                  + tipki premika). PER NAPRAVA (ro_kds_ticket_order, Issue #74 družina);
                  sekvenca se deli z ostalimi Manual napravami lokacije (Square: sync
                  »with the same mode«). Pre-DDL: preklop deluje (lokalna preferenca),
                  vlečenje/tipke pa onemogočene z nasvetom kds.reorderPending. */}
              {!kdsCustomView && (
                <div className="inline-flex rounded-lg border border-stone-300 bg-white p-0.5" role="group" aria-label={t('kds.orderModeTitle')}>
                  {(['default', 'manual'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={kdsTicketOrder === m}
                      aria-label={m === 'default' ? t('kds.orderModeDefault') : t('kds.orderModeManual')}
                      title={m === 'default' ? t('kds.orderModeDefault') : `${t('kds.orderModeManual')} — ${t('kds.orderModeTitle')}`}
                      onClick={() => { setKdsTicketOrder(m); kdsPersist('ro_kds_ticket_order', m) }}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                        kdsTicketOrder === m ? 'bg-emerald-700 text-white shadow-sm' : 'text-stone-600 hover:text-stone-900'
                      }`}
                    >
                      {m === 'default' ? <Clock className="w-3.5 h-3.5" aria-hidden /> : <ListOrdered className="w-3.5 h-3.5" aria-hidden />}
                      <span className="hidden sm:inline">{m === 'default' ? t('kds.orderModeDefault') : t('kds.orderModeManual')}</span>
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
                  {/* §41 (v1.267.0): STREŽNIŠKI PROFIL POSTAJE — shranjevanje/
                      obnova nastavitev zaslona PO POSTAJI (nova/zamenjana tablica
                      samodejno dobi zadnji profil ob izbiri postaje; gumbi sta
                      vedno na voljo tudi ročno). */}
                  <div className="space-y-2 border-t border-stone-200 pt-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{t('kds.profileTitle')}</p>
                    <p className="text-xs text-stone-500">
                      {t('kds.profileHint')}
                      {kdsProfiles[kdsStation] ? (
                        <> · {t('kds.profileExisting', { when: new Date(kdsProfiles[kdsStation].savedAt || Date.now()).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), who: kdsProfiles[kdsStation].savedBy || '—' })}</>
                      ) : null}
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Button
                        size="sm"
                        className="h-9 gap-1 bg-emerald-700 hover:bg-emerald-800"
                        disabled={kdsProfileBusy}
                        onClick={() => void saveKdsStationProfile()}
                        aria-label={t('kds.profileSaveAria', { station: kdsStation === 'ALL' ? t('kds.all') : kdsStation === 'KITCHEN' ? t('menu.stationKitchen') : kdsStation === 'BAR' ? t('menu.stationBar') : kdsStation })}
                      >
                        <Save className="w-3.5 h-3.5" aria-hidden /> {t('kds.profileSave')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 gap-1"
                        disabled={kdsProfileBusy || !kdsProfiles[kdsStation]}
                        onClick={restoreKdsStationProfile}
                        aria-label={t('kds.profileRestoreAria', { station: kdsStation === 'ALL' ? t('kds.all') : kdsStation === 'KITCHEN' ? t('menu.stationKitchen') : kdsStation === 'BAR' ? t('menu.stationBar') : kdsStation })}
                      >
                        <History className="w-3.5 h-3.5" aria-hidden /> {t('kds.profileRestore')}
                      </Button>
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
                viewOnly={kdsViewOnly}
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
              /* v1.236.0: listek ostane v vrsti tudi, ko so VSE postavke preklicane
                 (voidedItems) — kuhinja mora VIDETI »vse preklicano« (Toast), ne da
                 bi listek tiho izginil sredi priprave. */
              const kdsQueue = viewKitchen
                .filter((o) => o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
                  || (o.voidedItems ?? []).some((it) => kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
                .slice()
                .sort((a, b) => Number(isStaleKdsTicket(kdsMinutes(a.createdAt))) - Number(isStaleKdsTicket(kdsMinutes(b.createdAt))))
              const kdsActive = kdsQueue.filter((o) => !isStaleKdsTicket(kdsMinutes(o.createdAt)))
              const kdsStale = kdsQueue.filter((o) => isStaleKdsTicket(kdsMinutes(o.createdAt)))
              /* v1.233.0 (PRIMERJAVA §11; Toast julij 2026 »Start Queue«): VRSTA —
                 naročila, katerih postavke (v tej vedi) so ŠE VSE PENDING (brez
                 požiga) — kuhinja vidi prihajajočo obremenitev, preden natakar
                 pošlje. v1.258.0 (PRIMERJAVA §32, Square Vol 13 »KDS draft tickets«):
                 ista množica je zdaj OSNUTKI — lastni zložljiv oddelek (zloženo =
                 pilule v1.233.0, razprto = polni predogled listkov). */
              const kdsIncoming = kdsQueue.filter((o) => kdsIsDraftOrder(o))
              /* v1.258.0 (§32 B2): aktivna vrsta šteje SAMO kuhanje — osnutki
                 (nedotaknjeni s požigom) izpadejo iz »Aktivna izmena« (kdsDraftIdSet
                 na ravni komponente — en vir resnice za oddelek/prazno stanje/all-day;
                 zastareli osnutki ostanejo v ZASTARELO revizijski veji). */
              const kdsActiveLive = kdsActive.filter((o) => !kdsDraftIdSet.has(o.id))
              /* §38 (v1.264.0, Square Vol 16 »Draggable ticket reordering on KDS«):
                 ROČNO ZAPOREDJE — Manual način (per naprava) sortira aktivno
                 izmeno po strežniški sekvenci (ASC; brez mesta → konec po
                 createdAt — novi listki prihajajo ZA ročno razvrščenimi,
                 luknje po izginulih asc sort preskoči). Default = sedanji
                 izpeljani red (byte-identična zgodovina — sekvenca obstaja,
                 a je naprava ne upošteva, Square: »same mode«). Osnutki (§32)
                 in zastareli (Issue #70 §2) obdržijo svoj red — prihodnji
                 tok / revizijska veja, ne ročna vrsta. */
              const kdsManualList = kdsTicketOrder === 'manual'
                ? applyManualTicketOrder(kdsActiveLive, (o) => kdsSequences[o.id], (o) => o.createdAt)
                : kdsActiveLive
              const kdsManualIds = kdsManualList.map((o) => o.id)
              const renderKdsTicket = (o: (typeof viewKitchen)[number], draft = false, manualIdx = -1) => {
                const items = o.items.filter((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
                const ageMin = kdsMinutes(o.createdAt)
                const stale = isStaleKdsTicket(ageMin)
                /* v1.236.0 (PRIMERJAVA §13, Toast KDS »Flash Changes«): UTRIP ob novem
                   oz. spremenjenem listku — kuhar pri steni 10 listkov vidi, KATERI se
                   je pravkar spremenil. Preklicane postavke (voidedItems, Toast: ostanejo
                   prečrtane + alarm) — izločene iz vseh štetij, čisto informacija. */
                const flashTicket = !!kdsFlash.tickets[o.id]
                const flashItems = items.filter((it) => kdsFlash.items[it.id])
                const voidedHere = (o.voidedItems ?? []).filter((it) => kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)
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
                       border-{color} pride ZA njim — najprej nevtralen border, nato leva.
                       v1.258.0 (§32 B3): OSNUTEK listek — amber ČRTKAN obroč + bledlo
                       (vizualno jasno »še ni poslano k nam«; črtkano loči od zastarelega
                       kamna, amber od žive starosti). */
                    className={`relative ${kdsDensityCls.card} border-l-4 ${draft ? 'border-dashed border-amber-300 border-l-amber-400 bg-amber-50/40' : stale ? 'border-dashed border-stone-300 border-l-stone-300 bg-stone-50' : kdsAgeBorderCls(ageCls)}`}
                  >
                    {/* v1.236.0 (Toast KDS »Flash Changes«): NOV listek — utripajoči
                        oranžni OBROČ. Čist prekrivni prazen span (pointer-events-none):
                        utripa SAMO obroč, vsebina listka ostane berljiva (animate-pulse
                        na Card bi zatemnjeval tudi besedilo). */}
                    {flashTicket && (
                      <span data-region="kds-flash-ring" aria-hidden className="pointer-events-none absolute -inset-1 rounded-xl ring-4 ring-orange-400/80 animate-pulse" />
                    )}
                    <CardHeader data-region="kds-ticket-header" className="gap-2 px-4 pt-0 pb-0 sm:px-6">
                      <CardTitle className="text-base flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                        {/* §38 (v1.264.0, Square Vol 16 »Draggable ticket reordering on
                            KDS«): ROČAJ + tipki premika — SAMO v Manual načinu in samo na
                            ŽIVIH (ne-osnutkih, ne-zastarelih) listkih. Ročaj = pointer
                            vlečenje (miška + dotik; aria-hidden — tipkovnična pot sta
                            tipki ↑/↓, a11y); ob zaklepu zaslona ali pre-DDL onemogočeno
                            z nasvetom (migrBox vzorec v1.197/§37). */}
                        {kdsTicketOrder === 'manual' && !draft && !stale && (
                          <span data-region="kds-ticket-reorder" className="inline-flex items-center gap-0.5 shrink-0">
                            <span
                              aria-hidden
                              title={kdsTicketDragAllowed ? t('kds.dragHandle') : kdsViewOnly ? t('kds.viewOnlyHint') : t('kds.reorderPending')}
                              onPointerDown={(e) => kdsTicketPointerDown(e, o.id, kdsManualIds)}
                              className={`-ml-1 inline-flex h-9 w-7 items-center justify-center rounded ${kdsTicketDragAllowed ? 'cursor-grab touch-none text-stone-400 hover:bg-stone-100 hover:text-stone-700 active:cursor-grabbing' : 'cursor-not-allowed text-stone-300'}`}
                            >
                              <GripVertical className="h-4 w-4" />
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={!kdsTicketDragAllowed || manualIdx <= 0}
                              onClick={() => kdsTicketMove(kdsManualIds, o.id, -1)}
                              aria-label={t('kds.moveUp')}
                              title={t('kds.moveUp')}
                            >
                              <ChevronUp className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={!kdsTicketDragAllowed || manualIdx < 0 || manualIdx >= kdsManualIds.length - 1}
                              onClick={() => kdsTicketMove(kdsManualIds, o.id, 1)}
                              aria-label={t('kds.moveDown')}
                              title={t('kds.moveDown')}
                            >
                              <ChevronDown className="h-4 w-4" aria-hidden />
                            </Button>
                          </span>
                        )}
                        {/* ISSUE #74 V-8: nazivna vrstica sledi velikosti pisave (S=13 → XL=22 px) */}
                        <span className={`font-bold truncate max-w-full min-w-0 ${kdsFont.title}`}>{o.table?.name || orderTypeL(o.type)}</span>
                        {/* Issue #71 audit-2: tip naročila je ZNAČKA ob naslovu (miza = identiteta),
                            ne surovi enum; podnaslov #num + ura brez sekund + osebe + natakar */}
                        <span className="inline-flex shrink-0 items-center rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-xs font-semibold text-stone-600">{orderTypeL(o.type)}</span>
                        {o.employee?.name && <span className="text-xs font-normal text-stone-400 min-w-0 shrink truncate" title={o.employee.name}>· {o.employee.name}</span>}
                        <span className="text-xs font-normal text-stone-500 min-w-0 shrink">#{o.orderNumber ?? '?'} · {new Date(o.createdAt).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })} · {tN('kds.guestsShort', 'oseba', o.guests)}</span>
                        {/* v1.236.0 (Toast KDS »Flash Changes«): značka NOVO (nov listek)
                            oz. +n (dodane postavke na obstoječem) — 10 s po utripu izgine
                            (»recently fulfilled tickets stop flashing« — Toast okt 2026). */}
                        {flashTicket && (
                          <span data-region="kds-flash-new" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-orange-300 bg-orange-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-orange-800 animate-pulse">
                            <Zap className="w-3 h-3" aria-hidden /> {t('kds.newTicket')}
                          </span>
                        )}
                        {!flashTicket && flashItems.length > 0 && (
                          <span data-region="kds-flash-items" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-800">
                            <Zap className="w-3 h-3" aria-hidden /> {t('kds.newItems', { n: flashItems.length })}
                          </span>
                        )}
                        {/* PRIMARNI STATUS — v1.129.0 (Toast/Square): NEVTRALEN obrobec (stone)
                            — RDEČA je rezervirana IZKLJUČNO za zamudo (starost listka),
                            polnjena barva statusa se je kuharjem zlivala z alarmno barvo.
                            v1.258.0 (§32 B3): OSNUTEK — pilula statusa se nadomesti z
                            izrecno značko OSNUTEK (amber, ikona peska): ODPRTO/POSLANO
                            sta si bila vizualno preveč podobna, kuhar ob steni ni mogel
                            hitro presoditi, ali je listek ŽE poslan k njim. */}
                        {draft ? (
                          <span data-region="kds-draft-badge" title={t('kds.draftHint')} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-900">
                            <Hourglass className="w-3.5 h-3.5 shrink-0" aria-hidden /> {t('kds.draftBadge')}
                          </span>
                        ) : (
                          <span className={`ml-auto inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide border ${o.status === 'SENT' ? 'border-stone-300 bg-stone-50 text-stone-700' : o.status === 'PREPARED' || o.status === 'READY' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-stone-300 bg-stone-50 text-stone-700'}`} title={stL(o.status)}>
                            {stL(o.status)}
                          </span>
                        )}
                      </CardTitle>
                      <div data-region="kds-ticket-timer-row" className="flex items-center gap-2 flex-wrap">
                        {/* ČASOVNIK — v1.141.0: ODBROJEVALNI kuharjev zorni kot (še-MM:SS do
                            praga zamude; prek → ZAMUDA +MM:SS rdeče). Prag = najvišji
                            postajni cilj listka (kdsTargetOf) ali globalni late prag.
                            v1.258.0 (§32 B3): OSNUTEK ga NE DOBIVA — odbrojevanje je
                            obljuba kuhanju, osnutek pa še ni bil poslan; namesto njega
                            pasivna amber starost vnosa (BREZ rdeče eskalacije — lažni
                            alarm na steni, medtem ko natakar še vnosa, je bil vrzel 2). */}
                        {draft ? (
                          <span
                            data-region="kds-draft-age"
                            className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold tabular-nums text-amber-800 shrink-0"
                            title={t('kds.draftWaiting')}
                          >
                            <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden />
                            {t('kds.draftAge', { m: ageMin })}
                          </span>
                        ) : (
                          <KdsCountdownPill
                            createdAt={o.createdAt}
                            lateMin={(() => {
                              const tt = Math.max(0, ...items.map((it) => kdsTargetOf(it) ?? 0))
                              return kdsLateThreshold(tt > 0 ? tt : null, kdsAgeTh)
                            })()}
                            stale={stale}
                            staleNode={(
                              <span
                                data-region="kds-ticket-timer"
                                className="text-sm font-extrabold tabular-nums px-2.5 py-1 rounded-full border bg-stone-100 text-stone-600 border-stone-300"
                                title={`${t('kds.stale')} — ${t('kds.minutes', { m: ageMin })}`}
                              >
                                {t('kds.stale')}: {t('kds.staleHours', { h: staleTicketHours(ageMin) })}
                              </span>
                            )}
                            fontCls={kdsFont.timer}
                            pillCls={kdsAgePillCls(ageCls)}
                            ageMin={ageMin}
                          />
                        )}
                        {/* v1.232.0 (PRIMERJAVA §3, Lightspeed KDS »Prep ETA«): OBETANA URA
                            PRIPRAVE listka — natakarju povedljiv ODGOVOR (»miza 12 bo
                            pripravljena ob 19:42«) namesto odbrojevanja. ETA = ura
                            naročila + cilj NAJZAHTVNEJŠE postaje na listku (isti vir kot
                            prag zamude — enoten vir resnice); brez cilja postaje ga
                            iskreno NE pokažemo (ne izmišljujemo si obljub). Ob preteku
                            ETA postane rdeč — obljuba je prekinjena, naknadna zelena
                            izdaja bi lagala. */}
                        {(() => {
                          /* v1.258.0 (§32 B3): OSNUTEK brez ETA — obljuba priprave se
                              začne s pošiljanjem, ne z vpisom prve postavke. */
                          if (draft) return null
                          const tt = Math.max(0, ...items.map((it) => kdsTargetOf(it) ?? 0))
                          if (tt <= 0 || stale) return null
                          const etaMs = new Date(o.createdAt).getTime() + tt * 60000
                          const etaOver = Date.now() > etaMs
                          const etaTime = new Date(etaMs).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
                          return (
                            <span
                              data-region="kds-ticket-eta"
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold tabular-nums shrink-0 ${
                                etaOver ? 'border-red-300 bg-red-50 text-red-800' : 'border-stone-300 bg-stone-50 text-stone-600'
                              }`}
                              title={t('kds.etaTitle', { m: tt })}
                            >
                              <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden />
                              {t('kds.eta')} {etaTime}
                            </span>
                          )
                        })()}
                        {/* v1.141.0: kompaktni listki — tiskanje IKONSKO (naslov v tooltipu),
                            v normalni gostoti pa besedilno kot prej */}
                        <span className="ml-auto flex gap-1.5 shrink-0">
                          <Button size="sm" variant="outline" className={kdsDensity === 'compact' ? 'h-11 w-11 p-0' : 'gap-1 h-11 text-xs'} onClick={() => void printKitchenTicket(o, 'KITCHEN')} title={t('kitchen.printKitchenTitle')} aria-label={t('kitchen.printKitchenTitle')}>
                            <Printer className="w-4 h-4" /> {kdsDensity !== 'compact' && t('kitchen.kitchenTicket')}
                          </Button>
                          <Button size="sm" variant="outline" className={kdsDensity === 'compact' ? 'h-11 w-11 p-0' : 'gap-1 h-11 text-xs'} onClick={() => void printKitchenTicket(o, 'BAR')} title={t('kitchen.printBarTitle')} aria-label={t('kitchen.printBarTitle')}>
                            <Printer className="w-4 h-4" /> {kdsDensity !== 'compact' && t('kitchen.barTicket')}
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
                            {/* v1.270.0 — n-od-m (tN2): {x} = postavkaGen kaže rodilnik po m;
                                besedna zveza »1 od 2 postavk« z rodilniško paradigmo v noun.* */}
                            {tN2('kds.unconfirmedAllergens', 'postavkaGen', unconfirmedCount, 'postavkaGen', items.length)}
                          </p>
                        </div>
                      )}
                      {/* v1.232.0 (PRIMERJAVA §3, Toast/Square »course grouping«):
                          postavke istega tečaja pod ENO glavo (coursing — kuhar vidi,
                          kaj gre SKUPAJ na mizo). Brez tečajev na listku = ena skupina
                          brez glave = ISTITA flat seznam kot prej (ničelna regresija).
                          §39 (v1.265.0, Square Vol 16 »Fire held courses from an Expo
                          KDS«): glava ZADRŽANEGA (pending) tečaja na ŽIVEM listku je
                          TAP TARČA ekspeditorja — prvi tap oboroži (3 s odštevanje),
                          drugi tap prekliče, potek pošlje fire. Dostop: orders.create
                          (POS) ALI kitchen.update + per-lokacijska nastavitev (strežnik
                          je avtoritativa — to je samo prikaz dostopa). Osnutki (§32),
                          zastareli (#70), zaklep zaslona (§18 B) in že poslani tečaji
                          glave ostanejo pasivne (isti izris kot prej). */}
                      {groupKdsItemsByCourse(items, o.courses ?? []).map((g) => (
                        <Fragment key={g.courseId ?? 'no-course'}>
                          {g.courseId && (() => {
                            const expoCourseId = g.courseId
                            const expoArmedHere = kdsFireArmLive?.orderId === o.id && kdsFireArmLive.courseId === expoCourseId
                            const expoArmable = !draft && !stale && !kdsViewOnly && !g.fired
                              && (canManage || perms.includes('orders.create') || (perms.includes('kitchen.update') && kdsExpoFireLocs[o.locationId ?? ''] === true))
                            if (!expoArmable) {
                              return (
                                <p data-region="kds-course-group" className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-stone-600">
                                  <Flame className={`w-3.5 h-3.5 shrink-0 ${g.fired ? 'text-orange-600' : 'text-stone-400'}`} aria-hidden />
                                  {g.courseNumber}. {g.label}{g.fired ? ' 🔥' : ''}
                                </p>
                              )
                            }
                            const remainSec = expoArmedHere ? expoFireCountdownSeconds(kdsFireArmLive.until, Date.now()) : 0
                            return (
                              <button
                                type="button"
                                data-region="kds-course-group"
                                aria-label={expoArmedHere ? t('kds.expoFireArmed', { s: remainSec }) : t('kds.expoFireArm', { name: g.label })}
                                title={expoArmedHere ? t('kds.expoFireArmed', { s: remainSec }) : t('kds.expoFireHint')}
                                onClick={() => {
                                  if (expoArmedHere) {
                                    setKdsFireArm(null)
                                    toast({ description: t('kds.expoFireCancel', { name: g.label }) })
                                  } else {
                                    setKdsFireArm({ orderId: o.id, courseId: expoCourseId, label: g.label, until: Date.now() + KDS_EXPO_FIRE_COUNTDOWN_MS })
                                  }
                                }}
                                className={`flex w-full items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide min-h-8 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${
                                  expoArmedHere
                                    ? 'border-amber-400 bg-amber-100 text-amber-900 animate-pulse'
                                    : 'border-stone-300 bg-stone-100 text-stone-600 hover:border-amber-300 hover:bg-amber-50 active:bg-amber-100'
                                }`}
                              >
                                <Flame className={`w-3.5 h-3.5 shrink-0 ${expoArmedHere ? 'text-amber-600' : 'text-stone-400'}`} aria-hidden />
                                {g.courseNumber}. {g.label}
                                {expoArmedHere && (
                                  <span data-region="kds-expo-fire-countdown" className="ml-auto tabular-nums normal-case">· {remainSec} s</span>
                                )}
                              </button>
                            )
                          })()}
                          {g.items.map((it) => {
                        const mi = menu.find((x) => x.name === it.name && (x.station || 'KITCHEN') === (it.station || 'KITCHEN'))
                        const itAge = kdsItemAge(it, o)
                        // Issue #14: tasked items are managed by the station flow — the legacy
                        // queue shows per-station sync chips instead of status buttons (no 409s)
                        const itemTasks = kdsTasks.filter((task) => task.itemId === it.id)
                        /* ISSUE #73 audit-22: row = TAP-CARD. The whole row is the tap
                           target for the MAIN progress (queued → preparing → ready);
                           the 86 sold-out toggle moves to a long-press (550 ms), print
                           stays in the ticket header (#69 layout). Tasked items and
                           ready items render inert. */
                        const itInteractive = !kdsViewOnly && itemTasks.length === 0 && (it.status === 'PENDING' || it.status === 'PREPARING')
                        const itNext = it.status === 'PENDING' ? t('kds.stInPrep') : it.status === 'PREPARING' ? t('kds.stMarkReady') : ''
                        const can86 = perms.includes('menu.availability') && !!mi
                        /* E2E lekcija: NEDEJAVNA vrstica (READY s Servirano gumbom,
                           postajni tok) je navaden div — aria-disabled ovojnica bi
                           bralcem zaslonov javila gumb Servirano kot onemogočen. */
                        const itFlash = !!kdsFlash.items[it.id]
                        /* v1.237.0 (PRIMERJAVA §14, Toast KDS »horizontal modifier display
                           mode«): izbrane opcije postavke — kuhar vidi TOČNO, kaj
                           pripraviti (»0,5 L«, »zveča sira«), ne samo ime artikla. */
                        const itMods = it.modifiers ?? []
                        const itRow = (rowBody: ReactNode) => itInteractive ? (
                          <KdsTapCard
                            key={it.id}
                            dataRegion="kds-ticket-item"
                            ariaLabel={t('kds.tapAria', { q: it.qty, name: it.name, next: itNext })}
                            onAdvance={() => {
                              if (it.status === 'PENDING') setItemStatus(it.id, 'PREPARING')
                              else bumpReady(it, o)
                            }}
                            onLongPress={can86 ? () => {
                              void kdsToggleAvailable(mi)
                              toast({ description: t(mi.available ? 'kds.86Done' : 'kds.86Back', { name: it.name }) })
                            } : undefined}
                            longPressHint={can86 ? t('kds.tapHint') : undefined}
                            className={`rounded-lg border bg-white px-3 py-1.5 space-y-1.5 min-w-0 hover:border-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:bg-stone-50 ${itFlash ? 'border-orange-400 bg-orange-50 ring-2 ring-orange-300/60' : 'border-stone-200'}`}
                          >
                            {rowBody}
                          </KdsTapCard>
                        ) : (
                          <div key={it.id} data-region="kds-ticket-item" className={`rounded-lg border bg-white px-3 py-1.5 space-y-1.5 min-w-0 ${itFlash ? 'border-orange-400 bg-orange-50 ring-2 ring-orange-300/60' : 'border-stone-200'}`}>
                            {rowBody}
                          </div>
                        )
                        return itRow(
                          <>
                            {/* A: količina + ime (levo) / starost postavke (desno) — hitro skeniranje */}
                            <div className="flex items-baseline justify-between gap-2 min-w-0">
                              <p className="text-sm sm:text-base font-semibold truncate min-w-0">
                                {it.qty}× {it.name}
                                {/* v1.236.0: pravkar DODANA postavka — utripajoči čip NOVO
                                    (Toast: kuhar vidi, KAJ je novega na listku, ne le da se
                                    je »nekaj« spremenilo) */}
                                {itFlash && <span data-region="kds-item-new" className="ml-1.5 inline-flex items-center gap-0.5 rounded-full border border-orange-300 bg-orange-100 px-1.5 py-0.5 text-[11px] font-bold uppercase text-orange-800 animate-pulse align-middle">+ {t('kds.newTicket')}</span>}
                              </p>
                              {/* OPS-9 val 3: per-item live timer (firedAt → order clock); OPS-11 val 1: red escalation per station (target → max(10, ceil(target×1.25))) */}
                              {/* Issue #70 §2: zastareli listki — starost postavke v urah (ne "13.496′") */}
                              {/* v1.258.0 (§32 B3): OSNUTEK — postavka nosi NEVTRALNO amber
                                  starost (brez rdeče eskalacije): kuhinja še ni bila prosena
                                  kuhati, minuta vnosa ni zamuda. */}
                              <span className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-full border shrink-0 ${draft ? 'bg-amber-50 text-amber-800 border-amber-300' : stale ? 'bg-stone-100 text-stone-600 border-stone-300' : kdsAgeClass(itAge, delayThresholdForTarget(kdsTargetOf(it)))}`}>{stale ? t('kds.staleHours', { h: staleTicketHours(itAge) }) : `${itAge}′`}</span>
                            </div>
                              {/* v1.237.0 (PRIMERJAVA §14, Toast KDS horizontalni prikaz):
                                  izbrane opcije v ENI vrstici pod imenom — Toast
                                  avgust 2026: horizontal mode prihrani vertikalni
                                  prostor (več listkov na zaslon); prej jih KDS sploh
                                  ni videl (API jih ni nosil). Prazno = brez vrstice
                                  (nič regresije gostote). */}
                              {itMods.length > 0 && (
                                <p data-region="kds-item-modifiers" className="text-xs sm:text-sm font-semibold text-stone-600 min-w-0 break-words" title={itMods.join(' · ')}>
                                  <span className="sr-only">{t('kds.itemOptions')}: </span>{itMods.join(' · ')}
                                </p>
                              )}
                            {/* B: postaja + potrjeni alergeni (jantorni čipi) + opomba — ločena vrstica.
                                Issue #71 audit-14: RDEČ pas je ZDAJ samo na vrhu listka (resnične alergije);
                                per-item opozorilo ostane rdeče, vendar kot pas, ne majhen čip. */}
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <Badge variant="outline" className="shrink-0">{it.station === 'BAR' ? t('menu.stationBar') : t('menu.stationKitchen')}</Badge>
                              {/* v1.261.0 (PRIMERJAVA §35): sedež postavke na KDS — isti vir
                                  resnice kot tisk (OrderItem.seat od v1.193.0); ključ je
                                  re-uporabljen iz plačilnega dialoga (0 duplikatov). */}
                              {it.seat != null && (
                                <span
                                  data-region="kds-seat-chip"
                                  className="inline-flex items-center rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-700 shrink-0"
                                >
                                  {t('payment.seatsAssign', { n: it.seat })}
                                </span>
                              )}
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
                            {/* C: stanje + NASLEDNJI KORAK — ISSUE #73 audit-22: vrstica je
                                tap-karta; naslednji korak napoveduje velik emerald čip
                                (dominanten, min 44 px), ne trije enakovredni gumbi.
                                v1.129.0 disciplina o 44 px ciljih ostaja (KDS JE dotik). */}
                            <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
                              {itemTasks.length > 0 ? (
                                <span className="flex flex-wrap gap-1 justify-end" role="group" aria-label={t('kds.stStatsTitle')}>
                                  {itemTasks.map((task) => <KdsTaskChip key={task.id} task={task} />)}
                                </span>
                              ) : it.status === 'PENDING' || it.status === 'PREPARING' ? (
                                <span
                                  data-region="kds-next-chip"
                                  aria-hidden
                                  className={`ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-bold shrink-0 ${
                                    it.status === 'PREPARING' ? 'bg-emerald-700 text-white' : 'bg-stone-800 text-white'
                                  }`}
                                >
                                  {it.status === 'PENDING' ? <Play className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                                  {itNext}
                                </span>
                              ) : it.status === 'READY' ? (
                                <div className="flex items-center gap-1.5">
                                  <Badge className={statusColors.READY}>{t('status.READY')}</Badge>
                                  {/* OPS-7 (v1.70.0): SERVED bump (Lightspeed vzorec — izloči iz vrste) */}
                                  <Button size="sm" variant="outline" className="h-11" onClick={() => setItemStatus(it.id, 'SERVED')}>{t('status.SERVED')}</Button>
                                </div>
                              ) : null}
                            </div>
                          </>
                        )
                          })}
                        </Fragment>
                      ))}
                      {/* v1.236.0 (PRIMERJAVA §13, Toast KDS): PREKLICANE postavke — prej so
                          se TIHO izgubile s KDS (kuhar je lahko že strt delo). Toast: voided
                          item ostane na listku PREČRTAN + alarm; pri nas tudi rdeč pas + razlog
                          (VoidReason), 30-min okno (strežnik), nato čisto izginejo. Izločene
                          iz vseh štetij (All Day, ESA, pragovi) — čista informacija. */}
                      {voidedHere.length > 0 && (
                        <div data-region="kds-ticket-voided" className="rounded-lg border border-red-300 bg-red-50/70 px-3 py-2 space-y-1" role="status">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-red-700">{t('kds.voidedTitle')}</p>
                          {voidedHere.map((v) => (
                            <div key={v.id} data-region="kds-ticket-voided-row" className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 rounded-md border px-2 py-1 ${kdsFlash.voids[v.id] ? 'border-red-400 bg-red-100/80 animate-pulse' : 'border-red-200 bg-white/60'}`}>
                              <Ban className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden />
                              <p className="text-sm font-semibold text-stone-500 line-through truncate min-w-0">{v.qty}× {v.name}</p>
                              {(v.modifiers ?? []).length > 0 && (
                                <span data-region="kds-voided-modifiers" className="text-xs text-stone-400 line-through truncate max-w-48 shrink-0" title={(v.modifiers ?? []).join(' · ')}>{(v.modifiers ?? []).join(' · ')}</span>
                              )}
                              <span className="text-xs font-bold uppercase text-red-700 shrink-0">{t('kds.voidedItem')}</span>
                              {v.voidReasonName && <span className="text-xs text-red-600 shrink-0 truncate max-w-48" title={v.voidReasonName}>· {v.voidReasonName}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* v1.129.0 (Toast/Square benchmark): bump CELEGA LISTKA — en velik
                          celoširinski gumb (kitchenski dotik, Toast: dvoklik/fulfill listka).
                          Prikazan samo, če so vse odprte postavke LEGACY (brez postajnih
                          nalogov — te upravlja postajni tok) in vsaj ena ni pripravljena.
                          v1.258.0 (§32 B3): OSNUTEK ga NE DOBIVA — »vse pripravljeno« na
                          listku, ki ni bil nikoli poslan, je vektor pomote (Square: osnutek
                          je predogled, ne dejanje). Posamezne postavke ostanejo tap-karte —
                          izrecen zgodnji začetek kuharja listek organično premakne v
                          aktivno vrsto. */}
                      {(() => {
                        if (draft) return null
                        const anyTasked = items.some((it) => kdsTasks.some((task) => task.itemId === it.id))
                        const openItems = items.filter((it) => !it.voided && (it.status === 'PENDING' || it.status === 'PREPARING'))
                        if (anyTasked || openItems.length === 0) return null
                        return (
                          <Button
                            data-region="kds-bump-all"
                            className="w-full h-12 mt-1 text-base font-bold gap-2 bg-emerald-700 hover:bg-emerald-800"
                            disabled={!!kdsBumpBusy || kdsViewOnly}
                            title={kdsViewOnly ? t('kds.viewOnlyHint') : undefined}
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
                  {/* v1.233.0: VRSTA (Start queue) — pasivni predogled, iskreno
                      izostane, ko je prazna; starostni razred po istem viru kot
                      listki (kdsAgeCls + kdsAgePillCls).
                      v1.258.0 (§32 B2, Square Vol 13 »KDS draft tickets«): VRSTA je
                      zdaj ZLOŽENI obraz OSNUTKOV — preklop (44 px, aria-expanded)
                      razkrije POLNE osnutek listke (predogled postavk/opcij/alergenov
                      za predpripravo). Zloženo stanje je PO BARVI GOSTOTI enako
                      v1.233.0 (pilule, kds-start-queue regija) — ničelna regresija. */}
                  {kdsDraftIdSet.size > 0 && (
                    <section data-region="kds-drafts" className="space-y-2 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-2.5" aria-label={t('kds.draftSection')}>
                      <button
                        type="button"
                        onClick={() => setKdsDraftsOpen((v) => !v)}
                        aria-expanded={kdsDraftsOpen}
                        aria-controls="kds-drafts-content"
                        aria-label={t('kds.draftSectionHint')}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-amber-800 hover:bg-amber-100 hover:text-amber-900 transition-colors min-h-11"
                      >
                        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${kdsDraftsOpen ? '' : '-rotate-90'}`} aria-hidden />
                        <span className="truncate min-w-0">{t('kds.draftSection')}</span>
                        <span className="ml-auto shrink-0 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 tabular-nums font-semibold text-amber-900">{tN('kds.staleCount', 'listek', kdsDraftIdSet.size)}</span>
                      </button>
                      <div id="kds-drafts-content">
                        {!kdsDraftsOpen && (
                          <div data-region="kds-start-queue" role="group" aria-label={t('kds.queueTitle')} title={t('kds.queueHint')}
                            className="flex flex-wrap items-center gap-1.5 px-1 pb-0.5">
                            {kdsIncoming.filter((o) => !isStaleKdsTicket(kdsMinutes(o.createdAt))).map((o) => {
                              const qItems = o.items.filter((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket))
                              const qAge = kdsMinutes(o.createdAt)
                              return (
                                <span key={o.id} className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums ${kdsAgePillCls(kdsAgeCls(qAge))}`}>
                                  {o.table?.name || orderTypeL(o.type)} · {qItems.reduce((s, it) => s + (it.qty || 0), 0)}× · {qAge} min
                                </span>
                              )
                            })}
                          </div>
                        )}
                        {kdsDraftsOpen && kdsIncoming.filter((o) => !isStaleKdsTicket(kdsMinutes(o.createdAt))).map((o) => renderKdsTicket(o, true))}
                      </div>
                    </section>
                  )}
                  {kdsActiveLive.length > 0 && (
                    <p data-region="kds-section-active" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-stone-500 px-1">
                      {t('kds.activeShift')}
                      <span className="rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 tabular-nums font-semibold">{tN('kds.staleCount', 'listek', kdsActiveLive.length)}</span>
                    </p>
                  )}
                  {/* §38 (v1.264.0): wrapper aktivne vrste — drop tarče ([data-order-id]
                      elementi berejo kdsComputeDropIndex) + drop indikator (emerald črta
                      pred i-tim listkom / na koncu) + zarisani (opacity) vlečeni listek.
                      space-y-4 = razmak TabsContent (byte-identična gostota brez vlečenja). */}
                  <div data-region="kds-active-list" className="space-y-4">
                    {kdsManualList.map((o, i) => (
                      <div
                        key={o.id}
                        data-order-id={o.id}
                        className={`relative ${kdsDragUi?.id === o.id ? 'opacity-40' : ''} ${
                          kdsDragUi && kdsDragUi.dropIndex === i && kdsDragUi.id !== o.id
                            ? "before:absolute before:-top-2 before:left-2 before:right-2 before:h-1 before:rounded-full before:bg-emerald-600 before:content-['']"
                            : ''
                        }`}
                      >
                        {renderKdsTicket(o, false, i)}
                      </div>
                    ))}
                    {kdsDragUi && kdsDragUi.dropIndex === kdsManualList.length && kdsDragUi.id !== kdsManualList[kdsManualList.length - 1]?.id && (
                      <div aria-hidden className="mx-2 h-1 rounded-full bg-emerald-600" />
                    )}
                  </div>
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
                        <span className="ml-auto shrink-0 rounded-full border border-stone-300 bg-stone-200 px-2 py-0.5 tabular-nums font-semibold">{tN('kds.staleCount', 'listek', kdsStale.length)}</span>
                      </button>
                      {kdsStaleOpen && kdsStale.map((o) => renderKdsTicket(o, false))}
                    </section>
                  )}
                </>
              )
            })()}
            {!kdsCustomView && viewKitchen.filter((o) => o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)) && !kdsDraftIdSet.has(o.id)).length === 0 && (
              /* Vizualni benchmark (Toast KDS): prazno stanje = velik jasni status »kuhinja
                 čista«, ne iskalna vrstica — ko pride listek, dobi 100 % pozornosti.
                 v1.258.0 (§32 B5): osnutki NE ŠTEJEJO za kuhanje — če so na zidu samo
                 osnutki, je kuhinja iskreno čista (osnutki so zgoraj v svojem oddelku). */
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
              /* v1.258.0 (§32 B2): all-day vrstica šteje samo DELO (živi + mešani
                 listki + zastareli) — osnutki niso obljuba kuhanja in je ne napihujejo. */
              const openItems = viewKitchen
                .filter((o) => !kdsDraftIdSet.has(o.id) && o.items.some((it) => !it.voided && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
                .flatMap((o) => o.items.filter((it) => !it.voided && (it.status === 'PENDING' || it.status === 'PREPARING') && (kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)))
              const byName = new Map<string, number>()
              for (const it of openItems) byName.set(it.name, (byName.get(it.name) ?? 0) + it.qty)
              const rows = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sl'))
              if (rows.length === 0) return null
              return (
                <div data-region="kds-allday" className="sticky bottom-0 z-10 rounded-xl border border-amber-300 bg-amber-50/95 dark:border-amber-700/60 dark:bg-stone-950/95 backdrop-blur px-3 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.4)]" role="status" aria-label={t('kds.allDayTitle')}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-xs font-bold uppercase tracking-wide text-amber-900 dark:text-amber-300 min-w-0 shrink-0">{t('kds.allDayTitle')}</p>
                    <p className="text-xs font-medium text-amber-700/80 dark:text-amber-400/70 ml-auto shrink-0" aria-hidden>{rows.length}</p>
                  </div>
                  {/* Toast production view: ENA vrstica z horizontalnim drsenjem (nowrap) —
                      ovijanje čipov je na mobilnem naredilo 800px+ blok, višji od zaslona,
                      in sticky ni mogel prilepiti na dno (izmerjeno: bottom 1137 > vh 844). */}
                  <div className="flex gap-1.5 overflow-x-auto flex-nowrap [scrollbar-width:thin]">
                    {rows.map(([name, qty]) => (
                      <span key={name} className="inline-flex items-baseline gap-1.5 rounded-lg border border-amber-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2.5 py-1 shrink-0 whitespace-nowrap">
                        <span className="text-base font-extrabold tabular-nums text-amber-900 dark:text-amber-400">{qty}×</span>
                        <span className="text-sm font-semibold text-stone-800 dark:text-stone-900">{name}</span>
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
            {/* OSS-10 (v1.209.0): variante postavk — skupine opcij (velikosti/nivoji), prvi admin CRUD */}
            <MenuModifiersCard canManage={hasPerm('menu.manage')} />
            {/* STREŽNI VAL v1.248.0 (§22 B): prednastavljene opombe za kuhinjo —
                registr (Lightspeed Back Office > Menu > Production instructions
                > Notes); POS izbira v košaricah prebere isti vir. */}
            <PresetNotesCard canManage={hasPerm('menu.manage')} />
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
                    <span className="text-xs font-normal text-stone-500 shrink-0">{tN('menu.catCount', 'artikel', g.items.length)}</span>
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
                  <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => setNewRes({ guestName: '', phone: '', guests: 2, reservedAt: '', note: '', tableId: '', source: 'phone', email: '', duration: 120, specialRequests: '', locationId: '', autoTable: true })}>
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
            {/* v1.244.0 (§18 D) — pričakovani gosti čez dan: pokritost po polurnih
                oknih (kuhinja/oddaja vidi naskok, preden se zgodi) */}
            {todayCovers.count > 0 && (
              <Card data-region="resv-covers">
                <CardContent className="pt-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-stone-700">{t('resv.coversTitle')}</h3>
                    <span className="text-xs text-stone-500">{t('resv.coversTotal', { guests: todayCovers.guests, count: todayCovers.count })}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {todayCovers.slots.map((s) => (
                      <span key={s.start} className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs tabular-nums text-stone-700">
                        <span className="font-semibold">{new Date(s.start).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })}</span>
                        <span aria-hidden>·</span>
                        <span>{s.guests}× {t('orders.persons')}</span>
                        <span className="sr-only">({s.count})</span>
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
            {todayCovers.count === 0 && (
              <p className="text-xs text-stone-400">{t('resv.coversEmpty')}</p>
            )}
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
                {/* v1.240.0: kartica se na mobilnem prelomi v stolpec — 4 akcijski
                    gumbi (opomnik/prišel/ni prišel/prekliči) v eni vrsti so štrleli
                    čez 390 px (horizontalni scroll); besedilo ostane min-w-0 nad gumbi. */}
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredRes.map((r) => (
                    <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
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
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <Badge variant="outline">{RES_STATUS_KEYS[r.status] ? t(RES_STATUS_KEYS[r.status]) : r.status}</Badge>
                        {/* v1.245.0 (§19): miza/kombinacija na kartici — ekipa vidi,
                            KJE sedi družba (kombinacija = vse članice, 🔗). */}
                        {(() => {
                          const ids: string[] = (r.tableIds?.length ?? 0) >= 2 ? r.tableIds! : (r.tableId ? [r.tableId] : [])
                          if (ids.length === 0) return null
                          const names = ids.map((id) => viewTables.find((x) => x.id === id)?.name.replace('Miza ', '') ?? '?')
                          return <Badge variant="outline" className="h-5 px-1.5 text-xs bg-stone-50 text-stone-700 border-stone-200">{ids.length >= 2 ? `🔗 Mize ${names.join('+')}` : `🪑 Miza ${names[0]}`}</Badge>
                        })()}
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
            {/* v1.247.0 (PRIMERJAVA §21; Lightspeed april 2026 »saved report views«):
                pogosto poročilo shranjeno enkrat z RELATIVNIM obdobjem — zagon z
                enim klikom poteže svež termin (»ta mesec« je vedno trenutni mesec).
                Gating reports.sales — isti lastnik kot sam izvoz. */}
            {hasPerm('reports.sales') && <SavedViewsCard />}
            {/* P2-13 (v1.189.0) — knjigovodski portal (read-only agregacija; ACCOUNTING tu pristane) */}
            {/* Issue #94 (QA): from/to sta NADZOROVANA iz zavihka — isto obdobje
                velja za kartice portala IN seznam izdanih računov + CSV izvoz. */}
            <AccountingPortalCard from={rcptFrom} to={rcptTo} onFromChange={setRcptFrom} onToChange={setRcptTo} />
            {/* PRIMERJAVA §34 (v1.260.0; Square Vol 13 »revenue centers«): prodaja
                izbranega obdobja grupirana po prihodkovnih centrih — cone miz
                (DINE_IN) + kanala odnes/dostava. ISTE from/to kot portal in
                seznam računov (Issue #94 vzorec); izpeljava ob branju, 0 DDL.
                Gating reports.sales — isti lastnik poročil na zavihku. */}
            {hasPerm('reports.sales') && <RevenueCentersCard from={rcptFrom} to={rcptTo} />}
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => {
                const d = new Date()
                downloadCSV(`racuni-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
                  [t('rcpt.csvNumber'), t('exp.csvDate'), t('wl.thTable'), t('rcpt.csvOrder'), t('rcpt.csvPayMethod'), t('exp.csvAmount'), 'EOR', 'FURS'],
                  ...receiptsInRange.map((r) => [r.invoiceNumber, new Date(r.createdAt).toLocaleString('sl-SI'), r.tableName || '', r.orderNumber ?? '', r.paymentMethod.toUpperCase(), r.total, r.eor, r.fiscalVerified ? 'verified' : r.fiscalStatus]),
                ])
              }}>
                {t('rcpt.exportCsv')}
              </Button>
            </div>
            {/* v1.251.0 (PRIMERJAVA §25; Toast januar 2026 »look up checks by scanning
                the receipt barcode«): skeniranje črtne kode z računa ali ročni vnos
                natisnjene številke — iskanje po VSEH računih obsega, ne samo zadnjih
                100 s seznama. Skener = tipkovnica (koda + Enter, paradigma EAN v1.229).
                Gating reports.sales — isti lastnik kao seznam in izvoz. */}
            {hasPerm('reports.sales') && (
              <Card data-region="receipt-scan">
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ScanBarcode className="w-4 h-4" /> {t('rcpt.scanTitle')}</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      data-testid="receipt-scan-input"
                      className="font-mono"
                      placeholder={t('rcpt.scanPlaceholder')}
                      value={rcptScanCode}
                      onChange={(e) => setRcptScanCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void rcptScanSubmit() } }}
                      aria-label={t('rcpt.scanTitle')}
                    />
                    <Button size="sm" className="gap-1.5 shrink-0" disabled={rcptScanning || !rcptScanCode.trim()} onClick={() => void rcptScanSubmit()}>
                      {rcptScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('rcpt.scanBtn')}
                    </Button>
                  </div>
                  <p className="text-xs text-stone-500 mt-1.5">{t('rcpt.scanHint')}</p>
                  {rcptScanResults !== null && rcptScanResults.length === 0 && (
                    <p className="text-sm text-stone-500 mt-3">{t('rcpt.scanNone')}</p>
                  )}
                  {rcptScanResults !== null && rcptScanResults.length > 1 && (
                    <p className="text-xs text-amber-700 mt-3">{t('rcpt.scanMany', { n: rcptScanResults.length })}</p>
                  )}
                  {rcptScanResults !== null && rcptScanResults.length > 0 && (
                    <div className="mt-3 space-y-2" data-region="receipt-scan-results">
                      {rcptScanResults.map((r) => (
                        <div key={r.id} className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium truncate">{r.invoiceNumber}{r.tableName ? ` · ${r.tableName}` : ''}</p>
                            <p className="text-xs text-stone-500">{new Date(r.createdAt).toLocaleString('sl-SI')} · {r.paymentMethod.toUpperCase()}{r.orderNumber ? ` · ${t('rcpt.orderShort', { n: r.orderNumber })}` : ''}</p>
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <span className="font-bold">{fmtEUR(r.total)}</span>
                            {r.fiscalVerified ? <Badge className="bg-emerald-600 text-white">FURS ✓</Badge> : <Badge variant="outline">{r.fiscalStatus || t('rcpt.unverified')}</Badge>}
                          </div>
                          <div className="shrink-0 flex items-center gap-1 w-full sm:w-auto justify-end">
                            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={printing} onClick={() => printInvoice(r.id)} title={t('payment.printTitle')}>
                              <Printer className="w-3.5 h-3.5" /> {t('common.print')}
                            </Button>
                            {/* v1.256.0 (PRIMERJAVA §30): ponatis listka iz zadetka
                                skeniranja — isti spor (gost prinese stari račun) */}
                            {r.orderId && (
                              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void openReprint(r)} title={t('rcpt.reprintBtnTitle')} aria-label={t('rcpt.reprintBtnTitle')}>
                                <RotateCcw className="w-3.5 h-3.5" /> {t('rcpt.reprintBtn')}
                              </Button>
                            )}
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
                  )}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t('rcpt.title')}</CardTitle></CardHeader>
              <CardContent>
                {receipts.length === 0 && <p className="text-sm text-stone-500">{t('rcpt.none')}</p>}
                {/* Issue #94 (QA): seznam upošteva datumsko obdobje zgoraj — prej je
                    kazal vse račune (do 100 naloženih) ne glede na izbor Od/Do. */}
                {receipts.length > 0 && receiptsInRange.length === 0 && (
                  <p className="text-sm text-stone-500 mb-2">{t('rcpt.noneInRange', { from: rcptFrom, to: rcptTo })}</p>
                )}
                <ScrollArea className="max-h-[60vh]">
                  <div className="space-y-2">
                    {receiptsInRange.map((r) => (
                      <div key={r.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {r.invoiceNumber}
                            {/* Issue #94 (QA): računi iz obdobja pred novo številčno
                                shemo (R-YYYY-NNNNN) so označeni — računovodja ne
                                ugiba, zakaj sta v seznamu dva formata. */}
                            {legacyInvoiceNumber(r.invoiceNumber) && (
                              <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-xs bg-stone-50 text-stone-600 border-stone-200">{t('rcpt.legacyBadge')}</Badge>
                            )}
                            {r.tableName ? ` · ${r.tableName}` : ''}
                          </p>
                          <p className="text-xs text-stone-500">{new Date(r.createdAt).toLocaleString('sl-SI')} · {r.paymentMethod.toUpperCase()}{r.orderNumber ? ` · ${t('rcpt.orderShort', { n: r.orderNumber })}` : ''}</p>
                          {/* Issue #94 (QA): prazen EOR pri nefiskaliziranih računih
                              ne izriše več golih »EOR: « — pove se stanje fiskalizacije. */}
                          <p className="text-xs text-stone-400 font-mono truncate max-w-xs sm:max-w-md">
                            {r.eor ? `EOR: ${r.eor}` : (r.fiscalStatus === 'pending' ? t('rcpt.eorPending') : t('rcpt.eorNone'))}
                          </p>
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
                          {/* v1.256.0 (PRIMERJAVA §30): ponatis kuhinjskega/bar listka
                              zaprtega naročila — samo, če račun nosi orderId */}
                          {r.orderId && (
                            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void openReprint(r)} title={t('rcpt.reprintBtnTitle')} aria-label={t('rcpt.reprintBtnTitle')}>
                              <RotateCcw className="w-3.5 h-3.5" /> {t('rcpt.reprintBtn')}
                            </Button>
                          )}
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

          {/* v1.256.0 (PRIMERJAVA §30; Lightspeed maj 2026 »Reprint orders«):
              ponatis listkov ZAPRTEGA naročila z izbiro produkcijskega središča
              (kuhinja / bar / vse) — vsako s številom postavk, potrditev gre
              čez revizijsko vrata ORDER_TICKET_REPRINT na strežniku. */}
          <Dialog open={!!reprintTarget} onOpenChange={(op) => { if (!op) { setReprintTarget(null); setReprintOrder(null) } }}>
            {/* aria-describedby={undefined} — vzorec v1.202.0+: dialog brez Description
                sicer sproži radix »Missing Description« warning (čista konsola) */}
            <DialogContent aria-describedby={undefined} className="max-w-sm" data-region="reprint-ticket-dialog">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-1.5"><RotateCcw className="w-4 h-4" /> {t('rcpt.reprintTitle')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <p className="text-stone-500">{t('rcpt.reprintHint', { n: reprintTarget?.invoiceNumber ?? '', order: String(reprintTarget?.orderNumber ?? '?') })}</p>
                {!reprintOrder && (
                  <div className="flex min-h-20 items-center justify-center gap-2 text-stone-500" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> {t('common.loading')}
                  </div>
                )}
                {reprintOrder && reprintCounts.ALL === 0 && (
                  <p className="text-stone-500">{t('rcpt.reprintNone')}</p>
                )}
                {reprintOrder && reprintCounts.ALL > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-stone-600">{t('rcpt.reprintStation')}</p>
                    <div role="radiogroup" aria-label={t('rcpt.reprintStation')} className="space-y-1.5">
                      {(['KITCHEN', 'BAR', 'ALL'] as const).map((st) => {
                        const count = reprintCounts[st]
                        const active = reprintStation === st
                        return (
                          <button key={st} type="button" role="radio" aria-checked={active} disabled={count === 0 || reprintBusy}
                            onClick={() => setReprintStation(st)}
                            className={`min-h-11 w-full rounded-lg border px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors ${active ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-stone-200 bg-white hover:bg-stone-50'} ${count === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}>
                            <span className="font-medium">{st === 'KITCHEN' ? t('rcpt.reprintKitchen') : st === 'BAR' ? t('rcpt.reprintBar') : t('rcpt.reprintAll')}</span>
                            <span className="text-xs text-stone-500">{tN('rcpt.reprintItems', 'postavka', count)}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setReprintTarget(null); setReprintOrder(null) }}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800 gap-1.5" disabled={reprintBusy || !reprintOrder || reprintCounts[reprintStation] === 0} onClick={() => void confirmReprint()}>
                  {reprintBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {t('rcpt.reprintConfirm')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <TabsContent value="inzeniring" className="space-y-4">
            {/* OPS-8 v1.71.0 — menu engineering (Kasavana-Smith kvadrant) */}
            <MenuEngineeringTab />
            {/* Issue #17 (v1.106.0) — food-cost varianca (dejanska proti teoretični porabi) */}
            <FoodCostVarianceCard />
            {/* v1.230.0 — taksacija pijače (pour cost, šank) — Clover/Toast benchmark */}
            <PourCostCard />
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

          <TabsContent value="opravila">
            {/* v1.246.0 (PRIMERJAVA §20 — OPERATIVNI VAL): digitalni checklisti
                (Lightspeed Tasks marec 2026). Plošča terminov za VSE prijavljene
                (odpiralni seznam izpolni kdor odpira — isti prag kot delovnica);
                urejevalnik predlog znotraj zavihka gatinga settings.manage. Komponenta
                se sama osveži (POST vrne run — lokalno zrcalo strežniške resnice). */}
            <OpravilaTab />
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
                          <Input aria-label={t('emp.bootNamePlaceholder')} value={bootName} onChange={(e) => setBootName(e.target.value)} placeholder={t('emp.bootNamePlaceholder')} className="max-w-48 h-9 bg-white" />
                          <Input aria-label={t('emp.bootPinPlaceholder')} inputMode="numeric" maxLength={8} value={bootPin} onChange={(e) => setBootPin(e.target.value.replace(/\D/g, ''))} placeholder={t('emp.bootPinPlaceholder')} className="max-w-28 h-9 bg-white" />
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
                        <p className="text-xs text-emerald-700 flex items-center gap-0.5"><ShieldCheck className="w-3 h-3" /> {tN('emp.permsCount', 'dovoljenje', e.permissionOverrides.length)}</p>
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
            <JobsCard jobs={jobs} canManage={hasPerm('inventory.manage')} onReload={load} tipPointsDdlActive={jobsTipDdl} />
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
              <SettingsEditor settings={settings} canManage={hasPerm('settings.manage')} onReload={load} receiptPolicyDdlActive={receiptPolicyDdlActive} />
              {/* Issue #13 (v1.110.0) — javni rezervacijski widget (povezava /r/<token>) */}
              <ReservationWidgetCard />
              {/* v1.244.0 (PRIMERJAVA §18 A) — ritem prihodov (arrival pacing) */}
              <ReservationPacingCard />
              {/* v1.245.0 (PRIMERJAVA §19) — kombinacije miz + rezervabilne mize */}
              <ReservationCombosCard />
              {/* P1 #8 (v1.190.0) — lastni spletni portal za naročila (povezava /s/<token>) */}
              <WebPortalCard />
            </SettingsSection>
            <SettingsSection id="ops" title={t('settings.secOps')}>
              {/* Issue #21 (v1.111.0) — nastavitve klica vodje (dovoljene vrste + čas eskalacije) */}
              <ManagerCallSettingsCard />
              {/* Issue #24 (v1.114.0) — potrjena etiketna pravila roka uporabe (inventory.manage) */}
              <LabelRulesCard />
              {/* Issue #14 (v1.112.0) — KDS named stations config + item routing editor
                  (settings.manage render gate inside the card; menu.manage gates routing) */}
              <PrepStationsCard />
              {/* OSS-1 (v1.200.0) — vzdrževanje opreme: register naprav + servisni načrti
                  (settings.manage render gate inside the card; 503 → migrBox do DDL) */}
              <EquipmentCard />
              {/* OSS-2 (v1.203.0) — dokumenti s priponkami: SOP-i, pogodbe, recepture,
                  navodila (settings.manage render gate inside the card; 503 → migrBox do DDL) */}
              <DocumentsCard />
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
                      <SelectTrigger aria-label={t('print.target')}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="browser">{t('print.targetBrowser')}</SelectItem>
                        <SelectItem value="agent">{t('print.targetAgent')}</SelectItem>
                        <SelectItem value="simulator">{t('print.targetSim')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('print.hostLabel')}</Label>
                    <Input aria-label={t('print.hostPlaceholder')} value={pcfg.host} onChange={(e) => setPcfg((c) => ({ ...c, host: e.target.value }))} placeholder={t('print.hostPlaceholder')} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('print.portLabel')}</Label>
                    <Input aria-label={t('print.portLabel')} inputMode="numeric" value={String(pcfg.port)} onChange={(e) => setPcfg((c) => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 9100 }))} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>{t('print.terminal')}</Label>
                    <Select value={termMode} onValueChange={(v) => setTermMode(v as TerminalMode)}>
                      <SelectTrigger aria-label={t('print.terminal')}><SelectValue /></SelectTrigger>
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
                            <p className="text-xs text-stone-400">{st ? tN('loc.today', 'narocilo', st.todayOrders) : '—'}</p>
                          </div>
                          {hasPerm('settings.manage') && (
                            <div className="flex flex-col gap-0.5">
                              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`${t('common.edit')} ${l.name}`} onClick={() => { setLocEditing(l); setLocForm({ name: l.name, code: l.code, address: l.address, city: l.city, postCode: l.postCode, country: l.country || 'SI', phone: l.phone, email: l.email, premisesId: l.premisesId || '', timezone: l.timezone || 'Europe/Ljubljana', currency: l.currency || 'EUR', isActive: l.isActive }); setLocKdsExpoFire(l.kdsExpoFireEnabled === true); setLocNotice(''); setLocDialogOpen(true) }}>
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
                      <p className="text-xs text-stone-400">{w.events.length > 0 ? w.events.join(' · ') : t('integ.noEvents')}{w.failureCount > 0 ? tN('integ.errorsCount', 'napaka', w.failureCount) : ''}{w.lastTriggered ? t('integ.lastTriggered', { when: new Date(w.lastTriggered).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) : ''}</p>
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
                {/* R4b-1 (v1.216.0): vrstica stanja posodobitev — jantarno SAMO ob
                    dokazano novejši različici; izklopljeno/napačno/nedosegljivo je
                    tiho sivo (operaterjeva zadeva, ne alarm natakarja). */}
                {updCheck && updCheck.updateAvailable && (
                  <>
                    <p className="font-medium text-amber-700">{t('sys.updAvailable', { v: updCheck.latest ?? '' })}</p>
                    <p className="text-xs text-amber-700/90">{t('sys.updHint')}</p>
                  </>
                )}
                {updCheck && !updCheck.updateAvailable && updCheck.reason === '' && (
                  <p>{t('sys.updOk')}</p>
                )}
                {updCheck && !updCheck.updateAvailable && updCheck.reason === 'off' && (
                  <p className="text-stone-400">{t('sys.updDisabled')}</p>
                )}
                {updCheck && !updCheck.updateAvailable && updCheck.reason === 'invalid_url' && (
                  <p className="text-stone-400">{t('sys.updInvalid')}</p>
                )}
                {updCheck && !updCheck.updateAvailable && updCheck.reason !== '' && updCheck.reason !== 'off' && updCheck.reason !== 'invalid_url' && (
                  <p className="text-stone-400">{t('sys.updUnreachable')}</p>
                )}
                <p>{t('sys.modules')}</p>
                <p>{t('sys.db')}</p>
              </CardContent>
            </Card>
            </SettingsSection>
          </TabsContent>
          </div>
        </div>
        {/* Issue #73 audit-10: mobilna spodnja vrstica — 4–5 zavihkov DEJANSKE
            vloge + gumb »Več« (predal s celotnim drevesom + iskalnik). */}
        <MobileBottomNav tabs={DASHBOARD_TABS} activeTab={activeTab} onSelect={setActiveTab} ctx={{ canManage, perms }} role={user?.role} onOpenMore={() => setNavMoreOpen(true)} />
        <MobileNavDrawer open={navMoreOpen} onOpenChange={setNavMoreOpen} tabs={DASHBOARD_TABS} activeTab={activeTab} onSelect={setActiveTab} ctx={{ canManage, perms }} />
      </Tabs>

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
                      /* OSS-10 B-del (v1.210.0): artikel z obvezno varianto odpre izbiro
                         (Plus bi sicer dobil 400 »Skupina … je obvezna«); izbrane vrstice
                         so VIDNE pod artikel vrstico (ločeno −/+ — v naglici ni ugibanja). */
                      <div key={m.id} className="space-y-1">
                        <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${m.available ? 'border-stone-200' : 'border-stone-200 bg-stone-100 opacity-70'}`}>
                          {/* §28: tap na ime = podrobnosti (opomba) */}
                          <button type="button" onClick={() => openNotePick('cart', m.id, m.name)} title={cartNotes[m.id] || t('posn.add', { name: m.name })} aria-label={cartNotes[m.id] ? t('posn.edit', { note: cartNotes[m.id].slice(0, 40) }) : t('posn.add', { name: m.name })} className="min-w-0 min-h-11 flex-1 rounded-md px-1 py-1 text-left hover:bg-stone-50">
                            <p className="text-sm truncate">{m.name} · <b>{fmtEUR(m.price)}</b>{!m.available && <Badge variant="outline" className="ml-1 text-xs px-1.5 py-0">86</Badge>}{(variantReqMap.get(m.id)?.length ?? 0) > 0 && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">{variantReqMap.get(m.id)![0].name}</span>}</p>
                            {!m.available && (
                              <p className="text-xs text-stone-500 truncate">
                                {t('kds.substitutes')}: {g.items.filter((x) => x.available && x.id !== m.id).slice(0, 2).map((x) => x.name).join(' · ') || t('kds.noSubstitutes')}
                              </p>
                            )}
                          </button>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                            <span className="w-6 text-center text-sm font-semibold">{cart[m.id] || 0}</span>
                            <Button size="icon" variant="outline" className="h-7 w-7" disabled={!m.available} title={m.available ? undefined : t('kds.markUnavailable')} onClick={() => posAddClick('cart', m)} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                            <CartNoteButton mode="cart" k={m.id} name={m.name} />
                          </div>
                        </div>
                        {cartNotes[m.id] && <p className="ml-3 text-xs text-amber-800 truncate" title={cartNotes[m.id]}>ℹ {cartNotes[m.id]}</p>}
                        {cartVariants.filter((l) => l.menuItemId === m.id).map((l) => (
                          <div key={l.key} className="ml-6 flex items-center justify-between gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-2.5 py-1.5">
                            {/* §28: tap na vrstico = podrobnosti (opomba) */}
                            <button type="button" onClick={() => openNotePick('cart', l.key, orderItemDisplayName(m.name, l.optionNames))} title={cartNotes[l.key] || t('posn.add', { name: orderItemDisplayName(m.name, l.optionNames) })} aria-label={cartNotes[l.key] ? t('posn.edit', { note: cartNotes[l.key].slice(0, 40) }) : t('posn.add', { name: orderItemDisplayName(m.name, l.optionNames) })} className="min-w-0 min-h-11 py-1 px-1 flex-1 rounded-md text-left hover:bg-stone-100">
                              <p className="text-sm truncate font-medium">{orderItemDisplayName(m.name, l.optionNames)}</p>
                              {l.optionPrice > 0 && <p className="text-xs text-stone-500">{t('orders.variantSurcharge')}: +{fmtEUR(l.optionPrice)}</p>}
                              {cartNotes[l.key] && <p className="text-xs text-amber-800 truncate">ℹ {cartNotes[l.key]}</p>}
                            </button>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setCartVariants((p) => changePosVariantLineQty(p, l.key, -1))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                              <span className="w-6 text-center text-sm font-semibold">{l.qty}</span>
                              <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setCartVariants((p) => addPosVariantLine(p, l))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                              <span className="w-16 text-right text-sm font-semibold tabular-nums">{fmtEUR((m.price + l.optionPrice) * l.qty)}</span>
                              <CartNoteButton mode="cart" k={l.key} name={orderItemDisplayName(m.name, l.optionNames)} />
                            </div>
                            {cartNotes[l.key] && <p className="ml-6 text-xs text-amber-800 truncate" title={cartNotes[l.key]}>ℹ {cartNotes[l.key]}</p>}
                          </div>
                        ))}
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

      {/* ── OSS-10 B-del (v1.210.0): IZBIRA VARIANTE (osebje) — skupni dialog za vse tri
          košarice POS (novo naročilo / hitra prodaja / urejevalnik). Obvezne skupine
          morajo dobiti izbiro PRED vnosom (sicer strežnik vrne 400); potrditev je
          omogočena šele, ko ima vsaka skupina izbrano razpoložljivo opcijo. ── */}
      <Dialog open={!!variantPick} onOpenChange={(v) => !v && setVariantPick(null)}>
        {/* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: živi račun ZRAVEN
            izbire variante — pending vrstica se posodablja z VSAKO izbiro
            (ime z opcijo, cena z doplačilom) še pred Dodaj (Square oktober
            2026 »the check updates with each choice as staff edit«). */}
        <DialogContent className="max-w-sm sm:max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('orders.variantTitle')} — {variantPick?.item.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <LiveCheckAside model={variantAsideModel} region="lcv-aside-variant" />
            <div className="space-y-3">
              {variantPickGroups.map((g) => (
                <div key={g.id}>
                  <p className="text-xs font-semibold uppercase text-stone-400 mb-1.5">{g.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {g.modifiers.filter((m) => m.isAvailable).map((m) => {
                      const sel = variantPick?.selections[g.id] === m.id
                      return (
                        <button key={m.id} type="button" aria-pressed={sel} onClick={() => setVariantPick((p) => (p ? { ...p, selections: { ...p.selections, [g.id]: m.id } } : p))}
                          className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition ${sel ? 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800' : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50'}`}>
                          {m.name}{m.price > 0 ? ` · +${fmtEUR(m.price)}` : ''}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setVariantPick(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 disabled:bg-stone-200 disabled:text-stone-500" disabled={!variantPickComplete} onClick={confirmVariantPick}>
              {t('orders.variantAdd')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── STREŽNI VAL v1.248.0 (§22 B): OPOMBA VRSTICE — skupni dialog za vse tri
          košarice POS (vzorec variantPick). Čipi prednastavljenih opomb (večizbirno,
          vir GET /api/preset-notes — register ureja menu.manage v Meni zavihku) +
          prosto besedilo; sestavljena opomba gre na vrstico (items[].note → KDS +
          kuhinjski/bar list). Počisti = odstranitev opombe z vrstice. ── */}
      <Dialog open={!!notePick} onOpenChange={(v) => !v && setNotePick(null)}>
        {/* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: živi račun ZRAVEN
            opombe — vrstica v urejanju nosi ŽIVO sestavljeno opombo (čipi +
            besedilo) že med tipkanjem, ne šele po Shrani. */}
        <DialogContent className="max-w-sm sm:max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('posn.title')} — {notePick?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <LiveCheckAside model={noteAsideModel} region="lcv-aside-note" />
            <div className="space-y-3">
              {presetNotes.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase text-stone-400">{t('posn.presets')}</p>
                  <div className="flex flex-wrap gap-1.5" data-region="posn-chips">
                    {presetNotes.map((n) => {
                      const on = noteChips.has(n.label)
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => setNoteChips((prev) => { const nx = new Set(prev); if (nx.has(n.label)) nx.delete(n.label); else nx.add(n.label); return nx })}
                          aria-pressed={on}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${on ? 'border-amber-400 bg-amber-100 text-amber-900' : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50'}`}
                        >
                          {n.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor="posn-text" className="text-xs font-semibold uppercase text-stone-400">{t('posn.free')}</label>
                <Input
                  id="posn-text"
                  value={noteText}
                  maxLength={200}
                  placeholder={t('posn.placeholder')}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyNotePick() } }}
                />
              </div>
              {notePickValue && <p className="text-xs text-stone-500 break-words" data-region="posn-current">ℹ {notePickValue}</p>}
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:gap-0">
            {notePickValue && (
              <Button variant="ghost" className="mr-auto text-red-700 hover:text-red-800" onClick={() => applyNotePick(true)}>{t('posn.clear')}</Button>
            )}
            <Button variant="outline" onClick={() => setNotePick(null)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" onClick={() => applyNotePick()}>
              <MessageSquareText className="w-4 h-4 mr-1" aria-hidden /> {t('posn.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OPS-7 (v1.68.0): UREJEVALNIK NAROČILA (Toast vzorec) — klik na zasedeno mizo ── */}
      {/* v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4): UREJEVALNIK MIZ — Toast/TouchBistro
          Lightspeed vsi imajo urejanje miz v UI; API (POST/PATCH/DELETE + revizija) je
          obstajal od P2 audit N1, UI pa ne. Vrstica po mizo (številka/sedeži/cona),
          dodajanje, brisanje z varovalko aktivnega naročila. Cona = prosto besedilo
          z datalist obstoječih con (nova cona se ustvari z vpisom). */}
      <Dialog open={tablesEditOpen} onOpenChange={(v) => { if (!v) setTablesEditOpen(false) }}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('tables.editTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-stone-500">{t('tables.editHint')}</p>
          <div className="space-y-3 text-sm">
            <ScrollArea className="max-h-72">
              <div className="space-y-1.5 pr-2">
                {teRows.map((row) => {
                  const tb = viewTables.find((x) => x.id === row.id)
                  const blocked = !!(tb && (tb.activeOrder || tb.heldOrderId))
                  return (
                    <div key={row.id} className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-2 py-1.5">
                      <label className="sr-only" htmlFor={`te-n-${row.id}`}>{t('tables.number')}</label>
                      <Input id={`te-n-${row.id}`} inputMode="numeric" value={row.number} disabled={teBusy}
                        onChange={(e) => setTeRows((pr) => pr.map((r) => (r.id === row.id ? { ...r, number: e.target.value } : r)))}
                        className="h-10 w-16 tabular-nums" aria-label={t('tables.number')} />
                      <label className="sr-only" htmlFor={`te-s-${row.id}`}>{t('tables.seatsShort')}</label>
                      <Input id={`te-s-${row.id}`} inputMode="numeric" value={row.seats} disabled={teBusy}
                        onChange={(e) => setTeRows((pr) => pr.map((r) => (r.id === row.id ? { ...r, seats: e.target.value } : r)))}
                        className="h-10 w-16 tabular-nums" aria-label={t('tables.seatsShort')} />
                      <label className="sr-only" htmlFor={`te-z-${row.id}`}>{t('tables.zoneShort')}</label>
                      <Input id={`te-z-${row.id}`} list="te-zones" value={row.zone} disabled={teBusy}
                        onChange={(e) => setTeRows((pr) => pr.map((r) => (r.id === row.id ? { ...r, zone: e.target.value } : r)))}
                        className="h-10 min-w-0 flex-1" aria-label={t('tables.zoneShort')} />
                      <datalist id="te-zones">
                        {[...new Set(viewTables.map((x) => x.zone).filter(Boolean))].map((z) => (
                          <option key={z} value={z} />
                        ))}
                      </datalist>
                      <Button size="sm" variant="outline" className="h-10 shrink-0 bg-emerald-700 text-white hover:bg-emerald-800" disabled={teBusy} onClick={() => void teSave(row)} aria-label={t('tables.saveRow')} title={t('tables.saveRow')}>
                        <Check className="w-3.5 h-3.5" aria-hidden />
                      </Button>
                      <Button size="sm" variant="outline" className="h-10 shrink-0 text-red-700 hover:bg-red-50" disabled={teBusy || blocked}
                        onClick={() => void teDelete(row)} aria-label={t('tables.deleteRow')} title={blocked ? t('tables.deleteBlocked') : t('tables.deleteRow')}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden />
                      </Button>
                    </div>
                  )
                })}
                {teRows.length === 0 && <p className="text-sm text-stone-500">{t('sale.empty')}</p>}
              </div>
            </ScrollArea>
            {/* nova miza — vrstica za dodajanje */}
            <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-stone-300 px-2 py-2">
              <label className="sr-only" htmlFor="te-new-n">{t('tables.number')}</label>
              <Input id="te-new-n" inputMode="numeric" placeholder={t('tables.number')} value={teNew.number} disabled={teBusy}
                onChange={(e) => setTeNew({ ...teNew, number: e.target.value })} className="h-10 w-16 tabular-nums" />
              <label className="sr-only" htmlFor="te-new-s">{t('tables.seatsShort')}</label>
              <Input id="te-new-s" inputMode="numeric" placeholder="4" value={teNew.seats} disabled={teBusy}
                onChange={(e) => setTeNew({ ...teNew, seats: e.target.value })} className="h-10 w-16 tabular-nums" />
              <label className="sr-only" htmlFor="te-new-z">{t('tables.zoneShort')}</label>
              <Input id="te-new-z" list="te-zones" placeholder={t('tables.zoneShort')} value={teNew.zone} disabled={teBusy}
                onChange={(e) => setTeNew({ ...teNew, zone: e.target.value })} className="h-10 min-w-0 flex-1" />
              <Button size="sm" className="h-10 shrink-0 gap-1 bg-emerald-700 hover:bg-emerald-800" disabled={teBusy} onClick={() => void teAdd()}>
                <Plus className="w-3.5 h-3.5" aria-hidden /> {t('tables.addRow')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* v1.233.0 (PRIMERJAVA §4): UREDJEVALNIK CON — cone kot samostojen objekt.
          Vrstica po coni: ime + število miz + seznam; PREIMENUJ (prosto besedilo)
          in ZDRUŽI (izbira obstoječe ciljne cone) — obe sta ISTA operacija na
          strežniku (updateMany area + revizija ZONE_RENAME), razliko naredi UI. */}
      <Dialog open={zonesEditOpen} onOpenChange={(v) => { if (!v) setZonesEditOpen(false) }}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('zones.editTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-stone-500">{t('zones.editDesc')}</p>
          <div className="space-y-3 text-sm">
            <ScrollArea className="max-h-72">
              <div className="space-y-2 pr-2">
                {zeZones().map((z) => {
                  const others = zeZones().filter((x) => x.zone !== z.zone)
                  return (
                    <div key={z.zone || '(prazna)'} data-region="zone-row" className="rounded-lg border border-stone-200 px-2.5 py-2 space-y-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold truncate min-w-0">{z.zone || '—'}</span>
                        <Badge variant="outline" className="shrink-0">{t('zones.tablesCount', { n: String(z.count) })}</Badge>
                        <span className="ml-auto text-xs text-stone-400 truncate max-w-[45%]" title={z.tables.join(', ')}>{t('zones.tablesList', { list: z.tables.join(', ') })}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <label className="sr-only" htmlFor={`ze-r-${z.zone || 'empty'}`}>{t('zones.newName')}</label>
                        <Input id={`ze-r-${z.zone || 'empty'}`} placeholder={t('zones.newName')} value={zeRename[z.zone] ?? ''} disabled={zeBusy}
                          onChange={(e) => setZeRename((p) => ({ ...p, [z.zone]: e.target.value }))}
                          className="h-10 min-w-0 flex-1" />
                        <Button size="sm" variant="outline" className="h-10 shrink-0 gap-1 bg-emerald-700 text-white hover:bg-emerald-800" disabled={zeBusy || !(zeRename[z.zone] ?? '').trim()}
                          onClick={() => void zeApply(z.zone, zeRename[z.zone] ?? z.zone)}>
                          <Check className="w-3.5 h-3.5" aria-hidden /> {t('zones.renameBtn')}
                        </Button>
                        {others.length > 0 && (
                          <>
                            <label className="sr-only" htmlFor={`ze-m-${z.zone || 'empty'}`}>{t('zones.mergeInto')}</label>
                            <Select value={zeMerge[z.zone] ?? ''} onValueChange={(v) => setZeMerge((p) => ({ ...p, [z.zone]: v }))} disabled={zeBusy}>
                              <SelectTrigger id={`ze-m-${z.zone || 'empty'}`} className="h-10 w-36 text-xs" aria-label={t('zones.mergeInto')}>
                                <SelectValue placeholder={t('zones.pickTarget')} />
                              </SelectTrigger>
                              <SelectContent>
                                {others.map((x) => (
                                  <SelectItem key={x.zone} value={x.zone}>{x.zone || '—'}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button size="sm" variant="outline" className="h-10 shrink-0" disabled={zeBusy || !zeMerge[z.zone]}
                              onClick={() => zeMerge[z.zone] && void zeApply(z.zone, zeMerge[z.zone])}>
                              {t('zones.mergeBtn')}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
                {zeZones().length === 0 && <p className="text-sm text-stone-500">{t('zones.empty')}</p>}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!orderSheet} onOpenChange={(v) => { if (!v) { setOrderSheet(null); setSheetCart({}); setSheetVariants([]); setSheetNotes({}); setSheetBanner(null) } }}>
        <DialogContent aria-describedby={undefined} className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg">
              {t('sheet.title', { n: String(orderSheet?.orderNumber ?? ''), name: orderSheet?.table?.name || orderSheet?.type || '' })}
            </DialogTitle>
          </DialogHeader>
          {/* v1.229.0 (PRIMERJAVA-VMESNIKOV-2026 §4): PRENOS NA NATAKARJA (Lightspeed
              »transfer user«) — trenutni natakar v vedno vidni izbiri; aktivna naročila
              samo (plačana zgodovina ostane pri svojem natakarju za poročila napitnin). */}
          {orderSheet && ['unpaid', 'partial'].includes(orderSheet.paymentStatus || 'unpaid') && hasPerm('orders.create') && (
            <div className="flex items-center gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-1.5 text-stone-500">
                <UserCog className="w-3.5 h-3.5 shrink-0" aria-hidden /> {t('sheet.waiterLabel')}:
              </span>
              <Select value={orderSheet.employee?.id || 'none'} onValueChange={(v) => { if (v !== 'none' && v !== orderSheet.employee?.id) void transferOrder(v) }}>
                <SelectTrigger className="h-9 min-w-0 flex-1 text-xs" aria-label={t('sheet.transferWaiter')}>
                  <SelectValue placeholder={t('sheet.transferWaiter')} />
                </SelectTrigger>
                <SelectContent>
                  {/* aktivni zaposleni LOKACIJE naročila (strežniško pravilo je
                      strogo: employee.locationId === order.locationId — brezlokacijski
                      zaposleni bi v izbiri obljubili prenos, ki strežnik zavrne) */}
                  {employees.filter((e) => e.active && (e.id === orderSheet.employee?.id || (!orderSheet.locationId || e.locationId === orderSheet.locationId))).map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {/* v1.255.0 (§29): potrditev tik pod glavo urejevalnika (Lightspeed »at the
              top of the screen when a task is complete«) — dodatek / fire / tečaj. */}
          <ConfirmBannerView banner={sheetBanner} onDismiss={() => setSheetBanner(null)} region="confirm-banner-sheet" />
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
                      {/* OSS-10 B-del: izbrane opcije (»0,5 L«) ob imenu — vidijo se tudi po osvežitvi */}
                      <span className="min-w-0 truncate flex items-center gap-1">
                        <span className="min-w-0 truncate">{it.qty}× {it.name}{it.modifiers?.length ? ` · ${it.modifiers.join(', ')}` : ''}</span>
                        {/* PRIMERJAVA §23 (v1.249.0): ✱ cena te postavke je bila
                            spremenjena na POS (tooltip nosi prejšnjo ceno + izvajalca) */}
                        {it.priceOverride && (
                          <span
                            title={`${t('prc.mark')}: ${fmtEUR(it.priceOverride.from)} → ${fmtEUR(it.priceOverride.to)} · ${it.priceOverride.by}`}
                            aria-label={t('prc.mark')}
                            className="shrink-0 inline-flex h-4 w-4 items-center justify-center rounded-full border border-orange-300 bg-orange-50 text-[10px] font-bold text-orange-800"
                          >✱</span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {/* QA najdba #3 (v1.218.0): surovi status (»PREPARING«) →
                            prevod iz status.* nabora (handheld že uporablja isti
                            vzorec); neznan enum ostane surov (doc-truth). */}
                        <Badge variant="outline" className="text-xs px-1.5 py-0">
                          {['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(it.status) ? t(`status.${it.status}`) : it.status}
                        </Badge>
                        {/* PRIMERJAVA §23 (v1.249.0): sprememba cene postavke —
                            isti trije varovali kot preklic (pravica + naročilo ni
                            plačano + postavka ni na plačanem izstavku §16 D). */}
                        {hasPerm('orders.priceOverride') && orderSheet.paymentStatus !== 'paid' && !it.checkPaid && (
                          <Button size="icon" variant="outline" className="h-6 w-6 text-orange-700 hover:bg-orange-50 hover:text-orange-800" disabled={sending} onClick={() => { setPriceItem(it); setPriceNew(fmtFixedSI(it.unitPrice, 2)); setPriceReason('') }} title={t('prc.button')} aria-label={t('prc.button')}>
                            <Coins className="w-3 h-3" />
                          </Button>
                        )}
                        {/* v1.239.0 §16 D: postavka na PLAČANEM izstavku (delno plačano
                            naročilo 'partial') — gumb skrit: preklic bi odvzel že
                            pobran denar brez vračila (strežnik vrne 409 + usmeritev
                            na fiskalni storno; UI samo ne ponuja prepovedane poteze). */}
                        {hasPerm('orders.void') && orderSheet.paymentStatus !== 'paid' && !it.checkPaid && (
                          <Button size="icon" variant="outline" className="h-6 w-6 text-red-700 hover:bg-red-50 hover:text-red-800" disabled={sending} onClick={() => void openVoidDialog(it)} title={t('sheet.void')} aria-label={t('sheet.void')}>
                            <Ban className="w-3 h-3" />
                          </Button>
                        )}
                        {hasPerm('orders.create') && it.status === 'PENDING' && (
                          <Select value={it.courseId || 'none'}
                            onValueChange={(v) => void assignCourse(it.id, v)}>
                            <SelectTrigger aria-label={t('sheet.noCourse')} className="h-6 w-[104px] text-xs gap-1"><SelectValue placeholder={t('sheet.noCourse')} /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('sheet.noCourse')}</SelectItem>
                              {sheetCourses.filter((c) => c.status === 'pending').map((c) => (
                                /* v1.232.0 P2 popravek: vrednost opcije je ID tečaja
                                   (ne courseNumber) — Select value={it.courseId} je
                                   tekal v prazno (prikaz placeholderja dodeljene
                                   postavke), izbira obstoječega tečaja pa je poslala
                                   courseNumber kot courseId → 404 »Tečaj ne obstaja«;
                                   deloval je SAMO »nov tečaj«. */
                                <SelectItem key={c.id} value={c.id}>{c.courseNumber}. {c.name}</SelectItem>
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
              {/* N-27-1: aktivni sedež (naročanje) — isti obseg sedežev kot plačilni dialog (1–5) */}
              {sheetHasItems && (
                <div className="flex items-center gap-1.5 flex-wrap mb-2" role="group" aria-label={t('order.activeSeat')}>
                  <span className="text-xs font-semibold uppercase text-stone-500 mr-1 shrink-0">{t('order.activeSeat')}</span>
                  <button aria-pressed={sheetSeat == null} onClick={() => setSheetSeat(null)} className={`min-h-11 px-3 rounded-lg text-sm font-bold ${sheetSeat == null ? 'bg-stone-800 text-white' : 'bg-stone-100 hover:bg-stone-200 text-stone-700'}`}>{t('order.seatNone')}</button>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} aria-pressed={sheetSeat === n} onClick={() => setSheetSeat(n)} className={`min-h-11 px-3 rounded-lg text-sm font-bold ${sheetSeat === n ? 'bg-emerald-700 text-white' : 'bg-stone-100 hover:bg-stone-200 text-stone-700'}`}>{t('payment.seatShort', { n })}</button>
                  ))}
                </div>
              )}
              <ScrollArea className="max-h-36">
                <div className="space-y-3 pr-2">
                  {orderDialogMenu.map((g) => (
                    <div key={g.cat.id}>
                      <p className="text-xs font-semibold uppercase text-stone-400 mb-1">{g.cat.name}</p>
                      <div className="space-y-1">
                        {g.items.map((m) => (
                          /* P0-3 (v1.83.0): prej tiho skrito (filter available) — natakar ni vedel,
                             DA artikel obstaja in je razprodan; zdaj sivi + 86 + nadomestki. */
                          /* OSS-10 B-del (v1.210.0): varianta = Plus odpre izbiro; vrstice pod artikel vrstico. */
                          <div key={m.id} className="space-y-1">
                            <div className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${m.available ? 'border-stone-100' : 'border-stone-100 bg-stone-100 opacity-70'}`}>
                              {/* §28: tap na ime = podrobnosti (opomba) */}
                              <button type="button" onClick={() => openNotePick('sheet', m.id, m.name)} title={sheetNotes[m.id] || t('posn.add', { name: m.name })} aria-label={sheetNotes[m.id] ? t('posn.edit', { note: sheetNotes[m.id].slice(0, 40) }) : t('posn.add', { name: m.name })} className="min-w-0 min-h-11 flex-1 rounded-md px-1 py-1 text-left hover:bg-stone-50">
                                <p className="text-sm truncate">{m.name} · <b>{fmtEUR(m.price)}</b>{!m.available && <Badge variant="outline" className="ml-1 text-xs px-1.5 py-0">86</Badge>}</p>
                                {!m.available && (
                                  <p className="text-xs text-stone-500 truncate">
                                    {t('kds.substitutes')}: {g.items.filter((x) => x.available && x.id !== m.id).slice(0, 2).map((x) => x.name).join(' · ') || t('kds.noSubstitutes')}
                                  </p>
                                )}
                              </button>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetCart((c) => ({ ...c, [m.id]: Math.max(0, (c[m.id] || 0) - 1) }))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                                <span className="w-5 text-center text-sm font-semibold">{sheetCart[m.id] || 0}</span>
                                <Button size="icon" variant="outline" className="h-6 w-6" disabled={!m.available} title={m.available ? undefined : t('kds.markUnavailable')} onClick={() => posAddClick('sheet', m)} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                                <CartNoteButton mode="sheet" k={m.id} name={m.name} />
                              </div>
                              {sheetNotes[m.id] && <p className="ml-3 text-xs text-amber-800 truncate" title={sheetNotes[m.id]}>ℹ {sheetNotes[m.id]}</p>}
                            </div>
                            {sheetVariants.filter((l) => l.menuItemId === m.id).map((l) => (
                              <div key={l.key} className="ml-5 flex items-center justify-between gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-2 py-1">
                                {/* §28: tap na vrstico = podrobnosti (opomba) */}
                                <button type="button" onClick={() => openNotePick('sheet', l.key, orderItemDisplayName(m.name, l.optionNames))} title={sheetNotes[l.key] || t('posn.add', { name: orderItemDisplayName(m.name, l.optionNames) })} aria-label={sheetNotes[l.key] ? t('posn.edit', { note: sheetNotes[l.key].slice(0, 40) }) : t('posn.add', { name: orderItemDisplayName(m.name, l.optionNames) })} className="min-w-0 min-h-11 flex-1 rounded-md px-1 py-1 text-left hover:bg-stone-100">
                                  <p className="min-w-0 truncate text-sm font-medium">{orderItemDisplayName(m.name, l.optionNames)}</p>
                                  {sheetNotes[l.key] && <p className="min-w-0 truncate text-xs text-amber-800">ℹ {sheetNotes[l.key]}</p>}
                                </button>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetVariants((p) => changePosVariantLineQty(p, l.key, -1))} aria-label={t('orders.less')}><Minus className="w-3 h-3" /></Button>
                                  <span className="w-5 text-center text-sm font-semibold">{l.qty}</span>
                                  <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setSheetVariants((p) => addPosVariantLine(p, l))} aria-label={t('orders.more')}><Plus className="w-3 h-3" /></Button>
                                  <span className="w-14 text-right text-sm font-semibold tabular-nums">{fmtEUR((m.price + l.optionPrice) * l.qty)}</span>
                                  <CartNoteButton mode="sheet" k={l.key} name={orderItemDisplayName(m.name, l.optionNames)} />
                                </div>
                              </div>
                            ))}
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
            {sheetHasItems && (
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
        {/* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: živi račun ZRAVEN
            preklica — vrstica prečrtana, skupaj po preklicu ŽIVO (denar, ki ga
            preklic odnese, je viden PREJ potrditve). */}
        <DialogContent aria-describedby={undefined} className="max-w-sm sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('void.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <LiveCheckAside model={voidAsideModel} region="lcv-aside-void" totalKey="lcv.totalAfterVoid" />
            <div className="space-y-3 text-sm">
              <p className="rounded-lg border border-stone-200 px-3 py-2">{voidItem?.qty}× {voidItem?.name}</p>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="void-reason-text">{t('void.reasonLabel')}</label>
                {voidReasons.length > 0 ? (
                  <Select value={voidReasonId} onValueChange={setVoidReasonId}>
                    <SelectTrigger aria-label="—" className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
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
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-9" onClick={() => setVoidItem(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" className="h-9" disabled={sending} onClick={() => void confirmVoidItem()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} {t('void.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PRIMERJAVA §23 (v1.249.0): dialog spremembe cene postavke — denarni
          poseg (nova cena + OBVEZEN razlog; strežnik validira strogo, preračuna
          DDV in totale v transakciji, zapiše revizijo ORDER_ITEM_PRICE_OVERRIDE) */}
      <Dialog open={!!priceItem} onOpenChange={(v) => { if (!v) setPriceItem(null) }}>
        {/* PRIMERJAVA §28 (v1.254.0) — REAL-TIME CHECK VIEW: živi račun ZRAVEN
            spremembe cene — vrstica pokaže prej → novo ŽIVO iz tipkanja in
            skupaj sledi (§23 denarna disciplina ostaja: vrata = Potrdi +
            obvezen razlog + strežniška validacija + revizija). */}
        <DialogContent aria-describedby={undefined} className="max-w-sm sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg flex items-center gap-2"><Coins className="w-5 h-5 text-orange-700" /> {t('prc.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <LiveCheckAside model={priceAsideModel} region="lcv-aside-price" />
            <div className="space-y-3 text-sm">
              <p className="rounded-lg border border-stone-200 px-3 py-2">{priceItem?.qty}× {priceItem?.name}</p>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="prc-current">{t('prc.current')}</label>
                <p id="prc-current" className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-semibold tabular-nums">{priceItem?.unitPrice != null ? fmtEUR(priceItem.unitPrice) : '—'}</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="prc-new">{t('prc.new')}</label>
                <input
                  id="prc-new"
                  value={priceNew}
                  onChange={(e) => setPriceNew(e.target.value.slice(0, 12))}
                  placeholder={t('prc.newPh')}
                  inputMode="decimal"
                  autoComplete="off"
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-stone-300"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="prc-reason">{t('prc.reason')}</label>
                <input
                  id="prc-reason"
                  value={priceReason}
                  onChange={(e) => setPriceReason(e.target.value.slice(0, 200))}
                  placeholder={t('prc.reasonPh')}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
                  maxLength={200}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-9" onClick={() => setPriceItem(null)}>{t('common.cancel')}</Button>
            <Button variant="outline" className="h-9 border-orange-300 text-orange-800 hover:bg-orange-50 hover:text-orange-900" disabled={sending} onClick={() => void confirmPriceOverride()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />} {t('prc.confirm')}
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
                  <SelectTrigger aria-label="—" className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
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
      <Dialog open={!!payingOrder} onOpenChange={(v) => { if (!v) { setPayingOrder(null); setInvoice(null); setPayBanner(null) } }}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader className="flex flex-row items-center justify-between gap-2">
            <DialogTitle className="text-lg">{t('payment.title', { name: payingOrder?.table?.name || '' })}{payCheckNum ? ` — ${t('payment.checkLabel', { n: payCheckNum })}` : ''}</DialogTitle>
            {/* OSS-15 (v1.201.0): zvočna potrditev plačila — izklop TOČNO tam, kjer se plačuje (Issue #71 vzorec: dejanja blizu konteksta) */}
            <button
              type="button"
              onClick={togglePayCue}
              aria-label={payCue ? t('payment.cueOn') : t('payment.cueOff')}
              title={payCue ? t('payment.cueOn') : t('payment.cueOff')}
              className="shrink-0 rounded-md p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition"
            >
              {payCue ? <Volume2 className="w-4 h-4" aria-hidden /> : <VolumeX className="w-4 h-4" aria-hidden />}
            </button>
          </DialogHeader>
          {/* v1.255.0 (§29): potrditev tik pod glavo plačilnega pogleda — popust. */}
          <ConfirmBannerView banner={payBanner} onDismiss={() => setPayBanner(null)} region="confirm-banner-payment" />
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
                                {it.seat !== null && <span className="text-xs font-medium text-stone-500">{t('payment.seatShort', { n: it.seat })}</span>}
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
                          {/* P1-6: split po gostih — en klik, poštena porazdelitev po znesku */}
                          <div className="rounded-lg border border-stone-100 bg-stone-50 p-2 space-y-1.5">
                            <p className="text-xs text-stone-500">{t('payment.splitGuestsHint')}</p>
                            <div className="flex gap-1.5">
                              {[2, 3, 4, 5].map((n) => (
                                <Button key={n} size="sm" variant="outline" className="min-h-10 flex-1 text-xs" disabled={sending}
                                  onClick={() => void splitByGuests(n)}>
                                  {t('payment.splitGuestsBtn', { n })}
                                </Button>
                              ))}
                            </div>
                          </div>
                          {/* P3 #20 (v1.193.0): sedeži — oznaka izvora postavke (kdo je naročil)
                              + split izstavkov po sedežih; dopolnjuje goste (LPT) in ročni split */}
                          <div className="rounded-lg border border-stone-100 bg-stone-50 p-2 space-y-1.5">
                            <p className="text-xs font-semibold text-stone-600">{t('payment.seatsTitle')}</p>
                            <p className="text-xs text-stone-500">{t('payment.seatsHint')}</p>
                            {(() => {
                              const seatTotals = new Map<number, number>()
                              let noneTotal = 0
                              let noneCount = 0
                              for (const it of checksData.items) {
                                if (it.seat === null) { noneTotal += it.lineTotal; noneCount += 1 }
                                else seatTotals.set(it.seat, (seatTotals.get(it.seat) ?? 0) + it.lineTotal)
                              }
                              const seatCount = seatTotals.size
                              const clearable = Object.entries(splitSel).some(([k, v]) => v && (checksData.items.find((it) => it.id === k)?.seat ?? null) !== null)
                              return (
                                <>
                                  {(seatCount > 0 || noneCount > 0) && (
                                    <div className="flex flex-wrap gap-1.5 text-xs">
                                      {[...seatTotals.entries()].sort((a, b) => a[0] - b[0]).map(([s, sum]) => (
                                        <span key={s} className="rounded-md border border-stone-200 bg-white px-1.5 py-0.5">{t('payment.seatsOverview', { n: s, sum: fmtEUR(sum) })}</span>
                                      ))}
                                      {noneCount > 0 && (
                                        <span className="rounded-md border border-stone-200 bg-white px-1.5 py-0.5 text-stone-500">{t('payment.seatsOverviewNone', { sum: fmtEUR(noneTotal) })}</span>
                                      )}
                                    </div>
                                  )}
                                  <div className="flex flex-wrap gap-1.5">
                                    {[1, 2, 3, 4, 5].map((n) => (
                                      <Button key={n} size="sm" variant="outline" className="min-h-10 flex-1 text-xs" disabled={sending || !Object.values(splitSel).some(Boolean)}
                                        onClick={() => void assignSeats(n)}>
                                        {t('payment.seatsAssign', { n })}
                                      </Button>
                                    ))}
                                    <Button size="sm" variant="outline" className="min-h-10 text-xs" disabled={sending || !clearable}
                                      onClick={() => void assignSeats(null)}>
                                      {t('payment.seatsClear')}
                                    </Button>
                                  </div>
                                  <Button size="sm" className="h-10 w-full text-xs bg-emerald-700 hover:bg-emerald-800" disabled={sending || seatCount < 2}
                                    onClick={() => void splitBySeats()}>
                                    {t('payment.seatsSplitBtn')}
                                  </Button>
                                </>
                              )
                            })()}
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
                {/* v1.238.0 §15: odprti balance — QR povezave so denar, ki je ŽE v blagajni */}
                {bill.linkPaidTotal != null && bill.linkPaidTotal > 0 && (
                  <div className="flex justify-between text-amber-700 border-t border-stone-100 pt-1" data-region="payment-link-paid">
                    <span>{t('payment.linkPaid')}</span>
                    <span>−{fmtEUR(bill.linkPaidTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg pt-1 border-t border-stone-200"><span>{t('payment.due')}</span><span>{fmtEUR(bill.linkPaidTotal != null && bill.linkPaidTotal > 0 ? Math.max(0, bill.totalDue - bill.linkPaidTotal) : bill.totalDue)}</span></div>
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
                        <SelectTrigger aria-label={t('payment.noDiscount')} className="h-9 flex-1"><SelectValue placeholder={t('payment.noDiscount')} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t('payment.noDiscount')}</SelectItem>
                          {manualDiscounts.map((d) => (
                            <SelectItem key={d.id} value={d.id}>{d.name} ({(d.type === 'percent' || d.type === 'percentage') ? `${d.amount} %` : fmtEUR(d.amount)})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* P2-10b (v1.187.0): osebni kupon (rojstnodnevni/ročni) — koda po e-pošti/iz CRM.
                      v1.225.0: isto polje sprejme tudi PROMO KODO registra (Discount.promoCode) —
                      strežnik najprej išče osebni kupon, nato promo kodo lokacije. */}
                  {hasPerm('apply_discounts') && (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs shrink-0" htmlFor="coupon-code">{t('cp.label')}</Label>
                      <Input
                        id="coupon-code"
                        className="h-9 flex-1 font-mono uppercase"
                        placeholder="BD26-XXXXXXXX / PROMO10"
                        value={couponCode}
                        onChange={(e) => setCouponCode(e.target.value)}
                        aria-label={t('cp.aria')}
                        maxLength={40}
                      />
                      <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" disabled={sending || !couponCode.trim()}
                        onClick={() => void applyCoupon()}>
                        {t('cp.apply')}
                      </Button>
                    </div>
                  )}

                  {/* zvestoba — iskanje gosta + unovčenje točk */}
                  {bill.loyalty.enabled && (
                    <div className="rounded-xl border border-stone-200 p-3 space-y-2">
                      {loyaltySel ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold truncate">{loyaltySel.customerName}</p>
                            <p className="text-xs text-stone-500">{tN('payment.pointsOf', 'tocka', loyaltySel.pointsBalance)} · {loyaltySel.tier}</p>
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
                                  <p className="text-xs text-stone-500">{a.customerPhone || '—'} · {tN('payment.pointsOf', 'tocka', a.pointsBalance)} · {a.tier}</p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {loyaltySel && (
                        <div className="flex items-center gap-2">
                          <Label className="text-xs shrink-0">{t('payment.redeem')}</Label>
                          <Input aria-label={t('payment.redeem')}
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
                            <SelectTrigger aria-label={t('payment.splitParts')} className="h-10 w-32"><SelectValue /></SelectTrigger>
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
          <DialogHeader>
            <DialogTitle>{t('resv.new')}</DialogTitle>
            {/* QA najdba #4 (v1.218.0): DialogDescription poveže aria-describedby
                (Radix ga sam pripne) — prej je dialog brez opisa pustil prazno
                »describedby« (bralniki niso slišali konteksta, konzola pa opozorila). */}
            <DialogDescription>{t('resv.newDesc')}</DialogDescription>
          </DialogHeader>
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
                <Input id="res-time" name="reservedAt" type="datetime-local" value={newRes.reservedAt} onChange={(e) => setNewRes({ ...newRes, reservedAt: e.target.value })} />
              </div>
              {/* Issue #96 (QA P1): centralna vloga brez dodeljene lokacije izbere
                  lokacijo rezervacije (vzorec iz PO dialoga v nabavi) — prej je
                  POST padel s 400 šele po oddaji, dialog ni ponujal rešitve. */}
              {resvNeedsLocation && resvLocationChoices.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="res-location">{t('resv.locationLabel')}</Label>
                  <Select value={newRes.locationId || viewLoc} onValueChange={(v) => setNewRes({ ...newRes, locationId: v })}>
                    <SelectTrigger id="res-location" name="locationId" className="w-full"><SelectValue placeholder={t('resv.locationPlaceholder')} /></SelectTrigger>
                    <SelectContent className="max-h-64 overflow-y-auto">
                      {resvLocationChoices.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {resvLocationChoices.length === 1 && <p className="text-xs text-stone-400">{t('resv.locationOnly')}</p>}
                </div>
              )}
              {/* OPS-8 val 3 (v1.73.0): miza / vir / e-pošta / trajanje / posebne zahteve */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="res-table">{t('resv.table')}</Label>
                  <div className="flex items-center gap-1.5">
                    <Select value={newRes.tableId || 'NONE'} onValueChange={(v) => setNewRes({ ...newRes, tableId: v === 'NONE' ? '' : v })}>
                      <SelectTrigger id="res-table" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-64 overflow-y-auto">
                        <SelectItem value="NONE">{t('resv.tableNone')}</SelectItem>
                        {viewTables.map((tb) => (
                          <SelectItem key={tb.id} value={tb.id}>{tb.name} · {tN('tables.seats', 'mesto', tb.seats)}</SelectItem>
                        ))}
                        {/* v1.245.0 (§19): registrirane kombinacije miz za velike
                            družbe — vrednost 'combo:<id>' se ob oddaji razplete
                            v tableIds[] (vsota sedežev članic). */}
                        {tableCombos.map((c) => {
                          const members = c.tableIds.map((id) => viewTables.find((tb) => tb.id === id)).filter((x): x is TableT => !!x)
                          if (members.length !== c.tableIds.length) return null
                          const seats = members.reduce((s, m) => s + m.seats, 0)
                          const lbl = members.map((m) => m.name.replace('Miza ', '')).join('+')
                          return (
                            <SelectItem key={c.id} value={`combo:${c.id}`}>
                              🔗 Miza {lbl} · {t('resv.comboSeats', { n: seats })}
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                    {/* v1.231.0 — samodejna dodelitev (manjša miza, ki ustreza
                        številu oseb, brez prekrivanja rezervacij) ob danem času */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-9 shrink-0 text-xs"
                      data-region="resv-auto-assign"
                      onClick={autoAssignTable}
                      title={t('resv.autoAssignHint')}
                    >
                      <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('resv.autoAssign')}
                    </Button>
                  </div>
                  {/* v1.252.0 (§26) — strežniška avtododelitev ob shrani (Lightspeed
                      maj 2026): privzeto VKLOP; izklop je zavedna odločitev osebja
                      (vzorec allowOutsideHours). Izrecna izbira mize zgoraj vedno
                      zmaga — ta stikalo velja SAMO za shranjevanje brez izbrane mize. */}
                  <div className="flex items-start gap-2 pt-0.5">
                    <Checkbox
                      id="res-auto-table"
                      checked={newRes.autoTable !== false}
                      onCheckedChange={(v) => setNewRes({ ...newRes, autoTable: v === true })}
                      className="mt-0.5"
                    />
                    <div className="grid gap-0.5 leading-none">
                      <Label htmlFor="res-auto-table" className="text-xs font-normal cursor-pointer">
                        {t('resv.autoServerToggle')}
                      </Label>
                      <p className="text-[11px] text-stone-400">{t('resv.autoServerToggleHint')}</p>
                    </div>
                  </div>
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
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={sending || !newRes?.guestName || !newRes?.reservedAt || resvLocationMissing} onClick={() => void createReservation()}>
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
                <SelectTrigger aria-label={t('emp.newRole')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {/* QA-val v1.222.0 (najdba #1): centralna vloga (OWNER/ADMIN) vidi tudi
                      privilegirane vloge — backend jih sme ustvariti (assertCentralGrant /
                      PRIVILEGED_ROLES), toda UI jih prej NI ponudil, zato je bilo dedovanje
                      lastništva mogoče samo neposredno prek baze. Operativne vloge ostanejo
                      za vse z employees.manage (vodja: samo operativne — C2 matrica). */}
                  {(canManage ? ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTING', 'WAREHOUSE', 'WAITER', 'BAR', 'KITCHEN', 'CHEF', 'CLEANER'] : ['WAITER', 'BAR', 'KITCHEN', 'CHEF', 'MANAGER', 'CLEANER', 'WAREHOUSE']).map((r) => (
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
                      <SelectTrigger aria-label={t('shifts.csvRole')}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {/* ISSUE #72 E4: WAREHOUSE/ACCOUNTING dodani v izbor (bili samo v
                            DB/izračunu); enterprise vloge ostanejo centralna pridržana pravica.
                            QA-val v1.222.0 (najdba #1-dopolnitev): CHEF manjkal v izboru —
                            nov-dialog in POST/OPERATIVE_ROLES ga imajo (vodja sme ustvariti kuharja,
                            a mu urejanje vloge ni ponujalo izbire). */}
                        {['OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'BAR', 'KITCHEN', 'CHEF', 'CLEANER', 'WAREHOUSE', 'ACCOUNTING'].map((r) => (
                          <SelectItem key={r} value={r} disabled={(user?.role !== 'OWNER' && r === 'OWNER') || (r !== 'WAITER' && r !== 'BAR' && r !== 'KITCHEN' && r !== 'CHEF' && r !== 'CLEANER' && !isCentralUIRole(user?.role))}>{roleL(r)}</SelectItem>
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
                  {/* QA-val v1.222.0 (najdba #7): receipts.storno brez reports.sales je
                      NEUPORABEN override — gumb za storno živi v zavihku Računi (TAB_PERM:
                      reports.sales) in GET /api/furs zahteva isto pravico (N5 revizija §4,
                      namerna izbira). Opozori podeljevalca, preden shrani mrtvi ključ. */}
                  {empPerms.includes('receipts.storno') && !empEffective.fromRole.includes('reports.sales') && !empPerms.includes('reports.sales') && (
                    <p className="text-xs rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-800 border border-amber-200">
                      ⚠ Storno gumb je v zavihku »Računi«, ki zahteva tudi dovoljenje
                      »Poročila — prodaja, računi, stroški (finance)«. Brez njega imetnik
                      storno pravice ne vidi računov, ki jih lahko stornira.
                    </p>
                  )}
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
                    <Input aria-label={t('emp.pinPlaceholder')}
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
                <Input aria-label={t('loc.namePlaceholder')} value={locForm.name} onChange={(e) => setLocForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('loc.namePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('loc.codeLabel')}</Label>
                <Input aria-label={t('loc.codePlaceholder')} value={locForm.code} onChange={(e) => setLocForm((f) => ({ ...f, code: e.target.value.toUpperCase().slice(0, 20) }))} placeholder={t('loc.codePlaceholder')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('set.address')}</Label>
              <Input aria-label={t('loc.addressPlaceholder')} value={locForm.address} onChange={(e) => setLocForm((f) => ({ ...f, address: e.target.value }))} placeholder={t('loc.addressPlaceholder')} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>{t('loc.cityLabel')}</Label>
                <Input aria-label={t('loc.cityLabel')} value={locForm.city} onChange={(e) => setLocForm((f) => ({ ...f, city: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('loc.postCode')}</Label>
                <Input aria-label={t('loc.postCode')} value={locForm.postCode} onChange={(e) => setLocForm((f) => ({ ...f, postCode: e.target.value }))} />
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
                <Input aria-label={t('dost.phonePlaceholder')} value={locForm.phone} onChange={(e) => setLocForm((f) => ({ ...f, phone: e.target.value }))} placeholder={t('dost.phonePlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('set.email')}</Label>
                <Input aria-label={t('set.email')} value={locForm.email} onChange={(e) => setLocForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t('loc.premisesLabel')}</Label>
                <Input aria-label={t('loc.premisesPlaceholder')} value={locForm.premisesId} onChange={(e) => setLocForm((f) => ({ ...f, premisesId: e.target.value.toUpperCase().slice(0, 40) }))} placeholder={t('loc.premisesPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('set.currency')}</Label>
                <Input aria-label={t('set.currency')} value={locForm.currency} onChange={(e) => setLocForm((f) => ({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) }))} />
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
            {/* §39 (v1.265.0, Square Vol 16 »Allow Firing from Expo KDS«):
                per-lokacijska nastavitev — ekspeditor na KDS zaslonu lahko z
                dvotapno potrditvijo pošlje zadržane tečaje v pripravo. Pre-DDL:
                preklop onemogočen z nasvetom poti konzole (migrBox v1.197
                vzorec); poslje se SAMO ob spremembi (ostalo shranjevanje
                lokacije ostane čisto). */}
            {locEditing && (
              <div className="flex items-center justify-between rounded-lg border border-stone-200 p-2.5">
                <div className="pr-2">
                  <Label className="text-sm">{t('loc.kdsExpoFire')}</Label>
                  <p className={`text-xs ${kdsExpoFireDdlActive ? 'text-stone-400' : 'text-amber-700'}`}>{kdsExpoFireDdlActive ? t('loc.kdsExpoFireHint') : t('loc.kdsExpoFireDdl')}</p>
                </div>
                <Switch
                  checked={locKdsExpoFire}
                  disabled={!kdsExpoFireDdlActive}
                  aria-label={t('loc.kdsExpoFire')}
                  onCheckedChange={setLocKdsExpoFire}
                />
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
        tabs={DASHBOARD_TABS}
        ctx={{ canManage, perms }}
        onNavigate={(t) => setActiveTab(t)}
        onRefresh={load}
        onNewOrder={() => { setActiveTab('mize'); document.getElementById('mize')?.scrollIntoView({ behavior: 'smooth' }) }}
        onLogout={() => setConfirmLogout(true)}
      />

      <footer className="mt-auto bg-white border-t border-stone-200 py-3 text-center text-xs text-stone-400 pb-[max(0.75rem,env(safe-area-inset-bottom))] mb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:mb-0">
        {/* ISSUE #74 V-16: noga brez verzije/besed rekonstrukcija/simulacija —
            tehnične podrobnosti živijo v Nastavitve → Sistem.
            Issue #73 audit-10: odmik na mobilnem (fiksna spodnja vrstica ne sme
            prekrivati noge, ko uporabnik drsa na konec strani). */}
        {t('dash.footer')}
      </footer>
    </main>
  )
}
