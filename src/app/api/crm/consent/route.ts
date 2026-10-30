import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { recordConsent, currentConsentMap, crmAudit, CRM_CHANNELS, type CrmChannel } from '@/lib/crm'

/**
 * Issue #11 §1 — zapis soglasja/preklica v append-only sled.
 *
 * PRAVILA:
 *  - grant ZAHTEVA dokaz izrecnega dejanja (proof, min. 3 znaki — GDPR člen 7:
 *    upravljavec mora znati dokazati privolitev; vnos e-pošte za rezervacijo
 *    NI dokaz soglasja in ta ruta ga nikoli ne pokliče);
 *  - revoke je vedno dovoljen in TAKOJ učinkovit (send-time re-check v
 *    dispatchCampaign izloči tudi že načrtovane vrstice);
 *  - email in SMS sta LOČENA kanala (stanje se NE predpostavi);
 *  - zgodovina se NE popravlja — samo appends (revizijska sled).
 *
 * RBAC: settings.manage + guardResource (lokacijski + org obseg gosta).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as {
    guestId?: string; channel?: string; action?: string; proof?: string; source?: string
  } | null
  if (!body?.guestId) return fail('Manjka guestId.')
  const channel = String(body.channel ?? 'email')
  // OSS-7 (v1.205.0): tretji kanal whatsapp — isti pravilnik soglasja
  if (!CRM_CHANNELS.includes(channel as CrmChannel)) return fail('Neveljaven kanal (email|sms|whatsapp).')
  const action = String(body.action ?? '')
  if (action !== 'grant' && action !== 'revoke') return fail('Neveljavna akcija (grant|revoke).')

  const guest = await db.guest.findUnique({ where: { id: body.guestId } })
  if (!guest) return fail('Gost ne obstaja.', 404)
  const guard = await guardResource(user, guest.locationId)
  if (guard) return guard

  const status = action === 'grant' ? 'granted' : 'revoked'
  const source = String(body.source ?? 'manual').slice(0, 60)
  try {
    await recordConsent({
      guestId: guest.id,
      channel: channel as CrmChannel,
      status,
      source,
      proof: status === 'granted' ? String(body.proof ?? '').slice(0, 500) : 'Preklic s strani vodstva/gosta.',
      recordedBy: user.sub,
      locationId: guest.locationId,
    })
  } catch (e) {
    return fail(String((e as Error).message || e), 400)
  }

  await crmAudit(
    action === 'grant' ? 'CRM_CONSENT_GRANTED' : 'CRM_CONSENT_REVOKED',
    'GuestConsent', guest.id,
    { guestId: guest.id, channel, source },
    { userId: user.sub, locationId: guest.locationId },
  )

  const map = await currentConsentMap([guest.id])
  return ok({ guestId: guest.id, consent: map.get(guest.id) ?? { email: null, sms: null } })
}
