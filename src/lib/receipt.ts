/**
 * NATISLJIVI FURS RAČUN — odjemalska generacija tiskalniškega prikaza (80 mm stil).
 * Odpre pojavno okno z računom in sproži tiskanje (v brskalniku je mogoče izbrati
 * tudi »Shrani kot PDF«). Ne potrebuje odvisnosti; črke č/š/ž delujejo izvorno.
 */

export interface ReceiptItemT {
  name: string
  qty: number
  price: number
  vatRate: number
  amount: number
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
}

const esc = (s: string | null | undefined) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Slovenska oznaka FURS stanja računa */
function fursLabel(d: ReceiptDetailT): string {
  if (d.fiscalVerified) return 'Račun je fiskaliziran (FURS ✓)'
  switch ((d.fiscalStatus || '').toLowerCase()) {
    case 'pending': return 'FURS: potrditev v obdelavi (simulacija)'
    case 'failed': return 'FURS: potrditev ni uspela'
    case 'none': return 'FURS: ni poslano'
    default: return `FURS status: ${d.fiscalStatus || 'neoverjeno'}`
  }
}

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const pct = (n: number) => `${n.toFixed(1).replace('.', ',')} %`
const SEP = '· · · · · · · · · · · · · · · · · · ·'

export function buildReceiptHTML(d: ReceiptDetailT, footer?: string | null): string {
  const items = d.items
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
        <td colspan="2">DDV ${pct(v.rate)} (osnova ${money(v.base)})</td>
        <td class="r">${money(v.vat)}</td>
      </tr>`,
    )
    .join('')

  const extraRows = [
    d.discount > 0 ? `<tr><td colspan="2">Popust</td><td class="r">−${money(d.discount)}</td></tr>` : '',
    d.tip > 0 ? `<tr><td colspan="2">Namig</td><td class="r">${money(d.tip)}</td></tr>` : '',
  ].join('')

  return `<!doctype html>
<html lang="sl">
<head>
<meta charset="utf-8">
<title>Račun ${esc(d.invoiceNumber)}</title>
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
  .copy { margin-top: 6px; text-align: center; border: 1px solid #111; padding: 2px; letter-spacing: 2px; }
  @media print { body { padding: 0; } .rc { max-width: none; } }
</style>
</head>
<body>
  <div class="rc">
    <h1>${esc(d.businessName || 'RestavrantOS')}</h1>
    ${d.businessAddress ? `<p class="c small">${esc(d.businessAddress)}</p>` : ''}
    <p class="c small">Davčna št.: ${esc(d.taxId || '—')}${d.businessId ? ` · Matična: ${esc(d.businessId)}` : ''}</p>
    <p class="c small">Poslovni prostor: ${esc(d.premisesId || d.businessId || 'BLG-001')} · Blagajna: ${esc(d.registerId || 'BLG-001')}</p>
    <p class="sep">${SEP}</p>
    <p>Račun št.: <b>${esc(d.invoiceNumber)}</b><br/>
       Datum izdaje: ${esc(new Date(d.createdAt).toLocaleString('sl-SI'))}<br/>
       ${d.tableName ? `${esc(d.tableName)}<br/>` : ''}${d.orderNumber != null ? `Naročilo #${d.orderNumber}<br/>` : ''}${d.operator ? `Operater: ${esc(d.operator)}` : ''}</p>
    <p class="sep">${SEP}</p>
    ${items ? `<table>${items}</table>` : '<p class="small c">(brez postavk)</p>'}
    <p class="sep">${SEP}</p>
    <table class="totals">
      ${extraRows}
      <tr class="small"><td colspan="2">Vsota brez DDV</td><td class="r">${money(d.subtotal)}</td></tr>
      ${vatRows}
      <tr class="small"><td colspan="2">DDV skupaj</td><td class="r">${money(d.totalVat)}</td></tr>
      <tr class="grand"><td colspan="2">SKUPAJ ZA PLAČILO</td><td class="r">${money(d.totalWithTip > 0 ? d.totalWithTip : d.total)}</td></tr>
    </table>
    <p>Plačilo: <b>${esc((d.paymentMethod || 'cash').toUpperCase())}</b></p>
    <p class="sep">${SEP}</p>
    <p class="small">ZOI: <span class="mono">${esc(d.zoi || '—')}</span></p>
    <p class="small">EOR: <span class="mono">${esc(d.eor || '—')}</span></p>
    <p class="c small">${esc(fursLabel(d))}</p>
    ${footer ? `<p class="c small footer">${esc(footer)}</p>` : ''}
    ${d.isCopy ? '<p class="copy small">KOPIJA RAČUNA</p>' : ''}
    ${d.isStorno ? '<p class="copy small">STORNO RAČUN</p>' : ''}
  </div>
</body>
</html>`
}

/** Odpre pojavno okno z računom in sproži tiskanje (uporabnik lahko izbere »Shrani kot PDF«). */
export function printReceipt(d: ReceiptDetailT, footer?: string | null): boolean {
  const w = window.open('', 'ro_receipt', 'width=440,height=680')
  if (!w) return false
  w.document.open()
  w.document.write(buildReceiptHTML(d, footer))
  w.document.close()
  setTimeout(() => {
    try { w.focus(); w.print() } catch { /* headless / zavrzeno okno — vsebina ostane odprta */ }
  }, 350)
  return true
}
