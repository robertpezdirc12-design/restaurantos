import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isCentralRole, isResponse, ok, fail, forbidden } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { mapOrder, mapOrderItem, nid, num, r2, itemStatusToDB, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { recalcOrderTotals, claimMutableOrder } from '@/lib/ops'
import { loadModifierContext, validateItemModifiers, ResolvedModifierOut } from '@/lib/modifiers'
import { buildAllergenSnapshots, sanitizeAllergenWarning } from '@/lib/allergen-profile'
import { vatFromGross } from '@/lib/billing'
import { parseSeatOption } from '@/lib/seat-assignments'
import { exceptionPolicy, amountAboveThreshold } from '@/lib/exception-policy'
import {
  validateExceptionReason,
  resolveExceptionApproval,
  reasonAuditFields,
  approvalAuditFields,
  type ReasonEvidence,
  type ApprovalEvidence,
} from '@/lib/exception-approval'
import type { Prisma } from '@prisma/client'

const orderInclude = {
  // OSS-10 B-del (v1.210.0): + OrderItemModifier (imena izbranih opcij) — aditivno:
  // mapOrderItem brez relacije polje izpusti (undefined), z relacijo nosi imena —
  // isti vzorec kot ops.ts orderInclude od v1.209.0 (list urejevalnika pokaže
  // velikost/dodatek tudi po osvežitvi naročila).
  OrderItem: { include: { MenuItem: { include: { PrepStation: true } }, OrderItemModifier: { select: { name: true } } } },
  Table: true,
  Employee_Order_employeeIdToEmployee: { select: { id: true, name: true, role: true } },
  Receipt: { orderBy: { createdAt: 'desc' as const } },
} as const

function normalize(o: Record<string, unknown>) {
  return {
    ...o,
    items: o.OrderItem,
    table: o.Table,
    employee: o.Employee_Order_employeeIdToEmployee,
  } as Parameters<typeof mapOrder>[0]
}

/* Issue #5: recalcTotals prestavljen v src/lib/ops.ts (recalcOrderTotals) — skupni
   vir za PATCH in preklic posamezne postavke (/api/orders/[id]/void). */
const recalcTotals = recalcOrderTotals

/** OSS-10 B-del (v1.210.0): zavrnitev opcij (v map() ni mogoče return fail) —
 *  nosi natanko sporočilo validacije (»Skupina … je obvezna …«) → 400. */
class ModifierValidationError extends Error {}

/*
 * ── STATE MACHINE NAROČILA (issue #47 + #48 — ena dokumentirana matrika) ─────────
 * Order.status:   open ──► sent ──► prepared ──► paid  (SAMO kanonična izdaja:
 *                 issueFursReceipt / paylink settle — Payment + Receipt + EOR +
 *                 razknjižba zaloge v isti transakciji)
 *                 open/sent/prepared so medsebojno prehodni (kitchen.update —
 *                 KDS lahko stanje vrne nazaj; operativni bounce)
 *                 paid      = TERMINALNO (fiskalni storno: /api/receipts/[id]/storno)
 *                 cancelled = TERMINALNO (PATCH status CANCELLED ali DELETE — samo
 *                 vodstvo, iz aktivnega statusa + unpaid/partial; odprte plačilne
 *                 povezave se prekličejo skupaj z naročilom)
 * Order.paymentStatus: unpaid ─► partial (paylink delna plačila) ─► paid (kanonično)
 *                 storno    = terminalno (fiskalni storno — negacija računa)
 *                 cancelled = terminalno (preklic naročila iz 'unpaid'; 'partial'
 *                 ostane, ker so delna plačila že v Payment vrsticah)
 * Mutacije po pravilih matrike:
 *  - PATCH status:    ročni PAID UKINJEN (#47); terminalna stanja zavračajo VSE
 *                     prehode (#48); CANCELLED dovoljen samo iz aktivnega statusa
 *                     + paymentStatus unpaid/partial. OD v1.145.0 (audit #10) se
 *                     stanje zapiše SAMO z CAS claimom (claimMutableOrder) in vsi
 *                     stranski učinki preklica so v isti transakciji ZA claimom —
 *                     pogoji se ne preverjajo le ob prihodu, ampak ob zapisu;
 *  - PATCH addItems:  CAS bela lista — status IN (open,sent,prepared) AND
 *                     paymentStatus IN (unpaid,partial); dirka s preklicom/plačilom
 *                     = rollback transakcije, BREZ delnih zapisov (#48);
 *  - PATCH note/customerName: vsebina naročila (orders.create) — dovoljeno tudi na
 *                     terminalnem naročilu (opomba za zgodovino, ne stanje);
 *  - DELETE:          preklic (isti pogoji kot PATCH CANCELLED); paid/storno → 409;
 *  - POST /void:      posamezna postavka — paid/storno/cancelled → 409 (ločena pot);
 *  - POST /api/furs:  issueFursReceipt CAS paymentStatus IN (unpaid,partial) +
 *                     idempotentni replay (clientOperationId); storno/cancelled
 *                     vnosi zavrnjeni na vhodu;
 *  - POST …/paylink:  izdaja samo za aktivna naročila (status bela lista) +
 *                     paymentStatus unpaid (reissue tudi partial-samo-iz-povezav).
 * ────────────────────────────────────────────────────────────────────────────────
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const order = await db.order.findUnique({ where: { id }, include: orderInclude })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate (prej: katerikoli staff je mogel brati naročilo katerekoli lokacije)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  return ok({ order: mapOrder(normalize(order)) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await params
  const body = await req.json().catch(() => null)

  // Granularne pravice (issue #1) — glede na vrsto spremembe:
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    const gate = await requirePermission(req, 'orders.create')
    if (isResponse(gate)) return gate
  } else if (body?.status) {
    // (podveje spodaj)
    if (body.status === 'PAID' || body.status === 'CANCELLED') {
      // plačilo/veljavnost mimo plačilnega poteka = samo vodstvo
      // P2 audit N2: OWNER je centralna vloga — sme tudi ročno override (prej samo ADMIN/MANAGER)
      if (!isCentralRole(user) && user.role !== 'MANAGER') return forbidden()
    } else {
      const gate = await requirePermission(req, 'kitchen.update')
      if (isResponse(gate)) return gate
    }
  } else if (body?.note !== undefined || body?.customerName !== undefined) {
    // Issue #5 (P0, komentar #3): opomba/stranka sta VSEBINA naročila — prej brez
    // pravice (vsak prijavljeni, tudi čistilka, je lahko spreminjal tudi na plačanih)
    const gate = await requirePermission(req, 'orders.create')
    if (isResponse(gate)) return gate
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: location gate na VSAKO spremembo (prej: PATCH brez body akcije je bil prazen gate)
  const locGuard = await guardResource(user, order.locationId)
  if (locGuard) return locGuard
  const recognized = Array.isArray(body?.addItems) || body?.status !== undefined || body?.note !== undefined || body?.customerName !== undefined
  if (!recognized) return fail('Ni prepoznane akcije (addItems | status | note | customerName).', 400)

  // v1.145.0 (audit #10): dokaz o izjemi za preklic se izračuna tukaj (pred
  // zapisom), ZAPIŠE pa se šele ob uspelem CAS claimu — glej konec funkcije.
  let cancelReason: ReasonEvidence | null = null
  let cancelApproval: ApprovalEvidence | null = null
  let cancelApprovalBasis: string | null = null

  const data: Record<string, unknown> = {}
  if (body?.status && ['OPEN', 'SENT', 'PREPARED', 'PAID', 'CANCELLED'].includes(body.status)) {
    // Issue #47: ROČNI STATUS PAID JE UKINJEN. Prej je override nastavil status 'paid' +
    // paymentStatus 'paid' + paidAt BREZ Payment/Receipt/EOR/razknjižbe — 'plačano brez
    // dokaza', ki je hkrati BLOKIRAL kanonično pot (issueFursReceipt CAS zahteva
    // unpaid/partial → 409 'plačano brez računa': naročilo se je za fiskalno izdajo
    // nepovratno zaprlo). Nadomestni poti: plačilni zavihek (kanonično — Payment +
    // račun z EOR + razknjižba) oz. vnos kartice z odobritveno kodo za izgubljen
    // odgovor terminala (processTerminalPayment manual = obstoječa reconciliation pot
    // z approvalCode sledljivostjo).
    if (body.status === 'PAID') {
      return fail('Ročni status PAID ni več podprt — plačilo izvedite prek plačilne poti (ustvari Payment, račun z EOR in razknjižbo zaloge); za izgubljen odgovor terminala uporabite vnos kartice z odobritveno kodo.', 409)
    }
    // Issue #48: TERMINALNA MATRIKA — paid/cancelled sta terminalna za vsak ročni PATCH
    // (prej: CANCELLED → OPEN/SENT/PREPARED in PAID → SENT sta bila možna prek navadnega
    // status PATCH-a; takšno naročilo je ostalo neuporabno za zakoniti zaključek, ker
    // kanonična pot nato zavrača kombinacijo status/paymentStatus).
    if (order.status === 'cancelled') {
      return fail('Preklicano naročilo je terminalno — statusa ni mogoče spreminjati. Ustvarite novo naročilo.', 409)
    }
    if (order.status === 'paid') {
      return fail('Plačano naročilo je terminalno — spremembe potekajo le prek fiskalnega storna/vračila.', 409)
    }
    // R10 popravek (P0 audit) + Issue #48: preklic je možen samo iz ne-terminalnega
    // plačilnega stanja ('partial' ostaja možen — delna plačila prek povezav so že v
    // Payment vrsticah; preklic takšnega naročila je popolnoma auditiran).
    if (body.status === 'CANCELLED' && ['paid', 'storno', 'cancelled'].includes(order.paymentStatus)) {
      return fail('Plačanega/storniranega naročila ni mogoče preklicati prek statusa — fiskalni storno/vračilo je ločena pot.', 409)
    }
    data.status = body.status.toLowerCase()
    if (body.status === 'CANCELLED') {
      // Issue #19 (v1.107.0): preklic naročila je finančna izjema → obvezen
      // razlog (politika excRequireReasonCancel, privzeto TRUE) + prag odobritve
      // (excCancelApprovalAmountCents, privzeto 0 = izklopljen; vodstvena
      // izvajalska vloga šteje kot odobritev, sicer poverilnica DRUGE osebe).
      const excPolicy = await exceptionPolicy()
      if (excPolicy.requireReasonCancel) {
        const rr = await validateExceptionReason('cancel', order.locationId, body)
        if (!rr.ok) return fail(rr.message, rr.status)
        cancelReason = rr.reason
      }
      if (amountAboveThreshold(num(order.total), excPolicy.cancelApprovalAmountCents)) {
        cancelApprovalBasis = `amount ${num(order.total).toFixed(2)} > ${(excPolicy.cancelApprovalAmountCents / 100).toFixed(2)}`
        const aa = await resolveExceptionApproval(user, order.locationId, body)
        if (!aa.ok) return fail(aa.message, aa.status)
        cancelApproval = aa.approval
      }
      data.cancelledAt = new Date()
      data.cancelledBy = user.name
      data.cancelledById = user.sub
      // Issue #48: preklic spravi plačilno stanje v terminalno 'cancelled' (samo iz
      // 'unpaid' — 'partial' ostane: delna plačila prek povezav so že v Payment tabeli).
      if (order.paymentStatus === 'unpaid') data.paymentStatus = 'cancelled'
      // v1.145.0 (audit #10): stranski učinki preklica (razveljavitev plačilnih
      // povezav, miza, revizijski zapis) so PRESELJENI za uspehen CAS claim — glej
      // konec funkcije. Prej so se zgodili PRED zapisom, zato je dirka s plačilom
      // pustila gostu brez veljavne povezave in v bazi lažen sled.
    }
  }
  if (body?.note !== undefined) data.notes = body.note
  if (body?.customerName !== undefined) data.customerName = body.customerName

  // dodajanje artiklov v odprto naročilo
  if (Array.isArray(body?.addItems) && body.addItems.length > 0) {
    // Issue #48: terminalno naročilo zavrnemo PRED obdelavo (CAS znotraj transakcije
    // ostaja avtoritativen za sočasne dirke): sprejemljivi so SAMO aktivni statusi
    // (open/sent/prepared) in neplačljivi paymentStatus (unpaid/partial).
    if (['paid', 'cancelled'].includes(order.status) || !['unpaid', 'partial'].includes(order.paymentStatus)) {
      return fail('Naročilo je zaključeno (plačano, preklicano ali stornirano) — postavk ni mogoče dodati.', 409)
    }
    const menuItems = await db.menuItem.findMany({
      where: {
        id: { in: body.addItems.map((i: { menuItemId: string }) => i.menuItemId) },
        isAvailable: true,
        // Issue #4 §1: artikel mora pripadati lokaciji naročila (prek Category→Menu)
        Category: { Menu: { locationId: order.locationId } },
      },
    })
    /* OSS-10 B-del (v1.210.0): addItems zdaj podpira opcije/variante — ISTA
       validacija kot createOrderCore (relacija artikel→skupina→modifier,
       required/minSelect/maxSelect, cene IZ DB — client cena se ignorira).
       Obvezna skupina brez izbire → 400 z natanko razlago (vzorec sedežne
       validacije zgoraj: PRED transakcijo, z razumljivim sporočilom). */
    const addItemsBody = body.addItems as {
      menuItemId: string
      qty?: number
      note?: string
      allergenWarning?: string
      seat?: unknown
      modifiers?: { modifierId?: unknown }[]
    }[]
    const chosenOf = (i: { modifiers?: { modifierId?: unknown }[] }): string[] =>
      (i.modifiers || []).map((m) => String(m?.modifierId || '')).filter(Boolean)
    const modIds = [...new Set(addItemsBody.flatMap((i) => chosenOf(i)))].filter(Boolean)
    const modCtx = await loadModifierContext(addItemsBody.map((i) => i.menuItemId), modIds)
    let resolvedByIdx: ResolvedModifierOut[][]
    try {
      resolvedByIdx = addItemsBody.map((i) => {
        const v = validateItemModifiers({
          allowedGroupIds: modCtx.allowedByItem.get(i.menuItemId) || [],
          groupById: modCtx.groupById,
          modById: modCtx.modById,
          chosenIds: chosenOf(i),
        })
        if (!v.ok) throw new ModifierValidationError(v.error || 'Opcije niso veljavne.')
        return v.resolved
      })
    } catch (e) {
      if (e instanceof ModifierValidationError) return fail(e.message, 400)
      throw e
    }
    // Issue #7 (P1, v1.104.0): posnetek alergenskih informacij za dodane postavke
    // (kode jedi ∪ kode IZBRANIH opcij — OSS-10 B-del: izbira opcij je tok).
    const allergenSnapshots = await buildAllergenSnapshots(
      addItemsBody.map((i) => ({ menuItemId: i.menuItemId, chosenModifierIds: chosenOf(i) }))
    ).catch(() => addItemsBody.map(() => '{}'))
    // N-27-1 (v1.195.0): sedežna validacija PRED gradnjo vrstic — 400 z razlogom
    // (ne tiho ignoriranje in ne zamenjava z »Artikel ni na voljo«; izrecno pred
    // transakcijo in izven njenega catch bloka, ki nosi artikel-sporočilo).
    const seatOptions = (addItemsBody as { seat?: unknown }[]).map((i) => parseSeatOption(i.seat))
    for (const s of seatOptions) {
      if (!s.ok) return fail(s.error, 400)
    }
    const modRowsAll: {
      id: string
      orderItemId: string
      name: string
      price: number
      modifierGroupId: string | null
      modifierGroupName: string
      sortOrder: number
    }[] = []
    const rows = addItemsBody.map((i, itemIdx: number) => {
      const mi = menuItems.find((m) => m.id === i.menuItemId)
      if (!mi) throw new Error(`Artikel ni na voljo na tej lokaciji (${i.menuItemId}).`)
      const seat = seatOptions[itemIdx].ok ? (seatOptions[itemIdx] as { ok: true; seat: number | null }).seat : null
      const qty = Math.max(1, Math.round(Number(i.qty) || 1))
      const price = num(mi.price)
      const vatRate = num(mi.vatRate, 22)
      // OSS-10 B-del: opcije se zlijejo v ceno vrstice (isti izračun kot
      // createOrderCore) — recalcTotals bere OrderItem.price, doplačilo teče
      // samodejno; vrstice OrderItemModifier z stabilnimi id-ji (retry-varno,
      // isti vzorec kot vrstice artiklov).
      const rowId = nid()
      const mods = (resolvedByIdx[itemIdx] || []).map((m, idx) => ({
        id: nid(),
        orderItemId: rowId,
        name: m.name.slice(0, 120),
        price: Math.max(0, m.price),
        modifierGroupId: m.modifierGroupId || null,
        modifierGroupName: String(m.groupName || '').slice(0, 120),
        sortOrder: idx,
      }))
      const modsTotal = mods.reduce((s, m) => s + m.price, 0)
      const line = (price + modsTotal) * qty
      if (mods.length) modRowsAll.push(...mods)
      return {
        id: rowId,
        orderId: id,
        menuItemId: mi.id,
        quantity: qty,
        price: price + modsTotal,
        vatRate,
        vatAmount: vatFromGross(line, vatRate),
        menuItemName: mi.name,
        status: itemStatusToDB('PENDING'),
        notes: i.note || '',
        seat,
        allergenSnapshot: allergenSnapshots[itemIdx] || '{}',
        allergenWarning: sanitizeAllergenWarning(i.allergenWarning),
      }
    })
    // R5 popravek (P0 audit) + Issue #48: createMany + recalcTotals + update v ISTI
    // transakciji s CAS — BELA LISTA mutabilnih stanj (status IN paymentStatus, ne
    // samo paymentStatus !== 'paid'): preklicano/stornirano/plačano naročilo ne sme
    // sprejeti postavk niti z direktnim PATCH klicem, sočasna dirka s preklicem/
    // plačilom pa pusti bazo BREZ delnih zapisov (createMany se z rollback-om izniči).
    //
    // Issue #39 (P1) — dodatna optimistična zaščita: zneski se zapišejo SAMO, če so
    // v vrstici še vrednosti, prebrane ZNOTRAJ transakcije (subtotal/tax/total CAS).
    // Sočasen preklic postavke, ki medtem Committira, povzroči rollback + ponovitev
    // (≤3) — sicer bi ta pot preklicano postavko tiho vrnila v NOVEJŠE (napačne)
    // zneske (lost-update pod READ COMMITTED na PostgreSQL/Neon). createMany je
    // ZNOTRAJ transakcije → rollback izniči tudi dodane vrstice, ponovitev jih
    // varno znova ustvari (isti nid-ji so bili povrnjeni).
    try {
      let added = false
      for (let attempt = 1; attempt <= 3 && !added; attempt++) {
        try {
          await db.$transaction(async (tx) => {
            // svež optimistični predpis (skupni zneski) pred mutacijo vrstic
            const cur = await tx.order.findUnique({
              where: { id },
              select: { subtotal: true, tax: true, total: true, tip: true },
            })
            if (!cur) throw new Error('ORDER_NOT_MUTABLE')
            await tx.orderItem.createMany({ data: rows })
            // OSS-10 B-del: vrstice opcij v ISTI transakciji (rollback jih izniči
            // skupaj z artikli); stabilni id-ji preživijo retry brez podvajanja.
            if (modRowsAll.length) await tx.orderItemModifier.createMany({ data: modRowsAll })
            const totals = await recalcTotals(id, tx)
            // #39: totalWithTip ohranja invarianto ≡ total + tip (tip je za
            // neplačana naročila 0; plačilni tok ga nastavi ob zaključku)
            const patch: Record<string, unknown> = { ...totals, totalWithTip: r2(totals.total + num(cur.tip)), ...data }
            if (data.status === undefined && order.status === 'open') patch.status = 'sent'
            const claim = await tx.order.updateMany({
              where: {
                id,
                status: { in: ['open', 'sent', 'prepared'] },
                paymentStatus: { in: ['unpaid', 'partial'] },
                subtotal: cur.subtotal,
                tax: cur.tax,
                total: cur.total,
              },
              data: patch,
            })
            if (claim.count === 0) throw new Error('ORDER_NOT_MUTABLE')
          })
          added = true
        } catch (e) {
          // lost-update dirka (totals se je medtem spremenil, stanje pa je še
          // mutabilno) → retry; terminalno zaprtje pade skozi kot ORDER_NOT_MUTABLE
          if (e instanceof Error && e.message === 'ORDER_NOT_MUTABLE') {
            const fresh = await db.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true } })
            const mutable = fresh && ['open', 'sent', 'prepared'].includes(fresh.status) && ['unpaid', 'partial'].includes(fresh.paymentStatus)
            if (!mutable || attempt === 3) {
              return fail('Naročilo je zaključeno (plačano, preklicano ali stornirano) — postavk ni mogoče dodati.', 409)
            }
            continue
          }
          throw e
        }
      }
    } catch (e) {
      return fail('Artikel ni na voljo na lokaciji naročila.', 400)
    }
    const updatedAfterAdd = await db.order.findUnique({ where: { id }, include: orderInclude })
    if (!updatedAfterAdd) return fail('Naročilo ne obstaja.', 404)
    if (updatedAfterAdd.status === 'paid') {
      await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updatedAfterAdd.id, payload: { total: updatedAfterAdd.total, locationId: updatedAfterAdd.locationId }, locationId: updatedAfterAdd.locationId }).catch(() => undefined)
    }
    if (updatedAfterAdd.status === 'cancelled') {
      await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updatedAfterAdd.id, payload: { by: user.name, locationId: updatedAfterAdd.locationId }, locationId: updatedAfterAdd.locationId }).catch(() => undefined)
    }
    return ok({ order: mapOrder(normalize(updatedAfterAdd)) })
  }

  // v1.145.0 (audit #10, P1): SPREMEMBA STANJA je sedaj CAS. Prej je bila pot
  // "preberi → preveri terminalna stanja → brezpogojni update", med branjem
  // (:115) in zapisom pa je kanonična plačilna pot (issueFursReceipt / paylink
  // settle) lahko commitnila — rezultat: fiskaliziran račun z EOR-jem na
  // 'cancelled' naročilu ALI plačano naročilo vrnjeno v 'prepared' (KDS klik).
  // Stranski učinki preklica so v ISTI transakciji ZA claimom, zato izgubljena
  // dirka pusti bazo NESPREMENJENO (brez "preklica, ki se ni zgodil" — brez
  // supersede povezav, brez premika mize, brez lažnega revizijskega zapisa).
  // Opomba/stranka (vsebina, ne stanje) ostata pisalni tudi na terminalnem
  // naročilu — dokumentirana matrika zgoraj.
  if (data.status !== undefined) {
    const isCancel = data.status === 'cancelled'
    const applied = await db.$transaction(async (tx) => {
      const claim = await claimMutableOrder(tx, id, data as Prisma.OrderUncheckedUpdateManyInput, order)
      if (!claim.ok) return null
      if (isCancel) {
        // Issue #48: odprte plačilne povezave se prekličejo skupaj z naročilom — gost
        // ne more plačati preklicanega naročila prek QR povezave.
        await tx.payLink.updateMany({ where: { orderId: id, status: 'open' }, data: { status: 'superseded' } })
        if (claim.tableId) await tx.table.update({ where: { id: claim.tableId }, data: { status: 'cleaning' } })
        // P0 audit (C2): ročni preklic statusa = finančna akcija → obvezen audit
        // #19: razlog (posnetek) + odobritev (če je prag aktiven) + znesek
        await writeAudit(tx, { userId: user.sub, action: 'ORDER_STATUS_CANCELLED_OVERRIDE', entityType: 'Order', entityId: id, details: jstr({ orderNumber: order.orderNumber, total: num(order.total), previousStatus: order.status, previousPaymentStatus: order.paymentStatus, by: user.name, ...reasonAuditFields(cancelReason), ...approvalAuditFields(cancelApproval, cancelApprovalBasis) }), locationId: order.locationId })
      }
      return tx.order.findUnique({ where: { id }, include: orderInclude })
    })
    if (!applied) return fail('Naročilo je medtem zaključeno (plačano, preklicano ali stornirano) — stanja ni mogoče spremeniti.', 409)
    const updated = applied
    // Issue #11 §3 — plačilo/storno dogodki (fire-and-forget, nikoli ne vplivata na odgovor)
    if (updated.status === 'paid') {
      await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updated.id, payload: { total: updated.total, locationId: updated.locationId }, locationId: updated.locationId }).catch(() => undefined)
    }
    if (updated.status === 'cancelled') {
      await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updated.id, payload: { by: user.name, locationId: updated.locationId }, locationId: updated.locationId }).catch(() => undefined)
    }
    return ok({ order: mapOrder(normalize(updated)) })
  }

  const updated = await db.order.update({ where: { id }, data, include: orderInclude })
  // Issue #11 §3 — plačilo/storno dogodki (fire-and-forget, nikoli ne vplivata na odgovor)
  if (updated.status === 'paid') {
    await publishEvent('PaymentCompleted', { entityType: 'Order', entityId: updated.id, payload: { total: updated.total, locationId: updated.locationId }, locationId: updated.locationId }).catch(() => undefined)
  }
  if (updated.status === 'cancelled') {
    await publishEvent('OrderCancelled', { entityType: 'Order', entityId: updated.id, payload: { by: user.name, locationId: updated.locationId }, locationId: updated.locationId }).catch(() => undefined)
  }
  return ok({ order: mapOrder(normalize(updated)) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  // storno naročila = samo vodstvo (issue #1: pravice na kritičnih operacijah)
  // P2 audit N2: OWNER je centralna vloga — sme tudi storno (prej samo ADMIN/MANAGER)
  if (!isCentralRole(user) && user.role !== 'MANAGER') return forbidden()
  const { id } = await params
  // #19: telo nosi razlog preklica (obvezna izjema; negativne preverbe ostanejo pred)
  const body = await req.json().catch(() => null)
  const order = await db.order.findUnique({ where: { id } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  // Issue #4 §1: lokacijski gate na storno
  const delGuard = await guardResource(user, order.locationId)
  if (delGuard) return delGuard
  // R10 popravek (P0 audit) + Issue #48: storno plačanega/STORNIRANEGA naročila brez
  // razknjižbe/fiskalnega storna je zavrnjen ('storno' paymentStatus = fiskalna negacija).
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'storno') {
    return fail('Plačanega/storniranega naročila ni mogoče stornirati — fiskalni storno/vračilo je ločena pot.', 409)
  }

  // Issue #19 (v1.107.0): preklic (DELETE) je finančna izjema → obvezen razlog
  // (politika excRequireReasonCancel, privzeto TRUE) + prag odobritve (privzeto
  // izklopljen; vodstvena izvajalska vloga = odobritev 'role')
  const excPolicy = await exceptionPolicy()
  let cancelReason: ReasonEvidence | null = null
  if (excPolicy.requireReasonCancel) {
    const rr = await validateExceptionReason('cancel', order.locationId, body)
    if (!rr.ok) return fail(rr.message, rr.status)
    cancelReason = rr.reason
  }
  let cancelApproval: ApprovalEvidence | null = null
  let cancelApprovalBasis: string | null = null
  if (amountAboveThreshold(num(order.total), excPolicy.cancelApprovalAmountCents)) {
    cancelApprovalBasis = `amount ${num(order.total).toFixed(2)} > ${(excPolicy.cancelApprovalAmountCents / 100).toFixed(2)}`
    const aa = await resolveExceptionApproval(user, order.locationId, body)
    if (!aa.ok) return fail(aa.message, aa.status)
    cancelApproval = aa.approval
  }

  // v1.145.0 (audit #11, P1): preklic je sedaj CAS ZNOTRAJ transakcije in pogoje
  // preveri ob ZAPISU, ne le ob prihodu zahtevka. Prej je pot "preberi → guard samo
  // na paymentStatus (paid/storno) → brezpogojni update" pustila dve napaki:
  //  1) sočasno plačilo (issueFursReceipt / paylink settle) je commitnilo med
  //     branjem in zapisom → fiskaliziran račun z EOR-jem je ostal na 'cancelled'
  //     naročilu (plačilo brez storna, izbrisan iz odprtih postavk);
  //  2) drugi DELETE istega naročila je SPET uspel (status 'cancelled' ni bil v
  //     guardu, paymentStatus 'cancelled'/'partial' pa tudi ne) → dvojna
  //     ORDER_CANCELLED revizija z različnima časoma in miza je bila vrnjena v
  //     'cleaning', če jo je medtem zasedlo drugo naročilo.
  // Stranski učinki (supersede povezav, miza, revizija) so za claimom v isti
  // transakciji → zavrnjen preklic ne pusti nobenega sledu.
  type CancelOutcome = 'ok' | 'missing' | 'fiscal' | 'raced'
  const outcome = await db.$transaction<CancelOutcome>(async (tx) => {
    const cur = await tx.order.findUnique({ where: { id }, select: { status: true, paymentStatus: true, tableId: true } })
    if (!cur) return 'missing'
    // R10 + Issue #48 (ponovljeno ob zapisu): fiskalna negacija je ločena pot
    if (cur.paymentStatus === 'paid' || cur.paymentStatus === 'storno') return 'fiscal'
    const claim = await claimMutableOrder(
      tx,
      id,
      // Issue #48: preklic spravi plačilno stanje v terminalno 'cancelled' (iz 'unpaid';
      // 'partial' ostane — delna plačila so že v Payment vrsticah)
      { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user.name, cancelledById: user.sub, ...(cur.paymentStatus === 'unpaid' ? { paymentStatus: 'cancelled' } : {}) },
      cur,
    )
    if (!claim.ok) return 'raced'
    // Issue #48: odprte plačilne povezave se prekličejo skupaj z naročilom (gost ne
    // more plačati preklicanega naročila prek QR povezave)
    await tx.payLink.updateMany({ where: { orderId: id, status: 'open' }, data: { status: 'superseded' } })
    if (claim.tableId) await tx.table.update({ where: { id: claim.tableId }, data: { status: 'cleaning' } })
    // P0 audit (C2): storno naročila je finančna akcija → obvezen revizijski zapis
    // #19: razlog (posnetek) + odobritev (če je prag aktiven)
    await writeAudit(tx, { userId: user.sub, action: 'ORDER_CANCELLED', entityType: 'Order', entityId: id, details: jstr({ orderNumber: order.orderNumber, total: num(order.total), storno: true, by: user.name, ...reasonAuditFields(cancelReason), ...approvalAuditFields(cancelApproval, cancelApprovalBasis) }), locationId: order.locationId })
    return 'ok'
  })
  if (outcome === 'missing') return fail('Naročilo ne obstaja.', 404)
  if (outcome === 'fiscal') return fail('Plačanega/storniranega naročila ni mogoče stornirati — fiskalni storno/vračilo je ločena pot.', 409)
  if (outcome === 'raced') return fail('Naročilo je medtem zaključeno (plačano ali preklicano) — preklic ni mogoč.', 409)
  // Issue #11 §3 — storno dogodek (po commitu: zavrnjen preklic ne sme objaviti dogodka)
  await publishEvent('OrderCancelled', { entityType: 'Order', entityId: order.id, payload: { by: user.name, locationId: order.locationId, storno: true }, locationId: order.locationId }).catch(() => undefined)
  return ok({ cancelled: true })
}
