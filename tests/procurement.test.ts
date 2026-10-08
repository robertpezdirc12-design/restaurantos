import { describe, it, expect } from 'bun:test'
import {
  poNumberFor,
  grnNumberFor,
  canTransition,
  lineNetCents,
  computeLineCents,
  computeTotalsCents,
  qtyToMilli,
  validateReceiveLines,
  itemStatusAfter,
  poStatusAfter,
  weightedAvgCostCents,
  priceHistoryRows,
  type PoItemState,
  type ReceiveLineInput,
} from '@/lib/procurement'

/* Issue #1 (triage ②) — nabava + prevzem: čista logika (brez DB).
   Ključne garancije: vsote so TOČNE v centih (integer aritmetika),
   statusni prehodi so zaprti (osnutek→oddaja→odobritev→dobava),
   prevzem vedno primerja naročeno/prejeto, zavrnitve zahtevajo razlog. */

describe('številčenje dokumentov', () => {
  it('PO-YYYYMMDD-0001 oblika (lokalni datum)', () => {
    expect(poNumberFor(new Date(2026, 9, 8), 1)).toBe('PO-20261008-0001')
    expect(poNumberFor(new Date(2026, 11, 31), 42)).toBe('PO-20261231-0042')
  })
  it('GRN-YYYYMMDD-0001 oblika', () => {
    expect(grnNumberFor(new Date(2026, 9, 8), 7)).toBe('GRN-20261008-0007')
  })
  it('neveljavna zaporedna številka zavrnjena', () => {
    expect(() => poNumberFor(new Date(), 0)).toThrow()
    expect(() => grnNumberFor(new Date(), 1.5)).toThrow()
  })
})

describe('statusni prehodi naročila', () => {
  it('srečna pot: draft → submitted → approved → partial → received', () => {
    expect(canTransition('draft', 'submitted')).toBe(true)
    expect(canTransition('submitted', 'approved')).toBe(true)
    expect(canTransition('approved', 'partial')).toBe(true)
    expect(canTransition('partial', 'partial')).toBe(true)
    expect(canTransition('partial', 'received')).toBe(true)
  })
  it('preklic dovoljen iz draft/submitted/approved/partial', () => {
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('submitted', 'cancelled')).toBe(true)
    expect(canTransition('approved', 'cancelled')).toBe(true)
    expect(canTransition('partial', 'cancelled')).toBe(true)
  })
  it('nedovoljeni preskoki: draft→approved, draft→received, submitted→received', () => {
    expect(canTransition('draft', 'approved')).toBe(false)
    expect(canTransition('draft', 'received')).toBe(false)
    expect(canTransition('submitted', 'received')).toBe(false)
    expect(canTransition('submitted', 'partial')).toBe(false)
  })
  it('terminalna stanja (received, cancelled) nimajo prehodov', () => {
    expect(canTransition('received', 'draft')).toBe(false)
    expect(canTransition('cancelled', 'draft')).toBe(false)
    expect(canTransition('received', 'partial')).toBe(false)
  })
})

describe('točne vsote v centih', () => {
  it('lineNetCents: 3 × 433.33 → 129999 (brez plavajoče napake)', () => {
    expect(lineNetCents(3, 43333)).toBe(129999)
  })
  it('frakcijska količina: 0.333 × 999c → 333', () => {
    expect(lineNetCents(0.333, 999)).toBe(333)
  })
  it('float drift zaščita: 0.1 + 0.2 količine pri 100c → 30c', () => {
    expect(qtyToMilli(0.1) + qtyToMilli(0.2)).toBe(300)
    expect(lineNetCents(0.3, 100)).toBe(30)
  })
  it('DDV po vrstici: 999c × 22 % → 220c (zaokroženo na cent)', () => {
    expect(computeLineCents({ quantity: 1, unitPriceCents: 999, vatRate: 22 })).toEqual({ netCents: 999, vatCents: 220, totalCents: 1219 })
  })
  it('vsota vrstic je TOČNO vsota subtotalov in DDV-jev', () => {
    const t = computeTotalsCents([
      { quantity: 2, unitPriceCents: 1250, vatRate: 22 },
      { quantity: 3.5, unitPriceCents: 899, vatRate: 9.5 },
      { quantity: 1, unitPriceCents: 1000, vatRate: 0 },
    ])
    expect(t.subtotalCents).toBe(2500 + 3147 + 1000)
    expect(t.vatCents).toBe(550 + 299 + 0)
    expect(t.totalCents).toBe(t.subtotalCents + t.vatCents)
  })
  it('privzeta DDV stopnja je 22 %, neveljavna zavrnjena', () => {
    expect(computeLineCents({ quantity: 1, unitPriceCents: 100 }).vatCents).toBe(22)
    expect(() => computeLineCents({ quantity: 1, unitPriceCents: 100, vatRate: 31 })).toThrow()
    expect(() => computeLineCents({ quantity: 1, unitPriceCents: -1 })).toThrow()
  })
})

describe('primerjava naročeno / prejeto', () => {
  const items: PoItemState[] = [
    { id: 'i1', description: 'Moka', quantityOrdered: 10, quantityReceivedSoFar: 0 },
    { id: 'i2', description: 'Olje', quantityOrdered: 6, quantityReceivedSoFar: 2 },
    { id: 'i3', description: 'Sol', quantityOrdered: 1, quantityReceivedSoFar: 1 },
  ]

  it('veljaven delni prevzem brez opozoril', () => {
    const lines: ReceiveLineInput[] = [
      { purchaseOrderItemId: 'i1', quantityAccepted: 4, quantityRejected: 0 },
      { purchaseOrderItemId: 'i2', quantityAccepted: 2, quantityRejected: 0 },
    ]
    const v = validateReceiveLines(items, lines)
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
    expect(v.hasAccepted).toBe(true)
    expect(v.overReceipt).toBe(false)
  })

  it('neznana postavka → napaka', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'neznana', quantityAccepted: 1, quantityRejected: 0 }])
    expect(v.errors.some((e) => e.includes('neznana postavka'))).toBe(true)
  })

  it('negativne količine → napaka', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'i1', quantityAccepted: -1, quantityRejected: 0 }])
    expect(v.errors.length).toBeGreaterThan(0)
  })

  it('zavrnjena količina brez razloga → napaka (evidenca vedno z razlogom)', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'i1', quantityAccepted: 0, quantityRejected: 2 }])
    expect(v.errors.some((e) => e.includes('razlog obvezen'))).toBe(true)
    const ok = validateReceiveLines(items, [{ purchaseOrderItemId: 'i1', quantityAccepted: 5, quantityRejected: 2, rejectReason: 'poškodovana embalaža' }])
    expect(ok.errors).toEqual([])
  })

  it('vse vrstice nič + brez sprejema → napaka', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'i1', quantityAccepted: 0, quantityRejected: 0 }])
    expect(v.errors.some((e) => e.includes('Vsaj ena vrstica'))).toBe(true)
  })

  it('over-receipt nad naročeno → opozorilo (dovoljen, označen)', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'i1', quantityAccepted: 11, quantityRejected: 0 }])
    expect(v.errors).toEqual([])
    expect(v.overReceipt).toBe(true)
    expect(v.warnings.length).toBe(1)
  })

  it('over-receipt upošteva že prejeto: 2 prejeto od 6, prevzem 5 → opozorilo', () => {
    const v = validateReceiveLines(items, [{ purchaseOrderItemId: 'i2', quantityAccepted: 5, quantityRejected: 0 }])
    expect(v.overReceipt).toBe(true)
  })

  it('podvojena postavka v prevzemu → napaka', () => {
    const v = validateReceiveLines(items, [
      { purchaseOrderItemId: 'i1', quantityAccepted: 1, quantityRejected: 0 },
      { purchaseOrderItemId: 'i1', quantityAccepted: 1, quantityRejected: 0 },
    ])
    expect(v.errors.some((e) => e.includes('dvakrat'))).toBe(true)
  })
})

describe('statusi po prevzemu', () => {
  it('itemStatusAfter: pending / partial / received', () => {
    expect(itemStatusAfter(10, 0, 0, 0)).toBe('pending')
    expect(itemStatusAfter(10, 0, 4, 0)).toBe('partial')
    expect(itemStatusAfter(10, 4, 6, 0)).toBe('received')
    expect(itemStatusAfter(10, 0, 0, 10)).toBe('received') // vse zavrnjeno = postavka obravnavana
  })
  it('decimalna natančnost: 0.1 + 0.2 od 0.3 → received (brez float drifta)', () => {
    expect(itemStatusAfter(0.3, 0.1, 0.2, 0)).toBe('received')
    expect(itemStatusAfter(0.3, 0.1, 0.1, 0)).toBe('partial')
  })
  it('poStatusAfter: vse received → received, mešano → partial', () => {
    expect(poStatusAfter(['received', 'received'])).toBe('received')
    expect(poStatusAfter(['received', 'partial'])).toBe('partial')
    expect(poStatusAfter(['pending'])).toBe('partial')
  })
})

describe('uteženo povprečna nabavna cena', () => {
  it('(10 kg po 200c) + (10 kg po 300c) → 250c', () => {
    expect(weightedAvgCostCents(10, 200, 10, 300)).toBe(250)
  })
  it('prazna zaloga → cena prevzema', () => {
    expect(weightedAvgCostCents(0, 0, 5, 150)).toBe(150)
  })
  it('prevzem brez količine ne spremeni cene', () => {
    expect(weightedAvgCostCents(10, 200, 0, 999)).toBe(200)
  })
  it('zaokrožitev na cent: (1 po 100c) + (1 po 101c) → 100.5 → 101', () => {
    expect(weightedAvgCostCents(1, 100, 1, 101)).toBe(101)
  })
})

describe('zgodovina nabavnih cen (SupplierPriceHistory)', () => {
  const base = { supplierId: 'sup1', purchaseOrderId: 'po1', locationId: 'loc1', observedAt: new Date('2026-10-08T10:00:00Z') }
  it('samo sprejete postavke z inventoryItemId; source = goods_receipt', () => {
    const rows = priceHistoryRows({
      ...base,
      lines: [
        { inventoryItemId: 'a1', quantityAccepted: 5, unitPrice: 4.5, unit: 'kg', vatRate: 22 },
        { inventoryItemId: 'a2', quantityAccepted: 0, unitPrice: 2, unit: 'l' }, // nič sprejeto → izpuščeno
        { quantityAccepted: 3, unitPrice: 1 }, // brez inventoryItemId → izpuščeno
      ],
    })
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ supplierId: 'sup1', inventoryItemId: 'a1', unitPrice: 4.5, source: 'goods_receipt', purchaseOrderId: 'po1' })
  })
  it('brez lokacije → locationId null, unit privzeto pcs', () => {
    const rows = priceHistoryRows({ ...base, locationId: null, lines: [{ inventoryItemId: 'x', quantityAccepted: 1, unitPrice: 9 }] })
    expect(rows[0].locationId).toBeNull()
    expect(rows[0].unit).toBe('pcs')
    expect(rows[0].vatRate).toBeNull()
  })
})
