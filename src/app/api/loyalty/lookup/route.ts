import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'

/**
 * Issue #1 §6 — identifikacija gosta (program zvestobe) v plačilnem dialogu.
 * Iskanje po telefonu ALI imenu (neobčutljivo na velikost), vrne največ 5 zadetkov
 * s stanjem točk. Zahteva orders.pay — dostop ima le osebje ob plačilu.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const q = new URL(req.url).searchParams.get('q')?.trim() || ''
  if (q.length < 2) return fail('Iskalni niz mora imeti vsaj 2 znaka.', 400)

  const digits = q.replace(/\D/g, '')
  const accounts = await db.loyaltyAccount.findMany({
    where: {
      isActive: true,
      OR: [
        { customerName: { contains: q } },
        ...(digits.length >= 3 ? [{ customerPhone: { contains: digits } }] : []),
      ],
    },
    orderBy: { updatedAt: 'desc' as const },
    take: 5,
    select: { id: true, customerName: true, customerPhone: true, pointsBalance: true, lifetimePoints: true, tier: true },
  })

  return ok({ results: accounts })
}
