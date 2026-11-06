import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

/**
 * PRIMERJAVA §40 (v1.266.0) — NAPITNINSKE TOČKE PO VLOGI (Square Vol 16,
 * 5. 11. 2026 »Split pooled tips by points assigned to each role«): točke
 * za delitev napitnin so pripisane VLOGI (delovnemu mestu — Job), enkrat
 * nastavljene; član delitve sledi svoji vlogi (predpolnitev), vnos pa
 * ostane POPOLNOMA per oseba (vatareč lahko prilagodi pred zaključkom
 * dneva — Square dobesedno »points assigned to each role«, naša delta
 * iz §37: predpolnitev po vlogi + ročni popravek).
 *
 * IMPLEMENTACIJA (vzorec receipt-display-policy / kds-expo-fire —
 * aditivni policy stolpec, tokrat na Job):
 *  - 1 nov stolpec: Job."tipPoints" INTEGER NOT NULL DEFAULT 0
 *    (0 = vloga NIMA privzetih točk — predpolnitev prazna, vnos ročen).
 *  - MAIN schema.prisma ga NIMA (zastrupitev P2022 do DDL) — dostop
 *    IZKLJUČNO prek raw SQL, gated s probo (60 s TTL → po DDL koraku se
 *    lambda samozdravi). SQLite mirror ga ima (dev db push).
 *  - DDL korak: /api/admin/migrate-job-tip-points (konzola Enterprise →
 *    Shema migracije → job-tip-points, idempotentno, oba dialekta).
 *  - Pisanje: PATCH /api/jobs/[id] (settings.manage — delovna mesta so
 *    nastavitvena entiteta, enako kot POST /api/jobs). Do DDL: pisanje →
 *    503 s potjo konzole.
 *
 * Bralci: GET /api/jobs (JobsCard prikaz/urejanje) + GET /api/tips
 * (predpolnitev jobTipPoints per zaposleni v predogledu delitve).
 * Delitev sama (splitTips / methodWeights) ostaja NESPREMENJENA —
 * matematika točkovne delitve je bila izvedena že od Issue #1.
 */

const PROBE_TTL_MS = 60_000

/** Zgornja meja točk vloge — 0..999 (privzete točke so utež, ne denar). */
export const JOB_TIP_POINTS_MAX = 999

export const DEFAULT_JOB_TIP_POINTS = 0

/** Validacija ene vrednosti: CELO število 0..999 (null/negativ/decimal → null). */
export function parseJobTipPoints(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  if (v < 0 || v > JOB_TIP_POINTS_MAX) return null
  return v
}

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetJobTipPointsProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali je stolpec tipPoints prisoten na trenutni bazi? (memoizirano, 60 s) */
export async function jobTipPointsAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "tipPoints" FROM "Job" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/**
 * Prebere točke za dane vloge (DDL-gated). Pre-DDL ali manjkajoča vrstica
 * → prazna preslikava (predpolnitev prazna — klicatelj pokaže ročen vnos,
 * BREZ napake: tips predogled mora delovati tudi brez DDL koraka).
 */
export async function jobTipPointsFor(jobIds: readonly string[]): Promise<Record<string, number>> {
  const ids = [...new Set(jobIds.filter((x) => typeof x === 'string' && x.length > 0))]
  if (ids.length === 0) return {}
  if (!(await jobTipPointsAvailable())) return {}
  try {
    const rows = await db.$queryRaw<{ id: string; tipPoints: unknown }[]>`
      SELECT "id", "tipPoints" FROM "Job" WHERE "id" IN (${Prisma.join(ids)})
    `
    const out: Record<string, number> = {}
    for (const r of rows) {
      const v = parseJobTipPoints(r.tipPoints)
      if (v !== null) out[r.id] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Zapiše točke ene vloge (raw UPDATE vezani parametri). Vrne napako
 * (string) | null — 503 sporočilo nosi pot do DDL konzole. Veljavne
 * vrednosti IZKLJUČNO cele 0..999 (parseJobTipPoints).
 */
export async function writeJobTipPoints(jobId: string, points: unknown): Promise<string | null> {
  const v = parseJobTipPoints(points)
  if (v === null) {
    return `tipPoints mora biti celo število 0..${JOB_TIP_POINTS_MAX}.`
  }
  if (typeof jobId !== 'string' || !jobId) return 'jobId je obvezen.'
  if (!(await jobTipPointsAvailable())) {
    return 'Napitninske točke po vlogi čakajo DDL korak (Enterprise → Shema migracije → job-tip-points).'
  }
  const res = await db.$executeRaw`UPDATE "Job" SET "tipPoints" = ${v}, "updatedAt" = ${new Date()} WHERE "id" = ${jobId}`
  if (res === 0) return 'Delovno mesto ne obstaja.'
  return null
}
