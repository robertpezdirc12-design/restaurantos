/**
 * Issue #29 (P1) — ATOMAREN claim vpisne kode naprave (PUT /api/devices/enroll):
 *  - dve sočasni zahtevi z isto veljavno kodo: NATANKO ena uspe (200 + token),
 *    druga dobi dosledno zavrnitev BREZ tokena;
 *  - tri sočasne: še vedno natanko ena;
 *  - zmagovalni token je (edini) zapisan v DeviceRegistry.deviceId; odgovor
 *    poražene zahteve NE vsebuje tokena;
 *  - že unovčena koda / potekla koda / preklicana naprava / neznana koda →
 *    410/403/404 brez tokena;
 *  - revoke PREJ commitan → claim 403, naprava NE dobi tokena (CAS
 *    revokedAt: null);
 *  - audit DEVICE_CLAIMED obstaja in NE vsebuje niti tokena niti kode;
 *  - rate limit 10/5min na IP ostane (11. poskus → 429).
 *
 * ID-ji s predpono `i29-` (sweep + eksplicitni cleanup auditov).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { employeePinFields } from '../src/lib/auth'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { PUT as enrollPUT } from '../src/app/api/devices/enroll/route'

const PREFIX = 'i29-'
const RUN = Date.now().toString(36)
let ipSeq = 0

function req(code: string | undefined, ip: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/devices/enroll', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(code === undefined ? {} : { code }),
  })
}

const isResp = (r: unknown): r is Response => r instanceof Response

async function claim(code: string, ip: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const v = await enrollPUT(req(code, ip))
  expect(isResp(v)).toBe(true)
  return { code: v.status, body: (await v.json()) as Record<string, unknown> }
}

let locA = ''
let staffId = ''

async function seedDevice(name: string, code: string, opts: { expiresAt?: Date; revokedAt?: Date; claimedAt?: Date } = {}): Promise<string> {
  const id = `${PREFIX}${name}-${RUN}`
  await db.deviceRegistry.create({
    data: {
      id,
      deviceId: `pending_${crypto.randomBytes(8).toString('hex')}`,
      name: `${PREFIX}${name}`,
      type: 'pos',
      locationId: locA,
      status: 'enrollment_pending',
      enrollmentCode: code,
      enrollmentExpiresAt: opts.expiresAt ?? new Date(Date.now() + 10 * 60_000),
      enrollmentClaimedAt: opts.claimedAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  })
  return id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  locA = `${PREFIX}locA-${RUN}`
  await db.location.create({ data: { id: locA, name: 'I29 Lokacija', code: `${PREFIX}L-${RUN}` } })
  const pin = String(10000000 + ([...`${PREFIX}staff`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 89999999, 7)))
  const fields = employeePinFields(pin, `${PREFIX}staff-${RUN}@test.local`)
  staffId = `${PREFIX}staff-${RUN}`
  await db.employee.create({
    data: {
      id: staffId, name: `${PREFIX}staff`, email: `${PREFIX}staff-${RUN}@test.local`,
      role: 'MANAGER', status: 'active', sessionVersion: 0, locationId: locA,
      pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
})

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } })
  await sweepTestFixtures(db, [PREFIX])
})

beforeEach(() => {
  __resetRateLimitForTests()
  ipSeq += 1
})

/* ═══════════════════ srečna pot + zavrnitve ═══════════════════ */

describe('issue #29 — enrollment claim: osnovne poti', () => {
  it('veljavna koda → 200 + token; DB deviceId = token; koda izbrisana; claimedAt postavljen', async () => {
    const devId = await seedDevice('happy', '11110001')
    const r = await claim('11110001', `10.0.0.${ipSeq}`)
    expect(r.code).toBe(200)
    const dev = r.body.device as { id: string; token: string; locationId: string | null }
    expect(dev.id).toBe(devId)
    expect(dev.token).toMatch(/^rodev_[0-9a-f]{48}$/)
    expect(dev.locationId).toBe(locA)
    const row = await db.deviceRegistry.findUnique({ where: { id: devId }, select: { deviceId: true, enrollmentCode: true, enrollmentClaimedAt: true, status: true } })
    expect(row?.deviceId).toBe(dev.token)
    expect(row?.enrollmentCode).toBeNull()
    expect(row?.enrollmentClaimedAt).not.toBeNull()
    expect(row?.status).toBe('online')
    // audit brez skrivnosti
    const audit = await db.auditLog.findFirst({ where: { action: 'DEVICE_CLAIMED', entityId: devId } })
    expect(audit).not.toBeNull()
    expect(audit?.details).not.toContain(dev.token)
    expect(audit?.details).not.toContain('11110001')
  })

  it('replay že unovčene kode → 410 brez tokena', async () => {
    await seedDevice('replay', '11110002', { claimedAt: new Date() })
    const r = await claim('11110002', `10.0.0.${ipSeq}`)
    expect(r.code).toBe(410)
    expect(r.body.device).toBeUndefined()
  })

  it('potekla koda → 410 brez tokena', async () => {
    await seedDevice('expired', '11110003', { expiresAt: new Date(Date.now() - 60_000) })
    const r = await claim('11110003', `10.0.0.${ipSeq}`)
    expect(r.code).toBe(410)
    expect(r.body.device).toBeUndefined()
  })

  it('preklicana naprava → 403 brez tokena', async () => {
    await seedDevice('revoked', '11110004', { revokedAt: new Date() })
    const r = await claim('11110004', `10.0.0.${ipSeq}`)
    expect(r.code).toBe(403)
    expect(r.body.device).toBeUndefined()
  })

  it('neznana koda → 404 brez tokena', async () => {
    const r = await claim('99999999', `10.0.0.${ipSeq}`)
    expect(r.code).toBe(404)
    expect(r.body.device).toBeUndefined()
  })
})

/* ═══════════════════ SOČASNOST — atomaren claim ═══════════════════ */

describe('issue #29 — sočasni claim (CAS)', () => {
  it('DVE sočasni zahtevi z isto veljavno kodo: NATANKO ena uspe, druga zavrnjena BREZ tokena', async () => {
    const devId = await seedDevice('race2', '11110011')
    const [a, b] = await Promise.all([claim('11110011', '10.1.0.1'), claim('11110011', '10.1.0.1')])
    const codes = [a.code, b.code].sort()
    // poraženka: koda je ob zmagi uničena (enrollmentCode → null) → 404 „neznana ali že unovčena“
    expect(codes).toEqual([200, 404])
    const winner = a.code === 200 ? a : b
    const loser = a.code === 200 ? b : a
    const wdev = winner.body.device as { token: string }
    expect(wdev.token).toMatch(/^rodev_/)
    // poražena: BREZ tokena
    expect(loser.body.device).toBeUndefined()
    expect(JSON.stringify(loser.body)).not.toMatch(/rodev_/)
    // DB: natanko ENA vrednost zmagovalnega tokena
    const row = await db.deviceRegistry.findUnique({ where: { id: devId }, select: { deviceId: true, enrollmentCode: true, enrollmentClaimedAt: true } })
    expect(row?.deviceId).toBe(wdev.token)
    expect(row?.enrollmentCode).toBeNull()
    expect(row?.enrollmentClaimedAt).not.toBeNull()
  })

  it('TRI sočasne zahteve: še vedno natanko ena zmagovalka', async () => {
    const devId = await seedDevice('race3', '11110012')
    const rs = await Promise.all([claim('11110012', '10.1.1.1'), claim('11110012', '10.1.1.1'), claim('11110012', '10.1.1.1')])
    const okCount = rs.filter((r) => r.code === 200).length
    const rejectCount = rs.filter((r) => r.code !== 200).length
    expect(okCount).toBe(1)
    expect(rejectCount).toBe(2)
    for (const r of rs.filter((x) => x.code !== 200)) {
      expect(JSON.stringify(r.body)).not.toMatch(/rodev_/)
    }
    const winner = rs.find((r) => r.code === 200)!
    const wdev = winner.body.device as { token: string }
    const row = await db.deviceRegistry.findUnique({ where: { id: devId }, select: { deviceId: true } })
    expect(row?.deviceId).toBe(wdev.token)
  })

  it('revoke COMMITAN pred claimom → koda uničena → 404, naprava NE dobi tokena', async () => {
    const devId = await seedDevice('revclaim', '11110013')
    // revoke se zgodi (commitan) pred claim poskusom — tudi če je claim prebral
    // STARI zapis, CAS (revokedAt: null + enrollmentCode) zavrne brez tokena
    await db.deviceRegistry.update({ where: { id: devId }, data: { revokedAt: new Date(), status: 'revoked', enrollmentCode: null } })
    const r = await claim('11110013', '10.1.2.1')
    expect(r.code).toBe(404) // koda je bila ob revoke uničena → neznana
    expect(r.body.device).toBeUndefined()
    const row = await db.deviceRegistry.findUnique({ where: { id: devId }, select: { deviceId: true } })
    expect(row?.deviceId).toMatch(/^pending_/) // NOBEN token ni bil izdan
  })

  it('claim zmagá, NATO revoke → token velja le do revoke (zaporedje je legitimno)', async () => {
    const devId = await seedDevice('claimrev', '11110014')
    const r = await claim('11110014', '10.1.3.1')
    expect(r.code).toBe(200)
    const wdev = r.body.device as { token: string }
    // revoke po uspešnem claimu (fizično zaporedje) — token v DB je zamenjan z revokacijo
    await db.deviceRegistry.update({ where: { id: devId }, data: { revokedAt: new Date(), status: 'revoked' } })
    const row = await db.deviceRegistry.findUnique({ where: { id: devId }, select: { deviceId: true, revokedAt: true } })
    expect(row?.deviceId).toBe(wdev.token)
    expect(row?.revokedAt).not.toBeNull()
  })
})

/* ═══════════════════ rate limit ═══════════════════ */

describe('issue #29 — rate limit ohranjen', () => {
  it('11. poskus z istega IP v 5 min → 429', async () => {
    const ip = '10.2.0.1'
    const devId = await seedDevice('rl', '11110021', { claimedAt: new Date() }) // že unovčena → vsi poskusi 410 (a štejejo)
    for (let i = 0; i < 10; i++) {
      const r = await claim('11110021', ip)
      expect([404, 410]).toContain(r.code)
    }
    const r11 = await claim('11110021', ip)
    expect(r11.code).toBe(429)
    // koda iz DRUGAČNEGA IP še vedno gre skozi (limit je per-IP)
    const other = await claim('11110021', '10.2.0.2')
    expect([404, 410]).toContain(other.code)
  })
})
