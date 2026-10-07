'use client'

/**
 * Tiskalniški adapterji (issue #1, naloga 2: realne naprave — simulator jasno ločen).
 * Cilji (per-device localStorage konfiguracija):
 *  - 'browser'   — window.print (80mm HTML, gonilnik/OS tiskalnik ali Shrani kot PDF)
 *  - 'agent'     — mini-services/print-agent (port 3031) → ESC/POS cp852 po TCP 9100
 *  - 'simulator' — potrdi potek brez naprave (jasno označena simulacija)
 */

export type PrintTarget = 'browser' | 'agent' | 'simulator'

export interface PrintConfig {
  target: PrintTarget
  host: string
  port: number
}

export interface PrintLine {
  text: string
  align?: 'left' | 'center' | 'right'
  bold?: boolean
  size?: 'normal' | 'large'
}

const CONFIG_KEY = 'ro_print_config'

export function getPrintConfig(): PrintConfig {
  if (typeof window === 'undefined') return { target: 'browser', host: '', port: 9100 }
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PrintConfig>
      return {
        target: (['browser', 'agent', 'simulator'] as const).includes(parsed.target as PrintTarget)
          ? (parsed.target as PrintTarget)
          : 'browser',
        host: parsed.host || '192.168.1.100',
        port: Number(parsed.port) || 9100,
      }
    }
  } catch { /* fallback spodaj */ }
  return { target: 'browser', host: '192.168.1.100', port: 9100 }
}

export function savePrintConfig(cfg: PrintConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

export interface PrintResult {
  ok: boolean
  simulated?: boolean
  error?: string
}

/** Natisni dokument prek konfiguriranega cilja (posamezne vrstice + stil) */
export async function printLines(title: string, lines: PrintLine[]): Promise<PrintResult> {
  const cfg = getPrintConfig()
  if (cfg.target === 'simulator') {
    // jasno ločena simulacija (issue #1: "simulator mora biti jasno ločen od realne integracije")
    console.info(`[PRINT SIMULATOR] ${title}`, lines.map((l) => l.text).join('\n'))
    return { ok: true, simulated: true }
  }
  if (cfg.target === 'agent') {
    const res = await fetch('/layout?XTransformPort=3031', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: cfg.host,
        port: cfg.port,
        title,
        lines,
      }),
    })
    const data = (await res.json()) as { ok: boolean; error?: string }
    return data.ok ? { ok: true } : { ok: false, error: data.error || 'Tiskalnik ni odziven.' }
  }
  // browser: 80mm HTML okno + window.print
  printLinesBrowser(title, lines)
  return { ok: true }
}

/** 80mm HTML izris (isti stil kot računi) */
function printLinesBrowser(title: string, lines: PrintLine[]) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = lines
    .map((l) => {
      const align = l.align === 'center' ? 'center' : l.align === 'right' ? 'right' : 'left'
      const weight = l.bold ? '700' : '400'
      const size = l.size === 'large' ? '15px' : '12px'
      return `<div style="text-align:${align};font-weight:${weight};font-size:${size};margin:1px 0;">${esc(l.text)}</div>`
    })
    .join('')
  const html = `<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { font-family: 'Courier New', monospace; width: 72mm; color: #000; background: #fff; }
  h1 { font-size: 14px; text-align: center; margin: 4px 0 8px; }
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`
  const w = window.open('', '_blank', 'width=380,height=640')
  if (!w) {
    alert('Brskalnik je blokiral pojavno okno za tisk. Dovoli pojavna okna ali preklopi tiskalniški cilj v Nastavitvah.')
    return
  }
  w.document.write(html)
  w.document.close()
  w.focus()
  w.print()
}

/** Kuhinjski list (issue #1: kuhinjski tisk) */
export function buildKitchenTicketLines(order: {
  orderNumber?: number
  tableName?: string | null
  type?: string
  createdAt?: string
  employeeName?: string | null
  items: { name: string; qty: number; note?: string | null; station?: string | null }[]
}, stationFilter?: 'KITCHEN' | 'BAR'): PrintLine[] {
  const now = new Date()
  const time = now.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
  const items = stationFilter
    ? order.items.filter((i) => (i.station || '').toUpperCase() === stationFilter)
    : order.items
  const out: PrintLine[] = [
    { text: stationFilter === 'BAR' ? '=== BAR LIST ===' : stationFilter === 'KITCHEN' ? '=== KUHINJSKI LIST ===' : '=== KUHINJA ===', align: 'center', bold: true, size: 'large' },
    { text: `Naročilo #${order.orderNumber ?? '?'}   ${time}`, bold: true },
    { text: order.tableName ? `Miza: ${order.tableName}` : `Tip: ${order.type || 'DINE_IN'}` },
  ]
  if (order.employeeName) out.push({ text: `Natakar: ${order.employeeName}` })
  out.push({ text: '--------------------------------' })
  for (const it of items) {
    out.push({ text: `${it.qty}× ${it.name}`, bold: true, size: 'large' })
    if (it.note) out.push({ text: `   opomba: ${it.note}` })
  }
  out.push({ text: '--------------------------------' })
  out.push({ text: `Št. artiklov: ${items.reduce((s, i) => s + i.qty, 0)}` })
  return out
}
