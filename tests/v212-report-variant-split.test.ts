/**
 * v1.212.0 — OSS-10 C-del: RAZCEP POROČIL PO VARIANTI.
 *
 * Kontekst: v1.209.0 je uvedel variante (obvezna enoizbirna skupina = velikost/
 * nivo), v1.210.0 izbiro osebja v POS — a so poročila ŠE VEDNO grupirala po
 * osnovnem imenu artikla: dashboard topItems (SQL groupBy po menuItemName),
 * dnevni e-poštni digest (top 3) in povzetek zaprtja izmene (top 3) so »0,5 L«
 * in »0,33 L« stalili v eno vrstico »Pizza«. Poštena meja iz v1.209.0/v1.210.0
 * („razcep poročil po varianti = naslednji val") je s tem vala poravnana.
 *
 * Kontrakt razcepa (isti razred kot isVariantGroup): LE obvezne enoizbirne
 * skupine razcepijo poročilno vrstico (velikost se ZAMENJUJE — »0,5 L« je
 * druga prodajna enota); prosti dodatki (»brez čebule«) razcepa NE naredijo
 * (sicer bi top-liste razpadle na desetine šumnih kombinacij z isto vsebino).
 * Brez variant v podatkih je izhod enak prejšnjemu obnašanju (samo osnovno ime).
 *
 * Poštene meje (namenoma NIZ razcepljene, dokumentirano v GAP OSS-10):
 *  - ai-insights restock: potrošnja zaloge je po OSNOVNEM artiklu (receptura
 *    ve, koliko moke porabi »Pizza«, ne »Pizza · 0,5 L«) — razcep bi podvajal
 *    predloge na varianti istega artikla;
 *  - menu-engineering + food-cost: cena na varianto NE obstaja (receptura je
 *    vezana na artikel) — razcep bi prikazal lažno ceno/maržo.
 *
 * Merila:
 *  Č1 čisti sloj (PURE, 0 baze): variantOptionNamesOf (razred = ISTI kot
 *     isVariantGroup, fail-soft) + aggregateSalesByVariant (razcep, spajanje,
 *     determinističen vrstni red, fail-soft; brez opcij = osnovno ime).
 *  Č2 disk kontrakt: dashboard/daily-email/shifts ožičenje (findMany z
 *     OrderItemModifier + ModifierGroup, agregacija v čistem sloju, top N
 *     zrezano na kraju; stari ročni qtyByName poti ZBRIŠANI) + item-variants
 *     ostaja brez uvozov + GAP dokument nosi C-DEL dokaz in poštene meje.
 *  Č3 registri: verzija 1.212.0 (toBe + ubežen regex), oznaka slike ↔
 *     APP_VERSION.
 *
 * 0 fikstur baze — sweep ni potreben (demo podatki nedotaknjeni).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  aggregateSalesByVariant,
  variantOptionNamesOf,
  isVariantGroup,
  orderItemDisplayName,
  type ReportItemRow,
  type ReportModifierRow,
} from '../src/lib/item-variants'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** Pomožnik: mod iz DB oblike (name + skupinski podatki). */
const mod = (name: string | null, groupRequired: unknown, groupMaxSelect: unknown): ReportModifierRow =>
  ({ name, groupRequired, groupMaxSelect })

/* ── Č1 — čisti sloj: razred opcij + agregacija z razcepom ────────────────── */
describe('v1.212.0 — Č1: variantOptionNamesOf (razred opcij za poročila)', () => {
  it('obvezna enoizbirna skupina = variantna opcija (ISTI razred kot isVariantGroup)', () => {
    const g = { required: true, maxSelect: 1 }
    expect(isVariantGroup(g)).toBe(true)
    expect(variantOptionNamesOf([mod('0,5 L', true, 1)])).toEqual(['0,5 L'])
  })

  it('prosta skupina (dodatek) razcepa NE naredi — required=false ali maxSelect≠1', () => {
    expect(variantOptionNamesOf([mod('brez čebule', false, 1)])).toEqual([])
    expect(variantOptionNamesOf([mod('_extra_', true, 3)])).toEqual([])
    expect(variantOptionNamesOf([mod('brez čebule', false, null)])).toEqual([])
  })

  it('fail-soft: izbrisana skupina (null), neznane vrednosti, prazno/ne-niz ime → opcija ven', () => {
    expect(variantOptionNamesOf([mod('0,5 L', null, null)])).toEqual([])
    expect(variantOptionNamesOf([mod(null, true, 1)])).toEqual([])
    expect(variantOptionNamesOf([mod('   ', true, 1)])).toEqual([])
    expect(variantOptionNamesOf([mod(42 as unknown as string, true, 1)])).toEqual([])
    expect(variantOptionNamesOf([null, undefined] as unknown as ReportModifierRow[])).toEqual([])
    expect(variantOptionNamesOf(null)).toEqual([])
    expect(variantOptionNamesOf(undefined)).toEqual([])
    expect(variantOptionNamesOf('ne-niz' as unknown as ReportModifierRow[])).toEqual([])
  })

  it('ime se obreže; mešani vhod vrne LE variantne opcije v vrstnem redu', () => {
    const mods = [
      mod('dodatek sir', false, 5),
      mod('  0,33 L  ', true, 1),
      mod('brez čebule', false, null),
      mod('nivo 2', true, 1),
    ]
    expect(variantOptionNamesOf(mods)).toEqual(['0,33 L', 'nivo 2'])
  })
})

describe('v1.212.0 — Č1: aggregateSalesByVariant (razcep + spajanje + vrstni red)', () => {
  it('različni varianti istega artikla = LOKEV vrstici, enaka izbira = spojena', () => {
    const rows: ReportItemRow[] = [
      { name: 'Pizza', qty: 2, modifiers: [mod('0,5 L', true, 1)] },
      { name: 'Pizza', qty: 1, modifiers: [mod('0,33 L', true, 1)] },
      { name: 'Pizza', qty: 3, modifiers: [mod('0,5 L', true, 1)] },
    ]
    expect(aggregateSalesByVariant(rows)).toEqual([
      { name: 'Pizza · 0,5 L', qty: 5 },
      { name: 'Pizza · 0,33 L', qty: 1 },
    ])
  })

  it('prosti dodatki NE razcepijo: isti artikel z različnimi dodatki = ena vrstica', () => {
    const rows: ReportItemRow[] = [
      { name: 'Pizza', qty: 2, modifiers: [mod('brez čebule', false, null)] },
      { name: 'Pizza', qty: 1, modifiers: [mod('dodatek sir', false, 5)] },
      { name: 'Pizza', qty: 4 },
    ]
    expect(aggregateSalesByVariant(rows)).toEqual([{ name: 'Pizza', qty: 7 }])
  })

  it('mešanica: osnovna vrstica + variantni razcep soobstojata', () => {
    const rows: ReportItemRow[] = [
      { name: 'Juha', qty: 3 },
      { name: 'Pizza', qty: 1, modifiers: [mod('0,5 L', true, 1)] },
      { name: 'Pizza', qty: 2, modifiers: [mod('0,5 L', true, 1), mod('brez čebule', false, null)] },
    ]
    expect(aggregateSalesByVariant(rows)).toEqual([
      { name: 'Juha', qty: 3 },
      { name: 'Pizza · 0,5 L', qty: 3 },
    ])
  })

  it('brez variant v podatkih = obnašanje enako prej (samo osnovna imena)', () => {
    const rows: ReportItemRow[] = [
      { name: 'Juha', qty: 3 },
      { name: 'Pizza', qty: 1, modifiers: [mod('brez čebule', false, null)] },
      { name: 'Solata', qty: 2, modifiers: [] },
    ]
    expect(aggregateSalesByVariant(rows)).toEqual([
      { name: 'Juha', qty: 3 },
      { name: 'Solata', qty: 2 },
      { name: 'Pizza', qty: 1 },
    ])
  })

  it('determinističen vrstni red: qty padajoče, izenačenje po kodnih točkah imena', () => {
    const rows: ReportItemRow[] = [
      { name: 'B', qty: 2 },
      { name: 'A', qty: 2 },
      { name: 'C', qty: 9 },
    ]
    expect(aggregateSalesByVariant(rows).map((r) => r.name)).toEqual(['C', 'A', 'B'])
  })

  it('fail-soft: null vrstice preskočene, ne-številska qty = 0, manjkajoče ime = Artikel', () => {
    const rows = [
      null,
      { name: null, qty: 2 },
      { name: 'X', qty: Number.NaN },
      { name: 'Y', qty: '3' },
    ] as unknown as ReportItemRow[]
    expect(aggregateSalesByVariant(rows)).toEqual([
      { name: 'Y', qty: 3 },
      { name: 'Artikel', qty: 2 },
      { name: 'X', qty: 0 },
    ])
  })

  it('podvojeni/prazni imena opcij se deduplikirajo (pogodba orderItemDisplayName)', () => {
    const rows: ReportItemRow[] = [
      {
        name: 'Pizza',
        qty: 1,
        modifiers: [mod('0,5 L', true, 1), mod('0,5 L', true, 1), mod('  ', true, 1)],
      },
    ]
    expect(aggregateSalesByVariant(rows)).toEqual([{ name: 'Pizza · 0,5 L', qty: 1 }])
    // in sestavljenec je dobesedno izhod orderItemDisplayName
    expect(orderItemDisplayName('Pizza', ['0,5 L'])).toBe('Pizza · 0,5 L')
  })

  it('null/undefined/ne-niz vhod → prazen seznam (nikoli ne meče)', () => {
    expect(aggregateSalesByVariant(null)).toEqual([])
    expect(aggregateSalesByVariant(undefined)).toEqual([])
    expect(aggregateSalesByVariant(42 as unknown as ReportItemRow[])).toEqual([])
  })
})

/* ── Č2 — disk kontrakt: ožičenje treh poročil + meje + GAP ────────────────── */
describe('v1.212.0 — Č2: disk kontrakt ožičenja', () => {
  it('dashboard: groupBy po menuItemName Zamenjan s findMany + agregacijo v čistem sloju', () => {
    const route = read('src/app/api/dashboard/route.ts')
    // stari SQL grupirni poti NE SME več biti (razcep je bil nemogoč v SQL)
    expect(route).not.toContain("by: ['menuItemName']")
    expect(route).toContain('aggregateSalesByVariant')
    expect(route).toContain('OrderItemModifier')
    expect(route).toContain('ModifierGroup: { select: { required: true, maxSelect: true } }')
    expect(route).toContain('.slice(0, 5)')
  })

  it('daily-email: digest top 3 nosi razcep (stari ročni qtyByName pot zbrisan)', () => {
    const lib = read('src/lib/daily-email.ts')
    expect(lib).toContain('aggregateSalesByVariant')
    expect(lib).toContain('OrderItemModifier')
    expect(lib).not.toContain('qtyByName')
    expect(lib).not.toContain("'(artikel)'")
    expect(lib).toContain('.slice(0, 3)')
  })

  it('shifts: povzetek izmene top 3 nosi ISTI kontrakt', () => {
    const route = read('src/app/api/shifts/route.ts')
    expect(route).toContain('aggregateSalesByVariant')
    expect(route).toContain('OrderItemModifier')
    expect(route).not.toContain('qtyByName')
    expect(route).not.toContain("'(artikel)'")
    expect(route).toContain('.slice(0, 3)')
  })

  it('item-variants.ts ostane čisti sloj: 0 uvozov (konvencija od v1.209.0)', () => {
    const lib = read('src/lib/item-variants.ts')
    expect(lib).not.toMatch(/^import\s/m)
    expect(lib).toContain('aggregateSalesByVariant')
    expect(lib).toContain('variantOptionNamesOf')
  })

  it('poštene meje: costna poročila ostanejo na osnovnem artiklu (GAP dokument)', () => {
    const gap = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(gap).toContain('C-DEL IZVEDENO @ v1.212.0')
    // meje morajo biti izrecne — razcep bi tu prikazal lažno ceno / podvajal predloge
    expect(gap).toContain('menu-engineering + food-cost na OSNOVNEM artiklu')
  })

  it('ai-insights + menu-engineering + food-cost: brez razcepa (namerna meja, ne spregled)', () => {
    // restock priporočila agregirajo po menuItemId (potrošnja zaloge = osnovni artikel)
    const ai = read('src/app/api/reports/ai-insights/route.ts')
    expect(ai).not.toContain('aggregateSalesByVariant')
    const me = read('src/app/api/menu-engineering/route.ts')
    expect(me).not.toContain('aggregateSalesByVariant')
    const fc = read('src/app/api/reports/food-cost/route.ts')
    expect(fc).not.toContain('aggregateSalesByVariant')
  })
})

/* ── Č3 — registri (verzija + oznaka slike) ───────────────────────────────── */
describe('v1.212.0 — Č3: registri', () => {
  it('verzija 1.212.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.215.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.215\.0'/)
  })

  it('oznaka slike ↔ APP_VERSION (docker-compose.yml)', () => {
    const compose = read('deploy/docker-compose.yml')
    const tag = compose.match(/image: restaurantos:([^\s"]+)/)
    expect(tag).not.toBeNull()
    expect((tag as RegExpMatchArray)[1]).toBe(APP_VERSION)
  })
})
