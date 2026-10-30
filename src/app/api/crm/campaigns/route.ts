import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { requirePermission, locationScope, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { CRM_SEGMENT_TYPES, crmAudit, CRM_CHANNELS, type CrmChannel } from '@/lib/crm'

/**
 * Issue #11 §3 — kampanje: seznam (v obsegu uporabnika) + ustvarjanje
 * osnutka. Vsaka kampanja je VEZANA na lokacijo (publika = gosti te
 * lokacije — staff meja; centralna vloga izbere lokacijo ob ustvarjanju).
 *
 * Ustvarjanje zahteva OBE jezikovni različici vsebine (SL + HR — issue:
 * "vmesnik in vsebine podpri v slovenščini in hrvaščini") in zadevo za
 * email kanal. Status osnutka je 'draft' — pošiljanje zahteva eksplicitno
 * odobritev (actions ruta).
 *
 * RBAC: settings.manage; create: requireUserLocation + assertOrgScope.
 */
const MAX_TEXT = 8000

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const scope = await locationScope(user)
  const campaigns = await db.campaign.findMany({
    where: scope,
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, name: true, channel: true, segmentType: true, segmentPeriodDays: true,
      subject: true, status: true, scheduledAt: true, sentAt: true, completedAt: true,
      eligibleCount: true, sentCount: true, failedCount: true, unsubscribedCount: true,
      testRecipient: true, lastError: true, locationId: true, createdAt: true,
    },
  })
  return ok({ campaigns })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null) as {
    name?: string; channel?: string; segmentType?: string; segmentPeriodDays?: number;
    subject?: string; bodySl?: string; bodyHr?: string; testRecipient?: string;
    locationId?: string
  } | null
  if (!body) return fail('Neveljavno telo zahteve.')
  const name = String(body.name ?? '').trim()
  if (name.length < 3) return fail('Ime kampanje je obvezno (min. 3 znaki).')
  const channel = String(body.channel ?? 'email')
  // OSS-7 (v1.205.0): tretji kanal whatsapp — model + opt-out (transport B/C)
  if (!CRM_CHANNELS.includes(channel as CrmChannel)) return fail('Kanal mora biti email, sms ali whatsapp.')
  const segmentType = String(body.segmentType ?? 'all')
  if (!CRM_SEGMENT_TYPES.includes(segmentType as 'all')) return fail('Neveljaven segment.')
  const segmentPeriodDays = Math.max(7, Math.min(730, Number(body.segmentPeriodDays) || 90))
  const bodySl = String(body.bodySl ?? '').trim()
  const bodyHr = String(body.bodyHr ?? '').trim()
  if (bodySl.length < 10 || bodyHr.length < 10) {
    return fail('Vsebina v slovenščini IN hrvaščini je obvezna (min. 10 znakov vsaka).')
  }
  if (bodySl.length > MAX_TEXT || bodyHr.length > MAX_TEXT) return fail('Vsebina je predolga.')
  const subject = String(body.subject ?? '').trim()
  if (channel === 'email' && subject.length < 3) return fail('Zadeva (subject) je obvezna za email kampanjo.')

  const loc = requireUserLocation(user, body.locationId)
  if (typeof loc !== 'string') return loc
  const org = await assertOrgScope(user, loc)
  if (org) return org
  const location = await db.location.findUnique({ where: { id: loc }, select: { id: true, isActive: true } })
  if (!location || !location.isActive) return fail('Lokacija ne obstaja ali ni aktivna.', 400)

  const campaign = await db.campaign.create({
    data: {
      id: nid(),
      name: name.slice(0, 200),
      channel,
      segmentType,
      segmentPeriodDays,
      subject: subject.slice(0, 300),
      bodySl,
      bodyHr,
      status: 'draft',
      testRecipient: String(body.testRecipient ?? '').trim().slice(0, 300),
      createdBy: user.sub,
      locationId: loc,
    },
  })

  await crmAudit(
    'CRM_CAMPAIGN_CREATED', 'Campaign', campaign.id,
    { name: campaign.name, channel, segmentType, locationId: loc },
    { userId: user.sub, locationId: loc },
  )
  return ok({ campaign })
}
