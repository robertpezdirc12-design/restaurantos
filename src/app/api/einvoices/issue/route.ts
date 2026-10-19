import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, num, r2 } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { buildOrderLines, grossOfOrderItems, type EinvoiceOrderLineInput } from '@/lib/einvoice-lines'
import { generateEslogXml, computeOutgoingTotals, type OutgoingEInvoice, type OutgoingEInvoiceLine } from '@/lib/eslog-export'
import { validateOutgoing } from '@/lib/einvoice-validate'

/**
 * Issue #4 (P1, v1.125.0) — izdaja ODHODNEGA B2B e-računa.
 *
 * POST /api/einvoices/issue { orderId? | lines[], customerName, customerTaxId,
 *   customerCountry ('SI'|'HR'), customerEmail?, dueDate?, currency?,
 *   documentType?, locationId? }
 *
 * Kanonični vir = AccountsReceivable (sklep issue §C): iz tokov POS/FURS se
 * NIKOLI ne retroaktivno dela B2B račun — iz orderId se naredi NOVA terjatev.
 * Cene v OrderItem so KONČNE (v1.124.0 DDV pravilo) → neto osnova se IZVLEČE iz
 * cene CELOTNE VRSTICE (v1.149.0 #6), ročne vrstice pa so NETO (B2B račun =
 * net + DDV).
 *
 * Račun iz naročila izda NATANČNO znesek, ki ga stranka dolguje (v1.149.0 #5):
 * bruto osnova je Σ _total_ plačanih računov (Check), sicer Σ postavk −
 * `Order.discount` − `OrderItem.discountAmount`. Popust se po vrsticah razreže
 * cent-exact v `@/lib/einvoice-lines`, zato AR in e-račun ne moreta biti višja
 * od plačila.
 *
 * Pravila:
 *  - validacija (validateOutgoing) prej — napake → 400 {errors:[{field,message}]}
 *    BREZ ustvarjanja AR/outbox;
 *  - idempotenca: orderId + že obstoječa odprta AR (status 'open') → 409
 *    {duplicate: true, ar} (isti vzorec kot uvoz eSLOG #65);
 *  - AR + EInvoiceOutbox (draft, XML + sha256 hash, idempotencyKey = outbox id)
 *    v ENI transakciji; arNumber AR-YYYY-NNNN (count seq + 5 retry);
 *  - profil: HR prejemnik → 'ubl-2.1-hr' (KPD obvezen), sicer 'eslog-2.0-si';
 *  - audit EINVOICE_ISSUED (veriga) na AccountsReceivable + outboxId v details.
 *
 * Pravica: inventory.manage (kot nabava). locationScope: uporabnik ene
 * lokacije NE izda računa iz naročila tuje lokacije.
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'einvoices.issue')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail('Neveljavno telo zahteve.', 400)

  const customerName = String(body.customerName ?? '').trim()
  const customerTaxId = String(body.customerTaxId ?? '').replace(/\s/g, '')
  const customerCountry = String(body.customerCountry ?? 'SI').trim().toUpperCase()
  const customerEmail = String(body.customerEmail ?? '').trim().slice(0, 200)
  const documentType = body.documentType === 'credit_note' ? 'credit_note' : 'invoice'
  const currency = String(body.currency ?? 'EUR').trim().toUpperCase() || 'EUR'
  const dueDateRaw = String(body.dueDate ?? '').trim()
  const issueDate = new Date().toISOString().slice(0, 10)
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw) ? dueDateRaw : undefined

  if (customerCountry !== 'SI' && customerCountry !== 'HR') {
    return fail('Država prejemnika mora biti SI ali HR.', 400)
  }

  // ── lokacija: user.loc || explicit (v obsegu uporabnika) ──
  let locationId = user.loc || null
  if (!locationId) {
    const explicit = String(body.locationId ?? '').trim()
    if (explicit) {
      const scope = await locationScope(user)
      const loc = await db.location.findFirst({ where: { id: explicit, ...scope }, select: { id: true } })
      if (!loc) return fail('Lokacija ni v vašem obsegu ali ne obstaja.', 403)
      locationId = loc.id
    }
  }

  // ── vrstice: iz naročila (končne cene → net) ali ročne (neto) ──
  let lines: OutgoingEInvoiceLine[] = []
  let orderId: string | null = null
  /** bruto, ki ga NAROČILO res dolguje — glava računa se šteje od tod (v1.149.0 #5) */
  let orderGross: number | null = null
  /** sled za revizijo: bruto pred razrezom in kolikor popusta je bilo razdeljenega */
  let grossBefore = 0
  let discountSpread = 0

  if (body.orderId != null && String(body.orderId).trim()) {
    orderId = String(body.orderId).trim()
    const scope = await locationScope(user)
    const order = await db.order.findFirst({
      where: { id: orderId, ...scope },
      select: {
        id: true,
        locationId: true,
        discount: true,
        OrderItem: {
          where: { voided: false },
          select: { menuItemName: true, quantity: true, price: true, vatRate: true, discountAmount: true },
        },
      },
    })
    if (!order) return fail('Naročilo ni v vašem obsegu ali ne obstaja.', 404)
    if (!locationId) locationId = order.locationId

    const items: EinvoiceOrderLineInput[] = order.OrderItem.map((it) => ({
      name: it.menuItemName || `Postavka ${it.quantity}×`,
      quantity: Number(it.quantity),
      unitPrice: Number(it.price),
      vatRate: Number(it.vatRate),
      lineDiscount: num(it.discountAmount),
    }))
    const grossItems = grossOfOrderItems(items)

    // Pričakovani bruto: če je naročilo POCELO izstavljeno in plačano, je edini
    // pravi znesek tisti, ki so ga plačilni izstavki (Check.total = ZA PLAČANJE, že
    // po vseh popustih — tudi happy hour). Če KATERIKOLI izstavek še čaka na
    // plačilo (delna poravnava mize), plačani seštevek NI celotno naročilo: račun
    // bi moral vse artiklje in bi iz neplačanega dela naredil fiktiven popust.
    // Takrat ostanemo pri postavkah minus ročni popust naročila.
    const unpaidChecks = await db.check.count({ where: { orderId: order.id, paymentStatus: { not: 'paid' } } })
    const paidChecks = await db.check.aggregate({
      where: { orderId: order.id, paymentStatus: 'paid' },
      _sum: { total: true },
    })
    const billedGross = unpaidChecks === 0 ? r2(num(paidChecks._sum.total)) : 0
    const expectedGross = billedGross > 0 ? billedGross : r2(Math.max(0, grossItems - num(order.discount)))

    if (expectedGross <= 0) {
      return fail('Naročilo nima zneska za izdajo računa (popoln popust ali brez veljavnih postavk).', 409)
    }

    const built = buildOrderLines(items, expectedGross)
    if (built.shortfallCents > 0) {
      // Postavke so bile po plačilu spremenjene/izbrisane, zato iz njih NE morem
      // sestaviti računa, ki bi znašal toliko, kot stranka dolguje. Bolje
      // zavrniti (fail-closed) kot izstaviti račun po domnevi.
      return fail(
        `Znesek naročila (${expectedGross.toFixed(2)} €) presega vrednost postavk (${built.grossBefore.toFixed(2)} €) — izdaja e-računa je zavrnjena, uskladite naročilo.`,
        409,
      )
    }
    orderGross = expectedGross
    grossBefore = built.grossBefore
    discountSpread = built.discountSpread
    lines = built.lines
  } else if (Array.isArray(body.lines)) {
    lines = (body.lines as Record<string, unknown>[]).map((l) => {
      const unitCode = String(l.unitCode ?? '').trim()
      const kpdCode = String(l.kpdCode ?? '').trim()
      const lineId = String(l.lineId ?? '').trim()
      return {
        name: String(l.name ?? ''),
        quantity: Number(l.quantity),
        unitPriceNet: Number(l.unitPriceNet),
        vatRate: Number(l.vatRate),
        ...(unitCode ? { unitCode } : {}),
        ...(kpdCode ? { kpdCode } : {}),
        ...(lineId ? { lineId } : {}),
      }
    })
  }

  if (lines.length === 0) {
    return fail('Račun mora vsebovati vsaj eno vrstico (naročilo ali ročni vnos).', 400)
  }

  // ── prodajalec = lokacija (izdajatelj) ──
  const sellerLoc = locationId
    ? await db.location.findUnique({
        where: { id: locationId },
        select: { name: true, taxId: true, address: true, city: true, postCode: true, country: true },
      })
    : null
  const sellerCountry = sellerLoc?.country === 'HR' ? 'HR' : 'SI'

  const profile = customerCountry === 'HR' ? 'ubl-2.1-hr' : 'eslog-2.0-si'
  const totals = computeOutgoingTotals(lines)
  // v1.149.0 (#5): pri računu iz naročila skupni znesek NI seštevek vrstic, ampak
  // znesek, ki ga stranka dolguje. Validacija dobi NEODVISEN kontrolni podatek —
  // če se razrez popusta po vrsticah ne ujema s plačilom, izdaja propade, namesto
  // da bi si glava sama potrdila lastno vsoto.
  const invoiceTotal = orderGross ?? totals.totalAmount

  // ── idempotenca: orderId + odprta AR → 409 duplicate (brez nove terjatve) ──
  if (orderId) {
    const existing = await db.accountsReceivable.findFirst({
      where: { orderId, status: 'open' },
      select: { id: true, arNumber: true, customerName: true, totalAmount: true, status: true },
    })
    if (existing) {
      return ok(
        {
          duplicate: true,
          error: `Za naročilo ${orderId} že obstaja odprta terjatev ${existing.arNumber} — izdaja e-računa je zavrnjena (brez dvojnika).`,
          ar: existing,
        },
        409,
      )
    }
  }

  // ── validacija PRED ustvarjanjem (issue §P1-C: napaka blokira) ──
  const now = new Date()
  const draft: OutgoingEInvoice = {
    // začasna številka — prava (AR-YYYY-NNNN) se zapiše v XML v transakcijski zanki
    invoiceNumber: 'PENDING',
    issueDate,
    dueDate,
    currency: currency as 'EUR',
    seller: {
      name: sellerLoc?.name || 'RestaurantOS',
      taxId: String(sellerLoc?.taxId ?? '').replace(/\D/g, ''),
      ...(sellerLoc?.address ? { address: sellerLoc.address } : {}),
      ...(sellerLoc?.city ? { city: sellerLoc.city } : {}),
      ...(sellerLoc?.postCode ? { postCode: sellerLoc.postCode } : {}),
      country: sellerCountry,
    },
    buyer: { name: customerName, taxId: customerTaxId, country: customerCountry as 'SI' | 'HR' },
    lines,
    documentType,
  }
  const validation = validateOutgoing(draft, profile, { subtotal: totals.subtotal, vatAmount: totals.vatAmount, totalAmount: invoiceTotal })
  if (validation.errors.length > 0) {
    return ok({ error: 'E-račun ni veljaven — izdaja blokirana.', errors: validation.errors }, 400)
  }

  // ── AR + EInvoiceOutbox v transakciji (številčenje s 5 retry) ──
  const year = now.getFullYear()
  let created: { arId: string; arNumber: string; outboxId: string; xmlHash: string } | null = null
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const seq = (await db.accountsReceivable.count({ where: { arNumber: { startsWith: `AR-${year}-` } } })) + 1 + attempt
    const arNumber = `AR-${year}-${String(Math.max(1, seq)).padStart(4, '0')}`
    const xml = generateEslogXml({ ...draft, invoiceNumber: arNumber }, { profile })
    const xmlHash = createHash('sha256').update(xml, 'utf8').digest('hex')
    const outboxId = nid()
    try {
      await db.$transaction(async (tx) => {
        const ar = await tx.accountsReceivable.create({
          data: {
            id: nid(),
            arNumber,
            orderId: orderId || null,
            customerName,
            customerTaxId,
            customerEmail,
            invoiceNumber: arNumber,
            invoiceDate: now,
            dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : new Date(now.getTime() + 30 * 86400000),
            subtotal: totals.subtotal,
            vatAmount: totals.vatAmount,
            totalAmount: invoiceTotal,
            status: 'open',
            notes: `B2B e-račun (${profile}) za ${customerName}`,
            locationId,
          },
        })
        await tx.eInvoiceOutbox.create({
          data: {
            id: outboxId,
            arId: ar.id,
            direction: 'outgoing',
            country: customerCountry,
            documentType,
            profile,
            currency,
            invoiceNumber: arNumber,
            receiverName: customerName,
            receiverTaxId: customerTaxId,
            receiverCountry: customerCountry,
            subtotal: totals.subtotal,
            vatAmount: totals.vatAmount,
            totalAmount: invoiceTotal,
            xmlPayload: xml,
            xmlHash,
            externalRef: '',
            idempotencyKey: outboxId,
            status: 'draft',
            lastReason: '',
            processedEvents: '[]',
            attempts: 0,
            locationId,
          },
        })
        created = { arId: ar.id, arNumber, outboxId, xmlHash }
      })
    } catch (e) {
      const msg = String((e as Error).message || '')
      if (msg.includes('arNumber') && attempt < 4) continue // sočasno števljenje → retry
      throw e
    }
  }
  // TS ozko grlo: dodelitev znotraj tx callbacka se ne sledi — eksplicitna končna oblika
  const createdFinal = created as { arId: string; arNumber: string; outboxId: string; xmlHash: string } | null
  if (!createdFinal) return fail('Izdaja e-računa ni uspela (številčenje terjitev).', 500)

  await writeAudit(db, {
    userId: user.sub,
    action: 'EINVOICE_ISSUED',
    entityType: 'AccountsReceivable',
    entityId: createdFinal.arId,
    details: JSON.stringify({
      arNumber: createdFinal.arNumber,
      outboxId: createdFinal.outboxId,
      profile,
      country: customerCountry,
      documentType,
      orderId: orderId || null,
      receiverName: customerName,
      receiverTaxId: customerTaxId,
      subtotal: totals.subtotal,
      vatAmount: totals.vatAmount,
      totalAmount: invoiceTotal,
      grossBefore: orderId ? grossBefore : null,
      discountSpread: orderId ? discountSpread : null,
      lines: lines.length,
      xmlHash: createdFinal.xmlHash,
      locationId,
      warnings: validation.warnings.map((w) => w.message),
    }),
    locationId,
  })

  return ok(
    {
      ar: { id: createdFinal.arId, arNumber: createdFinal.arNumber, customerName, totalAmount: invoiceTotal, status: 'open' },
      eInvoice: {
        id: createdFinal.outboxId,
        status: 'draft',
        profile,
        country: customerCountry,
        documentType,
        invoiceNumber: createdFinal.arNumber,
        subtotal: totals.subtotal,
        vatAmount: totals.vatAmount,
        totalAmount: invoiceTotal,
        xmlHash: createdFinal.xmlHash,
        idempotencyKey: createdFinal.outboxId,
        warnings: validation.warnings,
      },
    },
    201,
  )
}
