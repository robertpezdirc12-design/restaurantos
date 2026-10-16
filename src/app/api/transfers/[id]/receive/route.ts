import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr, r2 } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { pushEvent } from '@/lib/push'
import { writeAudit } from '@/lib/audit-chain'
import { weightedAvgCostCents } from '@/lib/procurement'
import { transferTablesReady } from '@/lib/transfer-schema'
import { TransferError, TRF_TX_IN, computeReceiveOutcome, transferDto, transferLineDto, r3, type TrfRow } from '@/lib/stock-transfer'

/**
 * Issue #8 (P2, v1.116.0) — PREVZEM medlokacijskega prenosa.
 *
 * POST /api/transfers/[id]/receive
 *   { note?, lines: [{ transferItemId, receivedQty, damagedQty?, note? }] }
 *
 *   EN sam FINALNI dogodek na prenos (ni večkratnega prevzemanja):
 *   vsaka postavka MORA imeti natanko en vnos (manjkajoč/podvojen → 400).
 *   Prejeto + poškodovano ≤ odpremljeno (sicer 400); razlika = MANJKANJE,
 *   ki se zapiše (varianca) in NE knjiži na zalogo.
 *
 *   V transakciji:
 *     1. ANCHOR na vrstici CILJNE lokacije (vzorec #63);
 *     2. CAS prevzem: updateMany where status DISPATCHED zapiše receivedAt/
 *        receivedById — sočasen dvojni prevzem → 409 'Prenos je medtem že
 *        prevzet.' (BREZ knjiženja); KONČNI status se določi ŠELE na koncu
 *        TX (RECEIVED | PARTIAL iz computeReceiveOutcome);
 *     3. per vrstica: razreši CILJNI artikel po imenu na ciljni lokaciji
 *        (exact findFirst + fallback manuelno case-insensitive primerjavo —
 *        Prisma mode:'insensitive' NI podprt na SQLite), sicer ga USTVARI
 *        (posnetek imena/enote/kategorije/dobavitelja iz vira);
 *     4. priliv: increment good (prejeto nepoškodovano) + utežena povprečna
 *        cena (weightedAvgCostCents — GRN precedens) + lastRestocked;
 *     5. serija NA CILJU (lot `TRF-…-n`, dobavitelj izvora, rok, cena) —
 *        SAMO za dobro količino (poškodovana serija se NE ustvari — vrednostna
 *        celovitost);
 *     6. StockTransaction TRF_TX_IN (POZITIVEN) — ledger ≡ DB (fresh branj);
 *     7. audit TRANSFER_RECEIVED (števci + varianca).
 *
 *   Po TX (fail-soft): publishEvent StockChanged na CILJNI lokaciji + push
 *   TRANSFER_RECEIVED vodstvu/skladišču IZVORNE lokacije.
 *
 * Pravica: inventory.manage + guardResource(to). PRE-DDL: 503 (graceful).
 */

const RECEIVE_NOTE_MAX = 500

/** sočasen prevzem (CAS izgubil) — 409, brez dvojnega knjiženja */
class ConcurrentReceiveError extends Error {
  constructor() {
    super('Prenos je medtem že prevzet.')
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  if (!(await transferTablesReady())) {
    return fail('Prenosi čakajo na shemsko migracijo (Enterprise → Shema migracije → stock-transfers).', 503)
  }
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, RECEIVE_NOTE_MAX) : ''
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return fail('Prevzem potrebuje vsaj eno postavko.', 400)
  }

  const transfer = await db.stockTransfer.findUnique({
    where: { id },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  })
  if (!transfer) return fail('Prenos ne obstaja.', 404)

  // prevzema SAMO ciljna lokacija (odpošiljatelj ne more dvigniti zaloge
  // prejemniku — enosmerna odgovornost prejema)
  const guarded = await guardResource(user, transfer.toLocationId)
  if (guarded) return guarded

  if (transfer.status === 'DRAFT') return fail('Prenos še ni odpremljen.', 409)
  if (transfer.status === 'RECEIVED' || transfer.status === 'PARTIAL') return fail('Prenos je že prevzet.', 409)
  if (transfer.status !== 'DISPATCHED') return fail('Prenos ni odpremljen.', 409)

  // ── validacija vnosov prevzema: natanko EN vnos na vsako postavko ──
  const lineById = new Map(transfer.items.map((l) => [l.id, l]))
  const receivedBy = new Map<string, { receivedQty: number; damagedQty: number; note: string }>()
  for (const raw of body.lines) {
    if (!raw || typeof raw !== 'object') return fail('Neveljavna postavka prevzema.', 400)
    const l = raw as Record<string, unknown>
    const transferItemId = typeof l.transferItemId === 'string' ? l.transferItemId.trim() : ''
    if (!transferItemId || !lineById.has(transferItemId)) {
      return fail('Neznana postavka prevzema.', 400)
    }
    if (receivedBy.has(transferItemId)) {
      return fail(`Podvojen prevzem postavke "${lineById.get(transferItemId)!.itemName}".`, 400)
    }

    const receivedQty = num(l.receivedQty, NaN)
    if (!Number.isFinite(receivedQty) || receivedQty < 0) {
      return fail('Prejeta količina ne sme biti negativna.', 400)
    }
    if (r3(receivedQty) !== receivedQty) return fail('Prejeta količina lahko ima največ 3 decimalke.', 400)
    const damagedQty = l.damagedQty === undefined || l.damagedQty === null ? 0 : num(l.damagedQty, NaN)
    if (!Number.isFinite(damagedQty) || damagedQty < 0) {
      return fail('Poškodovana količina ne sme biti negativna.', 400)
    }
    if (r3(damagedQty) !== damagedQty) return fail('Poškodovana količina lahko ima največ 3 decimalke.', 400)

    const line = lineById.get(transferItemId)!
    const dispatched = r3(num(line.dispatchedQty))
    if (r3(receivedQty + damagedQty) > dispatched + 0.0005) {
      return fail(`Prejeto + poškodovano presega odpremljeno za "${line.itemName}".`, 400)
    }
    receivedBy.set(transferItemId, {
      receivedQty: r3(receivedQty),
      damagedQty: r3(damagedQty),
      note: typeof l.note === 'string' ? l.note.trim().slice(0, RECEIVE_NOTE_MAX) : '',
    })
  }
  for (const line of transfer.items) {
    if (!receivedBy.has(line.id)) {
      return fail(`Manjka prevzem za postavko "${line.itemName}".`, 400)
    }
  }

  const now = new Date()
  let totalReceived = 0
  let totalDamaged = 0
  let totalMissing = 0

  try {
    const updated = await db.$transaction(async (tx) => {
      // 1. ANCHOR na vrstici CILJNE lokacije (#63) — serializira sočasne
      //    prevzeme/prijeme za isto lokacijo
      const anchor = await tx.location.updateMany({ where: { id: transfer.toLocationId }, data: { updatedAt: now } })
      if (anchor.count === 0) throw new TransferError('Ciljna lokacija ne obstaja.', 404)

      // 2. CAS prevzem (zahteva status DISPATCHED): sočasni dvojni klik izgubi
      //    (409 rollback) — končni status RECEIVED/PARTIAL se zapiše na koncu
      const claim = await tx.stockTransfer.updateMany({
        where: { id: transfer.id, status: 'DISPATCHED' },
        data: { receivedAt: now, receivedById: user.sub },
      })
      if (claim.count === 0) throw new ConcurrentReceiveError()

      // kandidati ciljne lokacije za razreševanje artikelov po imenu
      // (lazy — samo, če natančno ujemanje ne zadene; primerjamo case-insensitive
      // ročno, ker Prisma mode:'insensitive' ni podprt na SQLite)
      let targetCandidates: { id: string; name: string }[] | null = null

      for (const [index, line] of transfer.items.entries()) {
        const entry = receivedBy.get(line.id)!
        const good = entry.receivedQty
        const damaged = entry.damagedQty
        const dispatched = r3(num(line.dispatchedQty))
        totalReceived = r3(totalReceived + good)
        totalDamaged = r3(totalDamaged + damaged)
        totalMissing = r3(totalMissing + Math.max(0, dispatched - good - damaged))

        // 3. razreši ciljni artikel po imenu (snapshot ime iz postavke)
        let target = await tx.inventoryItem.findFirst({
          where: { locationId: transfer.toLocationId, name: line.itemName },
          select: { id: true, name: true, unit: true, quantity: true, costPerUnit: true },
        })
        if (!target && targetCandidates === null) {
          const rows = await tx.inventoryItem.findMany({
            where: { locationId: transfer.toLocationId },
            select: { id: true, name: true },
            take: 2000,
            orderBy: { name: 'asc' },
          })
          targetCandidates = rows
        }
        if (!target && targetCandidates) {
          const lower = line.itemName.toLowerCase()
          const hit = targetCandidates.find((c) => c.name.toLowerCase() === lower)
          if (hit) {
            target = await tx.inventoryItem.findUnique({
              where: { id: hit.id },
              select: { id: true, name: true, unit: true, quantity: true, costPerUnit: true },
            })
          }
        }

        // vir kategorije/dobavitelja za NOV artikel (posnetek — vir je lahko pobrisan)
        const sourceItem = line.inventoryItemId
          ? await tx.inventoryItem.findUnique({
              where: { id: line.inventoryItemId },
              select: { category: true, supplier: true },
            })
          : null

        if (!target) {
          // USTVARI ciljni artikel (zrcalo POST /api/inventory oblike) —
          // količina 0, priliv se knjiži spodaj v istem koraku
          const created = await tx.inventoryItem.create({
            data: {
              id: nid(),
              name: line.itemName,
              unit: line.unit || 'pcs',
              quantity: 0,
              minQuantity: 0,
              costPerUnit: line.unitCost != null ? r2(num(line.unitCost)) : 0,
              supplier: sourceItem?.supplier || '',
              category: sourceItem?.category || 'general',
              locationId: transfer.toLocationId,
            },
            select: { id: true, name: true, unit: true, quantity: true, costPerUnit: true },
          })
          target = created
        }

        // enota obstoječega ciljnega artikla se NE spremeni (dokumentirana
        // odločitev: enota je last lokacije; razlika je vidna v postavki prenosa)

        // 4. priliv + utežena povprečna cena (GRN precedens) — samo DOBRO
        const unitCost = line.unitCost != null ? r2(num(line.unitCost)) : null
        let newQty = r3(num(target.quantity))
        let prevQty = newQty
        if (good > 0) {
          const oldCostCents = Math.round(num(target.costPerUnit) * 100)
          const addCostCents = unitCost != null ? Math.round(unitCost * 100) : 0
          const newCostCents = weightedAvgCostCents(prevQty, oldCostCents, good, addCostCents)
          await tx.inventoryItem.update({
            where: { id: target.id },
            data: {
              quantity: { increment: good },
              ...(unitCost != null ? { costPerUnit: newCostCents / 100, lastRestocked: now } : { lastRestocked: now }),
            },
          })
          // fresh post-increment (ledger ≡ DB — increment nima CAS tveganja)
          const fresh = await tx.inventoryItem.findUnique({ where: { id: target.id }, select: { quantity: true } })
          newQty = r3(num(fresh?.quantity))
        }

        // 5. serija NA CILJU — lot TRF-<številka>-<vrstica>, dobavitelj izvora;
        // SAMO za dobro količino (poškodovana serija pomeni vrednostno izgubo)
        if (good > 0 && (line.expiryDate != null || line.lotNumber != null || unitCost != null)) {
          const sourceBatch = line.batchId
            ? await tx.inventoryBatch.findUnique({ where: { id: line.batchId }, select: { supplierId: true, supplierName: true } })
            : null
          await tx.inventoryBatch.create({
            data: {
              id: nid(),
              inventoryItemId: target.id,
              locationId: transfer.toLocationId,
              lotNumber: `${transfer.transferNumber}-${index + 1}`,
              supplierId: sourceBatch?.supplierId ?? null,
              supplierName: sourceBatch?.supplierName ?? '',
              receivedAt: now,
              expiryDate: line.expiryDate ?? null,
              quantityInitial: good,
              quantityRemaining: good,
              unit: target.unit || line.unit || '',
              unitCost: unitCost != null ? unitCost : null,
              status: 'ACTIVE',
            },
          })
        }

        // 6. StockTransaction TRF_TX_IN (POZITIVEN — priliv ciljne lokacije)
        if (good > 0) {
          await tx.stockTransaction.create({
            data: {
              id: nid(),
              inventoryItemId: target.id,
              type: TRF_TX_IN,
              quantity: good,
              previousQty: prevQty,
              newQty,
              costPerUnit: unitCost != null ? unitCost : r2(num(target.costPerUnit)),
              totalCost: r2((unitCost != null ? unitCost : r2(num(target.costPerUnit))) * good),
              reason: `Prejem prenosa ${transfer.transferNumber}`,
              note: [line.itemName, entry.note, note].filter(Boolean).join(' · ') || line.itemName,
              supplierDoc: transfer.transferNumber,
              employeeId: user.sub,
              employeeName: user.name,
            },
          })
        }

        // 7. postavka: prejeto/poškodovano + razrešen ciljni artikel + opomba
        const noteParts = [line.note, entry.note, note].filter(Boolean)
        await tx.stockTransferItem.update({
          where: { id: line.id },
          data: {
            receivedQty: good,
            damagedQty: damaged,
            targetItemId: target.id,
            ...(noteParts.length ? { note: noteParts.join(' · ').slice(0, 500) } : {}),
          },
        })
      }

      // končni status: RECEIVED iff vse prejeto + 0 poškodovano (EPS), sicer PARTIAL
      const outcome = computeReceiveOutcome(
        transfer.items.map((l) => {
          const entry = receivedBy.get(l.id)!
          return { dispatchedQty: r3(num(l.dispatchedQty)), receivedQty: entry.receivedQty, damagedQty: entry.damagedQty }
        }),
      )
      await tx.stockTransfer.updateMany({
        where: { id: transfer.id },
        data: { status: outcome.status },
      })

      // audit (števci + varianca — brez vrstic/PII)
      await writeAudit(tx, {
        userId: user.sub,
        action: 'TRANSFER_RECEIVED',
        entityType: 'StockTransfer',
        entityId: transfer.id,
        details: jstr({
          transferNumber: transfer.transferNumber,
          status: outcome.status,
          lines: transfer.items.length,
          totalReceived,
          totalDamaged,
          totalMissing,
          acknowledged: note !== '',
        }),
        locationId: transfer.toLocationId,
      })

      return tx.stockTransfer.findUnique({
        where: { id: transfer.id },
        include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
      })
    })

    if (!updated) return fail('Prenos ne obstaja.', 404)

    // fail-soft dogodki (NE podrejo prevzema)
    await publishEvent('StockChanged', {
      entityType: 'StockTransfer',
      entityId: transfer.id,
      payload: {
        transferNumber: transfer.transferNumber,
        toLocationId: transfer.toLocationId,
        totalReceived,
        by: user.name,
        cause: 'transfer_receive',
        locationId: transfer.toLocationId,
      },
      locationId: transfer.toLocationId,
    }).catch(() => undefined)

    // push: vodstvo/skladišče IZVORNE lokacije (odpošiljatelj ve, da je konec)
    void pushEvent(
      'TRANSFER_RECEIVED',
      {
        title: 'Prenos prevzet',
        body: `${transfer.transferNumber} · ${transfer.items.length} postavk`,
        url: '/dashboard?tab=prenosi',
        tag: `transfer-received-${transfer.id}`,
      },
      { roles: ['manager', 'warehouse'], locationId: transfer.fromLocationId },
    )

    // DTO z vrsticami + variance (terminalno stanje)
    const dto = transferDto(updated as TrfRow)
    const lines = updated.items.map((l) => transferLineDto(l))
    const outcome = computeReceiveOutcome(
      lines.map((l) => ({ dispatchedQty: l.dispatchedQty, receivedQty: l.receivedQty, damagedQty: l.damagedQty })),
    )
    return ok({
      transfer: {
        ...dto,
        lines,
        variance: { missingQty: outcome.totalMissing, damagedQty: outcome.totalDamaged },
      },
    })
  } catch (e) {
    if (e instanceof ConcurrentReceiveError) return fail(e.message, 409)
    if (e instanceof TransferError) return fail(e.message, e.status)
    throw e
  }
}
