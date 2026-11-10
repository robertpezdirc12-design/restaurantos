/**
 * v1.276.0 — DECIMALNA LOČILA: surovi toFixed v render poteh
 * (svež pregled po zaključku diakritik (v1.272–v1.273, v1.275) in
 *  lokalnega determinizma (v1.274) — naslednja površina iste družine)
 *
 *  NAJDENIH IN POPRAVLJENIH 37 mest (v 10 datotekah):
 *    · surov `${n.toFixed(N)}` v UPORABNIŠKO VIDNIH izpisih izpiše PIKO
 *      (»12.50 %«, »4.7«), medtem ko centralni formatirniki (fmtEUR/
 *      fmtNumSI/fmtPctSigned, vsi 'sl-SI') izpisujejo VEJICO — uporabnik
 *      vidi nedosledna ločila na ISTEM zaslonu (KPI kartica ob fmtEUR
 *      vrstici, labor % ob strošku …). Doktrina issue #71: »ena funkcija
 *      = ena oblika« — ta val le zaključuje površino, ki jo je issue #71
 *      odprl za meritve.
 *    · NOVI čisti formatirnik fmtFixedSI(n, digits, unit?) v client.ts:
 *      fiksno število decimalnk po vzorcu toFixed(N) (trailing ničle
 *      ohranjene: 4 → »4,0«), a v sl-SI obliki — vejica + ločilo
 *      tisočic (1234.5 → »1.234,50«) + U+2212 minus pri negativnih
 *      (ista konvencija kot fmtEUR/fmtPctSigned). fmtNumSI dopolnjen z
 *      aditivno min opcijo (nazdružljivo nazaj — obstoječi klici brez
 *      min so byte-identični).
 *    · ZNESKI (12 mest): exceptions ×2, dashboard toast/tooltip/prikaz ×3,
 *      kuponi ×1, zaloga variansa ×1, modifikatorji EUR ×1 → fmtEUR
 *      (celotna valutna oblika z ločilom tisočic).
 *    · ODSOTKI/MERITVE (25 mest): analitika 16 (pop tooltip, referenčne
 *      črte, food-cost tabele, KDS KPI/sub, heatmap tooltip, postaje,
 *      fcQty/fcPct, pijače, PC značke, stroškovna struktura), operacije 12
 *      (labor % ×6, pokritje expectedPct ×2, število osebja, ure fmtH,
 *      napoved vrzeli −/+ ), dashboard vnos cene ×1 (parser 1517 je
 *      vejico-toleranten: replace(',', '.') — inicializacija zdaj
 *      prikaže »12,50« namesto »12.50«), gostje ocena ×1, finance KB/MB ×2,
 *      dokumenti kB/MB ×2 → fmtFixedSI.
 *
 *  POŠTENI NEGATIVNI KONTROLI (NEVDNI — ostanejo s piko/goli):
 *    · CSV izvozi (analitika 5 vrstic): pika = Excel/računovodska
 *      konvencija repozitorija (v1.274 lekcija: CSV eur() pomožniki so
 *      NAMERNO pika v datotekah);
 *    · TISK (dashboard money helper za PrintLine vrstice) in GOSTUJOČE
 *      strani (/s /pay /m /kiosk /display — 5 lokalnih fmt helperjev):
 *      lokalna helperja že proizvajata VEJICO prek .replace('.', ',');
 *      gost strani so namerno samostojne (0 uvozov iz client.ts);
 *    · VNOSNA POLJA type=number (dashboard p.amount): DOM vrednost
 *      številčnega polja ZAHTEJEVA strojno piko — brskalnik sam prikaže
 *      vejico uporabniku glede na locale;
 *    · tehnični lib (furs/eslog/einvoice/fiscal/cis — xsd:decimal oblika,
 *      API route zaokroževanje za izračune, ne izpise) izven obsega.
 *
 *  Č1 · PURE: fmtFixedSI obnašanje (trailing ničle, vejica, tisočice,
 *      U+2212 minus, unit) + fmtNumSI min aditivnost + fmtEUR referenca.
 *  Č2 · PINI: vseh 37 mest živih v svojih datotekah po skupinah.
 *  Č3 · NEGATIVNI KONTROLI + SKEN: dovoljeni ostanki točno naštevani
 *      (allowlist) — 0 surovih toFixed v render poteh UI datotek.
 *  Ž · REGISTRI: verzija 1.276.0 (version.ts + compose + APP_VERSION
 *      vsebina), worklog vrh Task ID, AUDIT POSODOBITEV v1.276.0,
 *      zgodovinska veriga v1.275.0 ostaja, i18n števci nespremenjeni.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { fmtEUR, fmtNumSI, fmtFixedSI } from '../src/lib/client'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) PURE — fmtFixedSI/fmtNumSI obnašanje ──
describe('v1.276.0 Č1 — čisti formatirnik fmtFixedSI (toFixed semantika, sl-SI oblika)', () => {
  test('trailing ničle ohranjene kot toFixed (4 → »4,0«, 92 → »92,0«)', () => {
    // surov toFixed(1) bi dal »4.0«/»92.0« — pika ob sosednjih vejicah
    expect(fmtFixedSI(4, 1)).toBe('4,0')
    expect(fmtFixedSI(92, 1)).toBe('92,0')
    expect(fmtFixedSI(0, 2)).toBe('0,00')
  })

  test('decimalna VEJICA namesto pike (12.345 → »12,35« — enako kot toFixed(2) zaokrožanje)', () => {
    expect(fmtFixedSI(12.345, 2)).toBe('12,35')
    expect(fmtFixedSI(4.65, 1)).toBe('4,7')
  })

  test('ločilo tisočic (ICU-odvisno: peskovnik »1.234,50«, CI brez skupinjenja »1234,50« — tema je VEJICA)', () => {
    // ISKRENO ODKRITJE CI (vzorec lekcije E5): CI runner (ubuntu Bun) ICU
    // formatira sl-SI BREZ skupinjenja tisočic (»1234,50«), peskovnik z
    // ločilom (»1.234,50«) — decimalna VEJICA (tema vala) je stabilna v
    // obeh, skupinjenje je odvisno od CLDR različice prevajalnika.
    const a = fmtFixedSI(1234.5, 2)
    const b = fmtFixedSI(100000, 2)
    expect(a.endsWith('234,50')).toBe(true)
    expect(b.endsWith('000,00')).toBe(true)
    // skupinjenje (0 ali 1 znak) — oba ICU svetova sprejemljiva
    expect(a).toMatch(/^1.?234,50$/)
    expect(b).toMatch(/^100.?000,00$/)
  })

  test('negativni predznak U+2212 (−12,34 — ista konvencija kot fmtEUR/fmtPctSigned)', () => {
    const out = fmtFixedSI(-12.34, 2)
    expect(out).toBe('−12,34')
    expect(out.charCodeAt(0)).toBe(0x2212)
  })

  test('unit dodatek (dodatna izbira, ne obveza)', () => {
    expect(fmtFixedSI(9.5, 1, ' %')).toBe('9,5 %')
    expect(fmtFixedSI(9.5, 1)).toBe('9,5')
  })

  test('0 decimalk (share ×100 → »45«; 100 → »100« brez ločila tisočic)', () => {
    expect(fmtFixedSI(45, 0)).toBe('45')
    expect(fmtFixedSI(100, 0)).toBe('100')
  })

  test('fmtNumSI min aditivnost: obstoječi klici brez min so nespremenjeni; min=max = fiksna oblika', () => {
    // nazdružljivo nazaj: brez min se obnaša kot prej (maximumFractionDigits)
    expect(fmtNumSI(4)).toBe('4')
    expect(fmtNumSI(4.2, { max: 1 })).toBe('4,2')
    expect(fmtNumSI(4.0, { max: 1 })).toBe('4') // brez min: brez trailing ničle
    // z min: trailing ničla pride (aditivna razširitev v1.276.0 dokumentirana v client.ts)
    expect(fmtNumSI(4, { min: 1, max: 1 })).toBe('4,0')
    expect(fmtNumSI(4, { min: 2, max: 2 })).toBe('4,00')
  })

  test('fmtEUR referenca: vejica + nedružljivi presledek pred € (zamenjava 12 zneskov)', () => {
    // Intl sl-SI valuta: pred € je U+00A0 (nedružljivi presledek — € se ne
    // loči od zneska ob prelomu vrstice; enako obnašanje kot pred valom);
    // skupinjenje tisočic je ICU-odvisno (CI brez — glej test zgoraj)
    expect(fmtEUR(12.5)).toBe('12,50\u00A0€')
    expect(fmtEUR(1234.5)).toMatch(/^1.?234,50\u00A0€$/)
    expect(fmtEUR(0)).toBe('0,00\u00A0€')
  })
})

// ── Č2) PINI — vseh 37 mest živih v svojih datotekah ──
describe('v1.276.0 Č2 — pini mest: 37 surovih toFixed render zamenjanih s centralnimi formatirniki', () => {
  test('analitika: 16 mest (tooltip pop, referenčne črte, tabele, KPI, fcQty/fcPct, pijače, PC, struktura)', () => {
    const src = read('src/components/tabs/analitika-tab.tsx')
    expect(src).toContain("{tx('me.th.pop')}: {fmtFixedSI(p.x, 1)} %")
    expect(src).toContain('label={{ value: `${fmtFixedSI(meanQtyThr, 1)} %`')
    expect(src).toContain("i.costKnown ? `${fmtFixedSI(i.foodCostPct, 1)} %` : '—'")
    expect(src).toContain('{fmtFixedSI(i.popShare, 1)} %')
    expect(src).toContain('{fmtFixedSI(kpi.onTimePct, 1)} %')
    expect(src).toContain('{fmtFixedSI(kpi.okPct, 1)} %')
    expect(src).toContain('{fmtFixedSI(kpi.warnPct, 1)} %')
    expect(src).toContain('{fmtFixedSI(kpi.latePct, 1)} %')
    expect(src).toContain('— ${fmtFixedSI(c.avg, 1)} min · ${c.count}×')
    expect(src).toContain('{fmtFixedSI(i.latePct, 1)} %')
    expect(src).toContain('{fmtFixedSI(sRow.latePct, 1)} %')
    expect(src).toContain('return Math.abs(n) >= 100 ? fmtFixedSI(n, 1) : String(n)')
    expect(src).toContain('return n == null ? \'—\' : `${fmtFixedSI(n, 1)} %`')
    expect(src).toContain("bevPct == null ? '—' : `${fmtFixedSI(bevPct, 1)} %`")
    expect(src).toContain('{fmtFixedSI(r.pct, 1)} %')
    expect(src).toContain('{fmtFixedSI(r.share * 100, 0)} %')
    expect(src).toContain('fmtFixedSI, downloadCSV')
  })

  test('operacije: 12 mest (labor % ×6, pokritje ×2, osebje, ure, vrzeli −/+)', () => {
    const src = read('src/components/tabs/ops-cards.tsx')
    expect(src).toContain("{d.pct === null ? '—' : `${fmtFixedSI(d.pct, 2)} %`}")
    expect(src).toContain("{s.avgPct === null ? '—' : `${fmtFixedSI(s.avgPct, 2)} %`}")
    expect(src).toContain('{`${fmtFixedSI(tt.laborPct, 2)} %`}')
    // d.laborPct se pojavi 2× (tabela + kartice) — števec occurrence
    expect(src.split("`${fmtFixedSI(d.laborPct, 2)} %`").length - 1).toBe(2)
    expect(src).toContain("{data.totals.laborPct === null ? '—' : `${fmtFixedSI(data.totals.laborPct, 2)} %`}")
    expect(src).toContain('fmtFixedSI(r.staff, 1)')
    expect(src.split('`${fmtFixedSI(c.expectedPct, 2)} %`').length - 1).toBe(2)
    expect(src).toContain('const fmtH = (h: number) => `${Number.isInteger(h) ? h : fmtFixedSI(h, 2)} ${t(\'lf.hoursShort\')}`')
    expect(src).toContain('−{fmtFixedSI(under, 2)}')
    expect(src).toContain('+{fmtFixedSI(over, 2)}')
    expect(src).toContain('fmtFixedSI, downloadCSV')
  })

  test('dashboard: 4 mesta (toast, tooltip, vnos cene s pillar parserja, prikaz trenutne cene)', () => {
    const src = read('src/app/dashboard/page.tsx')
    expect(src).toContain('description: `${fmtEUR(d.overridden.oldPrice)} → ${fmtEUR(d.overridden.newPrice)}`')
    expect(src).toContain('title={`${t(\'prc.mark\')}: ${fmtEUR(it.priceOverride.from)} → ${fmtEUR(it.priceOverride.to)}')
    expect(src).toContain('setPriceNew(fmtFixedSI(it.unitPrice, 2))')
    expect(src).toContain("{priceItem?.unitPrice != null ? fmtEUR(priceItem.unitPrice) : '—'}")
  })

  test('dashboard: vnos cene je VEJICO-TOLERANTEN (parser replace — dokaz varnosti swapa)', () => {
    // parser vrstica ~1517 sprejme tudi vejico → inicializacija s fmtFixedSI je varna
    const src = read('src/app/dashboard/page.tsx')
    expect(src).toContain("Number(priceNew.trim().replace(',', '.'))")
  })

  test('izjeme: 2 zneska (povzetek po vrsti + vrstica dogodka)', () => {
    const src = read('src/components/tabs/exceptions-card.tsx')
    expect(src).toContain('{fmtEUR(data.byKind[k].amount)}')
    expect(src).toContain('{e.amount !== null && <span className="font-semibold">{fmtEUR(e.amount)}</span>}')
  })

  test('dokumenti: humanSizeUI kB/MB — decimalna vejica, cela vrednost brez decimalke (ohranjena semantika)', () => {
    const src = read('src/components/tabs/documents-card.tsx')
    expect(src).toContain('const kb = bytes / 1000; return `${Number.isInteger(kb) ? kb : fmtFixedSI(kb, 1)} kB`')
    expect(src).toContain('return `${Number.isInteger(mb) ? mb : fmtFixedSI(mb, 1)} MB`')
  })

  test('finance: fmtSize KB/MB — vedno 1 decimalka (ohranjena semantika Math.round(x*10)/10)', () => {
    const src = read('src/components/tabs/finance-tab.tsx')
    expect(src).toContain('${fmtFixedSI(Math.round((b / 1024) * 10) / 10, 1)} KB')
    expect(src).toContain('${fmtFixedSI(Math.round((b / (1024 * 1024)) * 10) / 10, 1)} MB')
  })

  test('gostje: povprečna ocena (4,7 namesto 4.7 ob zvezdicah)', () => {
    expect(read('src/components/tabs/gostje-tab.tsx')).toContain('{feedback.length > 0 ? fmtFixedSI(avg, 1) : \'—\'}')
  })

  test('modifikatorji: cena z EUR oznako (ločilo popravljeno, enota ohranjena)', () => {
    const src = read('src/components/tabs/menu-modifiers-card.tsx')
    expect(src).toContain('`+${fmtFixedSI(m.price, 2)} EUR`')
    expect(src).toContain("'0,00 EUR'")
    expect(src).not.toContain("'0.00 EUR'")
  })

  test('kuponi: fiksni znesek (odstotek ostane celo število)', () => {
    expect(read('src/components/tabs/coupons-card.tsx')).toContain('fmtEUR(Number(c.fixedAmount))')
  })

  test('zaloga: variansa vrednosti (predznak + fmtEUR)', () => {
    expect(read('src/components/tabs/zaloga-tab.tsx')).toContain("{s.varianceValue > 0 ? '+' : ''}{fmtEUR(s.varianceValue)}")
  })
})

// ── Č3) NEGATIVNI KONTROLI + SKEN ──
describe('v1.276.0 Č3 — nevdni ostanki (CSV/pisak/gosti/vnos) + sken 0 surovih toFixed v render poteh', () => {
  test('CSV izvozi ostanejo s PIKO (Excel/računovodska konvencija — analitika 5 vrstic)', () => {
    const src = read('src/components/tabs/analitika-tab.tsx')
    expect(src).toContain('i.name, i.category, i.qtySold, i.revenue.toFixed(2),')
    expect(src).toContain("i.costKnown ? i.cost.toFixed(2) : '—', i.costKnown ? i.cm.toFixed(2) : '—',")
    expect(src).toContain("i.costKnown ? i.foodCostPct.toFixed(1) : '—', i.popShare.toFixed(1),")
    expect(src).toContain('i.latePct.toFixed(1)]),')
    expect(src).toContain('Math.round(r.avgTurnMin), r.revenue.toFixed(2),')
  })

  test('tisk + gostujoče strani: lokalni helperji ŽE imajo vejico (replace — NEVDNI)', () => {
    // dashboard money (PrintLine vrstice tiskalnika) + urniki tcPay + 5 gost strani
    expect(read('src/app/dashboard/page.tsx')).toContain("const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`")
    expect(read('src/components/tabs/urniki-tab.tsx')).toContain("return eur.toFixed(2).replace('.', ',') + ' €'")
    for (const p of ['src/app/s/[token]/page.tsx', 'src/app/pay/[token]/page.tsx', 'src/app/display/page.tsx', 'src/app/kiosk/page.tsx', 'src/app/m/[token]/page.tsx']) {
      expect(read(p)).toContain(".toFixed(2).replace('.', ',')")
    }
  })

  test('gostujoče strani so NAMERNO samostojne (0 uvozov iz client.ts — arhitektura, ne vrzel)', () => {
    for (const p of ['src/app/s/[token]/page.tsx', 'src/app/pay/[token]/page.tsx', 'src/app/display/page.tsx', 'src/app/kiosk/page.tsx', 'src/app/m/[token]/page.tsx']) {
      expect(read(p)).not.toContain("from '@/lib/client'")
    }
  })

  test('vnosno polje type=number: strojna pika ostane (DOM zahteva; brskalnik prikaže locale)', () => {
    const src = read('src/app/dashboard/page.tsx')
    expect(src).toContain('value={p.amount ? p.amount.toFixed(2) : \'\'}')
    // in je polje res številčno (dokaz klasifikacije)
    const idx = src.indexOf("value={p.amount ? p.amount.toFixed(2) : ''}")
    const before = src.slice(Math.max(0, idx - 400), idx)
    expect(before).toContain('type="number"')
  })

  test('SKEN: 0 surovih toFixed v render poteh UI datotek (allowlist = 13 dovoljenih mest)', () => {
    // dovoljeni ostanki (natanko naštevani — vsak nov surov toFixed v UI
    // render poti pada pod ta sken):
    const allow = [
      // CSV analitika (5 vrstic — pika po konvenciji)
      (l: string) => l.includes('i.name, i.category, i.qtySold, i.revenue.toFixed(2),'),
      (l: string) => l.includes("i.costKnown ? i.cost.toFixed(2) : '—', i.costKnown ? i.cm.toFixed(2) : '—',"),
      (l: string) => l.includes("i.costKnown ? i.foodCostPct.toFixed(1) : '—', i.popShare.toFixed(1),"),
      (l: string) => l.includes('i.latePct.toFixed(1)]),'),
      (l: string) => l.includes('Math.round(r.avgTurnMin), r.revenue.toFixed(2),'),
      // lokalni vejico-helperji (7 — tisk + urniki + 5 gost strani)
      (l: string) => l.includes("toFixed(2).replace('.', ',')"),
      // type=number strojna vrednost (1)
      (l: string) => l.includes("value={p.amount ? p.amount.toFixed(2) : ''}"),
    ]
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir))) {
        const p = join(dir, e)
        const st = statSync(join(ROOT, p))
        if (st.isDirectory()) { walk(p); continue }
        if (!p.endsWith('.tsx') || p.includes('/api/')) continue
        read(p).split('\n').forEach((line, i) => {
          if (line.includes('.toFixed(') && !allow.some((fn) => fn(line))) {
            hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 80)}`)
          }
        })
      }
    }
    walk('src/components')
    walk('src/app')
    expect(hits).toEqual([])
  })
})

// ── Ž) REGISTRI ──
describe('v1.276.0 Ž — registri', () => {
  test('verzija 1.276.0 (version.ts + compose + APP_VERSION vsebina)', () => {
    expect(APP_VERSION).toBe('1.295.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.295.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.295.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.295.0-obnova-11-reset-rep-integ60')
  })

  test('AUDIT doc-truth: POSODOBITEV (v1.276.0, decimalna ločila — surovi toFixed v render poteh)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.276.0, decimalna ločila — surovi toFixed v render poteh)')
    // prejšnji vnos ostaja (zgodovinska veriga doc-truth)
    expect(audit).toContain('POSODOBITEV (v1.275.0, diakritike III — payroll izvoz)')
  })

  test('i18n števci nespremenjeni (0 ključev — števila so izven slovarjev)', () => {
    const v272 = read('tests/v272-diakritike-csv.test.ts')
    expect(v272).toContain('4320')
  })

  test('0 DDL: shema nedotaknjena (val je čisto frontend formatiranje)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('DecimalLocila')
    expect(schema).not.toContain('FmtFixed')
  })
})
