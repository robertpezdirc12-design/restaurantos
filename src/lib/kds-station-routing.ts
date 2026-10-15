/**
 * Issue #14 (P1/P2, v1.112.0) — KDS postajno usmerjanje: ČIST motor.
 *
 * NAČRT (Toast Prep Stations vzorec): poljubno število POIMENOVANIH postaj na
 * lokacijo (PrepStation — obstoječi model), usmerjanje ARTIKLA (primarna
 * PrepStation + dodatne MenuItemStation), usmerjanje OPCIJE (Modifier.prepStationId
 * — opcija odide na DRUGO postajo, ne da bi se podvojila postavka) in IZDAJNA
 * postaja (PrepStation.isExpo — sestava/izdaja celega artikla po končani pripravi).
 *
 * TA modul je PURE (brez DB uvozov — isti vzorec kot manager-call-registry.ts):
 *  - strežnik (src/lib/station-task-service.ts) ga pokliče ob FIRE-u za izdelavo
 *    nalog (StationTask) in ob vsaki spremembi statusa za rollup postavke;
 *  - testi pokrivajo motor neposredno (brez baze);
 *  - klient lahko deljenje ključe poglede (viewKey) uporablja za prikaz.
 *
 * ZDRAŽLJIVOST (issue §1): postaji tipa 'bar'/'kitchen' ostajata LEGACY vedra
 * BAR/KITCHEN — dokler lokal ne konfigurira poimenovanih postaj, se obnašanje
 * ne spremeni. Vsak drug tip ('grill', 'fry', 'salad', 'pizza', …) dobi SVOJ
 * pogled, ključan na id postaje.
 */

import type { StationTaskStatus } from '@/lib/prisma-types'

/** Legacy tipa postaj — preslikata se v (edina) zgodovinska vedra. */
export const STATION_LEGACY_TYPES = ['bar', 'kitchen'] as const

/** Zaporedna številka izdajne (expo) naloge — vedno ZADNJA v verigi. */
export const EXPO_SEQUENCE = 1_000_000

/** Statusi postajne naloge (proste vrednosti String stolpca). */
export const STATION_TASK_STATUSES = ['waiting', 'pending', 'preparing', 'ready', 'done'] as const

/** Terminalna statusa (nadaljnje prehode ni). */
export const TASK_TERMINAL = ['ready', 'done'] as const

/** Vrste nalog: priprava artikla / delo iz opcije / izdaja (expediter). */
export const STATION_TASK_KINDS = ['prep', 'modifier', 'expo'] as const
export type StationTaskKind = (typeof STATION_TASK_KINDS)[number]

/** Postaja, kot jo vidi motor (preslikana vrstica PrepStation). */
export interface StationRef {
  id: string
  name: string
  type: string
  avgPrepTime: number
  sortOrder: number
  isExpo: boolean
  isActive: boolean
}

/** En razreševalni vhod naloge za postavko naročila. */
export interface TaskPlanInput {
  /** aktivne postaje lokacije (razreševanje id → postaja) */
  stations: StationRef[]
  /** primarna postaja artikla (MenuItem.prepStationId) — null = brez */
  primaryStationId: string | null
  /** dodatne postaje artikla (MenuItemStation) */
  extraStationIds: string[]
  /** opcije postavke, usmerjene na DRUGO postajo: { stationId, names } */
  modifierStations: { stationId: string; names: string[] }[]
  /** izdelana postavka naročila (naslov + količina za posnetek naloge) */
  title: string
  quantity: number
}

/** Izdelana (še ne zapisana) naloga — vse Snapshot vrednosti. */
export interface TaskPlanItem {
  stationId: string
  stationName: string
  stationType: string
  kind: StationTaskKind
  sequence: number
  status: StationTaskStatus
  title: string
  detail: string
  quantity: number
}

/**
 * Pogled KDS deska za postajo: legacy tip → vedro (BAR/KITCHEN), custom tip →
 * id postaje. Enako pravilo za naloge (stationType posnetek) — vsee eno.
 */
export function stationViewKey(station: { id: string; type: string }): string {
  const t = station.type?.toLowerCase()
  if (t === 'bar') return 'BAR'
  if (t === 'kitchen') return 'KITCHEN'
  return station.id
}

/**
 * Izdelava načrta nalog za ENO postavko naročila (pokliče se ob FIRE-u).
 *
 * Pravila:
 *  1. postaje artikla = [primarna] + dodatne (dedup, samo AKTIVNE, znane) —
 *     vsaka dobi nalogo kind 'prep', sequence = sortOrder postaje (posnetek);
 *  2. brez usmeritve → PRIVZETA postaja: prva aktivna tipa 'kitchen' (legacy
 *     vedro); če je ni, postavka OSTANE brez nalog (čisti legacy prikaz);
 *  3. opcije, usmerjene na postajo, ki NI med postajami artikla → naloga
 *     kind 'modifier' (detail = imena opcij) — postavka se NE podvoji;
 *     opcije na postaji artikla se izpišejo kot detail obstoječe naloge;
 *  4. vsaka aktivna IZDAJNA postaja (isExpo) dobe nalogo kind 'expo',
 *     sequence = EXPO_SEQUENCE (vedno zadnja);
 *  5. zaporedje (issue §3): naloga je 'waiting', dokler ima predhodnico
 *     (STROGO manjši sequence, kind ≠ 'modifier' — opcije so vzporedno
 *     bočno delo in nikoli ne blokirajo/so blokirane) ki ni končana;
 *     izdajna naloga je 'waiting', dokler katera koli pripravljalna naloga
 *     ni 'ready'/'done'. Najnižja naloga vedno začne kot 'pending'.
 */
export function buildTaskPlan(input: TaskPlanInput): TaskPlanItem[] {
  const byId = new Map(input.stations.map((s) => [s.id, s]))
  const itemStationIds: string[] = []
  const seen = new Set<string>()
  for (const sid of [input.primaryStationId, ...input.extraStationIds]) {
    if (!sid || seen.has(sid)) continue
    const st = byId.get(sid)
    if (!st || !st.isActive) continue
    seen.add(sid)
    itemStationIds.push(sid)
  }
  // privzeta postaja (legacy): prva aktivna tipa 'kitchen'
  if (itemStationIds.length === 0) {
    const fallback = input.stations
      .filter((s) => s.isActive && s.type?.toLowerCase() === 'kitchen')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))[0]
    if (fallback) itemStationIds.push(fallback.id)
  }

  const tasks: TaskPlanItem[] = []
  const itemDetail: string[] = []

  for (const sid of itemStationIds) {
    const st = byId.get(sid)
    if (!st) continue
    tasks.push({
      stationId: st.id,
      stationName: st.name,
      stationType: st.type,
      kind: 'prep',
      sequence: st.sortOrder,
      status: 'pending',
      title: input.title,
      detail: '',
      quantity: input.quantity,
    })
  }

  // opcije: postaja, ki NI med postajami artikla → svoja naloga; sicer → detail
  const itemStationSet = new Set(itemStationIds)
  for (const ms of input.modifierStations) {
    const st = byId.get(ms.stationId)
    if (!st || !st.isActive) continue
    if (itemStationSet.has(ms.stationId)) {
      itemDetail.push(...ms.names)
      continue
    }
    tasks.push({
      stationId: st.id,
      stationName: st.name,
      stationType: st.type,
      kind: 'modifier',
      sequence: st.sortOrder,
      status: 'pending',
      title: input.title,
      detail: ms.names.join(', '),
      quantity: input.quantity,
    })
  }
  // detail opcij na postajah artikla → prva pripravljalna naloga
  if (itemDetail.length > 0) {
    const first = tasks.find((t) => t.kind === 'prep')
    if (first) first.detail = itemDetail.join(', ')
  }

  // izdajne postaje (samo če ima postavka vsaj en pripravljalni/modifikatorski korak)
  const hasPrep = tasks.some((t) => t.kind !== 'expo')
  if (hasPrep) {
    for (const st of input.stations) {
      if (!st.isActive || !st.isExpo) continue
      tasks.push({
        stationId: st.id,
        stationName: st.name,
        stationType: st.type,
        kind: 'expo',
        sequence: EXPO_SEQUENCE,
        status: 'pending',
        title: input.title,
        detail: '',
        quantity: input.quantity,
      })
    }
  }

  // zaporedna zapora: 'waiting', dokler predhodnica ni končana
  for (const t of tasks) {
    t.status = isTaskBlocked(t, tasks) ? 'waiting' : 'pending'
  }
  return tasks
}

/** Ali je naloga blokirana s predhodnico (STROGO manjši sequence, ne-opcijska)? */
export function isTaskBlocked(task: { sequence: number; kind: string }, siblings: { sequence: number; kind: string; status: string }[]): boolean {
  return siblings.some(
    (s) =>
      s !== task &&
      s.sequence < task.sequence &&
      s.kind !== 'modifier' &&
      !(TASK_TERMINAL as readonly string[]).includes(s.status)
  )
}

/**
 * Rollup statusa POSTAVKE iz njenih nalog (kanonični vir, ko naloge obstajajo):
 *  - vsa naloga končana (ready/done) + izdaja izvedena (katera koli 'done') → 'served';
 *  - vsa naloga končana brez izdaje → 'ready'  (kuhinja dokončana — legacy pomen);
 *  - katera koli naloga 'preparing' → 'preparing';
 *  - sicer (samo waiting/pending) → 'fired'.
 * Prazna tabela → null (postavka BREZ nalog — čisti legacy tok).
 */
export function itemStatusFromTasks(tasks: { kind: string; status: string }[]): 'served' | 'ready' | 'preparing' | 'fired' | null {
  if (tasks.length === 0) return null
  const terminal = tasks.every((t) => (TASK_TERMINAL as readonly string[]).includes(t.status))
  if (terminal) return tasks.some((t) => t.status === 'done') ? 'served' : 'ready'
  if (tasks.some((t) => t.status === 'preparing')) return 'preparing'
  return 'fired'
}

/** Ali sme naloga 'issue' (izdaja) — izvedejo se SAMO izdajne naloge. */
export function isIssueTask(task: { kind: string }): boolean {
  return task.kind === 'expo'
}

/** Prehodna pravila naloge (CAS where-pogoj → ciljni status). */
export function taskTransitionFrom(action: 'start' | 'ready' | 'issue'): { allowedFrom: StationTaskStatus[]; to: StationTaskStatus } | null {
  switch (action) {
    case 'start':
      return { allowedFrom: ['pending'], to: 'preparing' }
    case 'ready':
      return { allowedFrom: ['pending', 'preparing'], to: 'ready' }
    case 'issue':
      return { allowedFrom: ['pending', 'waiting'], to: 'done' }
    default:
      return null
  }
}
