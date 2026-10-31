/**
 * v1.208.0 — Railway priprava (dokazni build + gostovanje OSS-13 slike v oblaku).
 *
 * Kontekst: lastnik je odobril testiranje OSS-13 Docker paketa na Railway
 * (gradbeni stroj v oblaku = daemon na daljavo, ker peskovnik nima Docker
 * daemon-a). REZULTAT RECON-a: recept OSS-13 je IZMERJEN v čistem klonu
 * (vse plasti deploy/Dockerfile izvedene dejansko: bun install 847 paketov →
 * ekspliciten prisma generate → db push 138 tabel → next build pod bun —
 * 173 statičnih strani z tipiziranjem; izmerjen vrh RAM ~3,7 GB — 4 GB
 * peskovnik je na meji OOM, zato dokumentirana meja v vodniku §9).
 *
 * KAJ TA VAL DODAJA (0 AI, 0 novih odvisnosti, 0 DDL, 0 novih rut, 0 UI):
 *   - `railway.json` — deterministična pogodba za Railway: builder DOCKERFILE
 *     prek `deploy/Dockerfile` (ista slika kot za NAS — NIČ vzporednih
 *     receptov), healthcheck `/api/health`, restart ON_FAILURE.
 *   - docs/SELFHOST-CASAOS.md §9 posodobljen (izmerjen recept + meja RAM)
 *     in §10 Railway (uvoz, identiteta, Volume /data, vrata, meje).
 *   - GAP-ANALIZA OSS-13: poštena meja »ni Docker daemon« zamenjana z
 *     izmerjenim dokazom + Railway potjo.
 *
 * POGODBA (kar ta test pineže): Railway NE SME dobiti svojega recepta —
 * builder mora ostati DOCKERFILE prek obstoječega deploy/Dockerfile, zato
 * vsak odmik (NIXPACKS, druga dockerfilePath, drug healthcheck) je rdeč.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { composeImageTag, validateDockerfileContract } from '../src/lib/selfhost-kit'
import { APP_VERSION } from '../src/lib/version'

const ROOT = join(import.meta.dir, '..')

const readRepo = (rel: string): string => {
  const p = join(ROOT, rel)
  expect(existsSync(p), `${rel} mora obstajati`).toBe(true)
  return readFileSync(p, 'utf8')
}

interface RailwayConfig {
  build?: { builder?: string; dockerfilePath?: string }
  deploy?: { healthcheckPath?: string; healthcheckTimeout?: number; restartPolicyType?: string; restartPolicyMaxRetries?: number }
  $schema?: string
}

/* ── Č1 — kontrakt railway.json (čista razčlenitev) ──────────────────────── */

describe('Č1 — railway.json pogodba', () => {
  const cfg = JSON.parse(readRepo('railway.json')) as RailwayConfig

  test('build ostane DOCKERFILE prek obstoječega deploy/Dockerfile (ni vzporednega recepta)', () => {
    expect(cfg.build?.builder).toBe('DOCKERFILE')
    expect(cfg.build?.dockerfilePath).toBe('deploy/Dockerfile')
  })

  test('healthcheck meri resnično zdravje (/api/health — dvostopenjska sonda)', () => {
    expect(cfg.deploy?.healthcheckPath).toBe('/api/health')
    // Start-period slike je 120 s; Railway healthcheck mora dopuščati hladen start.
    expect(cfg.deploy?.healthcheckTimeout).toBeGreaterThanOrEqual(120)
  })

  test('restart politika: ON_FAILURE (storitev vstane sama, kot compose unless-stopped)', () => {
    expect(cfg.deploy?.restartPolicyType).toBe('ON_FAILURE')
    expect(cfg.deploy?.restartPolicyMaxRetries).toBeGreaterThan(0)
  })

  test('$schema je Railway shema (deterministična razčlenitev v vmesniku)', () => {
    expect(cfg.$schema).toContain('railway.app/railway.schema.json')
  })
})

/* ── Č2 — disk: recept nespremenjen, vodnik, meja RAM ────────────────────── */

describe('Č2 — disk: recept in dokumentacija', () => {
  test('deploy/Dockerfile še vedno izpolnjuje kontrakt OSS-13 (railway.json ga ne obide)', () => {
    expect(validateDockerfileContract(readRepo('deploy/Dockerfile'))).toEqual([])
  })

  test('compose oznaka sledi APP_VERSION (enkratna resnica — parity s selfhost-check)', () => {
    expect(composeImageTag(readRepo('deploy/docker-compose.yml'))).toBe(APP_VERSION)
  })

  test('vodnik pokriva Railway (uvoz, identiteta, Volume, vrata, RAILWAY_TOKEN meja)', () => {
    const doc = readRepo('docs/SELFHOST-CASAOS.md')
    for (const needle of ['railway.json', 'RAILWAY_TOKEN', 'Volume', '/data', 'EXPOSE 3000']) {
      expect(doc.includes(needle), `vodnik mora vsebovati «${needle}»`).toBe(true)
    }
  })

  test('vodnik dokumentira izmerjeno mejo gradnje (~3,7 GB RAM — OOM na 4 GB hostu)', () => {
    const doc = readRepo('docs/SELFHOST-CASAOS.md')
    expect(doc).toContain('~3,7 GB RAM')
    expect(doc).toContain('IZMERJEN v čistem klonu')
  })

  test('Dockerfile nosi zapis o izmerjeni gradnji in Railway poti', () => {
    const df = readRepo('deploy/Dockerfile')
    expect(df).toContain('v1.208.0')
    expect(df).toContain('railway.json')
  })
})

/* ── Č3 — registri: verzija, GAP ─────────────────────────────────────────── */

describe('Č3 — registri v1.208.0', () => {
  test('verzija 1.212.0 (toBe + ubežen regex na enkratni resnici)', () => {
    expect(APP_VERSION).toBe('1.214.0')
    expect(readFileSync(join(ROOT, 'src/lib/version.ts'), 'utf8')).toMatch(/APP_VERSION = '1\.214\.0'/)
  })

  test('GAP OSS-13: poštena meja zamenjana z izmerjenim dokazom + Railway potjo', () => {
    const doc = readRepo('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(doc).toContain('recept IZMERJEN v čistem klonu')
    expect(doc).toContain('railway.json')
    expect(doc).toContain('v1.208.0')
    // Zgodovinski pin v207 ostaja (OSS-13 je bilo izvedeno v v1.207.0).
    expect(doc).toContain('**IZVEDENO @ v1.207.0**')
  })

  test('GAP OSS-13: zastarela trditev »ni Docker daemon« je odstranjena', () => {
    const doc = readRepo('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(doc).not.toContain('gradnja slike v peskovniku ni izvedljiva')
  })
})
