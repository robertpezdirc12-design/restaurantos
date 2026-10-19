import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, r2, jparse, jstr, mapReceipt } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { OrderError } from '@/lib/ops'
import { fiscalAdapterFor } from '@/lib/fiscal'
import { fiscalCerts, stampFiscalCodes, submitFiscalDocument } from '@/lib/furs/submit'
import { writeAudit } from '@/lib/audit-chain'
import { resolveFiscalProfile, FiscalConfigError, type FiscalProfile } from '@/lib/fiscal-profile'
import { allocateReceiptNumber } from '@/lib/furs/receipt-number'
import { exceptionPolicy, amountAboveThreshold } from '@/lib/exception-policy'
import {
  validateExceptionReason,
  resolveExceptionApproval,
  reasonAuditFields,
  approvalAuditFields,
  type ReasonEvidence,
  type ApprovalEvidence,
} from '@/lib/exception-approval'

/**
 * Fiskalni storno (umnik/povračilo) računa — P1 točka 1 iz docs/RESTAURANTOS-AUDIT.md.
 *
 * Ustvari STORNO račun z negativnimi zneski (exactna negacija originala), nastavi
 * naročilo na paymentStatus='storno', povrne razknjiženo zalogo (StockTransaction
 * type='STORNO_RETURN' + povračilo serij po StockBatchAllocation) in zapiše revizijo
 * RECEIPT_STORNO — VSE v ENI transakciji (isti vzorec kot /api/furs POST).
 *
 * Pravila (fail-closed):
 *  - 404: originalni račun ne obstaja / pripadajoče naročilo ne obstaja.
 *  - 403: tuja lokacija (guardResource — lokacijska + org meja; centralne vloge prej bypass).
 *  - 409: storno računa (isStorno=true) — storna ni mogoče še enkrat stornirati.
 *  - 409: kopija računa (isCopy=true) — storno je mogoč SAMO za originalni račun
 *         (kopija je reprint brez lastnega življenja; storno kopije bi podvojil umik).
 *  - 409: naročilo ni 'paid' — samo plačana naročila se stornirajo (R10 vzorec).
 *  - 409: dvojni storno — preverba znotraj transakcije (race varna) + fail-fast zunaj.
 *
 * Issue #19 (v1.107.0): fiskalni storno je finančna izjema → obvezen RAZLOG
 * (politika excRequireReasonStorno, privzeto TRUE; katalog VoidReason
 * kind=storno|any ALI prosto besedilo 3–200 — posnetek v auditu) + prag
 * ODOBREDITVE (excStornoApprovalAmountCents, privzeto 0 = izklopljen —
 * dovoljenje furs.issue je že vodstveno; vodstvena izvajalska vloga šteje kot
 * odobritev 'role', NE-vodstveni izvajalec pa potrebuje poverilnico DRUGE
 * pooblaščene osebe). PIN odobritelja se NIKOLI ne zapiše v audit.
 *
 * Fiskalna polja: replikacija vedenja /api/furs POST (simulacija → ZOI/EOR + 'verified',
 * produkcija brez certifikata → prazne kode + 'pending') — NIč ne izmišljujemo.
 * Številčenje: isti Counter (`receipt:<locationId>`) in isti format št. računa.
 */

/** Tip transakcije povračila zaloge ob stornu (pozitivna količina — vračilo na zalogo). */
const STORNO_RETURN_TX_TYPE = 'STORNO_RETURN'

const r3 = (n: number) => Math.round(n * 1000) / 1000

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'receipts.storno')
  if (isResponse(user)) return user
  const { id } = await ctx.params
  // #19: telo nosi razlog storna (+ morebitno poverilnico odobritelja)
  const body = await req.json().catch(() => null)

  // ── Predhodne preverbe (definitivni odgovori, ne transakcijski) ──
  const original = await db.receipt.findUnique({ where: { id } })
  if (!original) return fail('Račun ne obstaja.', 404)

  // Issue #4 §1 vzorec: storno tujega računa (druga lokacija) je ZAVRJENO
  const locGuard = await guardResource(user, original.locationId)
  if (locGuard) return locGuard

  if (original.isStorno) {
    return fail('Računa, ki je že storno, ni mogoče še enkrat stornirati.', 409)
  }
  if (original.isCopy) {
    return fail('Kopije računa ni mogoče stornirati — storno je mogoč samo za originalni račun.', 409)
  }

  // Fail-fast preverba dvojnega storna (race-varena preverba je še znotraj transakcije)
  const existingStorno = await db.receipt.findFirst({
    where: { stornoOf: original.id },
    select: { receiptNumber: true },
  })
  if (existingStorno) {
    return fail(`Račun je že storniran (storno račun ${existingStorno.receiptNumber}).`, 409)
  }

  const order = await db.order.findUnique({ where: { id: original.orderId } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  if (order.paymentStatus !== 'paid') {
    return fail('Storno je mogoč samo za plačano naročilo.', 409)
  }

  const location = await db.location.findUnique({ where: { id: original.locationId } })
  if (!location) return fail('Lokacija ne obstaja.', 400)

  // ── Issue #19: razlog + odobritev (ZA preverbami stanja, PRED transakcijo) ──
  const excPolicy = await exceptionPolicy()
  let stornoReason: ReasonEvidence | null = null
  if (excPolicy.requireReasonStorno) {
    const rr = await validateExceptionReason('storno', original.locationId, body)
    if (!rr.ok) return fail(rr.message, rr.status)
    stornoReason = rr.reason
  }
  const stornoAmount = Math.abs(num(original.total))
  let stornoApproval: ApprovalEvidence | null = null
  let stornoApprovalBasis: string | null = null
  if (amountAboveThreshold(stornoAmount, excPolicy.stornoApprovalAmountCents)) {
    stornoApprovalBasis = `amount ${stornoAmount.toFixed(2)} > ${(excPolicy.stornoApprovalAmountCents / 100).toFixed(2)}`
    const aa = await resolveExceptionApproval(user, original.locationId, body)
    if (!aa.ok) return fail(aa.message, aa.status)
    stornoApproval = aa.approval
  }

  // Isti fiskalni režim kot /api/furs POST (simulacija / produkcija pending do certifikata)
  // Issue #53 (P0/P1): profil je zdaj STREŽNIŠKI in fail-closed (src/lib/fiscal-profile.ts)
  // — produkcija brez izrecnega okolja oz. s simulacijo → 503 PRED kakršnimkoli zapisom
  // (storno = fiskalna izdaja nad plačanim računom; enaka vrzel kot /api/furs POST).
  let profile: FiscalProfile
  try {
    profile = resolveFiscalProfile({
      globalEnv: process.env.FURS_ENVIRONMENT,
      locationEnv: location.fursEnvironment,
      allowSimulation: process.env.FURS_ALLOW_SIMULATION,
      productionTestMode: process.env.FURS_PRODUCTION_TEST_MODE,
      nodeEnv: process.env.NODE_ENV,
    })
  } catch (e) {
    if (e instanceof FiscalConfigError) return fail(e.message, e.status)
    throw e
  }
  const simulation = profile.simulation
  // audit #3 (v1.144.0): certifikata se razrešita IZVEN transakcije (dekripcija
  // PKCS#12 sodi pred tx) — ista pot kot pri izdaji (src/lib/furs/issue.ts).
  const certs = fiscalCerts(simulation, location.country)

  // ── Negacija originalnih zneskov (storno TOČNO uniči original — brez preračuna) ──
  const subtotal = r2(-num(original.subtotal))
  const totalVat = r2(-num(original.totalVat))
  const discount = r2(-num(original.discount))
  const total = r2(-num(original.total))
  const tip = r2(-num(original.tip))
  const totalWithTip = r2(-num(original.totalWithTip))
  const vatMapOrig = jparse<Record<string, { base?: unknown; vat?: unknown }>>(original.vatBreakdown, {})
  const vatMap: Record<string, { base: number; vat: number }> = {}
  for (const [rate, v] of Object.entries(vatMapOrig)) {
    if (!v || typeof v !== 'object') continue
    vatMap[rate] = { base: r2(-num(v.base)), vat: r2(-num(v.vat)) }
  }

  const now = new Date()

  try {
    const result = await db.$transaction(async (tx) => {
      // ── CAS zaščita (R10 vzorec): naročilo spremenimo SAMO če je še 'paid' —
      // sočasni/dvojni storno izgubi dirko (račun prejšnjega klicalca že obstaja) ──
      const cas = await tx.order.updateMany({
        where: { id: order.id, paymentStatus: 'paid' },
        data: { paymentStatus: 'storno' },
      })
      if (cas.count === 0) {
        const twin = await tx.receipt.findFirst({
          where: { stornoOf: original.id },
          select: { receiptNumber: true },
        })
        throw new OrderError(
          twin
            ? `Račun je že storniran (storno račun ${twin.receiptNumber}).`
            : 'Naročilo ni več v stanju "paid" — storno ni mogoč.',
          409,
        )
      }
      // Race varna preverba dvojnega storna (znotraj transakcije — zahteva naloge)
      const dup = await tx.receipt.findFirst({ where: { stornoOf: original.id }, select: { id: true } })
      if (dup) throw new OrderError('Račun je že storniran.', 409)

      // ── Številčenje: ISTA pot kot /api/furs (audit #14, v1.146.0: skupni
      // allocateReceiptNumber — Counter + preizkus zasedenosti, da reža v
      // obstoječih številkah ne more dvigniti P2002 in rewindati storna) ──
      const { seq, receiptNumber } = await allocateReceiptNumber(tx, location, now)

      // ── Fiskalne kode: ISTA pot kot /api/furs (audit #3, v1.144.0) ──
      // Pred tem je ruta klicala samo `fiscal.computeCodes`, ki v PRODUKCIJI vrne
      // prazne kode (certifikat obdela podpisna pot v submit.ts) → storno je dobil
      // `zoi:''` in ga zato ni bilo mogoče oddati NIKOLI VEČ (naknadna oddaja
      // računa brez zaščitne kode je zavrnjena).
      const fiscal = fiscalAdapterFor(location.country)
      const isHrFiscal = fiscal.country === 'HR'
      const stamp = stampFiscalCodes(
        { location, receiptNumber, sequence: seq, total, issuedAt: now, simulation },
        certs,
      )
      const zoi = stamp.zoi
      const eor = stamp.eor

      const created = await tx.receipt.create({
        data: {
          id: nid(),
          receiptNumber,
          orderId: original.orderId,
          // poslovni podatki se KOPIRAJO iz originala (storno velja za ISTI dokument)
          businessName: original.businessName,
          businessAddress: original.businessAddress,
          businessId: original.businessId,
          taxId: original.taxId,
          registerId: original.registerId,
          zoi,
          eor,
          fiscalVerified: simulation,
          fiscalStatus: simulation ? 'verified' : 'pending',
          verificationDate: simulation ? now : null,
          subtotal,
          vatBreakdown: jstr(vatMap),
          totalVat,
          discount,
          total,
          tip,
          totalWithTip,
          paymentMethod: original.paymentMethod,
          isStorno: true,
          stornoOf: original.id,
          printedAt: now,
          locationId: original.locationId,
          cisStatus: isHrFiscal ? (simulation ? 'verified' : 'pending') : 'none',
          cisZki: stamp.cisZki,
          cisJir: stamp.cisJir,
        },
      })

      // ── Povračilo zaloge: vsi SALE odjemi tega naročila se vrnejo (ista transakcija
      // kot račun — če storno pade, se zaloga ne spremeni). Vzorec R2/R4: atomarni
      // increment + r3 normalizacija (SQLite REAL drift), previousQty/newQty iz sveže
      // vrednosti PO prirastu (vedno resničen par, tudi ob sočasnosti). ──
      const saleTxs = await tx.stockTransaction.findMany({
        where: { orderId: order.id, type: 'SALE' },
        select: { id: true, inventoryItemId: true, quantity: true, costPerUnit: true },
        orderBy: { createdAt: 'asc' },
      })
      let stockReversalCount = 0
      const restoredItems: { id: string; qty: number }[] = []

      for (const sale of saleTxs) {
        const restore = r3(-num(sale.quantity)) // SALE je negativen → povračilo pozitivno
        if (restore <= 0) continue

        // Glavna zaloga: atomarni prirast (fail-closed — napaka pade cela transakcija)
        await tx.inventoryItem.updateMany({
          where: { id: sale.inventoryItemId },
          data: { quantity: { increment: restore } },
        })
        const fresh = await tx.inventoryItem.findUnique({
          where: { id: sale.inventoryItemId },
          select: { quantity: true },
        })
        const rawQty = num(fresh?.quantity)
        const after = r3(rawQty)
        if (after !== rawQty) {
          await tx.inventoryItem.update({ where: { id: sale.inventoryItemId }, data: { quantity: after } })
        }
        const prevQty = r3(after - restore)

        // Serije (fail-open, kot zahteva spec): manjkajoča serija → opomba, ne blokira.
        // Glavna količina se VEDNO povrne; serija je samo FEFO sledljivost.
        const notes: string[] = []
        const allocs = await tx.stockBatchAllocation.findMany({
          where: { stockTransactionId: sale.id },
          select: { batchId: true, quantity: true },
        })
        for (const a of allocs) {
          const q = r3(num(a.quantity))
          if (q <= 0) continue
          const batch = await tx.inventoryBatch.findUnique({
            where: { id: a.batchId },
            select: { status: true, quantityRemaining: true },
          })
          if (!batch) {
            notes.push(`Serija ${a.batchId} ne obstaja več — povračilo na serijo preskočeno.`)
            continue
          }
          await tx.inventoryBatch.updateMany({
            where: { id: a.batchId },
            data: { quantityRemaining: { increment: q } },
          })
          const bfresh = await tx.inventoryBatch.findUnique({
            where: { id: a.batchId },
            select: { quantityRemaining: true, status: true },
          })
          const braw = num(bfresh?.quantityRemaining)
          const bAfter = r3(braw)
          if (bAfter !== braw) {
            await tx.inventoryBatch.update({ where: { id: a.batchId }, data: { quantityRemaining: bAfter } })
          }
          // serija je bila ob izprodaji označena EXHAUSTED → s povračilom spet ACTIVE.
          // Issue #15 (v1.105.0): varovalka — če je bila serija medtem BLOKIRANA
          // (karantena/odpoklic), vračilo poveča količino (fizična resnica), a
          // status ostane blokiran — tiha reaktivacija iz blokade ni mogoča.
          const stNow = (bfresh?.status || '').toUpperCase()
          if (bfresh?.status === 'EXHAUSTED' && bAfter > 0.0005 && stNow !== 'QUARANTINE' && stNow !== 'RECALLED') {
            await tx.inventoryBatch.updateMany({
              where: { id: a.batchId, status: 'EXHAUSTED' },
              data: { status: 'ACTIVE' },
            })
          }
          if (stNow === 'QUARANTINE' || stNow === 'RECALLED') {
            notes.push(`Serija ${a.batchId} je blokirana (${stNow}) — vračilo ${q} dodano na količino, status ostane blokiran.`)
          }
        }

        await tx.stockTransaction.create({
          data: {
            id: nid(),
            inventoryItemId: sale.inventoryItemId,
            type: STORNO_RETURN_TX_TYPE,
            quantity: restore,
            previousQty: prevQty,
            newQty: after,
            costPerUnit: num(sale.costPerUnit),
            totalCost: r2(num(sale.costPerUnit) * restore),
            reason: `Storno računa ${receiptNumber} — povračilo razknjižbe`,
            note: notes.join(' '),
            employeeId: user.sub,
            employeeName: user.name,
            orderId: order.id,
          },
        })
        stockReversalCount += 1
        restoredItems.push({ id: sale.inventoryItemId, qty: restore })
      }

      // ── Revizija znotraj transakcije (isti vzorec kot INVOICE_ISSUE v /api/furs) ──
      await writeAudit(tx, { userId: user.sub, action: 'RECEIPT_STORNO', entityType: 'Receipt', entityId: created.id, details: jstr({
            originalReceiptId: original.id,
            originalReceiptNumber: original.receiptNumber,
            stornoReceiptId: created.id,
            stornoReceiptNumber: receiptNumber,
            orderId: order.id,
            total,
            stockReversalCount,
            simulation,
            // Issue #53: izrecna oznaka okolja v reviziji storna (enaka disciplina INVOICE_ISSUE)
            fursEnvironment: profile.environment,
            fursProfileSource: profile.source,
            // Issue #19: razlog (posnetek) + odobritev storna
            ...reasonAuditFields(stornoReason),
            ...approvalAuditFields(stornoApproval, stornoApprovalBasis),
          }), locationId: original.locationId })

      return { created, stockReversalCount, restoredItems }
    })

    // Evidenca gibanja zaloge (fire-and-forget, isti vzorec kot reverzija odpada)
    for (const it of result.restoredItems) {
      void publishEvent('StockChanged', {
        entityType: 'InventoryItem',
        entityId: it.id,
        payload: {
          variance: it.qty,
          cause: 'receipt-storno',
          receiptNumber: result.created.receiptNumber,
          orderId: order.id,
          by: user.name,
          // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
          locationId: original.locationId,
        },
        // Issue #38: verifikovana lokacija originalnega računa
        locationId: original.locationId,
      }).catch(() => undefined)
    }

    // audit 2026-10 #3 (v1.144.0): storno je NOV fiskalni dokument in ga je v
    // produkciji treba PRIJAVITI (ZOI→EOR / ZKI→JIR). Pred tem je ruta kode samo
    // izračunala in zapisala 'pending' → negativni račun pri FURS/Porezni NI
    // OBSTAJOČ. Isti fail-safe kot pri izdaji: ob napaki dokument ostane 'pending'
    // in se obnovi prek POST /api/furs/[id]/resubmit (SubsequentSubmit / NakDost).
    let stornoDoc = result.created
    if (!simulation) {
      const submitted = await submitFiscalDocument({
        receipt: stornoDoc,
        location,
        total,
        vatMap,
        issuedAt: now,
        userId: user.sub,
        simulation,
      })
      if (submitted.ok) stornoDoc = submitted.receipt
    }

    return ok({
      invoice: {
        ...mapReceipt(stornoDoc),
        isStorno: true,
        stornoOf: original.id,
        stornoOfReceiptNumber: original.receiptNumber,
      },
      storno: {
        originalReceiptId: original.id,
        originalReceiptNumber: original.receiptNumber,
        stornoReceiptNumber: stornoDoc.receiptNumber,
        restoredStockItems: result.stockReversalCount,
        fiscalVerified: stornoDoc.fiscalVerified,
        fiscalStatus: stornoDoc.fiscalStatus,
        simulation,
        // Issue #53: izrecna oznaka okolja — 'test'/'simulation' se razločita od produkcije
        fursEnvironment: profile.environment,
      },
      order: { id: order.id, paymentStatus: 'storno' },
    }, 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    console.error('[receipt storno POST] transakcija ni uspela:', e)
    return fail('Storna ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}
