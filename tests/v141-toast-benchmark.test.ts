/**
 * v1.141.0 — SVETOVNI POS BENCHMARK (Toast / Lightspeed / Square / Oracle):
 * 6 front-of-house izboljšav, ki jih je potrdil lastnik po vizualni primerjavi
 * z najboljšimi svetovnimi POS programi (poročilo: lepota 8–8.5/10, workflow
 * hitra prodaja 6/10 → cilj 8–9/10).
 *
 *  1. Kompaktni grid hitre prodaje (Toast »tiered grid«): preklop kartice ↔
 *     kompaktno (persist ro_sale_view), 3–6 stolpcev, barvno kodiran levega
 *     roba po kategoriji (deterministični hash — SALE_CAT_BORDER).
 *  2. Privzeta kategorija = NAJBOLJ POLNA (Toast vzorec), ne prva po sortOrder.
 *  3. Košara LEVO (Toast »left rail«): md:order-1 mreža order — oko natakarja
 *     ostaja na mreži (prej desno → pot čez cel zaslon).
 *  4. Temni način POS + KDS: kompaktna ploščica dark:bg-stone-800, all-day
 *     trak dark:bg-stone-950/95 (NE dark:stone-900 — .dark remap je svetel!).
 *  5. Prostorski tloris miz (Lightspeed): OBLIKE (square/round/stool) iz DB
 *     shape + fallback po sedežih, cone (dashed bounding box + oznaka), pike
 *     sedežev; mapTable izpostavlja shape (tipizirano).
 *  6. KDS odbrojevalni časovnik (profesionalni KDS): »še MM:SS« do praga,
 *     prek → Zamuda +MM:SS rdeče utripanje; sekunde FIXED (% 60); privzeta
 *     gostota kompaktno; tisk v kompaktni gostoti IKONSKO.
 *  +. Demo nabor (zaloga za testiranje): /api/inventory take 500 (~200 artiklov),
 *     prisma/seed-demo.ts + scripts/seed-demo-{tables,menu,orders}.ts.
 *
 * Čisto source-pin + i18n testi (vzorec issue69/70): brez DB fiksur, brez API
 * klicev. Demo skripte NE spreminjajo sheme (0 DDL).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { mapTable } from '../src/lib/map'

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')
const dash = (): string => src('app/dashboard/page.tsx')

// ═══ §A — Toast gostota: kompaktni grid + preklop načina ═══
describe('v1.141.0 §A — Toast gostota: kompaktni grid hitre prodaje', () => {
  it('preklop kartice ↔ kompaktno s persistom (ro_sale_view)', () => {
    const d = dash()
    expect(d).toContain("useState<'cards' | 'compact'>('cards')")
    expect(d).toContain("localStorage.getItem('ro_sale_view')")
    expect(d).toContain("localStorage.setItem('ro_sale_view', v)")
    expect(d).toContain("saleView === 'compact' ?")
  })
  it('kompaktna mreža 3–6 stolpcev (12–20 ploščic na ekran)', () => {
    const d = dash()
    expect(d).toContain('grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6')
    // ploščica je TIPKA (h-20) z barvnim levim robom kategorije
    expect(d).toContain('border-l-4')
    expect(d).toContain('h-20')
  })
  it('barvno kodiranje roba po kategoriji — deterministični hash (8 barv)', () => {
    const d = dash()
    expect(d).toContain('SALE_CAT_BORDER')
    expect(d).toContain('saleCatBorderCls(catKey)')
  })
  it('količina v košari = takojšen povratni signal (ring)', () => {
    expect(dash()).toContain("inCart > 0 ? 'ring-2 ring-emerald-600' : ''")
  })
})

// ═══ §B — Toast vzorec: privzeta kategorija = najbolj polna ═══
describe('v1.141.0 §B — privzeta kategorija = NAJBOLJ POLNA', () => {
  it('izbira po številu razpoložljivih izdelkov, ne po sortOrder', () => {
    const d = dash()
    expect(d).toContain('let best = categories[0]')
    expect(d).toContain('mi.categoryId === c.id && mi.available')
    expect(d).toContain('if (bestN > 0) setSaleCat(best.id)')
  })
  it('uporabnikov izbor premaga privzeto (saleCatTouched varovalka ostaja)', () => {
    expect(dash()).toContain("saleCatTouched.current || saleCat !== 'ALL'")
  })
})

// ═══ §C — Toast »left rail«: košara LEVO ═══
describe('v1.141.0 §C — košara levo (Toast left rail)', () => {
  it('md postavitev: mreža order-1 = košara, order-2 = mreža', () => {
    const d = dash()
    expect(d).toContain('md:grid-cols-[17rem_minmax(0,1fr)]')
    expect(d).toContain('md:order-1')
    expect(d).toContain('md:order-2')
  })
})

// ═══ §D — temni način POS + KDS ═══
describe('v1.141.0 §D — temni način POS in KDS', () => {
  it('kompaktna ploščica: dark podlage (bg-stone-800, NE stone-900 — .dark remap)', () => {
    const d = dash()
    expect(d).toContain('bg-white dark:bg-stone-800')
    expect(d).toContain('dark:hover:bg-stone-700')
  })
  it('KDS all-day trak: dark:bg-stone-950/95', () => {
    expect(dash()).toContain('dark:bg-stone-950/95')
  })
  it('ModuleIntro: temni odtenki (amber)', () => {
    const mi = src('components/module-intro.tsx')
    expect(mi).toContain('dark:bg-amber-950/40')
    expect(mi).toContain('dark:text-amber-300')
  })
})

// ═══ §E — Lightspeed: prostorski tloris miz ═══
describe('v1.141.0 §E — prostorski tloris (oblike miz, cone, sedeži)', () => {
  it('oblika iz DB shape + fallback po sedežih (1 stol, ≥6 krog, 2–5 kvadrat)', () => {
    const d = dash()
    expect(d).toContain("tb.shape || (tb.seats <= 1 ? 'stool' : tb.seats >= 6 ? 'round' : 'square')")
    expect(d).toContain("shape === 'stool'\n                      ? 'w-9 h-9 rounded-full text-[10px]'")
    expect(d).toContain("shape === 'round'\n                        ? 'w-16 h-16 rounded-full'")
  })
  it('cone: dashed bounding box + oznaka cone (zoneL)', () => {
    const d = dash()
    expect(d).toContain('[...new Set(viewTables.map((t) => t.zone))]')
    expect(d).toContain('border-2 border-dashed border-stone-300/80')
    expect(d).toContain('{zoneL(zone)}')
  })
  it('mapTable izpostavlja shape (tipizirano polje)', () => {
    const t = { id: 'x', capacity: 4, status: 'FREE', shape: 'round' } as never
    expect(mapTable(t).shape).toBe('round')
    const legacy = { id: 'y', capacity: 2, status: 'FREE', shape: null } as never
    expect(mapTable(legacy).shape).toBe('square')
  })
  it('aspectRatio 16/10 canvas + dotik (pointer dogodki) na tlorisu', () => {
    const d = dash()
    expect(d).toContain("aspectRatio: '16 / 10'")
    expect(d).toContain('onPointerDown={planPointerDown(tb)}')
  })
})

// ═══ §F — KDS odbrojevalni časovnik + kompaktna gostota ═══
describe('v1.141.0 §F — KDS odbrojevalni časovnik', () => {
  it('odbrojevalnik: še MM:SS / Zamuda +MM:SS (rdeče utripanje)', () => {
    const d = dash()
    expect(d).toContain("overdue ? 'bg-red-600 text-white border-red-700 animate-pulse' : pillCls")
    expect(d).toContain("{t('kds.remaining')} {mm}:{ss}")
    expect(d).toContain("{t('kds.overdue')} +{mm}:{ss}")
    // sekunde FIXED: % 60 (ne napačne minute)
    expect(d).toContain('two((rem * -1) % 60)')
    expect(d).toContain('two(rem % 60)')
  })
  it('prag zamude = max postajni cilj listka (kdsTargetOf)', () => {
    expect(dash()).toContain('kdsTargetOf(it) ?? 0')
  })
  it('privzeta gostota = kompaktno; tisk ikonsko v kompaktni gostoti', () => {
    const d = dash()
    expect(d).toContain("useState<KdsDensityT>('compact')")
    expect(d).toContain("kdsDensity === 'compact' ? 'h-11 w-11 p-0'")
  })
})

// ═══ §G — i18n: novi ključi v OBEH slovarjih ═══
describe('v1.141.0 §G — i18n ključi (SL + HR)', () => {
  const keys = ['sale.viewMode', 'sale.viewCards', 'sale.viewCompact', 'kds.remaining', 'kds.overdue'] as const
  for (const k of keys) {
    it(`${k} obstaja v SL in HR`, () => {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    })
  }
})

// ═══ §H — demo nabor za testiranje (zaloga) ═══
describe('v1.141.0 §H — demo nabor (zaloga ~200 artiklov)', () => {
  it('/api/inventory take 500 (zaloga tab pokaže CELO zalogo)', () => {
    const inv = readFileSync(join(process.cwd(), 'src/app/api/inventory/route.ts'), 'utf8')
    expect(inv).toContain('take: 500')
  })
  it('demo skripte obstajajo (seed-demo.ts + tables/menu/orders)', () => {
    expect(existsSync(join(process.cwd(), 'prisma/seed-demo.ts'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'scripts/seed-demo-tables.ts'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'scripts/seed-demo-menu.ts'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'scripts/seed-demo-orders.ts'))).toBe(true)
  })
  it('seed-demo: mize z oblikami (round/square) + cone + FEFO serije', () => {
    const seed = readFileSync(join(process.cwd(), 'prisma/seed-demo.ts'), 'utf8')
    expect(seed).toContain("shape: 'round'")
    expect(seed).toContain("shape: 'square'")
    // cone/območja tlorisa (Glavna dvorana / Šank / Terasa)
    expect(seed).toContain("area: 'Glavna dvorana'")
    expect(seed).toContain("area: 'Šank'")
  })
})
