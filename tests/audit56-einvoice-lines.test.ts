import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, employeePinFields } from '../src/lib/auth'
import { buildOrderLines, grossOfOrderItems, spreadCentsByWeight } from '../src/lib/einvoice-lines'
import { computeOutgoingTotals, lineNetAmountOf } from '../src/lib/eslog-export'
import { checkDigitSiTaxId } from '../src/lib/einvoice-validate'
import { POST as issuePOST } from '../src/app/api/einvoices/issue/route'

/**
 * v1.149.0 — revizija 2026-10, najdbi №5 in №6 (B2B e-račun iz naročila).
 *
 *  №5 — `POST /api/einvoices/issue` je iz naročila vzel SAMO cene postavk in je
 *       prezrl `Order.discount` (ročni popust na naročilu) ter
 *       `OrderItem.discountAmount`. Izstavljena računa in terjatev (AR) sta bila
 *       višja od zneska, ki ga stranka dejansko dolguje — razlike ni bilo česa
 *       plačati. Hkrati je validacija primerjala glavo, izračunano iz ISTIH
 *       vrstic, torej si je sama potrdila lastno napako.
 *
 *  №6 — neto osnova in DDV sta bila izpeljana IZ ENOTE (`r2(cena / (1 + stopnja))`,
 *       nato × količina). Zaokrožitev na enoti se pomnoži s količino, zato vrstica
 *       ne zadošča pravilu EN 16931 BT-111 = BT-118 × BT-146, vsota vrstic pa ne
 *       pride do plačanega zneska. Pri 7 × 5,75 € pri 9,5 % je razlika natanko
 *       0,01 € na vrstico.
 *
 * Popravek: `@/lib/einvoice-lines` razreže popust cent-exact po vrsticah
 * (deterministično — isti vhod → isti XML → isti sha256), izračuna osnovo PO
 * VRSTICI in vrne `shortfallCents`, kadar iz postavk ni mogoče sestaviti
 * pričakovanega zneska (takrat ruta zavrne fail-closed z 409). Glava računa iz
 * naročila je NEODVISEN podatek (Σ plačanih `Check.total`, sicer Σ postavk −
 * popust), zato validacija prvič res preverja ujemanje.
 *
 * Fiksature s predpono `a56-`; cleanup = ročno brisanje AR/outbox (nid() id-ji
 * brez predpone) + sweepTestFixtures.
 */

const P = 'a56-'
const RUN = Date.now().toString(36)
const PIN_BASE = String(Date.now()).slice(-6)

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/** generirana (NE realna) davčna številka prejemnika */
const SI_TAX = '1234567' + String(checkDigitSiTaxId('1234567'))

let locId = ''
let miId = ''
let tokOwner = ''
const arIds: string[] = []
const outboxIds: string[] = []

/* ══════════════ A. gradnik vrstic — zaokroževanje po vrstici (#6) ══════════════ */

describe('A. buildOrderLines — osnova in DDV se zaokrožita PO VRSTICI', () => {
  test('7 × 5,75 € pri 9,5 %: neto 36,76 / DDV 3,49 (stara pot: 36,75 / 3,50)', () => {
    const built = buildOrderLines([{ name: 'Kava', quantity: 7, unitPrice: 5.75, vatRate: 9.5 }], 40.25)
    expect(built.grossBefore).toBe(40.25)
    expect(built.discountSpread).toBe(0)
    expect(built.gross).toBe(40.25)
    expect(built.shortfallCents).toBe(0)
    // neto vrstice = r2(40,25 / 1,095) = 36,76; na enoti bi bilo r2(5,75/1,095)=5,25 × 7 = 36,75
    expect(lineNetAmountOf(built.lines[0])).toBe(36.76)
    expect(built.lines[0].lineVatAmount).toBe(3.49)
    expect(built.net).toBe(36.76)
    expect(built.vatAmount).toBe(3.49)
    // par (neto, DDV) se sešteje NATANČNO v bruto vrstice — noben cent ne ostane nedodeljen
    expect(r2(built.net + built.vatAmount)).toBe(built.gross)
  })

  test('neto cena na enoto je izpeljana iz zneska vrstice (sicer se pomnožek ne vrne)', () => {
    const built = buildOrderLines([{ name: 'Kava', quantity: 7, unitPrice: 5.75, vatRate: 9.5 }], 40.25)
    const unit = built.lines[0].unitPriceNet
    // dvodecimalna izbira (5,25) × 7 = 36,75 ≠ 36,76 → generator mora izpisati 4 decimalke
    expect(r2(unit)).toBe(5.25)
    expect(r2(r2(unit) * 7)).toBe(36.75)
    expect(Math.round(unit * 10000) / 10000).toBe(5.2514)
    expect(r2(5.2514 * 7)).toBe(36.76)
    expect(lineNetAmountOf(built.lines[0])).toBe(36.76)
  })

  test('kanonični primer najdbe #6: 100 × 10,99 € pri 22 % → razlika 0,18 € na vrstici', () => {
    const built = buildOrderLines([{ name: 'Malica', quantity: 100, unitPrice: 10.99, vatRate: 22 }], 1099)
    expect(built.gross).toBe(1099)
    // PO VRSTICI: neto = r2(1099 / 1,22) = 900,82; DDV je preostanek = 198,18
    expect(lineNetAmountOf(built.lines[0])).toBe(900.82)
    expect(built.lines[0].lineVatAmount).toBe(198.18)
    // PO ENOTI (stara pot): r2(10,99 / 1,22) = 9,01 × 100 = 901,00 in 1,98 × 100 = 198,00
    expect(r2(r2(10.99 / 1.22) * 100)).toBe(901)
    expect(r2(100 * r2(10.99 - r2(10.99 / 1.22)))).toBe(198)
    // davčni zvezi bi moral pojasniti 0,18 € osnove, ki jih na računu ni
    expect(r2(901 - built.net)).toBe(0.18)
    expect(r2(built.vatAmount - 198)).toBe(0.18)
    expect(r2(built.net + built.vatAmount)).toBe(built.gross)
    const t = computeOutgoingTotals(built.lines)
    expect(t.subtotal).toBe(900.82)
    expect(t.vatAmount).toBe(198.18)
    expect(t.totalAmount).toBe(1099)
  })

  test('več stopenj: vsaka vrstica nosi svoj par, vsota je cent-exact do glave', () => {
    const items = [
      { name: 'Jedi', quantity: 2, unitPrice: 10, vatRate: 22 },
      { name: 'Vino', quantity: 3, unitPrice: 5.75, vatRate: 9.5 },
    ]
    const built = buildOrderLines(items, 37.25)
    expect(built.gross).toBe(37.25)
    // 20,00 @ 22 % → 16,39 / 3,61 — 17,25 @ 9,5 % → 15,75 / 1,50
    expect(lineNetAmountOf(built.lines[0])).toBe(16.39)
    expect(built.lines[0].lineVatAmount).toBe(3.61)
    expect(lineNetAmountOf(built.lines[1])).toBe(15.75)
    expect(built.lines[1].lineVatAmount).toBe(1.5)
    expect(built.net).toBe(32.14)
    expect(built.vatAmount).toBe(5.11)
    const t = computeOutgoingTotals(built.lines)
    expect(t.subtotal).toBe(32.14)
    expect(t.vatAmount).toBe(5.11)
    expect(t.totalAmount).toBe(37.25)
  })
})

/* ══════════════ B. razrez popusta (#5) ══════════════ */

describe('B. razrez popusta po vrsticah', () => {
  test('popust 8,00 € na dveh enakih vrsticah → sorazmerno, vsota = 32,00', () => {
    const items = [
      { name: 'A', quantity: 1, unitPrice: 20, vatRate: 22 },
      { name: 'B', quantity: 1, unitPrice: 20, vatRate: 22 },
    ]
    const built = buildOrderLines(items, 32)
    expect(built.grossBefore).toBe(40)
    expect(built.discountSpread).toBe(8)
    expect(built.gross).toBe(32)
    expect(lineNetAmountOf(built.lines[0])).toBe(lineNetAmountOf(built.lines[1]))
    expect(r2(built.net + built.vatAmount)).toBe(32)
  })

  test('lihi centek gre na NIŽJI indeks; ponovni izračun je identičen', () => {
    const items = [0, 1, 2].map((i) => ({ name: `Vrstica ${i}`, quantity: 1, unitPrice: 10, vatRate: 22 }))
    const built = buildOrderLines(items, 29.99)
    expect(built.discountSpread).toBe(0.01)
    expect(built.lines.map((l) => lineNetAmountOf(l))).toEqual([8.19, 8.2, 8.2])
    const again = buildOrderLines(items, 29.99)
    expect(again.lines.map((l) => lineNetAmountOf(l))).toEqual(built.lines.map((l) => lineNetAmountOf(l)))
    expect(r2(built.net + built.vatAmount)).toBe(29.99)
  })

  test('popust vrstice (`OrderItem.discountAmount`) je upoštevan že v bruto osnovi', () => {
    const items = [
      { name: 'A', quantity: 1, unitPrice: 10, vatRate: 22, lineDiscount: 2.5 },
      { name: 'B', quantity: 1, unitPrice: 10, vatRate: 22 },
    ]
    expect(grossOfOrderItems(items)).toBe(17.5)
    const built = buildOrderLines(items, 17.5)
    expect(built.discountSpread).toBe(0)
    expect(built.gross).toBe(17.5)
    expect(r2(lineNetAmountOf(built.lines[0]) * 1.22)).toBe(7.5)
    expect(r2(lineNetAmountOf(built.lines[1]) * 1.22)).toBe(10)
  })

  test('razrez ne pripelje vrstice pod nič; manjkajoči znesek je `shortfallCents`', () => {
    const ok = buildOrderLines([{ name: 'A', quantity: 1, unitPrice: 10, vatRate: 22 }], 0.01)
    expect(ok.gross).toBe(0.01)
    expect(ok.shortfallCents).toBe(0)
    // naročilo dolguje VEČ, kot znašajo postavke (artikel spremenjen po plačilu)
    const short = buildOrderLines([{ name: 'A', quantity: 1, unitPrice: 10, vatRate: 22 }], 30)
    expect(short.shortfallCents).toBe(2000)
    expect(short.gross).toBe(10)
  })

  test('spreadCentsByWeight: kapica drži vrstico nad 0 in vrže manj, kot je zahtevano', () => {
    // 1,50 € na uteži [1,00 | 1,00], kapica na drugi vrstici 0,30 €
    const capped = spreadCentsByWeight(150, [100, 100], [100, 30])
    expect(capped).toEqual([100, 30])
    expect(spreadCentsByWeight(150, [100, 100], [100, 100])).toEqual([75, 75])
    expect(spreadCentsByWeight(100, [0, 0], [0, 0])).toEqual([0, 0])
    expect(spreadCentsByWeight(0, [100, 100], [100, 100])).toEqual([0, 0])
  })
})

/* ══════════════ fiksture za ruto ══════════════ */

interface IssueJson {
  ar?: { id?: string; totalAmount?: number }
  eInvoice?: { id?: string; subtotal?: number; vatAmount?: number; totalAmount?: number }
  error?: string
  errors?: { field: string; message: string }[]
}

async function seedEmployee(role: string, seq: number): Promise<string> {
  const id = `${P}${role}-${RUN}`
  const f = employeePinFields(`${PIN_BASE}${seq}`, `${P}${role}-${RUN}@test.local`)
  await db.employee.create({
    data: {
      id, name: `${P}${role}`, email: `${P}${role}-${RUN}@test.local`,
      role, status: 'active', sessionVersion: 0, locationId: locId,
      pin: f.pin, pinLookup: f.pinLookup,
    },
  })
  return id
}

let orderSeq = 0

/** Naročilo s KONČNIMI cenami; postavke = [naziv, količina, cena, stopnja, stornirano?]. */
async function seedOrder(items: Array<[string, number, number, number, boolean?]>, discount = 0): Promise<string> {
  orderSeq++
  const id = `${P}ord-${orderSeq}-${RUN}`
  await db.order.create({
    data: {
      id, orderNumber: 7100 + orderSeq, locationId: locId, type: 'dine-in',
      status: 'paid', paymentStatus: 'unpaid', discount,
    },
  })
  for (let i = 0; i < items.length; i++) {
    const [name, quantity, price, rate, voided] = items[i]
    await db.orderItem.create({
      data: {
        id: `${P}it-${orderSeq}-${i}-${RUN}`, orderId: id, menuItemId: miId,
        quantity, price, vatRate: rate, vatAmount: 0, menuItemName: name, voided: voided === true,
      },
    })
  }
  return id
}

/** Izstavek na naročilu — `total` je znesek ZA PLAČANJE (že po vseh popustih). */
async function seedCheck(orderId: string, n: number, total: number, subtotal: number, tax: number, discount: number, paymentStatus = 'paid'): Promise<void> {
  await db.check.create({
    data: { id: `${P}chk-${orderId}-${n}-${RUN}`, checkNumber: n, orderId, subtotal, tax, discount, total, paymentStatus },
  })
}

async function issue(orderId: string | null, extra: Record<string, unknown> = {}): Promise<{ status: number; json: IssueJson }> {
  const body = {
    customerName: `${P}Podjetje ${RUN}`,
    customerTaxId: SI_TAX,
    customerCountry: 'SI',
    ...(orderId ? { orderId } : { lines: [{ name: 'Ročna vrstica', quantity: 1, unitPriceNet: 10, vatRate: 22 }] }),
    ...extra,
  }
  const req = new NextRequest('http://localhost:3000/api/einvoices/issue', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokOwner}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await issuePOST(req)
  const json = (await res.json()) as IssueJson
  if (json.eInvoice?.id) outboxIds.push(String(json.eInvoice.id))
  if (json.ar?.id) arIds.push(String(json.ar.id))
  return { status: res.status, json }
}

beforeAll(async () => {
  await sweepTestFixtures(db, [P])
  locId = `${P}loc-${RUN}`
  await db.location.create({
    data: { id: locId, code: `${P}L`, name: `${P}Lokacija`, premisesId: `${P}prem-${RUN}`, taxId: '76543210' },
  })
  const menu = await db.menu.create({ data: { id: `${P}menu-${RUN}`, name: `${P}Meni`, locationId: locId } })
  const cat = await db.category.create({ data: { id: `${P}cat-${RUN}`, name: `${P}Kat`, menuId: menu.id } })
  const item = await db.menuItem.create({ data: { id: `${P}mi-${RUN}`, name: `${P}Jedi`, price: 10, categoryId: cat.id } })
  miId = item.id
  await seedEmployee('owner', 1)
  tokOwner = createToken({ sub: `${P}owner-${RUN}`, name: `${P}owner`, role: 'owner', loc: locId, sv: 0 })
})

afterAll(async () => {
  await db.eInvoiceOutbox.deleteMany({ where: { id: { in: outboxIds } } }).catch(() => null)
  await db.accountsReceivable.deleteMany({ where: { id: { in: arIds } } }).catch(() => null)
  await db.auditLog.deleteMany({ where: { locationId: locId } }).catch(() => null)
  await sweepTestFixtures(db, [P])
})

/* ══════════════ C. ruta: znesek računa = znesek, ki ga stranka dolguje ══════════════ */

describe('C. issue ruta — popust naročila in plačani izstavek', () => {
  test('№5: naročilo s popustom 8,00 € → račun 32,00 € (ne 40,00 €)', async () => {
    const orderId = await seedOrder([['A', 1, 20, 22], ['B', 1, 20, 22]], 8)
    const { status, json } = await issue(orderId)
    expect(status).toBe(201)
    const ei = json.eInvoice!
    expect(ei.totalAmount).toBe(32)
    expect(r2(Number(ei.subtotal) + Number(ei.vatAmount))).toBe(32)
    // pin NISTAVNEGA obnašanja: pred popravkom je račun znašal celotno vrednost postavk
    expect(ei.totalAmount).not.toBe(40)
    const arRow = await db.accountsReceivable.findUnique({ where: { id: String(json.ar!.id) } })
    expect(Number(arRow!.totalAmount)).toBe(32)
    expect(r2(Number(arRow!.subtotal) + Number(arRow!.vatAmount))).toBe(32)
    const audit = await db.auditLog.findFirst({ where: { action: 'EINVOICE_ISSUED', entityId: String(json.ar!.id) } })
    expect(audit).not.toBeNull()
    const details = JSON.parse(audit!.details) as Record<string, number>
    expect(details.grossBefore).toBe(40)
    expect(details.discountSpread).toBe(8)
    expect(details.totalAmount).toBe(32)
  })

  test('№5: plačan izstavek je kanonični znesek — happy hour ne more biti prezrt', async () => {
    const orderId = await seedOrder([['Kava', 3, 10, 22]])
    await seedCheck(orderId, 1, 27, 22.13, 4.87, 3)
    const { status, json } = await issue(orderId)
    expect(status).toBe(201)
    const ei = json.eInvoice!
    expect(ei.totalAmount).toBe(27)
    // DDV se izračuna iz plačanih 27,00, ne iz predpopustnih 30,00
    expect(ei.subtotal).toBe(22.13)
    expect(ei.vatAmount).toBe(4.87)
    expect(r2(Number(ei.subtotal) + Number(ei.vatAmount))).toBe(27)
  })

  test('delno plačana miza (odprt izstavek) → račun ostane po vseh artiklih, ne po plačanem delu', async () => {
    // 3 × 10,00 € = 30,00; izstavek #1 je plačan (20,00), #2 čaka na plačilo.
    // Plačani seštevek NI celotno naročilo, zato se ne sme usesti kot popust —
    // račun je vseh 30,00 € artiklov brez fiktivnega popusta.
    const orderId = await seedOrder([['Kava', 3, 10, 22]])
    await seedCheck(orderId, 1, 20, 16.39, 3.61, 0)
    await seedCheck(orderId, 2, 10, 8.2, 1.8, 0, 'unpaid')
    const { status, json } = await issue(orderId)
    expect(status).toBe(201)
    const ei = json.eInvoice!
    expect(ei.totalAmount).toBe(30)
    expect(ei.subtotal).toBe(24.59)
    expect(ei.vatAmount).toBe(5.41)
  })

  test('№5 fail-closed: plačan znesek presega vrednost postavk → 409, brez AR in outbox', async () => {
    const arBefore = await db.accountsReceivable.count()
    const obBefore = await db.eInvoiceOutbox.count()
    const orderId = await seedOrder([['A', 1, 10, 22]])
    await seedCheck(orderId, 1, 12, 9.84, 2.16, 0)
    const { status, json } = await issue(orderId)
    expect(status).toBe(409)
    expect(String(json.error)).toContain('zavrnjena')
    expect(await db.accountsReceivable.count()).toBe(arBefore)
    expect(await db.eInvoiceOutbox.count()).toBe(obBefore)
  })

  test('popoln popust (nič za plačati) → 409, ničeln račun ne izide', async () => {
    const arBefore = await db.accountsReceivable.count()
    const orderId = await seedOrder([['A', 1, 10, 22]], 10)
    const { status } = await issue(orderId)
    expect(status).toBe(409)
    expect(await db.accountsReceivable.count()).toBe(arBefore)
  })

  test('stornirane postavke so izven osnove, preostale se razrežejo po njim', async () => {
    const orderId = await seedOrder([['A', 1, 10, 22], ['B', 1, 10, 22, true]])
    const { status, json } = await issue(orderId)
    expect(status).toBe(201)
    expect(json.eInvoice!.totalAmount).toBe(10)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: String(json.eInvoice!.id) } })
    expect(row!.xmlPayload).toContain('<cbc:Name>A</cbc:Name>')
    expect(row!.xmlPayload).not.toContain('<cbc:Name>B</cbc:Name>')
  })

  test('№6: 7 × 5,75 € pri 9,5 % → XML nosi 4-decimalno ceno, znesek vrstice 36,76', async () => {
    const orderId = await seedOrder([['Kava', 7, 5.75, 9.5]])
    const { status, json } = await issue(orderId)
    expect(status).toBe(201)
    const ei = json.eInvoice!
    expect(ei.totalAmount).toBe(40.25)
    expect(ei.subtotal).toBe(36.76)
    expect(ei.vatAmount).toBe(3.49)
    const row = await db.eInvoiceOutbox.findUnique({ where: { id: String(json.eInvoice!.id) } })
    expect(row!.xmlPayload).toContain('<cbc:LineExtensionAmount currencyID="EUR">36.76</cbc:LineExtensionAmount>')
    // dvodecimalna cena (5,25) × 7 = 36,75 ≠ 36,76 → izpisanih mora biti 5,2514
    expect(row!.xmlPayload).toContain('<cbc:PriceAmount currencyID="EUR">5.2514</cbc:PriceAmount>')
    expect(row!.xmlPayload).not.toContain('<cbc:PriceAmount currencyID="EUR">5.25</cbc:PriceAmount>')
  })

  test('ročne vrstice ostanejo NETO (B2B račun = net + DDV), glava je njihov seštevek', async () => {
    const { status, json } = await issue(null)
    expect(status).toBe(201)
    const ei = json.eInvoice!
    expect(ei.subtotal).toBe(10)
    expect(ei.vatAmount).toBe(2.2)
    expect(ei.totalAmount).toBe(12.2)
  })
})
