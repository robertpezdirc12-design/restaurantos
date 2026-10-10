import { describe, expect, test } from 'bun:test'
import {
  classifyDrift,
  isIssue13Statement,
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
