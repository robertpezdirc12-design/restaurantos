/**
 * v1.156.0 — prevzem na zalogo: compare-and-set zanka (brez DB).
 *
 * Zakaj ločen test: SQLite (CI) serializira pisce, zato izgubljenega prirastka
 * prek dveh sočasnih API klicev ni mogoče reproducirati — na Postgresu READ
 * COMMITTED pa je realen: oba prevzema prebereta 10 in oba zapišeta 11, seriji
 * in StockTransaction pa trdita 10 → 11. Tu zato vlogo sočasnega pisca prevzame
 * skriptiran tx: prvi CAS vrne 0 (vmes je nekdo spremenil količino), drugi
 * uspe. Brez ponovnega branja bi helper ustvaril serijo/sled na zastarelih
 * podatkih ali javil uspeh, čeprav zaloga ni bila posodobljena.
 */
import { describe, test, expect } from 'bun:test'
import {
  applyReceiveToStock,
  type ReceiveStockInput,
  type StockTx,
} from '../src/lib/procurement-stock'

type Row = {
  id: string
  name: string
  unit: string
  quantity: number
  costPerUnit: number
  locationId: string | null
}

const input = (over: Partial<ReceiveStockInput> = {}): ReceiveStockInput => ({
  inventoryItemId: 'inv-1',
  quantityAccepted: 1,
  unitPrice: 2,
  description: 'moka',
  locationId: 'loc-1',
  grnNumber: 'GRN-20261020-0001',
  lotNumber: 'GRN-20261020-0001-1',
  supplierId: 'sup-1',
  supplierName: 'Dobavitelj',
  expiryDate: null,
  receivedAt: new Date('2026-10-20T10:00:00Z'),
  userId: 'u-1',
  userName: 'Skladiščnik',
  ...over,
})

/** Skriptiran tx: zaporedje branj + izidov CAS; beleži vse klice. */
function fakeTx(reads: (Row | null)[], casOutcomes: number[]) {
  const state = {
    reads: [...reads],
    cas: [...casOutcomes],
    casArgs: [] as Array<{ where: { id: string; quantity: unknown }; data: Record<string, unknown> }>,
    batches: [] as Record<string, unknown>[],
    stock: [] as Record<string, unknown>[],
  }
  const tx: StockTx = {
    inventoryItem: {
      findUnique: async () => state.reads.shift() ?? null,
      updateMany: async (args) => {
        state.casArgs.push(args as (typeof state.casArgs)[number])
        return { count: state.cas.shift() ?? 0 }
      },
    },
    inventoryBatch: { create: async ({ data }) => { state.batches.push(data); return data } },
    stockTransaction: { create: async ({ data }) => { state.stock.push(data); return data } },
  }
  return { tx, state }
}

const row = (quantity: number, over: Partial<Row> = {}): Row => ({
  id: 'inv-1', name: 'Moka', unit: 'kg', quantity, costPerUnit: 1, locationId: 'loc-1', ...over,
})

describe('v156 — applyReceiveToStock CAS', () => {
  test('sočasni pisec med branjem in zapisom: ponovno branje, končna količina 12, sled 11 → 12', async () => {
    const { tx, state } = fakeTx([row(10), row(11)], [0, 1])
    const res = await applyReceiveToStock(tx, input())

    expect(res).toEqual({ kind: 'applied', previousQty: 11, newQty: 12, costPerUnit: 1.08 })
    // CAS je bil izveden DVakrat: prvi z staro (10), drugi s svežo (11) količino
    expect(state.casArgs.length).toBe(2)
    expect(Number(state.casArgs[0].where.quantity)).toBe(10)
    expect(Number(state.casArgs[1].where.quantity)).toBe(11)
    // utežena cena: (11 × 1,00 € + 1 × 2,00 €) / 12 = 1,08 €
    expect(state.batches.length).toBe(1)
    expect(state.batches[0].quantityInitial).toBe(1)
    expect(state.batches[0].unitCost).toBe(1.08)
    expect(state.stock.length).toBe(1)
    expect(state.stock[0].previousQty).toBe(11)
    expect(state.stock[0].newQty).toBe(12)
    expect(state.stock[0].costPerUnit).toBe(1.08)
    expect(state.stock[0].totalCost).toBe(2)
  })

  test('pet zaporednih trkov → contended brez stranskih učinkov (serija/sled se ne ustvarita)', async () => {
    const { tx, state } = fakeTx([row(10), row(10), row(10), row(10), row(10)], [0, 0, 0, 0, 0])
    const res = await applyReceiveToStock(tx, input())
    expect(res).toEqual({ kind: 'contended' })
    expect(state.batches.length).toBe(0)
    expect(state.stock.length).toBe(0)
  })

  test('artikel ne obstaja → missing (prevzem ga preskoči, ne pade)', async () => {
    const { tx, state } = fakeTx([null], [])
    expect(await applyReceiveToStock(tx, input())).toEqual({ kind: 'missing' })
    expect(state.casArgs.length).toBe(0)
  })

  test('tuja lokacija → foreign_location brez zapisa zaloge', async () => {
    const { tx, state } = fakeTx([row(10, { locationId: 'loc-2', name: 'Tuja moka' })], [])
    const res = await applyReceiveToStock(tx, input())
    expect(res).toEqual({ kind: 'foreign_location', inventoryName: 'Tuja moka' })
    expect(state.casArgs.length).toBe(0)
    expect(state.batches.length).toBe(0)
  })
})
