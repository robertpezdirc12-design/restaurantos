/**
 * v1.214.0 — OSS-11 B-del: NALAGANJE LOGOTIPA KOT DATOTEKE.
 *
 * Kontekst: meja A-dela (v1.213.0) je izrecno imenovala to izdajo —
 * »logotip je URL (nalaganje datotek = ločena izdaja po OSS-2 vzorcu)«.
 * Lastnik v Enterprise zavihku NALOŽI datoteko (PNG/JPEG/WebP/GIF, ≤ 512 kB);
 * sistem bajte validira (allowlist + MAGIC-BYTE preverjanje — mime ni zaupan,
 * ampak preverjen), shrani v bazo (ZERO DDL — Integration vrstica
 * 'brand-logos') in gostovskim površinam streže prek javne rute z nosniff +
 * ETag/304 + ponovnim preverjanjem bajtov (obramba v globino).
 *
 * Kontrakt:
 *  - NALOŽENA DATOTEKA PREMAGA URL (deterministična prednostnost — zastavica
 *    logoUploaded v LAHKI vrstici 'brand-themes'; odstranitev vrne URL);
 *  - vrstica teme ostane LAHKA: javne rute bajtov NE berejo (samo zastavica);
 *  - logotip se prikaže SAMO z akcentno barvo (tema = barva + logotip kot
 *    celota — v213 pogodba; brez barve POST odgovori themeActive: false);
 *  - ZERO DDL: shema ne pozna modela BrandLogo (vrednost, ne model);
 *  - PUT tem zdaj ZLIIJE vnose (popravek realne napake: admin org B je doslej
 *    s shranitvijo tiho pobrisal teme org A — vrstica je globalna, obseg ne);
 *  - obseg = znamke LASTNE organizacije (fail-closed 403 brez verige, 403
 *    izven obsega — isti razlog kot v213).
 *
 * Merila:
 *  Č1 čisti sloj (PURE, 0 baze): validateLogoUpload matrika (magic bytes,
 *     neujemanja, base64 vrata, budget, data: strip), detectImageMime,
 *     sanitizeBrandLogoConfig (fail-soft), logoStoreTotalBytes, zastavica
 *     logoUploaded v sanitize/themeForBrand (prednostnost nad URL), publicLogoPath.
 *  Č2 disk kontrakt: admin rute (POST/DELETE + merge PUT + normalizacija),
 *     javna ruta bajtov (nosniff/ETag/304/ponovno preverjanje), UI kartica,
 *     gostovske površine NEspremenjene (negativno), i18n pariteta, GAP dokaz.
 *  Č3 registri: verzija 1.215.0 (toBe + ubežen regex), oznaka slike ↔
 *     APP_VERSION, AUDIT §8 števec 3731.
 *
 * 0 fikstur baze — sweep ni potreben (demo podatki nedotaknjeni).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND_LOGOS_MARKER,
  BRAND_LOGO_MAX,
  MAX_LOGO_BYTES,
  MAX_LOGO_STORE_BYTES,
  LOGO_MIME_ALLOWLIST,
  validateLogoUpload,
  detectImageMime,
  sanitizeBrandLogoConfig,
  sanitizeBrandThemeConfig,
  logoStoreTotalBytes,
  logoBase64SizeBytes,
  publicLogoPath,
  themeForBrand,
  type BrandThemeConfig,
  type BrandLogoConfig,
} from '../src/lib/brand-themes'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/** base64 iz seznama bajtov (magic-byte vektorji — brez zunanjih datotek). */
function b64of(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0, 0, 0, 0, 0, 0]
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]
/** pravi 1×1 PNG (najmanjša veljavna datoteka) */
const REAL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/* ── Č1 — čisti sloj: preverjanje vsebine datoteke ──────────────────────── */
describe('v1.214.0 — Č1: detectImageMime (magic bytes, deterministično)', () => {
  it('prepozna vse štiri dovoljene vrste', () => {
    expect(detectImageMime(new Uint8Array(PNG))).toBe('image/png')
    expect(detectImageMime(new Uint8Array(JPG))).toBe('image/jpeg')
    expect(detectImageMime(new Uint8Array(GIF87))).toBe('image/gif')
    expect(detectImageMime(new Uint8Array(GIF89))).toBe('image/gif')
    expect(detectImageMime(new Uint8Array(WEBP))).toBe('image/webp')
  })

  it('neznano/krajše/prazno → null (fail-closed, ne ugiba)', () => {
    expect(detectImageMime(new Uint8Array([...'<html><body>']))).toBeNull()
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull() // < 12 bajtov
    expect(detectImageMime(new Uint8Array([]))).toBeNull()
    // SVG tekst ne more biti prepoznan (ni na listi, bajti se ne ujemajo z ničemer)
    expect(detectImageMime(new Uint8Array([...'<?xml versio']))).toBeNull()
    // napačen odmik WEBP (RIFF brez WEBP na 8.)
    expect(detectImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x51]))).toBeNull()
  })
})

describe('v1.214.0 — Č1: validateLogoUpload (mime PREVERJEN, ne zaupan)', () => {
  it('veljavni PNG → kanonični mime + čist base64 + poštena velikost', () => {
    const r = validateLogoUpload('image/png', b64of(PNG))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mime).toBe('image/png')
      expect(r.value.sizeBytes).toBe(12)
      expect(r.value.data).toBe(b64of(PNG))
    }
  })

  it('pravi 1×1 PNG + data: URL predpona (FileReader izhod) → odrezana', () => {
    const r = validateLogoUpload('image/png', `data:image/png;base64,${REAL_PNG_B64}`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.data).toBe(REAL_PNG_B64)
      expect(r.value.sizeBytes).toBeGreaterThan(60)
      expect(r.value.sizeBytes).toBeLessThan(100)
    }
  })

  it('NEUJEMANJE mime ↔ vsebina → zavrnjeno (lažna datoteka ne gre skozi)', () => {
    const r = validateLogoUpload('image/jpeg', b64of(PNG))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ne ustreza vsebini')
    const r2 = validateLogoUpload('image/webp', REAL_PNG_B64)
    expect(r2.ok).toBe(false)
  })

  it('vrsta izven allowliste (SVG/PDF/HTML) → zavrnjena pred dekodiranjem', () => {
    for (const bad of ['image/svg+xml', 'text/html', 'application/pdf', 'image/bmp', '']) {
      const r = validateLogoUpload(bad, b64of(PNG))
      expect(r.ok, `mime=${bad}`).toBe(false)
      if (!r.ok) expect(r.error).toContain('ni dovoljena')
    }
  })

  it('HTML vsebina s PNG oznako → zavrnjena (vonjava ne prepozna slike)', () => {
    const r = validateLogoUpload('image/png', b64of([...'<html><body>']))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ni prepoznana kot slika')
  })

  it('base64 vrata: alphabet, %4, prazno, presledki, ne-nizi', () => {
    expect(validateLogoUpload('image/png', '').ok).toBe(false)
    expect(validateLogoUpload('image/png', 'not@base64!').ok).toBe(false)
    expect(validateLogoUpload('image/png', 'AAAAA').ok).toBe(false) // %4 != 0
    expect(validateLogoUpload('image/png', ' AAAAAA').ok).toBe(false)
    expect(validateLogoUpload('image/png', null).ok).toBe(false)
    expect(validateLogoUpload(null, b64of(PNG)).ok).toBe(false)
  })

  it('budget: 0 bajtov in nad 512 kB → zavrnjeno (velikost iz dolžine, brez dekodiranja)', () => {
    expect(validateLogoUpload('image/png', '====').ok).toBe(false) // velikost 0
    // 513 kB raw ≈ 684.000 base64 znakov (samo 'A' — zavrnjeno PRED dekodiranjem)
    const big = 'A'.repeat(684_000)
    const r = validateLogoUpload('image/png', big)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('presega')
    // točno meja: 512.000 raw = 682.667 znakov (zaokroženo na %4) → gremo čez sniff (A* ni PNG) → zavrnjeno z 'ni prepoznana', NE z 'presega'
    const edge = 'A'.repeat(Math.floor(MAX_LOGO_BYTES * 4 / 3 / 4) * 4)
    expect(logoBase64SizeBytes(edge)).toBeLessThanOrEqual(MAX_LOGO_BYTES)
    const r2 = validateLogoUpload('image/png', edge)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).not.toContain('presega')
  })
})

describe('v1.214.0 — Č1: sanitizeBrandLogoConfig + logoStoreTotalBytes (fail-soft branje)', () => {
  const ids = new Set(['b1', 'b2'])

  it('veljaven vnos ohranjen; neveljaven mime/base64/velikost → odvržen', () => {
    const out = sanitizeBrandLogoConfig(
      { b1: { mime: 'image/png', data: b64of(PNG) }, b2: { mime: 'image/svg+xml', data: b64of(PNG) } },
      ids,
    )
    expect(Object.keys(out)).toEqual(['b1'])
    expect(out.b1.mime).toBe('image/png')
  })

  it('neznani brandId odvržen (null = brez obstojnostne poizvedbe, vrednosti VSEENO validirane)', () => {
    const out = sanitizeBrandLogoConfig({ b1: { mime: 'image/png', data: b64of(PNG) }, tuja: { mime: 'image/png', data: b64of(PNG) } }, ids)
    expect(Object.keys(out)).toEqual(['b1'])
    const out2 = sanitizeBrandLogoConfig({ tuja: { mime: 'image/png', data: 'ni-baza' } }, null)
    expect(Object.keys(out2)).toEqual([])
  })

  it('ne-objektni vhodi → {}; cap BRAND_LOGO_MAX; vrstni red po prvem pojavu', () => {
    expect(sanitizeBrandLogoConfig(null, ids)).toEqual({})
    expect(sanitizeBrandLogoConfig('ne', ids)).toEqual({})
    expect(sanitizeBrandLogoConfig([], ids)).toEqual({})
    expect(sanitizeBrandLogoConfig({ b1: 'ne-objekt' }, ids)).toEqual({})
    const big: Record<string, { mime: string; data: string }> = {}
    for (let i = 0; i < BRAND_LOGO_MAX + 10; i++) big[`k${i}`] = { mime: 'image/png', data: b64of(PNG) }
    const capped = sanitizeBrandLogoConfig(big, null)
    expect(Object.keys(capped).length).toBe(BRAND_LOGO_MAX)
    expect(Object.keys(capped)[0]).toBe('k0')
  })

  it('velikost nad budgetom na VNOSU → odvržen pri branju (ročno pokvarjena vrstica)', () => {
    const huge = 'A'.repeat(700_000) // > 512 kB raw, čist base64
    const out = sanitizeBrandLogoConfig({ b1: { mime: 'image/png', data: huge } }, null)
    expect(Object.keys(out)).toEqual([])
  })

  it('logoStoreTotalBytes sešteva raw velikosti (izračun iz dolžin)', () => {
    const store: BrandLogoConfig = {
      a: { mime: 'image/png', data: b64of(PNG) },
      b: { mime: 'image/png', data: b64of(JPG) },
    }
    expect(logoStoreTotalBytes(store)).toBe(24)
    expect(logoStoreTotalBytes({})).toBe(0)
    expect(MAX_LOGO_STORE_BYTES).toBeGreaterThan(MAX_LOGO_BYTES)
  })

  it('marker + konstante', () => {
    expect(BRAND_LOGOS_MARKER).toBe('brand-logos')
    expect(LOGO_MIME_ALLOWLIST).not.toContain('image/svg+xml')
    expect(LOGO_MIME_ALLOWLIST).toContain('image/webp')
    expect(MAX_LOGO_BYTES).toBe(512_000)
  })
})

/* ── Č1 — čisti sloj: zastavica logoUploaded + prednostnost datoteke ─────── */
describe('v1.214.0 — Č1: sanitizeBrandThemeConfig ohrani zastavico logoUploaded (SAMO true)', () => {
  it('logoUploaded === true ohranjen; false/1/„da"/null izpuščeni', () => {
    const out = sanitizeBrandThemeConfig(
      {
        b1: { accent: '#123456', logoUploaded: true },
        b2: { accent: '#123456', logoUploaded: false },
        b3: { accent: '#123456', logoUploaded: 'da' },
        b4: { accent: '#123456', logoUploaded: 1 },
        b5: { accent: '#123456' },
      },
      null,
    )
    expect(out.b1.logoUploaded).toBe(true)
    expect(out.b2.logoUploaded).toBeUndefined()
    expect(out.b3.logoUploaded).toBeUndefined()
    expect(out.b4.logoUploaded).toBeUndefined()
    expect(out.b5.logoUploaded).toBeUndefined()
  })
})

describe('v1.214.0 — Č1: themeForBrand — NALOŽENA DATOTEKA PREMAGA URL', () => {
  it('logoUploaded → logoUrl = javna pot bajtov (ignore URL)', () => {
    const config: BrandThemeConfig = { b1: { accent: '#1c1917', logoUrl: 'https://zna.mka/l.png', logoUploaded: true } }
    const v = themeForBrand(config, 'b1')
    expect(v).toEqual({ accent: '#1c1917', textOn: '#ffffff', logoUrl: '/api/public/brand-logo/b1' })
  })

  it('brez zastavice → sanitiziran https URL (v213 obnašanje nespremenjeno)', () => {
    const config: BrandThemeConfig = { b1: { accent: '#1c1917', logoUrl: 'https://zna.mka/l.png' } }
    expect(themeForBrand(config, 'b1')?.logoUrl).toBe('https://zna.mka/l.png')
    const config2: BrandThemeConfig = { b2: { accent: '#1c1917', logoUrl: 'http://ne-varno' } }
    expect(themeForBrand(config2, 'b2')?.logoUrl).toBeNull()
  })

  it('samo zastavica brez URL-ja → pot bajtov (logo brez URL-ja je legitimna izbira)', () => {
    const config: BrandThemeConfig = { b1: { accent: '#ABC', logoUploaded: true } }
    expect(themeForBrand(config, 'b1')?.logoUrl).toBe('/api/public/brand-logo/b1')
  })
})

describe('v1.214.0 — Č1: publicLogoPath (encodeURIComponent)', () => {
  it('preprost id + id s posebnimi znaki', () => {
    expect(publicLogoPath('b1')).toBe('/api/public/brand-logo/b1')
    expect(publicLogoPath('a/b c')).toBe('/api/public/brand-logo/a%2Fb%20c')
    expect(publicLogoPath('že-š')).toBe('/api/public/brand-logo/%C5%BEe-%C5%A1')
  })
})

describe('v1.214.0 — Č1: čisti sloj ostaja 0 uvozov', () => {
  it('brand-themes.ts brez import stavkov', () => {
    const src = read('src/lib/brand-themes.ts')
    expect(src).not.toMatch(/(^|\n)\s*import /)
    expect(src).not.toMatch(/require\(/)
  })
})

/* ── Č2 — disk kontrakt: rute, strežniški sloj, UI, meje ────────────────── */
describe('v1.214.0 — Č2: admin ruta /api/brand-themes/logo (POST + DELETE)', () => {
  const route = () => read('src/app/api/brand-themes/logo/route.ts')

  it('settings.manage na OBEH metodah + reviziji BRAND_LOGO_UPDATED/REMOVED', () => {
    const src = route()
    expect(src.match(/requirePermission\(req, 'settings\.manage'\)/g)?.length).toBe(2)
    expect(src).toContain("action: 'BRAND_LOGO_UPDATED'")
    expect(src).toContain("action: 'BRAND_LOGO_REMOVED'")
  })

  it('fail-closed ×2 (brez verige) + znamka izven obsega → 403 (izrecno)', () => {
    const src = route()
    expect(src.match(/ni vezan v organizacijsko drevo/g)?.length).toBe(2)
    expect(src.match(/Znamka ni v obsegu vaše organizacije\.'/g)?.length).toBe(2)
    expect(src).toContain('scopedBrandIds')
  })

  it('validacija IZ čistega sloja (strežnik ne izmišljuje svojih pravil) + vratarja', () => {
    const src = route()
    expect(src).toContain('validateLogoUpload(body?.mimeType, body?.contentBase64)')
    expect(src).toContain('MAX_LOGO_STORE_BYTES')
    expect(src).toContain('BRAND_LOGO_MAX')
    // read-modify-write: vnosi ostalih znamk se OHRANIJO
    expect(src).toContain('delete store[brandId]')
    expect(src).toContain('store[brandId] = { mime, data }')
  })

  it('zastavica v vrstici tem + themeActive pošteno sporoča nedejavjen logotip', () => {
    const src = route()
    expect(src).toContain('setThemeLogoFlag(brandId, true)')
    expect(src).toContain('setThemeLogoFlag(brandId, false)')
    expect(src).toContain('themeActive')
  })
})

describe('v1.214.0 — Č2: PUT tem ZLIIJE vnose (popravek med-organskega brisanja)', () => {
  const route = () => read('src/app/api/brand-themes/route.ts')

  it('GET nosi aditivni logos (metapodatki BREZ base64 — seznam lahek)', () => {
    const src = route()
    expect(src).toContain('const logos: Record<string, { mimeType: string; sizeBytes: number }>')
    expect(src).toContain('return ok({ config, logos })')
    expect(src).not.toContain('logos[brandId] = { mimeType: rec.mime, data')
  })

  it('PUT: obstoječi vnosi IZVEN obsega se ohranijo (merge, ne replace)', () => {
    const src = route()
    expect(src).toContain('if (!ids.has(brandId)) merged[brandId] = setting')
    expect(src).toContain('sanitizeBrandThemeConfig(body.config, ids)')
  })

  it('PUT: normalizacija zastavice iz DEJANSKE prisotnosti bajtov', () => {
    const src = route()
    expect(src).toContain('if (store[brandId]) merged[brandId] = { ...setting, logoUploaded: true }')
  })
})

describe('v1.214.0 — Č2: javna ruta bajtov /api/public/brand-logo/[brandId]', () => {
  const route = () => read('src/app/api/public/brand-logo/[brandId]/route.ts')

  it('glava: nosniff + ETag/304 + cache + Content-Length; brez Content-Disposition', () => {
    const src = route()
    expect(src).toContain("'X-Content-Type-Options': 'nosniff'")
    expect(src).toContain('ETag')
    expect(src).toContain('if-none-match')
    expect(src).toContain('status: 304')
    expect(src).toContain("'Cache-Control': 'public, max-age=300, must-revalidate'")
    expect(src).toContain("'Content-Length'")
    // citirana oblika headerja se pojavi SAMO v kodi nastavljanja — komentar
    // dokumentira odločitev, negativna trditev pa preverja DELO
    expect(src).not.toContain("'Content-Disposition':")
  })

  it('obramba v globino: bajti se PONOVNO preverijo (sniff iz čistega sloja)', () => {
    const src = route()
    expect(src).toContain('brandLogoBytesForBrand')
    expect(read('src/lib/brand-themes-server.ts')).toContain('if (!sniffed || sniffed !== rec.mime) return null')
  })

  it('rate limit 60/min/IP (enako kot javni meni) + 404 fail', () => {
    const src = route()
    expect(src).toContain("rateLimitPublic(`brandlogo:${clientIp(req)}`, 60)")
    expect(src).toContain("'Logotip ni na voljo.', 404")
  })
})

describe('v1.214.0 — Č2: UI kartica (nalaganje + odstranitev + predogled)', () => {
  it('Enterprise zavihek: file input z allowlist + POST/DELETE žici + BrandLogo predogled', () => {
    const src = read('src/components/tabs/enterprise-tab.tsx')
    expect(src).toContain('type="file"')
    expect(src).toContain('LOGO_MIME_ALLOWLIST.join(\',\')')
    expect(src).toContain("'/api/brand-themes/logo'")
    expect(src).toContain('uploadLogo(b.id, f)')
    expect(src).toContain('removeLogo(b.id)')
    expect(src).toContain('publicLogoPath(b.id)')
    expect(src).toContain('MAX_LOGO_BYTES')
    expect(src).toContain('ent.logoNeedsAccent')
  })

  it('bralna vrata: strežnik je avtoriteta — UI samo predpreveri', () => {
    const src = read('src/components/tabs/enterprise-tab.tsx')
    expect(src).toContain("toast({ title: t('ent.logoBadType'), variant: 'destructive' })")
    expect(src).toContain("toast({ title: t('ent.logoTooLarge'), variant: 'destructive' })")
  })
})

describe('v1.214.0 — Č2: gostovske površine NEspremenjene (0 diff na straneh)', () => {
  it('m/kiosk/s/pay/r še vedno rišejo theme.logoUrl prek BrandLogo — brez novih poti', () => {
    for (const p of [
      'src/app/m/[token]/page.tsx',
      'src/app/kiosk/page.tsx',
      'src/app/s/[token]/page.tsx',
      'src/app/pay/[token]/page.tsx',
      'src/app/r/[token]/page.tsx',
    ]) {
      const src = read(p)
      expect(src, p).toContain('BrandLogo')
      expect(src, p).not.toContain('brand-logo/') // strani NE gradijo poti same — pot pride iz teme
      expect(src, p).not.toContain('brand-themes/logo') // noben direkten klic admin rute iz gostovske strani
    }
  })

  it('javne rute menu/web-portal/pay/reservations NE berejo težke shrambe bajtov', () => {
    for (const p of [
      'src/app/api/public/menu/route.ts',
      'src/app/api/public/web-portal/route.ts',
      'src/app/api/public/pay/[token]/route.ts',
      'src/app/api/public/reservations/route.ts',
    ]) {
      const src = read(p)
      expect(src, p).toContain('brandThemeForLocation')
      expect(src, p).not.toContain('BRAND_LOGOS_MARKER')
      expect(src, p).not.toContain('loadBrandLogoConfig')
    }
  })

  it('MEJA: dashboard/POS/display/label ostajajo kamniti (negativno)', () => {
    expect(read('src/components/dashboard-tabs.tsx')).not.toContain('brand-themes')
    expect(read('src/components/dashboard-nav.tsx')).not.toContain('brand-themes')
    expect(read('src/app/display/page.tsx')).not.toContain('BrandLogo')
    expect(read('src/app/label/[token]/page.tsx')).not.toContain('BrandLogo')
  })
})

describe('v1.214.0 — Č2: i18n (SL/HR pariteta ent.logo*)', () => {
  const KEYS = [
    'ent.logoUpload',
    'ent.logoReplace',
    'ent.logoRemove',
    'ent.logoUploaded',
    'ent.logoRemoved',
    'ent.logoFile',
    'ent.logoHint',
    'ent.logoBadType',
    'ent.logoTooLarge',
    'ent.logoNeedsAccent',
  ]

  it('vseh 10 ključev v OBEH slovarjih, vzporedno', () => {
    for (const k of KEYS) {
      expect(typeof (sl as Record<string, string>)[k], `sl:${k}`).toBe('string')
      expect(typeof (hr as Record<string, string>)[k], `hr:${k}`).toBe('string')
      expect(((sl as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
      expect(((hr as Record<string, string>)[k] || '').length).toBeGreaterThan(0)
    }
  })

  it('3721 → 3731 ključev (10 novih v1.214.0 v obeh jezikih)', () => {
    expect(Object.keys(sl).length).toBe(3731)
    expect(Object.keys(hr).length).toBe(3731)
  })
})

describe('v1.214.0 — Č2: dokumentacija + 0 DDL dokaz', () => {
  it('GAP OSS-11 nosi B-DEL dokaz + izrecne meje', () => {
    const gap = read('docs/GAP-ANALIZA-odprtokodna-konkurenca.md')
    expect(gap).toContain('**B-DEL IZVEDENO @ v1.214.0**')
    expect(gap).toContain('validateLogoUpload')
    expect(gap).toContain('NALOŽENA DATOTEKA PREMAGA URL')
    expect(gap).toContain('DEJANSKE barve/logotipi = lastnikov vnos v UI')
  })

  it('0 DDL: shema ne pozna modela BrandLogo (Integration vrstica, ne tabela)', () => {
    const schema = read('prisma/schema.sqlite.prisma') + read('prisma/schema.prisma')
    expect(schema).not.toContain('model BrandLogo')
    expect(schema).not.toContain('brand_logos')
  })

  it('OSS-5 disciplina: javna ruta je DOKUMENTIRANA v OpenAPI spec + vpisana v register javnih rut', () => {
    expect(read('src/lib/openapi-spec.ts')).toContain("'/api/public/brand-logo/{brandId}'")
    expect(read('src/lib/openapi-spec.ts')).toContain('branding')
    expect(read('tests/route-coverage.test.ts')).toContain("path: '/api/public/brand-logo/[brandId]'")
    // v201 pin števca handlerjev nosi novo resnico (19 → 20)
    expect(read('tests/v201-openapi.test.ts')).toContain('expect(checked).toBe(20)')
  })
})

/* ── Č3 — registri (verzija + oznaka slike + AUDIT števec) ──────────────── */
describe('v1.214.0 — Č3: registri', () => {
  it('verzija 1.215.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.215.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.215\.0'/)
  })

  it('oznaka slike ↔ APP_VERSION (docker-compose.yml)', () => {
    const compose = read('deploy/docker-compose.yml')
    const tag = compose.match(/image: restaurantos:([^\s"]+)/)
    expect(tag).not.toBeNull()
    expect((tag as RegExpMatchArray)[1]).toBe(APP_VERSION)
  })

  it('AUDIT §8: števec 3731 + POSODOBITEV nota', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('3731 ključev SL in 3731 HR')
    expect(audit).toContain('**POSODOBITEV (v1.214.0):** dodani ključi `ent.logo*` (10 ključev')
  })
})
