import { db } from '@/lib/db'
import { isMissingSchemaError } from '@/lib/prisma-missing'

/**
 * P3 #20 (v1.193.0) — strežniški pomožnik za sedežne rute: ali DDL stolpca
 * `OrderItem."seat"` že obstaja? (produkcijski Neon čaka konsolo Enterprise →
 * Shema migracije → sedeži; dev SQLite dobi stolpec prek db push mirrorja).
 *
 * Dokler DDL ni apliciran, sedežne rute odgovarjajo 503 z jasnim sporočilom —
 * nikoli tihe odpovedi ali lažnega uspeha (isti politiki kot haccp capability
 * probe in web-portal 404). Infrastrukturne napake se propagirajo (status error).
 */
export async function seatsColumnAvailable(): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "seat" FROM "OrderItem" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingSchemaError(e)) return false
    throw e
  }
}
