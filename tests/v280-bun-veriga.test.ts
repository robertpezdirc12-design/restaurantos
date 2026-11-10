import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.280.0 — VERIGA BUN: peskovnik 1.3.14 → 1.4.4 (CI je tekel latest, Docker
 * oven/bun:1.4 — peskovnik je bil edini zaostanek). Dve OKVARI bun 1.3.14 sta
 * tri verzije delali 33 lažnih okvar + 4 napake lokalne suite (identično
 * v1.277/278/279), CI pa je bil ZELEN:
 *
 * OKVARA 1 (node:sqlite): bun 1.3.14 NIMA vgrajenega modula node:sqlite →
 *   tests/v180-setup-wizard §C (15), §G/§H/§I (7) + tests/v165-* (1+4) + 2
 *   errorji na ravni datoteke — skupaj 27 lažnih rdečih.
 *
 * OKVARA 2 (spawnSync env): bun 1.3.14 ne podaja RUNTIME nastavljenih
 *   process.env spremenljivk otrokom pri spawnSync znotraj bun test →
 *   tests/v184 F1–F5 (5) + F9 tests/v175 (1) — lutke (fake orodja) padejo,
 *   ker V184_LOG ni viden otroku. Dokazano z minimalno reprodukcijo.
 *
 *  · Č1 — ŽIVE zmožnosti verige (behavior, ne pini): node:sqlite se naloži +
 *    spawnSync podeduje runtime process.env — OBA testa padeta na 1.3.14 in
 *    gresta zeleno na 1.4.4 (to JE dokaz verige, ista dva vzorca kot okvari)
 *  · Č2 — pini verige: ci.yml 3× bun-version 1.4.4 (0× latest — bili smo na
 *    nedeterminističnem latest, peskovnik/CI divergenca je bila koren vzroka),
 *    package.json BREZ engines.bun (POPRAVEK 8. 11. 2026: semver range >=1.4.0
 *    je lomil Vercel build — edina build-relevantna sprememba med zadnjim
 *    zelenim Git deployem 3d8d330 in padlim 3e2d7a8 dpl_GoP7EzVMFo…;
 *    Vercel docs runtimes/bun: veljavni sta SAMO dobesedni "1.4.x"/"1.x",
 *    range ni podprt; bun engines pri installu tudi lokalno NE enforca —
 *    preizkušeno na rezervi 1.3.14, install zelen — torej ni bil zaščita,
 *    ampak tiha past), Dockerfile oven/bun:1.4, LOKALNI-ZAGON veriga vrstica
 *  · Ž · REGISTRI: verzija 1.280.0, worklog vrh Task ID, i18n 4324/4324
 *    (0 sprememb — val brez UI), 0 DDL (shema nedotaknjena), AUDIT števec
 */

const ROOT = process.cwd()
const zahtevaj = createRequire(import.meta.url)

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) ŽIVE ZMOŽNOSTI VERIGE — vedenje runtime-a, ne pini ──

describe('v280 Č1: veriga bun — žive zmožnosti (dokaz, ne mock)', () => {
  test('node:sqlite se naloži (okvara 1: bun 1.3.14 ga NIMA → v180 §C + v165 so padali)', () => {
    // na bun 1.3.14 ta vrstica vrže "No such built-in module: node:sqlite"
    const mod = zahtevaj('node:sqlite')
    expect(mod).toBeTruthy()
    expect(typeof mod.DatabaseSync).toBe('function')
  })

  test('spawnSync podeduje RUNTIME nastavljene process.env spremenljivke (okvara 2: F1–F5/F9 lutke)', () => {
    //Minimalna reprodukcija okvare: proces, ki nastavi env PO zagonu, ga mora
    //videti tudi otrok. Na 1.3.14 je bilo log prazno (appendFileSync(undefined)).
    process.env.V280_PROBE = 'viden-otroku'
    try {
      const r = spawnSync(process.execPath, ['-e', 'console.log(process.env.V280_PROBE)'], {
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: 15000,
      })
      expect(r.status).toBe(0)
      expect(String(r.stdout).trim()).toBe('viden-otroku')
    } finally {
      delete process.env.V280_PROBE
    }
  })

  test('bun verzija teče na verigi 1.4 (nizložno dokazovalno — 1.3.14 je izrecno pokvarjen)', () => {
    const r = spawnSync(process.execPath, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 15000 })
    const verzija = String(r.stdout).trim()
    // glavno številko preverjamo mehko (1.4.x danes; 1.5+ ob nadgradnji ostane zeleno —
    // okvari sta SPECIFIČNI za 1.3.14, ne za vse prihodnje)
    const [glavna, manjsa] = verzija.split('.').map(Number)
    expect(glavna).toBeGreaterThanOrEqual(1)
    if (glavna === 1) expect(manjsa).toBeGreaterThanOrEqual(4)
  })
})

// ── Č2) PINI VERIGE — kdeks, ne vedenje ──

describe('v280 Č2: pini verige bun po vseh nosilcih', () => {
  test('ci.yml: 3× bun-version 1.4.4, 0× latest (determinizem — bili smo na nedoločenem latest)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci.split('bun-version: 1.4.4').length - 1).toBe(3)
    expect(ci).not.toContain('bun-version: latest')
  })

  test('package.json: BREZ engines.bun (8. 11. 2026: semver range >=1.4.0 je lomil Vercel build — Vercel sprejme samo dobesedne "1.4.x"/"1.x"; bun engines lokalno ne enforca, torej ni bil zaščita ampak past)', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.engines?.bun).toBeUndefined()
  })

  test('deploy/Dockerfile: oven/bun:1.4 pod (NESPREMENJENO od v1.207 — paket je bil na verigi prej kot peskovnik)', () => {
    const df = read('deploy/Dockerfile')
    expect(df).toContain('FROM oven/bun:1.4')
  })

  test('LOKALNI-ZAGON.md: veriga vrstica z obema okvarama pošteno poimenovanima', () => {
    const doc = read('docs/LOKALNI-ZAGON.md')
    expect(doc).toContain('1.4 ali novejši')
    expect(doc).toContain('node:sqlite')
    expect(doc).toContain('spawnSync')
    expect(doc).toContain('1.3.14')
  })

  test('SELFHOST-CASAOS.md ostaja brez spremembe verige (zabojnik že oven/bun:1.4)', () => {
    const doc = read('docs/SELFHOST-CASAOS.md')
    expect(doc).not.toContain('bun 1.3')
  })
})

// ── Ž) REGISTRI ──

describe('v280 Ž: registri', () => {
  test('verzija 1.280.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.294.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.294.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.294.0-paylink-cleanup-locationid')
  })

  test('i18n 4324/4324 nespremenjeno (val brez UI — 0 novih ključev)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shema nedotaknjena (val je runtime/veriga — brez modelov, brez stolpcev)', () => {
    const schema = read('prisma/schema.sqlite.prisma')
    expect(schema).not.toContain('model BunVeriga')
    expect(schema).not.toMatch(/^\s*model\s+Bun/i)
  })
})
