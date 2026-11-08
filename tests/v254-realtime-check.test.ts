/**
 * v1.254.0 — REAL-TIME CHECK VIEW (docs/PRIMERJAVA-VMESNIKOV-2026 §28;
 * Square oktober 2026 »Edit items with the check in view« — ZAMUJENA
 * postavka Vol 15: §27 je ocenil pet od šestih oktobrskih kvadratov,
 * »Real-Time Check View« pa je ostala neocenjena (rg brez zadetkov v
 * PRIMERJAVI in worklogu — preverjeno 4. 11. 2026).
 *
 * Merjena situacija: vsi štirje urejevalni dialogi POS (izbira variante
 * OSS-10, opomba vrstice §22 B, sprememba cene §23, preklic postavke
 * Issue #5) so max-w-sm modali, ki račun PREKRIJEJO — osebje ureja
 * »na slepo«, račun se posodobi šele po Potrdi.
 *
 *  A · ČISTI SLOJ (live-check): model vrstic + defenzivna normalizacija
 *    (qty ≥ 0 celo, cene r2 ≥ 0, note trim, kap 30 z iskrenim »… in še
 *    N«, prečrtane IZPUŠČENE iz skupaj) + preslikave treh košaric +
 *    obstoječih postavk naročila + živi predogledi (pending varianta,
 *    note/cena/preklic patch, parse vnosa cene).
 *  B · MONTAŽA (page.tsx + komponenta): štirje dialogi dobijo LiveCheckAside
 *    zraven urejevalca (sm:grid-cols-2, mobilno plošča nad urejevalcem),
 *    vrstice košaric so TAPLJIVE (odprejo opombo — Square »A tap on a
 *    check item opens its details«), 0 DDL.
 *
 * Predpona fiksatur ni potrebna (čisti sloj + registri — brez DB).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  LIVE_CHECK_EMPTY,
  MAX_LIVE_CHECK_LINES,
  buildLiveCheck,
  cartPreviewLines,
  orderPreviewLines,
  parsePriceInput,
  variantPendingLine,
  withLineUpdate,
  type LiveCheckLine,
} from '../src/lib/live-check'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── A) ČISTI SLOJ ──

describe('v1.254.0 A1 — buildLiveCheck: defenzivna normalizacija', () => {
  test('A1a: qty se ščipne na celo ≥ 0, cena na r2 ≥ 0, opomba se trimma', () => {
    const m = buildLiveCheck([
      { key: 'a', name: 'Pivo', qty: 2.7, unitPrice: 3.333 },
      { key: 'b', name: 'Pizza', qty: -4, unitPrice: -1 },
      { key: 'c', name: 'Juha', qty: 1, unitPrice: 4.005, note: '  brez ledu  ' },
    ])
    const a = m.lines.find((l) => l.key === 'a')!
    expect(a.qty).toBe(3) // Math.round(2.7)
    expect(a.unitPrice).toBe(3.33) // r2
    const b = m.lines.find((l) => l.key === 'b')!
    expect(b.qty).toBe(0) // negativno → 0 (ne laže o količini)
    expect(b.unitPrice).toBe(0)
    const c = m.lines.find((l) => l.key === 'c')!
    expect(c.note).toBe('brez ledu')
  })

  test('A1b: smeti → null (brez ključa/imena); števke/objekti ignorirani', () => {
    const m = buildLiveCheck([
      null,
      undefined,
      42,
      'x',
      {},
      { key: '', name: 'X', qty: 1, unitPrice: 1 },
      { key: 'ok', name: 'Y', qty: 1, unitPrice: 2 },
    ] as unknown[])
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0].key).toBe('ok')
  })

  test('A1c: podvojen ključ — PRVI zmaga (vrstica je enolična)', () => {
    const m = buildLiveCheck([
      { key: 'a', name: 'Prvi', qty: 1, unitPrice: 5 },
      { key: 'a', name: 'Drugi', qty: 9, unitPrice: 9 },
    ])
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0].name).toBe('Prvi')
  })

  test('A1d: null/undefined/ne-tabela → prazen model (LIVE_CHECK_EMPTY discipline)', () => {
    expect(buildLiveCheck(null)).toEqual({ lines: [], total: 0, more: 0 })
    expect(buildLiveCheck(undefined)).toEqual({ lines: [], total: 0, more: 0 })
    expect(LIVE_CHECK_EMPTY.lines).toHaveLength(0)
    expect(LIVE_CHECK_EMPTY.total).toBe(0)
  })
})

describe('v1.254.0 A2 — buildLiveCheck: skupaj + prečrtane + kap', () => {
  test('A2a: skupaj = Σ qty×unitPrice po NE-prečrtanih (r2)', () => {
    const m = buildLiveCheck([
      { key: 'a', name: 'A', qty: 2, unitPrice: 3.5 },
      { key: 'b', name: 'B', qty: 1, unitPrice: 7.01 },
      { key: 'c', name: 'C', qty: 3, unitPrice: 2, voided: true },
    ])
    expect(m.total).toBe(14.01) // 7 + 7.01; prečrtana c IZPUŠČENA
  })

  test('A2b: pending obroba ne spremeni zneska (samo vizualno)', () => {
    const m = buildLiveCheck([{ key: 'a', name: 'A', qty: 1, unitPrice: 4, pending: true }])
    expect(m.total).toBe(4)
    expect(m.lines[0].pending).toBe(true)
  })

  test('A2c: kap 30 z iskrenim števcem — skupaj sešteje VSE (nezrezane) vrstice', () => {
    const raw: LiveCheckLine[] = Array.from({ length: 35 }, (_, i) => ({ key: `k${i}`, name: `N${i}`, qty: 1, unitPrice: 1 }))
    const m = buildLiveCheck(raw)
    expect(m.lines).toHaveLength(MAX_LIVE_CHECK_LINES)
    expect(m.more).toBe(5) // … in še 5 — ne tiha rezanja
    expect(m.total).toBe(35) // poštena številka kljub rezi seznama
  })

  test('A2d: prevPrice se ohrani samo kadar veljaven (≥ 0, končno)', () => {
    const m = buildLiveCheck([
      { key: 'a', name: 'A', qty: 1, unitPrice: 5, prevPrice: 4 },
      { key: 'b', name: 'B', qty: 1, unitPrice: 5, prevPrice: -2 },
      { key: 'c', name: 'C', qty: 1, unitPrice: 5, prevPrice: 'x' },
    ] as unknown[])
    expect(m.lines.find((l) => l.key === 'a')!.prevPrice).toBe(4)
    expect(m.lines.find((l) => l.key === 'b')!.prevPrice).toBeUndefined()
    expect(m.lines.find((l) => l.key === 'c')!.prevPrice).toBeUndefined()
  })
})

describe('v1.254.0 B — cartPreviewLines: preslikava treh košaric POS', () => {
  const menu = [
    { id: 'm1', name: 'Pivo', price: 3.5 },
    { id: 'm2', name: 'Pizza', price: 8 },
  ]

  test('B1: navadne + variantne vrstice — ime z opcijami, cena z doplačilom, opombe', () => {
    const lines = cartPreviewLines(
      { m1: 2 },
      [{ key: 'v1', menuItemId: 'm2', qty: 1, optionNames: ['velika', 'gluten-free'], optionPrice: 1.5 }],
      { m1: 'brez pene', v1: 'rezano' },
      menu,
    )
    expect(lines).toHaveLength(2)
    const p = lines.find((l) => l.key === 'm1')!
    expect(p.name).toBe('Pivo')
    expect(p.qty).toBe(2)
    expect(p.unitPrice).toBe(3.5)
    expect(p.note).toBe('brez pene')
    const v = lines.find((l) => l.key === 'v1')!
    expect(v.name).toBe('Pizza · velika, gluten-free')
    expect(v.unitPrice).toBe(9.5) // 8 + 1.5
    expect(v.note).toBe('rezano')
  })

  test('B2: qty ≤ 0 in manjkajoči artikel se preskočijo (predogled ne laže o 0,00 €)', () => {
    const lines = cartPreviewLines(
      { m1: 0, m2: 1, mX: 3 },
      [{ key: 'v9', menuItemId: 'ne-obstaja', qty: 2, optionNames: [], optionPrice: 0 }],
      {},
      menu,
    )
    expect(lines).toHaveLength(1) // samo m2
    expect(lines[0].key).toBe('m2')
  })

  test('B3: defenzivno — prazni/null vhodi → []', () => {
    expect(cartPreviewLines(null, null, null, null)).toEqual([])
    expect(cartPreviewLines({}, [], {}, [])).toEqual([])
    expect(cartPreviewLines({ m1: 1 }, null, null, menu)).toHaveLength(1)
  })
})

describe('v1.254.0 C — orderPreviewLines: obstoječe postavke naročila', () => {
  test('C1: modifiers v imenu, opomba, preklicane (voided) preskočene', () => {
    const lines = orderPreviewLines([
      { id: 'i1', name: 'Pizza', qty: 1, unitPrice: 9, modifiers: ['velika'] },
      { id: 'i2', name: 'Juha', qty: 2, unitPrice: 4, note: 'brez glutena' },
      { id: 'i3', name: 'Staro', qty: 1, unitPrice: 5, voided: true },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].name).toBe('Pizza · velika')
    expect(lines[1].note).toBe('brez glutena')
    expect(lines[1].qty).toBe(2)
  })

  test('C2: defenzivno — smeti preskočene (brez id/ime, ne-objekti)', () => {
    const lines = orderPreviewLines([
      null,
      { id: '', name: 'X', qty: 1, unitPrice: 1 },
      { id: 'ok', name: '', qty: 1, unitPrice: 1 },
      { id: 'i9', name: 'Dobro', qty: 1, unitPrice: 3 },
    ] as unknown[])
    expect(lines).toHaveLength(1)
    expect(lines[0].key).toBe('i9')
  })
})

describe('v1.254.0 D — variantPendingLine: živa vrstica iz TRENUTNIH izbir', () => {
  const groups = [
    { id: 'g1', modifiers: [{ id: 'o1', name: '0,3 L', price: 0 }, { id: 'o2', name: '0,5 L', price: 1 }] },
    { id: 'g2', modifiers: [{ id: 'p1', name: 'Hefeweizen', price: 0.5 }] },
  ]

  test('D1: prazne izbire → osnovno ime/cena, pending (vrstica je VEDNO vidna med urejanjem)', () => {
    const l = variantPendingLine({ name: 'Pivo', price: 3.5 }, groups, {})
    expect(l).not.toBeNull()
    expect(l!.name).toBe('Pivo')
    expect(l!.unitPrice).toBe(3.5)
    expect(l!.qty).toBe(1)
    expect(l!.pending).toBe(true)
  })

  test('D2: izbire → ime z opcijami + vsota doplačil; neznana izbira preskočena', () => {
    const l = variantPendingLine({ name: 'Pivo', price: 3.5 }, groups, { g1: 'o2', g2: 'p1', gX: 'ne-obstaja' })
    expect(l!.name).toBe('Pivo · 0,5 L, Hefeweizen')
    expect(l!.unitPrice).toBe(5) // 3.5 + 1 + 0.5
  })

  test('D3: item null/pražen → null (dialog brez konteksta)', () => {
    expect(variantPendingLine(null, groups, {})).toBeNull()
    expect(variantPendingLine({ name: '  ', price: 3 } as { name: string; price: number }, groups, {})).toBeNull()
  })
})

describe('v1.254.0 E — withLineUpdate + parsePriceInput (živi predogledi)', () => {
  const base: LiveCheckLine[] = [
    { key: 'a', name: 'A', qty: 1, unitPrice: 5 },
    { key: 'b', name: 'B', qty: 2, unitPrice: 3 },
  ]

  test('E1: note patch — čista kopija, SAMO dotaknjena vrstica dobi pending', () => {
    const nx = withLineUpdate(base, 'a', { note: 'brez ledu' })
    expect(nx).not.toBe(base) // kopija
    expect(base[0].note).toBeUndefined() // izvirnik nedotaknjen
    expect(nx[0].note).toBe('brez ledu')
    expect(nx[0].pending).toBe(true)
    expect(nx[1].pending).toBeUndefined()
  })

  test('E2: cena patch nosi prevPrice; preklic patch voided', () => {
    const nx = withLineUpdate(base, 'b', { unitPrice: 4, prevPrice: 3 })
    expect(nx[1].unitPrice).toBe(4)
    expect(nx[1].prevPrice).toBe(3)
    expect(nx[1].pending).toBe(true)
    const vx = withLineUpdate(base, 'b', { voided: true })
    expect(vx[1].voided).toBe(true)
    // skupaj po preklicu (buildLiveCheck izpusti prečrtano)
    expect(buildLiveCheck(vx).total).toBe(5)
  })

  test('E3: neznan ključ → tabela nespremenjena (kopija, brez izumljanja vrstic)', () => {
    const nx = withLineUpdate(base, 'ne-obstaja', { note: 'x' })
    expect(nx).toEqual(base)
    expect(withLineUpdate(base, '', { note: 'x' })).toEqual(base)
  })

  test('E4: parsePriceInput — vejica/pika/celo; smeti/negativno/preveliko → null', () => {
    expect(parsePriceInput('12,50')).toBe(12.5)
    expect(parsePriceInput('12.5')).toBe(12.5)
    expect(parsePriceInput('12')).toBe(12)
    expect(parsePriceInput(' 9,99 ')).toBe(9.99)
    expect(parsePriceInput('')).toBeNull()
    expect(parsePriceInput('abc')).toBeNull()
    expect(parsePriceInput('-5')).toBeNull()
    expect(parsePriceInput('1e9')).toBeNull()
    expect(parsePriceInput('100000')).toBeNull()
    expect(parsePriceInput(12.5)).toBeNull() // samo niz (vhod je input.value)
  })
})

// ── Ž) REGISTRI ──

describe('v1.254.0 Ž — registri', () => {
  const pageSrc = read('src/app/dashboard/page.tsx')
  const compSrc = read('src/components/live-check-aside.tsx')
  const libSrc = read('src/lib/live-check.ts')

  test('Ž1: verzija 1.257.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.282.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.282.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.282.0')
  })

  test('Ž2: i18n pariteta SL/HR 4093/4093 (+10 lcv.*)', () => {
    for (const k of [
      'lcv.title', 'lcv.live', 'lcv.empty', 'lcv.pending', 'lcv.voided',
      'lcv.more', 'lcv.total', 'lcv.totalAfterVoid', 'lcv.prev', 'lcv.hint',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4324)
    expect(hrCount).toBe(4324)
  })

  test('Ž3: montaža — štirje dialogi z LiveCheckAside + tap na vrstico + 0 DDL dokaz', () => {
    // štirje urejevalni dialogi nosijo ploščo z lastnim data-region (ločljivo v E2E)
    expect(pageSrc).toContain('region="lcv-aside-variant"')
    expect(pageSrc).toContain('region="lcv-aside-note"')
    expect(pageSrc).toContain('region="lcv-aside-price"')
    expect(pageSrc).toContain('region="lcv-aside-void"')
    // dvostolpčna postavitev (Square: check ZRAVEN urejevalca; mobilno plošča na vrhu)
    expect(pageSrc.match(/sm:grid-cols-\[minmax\(0,0\.95fr\)_minmax\(0,1\.05fr\)\]/g)?.length).toBe(4)
    // živi modeli so izpeljani iz stanja (posodobitev z vsako izbiro)
    expect(pageSrc).toContain('variantAsideModel')
    expect(pageSrc).toContain('noteAsideModel')
    expect(pageSrc).toContain('priceAsideModel')
    expect(pageSrc).toContain('voidAsideModel')
    // tap na vrstico košarice odpre podrobnosti (opombo) — vseh šest mest
    expect(pageSrc.match(/openNotePick\('sale', l\.key/g)?.length).toBe(2) // namizni + mobilni sale variant
    expect(pageSrc.match(/openNotePick\('sale', mi\.id/g)?.length).toBe(1) // SaleCartLineName (namizni + mobilni)
    expect(pageSrc.match(/openNotePick\('cart', m\.id/g)?.length).toBe(1)
    expect(pageSrc.match(/openNotePick\('cart', l\.key/g)?.length).toBe(1)
    expect(pageSrc.match(/openNotePick\('sheet', m\.id/g)?.length).toBe(1)
    expect(pageSrc.match(/openNotePick\('sheet', l\.key/g)?.length).toBe(1)
    // komponenta: jantarna pending obroba + prečrtana voided + iskren cap
    expect(compSrc).toContain('lcv-aside')
    expect(compSrc).toContain('border-amber-300 bg-amber-50')
    expect(compSrc).toContain('line-through')
    expect(compSrc).toContain("t('lcv.more', { n: model.more })")
    expect(compSrc).toContain('max-h-48')
    // 0 DDL dokaz: čista lib brez db/prisma uvozov; schema brez novih modelov tega vala
    expect(libSrc).not.toContain("from '@/lib/db'")
    expect(libSrc).not.toContain('prisma')
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('LiveCheck')
  })

  test('Ž4: dokumenta — PRIMERJAVA §28 + AUDIT POSODOBITEV + števec', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 28.')
    expect(doc).toContain('Real-Time Check View')
    expect(doc).toContain('updates with each choice as staff edit')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.256.0')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž5: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.282.0-email-determinizem')
  })
})
