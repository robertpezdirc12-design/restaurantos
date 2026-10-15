import { db } from '@/lib/db'
import { isMissingSchemaError } from './prisma-missing'

/**
 * Task 65 (v1.63.0) — register shematskih migracij (DDL konzola).
 *
 * Projekt je po issue-13 vzorcu (Task 44) ob vsakem novem modelu/stolpcu dodal
 * idempotentno admin migrate rutо (/api/admin/migrate-*) z FIKSNO DDL — produkcija
 * (Neon Postgres) ne izvaja `prisma db push`, zato DDL korake izvaja centralna
 * vloga ročno. Do Task 65 je bilo takih rut 9 → uporabniško trenje (9 ročnih
 * POST klicev). Konzola (/api/admin/migrations) jih združi: status vsake
 * migracije (idempotentna preverba probe) + en klik "uporabi vse čakajoče"
 * z delegacijo na obstoječe rute (ENAK DDL vir, ENAK audit chain — konzola NE
 * podvaja DDL).
 *
 * Probe mora biti dialekt-agnostična (dev SQLite + produkcijski Postgres):
 *  - tableExists:  SELECT 1 FROM "T" LIMIT 1        → manjka = P2010/raw (prisma-missing.ts)
 *  - columnExists: SELECT "c" FROM "T" LIMIT 1      → manjka = P2010/raw (prisma-missing.ts)
 *  - columnNullable: Postgres information_schema, SQLite PRAGMA fallback
 * Infrastrukturne napake (P1001 unreachable, timeout …) NISO "pending" — probe
 * jih propagira (status error), da konzola pokaže resnico in ne lažnega DDL
 * stanja (isti politiki kot haccp capability probe, src/lib/haccp-plans.ts).
 *
 * Omejitev: PG enum vrednosti (ALTER TYPE … ADD VALUE, migrate-issue11) niso
 * dialekt-agnostično preverljive — probe issue11 preverja tabele + stolpce kot
 * zadosten proxy (vloge so priložene tabelam; drift-check na CI čuva ostalo).
 */

export interface SchemaMigration {
  /** stabilni id (UI + POST {id}) */
  id: string
  /** i18n ključ opisa (UI) */
  descKey: string
  /** vir DDL — obstoječa admin migrate ruta, ki ji konzola delegira izvedbo */
  endpoint: string
  /** idempotentna preverba "aplicirano" (true = DDL ni potreben) */
  probe: () => Promise<boolean>
}

/* ───────────────────────── probe pomožniki ───────────────────────── */

/** v1.86.1: P2021/P2022 (tipizirane poizvedbe) + P2010/raw (meta koda
 * driverja — PG 42P01/42703, SQLite "no such …") — glej src/lib/prisma-missing.ts. */
const isMissingCode = isMissingSchemaError

/** Ali tabela obstaja? (SQLite + Postgres) */
async function tableExists(table: string): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingCode(e)) return false
    throw e // infra napaka → status error (brez maskiranja)
  }
}

/** Ali stolpec obstaja? (SQLite + Postgres) */
async function columnExists(table: string, column: string): Promise<boolean> {
  try {
    await db.$queryRawUnsafe(`SELECT "${column}" FROM "${table}" LIMIT 1`)
    return true
  } catch (e) {
    if (isMissingCode(e)) return false
    throw e
  }
}

/** Ali so vsi pari (tabela, stolpec) prisotni? */
async function columnsAll(pairs: [string, string][]): Promise<boolean> {
  for (const [table, column] of pairs) {
    if (!(await columnExists(table, column))) return false
  }
  return true
}

/** Ali vse tabele obstajajo? */
async function tablesAll(tables: string[]): Promise<boolean> {
  for (const t of tables) {
    if (!(await tableExists(t))) return false
  }
  return true
}

/**
 * Ali je stolpec NULL-able? (migrate-issue13 preverja spremembo omejitve, ne prisotnosti)
 * Dialekt po DATABASE_URL (tiho, brez poizvedovnega šuma): SQLite (file:) →
 * PRAGMA table_info (notnull je BigInt → Number()), Postgres → information_schema.
 */
async function columnNullable(table: string, column: string): Promise<boolean> {
  if ((process.env.DATABASE_URL ?? '').startsWith('file:')) {
    try {
      const rows = await db.$queryRawUnsafe<{ name: string; notnull: bigint | number }[]>(
        `PRAGMA table_info("${table}")`,
      )
      const col = rows.find((c) => c.name === column)
      return col ? Number(col.notnull) === 0 : false
    } catch (e) {
      if (isMissingCode(e)) return false
      throw e
    }
  }
  const rows = await db.$queryRawUnsafe<{ is_nullable: string }[]>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
  )
  // 0 vrstic = tabela/stolpec manjka → migracija ni aplicirana
  return rows.length > 0 ? rows[0].is_nullable === 'YES' : false
}

/* ───────────────────────── register ───────────────────────── */

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: 'issue3',
    descKey: 'mig.issue3.desc',
    endpoint: '/api/admin/migrate-issue3',
    probe: () => columnsAll([
      ['Table', 'qrToken'], ['Table', 'qrEnabled'], ['Table', 'qrRotatedAt'],
      ['DeviceRegistry', 'pairingCode'], ['DeviceRegistry', 'pairingExpiresAt'],
      ['DeviceRegistry', 'pairedToDeviceId'], ['DeviceRegistry', 'displayPayload'],
      ['DeviceRegistry', 'displayUpdatedAt'], ['DeviceRegistry', 'revokedAt'],
      ['Order', 'orderSource'],
    ]),
  },
  {
    id: 'issue4',
    descKey: 'mig.issue4.desc',
    endpoint: '/api/admin/migrate-issue4',
    probe: () => columnsAll([
      ['DeviceRegistry', 'enrollmentCode'],
      ['DeviceRegistry', 'enrollmentExpiresAt'],
      ['DeviceRegistry', 'enrollmentClaimedAt'],
    ]),
  },
  {
    id: 'issue1-s6',
    descKey: 'mig.issue1s6.desc',
    endpoint: '/api/admin/migrate-issue1-s6',
    probe: () => columnsAll([
      ['Discount', 'happyDays'], ['Discount', 'happyFromHour'],
      ['Discount', 'happyToHour'], ['Discount', 'targetCategoryIds'],
    ]),
  },
  {
    id: 'issue1-s7',
    descKey: 'mig.issue1s7.desc',
    endpoint: '/api/admin/migrate-issue1-s7',
    probe: () => tableExists('SpecialOpeningDay'),
  },
  {
    id: 'issue10',
    descKey: 'mig.issue10.desc',
    endpoint: '/api/admin/migrate-issue10',
    probe: () => tableExists('PrintJob'),
  },
  {
    id: 'issue11',
    descKey: 'mig.issue11.desc',
    endpoint: '/api/admin/migrate-issue11',
    // proxy za enum vrednosti (glej opis modula): tabele + propertyId stolpci
    // (obe podpreverbi eksplicitno await — brez lebdečih promise-ov)
    probe: async () =>
      (await tablesAll(['Organization', 'Brand', 'Property', 'Workstation', 'EventLog']))
      && (await columnsAll([['Location', 'propertyId'], ['RevenueCenter', 'propertyId']])),
  },
  {
    id: 'issue12',
    descKey: 'mig.issue12.desc',
    endpoint: '/api/admin/migrate-issue12',
    probe: () => columnsAll([
      ['Employee', 'mfaSecret'], ['Employee', 'mfaEnabled'],
      ['Employee', 'mfaRecoveryCodes'], ['Employee', 'mfaEnrolledAt'],
    ]),
  },
  {
    id: 'issue13',
    descKey: 'mig.issue13.desc',
    endpoint: '/api/admin/migrate-issue13',
    probe: () => columnNullable('Location', 'premisesId'),
  },
  {
    id: 'haccp-plans',
    descKey: 'mig.haccpPlans.desc',
    endpoint: '/api/admin/migrate-haccp-plans',
    probe: () => tableExists('HaccpPlan'),
  },
  {
    // Task 66 (v1.64.0): stroški kategorije — NOV STOLPEC na živeči tabeli.
    // Main schema.prisma polja še NIMA (zastrupitev P2022 do DDL) — polje je samo
    // v dev zrcalu. Ko je DDL apliciran, NASLEDNJA naloga doda polje v main schema
    // (koda/UI kategorij); do takrat drift-check prikaže ::warning:: (DROP COLUMN
    // faza — glej isStroskiKategorijeStatement v scripts/drift-check.ts).
    id: 'stroski-kategorije',
    descKey: 'mig.stroskiKategorije.desc',
    endpoint: '/api/admin/migrate-stroski-kategorije',
    probe: () => columnExists('AccountsPayable', 'category'),
  },
  {
    // P1-6 (v1.87.0): split po gostih — DROP orderId unique + 3 novi stolpci.
    // Predpogoj: osnovna migracija 'paylink' (tabela obstaja); ruta zavrne
    // izvedbo s 409 če tabele še ni (konzola pokaže paylink kot čakajočega).
    id: 'paylink-split',
    descKey: 'mig.paylinkSplit.desc',
    endpoint: '/api/admin/migrate-paylink-split',
    probe: () => columnsAll([
      ['PayLink', 'splitIndex'], ['PayLink', 'splitCount'], ['PayLink', 'approvalCode'],
    ]),
  },
  {
    // Issue #37 (v1.98.0): kanonična Stripe Checkout seja na PayLink —
    // potrditev plačila sprejme SAMO sejo, ki je atomarno prijavljena na
    // povezavi (CAS) in vezana prek Stripe metadata. Predpogoj: tabela PayLink.
    id: 'paylink-session',
    descKey: 'mig.paylinkSession.desc',
    endpoint: '/api/admin/migrate-paylink-session',
    probe: () => columnExists('PayLink', 'sessionId'),
  },
  {
    // Issue #38 (v1.100.0, P1): EventLog."locationId" — kanonični tenant ključ
    // dogodkovne vrste (strežniško izpeljan; NULL = samo bootstrap operator).
    id: 'issue38',
    descKey: 'mig.issue38.desc',
    endpoint: '/api/admin/migrate-issue38',
    probe: () => columnExists('EventLog', 'locationId'),
  },
  {
    // Issue #18 (v1.103.0, P1): tolerance tristranskega ujemanja — 4 stolpci na
    // RestaurantSettings (qty/price/vat % + centi zaokroževanja). Privzeto strogo
    // (0 % / 2 c) — ohlapitev je izrecna odločitev settings.manage osebe.
    // Do DDL: match motor teče na strogih privzetkih (graceful), pisanje → 503.
    id: 'ap-tolerance',
    descKey: 'mig.apTolerance.desc',
    endpoint: '/api/admin/migrate-ap-tolerance',
    probe: () => columnsAll([
      ['RestaurantSettings', 'apMatchQtyTolerancePct'],
      ['RestaurantSettings', 'apMatchPriceTolerancePct'],
      ['RestaurantSettings', 'apMatchVatTolerancePct'],
      ['RestaurantSettings', 'apMatchAmountToleranceCents'],
    ]),
  },
  {
    // OPS-4 (v1.67.0): nova DB vloga 'cleaner' (čistilka — haccp.execute).
    // Postgres: ALTER TYPE ADD VALUE IF NOT EXISTS (migrate-cleaner-role).
    // SQLite: role je String — brez DDL, probe vedno true (konzola pokaže aplicirano).
    // Probe je dialekt-ozaveščena (enako kot columnNullable zgoraj).
    id: 'paylink',
    descKey: 'mig.paylink.desc',
    endpoint: '/api/admin/migrate-paylink',
    probe: () => tableExists('PayLink'),
  },
  {
    id: 'cleaner-role',
    descKey: 'mig.cleanerRole.desc',
    endpoint: '/api/admin/migrate-cleaner-role',
    probe: async () => {
      if ((process.env.DATABASE_URL ?? '').startsWith('file:')) return true
      const rows = await db.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT 'cleaner' = ANY(enum_range(NULL::"EmployeeRole")) AS ok`,
      )
      return rows.length > 0 && rows[0].ok === true
    },
  },
  {
    // Issue #7 (P1, v1.104.0): alergeni — en vir resnice. 10 stolpcev na 3
    // obstoječih tabelah (InventoryItem sestavina / MenuItem jed / OrderItem
    // posnetek naročila). Do DDL: pisanje 503 (graceful), javni meni pade
    // nazaj na legacy prosto besedilo (toleranten parse).
    id: 'allergen-truth',
    descKey: 'mig.allergenTruth.desc',
    endpoint: '/api/admin/migrate-allergen-truth',
    probe: () => columnsAll([
      ['InventoryItem', 'allergens'], ['InventoryItem', 'allergensCrossContact'],
      ['InventoryItem', 'allergensConfirmedAt'], ['InventoryItem', 'allergensConfirmedById'],
      ['MenuItem', 'allergensOverride'], ['MenuItem', 'allergensConfirmedAt'],
      ['MenuItem', 'allergensConfirmedById'], ['MenuItem', 'allergenReviewFlag'],
      ['MenuItem', 'allergenReviewReason'], ['OrderItem', 'allergenSnapshot'],
      ['OrderItem', 'allergenWarning'],
    ]),
  },
  {
    // Issue #15 (P1, v1.105.0): lot governance — 9 stolpcev na InventoryBatch
    // (alert/removal datum + karantena/odpoklic hold/release sled) + podatkovna
    // normalizacija legacy status='active' (receive pot ≤ v1.104 ni bila FEFO
    // razporejena — SQLite case-sensitive). Statusi QUARANTINE/RECALLED so
    // proste vrednosti obstoječega status stolpca (brez DDL).
    id: 'lot-governance',
    descKey: 'mig.lotGovernance.desc',
    endpoint: '/api/admin/migrate-lot-governance',
    probe: () => columnsAll([
      ['InventoryBatch', 'alertDate'], ['InventoryBatch', 'removalDate'],
      ['InventoryBatch', 'holdReason'], ['InventoryBatch', 'holdAt'],
      ['InventoryBatch', 'holdById'], ['InventoryBatch', 'holdRef'],
      ['InventoryBatch', 'releaseAt'], ['InventoryBatch', 'releaseById'],
      ['InventoryBatch', 'releaseNote'],
    ]),
  },
  {
    // Issue #19 (P1/P2, v1.107.0): politika finančnih izjem — 9 stolpcev na
    // RestaurantSettings (pragovi odobritve popusta/preklica/storna + obveznost
    // razloga). Privzeto: % prag 15 (dosedanja disciplina), zneskovni pragovi
    // izklopljeni, razlog obvezen za preklic/storno/void. Do DDL: varni
    // privzetki (graceful), pisanje → 503.
    id: 'exception-policy',
    descKey: 'mig.exceptionPolicy.desc',
    endpoint: '/api/admin/migrate-exception-policy',
    probe: () => columnsAll([
      ['RestaurantSettings', 'excDiscountApprovalPct'],
      ['RestaurantSettings', 'excDiscountApprovalAmountCents'],
      ['RestaurantSettings', 'excVoidApprovalAmountCents'],
      ['RestaurantSettings', 'excStornoApprovalAmountCents'],
      ['RestaurantSettings', 'excCancelApprovalAmountCents'],
      ['RestaurantSettings', 'excRequireReasonDiscount'],
      ['RestaurantSettings', 'excRequireReasonCancel'],
      ['RestaurantSettings', 'excRequireReasonStorno'],
      ['RestaurantSettings', 'excRequireReasonVoid'],
    ]),
  },
  {
    // Issue #19 (P1/P2, v1.107.0): katalog razlogov izjem — 2 stolpca na
    // obstoječem VoidReason (kind vrste izjeme + requireComment). PONOVNA
    // UPORABA obstoječega modela (brez vzporednega sistema razlogov). Obstoječe
    // vrstice ostanejo 'void'. Do DDL: katalog veljaven samo za void.
    id: 'exception-reasons',
    descKey: 'mig.exceptionReasons.desc',
    endpoint: '/api/admin/migrate-exception-reasons',
    probe: () => columnsAll([
      ['VoidReason', 'kind'], ['VoidReason', 'requireComment'],
    ]),
  },
  {
    // Issue #16 (P1/P2, v1.108.0): blagajniški premiki denarja — NOVA tabela
    // CashMovement (knjiga neprodajnih premikov predala na obstoječi izmeni;
    // scalar vezave brez FK, EventLog vzorec) + 2 politika stolpca na
    // RestaurantSettings (prag variance, slepi popis) + 3 povzetek stolpca na
    // ZReport (paidIn/paidOut/guestRefund; typed cashDrops = odvod v sef).
    id: 'cash-movements',
    descKey: 'mig.cashMovements.desc',
    endpoint: '/api/admin/migrate-cash-movements',
    probe: async () =>
      (await columnsAll([
        ['RestaurantSettings', 'cashVarianceThresholdCents'],
        ['RestaurantSettings', 'cashBlindCount'],
        ['ZReport', 'cashPaidIn'],
        ['ZReport', 'cashPaidOut'],
        ['ZReport', 'cashGuestRefund'],
      ])) && (await tableExists('CashMovement')),
  },
  {
    // Issue #20 (P1/P2, v1.109.0): operativni HACCP tok — 12 novih stolpcev na
    // HaccpEntry (vezava na načrt, strukturirana meritev, cikel odstopanja),
    // 13 novih stolpcev na HaccpPlan (pravila meritev, termin, različica) +
    // NOVA tabela HaccpAction (append-only revizijski dogodki: korektivni
    // ukrep / verifikacija). Stare vrstice ostanejo 'legacy' — obstoječi
    // tokovi (načrti brez novih polj, ad-hoc vnosi, zgodovina) se ne dotaknejo
    // (graceful degradacija prek haccpOpsColumnsReady probe).
    id: 'haccp-ops',
    descKey: 'mig.haccpOps.desc',
    endpoint: '/api/admin/migrate-haccp-ops',
    probe: async () =>
      (await columnsAll([
        ['HaccpEntry', 'planId'],
        ['HaccpEntry', 'entryState'],
        ['HaccpEntry', 'occurrenceKey'],
        ['HaccpPlan', 'measureKind'],
        ['HaccpPlan', 'dueTime'],
        ['HaccpPlan', 'version'],
      ])) && (await tableExists('HaccpAction')),
  },
  {
    // Issue #13 (P1/P2, v1.110.0): javni rezervacijski widget — NOVA tabela
    // ReservationWidget (ena vrstica na lokacijo: skrivnostni token javne
    // povezave /r/<token>, vklop, politika terminov). locationId je skalar
    // brez FK (EventLog vzorec). Dokler DDL ni apliciran, javne rute widgeta
    // odgovarjajo 404 — interni rezervacijski tok se ne dotakne.
    id: 'reservation-widget',
    descKey: 'mig.reservationWidget.desc',
    endpoint: '/api/admin/migrate-reservation-widget',
    probe: async () => (await tableExists('ReservationWidget')),
  },
  {
    // Issue #21 (P1/P2, v1.111.0): klic vodje iz POS-a — NOVA tabela
    // ManagerCall (življenjski cikel zahtev za pomoč: OPEN → ESCALATED
    // (krogi, max 3) / ACKNOWLEDGED → IN_PROGRESS → RESOLVED / CANCELLED;
    // skalarne vezave brez FK, snapshot imen, dostavna evidenca,
    // idempotencyKey). locationId je skalar brez FK (EventLog vzorec).
    // Do DDL: rute klica vodja odgovarjajo 503 (graceful) — POS tok
    // se ne dotakne.
    id: 'manager-call',
    descKey: 'mig.managerCall.desc',
    endpoint: '/api/admin/migrate-manager-call',
    probe: async () => (await tableExists('ManagerCall')),
  },
]

/* ───────────────────────── status ───────────────────────── */

export interface MigrationStatus {
  id: string
  applied: boolean
  /** infra napaka probe — ni "pending", konzola pokaže resnico */
  error?: string
}

/** test hook: vsili probe rezultat (simulacija DDL pending brez rušenja sheme) */
const probeOverrides = new Map<string, boolean>()

export function setMigrationProbeOverride(id: string, applied: boolean): void {
  probeOverrides.set(id, applied)
}

export function clearMigrationProbeOverrides(): void {
  probeOverrides.clear()
}

/** Status vseh migracij v register rednem vrstnem redu. */
export async function schemaMigrationsStatus(): Promise<MigrationStatus[]> {
  const out: MigrationStatus[] = []
  for (const m of SCHEMA_MIGRATIONS) {
    const override = probeOverrides.get(m.id)
    if (override !== undefined) {
      out.push({ id: m.id, applied: override })
      continue
    }
    try {
      out.push({ id: m.id, applied: await m.probe() })
    } catch (e) {
      out.push({ id: m.id, applied: false, error: (e as Error).message })
    }
  }
  return out
}
