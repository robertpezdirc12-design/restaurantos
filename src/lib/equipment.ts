/**
 * OSS-1 (v1.200.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — čisti sloj
 * VZDRŽEVANJA OPREME (pure, 0 DB uvozov — vzorec payroll-rates.ts).
 *
 * Register naprav (pečice, hladilniki, klima …) + servisni načrti z intervali.
 * Overdue zastavice so IZPELJANE ob branju (dueStatus nad nextDueAt) — brez
 * cron stanja: ena resnica (načrt) + deterministična izpeljava ob vsakem
 * branju. Datum servisa v prihodnosti je napaka (servis se ne napoveduje
 * nazaj v čas — nič ne izmišljamo). Interval 1–3650 dni; status prost niz
 * z znanim množico (active | broken | retired) — GRN/WasteRecord konvencija.
 */

const DAY_MS = 86_400_000

export const EQUIPMENT_STATUSES = ['active', 'broken', 'retired'] as const
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number]

export const DEFAULT_EQUIPMENT_INTERVAL_DAYS = 90

/** Koliko dni pred zapadlostjo pokažemo »kmalu zapade« (deterministično). */
export const DUE_SOON_DAYS = 7

export interface EquipmentPlanCore {
  intervalDays: number
  lastServicedAt: Date | null
  nextDueAt: Date | null
  active: boolean
}

export type DueStatus = 'overdue' | 'dueSoon' | 'ok' | 'paused'

export interface ParsedEquipmentInput {
  name: string
  kind: string
  serialNumber: string | null
  installedAt: Date | null
  status: EquipmentStatus
  notes: string | null
  intervalDays: number
  planTitle: string
}

export interface ParsedEquipmentPatch {
  name?: string
  kind?: string
  serialNumber?: string | null
  installedAt?: Date | null
  status?: EquipmentStatus
  notes?: string | null
  intervalDays?: number
  planTitle?: string
  planActive?: boolean
}

export interface ParsedServiceInput {
  servicedAt: Date
  note: string | null
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function asTrimmedString(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string') return undefined
  return v.trim()
}

/** Datumsko polje: undefined = ni podano; ''/null = izrecno prazno; sicer ISO/datum niz. */
function parseDateField(v: unknown): { kind: 'absent' | 'empty' | 'date'; date?: Date } {
  if (v === undefined) return { kind: 'absent' }
  if (v === null || v === '') return { kind: 'empty' }
  if (typeof v !== 'string') return { kind: 'empty' }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return { kind: 'empty' }
  return { kind: 'date', date: d }
}

/** Naslednji servis = (zadnji servis ?? nastanitev načrta) + interval dni. */
export function nextDueAtFor(intervalDays: number, lastServicedAt: Date | null, fallback: Date): Date {
  const base = lastServicedAt ?? fallback
  return new Date(base.getTime() + intervalDays * DAY_MS)
}

/** Izpeljan status zapadlosti (deterministična UTC-dnevna aritmetika). */
export function dueStatus(plan: EquipmentPlanCore | null, now: Date): DueStatus {
  if (!plan || !plan.active) return 'paused'
  if (!plan.nextDueAt) return 'ok'
  const startToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const due = plan.nextDueAt.getTime()
  if (due < startToday) return 'overdue'
  if (due - startToday <= DUE_SOON_DAYS * DAY_MS) return 'dueSoon'
  return 'ok'
}

/** Dni do zapadlosti (negativno = zapadlo pred startom današnjega dne); null brez načrta/roka. */
export function dueInDays(plan: EquipmentPlanCore | null, now: Date): number | null {
  if (!plan || !plan.active || !plan.nextDueAt) return null
  const startToday = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  return Math.round((plan.nextDueAt.getTime() - startToday) / DAY_MS)
}

/** Vnos za CREATE opreme + načrta (obvezni naziv; ostalo z razumnimi privzetimi). */
export function parseEquipmentInput(body: unknown): ParseResult<ParsedEquipmentInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Neveljavno telo zahteve.' }
  const b = body as Record<string, unknown>

  const name = asTrimmedString(b.name)
  if (name === undefined || name.length < 1 || name.length > 80) {
    return { ok: false, error: 'Naziv je obvezen (1–80 znakov).' }
  }

  const kindRaw = asTrimmedString(b.kind)
  if (kindRaw !== undefined && kindRaw.length > 40) {
    return { ok: false, error: 'Vrsta opreme ima največ 40 znakov.' }
  }

  const serialRaw = asTrimmedString(b.serialNumber)
  if (serialRaw !== undefined && serialRaw.length > 80) {
    return { ok: false, error: 'Serijska številka ima največ 80 znakov.' }
  }

  const inst = parseDateField(b.installedAt)
  if (inst.kind === 'empty') {
    return { ok: false, error: 'Neveljaven datum namestitve.' }
  }

  const statusRaw = asTrimmedString(b.status) ?? 'active'
  if (!(EQUIPMENT_STATUSES as readonly string[]).includes(statusRaw)) {
    return { ok: false, error: 'Stanje mora biti eno od: active, broken, retired.' }
  }

  const notesRaw = asTrimmedString(b.notes)
  if (notesRaw !== undefined && notesRaw.length > 500) {
    return { ok: false, error: 'Opombe imajo največ 500 znakov.' }
  }

  let intervalDays = DEFAULT_EQUIPMENT_INTERVAL_DAYS
  if (b.intervalDays !== undefined && b.intervalDays !== null && b.intervalDays !== '') {
    const n = typeof b.intervalDays === 'number' ? b.intervalDays : Number(String(b.intervalDays))
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return { ok: false, error: 'Interval servisa mora biti celo število med 1 in 3650.' }
    }
    intervalDays = n
  }

  const planTitleRaw = asTrimmedString(b.planTitle)
  if (planTitleRaw !== undefined && planTitleRaw.length > 120) {
    return { ok: false, error: 'Naziv servisa ima največ 120 znakov.' }
  }

  return {
    ok: true,
    value: {
      name,
      kind: kindRaw && kindRaw.length > 0 ? kindRaw : 'other',
      serialNumber: serialRaw ?? null,
      installedAt: inst.kind === 'date' ? (inst.date as Date) : null,
      status: statusRaw as EquipmentStatus,
      notes: notesRaw ?? null,
      intervalDays,
      planTitle: planTitleRaw && planTitleRaw.length > 0 ? planTitleRaw : 'Servis',
    },
  }
}

/** Vnos za PATCH: vsa polja neobvezna; vsaj eno spremembo mora klic dati (preveri ruta). */
export function parseEquipmentPatch(body: unknown): ParseResult<ParsedEquipmentPatch> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Neveljavno telo zahteve.' }
  const b = body as Record<string, unknown>
  const out: ParsedEquipmentPatch = {}

  if ('name' in b) {
    const name = asTrimmedString(b.name)
    if (name === undefined || name.length < 1 || name.length > 80) {
      return { ok: false, error: 'Naziv je obvezen (1–80 znakov).' }
    }
    out.name = name
  }
  if ('kind' in b) {
    const kindRaw = asTrimmedString(b.kind)
    if (kindRaw !== undefined && kindRaw.length > 40) {
      return { ok: false, error: 'Vrsta opreme ima največ 40 znakov.' }
    }
    out.kind = kindRaw && kindRaw.length > 0 ? kindRaw : 'other'
  }
  if ('serialNumber' in b) {
    const serialRaw = asTrimmedString(b.serialNumber)
    if (serialRaw !== undefined && serialRaw.length > 80) {
      return { ok: false, error: 'Serijska številka ima največ 80 znakov.' }
    }
    out.serialNumber = serialRaw ?? null
  }
  if ('installedAt' in b) {
    const inst = parseDateField(b.installedAt)
    if (inst.kind === 'empty') return { ok: false, error: 'Neveljaven datum namestitve.' }
    out.installedAt = inst.kind === 'date' ? (inst.date as Date) : null
  }
  if ('status' in b) {
    const statusRaw = asTrimmedString(b.status)
    if (statusRaw === undefined || !(EQUIPMENT_STATUSES as readonly string[]).includes(statusRaw)) {
      return { ok: false, error: 'Stanje mora biti eno od: active, broken, retired.' }
    }
    out.status = statusRaw as EquipmentStatus
  }
  if ('notes' in b) {
    const notesRaw = asTrimmedString(b.notes)
    if (notesRaw !== undefined && notesRaw.length > 500) {
      return { ok: false, error: 'Opombe imajo največ 500 znakov.' }
    }
    out.notes = notesRaw ?? null
  }
  if ('intervalDays' in b) {
    const n = typeof b.intervalDays === 'number' ? b.intervalDays : Number(String(b.intervalDays))
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return { ok: false, error: 'Interval servisa mora biti celo število med 1 in 3650.' }
    }
    out.intervalDays = n
  }
  if ('planTitle' in b) {
    const planTitleRaw = asTrimmedString(b.planTitle)
    if (planTitleRaw !== undefined && planTitleRaw.length > 120) {
      return { ok: false, error: 'Naziv servisa ima največ 120 znakov.' }
    }
    out.planTitle = planTitleRaw ?? 'Servis'
  }
  if ('planActive' in b) {
    if (typeof b.planActive !== 'boolean') return { ok: false, error: 'Pavza servisa mora biti true/false.' }
    out.planActive = b.planActive
  }
  return { ok: true, value: out }
}

/** Vnos za »servis opravljen«: datum V PRIHODNOSTI je napaka (servis se ne napoveduje nazaj). */
export function parseServiceInput(body: unknown, now: Date): ParseResult<ParsedServiceInput> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Neveljavno telo zahteve.' }
  const b = body as Record<string, unknown>

  let servicedAt = now
  const svc = parseDateField(b.servicedAt)
  if (svc.kind === 'date') {
    servicedAt = svc.date as Date
  } else if (b.servicedAt !== undefined && b.servicedAt !== null && b.servicedAt !== '') {
    return { ok: false, error: 'Neveljaven datum servisa.' }
  }
  if (servicedAt.getTime() > now.getTime() + 60_000) {
    return { ok: false, error: 'Datum servisa ne sme biti v prihodnosti.' }
  }

  const noteRaw = asTrimmedString(b.note)
  if (noteRaw !== undefined && noteRaw.length > 500) {
    return { ok: false, error: 'Opomba servisa ima največ 500 znakov.' }
  }

  return { ok: true, value: { servicedAt, note: noteRaw ?? null } }
}

/* ───────────────────────── DTO (pure preslikava) ───────────────────────── */

export interface EquipmentPlanDto {
  id: string
  title: string
  intervalDays: number
  lastServicedAt: string | null
  nextDueAt: string | null
  active: boolean
  due: DueStatus
  dueInDays: number | null
}

export interface EquipmentDto {
  id: string
  locationId: string
  name: string
  kind: string
  serialNumber: string | null
  installedAt: string | null
  status: string
  notes: string | null
  plan: EquipmentPlanDto | null
}

interface EquipmentRowLike {
  id: string
  locationId: string
  name: string
  kind: string
  serialNumber: string | null
  installedAt: Date | null
  status: string
  notes: string | null
}

interface PlanRowLike extends EquipmentPlanCore {
  id: string
  title: string
}

/** Pure preslikava vrstic (Prisma rezultat) → JSON DTO z izpeljanim due statusom. */
export function equipmentDto(e: EquipmentRowLike, plan: PlanRowLike | null, now: Date): EquipmentDto {
  return {
    id: e.id,
    locationId: e.locationId,
    name: e.name,
    kind: e.kind,
    serialNumber: e.serialNumber,
    installedAt: e.installedAt ? e.installedAt.toISOString() : null,
    status: e.status,
    notes: e.notes,
    plan: plan
      ? {
          id: plan.id,
          title: plan.title,
          intervalDays: plan.intervalDays,
          lastServicedAt: plan.lastServicedAt ? plan.lastServicedAt.toISOString() : null,
          nextDueAt: plan.nextDueAt ? plan.nextDueAt.toISOString() : null,
          active: plan.active,
          due: dueStatus(plan, now),
          dueInDays: dueInDays(plan, now),
        }
      : null,
  }
}
