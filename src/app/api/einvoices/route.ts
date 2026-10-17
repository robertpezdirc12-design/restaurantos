import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'

/**
 * Issue #4 (P1, v1.125.0) — seznam odhodnih B2B e-računov (outbox).
 *
 * GET /api/einvoices?country=&status=&direction=&from=&to=&q=&limit=&offset=
 *  - filtri: country (SI/HR), status (EINVOICE_STATUSES), direction (outgoing),
 *    from/to (createdAt), q (iskanje po externalRef/invoiceNumber/receiverName/
 *    receiverTaxId);
 *  - locationScope (enak predikat kot Stroški/terjatve): uporabnik ene lokacije
 *    NE vidi tujih e-računov;
 *  - xmlPayload se NE vrača (težko polje — izključeno iz selekta; posebna ruta
 *    /api/einvoices/[id]/xml ga vrne s hash glavo);
 *  - paginacija: limit ≤ 100 (privzeto 50) + offset.
 *
 * Pravica: reports.view (finančni seznam — kot Stroški).
 */
const LIST_SELECT = {
  id: true,
  arId: true,
  direction: true,
  country: true,
  documentType: true,
  profile: true,
  currency: true,
  invoiceNumber: true,
  receiverName: true,
  receiverTaxId: true,
  receiverCountry: true,
  subtotal: true,
  vatAmount: true,
  totalAmount: true,
  externalRef: true,
  idempotencyKey: true,
  status: true,
  lastReason: true,
  attempts: true,
  lastAttemptAt: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  locationId: true,
} satisfies Prisma.EInvoiceOutboxSelect

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.sales')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const country = url.searchParams.get('country')?.trim().toUpperCase() || ''
  const status = url.searchParams.get('status')?.trim().toLowerCase() || ''
  const direction = url.searchParams.get('direction')?.trim().toLowerCase() || ''
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const q = url.searchParams.get('q')?.trim() || ''
  const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10)
  const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0

  const fromDate = from ? new Date(`${from}T00:00:00`) : null
  const toDate = to ? new Date(`${to}T23:59:59.999`) : null
  if ((from && isNaN(fromDate!.getTime())) || (to && isNaN(toDate!.getTime()))) {
    return fail('Neveljaven datum (pričakovano YYYY-MM-DD).', 400)
  }

  const scope = await locationScope(user)
  const where: Prisma.EInvoiceOutboxWhereInput = {
    ...scope,
    ...(country ? { country } : {}),
    ...(status ? { status } : {}),
    ...(direction ? { direction } : {}),
    ...(fromDate || toDate ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { externalRef: { contains: q } },
            { invoiceNumber: { contains: q } },
            { receiverName: { contains: q } },
            { receiverTaxId: { contains: q } },
          ],
        }
      : {}),
  }

  const [rows, total] = await Promise.all([
    db.eInvoiceOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: LIST_SELECT,
    }),
    db.eInvoiceOutbox.count({ where }),
  ])

  return ok({
    eInvoices: rows.map((r) => ({
      ...r,
      subtotal: Number(r.subtotal),
      vatAmount: Number(r.vatAmount),
      totalAmount: Number(r.totalAmount),
    })),
    total,
    limit,
    offset,
  })
}
