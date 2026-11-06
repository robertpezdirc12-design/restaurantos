import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { jparse, jstr, nid } from '@/lib/map'
import { jobTipPointsAvailable, jobTipPointsFor, writeJobTipPoints } from '@/lib/job-tip-points'

/**
 * Issue #5 (P0, kommentar #2): prej requireAuth — vsak prijavljeni je videl seznam
 * delovnih mest z njihovimi nabori dovoljenj (varnostna rekonivala). JobsCard je v
 * zaposleni-tabu (employees.manage); urnik svojih izmen imena delovnih mest dobi iz
 * /api/staff-shifts (Job include) — zato branje /api/jobs sedaj employees.manage.
 *
 * PRIMERJAVA §40 (v1.266.0) — NAPITNINSKE TOČKE PO VLOGI (Square Vol 16
 * »Split pooled tips by points assigned to each role«): GET aditivno
 * nosi tipPoints per vrstico (raw read, pre-DDL → 0) + tipPointsDdlActive
 * zastavico (JobsCard pokaže urejanje točk SAMO po DDL koraku —
 * vzorec kdsExpoFireDdlActive iz §39). POST opcijsko sprejme tipPoints
 * (pre-DDL s tipPoints > 0 → 503 s potjo konzole).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  const rows = await db.job.findMany({ orderBy: { sortOrder: 'asc' }, take: 100 })
  const ddlActive = await jobTipPointsAvailable()
  const points = ddlActive ? await jobTipPointsFor(rows.map((r) => r.id)) : {}
  return ok({
    tipPointsDdlActive: ddlActive,
    jobContexts: rows.map((r) => ({
      id: r.id,
      title: r.name,
      permissions: (jparse<string[]>(r.permissions, []) || []).join(','),
      active: r.isActive,
      startedAt: r.createdAt,
      endedAt: null,
      tipPoints: points[r.id] ?? 0,
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
  // §40: opcijsene točke vloge — veljavne IZKLJUČNO cele 0..999; DDL-gated
  // (pre-DDL vpis > 0 → 503 s potjo konzole; 0/null = brez pomena, ustvari navadno)
  const hasTipPoints = body?.tipPoints !== undefined && body?.tipPoints !== null
  const rawPoints = Number(body?.tipPoints)
  if (hasTipPoints && (!Number.isInteger(rawPoints) || rawPoints < 0 || rawPoints > 999)) {
    return ok({ error: 'tipPoints mora biti celo število 0..999.' }, 400)
  }
  if (hasTipPoints && rawPoints > 0) {
    const ddlActive = await jobTipPointsAvailable()
    if (!ddlActive) {
      return ok({ error: 'Napitninske točke po vlogi čakajo DDL korak (Enterprise → Shema migracije → job-tip-points).' }, 503)
    }
  }
  const job = await db.job.create({
    data: {
      id: nid(),
      name,
      permissions: jstr(body.permissions || []),
      basePayRate: Number(body?.payRate) || 0,
    },
  })
  if (hasTipPoints && rawPoints > 0) {
    const err = await writeJobTipPoints(job.id, rawPoints)
    if (err) return ok({ error: err }, 503)
  }
  return ok({ job: { id: job.id, title: job.name, active: job.isActive } }, 201)
}
