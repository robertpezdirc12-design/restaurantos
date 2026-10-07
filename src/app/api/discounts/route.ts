import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, isCentralRole, requireUserLocation } from '@/lib/api'
import { nid, num, r2, jstr } from '@/lib/map'

/**
 * Issue #1 §6 — popusti/promocije + Happy Hour: CRUD Discount modela.
 * - GET: seznam za lokacijo (aktivni + neaktivni za administracijo)
 * - POST: nov popust (requirePermission apply_discounts) + audit
 * Validacija: type percent|fixed, amount>0 (percent <= 100), Happy okno (ura 0–23, from ≠ to,
 * days ⊂ 0–6), targetCategoryIds = obstoječe kategorije lokacije.
 */

function parseDays(v: unknown): string {
  if (v == null || v === '') return ''
  const set = new Set<string>()
  for (const part of String(v).split(',')) {
    const n = parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(String(n))
  }
  return [...set].sort().join(',')
}

function parseCats(v: unknown): string {
  if (v == null || v === '') return ''
  return [...new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))].join(',')
}

function validateDiscountBody(body: Record<string, unknown>) {
  const name = String(body?.name || '').trim()
  if (!name) return 'Ime popusta je obvezno.'
  const type = String(body?.type || '').toLowerCase()
  if (!['percent', 'fixed'].includes(type)) return 'Vrsta mora biti percent ali fixed.'
  const amount = num(body?.amount)
  if (!(amount > 0)) return 'Znesek/odstotek mora biti večji od 0.'
  if (type === 'percent' && amount > 100) return 'Odstotek ne sme presegati 100.'
  const fromHour = body?.happyFromHour == null ? null : Number(body.happyFromHour)
  const toHour = body?.happyToHour == null ? null : Number(body.happyToHour)
  for (const [label, h] of [['happyFromHour', fromHour], ['happyToHour', toHour]] as const) {
    if (h != null && (!Number.isInteger(h) || h < 0 || h > 23)) return `${label} mora biti ura 0–23.`
  }
  if ((fromHour != null) !== (toHour != null)) return 'Happy Hour okno zahteva obe uri (od in do).'
  return null
}

function discountPayload(body: Record<string, unknown>, locationId: string) {
  return {
    name: String(body.name).trim().slice(0, 120),
    type: String(body.type).toLowerCase(),
    amount: r2(num(body.amount)),
    appliesTo: body.appliesTo === 'item' && String(body.targetCategoryIds || '') ? 'item' : 'check',
    triggerType: String(body.triggerType || 'manual').toLowerCase() === 'auto' ? 'auto' : 'manual',
    promoCode: String(body?.promoCode || '').trim().slice(0, 40),
    maxUses: body?.maxUses == null ? null : Math.max(0, Math.round(Number(body.maxUses))),
    validFrom: body?.validFrom ? new Date(String(body.validFrom)) : null,
    validTo: body?.validTo ? new Date(String(body.validTo)) : null,
    happyDays: parseDays(body?.happyDays),
    happyFromHour: body?.happyFromHour == null ? null : Math.round(Number(body.happyFromHour)),
    happyToHour: body?.happyToHour == null ? null : Math.round(Number(body.happyToHour)),
    targetCategoryIds: parseCats(body?.targetCategoryIds),
    isActive: body?.isActive === undefined ? true : Boolean(body.isActive),
    sortOrder: Math.max(0, Math.round(Number(body?.sortOrder) || 0)),
    locationId,
  }
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const locationId = url.searchParams.get('locationId')
  // Issue #4 §1: za non-central ignoriraj client query locationId in forsiraj user.loc
  // (cross-location popusti so sicer brani samo pri pisanju); centralna lahko filtrira
  const where = isCentralRole(user)
    ? (locationId ? { locationId } : {})
    : { locationId: user.loc || '__no_location__' }
  const rows = await db.discount.findMany({
    where,
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' as const }],
    take: 200,
  })
  return ok({ discounts: rows })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)
  const vErr = validateDiscountBody(body)
  if (vErr) return fail(vErr, 400)
  // Issue #4 §10: popust se vedno ustvari na lokaciji uporabnika — body.locationId je
  // spoštovan SAMO pri centralnih vlogah (prej je kadarkoli podal poljuben locationId)
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const location = await db.location.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!location) return fail('Lokacija ne obstaja.', 404)

  // ciljne kategorije morajo obstajati (zaščita pred tipkarskimi napakami)
  const cats = parseCats(body?.targetCategoryIds)
  if (cats) {
    const ids = cats.split(',')
    const found = await db.category.findMany({ where: { id: { in: ids } }, select: { id: true } })
    if (found.length !== ids.length) return fail('Ena ali več ciljnih kategorij ne obstaja.', 400)
  }

  const created = await db.discount.create({ data: { id: nid(), ...discountPayload(body, locationId) } })
  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'DISCOUNT_CREATED',
      entityType: 'Discount',
      entityId: created.id,
      details: jstr({ name: created.name, type: created.type, amount: created.amount, triggerType: created.triggerType, happyDays: created.happyDays, happyFromHour: created.happyFromHour, happyToHour: created.happyToHour, targetCategoryIds: created.targetCategoryIds }),
      locationId,
    },
  })
  return ok({ discount: created }, 201)
}
