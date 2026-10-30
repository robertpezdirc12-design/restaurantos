import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * N-27-4 (docs/TRZNA-VRZELI-2027.md) — ESLint react-hooks refaktor, v1.198.0.
 *
 * Zgodovina (worklog v1.154.0-deps-security, „ESLINT INCIDENT"): nadgradnja
 * odvisnosti je pripeljala `eslint-plugin-react-hooks` 7.1.1 z React Compiler
 * pravili → 73 napak lint-a brez spremembe kode. Takrat je bil gate zaprt z
 * override-om 7.0.1 („pravila niso bila tiho izklopljena"), refaktor pa
 * izrecno odložen kot ločena izdaja — ta val (N-27-4) je ta ločena izdaja.
 *
 * Koda je od takrat zrasla, zato je meritev tega vala 96 najdb (ne 73):
 *   58× set-state-in-effect, 26× static-components, 12× refs
 * + 6× purity (ob odklenitvi react-hooks/purity): 5× Date.now, 1× Math.random.
 * Vse popravljene deterministično, brez suppressions, brez novih odvisnosti,
 * brez spremembe vedenja (isti JSX/i18n ključi; hydration-varen prvi izris).
 *
 * Zaklenjeno stanje (enaka disciplina kot tests/dependency-advisories.test.ts):
 *   A deklaracija — override 7.1.1 + lint skript z omejeno kopico (7.1.1
 *     analiza na 4 GB peskovniku sicer OOM; cap 1536 MB naredi vrata
 *     ponovljiva tudi na manjših strojih/CI),
 *   B lockfile — razrešena različica = override,
 *   C nameščeno stanje — node_modules = lockfile,
 *   D konfiguracija — react-hooks/purity odklenjen, mrtvi vnos
 *     `react-compiler/react-compiler` (plugin ni registriran) odstranjen,
 *     `react-hooks/exhaustive-deps: off` ostane ZAVESTNA meja (klasično
 *     pravilo, ne React Compiler pravilo — svoj refaktor, ne ta val),
 *   E dokumentacija — N-27-4 ZAPRTO (v1.198.0) v TRZNA-VRZELI-2027.
 */

const ROOT = join(import.meta.dir, '..')

function readText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readText(rel))
}

const PIN = '7.1.1'

describe('v1.198.0 — override dvignjen na 7.1.1 (rh198-a)', () => {
  const pkg = readJson('package.json')
  const overrides = (pkg.overrides ?? {}) as Record<string, string>

  test('override eslint-plugin-react-hooks je natanko 7.1.1', () => {
    expect(overrides['eslint-plugin-react-hooks']).toBe(PIN)
  })

  test('lint skript teče z omejeno kopico (7.1.1 analiza na 4 GB peskovniku sicer OOM)', () => {
    const lint = ((pkg.scripts ?? {}) as Record<string, string>).lint ?? ''
    expect(lint).toContain('--max-old-space-size=1536')
    expect(lint).toContain('eslint .')
  })
})

describe('v1.198.0 — lockfile in nameščeno stanje (rh198-b)', () => {
  // bun.lock ni strogi JSON (končne vejice) — isti recept kot dependency-advisories.
  const lock = JSON.parse(readText('bun.lock').replace(/,\s*([}\]])/g, '$1')) as {
    overrides?: Record<string, string>
    packages: Record<string, unknown[]>
  }

  test('bun.lock overrides se ujemajo s package.json', () => {
    expect(lock.overrides ?? {}).toEqual((readJson('package.json').overrides ?? {}) as Record<string, string>)
  })

  test(`razrešena različica v bun.lock je ${PIN}`, () => {
    const entry = lock.packages['eslint-plugin-react-hooks']
    expect(Array.isArray(entry)).toBeTrue()
    const spec = entry![0] as string
    expect(spec.slice(spec.lastIndexOf('@') + 1)).toBe(PIN)
  })

  test(`nameščen plugin je ${PIN}`, () => {
    const installed = readJson('node_modules/eslint-plugin-react-hooks/package.json') as { version: string }
    expect(installed.version).toBe(PIN)
  })
})

describe('v1.198.0 — React Compiler pravila odklenjena (rh198-c)', () => {
  const config = readText('eslint.config.mjs')

  test('react-hooks/purity NI več izklopljen (pravilo živi, najdbe=0)', () => {
    expect(config).not.toContain('"react-hooks/purity": "off"')
  })

  test('mrtvi vnos react-compiler/react-compiler je odstranjen (plugin ni registriran)', () => {
    expect(config).not.toContain('react-compiler/react-compiler')
  })

  test('react-hooks/exhaustive-deps ostaja ZAVESTNO izklopljen (meja, ne tiha izklop)', () => {
    expect(config).toContain('"react-hooks/exhaustive-deps": "off"')
  })
})

describe('v1.198.0 — verzija in dokumentacija (rh198-d)', () => {
  test('verzija 1.202.0', () => {
    const version = readText('src/lib/version.ts')
    expect(version).toMatch(/APP_VERSION = '1\.202\.0'/)
  })

  test('TRZNA-VRZELI-2027: N-27-4 je ZAPRTO (v1.198.0)', () => {
    const doc = readText('docs/TRZNA-VRZELI-2027.md')
    expect(doc).toContain('N-27-4')
    expect(doc).toContain('ZAPRTO (v1.198.0)')
  })

  test('brez suppressions v src (disciplina: pravila niso tiho izklopljena)', () => {
    // Plugin 7.1.1 dovoljuje eslint-disable-react-hooks/… direktive; val jih ni
    // uporabil — preverba, da tudi ni ostala nobena od prejšnjih valov.
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (/\.(tsx?|jsx)$/.test(name) && readFileSync(p, 'utf8').includes('eslint-disable-react-hooks')) hits.push(p)
      }
    }
    walk(join(ROOT, 'src'))
    expect(hits).toEqual([])
  })
})
