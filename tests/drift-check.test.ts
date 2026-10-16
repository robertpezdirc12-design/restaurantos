import { describe, expect, test } from 'bun:test'
import {
  classifyDrift,
  isIssue13Statement,
  isIssue38EventTenantStatement,
  isStroskiKategorijeStatement,
  isAllergenTruthStatement,
  isLotGovernanceStatement,
  isHaccpOpsStatement,
  isRestaurantSettingsPendingMergedStatement,
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

/**
 * Issue #2 (faza B po DDL valovih 13.–16. 10. 2026): prvi neon-smoke po
 * vrnitvi CI (run 38964400094) je razkril 5 stavkov, ki jih posamični
 * fazni matcherji niso pokrili — prisma migrate diff ZDRUŽI vse stolpce
 * ene tabele v EN stavek (ne glede na funkcijo izvora) in za tipne/nullability
 * razlike po DDL apliciranju generira SET DATA TYPE / DROP NOT NULL oblike.
 * Fixtures spodaj so TOČNO stavki iz tega runa (izpis koraka drift-check).
 */
const I2_PROD_HACCP_PLANID =
  'ALTER TABLE "HaccpEntry" ALTER COLUMN "planId" DROP NOT NULL'
const I2_PROD_INVBATCH_TP =
  'ALTER TABLE "InventoryBatch" ALTER COLUMN "alertDate" SET DATA TYPE TIMESTAMP(3), ' +
  'ALTER COLUMN "removalDate" SET DATA TYPE TIMESTAMP(3), ' +
  'ALTER COLUMN "holdAt" SET DATA TYPE TIMESTAMP(3), ' +
  'ALTER COLUMN "releaseAt" SET DATA TYPE TIMESTAMP(3)'
const I2_PROD_INVITEM_TP =
  'ALTER TABLE "InventoryItem" ALTER COLUMN "allergensConfirmedAt" SET DATA TYPE TIMESTAMP(3)'
const I2_PROD_MENUITEM_TP =
  'ALTER TABLE "MenuItem" ALTER COLUMN "allergensConfirmedAt" SET DATA TYPE TIMESTAMP(3)'
const I2_PROD_SETTINGS_MERGED_15 =
  'ALTER TABLE "RestaurantSettings" DROP COLUMN "apMatchAmountToleranceCents", ' +
  'DROP COLUMN "apMatchPriceTolerancePct", DROP COLUMN "apMatchQtyTolerancePct", ' +
  'DROP COLUMN "apMatchVatTolerancePct", DROP COLUMN "cashBlindCount", ' +
  'DROP COLUMN "cashVarianceThresholdCents", DROP COLUMN "excCancelApprovalAmountCents", ' +
  'DROP COLUMN "excDiscountApprovalAmountCents", DROP COLUMN "excDiscountApprovalPct", ' +
  'DROP COLUMN "excRequireReasonCancel", DROP COLUMN "excRequireReasonDiscount", ' +
  'DROP COLUMN "excRequireReasonStorno", DROP COLUMN "excRequireReasonVoid", ' +
  'DROP COLUMN "excStornoApprovalAmountCents", DROP COLUMN "excVoidApprovalAmountCents"'

describe('drift-check: isAllergenTruthStatement — TIMESTAMP(3) normalizacija (issue #2, faza B)', () => {
  test('SET DATA TYPE TIMESTAMP(3) za allergensConfirmedAt (InventoryItem + MenuItem) → znan', () => {
    expect(isAllergenTruthStatement(I2_PROD_INVITEM_TP)).toBe(true)
    expect(isAllergenTruthStatement(I2_PROD_MENUITEM_TP)).toBe(true)
  })

  test('mešani stavek (DROP COLUMN + SET DATA TYPE) iste funkcije → znan', () => {
    const mixed =
      'ALTER TABLE "MenuItem" DROP COLUMN "allergensOverride", ' +
      'ALTER COLUMN "allergensConfirmedAt" SET DATA TYPE TIMESTAMP(3)'
    expect(isAllergenTruthStatement(mixed)).toBe(true)
  })

  test('tuj stolpec / druga natančnost / OrderItem → NI znan', () => {
    // OrderItem nima allergensConfirmedAt (ima samo allergenSnapshot/allergenWarning)
    expect(isAllergenTruthStatement(I2_PROD_INVITEM_TP.replace('InventoryItem', 'OrderItem'))).toBe(false)
    expect(isAllergenTruthStatement(
      'ALTER TABLE "MenuItem" ALTER COLUMN "allergensConfirmedAt" SET DATA TYPE TIMESTAMP(6)',
    )).toBe(false)
    // TEXT stolpec ne more biti del TIMESTAMP(3) normalizacije
    expect(isAllergenTruthStatement(
      'ALTER TABLE "MenuItem" ALTER COLUMN "allergensOverride" SET DATA TYPE TIMESTAMP(3)',
    )).toBe(false)
  })
})

describe('drift-check: isLotGovernanceStatement — TIMESTAMP(3) normalizacija (issue #2, faza B)', () => {
  test('produkcijski 4-klavzulni stavek + posamične oblike → znane', () => {
    expect(isLotGovernanceStatement(I2_PROD_INVBATCH_TP)).toBe(true)
    expect(isLotGovernanceStatement(
      'ALTER TABLE "InventoryBatch" ALTER COLUMN "holdAt" SET DATA TYPE TIMESTAMP(3)',
    )).toBe(true)
  })

  test('TEXT/polje iz druge tabele v SET DATA TYPE → NI znan', () => {
    expect(isLotGovernanceStatement(
      'ALTER TABLE "InventoryBatch" ALTER COLUMN "holdReason" SET DATA TYPE TIMESTAMP(3)',
    )).toBe(false) // holdReason je TEXT
    expect(isLotGovernanceStatement(
      'ALTER TABLE "InventoryItem" ALTER COLUMN "alertDate" SET DATA TYPE TIMESTAMP(3)',
    )).toBe(false) // napačna tabela
  })
})

describe('drift-check: isHaccpOpsStatement — planId nullability (issue #2, faza B)', () => {
  test('produkcijski DROP NOT NULL + mešan s DROP COLUMN → znana', () => {
    expect(isHaccpOpsStatement(I2_PROD_HACCP_PLANID)).toBe(true)
    expect(isHaccpOpsStatement(
      'ALTER TABLE "HaccpEntry" DROP COLUMN "planName", ALTER COLUMN "planId" DROP NOT NULL',
    )).toBe(true)
  })

  test('nullability za DRUG stolpec / SET NOT NULL → NI znan', () => {
    expect(isHaccpOpsStatement(
      'ALTER TABLE "HaccpEntry" ALTER COLUMN "planName" DROP NOT NULL',
    )).toBe(false)
    expect(isHaccpOpsStatement(
      'ALTER TABLE "HaccpEntry" ALTER COLUMN "planId" SET NOT NULL',
    )).toBe(false)
  })
})

describe('drift-check: isRestaurantSettingsPendingMergedStatement (issue #2, CI run 38964400094)', () => {
  test('produkcijski združeni DROP COLUMN ×15 → znan', () => {
    expect(isRestaurantSettingsPendingMergedStatement(I2_PROD_SETTINGS_MERGED_15)).toBe(true)
  })

  test('podmnožica in preurejena razporeditev klavzul → znana', () => {
    expect(isRestaurantSettingsPendingMergedStatement(
      'ALTER TABLE "RestaurantSettings" DROP COLUMN "excRequireReasonVoid", ' +
      'DROP COLUMN "apMatchQtyTolerancePct", DROP COLUMN "cashBlindCount"',
    )).toBe(true)
  })

  test('tuji/nedokumentiran stolpec ali druga tabela → NI znan (hard fail)', () => {
    expect(isRestaurantSettingsPendingMergedStatement(
      'ALTER TABLE "RestaurantSettings" DROP COLUMN "futureCol"',
    )).toBe(false)
    expect(isRestaurantSettingsPendingMergedStatement(
      'ALTER TABLE "RestaurantSettings" DROP COLUMN "cashBlindCount", DROP COLUMN "futureCol"',
    )).toBe(false)
    expect(isRestaurantSettingsPendingMergedStatement(
      'ALTER TABLE "VoidReason" DROP COLUMN "kind"',
    )).toBe(false)
  })
})

describe('drift-check: classifyDrift — CELA produkcijska diffa (run 38964400094) → 0 nepričakovanih', () => {
  const FULL_DIFF = [
    '-- AlterTable',
    I2_PROD_HACCP_PLANID + ';',
    I2_PROD_INVBATCH_TP + ';',
    I2_PROD_INVITEM_TP + ';',
    I2_PROD_MENUITEM_TP + ';',
    I2_PROD_SETTINGS_MERGED_15 + ';',
    '-- znani pred-popravilom:',
    'ALTER TABLE "AccountsPayable" DROP COLUMN "category";',
    'ALTER TABLE "CashMovement" ALTER COLUMN "amount" DROP DEFAULT, ' +
      'ALTER COLUMN "voidedAt" SET DATA TYPE TIMESTAMP(3);',
    'ALTER TABLE "ZReport" DROP COLUMN "cashGuestRefund", ' +
      'DROP COLUMN "cashPaidIn", DROP COLUMN "cashPaidOut";',
    'ALTER TABLE "VoidReason" DROP COLUMN "kind", DROP COLUMN "requireComment";',
    '',
  ].join('\n')

  test('vseh 10 stavkov klasificiranih kot znani, 0 blokatorjev', () => {
    const cls = classifyDrift(FULL_DIFF)
    expect(cls.unexpected).toHaveLength(0)
    const ids = cls.known.map((k) => k.id)
    expect(ids).toContain('haccp-ops')
    expect(ids).toContain('lot-governance')
    expect(ids).toContain('allergen-truth')
    expect(ids).toContain('settings-pending-merged')
    expect(ids).toContain('stroski-kategorije')
    expect(ids).toContain('cash-movements')
    expect(ids).toContain('exception-reasons')
  })

  test('regresijska varovalka: nov nedokumentiran RestaurantSettings stolpec → hard fail ostane', () => {
    const cls = classifyDrift(
      '-- AlterTable\nALTER TABLE "RestaurantSettings" DROP COLUMN "brandNewCol";\n',
    )
    expect(cls.unexpected).toHaveLength(1)
  })

  test('register vsebuje settings-pending-merged z referencami na vse tri DDL rute', () => {
    const entry = KNOWN_DRIFTS.find((k) => k.id === 'settings-pending-merged')
    expect(entry).toBeDefined()
    expect(entry!.reason).toContain('/api/admin/migrate-ap-tolerance')
    expect(entry!.reason).toContain('/api/admin/migrate-exception-policy')
    expect(entry!.reason).toContain('/api/admin/migrate-cash-movements')
  })
})
