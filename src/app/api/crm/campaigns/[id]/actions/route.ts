import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import {
  computeAudience, dispatchCampaign, sendTestEmail, crmAudit,
  CRM_BATCH_LIMIT, smtpSendFn, smsSendFn,
} from '@/lib/crm'

/**
 * Issue #11 §3 — življenjski cikel kampanje (ene akcije na klic):
 *  - preview   → publika po preverbi soglasja/odjav/manjkajočih kontaktov
 *                (število upravičenih naslovnikov — predogled);
 *  - approve   → draft → approved (odobritev, zapis odobritelja/časa);
 *  - schedule  → approved → scheduled (načrtovan čas, MORA biti v prihodnosti;
 *                pošiljanje prek dispatch samo po zapadlosti);
 *  - cancel    → preklic (draft/approved/scheduled/sending → cancelled;
 *                že poslane pošiljke ostanejo dokaz);
 *  - send-test → testni prejemnik/simulator (NI gost, brez CampaignSend;
 *                zahteva SMTP/SMS konfiguracijo — brez nje jasna napaka);
 *  - dispatch  → pošiljanje (omejeno CRM_BATCH_LIMIT, idempotentno,
 *                send-time re-check soglasja; approved = takoj,
 *                scheduled = samo po zapadlosti, sending = retry).
 *
 * Statusi pošiljk so DOKAZOVANI: SMTP sprejem = sent_to_provider (NE
 * dostava); failed samo ob napaki. Brez ponudnikove potrditve se nič
 * ne označi kot dostavljeno.
 *
 * RBAC: settings.manage + guardResource (lokacijski + org obseg).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as {
    action?: string; scheduledAt?: string; to?: string
  } | null
  const action = String(body?.action ?? '')
  if (!action) return fail('Manjka akcija (preview|approve|schedule|cancel|send-test|dispatch).')

  const campaign = await db.campaign.findUnique({ where: { id } })
  if (!campaign) return fail('Kampanja ne obstaja.', 404)
  const guard = await guardResource(user, campaign.locationId)
  if (guard) return guard

  switch (action) {
    case 'preview': {
      const audience = await computeAudience(campaign)
      await db.campaign.update({
        where: { id },
        data: { eligibleCount: audience.eligible.length },
      }).catch(() => null)
      return ok({
        audience: {
          total: audience.total,
          consentGranted: audience.consentGranted,
          suppressed: audience.suppressed,
          missingContact: audience.missingContact,
          eligible: audience.eligible.length,
        },
      })
    }
    case 'approve': {
      if (campaign.status !== 'draft') return fail('Odobriti se da samo osnutek.', 400)
      const updated = await db.campaign.update({
        where: { id },
        data: { status: 'approved', approvedBy: user.sub, approvedAt: new Date() },
      })
      await crmAudit(
        'CRM_CAMPAIGN_APPROVED', 'Campaign', id,
        { locationId: campaign.locationId },
        { userId: user.sub, locationId: campaign.locationId },
      )
      return ok({ campaign: updated })
    }
    case 'schedule': {
      if (campaign.status !== 'approved') return fail('Načrtovati se da samo odobreno kampanjo.', 400)
      const when = body?.scheduledAt ? new Date(body.scheduledAt) : null
      if (!when || Number.isNaN(when.getTime())) return fail('Manjka ali je neveljaven scheduledAt (ISO).')
      if (when.getTime() <= Date.now()) return fail('Načrtovan čas mora biti v prihodnosti.', 400)
      const updated = await db.campaign.update({
        where: { id },
        data: { status: 'scheduled', scheduledAt: when },
      })
      await crmAudit(
        'CRM_CAMPAIGN_SCHEDULED', 'Campaign', id,
        { scheduledAt: when.toISOString(), locationId: campaign.locationId },
        { userId: user.sub, locationId: campaign.locationId },
      )
      return ok({ campaign: updated })
    }
    case 'cancel': {
      if (['sent', 'cancelled'].includes(campaign.status)) {
        return fail(`Kampanja je že ${campaign.status === 'sent' ? 'zaključena' : 'preklicana'}.`, 400)
      }
      const updated = await db.campaign.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      })
      await crmAudit(
        'CRM_CAMPAIGN_CANCELLED', 'Campaign', id,
        { locationId: campaign.locationId },
        { userId: user.sub, locationId: campaign.locationId },
      )
      return ok({ campaign: updated })
    }
    case 'send-test': {
      const to = String(body?.to ?? campaign.testRecipient ?? '').trim()
      if (!to) return fail('Manjka testni prejemnik (to ali testRecipient na kampanji).', 400)
      try {
        const result = await sendTestEmail(id, to)
        await crmAudit(
          'CRM_CAMPAIGN_TEST_SENT', 'Campaign', id,
          { ok: result.ok, channel: campaign.channel, locationId: campaign.locationId },
          { userId: user.sub, locationId: campaign.locationId },
        )
        if (!result.ok) return fail(`Testna pošiljka ni uspela: ${result.detail}`, 400)
        return ok({ testSent: true, detail: result.detail })
      } catch (e) {
        return fail(String((e as Error).message || e), 400)
      }
    }
    case 'dispatch': {
      if (!['approved', 'scheduled', 'sending'].includes(campaign.status)) {
        return fail(`Pošiljati se da samo odobreno/načrtovano kampanjo (stanje: ${campaign.status}).`, 400)
      }
      const result = await dispatchCampaign(id, {
        sendFn: campaign.channel === 'sms' ? smsSendFn : smtpSendFn,
      })
      await crmAudit(
        'CRM_CAMPAIGN_DISPATCHED', 'Campaign', id,
        {
          created: result.created, sent: result.sent, failed: result.failed,
          skipped: result.skipped, status: result.status, limit: CRM_BATCH_LIMIT,
          locationId: campaign.locationId,
        },
        { userId: user.sub, locationId: campaign.locationId },
      )
      return ok({ dispatch: result })
    }
    default:
      return fail('Neznana akcija.', 400)
  }
}
