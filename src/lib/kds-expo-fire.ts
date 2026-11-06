/**
 * PRIMERJAVA §39 (v1.265.0) — EXPO POŽIG ZADRŽANIH TEČAJEV S KDS
 * (Square Vol 16, 5. 11. 2026 »Fire held courses from an Expo KDS«):
 * per-lokacijska nastavitev »Dovoli požig s KDS« — ekspeditor na KDS
 * zaslonu lahko pošlje ZADRŽANE tečaje (pending, ne požgani) v pripravo
 * z dvotapno potrditvijo (odštevanje; drugi tap prekliče).
 *
 * Nosilec: Location."kdsExpoFireEnabled" BOOLEAN NOT NULL DEFAULT FALSE
 * — PER LOKACIJA (Square dobesedno: nastavitev »Allow Firing from Expo
 * KDS« je per location). Privzeto IZKLOPLJENO: požig ostane izključno
 * natakarjeva pristojnost (orders.create v POS urejevalniku — sedanje
 * stanje, byte-identično).
 *
 * IMPLEMENTACIJA (vzorec receipt-display-policy §37 / kds-ticket-sequence
 * §38 — aditivni politika stolpec, tokrat na Location):
 *  - MAIN schema.prisma ga NIMA (zastrupitev P2022 do DDL) — dostop
 *    IZKLJUČNO prek raw SQL, gated s probo (60 s TTL → po DDL koraku se
 *    lambda samozdravi). SQLite mirror ga ima (dev db push).
 *  - DDL korak: /api/admin/migrate-kds-expo-fire (konzola, idempotentno,
 *    oba dialekta).
 *  - Branje: expoFireEnabledFor(locationIds) → mapa {locationId: bool}
 *    (GET /api/kitchen — klient prikaže tap tarče samo za vklopljene
 *    lokacije; pre-DDL → prazna mapa = nikjer, graceful).
 *  - Pisanje: PATCH /api/locations/[id] {kdsExpoFireEnabled} (raw
 *    UPDATE; pre-DDL → 503 s potjo konzole).
 *  - Uveljavitev: POST /api/orders/[id]/fire dovoli orders.create
 *    (nespremenjeno) ALI kitchen.update + nastavitev VKLOPLJENA na
 *    lokaciji NAROČILA (jurisdikcična odločitev lastnika — pri Square
 *    ekspeditor kuha, pri nas natakar).
 */
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

const PROBE_TTL_MS = 60_000

/** Privzeto IZKLOPLJENO — požig s KDS nemogoč (danesšnje stanje). */
export const DEFAULT_KDS_EXPO_FIRE_ENABLED = false

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL / v testih). Z vrednostjo jo vsili. */
export function resetKdsExpoFireProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali stolpec Location."kdsExpoFireEnabled" obstaja na trenutni bazi? (memoizirano, 60 s) */
export async function kdsExpoFireAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe(`SELECT "kdsExpoFireEnabled" FROM "Location" LIMIT 1`)
    cached = { value: true, at: Date.now() }
  } catch (e) {
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/**
 * Prebere nastavitev za dane lokacije → mapa samo za ZAPOSLJENE
 * (pošiljatelj ve svoj nabor; manjkajoči ključ = privzetek IZKLOPLJENO).
 * Pre-DDL → prazna mapa (graceful — KDS nikjer ne pokaže tap tarč).
 * Infra napake se propagirajo (resnica, ne maskirana praznina).
 */
export async function expoFireEnabledFor(locationIds: readonly string[]): Promise<Record<string, boolean>> {
  if (locationIds.length === 0) return {}
  if (!(await kdsExpoFireAvailable())) return {}
  const uniq = [...new Set(locationIds)]
  const rows = await db.$queryRaw<{ id: string; kdsExpoFireEnabled: unknown }[]>`
    SELECT "id", "kdsExpoFireEnabled" FROM "Location" WHERE "id" IN (${Prisma.join(uniq)})
  `
  const out: Record<string, boolean> = {}
  for (const r of rows) {
    // defenzivno (§36 disciplina): samo končni boolean je vklop
    if (typeof r.kdsExpoFireEnabled === 'boolean') out[r.id] = r.kdsExpoFireEnabled
  }
  return out
}

/** Ena lokacija: ali je požig s KDS vklopljen? (pre-DDL/manjko → false) */
export async function expoFireEnabled(locationId: string): Promise<boolean> {
  const map = await expoFireEnabledFor([locationId])
  return map[locationId] === true
}

/**
 * Zapiše nastavitev lokacije (raw UPDATE, vezani parametri). Vrne napako
 * (string s potjo konzole — klicatelj odgovori 503) | null.
 */
export async function writeKdsExpoFire(locationId: string, enabled: boolean): Promise<string | null> {
  if (typeof enabled !== 'boolean') return 'kdsExpoFireEnabled mora biti true/false.'
  if (!(await kdsExpoFireAvailable())) {
    return 'Požig tečajev s KDS čaka DDL korak (Enterprise → Shema migracije → kds-expo-fire).'
  }
  await db.$executeRaw`UPDATE "Location" SET "kdsExpoFireEnabled" = ${enabled} WHERE "id" = ${locationId}`
  return null
}
