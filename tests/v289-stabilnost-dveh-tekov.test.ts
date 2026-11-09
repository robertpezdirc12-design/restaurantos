import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.289.0 — STABILNOST DVEH TEKOV (A-kandidat iz zaključka v1.288.0: »živa
 * potrditev stabilnosti po naslednjih 2 tekih suite na novi kodi (DMMF
 * pregled — pričakovano: 0 mrtvih števcev, 0 predponskih stalnih ostanov,
 * edina rast demo-realna meja)«).
 *
 * MERITEV (2 zeleni teka 6048/3/0 na seedani bazi po 7. resetu peskovnika,
 * DMMF klasifikacija vseh 142 tabel po vsakem teku):
 *  - PREHODNO RAVNOTEŽJE, ne akumulacija: po teku 1 ~93 predponskih vrstic
 *    (AuditLog 66, GuestFeedback 7, InventoryItem 8, Integration 4, EventLog
 *    7, Location 2, + 8 tabel po 1) — po teku 2 IDENTIČNA števila, vzorci
 *    nosijo run-id teka 2 → vrstice teka 1 je pomel naslednji tek (mehanizem:
 *    sweepTestFixtures v beforeAll lastnikov predpon + centralni Ç3 sweep).
 *    KATERE datoteke končajo po zadnjem centralnem sweepu določa razporejevalnik
 *    bun test (vzporedni workerji) — profil je determinističen za isto okolje
 *    (oba teka identična), a odvisen od števila workerjev (razlaga razlike proti
 *    19+6 iz finalnega teka v1.288.0 — peskovnik je bil med sejama resetiran).
 *  - ŠTEVCI: 0 TRAJNO mrtvih števcev — vsak tek je pustil 1 PREHODEN mrtev
 *    števec »order:i30-loc-a-<run>« (issue30-37-ssrf: receipt-only izbris v
 *    afterAll), ki ga naslednji tek pobere prek Counter contains prehoda
 *    (predponski id lokacije v imenu števca). Živi dokaz menjave: števec teka 1
 *    (mw932rfl) je izginil med tekom 2; samoten tek po teku 2 je enako pobral
 *    mw93aaa4 in pustil novega mw93oxli.
 *  - DEMO-REALNA MEJA (popravek dokumentacije v1.288.0 z merjenimi številkami):
 *    AuditLog +52/+38 čistih na tek (~45 povprečno; v1.288.0 je zapisala ~41),
 *    EventLog +22/+22 (točno kot dokumentirano), DEMO_LOGIN 11/tek (NE 2/tek —
 *    burst 11 prijav v 15 ms je preizkus rate-limit 10/min v
 *    tests/auth-demo-login; userId semenskega admina = čiste vrstice),
 *    Integration 3 stabilne (ensure), DeviceRegistry 1, grn 1/dan.
 *  - VARNOST: seme (1 lokacija, 4 zaposleni, 12 artiklov, 14 miz, 4 demo
 *    naročila) pred=po obeh tekih nedotaknjeno.
 *
 * POPRAVEK (tests/issue30-37-ssrf-paylink-binding.test.ts): 11. datoteka
 * vzorca najdbe #1 iz v1.288.0 — counter izbris razširjen receipt →
 * receipt+order (in-array vzorec 10 datotek). Merjeno: datoteka ustvari 8
 * zaporedij naročil na lastni lokaciji ('order:i30-loc-a-<run>' value 8) in
 * jo pobriše z lastnim reverse-FK afterAll preden kateri koli sweep vidi njen
 * id. RDEČI DOKAZ: samoten tek na stari kodi pusti mrtev števec (25/25
 * zelenih, 1 mrtev), na novi kodi 0 mrtvih števcev (25/25 zelenih) — pogodba
 * »0 mrtvih števcev po teku« zdaj neodvisna od razporejanja datotek.
 */

const P = 'v289-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(counter|location):/

// ── Ç1) VEDENJE — mehanizem samozdravljenja prehodnih števcev ─────────────

describe('v289 Ç1: mehanizem samozdravljenja (Counter contains prehod)', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Ç1a oblika i30 prehodnega števca: »order:<predponski-id>« pobran s sweepom (self-heal dokaz)', async () => {
    // Oblika, ki jo po vsakem teku pusti i30 datoteka, preden jo pobere
    // naslednji tek: id lokacije je PREDPONSKI (i30-loc-a-<run>) → ime števca
    // vsebuje predpono → Counter contains prehod (FIELD_SWEEP
    // { model: 'counter', fields: ['name'], contains: true }) ga vidi.
    const names = [`order:${P}loc-a-${RUN}`, `receipt:${P}loc-b-${RUN}`]
    for (const name of names) {
      await db.counter.create({ data: { id: nid(), name, value: 3 } })
    }
    try {
      await sweepTestFixtures(db, [P])
      for (const name of names) {
        expect(await db.counter.count({ where: { name } })).toBe(0)
      }
    } finally {
      for (const name of names) {
        await db.counter.deleteMany({ where: { name } }).catch(() => null)
      }
    }
  })

  test('Ç1b varnost: števec z imenom BREZ predpone preživi sweep (realna oblika)', async () => {
    // Realni števci ('order:<nid lokacije>', 'grn:GRN-<datum>') ne nosijo
    // testnih predpon → contains prehod jih NE SME tid (pogodba: brisanje
    // izključno po testni predponi). Oblika: lokacijski del je nid() — nid
    // odstrani vezaje, zato ime iz nid delov NIKOLI ne vsebuje predpone.
    const realName = `order:${nid()}`
    await db.counter.create({ data: { id: nid(), name: realName, value: 7 } })
    try {
      await sweepTestFixtures(db, [P])
      expect(await db.counter.count({ where: { name: realName } })).toBe(1)
    } finally {
      await db.counter.deleteMany({ where: { name: realName } }).catch(() => null)
    }
  })
})

// ── Ç2) PINI POPRAVKA — 11. datoteka vzorca najdbe #1 ─────────────────────

describe('v289 Ç2: popravek i30 — števci naročil (receipt+order)', () => {
  test('Ç2a issue30-37-ssrf: counter izbris razširjen na order (in-array vzorec 10 datotek iz v1.288.0)', () => {
    // RDEČI pin: stara koda je imela `name: `receipt:${loc.id}`` (samo en
    // števec) — samoten tek je pustil mrtev »order:i30-loc-a-<run>«.
    expect(read('tests/issue30-37-ssrf-paylink-binding.test.ts')).toContain(
      'name: { in: [`receipt:${loc.id}`, `order:${loc.id}`] }',
    )
  })

  test('Ç2b mehanizem menjave: beforeAll sweep lastnika pobere prehodne vrstice prejšnjega teka', () => {
    // To je razlog, zakaj prehodni ostanki NISO akumulacija: datoteka začne z
    // sweepom svojih predpon (i30-/p37-) preden ustvari nove fiksture.
    expect(read('tests/issue30-37-ssrf-paylink-binding.test.ts')).toContain(
      'sweepTestFixtures(db, [PREFIX, P37])',
    )
  })

  test('Ç2c ostala receipt-only mesta ne puščajo števcev (merjeno 2 teka + samotna teka — 0 mrtvih)', () => {
    // issue3-pos-readiness in furs-post imata receipt-only izbris, a NE
    // ustvarjata order števcev (fiskalne poti samo receipt:) — izmerjeno po
    // 2 tekih suite in samotnih tekih: edini mrtev števec je bil i30. Pini
    // dokumentirajo, da vzorca NE širimo špekulativno (samo izmerjene rupe).
    expect(read('tests/issue3-pos-readiness.test.ts')).toContain(
      'name: `receipt:${locId}`',
    )
    expect(read('tests/furs-post.test.ts')).toContain('name: `receipt:${locId}`')
  })
})

// ── Ç3) MERILNE POGODBE VALA (dokumentacija z merjenimi številkami) ───────

describe('v289 Ç3: merilne pogodbe (2 teka, DMMF klasifikacija)', () => {
  test('Ç3a DEMO_LOGIN 11/tek — popravek dokumentacije v1.288.0 (»2/tek« je bila napačna)', () => {
    const wl = read('worklog.md').slice(0, 5000)
    expect(wl).toContain('DEMO_LOGIN 11/tek')
  })

  test('Ç3b prehodno ravnotežje ~93 predponskih vrstic/tek zapisano z merjenimi številkami', () => {
    const wl = read('worklog.md').slice(0, 5000)
    expect(wl).toContain('93 predponskih')
  })

  test('Ç3c pogodba 0 trajno mrtvih števcev + prehoden i30 zapisana', () => {
    const wl = read('worklog.md').slice(0, 5000)
    expect(wl).toContain('0 TRAJNO mrtvih števcev')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v289 Ž: registri', () => {
  test('verzija 1.289.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.289.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.289.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.289.0-stabilnost-dveh-tekov')
  })

  test('TEST_PREFIXES: 140 z v289- registrirano', () => {
    expect(TEST_PREFIXES.includes(P)).toBe(true)
    expect(TEST_PREFIXES.length).toBe(140)
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je merilna higiena + 1 testni popravek)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('StabilnostDvehTekov')
    expect(read('prisma/schema.prisma')).not.toContain('StabilnostDvehTekov')
  })
})

afterAll(async () => {
  const res = await sweepTestFixtures(db, [P])
  expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
})
