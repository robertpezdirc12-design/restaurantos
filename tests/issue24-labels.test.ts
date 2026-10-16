/**
 * Issue #24 (P2, v1.114.0) — etikete za pripravljeno hrano in odprte serije.
 *
 * Pokrito:
 *  A. ČISTI MOTOR (src/lib/label.ts, brez DB):
 *   1. computeExpiry: potrjeno pravilo (hours>0) → preparedAt+hours,
 *      needsReview false, ruleSource 'rule', ruleConfirmedBy snapshot;
 *   2. pravilo hours=0 → IZRECNO "rok ni določen" (null + needsReview);
 *   3. brez pravila + ročni rok → 'manual' + needsReview (ni iz pravila);
 *   4. brez vsega → null + needsReview (etiketa pokaže "potreben pregled");
 *   5. labelScanStatus matrika: void → bucket prenos (recalled/quarantined/
 *      exhausted/expired/removal_due→review/alert) → lastni rok (pretekla →
 *      expired, ≤24 h → alert) → null+needsReview → review / null+!needsReview → ok;
 *   6. printBlockedReason: ok/alert NE blokirata; void/karantena/odpoklic/
 *      izčrpana/odstranitev/pretekel lastni rok → razlog blokade;
 *   7. initialsOf: dvodelno ime → MV, enodelno → J, prazno → '';
 *   8. formatQty: slovenska decimalna vejica, celi ostanejo celi;
 *  B. POST /api/labels: srečna pot batch (zamrznjen posnetek + ROK iz
 *     potrjenega pravila + QR 32hex + audit LABEL_CREATED z verigo);
 *     brez pravila/roka → needsReview; ročni rok v preteklosti → 400;
 *     karantena/izčrpana serija → 409; DRAFT priprava → 409 (COMPLETED → 201);
 *     401 brez žetona; količina ≤ 0 → 400;
 *  C. GET + obseg: filter batchId; tuja lokacija (locationScope) ne vidi;
 *     GET [id] detail + batch + printJobs; 404/403; pre-DDL 503
 *     (labelTablesReady cache hook);
 *  D. PRINT: printCount++ + lastPrintedAt + QR dataURL/text + audit
 *     LABEL_PRINTED; ponovni tisk = ISTA vrstica (printCount 2); tisk po
 *     karanteni serije → 409; tisk VOID etikete → 409; /api/print/ack
 *     evidence (kind='label', refId) viden v GET [id].printJobs;
 *  E. VOID: staff brez inventory.manage → 403; srečna pot (razlog) → VOID +
 *     audit LABEL_VOIDED; dvojna → 409; razlog < 3 znaki → 400;
 *  F. RULES: GET 403 staff / 200 manager; PUT upsert (create + update isti
 *     id, confirmedByName snapshot, audit LABEL_RULE_CONFIRMED); PUT null →
 *     izbris + LABEL_RULE_REMOVED (drugič removed:false); hours 9000/1.5 →
 *     400; neobstoječi artikel → 404;
 *  G. JAVNI STATUS: veljaven token → SAMO status/itemName/expiresAt/
 *     preparedAt/unit (brez PII/ID-jev/količin); pretekli rok → expired;
 *     VOID → void; napačen/neveljaven token → generični 404; brez Authorization;
 *  H. REGISTER/DDL/DRIFT: 'prep-labels' v SCHEMA_MIGRATIONS (26) + i18n
 *     SL/HR; DDL idempotenten (alreadyApplied + audit); manager → 403;
 *     drift matcher isPrepLabelsStatement.
 *
 * Fiksture s predpono i24- (TEST_PREFIXES); PrepLabel/LabelShelfRule/
 * BatchPreparation se počistijo ročno (nisno v ID_SWEEP — skalarne vezave).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { nid, num } from '../src/lib/map'
import {
  computeExpiry,
  labelScanStatus,
  printBlockedReason,
  initialsOf,
  formatQty,
  PRINT_BLOCK_MESSAGES,
} from '../src/lib/label'
import { __setLabelTablesCacheForTests, __resetLabelTablesCacheForTests } from '../src/lib/label-schema'
import { POST as labelsPOST, GET as labelsGET } from '../src/app/api/labels/route'
import { GET as labelGET } from '../src/app/api/labels/[id]/route'
import { POST as printPOST } from '../src/app/api/labels/[id]/print/route'
import { POST as voidPOST } from '../src/app/api/labels/[id]/void/route'
import { GET as rulesGET, PUT as rulesPUT } from '../src/app/api/labels/rules/route'
import { GET as publicLabelGET } from '../src/app/api/public/label-status/route'
import { POST as ackPOST } from '../src/app/api/print/ack/route'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-prep-labels/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl as slDict } from '../src/lib/i18n/sl'
import { hr as hrDict } from '../src/lib/i18n/hr'

const P = 'i24-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const TS = Date.now()

let locA = ''
let locB = ''
let locAName = ''
let mgrA = ''
let mgrB = ''
let waiterA = ''
let ownerA = ''
let tokA = ''
let tokB = ''
let tokWaiter = ''
let tokOwner = ''

let invItem = ''  // skupni artikel BREZ pravila (needsReview poti)
let invRule = ''  // B1: artikel s potrjenim pravilom 48 h
let invPrep = ''  // priprave (B6)
let invF = ''     // F: pravila upsert/izbris

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** javni klic BREZ Authorization glave (label-status je javen) */
function pubReq(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, { method: 'GET' })
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

async function seedEmployee(name: string, role: string, loc: string | null, seq: number): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const pin = `${PIN_BASE}${seq}`
  const f = employeePinFields(pin, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

interface MkBatchOpts {
  itemId?: string
  qty?: number
  expiryInDays?: number | null
  status?: string
}

async function mkBatch(opts: MkBatchOpts = {}) {
  const id = nid()
  return db.inventoryBatch.create({
    data: {
      id,
      inventoryItemId: opts.itemId ?? invItem,
      locationId: locA,
      lotNumber: `${P}lot-${id.slice(0, 8)}`,
      receivedAt: new Date(TS - 3_600_000),
      // privzeto 30 dni → bucket 'ok' (/null = unknown_expiry, kadar želeno)
      expiryDate: opts.expiryInDays === null
        ? null
        : new Date(TS + (opts.expiryInDays ?? 30) * 86_400_000),
      quantityInitial: opts.qty ?? 5,
      quantityRemaining: opts.qty ?? 5,
      unit: 'kg',
      status: opts.status || 'ACTIVE',
    },
  })
}

async function mkPrep(status: string): Promise<string> {
  const id = `${P}prep-${status.toLowerCase()}-${RUN}-${Math.random().toString(36).slice(2, 6)}`
  await db.batchPreparation.create({
    data: {
      id,
      locationId: locA,
      status,
      outputItemId: invPrep,
      outputQuantity: 3,
      outputUnit: 'kg',
      createdByName: `${P}mgrA`,
      completedAt: status === 'COMPLETED' ? new Date(TS - 3_600_000) : null,
    },
  })
  return id
}

/** izda etiketo prek RUTE iz sveže serije (privzeto artikel brez pravila) */
async function mkLabel(itemId?: string): Promise<{ id: string; token: string; batchId: string; lot: string }> {
  const b = await mkBatch({ itemId: itemId ?? invItem })
  const r = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id }))
  expect(r.status).toBe(201)
  const j = await body(r)
  const id = String((j.label as Record<string, unknown>).id)
  const row = await db.prepLabel.findUniqueOrThrow({ where: { id }, select: { token: true } })
  return { id, token: row.token, batchId: b.id, lot: b.lotNumber }
}

/** ročno čiščenje modelov, ki jih ID_SWEEP ne pozna (skalarne vezave) */
async function cleanup() {
  await db.prepLabel.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.labelShelfRule.deleteMany({ where: { inventoryItemId: { startsWith: P } } }).catch(() => null)
  await db.batchPreparation.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.printJob.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { locationId: { startsWith: P } } }).catch(() => null)
  if (ownerA) {
    await db.auditLog.deleteMany({ where: { action: 'SCHEMA_MIGRATION_PREP_LABELS', userId: ownerA } }).catch(() => null)
  }
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()
  const la = await db.location.create({ data: { id: `${P}locA-${RUN}`, name: `${P}Ljubljana`, code: `I24A-${RUN.toUpperCase()}` } })
  const lb = await db.location.create({ data: { id: `${P}locB-${RUN}`, name: `${P}Maribor`, code: `I24B-${RUN.toUpperCase()}` } })
  locA = la.id
  locB = lb.id
  locAName = la.name
  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  waiterA = await seedEmployee('waiterA', 'waiter', locA, 3)
  ownerA = await seedEmployee('ownerA', 'owner', locA, 4)
  tokA = createToken({ sub: mgrA, name: `${P}mgrA`, role: 'MANAGER', loc: locA, sv: 0 })
  tokB = createToken({ sub: mgrB, name: `${P}mgrB`, role: 'MANAGER', loc: locB, sv: 0 })
  tokWaiter = createToken({ sub: waiterA, name: `${P}waiterA`, role: 'WAITER', loc: locA, sv: 0 })
  tokOwner = createToken({ sub: ownerA, name: `${P}ownerA`, role: 'OWNER', loc: locA, sv: 0 })

  invItem = `${P}inv-${RUN}`
  invRule = `${P}invRule-${RUN}`
  invPrep = `${P}invPrep-${RUN}`
  invF = `${P}invF-${RUN}`
  await db.inventoryItem.create({ data: { id: invItem, name: `${P}Sestavina ${RUN}`, unit: 'kg', quantity: 0, costPerUnit: 2, locationId: locA } })
  await db.inventoryItem.create({ data: { id: invRule, name: `${P}Juha ${RUN}`, unit: 'kg', quantity: 0, costPerUnit: 2, locationId: locA, allergens: '["gluten","milk"]' } })
  await db.inventoryItem.create({ data: { id: invPrep, name: `${P}Mešanica ${RUN}`, unit: 'kg', quantity: 0, costPerUnit: 2, locationId: locA } })
  await db.inventoryItem.create({ data: { id: invF, name: `${P}Solata ${RUN}`, unit: 'kg', quantity: 0, costPerUnit: 2, locationId: locA } })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ A. čisti motor (label.ts) ═══════════════════ */

describe('A. label.ts čisti motor', () => {
  const prepared = new Date('2026-03-01T08:00:00Z')

  it('A1. computeExpiry: potrjeno pravilo 48 h → preparedAt+48h, brez pregleda, snapshot potrditelja', () => {
    const d = computeExpiry(prepared, { hours: 48, confirmedByName: 'Mojca Vodja' }, null)
    expect(d.expiresAt?.toISOString()).toBe('2026-03-03T08:00:00.000Z')
    expect(d.needsReview).toBe(false)
    expect(d.ruleSource).toBe('rule')
    expect(d.ruleHours).toBe(48)
    expect(d.ruleConfirmedBy).toBe('Mojca Vodja')
  })

  it('A2. computeExpiry: pravilo hours=0 → IZRECNO "rok ni določen" (null + needsReview)', () => {
    const d = computeExpiry(prepared, { hours: 0, confirmedByName: 'Mojca Vodja' }, null)
    expect(d.expiresAt).toBeNull()
    expect(d.needsReview).toBe(true)
    expect(d.ruleSource).toBe('rule')
    expect(d.ruleHours).toBe(0)
  })

  it('A3. computeExpiry: brez pravila + ročni rok → source manual, needsReview (ni iz pravila)', () => {
    const manual = new Date('2026-03-02T12:00:00Z')
    const d = computeExpiry(prepared, null, manual)
    expect(d.expiresAt?.getTime()).toBe(manual.getTime())
    expect(d.ruleSource).toBe('manual')
    expect(d.ruleHours).toBeNull()
    expect(d.needsReview).toBe(true)
  })

  it('A4. computeExpiry: brez pravila in brez roka → null + needsReview (nikoli navidezno veljaven datum)', () => {
    const d = computeExpiry(prepared, null, null)
    expect(d.expiresAt).toBeNull()
    expect(d.needsReview).toBe(true)
    expect(d.ruleSource).toBe('none')
    expect(d.ruleConfirmedBy).toBe('')
  })

  it('A5. labelScanStatus matrika: stanje serije premaga lastni rok; null+needsReview → review', () => {
    const now = new Date('2026-05-01T10:00:00Z')
    const base = { status: 'ACTIVE', needsReview: false, expiresAt: null as Date | null, batch: null as { bucket: string | null } | null }
    // status etikete
    expect(labelScanStatus({ ...base, status: 'VOID' }, now)).toBe('void')
    // prenos bucketov vezane serije (#15)
    expect(labelScanStatus({ ...base, batch: { bucket: 'recalled' } }, now)).toBe('recalled')
    expect(labelScanStatus({ ...base, batch: { bucket: 'quarantined' } }, now)).toBe('quarantined')
    expect(labelScanStatus({ ...base, batch: { bucket: 'exhausted' } }, now)).toBe('exhausted')
    expect(labelScanStatus({ ...base, batch: { bucket: 'expired' } }, now)).toBe('expired')
    expect(labelScanStatus({ ...base, batch: { bucket: 'removal_due' } }, now)).toBe('review')
    expect(labelScanStatus({ ...base, batch: { bucket: 'alert' } }, now)).toBe('alert')
    expect(labelScanStatus({ ...base, batch: { bucket: 'ok' } }, now)).toBe('ok')
    // lastni rok etikete (serija ok/brez serije)
    expect(labelScanStatus({ ...base, expiresAt: new Date(now.getTime() - 1) }, now)).toBe('expired')
    expect(labelScanStatus({ ...base, expiresAt: new Date(now.getTime() + 12 * 3_600_000) }, now)).toBe('alert')
    expect(labelScanStatus({ ...base, expiresAt: new Date(now.getTime() + 72 * 3_600_000) }, now)).toBe('ok')
    // brez roka: potreben pregled (ali potrjeno "brez roka" → ok)
    expect(labelScanStatus({ ...base, needsReview: true }, now)).toBe('review')
    expect(labelScanStatus({ ...base, needsReview: false }, now)).toBe('ok')
  })

  it('A6. printBlockedReason: ok/alert NE blokirata; void/karantena/odpoklic/izčrpana/odstranitev/pretekel rok', () => {
    const now = new Date('2026-05-01T10:00:00Z')
    const fresh = { status: 'ACTIVE', expiresAt: new Date(now.getTime() + 48 * 3_600_000) }
    expect(printBlockedReason(fresh, null, now)).toBeNull()
    // "kmalu poteče" (≤24 h) NE blokira — rok je znan in izpisan na etiketi
    expect(printBlockedReason({ status: 'ACTIVE', expiresAt: new Date(now.getTime() + 3_600_000) }, null, now)).toBeNull()
    expect(printBlockedReason({ status: 'VOID', expiresAt: null }, null, now)).toBe('void')
    expect(printBlockedReason(fresh, { bucket: 'quarantined' }, now)).toBe('quarantined')
    expect(printBlockedReason(fresh, { bucket: 'recalled' }, now)).toBe('recalled')
    expect(printBlockedReason(fresh, { bucket: 'exhausted' }, now)).toBe('exhausted')
    expect(printBlockedReason(fresh, { bucket: 'removal_due' }, now)).toBe('removal_due')
    expect(printBlockedReason(fresh, { bucket: 'expired' }, now)).toBe('expired')
    expect(printBlockedReason({ status: 'ACTIVE', expiresAt: new Date(now.getTime() - 3_600_000) }, null, now)).toBe('expired')
    // sporočila blokad so slovenska (ključi razlogov)
    expect(PRINT_BLOCK_MESSAGES.quarantined).toContain('karanten')
    expect(PRINT_BLOCK_MESSAGES.void).toContain('razveljavljena')
  })

  it("A7. initialsOf: 'Mojca Vodja' → MV; 'Janez' → J; '' → ''", () => {
    expect(initialsOf('Mojca Vodja')).toBe('MV')
    expect(initialsOf('Janez')).toBe('J')
    expect(initialsOf('')).toBe('')
    expect(initialsOf('   ')).toBe('')
    expect(initialsOf('ana novak petrović')).toBe('ANP')
  })

  it("A8. formatQty: 1.5 → '1,5'; 2 → '2'; 0.123 → '0,123'", () => {
    expect(formatQty(1.5)).toBe('1,5')
    expect(formatQty(2)).toBe('2')
    expect(formatQty(0.123)).toBe('0,123')
    expect(formatQty(0.5)).toBe('0,5')
    expect(formatQty(10)).toBe('10')
  })
})

/* ═══════════════════ B. POST /api/labels ═══════════════════ */

describe('B. POST /api/labels (izdaja etikete)', () => {
  it('B1. srečna pot batch: zamrznjen posnetek + rok iz pravila + QR + audit z verigo', async () => {
    // potrjeno pravilo 48 h direktno v DB (snapshot ob izdaji)
    await db.labelShelfRule.create({
      data: {
        id: `${P}rule-b1-${RUN}`,
        inventoryItemId: invRule,
        shelfLifeHours: 48,
        note: 'HLADILNIK 2–4 °C',
        confirmedById: mgrA,
        confirmedByName: 'Mojca Vodja',
        confirmedAt: new Date(TS - 600_000),
      },
    })
    const b = await mkBatch({ itemId: invRule, qty: 5, expiryInDays: 30 })
    const prepared = new Date(TS - 60_000)
    const r = await labelsPOST(req('POST', '/api/labels', tokA, {
      source: 'batch',
      batchId: b.id,
      preparedAt: prepared.toISOString(),
      note: 'B1 izdaja',
    }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const label = j.label as Record<string, unknown>
    // ZAMRZNJEN POSNETEK ob izdaji
    expect(label.itemName).toBe(`${P}Juha ${RUN}`)
    expect(label.lotNumber).toBe(b.lotNumber)
    expect(label.area).toBe(locAName)
    expect(label.quantity).toBe(5)
    expect(label.itemUnit).toBe('kg')
    expect(label.preparedByName).toBe(`${P}mgrA`)
    expect(label.preparedById).toBe(mgrA)
    expect(label.allergens).toEqual(['gluten', 'milk'])
    expect(label.status).toBe('ACTIVE')
    // ROK iz POTRJENEGA pravila
    expect(label.expiresAt).toBe(new Date(prepared.getTime() + 48 * 3_600_000).toISOString())
    expect(label.ruleSource).toBe('rule')
    expect(label.ruleHours).toBe(48)
    expect(label.ruleConfirmedBy).toBe('Mojca Vodja')
    expect(label.needsReview).toBe(false)
    expect(j.needsReview).toBe(false)
    expect(label.scanStatus).toBe('ok')
    // QR žeton (32 hex) + javni URL
    expect(String(j.qrUrl)).toContain('/label/')
    const token = String(j.qrUrl).split('/label/')[1]
    expect(token).toMatch(/^[a-f0-9]{32}$/)
    const row = await db.prepLabel.findUnique({ where: { id: String(label.id) } })
    expect(row?.token).toMatch(/^[a-f0-9]{32}$/)
    expect(row?.printCount).toBe(0)
    expect(row?.note).toBe('B1 izdaja')
    expect(num(row?.quantity)).toBe(5)
    // revizijska sled z verigo (audit-chain)
    const audit = await db.auditLog.findFirst({ where: { action: 'LABEL_CREATED', entityId: String(label.id) } })
    expect(audit).toBeTruthy()
    expect(audit?.chainHash).toBeTruthy()
    expect(typeof audit?.previousHash).toBe('string')
    expect(String(audit?.details)).toContain('"source":"batch"')
    expect(String(audit?.details)).toContain(`"inventoryItemId":"${invRule}"`)
    expect(audit?.locationId).toBe(locA)
    expect(audit?.userId).toBe(mgrA)
  })

  it('B2. brez pravila in brez ročnega roka → 201, needsReview, expiresAt null', async () => {
    const b = await mkBatch({ qty: 2 })
    const r = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id }))
    expect(r.status).toBe(201)
    const j = await body(r)
    const label = j.label as Record<string, unknown>
    expect(j.needsReview).toBe(true)
    expect(label.needsReview).toBe(true)
    expect(label.expiresAt).toBeNull()
    expect(label.ruleSource).toBe('none')
    expect(label.scanStatus).toBe('review') // rok neznan → potreben pregled
  })

  it('B3. brez pravila + ročni rok v preteklosti → 400 (ne sme nositi navidezno veljavnega datuma)', async () => {
    const b = await mkBatch({ qty: 2 })
    const past = new Date(TS - 86_400_000).toISOString()
    const r = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id, manualExpiresAt: past }))
    expect(r.status).toBe(400)
    const j = await body(r)
    expect(String(j.error)).toContain('preteklosti')
  })

  it('B4. serija v karanteni → 409 (tiskanje ne sme ustvariti vtisa primernosti)', async () => {
    const b = await mkBatch({ qty: 2, status: 'QUARANTINE' })
    const r = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id }))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toContain('karanten')
  })

  it('B5. izčrpana serija (quantityRemaining 0) → 409', async () => {
    const b = await mkBatch({ qty: 0, expiryInDays: 30 })
    const r = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id }))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toContain('izčrpana')
  })

  it('B6. priprava DRAFT → 409; COMPLETED → 201 (vir preparation, brez izmišljene serije)', async () => {
    const draftId = await mkPrep('DRAFT')
    const r1 = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'preparation', preparationId: draftId }))
    expect(r1.status).toBe(409)
    const j1 = await body(r1)
    expect(String(j1.error)).toContain('zaključeno')

    const doneId = await mkPrep('COMPLETED')
    const r2 = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'preparation', preparationId: doneId }))
    expect(r2.status).toBe(201)
    const j2 = await body(r2)
    const label = j2.label as Record<string, unknown>
    expect(label.source).toBe('preparation')
    expect(label.preparationId).toBe(doneId)
    expect(label.batchId).toBeNull()
    expect(label.lotNumber).toBe('') // NI izmišljenih številk — izvor je preparationId
    expect(label.quantity).toBe(3)
    expect(label.itemName).toBe(`${P}Mešanica ${RUN}`)
    expect(label.preparedAt).toBeTruthy()
  })

  it('B7. 401 brez žetona; količina ≤ 0 → 400', async () => {
    const b = await mkBatch({ qty: 4 })
    const r401 = await labelsPOST(req('POST', '/api/labels', '', { source: 'batch', batchId: b.id }))
    expect(r401.status).toBe(401)
    const r0 = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id, quantity: 0 }))
    expect(r0.status).toBe(400)
    const rNeg = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id, quantity: -1 }))
    expect(rNeg.status).toBe(400)
  })
})

/* ═══════════════════ C. GET + obseg ═══════════════════ */

describe('C. GET /api/labels + obseg', () => {
  it('C1. filter batchId → samo etikete te serije; scanStatus izračunan', async () => {
    const l1 = await mkLabel()
    const l2 = await mkLabel()
    const r = await labelsGET(req('GET', `/api/labels?batchId=${l1.batchId}&take=200`, tokA))
    expect(r.status).toBe(200)
    const j = await body(r)
    const labels = j.labels as Array<Record<string, unknown>>
    const ids = labels.map((x) => String(x.id))
    expect(ids).toContain(l1.id)
    expect(ids).not.toContain(l2.id)
    const one = labels.find((x) => String(x.id) === l1.id)!
    expect(one.scanStatus).toBe('review') // brez pravila → needsReview
    expect(one.lotNumber).toBe(l1.lot)
    expect(one.status).toBe('ACTIVE')
  })

  it('C2. tuja lokacija: manager B vidi SAMO svoje (locationScope) → prazno', async () => {
    const l = await mkLabel()
    const r = await labelsGET(req('GET', '/api/labels?take=200', tokB))
    expect(r.status).toBe(200)
    const j = await body(r)
    const ids = (j.labels as Array<Record<string, unknown>>).map((x) => String(x.id))
    expect(ids).not.toContain(l.id)
    expect(ids).toEqual([]) // locB nima nobenih etiket
  })

  it('C3. GET /api/labels/[id]: detail + vezana serija + prazni tiskalni poskusi', async () => {
    const l = await mkLabel()
    const r = await labelGET(req('GET', `/api/labels/${l.id}`, tokA), params(l.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    const label = j.label as Record<string, unknown>
    expect(label.id).toBe(l.id)
    const batch = j.batch as Record<string, unknown>
    expect(batch.id).toBe(l.batchId)
    expect(batch.lotNumber).toBe(l.lot)
    expect(batch.bucket).toBe('ok')
    expect(num(batch.quantityRemaining)).toBe(5)
    expect((j.printJobs as unknown[]).length).toBe(0)
  })

  it('C4. [id] 404 neobstoječa; 403 tuja lokacija (manager B na etiketo A)', async () => {
    const l = await mkLabel()
    const r404 = await labelGET(req('GET', `/api/labels/${nid()}`, tokA), params(nid()))
    expect(r404.status).toBe(404)
    const r403 = await labelGET(req('GET', `/api/labels/${l.id}`, tokB), params(l.id))
    expect(r403.status).toBe(403)
  })

  it('C5. pre-DDL: labelTablesReady=false → GET/POST/[id] 503 (graceful) → reset', async () => {
    const b = await mkBatch({ qty: 1 })
    __setLabelTablesCacheForTests(false)
    try {
      const rList = await labelsGET(req('GET', '/api/labels?take=10', tokA))
      expect(rList.status).toBe(503)
      const rPost = await labelsPOST(req('POST', '/api/labels', tokA, { source: 'batch', batchId: b.id }))
      expect(rPost.status).toBe(503)
      const j = await body(rPost)
      expect(String(j.error)).toContain('migracijo')
    } finally {
      __resetLabelTablesCacheForTests()
    }
    // po resetu probe znova deluje (tabela obstaja → true)
    const rAfter = await labelsGET(req('GET', '/api/labels?take=1', tokA))
    expect(rAfter.status).toBe(200)
  })
})

/* ═══════════════════ D. PRINT ═══════════════════ */

describe('D. POST /api/labels/[id]/print + evidence', () => {
  it('D1. tisk: printCount 1, lastPrintedAt, QR dataURL/text, audit LABEL_PRINTED', async () => {
    const l = await mkLabel()
    const r = await printPOST(req('POST', `/api/labels/${l.id}/print`, tokA), params(l.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.printCount).toBe(1)
    expect(String(j.qrDataUrl).startsWith('data:image/png')).toBe(true)
    expect(String(j.qrText)).toContain(`/label/${l.token}`)
    const row = await db.prepLabel.findUnique({ where: { id: l.id } })
    expect(row?.printCount).toBe(1)
    expect(row?.lastPrintedAt).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { action: 'LABEL_PRINTED', entityId: l.id } })
    expect(audit).toBeTruthy()
    expect(String(audit?.details)).toContain('"printCount":1')
  })

  it('D2. ponovni tisk = ISTA etiketa (printCount 2, brez nove vrstice/serije)', async () => {
    const l = await mkLabel()
    const r1 = await printPOST(req('POST', `/api/labels/${l.id}/print`, tokA), params(l.id))
    expect(r1.status).toBe(200)
    const r2 = await printPOST(req('POST', `/api/labels/${l.id}/print`, tokA), params(l.id))
    expect(r2.status).toBe(200)
    const j2 = await body(r2)
    expect(j2.printCount).toBe(2)
    const label = j2.label as Record<string, unknown>
    expect(label.id).toBe(l.id)
    // NI nove etikete niti spremembe serije/količine
    expect(await db.prepLabel.count({ where: { batchId: l.batchId } })).toBe(1)
    const batch = await db.inventoryBatch.findUnique({ where: { id: l.batchId } })
    expect(num(batch?.quantityRemaining)).toBe(5) // nedotaknjena
    expect(await db.stockTransaction.count({ where: { note: { contains: l.id } } })).toBe(0)
  })

  it('D3. tisk po karanteni serije → 409 (re-blokada ob vsakem tisu)', async () => {
    const l = await mkLabel()
    await db.inventoryBatch.update({ where: { id: l.batchId }, data: { status: 'QUARANTINE' } })
    const r = await printPOST(req('POST', `/api/labels/${l.id}/print`, tokA), params(l.id))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toContain('karanten')
    const row = await db.prepLabel.findUnique({ where: { id: l.id } })
    expect(row?.printCount).toBe(0) // blokada se zgodi PRED štetjem
  })

  it('D4. tisk VOID etikete → 409', async () => {
    const l = await mkLabel()
    await db.prepLabel.update({ where: { id: l.id }, data: { status: 'VOID' } })
    const r = await printPOST(req('POST', `/api/labels/${l.id}/print`, tokA), params(l.id))
    expect(r.status).toBe(409)
    const j = await body(r)
    expect(String(j.error)).toContain('razveljavljena')
  })

  it('D5. evidence: /api/print/ack kind=label → PrintJob vrstica → vidna v GET [id].printJobs', async () => {
    const l = await mkLabel()
    const r = await ackPOST(req('POST', '/api/print/ack', tokA, {
      kind: 'label',
      refId: l.id,
      target: 'simulator',
      status: 'printed',
      error: '',
      attempts: 1,
      device: '',
    }))
    expect(r.status).toBe(201)
    const job = await db.printJob.findFirst({ where: { kind: 'label', refId: l.id } })
    expect(job).toBeTruthy()
    expect(job?.target).toBe('simulator')
    expect(job?.status).toBe('printed')
    expect(job?.locationId).toBe(locA)
    const d = await labelGET(req('GET', `/api/labels/${l.id}`, tokA), params(l.id))
    expect(d.status).toBe(200)
    const j = await body(d)
    const jobs = j.printJobs as Array<Record<string, unknown>>
    expect(jobs.length).toBe(1)
    expect(jobs[0].kind).toBe('label')
    expect(jobs[0].refId).toBe(l.id)
  })
})

/* ═══════════════════ E. VOID ═══════════════════ */

describe('E. POST /api/labels/[id]/void', () => {
  it('E1. staff brez inventory.manage → 403', async () => {
    const l = await mkLabel()
    const r = await voidPOST(req('POST', `/api/labels/${l.id}/void`, tokWaiter, { reason: 'Natakar poskuša razveljaviti' }), params(l.id))
    expect(r.status).toBe(403)
  })

  it('E2. srečna pot: manager → VOID + voidReason + audit LABEL_VOIDED', async () => {
    const l = await mkLabel()
    const r = await voidPOST(req('POST', `/api/labels/${l.id}/void`, tokA, { reason: 'Napačna količina na etiketi' }), params(l.id))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.status).toBe('VOID')
    expect(j.voidReason).toBe('Napačna količina na etiketi')
    const row = await db.prepLabel.findUnique({ where: { id: l.id } })
    expect(row?.status).toBe('VOID')
    expect(row?.voidReason).toBe('Napačna količina na etiketi')
    const audit = await db.auditLog.findFirst({ where: { action: 'LABEL_VOIDED', entityId: l.id } })
    expect(audit).toBeTruthy()
    expect(audit?.userId).toBe(mgrA)
    expect(String(audit?.details)).toContain('Napačna količina')
  })

  it('E3. dvojna razveljavitev → 409', async () => {
    const l = await mkLabel()
    const r1 = await voidPOST(req('POST', `/api/labels/${l.id}/void`, tokA, { reason: 'Prva razveljavitev' }), params(l.id))
    expect(r1.status).toBe(200)
    const r2 = await voidPOST(req('POST', `/api/labels/${l.id}/void`, tokA, { reason: 'Druga razveljavitev' }), params(l.id))
    expect(r2.status).toBe(409)
  })

  it('E4. razlog < 3 znaki → 400 (obvezen, sledljiv)', async () => {
    const l = await mkLabel()
    const r = await voidPOST(req('POST', `/api/labels/${l.id}/void`, tokA, { reason: 'xx' }), params(l.id))
    expect(r.status).toBe(400)
    const row = await db.prepLabel.findUnique({ where: { id: l.id } })
    expect(row?.status).toBe('ACTIVE') // nedotaknjena
  })
})

/* ═══════════════════ F. RULES ═══════════════════ */

describe('F. GET/PUT /api/labels/rules', () => {
  it('F1. GET: staff brez inventory.manage → 403; manager → 200 z B1 pravilom', async () => {
    const rStaff = await rulesGET(req('GET', '/api/labels/rules', tokWaiter))
    expect(rStaff.status).toBe(403)
    const r = await rulesGET(req('GET', '/api/labels/rules', tokA))
    expect(r.status).toBe(200)
    const j = await body(r)
    const rules = j.rules as Array<Record<string, unknown>>
    const b1 = rules.find((x) => x.inventoryItemId === invRule)
    expect(b1).toBeDefined()
    expect(b1!.shelfLifeHours).toBe(48)
    expect(b1!.confirmedByName).toBe('Mojca Vodja')
    expect(b1!.itemName).toBe(`${P}Juha ${RUN}`)
  })

  it('F2. PUT upsert: create s snapshotom potrditelja + audit; update = ISTA vrstica', async () => {
    const r1 = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: 24, note: 'HLADILNIK' }))
    expect(r1.status).toBe(200)
    const j1 = await body(r1)
    const rule = j1.rule as Record<string, unknown>
    expect(rule.inventoryItemId).toBe(invF)
    expect(rule.shelfLifeHours).toBe(24)
    expect(rule.confirmedByName).toBe(`${P}mgrA`)
    expect(rule.confirmedAt).toBeTruthy()
    const audit = await db.auditLog.findFirst({ where: { action: 'LABEL_RULE_CONFIRMED', entityId: String(rule.id) } })
    expect(audit).toBeTruthy()
    expect(String(audit?.details)).toContain(`"inventoryItemId":"${invF}"`)
    // drugačen PUT → UPDATE (isti id, ista vrstica)
    const r2 = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: 12, note: 'KRAJŠI ROK' }))
    expect(r2.status).toBe(200)
    const j2 = await body(r2)
    expect((j2.rule as Record<string, unknown>).id).toBe(rule.id)
    expect(await db.labelShelfRule.count({ where: { inventoryItemId: invF } })).toBe(1)
    const row = await db.labelShelfRule.findUniqueOrThrow({ where: { inventoryItemId: invF } })
    expect(row.id).toBe(rule.id)
    expect(row.shelfLifeHours).toBe(12)
    expect(row.note).toBe('KRAJŠI ROK')
  })

  it('F3. PUT null → izbris + audit LABEL_RULE_REMOVED; drugič removed:false', async () => {
    const existing = await db.labelShelfRule.findUniqueOrThrow({ where: { inventoryItemId: invF } })
    const r1 = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: null }))
    expect(r1.status).toBe(200)
    const j1 = await body(r1)
    expect(j1.removed).toBe(true)
    expect(await db.labelShelfRule.count({ where: { inventoryItemId: invF } })).toBe(0)
    // revizija: izbrisan pravil-id + nekdanje ure (obseg prek OUR vrstice)
    const audit = await db.auditLog.findFirst({ where: { action: 'LABEL_RULE_REMOVED', entityId: existing.id } })
    expect(audit).toBeTruthy()
    expect(String(audit?.details)).toContain(`"inventoryItemId":"${invF}"`)
    expect(String(audit?.details)).toContain(`"formerHours":${existing.shelfLifeHours}`)
    expect(audit?.userId).toBe(mgrA)
    const r2 = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: null }))
    expect(r2.status).toBe(200)
    const j2 = await body(r2)
    expect(j2.removed).toBe(false)
  })

  it('F4. PUT hours 9000 → 400; hours 1.5 (ne-celo) → 400', async () => {
    const rBig = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: 9000 }))
    expect(rBig.status).toBe(400)
    const jBig = await body(rBig)
    expect(String(jBig.error)).toContain('8760')
    const rFrac = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: invF, shelfLifeHours: 1.5 }))
    expect(rFrac.status).toBe(400)
    expect(await db.labelShelfRule.count({ where: { inventoryItemId: invF } })).toBe(0)
  })

  it('F5. PUT neobstoječi artikel → 404', async () => {
    const r = await rulesPUT(req('PUT', '/api/labels/rules', tokA, { inventoryItemId: `${P}ne-obstaja-${RUN}`, shelfLifeHours: 5 }))
    expect(r.status).toBe(404)
  })
})

/* ═══════════════════ G. javni status ═══════════════════ */

describe('G. GET /api/public/label-status (QR → status)', () => {
  it('G1. veljaven token → 200 SAMO z {status, itemName, expiresAt, preparedAt, unit} (brez PII)', async () => {
    const l = await mkLabel()
    const r = await publicLabelGET(pubReq(`/api/public/label-status?token=${l.token}`))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(Object.keys(j).sort()).toEqual(['expiresAt', 'itemName', 'preparedAt', 'status', 'unit'])
    expect(j.status).toBe('review') // brez pravila → potreben pregled
    expect(j.itemName).toBe(`${P}Sestavina ${RUN}`)
    expect(j.expiresAt).toBeNull()
    expect(j.preparedAt).toBeTruthy()
    expect(j.unit).toBe('kg')
    // BREZ: lokacija, količina, pripravljatelj, žeton, vezave
    const forbidden = ['locationId', 'quantity', 'preparedByName', 'preparedById', 'token', 'batchId', 'id', 'area']
    for (const k of forbidden) expect(Object.keys(j)).not.toContain(k)
  })

  it('G2. pretekli rok → status expired', async () => {
    const l = await mkLabel()
    await db.prepLabel.update({ where: { id: l.id }, data: { expiresAt: new Date(TS - 86_400_000), needsReview: false } })
    const r = await publicLabelGET(pubReq(`/api/public/label-status?token=${l.token}`))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.status).toBe('expired')
  })

  it("G3. VOID etiketa → 'void'; napačen/neveljaven token → generični 404", async () => {
    const l = await mkLabel()
    await db.prepLabel.update({ where: { id: l.id }, data: { status: 'VOID' } })
    const r = await publicLabelGET(pubReq(`/api/public/label-status?token=${l.token}`))
    expect(r.status).toBe(200)
    expect((await body(r)).status).toBe('void')
    // napačen a veljaven 32hex žeton → 404 (brez razlikovanja)
    const rWrong = await publicLabelGET(pubReq(`/api/public/label-status?token=${'ab12cd34'.repeat(4)}`))
    expect(rWrong.status).toBe(404)
    // napačen format → 404 (isti odgovor)
    const rFmt = await publicLabelGET(pubReq('/api/public/label-status?token=xyz'))
    expect(rFmt.status).toBe(404)
    expect(await body(rFmt)).toEqual(await body(rWrong))
  })

  it('G4. javna pot deluje BREZ Authorization glave', async () => {
    const l = await mkLabel()
    const r = await publicLabelGET(pubReq(`/api/public/label-status?token=${l.token}`))
    expect(r.status).toBe(200)
    expect((await body(r)).itemName).toBe(`${P}Sestavina ${RUN}`)
  })
})

/* ═══════════════════ H. register / DDL / drift ═══════════════════ */

describe('H. register + DDL + drift', () => {
  it('H1. SCHEMA_MIGRATIONS vsebuje prep-labels + endpoint + i18n SL/HR opis', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'prep-labels')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-prep-labels')
    expect(m!.descKey).toBe('mig.prepLabels.desc')
    expect(typeof m!.probe).toBe('function')
    expect(slDict['mig.prepLabels.desc']).toBeTruthy()
    expect(hrDict['mig.prepLabels.desc']).toBeTruthy()
  })

  it('H2. DDL ruta (centralna vloga): idempotentna → alreadyApplied + audit', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-prep-labels', tokOwner))
    expect(r.status).toBe(200)
    const j = await body(r)
    expect(j.alreadyApplied).toBe(true) // dev SQLite: tabele že prek db push
    expect((j.applied as unknown[]).length).toBe(0)
    const audit = await db.auditLog.findFirst({ where: { action: 'SCHEMA_MIGRATION_PREP_LABELS', entityId: 'prep-labels' } })
    expect(audit).toBeTruthy()
    expect(audit?.userId).toBe(ownerA)
    expect(String(audit?.details)).toContain('/api/admin/migrate-prep-labels')
  })

  it('H3. DDL ruta: manager (ni centralna vloga) → 403', async () => {
    const r = await ddlPOST(req('POST', '/api/admin/migrate-prep-labels', tokA))
    expect(r.status).toBe(403)
  })

  it('H4. drift matcher: PrepLabel/LabelShelfRule CREATE/INDEX/ALTER so znani drift; DROP ne', async () => {
    const { isPrepLabelsStatement } = await import('../scripts/drift-check')
    expect(isPrepLabelsStatement('CREATE TABLE IF NOT EXISTS "PrepLabel" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isPrepLabelsStatement('CREATE TABLE IF NOT EXISTS "LabelShelfRule" ("id" TEXT NOT NULL)')).toBe(true)
    expect(isPrepLabelsStatement('CREATE UNIQUE INDEX IF NOT EXISTS "PrepLabel_token_key" ON "PrepLabel"("token")')).toBe(true)
    expect(isPrepLabelsStatement('CREATE INDEX IF NOT EXISTS "PrepLabel_batchId_idx" ON "PrepLabel"("batchId")')).toBe(true)
    expect(isPrepLabelsStatement('ALTER TABLE "PrepLabel" ADD COLUMN "x" TEXT')).toBe(true)
    expect(isPrepLabelsStatement('DROP TABLE "PrepLabel"')).toBe(false)
    expect(isPrepLabelsStatement('CREATE TABLE "X" ("id" TEXT)')).toBe(false)
    expect(isPrepLabelsStatement('DELETE FROM "PrepLabel"')).toBe(false)
  })

  it('H5. register dolžina = 26 (v1.114.0: +prep-labels)', () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(27) // v1.115.0: +payroll-periods (#22) // v1.114.0: +prep-labels (#24)
  })
})
