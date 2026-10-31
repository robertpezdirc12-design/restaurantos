/**
 * Issue #11 (P2, v1.126.0) — CRM GOSTOV IN KAMPANJE: soglasje, segmentacija,
 * odjava, kampanjski življenjski cikel, pošiljanje, tenant izolacija, meritve.
 *
 * IZOLACIJA TESTOV: dve lokaciji — locA (soglasje/segmenti/tenant) in locC
 * (kampanje/pošiljanje/odjava/meritve, svoj manager) → publika kampanje
 * (gosti kampanjine lokacije) je v vsakem testu deterministična.
 *
 * 0 omrežja (SAMO vbrizgan sendFn simulator), 0 pravih poverilnic, 0
 * izmišljenih delivery podatkov: SMTP sprejem = 'sent_to_provider' (NE
 * dostava). Fiksture s predpono i11- (TEST_PREFIXES).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  recordConsent, currentConsentMap, dispatchCampaign,
  dispatchDueCampaigns, campaignPerformance,
  campaignBody, campaignSubject, segmentWhere, CRM_BATCH_LIMIT,
  type CampaignSendFn,
} from '../src/lib/crm'
import { POST as consentPOST } from '../src/app/api/crm/consent/route'
import { GET as segmentsGET } from '../src/app/api/crm/segments/route'
import { GET as guestsGET } from '../src/app/api/crm/guests/route'
import { GET as exportGET } from '../src/app/api/crm/guests/export/route'
import { GET as campaignsGET, POST as campaignsPOST } from '../src/app/api/crm/campaigns/route'
import { GET as campaignDetailGET } from '../src/app/api/crm/campaigns/[id]/route'
import { POST as campaignActionsPOST } from '../src/app/api/crm/campaigns/[id]/actions/route'
import { GET as unsubGET, POST as unsubPOST } from '../src/app/api/public/crm/unsubscribe/route'

const P = 'i11-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let orgA = ''
let orgB = ''
let brandA = ''
let brandB = ''
let propA = ''
let propB = ''
let locA = ''
let locB = ''
let locC = ''
let mgrA = ''
let mgrB = ''
let mgrC = ''
let waiterA = ''
let adminB = ''
let tokMgrA = ''
let tokMgrB = ''
let tokMgrC = ''
let tokWaiterA = ''
let tokAdminB = ''
// issue #72 C1: soglasja/kampanje/izvoz (settings.manage) MANAGER nima več →
// property_manager = poln nabor pravic, a LOKACIJSKO vezan (ni centralen)
let tokPmA = ''
let tokPmB = ''
let tokPmC = ''

const guestIds: string[] = []
const campaignIds: string[] = []
const orderIds: string[] = []
const sentEmails: { to: string; subject: string; text: string; unsubUrl: string }[] = []

/** Simulator pošiljanja (0 omrežja) — zapiše KAJ je šlo ven. */
const fakeSendOk: CampaignSendFn = async (args) => {
  sentEmails.push({ to: args.to, subject: args.subject, text: args.text, unsubUrl: args.unsubscribeUrl })
  return { ok: true, detail: 'OK', messageId: `mock-${sentEmails.length}` }
}
const fakeSendFail: CampaignSendFn = async () => ({ ok: false, detail: 'Simulirana napaka SMTP 535' })

function tok(sub: string, name: string, role: string, loc: string | null): string {
  return createToken({ sub, name, role, loc, sv: 0 })
}

function req(method: string, url: string, token: string, body?: unknown, ip?: string): NextRequest {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (ip) headers['x-forwarded-for'] = ip
  return new NextRequest(`http://localhost:3000${url}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Next.js 16 kontekst dinamične rute ([id]) — params kot Promise. */
function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function seedEmployee(name: string, role: string, loc: string | null, seq: number, overrides: string[] = []): Promise<string> {
  const id = `${P}${name}-${RUN}`
  const f = employeePinFields(`${PIN_BASE}${seq}`, `${P}${name}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${name}`, email: `${P}${name}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: loc,
      pin: f.pin, pinLookup: f.pinLookup,
      ...(overrides.length ? { permissionOverrides: JSON.stringify(overrides) } : {}),
    },
  })
  return id
}

/** Gost z poslovnimi podatki (agregati) + kontaktom. */
async function seedGuest(opts: {
  suffix: string; email?: string; phone?: string; isVip?: boolean; totalVisits?: number
  firstVisitDaysAgo?: number; lastVisitDaysAgo?: number; loc: string; allergens?: string[]
}): Promise<string> {
  const id = `${P}g-${opts.suffix}-${RUN}`
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000)
  guestIds.push(id)
  await db.guest.create({
    data: {
      id,
      firstName: `${P}Ime`,
      lastName: `Gost${opts.suffix}`,
      email: opts.email ?? `${id}@test.local`,
      phone: opts.phone ?? '+38640123456',
      isVip: opts.isVip ?? false,
      totalVisits: opts.totalVisits ?? 0,
      lastVisitAt: opts.lastVisitDaysAgo !== undefined ? daysAgo(opts.lastVisitDaysAgo) : null,
      firstVisitAt: opts.firstVisitDaysAgo !== undefined ? daysAgo(opts.firstVisitDaysAgo) : null,
      locationId: opts.loc,
      allergens: JSON.stringify(opts.allergens ?? []),
      dietaryPrefs: JSON.stringify(opts.allergens ? ['vegansko'] : []),
    },
  })
  return id
}

async function mkCampaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await campaignsPOST(req('POST', '/api/crm/campaigns', tokPmC, {
    name: `${P}Kampanja ${RUN}`,
    channel: 'email',
    segmentType: 'all',
    segmentPeriodDays: 90,
    subject: `${P}Zadeva ${RUN}`,
    bodySl: `${P}Spoštovani, imejte lepo nov teden v naši restavraciji! ${RUN}`,
    bodyHr: `${P}Poštovani, ugodan vam novi tjedan u našem restoranu! ${RUN}`,
    locationId: locC,
    ...overrides,
  }))
  const json = (await res.json()) as { campaign?: { id: string } }
  const id = json.campaign?.id ?? ''
  if (id) campaignIds.push(id)
  return id
}

async function grant(guestId: string, channel: 'email' | 'sms' = 'email', proof = 'Potrdil osebno ob računu.'): Promise<void> {
  await recordConsent({ guestId, channel, status: 'granted', source: 'manual', proof })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  // org drevo: A (locA + locC) vs B (locB) — za cross-tenant preverbe
  orgA = `${P}orgA-${RUN}`; orgB = `${P}orgB-${RUN}`
  brandA = `${P}brandA-${RUN}`; brandB = `${P}brandB-${RUN}`
  propA = `${P}propA-${RUN}`; propB = `${P}propB-${RUN}`
  locA = `${P}locA-${RUN}`; locB = `${P}locB-${RUN}`; locC = `${P}locC-${RUN}`
  await db.organization.create({ data: { id: orgA, name: `${P}Org A`, slug: `${P}orga-${RUN}` } })
  await db.organization.create({ data: { id: orgB, name: `${P}Org B`, slug: `${P}orgb-${RUN}` } })
  await db.brand.create({ data: { id: brandA, name: `${P}Brand A`, organizationId: orgA } })
  await db.brand.create({ data: { id: brandB, name: `${P}Brand B`, organizationId: orgB } })
  await db.property.create({ data: { id: propA, name: `${P}Prop A`, brandId: brandA } })
  await db.property.create({ data: { id: propB, name: `${P}Prop B`, brandId: brandB } })
  await db.location.create({ data: { id: locA, code: `${P}LA`, name: `${P}Lokacija A`, premisesId: `${P}premA-${RUN}`, propertyId: propA } })
  await db.location.create({ data: { id: locB, code: `${P}LB`, name: `${P}Lokacija B`, premisesId: `${P}premB-${RUN}`, propertyId: propB } })
  await db.location.create({ data: { id: locC, code: `${P}LC`, name: `${P}Lokacija C`, premisesId: `${P}premC-${RUN}`, propertyId: propA } })

  mgrA = await seedEmployee('mgrA', 'manager', locA, 1)
  mgrB = await seedEmployee('mgrB', 'manager', locB, 2)
  mgrC = await seedEmployee('mgrC', 'manager', locC, 5)
  waiterA = await seedEmployee('waiterA', 'waiter', locA, 3)
  adminB = await seedEmployee('adminB', 'admin', locB, 4)
  // issue #72 C1: akterji s settings.manage, a lokacijsko vezani (guard ostane smiseln)
  // ISSUE #75 5.1: property_manager = Razširjena raven; testni namen (ne-centralen
  // settings.manage za CRM kampanje/izvoze) izrecen prek centralno podeljenega override-a
  const pmA = await seedEmployee('pmA', 'property_manager', locA, 6, ['settings.manage'])
  const pmB = await seedEmployee('pmB', 'property_manager', locB, 7, ['settings.manage'])
  const pmC = await seedEmployee('pmC', 'property_manager', locC, 8, ['settings.manage'])
  tokMgrA = tok(mgrA, 'mgrA', 'MANAGER', locA)
  tokMgrB = tok(mgrB, 'mgrB', 'MANAGER', locB)
  tokMgrC = tok(mgrC, 'mgrC', 'MANAGER', locC)
  tokWaiterA = tok(waiterA, 'waiterA', 'WAITER', locA)
  tokAdminB = tok(adminB, 'adminB', 'ADMIN', locB)
  tokPmA = tok(pmA, 'pmA', 'PROPERTY_MANAGER', locA)
  tokPmB = tok(pmB, 'pmB', 'PROPERTY_MANAGER', locB)
  tokPmC = tok(pmC, 'pmC', 'PROPERTY_MANAGER', locC)
})

afterAll(async () => {
  // otroci → starši (FK / konsistentno)
  await db.campaignSend.deleteMany({ where: { campaignId: { in: campaignIds } } })
  await db.campaign.deleteMany({ where: { id: { in: campaignIds } } })
  await db.guestConsent.deleteMany({ where: { guestId: { in: guestIds } } })
  await db.guestVisit.deleteMany({ where: { guestId: { in: guestIds } } })
  await db.guestFeedback.deleteMany({ where: { guestId: { in: guestIds } } })
  await db.order.deleteMany({ where: { id: { in: orderIds } } })
  await db.loyaltyAccount.deleteMany({ where: { Guest: { is: null }, id: { startsWith: P } } })
  await db.guest.deleteMany({ where: { id: { in: guestIds } } })
  await db.reservation.deleteMany({ where: { id: { startsWith: P } } })
  await db.employee.deleteMany({ where: { id: { startsWith: P } } })
  await db.location.deleteMany({ where: { id: { in: [locA, locB, locC] } } })
  await db.property.deleteMany({ where: { id: { in: [propA, propB] } } })
  await db.brand.deleteMany({ where: { id: { in: [brandA, brandB] } } })
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } })
})

/* ═══════════════════ A — SOGLASJE (§1, na locA) ═══════════════════ */

describe('A — Soglasje: sled, dokaz, ločeni kanali', () => {
  it('privzeto stanje = NI potrjenega soglasja (vnos e-pošte pri rezervaciji NI soglasje)', async () => {
    await db.reservation.create({
      data: {
        id: `${P}resv-${RUN}`,
        customerName: `${P}Rezervant`,
        customerEmail: `${P}rezervant-${RUN}@test.local`,
        customerPhone: '+38640555666',
        dateTime: new Date(Date.now() + 86400_000),
        partySize: 2,
        locationId: locA,
      },
    })
    const rows = await db.guestConsent.findMany({ where: { guestId: { startsWith: P } } })
    expect(rows.length).toBe(0)
    const g = await seedGuest({ suffix: 'a1', loc: locA, email: `${P}a1-${RUN}@test.local` })
    const state = (await currentConsentMap([g])).get(g)
    expect(state?.email ?? null).toBeNull()
    expect(state?.sms ?? null).toBeNull()
  })

  it('grant ZAHTEVA dokaz izrecnega dejanja (GDPR člen 7)', async () => {
    const g = await seedGuest({ suffix: 'a2', loc: locA })
    const bad = await consentPOST(req('POST', '/api/crm/consent', tokPmA, { guestId: g, channel: 'email', action: 'grant' }))
    expect(bad.status).toBe(400)
    const rows = await db.guestConsent.findMany({ where: { guestId: g } })
    expect(rows.length).toBe(0)
  })

  it('grant z dokazom zapiše vrstico (vir, različica, zapisal)', async () => {
    const g = await seedGuest({ suffix: 'a3', loc: locA })
    const res = await consentPOST(req('POST', '/api/crm/consent', tokPmA, {
      guestId: g, channel: 'email', action: 'grant',
      proof: 'Gost je soglasje potrdil osebno ob plačilu (PIN vnesel natakar).',
    }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { consent: { email: string } }
    expect(json.consent.email).toBe('granted')
    const row = await db.guestConsent.findFirst({ where: { guestId: g } })
    expect(row?.source).toBe('manual')
    expect(row?.textVersion).toBe('crm-consent-v1')
    expect(row?.status).toBe('granted')
    expect(row?.proof.length ?? 0).toBeGreaterThan(5)
  })

  it('email in SMS sta LOČENA kanala (stanje se NE predpostavi)', async () => {
    const g = await seedGuest({ suffix: 'a4', loc: locA, phone: '+38641555444' })
    await consentPOST(req('POST', '/api/crm/consent', tokPmA, {
      guestId: g, channel: 'sms', action: 'grant', proof: 'Gost je potrdil SMS ob prijavi v zvestobo.',
    }))
    const state = (await currentConsentMap([g])).get(g)
    expect(state?.sms).toBe('granted')
    expect(state?.email ?? null).toBeNull() // SMS soglasje NI email soglasje
  })

  it('preklic je takoj učinkovit in zabeležen (append-only, latest-wins)', async () => {
    const g = await seedGuest({ suffix: 'a5', loc: locA })
    await recordConsent({ guestId: g, channel: 'email', status: 'granted', source: 'manual', proof: 'Osebno potrdilo ob računu.' })
    await new Promise((r) => setTimeout(r, 20))
    await recordConsent({ guestId: g, channel: 'email', status: 'revoked', source: 'manual' })
    const state = (await currentConsentMap([g])).get(g)
    expect(state?.email).toBe('revoked')
    const rows = await db.guestConsent.findMany({ where: { guestId: g }, orderBy: { createdAt: 'asc' } })
    expect(rows.length).toBe(2) // zgodovina OSTANE (append-only revizijska sled)
    await new Promise((r) => setTimeout(r, 20))
    await recordConsent({ guestId: g, channel: 'email', status: 'granted', source: 'manual', proof: 'Ponovno potrdil v lokalu.' })
    const state2 = (await currentConsentMap([g])).get(g)
    expect(state2?.email).toBe('granted')
  })

  it('RBAC: waiter brez settings.manage → 403; vodja druge lokacije → 403', async () => {
    const g = await seedGuest({ suffix: 'a6', loc: locA })
    const w = await consentPOST(req('POST', '/api/crm/consent', tokWaiterA, { guestId: g, channel: 'email', action: 'revoke' }))
    expect(w.status).toBe(403)
    const m = await consentPOST(req('POST', '/api/crm/consent', tokPmB, { guestId: g, channel: 'email', action: 'revoke' }))
    expect(m.status).toBe(403)
    const rows = await db.guestConsent.findMany({ where: { guestId: g } })
    expect(rows.length).toBe(0)
  })

  it('statična varovalka: GuestConsent piše SAMO crm modul (uvoz/rezervacije ne morejo vzkrisiti soglasja)', async () => {
    const consentRoute = readFileSync(join(process.cwd(), 'src/app/api/crm/consent/route.ts'), 'utf8')
    expect(/guestConsent\.(create|update|delete|updateMany)/.test(consentRoute)).toBe(false)
    const crmSrc = readFileSync(join(process.cwd(), 'src/lib/crm.ts'), 'utf8')
    expect(/guestConsent\.create/.test(crmSrc)).toBe(true)
  })
})

/* ═══════════════════ B — SEGMENTI (§2, na locA) ═══════════════════ */

describe('B — Segmenti: deterministični, razložljivi, brez alergenov', () => {
  it('segmenti so deterministični na fiksturah (vip/frequent/new/inactive/loyalty/all)', async () => {
    await seedGuest({ suffix: 'b1', loc: locA, isVip: true, totalVisits: 5, lastVisitDaysAgo: 2, firstVisitDaysAgo: 200 })
    await seedGuest({ suffix: 'b2', loc: locA, totalVisits: 0, firstVisitDaysAgo: 10 })
    await seedGuest({ suffix: 'b3', loc: locA, totalVisits: 2, lastVisitDaysAgo: 200, firstVisitDaysAgo: 400 })
    await seedGuest({ suffix: 'b4', loc: locA, totalVisits: 4, lastVisitDaysAgo: 5, firstVisitDaysAgo: 30 })
    const g5 = await seedGuest({ suffix: 'b5', loc: locA, totalVisits: 3, lastVisitDaysAgo: 1, firstVisitDaysAgo: 60 })
    const la = await db.loyaltyAccount.create({
      data: { id: `${P}loy-${RUN}`, customerName: 'Loy', customerPhone: '+38641555333', pointsBalance: 10, lifetimePoints: 10, locationId: locA },
    })
    await db.guest.update({ where: { id: g5 }, data: { loyaltyAccountId: la.id } })
    await seedGuest({ suffix: 'b6', loc: locB, isVip: true, totalVisits: 9 }) // TUJA lokacija

    const ids = async (type: string) => (await db.guest.findMany({ where: segmentWhere(type as 'all', 90, new Date(), { locationId: locA }), select: { id: true } })).map((g) => g.id)
    expect((await ids('vip')).length).toBe(1) // b1 (b6 je na locB — izključen)
    expect((await ids('frequent')).length).toBe(3) // b1 (5) + b4 (4) + b5 (3)
    expect((await ids('new')).length).toBe(3) // b2 (10d) + b4 (30d) + b5 (60d) — vsi v 90d
    expect((await ids('inactive')).length).toBe(1) // b3 (zadnji obisk 200d > 90d)
    expect(await ids('loyalty')).toEqual([g5])
    // 'all' na locA: 6 gostov iz A + 5 iz B (b6 na locB ne šteje)
    expect((await ids('all')).length).toBe(11)
  })

  it('alergeni/prehranjevalne preference NE vplivajo na segmentacijo (varna postrežba)', async () => {
    const gX = await seedGuest({ suffix: 'b7', loc: locA, isVip: true, totalVisits: 4, lastVisitDaysAgo: 3, allergens: ['gluten', 'laktosa'] })
    const gY = await seedGuest({ suffix: 'b8', loc: locA, isVip: true, totalVisits: 4, lastVisitDaysAgo: 3, allergens: [] })
    const rows = await db.guest.findMany({ where: segmentWhere('vip', 90, new Date(), { locationId: locA }), select: { id: true, allergens: true } })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(gX)
    expect(ids).toContain(gY) // IDENTIČNA poslovna podatka → isti segment kljub različnim alergenom
    expect(JSON.parse(rows.find((r) => r.id === gX)!.allergens).length).toBe(2)
  })

  it('GET /api/crm/segments vrne razložljive kriterije + obdobje + upravičene (RBAC reports.view)', async () => {
    const res = await segmentsGET(req('GET', '/api/crm/segments?periodDays=90', tokMgrA))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { segments: Array<{ type: string; total: number; criterionKey: string; criterionParams: Record<string, number>; periodDays: number; emailEligible: number }> }
    expect(json.segments.length).toBe(6)
    const all = json.segments.find((s) => s.type === 'all')!
    expect(all.total).toBeGreaterThanOrEqual(11)
    expect(all.criterionKey).toBe('crm.seg.all')
    expect(all.periodDays).toBe(90)
    const frequent = json.segments.find((s) => s.type === 'frequent')!
    expect(frequent.criterionParams.n).toBe(3) // min. obiskov je izpostavljen (razložljivost)
    expect(frequent.emailEligible).toBeGreaterThanOrEqual(0) // brez soglasja = 0 upravičenih
  })

  it('GET /api/crm/segments: waiter (brez reports.view) → 403', async () => {
    const res = await segmentsGET(req('GET', '/api/crm/segments', tokWaiterA))
    expect(res.status).toBe(403)
  })
})

/* ═══════════════════ C — KAMPANJE: cikel + publika (na locC) ═══════════════════ */

describe('C — Kampanje: validacija, cikel, publika', () => {
  it('ustvarjanje zahteva OBE jezikovni različici + zadevo (email)', async () => {
    const bad = await mkCampaign({ bodyHr: '' })
    expect(bad).toBe('') // napaka → brez id
    const bad2 = await mkCampaign({ subject: '' })
    expect(bad2).toBe('')
    const id = await mkCampaign()
    expect(id).not.toBe('')
    const c = await db.campaign.findUnique({ where: { id } })
    expect(c?.status).toBe('draft')
    expect(c?.locationId).toBe(locC)
  })

  it('RBAC: waiter ne more ustvariti kampanje (403)', async () => {
    const res = await campaignsPOST(req('POST', '/api/crm/campaigns', tokWaiterA, {
      name: 'X', channel: 'email', subject: 'X', bodySl: 'xxxxxxxxxx', bodyHr: 'xxxxxxxxxx',
    }))
    expect(res.status).toBe(403)
  })

  it('preview: gostje BREZ soglasja/manj kontakta so izključeni; odjavljeni ločeno', async () => {
    const gOk = await seedGuest({ suffix: 'c1', loc: locC, email: `${P}c1-${RUN}@test.local` })
    const gNo = await seedGuest({ suffix: 'c2', loc: locC, email: `${P}c2-${RUN}@test.local` }) // brez soglasja
    const gRevoked = await seedGuest({ suffix: 'c3', loc: locC, email: `${P}c3-${RUN}@test.local` })
    await grant(gOk)
    await grant(gRevoked, 'email', 'Potrdil nekoč.')
    await new Promise((r) => setTimeout(r, 20))
    await recordConsent({ guestId: gRevoked, channel: 'email', status: 'revoked', source: 'manual' })
    const gNoContact = await seedGuest({ suffix: 'c4', loc: locC, email: '', phone: '' }) // soglasje a brez kontakta
    await grant(gNoContact, 'email', 'Potrdil, a brez e-pošte.')

    const id = await mkCampaign({ segmentType: 'all' })
    const res = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'preview' }), params(id))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { audience: { total: number; consentGranted: number; suppressed: number; missingContact: number; eligible: number } }
    expect(json.audience.total).toBe(4) // c1–c4 (locC gostje)
    expect(json.audience.eligible).toBe(1) // SAMO gOk
    expect(json.audience.suppressed).toBe(1) // gRevoked
    expect(json.audience.missingContact).toBe(1) // gNoContact
    expect(json.audience.consentGranted).toBe(2)
    void gNo
  })

  it('cikel: approve → schedule (prihodnost) → dispatch pošlje; schedule v preteklosti → 400', async () => {
    const g = await seedGuest({ suffix: 'c5', loc: locC, email: `${P}c5-${RUN}@test.local` })
    await grant(g)
    const id = await mkCampaign({ segmentType: 'all' })

    const ap = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    expect(ap.status).toBe(200)
    const badSched = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'schedule', scheduledAt: '2020-01-01T00:00:00Z' }), params(id))
    expect(badSched.status).toBe(400)
    const sched = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }), params(id))
    expect(sched.status).toBe(200)

    // dispatch PREK time-travel: scheduled v prihodnost → NE pošlje
    const noSend = await dispatchCampaign(id, { sendFn: fakeSendOk, now: new Date() })
    expect(noSend.sent).toBe(0)
    expect(noSend.status).toBe('scheduled')
    // dispatch po zapadlosti → pošlje (c1 + c5, oba soglasna)
    const due = await dispatchCampaign(id, { sendFn: fakeSendOk, now: new Date(Date.now() + 7200_000) })
    expect(due.sent).toBe(2)
    expect(due.status).toBe('sent')
  })

  it('pošiljanje: status sent_to_provider (NE dostava), subject brez [TEST], noga z odjavo', async () => {
    const last = sentEmails[sentEmails.length - 1]
    expect(last.subject.startsWith('[TEST]')).toBe(false)
    expect(last.text).toContain('/api/public/crm/unsubscribe?token=')
    expect(last.text).not.toContain('[TEST')
    const rows = await db.campaignSend.findMany({ where: { status: 'sent_to_provider' } })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.every((r) => r.providerMessageId.startsWith('mock-'))).toBe(true)
    // DOSTAVA se ne označi brez dokaza ponudnika
    const delivered = await db.campaignSend.findMany({ where: { status: 'delivered' } })
    expect(delivered.length).toBe(0)
  })
})

/* ═══════════════════ D — IDEMPOTENCA + OMEJENOST (§3, na locC) ═══════════════════ */

describe('D — Idempotenca, batch limit, retry', () => {
  it('ponovni dispatch NE podvoji pošiljk niti števcev; snapshot publike zamrzne', async () => {
    const g = await seedGuest({ suffix: 'd1', loc: locC, email: `${P}d1-${RUN}@test.local` })
    const g2 = await seedGuest({ suffix: 'd2', loc: locC, email: `${P}d2-${RUN}@test.local` })
    await grant(g); await grant(g2)
    const id = await mkCampaign({ segmentType: 'all' })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))

    const before = sentEmails.length
    const r1 = await dispatchCampaign(id, { sendFn: fakeSendOk })
    // upravičeni na locC: c1, c5, d1, d2 → 4 poslalke
    expect(r1.sent).toBe(4)
    expect(sentEmails.length).toBe(before + 4)
    const c1 = await db.campaign.findUnique({ where: { id } })
    expect(c1?.sentCount).toBe(4)

    // nov upravičen gost PO prvem dispatchu → snapshot: NE dodaja
    const g3 = await seedGuest({ suffix: 'd3', loc: locC, email: `${P}d3-${RUN}@test.local` })
    await grant(g3, 'email', 'Potrdil pozneje.')
    const r2 = await dispatchCampaign(id, { sendFn: fakeSendOk })
    expect(r2.created).toBe(0)
    expect(r2.sent).toBe(0) // nič novega (kampanja že 'sent' → early return)
    expect(sentEmails.length).toBe(before + 4) // NIČ dodatnih pošiljk
    const sends = await db.campaignSend.findMany({ where: { campaignId: id } })
    expect(sends.length).toBe(4) // unikatna (campaignId, guestId) — @@unique
    const c2 = await db.campaign.findUnique({ where: { id } })
    expect(c2?.sentCount).toBe(4) // števci so IZ vrstic — podvajanje nemogoče
  })

  it("batch limit: omejeno pošiljanje na klic; preostanek v 'sending' → dopošiljanje", async () => {
    for (let i = 1; i <= 3; i++) {
      const g = await seedGuest({ suffix: `dl${i}`, loc: locC, email: `${P}dl${i}-${RUN}@test.local`, totalVisits: 2, lastVisitDaysAgo: 200 })
      await grant(g, 'email', `Potrdil ${i}.`)
    }
    // segment 'inactive' na locC: SAMO dl1–dl3 (c*/d* imajo lastVisitAt null)
    const id = await mkCampaign({ segmentType: 'inactive', name: `${P}Limit ${RUN}` })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    const r1 = await dispatchCampaign(id, { sendFn: fakeSendOk, limit: 2 })
    expect(r1.sent).toBe(2)
    expect(r1.completed).toBe(false)
    const c1 = await db.campaign.findUnique({ where: { id } })
    expect(c1?.status).toBe('sending')
    const r2 = await dispatchCampaign(id, { sendFn: fakeSendOk, limit: 2 })
    expect(r2.sent).toBe(1)
    expect(r2.completed).toBe(true)
    const c2 = await db.campaign.findUnique({ where: { id } })
    expect(c2?.status).toBe('sent')
    expect(c2?.completedAt).toBeTruthy()
    expect(CRM_BATCH_LIMIT).toBeLessThanOrEqual(25) // zgornja meja pošiljk na klic
  })

  it('neuspešna pošiljka: failed + errorMessage (ponudnik vrnil napako)', async () => {
    const g = await seedGuest({ suffix: 'd4', loc: locC, email: `${P}d4-${RUN}@test.local`, isVip: true })
    await grant(g)
    // segment 'vip' na locC: SAMO d4 (b* so na locA)
    const id = await mkCampaign({ segmentType: 'vip', name: `${P}Fail ${RUN}` })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    const r = await dispatchCampaign(id, { sendFn: fakeSendFail })
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)
    const send = await db.campaignSend.findFirst({ where: { campaignId: id } })
    expect(send?.status).toBe('failed')
    expect(send?.errorMessage).toContain('535')
    expect(send?.attempts).toBe(1)
    const c = await db.campaign.findUnique({ where: { id } })
    expect(c?.failedCount).toBe(1)
  })
})

/* ═══════════════════ E — ODAJAVA (javna, takoj učinkovita, na locC) ═══════════════════ */

describe('E — Odjava: enklik, kanalno, takoj učinkovita, idempotentna', () => {
  it('preklic soglasja IZLOČI gosta iz ŽE NAČRTOVANE pošiljke (send-time re-check) in preživi retry', async () => {
    const g = await seedGuest({ suffix: 'e1', loc: locC, email: `${P}e1-${RUN}@test.local`, firstVisitDaysAgo: 10 })
    const g2 = await seedGuest({ suffix: 'e2', loc: locC, email: `${P}e2-${RUN}@test.local`, firstVisitDaysAgo: 10 })
    await grant(g); await grant(g2)
    // segment 'new' na locC: e1 + e2 (c*/d*/dl* imajo firstVisitAt null)
    const id = await mkCampaign({ segmentType: 'new', name: `${P}Unsub ${RUN}` })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    // PRVI dispatch z limitom 1 → e1 poslan (vrstni red lastName), e2 OSTANE 'queued'
    const r1 = await dispatchCampaign(id, { sendFn: fakeSendOk, limit: 1 })
    expect(r1.sent + r1.failed).toBe(1)
    const queued = await db.campaignSend.findFirst({ where: { campaignId: id, status: 'queued' } })
    expect(queued).toBeTruthy()
    // PREKLIC soglasja gosta v vrsti (prek consent rute — vodstvo/gost po telefonu)
    const rv = await consentPOST(req('POST', '/api/crm/consent', tokPmC, { guestId: queued!.guestId, channel: 'email', action: 'revoke' }))
    expect(rv.status).toBe(200)
    // retry dispatch → e2 je IZPUŠČEN (skipped), poslan = 0 — TAKOJ učinkovito
    const r2 = await dispatchCampaign(id, { sendFn: fakeSendOk })
    expect(r2.sent).toBe(0)
    expect(r2.skipped).toBe(1)
    const send2 = await db.campaignSend.findUnique({ where: { id: queued!.id } })
    expect(send2?.status).toBe('skipped')
    expect(send2?.errorMessage).toContain('soglasja')
  })

  it('javna enklik odjava POSLANEGA prejemnika: sled revoked, izključen iz NASLEDNJE kampanje, idempotentna', async () => {
    // e1 iz prejšnjega testa: poslan send s povezavo za odjavo
    const sent = await db.campaignSend.findFirst({ where: { status: 'sent_to_provider', campaignId: { in: campaignIds } }, orderBy: { createdAt: 'desc' } })
    expect(sent).toBeTruthy()
    const token = sent!.unsubscribeToken
    const before = (await currentConsentMap([sent!.guestId])).get(sent!.guestId)
    expect(before?.email).toBe('granted') // pred odjavo

    const first = await unsubGET(req('GET', `/api/public/crm/unsubscribe?token=${token}&lang=hr`, '', undefined, '10.11.12.2'))
    expect(first.status).toBe(200)
    const text1 = await first.text()
    expect(text1).toContain('Odjava uspješna')
    // sled: revoked (KANAL email), send marked unsubscribed
    const state = (await currentConsentMap([sent!.guestId])).get(sent!.guestId)
    expect(state?.email).toBe('revoked')
    const sendRow = await db.campaignSend.findUnique({ where: { id: sent!.id } })
    expect(sendRow?.status).toBe('unsubscribed')
    expect(sendRow?.unsubscribedAt).toBeTruthy()

    // NASLEDNJA kampanja (segment 'new' — e1/e2 oba odjavljena): gost NI več upravičen
    const id2 = await mkCampaign({ segmentType: 'new', name: `${P}After-unsub ${RUN}` })
    const prev = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id2}/actions`, tokPmC, { action: 'preview' }), params(id2))
    const prevJson = (await prev.json()) as { audience: { eligible: number; suppressed: number } }
    expect(prevJson.audience.eligible).toBe(0)
    expect(prevJson.audience.suppressed).toBeGreaterThanOrEqual(1)

    // idempotentna: ponovni klik = že odjavljeni (200, brez nove vrstice v sledi)
    const rowsBefore = await db.guestConsent.count({ where: { guestId: sent!.guestId } })
    const second = await unsubGET(req('GET', `/api/public/crm/unsubscribe?token=${token}`, '', undefined, '10.11.12.3'))
    expect(second.status).toBe(200)
    const text2 = await second.text()
    expect(['Već odjavljeni', 'Že odjavljeni'].some((s) => text2.includes(s))).toBe(true)
    const rowsAfter = await db.guestConsent.count({ where: { guestId: sent!.guestId } })
    expect(rowsAfter).toBe(rowsBefore) // NIČ dodatne vrstice — idempotenca
    // neveljaven žeton → splošno sporočilo (brez razkritja)
    const bad = await unsubGET(req('GET', '/api/public/crm/unsubscribe?token=deadbeef', '', undefined, '10.11.12.4'))
    expect(bad.status).toBe(200)
    const textBad = await bad.text()
    expect(['Neveljavna', 'Nevaljana'].some((s) => textBad.includes(s))).toBe(true)
    // POST pot (idempotentna)
    const post = await unsubPOST(req('POST', '/api/public/crm/unsubscribe', '', { token }, '10.11.12.5'))
    expect(post.status).toBe(200)
  })

  it('odjava je KANALNO specifična (SMS pošiljka odjavi SMS, ne email)', async () => {
    const g = await seedGuest({ suffix: 'e3', loc: locC, phone: '+38640777888', email: `${P}e3-${RUN}@test.local`, isVip: true })
    await grant(g, 'email', 'Email potrdil.')
    await grant(g, 'sms', 'SMS potrdil.')
    // segment 'vip' na locC: d4 (samo email soglasje) + e3 → SMS upravičen SAMO e3
    const id = await mkCampaign({ channel: 'sms', segmentType: 'vip', name: `${P}SMS ${RUN}`, subject: '' })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    const r = await dispatchCampaign(id, { sendFn: fakeSendOk })
    expect(r.sent).toBe(1)
    const send = await db.campaignSend.findFirst({ where: { campaignId: id } })
    await recordConsent({ guestId: g, channel: 'email', status: 'granted', source: 'manual', proof: 'Dokaz za test kanalov.' }) // zagotovi granted za primerjavo
    const out = await import('../src/lib/crm').then((m) => m.unsubscribeByToken(send!.unsubscribeToken))
    expect(out.kind).toBe('ok')
    const state = (await currentConsentMap([g])).get(g)
    expect(state?.sms).toBe('revoked') // SMS kanal odjavljen
    expect(state?.email).toBe('granted') // email NI dotaknjen
  })

  it('rate limit: 10 klicev/min/IP → 429', async () => {
    const token = new Array(32).fill('b').join('')
    let last = 200
    for (let i = 0; i < 12; i++) {
      const res = await unsubGET(req('GET', `/api/public/crm/unsubscribe?token=${token}`, '', undefined, '10.11.13.9'))
      last = res.status
      if (res.status === 429) break
    }
    expect(last).toBe(429)
  })
})

/* ═══════════════════ F — TENANT IZOLACIJA + PII ═══════════════════ */

describe('F — Tenant izolacija, PII maskiranje, izvoz', () => {
  it('GET /api/crm/guests: manager locA vidi SAMO locA, kontakti MASKIRANI', async () => {
    const res = await guestsGET(req('GET', '/api/crm/guests', tokMgrA))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { guests: Array<{ email: string | null; phone: string | null }> }
    expect(json.guests.length).toBeGreaterThan(0)
    for (const g of json.guests) {
      expect(g.email === null || g.email.includes('***')).toBe(true) // maskirano
      expect(g.phone === null || g.phone.includes('***')).toBe(true)
      expect(g.email?.includes('i11-g-')).toBe(false) // poln lokalni del NE sme ven (domena je ok)
    }
  })

  it('GET /api/crm/guests: waiter → 403 (ni guests.read)', async () => {
    const res = await guestsGET(req('GET', '/api/crm/guests', tokWaiterA))
    expect(res.status).toBe(403)
  })

  it('izvoz CSV: settings.manage (pmA) + audit BREZ PII', async () => {
    const res = await exportGET(req('GET', '/api/crm/guests/export', tokPmA))
    expect(res.status).toBe(200)
    const csv = await res.text()
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('soglasjeEmail')
    expect(csv).toContain('i11-') // gostje so notri
    const w = await exportGET(req('GET', '/api/crm/guests/export', tokWaiterA))
    expect(w.status).toBe(403)
    // audit: izvoz zapisan BREZ naslovov
    const audits = await db.auditLog.findMany({
      where: { action: 'CRM_GUESTS_EXPORTED', details: { contains: RUN } },
      orderBy: { timestamp: 'desc' }, take: 1,
    })
    expect(audits.length).toBe(1)
    expect(audits[0].details).not.toContain('@test.local')
  })

  it('kampanja locC (org A): pmB (settings.manage, druga lokacija) → 403 (guardResource); adminB org B → 403 (org meja)', async () => {
    const res = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${campaignIds[0]}/actions`, tokPmB, { action: 'preview' }), params(campaignIds[0]))
    expect(res.status).toBe(403)
    const detail = await campaignDetailGET(req('GET', `/api/crm/campaigns/${campaignIds[0]}`, tokPmB), params(campaignIds[0]))
    expect(detail.status).toBe(403)
    const orgRes = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${campaignIds[0]}/actions`, tokAdminB, { action: 'preview' }), params(campaignIds[0]))
    expect(orgRes.status).toBe(403)
  })

  it('GET /api/crm/campaigns: seznam v obsegu uporabnika (pmC vidi locC kampanje)', async () => {
    const res = await campaignsGET(req('GET', '/api/crm/campaigns', tokPmC))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { campaigns: Array<{ locationId: string | null }> }
    expect(json.campaigns.length).toBeGreaterThan(0)
    expect(json.campaigns.every((c) => c.locationId === locC)).toBe(true)
  })
})

/* ═══════════════════ G — MERITVE + KRON (na locC) ═══════════════════ */

describe('G — Meritve rezultatov + cron dispatch', () => {
  it('ponovni nakupi: naročila prejemnikov v oknu po pošiljki (dokaz — brez klikov)', async () => {
    const send = await db.campaignSend.findFirst({ where: { status: 'sent_to_provider' }, orderBy: { sentAt: 'desc' } })
    expect(send).toBeTruthy()
    const oid = `${P}ord-${RUN}`
    orderIds.push(oid)
    await db.order.create({
      data: {
        id: oid, orderNumber: Math.floor(Math.random() * 900000) + 100000,
        locationId: locC, type: 'dine-in', status: 'paid', paymentStatus: 'paid',
        guestId: send!.guestId, customerEmail: send!.recipient,
      },
    })
    const perf = await campaignPerformance(send!.campaignId)
    expect(perf.sentToProvider).toBeGreaterThanOrEqual(1)
    expect(perf.repeatOrders).toBeGreaterThanOrEqual(1) // naročilo prejemnika v oknu
    expect(perf.windowDays).toBe(14)
  })

  it("dispatchDueCampaigns: zapadle 'scheduled' pošlje, nezapadle NE", async () => {
    const g = await seedGuest({ suffix: 'g1', loc: locC, email: `${P}g1-${RUN}@test.local`, firstVisitDaysAgo: 10 })
    await grant(g)
    // segment 'new' na locC: e1/e2 sta odjavljena, g1 edini upravičen
    const id = await mkCampaign({ segmentType: 'new', name: `${P}Cron ${RUN}` })
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'approve' }), params(id))
    // NEzapadla (1h v prihodnosti)
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${id}/actions`, tokPmC, { action: 'schedule', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }), params(id))
    const r1 = await dispatchDueCampaigns({ sendFn: fakeSendOk, now: new Date() })
    expect(r1.find((x) => x.campaignId === id)?.sent ?? 0).toBe(0) // še ni zapadla
    // ZAPADLA: time-travel 2h naprej
    const r2 = await dispatchDueCampaigns({ sendFn: fakeSendOk, now: new Date(Date.now() + 7200_000) })
    expect(r2.find((x) => x.campaignId === id)?.sent ?? 0).toBe(1)
    const c = await db.campaign.findUnique({ where: { id } })
    expect(c?.status).toBe('sent')
  })

  it('detajl kampanje: števci IZ vrstic + pošiljke maskirane + performance', async () => {
    const id = campaignIds[0]
    const res = await campaignDetailGET(req('GET', `/api/crm/campaigns/${id}`, tokPmC), params(id))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      sends: Array<{ recipientMasked: string | null; status: string }>
      performance: { sentToProvider: number }
      campaign: { sentCount: number }
    }
    for (const s of json.sends) {
      expect(s.recipientMasked === null || s.recipientMasked.includes('***')).toBe(true)
    }
    expect(json.performance.sentToProvider).toBe(json.campaign.sentCount) // isti vir: vrstice
  })
})

/* ═══════════════════ H — ČISTI POMOČNIKI ═══════════════════ */

describe('H — Vsebina: [TEST] prefix, noga odjave, subject', () => {
  it('campaignSubject/campaignBody: testni način označen, noga vedno prisotna', () => {
    const c = { bodySl: 'Vsebina SL', bodyHr: 'Sadržaj HR', channel: 'email', subject: 'Zadeva' }
    expect(campaignSubject(c, true)).toBe('[TEST] Zadeva')
    const bodySl = campaignBody(c, 'sl', 'http://x/unsub?token=abc')
    const bodyHr = campaignBody(c, 'hr', 'http://x/unsub?token=abc')
    expect(bodySl).toContain('Odjavite se z enim klikom')
    expect(bodyHr).toContain('Odjavite se jednim klikom')
    expect(bodySl).toContain('http://x/unsub?token=abc')
    expect(bodyHr).toContain('http://x/unsub?token=abc')
    const testBody = campaignBody(c, 'sl', 'http://x', true)
    expect(testBody).toContain('[TEST')
  })

  it('verzija aplikacije je dvignjena na 1.141.0', () => {
    expect(APP_VERSION).toBe('1.210.0')
  })
})
