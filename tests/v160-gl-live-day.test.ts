/**
 * v1.160.0 — GL dnevnik: tekoči dan ni več zamrznjen ob prvem ogledu.
 *
 * Najdba: GET /api/reports/gl je obstoječi JournalEntry vrnil nespremenjen, zato
 * je vnos za TEKOČI dan ostal pri stanju prvega ogleda — kasnejši promet istega
 * dneva se v dnevniku ni nikoli pojavil. Popravek: avtomatski vnos se osveži,
 * dokler je bil ustvarjen znotraj svojega dneva (postedAt < konec dneva); prvi
 * ogled po polnoči ga enkrat uskladi s celotnim dnevom in ga s tem zamrzne.
 * Ročni vnosi se nikoli ne prepišejo.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { glEntryNumber, glMemo } from '../src/lib/gl'
import { GET as glGET } from '../src/app/api/reports/gl/route'

const P = 'v160-'
const RUN = Date.now().toString(36)
let locId = ''
let empId = ''
let seq = 0

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = (): string => iso(new Date())
const yesterday = (): string => {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return iso(d)
}

const scopeKey = (): string => createHash('sha256').update(locId).digest('hex').slice(0, 8)
const entryNo = (day: string): string => glEntryNumber(day, scopeKey())

const tok = (): string => createToken({ sub: empId, name: 'V160', role: 'admin', loc: locId, sv: 0 })

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, { headers: { authorization: `Bearer ${tok()}` } })
}

async function gl(day: string): Promise<{
  persisted: boolean
  entries: { entryNo: string; debit: number; credit: number; lines: { accountCode: string; debit: number; credit: number }[] }[]
}> {
  const res = await glGET(req(`/api/reports/gl?from=${day}&to=${day}`))
  expect(res.status).toBe(200)
  return (await res.json()) as never
}

/** En dan prodaje: račun (neto + DDV) + gotovinsko plačilo prek Check → Order. */
async function seedSale(at: Date, cash: number, net: number, vat: number): Promise<void> {
  seq++
  const n = 9600 + seq
  const order = await db.order.create({
    data: { id: `${P}o-${seq}-${RUN}`, locationId: locId, orderNumber: n, status: 'paid', paymentStatus: 'paid', type: 'dine-in' },
  })
  await db.receipt.create({
    data: {
      id: `${P}r-${seq}-${RUN}`, receiptNumber: `${P}-R${seq}-${RUN}`, orderId: order.id,
      businessName: 'V160', businessAddress: '', businessId: '', taxId: '',
      subtotal: net, totalVat: vat, total: net + vat, discount: 0, paymentMethod: 'cash',
      createdAt: at, printedAt: at, locationId: locId,
    },
  })
  const check = await db.check.create({
    data: {
      id: `${P}c-${seq}-${RUN}`, checkNumber: n, orderId: order.id,
      subtotal: net, tax: vat, total: net + vat, paymentStatus: 'paid', paymentMethod: 'cash',
    },
  })
  await db.payment.create({
    data: { id: `${P}p-${seq}-${RUN}`, checkId: check.id, amount: cash, type: 'cash', status: 'completed', createdAt: at },
  })
}

/** Ročni/avtomatski vnos z natanko določenim postedAt (simulacija starega stanja). */
async function seedEntry(day: string, opts: { source: 'auto' | 'manual'; postedAt: Date; debit: number }): Promise<string> {
  const id = `${P}je-${++seq}-${RUN}`
  await db.journalEntry.create({
    data: {
      id, entryNumber: entryNo(day), date: new Date(`${day}T12:00:00`),
      description: glMemo(day), source: opts.source, status: 'posted', postedAt: opts.postedAt,
      postedBy: 'avtomatika', locationId: locId,
      JournalLine: {
        create: [{
          id: `${P}jl-${seq}-${RUN}`, accountCode: '101', accountName: 'Blagajna', accountType: 'asset',
          debit: opts.debit, credit: 0, description: 'simulacija', chartOfAccountCode: '101', locationId: locId,
        }],
      },
    },
  })
  return id
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locId = `${P}loc-${RUN}`
  await db.location.create({ data: { id: locId, name: `${P}Lokacija`, code: `V160-${RUN.toUpperCase()}`, premisesId: `${P}prem-${RUN}` } })
  const f = employeePinFields(`V160${RUN}`.slice(0, 12), `${P}admin@test.local`)
  empId = `${P}admin-${RUN}`
  await db.employee.create({
    data: {
      id: empId, name: `${P}Admin`, email: `${P}admin@test.local`,
      role: 'admin', status: 'active', sessionVersion: 0, locationId: locId,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
})

/** Vsak test dobi svež dan brez vnosov prejšnjega (isti dan = isti entryNumber). */
async function reset(): Promise<void> {
  await db.journalLine.deleteMany({ where: { locationId: locId } })
  await db.journalEntry.deleteMany({ where: { locationId: locId } })
  const orders = await db.order.findMany({ where: { locationId: locId }, select: { id: true } })
  const ids = orders.map((o) => o.id)
  const checks = await db.check.findMany({ where: { orderId: { in: ids } }, select: { id: true } })
  await db.payment.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } })
  await db.receipt.deleteMany({ where: { orderId: { in: ids } } })
  await db.check.deleteMany({ where: { orderId: { in: ids } } })
  await db.order.deleteMany({ where: { id: { in: ids } } })
}

beforeEach(reset)

afterAll(async () => {
  // GL ni v ID_SWEEP — vnosi visijo na lokaciji (route uporabi nid(), ne predpone).
  await reset()
  await sweepTestFixtures(db, [P])
})

describe('v1.160.0 — GL tekoči dan', () => {
  test('nov promet istega dne POSODOBI vnos na mestu (brez dvojnika in brez podvojenih vrstic)', async () => {
    const day = today()
    await seedSale(new Date(), 122, 100, 22)
    const first = await gl(day)
    expect(first.entries.length).toBe(1)
    expect(first.entries[0].entryNo).toBe(entryNo(day))
    expect(first.entries[0].debit).toBe(122)
    expect(first.entries[0].credit).toBe(122)
    const before = await db.journalEntry.findUnique({ where: { entryNumber: entryNo(day) }, include: { JournalLine: true } })
    expect(before?.JournalLine.length).toBe(3)

    await seedSale(new Date(), 61, 50, 11)
    const second = await gl(day)
    expect(second.entries.length).toBe(1)
    expect(second.entries[0].entryNo).toBe(entryNo(day))
    expect(second.entries[0].debit).toBe(183)
    expect(second.entries[0].credit).toBe(183)
    const line101 = second.entries[0].lines.find((l) => l.accountCode === '101')
    expect(line101?.debit).toBe(183)
    expect(second.entries[0].lines.find((l) => l.accountCode === '401')?.credit).toBe(150)
    expect(second.entries[0].lines.find((l) => l.accountCode === '221')?.credit).toBe(33)

    const after = await db.journalEntry.findUnique({ where: { entryNumber: entryNo(day) }, include: { JournalLine: true } })
    expect(after?.id).toBe(before?.id) // posodobitev na mestu, ne nov vnos
    expect(after?.JournalLine.length).toBe(3)
    expect(after?.JournalLine.filter((l) => l.accountCode === '401').length).toBe(1)
    expect(Number(after?.JournalLine.find((l) => l.accountCode === '101')?.debit)).toBe(183)
  })

  test('vnos, ustvarjen PO koncu dneva, ostane zamrznjen (pretekli dan se ne preračunava)', async () => {
    const day = yesterday()
    await seedSale(new Date(`${day}T12:00:00`), 61, 50, 11)
    const first = await gl(day)
    expect(first.entries[0].debit).toBe(61)

    await seedSale(new Date(`${day}T18:00:00`), 122, 100, 22)
    const second = await gl(day)
    expect(second.entries[0].debit).toBe(61) // knjiženo po zaključku dneva = dokončno
    const row = await db.journalEntry.findUnique({ where: { entryNumber: entryNo(day) }, include: { JournalLine: true } })
    expect(Number(row?.JournalLine.find((l) => l.accountCode === '101')?.debit)).toBe(61)
  })

  test('ročni vnos z isto številko se NIKOLI ne prepiše', async () => {
    const day = today()
    await seedEntry(day, { source: 'manual', postedAt: new Date(), debit: 7 })
    await seedSale(new Date(), 122, 100, 22)
    const view = await gl(day)
    expect(view.entries[0].debit).toBe(7)
    expect(view.entries[0].lines.length).toBe(1)
    const row = await db.journalEntry.findUnique({ where: { entryNumber: entryNo(day) }, include: { JournalLine: true } })
    expect(row?.source).toBe('manual')
    expect(row?.JournalLine.length).toBe(1)
  })

  test('vnos iz sredine dneva se po polnoči enkrat uskladi s celotnim dnem in nato zamrzne', async () => {
    const day = yesterday()
    const id = await seedEntry(day, { source: 'auto', postedAt: new Date(`${day}T23:00:00`), debit: 1 })
    await seedSale(new Date(`${day}T12:00:00`), 61, 50, 11)

    const first = await gl(day)
    expect(first.entries[0].debit).toBe(61)
    const row = await db.journalEntry.findUnique({ where: { entryNumber: entryNo(day) }, include: { JournalLine: true } })
    expect(row?.id).toBe(id)
    expect(row?.postedAt?.getTime()).toBeGreaterThan(new Date(`${day}T23:59:59.999`).getTime())

    await seedSale(new Date(`${day}T13:00:00`), 122, 100, 22)
    const second = await gl(day)
    expect(second.entries[0].debit).toBe(61) // po enkratnem usklajevanju je dan zaključen
  })
})
