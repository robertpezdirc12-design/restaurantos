import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, fail, locationScope } from '@/lib/api'

/**
 * Issue #4 (P1, v1.125.0) — izpis shranjenega XML odhodnega e-računa (dokaz).
 *
 * GET /api/einvoices/[id]/xml
 *  - vrne xmlPayload (Content-Type application/xml, Content-Disposition
 *    attachment; filename=<invoiceNumber>.xml — sanitizirano);
 *  - glava X-EInvoice-Hash = xmlHash (sha256 poslane vsebine — dokaz
 *    ponovljivosti, issue §P1-C: nezmanjšljiva reprezentacija);
 *  - locationScope: tuj outbox → 404 (občutljiva vsebina — samo reports.view).
 */
function safeFilename(invoiceNumber: string): string {
  const clean = String(invoiceNumber || 'einvoice').replace(/[^\w.-]+/g, '_').slice(0, 60)
  return clean || 'einvoice'
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const { id } = await params

  const scope = await locationScope(user)
  const outbox = await db.eInvoiceOutbox.findFirst({
    where: { id, ...scope },
    select: { xmlPayload: true, xmlHash: true, invoiceNumber: true },
  })
  if (!outbox || !outbox.xmlPayload) return fail('E-račun ni v vašem obsegu ali nima XML vsebine.', 404)

  return new NextResponse(outbox.xmlPayload, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeFilename(outbox.invoiceNumber)}.xml"`,
      'X-EInvoice-Hash': outbox.xmlHash,
      'Cache-Control': 'no-store',
    },
  })
}
