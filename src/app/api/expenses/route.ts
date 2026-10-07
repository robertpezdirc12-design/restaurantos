import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { num, nid, r2 } from '@/lib/map'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const rows = await db.accountsPayable.findMany({
    // Issue #4 §1: stroški po lokaciji (AccountsPayable.locationId)
    where: locationScope(user),
    orderBy: { invoiceDate: 'desc' },
    take: 100,
  })
  return ok({
    expenses: rows.map((r) => ({
      id: r.id,
      category: 'OSTALO',
      description: r.invoiceNumber || r.notes || 'Dobaviteljev račun',
      amount: num(r.totalAmount),
      paidAt: r.paidAt || r.invoiceDate,
      locationId: r.locationId,
    })),
  })
}

/**
 * Nov strošek (dobaviteljev račun / AccountsPayable).
 * opomba: supplierId je FK na Supplier — če obstajajo, vzemi prvega, sicer ustvari
 * privzetega "Razno". apNumber je unique brez defaulta → generiramo.
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!['OWNER', 'ADMIN', 'MANAGER'].includes(user.role)) return fail('Ni dovoljenj.', 403)
  const body = await req.json().catch(() => null)
  const description = String(body?.description || '').trim()
  const amount = num(body?.amount)
  if (!description) return fail('Opis je obvezen.', 400)
  if (!(amount > 0)) return fail('Znesek mora biti pozitiven.', 400)
  // Issue #4 §10: brez findFirst() fallback — staff = svoja lokacija, centralna poda body.locationId
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId

  let supplier = await db.supplier.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!supplier) {
    supplier = await db.supplier.create({ data: { id: nid(), name: 'Razno' } })
  }

  const now = new Date()
  const due = new Date(now)
  due.setDate(due.getDate() + 30)
  const row = await db.accountsPayable.create({
    data: {
      id: nid(),
      apNumber: `AP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${nid().slice(0, 6).toUpperCase()}`,
      supplierId: supplier.id,
      invoiceNumber: description.slice(0, 120),
      invoiceDate: now,
      dueDate: due,
      subtotal: r2(amount),
      totalAmount: r2(amount),
      notes: description,
      locationId,
    },
  })
  return ok({
    expense: {
      id: row.id,
      category: 'OSTALO',
      description: row.invoiceNumber || row.notes,
      amount: num(row.totalAmount),
      paidAt: row.paidAt || row.invoiceDate,
    },
  }, 201)
}
