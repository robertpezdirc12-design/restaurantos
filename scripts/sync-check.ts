#!/usr/bin/env bun
/**
 * Task 46: sync-check — detekcija desinka med lokalnim repozitorijem, GitLab
 * mirrorjem in produkcijo + opcionalen samodejni resync.
 *
 * MOTIVACIJA: peskovni rollback je dvakrat (Task 26 in Task 46) povrnil lokalne
 * git refse na star snapshot, medtem ko je bil GitHub/GitLab mirror in produkcija
 * novojevanska. Diagnoza je vsakič vzela časa; ta skripta jo skrajša na sekundo.
 *
 * Uporaba:
 *   bun scripts/sync-check.ts             # poročilo (exit 0 = synced, 1 = desync/infra)
 *   bun scripts/sync-check.ts --fix       # popravi LOCAL BEHIND (fetch + reset --hard origin/main)
 *   bun scripts/sync-check.ts --fix --force  # reset tudi z umazanim working treejem
 *
 * Preverja tri pike (vsaka neodvisno, napaka = null, ne vrže):
 *   local  = git rev-parse HEAD (+ število umazanih datotek)
 *   mirror = git ls-remote origin refs/heads/main
 *   prod   = GET $PROD_URL/api/health → commit (+ version, database)
 *
 * Klasifikacija (classifySync — testirana):
 *   synced      : local == mirror == prod (vsi znani)
 *   local-behind: local != mirror, mirror == prod  → --fix (fetch + reset)
 *   local-ahead : local == prod, mirror zaostaja   → push mirror
 *   diverged    : mirror != prod                   → ročni pregled (kdo je avtoritativa?)
 *   unknown     : katera pika ni dosegljiva        → infra diagnoza
 *
 * Konvencija avtoritativnosti: GitHub main je avtoritativa (Vercel builda iz
 * GitHuba); GitLab mirror je zrcalo istih SHA-jev. Produkcija health commit =
 * dokaz, kaj je realno deployano. sync-check torej ob desinku VEDNO poroča,
 * katera pika zaostaja — ne ugiba.
 */

import { execFileSync } from 'node:child_process'

export type SyncPoint = string | null

export interface SyncState {
  local: SyncPoint
  mirror: SyncPoint
  prod: SyncPoint
  /** Spremembe na SLEDENIH datotekah (blokirajo --fix — reset --hard jih bi izgubil). */
  dirtyTracked: number
  /** Untracked datoteke (reset --hard jih ne poškoduje — ne blokirajo --fix). */
  dirtyUntracked: number
  prodVersion: string | null
  prodDatabase: string | null
}

export type SyncClassification =
  | 'synced'
  | 'local-behind'
  | 'local-ahead'
  | 'diverged'
  | 'unknown'

export interface SyncVerdict {
  state: SyncClassification
  /** Kratek opis stanja za človeka. */
  summary: string
  /** Akcijski koraki (v vrstnem redu), ki jih priporoča skripta. */
  actions: string[]
}

/** Klasifikacija je čista funkcija — testirana v tests/sync-check.test.ts. */
export function classifySync(s: SyncState): SyncVerdict {
  const { local, mirror, prod } = s
  if (local === null || mirror === null || prod === null) {
    const missing = [
      local === null && 'lokalni git',
      mirror === null && 'GitLab mirror',
      prod === null && 'produkcija health',
    ]
      .filter(Boolean)
      .join(' + ')
    return {
      state: 'unknown',
      summary: `nedosegljivo: ${missing} — najprej infra diagnoza`,
      actions: [
        'preveri omrežje/avtentikacijo (git ls-remote origin; curl $PROD_URL/api/health)',
      ],
    }
  }
  if (local === mirror && mirror === prod) {
    return {
      state: 'synced',
      summary: 'vse tri pike na istem commitu',
      actions: [],
    }
  }
  if (local === prod && mirror !== prod) {
    return {
      state: 'local-ahead',
      summary: 'lokalno in produkcija sta novojevanski, GitLab mirror zaostaja',
      actions: ['git push origin main'],
    }
  }
  if (mirror === prod && local !== mirror) {
    return {
      state: 'local-behind',
      summary: 'mirror in produkcija sta novojevanski, lokalni repo zaostaja (typičen peskovni rollback)',
      actions: [
        'git fetch origin',
        'git status --porcelain  # mora biti čist',
        'git reset --hard origin/main  # ali: bun scripts/sync-check.ts --fix',
      ],
    }
  }
  return {
    state: 'diverged',
    summary: 'mirror in produkcija sta na RAZLIČNIH commitih (lokalno sledi mirrorju)',
    actions: [
      'ugotovi, katera pika je avtoritativa (Vercel dashboard → Deployments: kaj je zgradil GitHub?)',
      'če je produkcija naprej: push mirror iz lokalnega + preveri GitHub remote',
      'če je mirror naprej: preveri, zakaj Vercel ni zgradil (GitHub token/App)',
    ],
  }
}

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function readLocal(): { head: SyncPoint; dirtyTracked: number; dirtyUntracked: number } {
  const head = sh('git', ['rev-parse', 'HEAD'])
  const out = sh('git', ['status', '--porcelain']) ?? ''
  let dirtyTracked = 0
  let dirtyUntracked = 0
  for (const line of out.split('\n').filter(Boolean)) {
    if (line.startsWith('??')) dirtyUntracked++
    else dirtyTracked++
  }
  return { head, dirtyTracked, dirtyUntracked }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * GitLab 403 anti-abuse je DOKUMENTIRAN tranzični vzorec (Task 26/44/46):
 * hitra zaporedna klica = 403, retry čez ~30 s uspešen. readMirror zato
 * retry-a z rastnim zamikom (5 s / 15 s) preden vrne null.
 */
async function readMirror(remote: string, attempts = 3): Promise<SyncPoint> {
  for (let i = 0; i < attempts; i++) {
    const out = sh('git', ['ls-remote', remote, 'refs/heads/main'])
    if (out) return out.split('\t')[0]?.trim() || null
    if (i < attempts - 1) {
      const delay = i === 0 ? 5_000 : 15_000
      console.error(`  mirror poskus ${i + 1}/${attempts} nič (403 anti-abuse?) — retry čez ${delay / 1000}s`)
      await sleep(delay)
    }
  }
  return null
}

interface ProdHealth {
  commit: SyncPoint
  version: string | null
  database: string | null
}

async function readProd(baseUrl: string): Promise<ProdHealth> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { commit: null, version: null, database: null }
    const j = (await res.json()) as {
      commit?: string
      version?: string
      database?: string
    }
    return {
      commit: typeof j.commit === 'string' && j.commit ? j.commit : null,
      version: j.version ?? null,
      database: j.database ?? null,
    }
  } catch {
    return { commit: null, version: null, database: null }
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const doFix = argv.includes('--fix')
  const force = argv.includes('--force')
  const remote = argv.find((a) => !a.startsWith('--')) ?? 'origin'
  const prodUrl = process.env.PROD_URL ?? 'https://restaurantos-theta.vercel.app'

  const { head, dirtyTracked, dirtyUntracked } = readLocal()
  const mirror = await readMirror(remote)
  const prod = await readProd(prodUrl)

  const state: SyncState = {
    local: head,
    mirror,
    prod: prod.commit,
    dirtyTracked,
    dirtyUntracked,
    prodVersion: prod.version,
    prodDatabase: prod.database,
  }
  const verdict = classifySync(state)

  console.log('═══ sync-check ═══')
  const dirtyNote = state.dirtyTracked
    ? ` (${state.dirtyTracked} sprememb na sledenih${state.dirtyUntracked ? `, ${state.dirtyUntracked} untracked` : ''})`
    : state.dirtyUntracked
      ? ` (${state.dirtyUntracked} untracked)`
      : ' (čist)'
  console.log(`local  : ${state.local ?? 'NEDOSEGLJIV'}${dirtyNote}`)
  console.log(`mirror : ${state.mirror ?? 'NEDOSEGLJIV'} (${remote})`)
  console.log(`prod   : ${state.prod ?? 'NEDOSEGLJIV'} (v${state.prodVersion ?? '?'}, db: ${state.prodDatabase ?? '?'})`)
  console.log(`stanje : ${verdict.state.toUpperCase()} — ${verdict.summary}`)
  for (const a of verdict.actions) console.log(`  → ${a}`)

  if (doFix && verdict.state === 'local-behind') {
    if (state.dirtyTracked > 0 && !force) {
      console.error(`\n✖ --fix preklican: ${state.dirtyTracked} sprememb na sledenih datotekah. Commitaj/stashaj ali uporabi --force. (Untracked datoteke reset --hard ne poškoduje — ne blokirajo.)`)
      return 1
    }
    console.log('\n--fix: git fetch origin && git reset --hard origin/main')
    const fetched = sh('git', ['fetch', remote])
    if (fetched === null) {
      console.error('✖ fetch ni uspel — preveri dostop do mirrorja')
      return 1
    }
    const after = sh('git', ['reset', '--hard', `${remote}/main`])
    if (after === null) {
      console.error('✖ reset ni uspel')
      return 1
    }
    const now = readLocal()
    console.log(`✔ lokal resetiran na ${now.head} (${now.dirtyTracked} sprememb na sledenih) untracked ostanejo: ${now.dirtyUntracked}`)
    return now.head === state.mirror ? 0 : 1
  }
  if (doFix && verdict.state !== 'local-behind') {
    console.log(`\n--fix ni relevanten za stanje ${verdict.state} — nič ne izvajam`)
  }

  return verdict.state === 'synced' ? 0 : 1
}

if (import.meta.main) {
  process.exit(await main())
}
