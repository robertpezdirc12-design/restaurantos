/**
 * v1.213.0 — OSS-11 A-del: TEME PO ZNAMKI (akcentna barva + logotip per Brand).
 *
 * Kontekst: GAP OSS-11 je nosil oznako »B (oblikovna odločitev)« — ta val sledi
 * dokazanemu vzorcu N-27-3 (noge doplačil): KONFIGURACIJA pretvori oblikovno
 * odločitev v UPORABNIŠKI VHOD. Lastnik v Enterprise zavihku izbere barvo/URL
 * per znamka; sistem ju deterministično validira in uporabi na gostovskih
 * površinah. Brez nastavljene teme = izgled nespremenjen (aditivni ključ).
 *
 * Kontrakt:
 *  - barva = SAMO hex (#RGB/#RRGGBB) — nič CSS vstavljanja, nič imen barv;
 *  - črnilo na akcentu = IZPELJANO ob branju (WCAG 2.x svetilnost) — v configu
 *    NI shranjen (ena resnica o barvi, izpeljava čista funkcija);
 *  - logotip = SAMO https URL (max 500) — nalaganje datotek ostaja ločena izdaja;
 *  - shranjevanje ZERO DDL: Integration(name='brand-themes', type='other') —
 *    isti vzorec kot kiosk-upsell;
 *  - obseg admin rute = znamke LASTNE organizacije (bootstrap break-glass);
 *    uporabnik brez organizacijske verige = fail-closed 403 (prazna validna
 *    množica bi sicer tiho POBRISALA config tujih znamk);
 *  - javne rute (menu/web-portal/pay/reservations) = aditivni ključ `theme`
 *    (absent = odgovor byte-identičen);
 *  - gostovske površine ×5 (m/kiosk/s/pay/r) uporabijo temo VSE POGOJNO.
 *
 * Merila:
 *  Č1 čisti sloj (PURE, 0 baze): parseAccentColor, textOnAccent, sanitizeLogoUrl,
 *     sanitizeBrandThemeConfig, themeForBrand + dokaz 0 uvozov.
 *  Č2 disk kontrakt: admin ruta (obseg + fail-closed + revizija), strežniški
 *     sloj, 4 javne rute, 5 gostovskih strani, BrandLogo, Enterprise kartica,
 *     i18n (SL/HR pariteta ent.theme*), GAP dokaz, negativne trditve meja.
 *  Č3 registri: verzija 1.213.0 (toBe + ubežen regex), oznaka slike ↔ APP_VERSION.
 *
 * 0 fikstur baze — sweep ni potreben (demo podatki nedotaknjeni).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND_THEMES_MARKER,
  BRAND_THEME_MAX,
  LOGO_URL_MAX,
  parseAccentColor,
  textOnAccent,
  sanitizeLogoUrl,
  sanitizeBrandThemeConfig,
  themeForBrand,
  type BrandThemeConfig,
} from '../src/lib/brand-themes'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/* ── Č1 — čisti sloj: barva, črnilo, URL, config, pogled ──────────────────── */
describe('v1.213.0 — Č1: parseAccentColor (SAMO hex — nič CSS vstavljanja)', () => {
  it('veljavni hex: #RRGGBB in #RGB, normalizacija na male črke', () => {
    expect(parseAccentColor('#1c1917')).toBe('#1c1917')
    expect(parseAccentColor('#1C1917')).toBe('#1c1917')
    expect(parseAccentColor('#ABC')).toBe('#aabbcc')
    expect(parseAccentColor('#abc')).toBe('#aabbcc')
    expect(parseAccentColor(' #00FF00 ')).toBe('#00ff00')
  })

  it('zavrnjeni vhodi: brez #, napačne dolžine, ne-hex znaki, imena, funkcije, ne-nizi', () => {
    expect(parseAccentColor('1c1917')).toBeNull()
    expect(parseAccentColor('#12345')).toBeNull()
    expect(parseAccentColor('#1234567')).toBeNull()
    expect(parseAccentColor('#GGGGGG')).toBeNull()
    expect(parseAccentColor('red')).toBeNull()
    expect(parseAccentColor('rgb(28,25,23)')).toBeNull()
    expect(parseAccentColor('hsl(0,0%,0%)')).toBeNull()
    expect(parseAccentColor('#abg')).toBeNull()
    expect(parseAccentColor('')).toBeNull()
    expect(parseAccentColor(null)).toBeNull()
    expect(parseAccentColor(undefined)).toBeNull()
    expect(parseAccentColor(42)).toBeNull()
    expect(parseAccentColor({})).toBeNull()
    expect(parseAccentColor(['#abc'])).toBeNull()
  })

  it('vstavljanje ni možno: hex z alternativnimi znaki zavrnjen', () => {
    // poskus z CSS-injection oblikami — vse morajo pasti (deterministično)
    expect(parseAccentColor('#abc; } body { display:none }')).toBeNull()
    expect(parseAccentColor('  #abc  ')).toBe('#aabbcc') // trim je nameren (isti vzorec kot ostala polja)
    expect(parseAccentColor('#abc/*')).toBeNull()
  })
})

describe('v1.213.0 — Č1: textOnAccent (WCAG 2.x, determinističen izbor)', () => {
  it('svetli akcent → temno črnilo, temni akcent → svetlo črnilo', () => {
    expect(textOnAccent('#ffffff')).toBe('#000000')
    expect(textOnAccent('#f5f5f4')).toBe('#000000') // stone-100
    expect(textOnAccent('#000000')).toBe('#ffffff')
    expect(textOnAccent('#1c1917')).toBe('#ffffff') // stone-900 (privzeti POS ton)
    expect(textOnAccent('#b91c1c')).toBe('#ffffff') // temno rdeča (kontrast na belo ~6.5)
    expect(textOnAccent('#16a34a')).toBe('#000000') // zelena 600 — svetilnost ~0.27: črno črnilo (7.0) premaga belo (3.3)
    expect(textOnAccent('#fbbf24')).toBe('#000000') // jantarna (svetla)
  })

  it('srednja sivina → temno črnilo; neveljaven vhod → fail-soft #000000', () => {
    expect(textOnAccent('#808080')).toBe('#000000')
    expect(textOnAccent('ni-barva')).toBe('#000000')
    expect(textOnAccent('')).toBe('#000000')
  })

  it('izenačeni primer (popolnoma srednja sivina #808080) = ISTI rezultat na vsakem klicu', () => {
    const a = textOnAccent('#808080')
    const b = textOnAccent('#808080')
    expect(a).toBe(b)
    expect(['#000000', '#ffffff']).toContain(a)
  })
})

describe('v1.213.0 — Č1: sanitizeLogoUrl (SAMO https)', () => {
  it('veljaven https URL ohranjen (trim)', () => {
    expect(sanitizeLogoUrl('https://zna.mka/logo.png')).toBe('https://zna.mka/logo.png')
    expect(sanitizeLogoUrl('  https://zna.mka/logo.png  ')).toBe('https://zna.mka/logo.png')
  })

  it('zavrnjeni: http, data:, javascript:, presledki, predolg, ne-niz', () => {
    expect(sanitizeLogoUrl('http://zna.mka/logo.png')).toBeNull()
    expect(sanitizeLogoUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(sanitizeLogoUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeLogoUrl('https://zna.mka/log o.png')).toBeNull()
    expect(sanitizeLogoUrl(`https://zna.mka/${'a'.repeat(LOGO_URL_MAX)}`)).toBeNull()
    expect(sanitizeLogoUrl('')).toBeNull()
    expect(sanitizeLogoUrl(null)).toBeNull()
    expect(sanitizeLogoUrl(123)).toBeNull()
  })
})

describe('v1.213.0 — Č1: sanitizeBrandThemeConfig (neznane znamke ven, fail-soft)', () => {
  const ids = new Set(['b1', 'b2'])

  it('neznani brandId odvržen; veljaven vnos ohranjen (logo opcionalen)', () => {
    const out = sanitizeBrandThemeConfig(
      { b1: { accent: '#ABC' }, tuja: { accent: '#000000' } },
      ids,
    )
    expect(Object.keys(out)).toEqual(['b1'])
    expect(out.b1.accent).toBe('#aabbcc')
    expect(out.b1.logoUrl).toBeUndefined()
  })

  it('neveljaven accent → vnos odvržen; neveljaven logo → ključ logo izpuščen (vnos OSTANE)', () => {
    const out = sanitizeBrandThemeConfig(
      { b1: { accent: 'rdeča' }, b2: { accent: '#123456', logoUrl: 'http://x.y/z.png' } },
      ids,
    )
    expect(Object.keys(out)).toEqual(['b2'])
    expect(out.b2.logoUrl).toBeUndefined()
  })

  it('validBrandIds = null → obstojnost NE preverja, vrednosti VSEENO (javno branje)', () => {
    const out = sanitizeBrandThemeConfig({ b1: { accent: '#abc' }, x: { accent: 'ne' } }, null)
    expect(Object.keys(out)).toEqual(['b1'])
  })

  it('ne-objektni vhodi → {}; cap BRAND_THEME_MAX; vrstni red po prvem pojavu', () => {
    expect(sanitizeBrandThemeConfig(null, ids)).toEqual({})
    expect(sanitizeBrandThemeConfig('ne', ids)).toEqual({})
    expect(sanitizeBrandThemeConfig([], ids)).toEqual({})
    expect(sanitizeBrandThemeConfig({ b1: 'ne-objekt' }, ids)).toEqual({})
    const big: Record<string, { accent: string }> = {}
    for (let i = 0; i < BRAND_THEME_MAX + 10; i++) big[`k${i}`] = { accent: '#112233' }
    const capped = sanitizeBrandThemeConfig(big, null)
    expect(Object.keys(capped).length).toBe(BRAND_THEME_MAX)
    expect(Object.keys(capped)[0]).toBe('k0')
  })
})

describe('v1.213.0 — Č1: themeForBrand (textOn izpeljan, sveža kopija)', () => {
  const config: BrandThemeConfig = {
    b1: { accent: '#1c1917', logoUrl: 'https://zna.mka/l.png' },
    b2: { accent: '#abc' },
  }

  it('pogled nosi accent + textOn + logo; brez logo = null', () => {
    const v = themeForBrand(config, 'b1')
    expect(v).toEqual({ accent: '#1c1917', textOn: '#ffffff', logoUrl: 'https://zna.mka/l.png' })
    const v2 = themeForBrand(config, 'b2')
    // #aabbcc ima svetilnost ~0.48 → črno črnilo (kontrast 10.7 premaga 2.0 na belo)
    expect(v2).toEqual({ accent: '#aabbcc', textOn: '#000000', logoUrl: null })
  })

  it('manjkajoča/neveljavna znamka → null; prazen brandId → null', () => {
    expect(themeForBrand(config, 'ni-ga')).toBeNull()
    expect(themeForBrand(config, null)).toBeNull()
    expect(themeForBrand(config, undefined)).toBeNull()
    expect(themeForBrand(config, '')).toBeNull()
    expect(themeForBrand({}, 'b1')).toBeNull()
  })

  it('mutacija pogleda NE pokvari configa (sveža kopija)', () => {
    const v = themeForBrand(config, 'b1')!
    v.accent = '#000000'
    expect(config.b1.accent).toBe('#1c1917')
  })

  it('marker Integration vrstice + konstante', () => {
    expect(BRAND_THEMES_MARKER).toBe('brand-themes')
    expect(BRAND_THEME_MAX).toBeGreaterThan(0)
    expect(LOGO_URL_MAX).toBe(500)
  })
})

describe('v1.213.0 — Č1: čisti sloj ostaja 0 uvozov', () => {
  it('brand-themes.ts brez import stavkov', () => {
    const src = read('src/lib/brand-themes.ts')
    expect(src).not.toMatch(/(^|\n)\s*import /)
    expect(src).not.toMatch(/require\(/)
  })
})

/* ── Č2 — disk kontrakt: rute, strani, i18n, dokumentacija ────────────────── */
describe('v1.213.0 — Č2: admin ruta /api/brand-themes (obseg + fail-closed + revizija)', () => {
  const route = () => read('src/app/api/brand-themes/route.ts')

  it('settings.manage na OBEH metodah + revizija BRAND_THEME_UPDATED', () => {
    const src = route()
    expect(src.match(/requirePermission\(req, 'settings\.manage'\)/g)?.length).toBe(2)
    expect(src).toContain("action: 'BRAND_THEME_UPDATED'")
    expect(src).toContain("where: { name: BRAND_THEMES_MARKER, type: 'other' }")
  })

  it('fail-closed: uporabnik brez organizacijske verige NE sme brati niti pisati', () => {
    const src = route()
    expect(src.match(/ni vezan v organizacijsko drevo/g)?.length).toBe(2)
    expect(src).toContain('isBootstrapAdmin')
    expect(src).toContain('chainForLocation')
  })

  it('sanitizacija proti ŽIVIM brand id-jem obsega (PUT ne zaupa klientu)', () => {
    const src = route()
    expect(src).toContain('sanitizeBrandThemeConfig(body.config, ids)')
    expect(src).toContain("db.brand.findMany")
  })
})

describe('v1.213.0 — Č2: javne rute — aditivni ključ theme (absent = byte-identično)', () => {
  it('strežniški sloj: brandThemeForLocation gre po verigi do znamke', () => {
    const src = read('src/lib/brand-themes-server.ts')
    expect(src).toContain('chainForLocation')
    expect(src).toContain('themeForBrand')
    expect(src).toContain('export async function brandThemeForLocation')
  })

  it('vse štiri javne rute vstavijo theme SAMO pogojno', () => {
    // enoten pogojni vzorec: spread na kraju (menu/web-portal/pay) ali ovit celoten
    // payload (reservations — payload prihaja iz pomožnika publicSlotsPayload)
    const spread = '...(theme ? { theme } : {})'
    const wrapped = 'ok(theme ? { ...payload, theme } : payload)'
    const expectations: Array<[string, string]> = [
      ['src/app/api/public/menu/route.ts', spread],
      ['src/app/api/public/web-portal/route.ts', spread],
      ['src/app/api/public/pay/[token]/route.ts', spread],
      ['src/app/api/public/reservations/route.ts', wrapped],
    ]
    for (const [p, needle] of expectations) {
      const src = read(p)
      expect(src, p).toContain('brandThemeForLocation')
      expect(src, p).toContain(needle)
    }
  })
})

describe('v1.213.0 — Č2: gostovske površine ×5 (pogojna uporaba + logotip)', () => {
  it('m/kiosk/s/pay/r nosijoBrandThemeView + pogojni acc', () => {
    const m = read('src/app/m/[token]/page.tsx')
    expect(m).toContain('theme = menu?.theme ?? null')
    expect(m).toContain('BrandLogo')
    expect(m).toContain('style={activeCat === c.id ? acc : undefined}')

    const kiosk = read('src/app/kiosk/page.tsx')
    expect(kiosk).toContain('theme = menu?.theme ?? null')
    expect(kiosk).toContain('BrandLogo')

    const s = read('src/app/s/[token]/page.tsx')
    expect(s).toContain('theme = store?.theme ?? null')
    expect(s).toContain('BrandLogo')

    const pay = read('src/app/pay/[token]/page.tsx')
    expect(pay).toContain('theme = state?.theme ?? null')
    expect(pay).toContain('BrandLogo')

    const r = read('src/app/r/[token]/page.tsx')
    expect(r).toContain('theme = state?.theme ?? null')
    expect(r).toContain('BrandLogo')
  })

  it('BrandLogo: onError skrije pokvarjen URL, alt prazen (ime je sosednje besedilo)', () => {
    const src = read('src/components/brand-logo.tsx')
    expect(src).toContain('onError')
    expect(src).toContain('alt=""')
    expect(src).toContain("aria-hidden=\"true\"")
  })

  it('preglednica si razreda barve NE izmišljuje — črnilo pride iz čistega sloja', () => {
    const src = read('src/components/tabs/enterprise-tab.tsx')
    expect(src).toContain("from '@/lib/brand-themes'")
    expect(src).toContain('parseAccentColor')
    expect(src).toContain('textOnAccent')
    expect(src).toContain("'/api/brand-themes'")
    expect(src).toContain('BrandThemesSection')
  })
})

describe('v1.213.0 — Č2: i18n (SL/HR pariteta ent.theme*)', () => {
  const KEYS = [
    'ent.themeTitle',
    'ent.themeDesc',
    'ent.themeAccent',
    'ent.themeLogo',
    'ent.themeNoBrands',
    'ent.themeSaved',
    'ent.themeNone',
    'ent.themeBadHex',
    'ent.themeRemove',
  ]

  it('vseh 9 ključev v OBIH slovarjih, SL/HR vzporedno', () => {
    for (const k of KEYS) {
      expect(typeof (sl as Record<string, string>)[k], `sl:${k}`).toBe('string')
      expect(typeof (hr as Record<string, string>)[k], `hr:${k}`).toBe('string')
      expect(((sl as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
      expect(((hr as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
    }
  })
  it('3712 → 3721 ključev (9 novih v obeh jezikih)', () => {
    expect(Object.keys(sl).length).toBe(3721)
    expect(Object.keys(hr).length).toBe(3721)
  })
})

describe('v1.213.0 — Č2: dokumentacija + poštene meje (negativne trditve)', () => {
  it('GAP OSS-11 nosi A-DEL dokaz + izrecne meje', () => {
    const gap = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(gap).toContain('**A-DEL IZVEDENO @ v1.213.0**')
    expect(gap).toContain('textOnAccent')
    expect(gap).toContain('DEJANSKE barve/logotipi = lastnikov vnos v UI')
  })

  it('MEJA: dashboard/POS osebja NE spreminjata barve (delovno orodje kamnito)', () => {
    expect(read('src/components/dashboard-tabs.tsx')).not.toContain('brand-themes')
    expect(read('src/components/dashboard-nav.tsx')).not.toContain('brand-themes')
  })

  it('MEJA: samo ena barva per znamka (ni palet/temnih načinov v sloju)', () => {
    const src = read('src/lib/brand-themes.ts')
    expect(src).not.toContain('palette')
    expect(src).not.toContain('darkMode')
  })
})

/* ── Č3 — registri (verzija + oznaka slike) ───────────────────────────────── */
describe('v1.213.0 — Č3: registri', () => {
  it('verzija 1.213.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.213.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.213\.0'/)
  })

  it('oznaka slike ↔ APP_VERSION (docker-compose.yml)', () => {
    const compose = read('deploy/docker-compose.yml')
    const tag = compose.match(/image: restaurantos:([^\s"]+)/)
    expect(tag).not.toBeNull()
    expect((tag as RegExpMatchArray)[1]).toBe(APP_VERSION)
  })
})
