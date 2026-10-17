import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, locationScope, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { findDuplicateGuests, dismissDuplicatePair, mergeGuests, crmAudit } from '@/lib/crm'

/**
 * Issue #11 §2 — podvojeni profili gostov: zaznava (normaliziran email/telefon),
 * ročna razrešitev. MERGE je transakcijsko prevezi vrstice (Order/GuestVisit/
 * GuestFeedback/GuestConsent/CampaignSend) z MAX agregati (nakupi/točke se NE
 * podvojijo); če OBA profila imata zvestobni račun → 409 (ročna razrešitev).
 * DISMISS = "ni duplikat" — par se ne vrača v pregledu (Integration marker,
 * cron-daily-state vzorec — zero DDL).
 *
 * RBAC: settings.manage; GET: locationScope; POST: guardResource na lokacijo
 * kanoničnega gosta.
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const pairs = await findDuplicateGuests(scope)
  return ok({ pairs })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as {
    action?: string; canonicalId?: string; duplicateId?: string; guestAId?: string; guestBId?: string
  } | null
  if (!body) return fail('Neveljavno telo zahteve.')
  const action = String(body.action ?? '')

  if (action === 'dismiss') {
    if (!body.guestAId || !body.guestBId) return fail('Manjkata guestAId/guestBId.')
    await dismissDuplicatePair(body.guestAId, body.guestBId)
    await crmAudit(
      'CRM_DUPLICATE_DISMISSED', 'Guest', body.guestAId,
      { pair: [body.guestAId, body.guestBId].sort().join('|') },
      { userId: user.sub },
    )
    return ok({ dismissed: true })
  }

  if (action === 'merge') {
    if (!body.canonicalId || !body.duplicateId) return fail('Manjkata canonicalId/duplicateId.')
    const canonical = await db.guest.findUnique({ where: { id: body.canonicalId } })
    if (!canonical) return fail('Kanonični gost ne obstaja.', 404)
    const guard = await guardResource(user, canonical.locationId)
    if (guard) return guard
    try {
      const result = await mergeGuests(body.canonicalId, body.duplicateId)
      await crmAudit(
        'CRM_GUESTS_MERGED', 'Guest', result.canonicalId,
        {
          canonicalId: result.canonicalId, duplicateId: body.duplicateId,
          ordersMoved: result.ordersMoved, visitsMoved: result.visitsMoved,
          feedbackMoved: result.feedbackMoved, consentMoved: result.consentMoved,
          sendsMoved: result.sendsMoved,
        },
        { userId: user.sub, locationId: canonical.locationId },
      )
      return ok({ merged: result })
    } catch (e) {
      const msg = String((e as Error).message || e)
      return fail(msg, /zvestobni račun|unikatna/i.test(msg) ? 409 : 400)
    }
  }

  return fail('Neveljavna akcija (merge|dismiss).')
}
