import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, locationScope, ok, isResponse } from '@/lib/api'
import { maskPhone } from '@/lib/pii'
import { maskEmail, currentConsentMap } from '@/lib/crm'

/**
 * Issue #11 §1 — seznam gostov s stanjem marketing soglasja (email/sms
 * LOČENO). PII: e-pošta in telefon sta VEDNO maskirana (enaka politika kot
 * loyalty seznam); polne kontakte nosi izključno izvoz (?full=1 →
 * /api/crm/guests/export z dovoljenjem settings.manage).
 *
 * RBAC: reports.view + locationScope (staff = izključno svoja lokacija).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const guests = await db.guest.findMany({
    where: scope,
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      isVip: true, totalVisits: true, totalSpent: true, lastVisitAt: true,
      loyaltyAccountId: true, locationId: true, createdAt: true,
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    take: 200,
  })
  const consent = await currentConsentMap(guests.map((g) => g.id))
  const rows = guests.map((g) => {
    const st = consent.get(g.id)
    return {
      id: g.id,
      name: `${g.firstName} ${g.lastName}`.trim() || '—',
      email: maskEmail(g.email),
      phone: maskPhone(g.phone),
      isVip: g.isVip,
      loyaltyMember: Boolean(g.loyaltyAccountId),
      totalVisits: g.totalVisits,
      totalSpent: Number(g.totalSpent),
      lastVisitAt: g.lastVisitAt,
      consentEmail: st?.email ?? null,
      consentSms: st?.sms ?? null,
    }
  })
  return ok({ guests: rows, total: rows.length })
}
