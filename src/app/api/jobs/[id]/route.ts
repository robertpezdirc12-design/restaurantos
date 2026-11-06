import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { writeJobTipPoints, jobTipPointsAvailable, jobTipPointsFor } from '@/lib/job-tip-points'

/**
 * PRIMERJAVA §40 (v1.266.0) — NAPITNINSKE TOČKE PO VLOGI (Square Vol 16
 * »Split pooled tips by points assigned to each role«): urejanje točk
 * delovnega mesta (vloge) za delitev napitnin.
 *
 * PATCH /api/jobs/[id]  { tipPoints: 0..999 }
 *   → raw UPDATE Job."tipPoints" (DDL-gated: pre-DDL → 503 s potjo
 *     konzole Enterprise → Shema migracije → job-tip-points), revizija
 *     JOB_TIP_POINTS (stara/nova vrednost — dokazljiva sled spremembe
 *     uteži delitve), odgovor nosi svežo vrednost iz baze.
 *
 * Pravica: settings.manage (delovna mesta so nastavitvena entiteta —
 * enako kot POST /api/jobs, N3 audit P1).
 *
 * Omejitev: ta ruta sprejme SAMO tipPoints — ostala polja delovnega
 * mesta (naziv, plača, dovoljenja) se urejajo v svojih poteh; tukaj
 * namenoma ni generičnega PATCH vsem poljem (majhna površina = majhna
 * tveganja; vzorec »samo-nastavitev« iz locations PATCH §39).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  if (!body || body.tipPoints === undefined) {
    return fail('tipPoints je obvezen (celo število 0..999).', 400)
  }

  const job = await db.job.findUnique({ where: { id } })
  if (!job) return fail('Delovno mesto ne obstaja.', 404)

  // validacija NAJPREJ (400), DDL vrata šele nato (503) — ločena sporočila
  const v = Number(body.tipPoints)
  if (!Number.isInteger(v) || v < 0 || v > 999) {
    return fail('tipPoints mora biti celo število 0..999.', 400)
  }

  const ddlActive = await jobTipPointsAvailable()
  if (!ddlActive) {
    return fail('Napitninske točke po vlogi čakajo DDL korak (Enterprise → Shema migracije → job-tip-points).', 503)
  }

  const before = (await jobTipPointsFor([id]))[id] ?? 0
  const err = await writeJobTipPoints(id, v)
  if (err) return fail(err, 503)
  const after = (await jobTipPointsFor([id]))[id] ?? 0

  await writeAudit(db, {
    userId: user.sub,
    action: 'JOB_TIP_POINTS',
    entityType: 'Job',
    entityId: id,
    details: jstr({ jobName: job.name, before, after }),
  }).catch(() => null)

  return ok({ id, jobName: job.name, tipPoints: after })
}
