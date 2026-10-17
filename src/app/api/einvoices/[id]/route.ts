import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'

/**
 * Issue #4 (P1, v1.125.0) — podrobnosti odhodnega B2B e-računa + revizijska
 * časovnica statusnih dogodkov.
 *
 * GET /api/einvoices/[id]
 *  - podrobnosti outboxa (BREZ xmlPayload — težko polje; posebna /xml ruta);
 *  - events = AuditLog (entityType 'EInvoiceOutbox', entityId = id), najstarejši
 *    najprej, max 50 — veriga JE revizijska sled (dogodki EINVOICE_ISSUED/
 *    EINVOICE_STATUS/EINVOICE_SEND_FAILED; correlationId/origin v details JSON);
 *  - locationScope: tuj outbox → 404.
 *
 * Pravica: reports.view.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const { id } = await params

  const scope = await locationScope(user)
  const outbox = await db.eInvoiceOutbox.findFirst({
    where: { id, ...scope },
    select: {
      id: true, arId: true, direction: true, country: true, documentType: true,
      profile: true, currency: true, invoiceNumber: true, receiverName: true,
      receiverTaxId: true, receiverCountry: true, subtotal: true, vatAmount: true,
      totalAmount: true, xmlHash: true, externalRef: true, idempotencyKey: true,
      status: true, lastReason: true, processedEvents: true, attempts: true,
      lastAttemptAt: true, sentAt: true, createdAt: true, updatedAt: true, locationId: true,
      AccountsReceivable: { select: { id: true, arNumber: true, customerName: true, status: true, paidAmount: true } },
    },
  })
  if (!outbox) return fail('E-račun ni v vašem obsegu ali ne obstaja.', 404)

  // revizijska časovnica statusnih dogodkov (AuditLog veriga — najstarejši najprej)
  // vključno z IZDAJO (EINVOICE_ISSUED piše na entiteti AR — entityId = arId)
  const events = await db.auditLog.findMany({
    where: {
      OR: [
        { entityType: 'EInvoiceOutbox', entityId: id },
        ...(outbox.arId ? [{ action: 'EINVOICE_ISSUED', entityId: outbox.arId }] : []),
      ],
    },
    orderBy: { timestamp: 'asc' },
    take: 50,
    select: { id: true, action: true, details: true, userId: true, timestamp: true },
  })

  let processedEventIds: string[] = []
  try {
    const parsed = JSON.parse(outbox.processedEvents || '[]') as unknown
    if (Array.isArray(parsed)) processedEventIds = parsed.filter((e) => typeof e === 'string').slice(0, 50)
  } catch {
    processedEventIds = []
  }

  return ok({
    eInvoice: {
      ...outbox,
      subtotal: Number(outbox.subtotal),
      vatAmount: Number(outbox.vatAmount),
      totalAmount: Number(outbox.totalAmount),
      AccountsReceivable: outbox.AccountsReceivable
        ? { ...outbox.AccountsReceivable, paidAmount: Number(outbox.AccountsReceivable.paidAmount) }
        : null,
    },
    events,
    processedEventIds,
  })
}
