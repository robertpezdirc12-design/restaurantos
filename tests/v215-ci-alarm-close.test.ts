/**
 * v1.215.0 — CI alarm življenjski cikel: SAMODEJNO ZAPIRANJE na zelenem (B-5).
 *
 * Kontekst (merjeno 31. 10. 2026, pred valom): alarm (v1.168.0) je bil
 * ENOSMEREN — odprl/dopolnil issue ob odpovedi, noben korak pa ga NI zaprl,
 * ko je job osedel zelen. Posledica: #86 (typecheck-prod, zelen od v1.211.0),
 * #82 (tests) in #85 (sync) so bili ODPRTI, čeprav so njihovi jobi zeleni —
 * seznam alarmov je bila trajna laž, v kateri so se izgubili pravi alarmi
 * (#78/#80/#81 = Neon kvota/premor, B-4). Quality gate pada na vsakem pushu
 * SAMO zaradi neon-smoke (typecheck-prod + tests sta zeleni na runu #225,
 * izmerjeno prek API-ja).
 *
 * Kontrakt nove akcije .github/actions/ci-alarm-close:
 *  - ob USPEHU joba zapre odprti `[CI alarm]` issue ISTEGA workflowa+scopa
 *    (ista vrata iskanja kot odpiralec: state=open&labels=ci-alarm, primerjava
 *    naslova case-insensitive — simetrija dedupliciranja);
 *  - komentar-dokaz: zelen run link + SHA + poskus; BREZ izsečka loga (№20)
 *    in BREZ žetona (napaka v1.168.0 #2 — hint se je razbil na presledkih);
 *  - NIKOLI ne vrže napake (job je zelen — rdečica bi pokvarila edino sporočilo;
 *    neuspeh = state=spodletela + ::warning::, naslednji zeleni run poskusi znova);
 *  - PRAZEN odgovor GET ≠ prazen seznam: `[]` = uspeh/brez zadetkov (ni-bilo),
 *    prazna vrednost = API je padel 3× → NEZNANO → spodletela (poštenost —
 *    neznanost NI "ni-bilo");
 *  - env-only vrednosti, REST base github.api_url, JSON izključno node,
 *    konfigurabilno spanje (v1.168.0 discipline, prenesene 1:1).
 *
 * Ožičenje: VSAK od 8 jobov z `if: failure()` alarmnim korakom (ci.yml ×3,
 * sync, neon-backup, prod-smoke, vercel-ops, ci-canary) nosi SIMETRIČNI
 * `if: success()` close korak z IDENTIČNIM scopom — naslov issue je sestavljen
 * iz njega, napačen scope bi iskal napačen alarm.
 *
 * Merila:
 *  Č1 akcija: statične pogodbe + vedenjski dokaz proti HTTP stubu (zaprta /
 *     ni-bilo / spodletela matrika, payload komentarja, PATCH zaprtje).
 *  Č2 simetrija življenjskega cikla v 8 jobih + issues: write povsod.
 *  Č3 registri: verzija 1.215.0, TRZNA-VRZELI-2027 B-5 posodobljen, worklog.
 *
 * 0 fikstur baze — sweep ni potreben.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'

const P = 'v215-'
const ACTION = '.github/actions/ci-alarm-close/action.yml'
const CLOSE_STEP = 'Zapri odprti alarm s tem naslovom (dokaz: ta zeleni run)'
const WF_DIR = '.github/workflows'
const WORKFLOWS = ['ci.yml', 'sync.yml', 'neon-backup.yml', 'prod-smoke.yml', 'vercel-ops.yml', 'ci-canary.yml']

/* ══════════ izvleček koraka (ista tehnika kot v168 — izvede KODO) ══════════ */

const yaml = readFileSync(ACTION, 'utf8')
const lines = yaml.split(/\r?\n/)

function stepBounds(stepName: string): { start: number; end: number } {
  const start = lines.findIndex((l) => l.includes('- name:') && l.includes(stepName))
  if (start === -1) throw new Error(`${P} korak "${stepName}" ni v ${ACTION}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** Izluščena vsebina `run: |` z ISTIM odmikom, kot ga dobi runner. */
function stepRun(stepName: string): string {
  const { start, end } = stepBounds(stepName)
  let runAt = -1
  for (let i = start + 1; i < end; i++) {
    if (/^\s*run:\s*\|/.test(lines[i])) {
      runAt = i
      break
    }
  }
  if (runAt === -1) throw new Error(`${P} korak "${stepName}" nima "run: |" bloka`)
  const runIndent = lines[runAt].search(/\S/)
  const body: string[] = []
  for (let i = runAt + 1; i < end; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      body.push('')
      continue
    }
    if (l.search(/\S/) <= runIndent) break
    body.push(l)
  }
  const minIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
  return body.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n') + '\n'
}

/* ══════════ lokalni HTTP stub namesto api.github.com ══════════ */

interface Hit {
  method: string
  url: string
  body: string
}

let server: Server
let base = ''
let hits: Hit[] = []
/** `existing` = odprta issue s tem naslovom; `none` = seznam prazen; `down` = 404 povsod. */
let mode: 'existing' | 'none' | 'down' = 'existing'

const REPO = 'octo/restaurantos'
const WORKFLOW = 'CI — quality gate (neon-smoke + tests)'
const SCOPE = 'typecheck-prod (tsc proti Postgres klientu)'
const TITLE = `[CI alarm] ${WORKFLOW} — ${SCOPE}`

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const url = decodeURIComponent(req.url ?? '')
      hits.push({ method: req.method ?? '', url, body })
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (mode === 'down') return json(404, { message: 'Not Found' })
      if (url.startsWith(`/repos/${REPO}/issues?`)) {
        // uspešen GET: prazen seznam je `[]` (NE-prazen niz) — ključna razlika
        return json(200, mode === 'existing' ? [{ number: 4242, title: TITLE }] : [])
      }
      if (/\/issues\/\d+\/comments$/.test(url) && req.method === 'POST') return json(201, { id: 9 })
      if (/\/issues\/\d+$/.test(url) && req.method === 'PATCH') return json(200, { number: 4242, state: 'closed' })
      return json(404, { message: 'Not Found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server?.close()
})

const tmp = mkdtempSync(join(tmpdir(), `${P}`))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Zažene pravi skript iz action.yml proti stubu; vrne izhod, izpis, GITHUB_OUTPUT in zadetke. */
async function runClose(over: Record<string, string> = {}) {
  hits = []
  const script = stepRun(CLOSE_STEP)
  const file = join(tmp, `close-${Object.keys(over).join('-') || 'base'}.sh`)
  writeFileSync(file, script, 'utf8')
  const outFile = join(tmp, 'github_output')
  writeFileSync(outFile, '', 'utf8')
  const sumFile = join(tmp, 'github_summary')
  writeFileSync(sumFile, '', 'utf8')
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    SCOPE,
    API_BASE: base,
    SERVER_URL: 'https://github.com',
    TOKEN: 'ghs_stub',
    GITHUB_WORKFLOW: WORKFLOW,
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: '41197664510',
    GITHUB_RUN_NUMBER: '225',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: '8f95c86e6ecd2d1ec82deea9a0fe4bf89bbf8509',
    GITHUB_REF_NAME: 'main',
    GITHUB_ACTOR: 'octo',
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: sumFile,
    API_RETRY_SLEEP: '0',
    ...over,
  }
  // spawn (ne execFileSync): stub teče v ISTEM procesu (v168 lekcija).
  return await new Promise<{ code: number; out: string; state: string; summary: string; hits: Hit[] }>((resolve) => {
    const child = spawn('bash', [file], { cwd: tmp, env })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { out += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({
        code: code ?? -1,
        out,
        state: readFileSync(outFile, 'utf8'),
        summary: readFileSync(sumFile, 'utf8'),
        hits: hits.slice(),
      })
    })
  })
}

const hitsOf = (h: Awaited<ReturnType<typeof runClose>>, method: string, suffix: string) =>
  h.hits.filter((x) => x.method === method && x.url.endsWith(suffix))

/* ══════════ Č1 — statične pogodbe (v1.168.0 discipline prenesene) ══════════ */

describe('v1.215.0 — Č1: close korak je izvedljiv in varnejši od svojih prednikov', () => {
  test('ni `${{ }}` vpokov v shell besedilu (vse gre prek env — skript teče lokalno)', () => {
    expect(stepRun(CLOSE_STEP)).not.toContain('${{')
  })

  test('API base je `github.api_url`, ne server_url/api/v3 (404 iz v1.168.0 #1)', () => {
    const { start, end } = stepBounds(CLOSE_STEP)
    const block = lines.slice(start, end).join('\n')
    expect(block).toContain('API_BASE: ${{ github.api_url }}')
    expect(stepRun(CLOSE_STEP)).not.toMatch(/server_url.*\/api\/v3/)
    expect(stepRun(CLOSE_STEP)).toMatch(/API="\$\{API_BASE\}\/repos\/\$\{GITHUB_REPOSITORY\}"/)
  })

  test('payload gradi node, ne python3 (Windows stub iz v1.168.0 #3)', () => {
    const run = stepRun(CLOSE_STEP)
    expect(run).not.toContain('python3')
    expect(run).toContain('node ')
  })

  test('poskusov ne zaspi 54 s v testih: API_RETRY_SLEEP konfigurabilen', () => {
    expect(stepRun(CLOSE_STEP)).toMatch(/API_RETRY_SLEEP:-3/)
  })

  test('inputs: samo token + scope, oba obvezna (brez zunanjih secretov)', () => {
    const inputs = yaml.split('runs:')[0]
    expect(inputs).toContain('token:')
    expect(inputs).toContain('scope:')
    expect((inputs.match(/required: true/g) ?? []).length).toBe(2)
    expect(yaml).not.toMatch(/secrets\.[A-Z_]+/)
  })

  test('naslov išče ISTA vrata kot odpiralec (dedup simetrija — case-insensitive)', () => {
    const run = stepRun(CLOSE_STEP)
    expect(run).toContain('"/issues?state=open&labels=ci-alarm&per_page=100"')
    expect(run).toContain('TITLE="[CI alarm] $GITHUB_WORKFLOW — $SCOPE"')
  })
})

/* ══════════ Č1 — vedenjska dostava zapiranja ══════════ */

describe('v1.215.0 — Č1: zapiranje obstoječega alarmnega issue', () => {
  beforeAll(() => { mode = 'existing' })

  test('komentar z dokazom + PATCH state=closed → state=zaprta, izhod 0', async () => {
    const h = await runClose()
    expect(h.code).toBe(0)
    expect(h.state).toContain('state=zaprta')
    const comment = hitsOf(h, 'POST', '/issues/4242/comments')
    expect(comment.length).toBe(1)
    const patch = hitsOf(h, 'PATCH', '/issues/4242')
    expect(patch.length).toBe(1)
    expect(JSON.parse(patch[0].body)).toEqual({ state: 'closed' })
  })

  test('komentar vsebuje dokaz (run link + SHA + cikel) in NE vsebuje žetona/izsečka loga', async () => {
    const h = await runClose()
    const payload = JSON.parse(hitsOf(h, 'POST', '/issues/4242/comments')[0].body) as { body: string }
    expect(payload.body).toContain('actions/runs/41197664510')
    expect(payload.body).toContain('8f95c86e6ecd2d1ec82deea9a0fe4bf89bbf8509')
    expect(payload.body).toContain('v1.215.0')
    expect(payload.body).toContain('ZELEN')
    // №20 + v1.168.0 #2: brez žetona, brez sledi stuba, brez stack tracev
    expect(payload.body).not.toContain('ghs_stub')
    expect(payload.body).not.toMatch(/at [A-Za-z0-9_]+ \(/)
  })

  test('povzetek koraka zapiše issue + dokaz (viden v run-u brez odpiranja issueja)', async () => {
    const h = await runClose()
    expect(h.summary).toContain('CI alarm zaprt')
    expect(h.summary).toContain('#4242')
    expect(h.summary).toContain('41197664510')
  })
})

describe('v1.215.0 — Č1: brez odprtega alarma → ni-bilo (navadni primer)', () => {
  beforeAll(() => { mode = 'none' })

  test('uspešen prazen seznam `[]` → NIČ POST/PATCH klicev, state=ni-bilo, izhod 0', async () => {
    const h = await runClose()
    expect(h.code).toBe(0)
    expect(h.state).toContain('state=ni-bilo')
    expect(h.hits.filter((x) => x.method !== 'GET').length).toBe(0)
    expect(h.out).not.toContain('::warning::')
  })
})

describe('v1.215.0 — Č1: API nedosegljiv → spodletela (neznanost NI "ni-bilo")', () => {
  beforeAll(() => { mode = 'down' })

  test('prazen odgovor GET (3 padli poskusi) → state=spodletela + opozorilo, izhod 0', async () => {
    const h = await runClose()
    expect(h.code).toBe(0)
    expect(h.state).toContain('state=spodletela')
    expect(h.out).toContain('::warning::')
    expect(h.out).toContain('NEZNANO')
    // ni-bilo bi bila laž: ne ve se, ali alarm obstaja
    expect(h.state).not.toContain('ni-bilo')
  })

  test('korak NIKOLI ne pade (job je zelen — rdečica bi pokvarila sporočilo)', async () => {
    const h = await runClose()
    expect(h.code).toBe(0)
  })
})

/* ══════════ Č2 — simetrija življenjskega cikla v 8 jobih ══════════ */

describe('v1.215.0 — Č2: vsak alarmni job ima SIMETRIČNI close korak', () => {
  const read = (n: string) => readFileSync(join(WF_DIR, n), 'utf8')

  /** Job kot blok od `  job:` do naslednjega enako zamaknjenega ključa (audit1516 tehnika). */
  function jobBlock(text: string, job: string): string {
    const ls = text.split(/\r?\n/)
    const start = ls.findIndex((l) => l === `  ${job}:`)
    if (start === -1) throw new Error(`job "${job}" ne obstaja`)
    let end = ls.length
    for (let i = start + 1; i < ls.length; i++) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(ls[i])) {
        end = i
        break
      }
    }
    return ls.slice(start, end).join('\n')
  }

  function jobNames(text: string): string[] {
    const ls = text.split(/\r?\n/)
    const jobsAt = ls.findIndex((l) => l === 'jobs:')
    if (jobsAt === -1) return []
    const out: string[] = []
    for (let i = jobsAt + 1; i < ls.length; i++) {
      const m = ls[i].match(/^  ([A-Za-z0-9_-]+):\s*$/)
      if (m) out.push(m[1])
    }
    return out
  }

  test('8 jobov: if: failure() alarm ↔ if: success() close z IDENTIČNIM scopom', () => {
    let jobs = 0
    for (const n of WORKFLOWS) {
      const text = read(n)
      for (const job of jobNames(text)) {
        jobs++
        const block = jobBlock(text, job)
        expect(block, `${n}:${job}`).toContain('if: failure()')
        // uses: ci-alarm kot CELA vrstica (ni podnapis ci-alarm-close!)
        expect(block, `${n}:${job}`).toMatch(/uses:\s*\.\/\.github\/actions\/ci-alarm\s*$/m)
        expect(block, `${n}:${job}`).toContain('if: success()')
        expect(block, `${n}:${job}`).toMatch(/uses:\s*\.\/\.github\/actions\/ci-alarm-close\s*$/m)
        expect(block, `${n}:${job}`).toContain('secrets.GITHUB_TOKEN')
        // SCOPE IDENTIČEN v obeh korakih (naslov issue je sestavljen iz njega)
        const scopes = [...block.matchAll(/scope:\s*'([^']+)'/g)].map((m) => m[1])
        expect(scopes, `${n}:${job}`).toHaveLength(2)
        expect(scopes[0], `${n}:${job}`).toBe(scopes[1])
      }
    }
    expect(jobs).toBe(8) // ci ×3, sync, backup, smoke, ops, canary
  })

  test('close korak pride ZA alarmnim (bralni vrstni red: padec prej, okrevanje potem)', () => {
    for (const n of WORKFLOWS) {
      const text = read(n)
      for (const job of jobNames(text)) {
        const block = jobBlock(text, job)
        const alarmAt = block.search(/uses:\s*\.\/\.github\/actions\/ci-alarm\s*$/m)
        const closeAt = block.search(/uses:\s*\.\/\.github\/actions\/ci-alarm-close\s*$/m)
        expect(alarmAt).toBeGreaterThan(-1)
        expect(closeAt).toBeGreaterThan(alarmAt)
      }
    }
  })

  test('workflowi s close korakom imajo issues: write (brez tega zapiranje samo utihni)', () => {
    for (const n of WORKFLOWS) {
      const text = read(n)
      if (!text.includes('ci-alarm-close')) continue
      expect(text).toMatch(/^permissions:\n(?:[^\n]*\n)*?\s*issues: write/m)
    }
  })

  test('audit1516 A2 pin ostaja zadovoljen (7 jobov v petih workflowih brez kanarja)', () => {
    const A1516 = ['ci.yml', 'neon-backup.yml', 'prod-smoke.yml', 'sync.yml', 'vercel-ops.yml']
    let jobs = 0
    for (const n of A1516) {
      const text = read(n)
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
})

/* ══════════ Č3 — registri ══════════ */

describe('v1.215.0 — Č3: registri', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  test('verzija 1.215.0 (toBe + ubežen regex)', async () => {
    const { APP_VERSION } = await import('../src/lib/version')
    expect(APP_VERSION).toBe('1.215.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.215\.0'/)
  })

  test('oznaka slike ↔ APP_VERSION (docker-compose.yml)', async () => {
    const { APP_VERSION } = await import('../src/lib/version')
    const tag = read('deploy/docker-compose.yml').match(/image: restaurantos:([^\s"]+)/)
    expect(tag).not.toBeNull()
    expect((tag as RegExpMatchArray)[1]).toBe(APP_VERSION)
  })

  test('TRZNA-VRZELI-2027 B-5 nosi UREJENO @ v1.215.0 dokaz', () => {
    const t = read('docs/TRZNA-VRZELI-2027.md')
    expect(t).toContain('UREJENO @ v1.215.0')
    expect(t).toContain('ci-alarm-close')
  })

  test('worklog nosi vnos vala', () => {
    const w = read('worklog.md')
    expect(w).toContain('Task ID: v1.215.0-ci-alarm-lifecycle')
  })
})
