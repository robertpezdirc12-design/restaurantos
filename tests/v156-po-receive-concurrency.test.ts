/**
 * Audit (v1.156.0) — POST /api/purchase-orders/[id]/receive: sočasna prevzema
 * istega naročila.
 *
 * PREJ:
 *  - InventoryItem se bere in zapisuje z read-modify-write ZNOTRAJ transakcije,
 *    a brez primerjave različice — dve sočasni transakciji prebereta 10, obe
 *    zapišeta 11 (na Postgresu READ COMMITTED en prirastek izgine, serija in
 *    StockTransaction pa obe trdita 10 → 11);
 *  - PurchaseOrderItem.quantityReceived se računa iz PO, prebranega PRED
 *    transakcijo — drugi prevzem prepiše prvega (0 + 1 = 1 namesto 2), zato
 *    naročilo za vedno ostane 'partial', čeprav je blago prejeto;
 *  - GRN številka = count(startsWith dan) + 1 ZUNAJ transakcije — oba zahtevka
 *    izračunata isto zaporedno številko, drugi pade na @@unique.
 *
 * ZDAJ (pričakovano):
 *  - GRN številka se dodeli atomarno (nextSequence znotraj transakcije),
 *  - zaloga se posodobi s primerjavo in ponovnim poskusom (compare-and-set),
 *  - quantityReceived/quantityRejected se povečata atomsko, status postavke in
 *    naročila pa se izračunata iz SVEŽIH vrstic znotraj transakcije.
 *
 * Fiksature s predpono `v156r-` (čiščenje: fixture-sweep).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken } from '../src/lib/auth'
import { POST as receivePOST } from '../src/app/api/purchase-orders/[id]/receive/route'
import { nid } from '../src/lib/map'

const PREFIX = 'v156r-'
const RUN = Date.now().toString(36)

let locId = ''
let whId = ''
let supplierId = ''
let inventoryId = ''
let poId = ''
let poItemId = ''

function req(url: string, token: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function cleanupFixtures() {
  await sweepTestFixtures(db, [PREFIX])
}

async function seed() {
  locId = `${PREFIX}loc-${RUN}`
  await db.location.create({ data: { id: locId, name: 'V156R lokacija', code: `${PREFIX}${RUN}` } })

  whId = nid()
  await db.employee.create({
    data: {
      id: whId, name: `${PREFIX}skladiscnik`, email: `${whId}@test.local`,
      role: 'warehouse', status: 'active', sessionVersion: 0, locationId: locId, pin: `${PREFIX}w`,
    },
  })

  supplierId = `${PREFIX}sup-${RUN}`
  await db.supplier.create({ data: { id: supplierId, name: `V156R dobavitelj ${RUN}`, code: `${PREFIX}${RUN}` } })

  inventoryId = `${PREFIX}inv-${RUN}`
  await db.inventoryItem.create({
    data: { id: inventoryId, name: `${PREFIX}moka`, unit: 'kg', quantity: 10, costPerUnit: 1, locationId: locId },
  })

  poId = nid()
  poItemId = nid()
  await db.purchaseOrder.create({
    data: {
      id: poId, poNumber: `PO-V156R-${RUN}`, supplierId, status: 'approved',
      subtotal: 2, vatAmount: 0.44, totalAmount: 2.44, locationId: locId,
      PurchaseOrderItem: {
        create: {
          id: poItemId, description: `${PREFIX}moka`, quantityOrdered: 2, unit: 'kg',
          unitPrice: 1, vatRate: 22, totalPrice: 2.44, inventoryItemId: inventoryId,
        },
      },
    },
  })
}

/** En prevzem; omogoča tudi napako, da jo test OPAZUJE namesto da bi padel v beforeAll. */
async function receive(key: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const token = createToken({ sub: whId, name: 'V156R skladiščnik', role: 'WAREHOUSE', loc: locId, sv: 0 })
  try {
    const res = await receivePOST(
      req(`/api/purchase-orders/${poId}/receive`, token, 'POST', {
        idempotencyKey: key,
        lines: [{ purchaseOrderItemId: poItemId, quantityAccepted: 1, quantityRejected: 0 }],
      }),
      { params: Promise.resolve({ id: poId }) },
    )
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  } catch (e) {
    return { status: 599, body: { error: String((e as Error).message || e) } }
  }
}

beforeAll(async () => {
  await cleanupFixtures()
  await seed()
})

afterAll(async () => {
  await cleanupFixtures()
})

describe('v156 — sočasna prevzema iste postavke', () => {
  test('dva vzporedna prevzema po 1 od naročenih 2: oba uspeta, količina 2, zaloga 12, dve seriji', async () => {
    const [a, b] = await Promise.all([receive(`${PREFIX}k1-${RUN}`), receive(`${PREFIX}k2-${RUN}`)])

    expect([a.status, b.status]).toEqual([201, 201])
    const grns = [a.body, b.body].map((r) => (r?.receipt as Record<string, unknown> | undefined)?.grnNumber)
    expect(new Set(grns).size).toBe(2)

    const item = await db.purchaseOrderItem.findUnique({ where: { id: poItemId } })
    expect(Number(item?.quantityReceived)).toBe(2)
    expect(item?.status).toBe('received')

    const po = await db.purchaseOrder.findUnique({ where: { id: poId } })
    expect(po?.status).toBe('received')
    expect(po?.receivedDate).not.toBeNull()

    const inv = await db.inventoryItem.findUnique({ where: { id: inventoryId } })
    expect(Number(inv?.quantity)).toBe(12)

    const batches = await db.inventoryBatch.findMany({ where: { inventoryItemId: inventoryId } })
    expect(batches.length).toBe(2)
    const stock = await db.stockTransaction.findMany({ where: { inventoryItemId: inventoryId }, orderBy: { createdAt: 'asc' } })
    expect(stock.length).toBe(2)
    // sled je nepretrgana: 10 → 11 → 12 (noben prirastek se ni izgubil);
    // vrstni red zapisov ni zajamčen (obe vrstici imata lahko isti createdAt)
    const transitions = stock
      .map((s) => [Number(s.previousQty), Number(s.newQty)] as const)
      .sort((x, y) => x[0] - y[0])
    expect(transitions).toEqual([[10, 11], [11, 12]])

    expect(await db.goodsReceipt.count({ where: { purchaseOrderId: poId } })).toBe(2)
  })
})
