/**
 * v1.166.0 — ZAČASNI demo zgodovina (del `bun run demo`; odstranitev:
 * docs/DEMO-DOSTOP.md §4).
 *
 * Analitiki na Pregledu («Prodaja in delo po urah», «Labor stroški») bereta SAMO
 * plačana naročila (paidAt) in zaključene delovne vnose (TimeEntry). Demo profil
 * brez njiju izgleda pokvarjen, zato ju generator naloži za zadnjih
 * `DEMO_HISTORY_DAYS` dni.
 *
 * Načrtovalnik je ČIST in determinističen: brez Date.now(), brez Math.random(),
 * brez dostopa do baze. Ide isto obliko podatkov kot `demoEnv()` — zapis v bazo naredi
 * `scripts/seed-demo-history.ts`.
 */

/** Okno zgodovine v dneh — poravnano s privzetim oknom obeh analiz (days=7). */
export const DEMO_HISTORY_DAYS = 7

/** Urna postavka po vlogi (EUR/uro, brez prispevkov delodajalca). */
export const DEMO_PAY_RATE_BY_ROLE: Record<string, number> = {
  owner: 16.4,
  admin: 14.5,
  manager: 12.5,
  chef: 12.8,
  staff: 9.4,
}
const DEFAULT_PAY_RATE = 9.4

export interface DemoHistoryMenuRow {
  id: string
  name: string
  price: number
  vatRate?: number | null
}

export interface DemoHistoryInput {
  now: Date
  locationId: string
  /** Največja uporabljena številka naročila — načrtovalnik šteje naprej od nje. */
  startOrderNumber: number
  menu: readonly DemoHistoryMenuRow[]
  tables: readonly { id: string }[]
  employees: readonly { id: string; role: string }[]
  days?: number
}

export interface DemoHistoryItem {
  id: string
  menuItemId: string
  menuItemName: string
  quantity: number
  price: number
  vatRate: number
  status: 'served'
}

export interface DemoHistoryOrder {
  id: string
  orderNumber: number
  type: 'dine-in' | 'takeout'
  status: 'paid'
  paymentStatus: 'paid'
  paymentMethod: string
  orderSource: 'pos'
  tableId: string | null
  employeeId: string
  locationId: string
  subtotal: number
  tax: number
  total: number
  createdAt: Date
  firedAt: Date
  paidAt: Date
  items: DemoHistoryItem[]
}

export interface DemoHistoryEntry {
  id: string
  employeeId: string
  locationId: string
  clockIn: Date
  clockOut: Date
  breakMinutes: number
  totalMinutes: number
  payRate: number
  totalPay: number
  type: 'regular'
  // 'approved', ne 'completed': TimeEntryStatus v produkcijski shemi pozna samo
  // active|approved|disputed. SQLite zrcalo ima String, zato lokalni tsc ne opozori.
  status: 'approved'
}

/** 32-bit FNV-1a — deterministično seme iz identifikatorjev (brez Math.random). */
function seedFrom(text: string): number {
  let h = 2166136261
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 — majhen, ponovljiv generator (enak izhod na enak niz). */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const c2 = (n: number) => Math.round(n * 100) / 100

/** Osnova = vsota artikov, DDV 22 % — enaka konvencija kot v ostalih demo seedih. */
const VAT_PERCENT = 22

function dayStart(base: Date, back: number): Date {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - back)
  return d
}

function atHour(day: Date, hour: number, minute: number): Date {
  const d = new Date(day)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Kosilo 11–14 in večerja 17–21; vikendi so gosto obiskani. */
const LUNCH_HOURS = [11, 12, 13, 14]
const DINNER_HOURS = [17, 18, 19, 20, 21]

function ordersForDay(
  input: DemoHistoryInput,
  day: Date,
  isToday: boolean,
  r: () => number,
  fromNumber: number,
): DemoHistoryOrder[] {
  const { tables } = input
  if (tables.length === 0) return []
  const nowHour = input.now.getHours()
  const weekend = day.getDay() === 0 || day.getDay() === 6
  const wanted = weekend ? 12 : 8
  const hours = [...LUNCH_HOURS, ...DINNER_HOURS].filter((h) => (isToday ? h <= nowHour : true))

  const out: DemoHistoryOrder[] = []
  if (hours.length === 0) {
    // Lokal se tega ni dotaknil (zgodnji juter): nekaj računov razporedimo po
    // zadnjih urah, da kartica »Prihodek danes« ni prazna ne glede na uro obiska.
    for (let i = 0; i < 3; i++) {
      const paidAt = new Date(input.now.getTime() - (25 + i * 30) * 60_000)
      out.push(buildOrder(input, out.length, paidAt, r, fromNumber + out.length))
    }
    return out
  }
  for (let i = 0; i < wanted; i++) {
    const hour = hours[Math.floor(r() * hours.length)]
    const paidAt = atHour(day, hour, Math.floor(r() * 60))
    if (paidAt.getTime() > input.now.getTime()) continue
    out.push(buildOrder(input, i, paidAt, r, fromNumber + out.length))
  }
  return out
}

function buildOrder(
  input: DemoHistoryInput,
  index: number,
  paidAt: Date,
  r: () => number,
  orderNumber: number,
): DemoHistoryOrder {
  const { menu, tables, employees, locationId } = input
  const count = 1 + Math.floor(r() * 3)
  const items: DemoHistoryItem[] = []
  for (let j = 0; j < count; j++) {
    const m = menu[Math.floor(r() * menu.length)]
    items.push({
      id: `dh-item-${orderNumber}-${j}`,
      menuItemId: m.id,
      menuItemName: m.name,
      quantity: 1 + Math.floor(r() * 2),
      price: c2(Number(m.price)),
      vatRate: Number(m.vatRate ?? VAT_PERCENT),
      status: 'served',
    })
  }
  const subtotal = c2(items.reduce((s, i) => s + i.price * i.quantity, 0))
  const tax = c2((subtotal * VAT_PERCENT) / 100)
  const created = new Date(paidAt.getTime() - (14 + Math.floor(r() * 22)) * 60_000)
  const isTakeout = r() < 0.2
  return {
    id: `dh-order-${orderNumber}`,
    orderNumber,
    type: isTakeout ? 'takeout' : 'dine-in',
    status: 'paid',
    paymentStatus: 'paid',
    paymentMethod: r() < 0.62 ? 'card' : 'cash',
    orderSource: 'pos',
    tableId: isTakeout ? null : tables[Math.floor(r() * tables.length)].id,
    employeeId: employees[Math.floor(r() * employees.length)].id,
    locationId,
    subtotal,
    tax,
    total: c2(subtotal + tax),
    createdAt: created,
    firedAt: new Date(created.getTime() + 60_000),
    paidAt,
    items,
  }
}

interface Shift { startHour: number; minutes: number; breakMinutes: number }

/** Jutranja in večerna izmena; ekipa se izmenjuje, da labor ni ravna črta. */
function shiftFor(role: string, index: number): Shift {
  const morning = (role === 'chef' || role === 'admin' || role === 'owner') === (index % 2 === 0)
  return { startHour: morning ? 9 : 15, minutes: 480, breakMinutes: 30 }
}

function entriesForWindow(input: DemoHistoryInput, days: number): DemoHistoryEntry[] {
  const out: DemoHistoryEntry[] = []
  for (let back = days - 1; back >= 0; back--) {
    const day = dayStart(input.now, back)
    for (const [i, emp] of input.employees.entries()) {
      const shift = shiftFor(emp.role, i + back)
      const clockIn = atHour(day, shift.startHour, 0)
      const clockOut = new Date(clockIn.getTime() + shift.minutes * 60_000)
      // odprt vnos se v analizah šteje »do zdaj«; demo profil rabi samo
      // zaključene izmene, zato jih tudi generira.
      if (clockOut.getTime() > input.now.getTime()) continue
      const totalMinutes = shift.minutes - shift.breakMinutes
      const payRate = DEMO_PAY_RATE_BY_ROLE[emp.role] ?? DEFAULT_PAY_RATE
      out.push({
        id: `dh-time-${emp.id}-${clockIn.getTime()}`,
        employeeId: emp.id,
        locationId: input.locationId,
        clockIn,
        clockOut,
        breakMinutes: shift.breakMinutes,
        totalMinutes,
        payRate,
        totalPay: c2((totalMinutes / 60) * payRate),
        type: 'regular',
        status: 'approved',
      })
    }
  }
  return out
}

/**
 * Zgradi načrt demo zgodovine. Prazen meni pomeni, da lokacija nima kaj prodati
 * → brez naročil in brez izmen (seed v tem primeru ne zapiše ničesar).
 */
export function demoHistoryPlan(input: DemoHistoryInput): {
  orders: DemoHistoryOrder[]
  entries: DemoHistoryEntry[]
} {
  const days = input.days ?? DEMO_HISTORY_DAYS
  if (input.menu.length === 0 || input.employees.length === 0 || !Number.isInteger(days) || days <= 0) {
    return { orders: [], entries: [] }
  }
  const orders: DemoHistoryOrder[] = []
  let nextNumber = input.startOrderNumber + 1
  for (let back = days - 1; back >= 0; back--) {
    const day = dayStart(input.now, back)
    const r = random(seedFrom(`${input.locationId}|${day.getTime()}`))
    const made = ordersForDay(input, day, back === 0, r, nextNumber)
    orders.push(...made)
    nextNumber += made.length
  }
  return { orders, entries: entriesForWindow(input, days) }
}
