import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.284.0 — SWEEP NID()-ID LOKACIJ S PREDPONSKIM IMENOM (location po imenu).
 *
 * Izveden A-kandidat iz zaključka v1.283.0 (»location FIELD_SWEEP po name za
 * nid()-id lokacije s predpono v imenu (izmerjena 1 vrstica 'i23-Nova',
 * 0 otrok)«; reset peskovnika pred valom je zgodovinsko vrstico pobrisal —
 * dokaz vala je STRUKTUREN, ne zgodovinski).
 *
 * VRZEL (izmerjeno v1.283.0 na živi bazi, vzročna verija najdena v tem valu):
 * POST /api/locations dodeli lokaciji nid() id, testna predpona pa živi SAMO
 * v imenu (tests/issue23-42: 'i23-Nova'; tests/unique-collision: 'uc-lok-*').
 * Centralni sweep je lokacijo čistil IZKLJUČNO po id-predponi (faza 1/3/4) →
 * takšna lokacija je nevidna VSEM prehodom:
 *  - faza 0 (FIELD_SWEEP): ni vpisa za location po imenu;
 *  - faza 1/3 (id): nid() id ne nosi predpone;
 *  - faza 2/5 (locationId otroci): otroci sirote nosijo nid() locationId;
 *  - faza 4 (lokacija zadnja): briše samo po id-predponi.
 * POSLEDICA (razlika do običajne crash-varovalke): issue23 afterAll se
 * zanaša IZKLJUČNO na sweepTestFixtures(['i23-']) → 'i23-Nova' je preživela
 * ZELENE teke (meritev v1.283.0). unique-collision čisti po imenu ROČNO
 * (afterAll po Task 44) → njegove preživijo samo crash pred afterAll.
 *
 * POPRAVEK (fixture-sweep.ts, 4 mesti):
 *  - NOV zbiralni prehod 0a: id-ji lokacij po IMENU (name startsWith predpona)
 *    → orphanLocIds (varnost = ista kot enterprise FIELD_SWEEP po name;
 *    realna imena ne nosijo testnih predpon — demo seed »RestaurantOS
 *    Ljubljana«, pin Č3 before=after);
 *  - blok otrok naročil (0b) razširjen z locationId IN orphanLocIds —
 *    plačilo→kupon (Restrict)→naročilo sirote bi sicer blokirali fazo 2;
 *  - prehoda 2 in 5 (locationId) razširjena z IN-seznamom (locChildOr) —
 *    otroci sirote imajo nid() locationId, startsWith jih ne vidi;
 *  - faza 4 (lokacija zadnja) briše tudi id IN orphanLocIds;
 *  - števec remainingLocations šteje tudi po imenu (poštena merilna točka:
 *    sirota po imenu JE testna lokacija).
 *
 * WORKSTATION (del A-kandidata, zavestno ven — izmerjeno): 0 vrstic v dev
 * bazi in 0 zapisovalcev (src/routes samo berejo; migrate-issue11 ustvari
 * tabelo, ne vrstic) → registracija bi bila mrtva teža (vzorec c15-/c23-).
 * Komentar na mestu vpisa dokumentira vrstni red (PRED property) za prihodnji
 * val, ki ga bo zapisal. Pin Č2 varuje pred tiho prihodnjo registracijo.
 */

const P = 'v284-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(location|employee|order|receipt|check|payment):/

// ── Č1) VEDENJE — vrzel izolirana na vsakem nivoju ───────────────────────

describe('v284 Č1: sweep pobira nid()-id lokacije s predponskim imenom', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Č1a i23 vzorec: gola lokacija z nid() id-jem in predponskim imenom → pobrana po imenu', async () => {
    // IZOLACIJA VRZELI (izmerjena vrstica 'i23-Nova', v1.283.0): POST
    // /api/locations dodeli nid() id → vsem prehodom po id nevidna; predpona
    // živi SAMO v imenu. Test ustvari fidelen par (nid id + predponsko ime)
    // in zahteva, da ga sweep pobere.
    const locId = nid()
    await db.location.create({ data: { id: locId, name: `${P}Nova ${RUN}`, code: `V284NV${RUN.toUpperCase()}` } })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.location.count({ where: { id: locId } })).toBe(0)
  }, 60_000)

  test('Č1b otrok po locationId: zaposleni z nid() id-jem in nid() locationId sirote → IN-seznam lokacijskega prehoda', async () => {
    // Otrok sirote nosi nid() locationId → prehoda 2/5 (startsWith predpona)
    // ga ne vidita. Brez IN-seznama bi zaposleni ostal SIROTA ZA VEDNO
    // (Employee→Location je SetNull — izbris lokacie mu nastavi NULL).
    const locId = nid()
    await db.location.create({ data: { id: locId, name: `${P}z-lok ${RUN}`, code: `V284ZL${RUN.toUpperCase()}` } })
    await db.employee.create({
      data: { id: nid(), name: `Sim Zaposleni ${RUN}`, email: `${P}emp-${RUN}@test.local`, locationId: locId },
    })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.employee.count({ where: { locationId: locId } })).toBe(0)
    expect(await db.location.count({ where: { id: locId } })).toBe(0)
  }, 60_000)

  test('Č1c naročilna veriga sirote: naročilo + račun + kupon + plačilo (Restrict) → 0b razširitev + IN-seznam', async () => {
    // Najglobja veriga: Payment→Check je Restrict, Check→Order Cascade,
    // Receipt→Order Restrict, Order→Location Restrict. Brez 0b razširitve
    // bi plačilo blokiralo kupon, kupon naročilo, naročilo lokacijo.
    const locId = nid()
    const orderId = nid()
    const receiptId = nid()
    const checkId = nid()
    const paymentId = nid()
    const num = Math.floor(Date.now() / 1000) % 1_000_000
    await db.location.create({ data: { id: locId, name: `${P}n-lok ${RUN}`, code: `V284NL${RUN.toUpperCase()}` } })
    await db.order.create({ data: { id: orderId, orderNumber: num, locationId: locId, status: 'completed' } })
    await db.receipt.create({
      data: {
        id: receiptId, receiptNumber: `R284-${num}`, orderId,
        businessName: 'Sim', businessAddress: 'Sim 1', businessId: 'SI1', taxId: 'T1',
        subtotal: 10, totalVat: 2.2, total: 12.2, paymentMethod: 'cash', locationId: locId,
      },
    })
    await db.check.create({ data: { id: checkId, checkNumber: num, orderId } })
    await db.payment.create({ data: { id: paymentId, checkId, amount: 12.2, type: 'cash' } })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    for (const [model, id] of [['location', locId], ['order', orderId], ['receipt', receiptId], ['check', checkId], ['payment', paymentId]] as const) {
      expect(await (db as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[model].count({ where: { id } })).toBe(0)
    }
  }, 60_000)

  test('Č1d varnost: nid() lokacija BREZ predpone v imenu preživi; id-predponska z imenom brez predpone še vedno pobrana (id pot nespremenjena)', async () => {
    // REGRESIJSKI VARUH VARNOSTI: popravek NE SME segati mimo testnih predpon
    // (realna lokacija z nid() id-jem in navadnim imenom preživi) in NE SME
    // zlomiti obstoječe id-poti (id-predponska lokacija z imenom BREZ
    // predpone se pobere kot prej).
    const realId = nid()
    const prefId = `${P}id-lok-${RUN}`
    // CI teče na SVEŽI bazi brez semena (ci.yml: db push BREZ db:seed —
    // »testi so samozadostni — potrjeno lokalno na prazni bazi«); demo seed
    // lokacija obstaja le na seedanih razvojnih bazah. Invarianta before=after
    // velja v obeh okoljih: lokalno 1→1 (polna preverba), v CI 0→0 (trivialno)
    // — vzorec sweep58 iz fixture-sweep.test.ts. Prvi CI zagon tega testa
    // (kumulativni push v1.283.0–v1.286.0) je padel ravno tu: strogi toBe(1)
    // je zahteval semensko vrstico, ki je v CI ne more biti.
    const demoSeedBefore = await db.location.count({ where: { name: 'RestaurantOS Ljubljana' } })
    try {
      await db.location.create({ data: { id: realId, name: `Restavracija Demo V284 ${RUN}`, code: `RDV284${RUN.toUpperCase()}` } })
      await db.location.create({ data: { id: prefId, name: `Ime brez predpone ${RUN}`, code: `IBP284${RUN.toUpperCase()}` } })
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.location.count({ where: { id: realId } })).toBe(1) // preživi — ni testna
      expect(await db.location.count({ where: { id: prefId } })).toBe(0) // id pot nespremenjena
      // demo seed lokacija prav tako preživi (isti varnostni razred kot Č3)
      expect(await db.location.count({ where: { name: 'RestaurantOS Ljubljana' } })).toBe(demoSeedBefore)
    } finally {
      await db.location.deleteMany({ where: { id: realId } }) // higiena lastne fiksture (vzorec v1.286.0: padec asercije ne sme puščati nid vrstic)
    }
  }, 60_000)
})

// ── Č2) PINI — statične varovalke popravka ───────────────────────────────

describe('v284 Č2: pini pokritja (zbiralni prehod + IN-seznami + registracija)', () => {
  test('zbiralni prehod orphanLocIds išče lokacije po IMENU (name startsWith — vzorec enterprise FIELD_SWEEP)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('orphanLocIds')
    expect(src).toContain("{ OR: forField('name', 'startsWith') }")
  })

  test('prehoda 2 in 5 (locationId) uporabljata locChildOr() — IN-seznam sirot ob predponskem startsWith', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const uses = src.split('locChildOr()').length - 1
    expect(uses, 'uporabljen v prehodih 2 in 5').toBeGreaterThanOrEqual(2)
  })

  test('faza 4 (lokacija zadnja) briše tudi id-je sirot: { id: { in: orphanLocIds } }', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('{ id: { in: orphanLocIds } }')
  })

  test('blok otrok naročil (0b) vključuje locationId IN orphanLocIds (plačilo→kupon Restrict bi blokiral fazo 2)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('{ locationId: { in: orphanLocIds } }')
  })

  test('števec remainingLocations šteje tudi po imenu (sirota po imenu JE testna lokacija)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('name: { startsWith: p }')
  })

  test('v284- registriran v TEST_PREFIXES; skupaj 136 vnosov (135 + ta val)', () => {
    expect(TEST_PREFIXES, P).toContain(P)
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('workstation ZAVESTNO VEN iz ID_SWEEP (0 zapisovalcev — mrtva teža, vzorec c15-/c23-); komentar dokumentira mesto vpisa', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).not.toMatch(/\{ model: 'workstation' \}/)
    expect(src).toContain('če ga prihodnji val zapiše, gre PRED property')
  })
})

// ── Č3) TEŽA — merjeno, ne ugibano ───────────────────────────────────────

describe('v284 Č3: centralni sweep z 136 predponami (proračun + varnost realnih podatkov)', () => {
  test('en poln centralni sweep znotraj 30 s; realne lokacije nedotaknjene (po id IN po imenu)', async () => {
    const isReal = (l: { id: string; name: string }) =>
      !TEST_PREFIXES.some((p) => l.id.startsWith(p)) && !TEST_PREFIXES.some((p) => l.name.startsWith(p))
    const realBefore = (await db.location.findMany({ select: { id: true, name: true } })).filter(isReal).length
    const t0 = Date.now()
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    const ms = Date.now() - t0
    console.log(`[v284] centralni sweep (136 predpon): ${ms} ms (referenca v283: 135 predpon 1,17 s)`)
    expect(ms).toBeLessThan(30_000)
    expect(res.remainingLocations).toBe(0)
    const realAfter = (await db.location.findMany({ select: { id: true, name: true } })).filter(isReal).length
    expect(realAfter).toBe(realBefore)
  }, 60_000)
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v284 Ž: registri', () => {
  test('verzija 1.302.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.302.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.302.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.302.0-nadzorni-val-stabilnosti-iii')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena sweepa)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('SweepLokacije')
    expect(read('prisma/schema.prisma')).not.toContain('SweepLokacije')
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
