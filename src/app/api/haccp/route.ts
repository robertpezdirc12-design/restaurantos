import { NextRequest } from 'next/server'
import type { HaccpCategory, HaccpStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num, nid } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

const HACCP_TYPES = ['temperature', 'cleaning', 'delivery', 'cooling', 'training'] as const
const HACCP_STATUSES = ['ok', 'warning', 'critical'] as const

/**
 * N5 (revizija §4): HACCP zapisi so interni kontrolni seznam — UI prikaže zavihek
 * HACCP samo z 'settings.manage' (TAB_PERM.haccp), zato backend uveljavlja isto
 * kanonično dovoljenje (prej: requireAuth). Odstopanje od predloga 'kitchen.update'
 * je namerno in preverjeno proti UI: kuhinjske vloge (chef/kitchen, dovoljenje
 * 'kitchen.update') zavihka HACCP v dashboardu NE vidijo (TAB_PERM ga vezuje na
 * settings.manage), zato bi 'kitchen.update' pustil API odprtejšega kot UI;
 * 'settings.manage' je minimalno dovoljenje, ki se ujema z vidnostjo vmesnika.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const rows = await db.haccpEntry.findMany({ where: await locationScope(user), orderBy: { date: 'desc' }, take: 100 })
  return ok({ haccpChecks: rows.map((r) => ({
    id: r.id, type: r.category.toUpperCase(), target: r.title, value: r.value ? num(r.value) : null,
    ok: r.status === 'ok', note: r.description || null, employeeId: r.employeeName || null, checkedAt: r.date, locationId: r.locationId,
  })) })
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const type = String(body?.type || '').toLowerCase()
  const target = String(body?.target || '').trim()
  if (!HACCP_TYPES.includes(type as typeof HACCP_TYPES[number])) return fail('Neznana vrsta kontrole.', 400)
  if (!target) return fail('Cilj kontrole (target) je obvezen.', 400)
  const status = body?.status && HACCP_STATUSES.includes(String(body.status) as typeof HACCP_STATUSES[number])
    ? String(body.status)
    : (body?.ok === false ? 'warning' : 'ok')
  const value = body?.value !== undefined && body?.value !== null && String(body.value) !== '' ? String(num(body.value)) : ''
  const locationId = user.loc || (await db.location.findFirst())?.id || null
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
