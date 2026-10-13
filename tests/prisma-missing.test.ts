import { describe, expect, test } from 'bun:test'
import { isMissingSchemaError } from '../src/lib/prisma-missing'
import { haccpPlansAvailable, resetHaccpPlansProbe } from '../src/lib/haccp-plans'
import { expenseCategoriesAvailable, resetExpenseCategoriesProbe } from '../src/lib/expenses-categories'
import { db } from '../src/lib/db'

/**
 * v1.86.1 — produkcijska lekcija: "manjka tabela/stolpec" prepoznavanje.
 *
 * Pred popravkom so isMissing preverbe (schema-migrations konzola, haccp in
 * expenses capability probi, stroski migrate pre-check) primerjale SAMO
 * Prisma kodi P2021/P2022 — te pa nastopijo IZKLJUČNO pri tipiziranih
 * poizvedbah. Za $queryRawUnsafe Prisma vrača P2010 s kodo driverja v meta:
 *   Postgres (Neon, dokazano na produkciji): 42P01 / 42703
 *   SQLite  (dev/testi, empirično izmerjeno): koda "1" + "no such …"
 * Posledice (obe odpravljene s tem commitom):
 *   1. stroski-kategorije migrate ruta je ob manjkajočem stolpcu vračala
 *      500 "Infrastrukturna napaka" NAMESTO da bi aplicirala DDL — zato
 *      uporabnikov klik "Uporabi" na produkciji ni uspel.
 *   2. haccp/expenses probi sta se ob manjkajoči strukturi obnašali kot
 *      READY → graceful degradacija (ddlPending/503) se ni nikoli sprožila.
 * Testi brez DB fixture-ov (pure funkcija + monkeypatch instance metod,
 * obnova v finally; probi so memoizirane → reset pred/po vsakem testu).
 */

/** PrismaClientKnownRequestError podobnost (P2010 "Raw query failed"). */
function p2010(dbCode: string, message: string): Error {
  return Object.assign(
    new Error(
      `Invalid \`prisma.$queryRawUnsafe()\` invocation:\n\nRaw query failed. Code: \`${dbCode}\`. Message: \`${message}\``,
    ),
    { code: 'P2010', meta: { code: dbCode, message } },
  )
}

function pCode(code: string): Error {
  return Object.assign(new Error(`prisma ${code}`), { code })
}

describe('prisma-missing: isMissingSchemaError (enotsko)', () => {
  test('tipizirana plast ostaja pokrita: P2021 (tabela) / P2022 (stolpec)', () => {
    expect(isMissingSchemaError(pCode('P2021'))).toBe(true)
    expect(isMissingSchemaError(pCode('P2022'))).toBe(true)
  })

  test('raw plast Postgres: P2010 + meta 42P01/42703 → manjka (produkcija: stroski pre-check 42703)', () => {
    expect(isMissingSchemaError(p2010('42P01', 'relation "PayLink" does not exist'))).toBe(true)
    expect(isMissingSchemaError(p2010('42703', 'column "category" does not exist'))).toBe(true)
  })

  test('raw plast SQLite: P2010 + "no such table/column" → manjka (dev: empirično izmerjeno)', () => {
    expect(isMissingSchemaError(p2010('1', 'no such table: NoSuchTable'))).toBe(true)
    expect(isMissingSchemaError(p2010('1', 'no such column: noSuchCol'))).toBe(true)
  })

  test('sporočilni fallback: meta.message manjka → err.message; meta.code manjka → sporočilo', () => {
    // meta brez message → uporabi err.message
    expect(
      isMissingSchemaError(Object.assign(new Error('no such table: X'), { code: 'P2010', meta: { code: '1' } })),
    ).toBe(true)
    // meta brez kode → sporočilo odloča
    expect(
      isMissingSchemaError(
        Object.assign(new Error('raw failed'), { code: 'P2010', meta: { message: 'no such column: y' } }),
      ),
    ).toBe(true)
  })

  test('infra/sintaksne napake NISO "manjka" (brez maskiranja resnice)', () => {
    expect(isMissingSchemaError(p2010('42601', 'syntax error at or near "FROM"'))).toBe(false)
    expect(isMissingSchemaError(pCode('P1001'))).toBe(false)
    expect(isMissingSchemaError(new Error('navadna napaka'))).toBe(false)
    expect(isMissingSchemaError(null)).toBe(false)
    expect(isMissingSchemaError(undefined)).toBe(false)
  })
})

describe('prisma-missing: capability probi prek raw plasti', () => {
  type RawFn = (sql: string) => Promise<unknown>
  const holder = db as unknown as { $queryRawUnsafe: RawFn }
  const origQuery = holder.$queryRawUnsafe.bind(db)

  function stubRaw(match: { needle: string; err: Error }): void {
    holder.$queryRawUnsafe = async (sql: string) => {
      if (sql.includes(match.needle)) throw match.err
      return origQuery(sql)
    }
  }

  function restoreRaw(): void {
    holder.$queryRawUnsafe = origQuery
  }

  test('haccp: P2010/42P01 (Postgres, tabela manjka) → proda DDL pending — prej lažni READY', async () => {
    resetHaccpPlansProbe()
    stubRaw({ needle: 'SELECT 1 FROM "HaccpPlan"', err: p2010('42P01', 'relation "HaccpPlan" does not exist') })
    try {
      expect(await haccpPlansAvailable()).toBe(false)
    } finally {
      restoreRaw()
      resetHaccpPlansProbe()
    }
    // obnovljena proda na dev bazi: tabela obstaja → READY
    expect(await haccpPlansAvailable()).toBe(true)
  })

  test('haccp: P2010/1 (SQLite "no such table") → proda DDL pending (dialekt-pariteta)', async () => {
    resetHaccpPlansProbe()
    stubRaw({ needle: 'SELECT 1 FROM "HaccpPlan"', err: p2010('1', 'no such table: HaccpPlan') })
    try {
      expect(await haccpPlansAvailable()).toBe(false)
    } finally {
      restoreRaw()
      resetHaccpPlansProbe()
    }
  })

  test('expenses: P2010/42703 (Postgres, stolpec manjka) → proda DDL pending — prej lažni READY', async () => {
    resetExpenseCategoriesProbe()
    stubRaw({
      needle: 'SELECT "category" FROM "AccountsPayable"',
      err: p2010('42703', 'column "category" does not exist'),
    })
    try {
      expect(await expenseCategoriesAvailable()).toBe(false)
    } finally {
      restoreRaw()
      resetExpenseCategoriesProbe()
    }
    expect(await expenseCategoriesAvailable()).toBe(true)
  })

  test('infra napaka (P1001) NE degenerira probe → true (resnico pokaže dejanska poizvedba)', async () => {
    resetHaccpPlansProbe()
    stubRaw({ needle: 'SELECT 1 FROM "HaccpPlan"', err: pCode('P1001') })
    try {
      expect(await haccpPlansAvailable()).toBe(true)
    } finally {
      restoreRaw()
      resetHaccpPlansProbe()
    }
  })
})
