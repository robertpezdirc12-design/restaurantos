#!/usr/bin/env bun
/**
 * v1.175.0 — R2b2: zagon lokalnega profila ob prijavi (namestitev in razveljavitev).
 *
 * Suhi tek je privzet in edini, kar ta skripta stori brez izrecne zahteve:
 * `bun run local:autostart` natisne artefakt in ukaze, ne piše in ne registrira.
 * `--install` zapiše artefakt in ga registrira, `--uninstall` registracijo
 * razveljavi; tujega artefakta nobena pot ne prepiše.
 *
 * Ukazi grejejo skozi `spawnSync` z argv nizom brez lupine — pot do repozitorija
 * je uporabniška in z njo lahko polna presledkov, `cmd /c` bi to pokvaril.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AUTOSTART_USAGE,
  applyAutostart,
  applyUninstall,
  autostartInput,
  buildAutostartPlan,
  decodeArtifact,
  encodeArtifact,
  parseAutostartArgs,
  type AutostartPlan,
} from '../src/lib/local-autostart'
import { resolveDataDir } from '../src/lib/local-runtime'

const ROOT = process.cwd()

function izvedi(argv: string[]) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
  if (r.error) return { status: -1, stdout: '', stderr: r.error.message }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function fsZaPlan(plan: AutostartPlan) {
  return {
    run: izvedi,
    exists: (p: string) => existsSync(p),
    readFile: (p: string) => (existsSync(p) ? decodeArtifact(readFileSync(p)) : undefined),
    writeFile: (p: string, vsebina: string) => {
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, encodeArtifact(vsebina, plan.artifactEncoding))
    },
  }
}

let args: ReturnType<typeof parseAutostartArgs>
try {
  args = parseAutostartArgs(process.argv.slice(2))
} catch (err) {
  console.error((err as Error).message)
  process.exit(2)
}

if (args.help) {
  console.log(AUTOSTART_USAGE)
  process.exit(0)
}

const dataDir = args.dataDir ? resolveDataDir({ env: { RESTAURANTOS_DATA_DIR: args.dataDir } }) : resolveDataDir()

const plan = buildAutostartPlan(
  autostartInput({
    platform: os.platform(),
    homeDir: os.homedir(),
    dataDir,
    root: ROOT,
    bunPath: process.execPath,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    // Avtozagonski ukaz mora nositi ISTO podatkovno mapo, absolutno: relativna pot
    // bi se ob prijavi razrešila drugače kot med namestitvijo.
    extraArgs: ['--data-dir', dataDir],
  }),
)

if (args.uninstall) {
  // `--uninstall` je izrecna zahteva, zato tu ni suhega teka; privzeti suhi tek je
  // v veji brez možnosti, kjer se pokaže oboje.
  const res = applyUninstall({ plan, dryRun: false, run: izvedi })
  console.log(res.message)
  process.exit(res.ok ? 0 : 1)
}

const res = applyAutostart({ plan, dryRun: !args.install, ...fsZaPlan(plan) })
if (!args.install) console.log(`\n${plan.artifactContent}`)
console.log(res.message)
if (res.dryRun) console.log('\nNič ni bilo zapisanega in noben ukaz ni zažagan.')
process.exit(res.ok ? 0 : 1)
