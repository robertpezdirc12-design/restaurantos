import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { nid, jstr } from '@/lib/map'

const TIER_FOR = (points: number): string => (points >= 1000 ? 'platinum' : points >= 500 ? 'gold' : points >= 100 ? 'silver' : 'bronze')

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.loyaltyAccount.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  return ok({
    accounts: rows.map((r) => ({
      id: r.id,
      guestName: r.customerName,
      phone: r.customerPhone || null,
      points: r.pointsBalance,
      visits: r.lifetimePoints,
      tier: r.tier,
      lastVisit: null,
      createdAt: r.createdAt,
    })),
  })
}

/** Nov član programa zvestobe — ADMIN/MANAGER. */
export async function POST(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const guestName = String(body?.guestName || '').trim()
  if (!guestName) return ok({ error: 'Ime gosta je obvezno.' }, 400)
  const locationId = user.loc || (await db.location.findFirst())?.id || null
  const row = await db.loyaltyAccount.create({
    data: {
      id: nid(),
      customerName: guestName,
      customerPhone: String(body?.phone || ''),
      tier: 'bronze',
      locationId,
    },
  })
  return ok({ account: { id: row.id, guestName: row.customerName } }, 201)
}

/** Točke: prihod (delta > 0) ali obračun (delta < 0) + samodejni tier — ADMIN/MANAGER. */
export async function PATCH(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const account = id ? await db.loyaltyAccount.findUnique({ where: { id } }) : null
  if (!account) return ok({ error: 'Račun zvestobe ne obstaja.' }, 404)
  const delta = Math.trunc(Number(body?.delta))
  if (!Number.isFinite(delta) || delta === 0) return ok({ error: 'Delta točk je obvezna (npr. 25 ali -10).' }, 400)

  const newBalance = Math.max(0, account.pointsBalance + delta)
  const lifetime = account.lifetimePoints + Math.max(0, delta)
  const updated = await db.loyaltyAccount.update({
    where: { id },
    data: { pointsBalance: newBalance, lifetimePoints: lifetime, tier: TIER_FOR(newBalance) },
  })
  await db.loyaltyTransaction.create({
    data: {
      id: nid(),
      loyaltyAccountId: id,
      type: delta > 0 ? 'earn' : 'redeem',
      points: delta,
      reason: String(body?.reason || (delta > 0 ? 'Prihod točk' : 'Obračun točk')).slice(0, 200),
    },
  })
  await db.auditLog.create({
    data: { id: nid(), userId: user.sub, action: 'LOYALTY_POINTS', entityType: 'LoyaltyAccount', entityId: id, details: jstr({ guest: account.customerName, delta, newBalance }) },
  })
  return ok({ account: { id: updated.id, guestName: updated.customerName, points: updated.pointsBalance, tier: updated.tier } })
}
