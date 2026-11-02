/**
 * ISSUE #74 (v1.135.0) — V-3 KDS pet razredov starosti.
 * V-7 (preslikava slik kategorij) je bila v v1.234.0 ODSTRANJENA po lastnikovi
 * odločitvi: vse ploščice ene kategorije so kazale isto sliko, ki ni odražala
 * artikla (produkcija: 16 ploščic »Glavne jedi« = ista klobasa). Square/Toast
 * načelo: fotografija je per-artikel podatek ali je ni — nikoli ugibanje iz
 * kategorije. Ploščice so zdaj besedilne z barvnim robom kategorije.
 *
 * Pure units, NO db fixtures — pokriva:
 *  - src/lib/kds-delays.ts (V-3): kdsAgeClass pet stopenj (fresh/ok/warn/urgent/late),
 *    normalizeKdsAgeThresholds (fail-closed + monotonost), kdsLateThreshold
 *    (nastavitev ali postajni cilj — kar je višje), pill/border CSS razredi
 *    (stranski rob ZA celovitim — tw-merge lekcija iz v1.131.0).
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

/* ─────────── v1.234.0: slike kategorij ODSTRANJENE ─────────── */

describe('v1.234.0 — POS ploščice brez fotografij (Square/Toast načelo)', () => {
  test('src/lib/category-images.ts NE obstaja več (preslikava kategorija→slika zbrisana)', async () => {
    const { existsSync } = await import('node:fs')
    expect(existsSync('src/lib/category-images.ts')).toBe(false)
    expect(existsSync('public/img/cat')).toBe(false)
  })
  test('dashboard in handheld NE vsebujeta <img> na ploščicah artiklov', async () => {
    const { readFileSync } = await import('node:fs')
    const dash = readFileSync('src/app/dashboard/page.tsx', 'utf8')
    const hh = readFileSync('src/app/handheld/page.tsx', 'utf8')
    // nobena ploščica artikla ne sme več nositi <img> (fotografija = per-artikel
    // podatek; dokler ni v bazi, je ploščica besedilna z barvnim robom)
    expect(dash).not.toContain('categoryImageForCategory')
    expect(hh).not.toContain('categoryImageForCategory')
    expect(dash).not.toContain('/img/cat/')
    expect(hh).not.toContain('/img/cat/')
    // obe ploščici ohranjata barvni rob kategorije (orientacija brez laži)
    expect(dash).toContain('saleCatBorderCls(catKey)')
    expect(hh).toContain('saleCatBorderCls(mi.categoryId || mi.name)')
  })
})
