/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a.
 *
 * Pokritost:
 *  A. MOTOR (čiste funkcije, manager-call-registry.ts): needsEscalation
 *     (starost, ponovni krog, ack ustavi, max 3 krogi, terminal), canTransition
 *     (statusni avtomat po akcijah), isReplayCandidate (dedup okno 60 s),
 *     parseManagerCallSettings (fail-safe privzetki), isManagerCallType/Action
 *     + konstante, serializeManagerCall (izpeljani časi poročila).
 *  B. ZAHTLEVA (POST /api/manager-call): zlata pot 201 (OPEN, snapshot prosilca,
 *     audit MANAGER_CALL_REQUESTED), 401 brez žetona, neveljaven tip/omejitev
 *     nastavitev 400, opomba > 300 porezana, miza 0/1000/1.5 → 400, orderId
 *     tuje/neznan → 404, dedup okno (replay 200 isti id, brez dvojnika),
 *     idempotencyKey replay, rate limit 6/min → 429, POŠTENA dostava
 *     (deliveryStatus none/sent + notifiedCount — brez trditve o prejemu).
 *  C. SEZNAM (GET): aktivni klici v obsegu uporabnika, tenant izolacija
 *     (klic lokacije B ni viden), scope=mine, scope=all RBAC (natakar 403,
 *     vodstvo + statistike), nastavitve v odgovoru, cross-tenant 403
 *     (guardResource: lokacijska + org plast), GET [id] 200/404.
 *  D. STATUSNI AVTOMAT (PATCH [id]): ack (samo vodstvo, CAS — sočasno
 *     prevzemanje dveh vodij → 409), progress, resolve (obvezen zapis),
 *     cancel (prosilec svojega ALI vodstvo), terminalni 409, tuja lokacija 403.
 *  E. LENA ESKALACIJA (GET sproži sweep): krog 1 po timeoutu + audit, ack po
 *     eskalaciji, po ack ni re-eskalacije, max 3 krogi, ponovni krog po
 *     timeoutu, rešen klic ni eskaliran, GET [id] NE sproži sweepa,
 *     ackTimeoutMinutes 60 pomakne mejo.
 *  F. NASTAVITVE (GET/PUT /api/manager-call/settings): privzeti GET (katera koli
 *     vloga), RBAC (natakar 403), persist + audit, validacije 400, omejitev
 *     vrst ugasne POST.
 *  G. FINANČNA LOČENOST: tip APPROVAL je samo ZAHTLEVA — Order ostane
 *     nedotaknjen (status plačila/popusti/vsota).
 *  H. DDL + REGISTER + DRIFT: register vnos, idempotentna DDL ruta (bootstrap),
 *     manager 403, isManagerCallStatement matcher, classifyDrift.
 *
 * Fiksture s predpono i21- (lokaciji A/B, vsaka v svoji organizacijski verigi —
 * C6 potrebuje obe znani verigi za cross-tenant 403). Hitrostni limiter se
 * resetira pred POST/PATCH testi (6/min na zaposlenega bi sicer zadušil
 * zaporedne teste). Globalna Integration vrstica 'manager-call-settings' se
 * povrne na izvirno stanje (snapshot v beforeAll) — test ne pušča sledi.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import {
  MANAGER_CALL_TYPES,
  MANAGER_CALL_MAX_ESCALATION_ROUNDS,
  MANAGER_CALL_DEDUP_WINDOW_MS,
  MANAGER_CALL_NOTE_MAX,
  DEFAULT_ACK_TIMEOUT_MINUTES,
  MIN_ACK_TIMEOUT_MINUTES,
  MAX_ACK_TIMEOUT_MINUTES,
  isManagerCallType,
  isManagerCallAction,
  needsEscalation,
  canTransition,
  isReplayCandidate,
  parseManagerCallSettings,
  type EscalationCandidate,
  type ManagerCallAction,
} from '../src/lib/manager-call-registry'
import { serializeManagerCall } from '../src/lib/manager-call'
import { GET as listGET, POST as mainPOST } from '../src/app/api/manager-call/route'
import { GET as callGET, PATCH as callPATCH } from '../src/app/api/manager-call/[id]/route'
import { GET as settingsGET, PUT as settingsPUT } from '../src/app/api/manager-call/settings/route'
import { POST as migratePOST } from '../src/app/api/admin/migrate-manager-call/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { classifyDrift, isManagerCallStatement } from '../scripts/drift-check'

const P = 'i21-'
const RUN = Date.now().toString(36)
const ALL_TYPES = [...MANAGER_CALL_TYPES]

let locA = ''
let locB = ''
let mgrAId = ''
let mgrA2Id = ''
let waiterAId = ''
let waiterBId = ''
let waiterGId = ''
let waiterRLId = ''
let mgrBId = ''
let adminBId = ''
let tokMgrA = ''
let tokMgrA2 = ''
let tokWaiterA = ''
let tokWaiterB = ''
let tokWaiterG = ''
let tokMgrB = ''
let tokAdminB = ''

/** Snapshot globalne nastavitvene vrstice (Integration 'manager-call-settings'). */
let settingsSnapshot: { id: string; config: string } | null = null

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token?: string, bodyData?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: bodyData === undefined ? undefined : JSON.stringify(bodyData),
  })
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

async function seedEmp(name: string, role: string, loc: string | null): Promise<{ id: string; pin: string }> {
  const id = `${P}${name}-${RUN}`
  const email = `${P}${name}-${RUN}@test.local`
  const pin = String(Math.floor(100000 + Math.random() * 900000))
  const f = employeePinFields(pin, email)
  await db.employee.create({
    data: { id, name: `${P}${name}`, email, role, status: 'active', sessionVersion: 0, locationId: loc, pin: f.pin, pinLookup: f.pinLookup },
  })
  return { id, pin }
}

async function newLoc(tag: string): Promise<string> {
  const id = `${P}loc${tag}-${RUN}`
  await db.location.create({ data: { id, code: `${P}L${tag}${RUN}`, name: `${P}Lok ${tag}`, premisesId: `${P}prem${tag}-${RUN}` } })
  return id
}

/** Lokacija v lastni organizacijski verigi (C6: obe verigi znani + različni → 403). */
async function bindOrg(tag: string, locId: string): Promise<void> {
  const orgId = `${P}org${tag}-${RUN}`
  await db.organization.create({ data: { id: orgId, name: `${P}Org ${tag}`, slug: `${P}org${tag}-${RUN}` } })
  const brandId = `${P}brand${tag}-${RUN}`
  await db.brand.create({ data: { id: brandId, organizationId: orgId, name: `${P}Brand ${tag}` } })
  const propertyId = `${P}prop${tag}-${RUN}`
  await db.property.create({ data: { id: propertyId, brandId, name: `${P}Prop ${tag}` } })
  await db.location.update({ where: { id: locId }, data: { propertyId } })
}

/** Direkten zapis klica (D/E deli — brez POST ovir: dedup okno + rate limit). */
async function seedCall(
  tag: string,
  opts: { loc?: string; requestorId?: string; requestorName?: string; type?: string; status?: string; data?: Record<string, unknown> } = {},
): Promise<string> {
  const id = `${P}call-${tag}-${RUN}`
  await db.managerCall.create({
    data: {
      id,
      locationId: opts.loc ?? locA,
      requestorId: opts.requestorId ?? waiterAId,
      requestorName: opts.requestorName ?? `${P}waiterA`,
      type: opts.type ?? 'OTHER',
      status: opts.status ?? 'OPEN',
      deliveryStatus: 'none',
      notifiedCount: 0,
      ...(opts.data ?? {}),
    },
  })
  return id
}

/** Postari klic (leni sweep vidi starost iz createdAt). */
async function ageCall(id: string, minutesOpen: number, extra: Record<string, unknown> = {}): Promise<void> {
  await db.managerCall.update({
    where: { id },
    data: { createdAt: new Date(Date.now() - minutesOpen * 60_000), ...extra },
  })
}

async function postCall(
  token: string,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<{ res: Response; j: Record<string, unknown>; id: string }> {
  const res = await mainPOST(req('POST', '/api/manager-call', token, { type, ...extra }))
  const j = await body(res)
  const call = (j.call ?? {}) as { id?: string }
  return { res, j, id: String(call.id ?? '') }
}

async function patchCall(
  id: string,
  token: string,
  action: string,
  note?: string,
): Promise<{ res: Response; j: Record<string, unknown> }> {
  const res = await callPATCH(
    req('PATCH', `/api/manager-call/${id}`, token, { action, ...(note === undefined ? {} : { note }) }),
    { params: Promise.resolve({ id }) },
  )
  return { res, j: await body(res) }
}

async function getCall(id: string, token: string): Promise<{ res: Response; j: Record<string, unknown> }> {
  const res = await callGET(req('GET', `/api/manager-call/${id}`, token), { params: Promise.resolve({ id }) })
  return { res, j: await body(res) }
}

async function listGet(token: string, scope?: string): Promise<{ res: Response; j: Record<string, unknown> }> {
  const q = scope ? `?scope=${scope}` : ''
  const res = await listGET(req('GET', `/api/manager-call${q}`, token))
  return { res, j: await body(res) }
}

/** Povrni globalno nastavitveno vrstico na stanje PRED testom (brez sledi). */
async function restoreSettingsFixture(): Promise<void> {
  if (settingsSnapshot) {
    await db.integration
      .update({ where: { id: settingsSnapshot.id }, data: { config: settingsSnapshot.config } })
      .catch(() => undefined)
  } else {
    await db.integration.deleteMany({ where: { name: 'manager-call-settings', type: 'other' } })
  }
}

beforeAll(async () => {
  __resetRateLimitForTests()
  // higiena: ostanki crashanih tekov z isto predpono (disciplina fixture-sweep)
  await sweepTestFixtures(db, [P])

  settingsSnapshot = await db.integration.findFirst({
    where: { name: 'manager-call-settings', type: 'other' },
    select: { id: true, config: true },
  })

  locA = await newLoc('A')
  locB = await newLoc('B')
  await bindOrg('A', locA)
  await bindOrg('B', locB)

  mgrAId = (await seedEmp('mgrA', 'manager', locA)).id
  mgrA2Id = (await seedEmp('mgrA2', 'manager', locA)).id
  waiterAId = (await seedEmp('waiterA', 'waiter', locA)).id
  waiterBId = (await seedEmp('waiterB', 'waiter', locA)).id
  waiterGId = (await seedEmp('waiterG', 'waiter', locA)).id
  waiterRLId = (await seedEmp('waiterRL', 'waiter', locA)).id
  mgrBId = (await seedEmp('mgrB', 'manager', locB)).id
  adminBId = (await seedEmp('adminB', 'admin', locB)).id

  tokMgrA = tok(mgrAId, `${P}mgrA`, 'MANAGER', locA)
  tokMgrA2 = tok(mgrA2Id, `${P}mgrA2`, 'MANAGER', locA)
  tokWaiterA = tok(waiterAId, `${P}waiterA`, 'WAITER', locA)
  tokWaiterB = tok(waiterBId, `${P}waiterB`, 'WAITER', locA)
  tokWaiterG = tok(waiterGId, `${P}waiterG`, 'WAITER', locA)
  tokMgrB = tok(mgrBId, `${P}mgrB`, 'MANAGER', locB)
  tokAdminB = tok(adminBId, `${P}adminB`, 'ADMIN', locB)
})

afterAll(async () => {
  await restoreSettingsFixture()
  const sweep = await sweepTestFixtures(db, [P])
  expect(sweep.remainingLocations).toBe(0)
  expect(sweep.errors.length).toBe(0)
})

/* ═══════════════ A. MOTOR — ČISTE FUNKCIJE ═══════════════ */

describe('A. registrar klica vodje (manager-call-registry.ts)', () => {
  const NOW = new Date('2026-11-09T12:00:00Z')
  const cand = (over: Partial<EscalationCandidate>): EscalationCandidate => ({
    status: 'OPEN',
    acknowledgedAt: null,
    escalatedCount: 0,
    lastEscalatedAt: null,
    createdAt: new Date('2026-11-09T11:55:00Z'),
    ...over,
  })

  it('A1: needsEscalation — starost, ponovni krog, ack ustavi, max krogi, terminal', () => {
    expect(needsEscalation(cand({ createdAt: new Date('2026-11-09T11:56:30Z') }), NOW, 5)).toBe(false) // svež OPEN (3,5 min < 5)
    expect(needsEscalation(cand({}), NOW, 5)).toBe(true) // OPEN starost ≥ timeout (5 min)
    expect(
      needsEscalation(
        cand({ status: 'ESCALATED', createdAt: new Date('2026-11-09T11:50:00Z'), lastEscalatedAt: new Date('2026-11-09T11:58:00Z') }),
        NOW,
        5,
      ),
    ).toBe(false) // zadnja eskalacija pred 2 min — ponovni krog še ne
    expect(
      needsEscalation(
        cand({ status: 'ESCALATED', createdAt: new Date('2026-11-09T11:40:00Z'), lastEscalatedAt: new Date('2026-11-09T11:55:00Z') }),
        NOW,
        5,
      ),
    ).toBe(true) // zadnja eskalacija + timeout → nov krog
    expect(needsEscalation(cand({ acknowledgedAt: new Date('2026-11-09T11:50:00Z'), status: 'ACKNOWLEDGED' }), NOW, 5)).toBe(false) // prevzet → NIKOLI
    expect(needsEscalation(cand({ status: 'ESCALATED', escalatedCount: MANAGER_CALL_MAX_ESCALATION_ROUNDS }), NOW, 5)).toBe(false) // max krogov
    expect(needsEscalation(cand({ status: 'RESOLVED' }), NOW, 5)).toBe(false)
    expect(needsEscalation(cand({ status: 'CANCELLED' }), NOW, 5)).toBe(false)
  })

  it('A2: canTransition — statusni avtomat po akcijah', () => {
    const t = (action: ManagerCallAction | string, from: string) => canTransition(action as ManagerCallAction, from)
    expect(t('ack', 'OPEN')).toBe(true)
    expect(t('ack', 'ESCALATED')).toBe(true)
    expect(t('ack', 'ACKNOWLEDGED')).toBe(false)
    expect(t('ack', 'IN_PROGRESS')).toBe(false)
    expect(t('progress', 'ACKNOWLEDGED')).toBe(true)
    expect(t('progress', 'OPEN')).toBe(false)
    for (const from of ['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS']) {
      expect(t('resolve', from)).toBe(true)
      expect(t('cancel', from)).toBe(true)
    }
    expect(t('resolve', 'RESOLVED')).toBe(false)
    expect(t('cancel', 'CANCELLED')).toBe(false)
    expect(t('bogus', 'OPEN')).toBe(false) // neznana akcija → fail-closed
  })

  it('A3: isReplayCandidate — dedup okno (isti prosilec + vrsta + lokacija, ≤ 60 s, neprevzet)', () => {
    const call = {
      requestorId: 'r1', type: 'OTHER', locationId: 'l1', status: 'OPEN',
      acknowledgedAt: null, createdAt: new Date(NOW.getTime() - 30_000),
    }
    const same = { requestorId: 'r1', type: 'OTHER', locationId: 'l1' }
    expect(isReplayCandidate(call, same, NOW)).toBe(true)
    expect(isReplayCandidate(call, { ...same, type: 'DEVICE' }, NOW)).toBe(false) // druga vrsta
    expect(isReplayCandidate(call, { ...same, requestorId: 'r2' }, NOW)).toBe(false) // drug prosilec
    expect(isReplayCandidate(call, { ...same, locationId: 'l2' }, NOW)).toBe(false) // druga lokacija
    expect(isReplayCandidate({ ...call, createdAt: new Date(NOW.getTime() - MANAGER_CALL_DEDUP_WINDOW_MS - 1_000) }, same, NOW)).toBe(false) // čez okno
    expect(isReplayCandidate({ ...call, acknowledgedAt: new Date(NOW.getTime() - 5_000) }, same, NOW)).toBe(false) // prevzet
    expect(isReplayCandidate({ ...call, status: 'RESOLVED' }, same, NOW)).toBe(false) // terminal
  })

  it('A4: parseManagerCallSettings — fail-safe normalizacija', () => {
    expect(parseManagerCallSettings(null)).toEqual({ ackTimeoutMinutes: DEFAULT_ACK_TIMEOUT_MINUTES, allowedTypes: ALL_TYPES })
    expect(parseManagerCallSettings(undefined)).toEqual({ ackTimeoutMinutes: DEFAULT_ACK_TIMEOUT_MINUTES, allowedTypes: ALL_TYPES })
    for (const bad of [0, 61, NaN, 'abc', -5]) {
      expect(parseManagerCallSettings({ ackTimeoutMinutes: bad }).ackTimeoutMinutes).toBe(DEFAULT_ACK_TIMEOUT_MINUTES)
    }
    expect(parseManagerCallSettings({ ackTimeoutMinutes: 10 }).ackTimeoutMinutes).toBe(10)
    expect(parseManagerCallSettings({ ackTimeoutMinutes: 10.7 }).ackTimeoutMinutes).toBe(10) // floor
    expect(parseManagerCallSettings({ ackTimeoutMinutes: 5, allowedTypes: ['APPROVAL', 'BOGUS'] }).allowedTypes).toEqual(['APPROVAL'])
    expect(parseManagerCallSettings({ ackTimeoutMinutes: 5, allowedTypes: [] }).allowedTypes).toEqual(ALL_TYPES) // prazno → vsi
    expect(parseManagerCallSettings({ ackTimeoutMinutes: 5, allowedTypes: 'APPROVAL' }).allowedTypes).toEqual(ALL_TYPES) // ni seznam → vsi
  })

  it('A5: tipi/akcije/strice — varovalke tipov + konstante', () => {
    for (const t of MANAGER_CALL_TYPES) expect(isManagerCallType(t)).toBe(true)
    expect(isManagerCallType('BOGUS')).toBe(false)
    expect(isManagerCallType(42)).toBe(false)
    expect(isManagerCallType(undefined)).toBe(false)
    expect(isManagerCallType(null)).toBe(false)
    for (const a of ['ack', 'progress', 'resolve', 'cancel'] as const) expect(isManagerCallAction(a)).toBe(true)
    expect(isManagerCallAction('bogus')).toBe(false)
    expect(isManagerCallAction(42)).toBe(false)
    expect(MANAGER_CALL_TYPES.length).toBe(5)
    expect(MANAGER_CALL_MAX_ESCALATION_ROUNDS).toBe(3)
    expect(MANAGER_CALL_DEDUP_WINDOW_MS).toBe(60_000)
    expect(MANAGER_CALL_NOTE_MAX).toBe(300)
    expect([MIN_ACK_TIMEOUT_MINUTES, DEFAULT_ACK_TIMEOUT_MINUTES, MAX_ACK_TIMEOUT_MINUTES]).toEqual([1, 5, 60])
  })

  it('A6: serializeManagerCall — izpeljani časi poročila (ageMinutes / minutesToAcknowledge / minutesToResolve / overdue)', () => {
    const created = new Date('2026-11-09T11:00:00Z')
    const baseRow = {
      id: 'x', locationId: 'l', requestorId: 'r', requestorName: 'R', type: 'OTHER', status: 'OPEN',
      note: '', orderId: null, orderNumber: null, tableNumber: null, deliveryStatus: 'none', notifiedCount: 0,
      escalatedCount: 0, lastEscalatedAt: null, acknowledgedAt: null, acknowledgedById: null, acknowledgedByName: null,
      inProgressAt: null, inProgressById: null, resolvedAt: null, resolvedById: null, resolvedByName: null,
      resolutionNote: '', cancelledAt: null, cancelledById: null, idempotencyKey: null, createdAt: created,
    }
    const settings = { ackTimeoutMinutes: 5, allowedTypes: ALL_TYPES }
    const now = new Date('2026-11-09T11:06:00Z')

    const open = serializeManagerCall(baseRow, settings, now)
    expect(open.ageMinutes).toBe(6)
    expect(open.overdue).toBe(true) // aktiven + brez potrditve + čez 5 min
    expect(open.minutesToAcknowledge).toBeNull()
    expect(open.minutesToResolve).toBeNull()

    const acked = serializeManagerCall(
      { ...baseRow, status: 'ACKNOWLEDGED', acknowledgedAt: new Date('2026-11-09T11:03:00Z') },
      settings,
      now,
    )
    expect(acked.overdue).toBe(false) // prevzet → ni več zapadla
    expect(acked.minutesToAcknowledge).toBe(3)

    const resolved = serializeManagerCall(
      { ...baseRow, status: 'RESOLVED', resolvedAt: new Date('2026-11-09T11:04:00Z') },
      settings,
      now,
    )
    expect(resolved.ageMinutes).toBeNull() // terminal → starost ni več relevantna
    expect(resolved.minutesToResolve).toBe(4)
    expect(resolved.overdue).toBe(false)

    const cancelled = serializeManagerCall({ ...baseRow, status: 'CANCELLED', cancelledAt: new Date('2026-11-09T11:02:00Z') }, settings, now)
    expect(cancelled.ageMinutes).toBeNull()
  })
})

/* ═══════════════ B. POST — USTVARIJANJE ZAHTEVE ═══════════════ */

describe('B. POST /api/manager-call', () => {
  it('B1: zlata pot — 201, OPEN, snapshot prosilca, audit MANAGER_CALL_REQUESTED', async () => {
    __resetRateLimitForTests()
    const { res, j, id } = await postCall(tokWaiterA, 'UNHAPPY_GUEST', { note: 'Gost je nezadovoljen', tableNumber: 3 })
    expect(res.status).toBe(201)
    expect(j.replayed).toBe(false)
    expect((j.call as { status?: string }).status).toBe('OPEN')
    expect(id).not.toBe('')

    const row = await db.managerCall.findUnique({ where: { id } })
    expect(row?.locationId).toBe(locA)
    expect(row?.requestorId).toBe(waiterAId)
    expect(row?.requestorName).toBe(`${P}waiterA`) // snapshot imena (ne FK)
    expect(row?.type).toBe('UNHAPPY_GUEST')
    expect(row?.note).toBe('Gost je nezadovoljen')
    expect(row?.tableNumber).toBe(3)
    expect(row?.status).toBe('OPEN')
    expect(row?.escalatedCount).toBe(0)

    const audit = await db.auditLog.findFirst({ where: { action: 'MANAGER_CALL_REQUESTED', entityId: id } })
    expect(audit).not.toBeNull()
    expect(audit?.userId).toBe(waiterAId)
    expect(audit?.locationId).toBe(locA)
  })

  it('B2: brez žetona → 401', async () => {
    __resetRateLimitForTests()
    const res = await mainPOST(req('POST', '/api/manager-call', undefined, { type: 'OTHER' }))
    expect(res.status).toBe(401)
  })

  it('B3: neveljavna vrsta → 400; vrsta izklopljena v nastavitvah → 400', async () => {
    __resetRateLimitForTests()
    const bogus = await postCall(tokWaiterG, 'BOGUS')
    expect(bogus.res.status).toBe(400)
    expect(String(bogus.j.error)).toContain('vrsta')

    // omejitev prek nastavitev (globalna vrstica — po testu povrnjena)
    const put = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 5, allowedTypes: ['APPROVAL'] }))
    expect(put.status).toBe(200)
    __resetRateLimitForTests()
    const denied = await postCall(tokWaiterG, 'DEVICE')
    expect(denied.res.status).toBe(400)
    expect(String(denied.j.error)).toContain('nastavitvah')
    await restoreSettingsFixture()
  })

  it('B4: opomba > 300 znakov → sprejeta, a porezana na 300', async () => {
    __resetRateLimitForTests()
    const { res, id } = await postCall(tokWaiterA, 'TABLE_ISSUE', { note: 'x'.repeat(400) })
    expect(res.status).toBe(201)
    const row = await db.managerCall.findUnique({ where: { id } })
    expect(row?.note.length).toBe(300)
  })

  it('B5: miza 0/1000/1.5 → 400; miza 5 → veljavna in shranjena', async () => {
    __resetRateLimitForTests()
    for (const bad of [0, 1000, 1.5]) {
      const { res } = await postCall(tokWaiterG, 'OTHER', { tableNumber: bad })
      expect(res.status).toBe(400)
    }
    const okCall = await postCall(tokWaiterG, 'OTHER', { tableNumber: 5 })
    expect(okCall.res.status).toBe(201)
    const row = await db.managerCall.findUnique({ where: { id: okCall.id } })
    expect(row?.tableNumber).toBe(5)
  })

  it('B6: orderId ne obstaja → 404; orderId Druge lokacije → 404', async () => {
    __resetRateLimitForTests()
    await db.order.create({ data: { id: `${P}ordB-${RUN}`, orderNumber: 910_001, locationId: locB } })
    const missing = await postCall(tokWaiterA, 'DEVICE', { orderId: `${P}ne-obstaja-${RUN}` })
    expect(missing.res.status).toBe(404)
    const foreign = await postCall(tokWaiterA, 'DEVICE', { orderId: `${P}ordB-${RUN}` }) // naročilo je na locB
    expect(foreign.res.status).toBe(404)
    expect(String(foreign.j.error)).toContain('lokaciji')
  })

  it('B7: dedup okno — podvojen klik → 200 replayed:true, ISTI id, brez dvojnika', async () => {
    __resetRateLimitForTests()
    const first = await postCall(tokWaiterB, 'UNHAPPY_GUEST', { tableNumber: 8 })
    expect(first.res.status).toBe(201)
    expect(first.j.replayed).toBe(false)
    const second = await postCall(tokWaiterB, 'UNHAPPY_GUEST', { tableNumber: 8 })
    expect(second.res.status).toBe(200)
    expect(second.j.replayed).toBe(true)
    expect(second.id).toBe(first.id)
    expect((second.j.message as string | undefined)).toBeTruthy() // ne zavrne tiho
    const count = await db.managerCall.count({ where: { requestorId: waiterBId, type: 'UNHAPPY_GUEST' } })
    expect(count).toBe(1)
  })

  it('B8: idempotencyKey — omrežna ponovitev → isti zapis, replayed:true', async () => {
    __resetRateLimitForTests()
    const key = `${P}idem-${RUN}`
    const first = await postCall(tokWaiterB, 'TABLE_ISSUE', { idempotencyKey: key, tableNumber: 2 })
    expect(first.res.status).toBe(201)
    expect(first.j.replayed).toBe(false)
    const second = await postCall(tokWaiterB, 'TABLE_ISSUE', { idempotencyKey: key, tableNumber: 2 })
    expect(second.res.status).toBe(200)
    expect(second.j.replayed).toBe(true)
    expect(second.id).toBe(first.id)
    const count = await db.managerCall.count({ where: { idempotencyKey: key } })
    expect(count).toBe(1)
  })

  it('B9: rate limit — 6 zahtev/min na zaposlenega, 7. → 429 (replay ŠTEJE)', async () => {
    __resetRateLimitForTests()
    const statuses: number[] = []
    for (const t of MANAGER_CALL_TYPES) {
      const { res } = await postCall(tok(waiterRLId, `${P}waiterRL`, 'WAITER', locA), t, { tableNumber: 1 })
      statuses.push(res.status)
    }
    // 6. zahteva: ista vrsta → dedup replay (200), a ZAHTEVA šteje v limiter
    const replay = await postCall(tok(waiterRLId, `${P}waiterRL`, 'WAITER', locA), 'UNHAPPY_GUEST', {})
    statuses.push(replay.res.status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 200])
    expect(replay.j.replayed).toBe(true)
    const seventh = await postCall(tok(waiterRLId, `${P}waiterRL`, 'WAITER', locA), 'OTHER', {})
    expect(seventh.res.status).toBe(429)
    expect(String(seventh.j.error)).toContain('Preveč')
    __resetRateLimitForTests()
  })

  it('B10: POŠTENA dostava — brez naročnin none/0; z aktivno naročnino vodje sent/≥1', async () => {
    __resetRateLimitForTests()
    // predpogoj testa: na lokaciji A ni nobene aktivne PushSubscription
    const none = await postCall(tokWaiterG, 'UNHAPPY_GUEST', { tableNumber: 4 })
    expect(none.res.status).toBe(201)
    expect((none.j.call as { deliveryStatus?: string }).deliveryStatus).toBe('none')
    expect((none.j.call as { notifiedCount?: number }).notifiedCount).toBe(0)

    // naročnina vodje na lokaciji A → dostava "poskusili na N naprav"
    await db.pushSubscription.create({
      data: {
        id: `${P}push-mgrA-${RUN}`,
        employeeId: mgrAId,
        endpoint: 'https://push.i21.invalid/endpoint/abc',
        p256dhKey: 'B'.repeat(130),
        authKey: 'A'.repeat(24),
        userAgent: 'i21-test',
        isActive: true,
      },
    })
    __resetRateLimitForTests()
    const sent = await postCall(tokWaiterG, 'TABLE_ISSUE', { tableNumber: 6 })
    expect(sent.res.status).toBe(201)
    expect((sent.j.call as { deliveryStatus?: string }).deliveryStatus).toBe('sent')
    expect(((sent.j.call as { notifiedCount?: number }).notifiedCount ?? 0)).toBeGreaterThanOrEqual(1)
  })
})

/* ═══════════════ C. GET — SEZNAM + TENANT IZOLACIJA ═══════════════ */

describe('C. GET /api/manager-call (seznam)', () => {
  let cA1 = ''
  let cB1 = ''

  beforeAll(async () => {
    cA1 = await seedCall('cA1', { type: 'UNHAPPY_GUEST', requestorId: waiterAId, requestorName: `${P}waiterA` })
    cB1 = await seedCall('cB1', { loc: locB, requestorId: `${P}waiterB2-${RUN}`, requestorName: `${P}waiterB2`, type: 'OTHER' })
  })

  it('C1: manager A vidi aktivne klice svoje lokacije; klic lokacije B NI viden', async () => {
    const { res, j } = await listGet(tokMgrA) // scope=active (privzeto)
    expect(res.status).toBe(200)
    const calls = (j.calls ?? []) as { id: string; locationId: string; status: string }[]
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.id === cA1)).toBe(true)
    expect(calls.some((c) => c.id === cB1)).toBe(false)
    expect(calls.every((c) => c.locationId === locA)).toBe(true)
    for (const c of calls) {
      expect(['OPEN', 'ESCALATED', 'ACKNOWLEDGED', 'IN_PROGRESS']).toContain(c.status)
    }
  })

  it('C2: natakar vidi aktivne klice svoje lokacije (scope=active)', async () => {
    const { res, j } = await listGet(tokWaiterA)
    expect(res.status).toBe(200)
    const calls = (j.calls ?? []) as { locationId: string }[]
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.locationId === locA)).toBe(true)
  })

  it('C3: natakar scope=all → 403 (namenjen vodstvu)', async () => {
    const { res, j } = await listGet(tokWaiterA, 'all')
    expect(res.status).toBe(403)
    expect(String(j.error)).toContain('vodstvu')
  })

  it('C4: scope=mine → samo lastne zahteve (tudi zaključene)', async () => {
    const { res, j } = await listGet(tokWaiterA, 'mine')
    expect(res.status).toBe(200)
    const calls = (j.calls ?? []) as { requestorId: string }[]
    expect(calls.length).toBeGreaterThanOrEqual(3) // B1 + B4 + cA1
    expect(calls.every((c) => c.requestorId === waiterAId)).toBe(true)
  })

  it('C5: odgovor nosi nastavitve (privzeti 5 min / vseh 5 vrst) + serverTime', async () => {
    const { j } = await listGet(tokMgrA)
    const settings = (j.settings ?? {}) as { ackTimeoutMinutes?: number; allowedTypes?: string[] }
    expect(settings.ackTimeoutMinutes).toBe(5)
    expect(settings.allowedTypes).toEqual(ALL_TYPES)
    expect(typeof j.serverTime).toBe('string')
  })

  it('C6: cross-tenant — manager B 403 (lokacijska plast), admin B 403 (org plast), manager A 200', async () => {
    const c6 = await seedCall('c6', { type: 'TABLE_ISSUE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const asMgrB = await getCall(c6, tokMgrB)
    expect(asMgrB.res.status).toBe(403)
    const asAdminB = await getCall(c6, tokAdminB) // centralna vloga, TUJA organizacija
    expect(asAdminB.res.status).toBe(403)
    const asMgrA = await getCall(c6, tokMgrA)
    expect(asMgrA.res.status).toBe(200)
    expect((asMgrA.j.call as { id?: string }).id).toBe(c6)
  })

  it('C7: manager scope=all → 200 + statistike (statusi, časi do potrditve/rešitve)', async () => {
    const { res, j } = await listGet(tokMgrA, 'all')
    expect(res.status).toBe(200)
    const stats = (j.stats ?? {}) as Record<string, unknown>
    expect(stats.total).toBe(((j.calls ?? []) as unknown[]).length)
    const byStatus = (stats.byStatus ?? {}) as Record<string, number>
    expect(Object.keys(byStatus)).toEqual(['open', 'escalated', 'acknowledged', 'inProgress', 'resolved', 'cancelled'])
    expect(stats.escalatedRounds).toBeDefined()
    expect('avgMinutesToAcknowledge' in stats).toBe(true)
    expect('avgMinutesToResolve' in stats).toBe(true)
    // natakar statistik NE dobi (samo scope=all)
    const { j: jW } = await listGet(tokWaiterA)
    expect(jW.stats).toBeUndefined()
  })

  it('C8: neveljaven scope → 400', async () => {
    const { res } = await listGet(tokMgrA, 'bogus')
    expect(res.status).toBe(400)
  })
})

/* ═══════════════ D. PATCH — STATUSNI AVTOMAT ═══════════════ */

describe('D. PATCH /api/manager-call/[id]', () => {
  it('D1: vodja prevzame (ack) → ACKNOWLEDGED + ime prevzemnika + audit', async () => {
    __resetRateLimitForTests()
    const d1 = await seedCall('d1', { type: 'UNHAPPY_GUEST', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const { res, j } = await patchCall(d1, tokMgrA, 'ack')
    expect(res.status).toBe(200)
    expect((j.call as { status?: string }).status).toBe('ACKNOWLEDGED')
    const row = await db.managerCall.findUnique({ where: { id: d1 } })
    expect(row?.acknowledgedById).toBe(mgrAId)
    expect(row?.acknowledgedByName).toBe(`${P}mgrA`) // snapshot imena
    expect(row?.acknowledgedAt).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'MANAGER_CALL_ACKNOWLEDGED', entityId: d1 } })
    expect(audit).not.toBeNull()
    expect(audit?.userId).toBe(mgrAId)
  })

  it('D2: natakar ack → 403 (izključno vodstvo)', async () => {
    __resetRateLimitForTests()
    const d2 = await seedCall('d2', { type: 'OTHER', requestorId: waiterBId, requestorName: `${P}waiterB` })
    const { res, j } = await patchCall(d2, tokWaiterA, 'ack')
    expect(res.status).toBe(403)
    expect(String(j.error)).toContain('vodstvo')
    const row = await db.managerCall.findUnique({ where: { id: d2 } })
    expect(row?.status).toBe('OPEN') // brez spremembe
  })

  it('D3: dvojni prevzem — drugi vodja dobi 409 (z aktualnim statusom v napaki)', async () => {
    __resetRateLimitForTests()
    const d3 = await seedCall('d3', { type: 'DEVICE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const first = await patchCall(d3, tokMgrA, 'ack')
    expect(first.res.status).toBe(200)
    const second = await patchCall(d3, tokMgrA2, 'ack')
    expect(second.res.status).toBe(409)
    expect(String(second.j.error)).toContain('ACKNOWLEDGED')
    const row = await db.managerCall.findUnique({ where: { id: d3 } })
    expect(row?.status).toBe('ACKNOWLEDGED')
    expect(row?.acknowledgedById).toBe(mgrAId) // prvi prevzemnik ZMAGA
  })

  it('D3b: CAS konflikt — če se klic medtem spremeni, 409 nosi aktualni klic v telesu', async () => {
    __resetRateLimitForTests()
    // d3 (iz D3) je že ACKNOWLEDGED; rutinemu branju podtaknemo ZASTARELO kopijo
    // (OPEN) → validacije grejo skozi, transakcija prebere aktualni status → konflikt.
    const d3 = `${P}call-d3-${RUN}`
    const current = await db.managerCall.findUnique({ where: { id: d3 } })
    expect(current?.status).toBe('ACKNOWLEDGED')
    const stale = { ...current, status: 'OPEN' }
    const delegate = db.managerCall as unknown as Record<string, (args: unknown) => Promise<unknown>>
    const origFindUnique = delegate.findUnique
    let intercepted = false
    try {
      delegate.findUnique = async (args: unknown) => {
        const a = args as { where?: { id?: string } } | undefined
        if (!intercepted && a?.where?.id === d3) {
          intercepted = true
          return stale
        }
        return origFindUnique(args)
      }
      const { res, j } = await patchCall(d3, tokMgrA2, 'ack')
      expect(res.status).toBe(409)
      expect(String(j.error)).toContain('spremenjena')
      expect((j.call as { status?: string }).status).toBe('ACKNOWLEDGED') // aktualno stanje v telesu
    } finally {
      delegate.findUnique = origFindUnique
    }
  })

  it('D4: progress po ack → IN_PROGRESS; progress iz OPEN → 409', async () => {
    __resetRateLimitForTests()
    const d4a = await seedCall('d4a', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const ack = await patchCall(d4a, tokMgrA, 'ack')
    expect(ack.res.status).toBe(200)
    const prog = await patchCall(d4a, tokMgrA, 'progress')
    expect(prog.res.status).toBe(200)
    expect((prog.j.call as { status?: string }).status).toBe('IN_PROGRESS')
    const row = await db.managerCall.findUnique({ where: { id: d4a } })
    expect(row?.inProgressById).toBe(mgrAId)
    expect(row?.inProgressAt).not.toBeNull()

    const d4b = await seedCall('d4b', { type: 'OTHER', requestorId: waiterBId, requestorName: `${P}waiterB` })
    const direct = await patchCall(d4b, tokMgrA, 'progress')
    expect(direct.res.status).toBe(409) // OPEN → progress ni veljaven prehod
  })

  it('D5: resolve — z zapisom 200 + resolutionNote + audit; brez zapisa 400; iz OPEN neposredno 200', async () => {
    __resetRateLimitForTests()
    const d5a = await seedCall('d5a', { type: 'UNHAPPY_GUEST', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await patchCall(d5a, tokMgrA, 'ack')
    const resolved = await patchCall(d5a, tokMgrA, 'resolve', 'Gost pomirjen, popust odobren ločeno')
    expect(resolved.res.status).toBe(200)
    expect((resolved.j.call as { status?: string }).status).toBe('RESOLVED')
    const row = await db.managerCall.findUnique({ where: { id: d5a } })
    expect(row?.resolutionNote).toBe('Gost pomirjen, popust odobren ločeno')
    expect(row?.resolvedByName).toBe(`${P}mgrA`)
    const audit = await db.auditLog.findFirst({ where: { action: 'MANAGER_CALL_RESOLVED', entityId: d5a } })
    expect(audit).not.toBeNull()

    const d5b = await seedCall('d5b', { type: 'TABLE_ISSUE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const noNote = await patchCall(d5b, tokMgrA, 'resolve')
    expect(noNote.res.status).toBe(400)
    expect(String(noNote.j.error)).toContain('zapis')

    const d5c = await seedCall('d5c', { type: 'DEVICE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const direct = await patchCall(d5c, tokMgrA, 'resolve', 'Neposredna rešitev')
    expect(direct.res.status).toBe(200)
    expect((direct.j.call as { status?: string }).status).toBe('RESOLVED')
  })

  it('D6: cancel — prosilec svojega 200; tuji natakar 403; vodja katerega koli 200', async () => {
    __resetRateLimitForTests()
    const d6a = await seedCall('d6a', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const own = await patchCall(d6a, tokWaiterA, 'cancel')
    expect(own.res.status).toBe(200)
    expect((own.j.call as { status?: string }).status).toBe('CANCELLED')
    const rowA = await db.managerCall.findUnique({ where: { id: d6a } })
    expect(rowA?.cancelledById).toBe(waiterAId)

    const d6b = await seedCall('d6b', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const foreign = await patchCall(d6b, tokWaiterB, 'cancel')
    expect(foreign.res.status).toBe(403)
    expect(String(foreign.j.error)).toContain('svojo')

    const d6c = await seedCall('d6c', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const byMgr = await patchCall(d6c, tokMgrA, 'cancel')
    expect(byMgr.res.status).toBe(200)
    expect((byMgr.j.call as { status?: string }).status).toBe('CANCELLED')
  })

  it('D7: terminal — resolve nato ponovni ack → 409 (neprehodno)', async () => {
    __resetRateLimitForTests()
    const d7 = `${P}call-d5a-${RUN}` // RESOLVED iz D5
    const again = await patchCall(d7, tokMgrA2, 'ack')
    expect(again.res.status).toBe(409)
    expect(String(again.j.error)).toContain('zaključena')
  })

  it('D8: vodja druge lokacije NE more prevzeti klica (guardResource 403)', async () => {
    __resetRateLimitForTests()
    const d8 = await seedCall('d8', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const { res, j } = await patchCall(d8, tokMgrB, 'ack')
    expect(res.status).toBe(403)
    expect(String(j.error)).toContain('zavrnjen')
    const row = await db.managerCall.findUnique({ where: { id: d8 } })
    expect(row?.status).toBe('OPEN')
  })

  it('D9: GET [id] — vodja svoje lokacije 200; neznan id 404; PATCH neznanega 404', async () => {
    const d9 = `${P}call-d1-${RUN}` // ACKNOWLEDGED iz D1
    const ok = await getCall(d9, tokMgrA)
    expect(ok.res.status).toBe(200)
    expect((ok.j.call as { status?: string }).status).toBe('ACKNOWLEDGED')
    const missing = await getCall(`${P}ne-obstaja-${RUN}`, tokMgrA)
    expect(missing.res.status).toBe(404)
    __resetRateLimitForTests()
    const patchMissing = await patchCall(`${P}ne-obstaja-${RUN}`, tokMgrA, 'ack')
    expect(patchMissing.res.status).toBe(404)
  })

  it('D10: neveljavna akcija → 400', async () => {
    __resetRateLimitForTests()
    const d10 = await seedCall('d10', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    const { res, j } = await patchCall(d10, tokMgrA, 'bogus')
    expect(res.status).toBe(400)
    expect(String(j.error)).toContain('akcija')
  })
})

/* ═══════════════ E. LENA ESKALACIJA (GET sproži sweep) ═══════════════ */

describe('E. eskalacija zapadlih klicev', () => {
  it('E1: klic čez ackTimeout (5 min) → GET seznam sproži krog 1 + audit', async () => {
    const e1 = await seedCall('e1', { type: 'UNHAPPY_GUEST', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await ageCall(e1, 10)
    const { res } = await listGet(tokMgrA) // leni sweep teče PRED seznamom
    expect(res.status).toBe(200)
    const row = await db.managerCall.findUnique({ where: { id: e1 } })
    expect(row?.status).toBe('ESCALATED')
    expect(row?.escalatedCount).toBe(1)
    expect(row?.lastEscalatedAt).not.toBeNull()
    expect(row?.acknowledgedAt).toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'MANAGER_CALL_ESCALATED', entityId: e1 } })
    expect(audit).not.toBeNull()
    expect(audit?.userId).toBeNull() // samodejni krog — ni človeškega izvajalca
  })

  it('E2: eskaliran klic je še vedno prevzljiv (ack → 200)', async () => {
    const e2 = await seedCall('e2', { type: 'TABLE_ISSUE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await ageCall(e2, 10)
    await listGet(tokMgrA) // sproži eskalacijo
    const escalated = await db.managerCall.findUnique({ where: { id: e2 } })
    expect(escalated?.status).toBe('ESCALATED')
    __resetRateLimitForTests()
    const { res, j } = await patchCall(e2, tokMgrA, 'ack')
    expect(res.status).toBe(200)
    expect((j.call as { status?: string }).status).toBe('ACKNOWLEDGED')
  })

  it('E3: po potrditvi NI re-eskalacije (acknowledgedAt ustavi sweep)', async () => {
    const e3 = await seedCall('e3', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    __resetRateLimitForTests()
    await patchCall(e3, tokMgrA, 'ack')
    await ageCall(e3, 10)
    await listGet(tokMgrA)
    const row = await db.managerCall.findUnique({ where: { id: e3 } })
    expect(row?.status).toBe('ACKNOWLEDGED')
    expect(row?.escalatedCount).toBe(0)
    expect(row?.acknowledgedAt).not.toBeNull()
  })

  it('E4: max 3 krogi — četrti krog NE izide (omejena množica pushov)', async () => {
    const e4 = await seedCall('e4', { type: 'DEVICE', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await ageCall(e4, 30, { status: 'ESCALATED', escalatedCount: 3, lastEscalatedAt: new Date(Date.now() - 10 * 60_000) })
    const auditsBefore = await db.auditLog.count({ where: { action: 'MANAGER_CALL_ESCALATED', entityId: e4 } })
    expect(auditsBefore).toBe(0)
    await listGet(tokMgrA)
    const row = await db.managerCall.findUnique({ where: { id: e4 } })
    expect(row?.escalatedCount).toBe(3) // brez 4. kroga
    expect(row?.status).toBe('ESCALATED')
    const auditsAfter = await db.auditLog.count({ where: { action: 'MANAGER_CALL_ESCALATED', entityId: e4 } })
    expect(auditsAfter).toBe(0)
  })

  it('E5: ponovni krog šele ackTimeout po zadnji eskalaciji (krog 2)', async () => {
    const e5 = await seedCall('e5', { type: 'OTHER', requestorId: waiterBId, requestorName: `${P}waiterB` })
    await ageCall(e5, 20, { status: 'ESCALATED', escalatedCount: 1, lastEscalatedAt: new Date(Date.now() - 10 * 60_000) })
    await listGet(tokMgrA)
    const row = await db.managerCall.findUnique({ where: { id: e5 } })
    expect(row?.status).toBe('ESCALATED')
    expect(row?.escalatedCount).toBe(2)
    expect((row?.lastEscalatedAt?.getTime() ?? 0)).toBeGreaterThan(Date.now() - 5_000) // svež čas kroga
  })

  it('E6: rešen klic s starim createdAt NI eskaliran', async () => {
    const e6 = await seedCall('e6', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    __resetRateLimitForTests()
    await patchCall(e6, tokMgrA, 'resolve', 'Rešeno pred staranjem')
    await ageCall(e6, 30)
    await listGet(tokMgrA)
    const row = await db.managerCall.findUnique({ where: { id: e6 } })
    expect(row?.status).toBe('RESOLVED')
    expect(row?.escalatedCount).toBe(0)
  })

  it('E7: GET [id] (posamezni) NE sproži sweepa — samo seznam ga', async () => {
    const e7 = await seedCall('e7', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await ageCall(e7, 10)
    const single = await getCall(e7, tokMgrA)
    expect(single.res.status).toBe(200)
    expect((single.j.call as { status?: string }).status).toBe('OPEN') // še ni pometen
    const rowBefore = await db.managerCall.findUnique({ where: { id: e7 } })
    expect(rowBefore?.status).toBe('OPEN')
    await listGet(tokMgrA) // seznam izvede leni sweep
    const rowAfter = await db.managerCall.findUnique({ where: { id: e7 } })
    expect(rowAfter?.status).toBe('ESCALATED')
  })

  it('E8: ackTimeoutMinutes 60 — klic star 10 minut NI eskaliran (+ povratek nastavitev)', async () => {
    const put = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 60, allowedTypes: ALL_TYPES }))
    expect(put.status).toBe(200)
    const e8 = await seedCall('e8', { type: 'OTHER', requestorId: waiterAId, requestorName: `${P}waiterA` })
    await ageCall(e8, 10)
    await listGet(tokMgrA)
    const row = await db.managerCall.findUnique({ where: { id: e8 } })
    expect(row?.status).toBe('OPEN') // 10 < 60 → meja pomaknjena
    expect(row?.escalatedCount).toBe(0)
    await restoreSettingsFixture() // globalna vrstica → povratek (brez sledi)
  })
})

/* ═══════════════ F. NASTAVITVE ═══════════════ */

describe('F. GET/PUT /api/manager-call/settings', () => {
  it('F1: GET — privzete nastavitve za katero koli prijavljeno vlogo', async () => {
    const res = await settingsGET(req('GET', '/api/manager-call/settings', tokWaiterA))
    const j = await body(res)
    expect(res.status).toBe(200)
    const settings = (j.settings ?? {}) as { ackTimeoutMinutes?: number; allowedTypes?: string[] }
    expect(settings.ackTimeoutMinutes).toBe(5)
    expect(settings.allowedTypes).toEqual(ALL_TYPES)
  })

  it('F2: RBAC — natakar PUT 403; vodja PUT 200 + persist + audit', async () => {
    const denied = await settingsPUT(req('PUT', '/api/manager-call/settings', tokWaiterA, { ackTimeoutMinutes: 10, allowedTypes: ALL_TYPES }))
    expect(denied.status).toBe(403)

    const put = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 10, allowedTypes: ['APPROVAL', 'UNHAPPY_GUEST', 'TABLE_ISSUE'] }))
    expect(put.status).toBe(200)
    const putBody = await body(put)
    expect((putBody.settings as { ackTimeoutMinutes?: number }).ackTimeoutMinutes).toBe(10)

    const got = await settingsGET(req('GET', '/api/manager-call/settings', tokMgrA))
    const gotBody = await body(got)
    expect((gotBody.settings as { ackTimeoutMinutes?: number; allowedTypes?: string[] }).ackTimeoutMinutes).toBe(10)
    expect((gotBody.settings as { allowedTypes?: string[] }).allowedTypes).toEqual(['APPROVAL', 'UNHAPPY_GUEST', 'TABLE_ISSUE'])

    const audit = await db.auditLog.findFirst({ where: { action: 'MANAGER_CALL_SETTINGS_UPDATED', userId: mgrAId } })
    expect(audit).not.toBeNull()
  })

  it('F3: validacije — timeout 0/61/10.5/"abc" → 400; allowedTypes []/["NOPE"] → 400', async () => {
    for (const bad of [0, 61, 10.5, 'abc']) {
      const res = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: bad, allowedTypes: ALL_TYPES }))
      expect(res.status).toBe(400)
    }
    const empty = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 5, allowedTypes: [] }))
    expect(empty.status).toBe(400)
    const bogus = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 5, allowedTypes: ['NOPE'] }))
    expect(bogus.status).toBe(400)
    // zavrnjene posodobitve se NISO persistirale (iz F2 ostaja 10 min)
    const got = await settingsGET(req('GET', '/api/manager-call/settings', tokMgrA))
    const gotBody = await body(got)
    expect((gotBody.settings as { ackTimeoutMinutes?: number }).ackTimeoutMinutes).toBe(10)
  })

  it('F4: omejitev vrst — po PUT allowedTypes ["APPROVAL"] je POST DEVICE zavrnjen', async () => {
    const put = await settingsPUT(req('PUT', '/api/manager-call/settings', tokMgrA, { ackTimeoutMinutes: 5, allowedTypes: ['APPROVAL'] }))
    expect(put.status).toBe(200)
    __resetRateLimitForTests()
    const { res, j } = await postCall(tokWaiterG, 'DEVICE')
    expect(res.status).toBe(400)
    expect(String(j.error)).toContain('nastavitvah')
  })
})

/* ═══════════════ G. FINANČNA LOČENOST (issue §3) ═══════════════ */

describe('G. finančna ločenost', () => {
  it('G1: tip APPROVAL je samo ZAHTLEVA — Order ostane popolnoma nedotaknjen', async () => {
    __resetRateLimitForTests()
    const ordG = `${P}ordG-${RUN}`
    await db.order.create({ data: { id: ordG, orderNumber: 910_002, locationId: locA, type: 'dine-in', status: 'pending' } })
    const before = await db.order.findUnique({ where: { id: ordG } })
    expect(before?.status).toBe('pending')
    expect(String(before?.paymentStatus)).toBe('unpaid')

    const { res, j, id } = await postCall(tokWaiterG, 'APPROVAL', { orderId: ordG, tableNumber: 7, note: 'Popust nad pragom — potrebnem odobritev' })
    expect(res.status).toBe(201)
    expect(j.replayed).toBe(false)

    // klic hrani KONTEKST naročila (snapshot številke)…
    const callRow = await db.managerCall.findUnique({ where: { id } })
    expect(callRow?.orderId).toBe(ordG)
    expect(callRow?.orderNumber).toBe('910002')
    expect(callRow?.tableNumber).toBe(7)

    // …a NAROČILO je bitno-nespremenjeno (klic NE odobri/spremeni finančnega stanja)
    const after = await db.order.findUnique({ where: { id: ordG } })
    expect(after?.status).toBe(before?.status)
    expect(String(after?.paymentStatus)).toBe(String(before?.paymentStatus))
    expect(String(after?.discount)).toBe(String(before?.discount))
    expect(String(after?.total)).toBe(String(before?.total))
    expect(String(after?.tip)).toBe(String(before?.tip))
    expect(String(after?.subtotal)).toBe(String(before?.subtotal))
    expect(after?.notes).toBe(before?.notes)
    expect(after?.paidAt?.getTime()).toBe(before?.paidAt?.getTime())
  })
})

/* ═══════════════ H. DDL + REGISTER + DRIFT ═══════════════ */

describe('H. DDL/register/drift', () => {
  it('H1: register vsebuje manager-call (id, endpoint, probe)', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'manager-call')
    expect(m).toBeDefined()
    expect(m?.endpoint).toBe('/api/admin/migrate-manager-call')
    expect(SCHEMA_MIGRATIONS.length).toBeGreaterThanOrEqual(25)
  })

  it('H2: DDL ruta idempotentna — bootstrap 200; drugi klic alreadyApplied:true', async () => {
    const adminTok = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const first = await migratePOST(req('POST', '/api/admin/migrate-manager-call', adminTok))
    const j1 = await body(first)
    expect(first.status).toBe(200)
    expect(j1.alreadyApplied === true || (j1.applied as string[] | undefined)?.includes('ManagerCall')).toBe(true)
    const second = await migratePOST(req('POST', '/api/admin/migrate-manager-call', adminTok))
    const j2 = await body(second)
    expect(second.status).toBe(200)
    expect(j2.alreadyApplied).toBe(true)
  })

  it('H3: ne-centralna vloga (manager) → 403 na DDL ruti', async () => {
    const denied = await migratePOST(req('POST', '/api/admin/migrate-manager-call', tokMgrA))
    expect(denied.status).toBe(403)
  })

  it('H4: isManagerCallStatement — stavki ManagerCall prepoznani; tuji NE', () => {
    expect(isManagerCallStatement('CREATE TABLE "ManagerCall" (id TEXT NOT NULL)')).toBe(true)
    expect(isManagerCallStatement('CREATE UNIQUE INDEX "ManagerCall_idempotencyKey_key" ON "ManagerCall"("idempotencyKey")')).toBe(true)
    expect(isManagerCallStatement('CREATE INDEX "ManagerCall_locationId_status_idx" ON "ManagerCall"("locationId", "status")')).toBe(true)
    expect(isManagerCallStatement('ALTER TABLE "ManagerCall" ADD COLUMN "x" TEXT')).toBe(true)
    expect(isManagerCallStatement('DROP TABLE "ManagerCall"')).toBe(false)
    expect(isManagerCallStatement('CREATE TABLE "OtherTable" (id TEXT)')).toBe(false)
    expect(isManagerCallStatement('CREATE INDEX "ReservationWidget_x" ON "ReservationWidget"("x")')).toBe(false)
  })

  it('H5: classifyDrift — ManagerCall stavki so znani (ne unexpected); tuji stavk je blokator', () => {
    const sql = [
      'CREATE TABLE "ManagerCall" (id TEXT NOT NULL)',
      'CREATE UNIQUE INDEX "ManagerCall_idempotencyKey_key" ON "ManagerCall"("idempotencyKey")',
      'CREATE INDEX "ManagerCall_locationId_status_idx" ON "ManagerCall"("locationId", "status")',
    ].join(';\n')
    const out = classifyDrift(sql)
    expect(out.unexpected.length).toBe(0)
    expect(out.known.some((k) => k.id === 'manager-call')).toBe(true)

    const dirty = classifyDrift(`${sql};\nALTER TABLE "Employee" ADD COLUMN "x" TEXT`)
    expect(dirty.unexpected.length).toBe(1)
    expect(dirty.unexpected[0]).toContain('"Employee"')
  })
})
