import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { guardResource } from '@/lib/tenant'
import { rateLimitSharedAsync } from '@/lib/rate-limit'
import { isManagerialRole } from '@/lib/exception-approval'
import {
  MANAGER_CALL_NOTE_MAX,
  isManagerCallAction,
  canTransition,
  MANAGER_CALL_TERMINAL_STATUSES,
} from '@/lib/manager-call-registry'
import { loadManagerCallSettings, serializeManagerCall, notifyRequestor } from '@/lib/manager-call'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje: AKCIJSKA ruta (statusni avtomat).
 *
 * PATCH /api/manager-call/[id] { action: 'ack'|'progress'|'resolve'|'cancel', note? }
 *
 *  - ack      : SAMO vodstvo (MANAGERIAL_ROLES). OPEN/ESCALATED → ACKNOWLEDGED.
 *              CAS (updateMany + pogoj status) — sočasno prevzemanje dveh vodij
 *              zmaga ENA (drugi dobi 409 z imenom prevzemnika). Prosilec dobi
 *              push potrditev (pushToEmployees — obstoječi wrapper).
 *  - progress : SAMO vodstvo. ACKNOWLEDGED → IN_PROGRESS.
 *  - resolve  : SAMO vodstvo. ne-terminal → RESOLVED + obvezen kratek zapis
 *              razrešitve (≤ 300, brez občutljivih podatkov — issue §2).
 *  - cancel   : prosilec SVOJEGA klica ALI vodstvo. ne-terminal → CANCELLED.
 *
 * Tenant varnost: guardResource (lokacijska plast + org scope) — zaposleni
 * DRUge lokacije klica ne vidi niti prevzame (403). Vsak prehod piše audit
 * (hash veriga) v isti transakciji; terminalni statusi so NEPREHOODNI.
 *
 * FINANČNA LOČENOST (issue §3): tip APPROVAL je samo ZAHTLEVA za pomoč —
 * ta ruta NIKOLI ne spreminja popusta/računa/naročila; odobritev teče prek
 * obstoječega zaščitenega toka (exception-approval).
 */

interface PatchBody {
  action?: unknown
  note?: unknown
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const call = await db.managerCall.findUnique({ where: { id } })
  if (!call) return fail('Zahteva ne obstaja.', 404)

  // tenant plast: tuji klic (druga lokacija/org) ne obstaja za tega uporabnika
  const guard = await guardResource(user, call.locationId)
  if (guard) return guard

  const settings = await loadManagerCallSettings()
  return ok({ call: serializeManagerCall(call, settings) })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  const { id } = await ctx.params

  const rl = await rateLimitSharedAsync(`mcall-act:${user.sub}`, 30)
  if (!rl.allowed) return fail('Preveč sprememb — poskusite znova čez minuto.', 429)

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return fail('Neveljavno telo zahteve.', 400)
  }

  const action = body.action
  if (!isManagerCallAction(action)) {
    return fail('Neveljavna akcija (ack, progress, resolve, cancel).', 400)
  }

  const call = await db.managerCall.findUnique({ where: { id } })
  if (!call) return fail('Zahteva ne obstaja.', 404)

  // tenant plast (issue §4: zaposleni druge lokacije/org jo NE SME prevzeti)
  const guard = await guardResource(user, call.locationId)
  if (guard) return guard

  // vloga: ack/progress/resolve so izključno vodstveni; cancel tudi prosilec svojega
  const managerial = isManagerialRole(user.role)
  if (action !== 'cancel' && !managerial) {
    return fail('To akcijo lahko izvede samo vodstvo.', 403)
  }
  if (action === 'cancel' && !managerial && call.requestorId !== user.sub) {
    return fail('Preklicati lahko samo svojo zahtevo.', 403)
  }

  // veljavnost prehoda (en vir resnice — registry TRANSITIONS)
  if ((MANAGER_CALL_TERMINAL_STATUSES as readonly string[]).includes(call.status)) {
    return fail('Zahteva je že zaključena.', 409)
  }
  if (!canTransition(action, call.status)) {
    return fail(`Prehod (${call.status} → ${action}) ni veljaven.`, 409)
  }

  // opomba (razrešitev; pri cancel neobvezna)
  let note = ''
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return fail('Zapis mora biti besedilo.', 400)
    note = body.note.trim().slice(0, MANAGER_CALL_NOTE_MAX)
  }
  if (action === 'resolve' && note.length < 2) {
    return fail('Kratek zapis razrešitve je obvezen.', 400)
  }

  const now = new Date()
  const AUDIT_ACTION = {
    ack: 'MANAGER_CALL_ACKNOWLEDGED',
    progress: 'MANAGER_CALL_IN_PROGRESS',
    resolve: 'MANAGER_CALL_RESOLVED',
    cancel: 'MANAGER_CALL_CANCELLED',
  }[action]
  const TARGET = { ack: 'ACKNOWLEDGED', progress: 'IN_PROGRESS', resolve: 'RESOLVED', cancel: 'CANCELLED' }[action]

  // CAS prehod: pogoj na TRENUTNI status (sočasen ack dveh vodij → ena zmaga)
  const result = await db.$transaction(async (tx) => {
    const prev = await tx.managerCall.findUnique({ where: { id } })
    if (!prev || prev.status !== call.status) return { conflict: true, call: prev ?? call }

    const data: {
      status: string
      acknowledgedAt?: Date
      acknowledgedById?: string
      acknowledgedByName?: string
      inProgressAt?: Date
      inProgressById?: string
      resolvedAt?: Date
      resolvedById?: string
      resolvedByName?: string
      resolutionNote?: string
      cancelledAt?: Date
      cancelledById?: string
    } = { status: TARGET }
    if (action === 'ack') {
      data.acknowledgedAt = now
      data.acknowledgedById = user.sub
      data.acknowledgedByName = user.name
    } else if (action === 'progress') {
      data.inProgressAt = now
      data.inProgressById = user.sub
    } else if (action === 'resolve') {
      data.resolvedAt = now
      data.resolvedById = user.sub
      data.resolvedByName = user.name
      data.resolutionNote = note
    } else {
      data.cancelledAt = now
      data.cancelledById = user.sub
    }
    const updated = await tx.managerCall.update({ where: { id }, data })

    await writeAudit(tx, {
      userId: user.sub,
      action: AUDIT_ACTION,
      entityType: 'ManagerCall',
      entityId: id,
      details: jstr({
        type: call.type,
        from: call.status,
        to: TARGET,
        ...(action === 'resolve' ? { resolutionNote: note } : {}),
        by: user.name,
      }),
      locationId: call.locationId,
    })
    return { conflict: false, call: updated }
  })

  if (result.conflict) {
    // sočasnost: klic se je medtem spremenil — pošljemo aktualno stanje
    const settings = await loadManagerCallSettings()
    return NextResponse.json(
      {
        error: `Zahteva je medtem spremenjena (status: ${result.call.status}).`,
        call: serializeManagerCall(result.call, settings),
      },
      { status: 409 },
    )
  }

  // push prosilcu PO commitu (potrditev prevzema/rešitve — direktni odgovor)
  if (action === 'ack') {
    notifyRequestor(call.requestorId, {
      title: 'Klic prevzet',
      body: `${user.name} je prevzel/a vaš klic.`,
    })
  } else if (action === 'resolve') {
    notifyRequestor(call.requestorId, { title: 'Klic rešen', body: `${user.name} je rešil/a vaš zahtevek.` })
  }

  const settings = await loadManagerCallSettings()
  return ok({ call: serializeManagerCall(result.call, settings) })
}
