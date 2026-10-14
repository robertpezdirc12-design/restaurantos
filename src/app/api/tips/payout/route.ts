import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { guardResource } from '@/lib/tenant'

/**
 * Issue #1 (triage ①) — izplačilo napitnin iz bazena.
 *
 * POST /api/tips/payout  { poolId, distributionId? }
 *   → označi eno (distributionId) ali vse čakajoče distribucije kot izplačane
 *     (status 'paid' + paidAt). Ko je vse izplačano → TipPool.status = 'paid'.
 *     Pravica: employees.manage. Idempotentno: že izplačane vrstice se preskočijo.
 *     Distribucije bazena so hash-verižene (nespremenljivi zneski) — izplačilo
 *     ne spreminja zneskov, samo status (revizijsko varno).
 *
 * R9 (revizija §6): CAS prehod pending → paid — vsaka distribucija in bazen se
 * prevzemata z updateMany({ where: { id, status: 'pending' } }). Dvojni klik ali
 * vzporedna zahteva: drugi poskus šteje 0 vrstic → 409 'Tips so že izplačani.',
 * brez drugega izplačila in brez drugega revizijskega vnosa (točno EN audit TIP_PAYOUT).
 *
 * Issue #64 (P2): sočasna izplačila RAZLIČNIH distribucij istega bazena — prej sta
 * obe transakciji iz lastnega (zastarelega) pogleda izračunali poolStatus='pending'
 * → po koncu obeh so lahko VSE distribucije paid, bazen pa zamrknil 'pending'.
 * Zdaj: ANCHOR zapis na vrstici bazena PRVI v transakciji (zaklep/claim) — druga
 * transakcija čaka na commit prve, njen FRESH pregled vseh distribucij vključuje
 * predhodna izplačila → agregatni status vedno odraža kanonično stanje
 * (vse paid ⇒ pool paid; kadar katera ostaja pending ⇒ pool pending).
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
  // Issue #5 (P0, komentar #6): prej BREZ guarda — nosilec employees.manage (tudi
  // MANAGER druge organizacije) je lahko OZNAČIL TUJ bazen kot izplačan (cross-org
  // finančna MUTACIJA). Zdaj guardResource (lokacija + org meja).
  const poolGuard = await guardResource(user, pool.locationId)
  if (poolGuard) return poolGuard

  const targets = distributionId ? pool.TipDistribution.filter((d) => d.id === distributionId) : pool.TipDistribution.filter((d) => d.status === 'pending')
  if (targets.length === 0) return fail('Ni čakajočih distribucij za izplačilo (že vse izplačano ali napačen ID).', 409)

  const now = new Date()
  const paid = await db.$transaction(async (tx) => {
    // Issue #64: ANCHOR zapis na vrstici bazena PRVI v transakciji — zaklep/claim
    // PRED izplačili distribucij (SQLite ekskluzivni write zaklep / PG vrstični
    // zaklep). Sočasna izplačila različnih distribucij se serializirajo: druga
    // transakcija čaka na commit prve → njen pregled distribucij je FRESH.
    // Bazena, izbrisanega med potekom, ne poznamo → anchorMiss (404 po tx).
    const anchor = await tx.tipPool.updateMany({ where: { id: poolId }, data: { updatedAt: now } })
    if (anchor.count === 0) return { anchorMiss: true as const }
    // R9: CAS guard — updateMany z statusom 'pending' v where. Podvojeni/vzporedni poskus
    // dobi count 0 → brez spremembe, brez audita (revizija vidi točno eno izplačilo).
    let count = 0
    for (const d of targets) {
      const r = await tx.tipDistribution.updateMany({
        where: { id: d.id, status: 'pending' },
        data: { status: 'paid', paidAt: now },
      })
      count += r.count
    }
    if (count === 0) return { count: 0, poolStatus: pool.status }
    // Issue #64: FRESH pregled vseh distribucij (PO anchor zaklepu + PO izplačilih)
    // — zadnji pisec vedno vidi tudi predhodna sočasna izplačila
    const all = await tx.tipDistribution.findMany({ where: { tipPoolId: poolId } })
    const poolStatus = all.every((d) => d.status === 'paid') ? 'paid' : 'pending'
    if (poolStatus === 'paid') {
      // tudi prehod bazena je CAS — samo iz 'pending' (nikoli ne prevrišemo
      // že zaključenega statusa; pending ostaja pending — nič za pisati)
      await tx.tipPool.updateMany({ where: { id: poolId, status: 'pending' }, data: { status: 'paid' } })
    }
    // 33-c: chain polja + locationId bazena (audit §6) — odraža KANONIČNI končni status
    await writeAudit(tx, { userId: user.sub, action: 'TIP_PAYOUT', entityType: 'TipPool', entityId: poolId, details: jstr({
          distributionId,
          markedPaid: count,
          poolStatus,
          total: pool.totalTips,
          by: user.name,
        }), locationId: pool.locationId })
    return { count, poolStatus }
  })

  // Issue #64: bazen je bil med potekom izbrisan (anchor ni zadel nobene vrstice)
  if ('anchorMiss' in paid) return fail('Bazen ne obstaja.', 404)

  // R9: drugi (podvojeni) poskus — nič izplačano → 409, brez drugega revizijskega vnosa
  if (paid.count === 0) return fail('Tips so že izplačani.', 409)

  return ok({ paid: paid.count, poolStatus: paid.poolStatus, paidAt: now.toISOString() }, 200)
}
