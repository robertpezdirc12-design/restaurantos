import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { maskPhone } from '@/lib/pii'
import { maskEmail, campaignPerformance, crmAudit, campaignChannel } from '@/lib/crm'

/**
 * Issue #11 §3 — detajl kampanje: števci IZ vrstic (sent/failed/skipped/
 * unsubscribed/queued), pošiljke (NASLOVNIKI MASKIRANI — PII) in meritve
 * (ponovni nakupi prejemnikov v oknu po pošiljanju; brez izmišljenih
 * delivery/klik podatkov).
 *
 * PATCH: urejanje OSNUTKA (samo status='draft').
 *
 * RBAC: settings.manage + guardResource (lokacijski + org obseg).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const campaign = await db.campaign.findUnique({ where: { id } })
  if (!campaign) return fail('Kampanja ne obstaja.', 404)
  const guard = await guardResource(user, campaign.locationId)
  if (guard) return guard

  const sends = await db.campaignSend.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true, guestId: true, channel: true, status: true, attempts: true,
      recipient: true, sentAt: true, failedAt: true, unsubscribedAt: true,
      errorMessage: true, createdAt: true,
    },
  })
  const guests = sends.length > 0
    ? await db.guest.findMany({
        where: { id: { in: sends.map((s) => s.guestId) } },
        select: { id: true, firstName: true, lastName: true },
      })
    : []
  const guestName = new Map(guests.map((g) => [g.id, `${g.firstName} ${g.lastName}`.trim() || '—']))
  const performance = await campaignPerformance(id)

  return ok({
    campaign,
    sends: sends.map((s) => ({
      id: s.id,
      guestId: s.guestId,
      guestName: guestName.get(s.guestId) ?? '—',
      channel: s.channel,
      status: s.status,
      attempts: s.attempts,
      // OSS-7 (v1.205.0): whatsapp je telefonski kanal — maska kot SMS
      recipientMasked: campaignChannel(s.channel) === 'email' ? maskEmail(s.recipient) : maskPhone(s.recipient),
      sentAt: s.sentAt,
      failedAt: s.failedAt,
      unsubscribedAt: s.unsubscribedAt,
      errorMessage: s.errorMessage,
      createdAt: s.createdAt,
    })),
    performance,
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const campaign = await db.campaign.findUnique({ where: { id } })
  if (!campaign) return fail('Kampanja ne obstaja.', 404)
  const guard = await guardResource(user, campaign.locationId)
  if (guard) return guard
  if (campaign.status !== 'draft') return fail('Urejati se da samo osnutek (draft).', 400)

  const body = await req.json().catch(() => null) as {
    name?: string; subject?: string; bodySl?: string; bodyHr?: string;
    segmentType?: string; segmentPeriodDays?: number; testRecipient?: string
  } | null
  if (!body) return fail('Neveljavno telo zahteve.')
  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim().length >= 3) data.name = body.name.trim().slice(0, 200)
  if (typeof body.subject === 'string') data.subject = body.subject.trim().slice(0, 300)
  if (typeof body.bodySl === 'string' && body.bodySl.trim().length >= 10) data.bodySl = body.bodySl.trim()
  if (typeof body.bodyHr === 'string' && body.bodyHr.trim().length >= 10) data.bodyHr = body.bodyHr.trim()
  if (typeof body.segmentType === 'string' && ['all', 'vip', 'loyalty', 'frequent', 'new', 'inactive'].includes(body.segmentType)) {
    data.segmentType = body.segmentType
  }
  if (body.segmentPeriodDays !== undefined) data.segmentPeriodDays = Math.max(7, Math.min(730, Number(body.segmentPeriodDays) || 90))
  if (typeof body.testRecipient === 'string') data.testRecipient = body.testRecipient.trim().slice(0, 300)
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')

  const updated = await db.campaign.update({ where: { id }, data })
  await crmAudit(
    'CRM_CAMPAIGN_UPDATED', 'Campaign', id,
    { fields: Object.keys(data), locationId: campaign.locationId },
    { userId: user.sub, locationId: campaign.locationId },
  )
  return ok({ campaign: updated })
}
