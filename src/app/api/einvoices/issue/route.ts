import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, r2 } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { netFromGross, vatFromGross } from '@/lib/billing'
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
 * Cene v OrderItem so KONČNE (v1.124.0 DDV pravilo) → neto osnova se izpelje
 * z netFromGross/vatFromGross; ročne vrstice so NETO (B2B račun = net + DDV).
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

  if (body.orderId != null && String(body.orderId).trim()) {
    orderId = String(body.orderId).trim()
    const scope = await locationScope(user)
    const order = await db.order.findFirst({
      where: { id: orderId, ...scope },
      select: {
        id: true,
        locationId: true,
        OrderItem: {
          where: { voided: false },
          select: { menuItemName: true, quantity: true, price: true, vatRate: true },
        },
      },
    })
    if (!order) return fail('Naročilo ni v vašem obsegu ali ne obstaja.', 404)
    if (!locationId) locationId = order.locationId
    lines = order.OrderItem.map((it) => {
      const gross = Number(it.price)
      const rate = Number(it.vatRate)
      // v1.124.0: cena je KONČNA (z DDV) → neto enota + DDV po vrstici
      const netUnit = netFromGross(gross, rate)
      const vatUnit = vatFromGross(gross, rate)
      return {
        name: it.menuItemName || `Postavka ${it.quantity}×`,
        quantity: Number(it.quantity),
        unitPriceNet: netUnit,
        vatRate: rate,
        lineVatAmount: r2(Number(it.quantity) * vatUnit),
      }
    })
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
  const validation = validateOutgoing(draft, profile, { subtotal: totals.subtotal, vatAmount: totals.vatAmount, totalAmount: totals.totalAmount })
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
            totalAmount: totals.totalAmount,
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
            totalAmount: totals.totalAmount,
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
      totalAmount: totals.totalAmount,
      lines: lines.length,
      xmlHash: createdFinal.xmlHash,
      locationId,
      warnings: validation.warnings.map((w) => w.message),
    }),
    locationId,
  })

  return ok(
    {
      ar: { id: createdFinal.arId, arNumber: createdFinal.arNumber, customerName, totalAmount: totals.totalAmount, status: 'open' },
      eInvoice: {
        id: createdFinal.outboxId,
        status: 'draft',
        profile,
        country: customerCountry,
        documentType,
        invoiceNumber: createdFinal.arNumber,
        subtotal: totals.subtotal,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        xmlHash: createdFinal.xmlHash,
        idempotencyKey: createdFinal.outboxId,
        warnings: validation.warnings,
      },
    },
    201,
  )
}
