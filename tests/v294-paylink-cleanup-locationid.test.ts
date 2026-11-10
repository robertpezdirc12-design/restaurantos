import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.294.0 — PAYLINK CLEANUP PO LOKACIJI: odklon osamljenosti AuditLog vrstic
 * (izvedba opcije (ii) iz analize v1.293.0 — "popravek paylink osamljenosti
 * (cleanup po locationId/userId → rast 14/tek); A-kandidat naslednjega vala").
 *
 * NOSENJE VALA: 503 degradacijski test v tests/paylink-flow.test.ts sredi suite
 * dela DROP TABLE "PayLink" → vsi do-tedaj ustvarjeni linki so uničeni →
 * afterAll cleanup `auditLog.deleteMany({ entityId: { in: links.map(…) } })`
 * dobi PRAZNO množico → 13 osamljenih PAY_LINK_* vrstic/tek je ostalo (izmerjeno
 * v1.293.0: 104/104 mrtvih nosilcev linka po teku, 0 živih; vsi trije nosilci
 * userId/entityId/locationId so nid() brez predpone — zato jih sweep NI smel
 * pobrisati, doktrina v291 Ç1c). POPRAVEK tega vala: cleanupFixtures briše
 * PAY_LINK_* vrstice FIKSTURNE lokacije po `locationId` (stolpec AuditLog) —
 * NEODVISNO od tabele PayLink in njenih id-jev. Pričakovana rast suite:
 * 27 čistih/tek → 14 čistih/tek (paylink del 13 → 0; cron 3 + login 5 + DDL 6
 * ostanejo — meja preostanka je ZAVESTNO ven, pogodba Task 58).
 *
 * VARNOSTNA DOKTRINA (kontinuiteta v291 Ç1c): brisanje je OMEJENO na lokacijo
 * LASTNE fiksture (loc.id iz findMany po predponi plnk-) + akcije z začetkom
 * 'PAY_LINK_' — vse iz PRODUKCIJSKIH pisateljev (CREATED/SPLIT_CREATED/
 * REVOKED/PAID/SHARE_PAID/STRIPE_REVIEW pišejo locationId: order.locationId);
 * tuje in čiste vrstice ostanejo NEDOTAKNJENE. Sweep (fixture-sweep.ts) se NI
 * dotaknjen — 0 produkcjske kode, 0 testnih fikstur, 0 DDL.
 *
 * Ta datoteka je STATIČNI VARUH (doktrina v287): 0 db fikstur, 0 predpon —
 * ZATO NI v TEST_PREFIXES (register ostaja 142).
 */

const read = (p: string) => readFileSync(p, 'utf8')

// ── Ç1) PINI POPRAVKA — pripis in neodvisnost ─────────────────────────────

describe('v294 Ç1: pini popravka (cleanup po locationId)', () => {
  test('Ç1a cleanup vrstica: PAY_LINK_* po locationId + startsWith, odporna na padec tabele', () => {
    const src = read('tests/paylink-flow.test.ts')
    // točna oblika filtra (OMEJEN where — lokacija fiksture + PAY_LINK_ akcije)
    expect(src).toContain("{ locationId: loc.id, action: { startsWith: 'PAY_LINK_' } }")
    // odpornost: brisanje je .catch(() => null) — padec (npr. tabela še ni
    // obnovljena v vzporednem workerju) ne ubije celotnega afterAll
    expect(src).toContain("action: { startsWith: 'PAY_LINK_' } } }).catch(() => null)")
  })

  test('Ç1b NEODVISNOST: locationId-brisanje teče PRED payLink.findMany (drop-safe vrstni red)', () => {
    const src = read('tests/paylink-flow.test.ts')
    const at = src.indexOf("{ locationId: loc.id, action: { startsWith: 'PAY_LINK_' } }")
    const linksAt = src.indexOf('const links = await db.payLink.findMany')
    expect(at).toBeGreaterThan(-1)
    expect(linksAt).toBeGreaterThan(-1)
    // PRED: tudi če findGiven pade/vrne prazno (DROP TABLE sredi suite),
    // PAY_LINK_* po lokaciji je ŽE pobrisano
    expect(at).toBeLessThan(linksAt)
  })

  test('Ç1c vzrok ostaja nedotaknjen: DROP TABLE + zgodovinski entityId-cleanup', () => {
    const src = read('tests/paylink-flow.test.ts')
    // degradacijski test (vzrok osamljenosti) ostaja — semantika 503/404 nespremenjena
    expect(src).toContain('DROP TABLE "PayLink"')
    // zgodovinski žeton-baziran cleanup ostaja (pobriše ŽIVE linke, če drop ni padel)
    expect(src).toContain('entityId: { in: links.map((l) => l.id) }')
  })

  test('Ç1d produkcija nedotaknjena: vsi PAY_LINK_* pisatelji pišejo locationId (route 3×, settle 2× + args 1×)', () => {
    const route = read('src/app/api/orders/[id]/paylink/route.ts')
    const settle = read('src/lib/paylink/settle.ts')
    // route: 1× payLink.create (zapis povezave nosi lokacijo) + 2× audit
    // (CREATED/SPLIT_CREATED + REVOKED) — vse pripisano lokaciji naročila
    expect(route.split('locationId: order.locationId').length - 1).toBe(3)
    // settle: SHARE_PAID + PAID (2× audit z order.locationId)
    expect(settle.split('locationId: order.locationId').length - 1).toBe(2)
    // settle STRIPE_REVIEW: pomožni pisatelj prek args.order.locationId
    expect(settle.split('locationId: args.order.locationId').length - 1).toBe(1)
    expect(settle).toContain("'PAY_LINK_SHARE_PAID'")
    expect(settle).toContain("'PAY_LINK_PAID'")
    expect(settle).toContain("'PAY_LINK_STRIPE_REVIEW'")
  })

  test('Ç1e kontinuiteta v293: Ç1b posodobljen na odklon (analiza → popravek veriga)', () => {
    const v293 = read('tests/v293-demo-real-auditlog-pisatelji.test.ts')
    expect(v293).toContain('Ç1b mehanizem paylink osamljenosti: odklonjen v1.294.0')
    // v293 Ç1a pini na produkcijo ostajajo zeleni (nedotaknjena koda)
    expect(v293).toContain("amounts ? 'PAY_LINK_SPLIT_CREATED' : 'PAY_LINK_CREATED'")
  })
})

// ── Ç2) VARNOSTNA DOKTRINA — omejen filter, sweep nedotaknjen ──────────────

describe('v294 Ç2: varnostna doktrina (omejen filter)', () => {
  test('Ç2a brisanje NIKOLI brez filtra: where vedno združi lokacijo fiksture + PAY_LINK_', () => {
    const src = read('tests/paylink-flow.test.ts')
    // splošno auditLog.deleteMany BREZ where (nevarno — pobrisalo bi vse)
    expect(src).not.toContain('auditLog.deleteMany()')
    // splošno brisanje po akciji BREZ lokacije (pobrisalo bi tuje paylinke)
    expect(src).not.toContain("auditLog.deleteMany({ where: { action: { startsWith: 'PAY_LINK_' } } })")
    // edina PAY_LINK_ oblika v cleanup je združena s locationId: loc.id
    const paylinkDeletes = src.split("action: { startsWith: 'PAY_LINK_' }").length - 1
    const boundedDeletes = src.split("{ locationId: loc.id, action: { startsWith: 'PAY_LINK_' } }").length - 1
    expect(paylinkDeletes).toBe(boundedDeletes)
  })

  test('Ç2b sweep NEDOTAKNJEN: fixture-sweep ne pozna PAY_LINK_ (čiste vrstice ostanejo)', () => {
    const sweep = read('tests/helpers/fixture-sweep.ts')
    expect(sweep).not.toContain('PAY_LINK_')
    // doktrina v291 Ç1c ostaja živa (sweep NIKOLI ne briše čistih vrstic)
    expect(read('tests/v291-demo-login-nicla-rast.test.ts')).toContain('Ç1c')
  })

  test('Ç2c 0 produkcjske kode: settle + route imata nespremenjene vsebinske pin-e v293 Ç1a', () => {
    const settle = read('src/lib/paylink/settle.ts')
    expect(settle).toContain("'PAY_LINK_PAID'")
    expect(settle).toContain('userId: null,')
    const route = read('src/app/api/orders/[id]/paylink/route.ts')
    expect(route).toContain("'PAY_LINK_REVOKED'")
    expect(route).toContain('id: nid()')
  })
})

// ── Ç3) MERILNE POGODBE VALA (reset → reseed → popravek → dokaz) ──────────

describe('v294 Ç3: merilne pogodbe', () => {
  // okno 80000 (preprečno, v1.295.0: 3. pojavev okenske družine v v289/v291
  // istega dne — zaključni vnos, dodan PO vratih vala, je potisnil pine čez
  // okno; proračun: OBA vnosa TEGA IN NASLEDNJEGA vala ~25k + rezervo ≈ 80k):
  // naslednji val doda OBA vnosa (~12k) NAD temi pini (@~2,4k–11k globoko v
  // lastnem vnosu) → ~23k skupaj
  test('Ç3a osnova po 10. resetu: baza izpraznjena + reseed pred tekom (AuditLog 0)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('10. reset')
    expect(wl).toContain('reseed')
    expect(wl).toContain('AuditLog 0')
  })

  test('Ç3b popravek zapisan: paylink osamljenost 13/tek → 0 (rast 27 → 14 čistih/tek)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('13 osamljenih')
    expect(wl).toContain('27 → 14')
  })

  test('Ç3c dokazi zapisani: TEK #1 številke + klasifikacija (0 predponskih + 0 mrtvih)', () => {
    const wl = read('worklog.md').slice(0, 160000)
    expect(wl).toContain('TEK #1')
    expect(wl).toContain('0 predponskih')
    expect(wl).toContain('0 mrtvih')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v294 Ž: registri', () => {
  test('verzija 1.300.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.300.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.300.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.300.0-nadzorni-val-stabilnosti-ii')
  })

  test('TEST_PREFIXES: 142 NESPREMJENJENO (v294 je testni cleanup obstoječe fiksture plnk-, 0 novih predpon)', () => {
    // plnk- je bil registriran ŽE pred tem valom (obstoječa fikstura) —
    // register ostaja 142, doktrino v291 Ž (142 z v291-) nosi naprej
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("'v291-'")
    expect(src).toContain("'plnk-'")
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testni cleanup + statični varuh)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('PaylinkCleanup')
    expect(read('prisma/schema.prisma')).not.toContain('PaylinkCleanup')
  })
})
