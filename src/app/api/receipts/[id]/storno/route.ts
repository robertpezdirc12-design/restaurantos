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
import { restoreAuto86ForInventory } from '@/lib/auto-86'
import { tierForPoints } from '@/lib/billing'
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
 *  - 409: naročilo ni 'paid' — samo plačana naročila se stornirajo (R10 vzorec);
 *    IZJEMA (v1.239.0 §16 D): delno plačano naročilo ('partial') z računom, ki
 *    nosi checkId (per-check izdaja od v1.239.0) — storno posameznega izstavka
 *    je dovoljen (denar za TA izstavek je pobran; Toast: refund ne razplača
 *    celotnega naročila). Naročilo ostane 'partial' (odprti izstavki živijo).
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
  // v1.239.0 §16 D: per-check storno na 'partial' naročilu — račun mora nositi
  // checkId (per-check izdaja od v1.239.0) IN ta izstavek mora biti plačan.
  // Brez checkId (legacy celotno plačilo) storno zahteva 'paid' (celoto).
  const partialScopedStorno = order.paymentStatus === 'partial' && !!original.checkId
  if (order.paymentStatus !== 'paid' && !partialScopedStorno) {
    return fail('Storno je mogoč samo za plačano naročilo oz. posamezen plačan izstavek.', 409)
  }
  if (partialScopedStorno) {
    const scopedCheck = await db.check.findUnique({
      where: { id: original.checkId as string },
      select: { paymentStatus: true },
    })
    if (scopedCheck?.paymentStatus !== 'paid') {
      return fail('Izstavek tega računa ni plačan — storno ni mogoč.', 409)
    }
  }

  // ── v1.238.0 §15 (P0): varovala STORNO PO IZSTAVKU na naročilu z VEČ računi ──
  // Split-check naročilo ima en račun na izstavek. Povračilo zaloge po
  // `orderId + type='SALE'` bi vrnilo odjeme VSEH izstavkov (pijače IN jedi) —
  // zaloga bi se napihnila za količine, ki so dejansko porabljene in plačane
  // (veljaven račun ostane). Od v1.238.0 razknjižba nosi žig računa
  // (StockTransaction.supplierDoc), zato:
  //  - žig OBSTAJA → storno vrača SAMO odjeme tega računa; naročilo OSTANE 'paid'
  //    (ostali izstavki so še veljavni — Toast: refund ne razplača celotnega naročila);
  //  - žiga NI (računi izdani pred v1.238.0) → 409 z iskrenim razlogom (ročni
  //    popravek zaloge prek inventure) — tiha korupcija zaloge NI možna.
  //  - §17 (v1.243.0) IZJEMA: naročilo BREZ odjemov zaloge (meni brez receptur —
  //    ni VRSTICE type='SALE') tvegana povratka nima KAJ vrnit: zaloga se ne
  //    razknjiži ob prodaji brez recepture, zato varovala takega naročila NE
  //    sme blokirati (prej: 409 past tudi za povračilo, ki zaloge sploh ne
  //    dotakne — izmerjeno v testu D2).
  const siblingReceipts = await db.receipt.count({
    where: { orderId: order.id, isStorno: false, isCopy: false, id: { not: original.id } },
  })
  let scopedMultiCheck = false
  if (siblingReceipts > 0) {
    const [stamped, saleTotal] = await Promise.all([
      db.stockTransaction.count({
        where: { orderId: order.id, type: 'SALE', supplierDoc: original.receiptNumber },
      }),
      db.stockTransaction.count({
        where: { orderId: order.id, type: 'SALE' },
      }),
    ])
    if (saleTotal > 0 && stamped === 0) {
      return fail(
        `Naročilo ima ${siblingReceipts + 1} računov (plačilo po izstavkih) — storno enega računa bi povrnilo zalogo vseh izstavkov. Računi, izdani pred v1.238.0, nimajo povezave odjema→račun: izvedite popravek zaloge ročno (inventura) ali stornirajte od zadnjega računa naprej.`,
        409,
      )
    }
    scopedMultiCheck = true
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
      // v1.238.0 §15: pri stornu ENEGA izstavka več-računskega naročila naročilo
      // OSTANE 'paid' (ostali izstavki so veljavni) — CAS je samo preverba stanja.
      // v1.239.0 §16 D: 'partial' + per-check račun → stanje ostane 'partial'
      // (odprti izstavki živijo naprej; refund ne razplača celotnega naročila).
      // POZOR (izmerjeno): updateMany s PRAZNIM data:{} vrne count 0 tudi ob
      // ujemajoči vrstici — zato nosi no-op poteza eksplicitni updatedAt (isti
      // zapis, ki ga @updatedAt PRIVZETO zapiše ob vsaki posodobitvi).
      const keepOrderState = scopedMultiCheck || partialScopedStorno
      const cas = await tx.order.updateMany({
        where: { id: order.id, paymentStatus: keepOrderState ? { in: ['paid', 'partial'] } : 'paid' },
        data: keepOrderState ? { updatedAt: new Date() } : { paymentStatus: 'storno' },
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
          // v1.239.0 §16 C: posnetek + izstavek se PRENESEJO na storno račun —
          // ponatisk storna prikaže iste postavke kot original (negirane).
          // Normalizacija: SQLite nosi JSON kot niz, Postgres (Json stolpec) lahko
          // vrne že razčlenjeno polje — vnos vedno normaliziramo v niz (isti
          // zapis kot ob izdaji, jstr).
          checkId: original.checkId,
          itemsJson: (typeof original.itemsJson === 'string' ? original.itemsJson : jstr(original.itemsJson ?? [])) as string,
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
        // v1.238.0 §15: pri več računih na naročilu vračamo SAMO odjeme tega računa (žig)
        where: { orderId: order.id, type: 'SALE', ...(scopedMultiCheck ? { supplierDoc: original.receiptNumber } : {}) },
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

      /* ── v1.239.0 §16 B: NEGACIJA PLAČILNIH VRSTIC (Payment) ──
       * Denarna celovitost: Payment vrstice so vir napitninskega bazena
       * (/api/tips), Z-poročila po vrsticah (§16 A) in izvoza knjigovodstva.
       * Do zdaj je storno negiral SAMO Receipt — Payment.tipAmount je ostal
       * pozitiven za vedno (dnevni bazen napitnin je računal preveč), vsota
       * vrstic na izstavku pa ni več 0 (denar "izgubljen" v bazenu).
       * Toast/Square: refund negira VSAK del plačila po izvirnem načinu.
       *
       * Obseg negacije (fail-closed):
       *  - original.checkId (per-check račun, v1.239.0+) → SAMO plačila tega izstavka;
       *  - sicer celotno plačilo (enični račun naročila) → plačila VSEH izstavkov;
       *  - legacy več-računsko naročilo brez checkId → NEGACIJA IZPUŠČENA (iskreno
       *    v auditu; okno v1.238.0→v1.239.0, zaloge/fiskal so pravilne, bazen
       *    ostane po starem obnašanju — ročni popravek vodstva).
       * Negacijska vrstica = zrcalo originala ( isti checkId, tip, prejemnik),
       * amount/tipAmount negirana, status 'completed' — VSE obstoječe agregacije
       * (bazen, Z-poročilo, izvoz) se natočijo same (neto 0).
       *
       * §17 (v1.243.0) POVRAČILNA CELICA — povračilo vrača VREDNOST, ne samo
       * računovodstvo: negacija Payment vrstice je računovodski sloj; ob plačilu
       * so se sredstva GIBALA tudi po vrednostnih instrumentih (darilna kartica,
       * točke zvestobe, kupon) — vsak instrument dobi svoje povračilo V ISTI
       * transakciji (Toast: refund returns funds to the ORIGINAL tender):
       *  - A) darilna kartica: CAS povračilo salda (centno-natančno, isti vzorec
       *    kot unovčenje ob izdaji) + GiftCardTransaction type='refund' (pozitiven
       *    predznak po konvenciji gcTxSign — issue/topup/refund +, redeem −);
       *  - B) unovčene točke: pointsBalance nazaj (increment) + zrcalna vrstica
       *    LoyaltyTransaction (points +, monetaryValue negirana — vsota para = 0);
       *    lifetimePoints se NE vrača (odjem ga ni dotaknil);
       *  - C) zaslužene točke: earn ob plačilu je povečal balance + lifetime + tier
       *    — negacija vseh treh (tierForPoints na novem doživetju) + zrcalna
       *    negativna vrstica. Saldo lahko pade NEGATIVNO (točke za vrnjeno blago
       *    so dolg — unovčenje blokira pogoj pointsBalance >= redeemPoints);
       *  - D) kupon: odkup (status 'redeemed') ob POLNEM povračilu naročila vrne
       *    kupon v 'issued' (redeemedAt/orderId čiščenje, opomba s številko storna)
       *    SAMO ko po tem stornu na naročilu ni več ŽIVEGA originalnega računa
       *    (brat račun, ki je bil že storniran sam, NI živ) in ni odprtih izstavkov
       *    (partialScopedStorno) — preostali izstavki še nosijo vrednost popusta.
       *    Register/adhoc popust se NE vrača (dokumentirana odločitev #45);
       *  - E) sledljivost: zrcalne Payment vrstice nosijo giftCardId /
       *    loyaltyAccountId / loyaltyPointsUsed (identifikacija instrumenta na
       *    negativni vrstici — zneski so negirani, števci pa identifikacija).
       *  Fail-open z iskreno opombo v reviziji: izbrisana kartica/račun zvestobe
       *    (FK SetNull) pomeni, da instrumenta ni mogoče povrniti — računovodski
       *    sloj je kljub temu pravilen (neto 0), ročni popravek ostaja vodstvu. */
      let negatedPayments = 0
      let paymentNegationScope: 'check' | 'order' | 'skipped-legacy-multicheck' = 'skipped-legacy-multicheck'
      // §17: števci povračil vrednostnih instrumentov + iskrene opombe (fail-open)
      let refundedGiftCards = 0
      let refundedGiftCardTotal = 0
      let refundedLoyaltyPoints = 0
      let negatedEarnedPoints = 0
      const valueNotes: string[] = []
      const negationCheckIds = original.checkId
        ? [original.checkId]
        : !scopedMultiCheck
          ? (await tx.check.findMany({ where: { orderId: order.id }, select: { id: true } })).map((c) => c.id)
          : []
      if (negationCheckIds.length > 0) {
        paymentNegationScope = original.checkId ? 'check' : 'order'
        const origPayments = await tx.payment.findMany({
          where: { checkId: { in: negationCheckIds }, amount: { gt: 0 }, status: 'completed' },
          select: { id: true, checkId: true, amount: true, tipAmount: true, type: true, employeeId: true, giftCardId: true, loyaltyAccountId: true, loyaltyPointsUsed: true },
        })
        for (const p of origPayments) {
          await tx.payment.create({
            data: {
              id: nid(),
              checkId: p.checkId,
              amount: r2(-num(p.amount)),
              tipAmount: r2(-num(p.tipAmount)),
              type: p.type,
              status: 'completed',
              // zrcalo originalnega prejemnika — bazen ostane sidran na osebi,
              // ki je napitnino prejela (negacija odšteje od njenega dneva)
              employeeId: p.employeeId,
              // §17 E: identifikacija instrumenta na zrcalu (zneski negirani,
              // števci so identifikacija — loyaltyPointsUsed ostane pozitiven
              // count točk tega dela plačila, kot na originalu)
              ...(p.giftCardId ? { giftCardId: p.giftCardId } : {}),
              ...(p.loyaltyAccountId ? { loyaltyAccountId: p.loyaltyAccountId } : {}),
              ...(Math.round(num(p.loyaltyPointsUsed)) > 0 ? { loyaltyPointsUsed: Math.round(num(p.loyaltyPointsUsed)) } : {}),
            },
          })
          negatedPayments += 1

          // ── §17 A: darilna kartica — povračilo salda na kartico (ISTI tx) ──
          if (p.type === 'giftcard') {
            const fresh = p.giftCardId
              ? await tx.giftCard.findUnique({ where: { id: p.giftCardId }, select: { balance: true } })
              : null
            if (!p.giftCardId || !fresh) {
              // kartica je bila IZBRISANA (FK SetNull prekine povezavo) — denarja
              // ni mogoče vrniti na instrument; iskrena opomba (računovodstvo je
              // kljub temu pravilno — neto 0; ročni popravek vodstva)
              valueNotes.push('Darilna kartica plačila ne obstaja več — povračilo na kartico ni mogoče (računovodska negacija je izvedena; ročni popravek vodstva).')
            } else {
              // centno-natančna aritmetika + enakostni CAS — isti vzorec kot
              // unovčenje ob izdaji (SQLite REAL drift; sočasnost topup/storno)
              const currentCents = Math.round(num(fresh.balance) * 100)
              const refundCents = Math.round(num(p.amount) * 100)
              const newBalance = (currentCents + refundCents) / 100
              const cas = await tx.giftCard.updateMany({
                where: { id: p.giftCardId, balance: fresh.balance },
                data: { balance: newBalance },
              })
              if (cas.count === 0) {
                throw new OrderError('Darilna kartica je bila sočasno spremenjena — storno poskusite znova.', 409)
              }
              await tx.giftCardTransaction.create({
                data: {
                  id: nid(),
                  giftCardId: p.giftCardId,
                  type: 'refund',
                  amount: r2(num(p.amount)),
                  balanceAfter: newBalance,
                  orderId: order.id,
                  checkId: p.checkId,
                  note: `Povračilo ob stornu računa ${receiptNumber}`,
                },
              })
              refundedGiftCards += 1
              refundedGiftCardTotal = r2(refundedGiftCardTotal + num(p.amount))
            }
          }

          // ── §17 B: unovčene točke — nazaj na saldo (ISTI tx) ──
          if (p.type === 'loyalty' && Math.round(num(p.loyaltyPointsUsed)) > 0) {
            const acc = p.loyaltyAccountId
              ? await tx.loyaltyAccount.findUnique({ where: { id: p.loyaltyAccountId }, select: { id: true } })
              : null
            if (!p.loyaltyAccountId || !acc) {
              // račun zvestobe je bil IZBRISAN (FK SetNull) — točk ni mogoče
              // vrniti gostu; iskrena opomba (ročni popravek vodstva)
              valueNotes.push('Račun zvestobe plačila ne obstaja več — točk ni bilo mogoče vrniti (ročni popravek vodstva).')
            } else {
              const pts = Math.round(num(p.loyaltyPointsUsed))
              // increment je atomaren (Prisma); lifetime se NE vrača — odjem
              // (redeem) ga ni dotaknil, zato tudi povračilo ne sme
              await tx.loyaltyAccount.update({
                where: { id: p.loyaltyAccountId },
                data: { pointsBalance: { increment: pts } },
              })
              await tx.loyaltyTransaction.create({
                data: {
                  id: nid(),
                  loyaltyAccountId: p.loyaltyAccountId,
                  // zrcalo originala: points + (original redeem je −),
                  // monetaryValue negirana — vsota para = 0
                  type: 'redeem',
                  points: pts,
                  reason: `Povračilo unovčenih točk ob stornu računa ${receiptNumber}`,
                  orderId: order.id,
                  checkId: p.checkId,
                  monetaryValue: r2(-num(p.amount)),
                },
              })
              refundedLoyaltyPoints += pts
            }
          }
        }

        // ── §17 C: negacija ZASLUŽENIH točk tega obsega (ISTI tx) ──
        // earn ob plačilu je povečal balance + lifetime + tier; storno negira
        // vse tri. Vrstice iščemo po checkId v obsegu negacije (isti obseg kot
        // plačila) — ročne prilagoditve (brez checkId) niso dotaknjene.
        const earnRows = await tx.loyaltyTransaction.findMany({
          where: { type: 'earn', checkId: { in: negationCheckIds }, points: { gt: 0 } },
          select: { id: true, loyaltyAccountId: true, points: true, checkId: true, monetaryValue: true },
        })
        for (const er of earnRows) {
          const acc = await tx.loyaltyAccount.findUnique({
            where: { id: er.loyaltyAccountId },
            select: { lifetimePoints: true },
          })
          if (!acc) {
            valueNotes.push(`Račun zvestobe zaslužka ne obstaja več — zaslužek ${er.points} tk ni bil mogoče negirati (ročni popravek vodstva).`)
            continue
          }
          // saldo lahko pade NEGATIVNO (točke za vrnjeno blago so dolg —
          // unovčenje blokira pogoj pointsBalance >= redeemPoints)
          await tx.loyaltyAccount.update({
            where: { id: er.loyaltyAccountId },
            data: {
              pointsBalance: { decrement: er.points },
              lifetimePoints: { decrement: er.points },
              tier: tierForPoints(acc.lifetimePoints - er.points),
            },
          })
          await tx.loyaltyTransaction.create({
            data: {
              id: nid(),
              loyaltyAccountId: er.loyaltyAccountId,
              // zrcalo originala: points − (original earn je +),
              // monetaryValue negirana — vsota para = 0
              type: 'earn',
              points: -er.points,
              reason: `Negacija zaslužka ob stornu računa ${receiptNumber}`,
              orderId: order.id,
              checkId: er.checkId,
              monetaryValue: r2(-num(er.monetaryValue)),
            },
          })
          negatedEarnedPoints += er.points
        }
      }

      // ── §17 D: kupon — ponovna izdaja SAMO ob polnem povračilu naročila ──
      // Po tem stornu na naročilu ne sme ostati NOBEN živ originalni račun
      // (bratje, ki so bili že stornirani sami, niso živi) in ne odprtih
      // izstavkov (partialScopedStorno = odprti izstavki še živijo) — samo takrat
      // je vrednost popusta dejansko neporabljena in kupon pripada gostu nazaj.
      const siblingOriginals = await tx.receipt.findMany({
        where: { orderId: order.id, isStorno: false, isCopy: false, id: { not: original.id } },
        select: { id: true },
      })
      let liveSiblings = siblingOriginals.length
      if (siblingOriginals.length > 0) {
        const stornoedSiblings = await tx.receipt.count({
          where: { stornoOf: { in: siblingOriginals.map((s) => s.id) } },
        })
        liveSiblings -= stornoedSiblings
      }
      const fullRefund = liveSiblings === 0 && !partialScopedStorno
      let couponReissued: { id: string; code: string } | null = null
      if (fullRefund) {
        // odkupljeni kupon TEGA naročila (discount ruta zavrača drugi popust na
        // naročilu z že pripetim — orderId je zanesljiv večinski ključ)
        const coupon = await tx.coupon.findFirst({
          where: { orderId: order.id, status: 'redeemed' },
          select: { id: true, code: true, note: true },
        })
        if (coupon) {
          await tx.coupon.update({
            where: { id: coupon.id },
            data: {
              status: 'issued',
              redeemedAt: null,
              // orderId počiščen — kupon je prost za naslednje naročilo;
              // izvor povračila ostaja dokumentiran v opombi + reviziji
              orderId: null,
              note: `${coupon.note ? `${coupon.note} · ` : ''}Ponovno izdan ob stornu računa ${original.receiptNumber} (storno ${receiptNumber})`,
            },
          })
          couponReissued = { id: coupon.id, code: coupon.code }
          await writeAudit(tx, {
            userId: user.sub,
            action: 'COUPON_REISSUED',
            entityType: 'Coupon',
            entityId: coupon.id,
            details: jstr({
              couponCode: coupon.code,
              orderId: order.id,
              originalReceiptNumber: original.receiptNumber,
              stornoReceiptNumber: receiptNumber,
              by: user.name,
            }),
            locationId: original.locationId,
          })
        }
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
            // v1.239.0 §16 B: negacija plačilnih vrstic (obseg + števec)
            paymentNegation: { scope: paymentNegationScope, negatedRows: negatedPayments },
            // §17 (v1.243.0): povračila vrednostnih instrumentov (isto-sferična
            // dokazljivost kot zaloga/plačila — kaj se je komu vrnilo in zakaj ne)
            valueRefunds: {
              giftCards: refundedGiftCards,
              giftCardTotal: refundedGiftCardTotal,
              redeemedPoints: refundedLoyaltyPoints,
              negatedEarnedPoints,
              couponReissued: couponReissued?.code ?? null,
              ...(valueNotes.length > 0 ? { notes: valueNotes } : {}),
            },
            simulation,
            // Issue #53: izrecna oznaka okolja v reviziji storna (enaka disciplina INVOICE_ISSUE)
            fursEnvironment: profile.environment,
            fursProfileSource: profile.source,
            // Issue #19: razlog (posnetek) + odobritev storna
            ...reasonAuditFields(stornoReason),
            ...approvalAuditFields(stornoApproval, stornoApprovalBasis),
          }), locationId: original.locationId })

      return {
        created,
        stockReversalCount,
        restoredItems,
        negatedPayments,
        paymentNegationScope,
        refundedGiftCards,
        refundedGiftCardTotal,
        refundedLoyaltyPoints,
        negatedEarnedPoints,
        couponReissued,
        valueNotes,
      }
    })

    // v1.230.0 — samodejni 86: povračilo razknjižbe obnovi avtomatsko razprodane
    // artikle (fire-and-forget; ročno ugasnjeni ostanejo ugasnjeni)
    void restoreAuto86ForInventory(
      result.restoredItems.filter((it) => it.qty > 0).map((it) => it.id),
      user.sub,
    )

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
        // v1.239.0 §16 B: koliko plačilnih vrstic je bilo negiranih (denar/bazen)
        negatedPaymentRows: result.negatedPayments,
        // §17 (v1.243.0): povračila vrednostnih instrumentov — darilna kartica,
        // točke (unovčene povrnjene + zaslužene negirane) in kupon
        valueRefunds: {
          giftCards: result.refundedGiftCards,
          giftCardTotal: result.refundedGiftCardTotal,
          redeemedPoints: result.refundedLoyaltyPoints,
          negatedEarnedPoints: result.negatedEarnedPoints,
          couponReissued: result.couponReissued?.code ?? null,
          ...(result.valueNotes.length > 0 ? { notes: result.valueNotes } : {}),
        },
        fiscalVerified: stornoDoc.fiscalVerified,
        fiscalStatus: stornoDoc.fiscalStatus,
        simulation,
        // Issue #53: izrecna oznaka okolja — 'test'/'simulation' se razločita od produkcije
        fursEnvironment: profile.environment,
      },
      order: { id: order.id, paymentStatus: scopedMultiCheck ? 'paid' : partialScopedStorno ? 'partial' : 'storno' },
    }, 201)
  } catch (e) {
    if (e instanceof OrderError) return fail(e.message, e.status)
    console.error('[receipt storno POST] transakcija ni uspela:', e)
    return fail('Storna ni bilo mogoče zaključiti. Stanje je nespremenjeno — poskusite znova.', 500)
  }
}
