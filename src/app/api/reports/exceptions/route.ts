import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { jparse, num } from '@/lib/map'

/**
 * Issue #19 (P1/P2, v1.107.0) — GET /api/reports/exceptions?from&to&format=json|csv
 *
 * Poročilo o finančnih izjemah po lokaciji, obdobju, vrsti, razlogu, zaposlenem
 * in odobritelju — iz KANONIČNIH audit vrstic (en vir resnice; nobenega
 * ločenega stanja). Vrste izjem:
 *   discount           DISCOUNT_APPLIED           (znesek, source register|adhoc)
 *   discount_remove    DISCOUNT_REMOVED           (removedAmount)
 *   void               ORDER_ITEM_VOID            (amountRemovedFromOrder — NETO
 *                                               zmanjšanje NEPLAČANEGA naročila,
 *                                               NI vračilo denarja)
 *   cancel             ORDER_CANCELLED + ORDER_STATUS_CANCELLED_OVERRIDE (total)
 *   storno             RECEIPT_STORNO             (total — fiskalna negacija
 *                                               plačanega računa + povračilo zaloge)
 *
 * BREZ dvojnega štetja (issue zahteva): vsaka audit vrstica je EN dogodek;
 * kompenzacija/void/storno so LOČENE vrste (dobropis ni refund, storno ni void).
 * Zneski po vrstah niso seštevani čez vrste (vsaka vrsta nosi svojo knjižno
 * vrednost; skupni »obseg izjem« se izrazi kot št. dogodkov, ne vsota mešanih
 * predznakov — storno/void imata negativen/promemotor učinek na promet).
 *
 * Obseg: reports.view + locationScope (tenant izolacija — issue #6; uporabnik
 * druge lokacije/org vidi SVOJE izjeme). CSV: UTF-8 BOM + `;` (hišni standard).
 */
const EXCEPTION_ACTIONS: Record<string, string> = {
  DISCOUNT_APPLIED: 'discount',
  DISCOUNT_REMOVED: 'discount_remove',
  ORDER_ITEM_VOID: 'void',
  ORDER_CANCELLED: 'cancel',
  ORDER_STATUS_CANCELLED_OVERRIDE: 'cancel',
  RECEIPT_STORNO: 'storno',
}

/** Znesek, ki ga posamezna vrsta izjeme nosi (kanonično polje v details). */
function amountOf(kind: string, d: Record<string, unknown>): number | null {
  switch (kind) {
    case 'discount':
      return d.amount !== undefined ? num(d.amount) : null
    case 'discount_remove':
      return d.removedAmount !== undefined ? num(d.removedAmount) : null
    case 'void':
      return d.amountRemovedFromOrder !== undefined ? num(d.amountRemovedFromOrder) : null
    case 'cancel':
      return d.total !== undefined ? num(d.total) : null
    case 'storno':
      return d.total !== undefined ? Math.abs(num(d.total)) : null
    default:
      return null
  }
}

const MAX_ROWS = 2000

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = req.nextUrl
  const fromStr = url.searchParams.get('from') || ''
  const toStr = url.searchParams.get('to') || ''
  const format = (url.searchParams.get('format') || 'json').toLowerCase()
  const kindFilter = (url.searchParams.get('kind') || '').toLowerCase()

  const from = fromStr ? new Date(fromStr) : new Date(Date.now() - 30 * 24 * 3600_000)
  const to = toStr ? new Date(toStr) : new Date()
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return fail('Neveljaven from/to (pričakovano YYYY-MM-DD).', 400)
  }
  const toEnd = new Date(to.getTime() + 24 * 3600_000 - 1) // vključujoč konec dneva

  const locScope = await locationScope(user)
  const rows = await db.auditLog.findMany({
    where: {
      action: { in: Object.keys(EXCEPTION_ACTIONS) },
      timestamp: { gte: from, lte: toEnd },
      ...locScope,
    },
    orderBy: { timestamp: 'desc' },
    take: MAX_ROWS,
    select: { id: true, timestamp: true, userId: true, action: true, entityType: true, entityId: true, details: true, locationId: true },
  })

  interface ExcRow {
    id: string
    at: string
    kind: string
    action: string
    actorId: string | null
    actorName: string | null
    amount: number | null
    orderNumber: number | null
    receiptNumber: string | null
    reasonId: string | null
    reasonName: string | null
    reasonText: string | null
    reasonComment: string | null
    approved: boolean
    approvalMethod: string | null
    approverId: string | null
    approverName: string | null
    approvalBasis: string | null
    entityId: string
    entityType: string
  }

  // imena akterjev/odobriteljev: Employee bulk (zgodovinska imena živijo v
  // details.by — fallback iz Employee vrstic za aktualna)
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))]
  const employees = userIds.length
    ? await db.employee.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(employees.map((e) => [e.id, e.name]))

  const excRows: ExcRow[] = []
  for (const r of rows) {
    const kind = EXCEPTION_ACTIONS[r.action] || 'unknown'
    if (kindFilter && kind !== kindFilter) continue
    const d = jparse<Record<string, unknown>>(r.details, {})
    const approverId = typeof d.approverId === 'string' ? d.approverId : null
    let approverName = typeof d.approverName === 'string' ? d.approverName : null
    if (approverId && !approverName) approverName = nameById.get(approverId) ?? null
    excRows.push({
      id: r.id,
      at: r.timestamp.toISOString(),
      kind,
      action: r.action,
      actorId: r.userId,
      actorName: nameById.get(r.userId || '') ?? (typeof d.by === 'string' ? d.by : null),
      amount: amountOf(kind, d),
      orderNumber: d.orderNumber !== undefined && d.orderNumber !== null ? Number(d.orderNumber) : null,
      receiptNumber:
        kind === 'storno'
          ? typeof d.stornoReceiptNumber === 'string'
            ? d.stornoReceiptNumber
            : typeof d.originalReceiptNumber === 'string'
              ? d.originalReceiptNumber
              : null
          : null,
      reasonId: typeof d.reasonId === 'string' ? d.reasonId : null,
      reasonName: typeof d.reasonName === 'string' ? d.reasonName : null,
      reasonText: typeof d.reasonText === 'string' ? d.reasonText : null,
      reasonComment: typeof d.reasonComment === 'string' ? d.reasonComment : null,
      approved: d.approved === true,
      approvalMethod: typeof d.approvalMethod === 'string' ? d.approvalMethod : null,
      approverId,
      approverName,
      approvalBasis: typeof d.approvalBasis === 'string' ? d.approvalBasis : null,
      entityId: r.entityId || '',
      entityType: r.entityType,
    })
  }

  // ── agregati (iste kanonične vrstice — brez ločenega števca) ──
  const byKind: Record<string, { count: number; amount: number | null }> = {}
  const byReason: Record<string, { count: number; amount: number | null }> = {}
  const byActor: Record<string, { count: number; amount: number | null }> = {}
  const byApprover: Record<string, number> = {}
  const withoutReason: string[] = []
  for (const e of excRows) {
    const bump = (m: Record<string, { count: number; amount: number | null }>, key: string) => {
      const cur = m[key] || { count: 0, amount: e.amount !== null ? 0 : null }
      cur.count += 1
      if (e.amount !== null && cur.amount !== null) cur.amount = Math.round((cur.amount + e.amount) * 100) / 100
      m[key] = cur
    }
    bump(byKind, e.kind)
    const reasonKey = e.reasonName || e.reasonText || (e.kind === 'cancel' || e.kind === 'storno' ? '(brez razloga — pred v1.107.0)' : '(brez razloga)')
    bump(byReason, reasonKey)
    bump(byActor, e.actorName || e.actorId || '(neznano)')
    if (e.approved && e.approverName) byApprover[e.approverName] = (byApprover[e.approverName] || 0) + 1
    if (!e.reasonName && !e.reasonText) withoutReason.push(e.id)
  }

  // ── CSV izvoz (ISTE vrstice — hišni standard: BOM + `;`) ──
  if (format === 'csv') {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = [
      'datum', 'vrsta', 'akcija', 'znesek', 'naročilo', 'račun', 'izvedel', 'razlog',
      'komentar', 'odobreno', 'način odobritve', 'odobril', 'osnova praga', 'entiteta',
    ]
    const lines = excRows.map((e) => [
      new Date(e.at).toLocaleString('sl-SI'), e.kind, e.action, e.amount ?? '', e.orderNumber ?? '',
      e.receiptNumber ?? '', e.actorName ?? '', e.reasonName || e.reasonText || '', e.reasonComment || '',
      e.approved ? 'da' : 'ne', e.approvalMethod || '', e.approverName || '', e.approvalBasis || '',
      `${e.entityType}:${e.entityId}`,
    ])
    const csv = [header, ...lines].map((l) => l.map(esc).join(';')).join('\r\n')
    return new NextResponse('\uFEFF' + csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv;charset=utf-8',
        'content-disposition': `attachment; filename="izjeme-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`,
      },
    })
  }

  return ok({
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    rows: excRows,
    total: excRows.length,
    truncated: rows.length === MAX_ROWS,
    byKind,
    byReason,
    byActor,
    byApprover,
    withoutReasonCount: withoutReason.length,
  })
}
