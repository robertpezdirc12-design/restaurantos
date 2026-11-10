import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.287.0 — CI SVEŽA BAZA (okoljska odvisnost v284 Č1d odstranjena).
 *
 * ZGODBA: prvi CI zagon kumulativnega pusha v1.283.0–v1.286.0 (pet
 * commitov, remote pred tem na a2f3c28) je padel na ENEM testu od 6010:
 * v284 Č1d je s strogo asercijo toBe(1) zahteval semensko lokacijo
 * »RestaurantOS Ljubljana« — CI tests job pa teče na sveži bazi
 * (ci.yml: prisma db push na ci-fresh.db BREZ db:seed; pogodba
 * »testi so samozadostni — potrjeno lokalno na prazni bazi«). Val
 * popravi asercijo na before/after invarianto (polna moč na seedani
 * bazi 1→1, trivialno zelena v CI 0→0 — vzorec sweep58 iz
 * fixture-sweep.test.ts) in doda try/finally higijeno fikstur
 * (LEKCIJA v1.286.0: padec asercije ne sme puščati nid vrstic).
 *
 * Ta datoteka je STATIČNI VARUH: okoljsko odvisne asercije v CI ni
 * mogoče odkriti drugače kot s padcem celotnega zagona — pini tu so
 * cenejši (vidni v vsakem lokalnem teku). Datoteka NE ustvarja db
 * fikstur (0 vrstic, 0 predpon) — zato ni v TEST_PREFIXES.
 */

const read = (p: string) => readFileSync(p, 'utf8')

// ── Č2) PINI — statične varovalke popravka ───────────────────────────────

describe('v287 Č2: pini (okoljska neodvisnost + CI pogodba)', () => {
  test('v284 Č1d nosi before/after invarianto semenske lokacije (ne strog toBe(1))', () => {
    const src = read('tests/v284-sweep-lokacije-po-imenu.test.ts')
    expect(src).toContain('demoSeedBefore')
    expect(src).toContain("name: 'RestaurantOS Ljubljana' } })).toBe(demoSeedBefore)")
    // regresijski varuh: stroga semenska asercija je vzrok CI padca @ e837e04
    expect(src).not.toContain("name: 'RestaurantOS Ljubljana' } })).toBe(1)")
  })

  test('v284 Č1d higiena v try/finally (LEKCIJA v1.286.0 — padec asercije ne pušča nid vrstic)', () => {
    const src = read('tests/v284-sweep-lokacije-po-imenu.test.ts')
    expect(src).toContain('} finally {')
    expect(src).toContain('await db.location.deleteMany({ where: { id: realId } }) // higiena lastne fiksture')
  })

  test('CI pogodba: tests job teče na sveži bazi BREZ semena (0 db:seed korakov v celem ci.yml)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('DATABASE_URL: file:./db/ci-fresh.db')
    expect(ci).toContain('bunx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate')
    expect(ci).not.toContain('db:seed') // semenska vrstica v CI ne sme obstajati
  })

  test('sweep58 vzorec ostaja živ (pogojna invarianta za sveže baze v fixture-sweep.test.ts)', () => {
    const src = read('tests/fixture-sweep.test.ts')
    expect(src).toContain('CI sveža baza brez realnih lokacij')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v287 Ž: registri', () => {
  test('verzija 1.304.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.304.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.304.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.304.0-nadzorni-val-stabilnosti-v')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena CI-ja)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('CiSvezaBaza')
    expect(read('prisma/schema.prisma')).not.toContain('CiSvezaBaza')
  })
})
