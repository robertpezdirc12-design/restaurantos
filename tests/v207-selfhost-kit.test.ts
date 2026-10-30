/**
 * OSS-13 (v1.207.0) — ONE-CLICK PAKIRANJE (Docker/CasaOS za NAS lastnika).
 * docs/GAP-ANALIZA-odprtokodna-konkurenca.md — OrderRestro «one-click install».
 *
 * KONTEKST: lokalni profil (autostart, dnevne kopije, WAL, wizard) je bil že
 * izveden (v1.165–v1.182); analiza v1.199.0 je kot preostanek OSS-13 zapisala
 * »NAS paket NI«. Ta izdaja doda PAKET: deploy/Dockerfile + docker-compose +
 * entrypoint + env pogodba + vodnik, vse nad OBSTOJEČIM `bun run local`
 * (zabojnik izvrši scripts/local-start.ts — nič vzporednih poti zagona).
 *
 * 0 omrežja, 0 AI, 0 novih odvisnosti, 0 DDL, 0 novih rut, 0 fikstur baze
 * (vse preverbe so čiste nizne kontraktnе preverbe + branje datotek).
 *
 * MEJA (poštena): gradnja slike v peskovniku ni izvedljiva (ni Docker
 * daemon) — kontrakt pineže recept in datoteke; sam ukazni nabor je izmerjen
 * vzorec iz local-setup.ts / local-start.ts (dokazano v vsakdanjem teku).
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SELFHOST_IDENTITY_ENV,
  SELFHOST_KIT_FILES,
  SELFHOST_ENV_FLAG_MAP,
  composeImageTag,
  validateComposeContract,
  validateDockerfileContract,
  validateEntrypointContract,
  validateEnvExampleContract,
  versionFromModule,
} from '../src/lib/selfhost-kit'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()
const readRepo = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

/* ── Č1 — čisti sloj: validatorji kontrakta (0 fs) ───────────────────────── */

describe('Č1 — validateDockerfileContract', () => {
  test('sprejme recept z vsemi obveznimi nizi', () => {
    const good = [
      'FROM oven/bun:1.4 AS base',
      'ENV NODE_ENV=production RESTAURANTOS_LOCAL=1',
      'RUN bun install --frozen-lockfile --ignore-scripts',
      'RUN bun node_modules/prisma/build/index.js generate --schema prisma/schema.sqlite.prisma',
      'ENV DATABASE_URL=file:/tmp/build-placeholder.db',
      'RUN bun node_modules/prisma/build/index.js db push --schema prisma/schema.sqlite.prisma --skip-generate',
      'RUN bun node_modules/next/dist/bin/next build',
      'EXPOSE 3000',
      'HEALTHCHECK CMD bun -e "fetch(\'http://127.0.0.1:3000/api/health\')"',
      'USER bun',
      'ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]',
    ].join('\n')
    expect(validateDockerfileContract(good)).toEqual([])
  })

  test('zavrača recept brez ne-root uporabnika in brez zdravstvene sonde', () => {
    const bad = 'FROM oven/bun:1.4\nRUN bun install --frozen-lockfile --ignore-scripts\n'
    const out = validateDockerfileContract(bad)
    expect(out.length).toBeGreaterThan(0)
    expect(out.some((v) => v.includes('USER bun'))).toBe(true)
    expect(out.some((v) => v.includes('HEALTHCHECK'))).toBe(true)
  })

  test('zavrača --https (TLS ni del paketa — CasaOS/obratni posrednik)', () => {
    const sneaky = [
      'FROM oven/bun:1.4',
      'ENV NODE_ENV=production RESTAURANTOS_LOCAL=1',
      'RUN bun install --frozen-lockfile --ignore-scripts',
      'RUN bun node_modules/prisma/build/index.js generate --schema prisma/schema.sqlite.prisma',
      'ENV DATABASE_URL=file:/tmp/x.db',
      'RUN bun node_modules/prisma/build/index.js db push --schema prisma/schema.sqlite.prisma --skip-generate',
      'RUN bun node_modules/next/dist/bin/next build',
      'EXPOSE 3000',
      'HEALTHCHECK CMD true',
      'USER bun',
      'ENTRYPOINT ["bun", "scripts/local-start.ts", "--https"]',
      'LABEL x docker-entrypoint.sh',
    ].join('\n')
    const out = validateDockerfileContract(sneaky)
    expect(out.some((v) => v.includes('prepovedano «--https»'))).toBe(true)
  })
})

describe('Č1 — validateComposeContract', () => {
  test('sprejme compose z eno storitvijo, nosilcem in zdravjem', () => {
    const good = [
      'services:',
      '  restaurantos:',
      '    build:',
      '      context: ..',
      '      dockerfile: deploy/Dockerfile',
      '    image: restaurantos:1.209.0',
      '    restart: unless-stopped',
      '    ports:',
      '      - "3000:3000"',
      '    env_file:',
      '      - .env',
      '    environment:',
      '      - RESTAURANTOS_LOCAL=1',
      '    volumes:',
      '      - restaurantos-data:/data',
    ].join('\n')
    expect(validateComposeContract(good)).toEqual([])
  })

  test('zavrača compose brez nosilca in brez ponovnega zagona', () => {
    const bad = 'services:\n  restaurantos:\n    build:\n      context: ..\n'
    const out = validateComposeContract(bad)
    expect(out.some((v) => v.includes('restaurantos-data:/data'))).toBe(true)
    expect(out.some((v) => v.includes('restart: unless-stopped'))).toBe(true)
  })

  test('zavrača razširjene pravice (privileged)', () => {
    const evil = [
      'services:',
      '  restaurantos:',
      '    build: {}',
      '    image: restaurantos:1.209.0',
      '    privileged: true',
      '    ports: []',
      '    restart: unless-stopped',
      '    environment: ["RESTAURANTOS_LOCAL=1"]',
      '    env_file: [.env]',
      '    volumes: ["restaurantos-data:/data"]',
    ].join('\n')
    expect(validateComposeContract(evil).some((v) => v.includes('privileged'))).toBe(true)
  })
})

describe('Č1 — validateEntrypointContract', () => {
  const base = ['#!/bin/sh', 'set -eu', 'set -- bun scripts/local-start.ts --port 3000 --data-dir /data']

  test('sprejme preslikavo vseh petih spremenljivk identitete', () => {
    const lines = [...base]
    for (const env of SELFHOST_IDENTITY_ENV) {
      lines.push(`if [ -n "\${${env}:-}" ]; then set -- "$@" ${SELFHOST_ENV_FLAG_MAP[env]} "\$${env}"; fi`)
    }
    lines.push('exec "$@"')
    expect(validateEntrypointContract(lines.join('\n'))).toEqual([])
  })

  test('zavrača manjkajočo preslikavo PIN-a in --https prekobolčnost', () => {
    const lines = [...base, 'exec "$@"']
    const out = validateEntrypointContract(lines.join('\n'))
    expect(out.some((v) => v.includes('RESTAURANTOS_OWNER_PIN'))).toBe(true)
    expect(validateEntrypointContract([...lines, '# --https ne smemo posredovati'].join('\n')).some((v) =>
      v.includes('prepovedano «--https»'),
    )).toBe(true)
  })
})

describe('Č1 — validateEnvExampleContract + razčlenjevalniki', () => {
  test('env pogodba brez PIN polja je prekršek', () => {
    const good = SELFHOST_IDENTITY_ENV.map((k) => `${k}=""`).join('\n')
    expect(validateEnvExampleContract(good)).toEqual([])
    const withoutPin = SELFHOST_IDENTITY_ENV.filter((k) => k !== 'RESTAURANTOS_OWNER_PIN')
      .map((k) => `${k}=""`)
      .join('\n')
    const out = validateEnvExampleContract(withoutPin)
    expect(out.length).toBe(1)
    expect(out[0]).toContain('RESTAURANTOS_OWNER_PIN=')
  })

  test('composeImageTag izvleče oznako in prenaša neznano obliko kot null', () => {
    expect(composeImageTag('image: restaurantos:1.207.0')).toBe('1.207.0')
    expect(composeImageTag('image: restaurantos:1.207.0 # sledljivost')).toBe('1.207.0')
    expect(composeImageTag('image: drugo:1.0.0')).toBeNull()
    expect(composeImageTag('')).toBeNull()
  })

  test('versionFromModule bere APP_VERSION izvoza', () => {
    expect(versionFromModule("export const APP_VERSION = '1.207.0'")).toBe('1.207.0')
    expect(versionFromModule('export const APP_VERSION = "1.207.0"')).toBeNull()
    expect(versionFromModule('')).toBeNull()
  })
})

/* ── Č2 — kit na disku: realne datoteke ustreza kontraktu ────────────────── */

describe('Č2 — kit na disku', () => {
  test('vse datoteke paketa obstajajo', () => {
    for (const rel of SELFHOST_KIT_FILES) {
      expect(existsSync(join(ROOT, rel)), `${rel} mora obstajati`).toBe(true)
    }
  })

  test('deploy/Dockerfile ustreza kontraktu', () => {
    expect(validateDockerfileContract(readRepo('deploy/Dockerfile'))).toEqual([])
  })

  test('deploy/docker-compose.yml ustreza kontraktu', () => {
    expect(validateComposeContract(readRepo('deploy/docker-compose.yml'))).toEqual([])
  })

  test('deploy/docker-entrypoint.sh ustreza kontraktu in je izvršljiv', () => {
    expect(validateEntrypointContract(readRepo('deploy/docker-entrypoint.sh'))).toEqual([])
    const mode = statSync(join(ROOT, 'deploy/docker-entrypoint.sh')).mode
    expect((mode & 0o111) !== 0).toBe(true)
  })

  test('deploy/.env.example ustreza pogodbi o identiteti', () => {
    expect(validateEnvExampleContract(readRepo('deploy/.env.example'))).toEqual([])
  })

  test('.dockerignore ločuje vir od odpadka in ohranja deploy pogodbe', () => {
    const di = readRepo('.dockerignore')
    for (const needle of ['node_modules', '.next', '.git', 'db', 'tests', 'deploy/.env', '!deploy/.env.example']) {
      expect(di.includes(needle), `.dockerignore mora vsebovati ${needle}`).toBe(true)
    }
  })

  test('vodnik pokriva CasaOS uvoz, identiteto, kopije in meje', () => {
    const doc = readRepo('docs/SELFHOST-CASAOS.md')
    for (const needle of [
      'docker compose',
      'CasaOS',
      'RESTAURANTOS_OWNER_PIN',
      'restaurantos-data',
      'local-offsite',
      'TLS ni del paketa',
      'selfhost-check',
    ]) {
      expect(doc.includes(needle), `vodnik mora vsebovati «${needle}»`).toBe(true)
    }
  })
})

/* ── Č3 — registri: verzija, GAP, skripta ────────────────────────────────── */

describe('Č3 — registri v1.207.0', () => {
  test('verzija 1.209.0', () => {
    expect(APP_VERSION).toBe('1.209.0')
  })

  test('oznaka slike v compose sledi APP_VERSION (enkratna resnica)', () => {
    const compose = readRepo('deploy/docker-compose.yml')
    expect(composeImageTag(compose)).toBe(APP_VERSION)
  })

  test('GAP dokument: OSS-13 je IZVEDENO @ v1.207.0', () => {
    const doc = readRepo('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(doc).toContain('**IZVEDENO @ v1.207.0**')
    expect(doc).toContain('deploy/Dockerfile')
  })

  test('selfhost-check je zelen (pred-let, exit 0)', () => {
    const r = Bun.spawnSync(['bun', 'scripts/selfhost-check.ts'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(0)
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain(`OK — paket skladen`)
  })
})
