/**
 * ISSUE #74 (v1.135.0) — V-3 KDS pet razredov starosti + V-7 preslikava slik kategorij.
 *
 * Pure units, NO db fixtures — pokriva:
 *  - src/lib/kds-delays.ts (V-3): kdsAgeClass pet stopenj (fresh/ok/warn/urgent/late),
 *    normalizeKdsAgeThresholds (fail-closed + monotonost), kdsLateThreshold
 *    (nastavitev ali postajni cilj — kar je višje), pill/border CSS razredi
 *    (stranski rob ZA celovitim — tw-merge lekcija iz v1.131.0);
 *  - src/lib/category-images.ts (V-7): categoryImageForCategory preslikava
 *    (vrstni red specifične→splošne, delni zadetki, fallback default).
 */
import { describe, expect, test } from 'bun:test'
import {
  KDS_AGE_DEFAULTS,
  kdsAgeClass,
  normalizeKdsAgeThresholds,
  kdsLateThreshold,
  kdsAgePillCls,
  kdsAgeBorderCls,
  type KdsAgeThresholds,
} from '../src/lib/kds-delays'
import {
  CATEGORY_IMAGE_RULES,
  CATEGORY_IMAGE_DEFAULT,
  categoryImageForCategory,
} from '../src/lib/category-images'

/* ─────────── V-3: pet razredov starosti ─────────── */

describe('issue74 V-3: kdsAgeClass — pet stopenj (siva→emerald→amber→utrip→rdeča)', () => {
  test('privzete prage: <10 fresh, 10–15 ok, 15–20 warn, 20–25 urgent, ≥25 late', () => {
    expect(kdsAgeClass(0)).toBe('fresh')
    expect(kdsAgeClass(9)).toBe('fresh')
    expect(kdsAgeClass(10)).toBe('ok')
    expect(kdsAgeClass(14)).toBe('ok')
    expect(kdsAgeClass(15)).toBe('warn')
    expect(kdsAgeClass(19)).toBe('warn')
    expect(kdsAgeClass(20)).toBe('urgent') // 25 − 5 (utrip okno)
    expect(kdsAgeClass(24)).toBe('urgent')
    expect(kdsAgeClass(25)).toBe('late')
    expect(kdsAgeClass(423)).toBe('late')
  })

  test('merjena napaka 1.132.0: 67 in 423 min NISTA več isti barvi', () => {
    // s privzetimi pragovi je 67 min 'late' — a že razred 'ok' (10 min) pomeni,
    // da se barva SPREMENI med 67 (late) in 423 (late) ne ločuje več po pillu
    // — ključna razlika je bila prej: enak rdeč pill za 5 min in za 423 min.
    expect(kdsAgeClass(5)).not.toBe(kdsAgeClass(423))
    expect(kdsAgeClass(5)).toBe('fresh')
    expect(kdsAgeClass(423)).toBe('late')
  })

  test('ne-številčna/negativna starost → fresh (brez podatka = ni alarm)', () => {
    expect(kdsAgeClass(NaN)).toBe('fresh')
    expect(kdsAgeClass(-1)).toBe('fresh')
    expect(kdsAgeClass(-Infinity)).toBe('fresh')
  })

  test('nastavljivi pragovi: višji prag zamakne rdečo', () => {
    const th: KdsAgeThresholds = { warn: 20, urgent: 30, late: 45 }
    expect(kdsAgeClass(15, undefined, th)).toBe('fresh')
    expect(kdsAgeClass(25, undefined, th)).toBe('ok')
    expect(kdsAgeClass(35, undefined, th)).toBe('warn')
    expect(kdsAgeClass(40, undefined, th)).toBe('urgent') // 45 − 5
    expect(kdsAgeClass(45, undefined, th)).toBe('late')
  })

  test('postajni cilj lahko prag samo DVIGNE (max(25, ceil(30×1.25)))', () => {
    // cilj 30 min → prag max(25, 38) = 38: 26 min je še warn/urgent, ne rdeče
    expect(kdsLateThreshold(30)).toBe(38)
    expect(kdsAgeClass(26, 30)).toBe('warn') // < 38 − 5 = 33
    expect(kdsAgeClass(33, 30)).toBe('urgent') // 38 − 5
    expect(kdsAgeClass(38, 30)).toBe('late')
    // cilj 4 min → prag ostane globalni (25), ne 5
    expect(kdsLateThreshold(4)).toBe(KDS_AGE_DEFAULTS.late)
    expect(kdsAgeClass(26, 4)).toBe('late')
  })
})

describe('issue74 V-3: normalizeKdsAgeThresholds — fail-closed', () => {
  test('veljavne vrednosti preidejo', () => {
    expect(normalizeKdsAgeThresholds({ warn: 12, urgent: 18, late: 40 })).toEqual({ warn: 12, urgent: 18, late: 40 })
  })
  test('neveljaven vnos → privzete vrednosti', () => {
    expect(normalizeKdsAgeThresholds(null)).toEqual(KDS_AGE_DEFAULTS)
    expect(normalizeKdsAgeThresholds(' garbage ')).toEqual(KDS_AGE_DEFAULTS)
    expect(normalizeKdsAgeThresholds({ warn: -5, urgent: 18, late: 40 })).toEqual(KDS_AGE_DEFAULTS)
    expect(normalizeKdsAgeThresholds({ warn: 9999, urgent: 18, late: 40 })).toEqual(KDS_AGE_DEFAULTS)
  })
  test('nemonotonost (šala) → privzete vrednosti', () => {
    expect(normalizeKdsAgeThresholds({ warn: 30, urgent: 20, late: 10 })).toEqual(KDS_AGE_DEFAULTS)
    expect(normalizeKdsAgeThresholds({ warn: 10, urgent: 10, late: 40 })).toEqual(KDS_AGE_DEFAULTS)
  })
})

describe('issue74 V-3: CSS razredi — vrstni red tw-merge (celovit PRED stranskim)', () => {
  test('pill razredi so parljivi za vsak razred', () => {
    for (const cls of ['fresh', 'ok', 'warn', 'urgent', 'late'] as const) {
      const pill = kdsAgePillCls(cls)
      const border = kdsAgeBorderCls(cls)
      expect(pill).toContain('bg-')
      expect(border).toMatch(/^border-stone-200 border-l-/)
      // celoviti border-{barva} mora priti PRED border-l-{barva}, sicer ga
      // tailwind-merge odstrani (lekcija v1.131.0: hrošč tihega izgleda).
      // fresh ima nevtralni levi rob (-200), ostali barvni (-500).
      const side = cls === 'fresh' ? '-200' : '-500'
      const m = border.match(new RegExp(`^border-stone-200 border-l-(stone|emerald|amber|orange|red)${side}( |$)`))
      expect(m).not.toBeNull()
    }
  })
  test('urgent ima animate-pulse (oranžni utrip — Lightspeed delay blink)', () => {
    expect(kdsAgePillCls('urgent')).toContain('animate-pulse')
    expect(kdsAgePillCls('warn')).not.toContain('animate-pulse')
    expect(kdsAgePillCls('late')).not.toContain('animate-pulse')
  })
})

/* ─────────── V-7: preslikava slik kategorij ─────────── */

describe('issue74 V-7: categoryImageForCategory', () => {
  test('specifične pred splošnimi (kava pred pijačami)', () => {
    expect(categoryImageForCategory('Kava in espresso')).toBe('/img/cat/coffee.jpg')
    expect(categoryImageForCategory('Brezalkoholne pijače')).toBe('/img/cat/soft-drinks.jpg')
  })
  test('delni zadetki po vrstnem redu pravil', () => {
    expect(categoryImageForCategory('Lokalna vina')).toBe('/img/cat/wine.jpg')
    expect(categoryImageForCategory('Penine')).toBe('/img/cat/wine.jpg')
    expect(categoryImageForCategory('Tople juhe')).toBe('/img/cat/soup-salad.jpg')
    expect(categoryImageForCategory('Glavne jedi')).toBe('/img/cat/main.jpg')
    expect(categoryImageForCategory('Sladice')).toBe('/img/cat/desserts.jpg')
    expect(categoryImageForCategory('Predjedi in prigrizki')).toBe('/img/cat/starters.jpg')
  })
  test('hrvaška imena (diakritiki) zadenejo ista pravila', () => {
    expect(categoryImageForCategory('Bezalkoholna pića')).toBe('/img/cat/soft-drinks.jpg')
    expect(categoryImageForCategory('Glavna jela')).toBe('/img/cat/main.jpg')
  })
  test('brez zadetka → default (nikoli prazna pot)', () => {
    expect(categoryImageForCategory('Sushi')).toBe(CATEGORY_IMAGE_DEFAULT)
    expect(categoryImageForCategory('')).toBe(CATEGORY_IMAGE_DEFAULT)
    expect(categoryImageForCategory(null)).toBe(CATEGORY_IMAGE_DEFAULT)
    expect(categoryImageForCategory(undefined)).toBe(CATEGORY_IMAGE_DEFAULT)
  })
  test('vsa pravila kažejo na obstoječe datoteke v public/img/cat', () => {
    expect(CATEGORY_IMAGE_RULES.length).toBeGreaterThanOrEqual(9)
    for (const rule of CATEGORY_IMAGE_RULES) {
      expect(rule.img).toMatch(/^\/img\/cat\/[a-z-]+\.jpg$/)
      expect(rule.keys.length).toBeGreaterThan(0)
    }
  })
})
