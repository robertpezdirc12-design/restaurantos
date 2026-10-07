import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { jparse, jstr, nid } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.job.findMany({ orderBy: { sortOrder: 'asc' }, take: 100 })
  return ok({
    jobContexts: rows.map((r) => ({
      id: r.id,
      title: r.name,
      permissions: (jparse<string[]>(r.permissions, []) || []).join(','),
      active: r.isActive,
      startedAt: r.createdAt,
      endedAt: null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const name = String(body?.title || body?.name || '').trim()
  if (!name) return ok({ error: 'Naziv delovnega mesta je obvezen.' }, 400)
  const exists = await db.job.findUnique({ where: { name } })
  if (exists) return ok({ error: 'Delovno mesto s tem nazivom že obstaja.' }, 409)
  const job = await db.job.create({
    data: {
      id: nid(),
      name,
      permissions: jstr(body.permissions || []),
      basePayRate: Number(body?.payRate) || 0,
    },
  })
  return ok({ job: { id: job.id, title: job.name, active: job.isActive } }, 201)
}
