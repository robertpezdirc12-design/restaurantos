import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num, nid } from '@/lib/map'

const HACCP_TYPES = ['temperature', 'cleaning', 'delivery', 'cooling', 'training']
const HACCP_STATUSES = ['ok', 'warning', 'critical']

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.haccpEntry.findMany({
    // Issue #4 §1: HACCP zapisi po lokaciji uporabnika
    where: locationScope(user),
    orderBy: { date: 'desc' },
    take: 100,
  })
  return ok({
    haccpChecks: rows.map((r) => ({
      id: r.id,
      type: r.category.toUpperCase(),
      target: r.title,
      value: r.value ? num(r.value) : null,
      ok: r.status === 'ok',
      note: r.description || null,
      employeeId: r.employeeName || null,
      checkedAt: r.date,
      locationId: r.locationId,
    })),
  })
}

/**
 * Nov HACCP vnos (temperaturna kontrola, čiščenje, prevzem, hlajenje, usposabljanje).
 * ok=true → status 'ok', sicer 'warning' (ali izrazito 'critical' prek status polja).
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const type = String(body?.type || '').toLowerCase()
  const target = String(body?.target || '').trim()
  if (!HACCP_TYPES.includes(type)) return fail('Neznana vrsta kontrole.', 400)
  if (!target) return fail('Cilj kontrole (target) je obvezen.', 400)
  const status = body?.status && HACCP_STATUSES.includes(String(body.status)) ? String(body.status) : (body?.ok === false ? 'warning' : 'ok')
  const value = body?.value !== undefined && body?.value !== null && String(body.value) !== '' ? String(num(body.value)) : ''
  const locationId = user.loc || (await db.location.findFirst())?.id || null

  const row = await db.haccpEntry.create({
    data: {
      id: nid(),
      category: type,
      title: target,
      value,
      status,
      description: String(body?.note || ''),
      correctiveAction: String(body?.correctiveAction || ''),
      employeeName: user.name || '',
      date: new Date(),
      locationId,
    },
  })
  return ok({
    check: {
      id: row.id,
      type: row.category.toUpperCase(),
      target: row.title,
      value: row.value ? num(row.value) : null,
      ok: row.status === 'ok',
      note: row.description || null,
      employeeId: row.employeeName || null,
      checkedAt: row.date,
    },
  }, 201)
}
