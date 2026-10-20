/**
 * v1.156.0 — CFD polling brez ponovnega prenosa nespremenjenega stanja.
 *
 * PROBLEM (Neon kvota): zaslon gostov je vsaki 2 s prebral CELO vrstico
 * DeviceRegistry (vključno z displayPayload) in CELO vrstico Integration
 * (vključno s config promocij) — tudi ko se stanje ni spremenilo. To je
 * pomenilo ~43.000 polnih branj na dan na zaslon in je (ob 24/7 zidnem
 * zaslonu) glavni porabnik mesečnega prenosa baze.
 *
 * REŠITEV: odgovor nosi `version`; odjemalec pošlje `?v=<version>`, strežnik
 * ob nespremenjenem stanju vrne samo majhen `{ unchanged: true, posOnline }`
 * brez `payload` in `promos`. Ob spremembi payloada ALI promocij se različica
 * spremeni in sledi poln odgovor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { __resetRateLimitForTests } from '../src/lib/rate-limit'
import { DISPLAY_PROMOS_MARKER } from '../src/lib/display-promos'
import { GET } from '../src/app/api/devices/display/state/route'

const P = 'v156-'
const RUN = Date.now().toString(36)
const DISPLAY_TOKEN = `rodev_v156_${RUN}`
let posId = ''
let displayId = ''
let promosId = ''
let ipSeq = 0

type Body = Record<string, unknown>

function makeReq(v?: string, token = DISPLAY_TOKEN): NextRequest {
  const url = new URL('http://localhost:3000/api/devices/display/state')
  if (v !== undefined) url.searchParams.set('v', v)
  ipSeq += 1
  return new NextRequest(url, {
    headers: { 'x-device-token': token, 'x-forwarded-for': `10.156.0.${ipSeq}` },
  })
}

async function getState(v?: string, token?: string): Promise<{ status: number; body: Body }> {
  const res = await GET(makeReq(v, token))
  return { status: res.status, body: (await res.json()) as Body }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  posId = `${P}pos-${RUN}`
  displayId = `${P}display-${RUN}`
  promosId = `${P}promos-${RUN}`
  const base = new Date('2026-10-20T10:00:00.000Z')
  await db.deviceRegistry.create({
    data: {
      id: posId,
      deviceId: `${P}pos-token-${RUN}`,
      name: `${P}POS`,
      type: 'pos',
      status: 'online',
      lastSeenAt: new Date(),
      displayPayload: JSON.stringify({
        state: 'ordering',
        tableName: 'Miza 1',
        lines: [{ name: 'Kava', qty: 1, price: 1.8 }],
        total: 1.8,
      }),
      displayUpdatedAt: base,
    },
  })
  await db.deviceRegistry.create({
    data: {
      id: displayId,
      deviceId: DISPLAY_TOKEN,
      name: `${P}Display`,
      type: 'customer_display',
      status: 'online',
      pairedToDeviceId: posId,
    },
  })
  await db.integration.create({
    data: {
      id: promosId,
      name: DISPLAY_PROMOS_MARKER,
      type: 'other',
      provider: 'display',
      config: JSON.stringify({
        ads: [{ id: `${P}promo-1`, imageUrl: 'https://cdn.example.com/a.jpg', durationSec: 10, active: true }],
      }),
    },
  })
})

afterAll(async () => {
  await db.integration.deleteMany({ where: { id: { startsWith: P } } })
  await db.deviceRegistry.deleteMany({ where: { id: { startsWith: P } } })
  await sweepTestFixtures(db, [P])
})

beforeEach(() => {
  __resetRateLimitForTests()
})

describe('v1.156.0 — različica stanja zaslona', () => {
  it('prvi klic vrne payload, promocije IN različico', async () => {
    const { status, body } = await getState()
    expect(status).toBe(200)
    expect(body.paired).toBe(true)
    expect(typeof body.version).toBe('string')
    expect((body.version as string).length).toBeGreaterThan(0)
    expect(body.unchanged).toBeUndefined()
    const payload = body.payload as Record<string, unknown>
    expect(payload.state).toBe('ordering')
    expect(payload.total).toBe(1.8)
    const promos = body.promos as Array<Record<string, unknown>>
    expect(promos).toHaveLength(1)
    expect(promos[0].id).toBe(`${P}promo-1`)
  })

  it('isti ?v → majhen odgovor brez payloada in promocij', async () => {
    const first = await getState()
    const version = first.body.version as string
    const second = await getState(version)
    expect(second.status).toBe(200)
    expect(second.body.paired).toBe(true)
    expect(second.body.unchanged).toBe(true)
    expect(second.body.version).toBe(version)
    expect('payload' in second.body).toBe(false)
    expect('promos' in second.body).toBe(false)
  })

  it('sprememba payloada → nova različica in poln odgovor', async () => {
    const first = await getState()
    const oldVersion = first.body.version as string
    await db.deviceRegistry.update({
      where: { id: posId },
      data: {
        displayPayload: JSON.stringify({ state: 'paid', total: 0, message: 'Hvala' }),
        displayUpdatedAt: new Date(Date.now() + 5000),
      },
    })
    const changed = await getState(oldVersion)
    expect(changed.body.unchanged).toBeUndefined()
    expect(changed.body.version).not.toBe(oldVersion)
    expect((changed.body.payload as Record<string, unknown>).state).toBe('paid')
  })

  it('sprememba promocij → nova različica in sveže promocije', async () => {
    const first = await getState()
    const oldVersion = first.body.version as string
    await db.integration.update({
      where: { id: promosId },
      data: {
        config: JSON.stringify({
          ads: [{ id: `${P}promo-2`, imageUrl: 'https://cdn.example.com/b.jpg', durationSec: 8, active: true }],
        }),
        updatedAt: new Date(Date.now() + 5000),
      },
    })
    const changed = await getState(oldVersion)
    expect(changed.body.unchanged).toBeUndefined()
    expect(changed.body.version).not.toBe(oldVersion)
    const promos = changed.body.promos as Array<Record<string, unknown>>
    expect(promos[0].id).toBe(`${P}promo-2`)
  })

  it('neznana različica → poln odgovor', async () => {
    const { body } = await getState('ne-obstaja')
    expect(body.unchanged).toBeUndefined()
    expect(body.payload).toBeDefined()
  })

  it('posOnline se osveži tudi ob nespremenjenem stanju', async () => {
    const first = await getState()
    expect(first.body.posOnline).toBe(true)
    await db.deviceRegistry.update({ where: { id: posId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } })
    const second = await getState(first.body.version as string)
    expect(second.body.unchanged).toBe(true)
    expect(second.body.posOnline).toBe(false)
  })
})

describe('v1.156.0 — obstoječe meje', () => {
  it('neznan token → 401', async () => {
    const { status } = await getState(undefined, `rodev_v156_neznan_${RUN}`)
    expect(status).toBe(401)
  })

  it('neparjena naprava → paired:false brez različice', async () => {
    await db.deviceRegistry.update({ where: { id: displayId }, data: { pairedToDeviceId: null } })
    try {
      const { status, body } = await getState()
      expect(status).toBe(200)
      expect(body.paired).toBe(false)
      expect(body.version).toBeUndefined()
    } finally {
      await db.deviceRegistry.update({ where: { id: displayId }, data: { pairedToDeviceId: posId } })
    }
  })

  it('polni odgovor ne razkrije skrivnosti naprave (deviceId/parjenje)', async () => {
    const { body } = await getState()
    expect(body.deviceId).toBeUndefined()
    expect(body.pairedToDeviceId).toBeUndefined()
    expect(body.displayPayload).toBeUndefined()
  })
})

describe('v1.156.0 — čista logika odjemalca', () => {
  it('displayStateVersion: stabilna ob enakih vhodih, spremenljiva ob vsaki spremembi', async () => {
    const { displayStateVersion } = await import('../src/lib/display-poll')
    const t0 = new Date('2026-10-20T10:00:00.000Z')
    const t1 = new Date('2026-10-20T10:00:01.000Z')
    const a = displayStateVersion(t0, 'p1', t0)
    expect(a).toBe(displayStateVersion(new Date(t0), 'p1', new Date(t0)))
    expect(displayStateVersion(t1, 'p1', t0)).not.toBe(a)
    expect(displayStateVersion(t0, 'p1', t1)).not.toBe(a)
    expect(displayStateVersion(t0, 'p2', t0)).not.toBe(a)
    expect(displayStateVersion(null, null, null)).toBe(displayStateVersion(null, null, null))
  })

  it('displayStateUrl: brez različice osnovna pot, z njo kodiran ?v=', async () => {
    const { displayStateUrl } = await import('../src/lib/display-poll')
    expect(displayStateUrl(null)).toBe('/api/devices/display/state')
    expect(displayStateUrl('d1.p2.x y')).toBe('/api/devices/display/state?v=d1.p2.x%20y')
  })

  it('mergeDisplayPoll: unchanged ohrani payload in promocije, osveži posOnline', async () => {
    const { mergeDisplayPoll } = await import('../src/lib/display-poll')
    const prev = {
      payload: { state: 'ordering' as const, total: 3 },
      posOnline: true,
      updatedAt: '2026-10-20T10:00:00.000Z',
      promos: [{ id: 'a', imageUrl: 'https://cdn.example.com/a.jpg', durationSec: 10, active: true }],
    }
    const merged = mergeDisplayPoll(prev, { unchanged: true, posOnline: false })
    expect(merged?.payload).toEqual(prev.payload)
    expect(merged?.promos).toEqual(prev.promos)
    expect(merged?.posOnline).toBe(false)
    expect(merged?.updatedAt).toBe(prev.updatedAt)
    // brez prejšnjega stanja ni česa ohraniti
    expect(mergeDisplayPoll(null, { unchanged: true, posOnline: true })).toBeNull()
    // poln odgovor zamenja celotno stanje
    const full = mergeDisplayPoll(prev, { posOnline: true, payload: { state: 'paid', total: 0 } })
    expect(full?.payload).toEqual({ state: 'paid', total: 0 })
    expect(full?.promos).toEqual([])
  })
})

describe('v1.156.0 — statična invarianta porabe', () => {
  it('ruta po lahki poti ne bere polnih vrstic (select namesto cele vrstice)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/app/api/devices/display/state/route.ts'), 'utf8')
    expect(src).toContain('deviceFromTokenLite')
    expect(src).toContain('unchanged: true')
    // lahka pot ne sme SELECTati težkih stolpcev (komentarji niso pomembni)
    const lightPath = src.split('unchanged: true')[0]
    expect(lightPath).not.toMatch(/displayPayload:\s*true/)
    expect(lightPath).not.toMatch(/config:\s*true/)
  })
})
