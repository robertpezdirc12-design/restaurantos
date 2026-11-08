import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.236.0 — POLISH VAL 2 (docs/PRIMERJAVA-VMESNIKOV-2026 NOVA §13):
 *
 * Raziskava december 2026 — Toast KDS platform guide + skupnost (avg/okt 2026):
 * 1. FLASH CHANGES: »A flash animation to indicate a ticket is new or was
 *    changed« — pri steni 10 listkov kuhar vidi, KATERI listek se je pravkar
 *    spremenil (dodatek postavk ob drugem krogu naročanja). Zvok: ločeni toni
 *    za nov listek / spremembo / preklic (Toast: »sound alerts for new tickets,
 *    ready orders, item changes, and voided items«). Zatritev po ~10 s
 *    (»recently fulfilled tickets stop flashing«, Toast okt 2026).
 * 2. PREKLICANE POSTAVKE VIDNE: prej se je postavka, preklicana PO pošiljanju
 *    v kuhinjo, TIHO izgubila s KDS (kuhar je lahko že strt delo). Toast:
 *    voided item ostane na listku PREČRTAN + alarm. 30-min okno, razlog iz
 *    kataloga (VoidReason), izločene iz vseh štetij (All Day, ETA, pragovi).
 *
 * 0 DDL · 0 odvisnosti · 0 AI. Vrh: klientski diferencialni pogon nad SSE
 * pretokom / 15 s pollingom (identiteta id-jev, ne števci).
 */

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const kitchenRoute = read('src/app/api/kitchen/route.ts')
const slSrc = read('src/lib/i18n/sl.ts')
const hrSrc = read('src/lib/i18n/hr.ts')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')

describe('v1.236.0 A — API: preklicane postavke (voidedItems)', () => {
  test('A1: poizvedba voidedItems — voided + AKTIVEN status + 30-min okno (KDS_VOID_WINDOW_MS)', () => {
    expect(kitchenRoute).toContain('KDS_VOID_WINDOW_MS = 30 * 60 * 1000')
    expect(kitchenRoute).toContain('voided: true')
    expect(kitchenRoute).toContain('updatedAt: { gte: voidedSince }')
    expect(kitchenRoute).toContain("status: { in: ITEM_ACTIVE_PRISMA }")
  })

  test('A2: vključen razlog iz kataloga (VoidReason → voidReasonName, aditivno)', () => {
    expect(kitchenRoute).toContain('VoidReason: { select: { name: true } }')
    expect(kitchenRoute).toContain('voidReasonName: v.VoidReason?.name ?? null')
  })

  test('A3: polje je ADITIVNO na vsakem listku vrste (queueWithVoids; stare odjemalce ne vrže)', () => {
    expect(kitchenRoute).toContain('voidedItems: voidedByOrder.get(o.id) ?? []')
  })

  test('A4: postajni filter obdrži listek z SAMO preklicanimi postavkami (informacija za kuhinjo)', () => {
    expect(kitchenRoute).toContain('o.items.length > 0 || o.voidedItems.length > 0')
  })

  test('A5: varovala — take 200 (masovni preklic ne raznese odgovora) + obseg lokacije', () => {
    expect(kitchenRoute).toContain('take: 200')
    expect(kitchenRoute).toContain('Order: { ...scope, status: { in: ORDER_ACTIVE_DB } }')
  })
})

describe('v1.236.0 B — klient: flash diferencialni pogon (Toast »Flash Changes«)', () => {
  test('B1: vidni posnetek primerja IDENTITETO (id-ji), ne števce — newTickets/newItems/newVoids', () => {
    expect(dash).toContain('const newTickets = vis.filter((o) => !seen.tickets.has(o.id))')
    expect(dash).toContain("o.items.filter((it) => !seen.items.has(it.id))")
    expect(dash).toContain('o.voids.filter((it) => !seen.voids.has(it.id))')
  })

  test('B2: prvi odčitek in preklop postaje = IZHODIŠČE (brez lažnega utripanja)', () => {
    expect(dash).toContain('if (!seen.primed || seen.station !== kdsStation) {')
    expect(dash).toContain('// izhodišče: prvi odčitek ali preklop postaje ne utripa ničesar')
  })

  test('B3: zatritev po ~10 s (Toast okt 2026 — fulfilled tickets stop flashing)', () => {
    expect(dash).toContain('setTimeout(() => setKdsFlash({ tickets: {}, items: {}, voids: {} }), 10_500)')
  })

  test('B4: RAZLIČNI zvočni toni — nov listek 880 / sprememba 660 dvojni / preklic 392 trojni', () => {
    expect(dash).toContain('kdsBeep(880, 180)')
    expect(dash).toContain('kdsBeep(660, 110); kdsBeep(660, 110, 170)')
    expect(dash).toContain('kdsBeep(392, 140); kdsBeep(392, 140, 200); kdsBeep(392, 140, 400)')
    // prednost: preklic > nov listek > sprememba (eni dogodek = en ton)
    const idx = dash.indexOf('if (newVoids.length > 0)')
    expect(idx).toBeGreaterThan(0)
    const block = dash.slice(idx, idx + 400)
    expect(block.indexOf('newTickets.length > 0')).toBeGreaterThan(0)
  })

  test('B5: poimenovana postaja (task board) ostaja na števcu nalog — ničelna regresija', () => {
    expect(dash).toContain("if (pending > kdsPrevPendingRef.current && kdsSound) kdsBeep(880, 180)")
  })

  test('B6: utripajoči obroč NOVEGA listka — prazen prekrivni span (vsebina NE utripa)', () => {
    expect(dash).toContain('data-region="kds-flash-ring"')
    const idx = dash.indexOf('data-region="kds-flash-ring"')
    const block = dash.slice(idx - 200, idx + 300)
    expect(block).toContain('pointer-events-none')
    expect(block).toContain('animate-pulse')
    expect(block).toContain('ring-4')
  })

  test('B7: znački NOVO / +n v glavi listka (kds-flash-new / kds-flash-items)', () => {
    expect(dash).toContain('data-region="kds-flash-new"')
    expect(dash).toContain("t('kds.newTicket')")
    expect(dash).toContain("t('kds.newItems', { n: flashItems.length })")
  })

  test('B8: utrip DODANE vrstice — oranžni rob + ozadje + obroč (kds-item-new čip)', () => {
    expect(dash).toContain("const itFlash = !!kdsFlash.items[it.id]")
    expect(dash).toContain("'border-orange-400 bg-orange-50 ring-2 ring-orange-300/60'")
    expect(dash).toContain('data-region="kds-item-new"')
  })
})

describe('v1.236.0 C — klient: preklicane postavke na listku', () => {
  test('C1: prečrtana vrstica z razlogom (kds-ticket-voided + line-through + razlog)', () => {
    expect(dash).toContain('data-region="kds-ticket-voided"')
    expect(dash).toContain('line-through')
    expect(dash).toContain('v.voidReasonName')
  })

  test('C2: NOV preklic utripa rdeče (voids mapa — isti diferencialni pogon)', () => {
    expect(dash).toContain('kdsFlash.voids[v.id]')
    const idx = dash.indexOf("kdsFlash.voids[v.id] ? 'border-red-400")
    expect(idx).toBeGreaterThan(0)
  })

  test('C3: vrsta obdrži listek z VSAJ preklicanimi postavkami (ne izgine tiho)', () => {
    expect(dash).toContain('(o.voidedItems ?? []).some((it) => kdsLegacyBucket')
  })

  test('C4: postavni filter preklicanih (BAR zaslon ne kaže kuhinjskih preklicov)', () => {
    expect(dash).toContain("const voidedHere = (o.voidedItems ?? []).filter((it) => kdsLegacyBucket === 'ALL' || (it.station || 'KITCHEN') === kdsLegacyBucket)")
  })

  test('C5: odsek je role=status (ni alarm — informacija; alarm je pas alergenov)', () => {
    const idx = dash.indexOf('data-region="kds-ticket-voided"')
    const block = dash.slice(idx, idx + 200)
    expect(block).toContain('role="status"')
  })
})

describe('v1.236.0 D — i18n (SL + HR pariteta, 3853 → 3857)', () => {
  test('D1: števci', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('D2: novi ključi KDS (4) obstajajo v obeh jezikih', () => {
    for (const k of ['kds.newTicket', 'kds.newItems', 'kds.voidedTitle', 'kds.voidedItem']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
  })

  test('D3: newItems nosi {n} spremenljivko v obeh jezikih', () => {
    expect(sl['kds.newItems']).toContain('{n}')
    expect(hr['kds.newItems']).toContain('{n}')
  })

  test('D4: SL/HR vrednosti niso po pomenu zamenjane (preklic = actionable besedilo)', () => {
    expect(sl['kds.voidedTitle']).toContain('ne pripravljaj')
    expect(hr['kds.voidedTitle']).toContain('ne pripremaj')
  })
})

describe('v1.236.0 Ž — registri (doc-truth + verzija)', () => {
  test('Ž1: verzija', () => {
    expect(APP_VERSION).toBe('1.285.0')
  })

  test('Ž2: PRIMERJAVA §13 (raziskava december 2026 — Flash Changes + preklicane postavke)', () => {
    expect(doc).toContain('## 13.')
    expect(doc).toContain('Flash Changes')
    expect(doc).toContain('prečrtan')
  })

  test('Ž3: toast utrip ne uporablja modre/indigo (dostopnost — oranžna paleta)', () => {
    const idx = dash.indexOf('kds-flash-ring')
    const block = dash.slice(idx - 100, idx + 500)
    expect(block).not.toMatch(/blue|indigo/)
    expect(block).toContain('orange')
  })
})
