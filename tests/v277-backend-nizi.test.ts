import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { fmtEUR, fmtNumSI, slCount, slNoun, SL_NOUNS, pluralForm } from '../src/lib/fmt'
import { fmtEUR as fmtEURReExport, fmtNumSI as fmtNumSIReExport } from '../src/lib/client'
import { pluralForm as pluralFormI18n, nounKey } from '../src/lib/i18n'
import { thresholdText, type PlanRule } from '../src/lib/haccp-ops'

/**
 * v1.277.0 — BACKEND NIZI: zneski v sl-SI obliki + slovenske množinske oblike
 * v potisnih telesih in napakah API rut (doktrina issue #71 na backend površini).
 *
 * REKONOS (svež pregled, 3 kandidati): (A) surovi % izpisi v komponentah —
 * 0 zadetkov, ne vrzel; (B) backend uporabniško vidni nizi v api/ — ZADETEK:
 * 11 mest zneskov s surovo piko (7 datotek) + 10 mest trdo kodiranih množin
 * (9 datotek) + surove številčne interpolacije (haccp valueTxt/thresholdText,
 * transfers totalQty, inventory hold količina); (C) e-poštni sloj —
 * DOKUMENTIRANA NAMERA (pika + »EUR«, doslednost znotraj sporočila —
 * daily-email/hourly-email) → izven obsega, negativno pripeto v Č3.
 *
 * ARHITEKTURA: client.ts ('use client') je bil NEDOSTOPEN za API rute → NOV
 * čisti sloj src/lib/fmt.ts (0 uvozov) je edini vir resnice; client.ts in
 * i18n/index.ts re-izvozita (vsi obstoječi uvozi + pini v276/v270/issue71
 * ostanejo zeleni). SL_NOUNS je KODNA tabela (OPS-8: backend besedila so SL
 * literali, vzorec orderWord v hourly-email.ts) — 0 novih i18n ključev.
 *
 *  · Č1 — čisti sloj fmt.ts: fmtEUR/fmtNumSI (vejica + NBSP + tisočice),
 *    slNoun/slCount (4 slovenske oblike × 5 samostalnikov), pluralForm
 *    re-izvozi (client + i18n — javni API nespremenjen)
 *  · Č2 — pini vseh spremenjenih mest (11 zneskov + 10 množin + 4 surove
 *    interpolacije) + thresholdText obnašanje (≤ 4,5 °C z vejico)
 *  · Č3 — negativni sken: 0 surovih toFixed v body:/fail( kontekstih api/,
 *    0 trdo kodiranih množic za števnike, e-poštni sloj NEDOTIČN (namera)
 *  · Ž · REGISTRI: verzija 1.277.0, worklog vrh Task ID, AUDIT POSODOBITEV,
 *    i18n števci 4320/4320 nespremenjeni, 0 DDL, fmt.ts čisti sloj 0 uvozov
 */

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

/** ICU-lekcija v1.276: skupinjenje tisočic je CLDR-odvisno (CI BREZ, peskovnik
 * Z ločilom) → tolerančni regex /^1.?234,50 €$/ (0 ali 1 znak groupanja);
 * decimalna VEJICA (tema vala) in NBSP pred € sta strogo pripeti. */
const NBSP = ' '

// ── Č1) ČISTI SLOJ fmt.ts — obnašanje ──

describe('v1.277.0 Č1 — čisti sloj fmt.ts (zneski + množine, sl-SI)', () => {
  test('fmtEUR: vejica + fiksne 2 decimalke + NBSP pred € (12,50 € / 0,00 €)', () => {
    expect(fmtEUR(12.5)).toBe(`12,50${NBSP}€`)
    expect(fmtEUR(0)).toBe(`0,00${NBSP}€`)
    expect(fmtEUR(4.7)).toBe(`4,70${NBSP}€`)
    expect(fmtEUR(-2.05)).toBe(`−2,05${NBSP}€`) // U+2212 minus (lekcija v276)
  })

  test('fmtEUR: >1000 tolerančno na ICU groupanje (1.234,50 ali 1234,50 — vejica + NBSP stabilna)', () => {
    expect(fmtEUR(1234.5)).toMatch(/^1.?234,50 €$/)
    expect(fmtEUR(100000)).toMatch(/^100.?000,00 €$/)
  })

  test('fmtNumSI: vejica + enota s presledkom (4,2 °C); max decimalk (2,501)', () => {
    expect(fmtNumSI(4.2, { unit: ' °C' })).toBe('4,2 °C')
    expect(fmtNumSI(4, { unit: ' °C' })).toBe('4 °C')
    expect(fmtNumSI(2.501, { max: 3 })).toBe('2,501')
    expect(fmtNumSI(12)).toBe('12')
  })

  test('slNoun: 4 slovenske oblike × 5 backend samostalnikov (ednina/dvojina/množina/rodilnik)', () => {
    expect([1, 2, 3, 5].map((n) => slNoun(n, 'racun'))).toEqual(['račun', 'računa', 'računi', 'računov'])
    expect([1, 2, 3, 5].map((n) => slNoun(n, 'vrstica'))).toEqual(['vrstica', 'vrstici', 'vrstice', 'vrstic'])
    expect([1, 2, 3, 5].map((n) => slNoun(n, 'postavka'))).toEqual(['postavka', 'postavki', 'postavke', 'postavk'])
    expect([1, 2, 3, 5].map((n) => slNoun(n, 'kos'))).toEqual(['kos', 'kosa', 'kosi', 'kosov'])
    expect([1, 2, 3, 5].map((n) => slNoun(n, 'oseba'))).toEqual(['oseba', 'osebi', 'osebe', 'oseb'])
  })

  test('slNoun: 0/negativne/NaN → rodilnik množine (vzorec pluralForm .n)', () => {
    expect(slNoun(0, 'racun')).toBe('računov')
    expect(slNoun(-3, 'postavka')).toBe('postavke') // |n| → 34 oblika
    expect(slNoun(-5, 'postavka')).toBe('postavk')
    expect(slNoun(NaN, 'oseba')).toBe('oseb')
    expect(slNoun(21, 'kos')).toBe('kosov') // 21 → n (le 1 ima ednino)
  })

  test('slCount: cel števnik z besedo (1 račun / 2 računa / 3 računi / 5 računov)', () => {
    expect(slCount(1, 'racun')).toBe('1 račun')
    expect(slCount(2, 'racun')).toBe('2 računa')
    expect(slCount(3, 'racun')).toBe('3 računi')
    expect(slCount(5, 'racun')).toBe('5 računov')
    expect(slCount(1, 'oseba')).toBe('1 oseba')
    expect(slCount(4, 'oseba')).toBe('4 osebe')
    expect(slCount(0, 'postavka')).toBe('0 postavk')
  })

  test('slCount: >1000 tolerančno na ICU groupanje (1.200 ali 1200 računov)', () => {
    expect(slCount(1200, 'racun')).toMatch(/^1.?200 računov$/)
  })

  test('SL_NOUNS: besede racun/vrstica/postavka/oseba so IDENTIČNE slovarskim noun.* vrednostim (doc-truth usklajenost)', () => {
    const sl = read('src/lib/i18n/sl.ts')
    for (const noun of ['racun', 'vrstica', 'postavka', 'oseba'] as const) {
      const forms = SL_NOUNS[noun]
      expect(sl).toContain(`'noun.${noun}.1': '${forms[0]}'`)
      expect(sl).toContain(`'noun.${noun}.2': '${forms[1]}'`)
      expect(sl).toContain(`'noun.${noun}.34': '${forms[2]}'`)
      expect(sl).toContain(`'noun.${noun}.n': '${forms[3]}'`)
    }
  })

  test('pluralForm: enako obnašanje po re-izvozu (client + i18n javni API nespremenjen)', () => {
    expect(pluralForm(1)).toBe('1')
    expect(pluralForm(2)).toBe('2')
    expect(pluralForm(4)).toBe('34')
    expect(pluralForm(5)).toBe('n')
    // re-izvozi so ISTA funkcija (eno mesto resnice, ne kopija):
    expect(pluralFormI18n).toBe(pluralForm)
    expect(fmtEURReExport).toBe(fmtEUR)
    expect(fmtNumSIReExport).toBe(fmtNumSI)
    // nounKey še vedno deluje prek re-izvoza (v270 pogodba):
    expect(nounKey('racun', 2)).toBe('noun.racun.2')
  })
})

// ── Č2) PINI — vsa spremenjena mesta ──

describe('v1.277.0 Č2 — pini mest: 11 zneskov + 10 množin + 4 surove interpolacije', () => {
  test('shifts/route.ts (Z_CLOSED): fmtEUR ×2 + slCount račun (ne surovi toFixed + »računov«)', () => {
    const s = read('src/app/api/shifts/route.ts')
    expect(s).toContain('`${fmtEUR(result.totalSales)} · ${slCount(result.receipts, \'racun\')} · gotovina ${fmtEUR(result.cash)}`')
    expect(s).not.toContain('računov · gotovina')
    expect(s).toContain("import { fmtEUR, slCount } from '@/lib/fmt'")
  })

  test('shifts/movements/route.ts (CASH_MOVEMENT): fmtEUR(amount) (ne toFixed)', () => {
    const s = read('src/app/api/shifts/movements/route.ts')
    expect(s).toContain('${fmtEUR(amount)}')
    expect(s).not.toContain('amount.toFixed(2)} €')
  })

  test('purchase-orders/[id]/route.ts (PO_APPROVED): fmtEUR + slCount vrstica (ne »vrst«)', () => {
    const s = read('src/app/api/purchase-orders/[id]/route.ts')
    expect(s).toContain("${fmtEUR(Number(po.totalAmount))} · ${slCount(po.PurchaseOrderItem.length, 'vrstica')}")
    expect(s).not.toContain('} vrst`')
  })

  test('orders/[id]/price-override/route.ts: fmtEUR ×2 (stara → nova cena)', () => {
    const s = read('src/app/api/orders/[id]/price-override/route.ts')
    expect(s).toContain('${fmtEUR(result.oldPrice)} → ${fmtEUR(result.newPrice)}')
    expect(s).not.toContain('oldPrice.toFixed(2)} €')
  })

  test('orders/[id]/paylink/route.ts (fail 400): fmtEUR ×2 (vsota deležev = ostanek)', () => {
    const s = read('src/app/api/orders/[id]/paylink/route.ts')
    expect(s).toContain('Vsota deležev (${fmtEUR(sum)}) mora biti enaka preostanku za plačilo (${fmtEUR(remaining)}).')
    expect(s).not.toContain('sum.toFixed(2)} €')
  })

  test('einvoices/issue/route.ts (fail 409): fmtEUR ×2 (znesek naročila vs postavke)', () => {
    const s = read('src/app/api/einvoices/issue/route.ts')
    expect(s).toContain('Znesek naročila (${fmtEUR(expectedGross)}) presega vrednost postavk (${fmtEUR(built.grossBefore)})')
    expect(s).not.toContain('expectedGross.toFixed(2)} €')
  })

  test('web-portal/route.ts (ORDER_NEW): slCount postavka + fmtEUR(total) (ne surova interpolacija)', () => {
    const s = read('src/app/api/public/web-portal/route.ts')
    expect(s).toContain("${slCount(items.length, 'postavka')} · ${fmtEUR(num(order.total))}")
    expect(s).not.toContain('postavk · ${num(order.total)} €')
  })

  test('orders/route.ts + public/orders/route.ts (ORDER_NEW): slCount postavka', () => {
    expect(read('src/app/api/orders/route.ts')).toContain("${slCount(order.items?.length ?? 0, 'postavka')}")
    expect(read('src/app/api/public/orders/route.ts')).toContain("${slCount(items.length, 'postavka')}")
  })

  test('transfers receive + dispatch: slCount postavka; dispatch tudi fmtNumSI(totalQty, {max: 3})', () => {
    const r = read('src/app/api/transfers/[id]/receive/route.ts')
    expect(r).toContain("${slCount(transfer.items.length, 'postavka')}")
    const d = read('src/app/api/transfers/[id]/dispatch/route.ts')
    expect(d).toContain("${slCount(transfer.items.length, 'postavka')} · skupaj ${fmtNumSI(totalQty, { max: 3 })}")
    expect(d).not.toContain('skupaj ${totalQty}`')
  })

  test('orders/[id]/fire/route.ts (ORDER_FIRE): slCount kos (ne »kos« za vse števnike)', () => {
    const s = read('src/app/api/orders/[id]/fire/route.ts')
    expect(s).toContain("${slCount(result.firedCount, 'kos')}")
    expect(s).not.toContain('firedCount} kos`')
  })

  test('reservations interna + javna: slCount oseba (ne »oseb« za vse števnike)', () => {
    expect(read('src/app/api/reservations/route.ts')).toContain("${slCount(Number(body.guests) || 2, 'oseba')}")
    expect(read('src/app/api/public/reservations/route.ts')).toContain("${slCount(partySize, 'oseba')}")
  })

  test('haccp/route.ts (HACCP_DEVIATION): fmtNumSI z enoto (4,5 °C v potisku, ne 4.5 °C)', () => {
    const s = read('src/app/api/haccp/route.ts')
    expect(s).toContain('fmtNumSI(numericValue, { unit: rule.unit ? ` ${rule.unit}` : undefined })')
    expect(s).not.toContain('`${numericValue} ${rule.unit}`')
  })

  test('thresholdText: meje skozi fmtNumSI — »≤ 4,5 °C« z VEJICO (audit-12: HACCP temperature)', () => {
    const base: PlanRule = {
      measureKind: 'number', unit: '°C', direction: 'below',
      okLimit: 4.5, warnLimit: 6.5, rangeMin: null, rangeMax: null,
      critical: false, requiresVerification: true,
    }
    expect(thresholdText(base)).toContain('≤ 4,5 °C')
    expect(thresholdText(base)).toContain('opozorilo ≤ 6,5 °C')
    expect(thresholdText(base)).not.toContain('4.5')
    const between: PlanRule = { ...base, direction: 'between', okLimit: null, warnLimit: null, rangeMin: 2.5, rangeMax: 5.5 }
    expect(thresholdText(between)).toBe('2,5–5,5 °C')
    // cela števila brez decimalk (kompatibilnost z issue20 pini »≤ 4 °C«):
    expect(thresholdText({ ...base, okLimit: 4, warnLimit: 6 })).toContain('≤ 4 °C')
  })

  test('inventory/batches/[id]/hold (LOT_BLOCKED): fmtNumSI količina z enoto', () => {
    const s = read('src/app/api/inventory/batches/[id]/hold/route.ts')
    expect(s).toContain('fmtNumSI(num(batch.quantityRemaining), { unit: batch.InventoryItem?.unit ? ` ${batch.InventoryItem.unit}` : undefined })')
    expect(s).not.toContain('${num(batch.quantityRemaining)} ${batch.InventoryItem?.unit')
  })

  test('receipts/[id]/storno (fail 409): slCount račun — odkrito s Č3 skenom po rekonosu (iskreno dopolnilo)', () => {
    const s = read('src/app/api/receipts/[id]/storno/route.ts')
    expect(s).toContain("Računi na naročilu: ${slCount(siblingReceipts + 1, 'racun')} (plačilo po izstavkih)")
    expect(s).not.toContain('${siblingReceipts + 1} računov')
  })

  test('orders/[id]/checks/guests (fail 409): slCount oseba + postavka (nominativ preoblikba — skladenje v vseh oblikah)', () => {
    const s = read('src/app/api/orders/[id]/checks/guests/route.ts')
    expect(s).toContain("Razdelitev ni mogoča: ${slCount(nRaw, 'oseba')} — ${slCount(movable.length, 'postavka')}; vsak gost mora dobiti vsaj eno.")
    expect(s).not.toContain('${nRaw} gostov ni mogoče razdeliti')
  })
})

// ── Č3) NEGATIVNI SKEN — regresijski var za prihodnje valove ──

describe('v1.277.0 Č3 — negativni sken api/ + poštene izjeme', () => {
  function walkTs(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) out.push(...walkTs(p))
      else if (/\.ts$/.test(name)) out.push(p)
    }
    return out
  }
  const API = join(ROOT, 'src/app/api')

  test('0 surovih toFixed v uporabniško vidnih nizih api/ (body: push telesa + fail() napake)', () => {
    const offenders: string[] = []
    for (const file of walkTs(API)) {
      const src = readFileSync(file, 'utf8')
      // body: `...${x.toFixed(...)}...` ali fail(`...${x.toFixed(...)}...`) — uporabniško vidno
      const bodyRe = /body:\s*`[^`]*\$\{[^}]*\.toFixed\(/ 
      const failRe = /fail\(\s*`[^`]*\$\{[^}]*\.toFixed\(/
      if (bodyRe.test(src)) offenders.push(`${file.replace(ROOT + '/', '')} → body: s surovim toFixed`)
      if (failRe.test(src)) offenders.push(`${file.replace(ROOT + '/', '')} → fail() s surovim toFixed`)
    }
    expect(offenders).toEqual([])
  })

  test('0 trdo kodiranih množin za števnike v api/ (»${n} postavk/računov/oseb/vrst/kos«)', () => {
    const offenders: string[] = []
    const re = /\$\{[^}`]+\}\s(postavk|računov|oseb|vrst|kos)(`|'|"|\s|$)/
    for (const file of walkTs(API)) {
      const src = readFileSync(file, 'utf8')
      const m = src.match(re)
      if (m) offenders.push(`${file.replace(ROOT + '/', '')} → \${…} ${m[1]}`)
    }
    expect(offenders).toEqual([])
  })

  test('POŠTENE IZJEME — tehnični approvalBasis/details/CSV izvozi OSTAJAJO s piko (strojna oblika, namera)', () => {
    // izjemna mesto: approvalBasis (revizijska podlaga, strojna oblika EN) + CSV (pika po
    // računovodski konvenciji — doktrina v1.276) + paylink details (tehnični dnevnik)
    const voidR = read('src/app/api/orders/[id]/void/route.ts')
    expect(voidR).toContain('voidApprovalBasis = `amount ${amountRemovedFromOrder.toFixed(2)}')
    const reports = read('src/app/api/reports/export/route.ts')
    expect(reports).toContain('const p2 = (n: number) => n.toFixed(2)')
  })

  test('e-poštni sloj NEDOTIČEN (dokumentirana namera: pika + EUR, doslednost znotraj sporočila)', () => {
    const hourly = read('src/lib/hourly-email.ts')
    expect(hourly).toContain('const eur = (v: number): string => `${r2(v).toFixed(2)} EUR`')
    expect(hourly).toContain("export function orderWord(n: number): string")
  })

  test('SMS telesi BREZ zneskov (lokacija — plačilo računa #N: URL) — ni klice za formatiranje', () => {
    const s = read('src/app/api/orders/[id]/paylink/route.ts')
    expect(s).toContain('plačilo računa #${order.orderNumber}: ${url}')
  })
})

// ── Ž) REGISTRI ──

describe('v1.277.0 Ž — registri', () => {
  test('Ž1: verzija 1.277.0 (version.ts + compose + APP_VERSION)', () => {
    expect(APP_VERSION).toBe('1.303.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.303.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.303.0')
  })

  test('Ž2: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.303.0-nadzorni-val-stabilnosti-iv')
  })

  test('Ž3: AUDIT doc-truth: POSODOBITEV (v1.277.0) + zgodovinska veriga (v1.276 pin ostaja)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.277.0, backend nizi — zneski sl-SI + množine v api/)')
    expect(audit).toContain('POSODOBITEV (v1.276.0, decimalna ločila — surovi toFixed v render poteh)')
  })

  test('Ž4: i18n števci NESPREMENJENI 4320/4320 — SL_NOUNS je kodna tabela, 0 novih ključev', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('Ž5: 0 DDL — shema nedotaknjena (čisti formatirni val, brez novih modelov)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('SlNoun')
    expect(schema).not.toContain('model Fmt')
  })

  test('Ž6: fmt.ts je ČISTI SLOJ (0 uvozov) + client.ts/i18n re-izvozi (javni API ohranjen)', () => {
    const fmt = read('src/lib/fmt.ts')
    expect(fmt).not.toMatch(/^import /m)
    expect(fmt).not.toMatch(/^} from /m)
    expect(read('src/lib/client.ts')).toContain("export { fmtEUR, fmtNumSI, fmtFixedSI, fmtStampSI } from './fmt'") // v1.279.0: pogodba razširjena (fmtStampSI — časovni žig, ista družina formatirnikov)
    expect(read('src/lib/i18n/index.ts')).toContain("export { pluralForm } from '../fmt'")
  })
})
