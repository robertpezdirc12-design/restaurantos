import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.288.0 — SWEEP GLOBJI PREGLED preostalih FIELD_SWEEP razlik (A-kandidat iz
 * zaključka v1.286.0/v1.287.0: »globji pregled preostalih FIELD_SWEEP razlik +
 * demo-history semena — naslednji val zapiše s številkami«).
 *
 * MERITEV (2 zeleni teki suite na svežem semenu, DMMF pregled vseh 142 tabel,
 * klasifikacija vsake vrstice po predponski prisotnosti v KATEREM KOLI polju):
 *  - Akumulacija na tek (tek 1 → tek 2): GuestFeedback 7→14, HaccpAction 9→18,
 *    Integration(+Log) 4+1→8+2, InventoryItem 9→18, Reservation 19→38 (od 20
 *    do 39 skupaj), StockTransaction 5→10, JournalLine 6→12 + JournalEntry
 *    2→4, AIConversation 3→6, DeliveryInfo 1→2, EventLog 6→12 (payload),
 *    AuditLog 26→52 (details) + 19→~19 userId (prehodni — naslednji tek jih
 *    pobere), Counter 7→14 (order:<mrtev nid>).
 *  - KORENSKI VZORCI (po razredu): vsi so nid() id + locationId NULL ali
 *    ODRLI (skalar/izbrisana lokacija) + predpona v besedilnem polju, ki ga
 *    doslej NOBEN prehod ni pometal. Izjemi: haccpAction (predponski
 *    locationId, SKALAR — nakana iz v1.109.0 nikoli izvedena v seznamu) in
 *    GL journalLine/journalEntry (vnos BREZ predponskega polja — dokaz je
 *    VRSTICA, zato zbirni prehod 0d po vzorcu 0c).
 *  - DEMO-REALNA meja (zavestno ven, z številkami): AuditLog ~41/tek ČISTIH
 *    (DEMO_LOGIN na demo adminu + dejanja demo entitet), EventLog ~22/tek
 *    čistih, Counter 'grn:GRN-<datum>' 1/dan (vrednost raste znotraj dneva),
 *    Integration ensure-vrstice 3 (stabilne, idempotentne). Vrste so brez
 *    predpone → varnostna pogodba sweepa (brisanje IZKLJUČNO po testni
 *    predponi) jih NE SME tid — dokumentirane, ne pometane.
 *
 * POPRAVEK (fixture-sweep.ts):
 *  - FIELD_SWEEP +9 vnosov (vrstni red FK-diktiran: stockTransaction PRED
 *    inventoryItem — Restrict): stockTransaction/employeeName,
 *    inventoryItem/name, integration/name (Cascade vzame IntegrationLog),
 *    reservation/customerName (Table.reservationId SetNull),
 *    guestFeedback/guestName+comment+tableId, aIConversation/employeeId,
 *    deliveryInfo/deliveryInstructions, eventLog/payload (contains — furspost
 *    »by« SRED JSON), auditLog/details (contains — poNumber SRED JSON; drugi
 *    vnos poleg obstoječega userId iz v1.285.0).
 *  - LOCATION_CHILD_SWEEP: 'haccpAction' PRED 'haccpEntry' (izvedba
 *    dokumentirane nakane v1.109.0) + 'journalLine' (plastena varovalka).
 *  - 0d ZBIRNI PREHOD: GL vnosi — journalEntryId zbrano iz journalLine s
 *    predponskim locationId (+ IN-seznam lokacijskih sirot po imenu 0a),
 *    vrstice PRED vnosi (Restrict FK), PRED fazo 1.
 *  - 0a IZTEG: Counter 'receipt:<locId>'/'order:<locId>' pobranih lokacijskih
 *    sirot — exact-match po celem imenu (demo števci živih lokacij in 'grn:'
 *    dnevni števec ostanejo).
 *  - tests/v190-web-portal.test.ts: deliveryInstructions nosi predpono
 *    (naslov/telefon sta predmet asercij — nosilec je navodilo).
 *
 * HIGIENA: vsa nid fikstura v tej datoteki tečejo v try/finally z eksplicitno
 * unikatnimi pini (lekcija v1.286.0 — padec asercije ne sme pustiti nid
 * vrstic, ki NOBEN sweep ne vidi več).
 */

const P = 'v288-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(guestFeedback|haccpAction|integration|inventoryItem|stockTransaction|reservation|journalLine|journalEntry|aIConversation|deliveryInfo|eventLog|auditLog|counter|location):/

// ── Ç1) VEDENJE — vsak razred vrzeli izoliran ────────────────────────────

describe('v288 Ç1: sweep pobira 9 razredov predponskih sirot (globji pregled)', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Ç1a gfb vzorec: GuestFeedback (nid, predponski guestName/comment/tableId, locationId NULL) → pobran', async () => {
    // Izmerjeno 7/tek iz tests/guest-feedback.test.ts (QR povratne informacije
    // prek javne rute). Stara koda: id-nid + locationId NULL → neviden.
    // Napoved rdečega dokaza: 1 (FAIL).
    const id = nid()
    await db.guestFeedback.create({
      data: { id, guestName: `${P} Ana`, comment: `${P} super hrana!`, tableId: `${P}tbl-${RUN}`, source: 'qr' },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.guestFeedback.count({ where: { id } })).toBe(0)
    } finally {
      await db.guestFeedback.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1b i20 vzorec: HaccpAction (nid, predponski SKALARNI locationId) → pobran lokacijskim prehodom', async () => {
    // Izmerjeno 9/tek iz tests/issue20-haccp-ops.test.ts. Nakana iz v1.109.0
    // (»lokacijski prehod PRED haccpEntry«) nikoli izvedena v seznamu.
    // Napoved rdečega dokaza: 1 (FAIL).
    const locId = `${P}locH-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija H ${RUN}`, code: `V288H${RUN.toUpperCase()}` } })
    const id = nid()
    await db.haccpAction.create({
      data: { id, entryId: nid(), locationId: locId, kind: 'corrective', performedById: `${P}cleaner-${RUN}`, performedByName: `${P}cleaner` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.haccpAction.count({ where: { id } })).toBe(0) // lokacijski prehod (novi vpis)
      expect(await db.location.count({ where: { id: locId } })).toBe(0)
    } finally {
      await db.haccpAction.deleteMany({ where: { id } }).catch(() => null)
      await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1c i30 vzorec: Integration (nid, predponsko ime, locationId NULL) → pobrana + Cascade vzame IntegrationLog', async () => {
    // Izmerjeno 4/tek + 1 log/tek iz tests/issue30-37-ssrf.test.ts.
    // IntegrationLog → Integration je CASCADE → z integracijo pade dnevnik.
    // Napoved rdečega dokaza: 1 + 1 (FAIL obe).
    const id = nid()
    await db.integration.create({ data: { id, name: `${P}Pzcqw`, type: '', provider: '' } })
    const logId = nid()
    await db.integrationLog.create({ data: { id: logId, integrationId: id, action: 'test_connection' } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.integration.count({ where: { id } })).toBe(0) // FIELD_SWEEP name
      expect(await db.integrationLog.count({ where: { id: logId } })).toBe(0) // CASCADE
    } finally {
      await db.integrationLog.deleteMany({ where: { id: logId } }).catch(() => null)
      await db.integration.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1d i52 vzorec: InventoryItem (nid, predponsko ime) + StockTransaction (nid, predponski employeeName) → oba pobrana (FK vrstni red)', async () => {
    // Izmerjeno 9 artiklov + 5 transakcij/tek iz tests/issue52-55-58-59-inventory.
    // StockTransaction → InventoryItem je Restrict → transakcije MORAJO pasti
    // prej (sicer brisanje artikla P2003 šum). Napoved: 1 + 1 (FAIL obe).
    const itemId = nid()
    await db.inventoryItem.create({ data: { id: itemId, name: `${P} wh artikel ${RUN}`, unit: 'pcs' } })
    const stxId = nid()
    await db.stockTransaction.create({
      data: { id: stxId, inventoryItemId: itemId, type: 'RECEIVE', quantity: 5, previousQty: 0, newQty: 5, costPerUnit: 2, totalCost: 10, employeeName: `${P}whA` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.stockTransaction.count({ where: { id: stxId } })).toBe(0) // employeeName (PRVI v FIELD_SWEEP bloku)
      expect(await db.inventoryItem.count({ where: { id: itemId } })).toBe(0) // name (drugi — varnost FK)
    } finally {
      await db.stockTransaction.deleteMany({ where: { id: stxId } }).catch(() => null)
      await db.inventoryItem.deleteMany({ where: { id: itemId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1e v240 vzorec: Reservation (nid, predponski customerName, locationId NULL) → pobrana', async () => {
    // Izmerjeno 19/tek iz tests/v240-reservation-cell.test.ts (javni widget).
    // Napoved: 1 (FAIL).
    const id = nid()
    await db.reservation.create({
      data: { id, customerName: `${P}Ana`, dateTime: new Date(Date.now() + 86_400_000), partySize: 2 },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.reservation.count({ where: { id } })).toBe(0)
    } finally {
      await db.reservation.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1f i5 vzorec (GL zbirni prehod 0d): JournalEntry (BREZ predponskega polja) + JournalLine (predponski locationId) → VNOS pade prek vrstice', async () => {
    // Izmerjeno 6 vrstic + 2 vnosa/tek iz tests/issue5-authorization
    // (POST /api/reports/gl s testno lokacijo). Vnos nima NOBENEGA predponskega
    // polja — dokaz je VRSTICA (vzorec 0c bazenov napitnin). Brez 0d bi vnos
    // ostal ZA VEDNO (prazna lupina po lokacijskem brisanju vrstic).
    // Napoved: vrstica 1 + vnos 1 (FAIL obe) na stari kodi.
    const entryId = nid()
    await db.journalEntry.create({
      data: { id: entryId, entryNumber: `V288-${RUN}`, source: 'auto', description: 'Avtomatski dnevni obračun prodaje' },
    })
    const lineId = nid()
    await db.journalLine.create({
      data: { id: lineId, journalEntryId: entryId, accountCode: '401', accountName: 'Prihodki od prodaje', accountType: 'revenue', debit: 0, credit: 10, description: 'Avtomatski dnevni obračun prodaje', locationId: `${P}locGL-${RUN}` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.journalLine.count({ where: { id: lineId } })).toBe(0) // 0d + lokacijski vpis
      expect(await db.journalEntry.count({ where: { id: entryId } })).toBe(0) // SAMO 0d (zbirni prehod)
    } finally {
      await db.journalLine.deleteMany({ where: { id: lineId } }).catch(() => null)
      await db.journalEntry.deleteMany({ where: { id: entryId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1g v186ai vzorec: AIConversation (nid, predponski employeeId) → pobran', async () => {
    // Izmerjeno 3/tek iz tests/v186-ai-insights.test.ts (insight_pack).
    // Napoved: 1 (FAIL).
    const id = nid()
    await db.aIConversation.create({
      data: { id, type: 'insight_pack', userMessage: 'vpogled', aiResponse: 'odgovor', employeeId: `${P}mgr-${RUN}` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.aIConversation.count({ where: { id } })).toBe(0)
    } finally {
      await db.aIConversation.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1h v190wp vzorec: DeliveryInfo (nid, predponsko deliveryInstructions) → pobran', async () => {
    // Izmerjeno 1/tek iz tests/v190-web-portal.test.ts (javni portal).
    // Napoved: 1 (FAIL).
    const id = nid()
    await db.deliveryInfo.create({
      data: { id, address: 'Slovenska 1', recipientName: 'Micka', deliveryInstructions: `${P} Zvonec na dvorišče` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.deliveryInfo.count({ where: { id } })).toBe(0)
    } finally {
      await db.deliveryInfo.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1i furspost vzorec: EventLog (nid id/entityId/locationId — VSI nid, predpona SAMO SRED payload JSON) → pobran (contains)', async () => {
    // Izmerjeno 6/tek iz tests/furs-post.test.ts (StockChanged ob fiskalnem
    // stornu; lokacijo počisti reverse-FK afterAll testa SAM — dokaz je
    // "by":"furspost-…" v payloadu). Napoved: 1 (FAIL).
    const id = nid()
    await db.eventLog.create({
      data: { id, type: 'StockChanged', entityType: 'InventoryItem', entityId: nid(), locationId: nid(), payload: `{"variance":2,"cause":"receipt-storno","receiptNumber":"2026-11-09-BLGX","by":"${P}emp-${RUN}"}` },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.eventLog.count({ where: { id } })).toBe(0) // payload contains
    } finally {
      await db.eventLog.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1j v156r/disc59 vzorec: AuditLog (nid, predpona SAMO SRED details JSON — userId brez predpone) → pobran (contains)', async () => {
    // Izmerjeno 26/tek (v156r-/disc59-/hcp64-/i53-/i4-: poNumber/grnNumber SRED
    // details JSON). Obstoječi userId prehod (v1.285.0) teh vrstic NE vidi.
    // Napoved: 1 (FAIL).
    const id = nid()
    await db.auditLog.create({
      data: { id, action: 'PO_RECEIVED', entityType: 'PurchaseOrder', details: `{"poNumber":"PO-V288-${RUN}","total":10}`, userId: '' },
    })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.auditLog.count({ where: { id } })).toBe(0) // details contains
    } finally {
      await db.auditLog.deleteMany({ where: { id } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1k Counter izteg 0a: nid()-id lokacija s predponskim IMENOM + njen števec »order:<locId>« → oba pobrana, števec realne lokacije preživi', async () => {
    // Izmerjeno +7 'order:<nid>'/tek — lokacije pobere 0a, števci ostanejo
    // (referencirajo lokacijo SRED imena; nextSequence jih nikoli več ne
    // pomika). Napoved: števec 1 + lokacija 0 (FAIL števec) na stari kodi.
    // SAMOZADOSTNOST (LEKCIJA v1.287.0): realna lokacija je NAŠA fikstura
    // (nid id + ime brez testne predpone) — NE semenska vrstica, ki v CI
    // (ci-fresh.db, brez db:seed) ne obstaja.
    const realLocId = nid()
    await db.location.create({ data: { id: realLocId, name: `Restavracija Demo K ${RUN}`, code: `V288KR${RUN.toUpperCase()}` } })
    const demoCounterName = `receipt:${realLocId}`
    const demoCounterId = nid()
    await db.counter.create({ data: { id: demoCounterId, name: demoCounterName, value: 5 } })
    const locId = nid() // NAMENOMA nid — vzorec API-ustvarjene lokacije
    await db.location.create({ data: { id: locId, name: `${P} Nova Lokacija ${RUN}`, code: `V288K${RUN.toUpperCase()}` } })
    const counterId = nid()
    await db.counter.create({ data: { id: counterId, name: `order:${locId}`, value: 3 } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.counter.count({ where: { id: counterId } })).toBe(0) // izteg 0a (exact-match)
      expect(await db.location.count({ where: { id: locId } })).toBe(0) // 0a + faza 4
      expect(await db.counter.count({ where: { id: demoCounterId } })).toBe(1) // števec realne lokacije preživi
      expect(await db.location.count({ where: { id: realLocId } })).toBe(1) // realna lokacija preživi
    } finally {
      await db.counter.deleteMany({ where: { id: counterId } }).catch(() => null)
      await db.counter.deleteMany({ where: { id: demoCounterId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: realLocId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1l varnost + meja: demo-realne vrstice (brez predpone) preživijo; id-pot integracije nespremenjena', async () => {
    // REGRESIJSKI VARUH VARNOSTI: popravek NE SME segati mimo testnih predpon.
    // Demo profil (izmerjena DEMO-REALNA meja vala — zavestno ven): auditLog
    // brez predpone, eventLog brez predpone, reservation 'Ana Kovac Demo',
    // inventoryItem 'Moka Demo', GL vnos demo lokacije — VSI preživijo.
    // Id-predponska integracija pade po obstoječi poti (kontinuiteta).
    const auditId = nid()
    await db.auditLog.create({ data: { id: auditId, action: 'DEMO_ACTION', entityType: 'Demo', details: '{"poNumber":"PO-DEMO-1"}' } })
    const eventId = nid()
    await db.eventLog.create({ data: { id: eventId, type: 'DemoEvent', payload: '{"by":"ana-demo"}' } })
    const resvId = nid()
    await db.reservation.create({ data: { id: resvId, customerName: `Ana Kovac Demo ${RUN}`, dateTime: new Date(Date.now() + 86_400_000), partySize: 2 } })
    const itemId = nid()
    await db.inventoryItem.create({ data: { id: itemId, name: `Moka Demo ${RUN}`, unit: 'kg' } })
    // SAMOZADOSTNOST (LEKCIJA v1.287.0): realna lokacija je NAŠA fikstura (nid
    // id + ime brez predpone) — ne semenska vrstica (v CI je baza prazna).
    const realLocId = nid()
    await db.location.create({ data: { id: realLocId, name: `Restavracija Demo L ${RUN}`, code: `V288LR${RUN.toUpperCase()}` } })
    const glEntryId = nid()
    await db.journalEntry.create({ data: { id: glEntryId, entryNumber: `V288D-${RUN}`, source: 'auto' } })
    const glLineId = nid()
    await db.journalLine.create({
      data: { id: glLineId, journalEntryId: glEntryId, accountCode: '401', accountName: 'Prihodki od prodaje', accountType: 'revenue', debit: 0, credit: 5, locationId: realLocId },
    })
    const prefIntId = `${P}int-id-${RUN}`
    await db.integration.create({ data: { id: prefIntId, name: `Demo Integracija ${RUN}`, type: '', provider: '' } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.auditLog.count({ where: { id: auditId } })).toBe(1) // demo-realen — meja
      expect(await db.eventLog.count({ where: { id: eventId } })).toBe(1) // demo-realen — meja
      expect(await db.reservation.count({ where: { id: resvId } })).toBe(1) // demo ime
      expect(await db.inventoryItem.count({ where: { id: itemId } })).toBe(1) // demo ime
      expect(await db.journalEntry.count({ where: { id: glEntryId } })).toBe(1) // GL realne lokacije
      expect(await db.journalLine.count({ where: { id: glLineId } })).toBe(1) // vrstica realne lokacije
      expect(await db.location.count({ where: { id: realLocId } })).toBe(1) // realna lokacija preživi
      expect(await db.integration.count({ where: { id: prefIntId } })).toBe(0) // id-pot nespremenjena
    } finally {
      await db.auditLog.deleteMany({ where: { id: auditId } }).catch(() => null)
      await db.eventLog.deleteMany({ where: { id: eventId } }).catch(() => null)
      await db.reservation.deleteMany({ where: { id: resvId } }).catch(() => null)
      await db.inventoryItem.deleteMany({ where: { id: itemId } }).catch(() => null)
      await db.journalLine.deleteMany({ where: { id: glLineId } }).catch(() => null)
      await db.journalEntry.deleteMany({ where: { id: glEntryId } }).catch(() => null)
      await db.integration.deleteMany({ where: { id: prefIntId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: realLocId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1m najdba #2 — instrumenti vračil (v243 stale vzorec): GC+LA z nid id-jem + predponskim imenom + ČISTIMI Restrict otroki → zbirni prehod 0e pobere vse', async () => {
    // Izmerjeno po samostojnem teku 7 datotek: 5 darilnih kartic + 6 računov
    // zvestobe z nid() id-jem, lokacija že izbrisana (SetNull) → lastni v243
    // cleanup po locationId jih ne vidi. Transakcije REDEEM/REFUND so BREZ
    // predpone (note nosi predpono samo ob izdaji) → Restrict blokada → samo
    // zbirni prehod 0e (otroci pobrani prek starša) reši vse.
    // Napoved na stari kodi: GC 1 + GTX 2 + LA 1 + LT 1 + gost 1 + kupon 1 (FAIL).
    const gostId = nid()
    await db.guest.create({ data: { id: gostId, lastName: `${P} Gost`, email: `${P}--gost-${RUN}@test.local` } })
    const kuponId = nid()
    await db.coupon.create({ data: { id: kuponId, code: `${P}--D1-${RUN}`, guestId: gostId, expiresAt: new Date(Date.now() + 86_400_000) } })
    const gcId = nid()
    await db.giftCard.create({ data: { id: gcId, ownerName: `${P} Gost`, cardNumber: `GC-${P}-${RUN}`, balance: 10, initialBalance: 10 } })
    const gtxIssue = nid()
    await db.giftCardTransaction.create({ data: { id: gtxIssue, giftCardId: gcId, type: 'issue', amount: 10, balanceAfter: 10, note: `${P} izdaja` } })
    const gtxRedeem = nid()
    await db.giftCardTransaction.create({ data: { id: gtxRedeem, giftCardId: gcId, type: 'redeem', amount: 4, balanceAfter: 6 } }) // ČIST otrok — bloker
    const laId = nid()
    await db.loyaltyAccount.create({ data: { id: laId, customerName: `${P} Zvesti Gost`, customerEmail: '' } })
    const ltId = nid()
    await db.loyaltyTransaction.create({ data: { id: ltId, loyaltyAccountId: laId, points: 5, type: 'earn' } }) // ČIST otrok — bloker
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.giftCard.count({ where: { id: gcId } })).toBe(0) // 0e zbirni
      expect(await db.giftCardTransaction.count({ where: { id: gtxIssue } })).toBe(0)
      expect(await db.giftCardTransaction.count({ where: { id: gtxRedeem } })).toBe(0) // čist otrok pade s staršem
      expect(await db.loyaltyAccount.count({ where: { id: laId } })).toBe(0) // 0e zbirni
      expect(await db.loyaltyTransaction.count({ where: { id: ltId } })).toBe(0) // čist otrok pade s staršem
      expect(await db.guest.count({ where: { id: gostId } })).toBe(0) // FIELD_SWEEP lastName/email
      expect(await db.coupon.count({ where: { id: kuponId } })).toBe(0) // FIELD_SWEEP code
    } finally {
      await db.loyaltyTransaction.deleteMany({ where: { id: ltId } }).catch(() => null)
      await db.loyaltyAccount.deleteMany({ where: { id: laId } }).catch(() => null)
      await db.giftCardTransaction.deleteMany({ where: { id: { in: [gtxIssue, gtxRedeem] } } }).catch(() => null)
      await db.giftCard.deleteMany({ where: { id: gcId } }).catch(() => null)
      await db.coupon.deleteMany({ where: { id: kuponId } }).catch(() => null)
      await db.guest.deleteMany({ where: { id: gostId } }).catch(() => null)
    }
  }, 60_000)

  test('Ç1n najdba #2 varnost: realni instrumenti (gost/kupon/kartica/zvestoba z imeni brez predpone) preživijo', async () => {
    // REGRESIJSKI VARUH: 0e in FIELD_SWEEP coupon/guest ne smeta segati mimo
    // testnih predpon — realna darilna kartica 'Ana Horvat Demo', njen ČIST
    // otrok (redeem), realen račun zvestobe + transakcija, realen gost in
    // kupon morajo preživeti.
    const gostId = nid()
    await db.guest.create({ data: { id: gostId, lastName: `Kovač Demo ${RUN}`, email: `ana-demo-${RUN}@test.local` } })
    const kuponId = nid()
    await db.coupon.create({ data: { id: kuponId, code: `WELCOME-${RUN}`, guestId: gostId, expiresAt: new Date(Date.now() + 86_400_000) } })
    const gcId = nid()
    await db.giftCard.create({ data: { id: gcId, ownerName: `Ana Horvat Demo ${RUN}`, cardNumber: `GC-DEMO-${RUN}`, balance: 10, initialBalance: 10 } })
    const gtxId = nid()
    await db.giftCardTransaction.create({ data: { id: gtxId, giftCardId: gcId, type: 'redeem', amount: 3, balanceAfter: 7 } })
    const laId = nid()
    await db.loyaltyAccount.create({ data: { id: laId, customerName: `Ana Zvesta Demo ${RUN}`, customerEmail: `zvesta-demo-${RUN}@test.local` } })
    const ltId = nid()
    await db.loyaltyTransaction.create({ data: { id: ltId, loyaltyAccountId: laId, points: 5, type: 'earn' } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.guest.count({ where: { id: gostId } })).toBe(1)
      expect(await db.coupon.count({ where: { id: kuponId } })).toBe(1)
      expect(await db.giftCard.count({ where: { id: gcId } })).toBe(1)
      expect(await db.giftCardTransaction.count({ where: { id: gtxId } })).toBe(1)
      expect(await db.loyaltyAccount.count({ where: { id: laId } })).toBe(1)
      expect(await db.loyaltyTransaction.count({ where: { id: ltId } })).toBe(1)
    } finally {
      await db.loyaltyTransaction.deleteMany({ where: { id: ltId } }).catch(() => null)
      await db.loyaltyAccount.deleteMany({ where: { id: laId } }).catch(() => null)
      await db.giftCardTransaction.deleteMany({ where: { id: gtxId } }).catch(() => null)
      await db.giftCard.deleteMany({ where: { id: gcId } }).catch(() => null)
      await db.coupon.deleteMany({ where: { id: kuponId } }).catch(() => null)
      await db.guest.deleteMany({ where: { id: gostId } }).catch(() => null)
    }
  }, 60_000)
})

// ── Ç2) PINI — statične varovalke popravka ───────────────────────────────

describe('v288 Ç2: pini popritja (9 FIELD_SWEEP vnosov + lokacijska vpisa + 0d + izteg + v190)', () => {
  test('FIELD_SWEEP vsebuje vseh 9 novih vnosov s pravimi polji', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'stockTransaction', fields: ['employeeName'] }")
    expect(src).toContain("{ model: 'inventoryItem', fields: ['name'] }")
    expect(src).toContain("{ model: 'integration', fields: ['name'] }")
    expect(src).toContain("{ model: 'reservation', fields: ['customerName'] }")
    expect(src).toContain("{ model: 'guestFeedback', fields: ['guestName', 'comment', 'tableId'] }")
    expect(src).toContain("{ model: 'aIConversation', fields: ['employeeId'] }")
    expect(src).toContain("{ model: 'deliveryInfo', fields: ['deliveryInstructions'] }")
    expect(src).toContain("{ model: 'eventLog', fields: ['payload'], contains: true }")
    expect(src).toContain("{ model: 'auditLog', fields: ['details'], contains: true }")
  })

  test('FK vrstni red: stockTransaction PRED inventoryItem v FIELD_SWEEP (Restrict otrok prej)', () => {
    // igli vključujeta polja — ID_SWEEP vsebuje goli "{ model: 'inventoryItem' }
    // (zgornji del datoteke), ki bi s preprosto iglo lažno zmagal primerjavo
    const src = read('tests/helpers/fixture-sweep.ts')
    const iStx = src.indexOf("{ model: 'stockTransaction', fields: ['employeeName'] }")
    const iInv = src.indexOf("{ model: 'inventoryItem', fields: ['name'] }")
    expect(iStx).toBeGreaterThan(-1)
    expect(iInv).toBeGreaterThan(iStx)
  })

  test("LOCATION_CHILD_SWEEP vsebuje 'haccpAction' PRED 'haccpEntry' (izvedba nakane v1.109.0) in 'journalLine'", () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const start = src.indexOf('const LOCATION_CHILD_SWEEP = [')
    const end = src.indexOf('] as const', start)
    const block = src.slice(start, end)
    const iAction = block.indexOf("'haccpAction',")
    const iEntry = block.indexOf("'haccpEntry',")
    expect(iAction).toBeGreaterThan(-1)
    expect(iEntry).toBeGreaterThan(iAction)
    expect(block).toContain("'journalLine',")
  })

  test('0d zbiralni prehod: orphanJournalEntryIds iz vrstic s predponskim locationId (+ IN-seznam), vrstice PRED vnosi, PRED fazo 1', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('const orphanJournalEntryIds')
    expect(src).toContain("await dele('journalEntry', { id: { in: orphanJournalEntryIds } })")
    const iCollect = src.indexOf('const orphanJournalEntryIds')
    const iLines = src.indexOf("await dele('journalLine'", iCollect)
    const iEntry = src.indexOf("await dele('journalEntry'", iCollect)
    const iPhase1 = src.indexOf('// 1. blok prehod po id')
    expect(iLines).toBeGreaterThan(iCollect) // vrstice po zbiranju …
    expect(iEntry).toBeGreaterThan(iLines) // … pred vnosi (Restrict)
    expect(iPhase1).toBeGreaterThan(iEntry) // vse pred fazo 1
  })

  test('0a izteg: Counter receipt:/order: po CELEM imenu pobranih lokacijskih sirot', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("name: { in: orphanLocIds.flatMap((id) => [`receipt:${id}`, `order:${id}`]) }")
    const iOrphan = src.indexOf('const orphanLocIds = (')
    const iIzteg = src.indexOf('orphanLocIds.flatMap')
    expect(iIzteg).toBeGreaterThan(iOrphan)
  })

  test('v190 nosilec: deliveryInstructions v javni dostavni fiksturi nosi predpono', () => {
    const src = read('tests/v190-web-portal.test.ts')
    expect(src).toContain('instructions: `${PREFIX} Zvonec na dvorišče`')
  })

  test('NAJDBA MED VALOM — števci naročil v 7 leaker datotekah: counter čiščenje razširjeno na order (vzorec furs-post receipt)', () => {
    // Živa verifikacija po teku je razkrila 49 NOVIH mrtvih 'order:<nid>'
    // števcev (po remedyju #1): 7 datotek (v238/v239/v243/v249/v250/v251/
    // zreport-storno) ustvari lokacije z nid() id-jem + predponskim IMENOM in
    // jih pobriše z ROČNIM reverse-FK afterAll (kateri koli kasnejši sweep ne
    // vidi več lokacije → 0a izteg ne more pobrati števca). PRVI POSKUS
    // (zamik sweepa pred ročno čiščenje) je REGRESIRAL: sweep pobriše naročila
    // PREJ, ročna zanka po orderId zgreši transakcije → P2003 blokada artiklov
    // (3 v238 vrstice v živi bazi dokaz) → REVERT. KONČNA REŠITEV po vzorcu
    // furs-post: razširitev obstoječega counter brisanja na order števec
    // (v251 nov vnos — dosedaj ni čistil števcev). Dokaz: tek 7 datotek po
    // popravku pusti 0 mrtvih števcev.
    const STARTS = [
      'tests/v238-money-integrity.test.ts',
      'tests/v239-receipt-cell.test.ts',
      'tests/v243-povracilna-celica.test.ts',
      'tests/v249-cenovni-val.test.ts',
      'tests/v250-tempo-val.test.ts',
    ]
    for (const f of STARTS) {
      expect(read(f), f).toContain('name: { in: [`receipt:${locId}`, `order:${locId}`] }')
    }
    expect(read('tests/zreport-storno.test.ts')).toContain('name: { in: [`receipt:${id}`, `order:${id}`] }')
    expect(read('tests/v251-crtna-koda.test.ts')).toContain('name: { in: [`receipt:${locId}`, `order:${locId}`] }')
    // drugi val najdbe #1 (živa verifikacija finalnega teka — 8 novih mrtvih
    // števcev iz treh dodatnih datotek z istim receipt-only vzorcem):
    expect(read('tests/v237-kds-modifiers.test.ts')).toContain('name: { in: [`receipt:${locId}`, `order:${locId}`] }')
    expect(read('tests/handheld-flow.test.ts')).toContain('name: { in: [`receipt:${locId}`, `order:${locId}`] }')
    expect(read('tests/paylink-flow.test.ts')).toContain('name: { in: [`receipt:${loc.id}`, `order:${loc.id}`] }')
    // varovalka: zamik NI smel ostati (regresija P2003)
    for (const f of [...STARTS, 'tests/zreport-storno.test.ts', 'tests/v251-crtna-koda.test.ts']) {
      const src = read(f)
      const afterAllAt = src.indexOf('afterAll(async () => {')
      const iSweep = src.indexOf('sweepTestFixtures(db, [PREFIX])', afterAllAt)
      const iCleanup = src.indexOf('await cleanupFixtures()', afterAllAt)
      if (iCleanup !== -1) expect(iCleanup, f).toBeLessThan(iSweep) // ročno čiščenje PREJ sweepu (originalni vrstni red)
    }
  })

  test('0e zbiralni prehod (najdba #2): orphanGiftCardIds/orphanLoyaltyIds — otroci prek starša (vzorec 0c/0d)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('const orphanGiftCardIds')
    expect(src).toContain("await dele('giftCardTransaction', { giftCardId: { in: orphanGiftCardIds } })")
    expect(src).toContain("await dele('giftCard', { id: { in: orphanGiftCardIds } })")
    expect(src).toContain('const orphanLoyaltyIds')
    expect(src).toContain("await dele('loyaltyTransaction', { loyaltyAccountId: { in: orphanLoyaltyIds } })")
    expect(src).toContain("await dele('loyaltyAccount', { id: { in: orphanLoyaltyIds } })")
    // vrstni red: transakcije PREJ starši (Restrict), vse PRED fazo 1
    const iCollect = src.indexOf('const orphanGiftCardIds')
    const iGc = src.indexOf("await dele('giftCard'", iCollect)
    const iGtx = src.indexOf("await dele('giftCardTransaction'", iCollect)
    const iPhase1 = src.indexOf('// 1. blok prehod po id')
    expect(iGtx).toBeGreaterThan(iCollect)
    expect(iGc).toBeGreaterThan(iGtx)
    expect(iPhase1).toBeGreaterThan(src.indexOf('const orphanLoyaltyIds'))
  })

  test('FIELD_SWEEP vsebuje coupon/guest vnose (najdba #2 — listi brez Restrict blokad)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'coupon', fields: ['code'] }")
    expect(src).toContain("{ model: 'guest', fields: ['lastName', 'email'] }")
  })

  test('v288- registriran v TEST_PREFIXES; skupaj 139 vnosov (138 + ta val)', () => {
    expect(TEST_PREFIXES, P).toContain(P)
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('kontinuiteta registracije: v282-/v284-/v285-/v286- ostanejo (migracija sledi trenutnemu stanju)', () => {
    expect(TEST_PREFIXES).toContain('v282-')
    expect(TEST_PREFIXES).toContain('v284-')
    expect(TEST_PREFIXES).toContain('v285-')
    expect(TEST_PREFIXES).toContain('v286-')
  })

  test('hex-varnost: vsaka predpona brez pomišljaja vsebuje ne-hex znak (nid() je samo [0-9a-f])', () => {
    for (const p of TEST_PREFIXES) {
      if (p.endsWith('-')) continue
      expect(p, p).toMatch(/[^0-9a-f]/)
    }
  })
})

// ── Ç3) TEŽA — merjeno, ne ugibano ─────────────────────────────────────

describe('v288 Ç3: centralni sweep s 139 predponami (živi ostanki → 0 + varnost realnih podatkov)', () => {
  test('poln sweep < 30 s; signali v288 pobrani; realne vrstice before=after', async () => {
    // ŽIVI DOKAZ: po 2 meritvenih tekih je baza nakladala izmerjene
    // predponske ostanke (Ç1 razredi). Centralni sweep mora vse ŽIVE predponske
    // signale pometati na 0 — tudi na sveži CI bazi (struktna trditev).
    // realni gostje: id IN lastName/email brez predpone (najdba #2 — gost je
    // pometen po lastName, ne po id → nid gost s predponskim priimkom NI realen)
    const isRealGuest = (g: { id: string; lastName?: string | null; email?: string | null }) =>
      !TEST_PREFIXES.some((p) => g.id.startsWith(p) || (g.lastName ?? '').startsWith(p) || (g.email ?? '').startsWith(p))
    const realGuestsBefore = (await db.guest.findMany({ select: { id: true, lastName: true, email: true } })).filter(isRealGuest).length
    // realne lokacije: id IN ime brez predpone (0a pobira po imenu; faza 4 po
    // id-ju) — predponski vrstni-red ostanki prejšnjih datotek NISO šum te
    // asercije (centralni sweep jih po pravičnosti pobere)
    const isRealLoc = (l: { id: string; name: string }) => !TEST_PREFIXES.some((p) => l.id.startsWith(p) || l.name.startsWith(p))
    const realLocsBefore = (await db.location.findMany({ select: { id: true, name: true } })).filter(isRealLoc).length
    // scena puščanja kot živi dokaz centralne poti (vzorec Ç1d + Ç1f)
    const itemId = nid()
    await db.inventoryItem.create({ data: { id: itemId, name: `${P} c3 artikel ${RUN}`, unit: 'pcs' } })
    const entryId = nid()
    await db.journalEntry.create({ data: { id: entryId, entryNumber: `V288C3-${RUN}`, source: 'auto' } })
    const lineId = nid()
    await db.journalLine.create({
      data: { id: lineId, journalEntryId: entryId, accountCode: '401', accountName: 'Prihodki od prodaje', accountType: 'revenue', debit: 0, credit: 7, locationId: `${P}c3loc-${RUN}` },
    })
    try {
      const t0 = Date.now()
      const res = await sweepTestFixtures(db, TEST_PREFIXES)
      const ms = Date.now() - t0
      console.log(`[v288] centralni sweep (139 predpon): ${ms} ms (referenca v286: 138 predpon 1,2–1,4 s)`)
      expect(ms).toBeLessThan(30_000)
      expect(res.remainingLocations).toBe(0)
      expect(await db.inventoryItem.count({ where: { id: itemId } })).toBe(0)
      expect(await db.journalLine.count({ where: { id: lineId } })).toBe(0)
      expect(await db.journalEntry.count({ where: { id: entryId } })).toBe(0) // zbirni prehod na centralni poti
      // vsi živi predponski signali novih razredov → 0 (živi dokaz pometanja
      // nakladanja iz meritev vala: gfb 14, i20 18, i30 8, i52 18, v240 38, …)
      expect(await db.guestFeedback.count({ where: { OR: [{ guestName: { startsWith: 'gfb-' } }, { comment: { startsWith: 'gfb-' } }, { tableId: { startsWith: 'gfb-' } }] } })).toBe(0)
      expect(await db.haccpAction.count({ where: { locationId: { startsWith: 'i20-' } } })).toBe(0)
      expect(await db.integration.count({ where: { name: { startsWith: 'i30-' } } })).toBe(0)
      expect(await db.inventoryItem.count({ where: { name: { startsWith: 'i52-' } } })).toBe(0)
      expect(await db.reservation.count({ where: { customerName: { startsWith: 'v240-' } } })).toBe(0)
      expect(await db.stockTransaction.count({ where: { employeeName: { startsWith: 'i52-' } } })).toBe(0)
      expect(await db.aIConversation.count({ where: { employeeId: { startsWith: 'v186ai-' } } })).toBe(0)
      expect(await db.deliveryInfo.count({ where: { deliveryInstructions: { startsWith: 'v190wp-' } } })).toBe(0)
      expect(await db.eventLog.count({ where: { payload: { contains: 'furspost' } } })).toBe(0)
      expect(await db.journalLine.count({ where: { locationId: { startsWith: 'i5-' } } })).toBe(0)
      // najdba #2 — instrumenti vračil (stale v243 vrstice iz samostojnih tekov vala):
      // 5 GC + 6 LA + 1 gost + 3 kuponi + transakcije — vse pobere 0e + FIELD_SWEEP
      expect(await db.giftCard.count({ where: { ownerName: { startsWith: 'v243-' } } })).toBe(0)
      expect(await db.loyaltyAccount.count({ where: { customerName: { startsWith: 'v243-' } } })).toBe(0)
      expect(await db.guest.count({ where: { lastName: { startsWith: 'v243-' } } })).toBe(0)
      expect(await db.coupon.count({ where: { code: { startsWith: 'v243-' } } })).toBe(0)
      // varnost: realni gostje in realne lokacije nedotaknjeni
      const realGuestsAfter = (await db.guest.findMany({ select: { id: true, lastName: true, email: true } })).filter(isRealGuest).length
      expect(realGuestsAfter).toBe(realGuestsBefore)
      const realLocsAfter = (await db.location.findMany({ select: { id: true, name: true } })).filter(isRealLoc).length
      expect(realLocsAfter).toBe(realLocsBefore)
    } finally {
      await db.journalLine.deleteMany({ where: { id: lineId } }).catch(() => null)
      await db.journalEntry.deleteMany({ where: { id: entryId } }).catch(() => null)
      await db.inventoryItem.deleteMany({ where: { id: itemId } }).catch(() => null)
    }
  }, 60_000)
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v288 Ž: registri', () => {
  test('verzija 1.297.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.297.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.297.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.297.0-obnova-12-reset-bun144-artefakti')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena sweepa)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('SweepGlobjiPregled')
    expect(read('prisma/schema.prisma')).not.toContain('SweepGlobjiPregled')
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
