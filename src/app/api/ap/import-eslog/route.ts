import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, jstr } from '@/lib/map'
import { apNumberFor, apLineTotalGross, parsePaymentTermsDays } from '@/lib/procurement'
import { parseEslog, type EslogInvoice } from '@/lib/eslog'
import { writeAudit } from '@/lib/audit-chain'
import { upsertApAttachments, oversizeNote, type ApAttachmentMeta } from '@/lib/ap-attachments'
import { pushEvent, apNewPushPayload } from '@/lib/push'
import { autoLinkExactMatches, applyApMatchEvaluation } from '@/lib/ap-match'
import type { AuthPayload } from '@/lib/auth'

/**
 * OPS-9 val 2 (v1.75.0) — eSLOG e-račun uvoz (XML → zapadle obveznosti).
 *
 * POST /api/ap/import-eslog { xml: string }
 *   → parse (src/lib/eslog.ts) → match Supplier po davčni številki (samo števke;
 *     Supplier.taxId sme imeti "SI" predpono — obe strani se normalizirajo) →
 *     AccountsPayable (status 'open', matchStatus 'auto') + AccountsPayableLine vrstice.
 *
 * Idempotentnost: AP z isto (supplierId, invoiceNumber) že obstaja → 200 {duplicate:true, ap}.
 * Brez ujemanja dobavitelja → 422 {error, parsed} (UI spodbudi ustvarjanje dobavitelja;
 * nikoli NE ustvarjamo dobavitelja samodejno).
 *
 * Pravica: inventory.manage (kot POST /api/purchase-orders). Audit: ESLOG_IMPORTED.
 * Numeracija: apNumberFor (AP-YYYY-NNNN), count-based seq + retry na unique
 * (isti vzorec kot prevzemni most v /api/purchase-orders/[id]/receive).
 *
 * Issue #65 (P1) — idempotenca eSLOG računa je tenant-scoped in DB-podprta:
 *  - kanonični dokumentni ključ = supplierId + normalizirana invoiceNumber
 *    (trim, brez strip leading zeros — deterministično); atomaren claim prek
 *    DETERMINISTIČNEGA AP id (`ap-eslog-<sha256>`) — primarni ključ je obstoječa
 *    DB unikatnost, zato dva sočasna uvoza istega XML-a trčita na PK (P2002)
 *    in natanko eden zmaga (brez DDL, brez novega stolpca);
 *  - duplicate/replay sme vrniti SAMO AP lastnega konteksta — enak obseg kot
 *    seznam /api/expenses (locationScope): globalna identiteta dobavitelja NI
 *    dovoljenje za globalni dostop do njegovih računov; tuj AP → 409 BREZ
 *    apNumber/dobavitelja/zneska/datuma/statusa;
 *  - isti dokument + RAZLIČEN finančni payload (znesek/DDV/datum/vrstice) →
 *    409 dokumentni konflikt (obstoječi AP se NE prekrije; usmeritev na pregled /
 *    dobropis / korigirani račun);
 *  - P2002 (PK ali apNumber števljenje) → preberi zmagovalca in vrni replay
 *    SAMO po obsežni preverbi (ključ ni poverilnica) — nikoli drugi AP number.
 */

const MAX_XML_BYTES = 2 * 1024 * 1024 // 2 MB — e-računi so majhni dokumenti

/**
 * Issue #65: normalizirana številka računa — trim whitespace (deterministično;
 * brez strip leading zeros / mipmap črk — eSLOG številka je občutljiv identifikator).
 */
function normalizeInvoiceNumber(raw: string): string {
  return String(raw ?? '').trim().slice(0, 120)
}

/**
 * Issue #65: kanonični dokumentni ključ → DETERMINISTIČNI AP id. Primarni ključ
 * je obstoječa DB unikatnost — INSERT istega dokumenta je atomaren idempotency
 * claim (P2002 = sočasni uvoz istega računa). Naključni nid() ostane za vse
 * ostale poti ustvarjanja AP (nabava/stroški) — predpona 'ap-eslog-' je
 * imensko ločena, zato trčenje z nid() ni mogoče.
 */
function eslogApId(supplierId: string, invoiceNumber: string): string {
  const h = createHash('sha256')
    .update(`eslog|${supplierId}|${normalizeInvoiceNumber(invoiceNumber)}`)
    .digest('hex')
    .slice(0, 24)
  return `ap-eslog-${h}`
}

/**
 * Issue #65 §2: ali je obstoječi AP viden v uporabniškem obsegu? ENAK predikat
 * kot seznam /api/expenses (locationScope) — list↔replay konsistentnost: kar
 * uporabnik vidi na seznamu, sme dobiti kot duplicate odgovor; kar ne vidi → 409.
 */
async function apVisibleInScope(user: AuthPayload, apId: string): Promise<boolean> {
  const visible = await db.accountsPayable.findFirst({
    where: { id: apId, ...(await locationScope(user)) },
    select: { id: true },
  })
  return visible != null
}

/**
 * Issue #65: ali se finančni payload uvoza ujema z obstoječim AP? Zneski v
 * centih (šum float), datum na DAN (samo če ga XML nosi — fallback 'now' ni
 * dokaz razlike), vrstice po vrstnem redu kreiranja (= vrstni red XML).
 * Vrača null (ujemanje) ali ime first-mismatch polja (za sporočilo).
 */
function eslogPayloadMismatch(
  ap: {
    invoiceDate: Date
    subtotal: unknown
    vatAmount: unknown
    totalAmount: unknown
    AccountsPayableLine?: { quantityInvoiced: unknown; unitPriceInvoiced: unknown; vatRateInvoiced: unknown }[]
  },
  inv: EslogInvoice
): string | null {
  const cents = (v: unknown) => Math.round(Number(v) * 100)
  const derived = totalsFromLines(inv)
  const sub = Number.isFinite(inv.subtotal) ? inv.subtotal : derived.subtotal
  const vat = Number.isFinite(inv.vatTotal) ? inv.vatTotal : derived.vatAmount
  const tot = Number.isFinite(inv.total) ? inv.total : derived.totalAmount
  if (cents(ap.subtotal) !== cents(sub)) return 'znesek brez DDV'
  if (cents(ap.vatAmount) !== cents(vat)) return 'DDV'
  if (cents(ap.totalAmount) !== cents(tot)) return 'skupni znesek'
  if (inv.issueDate && !isNaN(new Date(inv.issueDate).getTime())) {
    const b = new Date(inv.issueDate)
    const a = ap.invoiceDate
    if (a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()) {
      return 'datum računa'
    }
  }
  const lines = ap.AccountsPayableLine ?? []
  if (lines.length !== inv.lines.length) return 'število vrstic'
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const x = inv.lines[i]
    // Issue #18: dobropisne vrstice so shranjene S PREDZNAKOM (negativno) —
    // isti XML poda enako predznakano vrednost
    const expectedQty = x.credited ? -x.quantity : x.quantity
    if (Math.round(Number(l.quantityInvoiced) * 10000) !== Math.round(expectedQty * 10000)) return `vrstica ${i + 1}: količina`
    if (cents(l.unitPriceInvoiced) !== cents(x.unitPrice)) return `vrstica ${i + 1}: cena`
    if (Math.round(Number(l.vatRateInvoiced) * 100) !== Math.round(x.vatRate * 100)) return `vrstica ${i + 1}: DDV stopnja`
  }
  return null
}

/** Response echo without the heavy base64 payloads (metadata only, additive). */
function parsedEcho(inv: EslogInvoice): Omit<EslogInvoice, 'attachments'> & { attachments: ApAttachmentMeta[] } {
  return {
    ...inv,
    attachments: (inv.attachments || []).map((a) => ({
      mimeCode: a.mimeCode,
      filename: a.filename,
      sizeB: Math.floor((a.dataBase64.replace(/\s+/g, '').length * 3) / 4),
    })),
  }
}

/**
 * OPS-10 val 3 — persist the embedded attachments for the AP archive (best-effort).
 * NEVER fails the import; appends the oversize note to AP.notes when a payload
 * exceeded the 1.5 MB config budget. Returns the number of archived attachments.
 */
async function saveAttachments(userId: string, apId: string, apNumber: string, apNotes: string, inv: EslogInvoice): Promise<number> {
  try {
    const atts = inv.attachments || []
    if (atts.length === 0) return 0
    const { entry, truncated, droppedBytes } = await upsertApAttachments(apNumber, atts)
    const saved = entry?.attachments.length ?? 0
    if (saved === 0) return 0
    if (truncated && droppedBytes > 0) {
      const base = (apNotes || '').trim()
      await db.accountsPayable
        .update({ where: { id: apId }, data: { notes: `${base} ${oversizeNote(droppedBytes)}`.trim() } })
        .catch(() => undefined)
    }
    await writeAudit(db, { userId: userId, action: 'ESLOG_ATTACHMENTS_SAVED', entityType: 'AccountsPayable', entityId: apId, details: jstr({ apNumber, saved, truncated, droppedBytes }) })
    return saved
  } catch (e) {
    // archive must never break the import — details only
    console.warn('[import-eslog] attachment archive failed (ignored):', String((e as Error).message || e))
    return 0
  }
}

function apResponse(ap: {
  id: string
  apNumber: string
  supplierId: string
  invoiceNumber: string
  invoiceDate: Date
  dueDate: Date
  subtotal: unknown
  vatAmount: unknown
  totalAmount: unknown
  status: string
  matchStatus: string
}) {
  return {
    id: ap.id,
    apNumber: ap.apNumber,
    supplierId: ap.supplierId,
    invoiceNumber: ap.invoiceNumber,
    invoiceDate: ap.invoiceDate,
    dueDate: ap.dueDate,
    subtotal: Number(ap.subtotal),
    vatAmount: Number(ap.vatAmount),
    totalAmount: Number(ap.totalAmount),
    status: ap.status,
    matchStatus: ap.matchStatus,
  }
}

/** Fallback totals from lines when the XML header amounts are missing/unparseable.
 *  Issue #18: vrstice dobropisa so predznačene negativno (kumulativa se ZMANJŠA). */
function totalsFromLines(inv: EslogInvoice): { subtotal: number; vatAmount: number; totalAmount: number } {
  let subtotal = 0
  let vatAmount = 0
  for (const l of inv.lines) {
    const lineSign = l.credited ? -1 : 1
    const net = (Math.round(l.quantity * l.unitPrice * 100) / 100) * lineSign
    const gross = apLineTotalGross(l.quantity, l.unitPrice, l.vatRate) * lineSign
    subtotal += net
    vatAmount += Math.round((gross - net) * 100) / 100
  }
  subtotal = Math.round(subtotal * 100) / 100
  vatAmount = Math.round(vatAmount * 100) / 100
  return { subtotal, vatAmount, totalAmount: Math.round((subtotal + vatAmount) * 100) / 100 }
}

type ExistingAp = {
  id: string
  apNumber: string
  supplierId: string
  invoiceNumber: string
  invoiceDate: Date
  dueDate: Date
  subtotal: unknown
  vatAmount: unknown
  totalAmount: unknown
  status: string
  matchStatus: string
  notes: string | null
  locationId: string | null
  AccountsPayableLine?: { quantityInvoiced: unknown; unitPriceInvoiced: unknown; vatRateInvoiced: unknown }[]
}

/**
 * Issue #65: enoten duplicate/conflict odgovor (pre-check hit + P2002 zmagoval).
 * 1. obseg: tuj AP → 409 BREZ apNumber/dobavitelja/zneska (ključ ni poverilnica);
 * 2. dokumentni konflikt: isti ključ, drugačen finančni payload → 409 (NE prekrijem);
 * 3. legitimni replay: duplicate:true + idempotentna arhivacija priponk.
 */
async function eslogDuplicateResponse(user: AuthPayload, existing: ExistingAp, inv: EslogInvoice): Promise<NextResponse> {
  if (!(await apVisibleInScope(user, existing.id))) {
    // varnostni dogodek v verigo (brez zneskov tujega AP — le klientovi lastni vnosi)
    await writeAudit(db, {
      userId: user.sub, action: 'ESLOG_IMPORT_BLOCKED', entityType: 'AccountsPayable', entityId: existing.id,
      details: jstr({ reason: 'scope', invoiceNumber: existing.invoiceNumber, supplierId: existing.supplierId, by: user.name }),
      locationId: user.loc ?? undefined,
    })
    return fail('Račun s to številko je že uvožen v drugem kontekstu (druga lokacija/organizacija) — uvoz zavrnjen.', 409)
  }
  const mismatch = eslogPayloadMismatch(existing, inv)
  if (mismatch) {
    return ok({
      conflict: true,
      error: `Uvožen račun s to številko ima drugačne podatke (${mismatch}) — obstoječi zapis ni bil spremenjen. Preverite obstoječi AP, dobropis ali korigirani račun.`,
      ap: apResponse(existing),
    }, 409)
  }
  // OPS-10 val 3: archive attachments also for a duplicate hit (idempotent merge;
  // covers invoices first imported before the attachment support existed)
  const attachmentsSaved = await saveAttachments(user.sub, existing.id, existing.apNumber, existing.notes || '', inv)
  return ok({ duplicate: true, ap: apResponse(existing), attachmentsSaved })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user

  const body = await req.json().catch(() => null)
  if (!body || typeof body.xml !== 'string') return fail('Manjka XML vsebina e-računa.', 400)
  const xml = body.xml
  if (xml.length > MAX_XML_BYTES) return fail('XML datoteka je prevelika (največ 2 MB).', 413)

  const parsedResult = parseEslog(xml)
  if (!parsedResult.invoice) {
    return ok({ error: parsedResult.error || 'Nepoznana struktura e-računa.', parsed: null }, 422)
  }
  const inv = parsedResult.invoice

  if (!inv.supplier.taxId) {
    return ok({ error: 'E-račun nima davčne številke dobavitelja — ni mogoče najti dobavitelja.', parsed: inv }, 422)
  }

  // supplier match: digits-only comparison (Supplier.taxId may carry an SI prefix)
  const suppliers = await db.supplier.findMany({
    select: { id: true, name: true, taxId: true, paymentTerms: true, isActive: true },
  })
  const supplier = suppliers.find((s) => String(s.taxId ?? '').replace(/\D/g, '') === inv.supplier.taxId) || null
  if (!supplier) {
    return ok(
      {
        error: `Dobavitelj z davčno številko ${inv.supplier.taxId} ni najden. Najprej ustvari dobavitelja.`,
        parsed: inv,
      },
      422,
    )
  }

  // idempotency (#65): isti kanonični dokument (supplierId + normalizirana
  // invoiceNumber) — hitra pot; sočasnost varuje deterministični AP id (PK claim)
  const invoiceNumber = normalizeInvoiceNumber(inv.invoiceNumber)
  const canonicalId = eslogApId(supplier.id, invoiceNumber)
  const existing = await db.accountsPayable.findFirst({
    where: { supplierId: supplier.id, invoiceNumber },
    include: { AccountsPayableLine: true },
  })
  if (existing) {
    // #65 §2: globalna identiteta dobavitelja ≠ dovoljenje — duplicate/replay
    // vrača SAMO AP lastnega obsega (isti predikat kot seznam /api/expenses);
    // tuj AP → 409 brez apNumber/dobavitelja/zneska; spremenjen payload → konflikt.
    return eslogDuplicateResponse(user, existing, inv)
  }

  // dates: issueDate/dueDate as written in XML (yyyy-mm-dd); fallbacks = today + payment terms
  const now = new Date()
  const invoiceDate = inv.issueDate && !isNaN(new Date(inv.issueDate).getTime()) ? new Date(inv.issueDate) : now
  const dueDateParsed = inv.dueDate && !isNaN(new Date(inv.dueDate).getTime()) ? new Date(inv.dueDate) : null
  const dueDate = dueDateParsed ?? new Date(invoiceDate.getTime() + parsePaymentTermsDays(supplier.paymentTerms) * 86400000)

  const derived = totalsFromLines(inv)
  const subtotal = Number.isFinite(inv.subtotal) ? inv.subtotal : derived.subtotal
  const vatAmount = Number.isFinite(inv.vatTotal) ? inv.vatTotal : derived.vatAmount
  const totalAmount = Number.isFinite(inv.total) ? inv.total : derived.totalAmount

  // Issue #18: vrstice dobropisa (CreditNoteLine) se shranijo S PREDZNAKOM —
  // negativna količina/vrednost (kumulativna fakturirana količina se zmanjša)
  const apLines = inv.lines.map((l) => {
    const lineSign = l.credited ? -1 : 1
    return {
      description: l.name || invoiceNumber,
      quantityInvoiced: l.quantity * lineSign,
      unitPriceInvoiced: l.unitPrice,
      vatRateInvoiced: l.vatRate,
      lineTotal: apLineTotalGross(l.quantity, l.unitPrice, l.vatRate) * lineSign,
    }
  })

  const year = now.getFullYear()
  let ap: Awaited<ReturnType<typeof createAp>> | null = null
  for (let attempt = 0; attempt < 5 && !ap; attempt++) {
    const seq = (await db.accountsPayable.count({ where: { apNumber: { startsWith: `AP-${year}-` } } })) + 1 + attempt
    try {
      ap = await createAp({ supplierId: supplier.id, invoiceDate, dueDate, subtotal, vatAmount, totalAmount, invoiceNumber, apLines, seq, locationId: user.loc || null, id: canonicalId })
    } catch (e) {
      // Issue #65: sočasni uvoz istega dokumenta — deterministični AP id (kanonični
      // ključ) je že prevzel zmagovalni poskus → preberi zmagovalca in vrni replay
      // SAMO po obsežni + dokumentni preverbi (ključ ni poverilnica). P2002 na
      // apNumber (števljenje) → zmagovalca NI → nadaljuj retry zanko z naslednjim seq.
      if ((e as { code?: string })?.code === 'P2002') {
        const winner = await db.accountsPayable.findFirst({
          where: { supplierId: supplier.id, invoiceNumber },
          include: { AccountsPayableLine: true },
        })
        if (winner) return eslogDuplicateResponse(user, winner, inv)
      }
      const msg = String((e as Error).message || '')
      if (msg.includes('apNumber') && attempt < 4) continue // concurrent numbering — retry
      throw e
    }
  }
  if (!ap) return fail('Uvoz računa ni uspel (številčenje).', 500)

  // OPS-10 val 3 — best-effort attachment archive (never fails the import)
  const attachmentsSaved = await saveAttachments(user.sub, ap.id, ap.apNumber, ap.notes || '', inv)

  // Issue #18 — tristransko ujemanje ob uvozu:
  //  1. deterministična samodejna povezava VRSTIC na PO postavke istega dobavitelja
  //     v obsegu AP (SAMO točna ujemanja: normaliziran opis + DDV + količinska
  //     smiselnost; vse ostalo je predlog za ročno potrditev v /api/ap/[id]/match);
  //  2. evalvacija PO ↔ GRN ↔ vrstice → kanonični matchStatus (matched /
  //     review_required / blocked) + varianceStatus/varianceNote vrstic.
  //     Napake NE podrejo uvoza (račun obstaja; stanje se vidi v Stroških).
  let linesAutoLinked = 0
  try {
    // obseg kandidatov = uporabnikov locationScope (centralni uvoz NE poveže
    // vrstic na PO-je tuje organizacije)
    linesAutoLinked = await autoLinkExactMatches(ap.id, user.sub, await locationScope(user))
  } catch (e) {
    console.warn('[import-eslog] auto-link ni uspel (račun ostaja uvožen):', String((e as Error).message || e))
  }
  let matchEvaluated = false
  try {
    const evaluated = await applyApMatchEvaluation(ap.id, { userId: user.sub, reason: 'eslog_import' })
    matchEvaluated = evaluated !== null
  } catch (e) {
    console.warn('[import-eslog] tristranska evalvacija ni uspela (račun ostaja uvožen):', String((e as Error).message || e))
  }

  await writeAudit(db, { userId: user.sub, action: 'ESLOG_IMPORTED', entityType: 'AccountsPayable', entityId: ap.id, details: jstr({
        apNumber: ap.apNumber,
        invoiceNumber, canonicalId,
        documentType: inv.documentType || 'invoice',
        linesAutoLinked,
        matchEvaluated,
        supplierId: supplier.id,
        supplierName: supplier.name,
        supplierTaxId: inv.supplier.taxId,
        subtotal,
        vatAmount,
        totalAmount,
        lines: apLines.length,
        dueDate: dueDate.toISOString(),
        locationId: user.loc || null,
      }) })

  // OPS-11 val 2 (v1.81.0) — AP_NEW push (new supplier invoice recorded). Fire-and-forget,
  // notification-matrix aware; pushEvent swallows its own errors so the import NEVER fails
  // because of push. Only on the fresh-create path — a duplicate hit is a silent no-op.
  void pushEvent(
    'AP_NEW',
    apNewPushPayload({ apNumber: ap.apNumber, supplierName: supplier.name, amount: totalAmount, dueDate: dueDate.toISOString() }),
    { roles: ['accounting', 'manager'], locationId: user.loc || null },
  )

  return ok({ ap: apResponse(ap), supplier: { id: supplier.id, name: supplier.name }, parsed: parsedEcho(inv), attachmentsSaved, linesAutoLinked, matchEvaluated }, 201)
}

async function createAp(args: {
  supplierId: string
  invoiceDate: Date
  dueDate: Date
  subtotal: number
  vatAmount: number
  totalAmount: number
  invoiceNumber: string
  apLines: { description: string; quantityInvoiced: number; unitPriceInvoiced: number; vatRateInvoiced: number; lineTotal: number }[]
  seq: number
  locationId: string | null
  /** Issue #65: deterministični id iz kanoničnega dokumentnega ključa (PK claim) */
  id: string
}) {
  const { supplierId, invoiceDate, dueDate, subtotal, vatAmount, totalAmount, invoiceNumber, apLines, seq, locationId, id } = args
  return db.$transaction(async (tx) => {
    return tx.accountsPayable.create({
      data: {
        id,
        apNumber: apNumberFor(new Date().getFullYear(), seq),
        supplierId,
        invoiceNumber,
        invoiceDate,
        dueDate,
        subtotal,
        vatAmount,
        totalAmount,
        status: 'open',
        matchStatus: 'auto',
        notes: `Uvoženo iz eSLOG računa ${invoiceNumber}`,
        locationId,
        AccountsPayableLine: {
          create: apLines.map((l) => ({ id: nid(), ...l })),
        },
      },
      include: { AccountsPayableLine: true },
    })
  })
}
