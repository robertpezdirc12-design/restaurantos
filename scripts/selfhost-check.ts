#!/usr/bin/env bun
/**
 * OSS-13 (v1.207.0) — pred-let preverba samogostiteljskega paketa.
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md (OSS-13) + docs/SELFHOST-CASAOS.md.
 *
 * Preveri kontrakt KITA na disku (deploy/*) in skladnost oznake slike
 * `restaurantos:x.y.z` z APP_VERSION (src/lib/version.ts — enkratna resnica).
 * 0 omrežja, 0 AI, 0 stranskih učinkov — samo branje + izpis + izhodni koda.
 *
 * Uporaba:
 *   bun scripts/selfhost-check.ts   # exit 0 = paket skladen, 1 = prekrški
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SELFHOST_KIT_FILES,
  composeImageTag,
  validateComposeContract,
  validateDockerfileContract,
  validateEntrypointContract,
  validateEnvExampleContract,
  versionFromModule,
} from '../src/lib/selfhost-kit'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()

interface Check {
  ok: boolean
  message: string
}

function main(): number {
  const checks: Check[] = []

  for (const rel of SELFHOST_KIT_FILES) {
    const p = join(ROOT, rel)
    checks.push({ ok: existsSync(p), message: `datoteka ${rel}` })
  }

  const read = (rel: string): string | null => {
    const p = join(ROOT, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  const dockerfile = read('deploy/Dockerfile')
  if (dockerfile) {
    for (const v of validateDockerfileContract(dockerfile)) checks.push({ ok: false, message: v })
  }

  const compose = read('deploy/docker-compose.yml')
  if (compose) {
    for (const v of validateComposeContract(compose)) checks.push({ ok: false, message: v })
    const tag = composeImageTag(compose)
    if (tag === null) {
      checks.push({ ok: false, message: 'compose: oznaka slike restaurantos:x.y.z ni berljiva' })
    } else {
      checks.push({
        ok: tag === APP_VERSION,
        message: `oznaka slike ${tag} ↔ APP_VERSION ${APP_VERSION}`,
      })
    }
  }

  const entry = read('deploy/docker-entrypoint.sh')
  if (entry) {
    for (const v of validateEntrypointContract(entry)) checks.push({ ok: false, message: v })
    const p = join(ROOT, 'deploy/docker-entrypoint.sh')
    const execBit = (statSync(p).mode & 0o111) !== 0
    checks.push({ ok: execBit, message: 'entrypoint ima izvršilni bit (chmod +x)' })
  }

  const envExample = read('deploy/.env.example')
  if (envExample) {
    for (const v of validateEnvExampleContract(envExample)) checks.push({ ok: false, message: v })
  }

  const versionTs = read('src/lib/version.ts')
  if (versionTs) {
    const v = versionFromModule(versionTs)
    checks.push({ ok: v === APP_VERSION, message: `version.ts bere ${v ?? 'nič'} ↔ izvoz ${APP_VERSION}` })
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('selfhost-check — kontrakt samogostiteljskega paketa')
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.message}`)
  if (failed.length === 0) {
    console.log(`OK — paket skladen (${checks.length} preverb, ciljna verzija ${APP_VERSION}).`)
    return 0
  }
  console.error(`\n${failed.length} prekrškov. Popravi in poženi znova.`)
  return 1
}

process.exit(main())
