import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { jparse, jstr, nid } from '@/lib/map'

/**
 * Issue #5 (P0, kommentar #2): prej requireAuth — vsak prijavljeni je videl seznam
 * delovnih mest z njihovimi nabori dovoljenj (varnostna rekonivala). JobsCard je v
 * zaposleni-tabu (employees.manage); urnik svojih izmen imena delovnih mest dobi iz
 * /api/staff-shifts (Job include) — zato je branje /api/jobs sedaj employees.manage.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
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

/** Novo delovno mesto — N3 (audit P1): kanonično dovoljenje `settings.manage` (DB lookup). */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
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
