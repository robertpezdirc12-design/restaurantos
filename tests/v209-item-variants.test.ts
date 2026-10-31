/**
 * v1.209.0 — OSS-10 VARIANTE ARTIKLOV (velikosti/nivoji) — 0 DDL.
 *
 * Analiza (dva raziskovalna prehoda) je pokazala REALNO vrzel, ne lažno:
 *  - model + strežniška validacija + gostovski UI (kiosk/QR/m) že znesejo
 *    obvezne enoizbirne skupine (required + maxSelect=1) — TO je varianta;
 *  - a admin CRUD za skupine/opcije NI OBSTAJAL (nič UI, nič write poti —
 *    edina ruta je bila PATCH /api/modifiers/[id] za alergene/postajo), zato
 *    »velikost« NI šla nastavit v produkciji (skupine le v testnih fiksturah);
 *  - kuhinjska štampiljka NI nosila opcij (kuhinja ne vidi »0,5 L«),
 *    kiosk košarica je pokazala surovo ime brez izbire.
 *
 * Rešitev: varianta = IZPELJANI razred obstoječe strukture (ModifierGroup
 * required=true + maxSelect=1) — 0 DDL, 0 novih odvisnosti; čisti sloj
 * item-variants.ts (0 uvozov) + admin CRUD (4 nove rute + razširjen PATCH +
 * DELETE na modifiers/[id]) + kartica Nastavitve→Meni + ožičenje prikaza
 * (kuhinjski list, kiosk košarica, mapOrderItem).
 *
 * Meje (dokumentirane v GAP): POS dashboard še brez izbire opcij (gostovski
 * tokovi pokriti), poročila še grupirajo po osnovnem imenu, modifiersJson
 * ostaja '[]' (posnetek živi v OrderItemModifier vrsticah).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isVariantGroup, orderItemDisplayName, VARIANT_NAME_MAX } from '../src/lib/item-variants'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/* ── Č1 — čisti sloj (0 uvozov) ──────────────────────────────────────────── */

describe('v1.209.0 — OSS-10 Č1: čisti sloj item-variants', () => {
  test('isVariantGroup: varianta = obvezno + NATANČNO en izbor', () => {
    expect(isVariantGroup({ required: true, maxSelect: 1 })).toBe(true)
    // prosta skupina (dodatki) — ni varianta:
    expect(isVariantGroup({ required: false, maxSelect: 1 })).toBe(false)
    expect(isVariantGroup({ required: true, maxSelect: null })).toBe(false)
    expect(isVariantGroup({ required: true, maxSelect: 3 })).toBe(false)
    expect(isVariantGroup({ required: false, maxSelect: null })).toBe(false)
  })

  test('orderItemDisplayName: »Osnova · opcije«; brez opcij = osnova NESPREMENJENA', () => {
    expect(orderItemDisplayName('Pizza Margherita', ['0,5 L'])).toBe('Pizza Margherita · 0,5 L')
    expect(orderItemDisplayName('Pivo', ['0,5 L', 'brez pena'])).toBe('Pivo · 0,5 L, brez pena')
    expect(orderItemDisplayName('Juha', [])).toBe('Juha')
    expect(orderItemDisplayName('Juha', ['   '])).toBe('Juha') // prazne opcije ven
    expect(orderItemDisplayName('Juha', null)).toBe('Juha')
    expect(orderItemDisplayName('Juha')).toBe('Juha')
    expect(orderItemDisplayName('', ['0,5 L'])).toBe('Artikel · 0,5 L') // fail-soft osnova
    expect(orderItemDisplayName('  Salata  ', ['  hrustljava  '])).toBe('Salata · hrustljava') // trim
    expect(orderItemDisplayName('Pivo', ['0,5 L', '0,5 L'])).toBe('Pivo · 0,5 L') // podvojen ven
    // neznani tipi NIKOLI ne mečejo (fail-soft kontrakt)
    expect(orderItemDisplayName(undefined, [null, 5])).toBe('Artikel')
    expect(orderItemDisplayName(null, null)).toBe('Artikel')
  })

  test('VARIANT_NAME_MAX: meja imena je diskretna konstanta (120)', () => {
    expect(VARIANT_NAME_MAX).toBe(120)
  })

  test('0 uvozov — čisti sloj ostane prenosljiv (disk preverba)', () => {
    const src = read('src/lib/item-variants.ts')
    expect(src).not.toMatch(/^import /m)
    expect(src).toContain('export function isVariantGroup')
    expect(src).toContain('export function orderItemDisplayName')
  })
})

/* ── Č2 — rute + ožičenje (disk kontrakt) ────────────────────────────────── */

describe('v1.209.0 — OSS-10 Č2: admin CRUD + ožičenje', () => {
  test('nove CRUD rute: varovalka + menu.manage + dosegg + revizija na vsaki', () => {
    const groups = read('src/app/api/modifier-groups/route.ts')
    expect(groups).toContain('export async function GET')
    expect(groups).toContain('export async function POST')
    expect(groups).toContain("requirePermission(req, 'menu.manage')")
    expect(groups).toContain('requireUserLocation')
    expect(groups).toContain('assertOrgScope')
    expect(groups).toContain("action: 'MODIFIER_GROUP_CREATED'")
    expect(groups).toContain("template === 'variant'")
    expect(groups).toContain('linkedMenuItemIds')

    const group = read('src/app/api/modifier-groups/[id]/route.ts')
    expect(group).toContain('export async function PATCH')
    expect(group).toContain('export async function DELETE')
    expect(group).toContain('guardResource')
    expect(group).toContain("action: 'MODIFIER_GROUP_UPDATED'")
    expect(group).toContain("action: 'MODIFIER_GROUP_DELETED'")
    expect(group).toContain('historyPreserved')

    const links = read('src/app/api/modifier-groups/[id]/menu-items/route.ts')
    expect(links).toContain("action === 'attach'")
    expect(links).toContain('menuItemId_modifierGroupId')
    expect(links).toContain("action: 'MODIFIER_GROUP_LINKED'")
    expect(links).toContain("action: 'MODIFIER_GROUP_UNLINKED'")
    expect(links).toContain('ne pripada lokaciji skupine')

    const mods = read('src/app/api/modifiers/route.ts')
    expect(mods).toContain('export async function POST')
    expect(mods).toContain("requirePermission(req, 'menu.manage')")
    expect(mods).toContain("action: 'MODIFIER_CREATED'")

    const mod = read('src/app/api/modifiers/[id]/route.ts')
    expect(mod).toContain('export async function DELETE')
    expect(mod).toContain("action: 'MODIFIER_UPDATED'")
    expect(mod).toContain("action: 'MODIFIER_DELETED'")
  })

  test('kuhinjski list zdaj nosi opcije (aditivno; brez opcij = byte-identično)', () => {
    const print = read('src/lib/devices/print.ts')
    expect(print).toContain('modifiers?: string[] | null')
    expect(print).toContain('`   + ${mo.trim()}`')
  })

  test('orders include + mapOrderItem + kiosk sestavljeno ime', () => {
    const ops = read('src/lib/ops.ts')
    expect(ops).toContain('OrderItemModifier: { select: { name: true } }')
    const map = read('src/lib/map.ts')
    expect(map).toContain('it.OrderItemModifier')
    const kiosk = read('src/app/kiosk/page.tsx')
    expect(kiosk).toContain('orderItemDisplayName(l.item.name')
  })

  test('UI kartica: predloga variante + razred iz čistega sloja + pripetost', () => {
    const card = read('src/components/tabs/menu-modifiers-card.tsx')
    expect(card).toContain("from '@/lib/item-variants'")
    expect(card).toContain('isVariantGroup')
    expect(card).toContain('SelectItem value="variant"')
    expect(card).toContain("'/api/modifier-groups'")
    expect(card).toContain('`/api/modifier-groups/${g.id}/menu-items`')
    const dash = read('src/app/dashboard/page.tsx')
    expect(dash).toContain("<MenuModifiersCard canManage={hasPerm('menu.manage')} />")
  })

  test('i18n: 16 novih ključev v OBAH slovarjih (SL/HR)', () => {
    const keys = [
      'modifiers.card.title', 'modifiers.card.desc', 'modifiers.group.new',
      'modifiers.group.name', 'modifiers.group.template', 'modifiers.template.free',
      'modifiers.template.variant', 'modifiers.group.required', 'modifiers.group.min',
      'modifiers.group.max', 'modifiers.option.add', 'modifiers.option.name',
      'modifiers.option.price', 'modifiers.items.attach', 'modifiers.links.count',
      'modifiers.variant.badge',
    ]
    const slRec = sl as unknown as Record<string, string>
    const hrRec = hr as unknown as Record<string, string>
    for (const k of keys) {
      expect(typeof slRec[k]).toBe('string')
      expect(typeof hrRec[k]).toBe('string')
    }
  })
})

/* ── Č3 — registri ───────────────────────────────────────────────────────── */

describe('v1.209.0 — OSS-10 Č3: registri', () => {
  test('verzija 1.212.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.212.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.212\.0'/)
  })

  test('0 DDL — varianta je IZPELJANA, ne shranjena (shema nespremenjena)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).toContain('model ModifierGroup')
    expect(schema).toContain('required')
    expect(schema).toContain('maxSelect')
    // dokaz 0 DDL: v shemi NE obstaja nobeno 'variant' polje/model — razred
    // izračuna isVariantGroup iz obstoječih stolpcev (required + maxSelect).
    expect(schema.toLowerCase()).not.toContain('variant')
  })

  test('GAP OSS-10: IZVEDENO @ v1.209.0 z dokazi + poštene meje', () => {
    const doc = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(doc).toContain('IZVEDENO @ v1.209.0')
    expect(doc).toContain('isVariantGroup')
    expect(doc).toContain('orderItemDisplayName')
    expect(doc).toContain('0 DDL')
    // v1.210.0 (B-del): vrzel »POS dashboard še brez izbire opcij« je ZAPRTA —
    // pin s sledenjem nameni (prej: dokumentiral mejo; zdaj: dokumentiral zaprtje)
    expect(doc).toContain('B-DEL IZVEDENO @ v1.210.0')
  })

  test('i18n pariteta: 3709 → 3712 ključev v OBIH jezikih', () => {
    expect(Object.keys(sl).length).toBe(3712)
    expect(Object.keys(hr).length).toBe(3712)
  })

  test('oznaka slike ↔ APP_VERSION (selfhost kontrakt ostane pinežen)', () => {
    const compose = read('deploy/docker-compose.yml')
    expect(compose).toContain(`restaurantos:${APP_VERSION}`)
  })
})
