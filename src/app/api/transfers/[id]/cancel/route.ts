import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { transferTablesReady } from '@/lib/transfer-schema'
import { transferDto, type TrfRow } from '@/lib/stock-transfer'

/**
 * Issue #8 (P2, v1.116.0) — PREKLIC medlokacijskega prenosa.
 *
 * POST /api/transfers/[id]/cancel  { reason }
 *   DRAFT → CANCELLED (SAMO osnutek — prenos, ki je že odpremljen, fizično
 *   potuje; preklic takrat zahteva vračilni postopek, ki ga ni). Zaloga se
 *   NE dotakne (osnutek ni knjižil ničesar). Razlog ≥ 3 znaki, ≤ 500.
 *   CAS updateMany where status DRAFT — sočasen preklic/dvojni klik → 409.
 *   Audit TRANSFER_CANCELLED (razlog vključen — sledljivost odločitve).
 *
 * Pravica: inventory.manage + guardResource(from). PRE-DDL: 503 (graceful).
 */

const CANCEL_REASON_MIN = 3
const CANCEL_REASON_MAX = 500

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < CANCEL_REASON_MIN) {
    return fail(`Razlog preklica mora imeti vsaj ${CANCEL_REASON_MIN} znake.`, 400)
  }
  if (reason.length > CANCEL_REASON_MAX) {
    return fail(`Razlog preklica je lahko največ ${CANCEL_REASON_MAX} znakov.`, 400)
  }

  const transfer = await db.stockTransfer.findUnique({
    where: { id },
    include: { items: true, _count: { select: { items: true } } },
  })
  if (!transfer) return fail('Prenos ne obstaja.', 404)

  // preklic je odločitev ODDAJNIKA (izvorne lokacije)
  const guarded = await guardResource(user, transfer.fromLocationId)
  if (guarded) return guarded

  if (transfer.status !== 'DRAFT') {
    return fail('Preklicati je mogoče le osnutek prenosa.', 409)
  }

  const now = new Date()
  const updated = await db.$transaction(async (tx) => {
    // ANCHOR na vrstici IZVORNE lokacije (#63) — serializira sočasne
    // preklice/odpremitve istega osnutka
    const anchor = await tx.location.updateMany({ where: { id: transfer.fromLocationId }, data: { updatedAt: now } })
    if (anchor.count === 0) return null

    // CAS: samo iz DRAFT — sočasna odpremitev je zmagala → 409 (nič spremembe)
    const cas = await tx.stockTransfer.updateMany({
      where: { id: transfer.id, status: 'DRAFT' },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason },
    })
    if (cas.count === 0) return { concurrent: true as const }

    await writeAudit(tx, {
      userId: user.sub,
      action: 'TRANSFER_CANCELLED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      details: jstr({
        transferNumber: transfer.transferNumber,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
        lineCount: transfer.items.length,
        reason,
      }),
      locationId: transfer.fromLocationId,
    })

    return { concurrent: false as const }
  })

  if (updated === null) return fail('Izvorna lokacija ne obstaja.', 404)
  if (updated.concurrent) {
    return fail('Prenos je medtem že odpremljen — preklic ni mogoč.', 409)
  }

  const fresh = await db.stockTransfer.findUnique({
    where: { id: transfer.id },
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  })
  if (!fresh) return fail('Prenos ne obstaja.', 404)
  return ok({ transfer: transferDto(fresh as TrfRow) })
}
