/**
 * v1.259.0 — VEDNO VIDNO NAROČILO NA MOBILNIH POVRŠINAH
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §33; Lightspeed K-Series november 2026
 * »Keep active orders visible while browsing menus« — slide-out menu
 * layer na handheld POS napravah).
 *
 * Merjena vrzel: obe mobilni površini (handheld ORDER pogled + tablica
 * listek) sta postavili obstoječe postavke naročila v isti drseči
 * vsebnik kot meni — ko natakar drsi po meniju (glavna dejavnost
 * pogleda), obstoječe postavke ODPADEJO iz pogleda; »did I already
 * ring in a Bograč?« terja vrnitev na vrh ali preklop zaslona.
 * Košarica NOVIH postavk je sicer že lepljiva na dnu, a obstoječe
 * (poslane) postavke niso bile vidne nikjer med brskanjem.
 *
 *  A · MONTAŽA VIRA (obeh površin): zložljiva LEPILJIVA vrstica
 *    naročila na vrhu drsečega območja menija (povzetek ostane v
 *    pogledu med brskanjem — naš prevod slide-out plasti), razpenjanje
 *    razkrije poln seznam z max-h + lastnim drsanjem (meni ostaja
 *    pod plastjo), 44 px dotik + aria-expanded/controls, najbolj
 *    relevantna faza v povzetku (priprava/pripravljeno — handheld),
 *    izločitve (prazno naročilo / nov listek brez vrstice).
 *  Ž · REGISTRI: verzija 1.259.0 + compose, i18n pariteta
 *    4105/4105 (+4 hh.orderBar* +2 tlb.orderBar*), dokumenta §33 +
 *    AUDIT, 0 DDL dokaz, 0 strežniških sprememb, worklog.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const hhSrc = read('src/app/handheld/page.tsx')
const tlbSrc = read('src/app/tablica/page.tsx')

// ── A) MONTAŽA VIRA ──

describe('v1.259.0 A1 — handheld: zložljiva lepljiva vrstica naročila', () => {
  test('A1a: stanje orderBarOpen, privzeto ZLOŽENO (prehodno, enako noteOpen)', () => {
    expect(hhSrc).toContain('const [orderBarOpen, setOrderBarOpen] = useState(false)')
    // BREZ persist — trenutna plast brskanja, ne nastavitev naprave
    expect(hhSrc).not.toContain('ro_hh_order_bar')
    expect(hhSrc).not.toContain("localStorage.setItem('ro_order_bar")
  })

  test('A1b: sekcija je LEPILJIVA na OKNO pod glavo (raztegnjena čez odmik; FIX zaključne verifikacije)', () => {
    const idx = hhSrc.indexOf('data-region="hh-order-bar"')
    expect(idx).toBeGreaterThan(0)
    const seg = hhSrc.slice(idx, idx + 220)
    // FIX (zaključna verifikacija, drugi korak — živa preverba je popravila
    // popravek): glavni del je min-h-dvh — okno drsa, vsebnik menija z
    // overflow-y-auto je bil MRTVI scroll-container, ki je ugrabil lepljivo
    // zavezo (vrstica je zdrsla z oknom, rob −550 px po 700 px drsanja).
    // Popravek: BREZ overflow-y-auto na vsebniku + top-[77px] — odmik se meri
    // od ROBA VSEBINE drsečega vsebnika (prvi poskus 65 px je napačno
    // predvideval margin-edge; živa izmera: 65 = 12 px ZA glavo, 77 = flush
    // 77=77, cela vrstica 45 px vidna).
    expect(seg).toContain('sticky top-[77px]')
    expect(seg).toContain('-mx-4 -mt-3')
    // trdna podlaga — drseči meni se ne vidi skozi
    expect(seg).toContain('bg-white/95')
    // MRTVI drseči vsebnik ODSTRANJEN na območju menija naročanja (listek/račun
    // pogled sta space-y-4, ta trditev cilja SAMO vsebnik naročanja space-y-3)
    expect(hhSrc).not.toContain('overflow-y-auto px-4 py-3 space-y-3')
  })

  test('A1c: preklop 44 px z aria-expanded/controls + polni opis', () => {
    expect(hhSrc).toContain('data-region="hh-order-bar-toggle"')
    expect(hhSrc).toContain('aria-expanded={orderBarOpen}')
    expect(hhSrc).toContain('aria-controls="hh-order-bar-list"')
    expect(hhSrc).toContain("aria-label={t('hh.orderBarAria')}")
    expect(hhSrc).toContain('id="hh-order-bar-list"')
    const idx = hhSrc.indexOf('aria-controls="hh-order-bar-list"')
    const seg = hhSrc.slice(idx, idx + 400)
    expect(seg).toContain('min-h-11')
  })

  test('A1d: zloženi povzetek — števec + znesek + puščica (rotacija ob razprtju)', () => {
    expect(hhSrc).toContain("t('hh.orderBar', { n: activeItems.length })")
    expect(hhSrc).toContain('fmtEUR(openOrder?.total ?? 0)')
    expect(hhSrc).toContain("orderBarOpen ? 'rotate-180' : ''")
    expect(hhSrc).toMatch(/<ChevronDown className=/)
  })

  test('A1e: najbolj relevantna faza v povzetku — priprava (amber) ima prednost pred pripravljenim (emerald)', () => {
    expect(hhSrc).toContain("t('hh.orderBarPrep', { n: prepCount })")
    expect(hhSrc).toContain("tN('hh.orderBarReady', 'pripravljen', readyCount)")
    // fazi sta izpeljani iz ISTEGA activeItems (eni resnici — memo ob istem viru)
    expect(hhSrc).toContain("activeItems.filter((it) => it.status === 'PREPARING').length")
    expect(hhSrc).toContain("activeItems.filter((it) => it.status === 'READY').length")
    // emerald veja samo, ko NI priprave (pogoj v izrisu)
    const idx = hhSrc.indexOf("tN('hh.orderBarReady', 'pripravljen', readyCount)")
    const before = hhSrc.slice(Math.max(0, idx - 260), idx)
    expect(before).toContain('prepCount === 0 && readyCount > 0')
  })

  test('A1f: razprta veja — poln seznam z lastnim drsanjem, meni OSTAJE pod plastjo', () => {
    const idx = hhSrc.indexOf('data-region="hh-order-bar-list"')
    expect(idx).toBeGreaterThan(0)
    const seg = hhSrc.slice(idx, idx + 160)
    expect(seg).toContain('max-h-64 overflow-y-auto')
    // statusne pilule postavk nespremenjene (isti ITEM_STATUS_BADGE vir)
    expect(hhSrc).toContain('ITEM_STATUS_BADGE[it.status] ?? ITEM_STATUS_BADGE.PENDING')
    // pogojena na orderBarOpen (ne izriše se vedno)
    expect(hhSrc).toContain('{orderBarOpen && (')
  })

  test('A1g: izločitve — prazno naročilo in nov listek vrstice NE nosijo', () => {
    // vrstica samo ob obstoječih postavkah
    expect(hhSrc).toContain('{activeItems.length > 0 && (')
    // prazno naročilo ostane iskreno kot prej (tlb.emptyOrder, izven plasti)
    expect(hhSrc).toContain("{openOrder && activeItems.length === 0 && <p className=\"text-sm text-stone-500\">{t('tlb.emptyOrder')}</p>}")
  })
})

describe('v1.259.0 A2 — tablica: enak vzorec v listku (hiter način)', () => {
  test('A2a: stanje orderBarOpen, privzeto ZLOŽENO (brez persist)', () => {
    expect(tlbSrc).toContain('const [orderBarOpen, setOrderBarOpen] = useState(false)')
    expect(tlbSrc).not.toContain('ro_tlb_order_bar')
  })

  test('A2b: sekcija lepljiva na vrhu drsečega območja listka z lastno regijo (flush po FIX)', () => {
    const idx = tlbSrc.indexOf('data-region="tlb-order-bar"')
    expect(idx).toBeGreaterThan(0)
    const seg = tlbSrc.slice(idx, idx + 220)
    // FIX (zaključna verifikacija, živo preverjeno na produkciji po deployju):
    // Sheet je višinsko omejen → vsebnik RES drsa in lepljivost deluje, a je
    // bila vrstica prilepljena 12 px POD robom vsebnika — odmik se meri od
    // ROBA VSEBINE drsečega vsebnika (pt-3 obloga vsebnika premakne izhodišče
    // za 12 px, ne -mt-3 na vrstici — lekcija iz handheld popravka). Nad
    // vrstico je pek 12 px pas z vsebino menija. -top-3 (−12 px) kompenzira
    // oblogo → obroba pristane TOČNO na robu vsebnika (živo po deployju:
    // flush 138=138, pas izgine, element nad robom = vrstica sama).
    expect(seg).toContain('sticky -top-3')
    expect(seg).toContain('-mx-4 -mt-3')
    expect(seg).toContain('bg-white/95')
  })

  test('A2c: preklop 44 px z aria-expanded/controls', () => {
    expect(tlbSrc).toContain('data-region="tlb-order-bar-toggle"')
    expect(tlbSrc).toContain('aria-expanded={orderBarOpen}')
    expect(tlbSrc).toContain('aria-controls="tlb-order-bar-list"')
    expect(tlbSrc).toContain("aria-label={t('tlb.orderBarAria')}")
    expect(tlbSrc).toContain('id="tlb-order-bar-list"')
    const idx = tlbSrc.indexOf('aria-controls="tlb-order-bar-list"')
    const seg = tlbSrc.slice(idx, idx + 400)
    expect(seg).toContain('min-h-11')
  })

  test('A2d: povzetek nosi števec že na naročilu + znesek + puščico', () => {
    expect(tlbSrc).toContain("t('tlb.orderBar', { n: openOrder.items.filter((it) => !it.voided).length })")
    expect(tlbSrc).toContain('fmtEUR(openOrder.total)')
    expect(tlbSrc).toContain("orderBarOpen ? 'rotate-180' : ''")
  })

  test('A2e: razprta veja z max-h-56; vrstice BREZ statusnih pilul (status quo hitrega načina)', () => {
    const idx = tlbSrc.indexOf('data-region="tlb-order-bar-list"')
    expect(idx).toBeGreaterThan(0)
    const seg = tlbSrc.slice(idx, idx + 160)
    expect(seg).toContain('max-h-56 overflow-y-auto')
    const barSeg = tlbSrc.slice(idx, idx + 1600)
    expect(barSeg).not.toContain('ITEM_STATUS_BADGE')
  })

  test('A2f: izločitve — prazno naročilo ostane izven plasti (iskreno stanje)', () => {
    // vrstica samo ob vsaj eni obstoječi postavki
    expect(tlbSrc).toContain('{openOrder && openOrder.items.filter((it) => !it.voided).length > 0 && (')
    // prazno naročilo: naslov + sporočilo kot prej
    expect(tlbSrc).toContain("{openOrder && openOrder.items.filter((it) => !it.voided).length === 0 && (")
    expect(tlbSrc).toContain("t('tlb.emptyOrder')")
  })
})

// ── Ž) REGISTRI ──

describe('v1.259.0 Ž — registri', () => {
  test('Ž1: verzija 1.259.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.301.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.301.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.301.0')
  })

  test('Ž2: i18n pariteta SL/HR 4105/4105 (+4 hh.orderBar* +2 tlb.orderBar*)', () => {
    for (const k of [
      'hh.orderBar', 'hh.orderBarPrep', 'hh.orderBarReady', 'hh.orderBarAria',
      'tlb.orderBar', 'tlb.orderBarAria',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4324)
    expect(hrCount).toBe(4324)
  })

  test('Ž3: dokumenta — PRIMERJAVA §33 + AUDIT POSODOBITEV + števci', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 33.')
    expect(doc).toContain('VEDNO VIDNO NAROČILO NA MOBILNIH POVRŠINAH')
    // citat je v dokumentu prelomljen čez vrstice — regex odporen na prelom
    expect(doc).toMatch(/Keep\s+active\s+orders\s+visible\s+while\s+browsing\s+menus/)
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.259.0')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž4: 0 DDL + 0 strežniških sprememb — čista klientna plast nad obstoječo cevjo', () => {
    const schema = read('prisma/schema.prisma')
    // 0 DDL dokaz: noben nosilec vrstice v shemi (vzorec §31/§32 Ž4:
    // ciljno ime polja, ne beseda)
    expect(schema).not.toContain('orderBar')
    expect(schema).not.toContain('OrderBar')
    // naročila se ŽE nalagajo na obe površini — ruti ostajata brez pojma vrstice
    const ordersRoute = read('src/app/api/orders/route.ts')
    expect(ordersRoute).not.toContain('orderBar')
    expect(ordersRoute).not.toContain('vrsticaNarocila')
    // vrstica je čisti izris nad activeItems/openOrder (isti vir kot prej)
    expect(hhSrc).toContain('const activeItems = useMemo(() => (openOrder ? openOrder.items.filter((it) => !it.voided) : [])')
    // 0 novih odvisnosti — ChevronDown je iz obstoječega lucide nabora
    expect(hhSrc).toMatch(/from 'lucide-react'/)
    expect(tlbSrc).toMatch(/from 'lucide-react'/)
  })

  test('Ž5: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.301.0-nadzorni-val-odlocitveni-paket')
  })
})
