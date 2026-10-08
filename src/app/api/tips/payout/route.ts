import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'

/**
 * Issue #1 (triage ①) — izplačilo napitnin iz bazena.
 *
 * POST /api/tips/payout  { poolId, distributionId? }
 *   → označi eno (distributionId) ali vse čakajoče distribucije kot izplačane
 *     (status 'paid' + paidAt). Ko je vse izplačano → TipPool.status = 'paid'.
 *     Pravica: employees.manage. Idempotentno: že izplačane vrstice se preskočijo.
 *     Distribucije bazena so hash-verižene (nespremenljivi zneski) — izplačilo
 *     ne spreminja zneskov, samo status (revizijsko varno).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  const poolId = String(body?.poolId || '')
  const distributionId = body?.distributionId ? String(body.distributionId) : null
  if (!poolId) return fail('poolId je obvezen.', 400)

  const pool = await db.tipPool.findUnique({ where: { id: poolId }, include: { TipDistribution: true } })
  if (!pool) return fail('Bazen ne obstaja.', 404)

  const targets = distributionId ? pool.TipDistribution.filter((d) => d.id === distributionId) : pool.TipDistribution.filter((d) => d.status === 'pending')
  if (targets.length === 0) return fail('Ni čakajočih distribucij za izplačilo (že vse izplačano ali napačen ID).', 409)

  const now = new Date()
  const paid = await db.$transaction(async (tx) => {
    let count = 0
    for (const d of targets) {
      if (d.status !== 'pending') continue
      await tx.tipDistribution.update({ where: { id: d.id }, data: { status: 'paid', paidAt: now } })
      count++
    }
    const all = await tx.tipDistribution.findMany({ where: { tipPoolId: poolId } })
    const poolStatus = all.every((d) => d.status === 'paid') ? 'paid' : 'pending'
    if (poolStatus !== pool.status) {
      await tx.tipPool.update({ where: { id: poolId }, data: { status: poolStatus } })
    }
    await tx.auditLog.create({
      data: {
        id: nid(),
        userId: user.sub,
        action: 'TIP_PAYOUT',
        entityType: 'TipPool',
        entityId: poolId,
        details: jstr({
          distributionId,
          markedPaid: count,
          poolStatus,
          total: pool.totalTips,
          by: user.name,
        }),
      },
    })
    return { count, poolStatus }
  })

  return ok({ paid: paid.count, poolStatus: paid.poolStatus, paidAt: now.toISOString() }, 200)
}
