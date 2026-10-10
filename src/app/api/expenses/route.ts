import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { num, nid, r2 } from '@/lib/map'

/**
 * N5 (revizija §4): GET je finančni seznam (dobaviteljski računi) — UI prikazuje
 * zavihek Stroški samo z 'reports.view' (TAB_PERM.stroski), zato backend uveljavlja
 * isto kanonično dovoljenje (prej: requireAuth — natakar je prek API-ja videl finance).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
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
 * N3 (audit P1): kanonično dovoljenje `settings.manage` namesto trdo kodiranih vlog —
 * enterprise vloge s to pravico in permissionOverrides delujejo na pisanje (DB lookup).
 * opomba: supplierId je FK na Supplier — če obstajajo, vzemi prvega, sicer ustvari
 * privzetega "Razno". apNumber je unique brez defaulta → generiramo.
 *
 * R12 (revizija §6): prejšnji findFirst→create je pod konkurenco ustvaril več
 * dobaviteljev "Razno" (dve zahtevi sta oba prebrali prazen seznam in oba ustvarili).
 * Supplier.name je @unique → upsert po unique ključu je ATOMAREN (INSERT ON CONFLICT):
 * če "Razno" že obstaja (ali ga je vzporedna zahteva pravkar ustvarila), upsert vrne
 * obstoječo vrstico — pod konkurenco obstaja natanko EN "Razno" dobavitelj.
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
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
    // R12: upsert (ne create) — unique name ključ odpravi duplikate "Razno" pod konkurenco
    supplier = await db.supplier.upsert({
      where: { name: 'Razno' },
      update: {},
      create: { id: nid(), name: 'Razno' },
    })
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
