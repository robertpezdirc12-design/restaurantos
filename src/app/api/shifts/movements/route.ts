import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, forbidden, isCentralRole } from '@/lib/api'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { pushEvent } from '@/lib/push'
import {
  CASH_MOVEMENT_TYPES,
  CASH_MOVEMENT_MIN,
  CASH_MOVEMENT_MAX,
  cashMovementDirection,
  noteRequiredForType,
  cashMovementsAvailable,
  cashPolicy,
  summarizeMovements,
  expectedDrawerCash,
  movementsCsv,
} from '@/lib/cash-movements'
import { isManagerialRole } from '@/lib/exception-approval'
import type { AuthPayload } from '@/lib/auth'

/**
 * Issue #16 (P1/P2, v1.108.0) — blagajniški premiki denarja.
 *
 * GET  ?shiftId=   — zgodovina premikov izmene + povzetek + živo pričakovano
 *                    stanje + politika + katalog NoSaleReason. Slepi popis
 *                    (politika cashBlindCount): NE-vodstveni uporabnik NE
 *                    dobi pričakovanega/povzetka zneskov (razkrite šele po
 *                    oddaji štetja); vodstveni nadzor ostane poln.
 * GET  ?format=csv&from&to — izvoz za računovodstvo (NEPRODAJNI premiki,
 *                    ločeno od prodaje; tenant/lokacijski obseg).
 * POST              — ustvari potrjen premik (idempotencyKey = zaščita pred
 *                    dvojnim klikom/izgubo odgovora). SAMO na ODPRTI izmeni
 *                    (pretekli zaključki se NE preračunavajo).
 * PATCH             — {id, action:'void', reason…} — razveljavitev:
 *                    KOMPENZACIJSKI obratni zapis + status 'voided' na
 *                    originalu (izbris/urejanje sta prepovedana — issue).
 *                    Prag politike → odobritev (resolveExceptionApproval).
 *
 * Dovoljenje: cash.manage (isti POS obseg kot izmene — natakar za bar,
 * blagajnik, vodstvo). Vsi premiki so tenant-obsegani prek izmene/lokacije.
 */

const MAX_NOTE = 500
const MAX_REASON_TEXT = 200

interface MovementDB {
  id: string
  shiftId: string
  locationId: string
  type: string
  direction: string
  amount: unknown
  currency: string
  reasonId: string | null
  reasonName: string
  reasonText: string
  note: string
  userId: string
  userName: string
  deviceId: string
  receiptRef: string
  status: string
  voidedById: string | null
  voidedByName: string
  voidedAt: Date | null
  voidReason: string
  reversalOfId: string | null
  expectedAfter: unknown
  createdAt: Date
}

function mapMovement(m: MovementDB): import('@/lib/cash-movements').CashMovementRow {
  return {
    id: m.id,
    shiftId: m.shiftId,
    locationId: m.locationId,
    type: m.type,
    direction: m.direction,
    amount: num(m.amount),
    currency: m.currency,
    reasonId: m.reasonId,
    reasonName: m.reasonName,
    reasonText: m.reasonText,
    note: m.note,
    userId: m.userId,
    userName: m.userName,
    deviceId: m.deviceId,
    receiptRef: m.receiptRef,
    status: m.status,
    voidedByName: m.voidedByName,
    voidedAt: m.voidedAt,
    voidReason: m.voidReason,
    reversalOfId: m.reversalOfId,
    expectedAfter: num(m.expectedAfter),
    createdAt: m.createdAt,
  }
}

/** Živa gotovinska prodaja izmene do trenutka (fiskalni računi, storno neto). */
async function liveCashSales(locId: string, openedAt: Date): Promise<number> {
  const receipts = await db.receipt.findMany({
    where: { locationId: locId, createdAt: { gte: openedAt }, paymentMethod: 'cash' },
    select: { total: true },
    take: 5000,
  })
  let cash = 0
  for (const rc of receipts) cash += num(rc.total) // storno računi so že negativni
  return Math.round((cash + Number.EPSILON) * 100) / 100
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'cash.manage')
  if (isResponse(user)) return user
  if (!(await cashMovementsAvailable())) {
    return ok({ movements: [], ddlPending: true, policy: { varianceThresholdCents: 0, blindCount: false } })
  }

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  const policy = await cashPolicy()

  /* ── CSV izvoz za računovodstvo (NEPRODAJNI premiki; prodaja = ZReport) ── */
  if (format === 'csv') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const lang = url.searchParams.get('lang') === 'hr' ? 'hr' : 'sl'
    const rows = await db.cashMovement.findMany({
      where: {
        createdAt: {
          gte: from ? new Date(from) : new Date(Date.now() - 30 * 24 * 3600 * 1000),
          lte: to ? new Date(to) : new Date(),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    })
    // tenant filter v pomnilniku (scalar locationId — ista disciplina locationScope)
    const allowed = await allowedLocationIds(user)
    const scoped = rows.filter((m) => allowed === null || allowed.has(m.locationId))
    const csv = movementsCsv(scoped.map((m) => mapMovement(m as MovementDB)), lang)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="cash-movements-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  }

  /* ── zgodovina + povzetek izmene ── */
  const shiftId = url.searchParams.get('shiftId') ?? ''
  if (!shiftId) return fail('Manjka shiftId (ali format=csv).')
  const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
  if (!shift) return fail('Izmena ne obstaja.', 404)
  if (!shift.locationId) return fail('Izmena brez lokacije (legacy) — ni podatkov.', 409)
  if (!shift.locationId) return fail('Izmena brez lokacije (legacy) — ni podatkov.', 409)

  // tenant: centralne vloge širše (org), staff IZKLJUČNO lastna lokacija
  if (!isCentralRole(user)) {
    if (!user.loc || shift.locationId !== user.loc) return forbidden()
  } else {
    const allowed = await allowedLocationIds(user)
    if (allowed !== null && !allowed.has(shift.locationId)) return forbidden()
  }

  const movements = await db.cashMovement.findMany({
    where: { shiftId: shift.id },
    orderBy: { createdAt: 'asc' },
    take: 1000,
  })
  const summary = summarizeMovements(movements.map((m) => ({ ...m, amount: num(m.amount) })))

  // slepi popis: NE-vodstveni uporabnik v blind načinu NE vidi pričakovanega
  // (niti razčlenitve — sicer bi iz vsot izračunal skrivnost)
  const hideExpected = policy.blindCount && !isManagerialRole(user.role) && shift.status === 'open'

  let runningExpected: number | null = null
  if (!hideExpected && shift.status === 'open' && shift.locationId) {
    const cashSales = await liveCashSales(shift.locationId, shift.openedAt)
    runningExpected = expectedDrawerCash(num(shift.startingCash), cashSales, summary.net)
  }

  // katalog razlogov (NoSaleReason — lokacija dejanja; dosedaj speč model)
  const reasons = shift.locationId
    ? await db.noSaleReason.findMany({
        where: { locationId: shift.locationId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        take: 100,
        select: { id: true, name: true },
      })
    : []

  return ok({
    movements: movements.map((m) => mapMovement(m as MovementDB)),
    summary: hideExpected
      ? { count: summary.count, voidedCount: summary.voidedCount, blind: true }
      : { ...summary, blind: false },
    runningExpected,
    shiftStatus: shift.status,
    startingCash: num(shift.startingCash),
    policy: { varianceThresholdCents: policy.varianceThresholdCents, blindCount: policy.blindCount },
    reasons,
  })
}

/**
 * Lokacije, ki jih uporabnik sme videti (ISTA disciplina kot locationScope v
 * api.ts: centralna vloga → organizacija uporabnikove lokacije + nevezane
 * legacy lokacije; neznana org → brez omejitve (null); staff → lastna lokacija).
 */
async function allowedLocationIds(user: AuthPayload): Promise<Set<string> | null> {
  if (!isCentralRole(user)) return new Set([user.loc || '__none__'])
  if (user.role === 'ADMIN' && user.sub === 'bootstrap') return null
  const orgLoc = await db.location.findFirst({
    where: { id: user.loc ?? '__none__' },
    select: { Property: { select: { Brand: { select: { organizationId: true } } } } },
  })
  const orgId = orgLoc?.Property?.Brand?.organizationId ?? null
  if (!orgId) return null // neznana/nevezana org → brez lokacijskega filtra (isti pravilnik)
  const rows = await db.location.findMany({
    where: { OR: [{ Property: { Brand: { organizationId: orgId } } }, { propertyId: null }] },
    select: { id: true },
    take: 500,
  })
  return new Set(rows.map((l) => l.id))
}

/* ───────── POST — ustvari premik ───────── */

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'cash.manage')
  if (isResponse(user)) return user
  if (!(await cashMovementsAvailable())) {
    return fail('Knjiga premikov čaka DDL korak (Enterprise → Shema migracije → cash-movements).', 503)
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Manjkajo podatki.')

  const shiftId = typeof body.shiftId === 'string' ? body.shiftId.trim() : ''
  const type = typeof body.type === 'string' ? body.type.trim() : ''
  if (!shiftId) return fail('Manjka izmena (shiftId).')
  if (!(CASH_MOVEMENT_TYPES as readonly string[]).includes(type)) {
    return fail(`Neznan tip premika (dovoljeni: ${CASH_MOVEMENT_TYPES.join(', ')}).`)
  }

  const shift = await db.cashRegisterShift.findUnique({ where: { id: shiftId } })
  if (!shift) return fail('Izmena ne obstaja.', 404)
  if (shift.status !== 'open') {
    return fail('Premik je mogoče knjižiti SAMO na odprti izmeni — pretekli zaključki se ne preračunavajo.', 409)
  }
  if (!shift.locationId) {
    return fail('Izmena brez lokacije (legacy) — najprej izrecna dodelitev lokacije.', 409)
  }

  // tenant: staff IZKLJUČNO lastna lokacija izmene; centralna vloga org-obseg
  if (!isCentralRole(user)) {
    if (!user.loc) return forbidden()
    if (shift.locationId !== user.loc) return forbidden()
  } else {
    const allowed = await allowedLocationIds(user)
    if (allowed !== null && !allowed.has(shift.locationId)) return forbidden()
  }

  // smer (izpeljana iz tipa; change_fund izrecna)
  const direction = cashMovementDirection(type, body.direction)
  if (!direction) {
    return fail("Za menjalni fond podaj smer ('in' ali 'out').")
  }

  // znesek
  const amount = num(body.amount, NaN)
  if (!Number.isFinite(amount)) return fail('Znesek mora biti število.')
  if (amount < CASH_MOVEMENT_MIN) return fail('Znesek mora biti pozitiven.')
  if (amount > CASH_MOVEMENT_MAX) return fail(`Znesek presega mejo (${CASH_MOVEMENT_MAX} EUR).`)

  // opomba (obvezna za določene tipe)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE) : ''
  if (noteRequiredForType(type) && note.length < 3) {
    return fail('Za ta tip premika je obvezna opomba (vsaj 3 znake).')
  }

  // razlog: katalog NoSaleReason (lokacija dejanja) ALI prosto besedilo
  let reasonId: string | null = null
  let reasonName = ''
  let reasonText = ''
  if (typeof body.reasonId === 'string' && body.reasonId.trim()) {
    const r = await db.noSaleReason.findUnique({ where: { id: body.reasonId.trim() } })
    if (!r || !r.isActive) return fail('Razlog ne obstaja ali ni aktiven.', 400)
    if (r.locationId !== shift.locationId) return fail('Razlog ni veljaven za to lokacijo.', 400)
    reasonId = r.id
    reasonName = r.name // posnetek ob dejanju
  } else if (typeof body.reason === 'string' && body.reason.trim().length >= 3) {
    reasonText = body.reason.trim().slice(0, MAX_REASON_TEXT)
  } else if (type === 'supplier_payment' || type === 'guest_refund') {
    return fail('Razlog je obvezen (izberi iz seznama ali vpiši vsaj 3 znake).')
  }

  // referenca računa (neobvezna): validacija + protidvojno-štetje varovalka
  let receiptRef = ''
  if (typeof body.receiptRef === 'string' && body.receiptRef.trim()) {
    receiptRef = body.receiptRef.trim().slice(0, 64)
    const rcpt = await db.receipt.findUnique({ where: { id: receiptRef } })
    if (!rcpt) {
      // dovolimo številko računa kot referenco (ne id) — le zapišemo
      receiptRef = ''
    } else {
      if (rcpt.locationId !== shift.locationId) return fail('Račun pripada drugi lokaciji.', 400)
      if (type === 'guest_refund' && rcpt.isStorno && rcpt.paymentMethod === 'cash') {
        return fail(
          'Gotovinsko vračilo je ŽE pokrito s fiskalnim stornom (šteje se v prodaji okna) — ' +
            'premik bi povzročil dvojno štetje. Če gre za vračilo brez storna, ne navežite računa storna.',
          409,
        )
      }
    }
  }

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim().slice(0, 64) : ''
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim().slice(0, 120) : null

  // PRIČAKOVANO STANJE izračunamo PRED transakcijo (liveCashSales uporablja
  // skupno db povezavo — klic ZNOTRAJ $transaction bi si prisvajal izključno
  // povezavo in obesil TX; vrednost je informacijska, minimalna neveznost
  // s transakcijo je sprejemljiva)
  const preMovements = await db.cashMovement.findMany({
    where: { shiftId: shift.id },
    select: { type: true, direction: true, amount: true, status: true, reversalOfId: true },
    take: 1000,
  })
  const preSummary = summarizeMovements(preMovements.map((p) => ({ ...p, amount: num(p.amount) })))
  const preCashSales = await liveCashSales(shift.locationId!, shift.openedAt)
  const expectedBefore = expectedDrawerCash(num(shift.startingCash), preCashSales, preSummary.net)
  const expectedAfter = direction === 'in' ? expectedBefore + amount : expectedBefore - amount

  try {
    const result = await db.$transaction(async (tx) => {
      // idempotenca (ponovljeni POST / sočasen klik / izguba odgovora):
      // enolični ključ → konflikt vrne OBSTOJEČI premik (NE podvoji)
      if (idempotencyKey) {
        const existing = await tx.cashMovement.findUnique({ where: { idempotencyKey } })
        if (existing) return { movement: existing, idempotentReplay: true }
      }

      const movement = await tx.cashMovement.create({
        data: {
          id: nid(),
          shiftId: shift.id,
          locationId: shift.locationId!,
          type,
          direction,
          amount: Math.round(amount * 100) / 100,
          currency: 'EUR',
          reasonId,
          reasonName,
          reasonText,
          note,
          userId: user.sub,
          userName: user.name,
          deviceId,
          receiptRef,
          status: 'confirmed',
          expectedAfter: Math.round(expectedAfter * 100) / 100,
          idempotencyKey,
        },
      })

      await writeAudit(tx, {
        userId: user.sub,
        action: 'CASH_MOVEMENT_CREATE',
        entityType: 'CashMovement',
        entityId: movement.id,
        details: jstr({
          type,
          direction,
          amount: Math.round(amount * 100) / 100,
          currency: 'EUR',
          shiftId: shift.id,
          reasonId,
          reasonName,
          reasonText,
          note,
          receiptRef,
          deviceId,
          expectedBefore,
          expectedAfter,
        }),
        locationId: shift.locationId!,
      })
      return { movement, idempotentReplay: false }
    })

    // push vodstvu ob ODLIVU (kraja/trenje signal — vzorec LOT_BLOCKED)
    if (direction === 'out' && !result.idempotentReplay) {
      void pushEvent('CASH_MOVEMENT', {
        title: 'Odliv gotovine iz predala',
        body: `${type} · ${amount.toFixed(2)} € · ${user.name}${reasonName || reasonText ? ` · ${reasonName || reasonText}` : ''}`,
        url: '/dashboard?tab=izmene',
        tag: `cash-movement-${result.movement.id}`,
      }, { roles: ['manager', 'admin'], locationId: shift.locationId })
    }

    return ok(
      {
        movement: mapMovement(result.movement as MovementDB),
        idempotentReplay: result.idempotentReplay,
      },
      result.idempotentReplay ? 200 : 201,
    )
  } catch (e) {
    const msg = String((e as Error)?.message ?? '')
    // unique konflikt na idempotencyKey (sočasen dvojni klik):
    if (idempotencyKey && /idempotencyKey|UNIQUE/i.test(msg)) {
      const existing = await db.cashMovement.findUnique({ where: { idempotencyKey } })
      if (existing) return ok({ movement: mapMovement(existing as MovementDB), idempotentReplay: true }, 200)
    }
    throw e
  }
}

/* ───────── PATCH — razveljavitev (kompenzacijski zapis) ───────── */

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'cash.manage')
  if (isResponse(user)) return user
  if (!(await cashMovementsAvailable())) {
    return fail('Knjiga premikov čaka DDL korak (Enterprise → Shema migracije → cash-movements).', 503)
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || body.action !== 'void') return fail('Podprta je samo akcija void (kompenzacijski zapis).')
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return fail('Manjka id premika.')

  const movement = await db.cashMovement.findUnique({ where: { id } })
  if (!movement) return fail('Premik ne obstaja.', 404)

  const shift = await db.cashRegisterShift.findUnique({ where: { id: movement.shiftId } })
  if (!shift) return fail('Izmena premika ne obstaja (podatkovna celovitost).', 409)

  // tenant
  if (!isCentralRole(user)) {
    if (!user.loc || movement.locationId !== user.loc) return forbidden()
  } else {
    const allowed = await allowedLocationIds(user)
    if (allowed !== null && !allowed.has(movement.locationId)) return forbidden()
  }

  if (movement.status !== 'confirmed') return fail('Premik je že razveljavitveno obračunan.', 409)
  if (movement.reversalOfId) return fail('Razveljavitvenega zapisa ni mogoče razveljaviti.', 409)
  if (shift.status !== 'open') {
    return fail('Zaključene izmene so NEPOSPRUNE za spreminjanje — popravek knjižite v novi odprti izmeni.', 409)
  }

  const voidReason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON_TEXT) : ''
  if (voidReason.length < 10) {
    return fail('Razlog razveljavitve je obvezen (vsaj 10 znakov).')
  }

  // prag politike: večji premik → odobritev (vzorec #19: vodstvena vloga
  // 'role' ALI poverilnica DRUGE osebe 'pin' — nikoli ista oseba)
  const policy = await cashPolicy()
  const amount = num(movement.amount)
  const needsApproval =
    policy.varianceThresholdCents > 0 && Math.round(amount * 100) > policy.varianceThresholdCents
  let approval: { method: 'role' | 'pin'; approverId: string; approverName: string } | null = null
  if (needsApproval) {
    const { resolveExceptionApproval } = await import('@/lib/exception-approval')
    const res = await resolveExceptionApproval(user, movement.locationId, {
      approverEmail: body.approverEmail,
      approverPin: body.approverPin,
    })
    if (!res.ok) return fail(res.message, res.status)
    approval = res.approval
  }

  // PRIČAKOVANO PO razveljavitvi izračunamo PRED transakcijo (liveCashSales
  // uporablja skupno db povezavo — ZNOTRAJ TX bi obesila povezavo). Kompenzacijski
  // zapis se v neto povzetkih NE šteje (reversalOfId izločen) → pričakovano
  // ostane enako POV-razveljavitvenemu stanju (brez originala).
  const others = await db.cashMovement.findMany({
    where: { shiftId: movement.shiftId, id: { not: movement.id } },
    select: { type: true, direction: true, amount: true, status: true, reversalOfId: true },
    take: 1000,
  })
  const othersSummary = summarizeMovements(others.map((c) => ({ ...c, amount: num(c.amount) })))
  const shiftRow = await db.cashRegisterShift.findUnique({ where: { id: movement.shiftId } })
  const cashSalesNow = await liveCashSales(movement.locationId, shiftRow?.openedAt ?? new Date())
  const expectedPostVoid = expectedDrawerCash(num(shiftRow?.startingCash ?? 0), cashSalesNow, othersSummary.net)
  const reverseDirection = movement.direction === 'in' ? 'out' : 'in'
  try {
    const result = await db.$transaction(async (tx) => {
      // CAS prevzem: samo prva zahteva razveljavi (sočasen klik)
      const claim = await tx.cashMovement.updateMany({
        where: { id: movement.id, status: 'confirmed' },
        data: {
          status: 'voided',
          voidedById: user.sub,
          voidedByName: user.name,
          voidedAt: new Date(),
          voidReason,
        },
      })
      if (claim.count === 0) return null

      // kompenzacijski OBRTNI zapis (isti znesek, nasprotna smer, vezava nazaj)
      const reverse = await tx.cashMovement.create({
        data: {
          id: nid(),
          shiftId: movement.shiftId,
          locationId: movement.locationId,
          type: movement.type,
          direction: reverseDirection,
          amount: movement.amount,
          currency: movement.currency,
          reasonId: null,
          reasonName: '',
          reasonText: `Razveljavitev: ${voidReason}`,
          note: `Kompenzacija premika ${movement.id}`,
          userId: user.sub,
          userName: user.name,
          deviceId: movement.deviceId,
          receiptRef: '',
          status: 'confirmed',
          reversalOfId: movement.id,
          expectedAfter: Math.round(expectedPostVoid * 100) / 100,
        },
      })
      await writeAudit(tx, {
        userId: user.sub,
        action: 'CASH_MOVEMENT_VOID',
        entityType: 'CashMovement',
        entityId: movement.id,
        details: jstr({
          originalType: movement.type,
          originalDirection: movement.direction,
          amount,
          reason: voidReason,
          reversalId: reverse.id,
          shiftId: movement.shiftId,
          approved: needsApproval,
          approvalMethod: approval?.method ?? null,
          approverId: approval?.approverId ?? null,
          approverName: approval?.approverName ?? null,
        }),
        locationId: movement.locationId,
      })
      // POSODOBLJENA originalna vrstica (status voided — prejšnje branje je
      // ZASTARELO; odgovor mora odsevati končno stanje)
      const updated = await tx.cashMovement.findUnique({ where: { id: movement.id } })
      return { original: updated ?? movement, reverse }
    })

    if (!result) return fail('Premik je bil že razveljavitveno obračunan (sočasna zahteva).', 409)
    return ok({
      movement: mapMovement(result.original as MovementDB),
      reversal: mapMovement(result.reverse as MovementDB),
    })
  } catch (e) {
    const msg = String((e as Error)?.message ?? '')
    if (/unique|idempotency|concurrent/i.test(msg)) {
      return fail('Sočasna razveljavitev — osvežite in poskusite znova.', 409)
    }
    throw e
  }
}
