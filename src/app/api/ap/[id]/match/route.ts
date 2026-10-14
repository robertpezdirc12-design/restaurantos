import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr, nid } from '@/lib/map'
import { writeAudit, auditChainFields } from '@/lib/audit-chain'
import {
  evaluateApMatch,
  applyApMatchEvaluation,
  proposeLinks,
  poCandidatesForSupplier,
  REEVALUABLE_STATUSES,
  type ApMatchEval,
} from '@/lib/ap-match'

/**
 * Issue #18 (P1) — tristransko ujemanje PO ↔ GRN ↔ dobaviteljev račun:
 * pregled in ročna razrešitev ujemanja AP (AccountsPayable).
 *
 * GET /api/ap/[id]/match  (reports.view — finančni vpogled, isti sloj kot seznam
 *   /api/expenses + guardResource nad AP lokacijo):
 *   → AP glava (apNumber, invoiceNumber, matchStatus, tolerance) + vrstice z
 *     evalvacijo (variance, kumulativna fakturirana/sprejeta/naročena količina)
 *     + predloge povezav (deterministično: samo točna ujemanja so predlagana kot
 *     samodejna; ostala nosijo razlog za ročno odločitev) + PO kandidati z GRN
 *     referencami. Obseg: SAMO lastna lokacija/org (tuji dokumenti → 403/404).
 *
 * POST /api/ap/[id]/match  { action }:
 *   - 'link'           (inventory.manage): { lineLinks: [{ lineId, purchaseOrderItemId }] }
 *       ročna potrditev povezav vrstic (ali popravilo samodejne) + re-evalvacija;
 *   - 'evaluate'       (inventory.manage): ponovna evalvacija (po GRN/spremembi);
 *   - 'approve_exception' (settings.manage — plačilna varovalka, pooblaščena
 *     oseba): { reason } obvezna; iz matchStatus blocked/review_required →
 *     exception_approved + audit AP_EXCEPTION_APPROVED (kdo/kdaj/zakaj/vrednost
 *     razlike + NESPREMENLJIVE reference na AP/PO/GRN). Račun je s tem znova
 *     potrjevan/plačljiv prek obstoječega PATCH /api/expenses/[id].
 *
 * Tenantska izolacija: guardResource (lokacijski sloj fail-closed) + kandidati
 * PO omejeni na obseg uporabnika (locationScope) — tuje cene/številke se NE
 * razkrijejo. Audit chain ohranjen (writeAudit).
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const { id } = await params

  const ap = await db.accountsPayable.findUnique({
    where: { id },
    include: {
      Supplier: { select: { id: true, name: true } },
      AccountsPayableLine: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!ap) return fail('Obveznost ne obstaja.', 404)
  const guard = await guardResource(user, ap.locationId)
  if (guard) return guard

  // evalvacija (brez pisanja — trenutno stanje)
  const evaluation = await evaluateApMatch(ap.id)
  const scope = await locationScope(user)
  const candidates = await poCandidatesForSupplier(ap.supplierId, scope, ap.id)
  const proposals = proposeLinks(
    ap.AccountsPayableLine.map((l) => ({
      id: l.id,
      description: l.description,
      quantityInvoiced: Number(l.quantityInvoiced),
      vatRateInvoiced: l.vatRateInvoiced == null ? null : Number(l.vatRateInvoiced),
    })),
    candidates,
  )
  const proposalByLine = new Map(proposals.map((p) => [p.lineId, p]))

  // GRN reference: prevzemi PO-jev, ki so povezani prek vrstic
  const linkedPoIds = [...new Set(ap.AccountsPayableLine.map((l) => l.purchaseOrderItemId).filter((x): x is string => !!x))]
  let grns: { grnNumber: string; receivedAt: Date; supplierDocNumber: string; status: string }[] = []
  let linkedPos: { poNumber: string; status: string; grnCount: number }[] = []
  if (linkedPoIds.length > 0) {
    const poItems = await db.purchaseOrderItem.findMany({
      where: { id: { in: linkedPoIds } },
      select: { purchaseOrderId: true, PurchaseOrder: { select: { id: true, poNumber: true, status: true } } },
    })
    const poIdSet = [...new Set(poItems.map((i) => i.PurchaseOrder.id))]
    const poRows = await db.purchaseOrder.findMany({
      where: { id: { in: poIdSet } },
      select: { id: true, poNumber: true, status: true, GoodsReceipt: { select: { grnNumber: true, receivedAt: true, supplierDocNumber: true, status: true } } },
    })
    grns = poRows.flatMap((po) =>
      po.GoodsReceipt.map((g) => ({ grnNumber: g.grnNumber, receivedAt: g.receivedAt, supplierDocNumber: g.supplierDocNumber, status: g.status })),
    )
    linkedPos = poRows.map((po) => ({ poNumber: po.poNumber, status: po.status, grnCount: po.GoodsReceipt.length }))
  }

  return ok({
    ap: {
      id: ap.id,
      apNumber: ap.apNumber,
      invoiceNumber: ap.invoiceNumber,
      matchStatus: ap.matchStatus,
      status: ap.status,
      supplierId: ap.supplierId,
      supplierName: ap.Supplier?.name || null,
      purchaseOrderId: ap.purchaseOrderId,
      subtotal: Number(ap.subtotal),
      vatAmount: Number(ap.vatAmount),
      totalAmount: Number(ap.totalAmount),
      locationId: ap.locationId,
    },
    // tolerance ( trenutna politika — prikaz za racionalizacijo odstopanj)
    tolerance: evaluation?.tolerance ?? null,
    evaluation: evaluation ? evalSummary(evaluation) : null,
    lines: ap.AccountsPayableLine.map((l) => {
      const ev = evaluation?.lines.find((x) => x.lineId === l.id) ?? null
      const proposal = proposalByLine.get(l.id) ?? null
      return {
        id: l.id,
        description: l.description,
        quantityInvoiced: Number(l.quantityInvoiced),
        unitPriceInvoiced: Number(l.unitPriceInvoiced),
        vatRateInvoiced: l.vatRateInvoiced == null ? null : Number(l.vatRateInvoiced),
        lineTotal: Number(l.lineTotal),
        purchaseOrderItemId: l.purchaseOrderItemId,
        varianceStatus: ev?.varianceStatus ?? l.varianceStatus,
        varianceNote: ev?.varianceNote ?? l.varianceNote,
        detail: ev,
        proposal: proposal
          ? {
              confidence: proposal.confidence,
              score: proposal.score,
              reasons: proposal.reasons,
              suggestedPoItemId: proposal.best?.id ?? null,
              suggestedPoNumber: proposal.best?.poNumber ?? null,
              suggestedDescription: proposal.best?.description ?? null,
            }
          : null,
      }
    }),
    poCandidates: candidates.map((c) => ({
      id: c.id,
      poNumber: c.poNumber,
      description: c.description,
      unit: c.unit,
      vatRate: c.vatRate,
      quantityOrdered: c.quantityOrdered,
      quantityReceived: c.quantityReceived,
      quantityInvoicedCumulative: c.quantityInvoicedCumulative,
    })),
    linkedPurchaseOrders: linkedPos,
    grns,
  })
}

function evalSummary(e: ApMatchEval) {
  return {
    matchStatus: e.matchStatus,
    linesTotal: e.linesTotal,
    linesMatched: e.linesMatched,
    linesBlocked: e.linesBlocked,
    linesNotLinked: e.linesNotLinked,
    varianceCents: e.varianceCents,
    totalsOk: e.totalsOk,
    reasons: e.reasons,
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)
  const action = String(body.action || '').trim()
  if (!['link', 'evaluate', 'approve_exception'].includes(action)) {
    return fail('Neznano dejanje — dovoljeno: link, evaluate, approve_exception.', 400)
  }

  // povezava/evalvacija = nabavni tok (inventory.manage); odobritev izjeme =
  // plačilna varovalka pooblaščene osebe (settings.manage)
  const user = action === 'approve_exception'
    ? await requirePermission(req, 'settings.manage')
    : await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const ap = await db.accountsPayable.findUnique({
    where: { id },
    include: { AccountsPayableLine: { orderBy: { createdAt: 'asc' } } },
  })
  if (!ap) return fail('Obveznost ne obstaja.', 404)
  const guard = await guardResource(user, ap.locationId)
  if (guard) return guard
  if (ap.status === 'void') return fail('Preklicane obveznosti ni mogoče urejati.', 409)

  /* ── ročna potrditev povezav vrstic ── */
  if (action === 'link') {
    if (ap.matchStatus === 'grn_draft') {
      return fail('Osnutku iz prevzema se povezave določijo ob prevzemu — uvozite dejanski račun (eSLOG) za tristransko primerjavo.', 409)
    }
    const rawLinks = (Array.isArray(body.lineLinks) ? body.lineLinks : []) as { lineId?: unknown; purchaseOrderItemId?: unknown }[]
    if (rawLinks.length === 0) return fail('lineLinks so obvezni (lineId + purchaseOrderItemId).', 400)

    // validacija: vrstice so res tega AP; PO postavke so od DOBAVITELJA tega AP
    // (povezava na tujega dobavitelja nima pomena in odkriva tuje podatke)
    const lineIds = new Set(ap.AccountsPayableLine.map((l) => l.id))
    const poItemIds = [...new Set(rawLinks.map((l: Record<string, unknown>) => String(l?.purchaseOrderItemId || '')).filter(Boolean))]
    const poItems = poItemIds.length
      ? await db.purchaseOrderItem.findMany({
          where: { id: { in: poItemIds } },
          select: { id: true, purchaseOrderId: true, PurchaseOrder: { select: { supplierId: true, status: true } } },
        })
      : []
    const poItemById = new Map(poItems.map((i) => [i.id, i]))
    for (const l of rawLinks) {
      const lineId = String(l?.lineId || '')
      const poItemId = String(l?.purchaseOrderItemId || '')
      if (!lineId || !poItemId) return fail('Vsaka povezava potrebuje lineId in purchaseOrderItemId.', 400)
      if (!lineIds.has(lineId)) return fail('Vrstica ne pripada tej obveznosti.', 400)
      const item = poItemById.get(poItemId)
      if (!item) return fail('Nabavna postavka ne obstaja.', 404)
      if (item.PurchaseOrder.supplierId !== ap.supplierId) {
        return fail('Nabavna postavka pripada drugemu dobavitelju — povezava zavrnjena.', 409)
      }
    }
    // ena PO postavka na vrstico (isti AP ne sme dvakrat fakturirati isto postavko)
    const seenPoItems = new Set<string>()
    for (const l of rawLinks) {
      const poItemId = String(l?.purchaseOrderItemId || '')
      if (seenPoItems.has(poItemId)) return fail('Ista nabavna postavka je povezana dvakrat — dvakratno fakturiranje.', 409)
      seenPoItems.add(poItemId)
    }

    await db.$transaction(async (tx) => {
      for (const l of rawLinks) {
        await tx.accountsPayableLine.update({
          where: { id: String(l?.lineId || '') },
          data: { purchaseOrderItemId: String(l?.purchaseOrderItemId || '') },
        })
      }
      await writeAudit(tx, {
        userId: user.sub,
        action: 'AP_LINE_LINKED',
        entityType: 'AccountsPayable',
        entityId: id,
        locationId: ap.locationId ?? undefined,
        details: jstr({
          apNumber: ap.apNumber,
          mode: 'manual',
          links: rawLinks.map((l: Record<string, unknown>) => ({ lineId: String(l?.lineId || ''), purchaseOrderItemId: String(l?.purchaseOrderItemId || '') })),
        }),
      })
    })

    const evaluation = await applyApMatchEvaluation(id, { userId: user.sub, reason: 'manual_link' })
    return ok({ linked: rawLinks.length, evaluation: evaluation ? evalSummary(evaluation) : null })
  }

  /* ── ponovna evalvacija ── */
  if (action === 'evaluate') {
    if (!(REEVALUABLE_STATUSES as readonly string[]).includes(ap.matchStatus)) {
      return fail(`Evalvacija ni mogoča v stanju "${ap.matchStatus}" (osnutek/odobrena izjema se ne prepiše).`, 409)
    }
    const evaluation = await applyApMatchEvaluation(id, { userId: user.sub, reason: 'manual_evaluate' })
    if (!evaluation) return fail('Obveznost ni upravičena do evalvacije.', 409)
    return ok({ evaluation: evalSummary(evaluation) })
  }

  /* ── odobritev izjeme (plačilna varovalka) ── */
  const reason = String(body.reason || '').trim()
  if (reason.length < 10) return fail('Razlog odobritve je obvezen (vsaj 10 znakov).', 400)
  if (reason.length > 500) return fail('Razlog odobritve je predolg (max 500 znakov).', 400)
  if (ap.matchStatus !== 'blocked' && ap.matchStatus !== 'review_required') {
    return fail(`Odobritev izjeme je mogoča samo pri blokiranem/za pregled zahtevnem računu — to je v stanju "${ap.matchStatus}".`, 409)
  }

  // NESPREMENLJIVE reference: AP + vsi PO (prek vrstic) + vsi GRN teh PO-jev
  const evaluation = await evaluateApMatch(id)
  const linkedPoIds = [...new Set(ap.AccountsPayableLine.map((l) => l.purchaseOrderItemId).filter((x): x is string => !!x))]
  let poNumbers: string[] = []
  let grnNumbers: string[] = []
  if (linkedPoIds.length) {
    const poItems = await db.purchaseOrderItem.findMany({
      where: { id: { in: linkedPoIds } },
      select: { PurchaseOrder: { select: { id: true, poNumber: true, GoodsReceipt: { select: { grnNumber: true } } } } },
    })
    const poById = new Map(poItems.map((i) => [i.PurchaseOrder.id, i.PurchaseOrder]))
    poNumbers = [...poById.values()].map((p) => p.poNumber)
    grnNumbers = [...poById.values()].flatMap((p) => p.GoodsReceipt.map((g) => g.grnNumber))
  }

  const __aId = nid()
  const __details = jstr({
    apNumber: ap.apNumber,
    invoiceNumber: ap.invoiceNumber,
    purchaseOrderNumbers: poNumbers,
    grnNumbers,
    varianceCents: evaluation?.varianceCents ?? null,
    linesBlocked: evaluation?.linesBlocked ?? null,
    linesNotLinked: evaluation?.linesNotLinked ?? null,
    reasons: (evaluation?.reasons ?? []).slice(0, 20),
    reason,
    approvedBy: user.name || user.sub,
    approvedAt: new Date().toISOString(),
  })
  const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'AP_EXCEPTION_APPROVED',
    entityType: 'AccountsPayable',
    entityId: id,
    details: __details,
    locationId: ap.locationId,
  })
  await db.$transaction(async (tx) => {
    await tx.accountsPayable.update({ where: { id }, data: { matchStatus: 'exception_approved' } })
    await tx.auditLog.create({
      data: {
        ...__chain,
        id: __aId,
        userId: user.sub,
        action: 'AP_EXCEPTION_APPROVED',
        entityType: 'AccountsPayable',
        entityId: id,
        details: __details,
        locationId: ap.locationId,
      },
    })
  })

  return ok({
    approved: true,
    apNumber: ap.apNumber,
    matchStatus: 'exception_approved',
    references: { purchaseOrderNumbers: poNumbers, grnNumbers },
    varianceCents: evaluation?.varianceCents ?? null,
  })
}
