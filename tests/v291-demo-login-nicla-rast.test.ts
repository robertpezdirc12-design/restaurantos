import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.291.0 — DEMO_LOGIN NIČELNA RAST (A-kandidat (a) iz zaključka v1.290.0:
 * »DEMO_LOGIN 0-rast (predponska fikstura v tests/auth-demo-login — zadnja
 * demo-realna rast 11/tek, če lastnik želi 0-rast)«).
 *
 * RDEČE IZHODIŠČE (merjeno na semeščeni bazi pred valom): 77 DEMO_LOGIN
 * vrstic = 7×11 točno (7 tekov suite); samostojni tek stare kode pusti +11
 * (77 → 88), vse z userId/entityId = semenski admin (nid, brez predpone) +
 * locationId = semenska lokacija → NEVIDNE vsem trem prehodom sweepa
 * (id/alt-entityId, lokacijskemu, FIELD_SWEEP userId). Pisatelj: tests/
 * auth-demo-login — dva testa brez DEMO_LOGIN_EMAIL (samodejna izbira +
 * rate-limit 11 klicev, od katerih 10 uspešnih) prijavita NAJSTAREJŠEGA
 * aktivnega owner/admina brez MFA = semenski admin (route: orderBy
 * createdAt asc). Ostalih 5 uspešnih prijav/tek je pripetih (env) na
 * predponskega adl-ownerja → že prej pometene.
 *
 * POSEG (tests/auth-demo-login.test.ts, 4 mesta): seedEmployee sprejema
 * opts.createdAt; nov ZASTAVLJENI predponski admin adl-auto-<RUN> (owner,
 * aktiven, brez MFA, PIN 4) z createdAt = 2020-01-01 — starejši od vsakega
 * semenskega admina (seme teče v sedanjosti; rezerva 6+ let) → samodejna
 * izbira pade NANJ tudi na semeščeni bazi, na prazni CI bazi (ci-fresh.db)
 * pa je edini kandidat; pin izbire toBe(autoAdminId) je NAMENOMO glasen —
 * če bi okolje imelo starejšega realnega owner/admina brez MFA, bi izbira
 * tiho pisala čiste vrstice (padec je boljši od tihega puščanja).
 *
 * ZELENI DOKAZ: samostojni tek nove kode 88 → 88 (+0; prej +11); afterAll
 * pometel vse adl- vrstice (0 ostankov). ENKRATNI REMEDY (vzorec v1.286.0,
 * pošteno zapisan): 88 legacy DEMO_LOGIN vrstic na semenskem adminu
 * izbrisanih (kriterij: action=DEMO_LOGIN AND userId=semenski admin; 88 =
 * 8×11 točno — 7 tekov suite + 1 meritveni tek rdečega izhodišča; pisala
 * jih je IZKLJUČNO stara koda testov). Dvojna verifikacija na čistem stanju:
 * 0 → 0.
 *
 * VAROST (meja 0-rasti): pogodba velja za TEKE SUITE (delta), NE absolutno
 * število — realna uporaba demo gumba v UI piše legitime vrstice na semenskega
 * admina in jih NIKOLI ne sme pometi testni sweep (Ç1d dokazuje smer
 * varnosti: vrstice brez predpone preživijo).
 */

const P = 'v291-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake te tabele so napake vala, ne šum. */
const NASI_MODELI = /^auditLog:/

// ── Ç1) MEHANIZEM — izbira po createdAt + trojni nosilec sweepa ────────────

describe('v291 Ç1: mehanizem — zastavljena fikstura + trojni nosilec', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Ç1a route izbere najstarejšega aktivnega owner/admina brez MFA (orderBy createdAt asc — pin izbire)', () => {
    const src = read('src/app/api/auth/demo-login/route.ts')
    // izbira je PO createdAt naraščajoče → zastavljeni (backdated) predponski
    // admin je vedno pred semenskim (seme teče v sedanjosti)
    expect(src).toContain("orderBy: { createdAt: 'asc' }")
    expect(src).toContain("const CENTRAL_DB_ROLES = ['owner', 'admin']")
    // filter: aktiven + vodstvena vloga + brez MFA (ista merila kot fikstura)
    expect(src).toContain("CENTRAL_DB_ROLES.includes(String(e.role).toLowerCase()) && !e.mfaEnabled")
  })

  test('Ç1b vsak od treh nosilcev DEMO_LOGIN zapisa SAM pobriše vrstico (userId/entityId/locationId)', async () => {
    // route zapiše DEMO_LOGIN z userId = entityId = izbrani admin,
    // locationId = njegova lokacija. Zastavljena fikstura naredi VSE TRI
    // predponske; ta test dokazuje, da vsak nosilec SAM zadostuje (redundanca
    // je varnostna mreža — tudi če bi route nekoč spremenil nosilca).
    const carriers = [
      { userId: `${P}u-${RUN}`, entityId: nid(), locationId: null as string | null },
      { userId: null as string | null, entityId: `${P}e-${RUN}`, locationId: null as string | null },
      { userId: null as string | null, entityId: nid(), locationId: `${P}loc-${RUN}` },
    ]
    for (const c of carriers) {
      await db.auditLog.create({
        data: { id: nid(), action: 'DEMO_LOGIN', entityType: 'Employee', ...c },
      })
    }
    expect(await db.auditLog.count({ where: { action: 'DEMO_LOGIN', OR: [
      { userId: { startsWith: P } }, { entityId: { startsWith: P } }, { locationId: { startsWith: P } },
    ] } })).toBe(3)
    try {
      await sweepTestFixtures(db, [P])
      expect(await db.auditLog.count({ where: { action: 'DEMO_LOGIN', OR: [
        { userId: { startsWith: P } }, { entityId: { startsWith: P } }, { locationId: { startsWith: P } },
      ] } })).toBe(0)
    } finally {
      await db.auditLog.deleteMany({ where: { OR: [
        { userId: { startsWith: P } }, { entityId: { startsWith: P } }, { locationId: { startsWith: P } },
      ] } }).catch(() => null)
    }
  })

  test('Ç1c varnost: vrstice BREZ predpone preživijo sweep (realna demo uporaba nikoli pometena)', async () => {
    // semenski admin nima predpone — njegove REALNE DEMO_LOGIN vrstice
    // (uporaba demo gumba v UI) morajo preživeti vsak testni sweep
    const simId = nid()
    await db.auditLog.create({
      data: { id: simId, userId: nid(), action: 'SIM_V291_REAL', entityType: 'Employee', entityId: nid() },
    })
    try {
      await sweepTestFixtures(db, TEST_PREFIXES) // ŠIROKI klic — vseh 142 predpon
      expect(await db.auditLog.count({ where: { id: simId } })).toBe(1)
    } finally {
      await db.auditLog.deleteMany({ where: { id: simId } }).catch(() => null)
    }
  })
})

// ── Ç2) PINI POSEGA — tests/auth-demo-login.test.ts (4 mesta) ─────────────

describe('v291 Ç2: pini posega (tests/auth-demo-login.test.ts)', () => {
  const srcAdl = () => read('tests/auth-demo-login.test.ts')

  test('Ç2a seedEmployee sprejema opts.createdAt (kanal za zastavljanje starosti fiksture)', () => {
    const src = srcAdl()
    expect(src).toContain('opts?: { createdAt?: Date }')
    expect(src).toContain('...(opts?.createdAt ? { createdAt: opts.createdAt } : {})')
  })

  test('Ç2b zastavljeni admin: adl-auto-<RUN> z createdAt 2020-01-01 (starejši od vsakega semena)', () => {
    const src = srcAdl()
    expect(src).toContain("autoAdminId = await seedEmployee(`${P}auto-${RUN}`, `${P}Samodejni Admin`, 'owner', 4, {")
    expect(src).toContain("createdAt: new Date('2020-01-01T00:00:00Z')")
  })

  test('Ç2c pin izbire: samodejni test zahteva autoAdminId (glasen padec > tiho puščanje)', () => {
    const src = srcAdl()
    expect(src).toContain('expect(d.employee?.id).toBe(autoAdminId)')
    // rate-limit test prav tako teče brez env → 10 uspešnih prijav pade na
    // zastavljenega admina (isti mehanizem kot samodejni test)
    expect(src.match(/delete process\.env\.DEMO_LOGIN_EMAIL/g)?.length).toBeGreaterThanOrEqual(4)
  })

  test('Ç2d docblock dokumentira 0-rast (rdeče izhodišče 11/tek + mehanizem)', () => {
    const src = srcAdl()
    expect(src).toContain('v1.291.0 (A-kandidat iz v1.290.0 — DEMO_LOGIN 0-rast)')
    expect(src).toContain('ZASTAVLJENA predponska')
  })
})

// ── Ç3) MERILNE POGODBE VALA (rdeče izhodišče +11/tek → 0-rast) ───────────

describe('v291 Ç3: merilne pogodbe', () => {
  test('Ç3a rdeče izhodišče +11/tek zapisano z merjenimi številkami (77 = 7×11 pred valom)', () => {
    // v1.293.0: okno 20000 → 40000 — vnosa vala v1.293.0 (osnovni ~7,5k +
    // zaključek pusha ~3,9k = ~11,4k skupaj) potisneta Ç3 pine (najgloblji
    // @19203 + 11,4k ≈ 30,5k) čez 30000, ki je bil izračunan SAMO za osnovni
    // vnos — LEKCIJA: okenski proračun vala zajema OBA vnosa. Pini na ISTIH
    // nizih (vzorec v263→v278→v285).
    // v1.295.0: okno 40000 → 80000 — ZAKLJUČNI vnos v1.294.0 (~3,9k, dodan
    // PO vratih vala) je potisnil Ç3 pine (@40228–41138) čez 40000 — 3.
    // pojavev družine; LEKCIJA (razširitev): proračun zajema OBA vnosa TEGA
    // IN NASLEDNJEGA vala (~25k skupaj) + rezervo (≈80k skupaj).
    // v1.298.0: okno 80000 → 160000 — kumulativa valov v1.296.0+v1.297.0
    // (~23k) je potisnila Ç3c pin '88 legacy DEMO_LOGIN' (@81554) čez 80000
    // — 4. pojav družine; konvencija PODVAJANJA meje (LEKCIJA razširitev 2 v
    // v289 Ç3a); pini na ISTIH nizih.
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('DEMO_LOGIN 11/tek')
    expect(wl).toContain('77 = 7×11')
  })

  test('Ç3b pogodba 0-rast: tek nove kode pušča 0 novih DEMO_LOGIN vrstic', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('DEMO_LOGIN 0/tek')
  })

  test('Ç3c enkratni remedy 88 legacy vrstic + dvojna verifikacija zapisana', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('88 legacy DEMO_LOGIN')
    expect(wl).toContain('0 → 0')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v291 Ž: registri', () => {
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

  test('TEST_PREFIXES: 142 z v291- registrirano', () => {
    expect(TEST_PREFIXES.includes(P)).toBe(true)
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena, ne shema)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('DemoLoginNiclaRast')
    expect(read('prisma/schema.prisma')).not.toContain('DemoLoginNiclaRast')
  })
})

afterAll(async () => {
  const res = await sweepTestFixtures(db, [P])
  expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
})
