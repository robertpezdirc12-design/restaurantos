/**
 * v1.178.0 — zanka ponovnega nalaganja gostovega menija (úloga #54).
 *
 * OKVARA: `useGuestApiError()` vrne ob vsakem renderju NOV objekt
 * (`src/components/guest-i18n.tsx`). Kjer je bil ta container ušel v odvisnosti
 * `useCallback`/`useEffect`, se callback regenerira ob vsakem renderju, effect se
 * zato požene znova, vsak krog pa znova začne z nalaganjem. Merjeno na živo
 * (worklog v1.177.0): 190 zahtevkov `/api/public/menu` v 8 s na enem samem
 * odprtem zavihku `/m`.
 *
 * VRATA:
 *  §A nobena gostova ruta ne sme imeti hook-containerja v nizu odvisnosti;
 *  §A2 ista detekcija na fixtureih — enega zares ujame, drugega ne javi (detektor
 *     ne sme pisati resnice o lastnem orodju);
 *  §B loader callback na `/m` in `/pay` sme biti odvisen samo od stabilnih
 *     setterjev, dekonstruiranih iz containerja (vzor `/r`, v1.110.0);
 *  §C vzorčna ruta `/r` mora obdržati ta vzorec (regresija = rdeče).
 *
 * NI produkcijska koda: datoteke se berejo z TypeScriptovim parserjem, kot v
 * `tests/helpers/guest-a11y.ts`, da se ne zanašamo na regex.
 */
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'

const ROUTES: Record<string, string> = {
  '/m': 'src/app/m/[token]/page.tsx',
  '/kiosk': 'src/app/kiosk/page.tsx',
  '/pay': 'src/app/pay/[token]/page.tsx',
  '/r': 'src/app/r/[token]/page.tsx',
}

interface Finding {
  file: string
  line: number
  hook: string
  dep: string
}

const isContainerCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) && node.expression.getText().endsWith('useGuestApiError')

/** Imena, ki so posledica klica `useGuestApiError()` (container, NE setter). */
function containerNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const walk = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isContainerCall(n.initializer)) {
      out.add(n.name.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
}

const parse = (source: string): ts.SourceFile =>
  ts.createSourceFile('route.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/**
 * Vrne kršitve: identifier v nizu odvisnosti `useCallback`/`useEffect`, ki je
 * container `useGuestApiError()`. Elementi niso nujno identifierji (`foo.bar`,
 * izpisi) — tistih ne obravnavamo.
 */
function findContainerInDeps(source: string, file: string, containers?: Set<string>): Finding[] {
  const sf = parse(source)
  const names = containers ?? containerNames(sf)
  const out: Finding[] = []
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const hook = n.expression.text
      if (hook === 'useCallback' || hook === 'useEffect' || hook === 'useMemo') {
        const deps = n.arguments[hook === 'useCallback' ? 1 : 1]
        if (deps && ts.isArrayLiteralExpression(deps)) {
          for (const el of deps.elements) {
            if (ts.isIdentifier(el) && names.has(el.text)) {
              out.push({ file, line: lineOf(sf, el), hook, dep: el.text })
            }
          }
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

/**
 * Lokalna IMENA stabilnih setterjev, dekonstruiranih iz containerjev
 * (`const { set: X, clear } = pageErr` → X in clear). Elementi ObjectBindingPattern
 * so `BindingElement` (NE `PropertyAssignment` — to je vrsta objektnega literala):
 * pri `set: X` je `propertyName` ključ vira, lokalno vezno ime pa je `name`.
 */
function stableSetters(sf: ts.SourceFile, containers: Set<string>): Set<string> {
  const out = new Set<string>()
  const walk = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      containers.has(n.initializer.text)
    ) {
      for (const p of n.name.elements) {
        if (ts.isBindingElement(p) && ts.isIdentifier(p.name)) out.add(p.name.text)
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
}

function src(rel: string): string {
  return readFileSync(rel, 'utf8')
}

describe('v1.178.0 §A — hook-container ne sme biti v odvisnosteh gostove rute', () => {
  test('A1: nobena od štirih gostovih rut ne našteje containerja v deps nizu', () => {
    const all: Finding[] = []
    for (const [route, rel] of Object.entries(ROUTES)) {
      all.push(...findContainerInDeps(src(rel), route))
    }
    // Sporočilo naj bo čitljivo: `file:line hook dep`
    const stisk = all.map((f) => `${f.file}:${f.line} ${f.hook}[${f.dep}]`).join(', ')
    expect(stisk, 'container v odvisnosteh: ' + stisk).toBe('')
  })
})

describe('v1.178.0 §A2 — detektor ve, kaj ujame in česa ne sme javiti', () => {
  const FIXTURE_DEPS = `
const pageErr = useGuestApiError()
const { set, clear } = pageErr
const load = useCallback(async () => { clear() }, [token, pageErr])
`
  test('A2.1: fixture z containerjem v deps je UJET (detektor ne laže)', () => {
    const f = findContainerInDeps(FIXTURE_DEPS, 'fixture')
    expect(f.length).toBe(1)
    expect(f[0]?.dep).toBe('pageErr')
  })
  test('A2.2: enak callback s stabilnima setterjema NI javljen', () => {
    const f = findContainerInDeps(FIXTURE_DEPS.replace('[token, pageErr]', '[token, set, clear]'), 'fixture')
    expect(f.length).toBe(0)
  })
  test('A2.3: member izraz v telesu (`pageErr.clear()`) ni odvisnost in ni kršitev', () => {
    const f = findContainerInDeps(
      `const pageErr = useGuestApiError()
const load = useCallback(async () => { pageErr.clear() }, [token])`,
      'fixture',
    )
    expect(f.length).toBe(0)
  })
  test('A2.4: kolektor setterjev vrne LOKALNA imena samo iz containerjev', () => {
    // Brez tega fixturea bi §B lahko uspel prazno (ali pa bi si izmislil setterje):
    // `useGuestT()` ni container → njegov `t` ne sme priti v seznam.
    const sf = parse(`const pageErr = useGuestApiError()
const { set: setPageErr, clear: clearPageErr } = pageErr
const payErr = useGuestApiError()
const { clear } = payErr
const { t } = useGuestT()`)
    const s = stableSetters(sf, containerNames(sf))
    expect(s.has('t'), '`t` iz useGuestT ni setter containerja').toBe(false)
    expect([...s].sort().join(',')).toBe('clear,clearPageErr,setPageErr')
  })
  test('A2.5: container v deps UČINKA (`useEffect`) je prav tako UJET — to je druga polovica zanke', () => {
    const f = findContainerInDeps(
      `const pageErr = useGuestApiError()
useEffect(() => { load() }, [load, pageErr])`,
      'fixture',
    )
    expect(f.length).toBe(1)
    expect(f[0]?.hook).toBe('useEffect')
  })
})

describe('v1.178.0 §B — loader na /m in /pay sme biti odvisen samo od stabilnih setterjev', () => {
  /** Ime loader callbacka po ruti (izmerjeno iz vira, ne iz spomina). */
  const LOADER: Record<string, string> = { '/m': 'loadMenu', '/pay': 'load' }

  for (const [route, loaderName] of Object.entries(LOADER)) {
    const rel = ROUTES[route]
    test(`B: ${route} — loader "${loaderName}" obstaja, nima containerja v deps in našteje vsaj en stabilen setter`, () => {
      const sf = parse(src(rel))
      const containers = containerNames(sf)
      const setters = stableSetters(sf, containers)

      let deps: readonly ts.Expression[] | null = null
      const find = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'useCallback' &&
          n.arguments.length > 1 &&
          ts.isArrayLiteralExpression(n.arguments[1]) &&
          ts.isVariableDeclaration(n.parent) &&
          ts.isIdentifier(n.parent.name) &&
          n.parent.name.text === loaderName
        ) {
          deps = (n.arguments[1] as ts.ArrayLiteralExpression).elements
        }
        ts.forEachChild(n, find)
      }
      find(sf)

      expect(deps, `${route}: ni najden ${loaderName} kot useCallback z deps nizom`).not.toBeNull()
      const texts = (deps as readonly ts.Expression[]).map((d) => d.getText(sf))
      const slabo = texts.filter((t) => containers.has(t))
      expect(slabo.join(','), `${route}: deps vsebuje container (${texts.join(', ')})`).toBe('')
      const uporabljeniSetterji = texts.filter((t) => setters.has(t))
      expect(
        uporabljeniSetterji.length,
        `${route}: deps (${texts.join(', ')}) ne našteje nobenega stabilnega setterja (${[...setters].join(', ')}), ` +
          'sicer se callback regenerira ob vsakem renderju',
      ).toBeGreaterThan(0)
    })
  }
})

describe('v1.178.0 §C — vzorčna ruta /r obdrži stabilni vzorec', () => {
  test('C1: /r ima dekonstruirane setterje iz containerja', () => {
    const source = src(ROUTES['/r'])
    expect(source).toContain('const { set: setPageErr, setKey: setPageErrKey, clear: clearPageErr } = pageErr')
  })
  test('C2: /r nima containerja v odvisnosteh', () => {
    expect(findContainerInDeps(src(ROUTES['/r']), '/r').length).toBe(0)
  })
})
