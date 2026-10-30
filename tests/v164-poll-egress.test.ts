/**
 * v1.164.0 — zmanjšanje egressa iz periodičnega osveževanja (Neon kvota).
 *
 * PROBLEM: dashboard je vsakih 15 s (»hot« cikel) poleg operativnih virov
 * (statistika/mize/naročila/kuhinja) prenašal še CEL meni (postavke + kategorije
 * + alergeni), rezervacije, zadnjih 100 računov (z Order+Table) in izmene —
 * vsakih 15 s, čeprav se ti podatki spreminjajo redko. Handheld in tablica sta
 * vsakih 15 s prenašala celoten meni skupaj z mizami in naročili.
 *
 * REŠITEV: počasni viri se osvežijo v polnem 60-sekundnem ciklu; meni na
 * napravah vsak 4. 15-sekundni cikel. Mize/naročila/kuhinja ostanejo na 15 s,
 * strežniška validacija naročila (razpoložljivost, 86) ostane varnostna mreža.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dashboardPollIncludes, menuRefreshDue, MENU_REFRESH_EVERY } from '../src/lib/poll-plan'

type Resource = Parameters<typeof dashboardPollIncludes>[1]

const HOT: Resource[] = ['stats', 'tables', 'orders', 'kitchen']
const FULL_ONLY: Resource[] = ['menus', 'reservations', 'furs', 'shifts']

describe('v1.164.0 — načrt osveževanja dashboarda', () => {
  it('hot cikel vsebuje operativne vire', () => {
    for (const r of HOT) expect(dashboardPollIncludes('hot', r)).toBe(true)
  })

  it('hot cikel NE vsebuje počasnih virov', () => {
    for (const r of FULL_ONLY) expect(dashboardPollIncludes('hot', r)).toBe(false)
  })

  it('full cikel vsebuje vse vire', () => {
    for (const r of [...HOT, ...FULL_ONLY]) expect(dashboardPollIncludes('full', r)).toBe(true)
  })
})

describe('v1.164.0 — osveževanje menija na napravah', () => {
  it('meni je na vsak 4. cikel (60 s pri 15-sekundnem intervalu)', () => {
    expect(MENU_REFRESH_EVERY).toBe(4)
    expect(menuRefreshDue(0)).toBe(true)
    for (const t of [1, 2, 3]) expect(menuRefreshDue(t)).toBe(false)
    expect(menuRefreshDue(4)).toBe(true)
    for (const t of [5, 6, 7]) expect(menuRefreshDue(t)).toBe(false)
    expect(menuRefreshDue(8)).toBe(true)
  })
})

describe('v1.164.0 — statične invariante klica', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('dashboard: počasni viri so v hot ciklu ZAKLENJENI z dashboardPollIncludes', () => {
    const src = read('src/app/dashboard/page.tsx')
    // v1.204.0 (OSS-4): destrukturiranje je dobilo `oh` (zadržana naročila —
    // lahki hot vir, /api/orders?status=hold; NE počasni vir → brez zaklepa)
    const start = src.indexOf('const [d, t, o, oh, k, m, e, r, rec')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('])', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    const lines = block.split('\n')
    const expected: Array<[string, Resource]> = [
      ['/api/menus', 'menus'],
      ['/api/reservations', 'reservations'],
      ['/api/furs', 'furs'],
      ['/api/shifts', 'shifts'],
    ]
    for (const [endpoint, key] of expected) {
      const hits = lines.filter((l) => l.includes(endpoint))
      expect(hits).toHaveLength(1)
      expect(hits[0]).toContain(`dashboardPollIncludes(scope, '${key}')`)
    }
  })

  it('handheld: meni se prenaša samo ob withMenu, interval odloča po menuRefreshDue(tick)', () => {
    const src = read('src/app/handheld/page.tsx')
    const start = src.indexOf('const load = useCallback')
    const end = src.indexOf('}, [])', start)
    const loadBody = src.slice(start, end)
    const menuLine = loadBody.split('\n').find((l) => l.includes('/api/menus'))
    expect(menuLine).toBeDefined()
    expect(menuLine!).toContain('withMenu ?')
    // interval: odločitev po ticku, ne vedno true
    const ivStart = src.indexOf('pollRef.current = setInterval')
    const ivBody = src.slice(ivStart, src.indexOf('}, 15000)', ivStart))
    expect(ivBody).toContain('menuRefreshDue(tick)')
    expect(ivBody).toContain('load(menuRefreshDue(tick))')
    // začetni load (in 'online') prineseta poln meni
    expect(src).toContain('await load(true)')
    expect(src).toContain('void load(true)')
  })

  it('tablica: meni se prenaša samo ob withMenu, interval odloča po menuRefreshDue(tick)', () => {
    const src = read('src/app/tablica/page.tsx')
    const start = src.indexOf('const load = useCallback')
    const end = src.indexOf('}, [])', start)
    const loadBody = src.slice(start, end)
    const menuLine = loadBody.split('\n').find((l) => l.includes('/api/menus'))
    expect(menuLine).toBeDefined()
    expect(menuLine!).toContain('withMenu ?')
    const ivStart = src.indexOf('pollRef.current = setInterval')
    const ivBody = src.slice(ivStart, src.indexOf('}, 15000)', ivStart))
    expect(ivBody).toContain('menuRefreshDue(tick)')
    expect(ivBody).toContain('load(menuRefreshDue(tick))')
    expect(src).toContain('await load(true)')
  })
})
