import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * v1.154.0 — varnostna nadgradnja odvisnosti (OSV pregled, 20. 10. 2026).
 *
 * Izhodišče: `next@16.1.3` je imel 38 OSV najdb, med njimi DVE CRITICAL
 * neavtenticirani RCE napadi (GHSA-2xp9-vwfh-vxw4 — optimizacija slik/AVIF;
 * GHSA-p293-qw3h-jr36 — strežniki na Windowsih). `sharp@0.34.5` je imel tri
 * HIGH najdbe v knjižnicah libvips/libheif/librsvg. Poleg tega so tri
 * neuporabljene neposredne odvisnosti vlekle svoje: `next-auth@4.24.13`
 * (CRITICAL GHSA-7rqj-j65f-68wh), `next-intl@4.7.0` (odprta preusmeritev),
 * `uuid@11.1.0` (GHSA-w5hq-g745-h8pq).
 *
 * Popravek ni „posodobi na najnovejše“, ampak NADGRADNJA Z DOKAZOM
 * (izmerjeno pred in po; po nadgradnji na 827 paketih ostanejo 4 HIGH):
 *   next 16.4.2   (spodnja meja 16.3.8 — najvišja meja med vsemi najdbami),
 *   sharp 0.35.5  (spodnja meja enaka popravku librsvg),
 *   odstranjeni next-auth / next-intl / uuid,
 *   override js-yaml 4.3.2 (GHSA-2883-xcg3-v3hh in še tri, vse nad 4.3.1),
 *   override eslint-plugin-react-hooks — od v1.154.0 (7.0.1, ker je 7.1.1
 *   vklopil React Compiler pravila in 73 napak lint-a) do v1.198.0, ko je
 *   N-27-4 refaktor (96 najdb @ 7.1.1, glej tests/v198-react-hooks-compiler.test.ts)
 *   opravil in pin dvignil na 7.1.1.
 *
 * Preostale najdbe so sprejete z zapisano utemeljitvijo (test skupina D):
 * braces 3.0.3 (ni popravka), deepmerge-ts 7.1.5 in effect 3.18.4 (exact pin
 * @prisma/config, samo build-time), node-forge 1.4.0 (samo PKCS#12 branje).
 *
 * Test zaklene STANJE, ki je bilo izmerjeno z OSV: če kdo v prihodnje spusti
 * različico pod mejo, doda nazaj odstranjen paket ali v lockfile pripelje
 * drug byte kot package.json, pade tukaj in ne v produkciji.
 */

const ROOT = join(import.meta.dir, '..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

const pkg = readJson('package.json')
const lockRaw = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
/** bun.lock ni strogi JSON (končne vejice), je pa po čiščenju popolnoma pravilen. */
const lock = JSON.parse(lockRaw.replace(/,\s*([}\]])/g, '$1')) as {
  workspaces: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>
  overrides: Record<string, string>
  packages: Record<string, unknown[]>
}

const NEXT_FLOOR = '16.3.8'
const SHARP_FLOOR = '0.35.5'
const JS_YAML_PIN = '4.3.2'
const REACT_HOOKS_PIN = '7.1.1'
const REMOVED = ['next-auth', 'next-intl', 'uuid'] as const

type Deps = Record<string, string>

function allDirect(): Deps {
  return {
    ...((pkg.dependencies as Deps) ?? {}),
    ...((pkg.devDependencies as Deps) ?? {}),
    ...((pkg.optionalDependencies as Deps) ?? {}),
  }
}

/** „^16.4.2“ / „>=16.3.8“ / „16.4.2“ → „16.4.2“ */
function declaredVersion(range: string): string {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`nerazumljiv razpon različice: ${range}`)
  return `${m[1]}.${m[2]}.${m[3]}`
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error(`neštevilčna različica: ${a} / ${b}`)
    if (x !== y) return x - y
  }
  return 0
}

function resolvedVersion(name: string): string | undefined {
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key !== name && !key.startsWith(`${name}@`)) continue
    const spec = value[0] as string
    return spec.slice(spec.lastIndexOf('@') + 1)
  }
  return undefined
}

function installedVersion(name: string): string | undefined {
  const p = join(ROOT, 'node_modules', name, 'package.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).version as string) : undefined
}

/** Ali se ime pojavi kot paket ali kot odvisnost kateregakoli paketa v lockfile-u. */
function lockReferences(name: string): boolean {
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key === name || key.startsWith(`${name}@`)) return true
    const meta = (value[2] ?? {}) as Record<string, Deps>
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      if (meta[field]?.[name]) return true
    }
  }
  const wsDeps = lock.workspaces[''] ?? {}
  return Boolean(wsDeps.dependencies?.[name] ?? wsDeps.devDependencies?.[name])
}

describe('v1.154.0 — spodnje meje neposrednih odvisnosti (dep154-a)', () => {
  test(`next je deklariran z različico ≥ ${NEXT_FLOOR} (dve CRITICAL RCE najdbi)`, () => {
    const d = allDirect()
    expect(d.next).toBeString()
    expect(cmp(declaredVersion(d.next), NEXT_FLOOR)).toBeGreaterThanOrEqual(0)
  })

  test(`sharp je deklariran z različico ≥ ${SHARP_FLOOR} (librsvg CVE-2026-96889)`, () => {
    const d = allDirect()
    expect(d.sharp).toBeString()
    expect(cmp(declaredVersion(d.sharp), SHARP_FLOOR)).toBeGreaterThanOrEqual(0)
  })

  test('eslint-config-next je pripet NA EKSAKTNO 16.1.3 (brez ^)', () => {
    // Karat je dovolil, da se je ob naslednjem installu pripeljal drug config
    // in s seboj drugačen eslint-plugin-react-hooks → 73 napak lint-a brez
    // spremembe kode (v1.154.0). React Compiler refaktor je od v1.198.0
    // opravljen (N-27-4), pin ostane za deterministično orodja.
    expect((pkg.devDependencies as Deps)['eslint-config-next']).toBe('16.1.3')
  })

  test('neuporabljene odvisnosti next-auth / next-intl / uuid niso več deklarirane', () => {
    const d = allDirect()
    for (const name of REMOVED) expect(d[name]).toBeUndefined()
  })

  test(`override-a sta eksaktna: js-yaml ${JS_YAML_PIN} in eslint-plugin-react-hooks ${REACT_HOOKS_PIN} (dvignjen z N-27-4 refaktorjem v1.198.0)`, () => {
    const ov = (pkg.overrides ?? {}) as Deps
    expect(ov['js-yaml']).toBe(JS_YAML_PIN)
    expect(ov['eslint-plugin-react-hooks']).toBe(REACT_HOOKS_PIN)
  })
})

describe('v1.154.0 — lockfile je resnično stanje, ne predlog (dep154-b)', () => {
  test('override-a v bun.lock se ujemata s package.json', () => {
    expect(lock.overrides).toEqual(pkg.overrides)
  })

  test('workspace deklaraciji next/sharp v bun.lock se ujemata s package.json', () => {
    const ws = lock.workspaces[''].dependencies ?? {}
    const d = pkg.dependencies as Deps
    expect(ws.next).toBe(d.next)
    expect(ws.sharp).toBe(d.sharp)
  })

  test(`razrešena next je ≥ ${NEXT_FLOOR}, sharp ≥ ${SHARP_FLOOR}`, () => {
    expect(cmp(resolvedVersion('next')!, NEXT_FLOOR)).toBeGreaterThanOrEqual(0)
    expect(cmp(resolvedVersion('sharp')!, SHARP_FLOOR)).toBeGreaterThanOrEqual(0)
  })

  test(`razrešena js-yaml je natanko ${JS_YAML_PIN}, eslint-plugin-react-hooks natanko ${REACT_HOOKS_PIN}`, () => {
    expect(resolvedVersion('js-yaml')).toBe(JS_YAML_PIN)
    expect(resolvedVersion('eslint-plugin-react-hooks')).toBe(REACT_HOOKS_PIN)
  })

  test('odstranjeni paketi se v lockfile-u ne pojavijo niti kot tranzitivne odvisnosti', () => {
    for (const name of REMOVED) {
      expect(lockReferences(name)).toBe(false)
      expect(lockRaw).not.toContain(`"${name}@`)
    }
  })
})

describe('v1.154.0 — nameščeno stanje se ujema z lockfile-om (dep154-c)', () => {
  // V tem repozitoriju se je že zgodilo, da je `node_modules/uuid` ostal po
  // odstranitvi next-auth, čeprav ga lockfile ni več poznal. Takšen ostanek
  // naredi vsak nadaljnji varnostni pregled lažnivo rdeč ali lažnivo zelen.
  test('nameščena next in sharp nista pod mejama in se ujemata z lockfile-om', () => {
    const next = installedVersion('next')
    const sharp = installedVersion('sharp')
    expect(next).toBe(resolvedVersion('next'))
    expect(sharp).toBe(resolvedVersion('sharp'))
    expect(cmp(next!, NEXT_FLOOR)).toBeGreaterThanOrEqual(0)
    expect(cmp(sharp!, SHARP_FLOOR)).toBeGreaterThanOrEqual(0)
  })

  test(`nameščena js-yaml in eslint-plugin-react-hooks sta ${JS_YAML_PIN} / ${REACT_HOOKS_PIN}`, () => {
    expect(installedVersion('js-yaml')).toBe(JS_YAML_PIN)
    expect(installedVersion('eslint-plugin-react-hooks')).toBe(REACT_HOOKS_PIN)
  })

  test('odstranjeni paketi niso več v node_modules', () => {
    for (const name of REMOVED) {
      expect(existsSync(join(ROOT, 'node_modules', name))).toBe(false)
    }
  })
})

describe('v1.154.0 — zapisana ocena preostalih najdb (dep154-d)', () => {
  const doc = () => readFileSync(join(ROOT, 'docs', 'SECURITY-BOUNDARY.md'), 'utf8')

  test('dokumentacija navaja meje, odstranjene pakete in ID-je najdb', () => {
    const d = doc()
    for (const needle of [
      'v1.154.0',
      NEXT_FLOOR,
      SHARP_FLOOR,
      JS_YAML_PIN,
      'GHSA-2xp9-vwfh-vxw4',
      'GHSA-p293-qw3h-jr36',
      'GHSA-f88m-g3jw-g9cj',
      'GHSA-7rqj-j65f-68wh',
      'GHSA-86w9-cpqp-85rv',
    ]) {
      expect(d).toContain(needle)
    }
  })

  test('dokumentacija našteje VSE preostale sprejete najdbe z razlogom', () => {
    const d = doc()
    for (const needle of ['braces', 'deepmerge-ts', 'effect', 'node-forge', 'Prisma 7']) {
      expect(d).toContain(needle)
    }
  })

  test('node-forge je dosegljiv samo za branje PKCS#12; podpisovanje teče prek node:crypto', () => {
    const src = readFileSync(join(ROOT, 'src', 'lib', 'furs', 'client.ts'), 'utf8')
    // Najdba GHSA-86w9-cpqp-85rv je v PREVERJANJU podpisa RSA PKCS#1 v1.5.
    // Ta pot v projektu ne obstaja: forge bere .p12, podpis pa naredi Node.
    expect(src).toContain('pkcs12FromAsn1')
    expect(src).toContain("createSign('RSA-SHA256')")
    expect(src).not.toMatch(/forge\.pki\.verify/)
    expect(src).not.toMatch(/forge\.pki\.rsa\.verify/)
    expect(src).not.toMatch(/forge\.md\./)
    expect(src).not.toMatch(/forge\.pki\.publicKeyFromPem/)
  })

  test('node-forge je uvožen samo v enem modulu', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name)
        if (name.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name.name) && readFileSync(p, 'utf8').includes("from 'node-forge'")) {
          offenders.push(p.slice(ROOT.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walk(join(ROOT, 'src'))
    expect(offenders).toEqual(['src/lib/furs/client.ts'])
  })
})
