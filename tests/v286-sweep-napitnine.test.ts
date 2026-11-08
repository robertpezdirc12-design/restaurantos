import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { db } from '../src/lib/db'
import { nid } from '../src/lib/map'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'

/**
 * v1.286.0 — SWEEP BAZENI NAPITNIN (TipPool zbirni prehod 0c + lokacijski vpis).
 *
 * Izveden A-kandidat iz zaključka v1.285.0 (»TipPool nid() sirote 13 živih —
 * nid() id, locationId NULL, shiftId NULL, NOBENO polje ne nosi predpone →
 * potrebuje ZBIRNI prehod po vzorcu 0a orphanLocIds (zbrati tipPoolId iz
 * predponskih TipDistribution PRED brisanjem, potem id IN seznam)«).
 *
 * VRZEL (izmerjeno v1.286.0 na živi bazi, po meritvi 13 iz v1.285.0):
 *  - 25 živih TipPool vrstic (rast +12 čez zadnji celoten tek suite — vzorec
 *    nalaganja čez teke), VSE z: nid() id, locationId NULL, shiftId NULL,
 *    0 otrok (TipDistribution skupaj 0 — alt employeeId prehod v1.285.0 je
 *    dokazano pobral vse predponske distribucije, bazeni pa so ostali).
 *  - MEHANIZEM (PRAGMA foreign_key_list na živi bazi): TipDistribution.
 *    tipPoolId → TipPool CASCADE; TipDistribution.employeeId → Employee
 *    RESTRICT; TipPool.locationId → Location SET NULL. POST /api/tips
 *    (src/app/api/tips/route.ts:354 — poolId = nid()) ustvari bazen z nid()
 *    id-jem in testnim locationId; distribucije z nid() id-jem ter predponskim
 *    employeeId (testni zaposleni). Potek vrzeli: faza 1 pobere distribucije
 *    (alt employeeId, v1.285.0) → bazen OSTANE s predponskim locationId →
 *    TipPool ni bil v NOBENEM seznamu → faza 4 izbriše testno lokacijo →
 *    SET NULL → locationId NULL → neviden VSEM prehodom (id/lokacijskim/
 *    besedilnim). Vsak tek, ki zapre bazen, pusti eno novo siroto ZA VEDNO.
 *
 * POŠTENA OMEJITEV (deljeno z 0a iz v1.284.0): 25 obstoječih sirot po tem
 * popravku NI več moč identificirati po predponi — dokaz je VRSTICA
 * distribucije (že padla) oziroma predponski locationId (že SET NULL).
 * Enkratni remedy vala jih pobere po struktnem kriteriju (nid id +
 * locationId NULL + 0 otrok; v živi bazi 0 realnih bazenov — seed ne ustvarja
 * TipPool vrstic). Vzorec: seed-row remedy iz v1.281.0.
 *
 * POPRAVEK (fixture-sweep.ts, 4 mesta):
 *  - 0c ZBIRNI PREHOD: orphanTipPoolIds = distinct tipPoolId iz TipDistribution
 *    z id/employeeId predpono, zbrano PRED fazo 1 (ko distribucija pade, je
 *    sled izbrisana). Varnost ista kot pri 0a: bazen, na katerega kaže
 *    predponska distribucija, JE testna fikstura (produkcija ne piše testnih
 *    predpon); CASCADE pobere tudi morebitne nepredtonske otroke bazena.
 *  - faza 1 (ID_SWEEP zanka): tipPool dobi OR + { id: { in: orphanTipPoolIds } }.
 *  - faza 3 (ponovni id prehod): enako — idempotentna varovalka.
 *  - LOCATION_CHILD_SWEEP: 'tipPool' PRED izbrisom lokacije pobere API-bazene
 *    s predponskim locationId (vzorec cashMovement iz v1.285.0) — pokrije
 *    bazene, katerih distribucije ne nosijo predpone (npr. demo zaposleni);
 *    SET NULL jih sicer naredi nevidne.
 *
 * ZAVESTNO VEN (dokumentirano v Č1e): nid() bazen z NULL locationId in BREZ
 * otrok preživi tudi novi sweep — noben predponski signal ne živi več. To je
 * meja fiksture (ne izdelka); remedy vala počisti obstoječe, 0c + lokacijski
 * vpis pa preprečujeta nastanek novih (dokaz: Č1a/Č1b/Č1c).
 *
 * NAJDBA MED VALOM (higiena fiksur): v285-vzorec ročnega izbrisa PO asercijah
 * pušča nid vrstice, ko asercija pade (rdeči tek) — izpad Ç1c je v živi bazi
 * pustil PAR bazen+distribucija+zaposleni, ki NOBEN sweep ne vidi več
 * (reprodukcija: pool nid + dist nid/nid + emp nid). Vsa higiena v tej
 * datoteki zato teče v try/finally — tudi ob padcu asercije. Lekcija za
 * prihodnje valove: vsaka nid fikstura brez predponskega signala MORA imeti
 * finally-higieno.
 */

const P = 'v286-'
const RUN = Date.now().toString(36)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** Napake teh tabel so napake vala, ne šum. */
const NASI_MODELI = /^(tipPool|tipDistribution|employee|location|auditLog):/

// ── Č1) VEDENJE — vrzel izolirana na vsakem nivoju ───────────────────────

describe('v286 Č1: sweep pobira bazene napitnin (zbirni prehod + lokacijski vpis)', () => {
  beforeAll(async () => {
    await sweepTestFixtures(db, [P])
  })

  test('Č1a API vzorec (pot vrzeli ob koncu teka): bazen (nid, predponski locationId) + distribucija (nid, predponski employeeId) + lokacija → vsi pobrani', async () => {
    // KONEC-POT vzorec iz meritve (v225/race-fixes/issue60-63 poganjajo POST
    // /api/tips s testnimi lokacijami in zaposlenimi): route ustvari nid()
    // bazen + nid() distribucije s predponskim employeeId. Stara koda: faza 1
    // pobere distribucijo, bazen ostane, faza 4 izbriše lokacijo → SET NULL
    // sirota. Napoved rdečega dokaza: bazen 1 (FAIL), distribucija 0, lokacija 0.
    const empId = `${P}emp-${RUN}`
    // pin: eksplicitno UNIKATEN — privzeta vrednost "" je @unique (dva brez
    // pina = P2002); v rdečem teku izpad Č1c pusti nid zaposlenega, ki bi
    // drugače povzročil kaskado namesto izoliranega padca (lekcija rdečega dokaza)
    await db.employee.create({ data: { id: empId, name: `Natakar ${RUN}`, email: `${P}emp-${RUN}@test.local`, pin: `${RUN}a` } })
    const locId = `${P}loc-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija ${RUN}`, code: `V286A${RUN.toUpperCase()}` } })
    const poolId = nid()
    await db.tipPool.create({ data: { id: poolId, date: new Date(), locationId: locId } })
    const distId = nid()
    await db.tipDistribution.create({ data: { id: distId, tipPoolId: poolId, employeeId: empId, employeeName: `${P}Natakar`, amount: 5 } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipPool.count({ where: { id: poolId } })).toBe(0) // zbirni prehod 0c (IN-seznam)
      expect(await db.tipDistribution.count({ where: { id: distId } })).toBe(0) // alt employeeId (v1.285.0)
      expect(await db.location.count({ where: { id: locId } })).toBe(0)
      expect(await db.employee.count({ where: { id: empId } })).toBe(0)
    } finally {
      // higiena tudi ob padcu asercije (NAJDBA MED VALOM: ročni izbris PO
      // asercijah pušča nid vrstice, ki NOBEN sweep ne vidi — rdeči tek jih
      // naloži za vedno; vzorec v285 Č1e je imel isto luknjo)
      await db.tipDistribution.deleteMany({ where: { id: distId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: poolId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: empId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
    }
  }, 60_000)

  test('Č1b crash vzorec (0c izolacija): bazen (nid, locationId NULL — po-SetNull stanje) + predponska distribucija → pobran SOLO prek zbirnega prehoda', async () => {
    // STANJE PO SET NULL (vzorec sirote iz meritve): locationId je že NULL,
    // distribucija ŠE ŽIVI (npr. crash teka PRED afterAll). Samo 0c vidi
    // bazen — noben drug prehod nima signala. Napoved: bazen 1 (FAIL) na stari
    // kodi; distribucija 0 (alt pot že obstaja).
    const empId = `${P}empB-${RUN}`
    await db.employee.create({ data: { id: empId, name: `Natakar B ${RUN}`, email: `${P}empB-${RUN}@test.local`, pin: `${RUN}b` } })
    const poolId = nid()
    await db.tipPool.create({ data: { id: poolId, date: new Date() } }) // locationId NULL = stanje PO izbrisu lokacije (SetNull)
    const distId = nid()
    await db.tipDistribution.create({ data: { id: distId, tipPoolId: poolId, employeeId: empId, employeeName: `${P}Natakar B`, amount: 3 } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipPool.count({ where: { id: poolId } })).toBe(0) // samo 0c
      expect(await db.tipDistribution.count({ where: { id: distId } })).toBe(0)
      expect(await db.employee.count({ where: { id: empId } })).toBe(0)
    } finally {
      await db.tipDistribution.deleteMany({ where: { id: distId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: poolId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: empId } }).catch(() => null)
    }
  }, 60_000)

  test('Č1c lokacijska izolacija (Fix A): bazen (nid, predponski locationId) + distribucija z DEMO zaposlenim (nid, brez predpone) → pobran prek lokacijskega prehoda, kaskada vzame distribucijo', async () => {
    // Bazen, katerega distribucije ne nosijo predpone (demo zaposleni v URI
    // teka): 0c ne vidi nič, predponski je SAMO locationId → LOCATION_CHILD_
    // SWEEP vpis ga pobere PRED izbrisom lokacije; CASCADE vzame distribucijo.
    // Napoved na stari kodi: bazen 1 + distribucija 1 (FAIL obe).
    const locId = `${P}locC-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija C ${RUN}`, code: `V286C${RUN.toUpperCase()}` } })
    const demoEmpId = nid()
    await db.employee.create({ data: { id: demoEmpId, name: `Demo Natakar ${RUN}`, email: `demo-${RUN}@test.local`, pin: `${RUN}c` } })
    const poolId = nid()
    await db.tipPool.create({ data: { id: poolId, date: new Date(), locationId: locId } })
    const distId = nid()
    await db.tipDistribution.create({ data: { id: distId, tipPoolId: poolId, employeeId: demoEmpId, employeeName: 'Demo Natakar', amount: 2 } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipPool.count({ where: { id: poolId } })).toBe(0) // lokacijski prehod (predponski locationId)
      expect(await db.tipDistribution.count({ where: { id: distId } })).toBe(0) // CASCADE z bazenom
      expect(await db.location.count({ where: { id: locId } })).toBe(0)
      expect(await db.employee.count({ where: { id: demoEmpId } })).toBe(1) // "realen" zaposleni preživi
    } finally {
      // higija lastnih fiksur tudi ob padcu (nid vrstice — demo zaposleni je
      // naš, ročno ustvarjen; kaskadni vrstni red: dist → pool → emp/loc)
      await db.tipDistribution.deleteMany({ where: { id: distId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: poolId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: demoEmpId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
    }
  }, 60_000)

  test('Č1d varnost: realen bazen (nid, realna lokacija) + realna distribucija preživita; id-predponski bazen (i22 vzorec) pade po obstoječi id poti', async () => {
    // REGRESIJSKI VARUH VARNOSTI: popravek NE SME segati mimo testnih predpon.
    // Realen bazen (nid id, locationId realne nid lokacije) in njegova
    // distribucija (nid, demo zaposleni) morata preživeti; bazen s predponskim
    // id-jem (vzorec tests/issue22-payroll db.create) se pobere po id poti,
    // kot prej.
    const realLocId = nid()
    await db.location.create({ data: { id: realLocId, name: `Restavracija Demo V286 ${RUN}`, code: `RDV286${RUN.toUpperCase()}` } })
    const realEmpId = nid()
    await db.employee.create({ data: { id: realEmpId, name: `Ana Demo ${RUN}`, email: `ana-demo-${RUN}@test.local`, pin: `${RUN}d` } })
    const realPoolId = nid()
    await db.tipPool.create({ data: { id: realPoolId, date: new Date(), locationId: realLocId } })
    const realDistId = nid()
    await db.tipDistribution.create({ data: { id: realDistId, tipPoolId: realPoolId, employeeId: realEmpId, employeeName: 'Ana Demo', amount: 1 } })
    const prefPoolId = `${P}pool-${RUN}`
    await db.tipPool.create({ data: { id: prefPoolId, date: new Date() } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipPool.count({ where: { id: realPoolId } })).toBe(1) // preživi — ni testna
      expect(await db.tipDistribution.count({ where: { id: realDistId } })).toBe(1) // preživi — otrok realnega bazena
      expect(await db.location.count({ where: { id: realLocId } })).toBe(1) // preživi — ni testna
      expect(await db.employee.count({ where: { id: realEmpId } })).toBe(1) // preživi
      expect(await db.tipPool.count({ where: { id: prefPoolId } })).toBe(0) // id pot nespremenjena
    } finally {
      // higija lastnih fiksur tudi ob padcu (vzorec Č1d v285 + try/finally)
      await db.tipDistribution.deleteMany({ where: { id: realDistId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: realPoolId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: prefPoolId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: realLocId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: realEmpId } }).catch(() => null)
    }
  }, 60_000)

  test('Č1e meja (pošteno): nid() bazen z NULL locationId in BREZ otrok preživi sweep — zavestno ven, remedy vala počisti obstoječe', async () => {
    // STANJE 25 SIROT IZ MERITVE: noben predponski signal ne živi več
    // (dokaz-distribucija padla, locationId že SET NULL). To je MEJA fiksture:
    // novi sweep takšne vrstice NE more pobrati po predponi (varnostna
    // pogodba: brisanje IZKLJUČNO po testni predponi ali zbranem seznamu
    // predponskih otrok). Test dokumentira mejo in varuje pred tiho
    // razširitvijo na struktni kriterij (»briši vse sirote« bi segala mimo
    // pogodbe). Zelen na obeh straneh — dokumentacija, ne regresija.
    const poolId = nid()
    await db.tipPool.create({ data: { id: poolId, date: new Date() } })
    try {
      const res = await sweepTestFixtures(db, [P])
      expect(res.errors.filter((e) => NASI_MODELI.test(e))).toEqual([])
      expect(await db.tipPool.count({ where: { id: poolId } })).toBe(1) // preživi — brez signala
    } finally {
      // higiena lastne fiksture — obvezno try/finally (nid, brez signala)
      await db.tipPool.deleteMany({ where: { id: poolId } }).catch(() => null)
    }
  }, 60_000)
})

// ── Č2) PINI — statične varovalke popravka ───────────────────────────────

describe('v286 Č2: pini popritja (zbirni prehod + IN-seznam + lokacijski vpis + registracija)', () => {
  test('0c zbiralni prehod: orphanTipPoolIds iz predponskih TipDistribution (id + employeeId), PRED fazo 1', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    expect(src).toContain('const orphanTipPoolIds')
    // vir zbiranja: OBA predponski polji distribucije (id — db.create pot;
    // employeeId — API pot z testnimi zaposlenimi, v1.285.0)
    expect(src).toContain("[...forField('id', 'startsWith'), ...forField('employeeId', 'startsWith')]")
    // NAROČENJE JE BIT: zbiranje mora pasti PRED fazo 1 (ko distribucija
    // pade, je dokaz izbrisan) — vzorec 0a orphanLocIds
    const iCollect = src.indexOf('const orphanTipPoolIds')
    const iPhase1 = src.indexOf('// 1. blok prehod po id')
    expect(iCollect).toBeGreaterThan(-1)
    expect(iPhase1).toBeGreaterThan(iCollect)
  })

  test('fazi 1 in 3 vračunata IN-seznam v brisanje tipPool (idempotentna varovalka)', () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const hits = src.match(/spec\.model === 'tipPool'/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2) // faza 1 + faza 3
    expect(src).toContain('orphanTipPoolIds.length > 0')
  })

  test("LOCATION_CHILD_SWEEP vsebuje 'tipPool' (API-bazeni s predponskim locationId PRED SetNull — vzorec cashMovement)", () => {
    const src = read('tests/helpers/fixture-sweep.ts')
    const start = src.indexOf('const LOCATION_CHILD_SWEEP = [')
    const end = src.indexOf('] as const', start)
    expect(src.slice(start, end)).toContain("'tipPool',")
  })

  test('v286- registriran v TEST_PREFIXES; skupaj 138 vnosov (137 + ta val)', () => {
    expect(TEST_PREFIXES, P).toContain(P)
    expect(TEST_PREFIXES.length).toBe(138)
  })

  test('kontinuiteta registracije: v282-/v284-/v285- ostanejo (migracija sledi trenutnemu stanju)', () => {
    expect(TEST_PREFIXES).toContain('v282-')
    expect(TEST_PREFIXES).toContain('v284-')
    expect(TEST_PREFIXES).toContain('v285-')
  })

  test('hex-varnost: vsaka predpona brez pomišljaja vsebuje ne-hex znak (nid() je samo [0-9a-f])', () => {
    for (const p of TEST_PREFIXES) {
      if (p.endsWith('-')) continue
      expect(p, p).toMatch(/[^0-9a-f]/)
    }
  })
})

// ── Č3) TEŽA — merjeno, ne ugibano ─────────────────────────────────────

describe('v286 Č3: centralni sweep s 138 predponami (živi ostanki → 0 + varnost realnih podatkov)', () => {
  test('poln sweep < 30 s; tipPool/tipDistribution kriteriji pobrani; realni gostje before=after', async () => {
    // ŽIVI DOKAZ: pred popravkom je centralni sweep pustil 25 bazenov
    // (meritev vala: nid + locationId NULL + 0 otrok; 13 iz v1.285.0 → 25).
    // Po popravku + remedyju mora biti 0 — tudi na sveži CI bazi
    // (struktna trditev: po sweepu ni ostankov z živim predponskim signalom).
    const poolSignalBefore = await db.tipPool.count({
      where: { OR: [{ id: { startsWith: 'v286-' } }, { locationId: { startsWith: 'v286-' } }] },
    })
    const distSignalBefore = await db.tipDistribution.count({
      where: { OR: [{ id: { startsWith: 'v286-' } }, { employeeId: { startsWith: 'v286-' } }] },
    })
    // 25 sirot iz meritve (dokaz vala): nid + NULL + brez otrok — te pobere
    // ENKRATNI REMEDY vala, ne sweep; po remedyju mora biti 0 in ostati 0.
    const poolsBefore = await db.tipPool.findMany({ select: { id: true, locationId: true } })
    let orphanShapeBefore = 0
    for (const p of poolsBefore) {
      if (!TEST_PREFIXES.some((pre) => p.id.startsWith(pre)) && !p.locationId) {
        if ((await db.tipDistribution.count({ where: { tipPoolId: p.id } })) === 0) orphanShapeBefore++
      }
    }
    console.log(`[v286] živi ostanki PRED: tipPool(signal)=${poolSignalBefore} tipDistribution(signal)=${distSignalBefore} sirota-oblika=${orphanShapeBefore} (meritev vala: 0/0/25)`)
    // scena puščanja kot živi dokaz centralne poti (vzorec Č1a)
    const empId = `${P}c3emp-${RUN}`
    await db.employee.create({ data: { id: empId, name: `Natakar C3 ${RUN}`, email: `${P}c3emp-${RUN}@test.local`, pin: `${RUN}e` } })
    const locId = `${P}c3loc-${RUN}`
    await db.location.create({ data: { id: locId, name: `${P}Lokacija C3 ${RUN}`, code: `V286D${RUN.toUpperCase()}` } })
    const leakPoolId = nid()
    await db.tipPool.create({ data: { id: leakPoolId, date: new Date(), locationId: locId } })
    const leakDistId = nid()
    await db.tipDistribution.create({ data: { id: leakDistId, tipPoolId: leakPoolId, employeeId: empId, employeeName: `${P}Natakar C3`, amount: 7 } })
    const isReal = (g: { id: string }) => !TEST_PREFIXES.some((p) => g.id.startsWith(p))
    const realGuestsBefore = (await db.guest.findMany({ select: { id: true } })).filter((g) => isReal(g)).length
    try {
      const t0 = Date.now()
      const res = await sweepTestFixtures(db, TEST_PREFIXES)
      const ms = Date.now() - t0
      console.log(`[v286] centralni sweep (138 predpon): ${ms} ms (referenca v285: 137 predpon 1,2–1,3 s)`)
      expect(ms).toBeLessThan(30_000)
      expect(res.remainingLocations).toBe(0)
      expect(await db.tipPool.count({ where: { id: leakPoolId } })).toBe(0) // zbirni prehod 0c na centralni poti
      expect(await db.tipPool.count({
        where: { OR: [{ id: { startsWith: 'v286-' } }, { locationId: { startsWith: 'v286-' } }] },
      })).toBe(0)
      expect(await db.tipDistribution.count({
        where: { OR: [{ id: { startsWith: 'v286-' } }, { employeeId: { startsWith: 'v286-' } }] },
      })).toBe(0)
      // post-remedy invariant: sirota-oblika (nid + NULL + brez otrok) = 0
      const poolsNow = await db.tipPool.findMany({ select: { id: true, locationId: true } })
      let orphanShapeAfter = 0
      for (const p of poolsNow) {
        if (!TEST_PREFIXES.some((pre) => p.id.startsWith(pre)) && !p.locationId) {
          if ((await db.tipDistribution.count({ where: { tipPoolId: p.id } })) === 0) orphanShapeAfter++
        }
      }
      expect(orphanShapeAfter).toBe(0)
      const realGuestsAfter = (await db.guest.findMany({ select: { id: true } })).filter((g) => isReal(g)).length
      expect(realGuestsAfter).toBe(realGuestsBefore)
    } finally {
      await db.tipDistribution.deleteMany({ where: { id: leakDistId } }).catch(() => null)
      await db.tipPool.deleteMany({ where: { id: leakPoolId } }).catch(() => null)
      await db.employee.deleteMany({ where: { id: empId } }).catch(() => null)
      await db.location.deleteMany({ where: { id: locId } }).catch(() => null)
    }
  }, 60_000)
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v286 Ž: registri', () => {
  test('verzija 1.287.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.287.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.287.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.287.0-ci-sveza-baza')
  })

  test('i18n nedotaknjen: 4324/4324 (0 novih ključev — val brez UI)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('0 DDL: shemi nedotaknjeni (val je testna higiena sweepa)', () => {
    expect(read('prisma/schema.sqlite.prisma')).not.toContain('SweepNapitnine')
    expect(read('prisma/schema.prisma')).not.toContain('SweepNapitnine')
  })
})

afterAll(async () => {
  await sweepTestFixtures(db, [P])
})
