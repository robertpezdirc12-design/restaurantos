import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Dobavitelji. Issue #1 (triage ②) — aditivne razširitve za nabavni tok:
 *  - GET: vrne bogatejši profil (davčna, IBAN, pogoji, aktivnost, št. naročil)
 *  - POST: ustvarjanje (obstojače, nedotaknjeno — zdaj z auditom)
 *  - PATCH: urejanje profila dobavitelja (N3/audit P1: kanonično dovoljenje
 *    `settings.manage` prek requirePermission — enako kot POST)
 * §18: obstoječi odgovorni ključi (id, name, contact, phone, email, address)
 * ostanejo nespremenjeni — samo dopolnjeno.
 */

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.supplier.findMany({
    orderBy: { name: 'asc' },
    take: 200,
    include: { _count: { select: { PurchaseOrder: true, SupplierItem: true } } },
  })
  return ok({
    suppliers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      contact: r.contactPerson || null,
      phone: r.phone || null,
      email: r.email || null,
      address: r.address || null,
      // triage ② — aditivno:
      code: r.code || null,
      city: r.city || null,
      country: r.country || null,
      taxId: r.taxId || null,
      businessId: r.businessId || null,
      iban: r.iban || null,
      bank: r.bank || null,
      paymentTerms: r.paymentTerms || null,
      isActive: r.isActive,
      notes: r.notes || null,
      purchaseOrdersCount: r._count.PurchaseOrder,
      itemsCount: r._count.SupplierItem,
    })),
  })
}

/** Nov dobavitelj — N3 (audit P1): kanonično dovoljenje `settings.manage` (DB lookup). */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  if (!name) return ok({ error: 'Naziv dobavitelja je obvezen.' }, 400)
  const exists = await db.supplier.findUnique({ where: { name } })
  if (exists) return ok({ error: 'Dobavitelj s tem nazivom že obstaja.' }, 409)
  const row = await db.supplier.create({
    data: {
      id: nid(),
      name,
      code: `SUP-${nid().slice(0, 8).toUpperCase()}`,
      contactPerson: String(body?.contact || ''),
      phone: String(body?.phone || ''),
      email: String(body?.email || ''),
      address: String(body?.address || ''),
      // triage ② — aditivno:
      city: String(body?.city || ''),
      postCode: String(body?.postCode || ''),
      country: String(body?.country || 'Slovenija'),
      taxId: String(body?.taxId || ''),
      businessId: String(body?.businessId || ''),
      iban: String(body?.iban || ''),
      bank: String(body?.bank || ''),
      paymentTerms: String(body?.paymentTerms || '30 dni'),
      notes: String(body?.notes || ''),
    },
  })
  // 33-c: chain polja + locationId akterja (audit §6)
  await writeAudit(db, { userId: user.sub, action: 'SUPPLIER_CREATE', entityType: 'Supplier', entityId: row.id, details: jstr({ name: row.name, code: row.code }), locationId: user.loc })
  return ok({ supplier: { id: row.id, name: row.name } }, 201)
}

/** Urejanje dobavitelja (triage ②) — enaka pravica kot ustvarjanje (`settings.manage`). */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '').trim()
  if (!id) return fail('Manjka id dobavitelja.', 400)
  const existing = await db.supplier.findUnique({ where: { id } })
  if (!existing) return fail('Dobavitelj ne obstaja.', 404)

  const data: Record<string, unknown> = {}
  const strFields: [string, string][] = [
    ['name', 'name'],
    ['contact', 'contactPerson'],
    ['phone', 'phone'],
    ['email', 'email'],
    ['address', 'address'],
    ['city', 'city'],
    ['postCode', 'postCode'],
    ['country', 'country'],
    ['taxId', 'taxId'],
    ['businessId', 'businessId'],
    ['iban', 'iban'],
    ['bank', 'bank'],
    ['paymentTerms', 'paymentTerms'],
    ['notes', 'notes'],
  ]
  for (const [key, column] of strFields) {
    if (body?.[key] !== undefined) data[column] = String(body[key]).trim()
  }
  if (body?.isActive !== undefined) data.isActive = Boolean(body.isActive)
  if (data.name === '') return fail('Naziv ne sme biti prazen.', 400)
  if (data.name && data.name !== existing.name) {
    const dup = await db.supplier.findUnique({ where: { name: String(data.name) } })
    if (dup) return fail('Dobavitelj s tem nazivom že obstaja.', 409)
  }
  if (Object.keys(data).length === 0) return fail('Ni sprememb.', 400)

  const row = await db.supplier.update({ where: { id }, data })
  // 33-c: chain polja + locationId akterja (audit §6)
  await writeAudit(db, { userId: user.sub, action: 'SUPPLIER_UPDATE', entityType: 'Supplier', entityId: id, details: jstr({ changed: Object.keys(data), name: row.name }), locationId: user.loc })
  return ok({ supplier: { id: row.id, name: row.name } })
}
