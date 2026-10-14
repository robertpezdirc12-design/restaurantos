import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, r2, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { expenseCategoriesAvailable, normalizeExpenseCategory } from '@/lib/expenses-categories'
import { applyApMatchEvaluation } from '@/lib/ap-match'

/**
 * Task 61 (revizija §7 vrstica 122): urejanje/mehko brisanje stroška (AccountsPayable).
 * Prej: samo GET+POST (seznam+vnos) — brez urejanja, brez plačila, brez preklica.
 *
 * Pravila (knjigovodsko konservativno):
 *  - PATCH: opis (invoiceNumber+notes), znesek, zapadlost (dueDate), status open↔paid.
 *    Znesek je VARNOSTNO zaklenjen, če je strošek že plačan (status 'paid' ali
 *    paidAmount > 0) → 409 (znesek plačanega povpraševanja ne sme drseti —
 *    najprej odpri plačilo, potem uredi znesek).
 *    'void' status se nastavlja IZKLJUČNO prek DELETE (mehko brisanje) — PATCH na
 *    preklicanega → 409.
 *  - DELETE: MEHKO — status 'void' (idempotentno: že preklican → ok brez nove revizije).
 *    Hard delete bi s FK AccountsPayableLine Cascade izgubil vrstice računa;
 *    status 'void' ohrani revizijsko pot, poročila pa ga izključijo
 *    (reports/financial: status != 'void', reports/export: status bucket).
 *  - Dovoljenje `settings.manage` (isti kanon kot POST) + `guardResource`
 *    (lokacijski sloj fail-closed: staff samo svoja lokacija; org meja za centralne).
 */

/** Skupni odzivni mapping — enak obliki, ki jo UI pričakuje od GET /api/expenses.
 *  Task 67: categoryOverride — realna kategorija (raw stolpec ni v tipiziranem
 *  vrstici); undefined → legacy 'OSTALO' (probe off / ni podano). */
function expenseView(r: {
  id: string
  apNumber: string
  invoiceNumber: string
  notes: string
  status: string
  totalAmount: unknown
  paidAmount: unknown
  paidAt: Date | null
  invoiceDate: Date
  dueDate: Date
  locationId: string | null
  Supplier?: { name: string } | null
}, categoryOverride?: string) {
  return {
    id: r.id,
    apNumber: r.apNumber,
    category: categoryOverride ?? 'OSTALO',
    description: r.invoiceNumber || r.notes || 'Dobaviteljev račun',
    amount: num(r.totalAmount),
    paidAmount: num(r.paidAmount),
    status: r.status || 'open',
    paidAt: r.paidAt || r.invoiceDate,
    dueDate: r.dueDate,
    locationId: r.locationId,
    supplierName: r.Supplier?.name || null,
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const existing = await db.accountsPayable.findUnique({
    where: { id },
    // Issue #18: vrstice potrebne za apHasPoLinks (re-evalvacija ob spremembi zneska)
    include: {
      Supplier: { select: { name: true } },
      AccountsPayableLine: { select: { purchaseOrderItemId: true } },
    },
  })
  if (!existing) return fail('Strošek ne obstaja.', 404)
  // lokacijski + org sloj (Task 52 konvencija — guardResource v 34 rutah)
  const guard = await guardResource(user, existing.locationId)
  if (guard) return guard
  if (existing.status === 'void') return fail('Preklicanega stroška ni mogoče urejati.', 409)

  const data: Record<string, unknown> = {}

  if (body?.description !== undefined) {
    const description = String(body.description).trim()
    if (!description) return fail('Opis je obvezen.', 400)
    data.invoiceNumber = description.slice(0, 120)
    data.notes = description
  }

  const isPaid = existing.status === 'paid' || num(existing.paidAmount) > 0
  if (body?.amount !== undefined) {
    const amount = num(body.amount)
    if (!(amount > 0)) return fail('Znesek mora biti pozitiven.', 400)
    // knjigovodska zaklen: plačanega zapisa se ne ureja po znesku (409, ne 400 —
    // konflikt stanja, ne sintakse). Najprej "odpri plačilo", potem uredi znesek.
    if (isPaid) return fail('Plačanega stroška ni mogoče urejati po znesku — najprej odpri plačilo.', 409)
    data.subtotal = r2(amount)
    data.totalAmount = r2(amount)
  }

  if (body?.dueDate !== undefined) {
    if (!body.dueDate) return fail('Zapadlost ne sme biti prazna.', 400)
    const due = new Date(String(body.dueDate))
    if (Number.isNaN(due.getTime())) return fail('Zapadlost ni veljaven datum.', 400)
    data.dueDate = due
  }

  if (body?.status !== undefined) {
    const status = String(body.status).toLowerCase()
    if (!['open', 'paid'].includes(status)) {
      return fail('Status mora biti open ali paid (preklic gre prek DELETE).', 400)
    }
    // Issue #18 (P1) — plačilna varovalka tristranskega ujemanja: račun z
    // nerazrešenimi razlikami (količina nad prevzemom / cena / DDV / znesek →
    // blocked ali review_required) NI potrjevan/plačljiv, dokler pooblaščena
    // oseba ne razreši izjeme (POST /api/ap/[id]/match approve_exception →
    // exception_approved). Osnutek iz prevzema (grn_draft) OSTAJA plačljiv
    // (blago je fizično prejeto; znesek izhaja iz PO) — a je jasno označen.
    if (status === 'paid' && (existing.matchStatus === 'blocked' || existing.matchStatus === 'review_required')) {
      return fail(
        `Račun ima nerazrešene razlike v tristranskem ujemanju (nabavno naročilo ↔ prevzem ↔ račun; stanje: ${existing.matchStatus}) — ` +
        'razrešite izjemo (Stroški → Ujemanje → Odobri izjemo) pred plačilom.',
        409,
      )
    }
    if (status === 'paid') {
      const total = r2(num(body?.amount !== undefined ? data.totalAmount : existing.totalAmount))
      data.status = 'paid'
      data.paidAmount = total
      if (!existing.paidAt) data.paidAt = new Date()
    } else {
      data.status = 'open'
      data.paidAmount = 0
      data.paidAt = null
    }
  }

  // Task 67: kategorija (opcijsko, runtime-gated) — '' pomeni brisanje kategorije.
  const catsEnabled = await expenseCategoriesAvailable()
  let categoryValue: string | null = null // null = ključ ni podan
  let categoryPrevious: string | null = null
  if (catsEnabled) {
    // prejšnja vrednost (raw — tipizirani client stolpca ne pozna); beremo VEDNO,
    // da je odziv pravilen tudi pri PATCH, ki kategorije ne dotakne
    const prevRows = await db.$queryRaw<{ category: string }[]>`
      SELECT "category" FROM "AccountsPayable" WHERE "id" = ${id}`
    categoryPrevious = prevRows[0]?.category ?? ''
  }
  if (body?.category !== undefined) {
    const normalized = normalizeExpenseCategory(body.category)
    if (normalized === null) return fail('Kategorija je predolga (največ 60 znakov).', 400)
    if (normalized && !catsEnabled) {
      return fail('Kategorije stroškov čakajo DDL korak (Enterprise → Shema migracije → stroski-kategorije).', 503)
    }
    categoryValue = normalized
  }
  const categoryChanged = categoryValue !== null && categoryValue !== categoryPrevious

  if (!Object.keys(data).length && !categoryChanged) return fail('Ni sprememb.', 400)

  // Task 67: update + kategorija v ENI interaktivni transakciji (oba ali noben)
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.accountsPayable.update({ where: { id }, data })
    if (categoryChanged && categoryValue !== null) {
      await tx.$executeRaw`UPDATE "AccountsPayable" SET "category" = ${categoryValue} WHERE "id" = ${id}`
    }
    return u
  })

  const __aId = nid()
  const __before: Record<string, unknown> = {
    description: existing.invoiceNumber || existing.notes,
    amount: num(existing.totalAmount),
    status: existing.status,
    dueDate: existing.dueDate,
  }
  const __after: Record<string, unknown> = {
    description: (data.invoiceNumber as string) || existing.invoiceNumber,
    amount: data.totalAmount !== undefined ? num(data.totalAmount) : num(existing.totalAmount),
    status: (data.status as string) || existing.status,
    dueDate: data.dueDate !== undefined ? data.dueDate : existing.dueDate,
  }
  if (catsEnabled) {
    __before.category = categoryPrevious ?? ''
    __after.category = categoryChanged ? categoryValue : (categoryPrevious ?? '')
  }
  const __details = jstr({ before: __before, after: __after })
  const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'EXPENSE_UPDATED',
    entityType: 'AccountsPayable',
    entityId: id,
    details: __details,
    locationId: existing.locationId,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'EXPENSE_UPDATED',
      entityType: 'AccountsPayable',
      entityId: id,
      details: __details,
      locationId: existing.locationId,
    },
  })

  // Issue #18: sprememba zneska glave na AP s PO povezavami → ponovna
  // tristranska evalvacija (prejšnji rezultat ne ostaja veljaven brez preverbe).
  // Best-effort (urejanje samo po uspehu); exception_approved se NE prepiše.
  if (data.totalAmount !== undefined && apHasPoLinks(existing)) {
    try {
      await applyApMatchEvaluation(id, { userId: user.sub, reason: 'expense_amount_changed' })
    } catch {
      /* stanje se vidi v /api/ap/[id]/match in seznamu Stroškov */
    }
  }

  return ok({ expense: expenseView(updated, catsEnabled ? (categoryChanged ? categoryValue! : (categoryPrevious ?? '')) : undefined) })
}

/** Issue #18: ali ima AP vrstice povezane na PO postavke (pomembno za re-evalvacijo)? */
function apHasPoLinks(ap: { AccountsPayableLine?: { purchaseOrderItemId: string | null }[] }): boolean {
  return (ap.AccountsPayableLine ?? []).some((l) => !!l.purchaseOrderItemId)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const { id } = await params

  const existing = await db.accountsPayable.findUnique({ where: { id } })
  if (!existing) return fail('Strošek ne obstaja.', 404)
  const guard = await guardResource(user, existing.locationId)
  if (guard) return guard

  // mehko brisanje, idempotentno — že preklican → ok, BREZ duplikata revizije
  if (existing.status !== 'void') {
    await db.accountsPayable.update({ where: { id }, data: { status: 'void' } })
    const __aId = nid()
    const __details = jstr({
      apNumber: existing.apNumber,
      description: existing.invoiceNumber || existing.notes,
      amount: num(existing.totalAmount),
      status: existing.status,
      softDelete: true,
    })
    const __chain = await auditChainFields(db, {
      id: __aId,
      action: 'EXPENSE_DELETED',
      entityType: 'AccountsPayable',
      entityId: id,
      details: __details,
      locationId: existing.locationId,
    })
    await db.auditLog.create({
      data: {
        ...__chain,
        id: __aId,
        userId: user.sub,
        action: 'EXPENSE_DELETED',
        entityType: 'AccountsPayable',
        entityId: id,
        details: __details,
        locationId: existing.locationId,
      },
    })
  }
  return ok({ deleted: true })
}
