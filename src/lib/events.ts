/**
 * Issue #11 §3 — event-driven temelj (faza 1): EventLog + publish + dispatch + retry.
 *
 * Zasnova:
 *  - `publishEvent(type, …)` ZAPISE dogodek (status pending) in NE MECE napak —
 *    objava dogodka nikoli ne sme porušiti poslovnega toka (§18 /增量 navodila #11).
 *  - handler registri: `registerHandler(type, fn)` — faza 1 brez stranskih default
 *    handlerjev (prijavljajo jih naslednji inkrementi); machinerija (dispatch,
 *    retry, statusi) je tu in testirana.
 *  - `dispatchPending(limit)`: prevzame pending + failed (attempts < MAX_ATTEMPTS),
 *    požene vse handlerje tipa, nastavi status processed/failed (+ attempts, error).
 *  - dispatch se lahko pokliče iz POST /api/events/dispatch (ops) ali health skripte.
 *
 * Vrste dogodkov (issue #11 §3): OrderCreated, OrderUpdated, OrderCancelled,
 * PaymentCompleted, InvoiceCreated, StockChanged, KitchenCompleted.
 */
import { nid } from '@/lib/map'
import { chainForLocation } from '@/lib/tenant'
import type { AuthPayload } from '@/lib/auth'

export const EVENT_TYPES = [
  'OrderCreated',
  'OrderUpdated',
  'OrderCancelled',
  'PaymentCompleted',
  'InvoiceCreated',
  'StockChanged',
  'KitchenCompleted',
] as const

export type RestaurantEventType = (typeof EVENT_TYPES)[number]

export const MAX_EVENT_ATTEMPTS = 5

export interface EventRecord {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: string
  status: string
  attempts: number
  error: string
  /** Issue #38: tenant ključ dogodka (strežniško izpeljan; null = neznan/legacy). */
  locationId?: string | null
}

type EventHandler = (evt: EventRecord) => Promise<void>

const handlers = new Map<string, EventHandler[]>()

/** Registriraj handler za tip dogodka (več handlerjev na tip je dovoljeno). */
export function registerHandler(type: string, handler: EventHandler): void {
  const list = handlers.get(type) || []
  list.push(handler)
  handlers.set(type, list)
}

/** Test-only: počisti registre. */
export function __resetHandlersForTests(): void {
  handlers.clear()
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Objava dogodka: INSERT v EventLog (pending) + detached dispatch (ne blokira klicatelja).
 * Vrne id dogodka ali null (ob napaki — nikoli ne meče; poslovni tok je svet).
 *
 * Issue #38 (P1): `opts.locationId` je KANONIČNI tenant ključ dogodka in ga klicatelj
 * prenese iz PREVERJENE strežniške entitete/konteksta (npr. `order.locationId`,
 * `st.locationId`, `row.locationId` prebrane iz DB po avtorizaciji). IZKLJUČNO
 * prepovedano: izpeljava iz klientovega `payload.locationId` (lažen payload ne sme
 * preskočiti tenant obsega — filter GET/dispatch deluje nad DB stolpcem, ne payloadom).
 * Dogodki brez zanesljive lokacije (npr. globalne integracije) ostanejo NULL →
 * fail-closed: vidni/dispatchani SAMO bootstrap platformnemu operaterju.
 */
export async function publishEvent(
  type: string,
  opts: {
    entityType?: string
    entityId?: string
    payload?: Record<string, unknown>
    /** Issue #38: verifikovana strežniška lokacija dogodka (null = neznan tenant). */
    locationId?: string | null
  } = {},
): Promise<string | null> {
  try {
    const { db } = await import('@/lib/db')
    const id = nid()
    await db.eventLog.create({
      data: {
        id,
        type,
        entityType: (opts.entityType || '').slice(0, 60),
        entityId: (opts.entityId || '').slice(0, 64),
        payload: JSON.stringify(opts.payload || {}).slice(0, 8000),
        locationId: opts.locationId ?? null,
      },
    })
    // Detached dispatch — napake so ujete v dispatchEvent in zapisane v EventLog.
    // (Sistemski klic BREZ tenant obsega: obdelava vrste ne razkriva payload-a
    // nikomur — klicatelj dobi samo id dogodka, ne rezultatov dispatcha.)
    void dispatchPending(1).catch(() => undefined)
    return id
  } catch (e) {
    console.error(`[events] publishEvent(${type}) napaka:`, (e as Error).message)
    return null
  }
}

/** Požene vse handlerje za dogodek; uspeh = vsi handlerji uspešni. */
export async function dispatchEvent(evt: EventRecord): Promise<{ ok: boolean; error: string }> {
  const list = handlers.get(evt.type) || []
  if (list.length === 0) {
    // brez handlerjev → dogodek je »potrošen« (evidenca ostaja; replay je mogoč)
    return { ok: true, error: '' }
  }
  for (const h of list) {
    try {
      await h(evt)
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'handler napaka' }
    }
  }
  return { ok: true, error: '' }
}

/**
 * Pregled vrste: pending najprej (FIFO), nato failed z attempts < MAX (retry).
 * Vrne števila po statusih; klicalcev (API/ops) dobi povzetek.
 *
 * Issue #38: `scope.locationIdIn` OMEJI obdelavo na tenant obseg klicatelja
 * (org centralna vloga obdeluje SAMO dogodke svoje organizacije; dogodki z
 * locationId NULL so izključeni — to je izrecna operacija platformnega
 * operaterja). Brez scope = sistemski klic (publishEvent detached dispatch,
 * health skripte) — obdelava poteka strežniško, brez razkritja payload-a.
 */
export async function dispatchPending(
  limit = 25,
  scope?: { locationIdIn?: string[] },
): Promise<{ processed: number; failed: number; scanned: number }> {
  const { db } = await import('@/lib/db')
  let processed = 0
  let failed = 0

  const tenantWhere: Record<string, unknown> = scope?.locationIdIn
    ? { locationId: { in: scope.locationIdIn } }
    : {}

  const batch = await db.eventLog.findMany({
    where: {
      OR: [
        { status: 'pending' },
        { status: 'failed', attempts: { lt: MAX_EVENT_ATTEMPTS } },
      ],
      ...tenantWhere,
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
    select: { id: true, type: true, entityType: true, entityId: true, payload: true, status: true, attempts: true, error: true, locationId: true },
  })

  for (const row of batch) {
    const evt: EventRecord = { ...row }
    const result = await dispatchEvent(evt)
    if (result.ok) {
      await db.eventLog.update({
        where: { id: evt.id },
        data: { status: 'processed', attempts: { increment: 1 }, error: '', processedAt: new Date() },
      }).catch(() => undefined)
      processed++
    } else {
      await db.eventLog.update({
        where: { id: evt.id },
        data: { status: 'failed', attempts: { increment: 1 }, error: result.error.slice(0, 500) },
      }).catch(() => undefined)
      failed++
    }
  }
  return { processed, failed, scanned: batch.length }
}

/* ───────────── Issue #38 — tenant obseg dogodkovne vrste ───────────── */

/**
 * Tenant obseg centralne vloge nad dogodkovno vrsto (STREŽNIŠKO izpeljan):
 *  - 'global' — bootstrap admin (sub='bootstrap'): break-glass, vidi/dispatcha
 *    VSE dogodke, vključno z legacy NULL (izrecni platformni operater);
 *  - 'org' — centralna vloga z zavezano organizacijo: SAMO dogodki, katerih
 *    locationId pripada lokacijam njene organizacije (STROGI seznam — brez
 *    legacy nevezanih lokacij, ker njihovega tenanta ni mogoče zanesljivo
 *    izpeljati → fail-closed izključitev);
 *  - 'none' — centralna vloga z NEZNANO organizacijo (loc null / nevezana
 *    lokacija): fail-closed — prazen seznam, števci 0, dispatch 403.
 *    LocationId dogodka NE sme biti nikoli izpeljan iz klienta.
 */
export type EventTenantScope =
  | { kind: 'global' }
  | { kind: 'org'; locationIds: string[] }
  | { kind: 'none' }

export async function eventTenantScope(user: AuthPayload): Promise<EventTenantScope> {
  if (user.role === 'ADMIN' && user.sub === 'bootstrap') return { kind: 'global' }
  const chain = await chainForLocation(user.loc)
  const orgId = chain?.organizationId ?? null
  if (!orgId) return { kind: 'none' }
  const { db } = await import('@/lib/db')
  const rows = await db.location.findMany({
    where: { Property: { Brand: { organizationId: orgId } } },
    select: { id: true },
  })
  return { kind: 'org', locationIds: rows.map((r) => r.id) }
}

/** Where-pogoj za tenant obseg (uporabno za seznam + števce + dispatch). */
export function eventScopeWhere(scope: EventTenantScope): Record<string, unknown> {
  if (scope.kind === 'global') return {}
  if (scope.kind === 'org') return { locationId: { in: scope.locationIds } }
  // 'none' — fail-closed: ne ujame ničesar (id, ki ne obstaja)
  return { id: '__event_scope_none__' }
}

/** Izvoz payload-a kot objekt (za API prikaz). */
export function eventPayload(evt: { payload: string }): Record<string, unknown> {
  return parsePayload(evt.payload)
}
