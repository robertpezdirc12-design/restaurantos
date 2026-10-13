import { NextRequest } from 'next/server'
import type { HaccpCategory, HaccpStatus } from '@/lib/prisma-types'
import { db } from '@/lib/db'
import { requireAuthWithPerms, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { num, nid } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

const HACCP_TYPES = ['temperature', 'cleaning', 'delivery', 'cooling', 'training'] as const
const HACCP_STATUSES = ['ok', 'warning', 'critical'] as const

/**
 * Issue #5 (P0 §C): prej neskladje v OBEH smereh — GET je zahteval settings.manage
 * (kuhar/čistilka z haccp.execute so videli TAB (TAB_PERM.haccp OR-seznam), API pa
 * 403 → prazna seznama), POST pa samo requireAuth (natakar je lahko vnašal kontrole!).
 * Zdaj: GET = settings.manage ALI haccp.execute (pregled kontrol za izvajalce);
 * POST = haccp.execute (izvedba) — urejanje NAČRTOV ostaja ločeno v /api/haccp/plans
 * (settings.manage).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  if (!ctx.perms.includes('settings.manage') && !ctx.perms.includes('haccp.execute')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: settings.manage | haccp.execute.', 403)
  }
  const user = ctx.user
  const rows = await db.haccpEntry.findMany({ where: await locationScope(user), orderBy: { date: 'desc' }, take: 100 })
  return ok({ haccpChecks: rows.map((r) => ({
    id: r.id, type: r.category.toUpperCase(), target: r.title, value: r.value ? num(r.value) : null,
    ok: r.status === 'ok', note: r.description || null, employeeId: r.employeeName || null, checkedAt: r.date, locationId: r.locationId,
  })) })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'haccp.execute')
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
  // Issue #5: requireUserLocation (§10 — brez findFirst() fallbacka)
  const locationId = requireUserLocation(user)
  if (isResponse(locationId)) return locationId
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
