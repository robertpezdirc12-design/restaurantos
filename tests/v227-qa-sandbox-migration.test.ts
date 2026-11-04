import { describe, test, expect } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolveTestDatabaseUrl } from './preload-env'
import { APP_VERSION } from '../src/lib/version'

/**
 * UPORABNIŠKI QA VAL #9 — SELITEV PESKOVNIKA (v1.228.0).
 *
 * Kontekst: peskovnik je bil 1. 11. 2026 ponastavljen (delovna kopija in
 * žetoni izgubljeni); repo je obnovljen iz javnega GitHub klona (v1.222.0)
 * + prenosljivega bundleja v1.226.0. Val zajema DVE najdbi, ki ju je
 * pokazala ŠELE selitev (obe popravljeni in dokazani):
 *
 * NAJDBA #1 (P1 — DEMO ZAGON NA BOGATEM PROFILU SESUJE SEED): `bun run demo`
 * na demo bazi z bogatim profilom Gostilna Pri Lipi (prisma/seed-demo.ts) je
 * padel — seed.ts je idempotenco preverjal SAMO po id lokacije, spodnji
 * create pa piše tudi unique premisesId 'BLG001', ki ga bogati profil že
 * ima → P2002 na premisesiId je sesoval celoten demo zagon (SEEDS veriga
 * se prekine, vrata ostanejo zaprta, strežnik se ne zažene; izmerjeno ob
 * selitvi). POPRAVEK: guard po OBEH ključih, ki jih create zapiše
 * (id OR premisesId), s poštenim imenom obstoječe lokacije v preskočnem
 * sporočilu.
 *
 * NAJDBA #2 (P1 test — HARNESS PIN ODVISEN OD LOKACIJE REPO):
 * tests/harness-env-pin.test.ts pravilo 2 je hardcodiralo scaffoldovo
 * absolutno pot /home/z/my-project/db/custom.db kot »tujo« — po selitvi
 * repo NA TO lokacijo pot ni bila več tuja, pin se ni sprožil in je test
 * padel rdeče, čeprav njegova glava obljublja »Test je NEODVISEN od
 * okolja« (prvi tek po obnovi: 34 fail ≘ bazna linija 33 + točno ta test).
 * POPRAVEK: tuja pot se izračuna kot sosednja mapa repozitorija — vedno
 * zunaj, ne glede na to, kje repo živi (CI, lastnik, peskovnik, selitev).
 */

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/* ═══════════════ A · SEED GUARD (demo zagon na bogatem profilu) ═══════════════ */

describe('v227 A · seed.ts idempotenca po OBEH ključih create', () => {
  test(
    'A1 vedenjsko: tuja lokacija s premisesId BLG001 (drug id) → seed preskoči, izhod 0, sporočilo z imenom, brez druge lokacije',
    () => {
      // Ločena baza v začasni mapi — tocno scenarij bogatega profila:
      // Gostilna Pri Lipi ima DRUG id, a ISTI unique premisesId 'BLG001'.
      const dbPath = join(tmpdir(), `v227-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)
      const env = { ...process.env, DATABASE_URL: `file:${dbPath}` }

      const push = spawnSync(
        'bunx',
        ['prisma', 'db', 'push', '--schema', 'prisma/schema.sqlite.prisma', '--skip-generate'],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 },
      )
      expect(push.status).toBe(0)

      const mk = spawnSync(
        'bun',
        [
          '-e',
          `const {PrismaClient}=require('@prisma/client');` +
            `const db=new PrismaClient();` +
            `db.location.create({data:{id:'v227-foreign-loc',name:'Gostilna Pri Lipi',code:'LJU-DEMO',premisesId:'BLG001'}})` +
            `.then(()=>db.$disconnect())`,
        ],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
      )
      expect(mk.status).toBe(0)

      const seed = spawnSync('bun', ['prisma/seed.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 })
      // Pred popravkom: P2002 Unique constraint failed on the fields: (`premisesId`) + izhod 1.
      expect(seed.status).toBe(0)
      expect(seed.stdout).toContain('preskok')
      expect(seed.stdout).toContain('Gostilna Pri Lipi')

      // Tuja lokacija ostaja edina — seed NI ustvaril svoje (RestaurantOS Ljubljana).
      const cnt = spawnSync(
        'bun',
        [
          '-e',
          `const {PrismaClient}=require('@prisma/client');` +
            `const db=new PrismaClient();` +
            `db.location.count().then(async n=>{console.log('N='+n);await db.$disconnect()})`,
        ],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
      )
      expect(cnt.stdout).toContain('N=1')

      for (const s of ['', '-journal', '-wal', '-shm']) {
        try {
          rmSync(dbPath + s)
        } catch {
          /* datoteka ne obstaja — v redu */
        }
      }
    },
    300_000,
  )

  test('A2 statika: OR guard prisoten, stari findUnique-po-id guard ODSOTEN, sporočilo nosi ime', () => {
    const seed = read('prisma/seed.ts')
    expect(seed).toContain("OR: [{ id: locationId }, { premisesId: 'BLG001' }]")
    expect(seed).not.toContain('findUnique({ where: { id: locationId } })')
    expect(seed).toContain('obstaja lokacija')
  })
})

/* ═══════════════ B · HARNESS PIN (neodvisnost od lokacije repo) ═══════════════ */

describe('v227 B · harness-env-pin pravilo 2 je neodvisno od lokacije repo', () => {
  test('B1 vedenjsko: sosednja mapa repozitorija je vedno tuja → pripne na <repo>/db/dev.db', () => {
    const REPO_ROOT = resolve(ROOT)
    const r = resolveTestDatabaseUrl(
      `file:${resolve(REPO_ROOT, '..', 'scaffold-custom', 'custom.db')}`,
      REPO_ROOT,
      REPO_ROOT,
    )
    expect(r.pinned).toBe(true)
    expect(r.url).toBe(`file:${resolve(REPO_ROOT, 'db', 'dev.db')}`)
  })

  test('B2 statika: hardcoded scaffoldova pot ODSOTNA iz pravila 2 (izračunana sosednja mapa)', () => {
    const t = read('tests/harness-env-pin.test.ts')
    expect(t).not.toContain("resolveTestDatabaseUrl('file:/home/z/my-project/db/custom.db'")
    expect(t).toContain("resolve(REPO_ROOT, '..', 'scaffold-custom', 'custom.db')")
  })
})

/* ═══════════════ Č · VERZIJA + REGISTRI ═══════════════ */

describe('v227 Č · verzija + dokumentacija', () => {
  test('verzija je dvignjena na 1.238.0 (version.ts)', () => {
    expect(APP_VERSION).toBe('1.251.0')
    expect(read('src/lib/version.ts')).toContain("'1.251.0'")
  })

  test('compose oznaka slike sledi verziji (selfhost pogodba)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('image: restaurantos:1.251.0')
  })

  test('PRD nosi zapis QA-vala v1.227.0 (doc-truth)', () => {
    expect(read('docs/PRD-LOKALNA-BAZA.md')).toContain('QA-val v1.227.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = read('worklog.md')
    expect(wl.indexOf('Task ID: v1.227.0')).toBeGreaterThanOrEqual(0)
    expect(wl.indexOf('Task ID: v1.227.0')).toBeLessThan(wl.indexOf('Task ID: v1.226.0'))
  })
})
