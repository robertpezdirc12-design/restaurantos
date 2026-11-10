import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES, type SweepResult } from './helpers/fixture-sweep'

/**
 * v1.283.0 — REGISTRACIJA TESTNIH PREDPON + SWEEP POKRITJE (AUDIT + ENTERPRISE).
 *
 * Izveden A-kandidat iz zaključka v1.282.0 (»registracija 50 preostalih
 * neregistriranih testnih predpon v TEST_PREFIXES z merjeno presojo učinka«).
 * Poštena meritev na živi post-suite bazi je razkrila TRISLOJNO sliko:
 *
 * (1) REGISTRACIJSKA VRZEL: 137 definiranih predpon, 90 registriranih →
 *     centralni samoceljiv sweep (fixture-sweep.test.ts: TEST_PREFIXES) je
 *     čistil samo registrirane. 16 od 50 neregistriranih je PUŠČALO OSTATKE
 *     PO ZELENIH tekih (ne le ob crashu!): afx- (EventLog/InventoryItem/
 *     StockTransaction — ročni afterAll zamudi eventLog + FK .catch(()=>null)
 *     pogoltne napako), clnfx-/i26-/i73a-/v220-/v224-/v247-/v252- (AuditLog),
 *     i30-/v240- (EventLog + AuditLog), i38-/i5-/i52- (enterprise drevo),
 *     v161- (cela lokacija — afterAll je ne briše), v221- (LoyaltyAccount).
 *     Preostalih 29 neregistriranih se samočisti (lastni sweep v afterAll),
 *     a ob crashu pred afterAll ostanejo — registracija da centralnemu
 *     sweepu priložnost počistiti jih na naslednjem teku suite (namen
 *     Task 58: »kill po timeoutu, garblirana generacija«).
 *
 * (2) VRZEL TABELE AuditLog: NI bil v LOCATION_CHILD_SWEEP (eventLog je bil,
 *     auditLog ne — asimetrija). locationId je SKALAR brez FK → brisanje
 *     testne lokacije ga ne počisti. Izmerjeno: AuditLog vrstice z ŽE
 *     REGISTRIRANIMI predponami (v248-/i20-/v242-) so preživele zelene teke.
 *
 * (3) VRZEL TABELE enterprise: Organization/Brand/Property niso bile v
 *     ID_SWEEP (samo FIELD_SWEEP po name/slug). Testi i5/i38/i52 ustvarjajo
 *     drevo z id-predpono in imeni BREZ predpone (»I38 Org A«, »PA«) →
 *     FIELD_SWEEP jih ne vidi. Izmerjeno: 18 osirotelih vrstic (6×3).
 *
 * ZAVESTNO ODLOŽENO (0 kode tukaj): (a) 4 predpone BREZ DB (c15-/c23-/
 * v168-/v215- — CI/log datoteke brez db uvoza; registracija = mrtva teža v
 * OR-seznamih), (b) zst63 (const brez pomišljaja; vrstice nosijo 'zst63-…',
 * ki je ŽE registriran), (c) nid()-id lokacije s predpono v imenu (izmerjena
 * 'i23-Nova' — potreben bi bil location FIELD_SWEEP po name, ločena vrzel),
 * (d) Workstation→Property Restrict FK (izmerjeno 0 vrstic — če ga prihodnji
 * val zapiše, gre PRED property v ID_SWEEP).
 */

const P = 'v283-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** 45 novih predpon (44 s pomišljajem + v206 brez — hex-varnost spodaj). */
const NOVE = [
  'afx-', // audit-fixes — izmerjeno: EventLog/InventoryItem/StockTransaction ostanki po zelenih tekih
  'clnfx-', // cleaner-role — izmerjeno: AuditLog ostanek
  'i26-', // issue26-giftcard-tenant — izmerjeno: AuditLog ostanek
  'i29-', // issue29-device-enroll — self-sweep; centralna varovalka ob crashu
  'i30-', // issue30-37-ssrf — izmerjeno: EventLog+AuditLog ostanki (ročni afterAll brez sweepa)
  'i31-', // issue31-36-mfa — self-sweep; centralna varovalka
  'i38-', // issue38-event-tenant — izmerjeno: enterprise drevo ostanki
  'i5-', // issue5-authorization — izmerjeno: enterprise drevo ostanki
  'i52-', // issue52-55-58-59-inventory — izmerjeno: enterprise drevo ostanki
  'i73a-', // issue73-audit15 — izmerjeno: AuditLog ostanek
  'i75fx-', // issue75-security — self-sweep; centralna varovalka
  'p086fx-', // menu-86-board — self-sweep; centralna varovalka
  'sweep58-', // fixture-sweep lastna — samočistilna datoteka, registracija za konsistentnost
  'v161-', // v161-cron-marker — izmerjeno: cela lokacija ostane (afterAll je ne briše)
  'v167-', // v167-digest-dedupe — ročni afterAll brez sweepa; ScheduledEmailLog vzorec
  'v185-', // v185-split-guests — self-sweep; centralna varovalka
  'v192ps-', // v192-payroll-surcharges — self-sweep; centralna varovalka
  'v193-', // v193-seats — self-sweep; centralna varovalka
  'v195-', // v195-order-seats — self-sweep; centralna varovalka
  'v196ec-', // v196-expense-category — self-sweep; centralna varovalka
  'v197ps-', // v197-payroll-rates — self-sweep; centralna varovalka
  'v200eq-', // v200-equipment — self-sweep; centralna varovalka
  'v202ean-', // v202-ean-receiving — self-sweep; centralna varovalka
  'v203doc-', // v203-documents — self-sweep; centralna varovalka
  'v204h-', // v204-order-hold — self-sweep; centralna varovalka
  'v205c-', // v205-crm-whatsapp — self-sweep; centralna varovalka
  'v206', // v206-hourly-email — BREZ pomišljaja (vrstice: v206loc-/v206ord-/v206rc-); nid() je samo hex, 'v' ni hex → nikoli ne more biti predpona realnega id-ja
  'v210v-', // v210-pos-variants — self-sweep; centralna varovalka
  'v219-', // v219-qa-hardening — self-sweep; centralna varovalka
  'v220-', // v220-qa-user-wave — izmerjeno: AuditLog ostanek
  'v221-', // v221-qa-loyalty-gc — izmerjeno: LoyaltyAccount ostanek
  'v224-', // v224-qa-promo — izmerjeno: AuditLog ostanek
  'v226-', // v226-qa-coupon — self-sweep; centralna varovalka
  'v230fx-', // v230-auto86 — self-sweep; centralna varovalka
  'v237-', // v237-kds-modifiers — self-sweep; centralna varovalka
  'v238-', // v238-money-integrity — self-sweep; centralna varovalka
  'v239-', // v239-receipt-cell — self-sweep; centralna varovalka
  'v2391-', // v239-1-receipt-snapshot — self-sweep; centralna varovalka
  'v240-', // v240-reservation-cell — izmerjeno: EventLog+AuditLog ostanki
  'v247-', // v247-pogledi — izmerjeno: AuditLog ostanek
  'v249-', // v249-cenovni — self-sweep; centralna varovalka
  'v250-', // v250-tempo — self-sweep; centralna varovalka
  'v251-', // v251-crtna-koda — self-sweep; centralna varovalka
  'v252-', // v252-avtododelitev — izmerjeno: AuditLog ostanek
  'v253-', // v253-odprti-racuni — self-sweep; centralna varovalka
] as const

/** 4 predpone brez DB (CI/log datoteke, 0 db uvoza) — zavestno NE registrirane. */
const BREZ_DB = ['c15-', 'c23-', 'v168-', 'v215-'] as const

/** Modeli, ki jih ta val čisti — errors teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(auditLog|location|organization|brand|property|eventLog|inventoryItem):/

// ── Č1) VEDENJE — tri izmerjene vrzeli, vsaka izolirana ───────────────────

describe('v283 Č1: sweep pobira tri izmerjene vrzeli', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Č1a AuditLog: nid() id + predponski locationId (REGISTRIRANA v248-) → lokacijski prehod', async () => {
    // IZOLACIJA VRZELI TABELE (ne registracije): v248- je registriran od v1.282.0,
    // a AuditLog ni bil v LOCATION_CHILD_SWEEP — izmerjeno na živi bazi: vrstice
    // v248-/i20-/v242- so preživele zelene teke (eventLog pokrit, auditLog ne).
    const locId = `v248-loc-v283sim-${RUN}`
    await db.location.create({ data: { id: locId, name: `v283 Sim A ${RUN}`, code: `V283A${RUN.toUpperCase()}` } })
    await db.auditLog.create({
      data: {
        id: `a${RUN}sim1`, locationId: locId, action: 'SIM_V283',
        entityType: 'test', entityId: `e${RUN}sim1`,
      },
    })
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.auditLog.count({ where: { id: `a${RUN}sim1` } })).toBe(0)
    expect(await db.location.count({ where: { id: locId } })).toBe(0)
  }, 60_000)

  test('Č1b enterprise: id-predponski org/brand/property z imeni BREZ predpone (REGISTRIRANA v282-) → ID_SWEEP', async () => {
    // IZOLACIJA VRZELI TABELE: v282- je registriran od v1.282.0, a drevo ni bilo
    // v ID_SWEEP — FIELD_SWEEP po name vidi samo vrstice s predpono v imenu;
    // testi i5/i38/i52 pišejo id-predpono in ime BREZ nje (»I38 Org A«, »PA«).
    const orgId = `v282-org-v283sim-${RUN}`
    const brandId = `v282-brand-v283sim-${RUN}`
    const propId = `v282-prop-v283sim-${RUN}`
    await db.organization.create({ data: { id: orgId, name: `Sim Org ${RUN}`, slug: `sim283org${RUN}` } })
    await db.brand.create({ data: { id: brandId, organizationId: orgId, name: `Sim Brand ${RUN}` } })
    await db.property.create({ data: { id: propId, brandId, name: `Sim Prop ${RUN}` } })
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.organization.count({ where: { id: orgId } })).toBe(0)
    expect(await db.brand.count({ where: { id: brandId } })).toBe(0)
    expect(await db.property.count({ where: { id: propId } })).toBe(0)
  }, 60_000)

  test('Č1c simulacija crasha: vrstice novih predpon (v161-/afx-/i30-) pobere CENTRALNI sweep', async () => {
    // IZOLACIJA REGISTRACIJSKE VRZELI: predpone do tega vala NISO bile v
    // TEST_PREFIXES → centralni sweep jih ni videl (lastni sweep datoteke
    // pomaga samo, če TA datoteka znova teče — scenarij Task 58: kill pred
    // afterAll). Vzorec izmerjenih ostankov: v161- cela lokacija, afx-
    // InventoryItem + EventLog (entityId predpona), i30- EventLog (nid id +
    // predponski locationId).
    const locId = `v161-loc-v283sim-${RUN}`
    await db.location.create({ data: { id: locId, name: `v283 Sim C ${RUN}`, code: `V283C${RUN.toUpperCase()}` } })
    await db.inventoryItem.create({ data: { id: `afx-item-v283sim-${RUN}`, name: `Sim artikel ${RUN}` } })
    await db.eventLog.create({ data: { id: `ev${RUN}sim`, type: 'SIM_V283', entityId: `afx-item-v283sim-${RUN}`, locationId: locId } })
    await db.eventLog.create({ data: { id: `ei${RUN}sim`, type: 'SIM_V283', locationId: `i30-loc-v283sim-${RUN}` } })
    const res: SweepResult = await sweepTestFixtures(db, TEST_PREFIXES)
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.location.count({ where: { id: locId } })).toBe(0)
    expect(await db.inventoryItem.count({ where: { id: `afx-item-v283sim-${RUN}` } })).toBe(0)
    expect(await db.eventLog.count({ where: { id: { in: [`ev${RUN}sim`, `ei${RUN}sim`] } } })).toBe(0)
    expect(res.remainingLocations).toBe(0)
  }, 60_000)

  test('Č1d zvestoba: nid() transakcija z loyaltyAccountId predpono NE sme zakleniti računa (vzorec v221, izmerjeno v živi bazi)', async () => {
    // IZOLACIJA VRZELI FK: aplikacijska pot zvestobe piše nid() id transakciji,
    // predpona živi SAMO v loyaltyAccountId → ID_SWEEP po id je ni videl, FK
    // (Restrict) pa je blokiral izbris računa — živi dokaz: v221-la-… je preživela
    // TRI centralne sweep (v1.283.0 pred alt popravkom). Vzorec stockTransaction/
    // inventoryItemId (i8): alt prehod po loyaltyAccountId PRED računom.
    const accId = `v283-la-${RUN}`
    await db.loyaltyAccount.create({ data: { id: accId, customerName: `Sim Gost ${RUN}`, pointsBalance: 10 } })
    await db.loyaltyTransaction.create({
      data: { id: `lt${RUN}sim`, loyaltyAccountId: accId, type: 'earn', points: 10, reason: 'SIM_V283' },
    })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => /^(loyaltyTransaction|loyaltyAccount):/.test(e))).toEqual([])
    expect(await db.loyaltyTransaction.count({ where: { id: `lt${RUN}sim` } })).toBe(0)
    expect(await db.loyaltyAccount.count({ where: { id: accId } })).toBe(0)
  }, 60_000)
})

// ── Č2) PINI — statične varovalke registracije + pokritja ─────────────────

describe('v283 Č2: pini registracije + pokritja', () => {
  test('vseh 45 novih predpon je registriranih v TEST_PREFIXES', () => {
    for (const p of NOVE) expect(TEST_PREFIXES, p).toContain(p)
  })

  test('TEST_PREFIXES = 136 vnosov (90 pred v1.283.0 + 45 tja + v284- lokacije po imenu)', () => {
    // v1.284.0: registracija v284- (sweep nid()-id lokacij s predponskim imenom)
    // dvigne register na 136 — pin sledi TRENUTNEMU stanju (vzorec worklog-vrh).
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('hex-varnost: predpona BREZ pomišljaja mora vsebovati znak izven [0-9a-f] (nid() = samo hex → ne more biti predpona realnega id-ja)', () => {
    // nid() = randomUUID().replace(/-/g,'').slice(0,25) — SAMO [0-9a-f]. Pomišljaja
    // ne vsebuje nikoli → predpone s končnim '-' so varne PO DEFINICIJI; predpone
    // brez njega (v206/stockded/zrepvat/furspost) so varne LE, če nosijo vsaj en
    // ne-hex znak. Ta pin varuje prihodnje registracije pred tiho pastjo.
    for (const p of TEST_PREFIXES) {
      if (p.endsWith('-')) continue
      expect(p, p).toMatch(/[^0-9a-f]/)
    }
  })

  test('auditLog je v LOCATION_CHILD_SWEEP (skalar locationId brez FK — vzorec managerCall/stationTask)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const lcStart = src.indexOf('const LOCATION_CHILD_SWEEP = [')
    const lcEnd = src.indexOf('] as const', lcStart)
    const block = src.slice(lcStart, lcEnd)
    expect(block).toMatch(/^ {2}'auditLog',$/m)
  })

  test('enterprise drevo v ID_SWEEP, vrstni red property → brand → organization (Restrict FK otroci→starši), pred lokacijo', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const iProp = src.indexOf("{ model: 'property' }")
    const iBrand = src.indexOf("{ model: 'brand' }")
    const iOrg = src.indexOf("{ model: 'organization' }")
    const iLoc = src.indexOf('// lokacija se briše ZADNJA')
    expect(iProp).toBeGreaterThan(-1)
    expect(iBrand).toBeGreaterThan(-1)
    expect(iOrg).toBeGreaterThan(-1)
    expect(iProp).toBeLessThan(iBrand)
    expect(iBrand).toBeLessThan(iOrg)
    expect(iOrg).toBeLessThan(iLoc)
  })

  test('loyaltyTransaction ima alt loyaltyAccountId (vzorec stockTransaction/inventoryItemId — nid() otrok FK Restrict)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'loyaltyTransaction', alt: 'loyaltyAccountId' }")
    // vrstni red: transakcija PRED računom (drugače bi Restrict FK zaklenil račun)
    expect(src.indexOf("{ model: 'loyaltyTransaction', alt: 'loyaltyAccountId' }")).toBeLessThan(
      src.indexOf("{ model: 'loyaltyAccount' }"),
    )
  })

  test('4 predpone BREZ DB niso registrirane (c15-/c23-/v168-/v215- — 0 db uvoza; registracija bi bila mrtva teža)', () => {
    for (const p of BREZ_DB) expect(TEST_PREFIXES, p).not.toContain(p)
  })
})

// ── Č3) TEŽA OR-SEZNAMA — merjeno, ne ugibano ─────────────────────────────

describe('v283 Č3: centralni sweep z 135 predponami (proračun + varnost realnih podatkov)', () => {
  test('en poln centralni sweep znotraj 30 s; realne lokacije nedotaknjene', async () => {
    const realBefore = (await db.location.findMany({ select: { id: true } }))
      .filter((l) => !TEST_PREFIXES.some((p) => l.id.startsWith(p))).length
    const t0 = Date.now()
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    const ms = Date.now() - t0
    console.log(`[v283] centralni sweep (135 predpon): ${ms} ms (izhodišče Task 58: ~3,2 s na pregled pri 64 predponah, 19. 10. 2026)`)
    expect(ms).toBeLessThan(30_000)
    expect(res.remainingLocations).toBe(0)
    const realAfter = (await db.location.findMany({ select: { id: true } }))
      .filter((l) => !TEST_PREFIXES.some((p) => l.id.startsWith(p))).length
    expect(realAfter).toBe(realBefore)
  }, 60_000)
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v283 Ž: registri', () => {
  test('verzija 1.308.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.308.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.308.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.308.0-nadzorni-val-stabilnosti-ix')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena + sweep pokritje)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('SweepRegistracija')
    expect(read('prisma/schema.prisma')).not.toContain('SweepRegistracija')
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
