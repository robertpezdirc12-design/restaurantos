import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * v1.150.0 — revizija 2026-10, najdbe №15, №16, №18, №21 (CI/CD varnostna plast).
 *
 *  №15 — `sync.yml` je bil edini workflow s HARDCODIRANIM `runs-on: ubuntu-latest`;
 *        ko je zmanjkalo hosted minut (13.–18. 10.), je GitHub job zavrgel in
 *        zrcalo GitLab je mirovalo 31 verzij zadaj. Isti workflow je token zapisal
 *        v `.git/config` (`https://oauth2:${GITLAB_TOKEN}@…`), neuspehen fetch/push
 *        ni vplival na izhod koraka (workflow zelen, sinhronizirano niče) in je
 *        tage pushal z `--force` v obe smeri (že objavljen tag je bilo mogoče
 *        tiho preusmeriti na drug commit).
 *
 *  №16 — nobenih petih workflowov ni imelo `if: failure()`. To je pogoj za
 *        ponovitev izpada, ne samo njegova posledica: rdeč pipeline, ki ga ne
 *        najde nihče, je enak modremu.
 *
 *  №18 — `next.config.ts` je imel `typescript.ignoreBuildErrors: true`, Vercel pa
 *        deploya ob pushu neodvisno od CI-ja. Trditev »tsc je ločen gate« torej
 *        ni blokirala deploya, ampak ga je samo prehitela.
 *
 *  №21 — `ci.yml` je izpisal prvih šest znakov Neon gesla v log.
 *
 * Testi so razdeljeni v dva razreda:
 *   A — statične pogodbe, prebrane IZ IZVORNIH DATOTEK (ne iz kopije), da razhajanje
 *       med GitHub in GitLab receptom pade tu in ne v produkciji;
 *   B — dinamični dokaz z PRAVIM gitom v temp fixtures: iz workflowa izvlečen
 *       askpass program in izvlečena koraka za zakasnitev zrcala ter push lint
 *       se izvedeta proti dveh lokalnih bare repozitorijev. S tem je dokazano,
 *       da guard za napako RES vrne neničeln izhod — kar je edini pogoj, da
 *       `if: failure()` lahko sploh kaj sproži.
 *
 * Testi ne potrebujejo baze (nič DB fiksur, predpona `c15-` je samo za temp mape).
 */

const P = 'c15-'
const ROOT = process.cwd()
const wfDir = join(ROOT, '.github/workflows')
const WORKFLOWS = ['ci.yml', 'neon-backup.yml', 'prod-smoke.yml', 'sync.yml', 'vercel-ops.yml']
const wfText = (n: string) => readFileSync(join(wfDir, n), 'utf8')
const allWf = () => WORKFLOWS.map(wfText).join('\n')
const gitlabText = () => readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8')
const alarmText = () => readFileSync(join(ROOT, '.github/actions/ci-alarm/action.yml'), 'utf8')

const tmpDirs: string[] = []
function mkTmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `${P}${label}-`))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/* ══════════ pomožne funkcije (line-based, brez neprijavljenih odvisnosti) ══════════ */

/**
 * Izluščene `run: |` vsebine koraka po imenu — z ISTIM odmikom, kot ga bo
 * dobil runner (YAML block scalar odstrani skupno indenacijo). Namen: test
 * izvodi kodo iz workflowa, ne njene replike.
 */
function stepScript(text: string, stepName: string): string {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes(`- name:`) && l.includes(stepName))
  if (at === -1) throw new Error(`korak "${stepName}" ni bil najden`)
  let runAt = -1
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*-\s+name:/.test(l)) break
    if (/^\s*run:\s*\|/.test(l)) {
      runAt = i
      break
    }
  }
  if (runAt === -1) throw new Error(`korak "${stepName}" nima "run: |" bloka`)
  const runIndent = lines[runAt].search(/\S/)
  const body: string[] = []
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      body.push('')
      continue
    }
    const ind = l.search(/\S/)
    if (ind <= runIndent) break
    body.push(l)
  }
  const minIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
  return body.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n') + '\n'

}

/** Vse `runs-on:` vrstice v workflowu. */
const runsOnLines = (text: string) => text.split(/\r?\n/).filter((l) => /^\s*runs-on:/.test(l))

/** Imena jobov (2 presledka pod `jobs:`). */
function jobNames(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const jobsAt = lines.findIndex((l) => l === 'jobs:')
  if (jobsAt === -1) return []
  const out: string[] = []
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (m) out.push(m[1])
  }
  return out
}

/** Job kot besedilo od njegove ključne vrstice do naslednjega enako zamaknjenega ključa. */
function jobBlock(text: string, job: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${job}:`)
  if (start === -1) throw new Error(`job "${job}" ne obstaja`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function runBash(dir: string, scriptPath: string, env: Record<string, string> = {}) {
  try {
    const out = execFileSync('bash', [scriptPath], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/* ══════════════ A. statične pogodbe (№15 №16 №18 №21) ══════════════ */

describe('A1. №15 — runner routing in čista `.git/config`', () => {
  test('vsak job v vseh petih workflowih usmerja prek CI_RUNNER_LABELS', () => {
    for (const n of WORKFLOWS) {
      const lines = runsOnLines(wfText(n))
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(l).toContain('vars.CI_RUNNER_LABELS')
        // hardkodiran hosted runner = prav tisto, kar je ubilo sinhronizacijo
        expect(/runs-on:\s*ubuntu-latest\s*$/.test(l)).toBe(false)
      }
    }
  })

  test('token nikoli ni del git URL-ja (posledica: ne pristane v .git/config)', () => {
    // Pregled se mora nanašati SAMO na izvedljive vrstice. Besedilo najdbe #15
    // (glava sync.yml) vzorec citira kot dokaz — če bi bil deležen pregleda,
    // bi bila razlaga napake hkrati njena kršitev.
    const text = WORKFLOWS.map(wfText)
      .map((t) => t.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n'))
      .join('\n')
    expect(/https:\/\/[^"'\s]*\$\{\{\s*secrets\./.test(text)).toBe(false)
    expect(/oauth2:\$\{\{/.test(text)).toBe(false)
    expect(/https:\/\/oauth2:\$\{GITLAB_TOKEN\}/.test(text)).toBe(false)
    // noben `git remote add` ne sme vsebovati interpolacije secret-a
    const remotes = text.split(/\r?\n/).filter((l) => l.includes('git remote add'))
    expect(remotes.length).toBeGreaterThan(0)
    for (const r of remotes) expect(r).not.toMatch(/:[$]\{/)
    // namesto tega mora biti askpass program
    expect(wfText('sync.yml')).toContain('GIT_ASKPASS')
  })

  test('tagi se ne pushajo več s --force (objavljen tag je neprepisljiv)', () => {
    const tags = stepScript(wfText('sync.yml'), 'Sinhroniziraj tage')
    expect(tags).toContain('refs/tags/*:refs/tags/*')
    // Flag se preverja na vrstici, ki ga more nositi — komentar in sporočilo o
    // napaki oba namerno omenjata `--force` (v pushu ga ni več).
    const pushes = tags.split(/\r?\n/).filter((l) => l.includes('git push') && l.includes('refs/tags/'))
    expect(pushes.length).toBe(1)
    for (const p of pushes) expect(p).not.toContain('--force')
    // obe smeri morata biti postreženi (zanka, ne podvojena vrstica)
    expect(tags).toMatch(/for REM in origin gitlab/)
    // in nasprotje mora vplivati na izhod — sicer je korak zelen brez vsebine
    expect(tags).toContain('exit 1')
  })

  test('secrets scan pregleda tudi .github/ (sicer #15 ne bi bil nikoli ujet)', () => {
    const sh = readFileSync(join(ROOT, 'scripts/check-secrets.sh'), 'utf8')
    const scanLine = sh
      .split(/\r?\n/)
      .find((l) => /\bsrc\/\s+scripts\//.test(l) && !/^\s*#/.test(l))
    expect(scanLine).toBeDefined()
    // .github/ mora biti med skandiranimi POTMI (ne v komentarju ali --include)
    expect(scanLine).toContain('.github/')
    expect(scanLine).toContain('.gitlab-ci.yml')
  })

  test('neuspeh fetcha in neuspeh pusha vplivata na izhod koraka (brez tega alarm ne more ničesar sprožiti)', () => {
    const fetch = stepScript(wfText('sync.yml'), 'Pridobi vsebino z obeh strani')
    expect(fetch).toContain('exit 1')
    expect(fetch).toMatch(/fetched/)
    const push = stepScript(wfText('sync.yml'), 'Zdruzi in poslji vse branche')
    expect(push).toContain('exit 1')
    expect(push).toMatch(/FAILED/)
    // in noben od njih ne more utihniti napake z `|| true` na celem koraku
    expect(/git push (origin|gitlab)[^|]*\|\| true/.test(push)).toBe(false)
  })
})

describe('A2. №16 — vsak job ima dead-man alarm', () => {
  test('vseh sedem jobov pokliče ./.github/actions/ci-alarm z if: failure()', () => {
    let jobs = 0
    for (const n of WORKFLOWS) {
      const text = wfText(n)
      for (const job of jobNames(text)) {
        jobs++
        const block = jobBlock(text, job)
        expect(block).toContain('if: failure()')
        expect(block).toMatch(/uses:\s*\.\/\.github\/actions\/ci-alarm/)
        expect(block).toContain('secrets.GITHUB_TOKEN')
      }
    }
    expect(jobs).toBe(7)
  })

  test('workflowi z alarmom imajo issues: write (brez pravice alarm samo utihni)', () => {
    for (const n of WORKFLOWS) {
      const text = wfText(n)
      if (!text.includes('ci-alarm')) continue
      expect(text).toMatch(/^permissions:\n(?:[^\n]*\n)*?\s*issues: write/m)
    }
  })

  test('alarm korak ne more skriti pravega vzroka (nikoli ne vrne napake)', () => {
    const a = alarmText()
    // zadnji izhodi so vsak || true ali exit 0; ni `set -e` brez izjeme
    expect(a).toContain('state=spodletela')
    expect(a).toContain('$GITHUB_STEP_SUMMARY')
    // dedup: obstoječ issue se dopolni, ne ustvari nov (alarm ne utone v hrupu)
    expect(a).toContain('state=dopolnjena')
    expect(a).toMatch(/\/issues\?state=open&labels=ci-alarm/)
    // dodelitev lastnika = edini signal, ki pride do uporabnika brez Actions zaslona
    expect(a).toMatch(/\/assignees/)
    // v bodyju NE sme biti izsečka loga (№20: log lahko vsebuje PIN-je/zneske)
    expect(a).not.toMatch(/logs?\$\{?{?\s*GITHUB_RUN_ID/)
  })

  test('alarm deluje tudi brez DB in brez zunanjih secretov (samo GITHUB_TOKEN)', () => {
    const inputs = alarmText().split('runs:')[0]
    expect(inputs).toContain('token:')
    expect(inputs).toContain('scope:')
    expect(/required: true/.test(inputs)).toBe(true)
    // noben drug secret ni potreben — repozitorij jih nima (NEON/VERCEL/GITLAB)
    expect(alarmText()).not.toMatch(/secrets\.[A-Z_]+/)
  })
})

describe('A3. №21 — nobeno geslo ne gre v log', () => {
  test('izpis delnega gesla (${X:0:n}) je odstranjen iz vseh workflowov', () => {
    expect(/\$\{[A-Za-z_][A-Za-z0-9_]*:0:\d+\}/.test(allWf())).toBe(false)
    expect(allWf()).not.toContain('role pw:')
  })

  test('geslo se sme poznati samo po dolžini', () => {
    const ci = wfText('ci.yml')
    expect(ci).toContain('${#ROLE_PW} znakov')
    // in gre naprej samo prek GITHUB_ENV (ki ni izpisan v logu)
    expect(ci).toContain('SMOKE_ROLE_PW=$ROLE_PW')
  })
})

describe('A4. №18 — build je zapora pred produkcijo', () => {
  test('v aktivni konfiguraciji ni ignoreBuildErrors (komentar ne steje)', () => {
    const raw = readFileSync(join(ROOT, 'next.config.ts'), 'utf8')
    // Dokumentacija sme imenovati bivso nastavitev (to je razlog, da je test
    // comment-stripped — sicer bi bila sama razlaga kršitev pogodbe).
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('ignoreBuildErrors')
    expect(code).not.toMatch(/typescript:\s*\{/)
    // in komentar MORA obstajati, da se nastavitev ne vrne kot „hitrejši build"
    expect(raw).toContain('ignoreBuildErrors')
    expect(raw).toContain('#18')
  })

  test('tsconfig izpušča tests/, da testna datoteka ne more blokirati deploya', () => {
    const ts = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')
    const excl = ts.split('"exclude"')[1] ?? ''
    expect(excl).toContain('"tests"')
  })
})

describe('A5. tri sistemi morajo izvajata isti proračun (uskladitev GitLab ↔ GitHub)', () => {
  const g = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0])

  /** Ukazi GitHub joba = same vrstice `run:` (imen korakov in komentarjev ne). */
  const ghCommands = (block: string) =>
    block
      .split(/\r?\n/)
      .filter((l) => /^\s*run:(\s*\|)?\s*\S/.test(l))
      .map((l) => l.replace(/^\s*run:(\s*\|)?\s*/, ''))

  /** Ukazi GitLab joba = izpodbjene vrstice pod `script:`. */
  const glCommands = (text: string, job: string) => {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((l) => l === `${job}:`)
    expect(start).toBeGreaterThan(-1)
    const scriptAt = lines.findIndex((l, i) => i > start && /^\s*script:\s*$/.test(l))
    expect(scriptAt).toBeGreaterThan(-1)
    const out: string[] = []
    for (let i = scriptAt + 1; i < lines.length; i++) {
      if (/^[A-Za-z]/.test(lines[i])) break
      const m = lines[i].match(/^\s{4}- (.+)$/)
      if (m) out.push(m[1])
    }
    return out
  }

  const TOKEN = /bun install|prisma db push|tsc --noEmit|run lint|run test|check-secrets|check-schema-drift/
  const tokens = (cmds: string[]) => cmds.map((c) => c.match(TOKEN)?.[0]).filter((x): x is string => !!x)

  test('GitLab quality-gate ima svoj DATABASE_URL in svežo SQLite bazo', () => {
    const gl = gitlabText()
    expect(gl).toMatch(/DATABASE_URL:\s*file:\.\/db\/[A-Za-z0-9._-]+\.db/)
    expect(gl).toContain('bunx prisma db push --schema prisma/schema.sqlite.prisma')
    // GitHub tests job mora imeti ISTA dva koraka
    const ghTests = jobBlock(wfText('ci.yml'), 'tests')
    expect(ghTests).toMatch(/DATABASE_URL: file:.*\.db/)
    expect(ghTests).toContain('bunx prisma db push --schema prisma/schema.sqlite.prisma')
  })

  test('zaporedje ukazov je na obeh sistemih enako (brez GitLab-ovega drift koraka)', () => {
    const gh = tokens(ghCommands(jobBlock(wfText('ci.yml'), 'tests')))
    const gl = tokens(glCommands(gitlabText(), 'quality-gate'))
    // PIN namenskega vrstnega reda. v1.152.0 (№26) je bil vrstni red spremenjen
    // NAMERNO: secrets je bil zadnji korak, zato ga je rdeč tsc zamaskiral —
    // podrobnosti so v komentarju .github/workflows/ci.yml in v skupini B datoteke
    // tests/audit2530-ci-determinism.test.ts. Enakost MED sistemoma (spodaj) je
    // prava varovalka; ta seznam je sidro, da korak ne more tiho izginiti iz OBOJEGA.
    expect(gh).toEqual(['bun install', 'prisma db push', 'check-secrets', 'tsc --noEmit', 'run lint', 'run test'])
    // drift je na GitLabu DODATEN korak (135/135 zrcenje shem), ki ga GitHub
    // pokriva z `neon-smoke` na resnicnem Postgresu — zato se ga tu odsteje
    expect(gl).toContain('check-schema-drift')
    expect(gl.filter((t) => t !== 'check-schema-drift')).toEqual(gh)
    // brez base test ne more teči: db push MORA biti pred testi
    expect(gl.indexOf('prisma db push')).toBeLessThan(gl.indexOf('run test'))
    expect(gh.indexOf('prisma db push')).toBeLessThan(gh.indexOf('run test'))
    // №26: varnostna koraka (drift, secrets) morata teči PRED dragimi gate-i.
    // Če sta zadnja, padec tsc/lint/testov pomeni, da se nista nikoli izvedela —
    // maskiranje je takrat struktura pipeline-a, ne sreča.
    expect(gh.indexOf('check-secrets')).toBeLessThan(gh.indexOf('tsc --noEmit'))
    expect(gl.indexOf('check-schema-drift')).toBeLessThan(gl.indexOf('tsc --noEmit'))
    expect(gl.indexOf('check-secrets')).toBeLessThan(gl.indexOf('tsc --noEmit'))
  })

  test('predpomnik node_modules ne more vrniti klienta, ki ne ustreza URL-ju', () => {
    const gl = gitlabText()
    const prefixes = g(/prefix: [a-z-]+/g, gl)
    expect(prefixes.length).toBe(2)
    expect(new Set(prefixes).size).toBe(2)
  })
})

/* ══════════════ B. dinamični dokaz z pravim gitom ══════════════ */

describe('B1. №15 — askpass program (izvlečen iz sync.yml) dejansko deluje', () => {
  const TOKEN = 'c15-fake-token-NE2KQ'

  const extractAskpass = () => {
    const script = stepScript(wfText('sync.yml'), 'Pripravi dostop do GitLaba')
    const m = script.match(/<<'EOS'\n([\s\S]*?)\n\s*EOS/)
    if (!m) throw new Error('heredoc za askpass ni bil najden v sync.yml')
    return { askpass: m[1], script }
  }

  test('v datoteko je zapisan samo sklic na $GITLAB_TOKEN, ne vrednost', () => {
    const { askpass, script } = extractAskpass()
    expect(askpass).toContain('${GITLAB_TOKEN')
    expect(script).not.toContain(TOKEN)
    expect(wfText('sync.yml')).not.toContain(TOKEN)
  })

  test('Username vpraša vrne oauth2, Password vrne token iz okolja', () => {
    const { askpass } = extractAskpass()
    const dir = mkTmp('askpass')
    const file = join(dir, 'askpass.sh')
    writeFileSync(file, `#!/bin/sh\n${askpass}\n`)
    const env = { GITLAB_TOKEN: TOKEN }
    const user = execFileSync('bash', ['-c', `sh "${file}" "Username for 'https://gitlab.com':"` ], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim()
    const pass = execFileSync('bash', ['-c', `sh "${file}" "Password for 'https://oauth2@gitlab.com':"` ], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim()
    expect(user).toBe('oauth2')
    expect(pass).toBe(TOKEN)
    // 45_000: zunanji procesi (bash + sh) so na Windows daljši od privzetih 5 s
  }, 45_000)

  test('brez tokena program NE vrne praznega gesla (fail-fast, ne tih push)', () => {
    const { askpass } = extractAskpass()
    const dir = mkTmp('askpass-nie')
    const file = join(dir, 'askpass.sh')
    writeFileSync(file, `#!/bin/sh\n${askpass}\n`)
    const r = runBash(dir, file)
    expect(r.code).not.toBe(0)
  }, 45_000)
})

/**
 * №25 (audit okt-2026): GitLab `quality-gate` teče v sliki `oven/bun:1`, kjer `git`
 * NI nameščen (GitHubovi runnerji ga imajo vedno, ker z njim kličejo checkout).
 * Prvih pet testov te skupine je zato v pipeline #57 padlo na
 * `Executable not found in $PATH: "git"` — rdeč gate zaradi orodja, ne zaradi kode
 * (ista družina kot №23). Pogoj za izvedbo je zdaj ekspliciten: skupina se
 * preskoči, skupno število preskočenih je vidno v povzetku `bun test`, ta datoteka
 * pa v log izpiše jasno oznako. Pokritost ostane na GitHub Actions (ista suite,
 * ubuntu runner z gitom) in na vsakem lokalnem teku.
 */
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (!HAS_GIT) console.log('PRESKOCENO-B2: git ni na voljo v tem okolju — skupina B2 (sync guard) se ne izvede; teče na GitHub Actions in lokalno')

describe.skipIf(!HAS_GIT)('B2. №15 — guard za zakasnitev zrcala in fail-loud push (pravi git)', () => {
  /** Dva bare repozitorija + delovna kopija; vrne pot do delovne kopije. */
  function fixture(name: string) {
    const root = mkTmp(name)
    const origin = join(root, 'origin.git')
    const gitlab = join(root, 'gitlab.git')
    const work = join(root, 'work')
    for (const bare of [origin, gitlab]) execFileSync('git', ['init', '--bare', '-q', bare])
    execFileSync('git', ['init', '-q', '-b', 'main', work])
    const git = (args: string[]) =>
      execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'remote', 'add', 'origin', origin])
    git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'remote', 'add', 'gitlab', gitlab])
    writeFileSync(join(work, 'mergesija.txt'), 'prva\n')
    git(['add', '-A'])
    git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'commit', '-q', '-m', 'c15: prva'])
    git(['push', '-q', 'origin', 'main'])
    git(['push', '-q', 'gitlab', 'main'])
    const fetchAll = () => {
      git(['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'])
      git(['fetch', '-q', 'gitlab', '+refs/heads/*:refs/remotes/gitlab/*', '--prune'])
    }
    return { root, origin, gitlab, work, git, fetchAll }
  }

  const runStep = (dir: string, name: string, scriptName: string, env: Record<string, string> = {}) => {
    const file = join(dir, `${scriptName}.sh`)
    // `sleep 12`/`sleep 15` zamenjamo s 50 ms: test trdi izhodno kodo, ne časovanje
    const body = stepScript(wfText(name), scriptName).replace(/sleep (\d+)/g, 'sleep 0.05')
    writeFileSync(file, body)
    return runBash(dir, file, env)
  }

  test('sinhronizirano zrcalo: guard vrne 0', () => {
    const f = fixture('lag-ok')
    f.fetchAll()
    const r = runStep(f.work, 'sync.yml', 'Preveri zakasnitev zrcala')
    expect(r.code).toBe(0)
    expect(r.out).toContain('istem commitu')
  }, 45_000)

  test('zrcalo za en commit zadaj: guard vrne 1 in pove ZA KOLIKO', () => {
    const f = fixture('lag-behind')
    writeFileSync(join(f.work, 'druga.txt'), 'druga\n')
    f.git(['add', '-A'])
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'commit', '-q', '-m', 'c15: druga'])
    f.git(['push', '-q', 'origin', 'main'])
    f.fetchAll()
    const r = runStep(f.work, 'sync.yml', 'Preveri zakasnitev zrcala')
    expect(r.code).toBe(1)
    expect(r.out).toContain('zaostaja za 1 commiti')
  }, 45_000)

  test('push loop: origin naprej → oba remote-a končata na istem commitu, izhod 0', () => {
    const f = fixture('push-ok')
    writeFileSync(join(f.work, 'naprej.txt'), 'x\n')
    f.git(['add', '-A'])
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'commit', '-q', '-m', 'c15: naprej'])
    f.git(['push', '-q', 'origin', 'main'])
    f.git(['update-ref', '-d', 'refs/remotes/gitlab/main'])
    f.fetchAll()
    const r = runStep(f.work, 'sync.yml', 'Zdruzi in poslji vse branche')
    expect(r.code).toBe(0)
    const gh = f.git(['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0]
    const gl = f.git(['ls-remote', 'gitlab', 'refs/heads/main']).split('\t')[0]
    expect(gl).toBe(gh)
  }, 45_000)

  test('push loop: nedostopen GitLab → IZHOD 1 (stari workflow bi bil zelen)', () => {
    const f = fixture('push-broken')
    writeFileSync(join(f.work, 'naprej2.txt'), 'y\n')
    f.git(['add', '-A'])
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'commit', '-q', '-m', 'c15: naprej2'])
    f.git(['push', '-q', 'origin', 'main'])
    f.fetchAll()
    rmSync(f.gitlab, { recursive: true, force: true })
    const r = runStep(f.work, 'sync.yml', 'Zdruzi in poslji vse branche')
    expect(r.code).toBe(1)
    expect(r.out).toContain('nesinhronizirani branchi')
    expect(r.out).toContain('main(push)')
  }, 45_000)

  test('tag za nasprotje: push brez --force ZAVRNE prepis, zrcalo ostane pri starem', () => {
    const f = fixture('tag-conflict')
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'tag', 'v1.0.0-c15'])
    f.git(['push', '-q', 'origin', 'refs/tags/v1.0.0-c15'])
    f.git(['push', '-q', 'gitlab', 'refs/tags/v1.0.0-c15'])
    // na GitHub strani tag premaknemo na nov commit (to je tisto, kar --force stori)
    writeFileSync(join(f.work, 'nov.txt'), 'z\n')
    f.git(['add', '-A'])
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'commit', '-q', '-m', 'c15: nov'])
    f.git(['-c', 'user.name=c15', '-c', 'user.email=c15@test', 'tag', '-f', 'v1.0.0-c15'])
    const before = f.git(['ls-remote', 'gitlab', 'refs/tags/v1.0.0-c15']).split('\t')[0]
    const r = runBash(f.work, (() => {
      const file = join(f.work, 'tagpush.sh')
      writeFileSync(file, 'git push gitlab "refs/tags/*:refs/tags/*" >/dev/null 2>&1\n')
      return file
    })())
    expect(r.code).not.toBe(0)
    const after = f.git(['ls-remote', 'gitlab', 'refs/tags/v1.0.0-c15']).split('\t')[0]
    expect(after).toBe(before)
    // dokaz, da je bila razlika realna (sicer test ne trdi ničesar)
    expect(before).not.toBe(f.git(['rev-parse', 'refs/tags/v1.0.0-c15']).trim())
  }, 45_000)
})
