import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #14 (P1/P2, v1.112.0) — KDS poimenovane postaje: DDL korak.
 *
 * NOVE tabele StationTask (postavka × postaja — usmerjanje ob FIRE-u, posnetki
 * imen, zaporedje korakov, statusi waiting/pending/preparing/ready/done) in
 * MenuItemStation (dodatne postaje artikla, M:N) + STOLPCA
 * Modifier.prepStationId (usmeritev opcije) in PrepStation.isExpo (izdajna
 * postaja). Skalarne vezave brez FK (EventLog/ManagerCall vzorec).
 *
 * Idempotentno: tabele IF NOT EXISTS; stolpci IF NOT EXISTS (Postgres) /
 * pri SQLite (dev prek db push že prisotno) se napaka duplikata tiho ignorira.
 * Samo centralne vloge (requireCentralRole). Do DDL: /api/kitchen additive
 * polja (stations/tasks/stationStats) se tiho izpraznijo — queue + stationTargets
 * ostaneta nespremenjena (graceful — obstoječi POS/KDS tok se ne dotakne).
 */

const CREATE_TASK_TABLE = `CREATE TABLE IF NOT EXISTS "StationTask" (
  "id" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "stationId" TEXT NOT NULL,
  "stationName" TEXT NOT NULL DEFAULT '',
  "stationType" TEXT NOT NULL DEFAULT 'kitchen',
  "kind" TEXT NOT NULL DEFAULT 'prep',
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL DEFAULT '',
  "detail" TEXT NOT NULL DEFAULT '',
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "firedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "readyAt" TIMESTAMP(3),
  "readyById" TEXT,
  "readyByName" TEXT NOT NULL DEFAULT '',
  "issuedAt" TIMESTAMP(3),
  "issuedById" TEXT,
  "issuedByName" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "StationTask_pkey" PRIMARY KEY ("id")
)`

const CREATE_ITEM_STATION_TABLE = `CREATE TABLE IF NOT EXISTS "MenuItemStation" (
  "id" TEXT NOT NULL,
  "menuItemId" TEXT NOT NULL,
  "stationId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MenuItemStation_pkey" PRIMARY KEY ("id")
)`

const UNIQUE_INDEXES = [
  // kind v unique: postaja, ki je hkrati priprava+izdajna (isExpo), dobi SVOJ
  // pripravljalni korak IN izdajo — dve vrstici, isti stationId (različen kind).
  `CREATE UNIQUE INDEX IF NOT EXISTS "StationTask_orderItemId_stationId_kind_key" ON "StationTask"("orderItemId", "stationId", "kind")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MenuItemStation_menuItemId_stationId_key" ON "MenuItemStation"("menuItemId", "stationId")`,
]

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "StationTask_locationId_status_idx" ON "StationTask"("locationId", "status")`,
  `CREATE INDEX IF NOT EXISTS "StationTask_stationId_status_idx" ON "StationTask"("stationId", "status")`,
  `CREATE INDEX IF NOT EXISTS "StationTask_orderItemId_idx" ON "StationTask"("orderItemId")`,
  `CREATE INDEX IF NOT EXISTS "StationTask_orderId_idx" ON "StationTask"("orderId")`,
  `CREATE INDEX IF NOT EXISTS "StationTask_status_idx" ON "StationTask"("status")`,
  `CREATE INDEX IF NOT EXISTS "MenuItemStation_menuItemId_idx" ON "MenuItemStation"("menuItemId")`,
  `CREATE INDEX IF NOT EXISTS "MenuItemStation_stationId_idx" ON "MenuItemStation"("stationId")`,
  `CREATE INDEX IF NOT EXISTS "MenuItemStation_locationId_idx" ON "MenuItemStation"("locationId")`,
]

/** ALTER stolpci (Postgres IF NOT EXISTS; SQLite duplikat → tiho preskoči). */
const COLUMN_DDL: Array<{ label: string; sql: string }> = [
  {
    label: 'Modifier.prepStationId',
    sql: `ALTER TABLE "Modifier" ADD COLUMN IF NOT EXISTS "prepStationId" TEXT`,
  },
  {
    label: 'PrepStation.isExpo',
    sql: `ALTER TABLE "PrepStation" ADD COLUMN IF NOT EXISTS "isExpo" BOOLEAN NOT NULL DEFAULT false`,
  },
]

async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      table,
    )
    return Array.isArray(rows) && rows.length > 0
  } catch {
    // SQLite (dev/CI): information_schema ne obstaja — tabeli sta že prek db push
    return true
  }
}

async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "${column}" FROM "${table}" LIMIT 1`)
    return true
  } catch (e) {
    const err = (e ?? {}) as { code?: string; meta?: { code?: string; message?: string }; message?: string }
    if (err.code === 'P2021' || err.code === 'P2022') return false
    if (err.code === 'P2010') {
      const dbCode = String(err.meta?.code ?? '')
      if (dbCode === '42P01' || dbCode === '42703') return false
      const msg = String(err.meta?.message ?? err.message ?? '')
      if (/no such (table|column)/i.test(msg)) return false
    }
    throw e
  }
}

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  const applied: string[] = []
  const skipped: string[] = []
  const columnsApplied: string[] = []

  try {
    for (const [label, ddl] of [
      ['StationTask', CREATE_TASK_TABLE],
      ['MenuItemStation', CREATE_ITEM_STATION_TABLE],
    ] as const) {
      if (await tableExists(label)) {
        skipped.push(label)
      } else {
        await db.$executeRawUnsafe(ddl)
        applied.push(label)
      }
    }
    for (const ix of [...UNIQUE_INDEXES, ...INDEXES]) {
      await db.$executeRawUnsafe(ix)
    }
    for (const col of COLUMN_DDL) {
      const [table, column] = col.label.split('.')
      if (await columnExists(table, column)) {
        skipped.push(col.label)
        continue
      }
      try {
        await db.$executeRawUnsafe(col.sql)
        columnsApplied.push(col.label)
      } catch (e) {
        // SQLite: "duplicate column name" → že prisotno prek db push (idempotentno)
        const msg = String((e as Error).message || e)
        if (/duplicate column/i.test(msg)) {
          skipped.push(col.label)
          continue
        }
        throw e
      }
    }

    await writeAudit(db, {
      userId: user.sub,
      action: 'SCHEMA_MIGRATION_KDS_STATIONS',
      entityType: 'SchemaMigration',
      entityId: 'kds-stations',
      details: jstr({ applied, columnsApplied, skipped: skipped.length, endpoint: '/api/admin/migrate-kds-stations' }),
      locationId: user.loc ?? null,
    })

    return ok({ applied, columnsApplied, skipped, alreadyApplied: applied.length === 0 && columnsApplied.length === 0 })
  } catch (e) {
    return fail(`DDL korak ni uspel: ${String((e as Error).message || e).slice(0, 300)}`, 500)
  }
}
