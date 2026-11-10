import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.292.0 — CI SVEŽA BAZA Ç1b (okoljska odvisnost v290 Ç1b odstranjena;
 * vzorec v1.287.0 ci-sveza-baza za isti razred hrošča).
 *
 * ZGODBA: push treh valov po dobavi novega žetona (f9b3902 dopolnitev
 * v1.289.0 + 71b7743 v1.290.0 + f07c393 v1.291.0; prejšnji žeton ghp_O5gi…
 * je bil mrtev 3 vale — v290/v291 še NIKOLI nista bila izpostavljena CI-ju)
 * je padel na ENEM testu od 6098: v290 Ç1b je s strogo asercijo
 * toBeGreaterThan(0) zahteval semensko lokacijo (»dev seme«) — CI tests
 * job pa teče na sveži bazi (ci.yml: prisma db push na ci-fresh.db BREZ
 * db:seed). Lokalno (custom.db s seedom) je test tekel zeleno — okoljska
 * odvisnost, nevidna v peskovniku. Alarmni cikel v1.215.0 je odprl #125.
 *
 * POPRAVEK 1 (močnejši od vzorca v287 Č1d, ki je zadostil z before/after
 * invarianto 0→0): Ç1b dobi LASTNO realno lokacijo (id BREZ predpone —
 * čisti pogoj »realnosti«) → pogodba preživetja je dokazljiva POZITIVNO
 * na KATERI KOLI bazi (sveža CI 0→1, dev seme 1→2); invarianta
 * after = before + 1 dokaže hkrati preživetje lastne IN nedotaknjenost
 * semena/ostalih realnih. Try/finally higijena (LEKCIJA v1.286.0) +
 * začetni deleteMany samo-zdravljenje.
 *
 * POPRAVEK 2 (rep po 9. resetu — izvedba A-kandidata (b) iz v1.291.0):
 * klasifikacija po KONČNEM TEKU #1 je pokazala 5 predponskih vrstic (vsse
 * afx-: AuditLog userId WASTE_RECORD, 2× InventoryItem id, EventLog
 * entityId StockChanged, StockTransaction FK) — audit-fixes.test.ts je
 * 10. repna datoteka: readdir red se s 9. resetom spremeni in datoteka
 * je stekla ZA zadnjim centralnim širokim klicem; njen ročni afterAll
 * zamuja EventLog + AuditLog-userId (entityId = nid wasteRecorda) + FK
 * .catch(()=>null) pogoltne zavrnitev (StockTransaction drži item).
 * POSEG po vzorcu v290: vhodni široki klic (setupP: [PREFIX] →
 * TEST_PREFIXES) + izhodni široki klic (konec afterAll).
 *
 * Ta datoteka je STATIČNI VARUH (doktrina v287): okoljsko odvisne
 * asercije v CI ni mogoče odkriti drugače kot s padcem celotnega zagona —
 * pini tu so cenejši (vidni v vsakem lokalnem teku). Datoteka NE ustvarja
 * db fikstur (0 vrstic, 0 predpon) — zato NI v TEST_PREFIXES (142 ostaja).
 */

const read = (p: string) => readFileSync(p, 'utf8')

// ── Ç1) PINI POPRAVKA — v290 Ç1b okoljsko neodvisen ───────────────────────

describe('v292 Ç1: pini popravka (v290 Ç1b)', () => {
  test('Ç1a lastna realna lokacija brez predpone (dokaz preživetja na kateri koli bazi)', () => {
    const src = read('tests/v290-repni-siroki-klici.test.ts')
    expect(src).toContain("const realId = 'real-loc-c1b-v290'")
    expect(src).toContain("name: 'Realna lokacija Ç1b'")
  })

  test('Ç1b invarianta before + 1 (preživetje lastne + nedotaknjenost semena hkrati)', () => {
    const src = read('tests/v290-repni-siroki-klici.test.ts')
    expect(src).toContain('expect(after).toBe(before + 1)')
    // pozitiven dokaz: vrstica OBSTOJI po sweepu (ne samo številčna aritmetika)
    expect(src).toContain('findUnique({ where: { id: realId } })')
  })

  test('Ç1c higiena: try/finally + samo-zdravljenje (LEKCIJA v1.286.0)', () => {
    const src = read('tests/v290-repni-siroki-klici.test.ts')
    expect(src).toContain('} finally {')
    expect(src).toContain('higiena lastne fiksture')
    expect(src).toContain('samo-zdravljenje')
  })

  test('Ç1d regresijski varuh: okoljsko odvisna asercija je ODSTRANJENA (vzrok CI padca @ f07c393)', () => {
    const src = read('tests/v290-repni-siroki-klici.test.ts')
    // vzorec v287 Č2 (not.toContain toBe(1)): izvršljiva oblika ne sme obstajati
    // ( zgodovinski citat v komentarju je dovoljen — pin cilja izvršljivo vrstico )
    expect(src).not.toContain('expect(after).toBeGreaterThan(0)')
  })

  test('Ç1e audit-fixes (10. repna datoteka po 9. resetu): vhodni ŠIROKI klic v setupP (TEST_PREFIXES ⊇ afx-)', () => {
    const src = read('tests/audit-fixes.test.ts')
    expect(src).toContain('// v1.292.0 repni vhod')
    expect(src).toContain('await sweepTestFixtures(db, TEST_PREFIXES)')
    // ozka oblika v tej datoteki ne sme več obstajati (nadmgradnja, vzorec v290)
    expect(src).not.toContain('sweepTestFixtures(db, [PREFIX])')
  })

  test('Ç1f audit-fixes: izhodni ŠIROKI klic na koncu afterAll (počisti EventLog/AuditLog-userId/FK-zavrnjene)', () => {
    const src = read('tests/audit-fixes.test.ts')
    expect(src).toContain('// v1.292.0 repni izhod')
    // izhodni klic mora biti ZADNJA vrstica afterAll (za ročnimi FK brisanji)
    const afterAllBody = src.slice(src.indexOf('afterAll(async () => {'), src.indexOf('const setupP'))
    expect(afterAllBody.trimEnd().endsWith('await sweepTestFixtures(db, TEST_PREFIXES)\n})')).toBe(true)
  })
})

// ── Ç2) OKOLJSKA POGODBA — CI sveža baza (pogodba, na kateri počiva popravek) ─

describe('v292 Ç2: okoljska pogodba (CI sveža baza)', () => {
  test('CI tests job teče na sveži bazi BREZ semena (0 db:seed korakov v ci.yml)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('DATABASE_URL: file:./db/ci-fresh.db')
    expect(ci).toContain('bunx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate')
    expect(ci).not.toContain('db:seed')
  })

  test('sweep58 vzorec ostaja živ (pogojna invarianta za sveže baze v fixture-sweep.test.ts)', () => {
    const src = read('tests/fixture-sweep.test.ts')
    expect(src).toContain('CI sveža baza brez realnih lokacij')
  })

  test('v287 varuh ostaja živ (predhodni popravek istega razreda — dokumentirana kontinuiteta)', () => {
    const src = read('tests/v287-ci-sveza-baza.test.ts')
    expect(src).toContain('v1.287.0 — CI SVEŽA BAZA')
  })
})

// ── Ç3) MERILNE POGODBE VALA (rdeče izhodišče → zeleni dokaz) ─────────────

describe('v292 Ç3: merilne pogodbe (klasifikacija po teku)', () => {
  // v1.293.0: okno 20000 → 40000 — vnosa vala v1.293.0 (~11,4k skupaj: osnovni
  // + zaključek pusha) potisneta najgloblji v292 pin (@9541 + 11,4k ≈ 20,9k)
  // čez 20000; LEKCIJA v1.293.0: okenski proračun zajema OBA vnosa vala. Pini
  // na ISTIH nizih (vzorec v263→v278→v285).
  // v1.295.0: okno 40000 → 80000 preprečno (najgloblji v292 pin @29939 —
  // ZAKLJUČNI vnos tega vala bi ga potisnil čez 40000, točno vzorec
  // v289/v291 istega dne) — proračun: OBA vnosa TEGA IN NASLEDNJEGA vala
  // (~25k skupaj) + rezervo (≈80k skupaj).
  test('Ç3a rdeče izhodišče zapisano: CI padec 6097/1/6098 @ f07c393 + alarm #125', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('6097/1/6098')
    expect(wl).toContain('#125')
  })

  test('Ç3b zeleni dokaz zapisan: 15/15 na sveži (CI pogoj) IN 15/15 na sejani (dev pogoj)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('15/15')
    expect(wl).toContain('0 → 1')
  })

  test('Ç3c samo-zdravljenje baze zapisano (higijena po teku — seme nedotaknjeno)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('higijena')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v292 Ž: registri', () => {
  test('verzija 1.305.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.305.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.305.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.305.0-nadzorni-val-stabilnosti-vi')
  })

  test('TEST_PREFIXES: 142 NESPREMJENJENO (v292 je statični varuh — 0 fikstur, 0 predpon, vzorec v287)', () => {
    // dinamiko pina v290 Ž (142 z v290- registrirano) — tukaj le dokumentacijski
    // pin, da se register tega vala ZAVESTNO ne dotika (nabor ostaja 142)
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("'v291-'")
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena CI-ja)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('CiSvezaBazaC1b')
    expect(read('prisma/schema.prisma')).not.toContain('CiSvezaBazaC1b')
  })
})
