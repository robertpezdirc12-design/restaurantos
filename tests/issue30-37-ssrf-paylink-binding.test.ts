/**
 * Issue #30 (P0) — SSRF: popolna zaščita strežniških testov integracij (DNS/
 * IPv6/preusmeritve/credential glave) + Issue #37 (P0) — Stripe plačilna seja
 * VEZANA na konkreten PayLink (kanonični sessionId + metadata + CAS).
 *
 * #30 pokritje (OWASP SSRF Prevention Cheat Sheet):
 *  1. URL parser: WHATWG normalizacija (2130706433/0x7f… → 127.0.0.1) + IPv6
 *     oklepaji/stisnjen hex vgrajeni IPv4 (::ffff:a00:1) → expandIpv6 nazaj;
 *  2. IPv4/IPv6 tabela: vsa special-purpose območja (loopback/RFC1918/CGNAT/
 *     link-local+metadata/multicast/reserved/TEST-NET/ULA/NAT64/IPv4-mapped);
 *  3. DNS: mešani zapisi (javni+zasebni A/AAAA) → zavrnitev (fail-closed);
 *     povezava na preverjeni IP (Host/SNI ohranita ime — dokazano prek lokalnega
 *     strežnika) → rebinding med preverbo in povezavo ni mogoč;
 *  4. preusmeritve: NE sledijo (3xx = rezultat; drugi strežnik NI dosežen);
 *  5. credential politika: privzeto BREZ apiKey/apiSecret (opt-in + samo https);
 *  6. higiiena logov: IntegrationLog/audit/odgovor BREZ skrivnosti in BREZ
 *     query stringa (samo varni host);
 *  7. produkcijska shemska politika: http zavrnjen v NODE_ENV=production.
 *
 * #37 pokritje:
 *  1. TUJA plačana seja (isti znesek!) → 409 PRED klicem na Stripe;
 *  2. napačni metadata/order/paylink/id-echo/valuta/mode → 409;
 *  3. povezava brez kanonične seje (legacy) → 409;
 *  4. ponovljen POST: ISTA odprta seja (idempotenca — en create klic);
 *  5. spremenjena napitnina: VARNA zamenjava (stara seja zaprta, nova kanonična);
 *  6. SOČASNA ustvarjanja: ena kanonična plačljiva seja (izgubljenikova zaprta);
 *  7. dvojna potrditev/dvojni simulator: EN finančni učinek (CAS + plkset);
 *  8. DDL: migrate-paylink-session (401/403/owner alreadyApplied) + register
 *     + i18n + javna napaka ima gostovski prevod.
 *
 * Fiksature: i30- (integracije), p37- (paylink). FURS simulacija.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { createToken, employeePinFields } from '../src/lib/auth'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import {
  validateTargetUrl,
  isBlockedHostname,
  expandIpv6,
  resolveValidatedAddresses,
  ssrfSafeRequest,
  ALLOWED_PORTS,
} from '../src/lib/ssrf-guard'
import { credentialHeadersFor, POST as testConnectionPOST } from '../src/app/api/integrations/[id]/test/route'
import { POST as integrationsPOST } from '../src/app/api/integrations/route'
import { POST as ordersPOST } from '../src/app/api/orders/route'
import { POST as firePOST } from '../src/app/api/orders/[id]/fire/route'
import { POST as paylinkPOST } from '../src/app/api/orders/[id]/paylink/route'
import { POST as publicPayPOST } from '../src/app/api/public/pay/[token]/route'
import { POST as migratePaylinkSessionPOST } from '../src/app/api/admin/migrate-paylink-session/route'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sendSms } from '../src/lib/reminders'
import { guestApiErrorKey } from '../src/components/guest-i18n'
import { t } from '../src/lib/i18n'

const PREFIX = 'i30-'
const P37 = 'p37-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)
const pinOf = (i: number) => `${PIN_BASE}${i}`

let locA = ''
let waiterToken = ''
let ownerToken = ''
let item5 = ''
let item350 = ''

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function seedEmployee(name: string, role: string, pin: string, locationId: string) {
  const fields = employeePinFields(pin, `${PREFIX}${name}-${RUN}@test.local`)
  return db.employee.create({
    data: {
      id: `${PREFIX}emp-${name}-${RUN}`, name: `${PREFIX}${name}`,
      email: `${PREFIX}${name}-${RUN}@test.local`, role, status: 'active',
      sessionVersion: 0, locationId, pin: fields.pin, pinLookup: fields.pinLookup,
    },
  })
}

let orderSeq = 893001
const TABLE_POOL: string[] = []
let tableCursor = 0

async function mkOrder(): Promise<string> {
  const tbl = TABLE_POOL[tableCursor++ % TABLE_POOL.length]
  const res = await ordersPOST(
    req('/api/orders', waiterToken, 'POST', {
      tableId: tbl, guests: 2,
      items: [{ menuItemId: item5, qty: 3 }, { menuItemId: item350, qty: 1 }],
      clientOperationId: `${P37}-op-${RUN}-${orderSeq++}`,
    }),
  )
  const data = (await res.json()) as { order?: { id: string }; id?: string }
  const id = data.order?.id || data.id || ''
  if (!id) throw new Error(`mkOrder failed: ${res.status}`)
  await firePOST(req(`/api/orders/${id}/fire`, waiterToken, 'POST', {}), { params: Promise.resolve({ id }) })
  return id
}

async function mkLink(orderId: string): Promise<{ token: string; id: string }> {
  const res = await paylinkPOST(req(`/api/orders/${orderId}/paylink`, waiterToken, 'POST', {}), {
    params: Promise.resolve({ id: orderId }),
  })
  const data = (await res.json()) as { link: { token: string; id: string } }
  if (!data.link?.token) throw new Error(`mkLink failed: ${res.status}`)
  return data.link
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX, P37])
  process.env.FURS_ENVIRONMENT = 'simulation'
  delete process.env.STRIPE_SECRET_KEY
  locA = (await db.location.create({
    data: { id: `${PREFIX}loc-a-${RUN}`, name: `${PREFIX}Lokacija A`, code: `I30A-${RUN.toUpperCase()}`,
      premisesId: `BLGI30A${RUN}`, taxId: 'SI12345678', registerNumber: 'BLG-I30-01A', fursEnvironment: 'simulation', country: 'SI' },
  })).id
  const waiter = await seedEmployee('waiter', 'waiter', pinOf(1), locA)
  const owner = await seedEmployee('owner', 'owner', pinOf(2), locA)
  waiterToken = createToken({ sub: waiter.id, name: waiter.name, role: 'WAITER', loc: locA, sv: 0 })
  ownerToken = createToken({ sub: owner.id, name: owner.name, role: 'OWNER', loc: locA, sv: 0 })
  const menu = (await db.menu.create({ data: { id: nid(), name: `${PREFIX} meni`, locationId: locA } })).id
  const cat = (await db.category.create({ data: { id: nid(), name: `${PREFIX} kat`, menuId: menu } })).id
  item5 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Jedi 5`, price: 5, categoryId: cat, vatRate: 22 } })).id
  item350 = (await db.menuItem.create({ data: { id: nid(), name: `${PREFIX} Prigrizek 3.5`, price: 3.5, categoryId: cat, vatRate: 22 } })).id
  for (let n = 931; n <= 948; n++) {
    TABLE_POOL.push((await db.table.create({ data: { id: nid(), number: n, capacity: 4, locationId: locA, status: 'available' } })).id)
  }
})

afterAll(async () => {
  // paylink/order/REVERSE-FK čiščenje (vzorec paylink-flow)
  const locs = await db.location.findMany({ where: { code: { startsWith: `I30A-` } } })
  for (const loc of locs) {
    const links = await db.payLink.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const orders = await db.order.findMany({ where: { locationId: loc.id }, select: { id: true } })
    for (const oid of orders.map((o) => o.id)) {
      const receipts = await db.receipt.findMany({ where: { orderId: oid }, select: { id: true } })
      const checks = await db.check.findMany({ where: { orderId: oid }, select: { id: true } })
      await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { entityId: { in: [...receipts.map((r) => r.id), oid] } } }).catch(() => null)
      await db.auditLog.deleteMany({ where: { entityId: { in: [...receipts.map((r) => r.id), oid, ...links.map((l) => l.id)] } } }).catch(() => null)
      await db.check.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.receipt.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.orderItem.deleteMany({ where: { orderId: oid } }).catch(() => null)
      await db.order.deleteMany({ where: { id: oid } }).catch(() => null)
    }
    await db.payLink.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    await db.eventLog.deleteMany({ where: { entityId: { in: links.map((l) => l.id) } } }).catch(() => null)
    const tables = await db.table.findMany({ where: { locationId: loc.id }, select: { id: true } })
    await db.eventLog.deleteMany({ where: { entityId: { in: tables.map((x) => x.id) } } }).catch(() => null)
    await db.table.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    const menus = await db.menu.findMany({ where: { locationId: loc.id }, select: { id: true } })
    const cats = await db.category.findMany({ where: { menuId: { in: menus.map((m) => m.id) } }, select: { id: true } })
    const mis = await db.menuItem.findMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, select: { id: true } })
    await db.recipeItem.deleteMany({ where: { menuItemId: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.menuItem.deleteMany({ where: { id: { in: mis.map((m) => m.id) } } }).catch(() => null)
    await db.category.deleteMany({ where: { id: { in: cats.map((c) => c.id) } } }).catch(() => null)
    await db.menu.deleteMany({ where: { id: { in: menus.map((m) => m.id) } } }).catch(() => null)
    await db.employee.deleteMany({ where: { locationId: loc.id } }).catch(() => null)
    await db.counter.deleteMany({ where: { name: `receipt:${loc.id}` } }).catch(() => null)
    await db.location.deleteMany({ where: { id: loc.id } }).catch(() => null)
  }
  await db.integrationLog.deleteMany({ where: { integrationId: { startsWith: PREFIX } } }).catch(() => null)
  await db.integration.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.employee.deleteMany({ where: { email: { contains: PREFIX } } }).catch(() => null)
})

/* ════════════════ Issue #30 — SSRF varovalo ════════════════ */

describe('#30 — URL parser + IPv4/IPv6 normalizacija (enotsko)', () => {
  test('expandIpv6: kompresija ::, hex-vgrajeni IPv4, dotted rep, oklepaji', () => {
    expect(expandIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
    expect(expandIpv6('2001:db8::')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0])
    expect(expandIpv6('[::ffff:a00:1]')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1])
    expect(expandIpv6('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1])
    expect(expandIpv6('[64:ff9b::7f00:1]')).toEqual([0x0064, 0xff9b, 0, 0, 0, 0, 0x7f00, 1])
    expect(expandIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(expandIpv6('a:::b')).toBeNull() // dvojna '::'
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull() // preveč skupin
    expect(expandIpv6('napačno')).toBeNull()
  })

  test('isBlockedHostname: VSA special-purpose območja + lokalna imena', () => {
    const blocked = [
      'localhost', 'a.local', 'b.internal', 'c.localhost', 'x.home.arpa', 'y.corp', 'z.lan',
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '240.0.0.1',
      '192.0.2.9', '198.51.100.7', '203.0.113.5', '198.18.0.5', '192.88.99.1', '192.0.0.8',
      '[::]', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '100::',
      '[::ffff:10.0.0.1]', '[::ffff:127.0.0.1]', '[::ffff:169.254.169.254]', '[64:ff9b::7f00:1]',
      'garbage:::x', '',
    ]
    for (const h of blocked) expect(isBlockedHostname(h), `mora blokirati: ${h}`).toBe(true)
    const allowed = ['example.com', 'api.stripe.com', '8.8.8.8', '1.1.1.1', '93.184.216.34', '[2606:4700:4700::1111]', '[64:ff9b::808:808]', 'xn--7gv.com', 'foo.example.com']
    for (const h of allowed) expect(isBlockedHostname(h), `mora dovoliti: ${h}`).toBe(false)
  })

  test('WHATWG normalizacija: oddoblike IPv4 razresane v dotted (2130706433 → 127.0.0.1 → blok)', () => {
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1')
    expect(new URL('http://0x7f.0.0.1/').hostname).toBe('127.0.0.1')
    expect(new URL('http://127.1/').hostname).toBe('127.0.0.1')
    expect(validateTargetUrl('http://2130706433/').ok).toBe(false)
    expect(validateTargetUrl('http://0x7f000001/').ok).toBe(false)
  })

  test('validateTargetUrl: shema/userinfo/port politika', () => {
    // nedovoljene sheme
    for (const u of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'https://user:pass@example.com/', 'https://example.com:6379/', 'https://example.com:22/', 'https://example.com:8080/', 'https://127.0.0.1/x', 'http://[::1]/x']) {
      expect(validateTargetUrl(u).ok, `mora zavrniti: ${u}`).toBe(false)
    }
    // dovoljeno (testno okolje — NODE_ENV ni production)
    expect(validateTargetUrl('https://example.com/').ok).toBe(true)
    expect(validateTargetUrl('https://example.com:443/x?a=1').ok).toBe(true)
    expect(validateTargetUrl('https://example.com:8443/').ok).toBe(true)
    expect(validateTargetUrl('http://example.com/').ok).toBe(true)
    expect(ALLOWED_PORTS.has(8443)).toBe(true)
  })

  test('produkcijska politika: http zavrnjen v NODE_ENV=production (dokumentirana izjema SSRF_ALLOW_HTTP)', () => {
    const prevNode = process.env.NODE_ENV
    const prevAllow = process.env.SSRF_ALLOW_HTTP
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.SSRF_ALLOW_HTTP
      const r = validateTargetUrl('http://example.com/')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('https')
      expect(validateTargetUrl('https://example.com/').ok).toBe(true)
      // eksplicitna dokumentirana izjema
      process.env.SSRF_ALLOW_HTTP = 'true'
      expect(validateTargetUrl('http://example.com/').ok).toBe(true)
    } finally {
      if (prevNode === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNode
      if (prevAllow === undefined) delete process.env.SSRF_ALLOW_HTTP
      else process.env.SSRF_ALLOW_HTTP = prevAllow
    }
  })
})

describe('#30 — DNS validacija (fail-closed na mešane/zasebne zapise)', () => {
  test('domena z javnim IN zasebnim A zapisom → zavrnjena (ne "izberi javnega")', async () => {
    const mixed = async () => {
      await resolveValidatedAddresses('evil.example', {
        resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }],
      })
    }
    await expect(mixed()).rejects.toThrow('dns_blocked_address')
  })

  test('AAAA zasebni + javni A → zavrnjeno; vsi javni → sprejeto (vrne naslove)', async () => {
    await expect(
      resolveValidatedAddresses('evil6.example', {
        resolver: async () => [{ address: '2606:4700::1', family: 6 }, { address: 'fd12::1', family: 6 }],
      }),
    ).rejects.toThrow('dns_blocked_address')
    const ok = await resolveValidatedAddresses('good.example', {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    expect(ok.map((a) => a.address)).toEqual(['93.184.216.34'])
  })

  test('prazen DNS odgovor → napaka (fail-closed)', async () => {
    await expect(
      resolveValidatedAddresses('empty.example', { resolver: async () => [] }),
    ).rejects.toThrow('dns_empty')
  })
})

describe('#30 — transport: DNS pinning + preusmeritve (lokalni strežnik, _testAllowPrivate)', () => {
  const PORT = 8443 // dovoljen port (allowlist) + neprivilegiran (bindable)

  test('povezava na PREVERJENI IP; Host glava ohrani ime; 3x se NE sledi', async () => {
    let hitsA = 0
    let hitsB = 0
    let seenHost = ''
    let seenPath = ''
    const bait = http.createServer((rq, rs) => {
      hitsB++
      rs.writeHead(200)
      rs.end()
    })
    await new Promise<void>((r) => bait.listen(8444, '127.0.0.1', () => r()))
    const a = http.createServer((rq, rs) => {
      hitsA++
      seenHost = rq.headers.host || ''
      seenPath = rq.url || ''
      if (seenPath === '/redirect') {
        rs.writeHead(302, { location: 'http://127.0.0.1:8444/bait' })
        rs.end()
        return
      }
      rs.writeHead(200, { 'content-type': 'application/json' })
      rs.end('{"ok":true}')
    })
    try {
      await new Promise<void>((r) => a.listen(PORT, '127.0.0.1', () => r()))
      // 1) DNS pinning: 'localhost' se razreši na 127.0.0.1 → povezava na ta IP,
      //    Host glava ohrani 'localhost:8443' (ime ni podtaknjeno)
      const r1 = await ssrfSafeRequest(`http://localhost:${PORT}/ping`, { _testAllowPrivate: true, timeoutMs: 4000 })
      expect(r1.status).toBe(200)
      expect(r1.ok).toBe(true)
      expect(r1.errorCategory).toBe('')
      expect(seenHost).toBe(`localhost:${PORT}`) // pinning + Host ohranjen
      expect(seenPath).toBe('/ping')
      // 2) preusmeritev: 302 se NE sledi — drugi strežnik NI dosežen
      const r2 = await ssrfSafeRequest(`http://localhost:${PORT}/redirect`, { _testAllowPrivate: true, timeoutMs: 4000 })
      expect(r2.status).toBe(302)
      expect(r2.ok).toBe(false)
      expect(r2.location).toContain('8444')
      expect(hitsA).toBe(2) // samo dva zahtevka na A (ping + redirect)
      expect(hitsB).toBe(0) // NIKOLI nismo sledili preusmeritvi
    } finally {
      await new Promise<void>((r) => a.close(() => r()))
      await new Promise<void>((r) => bait.close(() => r()))
    }
  })

  test('nedosegljiv naslov → omrežna kategorija (timeout/refused), ne surovo sporočilo', async () => {
    const r = await ssrfSafeRequest('http://192.0.2.1:8443/x', { _testAllowPrivate: true, timeoutMs: 700 })
    expect(r.status).toBe(0)
    expect(['timeout', 'network', 'refused']).toContain(r.errorCategory)
  })
})

describe('#30 — credential politika (privzeto BREZ skrivnosti)', () => {
  test('credentialHeadersFor: privzeto PRAZNO; opt-in SAMO na https', () => {
    const row = { baseUrl: 'https://api.example.com', apiKey: 'sk-SECRET-30', apiSecret: 'sec-SECRET-30', config: '{}' }
    // brez opt-in → nič (tudi na https)
    expect(credentialHeadersFor(row, new URL('https://api.example.com'))).toEqual({})
    // opt-in + https → glave
    const rowOptIn = { ...row, config: '{"sendCredentialsOnTest":true}' }
    const httpsHeaders = credentialHeadersFor(rowOptIn, new URL('https://api.example.com'))
    expect(httpsHeaders['authorization']).toBe('Bearer sk-SECRET-30')
    expect(httpsHeaders['x-api-secret']).toBe('sec-SECRET-30')
    // opt-in + http → NIČ (poverilnica ne gre po odprtem kanalu)
    expect(credentialHeadersFor(rowOptIn, new URL('http://api.example.com'))).toEqual({})
    // opt-in + https, brez ključev → prazno
    expect(credentialHeadersFor({ ...rowOptIn, apiKey: '', apiSecret: '' }, new URL('https://api.example.com'))).toEqual({})
  })

  test('SMS webhook (reminders): zasebni cilj zavrnjen fail-soft (brez klica)', async () => {
    const r = await sendSms({ provider: 'webhook', url: 'http://127.0.0.1:9/x', secret: 'whsec-30' }, '+38640123456', 'test')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('Webhook')
  })
})

describe('#30 — raven rute: zavrnitve + higiiena logov (brez skrivnosti/query)', () => {
  test('port 6379 (public host) → 400; userinfo → 400; localhost → 400 (zasebnih)', async () => {
    const mk = async (baseUrl: string) => {
      const c = await integrationsPOST(req('/api/integrations', ownerToken, 'POST', { name: `${PREFIX}P${Math.random().toString(36).slice(2, 6)}`, baseUrl, locationId: locA }))
      return ((await c.json()) as { integration: { id: string } }).integration.id
    }
    const idPort = await mk('https://example.com:6379')
    const ePort = await testConnectionPOST(req(`/api/integrations/${idPort}/test`, ownerToken, 'POST'), { params: Promise.resolve({ id: idPort }) })
    expect(ePort.status).toBe(400)
    const idUser = await mk('https://user:pass@example.com')
    const eUser = await testConnectionPOST(req(`/api/integrations/${idUser}/test`, ownerToken, 'POST'), { params: Promise.resolve({ id: idUser }) })
    expect(eUser.status).toBe(400)
    const idLocal = await mk('http://localhost:3000')
    const eLocal = await testConnectionPOST(req(`/api/integrations/${idLocal}/test`, ownerToken, 'POST'), { params: Promise.resolve({ id: idLocal }) })
    expect(eLocal.status).toBe(400)
    const e = (await eLocal.json()) as { error: string }
    expect(e.error).toContain('zasebnih')
  })

  test('nedosegljiv javni gostitelj: log vsebuje SAMO host (brez apiKey/query), odgovor brez skrivnosti', async () => {
    const created = await integrationsPOST(req('/api/integrations', ownerToken, 'POST', {
      name: `${PREFIX}LogHig`, baseUrl: 'https://integ30-host.invalid/path?token=QUERY-SECRET-1', apiKey: 'sk-LOG-SECRET-30', locationId: locA,
    }))
    const id = ((await created.json()) as { integration: { id: string } }).integration.id
    const r = await testConnectionPOST(req(`/api/integrations/${id}/test`, ownerToken, 'POST'), { params: Promise.resolve({ id }) })
    expect(r.status).toBe(200)
    const d = (await r.json()) as { reachable: boolean; error: string }
    expect(d.reachable).toBe(false) // .invalid → DNS napaka (RFC 2606)
    // #30 §B: odgovor NE sme vsebovati skrivnosti
    expect(JSON.stringify(d)).not.toContain('sk-LOG-SECRET-30')
    expect(JSON.stringify(d)).not.toContain('QUERY-SECRET-1')
    // log: samo varni host + shema — BREZ query stringa, BREZ apiKey
    const log = await db.integrationLog.findFirst({ where: { integrationId: id, action: 'test_connection' } })
    expect(log).toBeTruthy()
    const rd = String(log?.requestData || '')
    expect(rd).toContain('integ30-host.invalid')
    expect(rd).not.toContain('QUERY-SECRET-1')
    expect(rd).not.toContain('sk-LOG-SECRET-30')
    expect(rd).not.toContain('token=')
    // revizija: samo status/duration/brez skrivnosti
    const audit = await db.auditLog.findFirst({ where: { action: 'INTEGRATION_TESTED', entityId: id } })
    expect(audit).toBeTruthy()
    expect(String(audit?.details || '')).not.toContain('sk-LOG-SECRET-30')
  })
})

/* ════════════════ Issue #37 — Stripe vezava na PayLink ════════════════ */

describe('#37 — potrditev: SAMO kanonična seja te povezave', () => {
  const origFetch = globalThis.fetch
  const mkSession = (id: string, link: { id: string; orderId: string }, extra: Record<string, unknown> = {}) => ({
    id, object: 'checkout.session', status: 'complete', mode: 'payment', payment_status: 'paid',
    payment_intent: `pi_${id}`, amount_total: 2076, currency: 'eur', client_reference_id: link.id,
    metadata: { payLinkId: link.id, orderId: link.orderId, locationId: locA, expectedAmountCents: '2076', currency: 'eur' },
    ...extra,
  })

  test('TUJA plačana seja (isti znesek!) → 409 PRED klicem na Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    let stripeCalls = 0
    // №28: števec sme šteti SAMO Stripe klice. Prej je štel VSAK `fetch`, tudi
    // obnovitev omejitve (Upstash REST), ki prav tako uporablja globalThis.fetch —
    // v GitLab CI-ju (kjer je bila UPSTASH spremenljivka nastavljena z neveljavnim
    // URL-jem) je test zato videl 2 namesto 0 in je trdil, da je guard spustil
    // klic na Stripe, čeprav Stripe nikoli ni bil klican.
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes('api.stripe.com')) stripeCalls++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const oid = await mkOrder()
      const link = await mkLink(oid)
      await db.payLink.update({ where: { token: link.token }, data: { amount: 18.5, tip: 2.26, sessionId: 'cs_canon_A' } })
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_foreign_paid' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(409)
      const d = (await res.json()) as { error: string }
      expect(d.error).toContain('ni veljavna')
      expect(stripeCalls).toBe(0) // zavrnitev PRED klicem — tujega ID-ja sploh ne povprašamo
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(row?.status).toBe('open') // ni poravnave
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('napačni metadata (tuja povezava) / valuta / mode → 409 (stripe echo preverjen)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    const oid = await mkOrder()
    const link = await mkLink(oid)
    await db.payLink.update({ where: { token: link.token }, data: { amount: 18.5, tip: 2.26, sessionId: 'cs_m1' } })
    const cases: [string, Record<string, unknown>][] = [
      ['cs_m1', { metadata: { payLinkId: `other-${RUN}`, orderId: oid, locationId: locA, expectedAmountCents: '2076' } }],
      ['cs_m1', { metadata: { payLinkId: link.id, orderId: `other-${RUN}`, locationId: locA, expectedAmountCents: '2076' } }],
      ['cs_m1', { currency: 'usd', metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' } }],
      ['cs_m1', { mode: 'subscription', metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' } }],
      ['cs_m1', { status: 'expired', metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' } }],
      ['cs_m1', { id: 'cs_NOT_echo', metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' } }],
    ]
    try {
      for (let i = 0; i < cases.length; i++) {
        const [sid, extra] = cases[i]
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(mkSession(sid, { id: link.id, orderId: oid }, extra)), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
        const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_m1' }), { params: Promise.resolve({ token: link.token }) })
        expect(res.status, `primer ${i}`).toBe(409)
        const row = await db.payLink.findUnique({ where: { token: link.token } })
        expect(row?.status, `primer ${i} — brez poravnave`).toBe('open')
      }
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('povezava brez kanonične seje (legacy/zaklenjen znesek brez seje) → 409', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    const oid = await mkOrder()
    const link = await mkLink(oid)
    await db.payLink.update({ where: { token: link.token }, data: { amount: 18.5, tip: 2.26 } }) // sessionId NULL
    let stripeCalls = 0
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes('api.stripe.com')) stripeCalls++ // №28: samo Stripe
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const res = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_any' }), { params: Promise.resolve({ token: link.token }) })
      expect(res.status).toBe(409)
      expect(stripeCalls).toBe(0)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })
})

describe('#37 — ustvarjanje: idempotenca, zamenjava, sočasnost', () => {
  const origFetch = globalThis.fetch

  test('ponovljen POST z istim zneskom → ISTA seja (en create klic, enak sessionId)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    let creates = 0
    const oid = await mkOrder()
    const link = await mkLink(oid)
    const sess = (id: string, url: string, status: string, amount: number) => ({
      id, object: 'checkout.session', status, mode: 'payment', payment_status: status === 'complete' ? 'paid' : 'unpaid',
      payment_intent: null, amount_total: amount, currency: 'eur', client_reference_id: link.id, url,
      metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: String(amount), currency: 'eur' },
    })
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u)
      if (url.includes('/checkout/sessions') && (init?.method || 'GET') === 'POST') {
        creates++
        return new Response(JSON.stringify({ id: `cs_reuse_${creates}`, url: `https://checkout.stripe.com/c/pay/cs_reuse_${creates}` }), { status: 200 })
      }
      if (url.includes('/checkout/sessions/cs_reuse_1')) {
        return new Response(JSON.stringify(sess('cs_reuse_1', 'https://checkout.stripe.com/c/pay/cs_reuse_1', 'open', 2076)), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const r1 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) })
      expect(r1.status).toBe(201)
      const d1 = (await r1.json()) as { sessionId: string }
      const r2 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) })
      expect(r2.status).toBe(201)
      const d2 = (await r2.json()) as { sessionId: string }
      expect(creates).toBe(1) // en create klic — drugi POST ponovno uporabi sejo
      expect(d2.sessionId).toBe(d1.sessionId)
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(row?.sessionId).toBe('cs_reuse_1')
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('spremenjena napitnina → VARNA zamenjava: nova seja kanonična, stara ZAPRTA', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    const oid = await mkOrder()
    const link = await mkLink(oid)
    let creates = 0
    let expires = 0
    const sessions: Record<string, string> = {}
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u)
      if (url.endsWith('/expire')) { // PREJ create vejo — expire JE tudi POST na /checkout/sessions/…
        expires++
        return new Response('{}', { status: 200 })
      }
      if (url.includes('/checkout/sessions') && (init?.method || 'GET') === 'POST') {
        creates++
        const id = `cs_swap_${creates}`
        sessions[id] = `https://checkout.stripe.com/c/pay/${id}`
        return new Response(JSON.stringify({ id, url: sessions[id] }), { status: 200 })
      }
      // status stare seje (cs_swap_1) — odprta, a stari znesek
      if (url.includes('/checkout/sessions/cs_swap_1')) {
        return new Response(JSON.stringify({
          id: 'cs_swap_1', status: 'open', mode: 'payment', payment_status: 'unpaid',
          amount_total: 2076, currency: 'eur', url: sessions['cs_swap_1'],
          metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const r1 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) })
      expect(r1.status).toBe(201)
      const d1 = (await r1.json()) as { sessionId: string }
      expect(d1.sessionId).toBe('cs_swap_1')
      // druga napitnina → NOVA seja + zamenjava + zaprtje stare
      const r2 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 5 }), { params: Promise.resolve({ token: link.token }) })
      expect(r2.status).toBe(201)
      const d2 = (await r2.json()) as { sessionId: string }
      expect(creates).toBe(2)
      expect(d2.sessionId).toBe('cs_swap_2')
      expect(expires).toBe(1) // stara seja zaprta
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(row?.sessionId).toBe('cs_swap_2')
      expect(Number(row?.tip)).toBe(5)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('SOČASNI ustvarjanji → ENA kanonična plačljiva seja (izgubljenikova ZAPRTA)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    const oid = await mkOrder()
    const link = await mkLink(oid)
    let creates = 0
    let expires = 0
    const sessData: Record<string, string> = {}
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u)
      if (url.endsWith('/expire')) { // PREJ create vejo — expire JE tudi POST na /checkout/sessions/…
        expires++
        return new Response('{}', { status: 200 })
      }
      if (url.includes('/checkout/sessions') && (init?.method || 'GET') === 'POST') {
        creates++
        const id = `cs_race_${creates}`
        sessData[id] = `https://checkout.stripe.com/c/pay/${id}`
        return new Response(JSON.stringify({ id, url: sessData[id] }), { status: 200 })
      }
      const m = /\/checkout\/sessions\/(cs_race_\d+)$/.exec(url)
      if (m && sessData[m[1]]) {
        return new Response(JSON.stringify({
          id: m[1], status: 'open', mode: 'payment', payment_status: 'unpaid',
          amount_total: 2076, currency: 'eur', url: sessData[m[1]],
          metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      const [r1, r2] = await Promise.all([
        publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) }),
        publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 2.26 }), { params: Promise.resolve({ token: link.token }) }),
      ])
      expect([r1.status, r2.status].sort()).toEqual([201, 201])
      const d1 = (await r1.json()) as { sessionId: string }
      const d2 = (await r2.json()) as { sessionId: string }
      // OBA odgovora kažeta NA ISTO (zmagovalčevo) sejo
      expect(d1.sessionId).toBe(d2.sessionId)
      const row = await db.payLink.findUnique({ where: { token: link.token } })
      expect(row?.sessionId).toBe(d1.sessionId)
      expect(creates).toBe(2) // dve ustvarjeni (a izgubljenikova takoj zaprta)
      expect(expires).toBe(1) // izgubljenikova seja ZAPRTA — plačljiva ostane samo kanonična
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })
})

describe('#37 — poravnava: EN finančni učinek (CAS + plkset idempotenca)', () => {
  const origFetch = globalThis.fetch

  test('dvojni potrditvi iste plačane seje → EN Payment + EN Receipt', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_37'
    const oid = await mkOrder()
    const link = await mkLink(oid)
    await db.payLink.update({ where: { token: link.token }, data: { amount: 18.5, tip: 2.26, sessionId: 'cs_dbl' } })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        id: 'cs_dbl', status: 'complete', mode: 'payment', payment_status: 'paid',
        payment_intent: 'pi_dbl', amount_total: 2076, currency: 'eur', client_reference_id: link.id,
        metadata: { payLinkId: link.id, orderId: oid, locationId: locA, expectedAmountCents: '2076', currency: 'eur' },
      }), { status: 200 })) as typeof fetch
    try {
      const r1 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_dbl' }), { params: Promise.resolve({ token: link.token }) })
      expect(r1.status).toBe(200)
      // druga potrditev iste seje — idempotentno (že plačano), brez novega učinka
      const r2 = await publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { verifySession: 'cs_dbl' }), { params: Promise.resolve({ token: link.token }) })
      expect(r2.status).toBe(409) // zgodnja preverba: 'Račun je že plačan.'
      const payments = await db.payment.count({ where: { idempotencyKey: { startsWith: `plkset:${oid}` } } })
      expect(payments).toBe(1)
      const receipts = await db.receipt.count({ where: { orderId: oid } })
      expect(receipts).toBe(1)
    } finally {
      delete process.env.STRIPE_SECRET_KEY
      globalThis.fetch = origFetch
    }
  })

  test('SOČASNI simulator plačili na isti povezavi → EN Payment (CAS zmagovalni zahtevek)', async () => {
    const oid = await mkOrder()
    const link = await mkLink(oid)
    const [r1, r2] = await Promise.all([
      publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: link.token }) }),
      publicPayPOST(req(`/api/public/pay/${link.token}`, '', 'POST', { tip: 0 }), { params: Promise.resolve({ token: link.token }) }),
    ])
    // ena poravna + en idempotenten odgovor (replay) — NIKOLI dva finančna učinka
    expect([r1.status, r2.status].sort()).toEqual([200, 200])
    const payments = await db.payment.count({ where: { idempotencyKey: { startsWith: `plkset:${oid}` } } })
    expect(payments).toBe(1)
    const receipts = await db.receipt.count({ where: { orderId: oid } })
    expect(receipts).toBe(1)
    const row = await db.payLink.findUnique({ where: { token: link.token } })
    expect(row?.status).toBe('paid')
  })
})

describe('#37 — DDL + register + i18n + javna napaka', () => {
  test('migrate-paylink-session: 401 brez žetona, 403 waiter, owner → alreadyApplied (SQLite ima stolpec)', async () => {
    expect((await migratePaylinkSessionPOST(req('/api/admin/migrate-paylink-session', '', 'POST', {}))).status).toBe(401)
    expect((await migratePaylinkSessionPOST(req('/api/admin/migrate-paylink-session', waiterToken, 'POST', {}))).status).toBe(403)
    const res = await migratePaylinkSessionPOST(req('/api/admin/migrate-paylink-session', ownerToken, 'POST', {}), )
    expect(res.status).toBe(200)
    const d = (await res.json()) as { alreadyApplied: boolean }
    expect(d.alreadyApplied).toBe(true)
  })

  test('register SCHEMA_MIGRATIONS vsebuje paylink-session + i18n opis v SL/HR', () => {
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'paylink-session')
    expect(m).toBeTruthy()
    expect(m?.endpoint).toBe('/api/admin/migrate-paylink-session')
    expect(t('sl', 'mig.paylinkSession.desc')).not.toBe('mig.paylinkSession.desc')
    expect(t('hr', 'mig.paylinkSession.desc')).not.toBe('mig.paylinkSession.desc')
  })

  test('javna napaka ima gostovski prevod (pay.errorSessionInvalid v SL/HR/EN)', () => {
    expect(guestApiErrorKey('Plačilna seja ni veljavna za to povezavo.')).toBe('pay.errorSessionInvalid')
    expect(t('sl', 'pay.errorSessionInvalid')).toContain('osebje')
    expect(t('hr', 'pay.errorSessionInvalid')).toContain('osoblje')
    expect(t('en', 'pay.errorSessionInvalid')).toContain('staff')
  })
})
