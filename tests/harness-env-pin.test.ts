import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { resolveTestDatabaseUrl } from './preload-env'

/**
 * Guard test za testni PRELOAD (tests/preload-env.ts + bunfig.toml).
 *
 * Ozadje (peskovnik 2026-10-29): globalni `DATABASE_URL=file:/home/z/my-project/
 * db/custom.db` (baza scaffoldskega projekta, brez sheme) preglasi `.env` —
 * procesno okolje ima vedno prednost. Skupine DB testov so lažno padale
 * (issue19: 0 pass / 1 fail brez izrecnega izvoza; 35/35 s pravilnim).
 * Preload pripne URL na <repo>/db/dev.db SAMO, kadar je vrednost manjkajoča
 * ali `file:` izven repozitorija — CI (`file:./db/ci-fresh.db` /
 * `file:./db/ci-gitlab.db`) in oddaljeni URL-ji ostanejo nedotaknjeni.
 *
 * Test je NEODVISEN od okolja: ne zaneka, da je URL natanko dev.db (v CI je
 * ci-fresh.db), ampak le, da je `file:` URL ZNOTRAJ repozitorija.
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const CWD = REPO_ROOT // testi tečejo iz korena repozitorija

describe('harness — testni preload okolja (DATABASE_URL pin)', () => {
  test('pravilo 1: manjkajoč DATABASE_URL → pripne na <repo>/db/dev.db', () => {
    const r = resolveTestDatabaseUrl(undefined, REPO_ROOT, CWD)
    expect(r.pinned).toBe(true)
    expect(r.url).toBe(`file:${resolve(REPO_ROOT, 'db', 'dev.db')}`)
  })

  test('pravilo 1b: prazen DATABASE_URL → pripne (trim tudi okoli presledkov)', () => {
    expect(resolveTestDatabaseUrl('', REPO_ROOT, CWD).pinned).toBe(true)
    expect(resolveTestDatabaseUrl('   ', REPO_ROOT, CWD).pinned).toBe(true)
  })

  test('pravilo 2: tuja absolutna file: pot (peskovniški scaffold) → pripne', () => {
    const r = resolveTestDatabaseUrl('file:/home/z/my-project/db/custom.db', REPO_ROOT, CWD)
    expect(r.pinned).toBe(true)
    expect(r.url).toBe(`file:${resolve(REPO_ROOT, 'db', 'dev.db')}`)
  })

  test('pravilo 2b: file: z query parametri izven repozitorija → pripne, parametri ohranjeni', () => {
    const r = resolveTestDatabaseUrl('file:/tmp/foreign.db?connection_limit=1&socket_timeout=15', REPO_ROOT, CWD)
    expect(r.pinned).toBe(true)
    expect(r.url.endsWith('?connection_limit=1&socket_timeout=15')).toBe(true)
    expect(r.url.startsWith(`file:${resolve(REPO_ROOT, 'db', 'dev.db')}`)).toBe(true)
  })

  test('pravilo 3: CI relativni URL (file:./db/ci-fresh.db ob CWD=repo) → OSTANE točno tak, kot je', () => {
    // Prisma (CLI IN klient, izmerjeno 6.11) razreši relativno pot glede na
    // imenik shame (prisma/) — par CLI↔klient je skladen; vsaka naša
    // pretvorba bi CI usmerila na napačno datoteko (poskušano in povrnjeno).
    const r = resolveTestDatabaseUrl('file:./db/ci-fresh.db', REPO_ROOT, CWD)
    expect(r.pinned).toBe(false)
    expect(r.url).toBe('file:./db/ci-fresh.db')
  })

  test('pravilo 3b: .env relativni URL (file:./db/dev.db) → OSTANE (lastnikov računalnik: db push ga ustvari shemsko-relativno)', () => {
    const r = resolveTestDatabaseUrl('file:./db/dev.db', REPO_ROOT, CWD)
    expect(r.pinned).toBe(false)
    expect(r.url).toBe('file:./db/dev.db')
  })

  test('pravilo 3c: relativni URL znotraj repozitorija z query parametri → OSTANE nespremenjen', () => {
    const r = resolveTestDatabaseUrl('file:./db/dev.db?connection_limit=1', REPO_ROOT, CWD)
    expect(r.pinned).toBe(false)
    expect(r.url).toBe('file:./db/dev.db?connection_limit=1')
  })

  test('pravilo 3d: absolutni URL znotraj repozitorija (demo.db) → OSTANE nespremenjen', () => {
    const inside = `${resolve(REPO_ROOT, 'prisma', 'db', 'demo.db')}`
    const r = resolveTestDatabaseUrl(`file:${inside}`, REPO_ROOT, CWD)
    expect(r.pinned).toBe(false)
    expect(r.url).toBe(`file:${inside}`)
  })

  test('pravilo 4: oddaljen URL (postgresql://) → OSTANE (namera operatorja; fixture-sweep ključavnica je druga linija)', () => {
    const r = resolveTestDatabaseUrl('postgresql://user:pw@host/db', REPO_ROOT, CWD)
    expect(r.pinned).toBe(false)
    expect(r.url).toBe('postgresql://user:pw@host/db')
  })

  test('pravilo 4b: mysql:// prav tako ostane', () => {
    expect(resolveTestDatabaseUrl('mysql://u:p@h/d', REPO_ROOT, CWD).pinned).toBe(false)
  })

  test('preload je vezan v bunfig.toml ([test] preload → tests/preload-env.ts)', () => {
    const bunfig = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8')
    expect(bunfig).toContain('[test]')
    expect(bunfig).toMatch(/preload\s*=\s*\["\.\/tests\/preload-env\.ts"\]/)
  })

  test('ŽIVI proces: trenutni DATABASE_URL je file: URL znotraj repozitorija (lokalno pripet, CI ohranjen)', () => {
    const url = process.env.DATABASE_URL ?? ''
    expect(url.startsWith('file:')).toBe(true)
    const dbPath = resolve(CWD, url.slice(5).split('?')[0])
    const inside = dbPath === REPO_ROOT || dbPath.startsWith(REPO_ROOT + '/')
    expect(inside).toBe(true)
  })
})
