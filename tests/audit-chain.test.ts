import { describe, expect, test, afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import {
  auditChainFields,
  auditCanonicalString,
  canonicalDetails,
  sortedKeysJson,
  verifyAuditChain,
  type ChainDb,
} from '../src/lib/audit-chain'
import { tipChainHash, verifyTipChain } from '../src/lib/tips'

/**
 * Task 33-c — tamper-evident revizijska veriga (audit §6/§193).
 *
 * Predpona fiksatur `33c-` — AuditLog/HaccpEntry nimata FK, cleanup v afterAll je
 * zato varen (deleteMany po id/entityId predponi). Veriga je GLOBALNA po modelu;
 * `after` v verifyAuditChain omogoča okno samo nad testnimi vrsticami.
 *
 * Omejitev, ki jo testi upoštevajo: vrstice z ISTIM millisekundnim časovnim žigom se
 * po (timestamp, id) ne dajo razvrstiti po pravem vrstnem redu vstavljanja (id je
 * naključen) — zato testi med zaporednimi vstavitvami počakajo ≥ 4 ms (dokumentirano
 * v JSDoc audit-chain.ts kot omejitev konkurenčnih/same-ms zapisov).
 */

const PREFIX = '33c-'
// Task 58: počisti ostanke prejšnjih crashanih tekov (isti predponi)
await sweepTestFixtures(db, [PREFIX])
const ACTION = 'CHAIN33C_TEST'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fake ChainDb za enotske teste — nadzorovan previousHash brez DB. */
function fakeDb(lastChainHash: string | null): ChainDb {
  return {
    auditLog: {
      findFirst: async () => (lastChainHash === null ? null : { chainHash: lastChainHash }),
    },
    haccpEntry: {
      findFirst: async () => (lastChainHash === null ? null : { chainHash: lastChainHash }),
    },
  } as unknown as ChainDb
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

afterAll(async () => {
  // obratna smer FK — AuditLog/HaccpEntry brez FK; predpona 33c- pokrije vse fiksature
  await db.auditLog.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { entityId: { startsWith: PREFIX } } }).catch(() => null)
  await db.haccpEntry.deleteMany({ where: { id: { startsWith: PREFIX } } }).catch(() => null)
})

describe('unit — kanonizacija (sortedKeysJson / canonicalDetails)', () => {
  test('sortedKeysJson: deterministično sortira ključe rekurzivno, polja ohrani po vrstnem redu', () => {
    const a = { b: 1, a: { d: [3, 1], c: 'x' } }
    const b = { a: { c: 'x', d: [3, 1] }, b: 1 }
    expect(sortedKeysJson(a)).toBe(sortedKeysJson(b))
    expect(sortedKeysJson(a)).toBe('{"a":{"c":"x","d":[3,1]},"b":1}')
  })

  test('canonicalDetails: objekt → sortirani JSON; neurejen JSON-string → urejen; ne-JSON → trim', () => {
    expect(canonicalDetails({ z: 1, a: 2 })).toBe('{"a":2,"z":1}')
    expect(canonicalDetails('{"z":1,"a":2}')).toBe('{"a":2,"z":1}')
    expect(canonicalDetails('  dober vnos  ')).toBe('dober vnos')
    expect(canonicalDetails(undefined)).toBe('')
    // enakost obeh poti (objekt in njegov JSON-string iz enakih podatkov, ključi urejeni)
    expect(canonicalDetails({ a: 2, z: 1 })).toBe(canonicalDetails('{"z":1,"a":2}'))
  })

  test('prazen previousHash za prvo vrstico + prazen datum (konvencija dateISO "")', () => {
    const s = auditCanonicalString({
      model: 'auditLog',
      previousHash: '',
      id: `${PREFIX}first`,
      action: ACTION,
      entityType: 'Test',
      entityId: `${PREFIX}e1`,
      details: { k: 'v' },
    })
    // oblika: model|prev|id|dateISO|action|entityType|entityId|locationId|details
    expect(s).toBe(`auditLog||${PREFIX}first||${ACTION}|Test|${PREFIX}e1||{"k":"v"}`)
    expect(sha256(s)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('chainHash je determinističen (isti vnos = isti hash) in občutljiv na id/action/details/locationId', async () => {
    const base = {
      id: `${PREFIX}det1`,
      action: ACTION,
      entityType: 'Test',
      entityId: `${PREFIX}e1`,
      details: { k: 'v' },
      locationId: '33c-loc-A',
    }
    const h1 = await auditChainFields(fakeDb('PREVHASH'), base)
    const h2 = await auditChainFields(fakeDb('PREVHASH'), { ...base })
    expect(h1.chainHash).toBe(h2.chainHash)
    expect(h1.previousHash).toBe('PREVHASH')

    const different = (over: Partial<typeof base>) => auditChainFields(fakeDb('PREVHASH'), { ...base, ...over })
    expect((await different({ id: `${PREFIX}det2` })).chainHash).not.toBe(h1.chainHash)
    expect((await different({ action: 'CHAIN33C_OTHER' })).chainHash).not.toBe(h1.chainHash)
    expect((await different({ details: { k: 'X' } })).chainHash).not.toBe(h1.chainHash)
    expect((await different({ locationId: '33c-loc-B' })).chainHash).not.toBe(h1.chainHash)
    // drug previousHash → drug hash (veriženje)
    expect((await auditChainFields(fakeDb('OTHER'), base)).chainHash).not.toBe(h1.chainHash)
  })

  test('fake db brez vrstic → previousHash "" (prva vrstica); z vrstico → prevzame chainHash', async () => {
    const opts = { id: `${PREFIX}x`, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e` }
    expect((await auditChainFields(fakeDb(null), opts)).previousHash).toBe('')
    expect((await auditChainFields(fakeDb('LASTROW'), opts)).previousHash).toBe('LASTROW')
  })
})

describe('integracija — AuditLog veriga na dev bazi', () => {
  test('2 zaporedna auditLog.create prek helperja → druga.previousHash == prva.chainHash', async () => {
    const id1 = `${PREFIX}seq1`
    const id2 = `${PREFIX}seq2`
    const c1 = await auditChainFields(db, { id: id1, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e1`, details: { n: 1 }, locationId: '33c-loc-A' })
    await db.auditLog.create({ data: { ...c1, id: id1, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e1`, details: '{"n":1}', locationId: '33c-loc-A' } })
    await sleep(4) // zagotovi drugačen millisekundni žig (omejitev same-ms — glej zgoraj)

    const c2 = await auditChainFields(db, { id: id2, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e2`, details: { n: 2 } })
    expect(c2.previousHash).toBe(c1.chainHash)
    await db.auditLog.create({ data: { ...c2, id: id2, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e2`, details: '{"n":2}' } })

    const r1 = await db.auditLog.findUnique({ where: { id: id1 } })
    const r2 = await db.auditLog.findUnique({ where: { id: id2 } })
    expect(r1?.chainHash).toBe(c1.chainHash)
    expect(r2?.previousHash).toBe(r1?.chainHash)
  })

  test('locationId je zapisan (lokacijski dogodek viden location-scoped uporabnikom)', async () => {
    const id = `${PREFIX}loc1`
    const c = await auditChainFields(db, { id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}eloc`, details: 'x', locationId: '33c-loc-A' })
    await db.auditLog.create({ data: { ...c, id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}eloc`, details: 'x', locationId: '33c-loc-A' } })
    const row = await db.auditLog.findUnique({ where: { id } })
    expect(row?.locationId).toBe('33c-loc-A')
    expect(row?.previousHash).toBe(c.previousHash)
  })

  test('verifyAuditChain: ok na 5 zaporednih zapisih (okno po `after`)', async () => {
    const after = new Date()
    let prev: { previousHash: string; chainHash: string } = { previousHash: '', chainHash: '' }
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      if (i > 0) await sleep(4)
      const id = `${PREFIX}v5-${i}`
      ids.push(id)
      const c = await auditChainFields(db, { id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e5`, details: { i } })
      // prva vrstica: previousHash kaže na zadnjo vrstico IZVEN okna (deljena dev baza —
      // prejšnji testi istega fajla se čistijo šele v afterAll); povezovalna preverba
      // zato samo od i=1 naprej (enako semantiko ima verifyAuditChain: prva vrstica okna
      // brez povezovalne preverbe)
      if (i > 0) expect(c.previousHash).toBe(prev.chainHash)
      await db.auditLog.create({ data: { ...c, id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}e5`, details: JSON.stringify({ i }) } })
      prev = c
    }
    const res = await verifyAuditChain(db, { limit: 100, after })
    expect(res.ok).toBe(true)
    expect(res.brokenAt).toBeNull()
    expect(res.checked).toBeGreaterThanOrEqual(5)
  })

  test('tamper check: spremenjen details → ok:false, brokenAt = id vrstice, reason "hash"', async () => {
    const after = new Date()
    const ids = [`${PREFIX}t1`, `${PREFIX}t2`, `${PREFIX}t3`]
    for (const id of ids) {
      const c = await auditChainFields(db, { id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}et`, details: { step: id } })
      // NAPOMBA: previousHash NE smemo ročno prepisati — chainHash je izračunan nad
      // helper-ovim previousHash (povezava na zadnjo vrstico baze). Ročni override bi
      // naredil vrstico sama-tamperano (stored previousHash ≠ hash povezave) in
      // verifikator bi pravilno zastavil t1 namesto t2 (bug testa, ne implementacije).
      await db.auditLog.create({ data: { ...c, id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}et`, details: JSON.stringify({ step: id }) } })
      await sleep(4)
    }
    // TAMPERING: spremeni details srednje vrstice naravnost v bazi ( mimo helperja)
    const target = await db.auditLog.findUnique({ where: { id: ids[1] } })
    expect(target).not.toBeNull()
    const originalDetails = target!.details
    await db.auditLog.update({ where: { id: ids[1] }, data: { details: JSON.stringify({ step: 'TAMPERED' }) } })

    const res = await verifyAuditChain(db, { limit: 100, after })
    expect(res.ok).toBe(false)
    expect(res.brokenAt).toBe(ids[1])
    expect(res.reason).toBe('hash')

    // povrni (da okno ostane veljavno za nadaljnje teste) in ponovno preveri
    await db.auditLog.update({ where: { id: ids[1] }, data: { details: originalDetails } })
    const res2 = await verifyAuditChain(db, { limit: 100, after })
    expect(res2.ok).toBe(true)
  })

  test('link break: izbris srednje vrstice → ok:false, reason "link" (izbris/vstavek je odkrit)', async () => {
    const after = new Date()
    const ids = [`${PREFIX}l1`, `${PREFIX}l2`, `${PREFIX}l3`]
    for (const id of ids) {
      const c = await auditChainFields(db, { id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}el`, details: { id } })
      await db.auditLog.create({ data: { ...c, id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}el`, details: JSON.stringify({ id }) } })
      await sleep(4)
    }
    await db.auditLog.delete({ where: { id: ids[1] } })
    const res = await verifyAuditChain(db, { limit: 100, after })
    expect(res.ok).toBe(false)
    expect(res.brokenAt).toBe(ids[2])
    expect(res.reason).toBe('link')
  })

  test('manjkajoč details → DB default "{}" — helper in verifikator sta usklajena', async () => {
    const after = new Date()
    const id = `${PREFIX}nodet`
    const c = await auditChainFields(db, { id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}enodet` })
    expect(c.chainHash).not.toBe('')
    await db.auditLog.create({ data: { ...c, id, action: ACTION, entityType: 'Test', entityId: `${PREFIX}enodet` } })
    const row = await db.auditLog.findUnique({ where: { id } })
    expect(row?.details).toBe('{}')
    const res = await verifyAuditChain(db, { limit: 10, after })
    expect(res.ok).toBe(true)
  })
})

describe('model haccpEntry — chain povezava (par)', () => {
  test('2 zaporedna haccpEntry prek helperja → druga.previousHash == prva.chainHash + verify ok', async () => {
    const after = new Date()
    const mk = (id: string, title: string, n: number) => auditChainFields(db, {
      id, model: 'haccpEntry', action: 'HACCP_ENTRY', entityType: 'HaccpEntry', entityId: id,
      details: { category: 'temperature', title, value: String(n), status: 'ok', description: '', correctiveAction: '', employeeName: '33c-tester' },
    })
    const id1 = `${PREFIX}h1`
    const id2 = `${PREFIX}h2`
    const c1 = await mk(id1, 'Hladilnik A', 4)
    await db.haccpEntry.create({ data: { ...c1, id: id1, category: 'temperature' as never, title: 'Hladilnik A', value: '4', status: 'ok' as never, employeeName: '33c-tester', locationId: null } })
    await sleep(4)
    const c2 = await mk(id2, 'Hladilnik B', 5)
    expect(c2.previousHash).toBe(c1.chainHash)
    await db.haccpEntry.create({ data: { ...c2, id: id2, category: 'temperature' as never, title: 'Hladilnik B', value: '5', status: 'ok' as never, employeeName: '33c-tester', locationId: null } })

    const r1 = await db.haccpEntry.findUnique({ where: { id: id1 } })
    const r2 = await db.haccpEntry.findUnique({ where: { id: id2 } })
    expect(r2?.previousHash).toBe(r1?.chainHash)

    const res = await verifyAuditChain(db, { model: 'haccpEntry', limit: 50, after })
    expect(res.ok).toBe(true)
  })

  test('haccp tamper: spremenjen title → ok:false, reason "hash"', async () => {
    const after = new Date()
    const id = `${PREFIX}ht`
    const c = await auditChainFields(db, {
      id, model: 'haccpEntry', action: 'HACCP_ENTRY', entityType: 'HaccpEntry', entityId: id,
      details: { category: 'cleaning', title: 'Original', value: '', status: 'ok', description: '', correctiveAction: '', employeeName: '33c-tester' },
    })
    await db.haccpEntry.create({ data: { ...c, id, category: 'cleaning' as never, title: 'Original', value: '', status: 'ok' as never, employeeName: '33c-tester' } })
    await db.haccpEntry.update({ where: { id }, data: { title: 'TAMPERED' } })
    const res = await verifyAuditChain(db, { model: 'haccpEntry', limit: 50, after })
    expect(res.ok).toBe(false)
    expect(res.brokenAt).toBe(id)
    expect(res.reason).toBe('hash')
  })
})

describe('regresija — TipDistribution veriga (tips.ts) ostane nespremenjena', () => {
  test('verifyTipChain: veljavno zaporedje → true; spremenjen znesek → false', () => {
    const rows = [
      { previousHash: '', chainHash: '', employeeId: 'emp-a', basis: 480 * 100, amount: 500 },
      { previousHash: '', chainHash: '', employeeId: 'emp-b', basis: 300 * 100, amount: 300 },
    ]
    let prev = ''
    for (const r of rows) {
      r.previousHash = prev
      r.chainHash = tipChainHash(prev, r.employeeId, r.basis, r.amount)
      prev = r.chainHash
    }
    expect(verifyTipChain(rows)).toBe(true)
    rows[1].amount = 999 // tampering
    expect(verifyTipChain(rows)).toBe(false)
  })
})
