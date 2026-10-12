import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { apNumberFor, apLineTotalGross, parsePaymentTermsDays } from '@/lib/procurement'
import { parseEslog, type EslogInvoice } from '@/lib/eslog'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * OPS-9 val 2 (v1.75.0) — eSLOG e-račun uvoz (XML → zapadle obveznosti).
 *
 * POST /api/ap/import-eslog { xml: string }
 *   → parse (src/lib/eslog.ts) → match Supplier po davčni številki (samo števke;
 *     Supplier.taxId sme imeti "SI" predpono — obe strani se normalizirajo) →
 *     AccountsPayable (status 'open', matchStatus 'auto') + AccountsPayableLine vrstice.
 *
 * Idempotentnost: AP z isto (supplierId, invoiceNumber) že obstaja → 200 {duplicate:true, ap}.
 * Brez ujemanja dobavitelja → 422 {error, parsed} (UI spodbudi ustvarjanje dobavitelja;
 * nikoli NE ustvarjamo dobavitelja samodejno).
 *
 * Pravica: inventory.manage (kot POST /api/purchase-orders). Audit: ESLOG_IMPORTED.
 * Numeracija: apNumberFor (AP-YYYY-NNNN), count-based seq + retry na unique
 * (isti vzorec kot prevzemni most v /api/purchase-orders/[id]/receive).
 */

const MAX_XML_BYTES = 2 * 1024 * 1024 // 2 MB — e-računi so majhni dokumenti

function apResponse(ap: {
  id: string
  apNumber: string
  supplierId: string
  invoiceNumber: string
  invoiceDate: Date
  dueDate: Date
  subtotal: unknown
  vatAmount: unknown
  totalAmount: unknown
  status: string
  matchStatus: string
}) {
  return {
    id: ap.id,
    apNumber: ap.apNumber,
    supplierId: ap.supplierId,
    invoiceNumber: ap.invoiceNumber,
    invoiceDate: ap.invoiceDate,
    dueDate: ap.dueDate,
    subtotal: Number(ap.subtotal),
    vatAmount: Number(ap.vatAmount),
    totalAmount: Number(ap.totalAmount),
    status: ap.status,
    matchStatus: ap.matchStatus,
  }
}

/** Fallback totals from lines when the XML header amounts are missing/unparseable. */
function totalsFromLines(inv: EslogInvoice): { subtotal: number; vatAmount: number; totalAmount: number } {
  let subtotal = 0
  let vatAmount = 0
  for (const l of inv.lines) {
    const net = Math.round(l.quantity * l.unitPrice * 100) / 100
    const gross = apLineTotalGross(l.quantity, l.unitPrice, l.vatRate)
    subtotal += net
    vatAmount += Math.round((gross - net) * 100) / 100
  }
  subtotal = Math.round(subtotal * 100) / 100
  vatAmount = Math.round(vatAmount * 100) / 100
  return { subtotal, vatAmount, totalAmount: Math.round((subtotal + vatAmount) * 100) / 100 }
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body || typeof body.xml !== 'string') return fail('Manjka XML vsebina e-računa.', 400)
  const xml = body.xml
  if (xml.length > MAX_XML_BYTES) return fail('XML datoteka je prevelika (največ 2 MB).', 413)

  const parsedResult = parseEslog(xml)
  if (!parsedResult.invoice) {
    return ok({ error: parsedResult.error || 'Nepoznana struktura e-računa.', parsed: null }, 422)
  }
  const inv = parsedResult.invoice

  if (!inv.supplier.taxId) {
    return ok({ error: 'E-račun nima davčne številke dobavitelja — ni mogoče najti dobavitelja.', parsed: inv }, 422)
  }

  // supplier match: digits-only comparison (Supplier.taxId may carry an SI prefix)
  const suppliers = await db.supplier.findMany({
    select: { id: true, name: true, taxId: true, paymentTerms: true, isActive: true },
  })
  const supplier = suppliers.find((s) => String(s.taxId ?? '').replace(/\D/g, '') === inv.supplier.taxId) || null
  if (!supplier) {
    return ok(
      {
        error: `Dobavitelj z davčno številko ${inv.supplier.taxId} ni najden. Najprej ustvari dobavitelja.`,
        parsed: inv,
      },
      422,
    )
  }

  // idempotency: same supplier + invoice number already imported
  const existing = await db.accountsPayable.findFirst({
    where: { supplierId: supplier.id, invoiceNumber: inv.invoiceNumber },
  })
  if (existing) {
    return ok({ duplicate: true, ap: apResponse(existing) })
  }

  // dates: issueDate/dueDate as written in XML (yyyy-mm-dd); fallbacks = today + payment terms
  const now = new Date()
  const invoiceDate = inv.issueDate && !isNaN(new Date(inv.issueDate).getTime()) ? new Date(inv.issueDate) : now
  const dueDateParsed = inv.dueDate && !isNaN(new Date(inv.dueDate).getTime()) ? new Date(inv.dueDate) : null
  const dueDate = dueDateParsed ?? new Date(invoiceDate.getTime() + parsePaymentTermsDays(supplier.paymentTerms) * 86400000)

  const derived = totalsFromLines(inv)
  const subtotal = Number.isFinite(inv.subtotal) ? inv.subtotal : derived.subtotal
  const vatAmount = Number.isFinite(inv.vatTotal) ? inv.vatTotal : derived.vatAmount
  const totalAmount = Number.isFinite(inv.total) ? inv.total : derived.totalAmount

  const apLines = inv.lines.map((l) => ({
    description: l.name || inv.invoiceNumber,
    quantityInvoiced: l.quantity,
    unitPriceInvoiced: l.unitPrice,
    vatRateInvoiced: l.vatRate,
    lineTotal: apLineTotalGross(l.quantity, l.unitPrice, l.vatRate),
  }))

  const year = now.getFullYear()
  let ap: Awaited<ReturnType<typeof createAp>> | null = null
  for (let attempt = 0; attempt < 5 && !ap; attempt++) {
    const seq = (await db.accountsPayable.count({ where: { apNumber: { startsWith: `AP-${year}-` } } })) + 1 + attempt
    try {
      ap = await createAp({ supplierId: supplier.id, invoiceDate, dueDate, subtotal, vatAmount, totalAmount, inv, apLines, seq, locationId: user.loc || null })
    } catch (e) {
      const msg = String((e as Error).message || '')
      if (msg.includes('apNumber') && attempt < 4) continue // concurrent numbering — retry
      throw e
    }
  }
  if (!ap) return fail('Uvoz računa ni uspel (številčenje).', 500)

  const __aId2 = nid(); const __chain2 = await auditChainFields(db, { action: 'ESLOG_IMPORTED', entityType: 'AccountsPayable', entityId: ap.id, details: jstr({ apNumber: ap.apNumber, invoiceNumber: inv.invoiceNumber, supplierId: supplier.id, supplierName: supplier.name, supplierTaxId: inv.supplier.taxId, subtotal, vatAmount, totalAmount, lines: apLines.length, dueDate: dueDate.toISOString(), locationId: user.loc || null, }), id: __aId2 })
  await db.auditLog.create({
    data: { ...__chain2,
      id: __aId2,
      userId: user.sub,
      action: 'ESLOG_IMPORTED',
      entityType: 'AccountsPayable',
      entityId: ap.id,
      details: jstr({
        apNumber: ap.apNumber,
        invoiceNumber: inv.invoiceNumber,
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierTaxId: inv.supplier.taxId,
        subtotal,
        vatAmount,
        totalAmount,
        lines: apLines.length,
        dueDate: dueDate.toISOString(),
        locationId: user.loc || null,
      }),
    },
  })

  return ok({ ap: apResponse(ap), supplier: { id: supplier.id, name: supplier.name }, parsed: inv }, 201)
}

async function createAp(args: {
  supplierId: string
  invoiceDate: Date
  dueDate: Date
  subtotal: number
  vatAmount: number
  totalAmount: number
  inv: EslogInvoice
  apLines: { description: string; quantityInvoiced: number; unitPriceInvoiced: number; vatRateInvoiced: number; lineTotal: number }[]
  seq: number
  locationId: string | null
}) {
  const { supplierId, invoiceDate, dueDate, subtotal, vatAmount, totalAmount, inv, apLines, seq, locationId } = args
  return db.$transaction(async (tx) => {
    return tx.accountsPayable.create({
      data: {
        id: nid(),
        apNumber: apNumberFor(new Date().getFullYear(), seq),
        supplierId,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate,
        dueDate,
        subtotal,
        vatAmount,
        totalAmount,
        status: 'open',
        matchStatus: 'auto',
        notes: `Uvoženo iz eSLOG računa ${inv.invoiceNumber}`,
        locationId,
        AccountsPayableLine: {
          create: apLines.map((l) => ({ id: nid(), ...l })),
        },
      },
      include: { AccountsPayableLine: true },
    })
  })
}
