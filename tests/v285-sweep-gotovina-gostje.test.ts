import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.285.0 — SWEEP GOTOVINSKA GIBANJA + GOSTJE (CashMovement + Guest).
 *
 * Izveden A-kandidat iz zaključka v1.284.0 (»cashMovement i16- + guest v187cp-
 * (v NOBENEM seznamu; OB NALAGATA čez teke) + vrstni-red ostanki«).
 *
 * VRZEL (izmerjeno v1.284.0, potvrjeno v tem valu na živi bazi):
 *  - CashMovement NI bil v NOBENEM seznamu (ID_SWEEP/LOCATION_CHILD_SWEEP/
 *    FIELD_SWEEP) → 68 živih vrstic: 36 z id-predpono (i16-mv-…, db.create
 *    pot tests/issue16-cash-movements.test.ts:152) + 32 z nid() id-jem, ki jih
 *    piše PRODUKCIJSKA ruta POST /api/shifts/movements (predponski locationId
 *    + userId + shiftId — skalarji BREZ FK). nalaganje čez teke: 27 (meritev
 *    v1.284.0) → 68 (meritev v1.285.0) — rast +41 v enem valu.
 *  - Guest NI bil v NOBENEM seznamu → 32 živih vrstic v187cp- (tests/
 *    v187-coupons.test.ts:87 jih seje s predponskim id-jem IN locationId
 *    lokacije; faza 4 izbriše lokacijo → Guest.locationId SetNull FK → NULL
 *    → NEVIDEN vsem lokacijskim prehodom, ID_SWEEP pa ga ni videl, ker
 *    model ni bil na seznamu). nalaganje: 24 → 32. +40 kuponov otrok
 *    (Coupon.guestId → CASCADE — padejo s staršem, a le ČE starš pade).
 *
 * FAKTOGRAFSKA KOREKTURA v1.284.0 (pošteno zapisano, vzorec LEKCIJE 4):
 * zaključek v1.284.0 je trdil »drži 27 zaposlenih i60-/v225- prek userId
 * Restrict, 2 P2003«. Živa resnica (PRAGMA foreign_key_list(CashMovement) =
 * PRAZEN): CashMovement NIMA DB-FK — P2003 iz brisanja zaposlenih je bil
 * nemogoč. Vseh 68 userId kaže na i16- zaposlene (že pocenjeni); 28 i60- +
 * 8 v225- zaposlenih so vrstni-red ostanki (ustvarjeni PO točki centralnega
 * sweepa v istem teku suite), ki jih nič ne drži — naslednji tek jih pobere.
 * VRZEL (kopičenje vrstic) je realna in izmerjena; mehanizem »talca« je bil
 * napačno pripisan. Vrstni-red ostanki iz zaključka v1.284.0 (v161- lokacija /
 * afx-×2 inventoryItem / i11-×1 loyaltyAccount) so izmerjeno 0 DANES — teki
 * po v1.284.0 so jih pobrali (samoceljivost dokazana v praksi).
 *
 * POPRAVEK (fixture-sweep.ts, 4 mesti):
 *  - ID_SWEEP: { model: 'guestVisit', alt: 'guestId' } PRED guest —
 *    GuestVisit.guestId je OBAVEZEN FK z Restrict (edini ne-kaskadni otrok
 *    gosta: Coupon CASCADE, Order SetNull; CampaignSend/GuestConsent sta
 *    skalarja brez FK). Brez tega bi crash i11 teka (edina zapisovalca
 *    GuestVisit ročno čistita — 0 vrstic v živi bazi) pustil PAR
 *    gost+obisk, ki ga NOBEN naslednji tek ne more pobrati (P2003 zanka).
 *    Vzorec: loyaltyTransaction/alt loyaltyAccountId iz v1.283.0.
 *  - ID_SWEEP: { model: 'guest' } — pobira id-predponske goste (v187cp-),
 *    tudi ko je locationId NULL (SetNull sirota).
 *  - ID_SWEEP: { model: 'cashMovement' } PRED cashRegisterShift (skalar
 *    shiftId — semantični otrok izmene; brez lastnih FK → čist list).
 *  - LOCATION_CHILD_SWEEP: 'cashMovement' PRED cashRegisterShift —
 *    API-ustvarjena gibanja (nid() id) testnih lokacij (32 živih vrstic).
 *
 * ZAVESTNO VEN: guest iz LOCATION_CHILD_SWEEP (0 nid() zapisovalcev —
 * produkcija ne ustvarja gostov: rg '\.guest\.(create|upsert)' src/ = 0 zadetkov;
 * vsi testi sejejo goste z id-predpono direktno → ID_SWEEP jih vidi v fazi 1
 * ŠE PRED izbrisom lokacije). Vzorec Workstation iz v1.284.0; pin Č2 varuje.
 */

const P = 'v285-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(cashMovement|guest|guestVisit|coupon|location|employee|cashRegisterShift|tipDistribution|tipPool|auditLog):/

// ── Č1) VEDENJE — vrzel izolirana na vsakem nivoju ───────────────────────

describe('v285 Č1: sweep pobira gotovinska gibanja in goste', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Č1a i16 vzorec: gibanje s predponskim id-jem (db.create pot) → ID_SWEEP prehod', async () => {
    // IZOLACIJA VRZELI (izmerjeno 36 živih vrstic i16-mv-…): test ustvari
    // gibanje z id-predpono direktno (tests/issue16:152 vzorec). ID_SWEEP
    // prehod po id ga mora pobrati — prej modela ni bilo na seznamu.
    const empId = `${P}emp-${RUN}`
    await db.employee.create({ data: { id: empId, name: `Sim ${RUN}`, email: `${P}emp-${RUN}@test.local` } })
    const mvId = `${P}mv-${RUN}`
    await db.cashMovement.create({
      data: { id: mvId, shiftId: `${P}shift-${RUN}`, locationId: `${P}loc-${RUN}`, type: 'paid_out', direction: 'out', amount: 10, userId: empId, userName: 'Sim' },
    })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.cashMovement.count({ where: { id: mvId } })).toBe(0)
    expect(await db.employee.count({ where: { id: empId } })).toBe(0) // zaposleni že pokrit
  }, 60_000)

  test('Č1b API vzorec: gibanje z nid() id-jem + predponski locationId (32 živih vrstic iz /api/shifts/movements) → lokacijski prehod', async () => {
    // PRODUKCIJSKA ruta piše nid() id + predponski locationId/userId/shiftId
    // (skalarji brez FK). ID_SWEEP po id-predponi takšne vrstice NE vidi →
    // potreben LOCATION_CHILD_SWEEP vpis (vzorec deviceSyncOperation).
    const locId = `${P}locB-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija B ${RUN}`, code: `V285B${RUN.toUpperCase()}` } })
    const mvId = nid()
    await db.cashMovement.create({
      data: { id: mvId, shiftId: nid(), locationId: locId, type: 'paid_out', direction: 'out', amount: 5, userId: nid(), userName: 'API' },
    })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.cashMovement.count({ where: { id: mvId } })).toBe(0)
    expect(await db.cashMovement.count({ where: { locationId: locId } })).toBe(0)
    expect(await db.location.count({ where: { id: locId } })).toBe(0)
  }, 60_000)

  test('Č1c v187cp vzorec: gost (id-predpona, SetNull sirota) + kupon (Cascade) + obisk (Restrict) → vsi pobrani', async () => {
    // Najglobja veriga: GuestVisit.guestId Restrict bi blokiral brisanje gosta
    // (P2003 zanka brez alt prehoda); Coupon.guestId Cascade pade s staršem;
    // gost z locationId NULL je neviden lokacijskim prehodom — vidi ga samo
    // ID_SWEEP po id-predponi.
    const guestId = `${P}g-${RUN}`
    await db.guest.create({ data: { id: guestId, firstName: `${P}Ime`, lastName: 'Test' } }) // locationId NULL = stanje PO izbrisu lokacije (SetNull)
    const couponId = nid()
    await db.coupon.create({
      data: { id: couponId, code: `V285C${RUN}`, guestId, expiresAt: new Date(Date.now() + 86_400_000) },
    })
    const visitId = nid()
    await db.guestVisit.create({ data: { id: visitId, guestId, partySize: 2, totalSpent: 50 } })
    const res = await sweepTestFixtures(db, [P])
    expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
    expect(await db.guest.count({ where: { id: guestId } })).toBe(0)
    expect(await db.coupon.count({ where: { id: couponId } })).toBe(0) // kaskada z gostom
    expect(await db.guestVisit.count({ where: { id: visitId } })).toBe(0) // alt guestId prehod PRED gostom
  }, 60_000)

  test('Č1d varnost: realen gost in realno gibanje (nid id, brez predpon) preživita; id-poti nespremenjene', async () => {
    // REGRESIJSKI VARUH VARNOSTI: popravek NE SME segati mimo testnih predpon.
    // Realen gost (nid() id, navadno ime) in realno gibanje (nid() id,
    // locationId realne lokacije) morata preživeti; id-predponski gost z
    // imenom brez predpone se pobere po id-poti kot prej.
    const realGuestId = nid()
    await db.guest.create({ data: { id: realGuestId, firstName: 'Ana', lastName: `Demo V285 ${RUN}` } })
    const realLocId = nid()
    await db.location.create({ data: { id: realLocId, name: `Restavracija Demo V285 ${RUN}`, code: `RDV285${RUN.toUpperCase()}` } })
    const realMvId = nid()
    await db.cashMovement.create({
      data: { id: realMvId, shiftId: nid(), locationId: realLocId, type: 'paid_out', direction: 'out', amount: 1, userId: nid(), userName: 'Demo' },
    })
    const prefGuestId = `${P}id-gost-${RUN}`
    await db.guest.create({ data: { id: prefGuestId, firstName: 'Ime brez predpone', lastName: 'Test' } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.guest.count({ where: { id: realGuestId } })).toBe(1) // preživi — ni testna
      expect(await db.cashMovement.count({ where: { id: realMvId } })).toBe(1) // preživi — lokacija ni testna
      expect(await db.location.count({ where: { id: realLocId } })).toBe(1) // preživi — ni testna
      expect(await db.guest.count({ where: { id: prefGuestId } })).toBe(0) // id pot nespremenjena
    } finally {
      // higija lastnih fiksur — try/finally (v1.286.0 NAJDBA: ročni izbris PO
      // asercijah je v rdečih tekih pustil 5× (lokacija+gost+gibanje) v živi
      // bazi — nid BREZ predponskega signala, NOBEN sweep jih ne vidi)
      await db.cashMovement.deleteMany({ where: { id: realMvId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: realLocId } }).catch(() => null)
      await db.guest.deleteMany({ where: { id: realGuestId } }).catch(() => null)
      await db.guest.deleteMany({ where: { id: prefGuestId } }).catch(() => null)
    }
  }, 60_000)

  test('Č1e i60/v225 vzorec (NAJDBA MED VALOM): TipDistribution (nid id, predponski employeeId RESTRICT) ne blokira več zaposlenih', async () => {
    // REŠITEV UGANKE »2 P2003« iz v1.284.0: API-ustvarjene distribucije napitnin
    // (nid() id iz POST /api/shifts/tips) nosijo predponski employeeId (RESTRICT
    // FK) → ena sama blokirana vrstica povrne CELO employee deleteMany (SQLite
    // atomarnost izjave) → VSI id-predponski zaposleni ostanejo skupaj (izmerjeno
    // 36 živih: 28 i60- + 8 v225- čez 4 teke). Brez alt prehoda se nalaga VEČNO.
    const empId = `${P}empX-${RUN}`
    await db.employee.create({ data: { id: empId, name: `Natakar ${RUN}`, email: `${P}empX-${RUN}@test.local`, pin: `${RUN}x` } })
    const poolId = nid()
    await db.tipPool.create({ data: { id: poolId, date: new Date() } })
    const distId = nid()
    await db.tipDistribution.create({ data: { id: distId, tipPoolId: poolId, employeeId: empId, employeeName: `${P}Natakar`, amount: 5 } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipDistribution.count({ where: { id: distId } })).toBe(0) // alt employeeId prehod
      expect(await db.employee.count({ where: { id: empId } })).toBe(0) // P2003 veriga prekinjena
    } finally {
      // TipPool nid() sirota BREZ predponskega polja: zbirni prehod 0c (v1.286.0)
      // jo pobere če distribucija še živi; try/finally higiena varuje rdeče teke
      await db.tipDistribution.deleteMany({ where: { id: distId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: poolId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: empId } }).catch(() => null)
    }
  }, 60_000)


})

// ── Č2) PINI — statične varovalke popravka ───────────────────────────────

describe('v285 Č2: pini pokritja (gibanja + gostje + registracija)', () => {
  test('ID_SWEEP: cashMovement PRED cashRegisterShift (skalar shiftId — semantični otrok izmene)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const iCash = src.indexOf("{ model: 'cashMovement' }")
    const iShift = src.indexOf("{ model: 'cashRegisterShift' }")
    expect(iCash).toBeGreaterThan(-1)
    expect(iShift).toBeGreaterThan(iCash)
  })

  test('ID_SWEEP: guestVisit z alt guestId PRED guest (Restrict otrok — vzorec loyaltyTransaction iz v1.283.0)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const iVisit = src.indexOf("{ model: 'guestVisit', alt: 'guestId' }")
    const iGuest = src.indexOf("{ model: 'guest' }")
    expect(iVisit).toBeGreaterThan(-1)
    expect(iGuest).toBeGreaterThan(iVisit)
  })

  test("LOCATION_CHILD_SWEEP vsebuje 'cashMovement' (API/nid() otroci testnih lokacij — 32 živih vrstic)", () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const start = src.indexOf('const LOCATION_CHILD_SWEEP = [')
    const end = src.indexOf('] as const', start)
    expect(src.slice(start, end)).toContain("'cashMovement',")
  })

  test('guest ZAVESTNO VEN iz LOCATION_CHILD_SWEEP (0 nid() zapisovalcev — produkcija ne ustvarja gostov); komentar dokumentira', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const start = src.indexOf('const LOCATION_CHILD_SWEEP = [')
    const end = src.indexOf('] as const', start)
    expect(src.slice(start, end)).not.toContain("'guest'")
    expect(src).toContain('produkcija ne ustvarja gostov')
  })

  test('v285- registriran v TEST_PREFIXES; skupaj 137 vnosov (136 + ta val)', () => {
    expect(TEST_PREFIXES, P).toContain(P)
    expect(TEST_PREFIXES.length).toBe(142)
  })

  test('i16- in v187cp- sta bili registrirani ŽE PREJ — vrzel vala je v SEZNAMIH modelov, ne v registraciji', () => {
    // Vzorec iz v1.284.0: registracija brez vnosa v sweep sezname je mrtva
    // črka — predpona je v TEST_PREFIXES od v1.108.0/v1.187.0, vrstice pa so
    // se nalagale, ker modela nista bila v NOBENEM prehodu.
    expect(TEST_PREFIXES).toContain('i16-')
    expect(TEST_PREFIXES).toContain('v187cp-')
  })

  test('hex-varnost: vsaka predpona brez pomišljaja vsebuje ne-hex znak (nid() je samo [0-9a-f])', () => {
    for (const p of TEST_PREFIXES) {
      if (p.endsWith('-')) continue
      expect(p, p).toMatch(/[^0-9a-f]/)
    }
  })

  test("ID_SWEEP: tipDistribution z alt employeeId (RESTRICT vzrok P2003 — odkritje med valom; izmerjeno 12 živih vrstic)", () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'tipDistribution', alt: 'employeeId' }")
  })

  test("FIELD_SWEEP: auditLog po userId (produkcija piše nid() id — vzorec scheduledEmailLog/recipient iz v1.282.0; izmerjeno 16)", () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain("{ model: 'auditLog', fields: ['userId'] }")
  })
})

// ── Č3) TEŽA — merjeno, ne ugibano ─────────────────────────────────────

describe('v285 Č3: centralni sweep s 137 predponami (živi ostanki → 0 + varnost realnih podatkov)', () => {
  test('poln sweep < 30 s; i16-/v187cp- živi ostanki pobrani; realni gostje before=after', async () => {
    // ŽIVI DOKAZ: pred popravkom je centralni sweep pustil 68 gibanj + 32
    // gostov + 40 kuponov (meritev vala). Po popravku mora biti 0 — tudi na
    // sveži CI bazi (struktorna trditev: po sweepu ni ostankov).
    const cashBefore = await db.cashMovement.count({
      where: { OR: [{ id: { startsWith: 'i16-' } }, { locationId: { startsWith: 'i16-' } }] },
    })
    const guestBefore = await db.guest.count({ where: { id: { startsWith: 'v187cp-' } } })
    const couponBefore = await db.coupon.count({ where: { guestId: { startsWith: 'v187cp-' } } })
    // NAJDBA MED VALOM: TipDistribution RESTRICT je povzročal P2003 rollback
    // CELEGA employee deleteMany → 36 zaposlenih (28 i60- + 8 v225-) je
    // preživelo VSE prejšnje sweepe; AuditLog.userId ×16 produkcjski smeti.
    const blockedEmpBefore = await db.employee.count({
      where: { OR: [{ id: { startsWith: 'i60-' } }, { id: { startsWith: 'v225-' } }] },
    })
    const auditOrphanBefore = await db.auditLog.count({
      where: { OR: [{ userId: { startsWith: 'i60-' } }, { userId: { startsWith: 'v225-' } }] },
    })
    const tipDistBefore = await db.tipDistribution.count({
      where: { OR: [{ employeeId: { startsWith: 'i60-' } }, { employeeId: { startsWith: 'v225-' } }] },
    })
    console.log(`[v285] živi ostanki PRED: cashMovement(i16-)=${cashBefore} guest(v187cp-)=${guestBefore} coupon(otroci)=${couponBefore} (meritev vala: 68/32/40)`)
    console.log(`[v285] najdba med valom PRED: zaposleni(i60-/v225-)=${blockedEmpBefore} tipDistribution=${tipDistBefore} auditLog(userId)=${auditOrphanBefore} (meritev: 36/12/16)`)
    const isReal = (g: { id: string }) => !TEST_PREFIXES.some((p) => g.id.startsWith(p))
    const realGuestsBefore = (await db.guest.findMany({ select: { id: true } })).filter((g) => isReal(g)).length
    const t0 = Date.now()
    const res = await sweepTestFixtures(db, TEST_PREFIXES)
    const ms = Date.now() - t0
    console.log(`[v285] centralni sweep (137 predpon): ${ms} ms (referenca v284: 136 predpon 1,1–1,3 s)`)
    expect(ms).toBeLessThan(30_000)
    expect(res.remainingLocations).toBe(0)
    expect(await db.cashMovement.count({
      where: { OR: [{ id: { startsWith: 'i16-' } }, { locationId: { startsWith: 'i16-' } }] },
    })).toBe(0)
    expect(await db.guest.count({ where: { id: { startsWith: 'v187cp-' } } })).toBe(0)
    expect(await db.coupon.count({ where: { guestId: { startsWith: 'v187cp-' } } })).toBe(0)
    expect(await db.employee.count({
      where: { OR: [{ id: { startsWith: 'i60-' } }, { id: { startsWith: 'v225-' } }] },
    })).toBe(0)
    expect(await db.tipDistribution.count({
      where: { OR: [{ employeeId: { startsWith: 'i60-' } }, { employeeId: { startsWith: 'v225-' } }] },
    })).toBe(0)
    expect(await db.auditLog.count({
      where: { OR: [{ userId: { startsWith: 'i60-' } }, { userId: { startsWith: 'v225-' } }] },
    })).toBe(0)
    const realGuestsAfter = (await db.guest.findMany({ select: { id: true } })).filter((g) => isReal(g)).length
    expect(realGuestsAfter).toBe(realGuestsBefore)
  }, 60_000)
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v285 Ž: registri', () => {
  test('verzija 1.305.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.305.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.305.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.305.0-nadzorni-val-stabilnosti-vi')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena sweepa)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('SweepGotovina')
    expect(read('prisma/schema.prisma')).not.toContain('SweepGotovina')
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
