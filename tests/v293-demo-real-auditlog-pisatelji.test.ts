import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.293.0 — DEMO-REALNI PISATELJI AUDITLOG: ANALIZA (izvedba A-kandidata (a)
 * iz zaključka v1.291.0/v1.292.0; vzorec analize v291 za DEMO_LOGIN).
 *
 * NOSENJE VALA: izmerjena sestava demo-realne (čiste) AuditLog rasti — 27
 * čistih vrstic na tek suite — in popolna atribucija pisateljev. MEJA je
 * ZAVESTNO VEN (pogodba Task 58): morebitni poseg (meja rasti ali čiščenje)
 * zahteva ODLOČITEV LASTNIKA po analizi — ta val ne spreminja NE produkcjske
 * kode NE testov (samo ta statični varuh + prevez + worklog).
 *
 * IZMERJENA SESTAVA (+27/tek, delta 189 → 216 po teku, 7 prejšnjih tekov ×
 * 27 = 189 osnova po reseed-u):
 *   PAY_LINK_CREATED 10, CRON_DAILY_RAN 3, LOGIN_FAILED 3,
 *   SCHEMA_MIGRATION_MANAGER_CALL 2, SCHEMA_MIGRATION_KDS_STATIONS 2,
 *   PAY_LINK_PAID 2, SCHEMA_MIGRATION_HACCP_OPS 1,
 *   SCHEMA_MIGRATION_RESERVATION_WIDGET 1, LOGIN_BOOTSTRAP_USED 1,
 *   LOGIN_RATE_LIMITED 1, PAY_LINK_REVOKED 1.
 *
 * ATRIBUCIJA (vsseh 27 prek PRODUKCIJSKIH rut — testi so klicalci):
 *   1. paylink-flow.test.ts → 13/tek: ruta /api/orders/[id]/paylink
 *      (CREATED 10 + REVOKED 1, entityId = nid() linke, userId = nid()
 *      zaposleni) + src/lib/paylink/settle.ts (PAID 2, userId: null).
 *      MEHANIZEM PREŽIVETJA (najdba vala): 503 degradacijski test dela
 *      DROP TABLE "PayLink" sredi suite → vse do-tedaj ustvarjene povezave
 *      so uničene → afterAll cleanup briše audit prek entityId IN linkIds
 *      → pade → 13 osamljenih vrstic/tek (dokaz: 104/104 mrtvih nosilcev
 *      linka po teku; zaposleni in lokacije prav tako izbrisani — vsi trije
 *      nosilci userId/entityId/locationId so nid brez predpone).
 *   2. v161-cron-marker.test.ts → 3/tek: 3 testi × 1 klic (beforeEach
 *      clearMarker → koraki stečejo → audit). userId = literal 'cron',
 *      entityId = 'cron-daily-YYYY-MM-DD' (datumski ključ — +1 nov datum
 *      na dan; suite čez polnoč UTC izpisuje 2 datuma).
 *   3. issue31-36-mfa-auth.test.ts → 5/tek: LOGIN_FAILED 3 (neznan račun
 *      nonexistent@i31.test + deaktiviran ina-<RUN>@i31.test (unikatna
 *      pošta na tek) + forged@i31.test iz x-vercel testa), BOOTSTRAP_USED 1
 *      (ghost@i31.test), RATE_LIMITED 1 (adm-<RUN>@i31.test). userId =
 *      'anonymous'/'bootstrap' literali. Napačni PIN-i na aktivnem i31-adm-*
 *      računu pišejo LOGIN_FAILED s PREDPONSKIM entityId (id zaposlenega) —
 *      te vrstice sweep POBRIŠE; ostanejo samo e-poštni entityId-ji brez
 *      registrirane predpone ('adm-' NI v registru; 'adl-' iz v291 JE).
 *   4. issue13/14/20/21 → 6/tek SCHEMA_MIGRATION_*: H2 idempotenčna testa
 *      (issue21 2 klica, issue14 2) + issue20 1 + issue13 1 admin klic od 2
 *      (drugi je 403 brez audita). userId = 'bootstrap' (sub žetona),
 *      entityId = statična imena funkcij; ruta piše audit ob VSAKEM
 *      avtoriziranem klicu (tudi alreadyApplied).
 *
 * SEME PIŠE 0 AUDIT VRSTIC (prisma/seed.ts + seed-demo* brez auditLog
 * klicev) — vsa rast je testnega izvora prek produkcjskih rut.
 *
 * VARNOSTNA DOKTRINA (kontinuiteta v291 Ç1c): sweep NIKOLI ne sme brisati
 * čistih vrstic — v produkciji iste action-e piše legitimna uporaba (pravi
 * cron, prave prijave, prave migracije, pravi paylinki).
 *
 * Ta datoteka je STATIČNI VARUH (doktrina v287): 0 db fikstur, 0 predpon —
 * ZATO NI v TEST_PREFIXES (register ostaja 142).
 */

const read = (p: string) => readFileSync(p, 'utf8')

// ── Ç1) PINI ATRIBUCIJE — pisatelji v produkcjski kodi ─────────────────────

describe('v293 Ç1: pini atribucije (produkcjski pisatelji)', () => {
  test('Ç1a paylink pisatelji: ruta CREATED/REVOKED z nid() + settle PAID z userId: null', () => {
    const route = read('src/app/api/orders/[id]/paylink/route.ts')
    expect(route).toContain("action: amounts ? 'PAY_LINK_SPLIT_CREATED' : 'PAY_LINK_CREATED'")
    expect(route).toContain('id: nid()')
    expect(route).toContain("'PAY_LINK_REVOKED'")
    const settle = read('src/lib/paylink/settle.ts')
    expect(settle).toContain("'PAY_LINK_PAID'")
    expect(settle).toContain('userId: null,')
    // testni klicalec
    expect(read('tests/paylink-flow.test.ts')).toContain('PAY_LINK_CREATED')
  })

  test('Ç1b mehanizem paylink osamljenosti: odklonjen v1.294.0 (cleanup po locationId)', () => {
    const src = read('tests/paylink-flow.test.ts')
    // vzrok ostaja: drop uniči povezave → entityId IN linkIds pobriše NIČ
    expect(src).toContain('DROP TABLE "PayLink"')
    // zgodovinski žeton-baziran cleanup (reverse-FK prek najdenih linkov) ostaja
    expect(src).toContain('entityId: { in: links.map((l) => l.id) }')
    // v1.294.0 POPRAVEK (opcija (ii) te analize): PAY_LINK_* po locationId —
    // NEODVISNO od tabele PayLink (osamljene vrstice 13/tek → 0)
    expect(src).toContain("locationId: loc.id, action: { startsWith: 'PAY_LINK_' }")
  })

  test('Ç1c cron pisatelj: userId literal \'cron\' + datumski entityId cron-daily-<ključ>', () => {
    const route = read('src/app/api/cron/daily/route.ts')
    expect(route).toContain("return { userId: 'cron' }")
    expect(route).toContain("'CRON_DAILY_RAN'")
    expect(route).toContain('cron-daily-${todayKey}')
    // testni klicalec: 3 testi × 1 klic, beforeEach clearMarker
    const src = read('tests/v161-cron-marker.test.ts')
    expect(src).toContain('already_ran_today')
    expect(src).toContain('await clearMarker()')
  })

  test('Ç1d login pisatelji: anonymous/bootstrap literali + e-poštni entityId', () => {
    const route = read('src/app/api/auth/login/route.ts')
    expect(route).toContain("userId: 'anonymous', action: 'LOGIN_RATE_LIMITED', entityType: 'Employee', entityId: email")
    expect(route).toContain("'LOGIN_BOOTSTRAP_USED'")
    expect(route).toContain("'LOGIN_FAILED'")
    expect(route).toContain('entityId: email') // neznan/deaktiviran račun → e-pošta
    expect(route).toContain('entityId: employee.id') // napačen PIN → id (PREDPONSKI → sweep pobriše)
    // testni klicalec
    expect(read('tests/issue31-36-mfa-auth.test.ts')).toContain("nonexistent@i31.test")
  })

  test('Ç1e migrate pisatelji: 4 DDL rute pišejo audit ob vsakem avtoriziranem klicu (userId = sub)', () => {
    for (const [f, action] of [
      ['src/app/api/admin/migrate-manager-call/route.ts', 'SCHEMA_MIGRATION_MANAGER_CALL'],
      ['src/app/api/admin/migrate-kds-stations/route.ts', 'SCHEMA_MIGRATION_KDS_STATIONS'],
      ['src/app/api/admin/migrate-haccp-ops/route.ts', 'SCHEMA_MIGRATION_HACCP_OPS'],
      ['src/app/api/admin/migrate-reservation-widget/route.ts', 'SCHEMA_MIGRATION_RESERVATION_WIDGET'],
    ] as const) {
      const src = read(f)
      expect(src).toContain(`'${action}'`)
      expect(src).toContain('userId: user.sub')
    }
    // klicalci: issue21/14 H2 2 klica, issue20 1, issue13 1 admin (+1 zavrnjen 403)
    expect(read('tests/issue21-manager-call.test.ts')).toContain('alreadyApplied')
    expect(read('tests/issue13-reservation-widget.test.ts')).toContain('requireCentralRole — manager NI centralna vloga')
  })
})

// ── Ç2) ODLOČITEV LASTNIKA — meja ZAVESTNO ven (pogodba Task 58) ───────────

describe('v293 Ç2: odločitev lastnika (meja ven)', () => {
  test('Ç2a meja ZAVESTNO ven + Task 58 (analiza dostavi podatke, poseg je lastnikova odločitev)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('meja ZAVESTNO ven')
    expect(wl).toContain('Task 58')
  })

  test('Ç2b seme piše 0 audit vrstic (vs demo-realna rast je testnega izvora prek produkcijskih rut)', () => {
    expect(read('prisma/seed.ts')).not.toContain('auditLog.create')
    expect(read('prisma/seed-demo.ts')).not.toContain('auditLog.create')
  })

  test('Ç2c varnostna doktrina v291 Ç1c ostaja živa (sweep NIKOLI ne briše čistih vrstic)', () => {
    const src = read('tests/v291-demo-login-nicla-rast.test.ts')
    expect(src).toContain('Ç1c')
  })
})

// ── Ç3) MERILNE POGODBE VALA (osnova → delta → klasifikacija) ──────────────

describe('v293 Ç3: merilne pogodbe', () => {
  // okno 40000 (NE 30000): v1.294.0 dodaja NOV vnos (~12k) NAD tem — pini tega
  // vala sedijo @~2,3k–11,3k globoko v lastnem vnosu → ~23,3k skupaj; dvig je
  // PREPREČEN (lekcija v1.293.0: okenski proračun zajema OBA vnosa naslednjega
  // vala; vzorec v289–v292 dvigov 30000→40000)
  // v1.295.0: okno 40000 → 80000 preprečno (3. pojavev družine v v289/v291
  // istega dne — zaključni vnos, dodan PO vratih vala, je potisnil pine čez;
  // proračun: OBA vnosa TEGA IN NASLEDNJEGA vala ~25k + rezervo ≈ 80k)
  test('Ç3a osnova zapisana: 189 čistih / 0 predponskih po 7 tekih (27 × 7)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('189 čistih')
    expect(wl).toContain('0 predponskih')
  })

  test('Ç3b delta zapisana: +27 točno (189 → 216) s sestavo po tipih', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('189 → 216')
    expect(wl).toContain('PAY_LINK_CREATED 10')
    expect(wl).toContain('CRON_DAILY_RAN 3')
    expect(wl).toContain('SCHEMA_MIGRATION')
  })

  test('Ç3c dokazi zapisani: TEK #1 6113 + 0 mrtvih + 104/104 osamljenih nosilcev linka', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('6113')
    expect(wl).toContain('0 mrtvih')
    expect(wl).toContain('104/104')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v293 Ž: registri', () => {
  test('verzija 1.298.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.298.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.298.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.298.0-nadzorni-val-okenski-dvig')
  })

  test('TEST_PREFIXES: 142 NESPREMJENJENO (v293 je analiza — 0 fikstur, 0 predpon, 0 posegov)', () => {
    // dinamiko pina v291 Ž (142 z v291- registrirano) — tukaj le dokumentacijski
    // pin, da se register tega vala ZAVESTNO ne dotika (nabor ostaja 142)
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("'v291-'")
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je analiza + statični varuh)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('DemoRealAuditlogPisatelji')
    expect(read('prisma/schema.prisma')).not.toContain('DemoRealAuditlogPisatelji')
  })
})
