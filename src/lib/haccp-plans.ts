import { db } from '@/lib/db'

/**
 * Task 64 (v1.62.0) — capability probe za HACCP načrte kontrol (model HaccpPlan).
 *
 * Issue-13 vzorec (Task 44/45): nova struktura je v datamodelu (schema.prisma +
 * dev SQLite prek `prisma db push`), produkcijski Neon Postgres pa čaka DDL korak
 * — admin ruta /api/admin/migrate-haccp-plans (fiksna aditivna CREATE TABLE,
 * requireCentralRole). Dokler DDL ni apliciran, bi vsaka poizvedba na haccpPlan
 * vrgla P2021 ("table does not exist") — zato rute PROBEJO capability in graceful
 * degradirajo: GET vrne `{ plans: [], ddlPending: true }`, pisanja 503. UI prikaže
 * passiven pas namesto napake — nobena živa funkcionalnost se ne zlomi (načrti so
 * NOVA funkcionalnost; obstoječi HaccpEntry tokovi se novih tabel ne dotikajo).
 *
 * Probe je memoizirana z 60 s TTL: Vercel lambda instance se po DDL apliciranju
 * samozdravijo najpozneje v minuti brez redeploya; admin migrate ruta poleg tega
 * resetira probo v istem procesu (takojšen učinek na instanci, ki je izvedla DDL).
 * Infrastrukturne napake (npr. P1001 unreachable) NE veljajo za "DDL pending" —
 * probe vrne true in dejanska poizvedba pokaže pravo napako (brez maskiranja).
 */

const PROBE_TTL_MS = 60_000

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL apliciranju / v testih). Z vrednostjo jo vsili. */
export function resetHaccpPlansProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali HaccpPlan tabela obstaja na trenutni bazi? (memoizirano, 60 s TTL) */
export async function haccpPlansAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM "HaccpPlan" LIMIT 1')
    cached = { value: true, at: Date.now() }
  } catch (e) {
    const code = (e as { code?: string }).code
    // P2021 = table does not exist, P2022 = column does not exist → DDL pending.
    // VSE ostalo (P1001, timeout, …) pomeni "tabela verjetno obstaja" → true,
    // da napako odkrije dejanska poizvedba (jasnejši 500 kot zamaskiran 503).
    cached = { value: code !== 'P2021' && code !== 'P2022', at: Date.now() }
  }
  return cached.value
}
