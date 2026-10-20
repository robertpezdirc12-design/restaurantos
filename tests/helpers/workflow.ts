import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bralci GitHub workflowov, skupni audit testom (v1.151.0 naprej).
 *
 * `audit1516-ci-hygiene.test.ts` ima svoj zasebni kopiji teh funkcij (izdan je
 * bil kot zaprt release in ga ne preurejam); nove audit datoteke uporabljajo
 * to, da se pravila izvlečanja block scalarjev ne morejo razhajati med dvema
 * testnima datovama.
 */

export const WF_DIR = (root: string) => join(root, '.github/workflows')

export const wfTextAt = (root: string, name: string) => readFileSync(join(WF_DIR(root), name), 'utf8')

/**
 * Izluščena vsebina koraka `run: |` po imenu — z ISTIM odmikom, kot ga dobi
 * runner (YAML block scalar odstrani skupno indenacijo). Namen: test izvodi
 * kodo iz workflowa, ne njene replike.
 */
export function stepScript(text: string, stepName: string): string {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes('- name:') && l.includes(stepName))
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
    if (l.search(/\S/) <= runIndent) break
    body.push(l)
  }
  const minIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
  return body.map((l) => (l.trim() === '' ? '' : l.slice(minIndent))).join('\n') + '\n'
}

/** Vse `runs-on:` vrstice v workflowu. */
export const runsOnLines = (text: string) => text.split(/\r?\n/).filter((l) => /^\s*runs-on:/.test(l))

/**
 * Ali `runs-on:` vrstice DEJANSKO usmerja na hosted runnerja.
 *
 * Odstraniti je treba dve stvari, ki nista odločitev:
 *   (a) komentar — sicer bi `runs-on: ubuntu-latest # utemeljitev` bil
 *       klasificiran kot usmerjen prek spremenljivke in bi se izmika lastni
 *       omejitvi (№15 / №24);
 *   (b) `${{ ... }}` izraz — `vars.CI_RUNNER_LABELS || 'ubuntu-latest'` je
 *       NAMERNI fallback petih delivery workflowov, ne hardcoded izbira.
 * Ostane samo goli literal.
 */
export const usesHostedRunner = (line: string) => {
  const bare = line.replace(/#.*$/, '').replace(/\$\{\{[^}]*\}\}/g, '')
  return /ubuntu-latest/.test(bare)
}

/** Imena jobov (2 presledka pod `jobs:`). */
export function jobNames(text: string): string[] {
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
export function jobBlock(text: string, job: string): string {
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
