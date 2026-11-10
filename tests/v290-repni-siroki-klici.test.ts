import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.290.0 — REPNI ŠIROKI KLICI (A-kandidat (a) iz zaključka v1.289.0:
 * »razširitev širokih klicev na vse repne datoteke (po vzorcu v283–v288
 * beforeAll) — rep bi se skrčil na ~0 neodvisno od readdir reda«).
 *
 * RDEČE IZHODIŠČE (klasifikacija classify-v290 po VSEH tabelah, predponska
 * prisotnost v KATEREM KOLI polju — stanje po zadnjem teku suite vala
 * v1.289.0 dopolnitve): 107 predponskih vrstic (auditLog 61, eventLog 20,
 * guestFeedback 7, inventoryItem 6, reservation 6, integration 4, location 2,
 * loyaltyAccount 1) + 0 mrtvih števcev (popravka i30/i7 iz v1.289.0 že
 * delujeta). Rep delajo 9 datotek, ki v readdir redu tečejo ZA zadnjim
 * centralnim širokim klicem (fixture-sweep[160]): issue30[162],
 * issue11-crm-core[218], v162[262], issue11-crm-admin[266],
 * guest-feedback[268], stocktake[271], haccp-plans[272], issue7[275],
 * v240[280] — afterAll vsake čisti LASTNE fiksture, ne pa stranskih učinkov
 * API-jev z nid() id-ji (predponska polja), ki jih vidi samo FIELD_SWEEP.
 *
 * POSEG (9 datotek): VHODNI široki klic — nadgradnja ozkega klica
 * sweepTestFixtures(db, [P]) na sweepTestFixtures(db, TEST_PREFIXES) v
 * beforeAll (TEST_PREFIXES ⊇ lastna predpona — ozek klic je podmnožica);
 * IZHODNI široki klic — sweepTestFixtures(db, TEST_PREFIXES) na koncu
 * afterAll. IZJEMA: haccp-plans nima beforeAll — setupP teče ob UVOZU modula
 * (pred beforeAll), zato je vhodni klic ZNOTRAJ setup() (nov beforeAll-sweep
 * bi pobrisal LASTNE fiksture datoteke).
 *
 * MEHANIKA (zakaj rep = 0 neodvisno od readdir reda): ko repna datoteka
 * začne, njena vhodni klic počisti vse ostanke datotek pred sabo (+ rep
 * prejšnjega teka); ko konča, njena izhodni klic počisti lastne stranske
 * učinke. Po teku suite ostanejo samo vrstice datotek, ki tečejo ZA zadnjo
 * repno datoteko — vse 9 merjenih puščalk je pokritih, ostale datoteke se
 * same čistijo (beforeAll ozek klic + lastni afterAll).
 */

const P = 'v290-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(counter|location):/

/** 9 repnih datotek iz meritev v1.289.0 (readdir pozicije v oglatih oklepajih). */
const REPNE_DATOTEKE = [
  'tests/issue30-37-ssrf-paylink-binding.test.ts', // [162]
  'tests/issue11-crm-core.test.ts', // [218]
  'tests/v162-waitlist-table-release.test.ts', // [262]
  'tests/issue11-crm-admin.test.ts', // [266]
  'tests/guest-feedback.test.ts', // [268]
  'tests/stocktake.test.ts', // [271]
  'tests/haccp-plans.test.ts', // [272]
  'tests/issue7-allergen-truth.test.ts', // [275]
  'tests/v240-reservation-cell.test.ts', // [280]
] as const

/** Predpone vseh 9 repnih datotek (vnos v TEST_PREFIXES). */
const REPNE_PREDPONE = ['i30-', 'i11-', 'v162-', 'i11a-', 'gfb-', 'tst57-', 'hcp64-', 'i7-', 'v240-'] as const

// ── Ç1) VEDENJE — široki klic vključuje lastno predpono (podmnožica) ───────

describe('v290 Ç1: mehanizem — široki klic počisti tudi lastno predpono', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Ç1a vrstica z lastno predpono pobrana s ŠIROKIM klicem (brez lastne predpone v argumentu)', async () => {
    // Mehanizem vhodnega/izhodnega klica repnih datotek: klic prejme
    // TEST_PREFIXES (140 drugih predpon + nikoli same sebe eksplicitno) —
    // lastna predpona datoteke je VSEBOVANA v TEST_PREFIXES, zato sweep počisti
    // tudi njene vrstice. Demo na dominantni repni tabeli (auditLog 61/107
    // izhodiščnih vrstic): nid() id + predponski userId (vzorec iz v1.285.0).
    const uid = `${P}emp-${RUN}`
    await db.auditLog.create({
      data: { id: nid(), userId: uid, action: 'SIM_V290', entityType: 'test', entityId: nid() },
    })
    expect(await db.auditLog.count({ where: { userId: uid } })).toBe(1)
    try {
      await sweepTestFixtures(db, TEST_PREFIXES) // ŠIROKI klic — P ni v argumentu
      expect(await db.auditLog.count({ where: { userId: uid } })).toBe(0)
    } finally {
      await db.auditLog.deleteMany({ where: { userId: uid } }).catch(() => null)
    }
  })

  test('Ç1b varnost: realne (nepredponske) lokacije preživijo široki klic (lastna realna fikstura — okoljsko neodvisno)', async () => {
    // v1.292.0 CI-fix (vzorec v287 Č1d + sweep58): CI tests job teče na SVEŽI
    // bazi (ci.yml: prisma db push na ci-fresh.db BREZ db:seed — 0 semenskih
    // vrstic), zato je bil prvotni »toBeGreaterThan(0) // dev seme« okoljsko
    // odvisen: rdeče @ f07c393 (6097/1/6098, alarm #125). Popravek: LASTNA
    // realna lokacija (id BREZ predpone — čisti pogoj »realnosti«, nobena od
    // 142 predpon se ne začne z 'real-') naredi pogodbo preživetja dokazljivo
    // na KATERI KOLI bazi (sveža CI 0→1, dev seme zraven lastne); invarianta
    // after = before + 1 dokaže hkrati: lastna PREŽIVI (+1) IN seme/ostale
    // realne ostanejo nedotaknjene (izguba katere koli → padec). Try/finally
    // higijena (LEKCIJA v1.286.0: padec asercije ne pušča vrstic) + začetni
    // deleteMany samo-zdravljenje (ubit tek ne zastrupi naslednjega).
    const isReal = (id: string) => !TEST_PREFIXES.some((p) => id.startsWith(p))
    const realId = 'real-loc-c1b-v290' // namerno BREZ predpone — to JE pogoj realnosti
    await db.location.deleteMany({ where: { id: realId } }).catch(() => null) // samo-zdravljenje
    const before = (await db.location.findMany({ select: { id: true } })).filter((l) => isReal(l.id)).length
    await db.location.create({ data: { id: realId, name: 'Realna lokacija Ç1b', code: 'REAL-C1B-V290' } })
    try {
      await sweepTestFixtures(db, TEST_PREFIXES)
      const after = (await db.location.findMany({ select: { id: true } })).filter((l) => isReal(l.id)).length
      expect(after).toBe(before + 1) // lastna realna lokacija PREŽIVI široki klic; seme nedotaknjeno
      expect(await db.location.findUnique({ where: { id: realId } })).toBeTruthy() // pozitiven dokaz na vsaki bazi
    } finally {
      await db.location.deleteMany({ where: { id: realId } }).catch(() => null) // higiena lastne fiksture
    }
  })
})

// ── Ç2) PINI POSEGA — vhodni + izhodni široki klic v 9 repnih datotekah ────

describe('v290 Ç2: pini posega (9 repnih datotek)', () => {
  test('Ç2a vsaka repna datoteka nosi markerja repni vhod + repni izhod in ≥2 široka klica', () => {
    for (const f of REPNE_DATOTEKE) {
      const src = read(f)
      expect(src).toContain('// v1.290.0 repni vhod')
      expect(src).toContain('// v1.290.0 repni izhod')
      const n = src.match(/sweepTestFixtures\(db, TEST_PREFIXES\)/g)?.length ?? 0
      expect(n).toBeGreaterThanOrEqual(2) // vhodni (beforeAll/setup) + izhodni (afterAll)
    }
  })

  test('Ç2b vseh 9 predpon repnih datotek registriranih v TEST_PREFIXES (vhodni klic jih vidi)', () => {
    for (const p of REPNE_PREDPONE) {
      expect(TEST_PREFIXES).toContain(p)
    }
  })

  test('Ç2c haccp-plans: vhodni klic ZNOTRAJ setup() (setupP teče ob uvozu modula — nov beforeAll bi pobrisal lastne fiksture)', () => {
    const src = read('tests/haccp-plans.test.ts')
    // edina repna datoteka brez beforeAll KLICA — široki klic je prva vrstica
    // setup(); omembe v komentarjih seštevajo v razlago, ne v klic
    expect(src).not.toContain('beforeAll(async')
    expect(src).toContain('async function setup() {\n  // v1.290.0 repni vhod')
    expect(src).toContain('const setupP = setup()')
  })

  test('Ç2d issue30: vhodni klic je NADGRADNJA ozkega [PREFIX, P37] (pin v289 Ç2b sledi trenutnemu stanju)', () => {
    const src = read('tests/issue30-37-ssrf-paylink-binding.test.ts')
    expect(src).toContain('sweepTestFixtures(db, TEST_PREFIXES)\n  process.env.FURS_ENVIRONMENT')
    expect(src).not.toContain('sweepTestFixtures(db, [PREFIX, P37])')
  })
})

// ── Ç3) MERILNE POGODBE VALA (rdeče izhodišče 107 → zeleni rep 0) ──────────
// v1.292.0: okno 15000→20000 (vzorec v289/v290) — vnos v1.292.0 (7088 znakov)
// je najzgodnejše pojave potisnil na ~13,9k; rezerva 1,1k je premajhna za
// naslednji vnos (~7k). Pini ostajajo na ISTEH nizih.

describe('v290 Ç3: merilne pogodbe (klasifikacija po teku)', () => {
  test('Ç3a rdeče izhodišče 107 predponskih vrstic zapisano z merjenimi številkami', () => {
    // v1.293.0: okno 20000 → 40000 — vnosa vala v1.293.0 (osnovni ~7,5k +
    // zaključek pusha ~3,9k = ~11,4k skupaj) potisneta Ç3 pine (najgloblji
    // @19203 + 11,4k ≈ 30,5k) čez 30000, ki je bil izračunan SAMO za osnovni
    // vnos — LEKCIJA: okenski proračun vala zajema OBA vnosa. Pini na ISTIH
    // nizih (vzorec v263→v278→v285).
    // v1.295.0: okno 40000 → 80000 preprečno (najgloblji v290 pin @21233 —
    // zaključni vnosi naslednjih valov bi ga potisnili čez; 3. pojavev
    // družine v v289/v291 istega dne) — proračun: OBA vnosa TEGA IN
    // NASLEDNJEGA vala (~25k skupaj) + rezervo (≈80k skupaj).
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('107 predponskih vrstic')
  })

  test('Ç3b pogodba rep suite po teku = 0 (vhod+izhod v 9 repnih datotekah)', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('rep suite po teku = 0')
  })

  test('Ç3c pogodba 0 mrtvih števcev po teku (nadaljevanje v1.289.0) zapisana', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('0 mrtvih števcev')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v290 Ž: registri', () => {
  test('verzija 1.297.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.297.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.297.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.297.0-obnova-12-reset-bun144-artefakti')
  })

  test('TEST_PREFIXES: 142 z v290- registrirano (v1.291.0 dodal v291-)', () => {
    expect(TEST_PREFIXES.includes(P)).toBe(true)
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena repa)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('RepniSirokiKlici')
    expect(read('prisma/schema.prisma')).not.toContain('RepniSirokiKlici')
  })
})

afterAll(async () => {
  const res = await sweepTestFixtures(db, [P])
  expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
})
