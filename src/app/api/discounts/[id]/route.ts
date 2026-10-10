import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, num, r2, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

/** Issue #1 §6 — urejanje/brisanje popusta (apply_discounts) + audit občutljivih sprememb. */

function parseDays(v: unknown): string {
  if (v == null || v === '') return ''
  const set = new Set<string>()
  for (const part of String(v).split(',')) {
    const n = parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(String(n))
  }
  return [...set].sort().join(',')
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const existing = await db.discount.findUnique({ where: { id } })
  if (!existing) return fail('Popust ne obstaja.', 404)

  const data: Record<string, unknown> = {}
  if (body?.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) return fail('Ime ne sme biti prazno.', 400)
    data.name = name.slice(0, 120)
  }
  if (body?.type !== undefined) {
    const type = String(body.type).toLowerCase()
    if (!['percent', 'fixed'].includes(type)) return fail('Vrsta mora biti percent ali fixed.', 400)
    data.type = type
  }
  if (body?.amount !== undefined) {
    const amount = num(body.amount)
    if (!(amount > 0)) return fail('Znesek/odstotek mora biti večji od 0.', 400)
    const effType = String(data.type || existing.type)
    if (effType === 'percent' && amount > 100) return fail('Odstotek ne sme presegati 100.', 400)
    data.amount = r2(amount)
  }
  if (body?.happyFromHour !== undefined || body?.happyToHour !== undefined) {
    const from = body?.happyFromHour !== undefined ? (body.happyFromHour == null ? null : Math.round(Number(body.happyFromHour))) : existing.happyFromHour
    const to = body?.happyToHour !== undefined ? (body.happyToHour == null ? null : Math.round(Number(body.happyToHour))) : existing.happyToHour
    for (const [label, h] of [['happyFromHour', from], ['happyToHour', to]] as const) {
      if (h != null && (!Number.isInteger(h) || h < 0 || h > 23)) return fail(`${label} mora biti ura 0–23.`, 400)
    }
    if ((from != null) !== (to != null)) return fail('Happy Hour okno zahteva obe uri (od in do).', 400)
    data.happyFromHour = from
    data.happyToHour = to
  }
  if (body?.happyDays !== undefined) data.happyDays = parseDays(body.happyDays)
  if (body?.targetCategoryIds !== undefined) {
    const cats = [...new Set(String(body.targetCategoryIds || '').split(',').map((s) => s.trim()).filter(Boolean))]
    if (cats.length) {
      const found = await db.category.findMany({ where: { id: { in: cats } }, select: { id: true } })
      if (found.length !== cats.length) return fail('Ena ali več ciljnih kategorij ne obstaja.', 400)
    }
    data.targetCategoryIds = cats.join(',')
    data.appliesTo = cats.length ? 'item' : 'check'
  }
  if (body?.validFrom !== undefined) data.validFrom = body.validFrom ? new Date(String(body.validFrom)) : null
  if (body?.validTo !== undefined) data.validTo = body.validTo ? new Date(String(body.validTo)) : null
  if (body?.maxUses !== undefined) data.maxUses = body.maxUses == null ? null : Math.max(0, Math.round(Number(body.maxUses)))
  if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive)
  if (body?.promoCode !== undefined) data.promoCode = String(body.promoCode || '').trim().slice(0, 40)
  if (body?.sortOrder !== undefined) data.sortOrder = Math.max(0, Math.round(Number(body.sortOrder) || 0))

  const updated = await db.discount.update({ where: { id }, data })
  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'DISCOUNT_UPDATED', entityType: 'Discount', entityId: id, details: jstr({ before: { name: existing.name, amount: existing.amount, isActive: existing.isActive, happyFromHour: existing.happyFromHour, happyToHour: existing.happyToHour }, after: data }), locationId: existing.locationId, id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2,
      id: __aId2,
      userId: user.sub,
      action: 'DISCOUNT_UPDATED',
      entityType: 'Discount',
      entityId: id,
      details: jstr({ before: { name: existing.name, amount: existing.amount, isActive: existing.isActive, happyFromHour: existing.happyFromHour, happyToHour: existing.happyToHour }, after: data }),
      locationId: existing.locationId,
    },
  })
  return ok({ discount: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'apply_discounts')
  if (isResponse(user)) return user
  const { id } = await params
  const existing = await db.discount.findUnique({ where: { id } })
  if (!existing) return fail('Popust ne obstaja.', 404)
  // mehko brisanje (Check/OrderItem imajo FK) — deaktivacija ohrani audit pot
  await db.discount.update({ where: { id }, data: { isActive: false } })
  const __aId4 = nid(); const __chain4 = await auditChainFields(db, { action: 'DISCOUNT_DELETED', entityType: 'Discount', entityId: id, details: jstr({ name: existing.name, amount: existing.amount, softDelete: true }), locationId: existing.locationId, id: __aId4 })
  await db.auditLog.create({
    data: { ...__chain4,
      id: __aId4,
      userId: user.sub,
      action: 'DISCOUNT_DELETED',
      entityType: 'Discount',
      entityId: id,
      details: jstr({ name: existing.name, amount: existing.amount, softDelete: true }),
      locationId: existing.locationId,
    },
  })
  return ok({ deleted: true })
}
