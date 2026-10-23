#!/usr/bin/env node
/**
 * CI canary — dead-man za izpad, ki ga `if: failure()` ne more videti
 * (audit okt-2026 №24, v1.151.0).
 *
 * Zakaj obstaja: alarm iz №16 je vezan na to, da se job IZVEDE in napako
 * vrne. Trije načini, kako CI izgine, tega pogoja ne izpolnijo nikoli:
 *   (a) job nikoli ne dobi runnerja (prazna hosted kvota — dokazano pri №15,
 *       kjer je zrcalo mirilo 31 verzij),
 *   (b) workflow datoteka je pokvarjena ali onemogočena, zato run ne nastane,
 *   (c) run ostane `queued`/`in_progress` za vedno,
 *   (d) run se konča kot `cancelled` ali `startup_failure` — tak run sam sebe ne
 *       more alarmirati, ker se ob preklicu njegovi koraki z `if: failure()` ne
 *       izvedejo. Izmerjeno 22.–23. 10. (v1.171.0): trije zaporedni `gitlab-sync`
 *       runi (#42, #43, #44) so končali `cancelled`, canary pa jih je tiho
 *       proglašal za »pokrite z lastnim alarmom« — in je vrnil 0.
 * V vseh štirih primerih je pipeline ne-rdeč in ne-zelen — preprosto nedosegljiv.
 *
 * Kanarija torej ne preverja vsebine gradnje, ampak eno samo dejstvo PER
 * WORKFLOW: za vsak push run na zadnjem commitu velja, da je zaključen z
 * `success` ali z `failure` (slednji ima svoj alarm) — vse ostalo je izpad.
 * Če ga ni ali pa je `cancelled`/`startup_failure`, vrne izhod 1 in s tem sproži
 * `./.github/actions/ci-alarm`.
 *
 * Zaključen `failure` run NAMERNO ostane tih: njegov lastni alarm korak je
 * takrat gotovo tekel, podvajanje pa bi signal samo utopilo v hrup.
 *
 * Poganja ga `node` (ne `bun`), ker na hosted runnerju bun ni nameščen.
 * Testni režim: CANARY_COMMITS_FILE / CANARY_RUNS_FILE prebereta JSON odziva
 * z diska, da lahko test presoji vsak izid brez mreže in brez žetona.
 */
import { readFileSync, appendFileSync } from 'node:fs'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY || ''
const TOKEN = process.env.GITHUB_TOKEN || ''
const BRANCH = process.env.CANARY_BRANCH || 'main'
const STALL_MIN = Number(process.env.CANARY_STALL_MINUTES || 20)
const NOW_MS = process.env.CANARY_NOW_EPOCH ? Number(process.env.CANARY_NOW_EPOCH) * 1000 : Date.now()
const SUMMARY = process.env.GITHUB_STEP_SUMMARY || ''

function say(line) {
  console.log(line)
  if (SUMMARY) {
    try {
      appendFileSync(SUMMARY, `${line}\n`)
    } catch {
      // povzetek je dodaten dokaz, nikoli pogoj za odločitev
    }
  }
}

function alarm(msg) {
  say(`ALARM: ${msg}`)
  process.exit(1)
}

async function getJson(endpoint, fixtureEnv, label) {
  const fixture = process.env[fixtureEnv]
  if (fixture) {
    let raw
    try {
      raw = readFileSync(fixture, 'utf8')
    } catch {
      alarm(`odziva API-ja (${label}) v testnem režimu ni bilo mogoče prebrati: ${fixture}`)
    }
    try {
      return JSON.parse(raw)
    } catch {
      alarm(`odziv API-ja (${label}) v testnem režimu ni veljaven JSON: ${fixture}`)
    }
  }
  if (!REPO || !TOKEN) {
    alarm(`manjka GITHUB_REPOSITORY ali GITHUB_TOKEN, testni datoteki pa nista nastavljeni (${fixtureEnv})`)
  }
  let res
  try {
    res = await fetch(`${API}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'restaurantos-ci-canary',
      },
    })
  } catch (e) {
    alarm(`API klic (${label}) ni mogel biti izveden: ${e.message}`)
  }
  if (!res.ok) alarm(`API klic (${label}) vrnil status ${res.status}`)
  return res.json()
}

const commits = await getJson(`/repos/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&per_page=1`, 'CANARY_COMMITS_FILE', 'commits')
/* Glava veje JE SEZNAM, ne posamezen zapis: `/commits?sha=…` vrne `[{ sha, … }]`.
 * Izmerjeno 23. 10. (`gh api … --jq 'type'` → `array`); neobstoječa veja vrne
 * HTTP 404, ne praznega seznama. Neposredno `commits.sha` je bila sedma luknja:
 * na seznamu je vedno `undefined`, zato je canary na vsakem načrtovanem runu
 * javil »prazen odgovor« — odgovor pa prazen nikoli ni bil. */
const head = Array.isArray(commits) ? commits[0]?.sha : undefined
if (!head) {
  const oblika = Array.isArray(commits) ? `seznam z ${commits.length} elementov` : `odgovor tipa ${typeof commits} namesto seznam-a`
  alarm(`zadnjega commita na veji ${BRANCH} ni bilo mogoče določiti: /commits je vrnil ${oblika}`)
}

const runs = await getJson(
  `/repos/${REPO}/actions/runs?branch=${encodeURIComponent(BRANCH)}&event=push&per_page=30`,
  'CANARY_RUNS_FILE',
  'actions/runs',
)
const list = runs && Array.isArray(runs.workflow_runs) ? runs.workflow_runs : null
if (!list) alarm('odziv /actions/runs nima polja workflow_runs — oblika API-ja se je spremenila')
if (list.length === 0) alarm(`na veji ${BRANCH} ni nobenega zabeleženega push runa — CI nikoli ni tekel`)

const mine = list.filter((r) => r.head_sha === head)
if (mine.length === 0) {
  alarm(
    `zadnji commit ${String(head).slice(0, 7)} na veji ${BRANCH} nima nobenega CI runa ` +
      `(workflow je onemogočen, pokvarjen, ali job nikoli ni dobil runnerja)`,
  )
}

const byCreated = (a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a)
/** Pravi API odgovor ima `run_number`; `number` je samo v starejših fixturah. */
const runNo = (r) => r.run_number ?? r.number
const open = mine.filter((r) => r.status !== 'completed')

if (open.length > 0) {
  const oldest = open.reduce((a, b) => (Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b))
  const ageMin = Math.floor((NOW_MS - Date.parse(oldest.created_at)) / 60000)
  if (ageMin > STALL_MIN) {
    alarm(
      `run #${runNo(oldest)} (status: ${oldest.status}) čaka ali teče že ${ageMin} min ` +
        `— najverjetneje ni dobil runnerja (prazna hosted kvota ali nedosegljiv self-hosted)`,
    )
  }
  say(`OK: run #${runNo(oldest)} je še v teku (${ageMin} min, prag ${STALL_MIN} min)`)
  process.exit(0)
}

/* Odločitev je PER WORKFLOW, ne po enem samem najnovejšem runu.
 * Razlog, izmerjen 22.–23. 10.: na tipu je bil zelen `ci.yml`, `sync.yml` pa je
 * vsakič končal `cancelled`, ker ga je v `concurrency` skupini držal zablokiran
 * `queued` job. En `cancelled` run ne more alarmirati sam sebe — njegovi koraki
 * z `if: failure()` se na preklicanem runu ne izvedejo nikoli — zato sme biti
 * tih samo zaključen run, ki je dejansko tekel: `success` ali `failure`. */
const SELF_ALARMING = new Set(['success', 'failure'])

const newestPerWorkflow = new Map()
for (const r of mine) {
  const key = r.name || String(r.workflow_id ?? 'neimenovan')
  const prev = newestPerWorkflow.get(key)
  if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) {
    newestPerWorkflow.set(key, r)
  }
}

const unable = [...newestPerWorkflow.values()].filter((r) => !SELF_ALARMING.has(r.conclusion))
if (unable.length > 0) {
  const w = unable.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a))
  alarm(
    `run #${runNo(w)} (workflow: ${w.name || 'neimenovan'}) je zaključen z '${w.conclusion}' — tak run ` +
      `ne izvede svojih 'if: failure()' korakov, zato njegov lastni alarm nikoli ne zaživi. ` +
      `Najverjetnejši vzrok je concurrency skupina, ki jo drži job v 'queued' stanju ` +
      `(cancel-in-progress: false); diagnostic: gh api 'repos/<repo>/actions/runs?status=queued' in nato ` +
      `preveri jobs posameznega runa.`,
  )
}

const failed = [...newestPerWorkflow.values()].filter((r) => r.conclusion === 'failure')
if (failed.length > 0) {
  const f = failed.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a))
  say(`OK (tih): run #${runNo(f)} (workflow: ${f.name || 'neimenovan'}) je zaključen z failure — njegov lastni alarm ga že pokriva, canary ne sme podvajati`)
  process.exit(0)
}
say(
  `OK: zadnji commit na veji ${BRANCH} ima zaključen uspešen run za vsak od ${newestPerWorkflow.size} workflowov na tipu: ` +
    [...newestPerWorkflow.values()].map((r) => `#${runNo(r)} (${r.name || 'neimenovan'})`).join(', '),
)
