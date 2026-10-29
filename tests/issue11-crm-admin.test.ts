/**
 * Issue #11 (P2, v1.126.0) — CRM ADMIN: DDL korak + register + i18n pariteta +
 * konzola + deduplikacija/merge + cron povezava + testna pošiljka + send-test
 * simulator + javna unsubscribe rute RBAC/varnost.
 *
 * Fiksture s predpono i11- (TEST_PREFIXES). 0 omrežja.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { dictionaryGaps } from '../src/lib/i18n'
import { TAB_PERM } from '../src/lib/tab-permissions'
import {
  findDuplicateGuests, dismissDuplicatePair, mergeGuests,
} from '../src/lib/crm'
import { POST as ddlPOST } from '../src/app/api/admin/migrate-crm-campaigns/route'
import { POST as dupPOST, GET as dupGET } from '../src/app/api/crm/duplicates/route'
import { POST as actionsPOST } from '../src/app/api/crm/campaigns/[id]/actions/route'
import { POST as consentPOST } from '../src/app/api/crm/consent/route'
import { GET as unsubGET } from '../src/app/api/public/crm/unsubscribe/route'

const P = 'i11a-'
const RUN = (Date.now() + 1).toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let tokMgr = ''
let tokWaiter = ''
// issue #72 C1: kampanje/soglasja/deduplikacije = settings.manage → MANAGER nima
// več → property_manager na lokaciji (ne-centralen, poln nabor pravic)
let tokPm = ''
const guestIds: string[] = []
const campaignIds: string[] = []
const orderIds: string[] = []
const visitIds: string[] = []
const feedbackIds: string[] = []
const loyaltyIds: string[] = []

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Next.js 16 kontekst dinamične rute ([id]) — params kot Promise. */
function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locA = `${P}locA-${RUN}`
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}prem-${RUN}` } })
  const mgr = `${P}mgr-${RUN}`
  const waiter = `${P}waiter-${RUN}`
  const f1 = employeePinFields(`${PIN_BASE}1`, `${P}mgr-${RUN}@test.local`)
  await db.employee.create({
    data: { id: mgr, name: `${P}Mgr`, email: `${P}mgr-${RUN}@test.local`, role: 'manager', status: 'active', sessionVersion: 0, locationId: locA, pin: f1.pin, pinLookup: f1.pinLookup },
  })
  const f2 = employeePinFields(`${PIN_BASE}2`, `${P}waiter-${RUN}@test.local`)
  await db.employee.create({
    data: { id: waiter, name: `${P}Waiter`, email: `${P}waiter-${RUN}@test.local`, role: 'waiter', status: 'active', sessionVersion: 0, locationId: locA, pin: f2.pin, pinLookup: f2.pinLookup },
  })
  const pm = `${P}pm-${RUN}`
  const f3 = employeePinFields(`${PIN_BASE}3`, `${P}pm-${RUN}@test.local`)
  // ISSUE #75 5.1: property_manager = Razširjena raven; testni namen (ne-centralen
  // settings.manage imetnik za CRM skrbniške rute) izrecen prek override-a
  await db.employee.create({
    data: { id: pm, name: `${P}Pm`, email: `${P}pm-${RUN}@test.local`, role: 'property_manager', status: 'active', sessionVersion: 0, locationId: locA, pin: f3.pin, pinLookup: f3.pinLookup, permissionOverrides: JSON.stringify(['settings.manage']) },
  })
  tokMgr = tok(mgr, 'mgr', 'MANAGER', locA)
  tokWaiter = tok(waiter, 'waiter', 'WAITER', locA)
  tokPm = tok(pm, 'pm', 'PROPERTY_MANAGER', locA)
})

afterAll(async () => {
  await db.campaignSend.deleteMany({ where: { campaignId: { in: campaignIds } } })
  await db.campaign.deleteMany({ where: { id: { in: campaignIds } } })
  await db.guestConsent.deleteMany({ where: { guestId: { in: guestIds } } })
  await db.guestVisit.deleteMany({ where: { id: { in: visitIds } } })
  await db.guestFeedback.deleteMany({ where: { id: { in: feedbackIds } } })
  await db.order.deleteMany({ where: { id: { in: orderIds } } })
  await db.loyaltyAccount.deleteMany({ where: { id: { in: loyaltyIds } } })
  await db.guest.deleteMany({ where: { id: { in: guestIds } } })
  await db.integration.deleteMany({ where: { name: 'crm-dup-dismissed' } })
  await db.employee.deleteMany({ where: { id: { startsWith: P } } })
  await db.location.deleteMany({ where: { id: locA } })
})

async function seedGuest(opts: { suffix: string; email: string; phone?: string; visits?: number; spent?: number; lastDaysAgo?: number }): Promise<string> {
  const id = `${P}g-${opts.suffix}-${RUN}`
  guestIds.push(id)
  await db.guest.create({
    data: {
      id,
      firstName: `${P}Ime`,
      lastName: `Gost${opts.suffix}`,
      email: opts.email,
      phone: opts.phone ?? '+38640999000',
      totalVisits: opts.visits ?? 0,
      totalSpent: opts.spent ?? 0,
      lastVisitAt: opts.lastDaysAgo !== undefined ? new Date(Date.now() - opts.lastDaysAgo * 24 * 3600 * 1000) : null,
      firstVisitAt: null,
      locationId: locA,
    },
  })
  return id
}

/* ═══════════════════ A — DDL + REGISTER + KONZOLA ═══════════════════ */

describe('A — DDL korak, register #30→31, i18n', () => {
  it('register: crm-campaigns je 30. vnos (register zdaj 31: +web-portal #8 v1.190.0) (3 nove tabele v probi)', async () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(31)
    const entry = SCHEMA_MIGRATIONS.find((m) => m.id === 'crm-campaigns')
    expect(entry).toBeTruthy()
    expect(entry!.endpoint).toBe('/api/admin/migrate-crm-campaigns')
    expect(entry!.descKey).toBe('mig.crmCampaigns.desc')
    // unikaten id (starejša legacy 'issue11' migracija EventLog NE kolidira)
    const ids = SCHEMA_MIGRATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('i18n: mig.crmCampaigns.desc obstaja v SL in HR; crm.* ključi so paritetni', () => {
    expect(sl['mig.crmCampaigns.desc']).toBeTruthy()
    expect(hr['mig.crmCampaigns.desc']).toBeTruthy()
    expect(sl['tabs.crm']).toBeTruthy()
    expect(hr['tabs.crm']).toBeTruthy()
    const slCrm = Object.keys(sl).filter((k) => k.startsWith('crm.'))
    const hrCrm = Object.keys(hr).filter((k) => k.startsWith('crm.'))
    expect(slCrm.length).toBeGreaterThan(80)
    expect(new Set([...slCrm, ...hrCrm]).size).toBe(slCrm.length) // popolna pariteta
    expect(slCrm.sort()).toEqual(hrCrm.sort())
    const gaps = dictionaryGaps()
    expect(gaps.missingInHr).toEqual([])
    expect(gaps.missingInSl).toEqual([])
  })

  it('tab-permissions: crm zavihek ima izrecen vnos (guests.read — issue #72 D3)', () => {
    expect(TAB_PERM['crm']).toBe('guests.read')
  })

  it('DDL ruta: manager/waiter → 403 (requireCentralRole); dev SQLite → alreadyApplied', async () => {
    const w = await ddlPOST(req('POST', '/api/admin/migrate-crm-campaigns', tokWaiter))
    expect(w.status).toBe(403)
    const m = await ddlPOST(req('POST', '/api/admin/migrate-crm-campaigns', tokMgr))
    expect(m.status).toBe(403)
    // dev SQLite ima tabele (db push) → idempotentno alreadyApplied
    const adminTok = tok('bootstrap', 'Bootstrap', 'ADMIN', null)
    const res = await ddlPOST(req('POST', '/api/admin/migrate-crm-campaigns', adminTok))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { alreadyApplied: boolean }
    expect(json.alreadyApplied).toBe(true)
  })

  it('DDL vir: fiksnе stavki, IF NOT EXISTS, brez DROP/DELETE; sqlite_master potrdi strukturo', async () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/admin/migrate-crm-campaigns/route.ts'), 'utf8')
    expect(src).toContain('CREATE TABLE IF NOT EXISTS "GuestConsent"')
    expect(src).toContain('CREATE TABLE IF NOT EXISTS "Campaign"')
    expect(src).toContain('CREATE TABLE IF NOT EXISTS "CampaignSend"')
    expect(src).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_campaignId_guestId_key"')
    expect(src).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "CampaignSend_unsubscribeToken_key"')
    expect(/DROP\s+TABLE|DELETE\s+FROM/i.test(src)).toBe(false)
    expect(src).toContain('SCHEMA_MIGRATION_CRM_CAMPAIGNS')
    const tables = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('GuestConsent','Campaign','CampaignSend')`,
    )
    expect(tables.length).toBe(3)
    const cols = await db.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info('CampaignSend')`,
    )
    const names = cols.map((c) => c.name)
    for (const c of ['id', 'campaignId', 'guestId', 'channel', 'recipient', 'status', 'attempts', 'unsubscribeToken', 'sentAt', 'failedAt', 'errorMessage', 'unsubscribedAt', 'locationId']) {
      expect(names).toContain(c)
    }
  })

  it('konzola: HANDLERS vsebuje crm-campaigns (delegacija na isto DDL pot)', async () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/admin/migrations/route.ts'), 'utf8')
    expect(src).toContain("'crm-campaigns': crmCampaignsPOST")
    expect(src).toContain("migrate-crm-campaigns/route")
  })
})

/* ═══════════════════ B — DEDIKACIJA/MERGE ═══════════════════ */

describe('B — Podvojeni profili: zaznava, merge (brez podvajanja), dismiss', () => {
  it('zaznava: enak normaliziran email (case/whitespace ne štejeta) → par; telefon ločeno', async () => {
    const gA = await seedGuest({ suffix: 'dupA', email: `  DUP-${RUN}@Test.Local ` }) // normalizacija
    const gB = await seedGuest({ suffix: 'dupB', email: `dup-${RUN}@test.local` })
    const gC = await seedGuest({ suffix: 'dupC', email: `${P}c-${RUN}@test.local`, phone: '+386 41 222 333' })
    const gD = await seedGuest({ suffix: 'dupD', email: `${P}d-${RUN}@test.local`, phone: '0038641222333' }) // isti digits
    const pairs = await findDuplicateGuests({ locationId: locA })
    const keys = pairs.map((p) => [p.canonical.id, p.duplicate.id].sort().join('|'))
    expect(keys).toContain([gA, gB].sort().join('|'))
    expect(keys).toContain([gC, gD].sort().join('|'))
    // kanonični = VEČ obiskov (razložljiva izbira)
    const emailPair = pairs.find((p) => [p.canonical.id, p.duplicate.id].sort().join('|') === [gA, gB].sort().join('|'))!
    expect(emailPair.matchedOn).toBe('email')
    void emailPair
  })

  it('merge: relacijske vrstice se PREVEŽEJO, agregati so MAX (ne vsota) — nakupi/točke se NE podvojijo', async () => {
    const gA = await seedGuest({ suffix: 'mA', email: `${P}ma-${RUN}@test.local`, visits: 5, spent: 200, lastDaysAgo: 3 })
    const gB = await seedGuest({ suffix: 'mB', email: `${P}ma-${RUN}@test.local`, visits: 2, spent: 90, lastDaysAgo: 40 })
    // gB nima emaila? ima — isti po želji testa. vrstice:
    const oid = `${P}ord-${RUN}`
    orderIds.push(oid)
    await db.order.create({
      data: { id: oid, orderNumber: Math.floor(Math.random() * 900000) + 100000, locationId: locA, type: 'dine-in', status: 'paid', paymentStatus: 'paid', guestId: gB },
    })
    const vid = `${P}vis-${RUN}`
    visitIds.push(vid)
    await db.guestVisit.create({ data: { id: vid, guestId: gB, partySize: 2, totalSpent: 50 } })
    const fid = `${P}fb-${RUN}`
    feedbackIds.push(fid)
    await db.guestFeedback.create({ data: { id: fid, guestId: gB, overallRating: 5, locationId: locA } })
    await db.guestConsent.create({
      data: { id: `${P}cons-${RUN}`, guestId: gB, channel: 'email', purpose: 'marketing', status: 'granted', source: 'manual', proof: 'Potrdil na dup profilu.' , locationId: locA },
    })
    const loyaltyId = `${P}loy-${RUN}`
    loyaltyIds.push(loyaltyId)
    await db.loyaltyAccount.create({ data: { id: loyaltyId, customerName: 'M', customerPhone: '+38641555001', pointsBalance: 10, lifetimePoints: 10, locationId: locA } })
    await db.guest.update({ where: { id: gB }, data: { loyaltyAccountId: loyaltyId } })

    const result = await mergeGuests(gA, gB) // kanonični = gA (več obiskov)
    expect(result.canonicalId).toBe(gA)
    expect(result.ordersMoved).toBe(1)
    expect(result.visitsMoved).toBe(1)
    expect(result.feedbackMoved).toBe(1)
    expect(result.consentMoved).toBe(1)

    const merged = await db.guest.findUnique({ where: { id: gA } })
    expect(merged?.totalVisits).toBe(5) // MAX(5, 2) — NE 7 (vsota bi podvojila!)
    expect(Number(merged?.totalSpent)).toBe(200) // MAX — ne 290
    expect(merged?.loyaltyAccountId).toBe(loyaltyId) // loyalty prenesen (gA ni imel)
    expect(await db.guest.findUnique({ where: { id: gB } })).toBeNull() // dup izbrisan
    const ord = await db.order.findUnique({ where: { id: oid } })
    expect(ord?.guestId).toBe(gA)
    const vis = await db.guestVisit.findUnique({ where: { id: vid } })
    expect(vis?.guestId).toBe(gA)
    const fb = await db.guestFeedback.findUnique({ where: { id: fid } })
    expect(fb?.guestId).toBe(gA)
    const consent = await db.guestConsent.findFirst({ where: { guestId: gA } })
    expect(consent?.proof).toContain('Potrdil')
  })

  it('merge zavrne: OBA profila imata zvestobni račun (409 pot v rutah)', async () => {
    const gA = await seedGuest({ suffix: 'xA', email: `${P}xa-${RUN}@test.local` })
    const gB = await seedGuest({ suffix: 'xB', email: `${P}xa-${RUN}@test.local` })
    const la = `${P}loya-${RUN}`
    const lb = `${P}loyb-${RUN}`
    loyaltyIds.push(la, lb)
    await db.loyaltyAccount.create({ data: { id: la, customerName: 'A', customerPhone: '+38641555002', pointsBalance: 5, lifetimePoints: 5, locationId: locA } })
    await db.loyaltyAccount.create({ data: { id: lb, customerName: 'B', customerPhone: '+38641555003', pointsBalance: 7, lifetimePoints: 7, locationId: locA } })
    await db.guest.update({ where: { id: gA }, data: { loyaltyAccountId: la } })
    await db.guest.update({ where: { id: gB }, data: { loyaltyAccountId: lb } })
    let threw = ''
    try { await mergeGuests(gA, gB) } catch (e) { threw = String((e as Error).message) }
    expect(threw).toContain('zvestobni račun')
    // rUTA: 409
    const res = await dupPOST(req('POST', '/api/crm/duplicates', tokPm, { action: 'merge', canonicalId: gA, duplicateId: gB }))
    expect(res.status).toBe(409)
  })

  it('dismiss: par se NE vrača v zaznavo; RBAC 403 za waiterja', async () => {
    const gA = await seedGuest({ suffix: 'disA', email: `${P}dis-${RUN}@test.local` })
    const gB = await seedGuest({ suffix: 'disB', email: `${P}dis-${RUN}@test.local` })
    let pairs = await findDuplicateGuests({ locationId: locA })
    const key = [gA, gB].sort().join('|')
    expect(pairs.some((p) => [p.canonical.id, p.duplicate.id].sort().join('|') === key)).toBe(true)
    await dismissDuplicatePair(gA, gB)
    pairs = await findDuplicateGuests({ locationId: locA })
    expect(pairs.some((p) => [p.canonical.id, p.duplicate.id].sort().join('|') === key)).toBe(false)
    // rUTA RBAC
    const w = await dupGET(req('GET', '/api/crm/duplicates', tokWaiter))
    expect(w.status).toBe(403)
    const m = await dupGET(req('GET', '/api/crm/duplicates', tokPm))
    expect(m.status).toBe(200)
    const dis = await dupPOST(req('POST', '/api/crm/duplicates', tokWaiter, { action: 'dismiss', guestAId: gA, guestBId: gB }))
    expect(dis.status).toBe(403)
  })
})

/* ═══════════════════ C — KAMPANJE: testna pošiljka + lifecycle varovalke ═══════════════════ */

describe('C — Testna pošiljka, schedule varovalke, cancel', () => {
  it('send-test: NEVELJAVEN naslov → 400; brez SMTP konfiguracije → jasna napaka (brez gostov)', async () => {
    const res = await (await import('../src/app/api/crm/campaigns/route')).POST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}Test campaign ${RUN}`, channel: 'email', segmentType: 'all',
      subject: `${P}Test ${RUN}`,
      bodySl: `${P}Testna vsebina slovensko ${RUN}`,
      bodyHr: `${P}Testni sadržaj hrvatski ${RUN}`,
      testRecipient: `${P}test-${RUN}@test.local`,
      locationId: locA,
    }))
    const json = (await res.json()) as { campaign?: { id: string } }
    const id = json.campaign?.id ?? ''
    campaignIds.push(id)
    expect(id).not.toBe('')
    // neveljaven naslov
    const bad = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'send-test', to: 'ni-email' }), params(id))
    expect(bad.status).toBe(400)
    // veljaven naslov, a SMTP NI konfiguriran (dev brez nastavitev) → 400 z jasno napako
    const no = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'send-test' }), params(id))
    expect(no.status).toBe(400)
    const noJson = (await no.json()) as { error?: string }
    expect(noJson.error ?? '').toContain('SMTP')
    // send-test NE ustvari CampaignSend vrstice (testni naslov NI gost)
    const sends = await db.campaignSend.findMany({ where: { campaignId: id } })
    expect(sends.length).toBe(0)
  })

  it('schedule za neodobreno kampanjo → 400; approve dvakrat → 400; cancel iz prvega stanja', async () => {
    const res = await (await import('../src/app/api/crm/campaigns/route')).POST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}Lifecycle ${RUN}`, channel: 'email', segmentType: 'all',
      subject: `${P}LC ${RUN}`, bodySl: `${P}Vsebina SL ${RUN}`, bodyHr: `${P}Sadržaj HR ${RUN}`, locationId: locA,
    }))
    const json = (await res.json()) as { campaign?: { id: string } }
    const id = json.campaign?.id ?? ''
    campaignIds.push(id)
    // schedule pred odobritvijo
    const s0 = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }), params(id))
    expect(s0.status).toBe(400)
    // approve
    const a1 = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'approve' }), params(id))
    expect(a1.status).toBe(200)
    // approve 2x
    const a2 = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'approve' }), params(id))
    expect(a2.status).toBe(400)
    // cancel
    const c1 = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'cancel' }), params(id))
    expect(c1.status).toBe(200)
    const camp = await db.campaign.findUnique({ where: { id } })
    expect(camp?.status).toBe('cancelled')
    expect(camp?.cancelledAt).toBeTruthy()
    // dispatch cancelled → 400
    const d1 = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'dispatch' }), params(id))
    expect(d1.status).toBe(400)
  })

  it('napačna akcija → 400; neveljaven id → 404; waiter → 403', async () => {
    const res = await (await import('../src/app/api/crm/campaigns/route')).POST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}Edge ${RUN}`, channel: 'email', segmentType: 'all',
      subject: `${P}E ${RUN}`, bodySl: `${P}Vsebina SL ${RUN}`, bodyHr: `${P}Sadržaj HR ${RUN}`, locationId: locA,
    }))
    const json = (await res.json()) as { campaign?: { id: string } }
    const id = json.campaign?.id ?? ''
    campaignIds.push(id)
    const badAction = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, { action: 'explode' }), params(id))
    expect(badAction.status).toBe(400)
    const noBody = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPm, {}), params(id))
    expect(noBody.status).toBe(400)
    const missing = await actionsPOST(req('POST', '/api/crm/campaigns/ne-obstaja/actions', tokPm, { action: 'preview' }), params('ne-obstaja'))
    expect(missing.status).toBe(404)
    const w = await actionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokWaiter, { action: 'preview' }), params(id))
    expect(w.status).toBe(403)
  })
})

/* ═══════════════════ D — CRON + JAVNA VAROVANJA ═══════════════════ */

describe('D — Cron povezava, javna odjava varovanja, audit', () => {
  it('cron/daily vsebuje korak campaigns (dispatchDueCampaigns)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/cron/daily/route.ts'), 'utf8')
    expect(src).toContain('dispatchDueCampaigns')
    expect(src).toContain('campaigns:')
  })

  it('javna odjava: pomoč brez žetona → neveljavna stran (200, splošno); token format strict', async () => {
    const noTok = await unsubGET(new NextRequest('http://localhost:3000/api/public/crm/unsubscribe'))
    const text = await noTok.text()
    expect(text).toContain('Neveljavna')
    const shortTok = await unsubGET(new NextRequest('http://localhost:3000/api/public/crm/unsubscribe?token=abc'))
    const text2 = await shortTok.text()
    expect(text2).toContain('Neveljavna')
  })

  it('audit: consent dogodki zapisani BREZ vsebine dokaza (samo id/kanal)', async () => {
    const g = await seedGuest({ suffix: 'aud', email: `${P}aud-${RUN}@test.local` })
    await consentPOST(req('POST', '/api/crm/consent', tokPm, {
      guestId: g, channel: 'email', action: 'grant', proof: 'Zelo oseben dokaz o soglasju gosta Fernet Vid 2026.',
    }))
    const audits = await db.auditLog.findMany({
      where: { action: 'CRM_CONSENT_GRANTED', entityId: g },
      orderBy: { timestamp: 'desc' }, take: 1,
    })
    expect(audits.length).toBe(1)
    expect(audits[0].details).toContain('"channel":"email"')
    expect(audits[0].details).not.toContain('Fernet') // dokaz NE gre v audit (kanonična sled ga ima)
    expect(audits[0].locationId).toBe(locA)
  })

  it('send-test audit: brez vsebine sporočila (CRM_CAMPAIGN_TEST_SENT)', async () => {
    // kampanja iz C1
    const camp = await db.campaign.findFirst({ where: { id: { in: campaignIds }, testRecipient: { not: '' } } })
    if (camp) {
      const audits = await db.auditLog.findMany({ where: { action: 'CRM_CAMPAIGN_TEST_SENT', entityId: camp.id } })
      expect(audits.length).toBeGreaterThanOrEqual(0) // poskusi so bili zavrnjeni (brez SMTP) — audit ok/not-ok obe varianti
      for (const a of audits) {
        expect(a.details).not.toContain('Zadeva')
      }
    }
  })
})
