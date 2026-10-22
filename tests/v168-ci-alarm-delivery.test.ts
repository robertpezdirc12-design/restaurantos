/**
 * v1.168.0 — dead-man alarm mora DOSTOPITI prejemnika, ne samo naznaniti napake.
 *
 * Najdba (22. 10. 2026): canary (№24, v1.151.0) je pravilno zaznal zataknjen CI
 * (6 zaporednih `failure`), alarmni korak pa je kljub temu vrnil `success` in NI
 * ustvaril NITI ene issue — `gh issue list --state all` nima nobene `[CI alarm]`
 * vrstice od izdaje naprej. Razlog: `API="${{ github.server_url }}/api/v3/..."`
 * (izmerjeno: 404; pravilen base je `github.api_url` → 200), `api()` pa uporablja
 * `curl -f`, zato vsak poziv padel in korak je tiho odšel na `state=spodletela`.
 * Drugi defekt: `${{ inputs.hint }}` se v shell besedilo presedeke dobesedno, hint
 * pa vsebuje narekovaje → `line 5: [: too many arguments` (run 39742241206) in
 * ključno navodilo izgine iz povzetka in bodyja.
 *
 * Zakaj test IZVAJA skript in ne samo bere datoteko: dokler so `${{ }}` vpoki v
 * shellu, skripta lokalno sploh ni mogoče pognati (manjkajo Actions konteksti),
 * zato ga dosedanji statični pin (audit1516 A2) ni mogel izvesti — in je zato
 * napako spregledal. Ko so vrednosti podane prek `env`, je izvleček iz
 * action.yml neposredno izvedljiv: test preveri DOGAJ (pravi HTTP pozivi, pravi
 * JSON, pravi izhod), ne oblike.
 *
 * `python3` se namenoma NE uporablja nigoli v pogodbi: na Windows je to stub
 * (WindowsApps), ki izpiše "Python ni bilo mogoče najti" in vrne 0 — tiho
 * zgradil bi prazen payload. `node` je edini upoštevan JSON gradnik.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'

const P = 'v168-'
const ACTION = '.github/actions/ci-alarm/action.yml'
const ALARM_STEP = 'Odprej ali dopolni issue s tremi vztrajnimi poskusi'
const SUMMARY_STEP = 'Povzetek koraka (veden takoj, tudi brez API-ja)'

/* ══════════ izvleček koraka (ista tehnika kot audit1516: izvede KODO, ne replike) ══════════ */

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

/** Celoten YAML blok koraka (od `- name:` do naslednjega koraka). */
function stepBlock(stepName: string): string {
  const { start, end } = stepBounds(stepName)
  return lines.slice(start, end).join('\n')
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
/** `ok` = navaden uspeh, `existing` = že odprta issue, `down` = sam 404 (pokvarjen base URL). */
let mode: 'ok' | 'existing' | 'down' = 'ok'

const REPO = 'octo/restaurantos'
const OWNER = 'octo'
const WORKFLOW = 'CI canary (dead-man za run-e, ki se nikoli ne začnejo)'
const SCOPE = 'canary: main nima zaključenega CI runa'
const JOB = 'canary'
/** Kopija pravicega hinta — z narekovaji in oklepaji, ki so razbili prejšnjo različico. */
const HINT =
  'Najprej preveri (1) ali so self-hosted runnerji živi, (2) ali hosted kvota ni izčrpana (iz №15: isti znak je bil "no runner could be assigned"), (3) ali je ci.yml veljaven YAML.'
/** Naslov mora biti sestavljen enako kot v akciji; če se format spremeni, dedup test glasno pade. */
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
      if (url.endsWith('/labels') && req.method === 'POST') return json(201, { name: 'ci-alarm' })
      if (url.startsWith(`/repos/${REPO}/issues?`)) {
        return json(200, mode === 'existing' ? [{ number: 4242, title: TITLE }] : [])
      }
      if (url.endsWith(`/repos/${REPO}/issues`) && req.method === 'POST') return json(201, { number: 999 })
      if (/\/issues\/\d+\/comments$/.test(url) && req.method === 'POST') return json(201, { id: 7 })
      if (/\/issues\/\d+\/assignees$/.test(url) && req.method === 'POST') return json(200, { assignees: [OWNER] })
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

/** Zažene pravi skript iz action.yml proti stubu; vrne izhodno kodo, izpis in GITHUB_OUTPUT. */
async function runAlarm(over: Record<string, string> = {}) {
  hits = []
  const script = stepRun(ALARM_STEP)
  const file = join(tmp, `alarm-${Object.keys(over).join('-') || 'base'}.sh`)
  writeFileSync(file, script, 'utf8')
  const outFile = join(tmp, 'github_output')
  writeFileSync(outFile, '', 'utf8')
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    SCOPE,
    HINT,
    JOB,
    API_BASE: base,
    SERVER_URL: 'https://github.com',
    RUNNER_NAME: 'stub-runner',
    RUNNER_OS: 'Linux',
    TOKEN: 'ghs_stub',
    // Actions jih nastavi sam — test jih samo oponaša:
    GITHUB_WORKFLOW: WORKFLOW,
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_OWNER: OWNER,
    GITHUB_RUN_ID: '39742241206',
    GITHUB_RUN_NUMBER: '10',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'a95583e6615ff7328b79a8e73ba7b9ceec0eb9e7',
    GITHUB_REF_NAME: 'main',
    GITHUB_ACTOR: OWNER,
    GITHUB_OUTPUT: outFile,
    API_RETRY_SLEEP: '0',
    ...over,
  }
  // `spawn` in ne `execFileSync`: HTTP stub teče v ISTEM procesu, a
  // execFileSync blokira event loop → curl bi čakal na odgovor, ki ga
  // blokiran loop nikoli ne postreže. Test bi visel namesto padel.
  return await new Promise<{ code: number; out: string; state: string; hits: Hit[] }>((resolve) => {
    const child = spawn('bash', [file], { cwd: tmp, env })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d })
    child.stderr.on('data', (d: Buffer) => { out += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code: code ?? -1, out, state: readFileSync(outFile, 'utf8'), hits: hits.slice() })
    })
  })
}

const post = (h: Awaited<ReturnType<typeof runAlarm>>, suffix: string) =>
  h.hits.filter((x) => x.method === 'POST' && x.url.endsWith(suffix))

/* ══════════ 1. statični pogoj, ki omogoča izvedbo ══════════ */

describe('v1.168.0 — alarmni korak je izvedljiv in uporablja pravi API base', () => {
  test('v obeh korakih ni `${{ }}` vpokov v shell besedilo (vse gre prek env)', () => {
    for (const step of [ALARM_STEP, SUMMARY_STEP]) {
      expect(stepRun(step)).not.toContain('${{')
    }
  })

  test('API base je `github.api_url`, NE `github.server_url`/api/v3 (ta vrne 404)', () => {
    const block = stepBlock(ALARM_STEP)
    expect(block).toContain('API_BASE: ${{ github.api_url }}')
    expect(stepRun(ALARM_STEP)).not.toMatch(/server_url.*\/api\/v3/)
    expect(stepRun(ALARM_STEP)).toMatch(/API="\$\{API_BASE\}\/repos\/\$\{GITHUB_REPOSITORY\}"/)
  })

  test('payloada gradita node, ne python3 (na Windows je stub, ki vrne 0 in izpiše napako)', () => {
    const run = stepRun(ALARM_STEP)
    expect(run).not.toContain('python3')
    expect(run).toContain('node ')
  })

  test('poskusov ne zaspi 54 s v testih: spanje je konfigurabilno, privzeto nespremenjeno', () => {
    const run = stepRun(ALARM_STEP)
    expect(run).toMatch(/API_RETRY_SLEEP:-3/)
  })
})

/* ══════════ 2. vedenostna dostava ══════════ */

describe('v1.168.0 — dostava alarmne issue', () => {
  beforeAll(() => {
    mode = 'ok'
  })

  test('odpre issue z naslovom, labelo in hintom, ki preživi narekovaje', async () => {
    const h = await runAlarm()
    expect(h.code).toBe(0)
    const created = post(h, `/repos/${REPO}/issues`)
    expect(created.length).toBe(1)
    const payload = JSON.parse(created[0].body) as { title: string; body: string; labels: string[] }
    expect(payload.title).toBe(TITLE)
    expect(payload.labels).toEqual(['ci-alarm'])
    // KLJUČNO: prav tu je prejšnja različica tiho izgubila navodilo.
    expect(payload.body).toContain('"no runner could be assigned"')
    expect(payload.body).toContain('najprej preveri')
    expect(h.state).toContain('state=odprta')
  })

  test('issue je dodeljena lastniku — edini signal, ki pride do njega brez Actions zaslona', async () => {
    const h = await runAlarm()
    const assigned = post(h, '/issues/999/assignees')
    expect(assigned.length).toBe(1)
    expect(JSON.parse(assigned[0].body)).toEqual({ assignees: [OWNER] })
  })

  test('v bodyju ni izsečka loga (№20: log lahko vsebuje PIN-je in zneske)', async () => {
    const h = await runAlarm()
    const created = post(h, `/repos/${REPO}/issues`)
    const payload = JSON.parse(created[0].body) as { body: string }
    expect(payload.body).not.toMatch(/at [A-Za-z0-9_]+ \(/)
    expect(payload.body).not.toContain('ghs_stub')
  })

  test('ob že odprti isti issue se pripne komentar, ne druge issue', async () => {
    mode = 'existing'
    try {
      const h = await runAlarm()
      expect(post(h, `/repos/${REPO}/issues`).length).toBe(0)
      expect(post(h, '/issues/4242/comments').length).toBe(1)
      expect(h.state).toContain('state=dopolnjena')
    } finally {
      mode = 'ok'
    }
  })

  test('če API ne odgovori, korak NE uspe in ne prekrije pravega vzroka (exit 0 + spodletela)', async () => {
    mode = 'down'
    try {
      const h = await runAlarm()
      expect(h.code).toBe(0)
      expect(h.state).toContain('state=spodletela')
      expect(h.out).toContain('::warning::')
      expect(post(h, `/repos/${REPO}/issues`).length).toBeGreaterThan(0) // poskusil je (3 poskusi), a ni uspel
    } finally {
      mode = 'ok'
    }
  })
})
