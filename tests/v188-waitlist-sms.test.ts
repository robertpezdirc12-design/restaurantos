import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import {
  WAITLIST_NOTIFY_STATUSES,
  canSmsWaitlist,
  waitlistSmsText,
} from '../src/lib/waitlist'
import { attemptWaitlistSms } from '../src/lib/waitlist-run'
import { PATCH as waitlistPATCH } from '../src/app/api/waitlist/route'

/**
 * P2-14 (v1.188.0) — WAITLIST SMS OPOmnik »vaša miza je prosta«.
 *
 * Zadnja res odprta točka tržnih vrzeli P2 (docs/TRZNA-VRZELI-2026.md §4,
 * vrstica 14): prehod waiting → notified je prej SAMO nastavil notifiedAt —
 * gost ni dobil nobenega signala. Ta izdaja doda fail-soft SMS:
 *  - brez številke → 'no_phone'; brez SMS integracije → 'sms_unconfigured';
 *  - ponudnik zavrne → 'failed' (prehod VEDNO uspe — usaditev je primarna);
 *  - uspeh → 'sent'; izid v reviziji (samo status, brez PII) in odgovoru.
 *
 * Merila:
 *  Č1 čisti sloj: prag številke (digits ≥ 6, kot sendSms), besedilo sl/hr
 *     (z/št. mize, z/brez imena), zaprt seznam notify statusov.
 *  Č2 pravice: 401 brez žetona, 403 CLEANER (reservations.manage).
 *  Č3 prehod notified (ruta): no_phone, sms_unconfigured, failed (SSRF-zavrnjen
 *     webhook = deterministično brez omrežja), fail-soft (status VEDNO notified),
 *     idempotenca (ponovni prehod 409), resend (samo za notified; WAITLIST_SMS_RESEND).
 *  Č4 strežniški sloj z vbrizganimi odvisnostmi (mock.module je ZAVRAN —
 *     audit2530): sent, ponudnik ok:false → failed, metljiva izjema → failed,
 *     notifyStatus vztrajno zapisan na vnos.
 *  Č5 urejanje ne sproži SMS (notifyStatus se ne spremeni).
 *
 * ID-ji s predpono `v188wl-` (sweep beforeAll, cleanup afterAll). Dve lokaciji:
 * locNoSms (brez SMS integracije) in locSms (z webhook integracijo, zasebni
 * cilj → SSRF varovalo jo deterministično zavrne → 'failed').
 */

const PREFIX = 'v188wl-'
const RUN = Date.now().toString(36)

let locNoSms = ''
let locSms = ''
let adminId = ''
let adminToken = ''
let smsAdminToken = ''
let noPermToken = ''
let integrationId = ''

function req(url: string, token: string | null, method = 'PATCH', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

let eSeq = 0
async function seedEntry(locationId: string, opts?: { phone?: string; status?: string; notifyStatus?: string }): Promise<string> {
  eSeq += 1
  const row = await db.waitlistEntry.create({
    data: {
      id: `${PREFIX}e${eSeq}-${RUN}`, guestName: `${PREFIX}Gost ${eSeq}`, partySize: 2,
      guestPhone: opts?.phone ?? '', status: opts?.status ?? 'waiting',
      ...(opts?.notifyStatus !== undefined ? { notifyStatus: opts.notifyStatus } : {}),
      locationId,
    },
  })
  return row.id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  locNoSms = (await db.location.create({
    data: { id: `${PREFIX}locA-${RUN}`, name: `${PREFIX}Brez SMS`, code: `V188A-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premA-${RUN}`, country: 'SI' },
  })).id
  locSms = (await db.location.create({
    data: { id: `${PREFIX}locB-${RUN}`, name: `${PREFIX}Z SMS`, code: `V188B-${RUN.toUpperCase()}`, premisesId: `${PREFIX}premB-${RUN}`, country: 'SI' },
  })).id
  integrationId = (await db.integration.create({
    data: {
      id: `${PREFIX}integ-${RUN}`, name: `${PREFIX} SMS webhook`, type: 'sms', provider: 'webhook',
      // zasebni cilj (127.0.0.1) — SSRF varovalo (#30) ga deterministično zavrne
      config: JSON.stringify({ provider: 'webhook', url: 'http://127.0.0.1:9/x' }),
      isActive: true, locationId: locSms,
    },
  })).id

  adminId = `${PREFIX}adminA-${RUN}`
  const pinA = employeePinFields(`7${RUN.slice(-5)}`, `${PREFIX}adminA-${RUN}@test.local`)
  await db.employee.create({
    data: { id: adminId, name: `${PREFIX}AdminA`, email: `${PREFIX}adminA-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locNoSms, ...pinA },
  })
  const pinB = employeePinFields(`6${RUN.slice(-5)}`, `${PREFIX}adminB-${RUN}@test.local`)
  await db.employee.create({
    data: { id: `${PREFIX}adminB-${RUN}`, name: `${PREFIX}AdminB`, email: `${PREFIX}adminB-${RUN}@test.local`, role: 'ADMIN', status: 'active', sessionVersion: 0, locationId: locSms, ...pinB },
  })
  const pinC = employeePinFields(`5${RUN.slice(-5)}`, `${PREFIX}clean-${RUN}@test.local`)
  const cleaner = await db.employee.create({
    data: { id: `${PREFIX}clean-${RUN}`, name: `${PREFIX}Cistilka`, email: `${PREFIX}clean-${RUN}@test.local`, role: 'CLEANER', status: 'active', sessionVersion: 0, locationId: locNoSms, ...pinC },
  })
  adminToken = createToken({ sub: adminId, name: `${PREFIX}AdminA`, role: 'ADMIN', loc: locNoSms, sv: 0 })
  smsAdminToken = createToken({ sub: `${PREFIX}adminB-${RUN}`, name: `${PREFIX}AdminB`, role: 'ADMIN', loc: locSms, sv: 0 })
  noPermToken = createToken({ sub: cleaner.id, name: `${PREFIX}Cistilka`, role: 'CLEANER', loc: locNoSms, sv: 0 })
})

afterAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
})

/* ────────────────────────── Č1 — čisti sloj ────────────────────────── */

describe('v1.188.0 P2-14 — čisti sloj', () => {
  test('canSmsWaitlist: digits ≥ 6 (isti prag kot sendSms); presledki/ločila dovoljeni', () => {
    expect(canSmsWaitlist('041 234 567')).toBe(true)
    expect(canSmsWaitlist('+386 40 123 456')).toBe(true)
    expect(canSmsWaitlist('12345')).toBe(false)
    expect(canSmsWaitlist('')).toBe(false)
    expect(canSmsWaitlist('abcd')).toBe(false)
    expect(canSmsWaitlist('klic: 041/234-567')).toBe(true)
  })

  test('waitlistSmsText: sl vsebuje ime in mizo; brez mize brez oklepajev', () => {
    const withTable = waitlistSmsText({ guestName: 'Ana', tableNumber: 12 }, 'sl')
    expect(withTable).toContain('Ana')
    expect(withTable).toContain('(miza 12)')
    expect(withTable).toContain('prosta')
    const noTable = waitlistSmsText({ guestName: 'Ana' }, 'sl')
    expect(noTable).toContain('Vaša miza je prosta')
    expect(noTable).not.toContain('(')
  })

  test('waitlistSmsText: hr varianta (stol, slobodan); brez imena vljuden fallback', () => {
    const hr = waitlistSmsText({ guestName: 'Ivan', tableNumber: 3 }, 'hr')
    expect(hr).toContain('Ivan')
    expect(hr).toContain('(stol 3)')
    expect(hr).toContain('slobodan')
    const fallbackSl = waitlistSmsText({}, 'sl')
    expect(fallbackSl).toContain('Pozdravljeni')
    const fallbackHr = waitlistSmsText({}, 'hr')
    expect(fallbackHr).toContain('Poštovani')
  })

  test('zaprt seznam notify statusov', () => {
    expect(WAITLIST_NOTIFY_STATUSES).toEqual(['', 'sent', 'no_phone', 'sms_unconfigured', 'failed'])
  })
})

/* ────────────────────────── Č2 — pravice ────────────────────────── */

describe('v1.188.0 P2-14 — pravice', () => {
  test('401 brez žetona; 403 CLEANER (reservations.manage)', async () => {
    const noTok = await waitlistPATCH(req('/api/waitlist', null, 'PATCH', { id: 'x', status: 'notified' }))
    expect(noTok.status, 'brez žetona').toBe(401)
    const clean = await waitlistPATCH(req('/api/waitlist', noPermToken, 'PATCH', { id: 'x', status: 'notified' }))
    expect(clean.status, 'CLEANER').toBe(403)
  })
})

/* ────────────────────────── Č3 — prehod notified (ruta) ────────────────────────── */

describe('v1.188.0 P2-14 — prehod notified z SMS (fail-soft)', () => {
  test('brez številke → no_phone; prehod uspe; audit ima notifyStatus (brez številke)', async () => {
    const id = await seedEntry(locNoSms, { phone: '' })
    const res = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id, status: 'notified' }))
    expect(res.status, 'prehod').toBe(200)
    const body = await res.json()
    expect(body.notifyStatus).toBe('no_phone')
    expect(body.entry.status).toBe('notified')
    const row = await db.waitlistEntry.findUnique({ where: { id } })
    expect(row?.notifyStatus).toBe('no_phone')
    expect(row?.notifiedAt).not.toBeNull()
    const audit = await db.auditLog.findFirst({ where: { action: 'WAITLIST_NOTIFY', entityId: id }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit?.details ?? '{}') as Record<string, unknown>
    expect(details.notifyStatus).toBe('no_phone')
    expect(JSON.stringify(details)).not.toContain('041') // brez PII v reviziji
  })

  test('številka brez SMS integracije → sms_unconfigured; prehod VEDNO uspe', async () => {
    const id = await seedEntry(locNoSms, { phone: '041 111 222' })
    const res = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id, status: 'notified' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.notifyStatus).toBe('sms_unconfigured')
    expect(body.entry.status).toBe('notified')
  })

  test('ponudnik zavrne (SSRF-zavrnjen webhook) → failed, prehod OSTANE notified (fail-soft)', async () => {
    const id = await seedEntry(locSms, { phone: '+386 40 555 666' })
    const res = await waitlistPATCH(req('/api/waitlist', smsAdminToken, 'PATCH', { id, status: 'notified' }))
    expect(res.status, 'SMS napaka NE sme blokirati prehoda').toBe(200)
    const body = await res.json()
    expect(body.notifyStatus).toBe('failed')
    expect(body.entry.status).toBe('notified')
    const row = await db.waitlistEntry.findUnique({ where: { id } })
    expect(row?.status).toBe('notified')
    expect(row?.notifiedAt).not.toBeNull()
    expect(row?.notifyStatus).toBe('failed')
  })

  test('idempotenca: ponovni prehod notified → notified je 409; notifyStatus se ne prepiše', async () => {
    const id = await seedEntry(locNoSms, { phone: '041 222 333' })
    const first = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id, status: 'notified' }))
    expect(first.status).toBe(200)
    const second = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id, status: 'notified' }))
    expect(second.status, 'isti prehod').toBe(409)
    const row = await db.waitlistEntry.findUnique({ where: { id } })
    expect(row?.notifyStatus).toBe('sms_unconfigured')
  })

  test('resend: waiting → 409; notified → nov poskus z auditom WAITLIST_SMS_RESEND', async () => {
    const waitingId = await seedEntry(locNoSms, { phone: '041 333 444' })
    const tooEarly = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id: waitingId, resend: true }))
    expect(tooEarly.status, 'resend še pred obveščenostjo').toBe(409)

    const id = await seedEntry(locSms, { phone: '+386 41 777 888', status: 'notified', notifyStatus: 'failed' })
    const res = await waitlistPATCH(req('/api/waitlist', smsAdminToken, 'PATCH', { id, resend: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.notifyStatus).toBe('failed') // webhook spet zavrnjen — deterministično
    const audit = await db.auditLog.findFirst({ where: { action: 'WAITLIST_SMS_RESEND', entityId: id }, orderBy: { timestamp: 'desc' } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit?.details ?? '{}') as Record<string, unknown>
    expect(details.notifyStatus).toBe('failed')
  })
})

/* ────────────────── Č4 — strežniški sloj (vbrizgane odvisnosti) ────────────────── */

describe('v1.188.0 P2-14 — attemptWaitlistSms (injekcija, brez omrežja)', () => {
  test('uspešen ponudnik → sent; notifyStatus vztrajno na vnosu', async () => {
    const id = await seedEntry(locNoSms, { phone: '041 444 555' })
    const status = await attemptWaitlistSms(
      { entryId: id, locationId: locNoSms, phone: '041 444 555', guestName: 'Ana' },
      { sendFn: async () => ({ ok: true, detail: 'TEST OK' }), smsConfigFn: async () => ({ provider: 'webhook', url: 'https://sms.example/hook' }) },
    )
    expect(status).toBe('sent')
    const row = await db.waitlistEntry.findUnique({ where: { id } })
    expect(row?.notifyStatus).toBe('sent')
  })

  test('ponudnik ok:false → failed; metljiva izjema → failed (nikoli ne meče)', async () => {
    const id1 = await seedEntry(locNoSms, { phone: '041 555 666' })
    const s1 = await attemptWaitlistSms(
      { entryId: id1, locationId: null, phone: '041 555 666', guestName: 'Bor' },
      { sendFn: async () => ({ ok: false, detail: 'Twilio 500' }), smsConfigFn: async () => ({ provider: 'twilio' }) },
    )
    expect(s1).toBe('failed')
    const id2 = await seedEntry(locNoSms, { phone: '041 666 777' })
    const s2 = await attemptWaitlistSms(
      { entryId: id2, locationId: null, phone: '041 666 777', guestName: 'Cene' },
      { sendFn: async () => { throw new Error('network down') }, smsConfigFn: async () => ({ provider: 'webhook', url: 'https://x.example' }) },
    )
    expect(s2).toBe('failed')
    const rows = await db.waitlistEntry.findMany({ where: { id: { in: [id1, id2] } } })
    expect(rows.every((r) => r.notifyStatus === 'failed')).toBe(true)
  })

  test('config funkcija vrne null → sms_unconfigured; kratka številka → no_phone (brez klica)', async () => {
    let called = 0
    const id1 = await seedEntry(locNoSms, { phone: '' })
    const s1 = await attemptWaitlistSms(
      { entryId: id1, locationId: null, phone: '', guestName: 'Dora' },
      { sendFn: async () => { called += 1; return { ok: true, detail: '' } }, smsConfigFn: async () => ({ provider: 'webhook', url: 'https://x.example' }) },
    )
    expect(s1).toBe('no_phone')
    const id2 = await seedEntry(locNoSms, { phone: '041 777 888' })
    const s2 = await attemptWaitlistSms(
      { entryId: id2, locationId: null, phone: '041 777 888', guestName: 'Eva' },
      { sendFn: async () => { called += 1; return { ok: true, detail: '' } }, smsConfigFn: async () => null },
    )
    expect(s2).toBe('sms_unconfigured')
    expect(called, 'send se ni klical v nobenem od obeh primerov').toBe(0)
  })
})

/* ────────────────── Č5 — urejanje ne sproži SMS ────────────────── */

describe('v1.188.0 P2-14 — urejanje brez prehoda', () => {
  test('sprememba guestPhone NE spremeni notifyStatus', async () => {
    const id = await seedEntry(locNoSms, { phone: '', status: 'notified', notifyStatus: 'no_phone' })
    const res = await waitlistPATCH(req('/api/waitlist', adminToken, 'PATCH', { id, guestPhone: '041 999 000' }))
    expect(res.status).toBe(200)
    const row = await db.waitlistEntry.findUnique({ where: { id } })
    expect(row?.guestPhone).toBe('041 999 000')
    expect(row?.notifyStatus).toBe('no_phone')
  })
})
