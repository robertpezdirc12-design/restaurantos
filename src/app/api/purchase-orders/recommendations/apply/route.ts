import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isCentralRole, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, num, r2, jstr } from '@/lib/map'
import { poNumberFor, computeTotalsCents, computeLineCents } from '@/lib/procurement'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #12 (P2) — POST /api/purchase-orders/recommendations/apply
 *
 * Pretvorba priporočil v OSNUTEK nabavnega naročila (človek potrduje —
 * issue: "preverljive predloge, ki jih človek potrdi"). Količine so v
 * PAKETIH dobavitelja: qty = packs × packQty; cena na enoto iz SupplierItem
 * (pricePerPack / packQty), DDV iz SupplierItem (privzeto 22 %), sicer
 * inventory costPerUnit fallback (isti resolver kot recurring-run).
 *
 * Telo: { supplierId, locationId?, expectedDate?, notes?,
 *         lines: [{ inventoryItemId, packs }] }   (packs = celo št. ≥ 1)
 *
 * Validacije (zrcalo POST /api/purchase-orders):
 *   - dobavitelj obstaja (404) · 1–100 vrstic · packs celo število ≥ 1 (400)
 *   - artikel obstaja (400) + pripada lokaciji naročila (403 tuja zaloga)
 *   - brez podvojenih artikelov (400)
 *   - lokacija iz obsega uporabnika (403 lokalna / assertOrgScope centralna,
 *     404 bogus) — issue #54 tenant varovalke
 *
 * Ustvari: status 'draft' (številčenje PO-YYYYMMDD-0001 z retry na unique),
 * aditivni SupplierItem backfill, audit PO_CREATE s source:'recommendation'.
 * Pravica: inventory.manage. Odgovor 201: { order } (ista oblika kot POST PO).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body) return fail('Manjkajo podatki.', 400)

  const supplierId = String(body.supplierId || '').trim()
  if (!supplierId) return fail('Dobavitelj je obvezen.', 400)
  const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) return fail('Dobavitelj ne obstaja.', 404)

  const rawLines = Array.isArray(body.lines) ? body.lines : []
  if (rawLines.length === 0) return fail('Naročilo potrebuje vsaj eno vrstico.', 400)
  if (rawLines.length > 100) return fail('Naročilo ima lahko največ 100 vrstic.', 400)

  // lokacija naročila IZHAJA iz obsega uporabnika (issue #54, kot POST PO)
  const bodyLoc = typeof body?.locationId === 'string' && body.locationId.trim() ? body.locationId.trim() : null
  if (bodyLoc && !isCentralRole(user) && bodyLoc !== user.loc) {
    return fail('Lokacija naročila ne sme odstopati od lokacije uporabnika.', 403)
  }
  const locRes = requireUserLocation(user, bodyLoc ?? undefined)
  if (isResponse(locRes)) return locRes
  const locationId = locRes
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard
  const locRow = await db.location.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!locRow) return fail('Lokacija ne obstaja.', 404)

  const expectedDate = body?.expectedDate ? new Date(String(body.expectedDate)) : null
  if (expectedDate && isNaN(expectedDate.getTime())) return fail('Neveljaven pričakovani datum.', 400)

  const seenItem = new Set<string>()
  const lines: {
    id: string
    description: string
    inventoryItemId: string | null
    quantityOrdered: number
    unit: string
    unitPrice: number
    vatRate: number
    totalPrice: number
    status: string
    packQty: number | null
    packUnit: string | null
  }[] = []
  for (const [idx, l] of rawLines.entries()) {
    const inventoryItemId = l?.inventoryItemId ? String(l.inventoryItemId) : ''
    if (!inventoryItemId) return fail(`Vrstica ${idx + 1}: artikel je obvezen (priporočila delujejo na inventarnih artiklih).`, 400)

    const packs = num(l?.packs)
    if (!Number.isInteger(packs) || packs < 1) return fail(`Vrstica ${idx + 1}: število paketov mora biti celo število, najmanj 1.`, 400)
    if (seenItem.has(inventoryItemId)) return fail(`Vrstica ${idx + 1}: artikel je naveden večkrat — združi količine.`, 400)
    seenItem.add(inventoryItemId)

    // referenčna integriteta + obseg lokacije (kot POST PO — tuja zaloga → 403)
    const inv = await db.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: { id: true, name: true, unit: true, locationId: true, costPerUnit: true },
    })
    if (!inv) return fail(`Vrstica ${idx + 1}: inventarni artikel ne obstaja.`, 400)
    if (inv.locationId && inv.locationId !== locationId) {
      return fail(`Vrstica ${idx + 1}: inventarni artikel pripada drugi lokaciji — naročilo ne sme referencirati tuje zaloge.`, 403)
    }

    // cenovni resolver: SupplierItem (pricePerPack/packQty, DDV), sicer
    // inventory costPerUnit + paket 1 (isti fallback kot recurring-run)
    const si = await db.supplierItem.findUnique({
      where: { supplierId_inventoryItemId: { supplierId, inventoryItemId } },
      select: { pricePerPack: true, packQty: true, packUnit: true, vatRate: true },
    })
    const packQty = si && num(si.packQty) > 0 ? num(si.packQty) : 1
    let unitPrice = num(inv.costPerUnit)
    if (si) {
      const perPack = num(si.pricePerPack)
      if (perPack > 0 && packQty > 0) unitPrice = perPack / packQty
    }
    const vatRate = si?.vatRate != null ? num(si.vatRate) : 22
    if (!(vatRate >= 0 && vatRate <= 30)) return fail(`Vrstica ${idx + 1}: DDV stopnja mora biti med 0 in 30 %.`, 400)

    const quantity = packs * packQty
    const t = computeLineCents({ quantity, unitPriceCents: Math.round(unitPrice * 100), vatRate })
    lines.push({
      id: nid(),
      description: inv.name,
      inventoryItemId,
      quantityOrdered: quantity,
      unit: inv.unit || 'pcs',
      unitPrice,
      vatRate: r2(vatRate),
      totalPrice: t.totalCents / 100,
      status: 'pending',
      packQty,
      packUnit: si?.packUnit ?? null,
    })
  }

  const totals = computeTotalsCents(lines.map((l) => ({ quantity: l.quantityOrdered, unitPriceCents: Math.round(l.unitPrice * 100), vatRate: l.vatRate })))

  // številčenje: zaporedje znotraj dneva + retry na unique (kot POST PO)
  let po: Awaited<ReturnType<typeof createRecommendedPo>> | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = (await db.purchaseOrder.count({ where: { poNumber: { startsWith: poNumberFor(new Date(), 1).slice(0, 13) } } })) + 1
    try {
      po = await createRecommendedPo({ supplierId, expectedDate, totals, locationId, notes: String(body?.notes || ''), user, lines, seq })
      break
    } catch (e) {
      const msg = String((e as Error).message || '')
      if (msg.includes('poNumber') && attempt < 4) continue // sočasno številčenje — poskusi znova
      throw e
    }
  }
  if (!po) return fail('Ustvarjanje naročila ni uspelo (številčenje).', 500)

  await writeAudit(db, {
    userId: user.sub,
    action: 'PO_CREATE',
    entityType: 'PurchaseOrder',
    entityId: po.id,
    locationId,
    details: jstr({
      source: 'recommendation',
      poNumber: po.poNumber,
      supplierId,
      supplierName: supplier.name,
      lines: lines.length,
      packs: lines.length,
      subtotalCents: totals.subtotalCents,
      vatCents: totals.vatCents,
      totalCents: totals.totalCents,
      locationId,
    }),
  })

  return ok(
    {
      order: {
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        supplierName: po.Supplier?.name || '',
        subtotal: Number(po.subtotal),
        vatAmount: Number(po.vatAmount),
        totalAmount: Number(po.totalAmount),
        items: po.PurchaseOrderItem.map((i) => ({
          id: i.id,
          description: i.description,
          quantityOrdered: Number(i.quantityOrdered),
          quantityReceived: Number(i.quantityReceived),
          unit: i.unit,
          unitPrice: Number(i.unitPrice),
          vatRate: Number(i.vatRate),
          totalPrice: Number(i.totalPrice),
          status: i.status,
          inventoryItemId: i.inventoryItemId,
          packQty: i.packQty == null ? null : Number(i.packQty),
          packUnit: i.packUnit,
        })),
      },
    },
    201,
  )
}

async function createRecommendedPo(args: {
  supplierId: string
  expectedDate: Date | null
  totals: { subtotalCents: number; vatCents: number; totalCents: number }
  locationId: string | null
  notes: string
  user: { sub: string; name?: string }
  lines: {
    description: string
    inventoryItemId: string | null
    quantityOrdered: number
    unit: string
    unitPrice: number
    vatRate: number
    totalPrice: number
    packQty: number | null
    packUnit: string | null
  }[]
  seq: number
}) {
  const { supplierId, expectedDate, totals, locationId, notes, user, lines, seq } = args
  return db.$transaction(async (tx) => {
    const created = await tx.purchaseOrder.create({
      data: {
        id: nid(),
        poNumber: poNumberFor(new Date(), seq),
        supplierId,
        status: 'draft',
        expectedDate,
        subtotal: totals.subtotalCents / 100,
        vatAmount: totals.vatCents / 100,
        totalAmount: totals.totalCents / 100,
        notes,
        locationId,
        requestedBy: user.name || '',
        requestedById: user.sub || null,
        PurchaseOrderItem: {
          create: lines.map((l) => ({ ...l, id: nid() })),
        },
      },
      include: { PurchaseOrderItem: true, Supplier: { select: { name: true } } },
    })

    // katalog dobavitelja (SupplierItem) — aditivno: dodaj samo, če vez še ne
    // obstaja (pricePerPack = cena NA PAKET; packQty iz vrstice)
    for (const l of lines) {
      if (!l.inventoryItemId) continue
      const existing = await tx.supplierItem.findUnique({
        where: { supplierId_inventoryItemId: { supplierId, inventoryItemId: l.inventoryItemId } },
      })
      if (!existing) {
        await tx.supplierItem.create({
          data: {
            id: nid(), supplierId, inventoryItemId: l.inventoryItemId,
            pricePerPack: Math.round(l.unitPrice * (l.packQty ?? 1) * 10000) / 10000,
            packQty: l.packQty ?? 1, packUnit: l.packUnit ?? 'paket', vatRate: l.vatRate,
          },
        })
      }
    }
    return created
  })
}
