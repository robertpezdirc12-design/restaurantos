import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { nid, jstr } from '@/lib/map'

const EDITABLE = [
  'name', 'address', 'city', 'postCode', 'phone', 'email', 'web', 'businessId', 'taxId',
  'registerNumber', 'fursEnvironment', 'defaultVatRate', 'reducedVatRate', 'loyaltyEnabled',
  'receiptFooter', 'currency', 'locale', 'country', 'emailEnabled',
] as const

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const s = await db.restaurantSettings.findFirst()
  return ok({ settings: s || null })
}

export async function PUT(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER'].includes(user.role)) return ok({ error: 'Ni dovoljenj.' }, 403)
  const body = await req.json().catch(() => null)
  if (!body) return ok({ error: 'Manjkajo podatki.' }, 400)
  const data: Record<string, unknown> = {}
  for (const key of EDITABLE) {
    if (body[key] !== undefined) data[key] = body[key]
  }
  if (body.emailReportRecipients !== undefined) data.emailReportRecipients = jstr(body.emailReportRecipients)
  const existing = await db.restaurantSettings.findFirst()
  const settings = existing
    ? await db.restaurantSettings.update({ where: { id: existing.id }, data })
    : await db.restaurantSettings.create({ data: { id: nid(), ...data } })
  return ok({ settings })
}
