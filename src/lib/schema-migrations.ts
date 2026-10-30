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
  {
    // Issue #14 (P1/P2, v1.112.0): KDS poimenovane postaje — NOVI tabeli
    // StationTask (postavka × postaja: usmerjanje ob FIRE-u, posnetki imen,
    // zaporedje korakov, statusi waiting/pending/preparing/ready/done) in
    // MenuItemStation (dodatne postaje artikla M:N) + STOLPCA
    // Modifier.prepStationId (usmeritev opcije na drugo postajo) in
    // PrepStation.isExpo (izdajna postaja). Skalarne vezave brez FK
    // (EventLog/ManagerCall vzorec). Do DDL: /api/kitchen additive polja
    // (stations/tasks/stationStats) se tiho izpraznijo — queue in
    // stationTargets ostaneta nespremenjena (graceful — POS/KDS tok
    // se ne dotakne).
    id: 'kds-stations',
    descKey: 'mig.kdsStations.desc',
    endpoint: '/api/admin/migrate-kds-stations',
    probe: async () => (await tablesAll(['StationTask', 'MenuItemStation'])) && (await columnsAll([
      ['Modifier', 'prepStationId'],
      ['PrepStation', 'isExpo'],
    ])),
  },
  {
    // Issue #24 (P2, v1.114.0) — etikete za pripravljeno hrano in odprte serije.
    // NOVI tabeli PrepLabel (zamrznjen posnetek etikete + QR token skrivnost)
    // in LabelShelfRule (potrjeno pravilo roka po pripravi/odprtju po artiklu).
    // Do DDL: /api/labels* → 503 (graceful) — serije/priprava/tisk tokovi se
    // ne dotaknejo.
    id: 'prep-labels',
    descKey: 'mig.prepLabels.desc',
    endpoint: '/api/admin/migrate-prep-labels',
    probe: async () => tablesAll(['PrepLabel', 'LabelShelfRule']),
  },
  {
    // Issue #22 (P2, v1.115.0) — obračun plač pripravljeni podatki. NOVI tabeli
    // PayrollPeriod (agregatni zaklep nad obstoječo evidenco časa: obdobje po
    // lokaciji s časovnim pasom, status draft/closed, zaklep/ponovno odprtje,
    // števci vnosi/potrjene ure/izjeme, centni zneski) in PayrollExport
    // (zabeležka vsakega izvoza: seq, format, contentHash + rowDigest brez PII
    // vsebine). Do DDL: /api/payroll* → 503 (graceful) — timeclock/tips/urnik
    // tokovi se ne dotaknejo.
    id: 'payroll-periods',
    descKey: 'mig.payrollPeriods.desc',
    endpoint: '/api/admin/migrate-payroll-periods',
    probe: async () => tablesAll(['PayrollPeriod', 'PayrollExport']),
  },
  {
    // Issue #8 (P2, v1.116.0) — medlokacijski prenosi zalog. NOVI tabeli
    // StockTransfer (glava: številka TRF, status DRAFT/DISPATCHED/RECEIVED/
    // PARTIAL/CANCELLED, idempotencyKey from+key) in StockTransferItem
    // (količine/serija/ciljni artikel; transferId FK Cascade). Skalarne
    // vezave brez FK na Location/InventoryItem (PrepLabel vzorec).
    // Do DDL: /api/transfers* rute vračajo 503 (graceful — nabava/zaloga/
    // serije tokovi se ne dotaknejo).
    id: 'stock-transfers',
    descKey: 'mig.stockTransfers.desc',
    endpoint: '/api/admin/migrate-stock-transfers',
    probe: async () => tablesAll(['StockTransfer', 'StockTransferItem']),
  },
  {
    // Issue #4 (P1, v1.125.0) — odhodni B2B e-računi SI/HR. NOVA tabela
    // EInvoiceOutbox (AR vezava SetNull, profil eSLOG 2.0 SI / UBL 2.1 HR,
    // xmlPayload + xmlHash dokaz, idempotencyKey unique, statusni življenjski
    // cikel draft→…→accepted/rejected, externalRef, processedEvents dedup).
    // AR/Location dobita SAMO prisma back-relacijo (0 DDL na obstoječih
    // tabelah). Do DDL: /api/einvoices* rute 503 degradirajo (graceful),
    // izvoz receivablesByStatus/einvoicesByStatus se tiho izprazni.
    id: 'einvoice-outbox',
    descKey: 'mig.einvoiceOutbox.desc',
    endpoint: '/api/admin/migrate-einvoice-outbox',
    probe: async () => tableExists('EInvoiceOutbox'),
  },
  {
    // Issue #11 (P2, v1.126.0) — CRM gostov in kampanje. NOVE tabele
    // GuestConsent (append-only sled marketing soglasja — kanal email/sms
    // LOČENO, vir, različica besedila, dokaz izrecnega dejanja; GDPR člen 7),
    // Campaign (življenjski cikel osnutek→odobritev→načrt→pošiljanje→zaključek,
    // števci izključno iz vrstic) in CampaignSend (idempotenca
    // @@unique(campaignId+guestId), enkratni žeton za javno odjavo, statusi
    // SAMO z dokazom — SMTP sprejem = sent_to_provider, NE dostava).
    // Skalarne vezave brez FK (EventLog vzorec — 0 DDL na obstoječih
    // tabelah). Do DDL: /api/crm* rute vračajo 503 (graceful — gostje,
    // zvestoba, rezervacije tokovi se ne dotaknejo).
    id: 'crm-campaigns',
    descKey: 'mig.crmCampaigns.desc',
    endpoint: '/api/admin/migrate-crm-campaigns',
    probe: async () => tablesAll(['GuestConsent', 'Campaign', 'CampaignSend']),
  },
  {
    // P1 #8 (v1.190.0): lastni spletni portal za naročila — NOVA tabela
    // WebOrderPortal (ena vrstica na lokacijo: skrivnostni token javne
    // povezave /s/<token>, vklop, načina prevzema/dostave, dostavna
    // pristojbina, minimalni znesek, ocena priprave, HMAC skrivnost
    // javnega sledenja statusa). locationId je skalar brez FK (EventLog
    // vzorec). Dokler DDL ni apliciran, javne rute portala odgovarjajo
    // 404 — POS/QR/kiosk tok se ne dotakne.
    id: 'web-portal',
    descKey: 'mig.webPortal.desc',
    endpoint: '/api/admin/migrate-web-portal',
    probe: async () => (await tableExists('WebOrderPortal')),
  },
  {
    // P3 #20 (v1.193.0): seat-level management — aditivni stolpec OrderItem."seat"
    // (ničen; sedež = oznaka izvora postavke, ortogonalna izstavkom). Dokler DDL
    // ni apliciran, sedežne rute odgovarjajo 503 z opozorilom — plačilni tok ostane
    // nespremenjen (isti politiki kot web-portal: 404 brez tabele).
    id: 'order-item-seats',
    descKey: 'mig.orderItemSeats.desc',
    endpoint: '/api/admin/migrate-order-item-seats',
    probe: () => columnExists('OrderItem', 'seat'),
  },
  {
    // N-27-3 (v1.197.0): noge doplačil obračuna — NOVA tabela PayrollSurchargeRate
    // (ena vrstica na lokacijo, NULL = privzete; odstotki noč/nedelja/praznik/
    // nadure Decimal(5,2) — UPORABNIŠKI vhod po kolektivni pogodbi, zakonitost
    // potrdi biro; sistem izračuna zneske iz minut obračuna). Skalarna vezava
    // brez FK (PrepLabel/PayrollPeriod konvencija). Do DDL: /api/payroll/
    // surcharge-rates → 503; detail/izvoz degradirata (minute brez zneskov).
    id: 'payroll-surcharge-rates',
    descKey: 'mig.payrollSurchargeRates.desc',
    endpoint: '/api/admin/migrate-payroll-surcharge-rates',
    probe: () => tableExists('PayrollSurchargeRate'),
  },
  {
    // OSS-1 (v1.200.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md): vzdrževanje
    // opreme — NOVI tabeli Equipment (register naprav po lokaciji: vrsta,
    // serijska, namestitev, status active/broken/retired) in
    // EquipmentMaintenancePlan (servisni načrt: naslov, interval dni, zadnji/
    // naslednji servis, pavza). Overdue zastavice so IZPELJANE ob branju
    // (nextDueAt < danes) — brez cron stanja. Skalarne vezave brez FK
    // (PayrollSurchargeRate konvencija). Do DDL: /api/equipment* → 503
    // (migrBox v kartici Nastavitve → Operacija).
    id: 'equipment-maintenance',
    descKey: 'mig.equipmentMaintenance.desc',
    endpoint: '/api/admin/migrate-equipment-maintenance',
    probe: async () => tablesAll(['Equipment', 'EquipmentMaintenancePlan']),
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
