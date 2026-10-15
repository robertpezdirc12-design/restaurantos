import { describe, expect, test } from 'bun:test'
import {
  classifyDrift,
  isIssue13Statement,
  isIssue38EventTenantStatement,
  isStroskiKategorijeStatement,
  isAllergenTruthStatement,
  parseStatements,
  KNOWN_DRIFTS,
} from '../scripts/drift-check'

/**
 * Task 45: testi za CI drift-check allowlist (scripts/drift-check.ts).
 * Čisti unit testi — brez DB. Vhodni SQL-i so točno v obliki, ki jo
 * generira `prisma migrate diff --script` (lokalno replikirano):
 *
 *   -- AlterTable
 *   ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL,
 *   ALTER COLUMN "premisesId" DROP DEFAULT;
 */

const ISSUE13_COMBINED = `-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL,
ALTER COLUMN "premisesId" DROP DEFAULT;
`

const ISSUE13_SEPARATE = `-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP DEFAULT;
`

describe('drift-check: parseStatements', () => {
  test('odstrani komentarje in prazne vrstice, razdeli na ;', () => {
    const stmts = parseStatements(ISSUE13_COMBINED)
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toBe(
      'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL, ALTER COLUMN "premisesId" DROP DEFAULT',
    )
  })

  test('prazen input / samo komentarji → brez stavkov', () => {
    expect(parseStatements('')).toEqual([])
    expect(parseStatements('-- This is an empty migration.\n')).toEqual([])
    expect(parseStatements('\n\n  \n')).toEqual([])
  })
})

describe('drift-check: isIssue13Statement', () => {
  test('kombinirana oblika (en stavek, dve klavzuli) → znana', () => {
    const [stmt] = parseStatements(ISSUE13_COMBINED)
    expect(isIssue13Statement(stmt)).toBe(true)
  })

  test('razdvojena oblika (dva stavka) → vsak znan', () => {
    const stmts = parseStatements(ISSUE13_SEPARATE)
    expect(stmts).toHaveLength(2)
    expect(stmts.every(isIssue13Statement)).toBe(true)
  })

  test('druga tabela → NI znana', () => {
    expect(
      isIssue13Statement('ALTER TABLE "Supplier" ALTER COLUMN "code" DROP NOT NULL'),
    ).toBe(false)
  })

  test('isti stolpec, drugačen tip klavzule (SET DATA TYPE) → NI znana', () => {
    expect(
      isIssue13Statement('ALTER TABLE "Location" ALTER COLUMN "premisesId" SET DATA TYPE text'),
    ).toBe(false)
  })

  test('mešane klavzule (DROP NOT NULL + ADD COLUMN) → NI znana (konzervativno)', () => {
    expect(
      isIssue13Statement(
        'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL, ADD COLUMN "x" TEXT',
      ),
    ).toBe(false)
  })
})

describe('drift-check: classifyDrift', () => {
  test('samo issue-13 (kombinirano) → known 1, unexpected 0', () => {
    const cls = classifyDrift(ISSUE13_COMBINED)
    expect(cls.unexpected).toHaveLength(0)
    expect(cls.known).toHaveLength(1)
    expect(cls.known[0].id).toBe('issue-13')
    expect(cls.known[0].statements).toHaveLength(1)
    expect(cls.known[0].reason).toContain('migrate-issue13')
  })

  test('samo issue-13 (razdvojeno) → known 1 z 2 stavkoma, unexpected 0', () => {
    const cls = classifyDrift(ISSUE13_SEPARATE)
    expect(cls.unexpected).toHaveLength(0)
    expect(cls.known).toHaveLength(1)
    expect(cls.known[0].statements).toHaveLength(2)
  })

  test('prazen input → brez drifta (known 0, unexpected 0)', () => {
    const cls = classifyDrift('-- This is an empty migration.\n')
    expect(cls.known).toHaveLength(0)
    expect(cls.unexpected).toHaveLength(0)
  })

  test('nepričakovan drift na drugi tabeli → unexpected', () => {
    const cls = classifyDrift(
      '-- AlterTable\nALTER TABLE "Supplier" DROP COLUMN "code";\n',
    )
    expect(cls.known).toHaveLength(0)
    expect(cls.unexpected).toHaveLength(1)
    expect(cls.unexpected[0]).toContain('Supplier')
  })

  test('mešano: issue-13 + nepričakovan → oba ločeno razvrščena', () => {
    const cls = classifyDrift(
      ISSUE13_COMBINED + '\nALTER TABLE "Employee" DROP COLUMN "pin";\n',
    )
    expect(cls.known).toHaveLength(1)
    expect(cls.known[0].id).toBe('issue-13')
    expect(cls.unexpected).toHaveLength(1)
    expect(cls.unexpected[0]).toContain('Employee')
  })

  test('issue-13 z neznanimi dodatnimi klavzulami → unexpected (allowlist je strog)', () => {
    const cls = classifyDrift(
      'ALTER TABLE "Location" ALTER COLUMN "premisesId" DROP NOT NULL, ALTER COLUMN "other" DROP DEFAULT;',
    )
    expect(cls.known).toHaveLength(0)
    expect(cls.unexpected).toHaveLength(1)
  })

  test('KNOWN_DRIFTS register vsebuje issue-13 z opisanim DDL korakom', () => {
    const ids = KNOWN_DRIFTS.map((k) => k.id)
    expect(ids).toContain('issue-13')
    const issue13 = KNOWN_DRIFTS.find((k) => k.id === 'issue-13')!
    expect(issue13.reason).toContain('/api/admin/migrate-issue13')
  })
})

describe('drift-check: isStroskiKategorijeStatement (Task 66)', () => {
  const STROSKI_ADD = 'ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT NOT NULL DEFAULT \'\''
  const STROSKI_DROP = 'ALTER TABLE "AccountsPayable" DROP COLUMN "category"'

  test('faza C-prime: ADD COLUMN (polje v main schema, DDL še ne apliciran) → znana', () => {
    expect(isStroskiKategorijeStatement(STROSKI_ADD)).toBe(true)
  })

  test('faza B: DROP COLUMN (DDL apliciran, main schema še brez polja) → znana', () => {
    expect(isStroskiKategorijeStatement(STROSKI_DROP)).toBe(true)
  })

  test('druga tabela (AccountsPayableLine, Supplier) → NI znana', () => {
    expect(
      isStroskiKategorijeStatement('ALTER TABLE "AccountsPayableLine" ADD COLUMN "category" TEXT'),
    ).toBe(false)
    expect(isStroskiKategorijeStatement('ALTER TABLE "Supplier" ADD COLUMN "category" TEXT')).toBe(false)
  })

  test('drugačen stolpec na isti tabeli (category_id, notes) → NI znana', () => {
    expect(
      isStroskiKategorijeStatement('ALTER TABLE "AccountsPayable" ADD COLUMN "category_id" TEXT'),
    ).toBe(false)
    expect(
      isStroskiKategorijeStatement('ALTER TABLE "AccountsPayable" DROP COLUMN "notes"'),
    ).toBe(false)
  })

  test('DROP TABLE / DELETE FROM / CREATE na isti tabeli → NI znana (samo ALTER+ADD/DROP COLUMN)', () => {
    expect(isStroskiKategorijeStatement('DROP TABLE "AccountsPayable";')).toBe(false)
    expect(isStroskiKategorijeStatement('DELETE FROM "AccountsPayable";')).toBe(false)
    expect(isStroskiKategorijeStatement('CREATE TABLE "AccountsPayable" ("category" TEXT);')).toBe(false)
  })

  test('kombiniran ALTER z dodatnimi stolpci → NI znana (allowlist je strog)', () => {
    expect(
      isStroskiKategorijeStatement(
        'ALTER TABLE "AccountsPayable" ADD COLUMN "category" TEXT, ADD COLUMN "extra" TEXT',
      ),
    ).toBe(false) // drugi stolpec → unexpected
  })

  test('classifyDrift: obi fazi znani, register ima stroski-kategorije z opisanim DDL korakom', () => {
    for (const stmt of [STROSKI_ADD, STROSKI_DROP]) {
      const cls = classifyDrift(`-- AlterTable\n${stmt};\n`)
      expect(cls.unexpected).toHaveLength(0)
      expect(cls.known).toHaveLength(1)
      expect(cls.known[0].id).toBe('stroski-kategorije')
      expect(cls.known[0].reason).toContain('/api/admin/migrate-stroski-kategorije')
    }
    const ids = KNOWN_DRIFTS.map((k) => k.id)
    expect(ids).toContain('stroski-kategorije')
  })
})

describe('drift-check: isIssue38EventTenantStatement (v1.100.0, issue #38)', () => {
  const ADD_COL = 'ALTER TABLE "EventLog" ADD COLUMN IF NOT EXISTS "locationId" TEXT'
  const ADD_COL_NO_IF = 'ALTER TABLE "EventLog" ADD COLUMN "locationId" TEXT'
  const IDX = 'CREATE INDEX IF NOT EXISTS "EventLog_locationId_idx" ON "EventLog" ("locationId")'
  const IDX_NO_IF = 'CREATE INDEX "EventLog_locationId_idx" ON "EventLog" ("locationId")'

  test('ADD COLUMN (z/brz IF NOT EXISTS) → znana', () => {
    expect(isIssue38EventTenantStatement(ADD_COL)).toBe(true)
    expect(isIssue38EventTenantStatement(ADD_COL_NO_IF)).toBe(true)
  })

  test('CREATE INDEX (z/brz IF NOT EXISTS) → znana', () => {
    expect(isIssue38EventTenantStatement(IDX)).toBe(true)
    expect(isIssue38EventTenantStatement(IDX_NO_IF)).toBe(true)
  })

  test('drugačen stolpec / druga tabela → NI znana', () => {
    expect(isIssue38EventTenantStatement('ALTER TABLE "EventLog" ADD COLUMN "organizationId" TEXT')).toBe(false)
    expect(isIssue38EventTenantStatement('ALTER TABLE "Order" ADD COLUMN "locationId" TEXT')).toBe(false)
    expect(isIssue38EventTenantStatement('ALTER TABLE "EventLog" DROP COLUMN "payload"')).toBe(false)
    expect(isIssue38EventTenantStatement('DROP TABLE "EventLog";')).toBe(false)
  })

  test('classifyDrift + register vsebuje issue38-event-tenant z DDL korakom', () => {
    const cls = classifyDrift(`-- AlterTable\n${ADD_COL};\n\n-- CreateIndex\n${IDX};\n`)
    expect(cls.unexpected).toHaveLength(0)
    expect(cls.known).toHaveLength(1)
    expect(cls.known[0].id).toBe('issue38-event-tenant')
    expect(cls.known[0].reason).toContain('/api/admin/migrate-issue38')
    const ids = KNOWN_DRIFTS.map((k) => k.id)
    expect(ids).toContain('issue38-event-tenant')
  })
})

describe('drift-check: isAllergenTruthStatement (v1.104.0, issue #7)', () => {
  const INV_ADD = 'ALTER TABLE "InventoryItem" ADD COLUMN IF NOT EXISTS "allergens" TEXT NOT NULL DEFAULT \'[]\''
  const MI_ADD = 'ALTER TABLE "MenuItem" ADD COLUMN IF NOT EXISTS "allergenReviewFlag" BOOLEAN NOT NULL DEFAULT false'
  const OI_ADD = 'ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "allergenWarning" TEXT NOT NULL DEFAULT \'\''
  const MI_DROP = 'ALTER TABLE "MenuItem" DROP COLUMN "allergensOverride"'

  test('ADD/DROP za dovoljene stolpce → znani (vse 3 tabele)', () => {
    expect(isAllergenTruthStatement(INV_ADD)).toBe(true)
    expect(isAllergenTruthStatement(MI_ADD)).toBe(true)
    expect(isAllergenTruthStatement(OI_ADD)).toBe(true)
    expect(isAllergenTruthStatement(MI_DROP)).toBe(true)
  })

  test('stolpec iz DRUGE tabele / tuja tabela / neznana klavzula → NI znana', () => {
    expect(isAllergenTruthStatement('ALTER TABLE "MenuItem" ADD COLUMN "allergens" TEXT')).toBe(false) // InventoryItem stolpec
    expect(isAllergenTruthStatement('ALTER TABLE "OrderItem" ADD COLUMN "allergenReviewFlag" BOOLEAN')).toBe(false) // MenuItem stolpec
    expect(isAllergenTruthStatement('ALTER TABLE "PayLink" ADD COLUMN "allergens" TEXT')).toBe(false)
    expect(isAllergenTruthStatement('DROP TABLE "MenuItem";')).toBe(false)
    expect(isAllergenTruthStatement('ALTER TABLE "MenuItem" RENAME COLUMN "allergensOverride" TO "x"')).toBe(false)
  })

  test('classifyDrift + register vsebuje allergen-truth z DDL korakom', () => {
    for (const stmt of [INV_ADD, MI_ADD, OI_ADD, MI_DROP]) {
      const cls = classifyDrift(`-- AlterTable\n${stmt};\n`)
      expect(cls.unexpected).toHaveLength(0)
      expect(cls.known).toHaveLength(1)
      expect(cls.known[0].id).toBe('allergen-truth')
      expect(cls.known[0].reason).toContain('/api/admin/migrate-allergen-truth')
    }
    const ids = KNOWN_DRIFTS.map((k) => k.id)
    expect(ids).toContain('allergen-truth')
  })
})
