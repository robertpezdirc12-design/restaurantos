import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

/**
 * Task 67 (v1.65.0) — capability probe za kategorije stroškov (stolpec
 * AccountsPayable.category).
 *
 * KLJUČNA RAZLIKA od HaccpPlan (Task 64): tu ni NOVA tabela, ampak NOV STOLPEC
 * na živeči tabeli. Polje je ZAVESNO zadržano izven main schema.prisma (Task 66
 * varnostna odločitev): če bi Prisma client SELECT-al neobstoječ stolpec, bi
 * VSE poizvedbe na AccountsPayable padle s P2022 (zastrupitev produkcije do
 * uporabnikovega DDL klika). Zato kategorije beremo/pišemo IZKLJUČNO prek raw
 * SQL ($queryRaw/$executeRaw z vezanimi parametri — dialekt-agnostično), gated
 * s to memoizirano probo:
 *  - probe true  → GET obogati vrstice z realno kategorijo, POST/PATCH pišejo
 *                  stolpec (v isti $transaction z osnovnim zapisom);
 *  - probe false → rute se obnašajo točno kot prej (fallback 'OSTALO'), pisanje
 *                  kategorije → 503 (UI polje skrije — enak vzorec kot haccp).
 *
 * Probe je memoizirana z 60 s TTL: Vercel lambda instance se po uporabnikovem
 * DDL kliku (Enterprise → konzola → stroski-kategorije) samozdravijo najpozneje
 * v minuti brez redeploya. Infrastrukturne napake (P1001 …) NE veljajo za "DDL
 * pending" — probe vrne true, da dejanska poizvedba pokaže pravo napako (brez
 * maskiranja). Dialekt-agnostično: SELECT "category" → P2021/P2022 = manjka na
 * obeh dialektih (isti vzorec kot schema-migrations.columnExists).
 *
 * Faza C' (ko uporabnik potrdi DDL klik): polje se preseli v main schema.prisma
 * + raw enrichment umaknemo v tipizirano branje + drift allowlist 'stroski-
 * kategorije' (ADD smer) upokojimo — ta lib pa ostane kot enaka varna vrata.
 */

const PROBE_TTL_MS = 60_000

/** Normalizirana max dolžina kategorije (prost tekst, UI datalist iz obstoječih). */
export const EXPENSE_CATEGORY_MAX = 60

let cached: { value: boolean; at: number } | null = null

/** Ponastavi probe (po DDL apliciranju / v testih). Z vrednostjo jo vsili. */
export function resetExpenseCategoriesProbe(value?: boolean): void {
  cached = value === undefined ? null : { value, at: Date.now() }
}

/** Ali stolpec AccountsPayable.category obstaja na trenutni bazi? (memoizirano, 60 s) */
export async function expenseCategoriesAvailable(): Promise<boolean> {
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value
  try {
    await db.$queryRawUnsafe('SELECT "category" FROM "AccountsPayable" LIMIT 1')
    cached = { value: true, at: Date.now() }
  } catch (e) {
    // Manjka tabela/stolpec → DDL pending. v1.86.1: prepoznamo TUDI raw
    // plast (P2010 + meta koda driverja — prisma-missing.ts); prej samo
    // P2021/P2022, kar se pri $queryRawUnsafe NIKOLI ne zgodi → produkcija je
    // ob manjkajočem stolpcu lažno trdila READY (fallback se ni sprožil).
    // VSE ostalo (P1001, timeout, …) → true, da napako odkrije dejanska poizvedba.
    cached = { value: !isMissingSchemaError(e), at: Date.now() }
  }
  return cached.value
}

/**
 * Normalizacija uporabniške kategorije: trim + strop dolžine.
 * Vrne trimmed string ( Lahko tudi '' — pomeni "brez kategorije").
 * Predolga → null (rute vrnejo 400).
 */
export function normalizeExpenseCategory(input: unknown): string | null {
  if (input === undefined || input === null) return ''
  const s = String(input).trim()
  if (s.length > EXPENSE_CATEGORY_MAX) return null
  return s
}
