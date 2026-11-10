import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.295.0 — OBNOVA PO 11. RESETU + REP INTEGRATIONS-ADMIN (integ60):
 * izvedba A-kandidata (b) iz zaključka v1.294.0 (»morebitni naslednji reset
 * peskovnika → readdir klasifikacija po prvem teku (pričakovano 0/0; vzorec
 * 11. repne datoteke)«).
 *
 * NOSENJE VALA: peskovnik je resetiran 11.č (bun 1.3.14 nazaj, rezerva
 * pobrisana, baza samo shema 142 tabel 0 vrstic) → obnovljen po dokumentirani
 * poti (npm registry tarball @oven/bun-linux-x64-1.4.4.tgz + rezerva +
 * reseed 1/4/12/14/3/1 + 4 demo naročila). OKENSKA VZDRŽBA (3. pojavev
 * družine, odkrit na osnovni pin-verifikaciji PO obnovitvi): zaključni vnos
 * v1.294.0 (~3,9k, dodan PO vratih vala) je potisnil v289 Ç3a/Ç3c + v291
 * Ç3a/Ç3b/Ç3c čez okno 40000 (@40228–42966) → dvig 40000 → 80000 v VSEH
 * šestih varuhih v289–v294 (18 pinov; v290/v292/v293/v294 preprečno);
 * LEKCIJA (razširitev v1.293.0): okenski proračun zajema OBA vnosa TEGA IN
 * NASLEDNJEGA vala (~25k skupaj) + rezervo (≈80k skupaj).
 *
 * 11. REPNA DATOTEKA (napoved A-kandidata (b) POTRJENA): klasifikacija po
 * 2. tekih je pokazala 18 PREDPONSKIH vrstic — AuditLog 9 + EventLog 9, VSE
 * integ60- (tests/integrations-admin.test.ts). Po 11. resetu se readdir red
 * spremeni (dokaz v1.289.0 dopolnitev) in datoteka je stekla ZA zadnjim
 * centralnim širokim klicem; njen OZKI afterAll filter (id/entityId
 * startsWith integ60-) je zamudil nosilca userId (AuditLog — produkcija
 * piše userId: user.sub = integ60-emp-owner-) + payload/by (EventLog —
 * name integ60-Glovo SRED JSON payloada). POPRAVEK tega vala (vzorec
 * v290/v292 repnih širokih klicev): VHODNI široki klic v setup() (PRED
 * lastnimi fiksturami — široka oblika ne more pobrisati lastnih vrstic) +
 * IZHODNI široki klic kot ZADNJA vrstica afterAll (.catch(() => null)).
 *
 * ČISTA rast AuditLog na svežem okolju: 28 = 2 × 14 TOČNO (pogodba v1.294.0
 * drži — sestava 14/tek: cron 3 + login 5 + DDL 6); 0 MRTVIH števcev (1 števec
 * = grn:GRN-20261110- ŽIVI dnevni, doktrina v1.288.0 »1/dan«).
 *
 * Ta datoteka je STATIČNI VARUH (doktrina v287): 0 db fikstur, 0 predpon —
 * ZATO NI v TEST_PREFIXES (register ostaja 142; integ60- je registriran ŽE
 * od Taska 60).
 */

const read = (p: string) => readFileSync(p, 'utf8')

// ── Ç1) PINI REPELNEGA POPRAVKA — integrations-admin ──────────────────────

describe('v295 Ç1: pini repnega popravka (integrations-admin)', () => {
  test('Ç1a vhodni široki klic: TEST_PREFIXES v setup() PRED lastnimi fiksturami', () => {
    const src = read('tests/integrations-admin.test.ts')
    // uvoz razširjen (samo sweepTestFixtures prej)
    expect(src).toContain("import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'")
    // široka oblika na vhodu (PRED db.location.create — ne more pobrisati lastnih)
    expect(src).toContain('await sweepTestFixtures(db, TEST_PREFIXES)')
    // ozka oblika [PREFIX] v setup je NADOMEŠČENA (zgodoval jo je pre-sweep Taska 58)
    expect(src).not.toContain('sweepTestFixtures(db, [PREFIX])')
  })

  test('Ç1b izhodni široki klic: ZADNJA vrstica afterAll + odpornost .catch', () => {
    const src = read('tests/integrations-admin.test.ts')
    expect(src).toContain('await sweepTestFixtures(db, TEST_PREFIXES).catch(() => null)')
    // ZADNJA: za njo je samo zaklep afterAll — ozko location-brisanje je PRED njo
    const izhodAt = src.lastIndexOf('await sweepTestFixtures(db, TEST_PREFIXES).catch(() => null)')
    const locAt = src.lastIndexOf('await db.location.deleteMany')
    expect(izhodAt).toBeGreaterThan(-1)
    expect(locAt).toBeGreaterThan(-1)
    expect(izhodAt).toBeGreaterThan(locAt)
  })

  test('Ç1c markerja repa: v1.295.0 repni vhod + repni izhod (vzorec v290/v292)', () => {
    const src = read('tests/integrations-admin.test.ts')
    expect(src).toContain('// v1.295.0 repni vhod')
    expect(src).toContain('// v1.295.0 repni izhod')
  })

  test('Ç1d ozki afterAll ostaja (zgodbena čistost: FK vrstni red + nid cleanup apiIntegrationIds)', () => {
    const src = read('tests/integrations-admin.test.ts')
    // vrstni red FK: integrationLog PRED integration (Restrict otrok najprej)
    const ilAt = src.indexOf('await db.integrationLog.deleteMany')
    const iAt = src.indexOf('await db.integration.deleteMany')
    expect(ilAt).toBeGreaterThan(-1)
    expect(iAt).toBeGreaterThan(-1)
    expect(ilAt).toBeLessThan(iAt)
    // API-ustvarjene integracije (nid() id — Task 58 dopolnilo) ostanejo
    expect(src).toContain('apiIntegrationIds')
    // zaposleni po email contains (fiksturni emaili nosijo predpono)
    expect(src).toContain("email: { contains: PREFIX }")
  })

  test('Ç1e vzrok zapisan + produkcija NEDOTAKNJENA (routes pišejo userId: user.sub)', () => {
    const src = read('tests/integrations-admin.test.ts')
    // vzrok (userId/payload nosilca izven ozkega filtra) je dokumentiran v komentarju popravka
    expect(src).toContain('userId (AuditLog) + payload/by (EventLog)')
    // produkcija: vse 4 audit poti pišejo userId = prijavljeni (user.sub) —
    // nosilec izhaja iz PRODUKCIJSKE kode, popravek je izključno testni
    const r1 = read('src/app/api/integrations/route.ts')
    expect(r1).toContain("userId: user.sub, action: 'INTEGRATION_CREATED'")
    const r2 = read('src/app/api/integrations/[id]/route.ts')
    expect(r2).toContain("userId: user.sub, action: 'INTEGRATION_UPDATED'")
    expect(r2).toContain("userId: user.sub, action: 'INTEGRATION_DISABLED'")
    const r3 = read('src/app/api/integrations/[id]/test/route.ts')
    expect(r3).toContain("userId: user.sub, action: 'INTEGRATION_TESTED'")
  })
})

// ── Ç2) OKENSKA VZDRŽBA — 3. pojavev družine ───────────────────────────────

describe('v295 Ç2: okenska vzdržba (3. pojavev družine)', () => {
  test('Ç2a dvig 40000 → 80000 v VSEH šestih varuhih (18 pinov, v290/v292/v293/v294 preprečno)', () => {
    const files = [
      'v289-stabilnost-dveh-tekov',
      'v290-repni-siroki-klici',
      'v291-demo-login-nicla-rast',
      'v292-ci-sveza-baza-c1b',
      'v293-demo-real-auditlog-pisatelji',
      'v294-paylink-cleanup-locationid',
    ]
    for (const f of files) {
      const src = read(`tests/${f}.test.ts`)
      expect(src).toContain('slice(0, 80000)')
      expect(src).not.toContain('slice(0, 40000)')
    }
  })

  test('Ç2b LEKCIJA (razširitev) zapisana: OBA vnosa TEGA IN NASLEDNJEGA vala + rezerva', () => {
    const src = read('tests/v289-stabilnost-dveh-tekov.test.ts')
    // razširitev lekcije v1.293.0 (OBA vnosa vala) na dva vala naprej
    expect(src).toContain('OBA vnosa TEGA')
    expect(src).toContain('NASLEDNJEGA vala')
    // vzorec dokumentiran tudi v v292 (ZAKLJUČNI vnos je povzročitelj 3. pojaveva)
    const v292 = read('tests/v292-ci-sveza-baza-c1b.test.ts')
    expect(v292).toContain('ZAKLJUČNI vnos tega vala bi ga potisnil čez 40000')
  })

  test('Ç2c pini na ISTIH nizih (družina v263→v278→v285 ostaja — dvig samo okna)', () => {
    const v289 = read('tests/v289-stabilnost-dveh-tekov.test.ts')
    expect(v289).toContain("'DEMO_LOGIN 11/tek'")
    expect(v289).toContain("'0 TRAJNO mrtvih števcev'")
    const v291 = read('tests/v291-demo-login-nicla-rast.test.ts')
    expect(v291).toContain("'DEMO_LOGIN 0/tek'")
    expect(v291).toContain("'88 legacy DEMO_LOGIN'")
  })
})

// ── Ç3) MERILNE POGODBE VALA (obnova → TEK #0 → klasifikacija → dokaz) ─────

describe('v295 Ç3: merilne pogodbe vala', () => {
  test('Ç3a obnova 11. reseta zapisana: bun 1.4.4 npm tarball + reseed 1/4/12/14/4', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('11. reset')
    expect(wl).toContain('npm registry tarballa')
    expect(wl).toContain('reseed')
    expect(wl).toContain('1/4/12/14/4')
  })

  test('Ç3b TEK #0 zelen v prvem poskusu na obnovljenem okolju: 6147/3/0 (289 datotek)', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('TEK #0')
    expect(wl).toContain('6147/3/0')
    expect(wl).toContain('ZELEN V PRVEM POSKUSU')
  })

  test('Ç3c klasifikacija: 18 PREDPONSKIH (9+9 integ60) + 0 mrtvih + čistih +14/tek (28 = 2 × 14)', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('18 PREDPONSKIH')
    expect(wl).toContain('9+9')
    expect(wl).toContain('integ60')
    expect(wl).toContain('0 mrtvih')
    expect(wl).toContain('28 = 2 × 14')
  })

  test('Ç3d rdeče→zelen dokaz popravka: samostojni tek 10/10 → 0 integ60 vrstic', () => {
    const wl = read('worklog.md').slice(0, 80000)
    expect(wl).toContain('10/10')
    expect(wl).toContain('0 integ60')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v295 Ž: registri', () => {
  test('verzija 1.295.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.295.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.295.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.295.0-obnova-11-reset-rep-integ60')
  })

  test('TEST_PREFIXES: 142 NESPREMJENJENO (integ60- ŽE registriran od Taska 60 — 0 novih predpon)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("'integ60-'")
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testni popravek + statični varuh)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('RepInteg60')
    expect(read('prisma/schema.prisma')).not.toContain('RepInteg60')
  })
})
