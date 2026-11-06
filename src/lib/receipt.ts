/**
 * NATISLJIVI FURS/HR RAČUN — odjemalska generacija tiskalniškega prikaza (80 mm stil).
 * Odpre pojavno okno z računom in sproži tiskanje (v brskalniku je mogoče izbrati
 * tudi »Shrani kot PDF«). Ne potrebuje odvisnosti; črke č/š/ž delujejo izvorno.
 *
 * Dvojezičnost SL/HR (issue #1 triage): jezik izpisa = parameter `locale` (privzeto
 * 'sl' — obstoječi izpis je nespremenjen, §18). Fiskalna pot se loči po državi
 * lokacije (fiskalizacija ni prevodna funkcija): SI → ZOI/EOR (FURS), HR → ZKI/JIR
 * + uradna potrditvena povezava Porezne uprave (Fiskalizacija 2.0, NN 89/2025).
 */

import { t, fiscalStatusLabel, type Locale } from '@/lib/i18n'
import { encodeCode128b, CODE128_QUIET_MODULES } from '@/lib/barcode'

export interface ReceiptItemT {
  name: string
  qty: number
  price: number
  vatRate: number
  amount: number
  /**
   * PRIMERJAVA §37 (v1.263.0) — žig spremembe cene na VRSTICI (§23
   * priceOverride from → to), strukturno aditivno: API (/api/furs/[id])
   * ga na posnetkovih in legacy vrsticah nosi od v1.249.0/§37; tip je
   * neznan, ker ga izris ne bere — samo filter ničelnih postavk ga
   * preverja za PRISOTNOST (poseg natakarja = comp → vrstica PIŠE).
   */
  priceOverride?: unknown
}

export interface ReceiptDetailT {
  id: string
  invoiceNumber: string
  createdAt: string
  printedAt: string | null
  businessName: string
  businessAddress: string
  businessId: string
  taxId: string
  registerId: string
  premisesId: string | null
  zoi: string
  eor: string
  fiscalVerified: boolean
  fiscalStatus: string
  subtotal: number
  discount: number
  totalVat: number
  total: number
  tip: number
  totalWithTip: number
  paymentMethod: string
  isCopy: boolean
  isStorno: boolean
  vatBreakdown: { rate: number; base: number; vat: number }[]
  orderNumber: number | null
  tableName: string | null
  operator: string | null
  items: ReceiptItemT[]
  /** Država lokacije ('SI' | 'HR') — določa fiskalni tok na izpisu (privzeto SI). */
  country?: string
  /** HR fiskalna polja (Fiskalizacija 2.0) */
  zki?: string
  jir?: string
  /** Uradna potrditvena povezava (QR vsebina) za HR račune */
  qr?: string
  /**
   * PRIMERJAVA §37 (v1.263.0) — SKRIVANJE NIČELNIH POSTAVK (Square
   * Vol 16 »Hide $0 items from printed customer receipts«): strežnik
   * prebere politiko (RestaurantSettings.hideZeroReceiptItems,
   * DDL-gated) in jo prilepi na račun — tiskalni kliki so tako
   * neodvisni od pravic nad nastavitvami (nauk §30/§31). Odsotno /
   * undefined = false = byte-identičen izpis dosedanjega stanja.
   */
  hideZeroItems?: boolean
}

const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const pct = (n: number) => `${n.toFixed(1).replace('.', ',')} %`
const SEP = '· · · · · · · · · · · · · · · · · · ·'

/**
 * PRIMERJAVA §37 (v1.263.0) — ali je vrstica računa DODANA PO NIČELNI ceni
 * (Square Vol 16: »items added at $0, like a complimentary basket of bread
 * or a glass of water«)? Posnetek nosi amount = unitPrice × qty, kjer je
 * unitPrice ZAMRZNJENA menijska cena + vsota cen opcij (ops.ts price +
 * modsTotal) in popusti hodijo LOČENO (skupna vrstica) — zato so Square
 * izjeme AVTOMATSKE: plačana postavka (> 0), popust-do-0 (price ostane > 0)
 * in 0-postavka s plačano opcijo (price > 0) imajo amount > 0 in PIŠEJO.
 * Edini kandidat: amount === 0. Četrta (naša) izjema: §23 priceOverride
 * (from → to) je IZRECNI poseg natakarja (comp) — žig prisoten → PIŠE,
 * ne glede na znesek. Defenzivno: ne-končen amount (NaN/undefined) NIKOLI
 * ni skrit — kar ne znamo izmeriti, izpišemo.
 */
export function isZeroAddedReceiptItem(it: ReceiptItemT): boolean {
  if (!Number.isFinite(it.amount)) return false
  if (it.amount !== 0) return false
  return it.priceOverride === undefined || it.priceOverride === null
}

/**
 * PRIMERJAVA §37 (v1.263.0) — postavke za IZRIS odjemalskega računa.
 * Ob d.hideZeroItems === true se 0-dodane vrstice (isZeroAddedReceiptItem)
 * izpustijo — SAMO v izrisu: posnetek (itemsJson) in kuhanjski listki
 * ostanejo popolni (Square: »transaction records … include $0 items
 * either way«). Prag poštenosti: če filter pošteni CEL seznam (izjemen
 * rob — račun s SAMO ničelnimi postavkami), izpis pade na poln seznam —
 * natisnjen fiskalni dokument NIKOLI ne sme imeti prazne tabele postavk.
 * Filter izklopljen (undefined/false) → ISTA referenca (brez kopije).
 */
export function receiptDisplayItems(d: ReceiptDetailT): ReceiptItemT[] {
  if (!d.hideZeroItems) return d.items
  const visible = d.items.filter((it) => !isZeroAddedReceiptItem(it))
  return visible.length > 0 ? visible : d.items
}

export function buildReceiptHTML(d: ReceiptDetailT, footer?: string | null, locale: Locale = 'sl'): string {
  const tr = (key: string, vars?: Record<string, string | number>) => t(locale, key, vars)
  const country = (d.country || 'SI').toUpperCase()
  const isHr = country === 'HR'
  const bcp = isHr ? 'hr-HR' : 'sl-SI'

  // PRIMERJAVA §37 (v1.263.0): izris teče čez receiptDisplayItems —
  // 0-dodane vrstice (kruh na hišni račun, voda) se ob vklopu politike
  // izpustijo SAMO tukaj; posnetek/kuhinja/poročila ostanejo popolni.
  const items = receiptDisplayItems(d)
    .map(
      (i) => `<tr>
        <td class="q">${i.qty}×</td>
        <td>${esc(i.name)} <span class="vat">(${pct(i.vatRate)})</span></td>
        <td class="r">${money(i.amount)}</td>
      </tr>`,
    )
    .join('')

  const vatRows = d.vatBreakdown
    .map(
      (v) => `<tr class="small">
        <td colspan="2">${esc(tr('receipt.vatRate', { rate: pct(v.rate), base: money(v.base) }))}</td>
        <td class="r">${money(v.vat)}</td>
      </tr>`,
    )
    .join('')

  const extraRows = [
    d.discount > 0 ? `<tr><td colspan="2">${esc(tr('receipt.discount'))}</td><td class="r">−${money(d.discount)}</td></tr>` : '',
    d.tip > 0 ? `<tr><td colspan="2">${esc(tr('receipt.tip'))}</td><td class="r">${money(d.tip)}</td></tr>` : '',
  ].join('')

  // Fiskalne vrstice po državi: SI (ZOI/EOR) ali HR (ZKI/JIR + potrditvena povezava)
  const fiscalRows = isHr
    ? `<p class="small">${esc(tr('receipt.zki'))} <span class="mono">${esc(d.zki || '—')}</span></p>
    <p class="small">${esc(tr('receipt.jir'))} <span class="mono">${esc(d.jir || '—')}</span></p>${d.qr ? `
    <p class="small mono">${esc(tr('receipt.hrCheck', { url: d.qr }))}</p>` : ''}`
    : `<p class="small">ZOI: <span class="mono">${esc(d.zoi || '—')}</span></p>
    <p class="small">EOR: <span class="mono">${esc(d.eor || '—')}</span></p>`

  const taxLine = isHr
    ? `${esc(tr('receipt.taxNo'))} ${esc(d.taxId || '—')}`
    : `${esc(tr('receipt.taxNo'))} ${esc(d.taxId || '—')}${d.businessId ? ` · ${esc(tr('receipt.registrationNo'))} ${esc(d.businessId)}` : ''}`

  // v1.251.0 (PRIMERJAVA §25): ČRTNA KODA RAČUNA — Code128-B vsebine
  // receiptNumber (številka je že natisnjena zgoraj → ročni vnos = ista
  // vrsta; Toast januar 2026 »look up checks by scanning the receipt
  // barcode«). Neenkodirljiva številka (znak izven ASCII 32–126) črtno kodo
  // tiho izpusti — tisk računa NIKOLI ne sme pasti (§18 print disciplina).
  const bc = encodeCode128b(d.invoiceNumber || '')
  let barcodeSvg = ''
  if (bc) {
    const quiet = CODE128_QUIET_MODULES
    const viewW = bc.totalModules + quiet * 2
    const rects: string[] = []
    let x = quiet
    for (let i = 0; i < bc.widths.length; i++) {
      const w = bc.widths[i]
      if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="60"/>`)
      x += w
    }
    const caption = `<p class="c small mono">${esc(d.invoiceNumber)}</p>`
    barcodeSvg = `<div class="bcwrap"><svg class="bc" viewBox="0 0 ${viewW} 60" width="100%" height="44" preserveAspectRatio="none" role="img" aria-label="${esc(d.invoiceNumber)}"><rect x="0" y="0" width="${viewW}" height="60" fill="#fff"/>${rects.join('')}</svg>${caption}</div>`
  }

  return `<!doctype html>
<html lang="${isHr ? 'hr' : 'sl'}">
<head>
<meta charset="utf-8">
<title>${esc(tr('receipt.title', { number: d.invoiceNumber }))}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Courier New', Courier, monospace; font-size: 12px; color: #111; background: #fff; padding: 8px; }
  .rc { max-width: 76mm; margin: 0 auto; }
  h1 { font-size: 15px; text-align: center; letter-spacing: 1px; margin-bottom: 2px; text-transform: uppercase; }
  .c { text-align: center; }
  .r { text-align: right; white-space: nowrap; }
  .q { text-align: right; white-space: nowrap; padding-right: 6px; }
  .small { font-size: 10.5px; }
  .vat { color: #555; font-size: 10px; }
  .mono { word-break: break-all; font-size: 10px; }
  p { margin: 2px 0; line-height: 1.45; }
  .sep { text-align: center; margin: 6px 0; letter-spacing: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; }
  td { padding: 1.5px 0; vertical-align: top; }
  .totals td { padding: 2px 0; }
  .grand { font-size: 14px; font-weight: bold; border-top: 1px dashed #111; padding-top: 4px; }
  .footer { margin-top: 8px; white-space: pre-line; }
  .bcwrap { margin-top: 6px; }
  .bc { display: block; max-width: 68mm; margin: 0 auto; }
  .bcwrap .mono { margin: 1px 0 0; }
  .copy { margin-top: 6px; text-align: center; border: 1px solid #111; padding: 2px; letter-spacing: 2px; }
  @media print { body { padding: 0; } .rc { max-width: none; } }
</style>
</head>
<body>
  <div class="rc">
    <h1>${esc(d.businessName || 'RestaurantOS')}</h1>
    ${d.businessAddress ? `<p class="c small">${esc(d.businessAddress)}</p>` : ''}
    <p class="c small">${taxLine}</p>
    <p class="c small">${esc(tr('receipt.premises'))} ${esc(d.premisesId || d.businessId || 'BLG-001')} · ${esc(tr('receipt.register'))} ${esc(d.registerId || 'BLG-001')}</p>
    <p class="sep">${SEP}</p>
    <p>${esc(tr('receipt.number'))} <b>${esc(d.invoiceNumber)}</b><br/>
       ${esc(tr('receipt.issuedAt'))} ${esc(new Date(d.createdAt).toLocaleString(bcp))}<br/>
       ${d.tableName ? `${esc(d.tableName)}<br/>` : ''}${d.orderNumber != null ? `${esc(tr('receipt.order', { n: d.orderNumber }))}<br/>` : ''}${d.operator ? `${esc(tr('receipt.operator'))} ${esc(d.operator)}` : ''}</p>
    <p class="sep">${SEP}</p>
    ${items ? `<table>${items}</table>` : `<p class="small c">${esc(tr('receipt.noItems'))}</p>`}
    <p class="sep">${SEP}</p>
    <table class="totals">
      ${extraRows}
      <tr class="small"><td colspan="2">${esc(tr('receipt.netTotal'))}</td><td class="r">${money(d.subtotal)}</td></tr>
      ${vatRows}
      <tr class="small"><td colspan="2">${esc(tr('receipt.vatTotal'))}</td><td class="r">${money(d.totalVat)}</td></tr>
      <tr class="grand"><td colspan="2">${esc(tr('receipt.grandTotal'))}</td><td class="r">${money(d.totalWithTip > 0 ? d.totalWithTip : d.total)}</td></tr>
    </table>
    <p>${esc(tr('receipt.paymentMethod'))} <b>${esc((d.paymentMethod || 'cash').toUpperCase())}</b></p>
    <p class="sep">${SEP}</p>
    ${fiscalRows}
    <p class="c small">${esc(fiscalStatusLabel(locale, country, d.fiscalStatus, d.fiscalVerified))}</p>
    ${barcodeSvg}
    ${footer ? `<p class="c small footer">${esc(footer)}</p>` : ''}
    ${d.isCopy ? `<p class="copy small">${esc(tr('receipt.copy'))}</p>` : ''}
    ${d.isStorno ? `<p class="copy small">${esc(tr('receipt.storno'))}</p>` : ''}
  </div>
</body>
</html>`
}

/** Odpre pojavno okno z računom in sproži tiskanje (uporabnik lahko izbere »Shrani kot PDF«). */
export function printReceipt(d: ReceiptDetailT, footer?: string | null, locale: Locale = 'sl'): boolean {
  const w = window.open('', 'ro_receipt', 'width=440,height=680')
  if (!w) return false
  w.document.open()
  w.document.write(buildReceiptHTML(d, footer, locale))
  w.document.close()
  setTimeout(() => {
    try { w.focus(); w.print() } catch { /* headless / zavrzeno okno — vsebina ostane odprta */ }
  }, 350)
  return true
}
