/**
 * Mapper sloj: produkcijska shema (Neon Postgres, 110 modelov) <-> API/UI oblika.
 * UI pričakuje UPPERCASE statusne vrednosti in poenotena polja (name/zone/seats/qty/...),
 * zato konverzije potekajo TUKAJ, ne v UI. Deluje proti obe shemi:
 *  - prisma/schema.prisma        (Postgres/Neon — produkcija; enumi, Json, Decimal)
 *  - prisma/schema.sqlite.prisma (lokalno zrcalo; String namesto enum/Json)
 */
import { randomUUID } from 'crypto'

/**
 * Issue #7 (P1, v1.104.0): toleranten parse alergenskega posnetka OrderItem
 * (LOKALNA čista funkcija — map.ts NE SME uvažati db verige; vzorec nid).
 */
function parseAllergenSnapshotLocal(raw: string | null | undefined): { codes?: unknown; status?: unknown } {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as { codes?: unknown; status?: unknown }
    }
  } catch {
    /* posnetek manjka/pokvarjen → prazno (nikoli ne meče) */
  }
  return {}
}

/** Nov ID za create (produkcijska shema ima String @id brez defaultov) */
export function nid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 25)
}

/** Zaokroži na 2 decimalki (denar) */
export function r2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

/** Decimal | string | null -> number */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && 'toNumber' in (v as Record<string, unknown>)) {
    try { return (v as { toNumber(): number }).toNumber() } catch { return fallback }
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Json (Postgres) ali String (SQLite) -> razčlenjena vrednost; odporen na double-encoding */
export function jparse<T = unknown>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T } catch { return fallback }
  }
  return v as T
}

/** object -> string za Json/String polja (enako obnašanje na obeh shemah) */
export function jstr(v: unknown): string {
  return JSON.stringify(v ?? null)
}

/* ───── Vloge (DB: owner|admin|manager|staff|waiter|bar|chef|kitchen ↔ UI: OWNER|ADMIN|MANAGER|WAITER|BAR|KITCHEN) ───── */

const ROLE_TO_UI: Record<string, string> = {
  owner: 'OWNER', admin: 'ADMIN', manager: 'MANAGER', staff: 'WAITER', waiter: 'WAITER',
  bar: 'BAR', chef: 'KITCHEN', kitchen: 'KITCHEN', cleaner: 'CLEANER',
  group_owner: 'GROUP_OWNER', org_admin: 'ORG_ADMIN', property_manager: 'PROPERTY_MANAGER',
  warehouse: 'WAREHOUSE', accounting: 'ACCOUNTING',
}
const ROLE_TO_DB: Record<string, string> = {
  OWNER: 'owner', ADMIN: 'admin', MANAGER: 'manager', WAITER: 'waiter', BAR: 'bar',
  KITCHEN: 'kitchen', KIOSK: 'staff', CLEANER: 'cleaner',
  GROUP_OWNER: 'group_owner', ORG_ADMIN: 'org_admin', PROPERTY_MANAGER: 'property_manager',
  WAREHOUSE: 'warehouse', ACCOUNTING: 'accounting',
}

export function roleToUI(role: string): string {
  return ROLE_TO_UI[role] || (ROLE_TO_UI[role.toLowerCase()] || 'WAITER')
}
export function roleToDB(role: string): string {
  return ROLE_TO_DB[role?.toUpperCase()] || 'staff'
}

/* ─────────────── Miza (DB: available|occupied|reserved|cleaning ↔ UI: FREE|OCCUPIED|RESERVED|DIRTY) ─────────────── */

const TABLE_TO_UI: Record<string, string> = {
  available: 'FREE', occupied: 'OCCUPIED', reserved: 'RESERVED', cleaning: 'DIRTY',
}
const TABLE_TO_DB: Record<string, string> = {
  FREE: 'available', OCCUPIED: 'occupied', RESERVED: 'reserved', DIRTY: 'cleaning',
}
export const tableStatusToUI = (s: string): string => TABLE_TO_UI[s] || 'FREE'
export const tableStatusToDB = (s: string): string => TABLE_TO_DB[s?.toUpperCase()] || 'available'

/* ─────────────── Naročilo (status: open|sent|prepared|paid|cancelled, freeform String v produkciji) ─────────────── */

const ORDER_TO_UI: Record<string, string> = {
  open: 'OPEN', sent: 'SENT', prepared: 'PREPARED', paid: 'PAID', cancelled: 'CANCELLED', pending: 'OPEN',
}
const ORDER_TO_DB: Record<string, string> = {
  OPEN: 'open', SENT: 'sent', PREPARED: 'prepared', PAID: 'paid', CANCELLED: 'cancelled',
}
export const orderStatusToUI = (s: string): string => ORDER_TO_UI[s] || 'OPEN'
export const orderStatusToDB = (s: string): string => ORDER_TO_DB[s?.toUpperCase()] || 'open'
export const ORDER_ACTIVE_DB = ['open', 'sent', 'prepared']

/* ─────────────── Artikli naročila (enum: pending|fired|preparing|ready|served|cancelled|voided) ─────────────── */

const ITEM_TO_UI: Record<string, string> = {
  pending: 'PENDING', fired: 'PREPARING', preparing: 'PREPARING', ready: 'READY', served: 'SERVED',
  cancelled: 'CANCELLED', voided: 'CANCELLED',
}
const ITEM_TO_DB: Record<string, string> = {
  PENDING: 'pending', PREPARING: 'preparing', READY: 'ready', SERVED: 'served', CANCELLED: 'cancelled',
}
export const itemStatusToUI = (s: string): string => ITEM_TO_UI[s] || 'PENDING'
export const itemStatusToDB = (s: string): string => ITEM_TO_DB[s?.toUpperCase()] || 'pending'
export const ITEM_ACTIVE_DB = ['pending', 'fired', 'preparing', 'ready']

/* ─────────────── Tip naročila (DB: dine-in|takeaway|delivery ↔ UI: DINE_IN|TAKEAWAY|DELIVERY) ─────────────── */

const TYPE_TO_UI: Record<string, string> = { 'dine-in': 'DINE_IN', takeaway: 'TAKEAWAY', delivery: 'DELIVERY' }
const TYPE_TO_DB: Record<string, string> = { DINE_IN: 'dine-in', TAKEAWAY: 'takeaway', DELIVERY: 'delivery' }
export const orderTypeToUI = (s: string): string => TYPE_TO_UI[s] || 'DINE_IN'
export const orderTypeToDB = (s: string): string => TYPE_TO_DB[s?.toUpperCase()] || 'dine-in'

/* ─────────────── Plačila (enum: unpaid|partial|paid|storno|cancelled; tip: cash|card|mobile|...) ─────────────── */

export const PAYMENT_TYPES_DB = ['cash', 'card', 'mobile', 'voucher', 'loyalty', 'giftcard', 'alternate']
export const paymentStatusToDB = (s: string): string => (s?.toLowerCase() === 'paid' ? 'paid' : 'unpaid')

/* ─────────────── Rezervacije (enum: confirmed|seated|completed|cancelled|no_show; vir: walk_in|phone|website|app) ─────────────── */

const RES_TO_UI: Record<string, string> = {
  confirmed: 'CONFIRMED', seated: 'SEATED', completed: 'COMPLETED', cancelled: 'CANCELLED', no_show: 'NO_SHOW',
}
const RES_TO_DB: Record<string, string> = {
  CONFIRMED: 'confirmed', SEATED: 'seated', COMPLETED: 'completed', CANCELLED: 'cancelled', NO_SHOW: 'no_show',
}
export const reservationStatusToUI = (s: string): string => RES_TO_UI[s] || 'CONFIRMED'
export const reservationStatusToDB = (s: string): string => RES_TO_DB[s?.toUpperCase()] || 'confirmed'
const RES_SOURCE_DB: Record<string, string> = { PHONE: 'phone', WEBSITE: 'website', APP: 'app' }
export const reservationSourceToDB = (s: string): string => RES_SOURCE_DB[s?.toUpperCase()] || 'walk_in'

/* ─────────────── Dostava (issue #2): DeliveryInfo/DeliveryZone; statusi freeform String ─────────────── */

const DELIVERY_TO_UI: Record<string, string> = {
  pending: 'PENDING', confirmed: 'CONFIRMED', assigned: 'ASSIGNED', picked_up: 'PICKED_UP',
  on_the_way: 'ON_THE_WAY', delivered: 'DELIVERED', cancelled: 'CANCELLED',
}
const DELIVERY_TO_DB: Record<string, string> = {
  PENDING: 'pending', CONFIRMED: 'confirmed', ASSIGNED: 'assigned', PICKED_UP: 'picked_up',
  ON_THE_WAY: 'on_the_way', DELIVERED: 'delivered', CANCELLED: 'cancelled',
}
export const deliveryStatusToUI = (s: string): string => DELIVERY_TO_UI[s] || 'PENDING'
export const deliveryStatusToDB = (s: string): string => DELIVERY_TO_DB[s?.toUpperCase()] || 'pending'
export const DELIVERY_STATUS_DB = [
  'pending', 'confirmed', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled',
] as const

export function mapDeliveryInfo(d: Row, tracking?: Row | null) {
  return {
    id: d.id as string,
    address: d.address as string,
    city: (d.city as string) || '',
    postCode: (d.postCode as string) || '',
    recipientName: (d.recipientName as string) || '',
    recipientPhone: (d.recipientPhone as string) || '',
    instructions: (d.deliveryInstructions as string) || '',
    status: deliveryStatusToUI(d.status as string),
    deliveryFee: num(d.deliveryFee),
    packagingFee: num(d.packagingFee),
    promisedTime: (d.promisedTime as string) || null,
    actualTime: (d.actualTime as string) || null,
    // OPS-9 val 3 (v1.76.0): provider ETA (webhook estimatedTime) — shown in the delivery cards
    estimatedTime: (d.estimatedTime as string) || null,
    courierName: (d.courierName as string) || '',
    courierPhone: (d.courierPhone as string) || '',
    driver: tracking
      ? {
          name: (tracking.driverName as string) || '',
          phone: (tracking.driverPhone as string) || '',
          status: (tracking.status as string) || 'assigned',
          estimatedArrival: (tracking.estimatedArrival as string) || null,
          // OPS-8 val 3 (v1.73.0): driver as Employee — id + resolved name (history list)
          employeeId: (tracking.driverEmployeeId as string) || null,
          employeeName: ((tracking as Row).Employee as Row | undefined)?.name ?? null,
        }
      : null,
  }
}

export function mapDeliveryZone(z: Row) {
  return {
    id: z.id as string,
    name: z.name as string,
    deliveryFee: num(z.deliveryFee, 2.5),
    minOrderAmount: num(z.minOrderAmount, 10),
    freeDeliveryAbove: num(z.freeDeliveryAbove),
    estimatedMinutes: (z.estimatedMinutes as number) || 30,
    isActive: z.isActive !== false,
    postCodes: jparse<string[]>(z.postCodes, []),
  }
}

/* ─────────────── Pripravljalne postaje (PrepStation.type: kitchen|bar ↔ UI: KITCHEN|BAR) ─────────────── */

export function stationToUI(type?: string | null): string {
  return type?.toLowerCase() === 'bar' ? 'BAR' : 'KITCHEN'
}

/* ─────────────── Konsolidirani mapperji vrstic -> API/UI oblika ─────────────── */

type Row = Record<string, unknown>

export function mapEmployee(e: Row) {
  return {
    id: e.id as string,
    name: e.name as string,
    email: e.email as string,
    role: roleToUI(e.role as string),
    active: e.status === 'active',
    locationId: (e.locationId as string) ?? null,
    phone: (e.phone as string) || null,
    /** DOVOLJENJA — kanonski seznam permission override-ov (R263/R264) */
    permissionOverrides: jparse<string[]>(e.permissionOverrides, []),
  }
}

export function mapTable(t: Row, activeOrder?: Row | null) {
  return {
    id: t.id as string,
    name: `Miza ${t.number}`,
    number: t.number as number,
    /** triage ⑧ — pogledi: lokacija mize za preklopnik */
    locationId: (t.locationId as string) ?? null,
    zone: (t.area as string) || 'Glavna dvorana',
    seats: t.capacity as number,
    posX: num(t.posX),
    posY: num(t.posY),
    /** v1.141.0 (Lightspeed benchmark): oblika mize za prostorski tloris —
        'square' (kvadratna, 2–6 sedežev), 'round' (okrogla, velika/barska),
        'stool' (barski stol, 1 sedež). Zgodovinske mize brez oblike → 'square'. */
    shape: ((t.shape as string) === 'round' || (t.shape as string) === 'stool') ? (t.shape as string) : 'square',
    // Issue #70 §1 (P1, v1.121.0): KANONIČNA izpeljava zasedenosti = AKTIVNO naročilo
    // (open/sent/prepared — include v /api/tables). DB 'occupied' BREZ aktivnega naročila
    // je zastarelo demo/odvodno stanje (vsak zaključek naročila — plačilo/storno/preklic —
    // postavi mizo v 'cleaning') → samodejno prikažemo kot DIRTY ("za pospraviti"), NE kot
    // zasedeno. 0 DDL: popravek je čisto v preslikavi, produkcijski podatki ostanejo
    // nedotaknjeni; dashboard/handheld/tablica izrisujejo IZKLJUČNO iz tega statusa.
    status: activeOrder
      ? 'OCCUPIED'
      : t.status === 'occupied'
        ? 'DIRTY'
        : tableStatusToUI(t.status as string),
    activeOrder: activeOrder
      ? {
          id: activeOrder.id as string,
          total: num(activeOrder.total),
          guests: (activeOrder.splitCount as number) || 1,
          itemCount: (activeOrder._count as { items?: number } | undefined)?.items
            ?? (activeOrder.items as unknown[] | undefined)?.length
            ?? 0,
        }
      : null,
  }
}

export function mapMenuItem(m: Row & { prepStation?: { type?: string } | null; Category?: unknown }) {
  // Task 51: lokacija artikla (prek Category → Menu, kadar je include podala ruta)
  // — klient filtrira meni naročilnega dialoga na lokacijo mize (server v ops.ts
  // ostane avtoritativa). Category je unknown: rute podajajo različne oblike
  // (z in brez Menu include) — varno ožanje znotraj.
  const catMenuLoc = (m.Category as { Menu?: { locationId?: string } | null } | undefined)?.Menu?.locationId
  return {
    id: m.id as string,
    name: m.name as string,
    price: num(m.price),
    description: (m.description as string) || '',
    station: stationToUI(m.prepStation?.type),
    available: m.isAvailable !== false,
    categoryId: (m.categoryId as string) ?? null,
    vatRate: num(m.vatRate, 22),
    locationId: catMenuLoc ?? null,
  }
}

export function mapCategory(c: Row) {
  return { id: c.id as string, name: c.name as string, sortOrder: c.sortOrder as number }
}

export function mapOrderItem(it: Row & { menuItem?: { prepStation?: { type?: string } | null } | null }) {
  // Issue #7 (P1, v1.104.0): alergenski posnetek postavke (kode ob nastanku —
  // tolerantno iz JSON niza) + izrecno opozorilo (gost/osebje) za KDS/bar/tisk
  const allergenSnap = parseAllergenSnapshotLocal(it.allergenSnapshot as string | null | undefined)
  return {
    id: it.id as string,
    name: (it.menuItemName as string) || 'Artikel',
    qty: it.quantity as number,
    unitPrice: num(it.price),
    vatRate: num(it.vatRate, 22),
    status: itemStatusToUI(it.status as string),
    station: stationToUI(it.menuItem?.prepStation?.type),
    note: (it.notes as string) || null,
    // Issue #7: ⚠ izrecno alergensko opozorilo — VEDNO vidno na KDS (preživi premik/osvežitev)
    allergenWarning: (it.allergenWarning as string) || '',
    // Issue #7: kode iz posnetka ob nastanku (zgodovina se ne spremeni s kasnejšim receptom)
    allergenCodes: Array.isArray(allergenSnap.codes)
      ? (allergenSnap.codes as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
    allergenStatus: typeof allergenSnap.status === 'string' ? allergenSnap.status : null,
    voided: it.voided === true,
    // OPS-7 coursing (v1.68.0): tečaj postavke (Course) — za urejevalnik naročila
    courseId: (it.courseId as string | null | undefined) ?? null,
    // OPS-9 val 3 (v1.76.0): firedAt for the KDS per-item live timer / delay-reason dialog
    firedAt: (it.firedAt as string | null | undefined) ?? null,
  }
}

export function mapOrder(o: Row & {
  items?: (Row & { menuItem?: { prepStation?: { type?: string } | null } | null })[]
  table?: Row | null
  employee?: Row | null
  receipts?: Row[]
}) {
  return {
    id: o.id as string,
    orderNumber: o.orderNumber as number,
    type: orderTypeToUI(o.type as string),
    status: orderStatusToUI(o.status as string),
    guests: (o.splitCount as number) || 1,
    note: (o.notes as string) || null,
    subtotal: num(o.subtotal),
    tax: num(o.tax),
    total: num(o.total),
    paymentStatus: o.paymentStatus as string,
    /** triage ⑧ — pogledi: lokacija naročila za preklopnik */
    locationId: (o.locationId as string) ?? null,
    tableId: (o.tableId as string) ?? null,
    table: o.table ? { name: `Miza ${o.table.number}`, zone: (o.table.area as string) || 'Glavna dvorana' } : null,
    employee: o.employee ? { name: o.employee.name as string } : null,
    createdAt: o.createdAt as string,
    paidAt: o.paidAt as string | null,
    fursEor: (o.receipts as Row[] | undefined)?.[0]?.eor ?? null,
    items: (o.items || []).map(mapOrderItem),
  }
}

export function mapReservation(r: Row) {
  return {
    id: r.id as string,
    guestName: r.customerName as string,
    phone: (r.customerPhone as string) || null,
    guests: r.partySize as number,
    reservedAt: r.dateTime as string,
    status: reservationStatusToUI(r.status as string),
    note: (r.notes as string) || null,
    tableId: (r.tableId as string) ?? null,
    locationId: (r.locationId as string) ?? null,
    createdAt: r.createdAt as string,
    // OPS-7 (v1.69.0): opomnik rezervacij — badge UI
    reminderSent: r.reminderSent === true,
    // OPS-8 val 3 (v1.73.0): dialog fields surfaced for API consumers (additive)
    email: (r.customerEmail as string) || '',
    duration: (r.duration as number) ?? 120,
    source: (r.source as string) || 'walk_in',
    specialRequests: (r.specialRequests as string) || '',
  }
}

export function mapShift(s: Row & { employee?: Row | null }) {
  return {
    id: s.id as string,
    employeeId: (s.employeeId as string) ?? null,
    employee: s.employee ? { name: s.employee.name as string, role: roleToUI((s.employee as Row).role as string) } : null,
    startedAt: s.openedAt as string,
    endedAt: (s.closedAt as string) ?? null,
    openingCash: num(s.startingCash),
    closingCash: num(s.closingCash),
    status: s.status as string,
    locationId: (s.locationId as string) ?? null,
  }
}

export function mapReceipt(r: Row) {
  return {
    id: r.id as string,
    invoiceNumber: r.receiptNumber as string,
    eor: r.eor as string,
    zoi: r.zoi as string,
    fiscalVerified: r.fiscalVerified === true,
    fiscalStatus: r.fiscalStatus as string,
    total: num(r.total),
    paymentMethod: r.paymentMethod as string,
    orderId: (r.orderId as string) ?? null,
    createdAt: r.createdAt as string,
  }
}

export function mapAudit(a: Row) {
  return {
    id: a.id as string,
    employeeId: (a.userId as string) ?? null,
    action: a.action as string,
    entity: a.entityType as string,
    entityId: (a.entityId as string) ?? null,
    data: (a.details as string) || null,
    createdAt: a.timestamp as string,
  }
}
