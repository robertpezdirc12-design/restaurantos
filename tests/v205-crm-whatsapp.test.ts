/**
 * OSS-7 (v1.205.0) — KAMPANJE PO KANALIH: KANAL WHATSAPP (A-del zaključek).
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md — OrderRestro #14.
 *
 * KONTEKST: kampanjni model + opt-out za email/SMS ŽE obstaja od v1.126.0
 * (Issue #11: Campaign + CampaignSend + GuestConsent + javna enklkova odjava
 * + segmenti) — analiza v1.199.0 tega ni ulovila (lažna vrzel 2, kot OSS-3).
 * Preostali deterministični A-del = TRETJI KANAL WhatsApp:
 *   - channel je String → 0 DDL (vrednost, ne model);
 *   - campaignChannel() fail-closed preslikava (neznan → email);
 *   - ConsentState.whatsapp — LOČENO soglasje (GDPR: en kanal ≠ drug);
 *   - whatsappSendFn = determinističen fail-soft (transport Meta Business API
 *     = B/C lastnik) — vrstica ostane 'failed' z IZRECNO razlogom, NIČ se ne
 *     laže o pošiljanju (princip 3 iz crm.ts);
 *   - odjava po kanalu deluje enako (token → revoke whatsapp).
 *
 * 0 omrežja, 0 AI, 0 novih odvisnosti. Fiksture s predpono v205c-.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { APP_VERSION } from '../src/lib/version'
import {
  CRM_CHANNELS, campaignChannel, isPhoneChannel, whatsappSendFn,
  computeAudience, dispatchCampaign, unsubscribeByToken, newUnsubscribeToken,
  type CampaignSendFn,
} from '../src/lib/crm'
import { POST as consentPOST } from '../src/app/api/crm/consent/route'
import { GET as guestsGET } from '../src/app/api/crm/guests/route'
import { GET as segmentsGET } from '../src/app/api/crm/segments/route'
import { GET as campaignsGET, POST as campaignsPOST } from '../src/app/api/crm/campaigns/route'
import { GET as campaignDetailGET } from '../src/app/api/crm/campaigns/[id]/route'
import { POST as campaignActionsPOST } from '../src/app/api/crm/campaigns/[id]/actions/route'
import { maskPhone } from '../src/lib/pii'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const P = 'v205c-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

let locA = ''
let locB = ''
let pmA = ''
let waiterB = ''
let tokPm = ''
let tokWaiterB = ''

const guestIds: string[] = []
const campaignIds: string[] = []

function req(method: string, url: string, token: string | null, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

async function body(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

async function seedGuest(suffix: string, opts: { email?: string; phone?: string; loc?: string } = {}): Promise<string> {
  const id = `${P}g-${suffix}-${RUN}`
  guestIds.push(id)
  await db.guest.create({
    data: {
      id,
      firstName: `${P}Gost`,
      lastName: suffix,
      email: opts.email ?? '',
      phone: opts.phone ?? '',
      locationId: opts.loc ?? locA,
      totalVisits: 1,
      lastVisitAt: new Date(),
    },
  })
  return id
}

async function cleanup() {
  await db.campaignSend.deleteMany({ where: { OR: [{ campaignId: { startsWith: `${P}cmp` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.guestConsent.deleteMany({ where: { OR: [{ guestId: { startsWith: `${P}g-` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.campaign.deleteMany({ where: { id: { startsWith: `${P}cmp` } } }).catch(() => null)
  await db.guest.deleteMany({ where: { OR: [{ id: { startsWith: `${P}g-` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.auditLog
    .deleteMany({ where: { OR: [{ locationId: { startsWith: P } }, { entityId: { startsWith: `${P}g-` } }, { entityType: 'CampaignSend' }] } })
    .catch(() => null)
  await db.eventLog.deleteMany({ where: { OR: [{ entityId: { startsWith: `${P}g-` } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.employee.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { locationId: { startsWith: P } }] } }).catch(() => null)
  await db.location.deleteMany({ where: { id: { startsWith: P } } }).catch(() => null)
  await sweepTestFixtures(db, [P])
}

beforeAll(async () => {
  await cleanup()

  const la = await db.location.create({
    data: { id: `${P}locA-${RUN}`, name: `${P}Kranj`, code: `H20W-${RUN.toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  locA = la.id
  const lb = await db.location.create({
    data: { id: `${P}locB-${RUN}`, name: `${P}Celje`, code: `H20V-${RUN.toUpperCase()}`, timezone: 'Europe/Ljubljana', country: 'SI' },
  })
  locB = lb.id

  const seed = async (key: string, name: string, role: string, loc: string, seq: number, overrides: string[] = []): Promise<string> => {
    const id = `${P}${key}-${RUN}`
    const f = employeePinFields(`${PIN_BASE}${seq}`, `${id}@test.local`)
    await db.employee.create({
      data: {
        id, name, email: `${id}@test.local`, role, status: 'active', sessionVersion: 0, locationId: loc,
        pin: f.pin, pinLookup: f.pinLookup,
        ...(overrides.length ? { permissionOverrides: JSON.stringify(overrides) } : {}),
      },
    })
    return id
  }
  // issue #72 C1: settings.manage = property_manager z izrecnim override-om (vzorec i11)
  pmA = await seed('pm', `${P}Vodja Vida`, 'property_manager', locA, 1, ['settings.manage'])
  waiterB = await seed('waitB', `${P}Natakar Nino`, 'waiter', locB, 2)
  tokPm = createToken({ sub: pmA, name: `${P}Vodja Vida`, role: 'PROPERTY_MANAGER', loc: locA, sv: 0 })
  tokWaiterB = createToken({ sub: waiterB, name: `${P}Natakar Nino`, role: 'WAITER', loc: locB, sv: 0 })

  // gostje: gW (whatsapp granted v testu Č2), gE (samo email), gR (whatsapp revoked), gN (nič)
  await seedGuest('W', { phone: '+386401112222', email: '' })
  await seedGuest('E', { phone: '+386403334444', email: `g-e-${RUN}@test.local` })
  await seedGuest('R', { phone: '+386405556666', email: '' })
  await seedGuest('N', { phone: '', email: '' })
})

afterAll(async () => {
  await cleanup()
})

/* ═══════════════════ Č1. ČISTI SLOJ (crm.ts — kanalna jedra) ═══════════════════ */

describe('Č1 čisti sloj whatsapp (pure)', () => {
  it('CRM_CHANNELS ima točno 3 kanale — email, sms, whatsapp', () => {
    expect([...CRM_CHANNELS]).toEqual(['email', 'sms', 'whatsapp'])
    expect(CRM_CHANNELS.length).toBe(3)
  })

  it('campaignChannel: fail-closed preslikava — sms/whatsapp/točno, neznan → email', () => {
    expect(campaignChannel('sms')).toBe('sms')
    expect(campaignChannel('whatsapp')).toBe('whatsapp')
    expect(campaignChannel('email')).toBe('email')
    // neznan kanal NIKOLI ne postane sms/whatsapp (fail-closed privzetek = email)
    expect(campaignChannel('morse')).toBe('email')
    expect(campaignChannel('')).toBe('email')
    expect(campaignChannel('WHATSAPP')).toBe('email')
  })

  it('isPhoneChannel: sms + whatsapp telefonska, email naslovna', () => {
    expect(isPhoneChannel('sms')).toBe(true)
    expect(isPhoneChannel('whatsapp')).toBe(true)
    expect(isPhoneChannel('email')).toBe(false)
  })

  it('whatsappSendFn: kanalni gard + determinističen fail-soft (transport B/C)', async () => {
    // gard: napačen kanal zavrnjen
    const wrong = await whatsappSendFn({
      campaignId: 'x', guestId: 'x', channel: 'email', to: 'a@b.c',
      subject: 's', text: 't', locationId: null,
    })
    expect(wrong.ok).toBe(false)
    expect(wrong.detail).toBe('Kanal ni whatsapp')
    // pravi kanal: IZRECNO neuspešno z razlogom (nič se ne laže o pošiljanju)
    const res = await whatsappSendFn({
      campaignId: 'x', guestId: 'x', channel: 'whatsapp', to: '38640111222',
      subject: 's', text: 't', locationId: null,
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('WhatsApp ponudnik ni konfiguriran')
    expect(res.detail).toContain('B/C')
    expect(res.messageId).toBeUndefined()
  })

  it('opt-out infrastruktura nedotaknjena: žeton je 32 hex znakov', () => {
    const t1 = newUnsubscribeToken()
    const t2 = newUnsubscribeToken()
    expect(t1).toMatch(/^[a-f0-9]{32}$/)
    expect(t2).toMatch(/^[a-f0-9]{32}$/)
    expect(t1).not.toBe(t2)
  })
})

/* ═══════════════════ Č2. BACKEND (rute + dispatch + odjava) ═══════════════════ */

describe('Č2 backend whatsapp', () => {
  it('POST /api/crm/campaigns: whatsapp kampanja 200 — subject NI obvezen (samo email)', async () => {
    const r = await campaignsPOST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}WhatsApp akcija`, channel: 'whatsapp', segmentType: 'all',
      segmentPeriodDays: 90, subject: '', bodySl: `${P}Pozdrav whatsapp Slo`,
      bodyHr: `${P}Pozdrav whatsapp Hrv`, locationId: locA,
    }))
    const b = await body(r)
    expect(r.status).toBe(200)
    const c = b.campaign as { id: string; channel: string }
    expect(c.channel).toBe('whatsapp')
    campaignIds.push(c.id)
  })

  it('POST /api/crm/campaigns: neznan kanal 400 (email|sms|whatsapp)', async () => {
    const r = await campaignsPOST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}Morse`, channel: 'morse', bodySl: `${P}Vsebina slo`, bodyHr: `${P}Vsebina hrv`,
      locationId: locA,
    }))
    const b = await body(r)
    expect(r.status).toBe(400)
    expect(String(b.error)).toContain('email, sms ali whatsapp')
  })

  it('POST /api/crm/consent: whatsapp grant + revoke (ločeno od email/sms)', async () => {
    const gW = guestIds[0]
    const gR = guestIds[2]
    // grant za gW
    const ok1 = await consentPOST(req('POST', '/api/crm/consent', tokPm, {
      guestId: gW, channel: 'whatsapp', action: 'grant',
      proof: `${P}Gost je soglasje potrdil osebno (v205 preverba).`,
    }))
    expect(ok1.status).toBe(200)
    // revoke za gR (samo preklic — brez dokaza)
    const ok2 = await consentPOST(req('POST', '/api/crm/consent', tokPm, {
      guestId: gR, channel: 'whatsapp', action: 'revoke',
    }))
    expect(ok2.status).toBe(200)
    // Neveljaven kanal → 400
    const bad = await consentPOST(req('POST', '/api/crm/consent', tokPm, {
      guestId: gW, channel: 'morse', action: 'grant',
    }))
    expect(bad.status).toBe(400)
  })

  it('GET /api/crm/guests: consentWhatsapp v DTO — granted/revoked/ni soglasja', async () => {
    const r = await guestsGET(req('GET', `/api/crm/guests?locationId=${locA}`, tokPm))
    const b = await body(r)
    expect(r.status).toBe(200)
    const rows = b.guests as Array<{ id: string; consentWhatsapp: string | null; consentEmail: string | null; consentSms: string | null }>
    const w = rows.find((g) => g.id === guestIds[0])
    const rev = rows.find((g) => g.id === guestIds[2])
    const none = rows.find((g) => g.id === guestIds[3])
    expect(w?.consentWhatsapp).toBe('granted')
    expect(rev?.consentWhatsapp).toBe('revoked')
    expect(none?.consentWhatsapp).toBeNull()
  })

  it('computeAudience: whatsapp = telefon, LOČENO soglasje — gW edini upravičen', async () => {
    const cmpId = campaignIds[0]
    const cmp = await db.campaign.findUnique({ where: { id: cmpId } })
    expect(cmp?.channel).toBe('whatsapp')
    const aud = await computeAudience({
      segmentType: 'all', segmentPeriodDays: 90, channel: 'whatsapp', locationId: locA,
    })
    expect(aud.total).toBe(4)
    // gW (granted + telefon) edini; gE ima SAMO email soglasje (whatsapp ločeno!);
    // gR revoked → suppressed; gN brez kontakta in brez soglasja
    expect(aud.eligible.length).toBe(1)
    expect(aud.eligible[0].guestId).toBe(guestIds[0])
    expect(aud.eligible[0].recipient).toBe('386401112222')
    expect(aud.eligible[0].recipient).not.toContain('@')
    expect(aud.consentGranted).toBe(1)
    expect(aud.suppressed).toBe(1)
  })

  it('dispatchCampaign brez transporta: VSE vrstice izrecno failed z razlogom (fail-soft)', async () => {
    const cmpId = campaignIds[0]
    // odobri (status approved — dispatch sprejme samo approved/scheduled/sending)
    const app = await campaignActionsPOST(req('POST', `/api/crm/campaigns/${cmpId}/actions`, tokPm, { action: 'approve' }), params(cmpId))
    expect(app.status).toBe(200)
    // privzeti sendFn (whatsappSendFn) — BREZ vbrizganega simulacija
    const res = await dispatchCampaign(cmpId)
    expect(res.created).toBe(1)
    expect(res.sent).toBe(0)
    expect(res.failed).toBe(1)
    const rows = await db.campaignSend.findMany({ where: { campaignId: cmpId } })
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].channel).toBe('whatsapp')
    expect(rows[0].errorMessage).toContain('WhatsApp ponudnik ni konfiguriran')
    // kampanja: nSent === 0 && nFailed > 0 → status 'failed' (dokazano stanje)
    const cmp = await db.campaign.findUnique({ where: { id: cmpId } })
    expect(cmp?.status).toBe('failed')
  })

  it('odjava po žetonu deluje kanalno: whatsapp revoke → GuestConsent + idempotenca', async () => {
    // PRava vrstica iz dispatcha (failed status NE blokira odjave — odjava deluje
    // neodvisno od statusa vrstice, kot za email/sms); žeton je bil ustvarjen ob
    // prvem zagonu dispatcha (snapshot publike)
    const row = await db.campaignSend.findFirst({ where: { campaignId: campaignIds[0], guestId: guestIds[0] } })
    expect(row).toBeDefined()
    const token = (row as { unsubscribeToken: string }).unsubscribeToken
    const out = await unsubscribeByToken(token)
    expect(out.kind).toBe('ok')
    expect(out.channel).toBe('whatsapp')
    // idempotenca: drugi klik = 'already'
    const again = await unsubscribeByToken(token)
    expect(again.kind).toBe('already')
    expect(again.channel).toBe('whatsapp')
    // GuestConsent: nova vrstica revoked whatsapp (append-only sled)
    const consents = await db.guestConsent.findMany({
      where: { guestId: guestIds[0], channel: 'whatsapp', purpose: 'marketing' },
      orderBy: { actedAt: 'asc' },
    })
    expect(consents.length).toBe(2) // grant (route) + revoke (odjava)
    expect(consents[consents.length - 1].status).toBe('revoked')
    expect(consents[consents.length - 1].source).toBe('unsubscribe_link')
    // po odjavi publika vsebuje 0 upravičenih (send-time re-check)
    const aud = await computeAudience({
      segmentType: 'all', segmentPeriodDays: 90, channel: 'whatsapp', locationId: locA,
    })
    expect(aud.suppressed).toBe(2) // gR + gW (odjavljen)
    expect(aud.eligible.length).toBe(0)
  })

  it('GET /api/crm/campaigns/[id]: whatsapp naslovnik maskiran kot TELEFON (PII)', async () => {
    const r = await campaignDetailGET(req('GET', `/api/crm/campaigns/${campaignIds[0]}`, tokPm), params(campaignIds[0]))
    const b = await body(r)
    expect(r.status).toBe(200)
    const sends = b.sends as Array<{ channel: string; recipientMasked: string }>
    const wSend = sends.find((s) => s.channel === 'whatsapp')
    expect(wSend).toBeDefined()
    // maska = maskPhone (telefon), NE maskEmail — polna številka nikoli v odgovoru
    expect(wSend?.recipientMasked).toBe(maskPhone('386401112222'))
    expect(wSend?.recipientMasked).not.toContain('386401112222')
  })

  it('GET /api/crm/segments: whatsappEligible v odgovoru (števec novega kanala)', async () => {
    const r = await segmentsGET(req('GET', `/api/crm/segments?locationId=${locA}&periodDays=90`, tokPm))
    const b = await body(r)
    expect(r.status).toBe(200)
    const segs = b.segments as Array<{ type: string; whatsappEligible: number }>
    expect(Array.isArray(segs)).toBe(true)
    for (const s of segs) expect(typeof s.whatsappEligible).toBe('number')
  })

  it('tenant guard: waiter TUJE lokacije ne vidi kampanje (fail-closed ostaja)', async () => {
    const r = await campaignsGET(req('GET', '/api/crm/campaigns', tokWaiterB))
    const b = await body(r)
    // waiter nima settings.manage → 403 (pravica, ne lokacija)
    expect(r.status).toBe(403)
    expect(b.campaigns).toBeUndefined()
  })

  it('vbrizgan simulator še vedno deluje za whatsapp (transport zamenljiv, vzorec sendFn)', async () => {
    // nova kampanja + simulator pošiljanja → dokaz, da bo Meta Business API
    // (ko lastnik odobri) tekel po ISTEM sendFn vzorcu brez sprememb dispatch zanke
    const r = await campaignsPOST(req('POST', '/api/crm/campaigns', tokPm, {
      name: `${P}WhatsApp simulator`, channel: 'whatsapp', segmentType: 'all',
      segmentPeriodDays: 90, subject: '', bodySl: `${P}Simulator Slo`,
      bodyHr: `${P}Simulator Hrv`, locationId: locA,
    }))
    const b = await body(r)
    const cmpId = (b.campaign as { id: string }).id
    campaignIds.push(cmpId)
    await campaignActionsPOST(req('POST', `/api/crm/campaigns/${cmpId}/actions`, tokPm, { action: 'approve' }), params(cmpId))
    // gW je odjavljen → publika 0; za simulator dokaz rabimo granted gosta:
    await consentPOST(req('POST', '/api/crm/consent', tokPm, {
      guestId: guestIds[1], channel: 'whatsapp', action: 'grant',
      proof: `${P}gE whatsapp grant za simulator.`,
    }))
    const sent: { to: string; channel: string }[] = []
    const sim: CampaignSendFn = async (args) => {
      sent.push({ to: args.to, channel: args.channel })
      return { ok: true, detail: 'OK', messageId: 'sim-1' }
    }
    const res = await dispatchCampaign(cmpId, { sendFn: sim })
    expect(res.sent).toBe(1)
    expect(sent[0].channel).toBe('whatsapp')
    expect(sent[0].to).toBe('386403334444')
    const row = await db.campaignSend.findFirst({ where: { campaignId: cmpId, status: 'sent_to_provider' } })
    expect(row?.channel).toBe('whatsapp')
    expect(row?.providerMessageId).toBe('sim-1')
  })
})

/* ═══════════════════ Č3. REGISTRI (GAP, i18n, UI, verzija, 0 DDL) ═══════════════════ */

describe('Č3 registri v1.205.0', () => {
  const gap = (): string => readFileSync('docs/GAP-ANALIZA-odprtokodna-konkurenca.md', 'utf8')
  const crmSrc = (): string => readFileSync('src/lib/crm.ts', 'utf8')
  const uiSrc = (): string => readFileSync('src/components/tabs/crm-tab.tsx', 'utf8')
  const schemaSrc = (): string => readFileSync('prisma/schema.prisma', 'utf8')

  it('GAP dokument: OSS-7 popravljen (lažna vrzel 2) + WhatsApp kanal izveden', () => {
    const d = gap()
    // popravek napačne trditve analize v1.199.0 (2. lažna vrzel, vzorec OSS-3)
    expect(d).toContain('lažna vrzel 2')
    expect(d).toContain('SKORAJ POLNO')
    // kandidatska vrstica + sklep
    expect(d).toContain('kanal WhatsApp @ v1.205.0')
    expect(d).toContain('A-del vključno z WhatsApp kanalom (v1.205.0')
    // transport ostaja lastnikov (B/C)
    expect(d).toContain('transport Meta Business API = B/C')
  })

  it('crm.ts: CRM_CHANNELS + campaignChannel + whatsappSendFn fail-soft statika', () => {
    const s = crmSrc()
    expect(s).toContain("CRM_CHANNELS = ['email', 'sms', 'whatsapp']")
    expect(s).toContain('export function campaignChannel')
    expect(s).toContain('export function isPhoneChannel')
    expect(s).toContain('whatsappSendFn')
    expect(s).toContain('transport čaka lastnikovo odobritev — B/C')
    // ConsentState ima whatsapp ključ (ločeno soglasje)
    expect(s).toContain('whatsapp')
  })

  it('0 DDL: shema ostaja String kanal — brez whatsapp v prisma shemi (vrednost, ne model)', () => {
    const s = schemaSrc()
    // Campaign.channel je String s privzetkom email — NOVA VREDNOST, ne DDL
    expect(s).toMatch(/model Campaign \{[\s\S]*?channel\s+String\s+@default\("email"\)/)
    expect(s).not.toContain('whatsapp')
  })

  it('UI: WhatsApp v obeh selectih + consentWhatsapp oznaka + channelLabel', () => {
    const u = uiSrc()
    // consent dialog + nova kampanja dialog
    expect(u.match(/value="whatsapp"/g)?.length).toBe(2)
    expect(u).toContain('consentWhatsapp')
    expect(u).toContain('function channelLabel')
    expect(u).toContain("return 'WhatsApp'")
    // testni prejemnik kanalsko vezan placeholder
    expect(u).toContain('testPlaceholderPhone')
  })

  it('i18n pariteta: +2 ključa v obeh jezikih (3691 → 3693)', () => {
    const sk = Object.keys(sl)
    const hk = Object.keys(hr)
    expect(sk.length).toBe(hk.length)
    expect(sk.length).toBe(3693)
    for (const k of ['crm.guests.whatsapp', 'crm.new.testPlaceholderPhone']) {
      expect(sk).toContain(k)
      expect(hk).toContain(k)
    }
    // znamka se ne prevaja
    expect(sl['crm.guests.whatsapp']).toBe('WhatsApp')
    expect(hr['crm.guests.whatsapp']).toBe('WhatsApp')
    // GDPR opomba omenja vse tri kanale
    expect(sl['crm.consent.gdprNote']).toContain('WhatsApp')
    expect(hr['crm.consent.gdprNote']).toContain('WhatsApp')
  })

  it('verzija 1.208.0', () => {
    expect(APP_VERSION).toBe('1.208.0')
  })
})
