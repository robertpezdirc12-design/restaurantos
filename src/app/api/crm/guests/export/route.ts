import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, locationScope, isResponse } from '@/lib/api'
import { currentConsentMap, crmAudit } from '@/lib/crm'

/**
 * Issue #11 §1 — izvoz seznama gostov (CSV). Dovoljenje: settings.manage
 * (vodstvo — izvoz je občutljiva operacija s PII). Audit CRM_GUESTS_EXPORTED
 * zapiše SAMO število vrstic + obseg lokacij (BREZ e-poštnih naslovov/telefonov
 * — audit ne sme nositi odvečne PII).
 *
 * CSV: ločilo ';', UTF-8 BOM (Excel SI/HR), vrstica z glavo. Vsebuje
 * poslovne agregate + trenutno stanje soglasja po kanalu (dokazljivost
 * GDPR člen 7: vir/čas/dokaz so v GuestConsent sledi, izvoz nosi stanje).
 */
function csvEscape(v: unknown): string {
  const s = String(v ?? '')
  if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const guests = await db.guest.findMany({
    where: scope,
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true,
      isVip: true, totalVisits: true, totalSpent: true, lastVisitAt: true,
      firstVisitAt: true, loyaltyAccountId: true, locationId: true,
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    take: 5000,
  })
  const consent = await currentConsentMap(guests.map((g) => g.id))
  const header = [
    'id', 'ime', 'priimek', 'e-posta', 'telefon', 'vip', 'obiski', 'poraba',
    'prviObisk', 'zadnjiObisk', 'zvestoba', 'lokacija', 'soglasjeEmail', 'soglasjeSms',
  ]
  const lines = [header.join(';')]
  for (const g of guests) {
    const st = consent.get(g.id)
    lines.push([
      g.id, g.firstName, g.lastName, g.email, g.phone,
      g.isVip ? 'da' : 'ne', g.totalVisits, Number(g.totalSpent).toFixed(2),
      g.firstVisitAt?.toISOString() ?? '', g.lastVisitAt?.toISOString() ?? '',
      g.loyaltyAccountId ? 'da' : 'ne', g.locationId ?? '',
      st?.email ?? 'ni_soglasja', st?.sms ?? 'ni_soglasja',
    ].map(csvEscape).join(';'))
  }
  const csv = '\uFEFF' + lines.join('\r\n')

  await crmAudit(
    'CRM_GUESTS_EXPORTED', 'Guest', undefined,
    { rows: guests.length, scope: scope.locationId ?? 'all' },
    { userId: user.sub },
  )

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="gosti-crm-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
