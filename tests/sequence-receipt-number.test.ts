import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../src/lib/db'
import { sweepTestFixtures, TEST_PREFIXES } from './helpers/fixture-sweep'
import { nextSequence, type SequenceTx } from '../src/lib/sequences'
import { allocateReceiptNumber } from '../src/lib/furs/receipt-number'
import { localYearMonth } from '../src/lib/fiscal-time'
import { nid } from '../src/lib/map'

/**
 * v1.146.0 — revizija 2026-10, najdba #14 (SPODNJA MEJA SEKVENCE in reže v
 * številčenju računov).
 *
 * NAPAKA (stanje pred popravkom): `nextSequence` je spodnjo mejo samo UPOŠTEVAL
 * ob vrnitvi (`Math.max(c.value, floor)`), nikoli pa jo ZAPISAL. Counter je
 * torej ostal za zadnjo izdano številko, vsak naslednji klic z isto mejo pa je
 * vrnil ISTO številko. Trk na `@@unique([locationId, receiptNumber])` dvigne
 * P2002 in razveljavi CELO transakcijo — tudi svoj lasten increment — zato stanje
 * NI enkraten spodrsljaj: lokacija ne more več izdati nobenega dokumenta.
 * Druga polovica napake: `count() + 1` kot meja ne vidi REŽ v obstoječem
 * številčenju (izbrisan račun v sredini niza), zato je meja lahko ŽE ZASEDENA.
 *
 * POPRAVEK:
 *  1. `nextSequence` mejo trajno zapiše (`updateMany … value: { lt: seed }`), da
 *     se Counter ozdravi in sočasni klic incrementa pade NAD mejo, ne na njo;
 *  2. `allocateReceiptNumber` (src/lib/furs/receipt-number.ts) pred vrnitvijo
 *     PREVERI, da številka še ni zasedena, in ob reži počaka naslednjo vrednost;
 *  3. izdaja (`issueFursReceipt`) in storno (`/api/receipts/[id]/storno`) si
 *     delita ENO numberjenje (ista funkcija), da se format ne more raziti.
 *
 * Pokrito:
 *  A) enota (brez baze): zapis/meja/seed pri štirih začetnih stanjih Counterja
 *  B) baza: reža → preskok zasedene številke (B1), enaka meja v dveh zaporednih
 *     transakcijah → različni števili + ozdravljen Counter (B2), sočasna izdaja
 *     (B3), lokalni koledarski prefiks meca (B4), prekinitev čez MAX_PROBES (B5)
 *  C) pini vira: meje ni več samo uporabljenih, numberjenje je na enem mestu,
 *     prepoznavna je tudi čistilna pravila za `Counter` v sweep-u
 *
 * Fiksature s predpono `seqfl-`.
 */

const PREFIX = 'seqfl-'
const RUN = Date.now().toString(36)

/** 2026-01-31T23:30Z = 01.02.2026 00:30 po ljubljanskem času → prefiks '2026-2'. */
const ISSUED_AT = new Date('2026-01-31T23:30:00Z')
const TZ = 'Europe/Ljubljana'
const YM = localYearMonth(ISSUED_AT, TZ)
const numberFor = (loc: Loc, seq: number) => `${YM.y}-${YM.m}-${seq}-${loc.premisesId}`

/** Ista oblika kot `ReceiptLocationRef` — timezone in premisesId sta v številki. */
interface Loc {
  id: string
  premisesId: string
  timezone: string
}

const mkLoc = (tag: string): Loc => ({ id: `${PREFIX}loc${tag}-${RUN}`, premisesId: `BLG${tag}${RUN}`, timezone: TZ })
const locA = mkLoc('A')
const locB = mkLoc('B')
const locC = mkLoc('C')
const locE = mkLoc('E')

/** Ena sama Order vrstica na lokacijo — Receipt zahteva veljaven orderId. */
let orderA = ''
let orderB = ''
let orderC = ''
let orderE = ''

async function seedLocation(loc: Loc, code: string, orderNumber: number): Promise<string> {
  await db.location.create({
    data: { id: loc.id, name: `${PREFIX}${code}`, code: `${code}-${RUN.toUpperCase()}`, premisesId: loc.premisesId, taxId: 'SI12345678', timezone: loc.timezone },
  })
  const order = await db.order.create({
    data: { id: `${PREFIX}ord${code}-${RUN}`, orderNumber, locationId: loc.id, tableId: null, status: 'closed', paymentStatus: 'paid', subtotal: 8.2, tax: 1.8, total: 10 },
  })
  return order.id
}

/** Ročno posejani račun (zapisi, ki jih Counter NI ustvaril — seed, uvoz, ročni poseg). */
async function seedReceipt(loc: Loc, orderId: string, seq: number): Promise<string> {
  const id = `${PREFIX}rc${seq}-${loc.premisesId}`
  await db.receipt.create({
    data: {
      id, receiptNumber: numberFor(loc, seq), orderId,
      businessName: `${PREFIX}Poslovni`, businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
      subtotal: 8.2, totalVat: 1.8, total: 10, vatBreakdown: JSON.stringify({ '22.00': { base: 8.2, vat: 1.8 } }),
      paymentMethod: 'cash', locationId: loc.id,
    },
  })
  return id
}

/** Proizvodni vzorec: dodeli številko IN vstavi račun v ISTI transakciji. */
async function issueReceipt(loc: Loc, orderId: string): Promise<{ seq: number; receiptNumber: string; id: string }> {
  return db.$transaction(async (tx) => {
    const { seq, receiptNumber } = await allocateReceiptNumber(tx, loc, ISSUED_AT)
    const id = `${PREFIX}live-${loc.premisesId}-${seq}`
    await tx.receipt.create({
      data: {
        id, receiptNumber, orderId,
        businessName: `${PREFIX}Poslovni`, businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
        subtotal: 8.2, totalVat: 1.8, total: 10, vatBreakdown: JSON.stringify({ '22.00': { base: 8.2, vat: 1.8 } }),
        paymentMethod: 'cash', locationId: loc.id,
      },
    })
    return { seq, receiptNumber, id }
  })
}

const counterName = (loc: Loc) => `receipt:${loc.id}`
const counterValue = async (loc: Loc): Promise<number> =>
  (await db.counter.findUnique({ where: { name: counterName(loc) } }))?.value ?? -1

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  orderA = await seedLocation(locA, 'A', 700001)
  orderB = await seedLocation(locB, 'B', 700002)
  orderC = await seedLocation(locC, 'C', 700003)
  orderE = await seedLocation(locE, 'E', 700004)
})

afterAll(async () => {
  const res = await sweepTestFixtures(db, [PREFIX])
  expect(res.errors).toEqual([])
  expect(res.remainingLocations).toBe(0)
})

/* ─────────────── A) enota: nextSequence in spodnja meja ─────────────── */

/** Lažni Counter — omogoča natančen pogled, KAJ se je zapisalo. */
function fakeTx(initial: Record<string, number> = {}) {
  const rows = new Map(Object.entries(initial))
  const clamps: Array<{ name: string; from: number; to: number }> = []
  const creates: Array<{ name: string; value: number }> = []
  const tx: SequenceTx = {
    counter: {
      async upsert({ where, create, update }) {
        const cur = rows.get(where.name)
        if (cur === undefined) {
          rows.set(where.name, create.value)
          creates.push({ name: where.name, value: create.value })
          return { value: create.value }
        }
        const next = cur + update.value.increment
        rows.set(where.name, next)
        return { value: next }
      },
      async updateMany({ where, data }) {
        const cur = rows.get(where.name)
        if (cur === undefined) return { count: 0 }
        if (where.value && cur >= where.value.lt) return { count: 0 }
        clamps.push({ name: where.name, from: cur, to: data.value })
        rows.set(where.name, data.value)
        return { count: 1 }
      },
    },
  }
  return { tx, rows, clamps, creates }
}

describe('A — nextSequence: spodnja meja se ZAPISAJE, ne samo upošteva', () => {
  test('Counter zaostaja za mejo: vrne mejo IN jo trajno zapiše', async () => {
    const { tx, rows, clamps } = fakeTx({ 'receipt:loc': 4 })
    const seq = await nextSequence(tx, 'receipt:loc', 6)
    expect(seq).toBe(6)
    // bistvo popravka: stanje vrstice JE 6, ne 5 (increment pod mejo)
    expect(rows.get('receipt:loc')).toBe(6)
    expect(clamps).toEqual([{ name: 'receipt:loc', from: 5, to: 6 }])
  })

  test('dva klica z ISTO mejo (sočasna izdaja) dobita RAZLIČNI številki', async () => {
    const { tx, rows } = fakeTx({ 'receipt:loc': 1 })
    const first = await nextSequence(tx, 'receipt:loc', 5)
    const second = await nextSequence(tx, 'receipt:loc', 5)
    // pred popravkom: max(2,5)=5 in max(3,5)=5 → ISTA številka → P2002 →
    // rollback celotne plačilne transakcije (kupec plača, računa ni)
    expect(first).toBe(5)
    expect(second).toBe(6)
    expect(rows.get('receipt:loc')).toBe(6)
  })

  test('Counter PRED mejo: increment in BREZ zapisovanja meje', async () => {
    const { tx, rows, clamps } = fakeTx({ 'order:loc': 10 })
    const seq = await nextSequence(tx, 'order:loc', 6)
    expect(seq).toBe(11)
    expect(clamps).toEqual([]) // nepotrebno pisanje bi maskiralo dejansko stanje
    expect(rows.get('order:loc')).toBe(11)
  })

  test('Counter manjka: create seedje na mejo (brez dodatnega clampa)', async () => {
    const { tx, rows, clamps, creates } = fakeTx()
    const seq = await nextSequence(tx, 'receipt:loc', 7)
    expect(seq).toBe(7)
    expect(creates).toEqual([{ name: 'receipt:loc', value: 7 }])
    expect(clamps).toEqual([])
    expect(rows.get('receipt:loc')).toBe(7)
  })

  test('meja pod 1 je normalizirana (prazna lokacija ne more seedjeti 0)', async () => {
    const { tx, rows } = fakeTx()
    expect(await nextSequence(tx, 'receipt:loc', 0)).toBe(1)
    expect(rows.get('receipt:loc')).toBe(1)
  })
})

/* ─────────────── B) baza: dodelitev številke računa ─────────────── */

describe('B — allocateReceiptNumber: reže, sočasnost in koledar', () => {
  test('B1 reža v obstoječem številčenju: zasedena številka se PRESKOČI', async () => {
    // stanje: zaporedne številke 1,2,3 in 7 (4 izbrisanih v sredini niza) →
    // count()+1 = 5, nato 6, nato MEJA 7, ki je ŽE ZASEDENA
    await seedReceipt(locA, orderA, 1)
    await seedReceipt(locA, orderA, 2)
    await seedReceipt(locA, orderA, 3)
    await seedReceipt(locA, orderA, 7)

    const a = await issueReceipt(locA, orderA)
    const b = await issueReceipt(locA, orderA)
    const c = await issueReceipt(locA, orderA)
    expect([a.seq, b.seq, c.seq]).toEqual([5, 6, 8])
    expect(c.receiptNumber).toBe(numberFor(locA, 8))

    // pred popravkom je tretji klic vrnil 7 → P2002 → rollback (in ker meja ni
    // bila zapisana, bi ponovitev vedno znova vrnila 7 = trajna izpad)
    const all = await db.receipt.findMany({ where: { locationId: locA.id }, select: { receiptNumber: true } })
    const numbers = all.map((r) => r.receiptNumber)
    expect(numbers).toHaveLength(7)
    expect(new Set(numbers).size).toBe(7)
    // Counter je ozdravljen NA zadnjo izdano številko, ne za njo
    expect(await counterValue(locA)).toBe(8)
  })

  test('B2 enaka meja v dveh zaporednih transakcijah → različni števili in ozdravljen Counter', async () => {
    // zaostarel Counter (1) + trije ročno posejani računi (meja iz count() = 4)
    await db.counter.create({ data: { id: nid(), name: counterName(locB), value: 1 } })
    await seedReceipt(locB, orderB, 1)
    await seedReceipt(locB, orderB, 2)
    await seedReceipt(locB, orderB, 3)

    // obe transakciji UPOSTATA isto mejo (4) — tako kot dve sočasni izdaji,
    // ki sta prebrali isti `count()`, preden je katera od transakcij vstavila
    const first = await db.$transaction(async (tx) => nextSequence(tx, counterName(locB), 4))
    const second = await db.$transaction(async (tx) => nextSequence(tx, counterName(locB), 4))
    expect(first).toBe(4)
    expect(second).toBe(5)
    expect(await counterValue(locB)).toBe(5)

    // tretji klic spet z mejo 4 (zakasnjen `count()` branje) ne more vrniti 4 ali 5
    const third = await db.$transaction(async (tx) => nextSequence(tx, counterName(locB), 4))
    expect(third).toBe(6)
  })

  test('B3 sočasna izdaja v dveh transakcijah: obe uspejata, številki sta različni', async () => {
    const [one, two] = await Promise.all([issueReceipt(locC, orderC), issueReceipt(locC, orderC)])
    expect(one.receiptNumber).not.toBe(two.receiptNumber)
    const rows = await db.receipt.findMany({ where: { locationId: locC.id }, select: { receiptNumber: true } })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.receiptNumber)).size).toBe(2)
    // SQLite transakcije serializira, zato B3 prikaže obliko (brez P2002);
    // deterministični dokaz istega mehanizma je B2.
  })

  test('B4 številka sledi LOKALNEMU koledarju lokacije (nočna izdaja)', async () => {
    const { seq, receiptNumber } = await db.$transaction(async (tx) => allocateReceiptNumber(tx, locC, ISSUED_AT))
    expect(receiptNumber).toBe(numberFor(locC, seq))
    expect(receiptNumber.startsWith('2026-2-')).toBe(true) // UTC bi dal '2026-1-'
  })

  test('B5 prek MAX_PROBES zaporednih zasedenih številk: napaka in NE neskončna zanka', async () => {
    // 64 posejanih računov (65…128) → count()=64 → meja 65, ki je zasedena;
    // vseh 64 zaporednih poskusov je zasedenih
    await db.receipt.createMany({
      data: Array.from({ length: 64 }, (_, i) => {
        const s = 65 + i
        return {
          id: `${PREFIX}rcFill${s}-${locE.premisesId}`, receiptNumber: numberFor(locE, s), orderId: orderE,
          businessName: `${PREFIX}Poslovni`, businessAddress: 'Testna 1', businessId: '12345678', taxId: 'SI12345678',
          subtotal: 8.2, totalVat: 1.8, total: 10, vatBreakdown: '{}', paymentMethod: 'cash', locationId: locE.id,
        }
      }),
    })
    expect(await db.receipt.count({ where: { locationId: locE.id } })).toBe(64)

    await expect(allocateReceiptNumber(db, locE, ISSUED_AT)).rejects.toThrow(/64 zaporednih/)
    // polovičnih zapisov ni, Counter pa je avanziral prek pregledanih številk
    expect(await db.receipt.count({ where: { locationId: locE.id } })).toBe(64)
    expect(await counterValue(locE)).toBe(128)
  }, 30_000)
})

/* ─────────────── C) pini vira ─────────────── */

describe('C — pini vira (najdba #14)', () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

  test('nextSequence mejo ZAPIŠE (updateMany … lt) in ne samo Math.max', () => {
    const s = src('lib/sequences.ts')
    expect(s).toContain('await tx.counter.updateMany(')
    expect(s).toContain('value: { lt: seed }')
    expect(s).toContain('data: { value: seed }')
    // enostranska/Math.max varianta je tista, ki nikoli ne ozdravi Counterja
    expect(s).not.toMatch(/return Math\.max\(c\.value, floor\)/)
  })

  test('izdaja in storno uporabljata SKUPNO numberjenje (ne gradita številke sami)', () => {
    const issue = src('lib/furs/issue.ts')
    const storno = src('app/api/receipts/[id]/storno/route.ts')
    const shared = src('lib/furs/receipt-number.ts')
    for (const [name, file] of [['issue.ts', issue], ['storno', storno]] as const) {
      expect(file).toContain("from '@/lib/furs/receipt-number'")
      expect(file).toContain('allocateReceiptNumber(tx')
      expect(file, name).not.toMatch(/nextSequence\(/)
      // če bi ruta številko sestavljala sama, bi se format lahko razšel
      expect(file, name).not.toMatch(/`\$\{y\}-\$\{m\}-\$\{seq\}-/)
    }
    expect(shared).toContain('export async function allocateReceiptNumber')
    expect(shared).toMatch(/const MAX_PROBES = 64/)
  })

  test('Counter ima čistilno pravilo v sweep-u (predpona živi SRED imena)', () => {
    const sweep = readFileSync(join(process.cwd(), 'tests', 'helpers', 'fixture-sweep.ts'), 'utf8')
    expect(sweep).toMatch(/\{ model: 'counter', fields: \['name'\], contains: true \}/)
    expect(sweep).toMatch(/spec\.contains \? \{ contains: p \} : \{ startsWith: p \}/)
    expect(TEST_PREFIXES).toContain(PREFIX)
  })
})
