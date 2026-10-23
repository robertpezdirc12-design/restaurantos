import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { stepScript, runsOnLines, usesHostedRunner, jobNames, jobBlock } from './helpers/workflow'

/**
 * v1.151.0 — revizija 2026-10, najdbi №23 in №24 (obe izven začetnih 22; razkrila
 * sta ju DEJANSKA izvedba pipeline-a in meritev, ne branje kode).
 *
 *  №23 — `src/lib/db.ts` je imel NEPOGOJEN `log: ['query']`. Izmerjeno 20. 10. 2026
 *        na tem repozitoriju: celoten suite (2872 testov, 138 datotek) natisne
 *        17.044.192 B izhoda, od tega 59.255 `prisma:query` vrstic. Omejitev
 *        GitLab-ovega jobskega loga je 4.194.304 B, zato je quality-gate
 *        umrl sredi testov (pipeline #56, sha e053a52): log se je prekinil z
 *        "Job's log exceeded limit of 4194304 bytes" in je za seboj pustil rdeč
 *        izid brez razloga. Posledica ni hrup, ampak GATE, KI NIKOLI NE MORE
 *        BITI ZELEN: `check-secrets.sh` in `check-schema-drift.cjs` se v tem
 *        pipeline-u nikoli nista izvedla. V produkciji isti mehanizem natisne ~20
 *        `prisma:query` vrstic na test v log drain (Vercel) — vrednosti parametrov Prisma ne
 *        izpisuje (ostanejo `?`), izpisuje pa obliko vsakega posega.
 *        Drugi, manj opazen del iste napake: `log: ['query']` je edina stopnja,
 *        zato Prisma svojih `warn` in `error` sporočil ni pisal nikoli.
 *
 *  №24 — `if: failure()` (№16) ne more sprožiti alarma za job, ki se nikoli ni
 *        začel. Izpad brez runnerja je bil dokazani scenarij že pri №15 (hosted
 *        kvota je zmanjkala in GitHub job zavrgel), alarm pa je vezan na to, da
 *        se job izvede — za izid, ki se ni zgodil, rdeče ne obstaja. Dodana sta
 *        `scripts/ci-canary-check.mjs` in `ci-canary.yml`: enkrat na uro
 *        preverita, da ima zadnji commit na `main` OBSTOJEČ in ZAKLJUČEN run.
 *
 * Razredi testov:
 *   A — statične pogodbe nad db.ts in nad CI konfiguracijama,
 *   B — dinamična sonda: zagon `scripts/log-noise-probe.ts` s stikalom in brez
 *       njega (dokaz, da je stikalo živo in da brez njega query log-a ni),
 *   C — statične pogodbe canary-ja, vključno z edino namerno izjemo od
 *       runner-routinga (№15) in pravilom, da se ta izjema ne more širiti,
 *   D — dinamični canary: ISTI skript, ki ga workflow zove, proti pripravljenim
 *       JSON odzivom API-ja (sedem scenarijev, trije morajo ostati zeleni).
 *
 * B potrebuje DATABASE_URL (že izpolnjen pogoj: `tests` job in quality-gate
 * klicata `prisma db push` pred testi).
 */

const ROOT = process.cwd()
const P = 'c23-'
const CANARY_WF = 'ci-canary.yml'
const CANARY_SCRIPT = join('scripts', 'ci-canary-check.mjs')

const tmpDirs: string[] = []
function mkTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `${P}${label}-`))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** Pod `bun test` je process.execPath pravi bun paket — sklic `bun` bi na
 *  Windowsih naletel na npm shim, ki ga Node ne more izvesti (ENOENT). */
const BUN = process.execPath

function runBun(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BUN, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** canary teče z node, ne z bun: na hosted runnerju bun ni nameščen. */
function runCanary(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [join(ROOT, CANARY_SCRIPT)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const queryLineCount = (s: string) => (s.match(/prisma:query/g) || []).length
const workflowFiles = () => readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'))

/* ══════════════ A. №23 — statične pogodbe ══════════════ */

describe('A. №23 — query log mora biti izbiran, ne privzet', () => {
  test('db.ts nima nepogojnega log: ["query"]', () => {
    const src = readFileSync(join(ROOT, 'src/lib/db.ts'), 'utf8')
    const logLines = src
      .split(/\r?\n/)
      .filter((l) => /\blog\s*[:=]/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
    expect(logLines.length).toBeGreaterThan(0)
    for (const l of logLines) {
      expect(/log:\s*\[\s*'query'\s*\]/.test(l)).toBe(false)
    }
    // stikalo mora biti env spremenljivka, ne hardkodirana vrednost
    expect(src).toMatch(/process\.env\.[A-Z0-9_]+\s*===\s*'1'/)
    expect(src).toContain('PRISMA_LOG_QUERIES')
  })

  test('privzeto se logirata warn in error (stara konfiguracija ju je pogoltnila)', () => {
    const src = readFileSync(join(ROOT, 'src/lib/db.ts'), 'utf8')
    expect(src).toContain("'warn'")
    expect(src).toContain("'error'")
  })

  test('nobena CI konfiguracija ne prižge query log-a (sicer se strop overflow vrne)', () => {
    const ci = [
      readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8'),
      readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    ].join('\n')
    // nastavitev na 1 je izvedljivi del; ime v komentarju ali dokumentu je dovoljeno
    const live = ci
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(/PRISMA_LOG_QUERIES\s*[:=]\s*['"]?1/.test(live)).toBe(false)
  })

  test('meritev, ki je ubila quality-gate, je zapisana na samem ozkem grlu', () => {
    const gl = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8')
    expect(gl).toContain('17.044.192')
    expect(gl).toContain('4.194.304')
  })
})

/* ══════════════ B. №23 — dinamična sonda ══════════════ */

describe('B. №23 — sonda: stikalo je živo, brez njega loga ni', () => {
  test('brez PRISMA_LOG_QUERIES sonda ne izpiše nobene prisma:query vrstice', () => {
    const r = runBun(['run', join('scripts', 'log-noise-probe.ts')], { PRISMA_LOG_QUERIES: '' })
    expect(r.out).toContain('PROBE_OK')
    expect(r.code).toBe(0)
    expect(queryLineCount(r.out)).toBe(0)
  }, 45_000)

  test('z PRISMA_LOG_QUERIES=1 ista sonda izpiše poizvedbo (dokaz, da stikalo deluje)', () => {
    const r = runBun(['run', join('scripts', 'log-noise-probe.ts')], { PRISMA_LOG_QUERIES: '1' })
    expect(r.out).toContain('PROBE_OK')
    expect(r.code).toBe(0)
    expect(queryLineCount(r.out)).toBeGreaterThan(0)
    expect(r.out).toMatch(/SELECT 1/i)
  }, 45_000)
})

/* ══════════════ C. №24 — canary pogodbe ══════════════ */

describe('C. №24 — canary obstaja in je vezan na dejanski signal', () => {
  test('workflowi so natanko pet delivery + ena canary izjema', () => {
    expect(workflowFiles().slice().sort()).toEqual(
      ['ci-canary.yml', 'ci.yml', 'neon-backup.yml', 'prod-smoke.yml', 'sync.yml', 'vercel-ops.yml'].sort(),
    )
  })

  test('canary je EDINA dovoljena izjema od runner-routinga in je utemeljena', () => {
    let exceptions = 0
    for (const f of workflowFiles()) {
      const text = readFileSync(join(ROOT, '.github/workflows', f), 'utf8')
      const lines = runsOnLines(text)
      expect(lines.length).toBeGreaterThan(0)
      // ne komentar in ne `${{ ... || 'ubuntu-latest' }}` fallback smeta skriti
      // dejanskega hosted runnerja — zato usesHostedRunner odstrani oboje
      const hosted = lines.filter(usesHostedRunner)
      if (hosted.length === 0) {
        for (const l of lines) expect(l).toContain('vars.CI_RUNNER_LABELS')
        continue
      }
      exceptions++
      // izjema sme biti samo canary in mora biti utemeljena z oznako v isti datoteki
      expect(f).toBe(CANARY_WF)
      expect(text).toContain('IZJEMA-CI-CANARY')
    }
    expect(exceptions).toBe(1)
  })

  test('canary se zaganja sam od sebe in ima lastni alarm', () => {
    const text = readFileSync(join(ROOT, '.github/workflows', CANARY_WF), 'utf8')
    expect(text).toMatch(/cron:\s*'\d+ \* \* \* \*'/)
    expect(text).toContain('workflow_dispatch')
    for (const perm of ['contents: read', 'issues: write', 'actions: read']) expect(text).toContain(perm)
    // brez checkouta lokalna akcija ne more biti najdena
    expect(text).toContain('actions/checkout@')
    const jobs = jobNames(text)
    expect(jobs.length).toBe(1)
    const block = jobBlock(text, jobs[0])
    expect(block).toContain('if: failure()')
    expect(block).toMatch(/uses:\s*\.\/\.github\/actions\/ci-alarm/)
    expect(block).toContain('secrets.GITHUB_TOKEN')
    // timeout: canary, ki visi sam, je ravno tisto, kar testira
    expect(block).toMatch(/timeout-minutes:\s*([1-9]|1[0-2])\b/)
  })

  /* v1.172.0 — dva pogoja, ki sta bila izmerjena, ne domnevna:
   * (a) hint mora našteti razred, ki ga `if: failure()` ne more zajeti, ker je
   *     to edino besedilo, ki ga osebnost na drugi strani sploh dobi (issue);
   * (b) `scope` je NASLOV issue-a, `ci-alarm` pa deduplicira po točnem
   *     naslovu (action.yml:143). Spremenjen scope = nov issue, stari (#77)
   *     pa ostane odprt in vedno tišji. */
  test('canary hint imenuje `cancelled` razred, scope pa ostane stabilen naslov', () => {
    const text = readFileSync(join(ROOT, '.github/workflows', CANARY_WF), 'utf8')
    // pripomoček je v SAMEM hintu, ki ga odda `ci-alarm` — ne nekje v datoteki,
    // sicer bi komentar zadostoval in test ne bi branil ničesar
    const hint = text.split(/\r?\n/).find((l) => l.trim().startsWith('hint:')) ?? ''
    expect(hint.length).toBeGreaterThan(0)
    expect(hint).toMatch(/cancelled/)
    expect(hint).toMatch(/startup_failure/)
    expect(hint).toMatch(/queued/)
    const scope = text.match(/scope:\s*'([^']+)'/)?.[1]
    expect(scope).toBe('canary: main nima zaključenega CI runa')
  })

  test('canary pokliče dejanski skript in ga ne ponotranji v YAML', () => {
    const text = readFileSync(join(ROOT, '.github/workflows', CANARY_WF), 'utf8')
    const script = stepScript(text, 'Preveri zakasnitev CI-ja na main')
    expect(script).toContain('ci-canary-check.mjs')
    expect(script).toMatch(/set -euo pipefail/)
    expect(script).not.toMatch(/\|\|\s*true/)
    expect(script).not.toMatch(/2>\s*\/dev\/null/)
    expect(existsSync(join(ROOT, CANARY_SCRIPT))).toBe(true)
    const js = readFileSync(join(ROOT, CANARY_SCRIPT), 'utf8')
    // hosted runner ima node, ne bun-a
    expect(js).not.toContain('Bun.')
    expect(js).toContain('fetch')
    // brez novega secret-a: edini vir pooblastila je GITHUB_TOKEN
    const secretLines = text.split(/\r?\n/).filter((l) => l.includes('secrets.'))
    expect(secretLines.length).toBeGreaterThan(0)
    for (const s of secretLines) expect(s).toContain('GITHUB_TOKEN')
  })
})

/* ══════════════ D. №24 — canary proti pripravljenim API odzivom ══════════════ */

describe('D. №24 — canary skript odloči pravilno', () => {
  const d = mkTmp('canary')
  const HEAD = 'a'.repeat(40)
  const CLOCK = Date.parse('2026-10-20T12:00:00Z')
  const iso = (agoMin: number) => new Date(CLOCK - agoMin * 60_000).toISOString()

  /* Izmerjeno 23. 10. (issue #77, run 39962111054): `/commits?sha=main&per_page=1`
   * vrne **seznam** (`gh api … --jq 'type'` → `array`), ne posameznega predmeta.
   * Stari helper je pisal `{ sha }`, torej obliko, je si je zamislil avtor testa in
   * je je API nikoli ne vrne — zato je 14 odločitvenih testov spodaj mirno zelenih,
   * medtem ko je canary na produkciji vedno javljal napačen razlog. Zdaj helper
   * normalizira **na pravo obliko**: karkoli ni seznam, postane seznam z enim
   * elementom, kot ga vrne goltalnik. */
  function fixtures(name: string, commits: unknown, runs: unknown) {
    const cf = join(d, `${name}-commits.json`)
    const rf = join(d, `${name}-runs.json`)
    writeFileSync(cf, JSON.stringify(Array.isArray(commits) ? commits : [commits]))
    writeFileSync(rf, JSON.stringify(runs))
    return {
      CANARY_COMMITS_FILE: cf,
      CANARY_RUNS_FILE: rf,
      CANARY_NOW_EPOCH: String(CLOCK / 1000),
      CANARY_STALL_MINUTES: '20',
      GITHUB_REPOSITORY: 'x/y',
      GITHUB_TOKEN: 'fixture-mode-ne-uporablja-se',
    }
  }

  const okRun = {
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    created_at: iso(35),
    number: 111,
  }

  test('zelen: zadnji commit ima zaključen uspešen run', () => {
    const r = runCanary(fixtures('ok', { sha: HEAD }, { workflow_runs: [okRun] }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/OK\b/)
  })

  test('rdeč: zadnji commit nima nobenega runa (Actions onemogočen ali pokvarjen workflow)', () => {
    const other = { ...okRun, head_sha: 'b'.repeat(40) }
    const r = runCanary(fixtures('norun', { sha: HEAD }, { workflow_runs: [other] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/nima nobenega CI runa/)
  })

  test('rdeč: na veji ni nobenega zabeleženega push runa', () => {
    const r = runCanary(fixtures('empty', { sha: HEAD }, { workflow_runs: [] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/nikoli ni tekel/)
  })

  test('rdeč: run čaka ali teče dlje od praga (najverjetneje ni dobil runnerja)', () => {
    const stuck = { ...okRun, status: 'in_progress', conclusion: null, created_at: iso(41) }
    const r = runCanary(fixtures('stuck', { sha: HEAD }, { workflow_runs: [stuck] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/čaka ali teče že 41 min/)
  })

  test('zelen: run v pragu se ne šteje za izpad', () => {
    const fresh = { ...okRun, status: 'queued', conclusion: null, created_at: iso(4) }
    const r = runCanary(fixtures('fresh', { sha: HEAD }, { workflow_runs: [fresh] }))
    expect(r.code).toBe(0)
  })

  test('zelen in tih za zaključen failed run — svoj if: failure() alarm ga že pokriva', () => {
    const failed = { ...okRun, conclusion: 'failure' }
    const r = runCanary(fixtures('failed', { sha: HEAD }, { workflow_runs: [failed] }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/podvajati/)
  })

  /* Izmerjen incident 22.–23. 10. (v1.171.0): `gitlab-sync` je dva dni držal en
   * sam `queued` job, vsak sync run na tipu pa je končal `cancelled` (runa #42,
   * #43, #44 brez enega samega rdečega koraka). `sync.yml` ima alarm korak z
   * `if: failure()` (vrstica 192), preklican run pa takšnih korakov ne izvede
   * NIKOLI — zato tiho predpogojem »njegov lastni alarm ga že pokriva« ne
   * sme več biti. Od tod napaka: canary je na teh tipih vrnil 0. */
  const SYNC_NAME = 'Dvosmerna sinhronizacija GitLab <-> GitHub'
  const CI_NAME = 'CI — quality gate (neon-smoke + tests)'

  test('rdeč: zaključen `cancelled` run na tipu ne sme ostati tih', () => {
    const cancelled = { ...okRun, name: SYNC_NAME, conclusion: 'cancelled', created_at: iso(30) }
    const r = runCanary(fixtures('cancelled-tip', { sha: HEAD }, { workflow_runs: [cancelled] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/cancelled/)
    expect(r.out).toMatch(/if: failure/)
  })

  test('rdeč: `startup_failure` na tipu je isti razred — alarm korak se ni mogel izvesti', () => {
    const sf = { ...okRun, name: CI_NAME, conclusion: 'startup_failure', created_at: iso(28) }
    const r = runCanary(fixtures('startup-failure', { sha: HEAD }, { workflow_runs: [sf] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/startup_failure/)
  })

  test('rdeč: uspeh enega workflowa ne pokrije preklicanega drugega na istem tipu', () => {
    const ciOk = { ...okRun, name: CI_NAME, created_at: iso(150) }
    const syncDead = { ...okRun, name: SYNC_NAME, conclusion: 'cancelled', created_at: iso(100) }
    const r = runCanary(fixtures('mixed', { sha: HEAD }, { workflow_runs: [ciOk, syncDead] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Dvosmerna/)
  })

  test('zelen: preklican run, ki mu je na istem workflowu sledil uspeh, ni izpad', () => {
    const older = { ...okRun, name: SYNC_NAME, conclusion: 'cancelled', created_at: iso(120) }
    const newer = { ...okRun, name: SYNC_NAME, conclusion: 'success', created_at: iso(60) }
    const r = runCanary(fixtures('recovered', { sha: HEAD }, { workflow_runs: [older, newer] }))
    expect(r.code).toBe(0)
  })

  test('zelen: failure enega in uspeh drugega workflowa na tipu ostaneta tiha', () => {
    const ciDead = { ...okRun, name: CI_NAME, conclusion: 'failure', created_at: iso(150) }
    const syncOk = { ...okRun, name: SYNC_NAME, conclusion: 'success', created_at: iso(100) }
    const r = runCanary(fixtures('failure-and-success', { sha: HEAD }, { workflow_runs: [ciDead, syncOk] }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/podvajati/)
  })

  /* Dejanska oblika izmera 22.–23. 10.: `ci.yml` na tipu zelene gradnje, zadnji
   * sync run na istem tipu pa `cancelled` in je STAREJŠI od CI-jevega. Odločitev
   * mora biti po workflowu, ne po »najnovejšem runu na tipu«. */
  test('rdeč: starejši preklican sync run na tipu zelenega CI-ja je izpad', () => {
    const ciOk = { ...okRun, name: CI_NAME, created_at: iso(60) }
    const syncDead = { ...okRun, name: SYNC_NAME, conclusion: 'cancelled', created_at: iso(120) }
    const r = runCanary(fixtures('stale-cancelled', { sha: HEAD }, { workflow_runs: [ciOk, syncDead] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Dvosmerna/)
    expect(r.out).toMatch(/queued/)
  })

  /* Pravi `/actions/runs` odgovor ima polje `run_number`, ne `number` (izmerjeno
   * 23. 10. na pravem odzivu API-ja, 1.516.726 B). Alarm, ki ne zna poimenovati
   * runa, je alarm, ki ga nihče ne more slediti. */
  test('alarm in OK sporočilo uporabljata pravi polji API-ja: run_number in name', () => {
    const realShape = {
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'cancelled',
      created_at: iso(30),
      run_number: 44,
      name: SYNC_NAME,
    }
    const r = runCanary(fixtures('real-shape', { sha: HEAD }, { workflow_runs: [realShape] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/#44/)
    expect(r.out).not.toMatch(/undefined/)

    const okReal = { ...realShape, conclusion: 'success', run_number: 48 }
    const g = runCanary(fixtures('real-shape-ok', { sha: HEAD }, { workflow_runs: [okReal] }))
    expect(g.code).toBe(0)
    expect(g.out).toMatch(/#48/)
    expect(g.out).not.toMatch(/undefined/)
  })

  /* SEDMA LUKNJA (izmerjeno 23. 10.): vseh 16 zasledovanih načrtovanih runov
   * canary-ja je odpovedalo z `ALARM: zadnjega commita na veji main ni bilo
   * mogoče določiti (prazen odgovor)`, čeprav je bil `main` poln zaključenih
   * runov. Odgovor `/commits` namreč NI prazen — je seznam z enim elementom,
   * katerega `.sha` skript ni znal prebrati. Odločitev, ki jo je prinesla
   * v1.172.0, se v produkciji nikoli ni izvedla. */
  test('rdeč: prazen seznam commitov javi dejansko obliko odgovora, ne „prazen odgovor"', () => {
    const r = runCanary(fixtures('empty-list', [], { workflow_runs: [okRun] }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/0 elementov/)
    expect(r.out).not.toMatch(/prazen odgovor/)
  })

  /* Statična pogodba, da se ta razred napake ne more vrniti tiho: glava veje
   * SME biti razrešjena samo prek seznama. Odstranitev tega pogoja bi
   * vrstila produkcijo nazaj na »vedno lažen razlog«, lokalni suite pa bi bil
   * spet zelen, ker bi helper pisal pravo obliko. */
  test('skript glavo veje razreši skozi seznam in ne z neposrednim .sha', () => {
    const js = readFileSync(join(ROOT, CANARY_SCRIPT), 'utf8')
    expect(js).toMatch(/Array\.isArray\(commits\)/)
    expect(js).not.toMatch(/const head = commits && commits\.sha/)
  })

  test('izpad API-ja je napaka, ne tiho zelena odločitev', () => {
    const r = runCanary({
      ...fixtures('broken', { sha: HEAD }, { workflow_runs: [okRun] }),
      CANARY_COMMITS_FILE: join(d, 'ne-obstaja.json'),
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/API|odziva/)
  })
})
