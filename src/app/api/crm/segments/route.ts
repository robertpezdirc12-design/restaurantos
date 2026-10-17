import { NextRequest } from 'next/server'
import { requirePermission, locationScope, ok, isResponse } from '@/lib/api'
import {
  CRM_SEGMENT_TYPES, SEGMENT_DEFS, segmentWhere, currentConsentMap, FREQUENT_MIN_VISITS,
} from '@/lib/crm'

/**
 * Issue #11 §2 — pregled segmentov: pogostni/novi/neaktivni/VIP/člani
 * zvestobe v izbranem obdobju. RAZLOGLJIV segment: odgovor vsebuje kriterij
 * (i18n ključ + parametri), obdobje in število ustreznih gostov — tudi
 * razdelitev po soglasju (upravičeni za marketing) in kontaktom.
 *
 * Alergeni/prehranjevalne preference se NE uporabijo za segmentacijo
 * (varna postrežba — GDPR člen 9; testna zaščita tests/issue11-crm-*.test.ts).
 *
 * RBAC: reports.view + locationScope (staff = izključno svoja lokacija).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const periodDays = Math.max(7, Math.min(730, Number(url.searchParams.get('periodDays')) || 90))
  const scope = await locationScope(user)
  const now = new Date()

  const out: Array<Record<string, unknown>> = []
  for (const def of SEGMENT_DEFS) {
    const where = segmentWhere(def.type, periodDays, now, scope)
    const guests = await (await import('@/lib/db')).db.guest.findMany({
      where,
      select: { id: true, email: true, phone: true },
      take: 5000,
    })
    const consent = await currentConsentMap(guests.map((g) => g.id))
    let emailEligible = 0
    let smsEligible = 0
    let missingContact = 0
    for (const g of guests) {
      const st = consent.get(g.id)
      const email = String(g.email ?? '').trim().toLowerCase()
      const phone = String(g.phone ?? '').replace(/\D/g, '')
      if (st?.email === 'granted' && email.includes('@')) emailEligible++
      if (st?.sms === 'granted' && phone.length >= 6) smsEligible++
      if (!email.includes('@') && phone.length < 6) missingContact++
    }
    out.push({
      type: def.type,
      total: guests.length,
      emailEligible,
      smsEligible,
      missingContact,
      criterionKey: def.criterionKey,
      criterionParams: { n: FREQUENT_MIN_VISITS, days: periodDays },
      periodDays,
    })
  }
  return ok({ segments: out, periodDays, types: CRM_SEGMENT_TYPES })
}
