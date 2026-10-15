import { NextRequest } from 'next/server'
import type { HaccpCategory, HaccpStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuthWithPerms, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { num, nid, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import {
  evalMeasurement,
  evalConfirm,
  ruleSnapshotOf,
  thresholdText,
  occurrenceForDate,
  haccpOpsColumnsReady,
  numStrict,
  type LocalDate,
} from '@/lib/haccp-ops'

const HACCP_TYPES = ['temperature', 'cleaning', 'delivery', 'cooling', 'training'] as const
const HACCP_STATUSES = ['ok', 'warning', 'critical'] as const

/**
 * Issue #5 (P0 §C): GET = settings.manage ALI haccp.execute (pregled kontrol
 * za izvajalce); POST = haccp.execute (izvedba) — urejanje NAČRTOV ostaja
 * ločeno v /api/haccp/plans (settings.manage).
 *
 * Issue #20 (v1.109.0) — GOVERNED tok: kadar POST navede planId, status NE
 * more podati klient — strežnik ga izračuna iz pravil načrta (evalMeasurement/
 * evalConfirm), zapis dobi posnetek pravil (ruleSnapshot) + termin
 * (occurrenceKey/dueAt po časovnem pasu LOKACIJE) + življenjski cikel
 * (done | deviation → korektiv → verifikacija → closed; rute /api/haccp/[id]/
 * actions). Brez planId ostaja LEGACY ad-hoc tok nespremenjen (issue: "Nezvezane
 * ad-hoc kontrole lahko ostanejo podprte").
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  if (!ctx.perms.includes('settings.manage') && !ctx.perms.includes('haccp.execute')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: settings.manage | haccp.execute.', 403)
  }
  const user = ctx.user
  const url = new URL(req.url)
  const state = url.searchParams.get('state')
  const planId = url.searchParams.get('planId')
  const rows = await db.haccpEntry.findMany({
    where: {
      ...(await locationScope(user)),
      ...(state ? { entryState: state } : {}),
      ...(planId ? { planId } : {}),
    },
    orderBy: { date: 'desc' },
    take: 100,
  })
  return ok({
    haccpChecks: rows.map((r) => ({
      id: r.id,
      type: r.category.toUpperCase(),
      target: r.title,
      value: r.numericValue !== null && r.numericValue !== undefined ? num(r.numericValue) : r.value ? num(r.value) : null,
      ok: r.status === 'ok',
      note: r.description || null,
      employeeId: r.employeeName || null,
      checkedAt: r.date,
      locationId: r.locationId,
      // Issue #20 — operativna polja (legacy vrstice: prazni)
      planId: r.planId || null,
      planName: r.planName || null,
      planVersion: r.planVersion || null,
      entryState: r.entryState || 'legacy',
      status: r.status,
      measureKind: r.measureKind || null,
      unit: r.unit || null,
      dueAt: r.dueAt ?? null,
      occurrenceKey: r.occurrenceKey || null,
      closedAt: r.closedAt ?? null,
      source: r.source || 'manual',
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'haccp.execute')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  // Issue #5: requireUserLocation (§10 — brez findFirst() fallbacka)
  const locationId = requireUserLocation(user)
  if (isResponse(locationId)) return locationId

  const planId = typeof body?.planId === 'string' && body.planId.trim() ? body.planId.trim() : ''

  /* ─────────── GOVERNED tok (Issue #20) ─────────── */
  if (planId) {
    if (!(await haccpOpsColumnsReady())) {
      return fail('Operativni HACCP tok še ni aktiviran — zahteva DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
    }
    const plan = await db.haccpPlan.findUnique({ where: { id: planId } })
    if (!plan) return fail('Načrt ne obstaja.', 404)
    // lokacijski + org sloj na NAČRTU (plan je lahko centralno brez lokacije)
    const guard = await guardResource(user, plan.locationId)
    if (guard) return guard

    const rule = ruleSnapshotOf(plan)
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : ''

    // meritev po vrsti načrta — number ZAHTeva številko, confirm izid
    let severity: 'ok' | 'warning' | 'critical'
    let numericValue: number | null = null
    if (rule.measureKind === 'number') {
      const v = numStrict(body?.numericValue)
      if (v === null) return fail('Numerična meritev je obvezna za ta načrt.', 400)
      numericValue = v
      severity = evalMeasurement(rule, v)
    } else {
      const outcome = String(body?.outcome ?? '').toLowerCase()
      if (outcome !== 'pass' && outcome !== 'fail') return fail("Potrditvena kontrola zahteva izid ('pass' | 'fail').", 400)
      severity = evalConfirm(rule, outcome)
    }
    // klientov status/ok je pri governed toku IGNORIRAN — strežnik odloča
    // (issue: "stranka ne sme poljubno označiti kot OK, če meritev presega mejo")

    // termin (dueDate = lokalni datum termina "YYYY-MM-DD"); brez dueDate =
    // izven-terminski vnos (dodatna kontrola, occurrenceKey '')
    let occurrenceKey = ''
    let dueAt: Date | null = null
    const dueDate = typeof body?.dueDate === 'string' ? body.dueDate.trim() : ''
    if (dueDate) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate)
      if (!m) return fail('dueDate mora biti v obliki YYYY-MM-DD.', 400)
      const date: LocalDate = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
      const loc = await db.location.findUnique({ where: { id: locationId }, select: { timezone: true } })
      const tz = loc?.timezone || 'Europe/Ljubljana'
      const occ = occurrenceForDate(
        { id: plan.id, frequency: plan.frequency, dueTime: plan.dueTime, weekday: plan.weekday, monthDay: plan.monthDay },
        date,
        tz,
      )
      if (!occ) return fail('Datum ni termina tega načrta (pogostost/dan se ne ujema).', 400)
      // podvojen termin: ena izvedba na termin (issue: brez podvojenih zapisov)
      const dup = await db.haccpEntry.findFirst({ where: { occurrenceKey: occ.key }, select: { id: true } })
      if (dup) return fail('Kontrola za ta termin je že vnesena.', 409)
      occurrenceKey = occ.key
      dueAt = occ.dueAt
    }

    const entryState = severity === 'ok' ? 'done' : 'deviation'
    const __aId = nid()
    const __chain = await auditChainFields(db, {
      id: __aId,
      model: 'haccpEntry',
      action: 'HACCP_ENTRY',
      entityType: 'HaccpEntry',
      entityId: __aId,
      details: {
        category: plan.category,
        title: plan.name,
        value: numericValue !== null ? String(numericValue) : '',
        status: severity,
        description: note,
        correctiveAction: '',
        employeeName: user.name || '',
        // Issue #20 — governed kontekst (vidno tudi v audit verigi)
        planId: plan.id,
        planVersion: rule.planVersion,
        occurrenceKey,
        entryState,
        measureKind: rule.measureKind,
        unit: rule.unit,
      },
      locationId,
    })
    const row = await db.haccpEntry.create({
      data: {
        ...__chain,
        id: __aId,
        category: plan.category as HaccpCategory,
        title: plan.name,
        value: numericValue !== null ? String(numericValue) : '',
        status: severity as HaccpStatus,
        description: note,
        correctiveAction: '',
        employeeName: user.name || '',
        date: new Date(),
        locationId,
        planId: plan.id,
        planName: plan.name,
        planVersion: rule.planVersion,
        ruleSnapshot: jstr(rule),
        measureKind: rule.measureKind,
        numericValue,
        unit: rule.unit,
        occurrenceKey,
        dueAt,
        entryState,
        source: 'manual',
      },
    })

    // takojšen push ob KRITIČNEM odstopanju (warning ni dogodek — šum)
    if (severity === 'critical') {
      const valueTxt = numericValue !== null ? `${numericValue} ${rule.unit}`.trim() : 'izid NE V REDU'
      void pushEvent(
        'HACCP_DEVIATION',
        {
          title: 'HACCP odstopanje',
          body: `${plan.name}: ${valueTxt} (meja: ${thresholdText(rule)})`,
          url: '/dashboard?tab=haccp',
          tag: `haccp-dev-${row.id}`,
        },
        { roles: ['manager'], locationId },
      )
    }

    return ok(
      {
        check: {
          id: row.id,
          type: row.category.toUpperCase(),
          target: row.title,
          value: row.numericValue !== null ? num(row.numericValue) : null,
          ok: row.status === 'ok',
          note: row.description || null,
          employeeId: row.employeeName || null,
          checkedAt: row.date,
          planId: row.planId,
          planName: row.planName,
          planVersion: row.planVersion,
          entryState: row.entryState,
          status: row.status,
          measureKind: row.measureKind,
          unit: row.unit,
          dueAt: row.dueAt,
          occurrenceKey: row.occurrenceKey,
          thresholdText: thresholdText(rule),
        },
      },
      201,
    )
  }

  /* ─────────── LEGACY ad-hoc tok (nespremenjen) ─────────── */
  const type = String(body?.type || '').toLowerCase()
  const target = String(body?.target || '').trim()
  if (!HACCP_TYPES.includes(type as (typeof HACCP_TYPES)[number])) return fail('Neznana vrsta kontrole.', 400)
  if (!target) return fail('Cilj kontrole (target) je obvezen.', 400)
  const status = body?.status && HACCP_STATUSES.includes(String(body.status) as (typeof HACCP_STATUSES)[number])
    ? String(body.status)
    : (body?.ok === false ? 'warning' : 'ok')
  const value = body?.value !== undefined && body?.value !== null && String(body.value) !== '' ? String(num(body.value)) : ''
  // 33-c: HaccpEntry dobí tamper-evidentno verigo (model 'haccpEntry' — audit §6/§193)
  const __aId = nid()
  const __chain = await auditChainFields(db, {
    id: __aId,
    model: 'haccpEntry',
    action: 'HACCP_ENTRY',
    entityType: 'HaccpEntry',
    entityId: __aId,
    details: { category: type, title: target, value, status, description: String(body?.note || ''), correctiveAction: String(body?.correctiveAction || ''), employeeName: user.name || '' },
    locationId,
  })
  const row = await db.haccpEntry.create({
    data: {
      ...__chain,
      id: __aId, category: type as HaccpCategory, title: target, value, status: status as HaccpStatus,
      description: String(body?.note || ''), correctiveAction: String(body?.correctiveAction || ''),
      employeeName: user.name || '', date: new Date(), locationId,
    },
  })
  return ok({ check: {
    id: row.id, type: row.category.toUpperCase(), target: row.title, value: row.value ? num(row.value) : null,
    ok: row.status === 'ok', note: row.description || null, employeeId: row.employeeName || null, checkedAt: row.date,
  } }, 201)
}
