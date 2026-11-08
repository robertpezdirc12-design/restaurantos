import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import {
  orderItemDisplayName,
  variantOptionNamesOf,
  aggregateSalesByVariant,
} from '../src/lib/item-variants'
import {
  parseAccentColor,
  textOnAccent,
  themeForBrand,
  publicLogoPath,
  validateLogoUpload,
  type BrandThemeConfig,
} from '../src/lib/brand-themes'
import { buildKitchenTicketLines } from '../src/lib/devices/print'

/**
 * v1.281.0 — UPORABNIŠKA POTRDITEV OSS GENERACIJE (OSS-10/OSS-11/OSS-12).
 *
 * Zadnja odprta točka registrov je bila ocena OSS-10 »potrebo potrditi z
 * uporabo« (GAP-ANALIZA + vrstica v worklogu v1.278). Ta val je izmeril VSE
 * tri kandidate ŽIVO (agent-browser E2E na dev 1.281.0, demo prijava):
 *
 * OSS-10 (variante artiklov — A v1.209 + B v1.210 + C v1.212):
 *   admin CRUD (skupina »Velikost v281-preverba«, opciji 0,3/0,5 L z
 *   doplačilom +1,50 €, pripetje na Laško pivo) → POS izbira variante
 *   (obvezni dialog, sestavljeno ime, doplačilo v znesku 3,80+1,50=5,30 €)
 *   → pošiljanje v pripravo → KDS listek »Izbrane opcije: 0,5 L« (vrstica v
 *   postajnem toku — naloge Bar) → TISKAN bar listek z vrstico »+ 0,5 L« →
 *   plačilo (status paid) → razcep poročil po varianti (ista preslikava kot
 *   rute, živi podatki: osnovno 2× + varianta 1× = DVE vrstici).
 *
 * OSS-11 (teme po znamki — A v1.213 + B v1.214): kartica Teme po znamki
 *   (akcent #B91C1C + nalaganje PNG logotipa z magičnimi bajti) → javni API
 *   /api/public/menu nosi theme { accent, textOn (WCAG izpeljava), logoUrl }
 *   → gostovska površina /m ŽIVO nosi logotip + akcent (glava, aktivni čipi,
 *   CTA) → NEGATIVNI test: dashboard (delovno orodje osebja) NI tematiziran
 *   (0 akcentnih elementov, 0 logotipov — v213 pogodba »kamnito«).
 *
 * OSS-12 (tržnica/ekosistem): C (mreža partnerjev) — lokalno NE izvedljivo,
 *   poštena klasifikacija v registru, 0 kode.
 *
 * NAJDBI VALA (popravljeno):
 *   1. UX-1 (menu-modifiers-card): dialog »Pripni na artikle« ob zaprtju NI
 *      prenesel števca pripetih artiklov IN predizbora nazaj v kartico —
 *      vrstica »Pripeto artiklov: N« je ostala zastarela do ročne osvežitve
 *      strani, ponovno odprtje dialoga pa je kazalo odpete artikle kot pripete.
 *      Popravek: onOpenChange ob zaprtju sinhronizira links +
 *      linkedMenuItemIds iz živega stanja potrditvenih polj (attSet).
 *   2. i18n tipka: sl 'modifiers.variant.badge' je bil »Varijanta« (SSKJ:
 *      varianta) — ista datoteka ima že »Izberi varianto« in »Varianta —
 *      velikost/nivo«; hr »Varijanta« je PRAVILNA hrvaška oblika in ostaja.
 *
 *  · Č1 — najdbi vala (UX-1 popravek + tipka)
 *  · Č2 — OSS-10 potrditve (čisti sloj na ISTEM vhodu kot E2E + tisk)
 *  · Č3 — OSS-11 potrditve (tema: barva/kontrast/logotip/zavrnitev) + negativni
 *  · Ž · REGISTRI: verzija 1.281.0, worklog vrh Task ID, i18n 4324/4324
 *    (vrednostni popravev tipke — 0 novih ključev), 0 DDL, GAP vrstice
 */

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) NAJDBI VALA ──────────────────────────────────────────────────────

describe('v281 Č1: najdba UX-1 — števec pripetih artiklov se osveži ob zaprtju dialoga', () => {
  test('onOpenChange ob zaprtju sinhronizira links + linkedMenuItemIds v groups (prej: zastarelo do ročne osvežitve)', () => {
    const src = read('src/components/tabs/menu-modifiers-card.tsx')
    // popravek: ob zaprtju dialoga (o === false) prenesi živo stanje nazaj v kartico
    expect(src).toContain('if (!o) {')
    expect(src).toContain('const finalSet = attSet')
    expect(src).toContain('links: updated.links, linkedMenuItemIds: [...finalSet]')
    // vrstica števca še vedno bere g.links (isto stanje, ki ga popravek osveži)
    expect(src).toContain(`{t('modifiers.links.count', { n: g.links })}`)
  })

  test('toggleAttach še vedno posodablja attGroup.links iz odgovora (odjemalec strežnika ne ugiba)', () => {
    const src = read('src/components/tabs/menu-modifiers-card.tsx')
    expect(src).toContain('setAttGroup((prev) => (prev ? { ...prev, links: res.links } : prev))')
  })
})

describe('v281 Č1: najdba i18n — tipkarska napaka v SL znaki variante', () => {
  test('sl badge je »Varianta« (SSKJ; prej »Varijanta« — ista datoteka ima že »Izberi varianto«)', () => {
    expect(sl['modifiers.variant.badge']).toBe('Varianta')
  })

  test('hr badge ostaja »Varijanta« — PRAVILNA hrvaška oblika (epentetski j)', () => {
    expect(hr['modifiers.variant.badge']).toBe('Varijanta')
  })

  test('v SL slovarju ni druge pojavitve napačne oblike (samo badge je bil napačen)', () => {
    const slSrc = read('src/lib/i18n/sl.ts')
    expect(slSrc).not.toContain("'Varijanta'")
    expect(slSrc).not.toBe('') // slovar dejansko prebran
  })
})

// ── Č2) OSS-10 POTRDITVE (isti vhodi kot živi E2E vala) ─────────────────

describe('v281 Č2: OSS-10 — sestavljeno ime + razcep poročil (čisti sloj, E2E vhod)', () => {
  test('orderItemDisplayName: »Laško pivo 0,5l« + »0,5 L« → »Laško pivo 0,5l · 0,5 L«', () => {
    expect(orderItemDisplayName('Laško pivo 0,5l', ['0,5 L'])).toBe('Laško pivo 0,5l · 0,5 L')
    // brez opcij = čisto osnovno ime (nič regresije)
    expect(orderItemDisplayName('Laško pivo 0,5l', [])).toBe('Laško pivo 0,5l')
  })

  test('variantOptionNamesOf: SAMO obvezna enoizbirna skupina razcepi (prosti dodatki ne)', () => {
    expect(variantOptionNamesOf([
      { name: '0,5 L', groupRequired: true, groupMaxSelect: 1 },
      { name: 'zveča sira', groupRequired: false, groupMaxSelect: null },
    ])).toEqual(['0,5 L'])
    // neveljavna/imena brez vsebine izpadejo (fail-soft)
    expect(variantOptionNamesOf([
      { name: '', groupRequired: true, groupMaxSelect: 1 },
      { name: null, groupRequired: true, groupMaxSelect: 1 },
    ])).toEqual([])
  })

  test('aggregateSalesByVariant na ŽIVEM E2E vhodu: osnovno 2× + varianta 1× = DVE vrstici (C-del v1.212)', () => {
    // točno stanje naročil 41004 (2× pivo brez opcij) + 41005 (1× pivo · 0,5 L),
    // izmerjeno v E2E vala na dev bazi
    const out = aggregateSalesByVariant([
      { name: 'Laško pivo 0,5l', qty: 2, modifiers: [] },
      { name: 'Cviček 1dl', qty: 1, modifiers: [] },
      { name: 'Kava', qty: 1, modifiers: [] },
      { name: 'Coca-Cola 0,33l', qty: 1, modifiers: [] },
      { name: 'Laško pivo 0,5l', qty: 1, modifiers: [{ name: '0,5 L', groupRequired: true, groupMaxSelect: 1 }] },
    ])
    const beer = out.find((r) => r.name === 'Laško pivo 0,5l')
    const beerVariant = out.find((r) => r.name === 'Laško pivo 0,5l · 0,5 L')
    expect(beer?.qty).toBe(2) // osnovna vrstica NI povečana z variantno
    expect(beerVariant?.qty).toBe(1) // varianta je SVOJA vrstica
    // brez variant v podatkih je izhod enak prejšnjemu obnašanju
    expect(aggregateSalesByVariant([{ name: 'Kava', qty: 3, modifiers: [] }])).toEqual([{ name: 'Kava', qty: 3 }])
  })

  test('dashboard ruta uporablja ISTO ravno preslikavo (groupRequired/groupMaxSelect) — en vir resnice', () => {
    const src = read('src/app/api/dashboard/route.ts')
    expect(src).toContain('aggregateSalesByVariant(topItemsRaw.map((r) => ({')
    expect(src).toContain('groupRequired: m.ModifierGroup?.required')
    expect(src).toContain('groupMaxSelect: m.ModifierGroup?.maxSelect')
    expect(src).toContain('.slice(0, 5)')
  })

  test('buildKitchenTicketLines: izbrane opcije gredo na TISKAN listek (»+ 0,5 L« — E2E dokaz bar listka)', () => {
    const lines = buildKitchenTicketLines({
      orderNumber: 41005,
      tableName: 'Miza 9',
      items: [{
        name: 'Laško pivo 0,5l', qty: 1, note: null, station: 'BAR',
        allergenWarning: '', allergenCodes: [], modifiers: ['0,5 L'], seat: null,
      }],
    }, 'BAR')
    const texts = lines.map((l) => l.text)
    expect(texts).toContain('1× Laško pivo 0,5l')
    expect(texts.some((t) => t.includes('+ 0,5 L'))).toBe(true)
    // brez opcij NI vrstice (nič regresije gostote)
    const plain = buildKitchenTicketLines({
      orderNumber: 41006,
      items: [{ name: 'Kava', qty: 1, modifiers: [] }],
    }, 'KITCHEN')
    expect(plain.map((l) => l.text).some((t) => t.trim().startsWith('+'))).toBe(false)
  })

  test('KDS izris nosi vrstico opcij (kds.itemOptions — v1.237 §14, E2E: »Izbrane opcije: 0,5 L«)', () => {
    const src = read('src/app/dashboard/page.tsx')
    expect(src).toContain(`{t('kds.itemOptions')}: `)
    expect(src).toContain('const itMods = it.modifiers ?? []')
    expect(src).toContain('{itMods.join(\' · \')}')
  })
})

// ── Č3) OSS-11 POTRDITVE (tema: barva/kontrast/logotip/zavrnitev) ────────

describe('v281 Č3: OSS-11 — tema po znamki (E2E: #B91C1C + PNG logotip živo na /m)', () => {
  test('parseAccentColor normalizira #B91C1C → #b91c1c (veljavni hex #RGB/#RRGGBB)', () => {
    expect(parseAccentColor('#B91C1C')).toBe('#b91c1c')
    expect(parseAccentColor(' #B91C1C ')).toBe('#b91c1c')
    expect(parseAccentColor('#b91c1c')).toBe('#b91c1c')
    expect(parseAccentColor('rdeča')).toBeNull()
    expect(parseAccentColor('#12345')).toBeNull()
    expect(parseAccentColor('javascript:alert(1)')).toBeNull()
  })

  test('textOnAccent izpelje belo na #b91c1c (WCAG relativna svetilnost — E2E API je vrnil #ffffff)', () => {
    expect(textOnAccent('#b91c1c')).toBe('#ffffff')
    // svetla akcentna barva → črnilo
    expect(textOnAccent('#ffffff')).toBe('#000000')
  })

  test('themeForBrand: naložena datoteka PREMAGA URL + logoUploaded izpelje pot (v214 pogodba)', () => {
    // BrandThemeConfig je RAVEN zapis { [brandId]: nastavitev } (ključ = Brand.id)
    const config: BrandThemeConfig = {
      'brand-1': { accent: '#b91c1c', logoUrl: 'https://cdn.example.com/logo.png', logoUploaded: true },
    }
    const view = themeForBrand(config, 'brand-1')
    expect(view?.accent).toBe('#b91c1c')
    expect(view?.logoUrl).toBe(publicLogoPath('brand-1')) // datoteka > URL
    expect(view?.textOn).toBe('#ffffff') // izpeljan ob branju, NI shranjen
    // brez naložene datoteke velja URL
    const urlOnly = themeForBrand({
      'brand-1': { accent: '#b91c1c', logoUrl: 'https://cdn.example.com/logo.png' },
    }, 'brand-1')
    expect(urlOnly?.logoUrl).toBe('https://cdn.example.com/logo.png')
    // neznana znamka → null (fail-soft)
    expect(themeForBrand(config, 'brand-neznana')).toBeNull()
  })

  test('validateLogoUpload: PNG magični bajti sprejeti, lažna vsebina zavrnjena (B-del v1.214)', () => {
    // PNG glava (podpis + IHDR 96×48 — 30 bajtov, deljivo s 3 → base64 BREZ
    // blaženja; blaženje sredi niza NI veljaven base64) — isto obliko kot E2E
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG podpis
      0x00, 0x00, 0x00, 0x0d, // dolžina IHDR
      0x49, 0x48, 0x44, 0x52, // »IHDR«
      0x00, 0x00, 0x00, 0x60, // širina 96
      0x00, 0x00, 0x00, 0x30, // višina 48
      0x08, 0x02, 0x00, 0x00, 0x00, // bitnost/barva/kompresija/filter/interlace
      0x00, // začetek CRC
    ])
    const pngB64 = Buffer.from(pngBytes).toString('base64')
    expect(pngB64.includes('=')).toBe(false) // dogovor vnosa: brez blaženja sredi
    const ok = validateLogoUpload('image/png', pngB64)
    expect(ok.ok).toBe(true)
    // mime ni zaupan: PNG podpis pod navedenim JPEG mimestom je zavrnjen
    const lie = validateLogoUpload('image/jpeg', pngB64)
    expect(lie.ok).toBe(false)
    // SVG allowlist izven (XSS vektor) — tudi prazen zavržen
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')
    expect(validateLogoUpload('image/svg+xml', svg).ok).toBe(false)
  })

  test('NEGATIVNI (v213 pogodba): dashboard osebja NE tema — 0 teme v dashboard page', () => {
    const src = read('src/app/dashboard/page.tsx')
    expect(src).not.toContain('themeForBrand')
    expect(src).not.toContain('brand-logo/')
    expect(src).not.toContain('parseAccentColor')
  })
})

// ── Ž) REGISTRI ──────────────────────────────────────────────────────────

describe('v281 Ž: registri', () => {
  test('verzija 1.281.0 (version.ts ena resnica)', () => {
    expect(APP_VERSION).toBe('1.282.0')
  })

  test('compose oznaka sledi verziji (selfhost-check pogodba: oznaka ↔ APP_VERSION)', () => {
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.282.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.282.0-email-determinizem')
  })

  test('i18n števci 4324/4324 — vrednostni popravek tipke, 0 novih ključev (popolna pariteta)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('GAP register: OSS-10 in OSS-11 POTRJENO Z UPORABO @ v1.281.0; OSS-12 ostaja C (mreža)', () => {
    const gap = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(gap).toContain('POTRJENO Z UPORABO @ v1.281.0 (OSS-10')
    expect(gap).toContain('POTRJENO Z UPORABO @ v1.281.0 (OSS-11')
    expect(gap).toMatch(/\*\*OSS-12\*\*.*C \(mreža\)/)
  })

  test('0 DDL: shema nedotaknjena (val je potrditev + 2 popravka UI/i18n — brez modelov, brez stolpcev)', () => {
    const schema = read('prisma/schema.sqlite.prisma')
    expect(schema).not.toContain('model OssPotrditev')
    expect(read('prisma/schema.prisma')).not.toContain('model OssPotrditev')
  })
})
