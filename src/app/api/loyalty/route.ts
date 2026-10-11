import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { maskPhone } from '@/lib/pii'
import { auditChainFields } from '@/lib/audit-chain'

const TIER_FOR = (points: number): string => (points >= 1000 ? 'platinum' : points >= 500 ? 'gold' : points >= 100 ? 'silver' : 'bronze')

/**
 * Seznam računov zvestobe.
 * P2 audit PII: telefonske številke so VEDNO maskirane (npr. »+386 *** 567«) —
 * seznam je berljiv vsem avtenticiranim, polna številka pa za delo s seznamom
 * ni potrebna (GDPR). Nezakrit pogled (?full=1 — izvoz/admin potreba) zahteva
 * dovoljenje settings.manage, sicer 403.
 */
export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const wantsFull = new URL(req.url).searchParams.get('full') === '1'
  if (wantsFull) {
    const gate = await requirePermission(req, 'settings.manage')
    if (isResponse(gate)) return gate
  }
  const rows = await db.loyaltyAccount.findMany({
    // Issue #4 §1: staff vidi samo račune zvestobe svoje lokacije
    where: locationScope(user),
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    accounts: rows.map((r) => ({
      id: r.id,
      guestName: r.customerName,
      phone: wantsFull ? (r.customerPhone || null) : maskPhone(r.customerPhone),
      points: r.pointsBalance,
      visits: r.lifetimePoints,
      tier: r.tier,
      lastVisit: null,
      createdAt: r.createdAt,
    })),
  })
}

/** Nov član programa zvestobe — N3 (audit P1): kanonično dovoljenje `settings.manage` (DB lookup). */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
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

/**
 * Točke: prihod (delta > 0) ali obračun (delta < 0) + samodejni tier.
 * N3 (audit P1): kanonično dovoljenje `settings.manage` namesto trdo kodiranih vlog;
 * lokacijski gate na tujem računu ostaja fail-closed.
 */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const account = id ? await db.loyaltyAccount.findUnique({ where: { id } }) : null
  if (!account) return ok({ error: 'Račun zvestobe ne obstaja.' }, 404)
  // Issue #4 §1: odštevanje/dodajanje točk tujemu računu (druga lokacija) je zavrnjeno;
  // null lokacija računa = "vir brez lokacije" → 403 za non-central (fail-closed)
  const locRes = await guardResource(user, account.locationId)
  if (locRes) return locRes
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
  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'LOYALTY_POINTS', entityType: 'LoyaltyAccount', entityId: id, details: jstr({ guest: account.customerName, delta, newBalance }), id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2, id: __aId2, userId: user.sub, action: 'LOYALTY_POINTS', entityType: 'LoyaltyAccount', entityId: id, details: jstr({ guest: account.customerName, delta, newBalance }) },
  })
  return ok({ account: { id: updated.id, guestName: updated.customerName, points: updated.pointsBalance, tier: updated.tier } })
}
