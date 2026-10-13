import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireAuthWithPerms, isResponse, ok } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

const EDITABLE = [
  'name', 'address', 'city', 'postCode', 'phone', 'email', 'web', 'businessId', 'taxId',
  'registerNumber', 'fursEnvironment', 'defaultVatRate', 'reducedVatRate', 'loyaltyEnabled',
  'receiptFooter', 'currency', 'locale', 'country', 'emailEnabled',
] as const

/**
 * Issue #5 (P0, kommentar #3): prej je GET vrnil CELO vrstico RestaurantSettings
 * vsakemu prijavljenemu — vključno s skrivnostmi (fursCertPassword, emailSmtpPassword,
 * apiKeys, cisCertPassword). Zdaj:
 *  - navaden prijavljen (POS potrebuje receiptFooter za tisk) → MINIMALNI operativni
 *    DTO iz EDITABLE (poslovni podatki, NI skrivnosti — enak seznam kot PUT sprejme);
 *  - settings.manage → polna vrstica (nastavitve-tab urejanje; PUT itak sprejema samo
 *    EDITABLE ključe, skrivnosti se ne morejo spreminjati prek API-ja).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const s = await db.restaurantSettings.findFirst()
  if (!s) return ok({ settings: null })
  if (ctx.perms.includes('settings.manage')) {
    return ok({ settings: s })
  }
  const minimal: Record<string, unknown> = {}
  for (const key of EDITABLE) {
    if (s[key] !== undefined) minimal[key] = s[key]
  }
  return ok({ settings: minimal })
}

export async function PUT(req: NextRequest) {
  // Issue #4 §1: inline role check zamenjan s kanoničnim dovoljenjem settings.manage (konsistentnost)
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
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
  // 33-c (audit §6): spremembe nastavitev so zdaj revidirane — SAMO ključi (NI vrednosti,
  // ker so med njimi poslovni podatki; pin/skrivnosti v Editable sploh niso)
  const changedKeys = Object.keys(data)
  if (changedKeys.length > 0) {
    await writeAudit(db, { userId: user.sub, action: 'SETTINGS_UPDATE', entityType: 'RestaurantSettings', entityId: settings.id, details: jstr({ changed: changedKeys }), locationId: user.loc })
  }
  return ok({ settings })
}
