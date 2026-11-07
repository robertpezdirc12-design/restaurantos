/**
 * v1.261.0 — SEDEŽI NA KUHINJSKEM LISTKU (docs/PRIMERJAVA-
 * VMESNIKOV-2026 §35; Square Vol 12 (10. 9. 2026) »razvrstitev
 * po sedežih na tisku« — zadnji neizvedeni Vol 12 P3 iz evidence
 * liste §31; zadnji A-razred kandidat brez DDL po zaključku §34).
 *
 * Merjena situacija: OrderItem.seat obstaja od v1.193.0 in se
 * PIŠE iz treh tokov (aktivni sedež N-27-1, plačilni dialog,
 * offline vrsta), a ga produkcija NI videla —
 * buildKitchenTicketLines polja sploh ni poznal (0 zadetkov
 * »seat« v print.ts) in KDS vrstica postavke prav tako ne.
 * Kuhinja — kjer sedež nosi največ informacije (alergije po
 * gostu!) — ni vedela, kateri sedež je kaj naročil.
 *
 *  Č1 · ČISTI SLOJ (print.ts): grupiranje po sedežih je POŠTENO
 *    do zgodovine — SAMO pri ≥ 2 različnih sedežih listek dobi
 *    odseke ── SEDEŽ N ── (naraščajoče), postavke brez sedeža
 *    sledijo brez glave; pri 0–1 sedežu je izhod byte-identičen
 *    (ničelna regresija). Station filter + ponatis + Št.
 *    artiklov ostajajo nedotaknjeni.
 *  Č2 · SERIALIZACIJA (map.ts): mapOrderItem aditivno izpostavi
 *    seat (?? null) — skalarno polje, brez spremembe poizvedb.
 *  Ž · MONTAŽA + REGISTRI: obe tiskalni mesti preslikata sedež,
 *    KDS čip pogojen na seat ≠ null (re-uporaba ključa
 *    payment.seatsAssign), 0 DDL dokaz, verzija 1.261.0,
 *    dokument §35 + AUDIT 0 ključev, worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildKitchenTicketLines } from '../src/lib/devices/print'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const pageSrc = read('src/app/dashboard/page.tsx')
const printSrc = read('src/lib/devices/print.ts')
const mapSrc = read('src/lib/map.ts')

// skupne postavke za teste — sedež je po tipu neobvezen
type SeatItem = { name: string; qty: number; station?: string; seat?: number | null; note?: string | null; modifiers?: string[] | null; allergenWarning?: string | null; allergenCodes?: string[] }

const baseOrder = {
  orderNumber: 128,
  tableName: 'Miza 10',
  type: 'DINE_IN',
  createdAt: '2026-11-05T18:30:00.000Z',
  employeeName: 'Ana',
}

/** Izpis brez sedežev (referenčna oblika) — 0 sedežev = stanje pred valom. */
function linesOf(items: SeatItem[], station?: 'KITCHEN' | 'BAR') {
  return buildKitchenTicketLines({ ...baseOrder, items }, station)
}

// ── Č1) ČISTI SLOJ ──

describe('v1.261.0 Č1 — sedeži na kuhinjskem listku (čisti sloj)', () => {
  test('Č1a: brez sedežev = byte-identičen izhod (ničelna regresija — večina listkov)', () => {
    const items: SeatItem[] = [
      { name: 'Bograč', qty: 1, station: 'KITCHEN', seat: null },
      { name: 'Bela kava', qty: 2, station: 'BAR' },
    ]
    const out = linesOf(items)
    const texts = out.map((l) => l.text)
    // nobenega odseka — oblika identična prejšnji verziji
    expect(texts.some((t) => t.includes('SEDEŽ'))).toBe(false)
    expect(texts).toContain('1× Bograč')
    expect(texts).toContain('2× Bela kava')
    // glava + noga ostajata (brez filtra je naslov KUHINJA — kot prej)
    expect(texts[0]).toBe('=== KUHINJA ===')
    expect(texts).toContain('Miza: Miza 10')
    expect(texts).toContain('Št. artiklov: 3')
  })

  test('Č1b: EN različen sedež = ŠE vedno brez glav (en sedež ni razdelitev)', () => {
    const items: SeatItem[] = [
      { name: 'Bograč', qty: 1, seat: 1 },
      { name: 'Zrezek', qty: 1, seat: 1 },
    ]
    const texts = linesOf(items).map((l) => l.text)
    expect(texts.some((t) => t.includes('SEDEŽ'))).toBe(false)
    expect(texts).toContain('1× Bograč')
    expect(texts).toContain('1× Zrezek')
  })

  test('Č1c: ≥ 2 sedeža = odseki naraščajoče z glavo ── SEDEŽ N ──', () => {
    const items: SeatItem[] = [
      { name: 'Zrezek', qty: 1, seat: 3 },
      { name: 'Juha', qty: 1, seat: 1 },
      { name: 'Solata', qty: 2, seat: 2 },
      { name: 'Pivo', qty: 1, seat: 1 },
    ]
    const texts = linesOf(items).map((l) => l.text)
    expect(texts).toContain('── SEDEŽ 1 ──')
    expect(texts).toContain('── SEDEŽ 2 ──')
    expect(texts).toContain('── SEDEŽ 3 ──')
    // naraščajoče: sedež 1 pred 2 pred 3
    const i1 = texts.indexOf('── SEDEŽ 1 ──')
    const i2 = texts.indexOf('── SEDEŽ 2 ──')
    const i3 = texts.indexOf('── SEDEŽ 3 ──')
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
    // postavke so pod SVOJIM odsekom (ne zaporedje vnosa)
    expect(texts.indexOf('1× Juha')).toBeGreaterThan(i1)
    expect(texts.indexOf('1× Juha')).toBeLessThan(i2)
    expect(texts.indexOf('2× Solata')).toBeGreaterThan(i2)
    expect(texts.indexOf('2× Solata')).toBeLessThan(i3)
    expect(texts.indexOf('1× Zrezek')).toBeGreaterThan(i3)
    expect(texts.indexOf('1× Pivo')).toBeGreaterThan(i1)
    expect(texts.indexOf('1× Pivo')).toBeLessThan(i2)
  })

  test('Č1d: postavke BREZ sedeža sledijo za odseki BREZ glave (iskrenost)', () => {
    const items: SeatItem[] = [
      { name: 'Juha', qty: 1, seat: 2 },
      { name: 'Kruh', qty: 3, seat: null }, // brez sedeža med seštevanjem
      { name: 'Zrezek', qty: 1, seat: 1 },
    ]
    const texts = linesOf(items).map((l) => l.text)
    expect(texts).toContain('── SEDEŽ 1 ──')
    expect(texts).toContain('── SEDEŽ 2 ──')
    // točno dve glavi odsekov — nobena »BREZ SEDEŽA«
    expect(texts.filter((t) => t.includes('SEDEŽ')).length).toBe(2)
    // kruh je ZA zadnjim odsekom (sedež 2), brez svoje glave
    const iS2 = texts.indexOf('── SEDEŽ 2 ──')
    const iKruh = texts.indexOf('3× Kruh')
    expect(iKruh).toBeGreaterThan(iS2)
    // Št. artiklov šteje VSE postavke (tudi brez sedeža)
    expect(texts).toContain('Št. artiklov: 5')
  })

  test('Č1e: station filter deluje NAD grupiranjem (bar list = samo bar postavke v odsekih)', () => {
    const items: SeatItem[] = [
      { name: 'Bograč', qty: 1, station: 'KITCHEN', seat: 1 },
      { name: 'Bela kava', qty: 1, station: 'BAR', seat: 1 },
      { name: 'Pivo', qty: 2, station: 'BAR', seat: 2 },
    ]
    const bar = buildKitchenTicketLines({ ...baseOrder, items }, 'BAR')
    const texts = bar.map((l) => l.text)
    expect(texts[0]).toBe('=== BAR LIST ===')
    expect(texts).toContain('── SEDEŽ 1 ──')
    expect(texts).toContain('── SEDEŽ 2 ──')
    expect(texts.some((t) => t.includes('Bograč'))).toBe(false)
    expect(texts).toContain('1× Bela kava')
    expect(texts).toContain('2× Pivo')
    expect(texts).toContain('Št. artiklov: 3')
    // kuhinjski filter pusti SAMO eno postavko → en sedež → brez glav
    const kitchen = buildKitchenTicketLines({ ...baseOrder, items }, 'KITCHEN')
    const ktexts = kitchen.map((l) => l.text)
    expect(ktexts.some((t) => t.includes('SEDEŽ'))).toBe(false)
    expect(ktexts).toContain('1× Bograč')
  })

  test('Č1f: opcije + alergeni + opomba ostanejo ZNOTRAJ odsekov svoje postavke', () => {
    const items: SeatItem[] = [
      { name: 'Pizza', qty: 1, seat: 1, modifiers: ['velika', 'brez čebule'], allergenWarning: 'lešniki', allergenCodes: ['GLUTEN'], note: 'brez feferonov' },
      { name: 'Solata', qty: 1, seat: 2 },
    ]
    const texts = linesOf(items).map((l) => l.text)
    const iS1 = texts.indexOf('── SEDEŽ 1 ──')
    const iS2 = texts.indexOf('── SEDEŽ 2 ──')
    for (const expected of ['   + velika', '   + brez čebule', '⚠ ALERGIJA: lešniki', '   opomba: brez feferonov']) {
      const at = texts.indexOf(expected)
      expect(at).toBeGreaterThan(iS1)
      expect(at).toBeLessThan(iS2)
    }
    expect(texts).toContain('1× Pizza')
  })

  test('Č1g: ponatis + sedeži sooplastična (dokument v sporu rekonstruira odseke)', () => {
    const items: SeatItem[] = [
      { name: 'Juha', qty: 1, seat: 1 },
      { name: 'Zrezek', qty: 1, seat: 2 },
    ]
    const out = buildKitchenTicketLines({ ...baseOrder, items }, undefined, { by: 'Vodja' })
    const texts = out.map((l) => l.text)
    expect(texts[0]).toBe('=== PONATIS · KUHINJA ===')
    // vrstica ponatisnika nosi tudi URO tiska (čas je živ — preverimo obliko)
    expect(texts.some((t) => /^Ponatis: Vodja · \d{2}:\d{2}$/.test(t))).toBe(true)
    expect(texts).toContain('Izvirno naročilo: 05. 11. 2026, 18:30')
    expect(texts).toContain('── SEDEŽ 1 ──')
    expect(texts).toContain('── SEDEŽ 2 ──')
  })

  test('Č1h: defenzivno — ne-številski sedež (NaN/Infinity/niz) = brez sedeža, ne explode', () => {
    const items = [
      { name: 'Juha', qty: 1, seat: Number.NaN },
      { name: 'Zrezek', qty: 1, seat: Number.POSITIVE_INFINITY },
      { name: 'Kava', qty: 1, seat: '2' as unknown as number },
    ]
    const texts = linesOf(items).map((l) => l.text)
    // samo '2' kot niz NI veljaven sedež → 0 veljavnih → brez glav
    expect(texts.some((t) => t.includes('SEDEŽ'))).toBe(false)
    expect(texts).toContain('1× Juha')
    expect(texts).toContain('1× Zrezek')
    expect(texts).toContain('1× Kava')
  })
})

// ── Č2) SERIALIZACIJA ──

describe('v1.261.0 Č2 — mapOrderItem aditivno izpostavi seat', () => {
  test('Č2a: vrstica s sedežem → številka; brez → null (?? null drži obliko)', () => {
    // mapOrderItem ni izvožen neposredno — preverimo skozi vir + obnašanje
    // print sloja nad serializirano obliko (seat ?? null obe mesti).
    // (Obstoječi testi already pokrivajo mapOrder prek API; tukaj je
    // pin oblike na izvorni ravni.)
    expect(mapSrc).toContain("seat: (it.seat as number | null | undefined) ?? null,")
    expect(mapSrc).toContain('v1.261.0 §35')
  })

  test('Č2b: builder tip postave nosi neobvezen seat (dvorogna streznost klienta)', () => {
    expect(printSrc).toMatch(/seat\?: number \| null/)
  })
})

// ── Ž) MONTAŽA + REGISTRI ──

describe('v1.261.0 Ž — montaža + registri', () => {
  test('Ž1: OrderItemT + OBE tiskalni mesti preslikata sedež v builder', () => {
    expect(pageSrc).toMatch(/seat\?: number \| null/)
    // KDS plošča (printKitchenTicket)
    expect(pageSrc).toMatch(/items: o\.items\.map\(\(it\) => \(\{ name: it\.name, qty: it\.qty, note: it\.note, station: it\.station, allergenWarning: it\.allergenWarning \|\| '', allergenCodes: it\.allergenCodes \|\| \[\], modifiers: it\.modifiers \?\? \[\], seat: it\.seat \?\? null \}\)\),/)
    // ponatis (confirmReprint)
    expect(pageSrc).toMatch(/items: live\.map\(\(it\) => \(\{ name: it\.name, qty: it\.qty, note: it\.note, station: it\.station, allergenWarning: it\.allergenWarning \|\| '', allergenCodes: it\.allergenCodes \|\| \[\], modifiers: it\.modifiers \?\? \[\], seat: it\.seat \?\? null \}\)\),/)
  })

  test('Ž2: KDS čip sedeža — pogojen na seat ≠ null, data-region, re-uporaba ključa', () => {
    expect(pageSrc).toContain('data-region="kds-seat-chip"')
    expect(pageSrc).toContain("{t('payment.seatsAssign', { n: it.seat })}")
    expect(pageSrc).toMatch(/\{it\.seat != null && \(/)
  })

  test('Ž3: 0 DDL — OrderItem.seat obstaja od v1.193.0, shema nedotaknjena', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).toMatch(/^  seat\s+Int\?$/m)
    // KDS čip in tisk so bralna plast — 0 novih API poti
    const seatRoutes = read('src/app/api/orders/[id]/seats/route.ts')
    expect(seatRoutes).toBeTruthy() // obstoječa pot iz v1.193.0 (PATCH dodelitev)
  })

  test('Ž4: i18n — 0 novih ključev (SL literali na tisku + re-uporaba payment.seatsAssign)', () => {
    // ključ obstaja v obeh slovarjih od v1.193.0 — re-uporaba, 0 duplikatov
    expect(sl['payment.seatsAssign']).toBe('Sedež {n}')
    expect(hr['payment.seatsAssign']).toBe('Sjedište {n}')
    // tiskalna glava odseka je SL literal v print.ts (konvencija KUHINJSKI LIST)
    expect(printSrc).toContain('── SEDEŽ ${s} ──')
    // AUDIT: števci nespremenjeni (0 ključev vala)
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.261.0, PRIMERJAVA-VMESNIKOV-2026 §35)')
    expect(auditDoc).toContain('števci nespremenjeni (4121)')
  })

  test('Ž5: dokument §35 + verzija 1.261.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 35.')
    expect(doc).toContain('SEDEŽI NA KUHINJSKEM LISTKU v1.261.0')
    expect(APP_VERSION).toBe('1.274.0')
    expect(read('src/lib/version.ts')).toContain("'1.274.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.274.0')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.274.0-lokalni-determinizem')
  })
})
