import { describe, test, expect, afterAll } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isUpstashUsable, rateLimitSharedAsync, __resetStoreForTests, upstashEndpoint } from '../src/lib/rate-limit'

/**
 * v1.152.0 — revizija 2026-10, najdbe №25–№30. VSE ŠEST je v repozitoriju obstajalo
 * že pred tem, nobena pa NI bila vidna iz kode: razkril je šele DEJANSKI izid
 * GitLab pipeline #57 (sha f9371d0, job 17309024530, log 653.068 B). Lokalno je
 * bil suite zelen 2889/2889, v CI-ju 9 rdečih — vsaka od devetih odpovedi pa je
 * bila posledica enega od šestih vzrokov spodaj.
 *
 *  №25 — `quality-gate` teče v `oven/bun:1`, kjer `git` ni nameščen. Skupina B2
 *        (sync guard, najdba №15) kliče prave git procese, zato je vseh pet
 *        testov padlo na `Executable not found in $PATH: "git"`. Gate rdeč zaradi
 *        orodja: ista družina kot №23.
 *  №26 — `check-secrets.sh` in `check-schema-drift.cjs` sta bila ZADNJA koraka za
 *        `bun run test`; job pa ustavi ob prvi napaki. Kakršen koli rdeč test ju je
 *        zato nikoli ni spustil. V pipeline #57 res nista tekla. Izpuščen
 *        žeton ali drift sheme bi ostala tiha.
 *  №27 — `tests/handheld-flow.test.ts` je klical `db.payment.deleteMany({ where:
 *        { orderId } })`, Payment pa stolpca `orderId` nima (edina pot do naročila
 *        je Check.checkId). Vrstica je VEDNO vrgla `Unknown argument 'orderId'`,
 *        `.catch(() => null)` jo je pogoltnil: 12× na tek, nič učinka.
 *  №28 — `getStore()` je Upstash izbral ob KAKRŠNI KOLI nastavitvi (`url && token`).
 *        GitLab projektne spremenljivke imajo obe vrednosti, URL brez sheme, zato je
 *        vsaka omejena zahteva naredila dva `fetch` klica, obsojena na neuspeh, in
 *        šele nato padla na memory store. Posledica ni samo hrup in odvečna mrežna
 *        pot: vsak test, ki zamenja `globalThis.fetch` in šteje klice, je
 *        rate-limitove klice štel za Stripe — #37 je v CI-ju videl 2 namesto 0 in
 *        trdil, da varovalka ni zadržala klica na Stripe, čeprav ga je.
 *  №29 — dirka "sočasno plačilo med preklicem" je bila odvisna od stenske ure:
 *        `commitPayment` je zaradi počasnega preklicnega handlerja dobil P1008
 *        (socket timeout, SQLite ima enega samega pisalca) in test je abortiral —
 *        brez dokazanega prekrška, brez deterministične alternative.
 *  №30 — bootstrap dispatch v issue38 je trdil globalno aritmetiko (`processed === 5`).
 *        Ob onesnaženju iz druge datoteke (posledica №29: prekinjen
 *        `db.eventLog.update()` v src/lib/events.ts:175 je pustil 'pending' vrstico)
 *        je odgovoril "Expected 5, Received 6" in ni povedal, KDO je onesnažil.
 *
 * Razredi:
 *   A — dinamična sonda №28 (resnični klici limiterja, števec fetch klicev),
 *   B — statične pogodbe vrstnega reda gate-ov (№26, oba sistema posebej),
 *   C — statične pogodbe dostopnosti gita (№25),
 *   D — statična pogodba veljavnih stolpcev počistila (№27, obojestransko),
 *   E — statične pogodbe determinizma dirke in atribucije onesnaženja (№29, №30).
 *
 * Testi NE potrebujejo baze.
 */

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const RUN = 'a2530'

/* ════════════ A — №28: izbira store-a je odvisna SAMO od UPORABNE nastavitve ════════════ */

const ORIG_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
}

function setUpstash(url: string | undefined, token: string | undefined) {
  if (url === undefined) delete process.env.UPSTASH_REDIS_REST_URL
  else process.env.UPSTASH_REDIS_REST_URL = url
  if (token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
  else process.env.UPSTASH_REDIS_REST_TOKEN = token
  __resetStoreForTests()
}

afterAll(() => {
  setUpstash(ORIG_ENV.url, ORIG_ENV.token)
})

/** Vrne število `fetch` klicev, ki jih je med `fn` naredila klicana koda. */
async function countFetches(fn: () => Promise<unknown>): Promise<number> {
  const orig = globalThis.fetch
  let n = 0
  globalThis.fetch = (async () => {
    n++
    return new Response('{"result":1}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = orig
  }
  return n
}

describe('A — №28 Upstash presoja (dinamično, brez mreže)', () => {
  test('URL brez sheme NENASTAVLJEN: limiter NE naredi nobenega fetch klica', async () => {
    setUpstash('redis.internal', 'tok-' + RUN)
    expect(isUpstashUsable()).toBe(false)
    expect(upstashEndpoint()).toBeNull()
    const calls = await countFetches(() => rateLimitSharedAsync(`a2530-nosheme-${RUN}`, 5, 60_000))
    expect(calls).toBe(0)
  })

  test('prazna ali samo-belesna vrednost = nenastavljeno', () => {
    setUpstash('   ', 'tok-' + RUN)
    expect(upstashEndpoint()).toBeNull()
    setUpstash('https://x.upstash.io', '   ')
    expect(upstashEndpoint()).toBeNull()
    setUpstash('https://', 'tok-' + RUN)
    expect(upstashEndpoint()).toBeNull()
  })

  test('absoluten https URL + token = UPORABNO: limiter res pokliče Upstash (veje ni mogoče utišati)', async () => {
    setUpstash('https://upstash.example.invalid', 'tok-' + RUN)
    expect(isUpstashUsable()).toBe(true)
    expect(upstashEndpoint()).toEqual({ url: 'https://upstash.example.invalid', token: 'tok-' + RUN })
    const calls = await countFetches(() => rateLimitSharedAsync(`a2530-valid-${RUN}`, 5, 60_000))
    expect(calls).toBeGreaterThan(0)
  })

  test('trailing slash in presledka na robovih sta odrezana (URL se ne poslabša samo zaradi oblike)', () => {
    setUpstash('  https://upstash.example.invalid///  ', ' tok ')
    expect(upstashEndpoint()).toEqual({ url: 'https://upstash.example.invalid', token: 'tok' })
  })

  test('ob neuporabni nastavitvi je zaščita še vedno aktivna (memory padec, ne dovoli-vse)', async () => {
    setUpstash('redis.internal', 'tok-' + RUN)
    const key = `a2530-protected-${RUN}`
    for (let i = 0; i < 5; i++) expect((await rateLimitSharedAsync(key, 5, 60_000)).allowed).toBe(true)
    expect((await rateLimitSharedAsync(key, 5, 60_000)).allowed).toBe(false)
  })
})

/* ════════════ B — №26: varnostna preverba NE SME biti za testi ════════════ */

describe('B — №26 vrstni red gate-ov (statično, vsak sistem posebej)', () => {
  test('GitLab quality-gate: drift in secrets tečeta PREJ kot `bun run test`', () => {
    const yml = read('.gitlab-ci.yml')
    const test = yml.indexOf('- bun run test')
    const drift = yml.indexOf('node scripts/check-schema-drift.cjs')
    const secrets = yml.indexOf('bash scripts/check-secrets.sh')
    expect(test).toBeGreaterThan(-1)
    expect(drift).toBeGreaterThan(-1)
    expect(secrets).toBeGreaterThan(-1)
    expect(drift).toBeLessThan(test)
    expect(secrets).toBeLessThan(test)
  })

  test('GitHub tests job: Secrets hygiene je PREJ kot Full test suite', () => {
    const yml = read('.github/workflows/ci.yml')
    // Rez po imenu joba, ne kar po celotnem YAML-u: koraki drugih jobov imajo
    // iste naslove in bi pogodbo razvodenili. Zapiranje poiščemo z regexom, ker je
    // `indexOf('\n  ')` neuporaben — vsaka vrstica z zamikom štirih presledkov
    // se začne z dvema.
    const from = yml.indexOf('  tests:')
    expect(from).toBeGreaterThan(-1)
    const tail = yml.slice(from + 8)
    const close = /\n {2}\S/.exec(tail)
    const body = tail.slice(0, close ? close.index : tail.length)
    expect(body.length).toBeGreaterThan(200)
    const secrets = body.indexOf('Secrets hygiene')
    const suite = body.indexOf('Full test suite')
    expect(secrets).toBeGreaterThan(-1)
    expect(suite).toBeGreaterThan(-1)
    expect(secrets).toBeLessThan(suite)
  })

  test('noben od obeh korakov ni označen z `continue-on-error` (gate, ki ne more pasti, ni gate)', () => {
    const gitlab = read('.gitlab-ci.yml')
    const gh = read('.github/workflows/ci.yml')
    for (const line of [...gitlab.matchAll(/^.*(check-secrets|check-schema-drift).*$/gm)].map((m) => m[0])) {
      expect(line).not.toMatch(/continue-on-error|\|\|\s*true/)
    }
    expect(gitlab).not.toMatch(/continue-on-error/)
    expect(gh).not.toMatch(/continue-on-error/)
  })

  test('vsaka `script` vrstica je YAML niz: nepoudarjen skalar ne sme vsebovati `: ` (pipeline #58 brez jobov)', () => {
    // GitLab pipeline #58 (sha 4b47f63) je bila `failed` z NIČ jobi, ker je
    // `echo "GIT-MISSING: B2 …"` dvopičje s presledkom spremenilo v preslikavo:
    // js-yaml vrne {"bash -c '…GIT-MISSING": "B2 …"} namesto niza. Pravilo
    // YAML: nepoudarjen skalar ne sme vsebovati `: `. Cela vrstica je lahko
    // niz tudi, če se skalar začne s citatom ali blokom — takrat je `: ` legalen.
    const lines = read('.gitlab-ci.yml').split('\n')
    const offenders: string[] = []
    let inScript = false
    for (const line of lines) {
      if (/^ {2}\S/.test(line)) inScript = /^ {2}script:\s*$/.test(line)
      if (!inScript || !/^ {4}- /.test(line)) continue
      const scalar = line.slice(6)
      if (!/^['"|>]/.test(scalar) && /: /.test(scalar)) offenders.push(line.trim())
    }
    expect(offenders).toEqual([])
  })

  test('GitLab production-typecheck in GitHub typecheck-prod: isti recept proti Postgres klientu', () => {
    // SQLite client (quality-gate) pozna enum polja kot String, zato tsc tam ne
    // vidi neveljavnega literala. Vercel generira Postgres client — in ravno ta
    // razlika je stala tri ERROR deployment-e (v1.150.0–v1.152.0). Zato sta
    // joba pinirana v OBEH sistemih z isto vsebino, da eden ne more tiho izginiti.
    const gitlab = read('.gitlab-ci.yml')
    const at = gitlab.indexOf('\nproduction-typecheck:')
    expect(at).toBeGreaterThan(-1)
    const tail = gitlab.slice(at + '\nproduction-typecheck:'.length)
    // konec joba: prva vrstica, ki se začne v stolpcu 0 (komentar ali naslednji job)
    const end = /\n(?=[^\s])/.exec(tail)
    const body = tail.slice(0, end ? end.index : tail.length)
    expect(body.length).toBeGreaterThan(200)
    for (const cmd of ['bunx prisma generate --schema prisma/schema.prisma', 'bunx tsc --noEmit']) {
      expect(body).toContain(cmd)
    }
    expect(body).not.toContain('schema.sqlite.prisma')
    expect(body).not.toContain('DATABASE_URL')

    const gh = read('.github/workflows/ci.yml')
    const from = gh.indexOf('\n  typecheck-prod:')
    expect(from).toBeGreaterThan(-1)
    const ghTail = gh.slice(from + '\n  typecheck-prod:'.length)
    const ghEnd = /\n {2}\S/.exec(ghTail)
    const ghBody = ghTail.slice(0, ghEnd ? ghEnd.index : ghTail.length)
    for (const cmd of ['prisma generate --schema prisma/schema.prisma', 'tsc --noEmit']) {
      expect(ghBody).toContain(cmd)
    }
    expect(ghBody).not.toContain('schema.sqlite.prisma')
  })
})

/* ════════════ C — №25: git kot pogoj, ne kot presenetljiva napaka ════════════ */

describe('C — №25 git dostopnost v CI (statično)', () => {
  test('quality-gate poskusi namestiti git, a namestitev NE more ustaviti joba', () => {
    const yml = read('.gitlab-ci.yml')
    expect(yml).toContain('command -v git')
    expect(yml).toContain('no-install-recommends git')
    const line = yml.split('\n').find((l) => l.includes('command -v git')) || ''
    expect(line).toMatch(/\|\|\s*echo/) // zadnja varovalka: brez uspeha vrne 0, ne ruši joba
    expect(line).not.toMatch(/&&\s*apt-get install[^|]*$/)
  })

  test('skupina B2 je vezana na ekspliciten pogoj in ne pade zaradi orodja', () => {
    const t = read('tests/audit1516-ci-hygiene.test.ts')
    expect(t).toMatch(/const HAS_GIT = \(\(\) => \{/)
    expect(t).toContain('describe.skipIf(!HAS_GIT)(\'B2.')
    expect(t).toContain('PRESKOCENO-B2')
    expect(t).toMatch(/execFileSync\('git', \['--version'\]/)
  })

  test('B2 pogodba NE velja za celotno datoteko: skupina A (statični pini) teče vedno', () => {
    const t = read('tests/audit1516-ci-hygiene.test.ts')
    const skipIfs = t.match(/describe\.skipIf\(!HAS_GIT\)/g) || []
    expect(skipIfs.length).toBe(1)
    expect(t).toMatch(/describe\('A[\s\S]*?test\(/)
  })
})

/* ════════════ D — №27: počistilo sme uporabljati samo STOLPCE, ki obstajajo ════════════ */

describe('D — №27 Payment nima orderId (pinirano v obe smeri)', () => {
  test('shema: model Payment NIMA stolpca orderId', () => {
    const schema = read('prisma/schema.prisma')
    const m = /model Payment \{([\s\S]*?)\n\}/.exec(schema)
    expect(m).not.toBeNull()
    expect(m![1]).not.toMatch(/^\s*orderId\b/m)
    expect(m![1]).toMatch(/^\s*checkId\s+String/m)
  })

  test('zrcalna shema (CI) je pri tem ISTA', () => {
    const m = /model Payment \{([\s\S]*?)\n\}/.exec(read('prisma/schema.sqlite.prisma'))
    expect(m).not.toBeNull()
    expect(m![1]).not.toMatch(/^\s*orderId\b/m)
  })

  test('nobeno počistilo v testih ne briše Payment po orderId (prejšnja tiha napaka)', () => {
    const t = read('tests/handheld-flow.test.ts')
    expect(t).not.toMatch(/payment\.deleteMany\(\{\s*where:\s*\{\s*orderId/)
    expect(t).toContain('№27')
  })

  test('edini prehod plačil gre po checkId', () => {
    const t = read('tests/handheld-flow.test.ts')
    expect(t).toMatch(/payment\.deleteMany\(\{ where: \{ checkId: \{ in: checks\.map/ )
  })
})

/* ════════════ E — №29 / №30: determinizem in atribucija ════════════ */

describe('E — №29 dirka in №30 onesnaženje (statično)', () => {
  test('raceSweep požre SAMO P1008 in ga ŠTEJE; vsaka druga napaka pade', () => {
    const t = read('tests/order-concurrency.test.ts')
    expect(t).toContain("code !== 'P1008'")
    expect(t).toMatch(/if \(code !== 'P1008'\) throw e/)
    expect(t).toMatch(/lockTimeouts\+\+/)
    expect(t).toMatch(/lockTimeouts, 'P1008 zakasnitev.*\)\s*\.toBeLessThanOrEqual\(1\)/s)
  })

  test('varnostna trditev dirke ima DETERMINISTIČNA primera (plačilo-prej in preklic-prej)', () => {
    const t = read('tests/order-concurrency.test.ts')
    expect(t).toContain('deterministično A')
    expect(t).toContain('deterministično B')
    // A: plačilo commitnjeno pred preklicom → 409 brez sledi
    expect(t).toMatch(/deterministično A[\s\S]*?toBe\(true\)[\s\S]*?\.status, kind\)\.toBe\(409\)/)
    // B: preklic zaključen pred plačilom → commitPayment false, račun 0
    expect(t).toMatch(/deterministično B[\s\S]*?commitPayment\(order\.id\)\)\.toBe\(false\)/)
    expect(t).toMatch(/deterministično B[\s\S]*?receipt\.count[\s\S]*?\)\.toBe\(0\)/)
  })

  test('nedoločena dirka ne more biti tiho prazna in ne sme soditi po hitrosti gostitelja', () => {
    const t = read('tests/order-concurrency.test.ts')
    // Računovodstvo poskusov: vseh 20 zamikov mora biti bodisi preverjenih
    // bodisi prištetih k P1008 — tiho preskočen poskus mora biti rdeč.
    expect(t).toMatch(/checked\+\+/)
    expect(t).toMatch(/patch\.checked \+ patch\.lockTimeouts \+ del\.checked \+ del\.lockTimeouts,[^)]*\)\s*\.toBe\(20\)/s)
    // Prepovedana oblika: trditev, kdo zmaga dirko, je odvisna od stroja. Na
    // GitHub runnerju je padla, čeprav finančna invarianta ni bila kršena
    // niti enkrat (run 39935225480, tests job, 23. 10. 09:55:04 UTC).
    expect(t).not.toMatch(/rejections\)\.toBeGreaterThan\(0\)/)
    // Zavrnitev mora biti upravičena: 409 brez commitnjenega plačila je napaka.
    expect(t).toMatch(/expect\(paidFirst, `409 brez commitnjenega plačila/)
  })

  test('issue38 bootstrap: lastnih vrst je točno 5, tuje se preštejejo in IMENUJEJO', () => {
    const t = read('tests/issue38-event-tenant-scope.test.ts')
    expect(t).toMatch(/status: 'pending', NOT: \{ id: \{ startsWith: PREFIX \} \}/)
    expect(t).toContain(`expect(await db.eventLog.count({ where: { status: 'pending', id: { startsWith: PREFIX } } })).toBe(5)`)
    expect(t).toMatch(/toBe\(5 \+ tujke\.length\)/)
    expect(t).toMatch(/onesnaženje pred tem testom/)
  })

  test('#37 števec šteje SAMO Stripe klice (ne rate-limitovih)', () => {
    const t = read('tests/issue30-37-ssrf-paylink-binding.test.ts')
    const naive = t.match(/globalThis\.fetch = \(async \(\) => \{\s*\n\s*stripeCalls\+\+/g) || []
    expect(naive.length).toBe(0)
    const filtered = t.match(/if \(String\(input\)\.includes\('api\.stripe\.com'\)\)\s*stripeCalls\+\+/g) || []
    expect(filtered.length).toBe(2)
  })

  test('rate-limit v src/ NE pozna globalThis.fetch brez predhodne presoje URL-ja', () => {
    const src = read('src/lib/rate-limit.ts')
    expect(src).toMatch(/if \(!ep\) throw new Error\('upstash ni konfiguriran/)
    expect(src).toContain('upstashEndpoint')
    // edini `fetch(` v modulu sme biti znotraj upstashCommand
    const fetchLines = src.split('\n').filter((l) => /^\s*(const res = await )?fetch\(/.test(l))
    expect(fetchLines.length).toBe(1)
  })
})

/**
 * v1.171.0 — F: tri najdbe, ki jih je razkril šele dejanski GitHub CI run
 * 39905677431 (prvi pravi tek po izbrisu `CI_RUNNER_LABELS`): 13 rdečih testov in
 * neon-smoke padec, lokalno zelen. Vsaka od treh najdb je ANTIPATTERN, ki ga
 * je bilo mogoče videti samo z več datotek v enem procesu ali z dejanskim izidom
 * infra koraka.
 */
describe('F — v1.171.0 antipatterni, ki jih vidi šele skupni proces ali infra izid', () => {
  test('nobena testna datoteka NE uporablja mock.module (strupi modulski register za cel proces)', () => {
    // Bunjev `mock.module` zamenja zapis v registru CELOTEN proces. `mock.restore()`
    // in ročna vrnitev pravega izvoza pominita samo IME izvoza — notranjost
    // zamenjanega modula (npr. njegov lasten `db`) ostane ponovno vezana in
    // tiho drugačna. Merjeno: v161 je zamenjal `@/lib/paylink/reconcile`, v157
    // (42. v CI vrstnem redu) je klical PRavo funkcijo, a je njen `findMany`
    // vrnil 0 vrstic ob 7 ujemajočih se povezavah.
    const files = readdirSync(join(process.cwd(), 'tests'), { recursive: true })
      .filter((f) => typeof f === 'string' && f.endsWith('.test.ts'))
      .map((f) => String(f))
    expect(files.length).toBeGreaterThan(100)
    // ta datoteka sama vsebuje iskalni niz (v trditvi spodaj), zato je izvzeta
    const uporabili = files
      .filter((f) => f !== 'audit2530-ci-determinism.test.ts')
      .filter((f) => read(join('tests', f)).includes('mock.module('))
    expect(uporabili).toEqual([])
  })

  test('Upstash INCR odgovor je PREVERJEN: nevrednost ne sme biti tiho enaka 0 zadetkom', () => {
    const src = read('src/lib/rate-limit.ts')
    // `Number(null) === 0` in `0 <= limit` → NEOMEJENO število dovoljenih zahtev.
    expect(src).toMatch(/if \(raw === null \|\| !Number\.isInteger\(count\) \|\| count < 1\)/)
    expect(src).toMatch(/neuskladen Upstash INCR odgovor/)
    // prepoved: številčna pretvorba odgovora brez vmesne preje
    expect(src).not.toMatch(/const count = Number\(await upstashCommand/)
  })

  test('ci.yml: Neon BR_ID gre v GITHUB_ENV PREJ od kateregakoli naslednjega API klica', () => {
    const yml = read('.github/workflows/ci.yml')
    const izvoz = yml.indexOf('echo "BR_ID=$BR_ID" >> "$GITHUB_ENV"')
    const endpoint = yml.indexOf('POST "/projects/$NEON_PROJECT_ID/endpoints"')
    expect(izvoz).toBeGreaterThan(-1)
    expect(endpoint).toBeGreaterThan(-1)
    expect(izvoz).toBeLessThan(endpoint)
    // korak za brisanje mora teči tudi ob padcu predhodnih korakov
    expect(yml).toMatch(/name: Delete ephemeral branch\n\s+if: always\(\)/)
  })
})
