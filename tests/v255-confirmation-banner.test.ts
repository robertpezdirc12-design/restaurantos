/**
 * v1.255.0 — CONFIRMATION BANNER (docs/PRIMERJAVA-VMESNIKOV-2026 §29;
 * Lightspeed »What's New in Lightspeed Restaurant« hub, november 2026:
 * »Order view confirmation banner« — »The order view now has a confirmation
 * banner at the top of the screen when a task is complete. Every discount
 * added, sequence completed or course fired will be clear so staff can
 * manage their shifts with confidence.«).
 *
 * Merjena situacija (izmere 5. 11. 2026): pet dejanj v NaročiloSheetu in
 * plačilnem dialogu je uspelo TIHO — pošiljanje dodatka (sendSheetItems),
 * streljanje vseh pending postavk (fireSheetAll), streljanje tečaja
 * (fireCourse), dodelitev h tečaju (assignCourse), ročni popust pod pragom
 * (applyManualDiscount, direktna pot). Napake toastajo, uspeh NE.
 *
 *  A · ČISTI SLOJ (confirm-banner): builderji petih vrst + defenzivna
 *    normalizacija (count ≥ 0 celo, zneski r2, imena trim + kap 60,
 *    številka tečaja ≥ 1) + i18n preslikava (ključ, parametri, detail da/ne).
 *  B · MONTAŽA (page.tsx + komponenta): banner na vrhu obeh pogledov
 *    (data-region confirm-banner-sheet | confirm-banner-payment), vsako od
 *    petih dejanj postavi banner po strežniškem uspehu, čiščenje ob zaprtju,
 *    role=status + aria-live=polite + avto-odpad 6 s + gumb 44 px, 0 DDL.
 *
 * Predpona fiksatur ni potrebna (čisti sloj + registri — brez DB).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CONFIRM_BANNER_MS,
  addItemsBanner,
  bannerDetailParams,
  bannerTitleKey,
  courseAssignBanner,
  discountBanner,
  fireAllBanner,
  fireCourseBanner,
  hasBannerDetail,
} from '../src/lib/confirm-banner'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── A) ČISTI SLOJ ──

describe('v1.255.0 A1 — fireAllBanner: streljanje vseh pending postavk', () => {
  test('A1a: count se ščipne na celo ≥ 0', () => {
    expect(fireAllBanner(3).count).toBe(3)
    expect(fireAllBanner(2.9).count).toBe(2) // floor — pol postavke ne gre v kuhinjo
    expect(fireAllBanner(-5).count).toBe(0) // negativno → 0 (ne laže)
    expect(fireAllBanner(NaN).count).toBe(0)
    expect(fireAllBanner('4').count).toBe(4) // striskaeverza iz JSON odgovora
  })

  test('A1b: vrsta + čas potrditve vedno definirana', () => {
    const b = fireAllBanner(0)
    expect(b.kind).toBe('fire-all')
    expect(b.at).toBeGreaterThan(0)
    // N=0 je iskrena informacija (idempotentna prijaznost fire rute)
    expect(hasBannerDetail(b)).toBe(true)
    expect(bannerDetailParams(b)).toEqual({ n: 0 })
  })
})

describe('v1.255.0 A2 — fireCourseBanner: streljanje posameznega tečaja', () => {
  test('A2a: številka ≥ 1 + ime trim; oba podatka v bannerju', () => {
    const b = fireCourseBanner(2, '  Glavne jedi  ')
    expect(b.kind).toBe('fire-course')
    expect(b.courseNumber).toBe(2)
    expect(b.courseName).toBe('Glavne jedi')
    expect(hasBannerDetail(b)).toBe(true)
    expect(bannerDetailParams(b)).toEqual({ n: 2, name: 'Glavne jedi' })
  })

  test('A2b: defenzivno — številka 0/NaN izpuščena, ime prazno izpuščeno', () => {
    expect(fireCourseBanner(0, 'Tek').courseNumber).toBeUndefined()
    expect(fireCourseBanner(NaN, 'Tek').courseNumber).toBeUndefined()
    expect(fireCourseBanner(1, '   ').courseName).toBeUndefined()
    expect(fireCourseBanner(-1, '').courseName).toBeUndefined()
  })

  test('A2c: brez številke IN imena → gol banner brez detaila (ne lažljiva ničla)', () => {
    const b = fireCourseBanner(undefined, null)
    expect(b.kind).toBe('fire-course')
    expect(b.courseNumber).toBeUndefined()
    expect(b.courseName).toBeUndefined()
    expect(hasBannerDetail(b)).toBe(false)
  })

  test('A2d: dolgo ime se kapne na 60 z iskrenim tropičjem', () => {
    const b = fireCourseBanner(1, 'x'.repeat(80))
    expect(b.courseName!.length).toBeLessThanOrEqual(60)
    expect(b.courseName!.endsWith('…')).toBe(true)
  })
})

describe('v1.255.0 A3 — courseAssignBanner: dodelitev postavke h tečaju', () => {
  test('A3a: obstoječi tečaj ponese številko in ime', () => {
    const b = courseAssignBanner(3, 'Sladice')
    expect(b.kind).toBe('course-assign')
    expect(bannerDetailParams(b)).toEqual({ n: 3, name: 'Sladice' })
  })

  test('A3b: nov tečaj brez znanega imena → samo številka; smeti → gol naslov', () => {
    expect(courseAssignBanner(4, '').courseName).toBeUndefined()
    expect(courseAssignBanner(4, undefined).hasOwnProperty('courseName')).toBe(false)
    const bare = courseAssignBanner(NaN, '  ')
    expect(hasBannerDetail(bare)).toBe(false)
  })
})

describe('v1.255.0 A4 — addItemsBanner: dodatek obstoječemu naročilu', () => {
  test('A4a: število novih vrstic (navadne + variantne) v bannerju', () => {
    const b = addItemsBanner(2)
    expect(b.kind).toBe('add-items')
    expect(b.count).toBe(2)
    expect(bannerDetailParams(b)).toEqual({ n: 2 })
    expect(addItemsBanner(1.5).count).toBe(1)
    expect(addItemsBanner(-2).count).toBe(0)
  })
})

describe('v1.255.0 A5 — discountBanner: ročni popust pod pragom', () => {
  test('A5a: ime + znesek r2; znesek v parametrih s PRIVZETO vejico (SI/HR)', () => {
    const b = discountBanner('Zvestostni 10 %', 2.4)
    expect(b.kind).toBe('discount')
    expect(b.discountName).toBe('Zvestostni 10 %')
    expect(b.amount).toBe(2.4)
    expect(bannerDetailParams(b)).toEqual({ name: 'Zvestostni 10 %', amount: '2,40' })
  })

  test('A5b: defenzivno — negativen/NaN znesek → 0 in IZPUŠČEN; 0 ne laže', () => {
    expect(discountBanner('X', -3).amount).toBeUndefined() // 0 → izpuščen
    expect(discountBanner('X', NaN).amount).toBeUndefined()
    expect(discountBanner('X', 1.005).amount).toBe(1) // r2 banker's rounding na cent
    expect(discountBanner('X', 0).amount).toBeUndefined()
    expect(hasBannerDetail(discountBanner('X', 0))).toBe(true) // ime nosi detail samo
  })

  test('A5c: brez imena in zneska → gol naslov (popust brez identitete je še vedno potrjen)', () => {
    const b = discountBanner(undefined, 0)
    expect(b.kind).toBe('discount')
    expect(hasBannerDetail(b)).toBe(false)
  })
})

describe('v1.255.0 B — i18n preslikava + avto-odpad', () => {
  test('B1: bannerTitleKey preslika vse pet vrst na cb.* ključe', () => {
    expect(bannerTitleKey(fireAllBanner(1))).toBe('cb.fire-all')
    expect(bannerTitleKey(fireCourseBanner(1, 'A'))).toBe('cb.fire-course')
    expect(bannerTitleKey(courseAssignBanner(1, 'A'))).toBe('cb.course-assign')
    expect(bannerTitleKey(addItemsBanner(1))).toBe('cb.add-items')
    expect(bannerTitleKey(discountBanner('A', 1))).toBe('cb.discount')
  })

  test('B2: avto-odpad je 6 s (6000 ms) — dovolj za dve vrstici, ne zadržuje pogleda', () => {
    expect(CONFIRM_BANNER_MS).toBe(6000)
  })

  test('B3: znesek v detail parametrih vedno formatiran z vejico (2,40 ne 2.40)', () => {
    expect(bannerDetailParams(discountBanner('X', 3)).amount).toBe('3,00')
    expect(bannerDetailParams(discountBanner('X', 12.345)).amount).toBe('12,35')
  })
})

// ── Ž) REGISTRI + MONTAŽA ──

describe('v1.255.0 Ž — registri', () => {
  const pageSrc = read('src/app/dashboard/page.tsx')
  const compSrc = read('src/components/confirm-banner.tsx')
  const libSrc = read('src/lib/confirm-banner.ts')

  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.263.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.263.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.263.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+11 cb.*)', () => {
    for (const k of [
      'cb.fire-all', 'cb.fire-allDetail', 'cb.fire-course', 'cb.fire-courseDetail',
      'cb.course-assign', 'cb.course-assignDetail', 'cb.add-items', 'cb.add-itemsDetail',
      'cb.discount', 'cb.discountDetail', 'cb.dismiss',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4125)
    expect(hrCount).toBe(4125)
  })

  test('Ž3: montaža — pet dejanj postavi banner + oba pogleda ga izrišeta + 0 DDL dokaz', () => {
    // PET doslej TIHIH uspehov zdaj postavi banner PO strežniškem odgovoru
    expect(pageSrc).toContain('setSheetBanner(addItemsBanner(items.length))')
    expect(pageSrc).toContain('setSheetBanner(fireAllBanner(d.firedCount))')
    expect(pageSrc).toContain('setSheetBanner(fireCourseBanner(course?.courseNumber, course?.name))')
    expect(pageSrc.match(/setSheetBanner\(courseAssignBanner\(/g)?.length).toBe(2) // novi + obstoječi tečaj
    expect(pageSrc).toContain('setPayBanner(discountBanner(d.name, b.bill.manualDiscount))')
    // banner na VRHU obeh pogledov z lastnim data-region (ločljivo v E2E)
    expect(pageSrc).toContain('region="confirm-banner-sheet"')
    expect(pageSrc).toContain('region="confirm-banner-payment"')
    // čiščenje: zaprtje sheet/plačila počisti; nov plačilni pogled začne čist
    expect(pageSrc).toContain('setSheetBanner(null) } }')
    expect(pageSrc.match(/setPayBanner\(null\)/g)?.length).toBe(3) // openPayment + onOpenChange + (komentar ne šteje — dva koda)
    // komponenta: dostopnost + avto-odpad + 44 px zapiralni gumb
    expect(compSrc).toContain('role="status"')
    expect(compSrc).toContain('aria-live="polite"')
    expect(compSrc).toContain('CONFIRM_BANNER_MS')
    expect(compSrc).toContain('h-11 w-11')
    expect(compSrc).toContain("t('cb.dismiss')")
    // banner je ČISTI povratni odziv — lib brez db/prisma uvozov; schema brez novih modelov
    expect(libSrc).not.toContain("from '@/lib/db'")
    expect(libSrc).not.toContain('prisma')
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('ConfirmBanner')
  })

  test('Ž4: dokumenta — PRIMERJAVA §29 + AUDIT POSODOBITEV + števec', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 29.')
    expect(doc).toContain('Order view confirmation banner')
    expect(doc).toContain('manage their shifts with confidence')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.256.0')
    expect(auditDoc).toContain('- 4125 ključev SL in 4125 HR')
  })

  test('Ž5: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.263.0-skritje-nicelnih-postavk-val')
  })
})
