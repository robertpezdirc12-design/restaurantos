import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, locationScope } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { rateLimitSharedAsync } from '@/lib/rate-limit'
import { pushEvent } from '@/lib/push'
import { isManagerialRole } from '@/lib/exception-approval'
import {
  MANAGER_CALL_NOTE_MAX,
  isManagerCallType,
  isReplayCandidate,
} from '@/lib/manager-call-registry'
import {
  loadManagerCallSettings,
  escalateOverdueManagerCalls,
  managerCallBaseTarget,
  managerCallDelivery,
  managerCallPushBody,
  serializeManagerCall,
} from '@/lib/manager-call'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: GLAVNA ruta.
 *
 * POST /api/manager-call — zaposleni (KATERA koli aktivna vloga s sejo —
 *   issue §1 "zaposleni sproži zahtevo z enega klika") zahteva pomoč vodje.
 *   Rate limit 6/min na zaposlenega; dedup okno 60 s (podvojen klik → 200 z
 *   obstoječim klicem + replayed:true, ne tiho zavrzi); idempotencyKey
 *   (unikatna vrstica) za omrežne ponovitve. Varnost: tip validiran proti
 *   nastavitvam, opomba ≤ 300, orderId preverjen na lokaciji; push vsebuje
 *   SAMO minimalno informacijo (tip + prosilec + miza/naročilo — brez opombe
 *   in brez podatkov o gostu, issue §1).
 *
 * GET /api/manager-call — lena eskalacija (zapadli neprevzeti klici dobijo
 *   krog, max 3) + seznam. scope=active (privzeto; aktivni klici v obsegu
 *   uporabnika), scope=mine (samo moji), scope=all (samo vodstvo — vsi
 *   statusi + statistike časa do potrditve/rešitve). Tenant obseg prek
 *   locationScope (zaposleni vidi SVOJO lokacijo; centralne vloge org).
 */

/* ─────────────── POST: ustvari zahtevo ─────────────── */

interface CreateBody {
  type?: unknown
  note?: unknown
  orderId?: unknown
  tableNumber?: unknown
  locationId?: unknown
  idempotencyKey?: unknown
}

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  // rate limit 6/min na zaposlenega — klic vodje je nujni kanal, ne klepet
  const rl = await rateLimitSharedAsync(`mcall:${user.sub}`, 6)
  if (!rl.allowed) {
    return fail('Preveč zahtev — poskusite znova čez minuto.', 429)
  }

  let body: CreateBody
  try {
    body = (await req.json()) as CreateBody
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }

  // lokacija: zaposleni → VEDNO svoja; centralna vloga → body ali svoja
  const loc = user.loc ?? (typeof body.locationId === 'string' && body.locationId ? body.locationId : null)
  if (!loc) return fail('Lokacija je obvezna.', 400)

  // tip + nastavitve (dovoljene vrste so nastavljive — issue §1)
  const type = body.type
  if (!isManagerCallType(type)) return fail('Neveljavna vrsta zahteve.', 400)
  const settings = await loadManagerCallSettings()
  if (!settings.allowedTypes.includes(type)) {
    return fail('Ta vrsta zahteve ni dovoljena v nastavitvah.', 400)
  }

  // opomba (ne obvezna; brez podatkov o gostu v pushu — opomba ostane v zapisu)
  let note = ''
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return fail('Opomba mora biti besedilo.', 400)
    note = body.note.trim().slice(0, MANAGER_CALL_NOTE_MAX)
  }

  // kontekst: miza in/ali naročilo (obstoječe na lokaciji)
  let tableNumber: number | null = null
  if (body.tableNumber !== undefined && body.tableNumber !== null) {
    const tn = Number(body.tableNumber)
    if (!Number.isInteger(tn) || tn < 1 || tn > 999) return fail('Številka mize je neveljavna.', 400)
    tableNumber = tn
  }
  let orderId: string | null = null
  let orderNumber: string | null = null
  if (typeof body.orderId === 'string' && body.orderId) {
    const order = await db.order.findFirst({ where: { id: body.orderId, locationId: loc } })
    if (!order) return fail('Naročilo ne obstaja na tej lokaciji.', 404)
    orderId = order.id
    orderNumber = String(order.orderNumber) // Order.orderNumber je Int — shranimo kot niz
    if (tableNumber === null && order.tableId) {
      const table = await db.table.findUnique({ where: { id: order.tableId } })
      if (table) tableNumber = table.number
    }
  }

  const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey.slice(0, 120) : null
  const now = new Date()

  // dedup okno: odprt NEprevzeti isti klic (prosilec+vrsta+lokacija) ≤ 60 s
  if (!idempotencyKey) {
    const recent = await db.managerCall.findFirst({
      where: {
        requestorId: user.sub,
        type,
        locationId: loc,
        status: { in: ['OPEN', 'ESCALATED'] },
        acknowledgedAt: null,
        createdAt: { gte: new Date(now.getTime() - 60_000) },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (recent && isReplayCandidate(recent, { requestorId: user.sub, type, locationId: loc }, now)) {
      return ok({ call: serializeManagerCall(recent, settings, now), replayed: true, message: 'Odprt klic te vrste že obstaja.' }, 200)
    }
  }

  // poštena dostava: preštejemo aktivne naročnine cilja PRED pushem
  const target = managerCallBaseTarget(loc)
  const delivery = await managerCallDelivery(target, 'MANAGER_CALL')

  const created = await db.$transaction(async (tx) => {
    // idempotencyKey: omrežna ponovitev → vrni obstoječega (brez dvojnika)
    if (idempotencyKey) {
      const existing = await tx.managerCall.findUnique({ where: { idempotencyKey } })
      if (existing) return { call: existing, replay: true }
    }
    const call = await tx.managerCall.create({
      data: {
        id: `MC${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        locationId: loc,
        requestorId: user.sub,
        requestorName: user.name,
        type,
        status: 'OPEN',
        note,
        orderId,
        orderNumber,
        tableNumber,
        deliveryStatus: delivery.deliveryStatus,
        notifiedCount: delivery.notifiedCount,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    })
    await writeAudit(tx, {
      userId: user.sub,
      action: 'MANAGER_CALL_REQUESTED',
      entityType: 'ManagerCall',
      entityId: call.id,
      details: jstr({ type, tableNumber, orderNumber, delivery: delivery.deliveryStatus, notified: delivery.notifiedCount, by: user.name }),
      locationId: loc,
    })
    return { call, replay: false }
  }).catch(async (e) => {
    // P2002 na idempotencyKey (sočasna ponovitev) → obstoječi zapis
    const code = (e as { code?: string }).code
    if (idempotencyKey && (code === 'P2002' || /Unique constraint/i.test(String(e)))) {
      const existing = await db.managerCall.findUnique({ where: { idempotencyKey } })
      if (existing) return { call: existing, replay: true }
    }
    throw e
  })

  // push PO commitu (matrika MANAGER_CALL; brez opombe/gosta — minimalna informacija)
  if (!created.replay) {
    void pushEvent(
      'MANAGER_CALL',
      {
        title: 'Klic vodje',
        body: managerCallPushBody(type, user.name, tableNumber, orderNumber),
        url: '/dashboard?tab=pregled',
        tag: `mcall-${created.call.id}`,
      },
      target,
    )
  }

  return ok(
    { call: serializeManagerCall(created.call, settings, now), replayed: created.replay },
    created.replay ? 200 : 201,
  )
}

/* ─────────────── GET: seznam (+ lena eskalacija) ─────────────── */

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') ?? 'active'
  const statusFilter = url.searchParams.get('status')
  const typeFilter = url.searchParams.get('type')
  const limitRaw = Number(url.searchParams.get('limit') ?? '60')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 60

  const settings = await loadManagerCallSettings()

  // lena eskalacija: za vezane uporabnike na njihovi lokaciji; centralne
  // nevezane (org brez lokacije) pometejo vse (dashboard 15 s poll)
  const scopeWhere = await locationScope(user)
  await escalateOverdueManagerCalls(typeof scopeWhere.locationId === 'string' ? scopeWhere.locationId : null)

  if (scope !== 'active' && scope !== 'mine' && scope !== 'all') {
    return fail('Neveljaven obseg (active, mine, all).', 400)
  }
  if (scope === 'all' && !isManagerialRole(user.role)) {
    return fail('Pregled vseh klicev je namenjen vodstvu.', 403)
  }

  const where: Record<string, unknown> = {}
  if (scope === 'mine') {
    where.requestorId = user.sub
  } else {
    where.locationId = scopeWhere.locationId
    if (scope === 'active') {
      where.status = { in: ['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS'] }
    }
  }
  if (statusFilter) where.status = statusFilter
  if (typeFilter) where.type = typeFilter

  const calls = await db.managerCall.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit })
  const now = new Date()
  const serialized = calls.map((c) => serializeManagerCall(c, settings, now))

  // statistike (samo vodstvo, scope=all): časi do potrditve/rešitve + eskalacije
  let stats: Record<string, unknown> | undefined
  if (scope === 'all') {
    const acked = serialized.filter((c) => c.minutesToAcknowledge !== null)
    const resolved = serialized.filter((c) => c.minutesToResolve !== null)
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
    stats = {
      total: serialized.length,
      byStatus: {
        open: serialized.filter((c) => c.status === 'OPEN').length,
        escalated: serialized.filter((c) => c.status === 'ESCALATED').length,
        acknowledged: serialized.filter((c) => c.status === 'ACKNOWLEDGED').length,
        inProgress: serialized.filter((c) => c.status === 'IN_PROGRESS').length,
        resolved: serialized.filter((c) => c.status === 'RESOLVED').length,
        cancelled: serialized.filter((c) => c.status === 'CANCELLED').length,
      },
      avgMinutesToAcknowledge: avg(acked.map((c) => c.minutesToAcknowledge as number)),
      avgMinutesToResolve: avg(resolved.map((c) => c.minutesToResolve as number)),
      escalatedRounds: serialized.reduce((a, c) => a + c.escalatedCount, 0),
    }
  }

  return ok({
    calls: serialized,
    ...(stats ? { stats } : {}),
    settings: { ackTimeoutMinutes: settings.ackTimeoutMinutes, allowedTypes: settings.allowedTypes },
    serverTime: now.toISOString(),
  })
}
