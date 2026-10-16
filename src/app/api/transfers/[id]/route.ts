import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { transferTablesReady } from '@/lib/transfer-schema'
import { transferDto, type TrfRow } from '@/lib/stock-transfer'

/**
 * Issue #8 (P2, v1.116.0) — DETALJ medlokacijskega prenosa.
 *
 * GET /api/transfers/[id]
 *   → prenos z vrsticami (količine, serije, ciljni artikel) + variance
 *     (missing/damaged — samo terminalna stanja) + imena lokacij.
 *   Vidnost: IZVOR ALI CILJ mora biti v uporabnikovem obsegu — non-central
 *     uporabnik vidi prenos, če je njegova lokacija from ALI to (48-h urni
 *     pregled prejemnika); centralna vloga = org meja na OBEH lokacijah
 *     (vsaj ena mora ustrezati, sicer 403).
 *
 * Pravica: inventory.manage. PRE-DDL: transferTablesReady → 503 (graceful).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }
  const { id } = await ctx.params

  const transfer = await db.stockTransfer.findUnique({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  })
  if (!transfer) return fail('Prenos ne obstaja.', 404)

  // vidnost: izvor ALI cilj v obsegu (guardResource vrne NextResponse pri
  // kršitvi) — prejemnik CILJNE lokacije vidi prenos za prevzem, odpošiljatelj
  // IZVORNE za odpremitev; centralni preverimo org mejo na obeh (fail-closed)
  const fromGuard = await guardResource(user, transfer.fromLocationId)
  const toGuard = await guardResource(user, transfer.toLocationId)
  if (fromGuard && toGuard) {
    // non-central: nobena od lokacij ni njegova → 403; centralni: vsaj ena
    // tuja org bi morala pasti tukaj samo, če sta OBE tuji (izvor in cilj
    // različnih org — to je že blokirano ob ustvarjanju, torej defenzivno)
    return fromGuard
  }

  const [fromLoc, toLoc] = await Promise.all([
    db.location.findUnique({ where: { id: transfer.fromLocationId }, select: { name: true } }),
    db.location.findUnique({ where: { id: transfer.toLocationId }, select: { name: true } }),
  ])

  return ok({
    transfer: transferDto(transfer as TrfRow, { from: fromLoc?.name ?? null, to: toLoc?.name ?? null }),
  })
}
