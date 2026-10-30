'use client'

/**
 * Tiskalniški adapterji (issue #1, naloga 2: realne naprave — simulator jasno ločen).
 * Cilji (per-device localStorage konfiguracija):
 *  - 'browser'   — window.print (80mm HTML, gonilnik/OS tiskalnik ali Shrani kot PDF)
 *  - 'agent'     — mini-services/print-agent (port 3031) → ESC/POS cp852 po TCP 9100
 *  - 'simulator' — potrdi potek brez naprave (jasno označena simulacija)
 */

import { allergenLabels } from '@/lib/allergen-catalog'
import { getToken } from '@/lib/client'

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
  /**
   * Issue #3 §C (P0) — ACK status za /api/print/ack evidenco:
   * 'sent' = bajti dostavljeni do tiskalnikove vtičnice (agent pot, BREZ
   * potrditve tiska); 'printed' = izrisan v brskalniku (window.print). agent
   * pot nastavi 'sent', ker dostava do jedra ≠ potrjen tisk — print-agent sam
   * priznava z note 'delivered-to-kernel' in NE bere statusa tiskalnika.
   */
  ackStatus?: 'sent' | 'printed'
}

/** Issue #10 P2-3 — opcijski kontekst ACK-evidence (nič od tega ne vpliva na tisk). */
export interface PrintContext {
  kind?: 'receipt' | 'kitchen' | 'bar' | 'report' | 'other' | 'label'
  refId?: string
}

/**
 * Issue #10 P2-3 — fire-and-forget ACK na /api/print/ack (strežniška evidenca poskusov).
 * TIHO: napaka ACK-a je ves čas ignorirana — tiskanje mora delovati tudi brez njega (§18).
 */
function sendPrintAck(title: string, target: PrintTarget, res: PrintResult, ctx?: PrintContext, device = ''): void {
  try {
    const kind = ctx?.kind || inferKindFromTitle(title)
    // FIX (E2E 8-e2e): /api/print/ack je requireAuth — brez Bearer glave je bil vsak
    // ACK iz brskalnika 401 in PrintJob evidenca tiskov NIKOLI ni nastala (vidno
    // šele v živem toku #24: simulator je izpisal etiketo, dokaz pa mankal).
    const token = getToken()
    void fetch('/api/print/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      keepalive: true,
      body: JSON.stringify({
        kind,
        refId: ctx?.refId || '',
        target,
        // Issue #3 §C: agent → 'sent', browser → 'printed' (izris v tiskalniško
        // pogovorno okno je izrecno dokumentiran kot izjema), simulator ostane 'simulated'
        status: res.simulated ? 'simulated' : res.ok ? (res.ackStatus ?? 'printed') : 'failed',
        error: res.error || '',
        device,
      }),
    }).catch(() => undefined)
  } catch { /* tih — ACK nikoli ne sme vplivati na tisk */ }
}

function inferKindFromTitle(title: string): PrintContext['kind'] {
  const t = (title || '').toUpperCase()
  if (t.includes('KUHINJ')) return 'kitchen'
  if (t.includes('BAR')) return 'bar'
  if (t.includes('RAČUN') || t.includes('RACUN') || t.includes('DOKLAD')) return 'receipt'
  if (t.includes('ETIKET')) return 'label'
  return 'other'
}

/** Natisni dokument prek konfiguriranega cilja (posamezne vrstice + stil). ctx = opcijska ACK evidenca (issue #10) */
export async function printLines(title: string, lines: PrintLine[], ctx?: PrintContext): Promise<PrintResult> {
  const cfg = getPrintConfig()
  if (cfg.target === 'simulator') {
    // jasno ločena simulacija (issue #1: "simulator mora biti jasno ločen od realne integracije")
    console.info(`[PRINT SIMULATOR] ${title}`, lines.map((l) => l.text).join('\n'))
    const res: PrintResult = { ok: true, simulated: true }
    sendPrintAck(title, 'simulator', res, ctx)
    return res
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
    // Issue #3 §C: agent ok = ESC/POS bajti odpihnjeni do jedra socket BREZ napake —
    // dobi oznako 'sent' (ne 'printed': dostava ≠ potrjen tisk; print-agent sam
    // vrača note 'delivered-to-kernel' brez branja statusa tiskalnika)
    const out: PrintResult = data.ok ? { ok: true, ackStatus: 'sent' } : { ok: false, error: data.error || 'Tiskalnik ni odziven.' }
    sendPrintAck(title, 'agent', out, ctx, `${cfg.host}:${cfg.port}`)
    return out
  }
  // browser: 80mm HTML okno + window.print
  printLinesBrowser(title, lines)
  const out: PrintResult = { ok: true }
  sendPrintAck(title, 'browser', out, ctx)
  return out
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
  items: { name: string; qty: number; note?: string | null; station?: string | null; allergenWarning?: string | null; allergenCodes?: string[]; modifiers?: string[] | null }[]
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
    // OSS-10 (v1.209.0): izbrane opcije (velikost/nivo/dodatki) na lastnih vrsticah —
    // kuhinja vidi »0,5 L« tudi na tiskanem listu (KDS jih že vidi kot detail naloge)
    for (const mo of it.modifiers ?? []) {
      if (typeof mo === 'string' && mo.trim()) out.push({ text: `   + ${mo.trim()}` })
    }
    // Issue #7 (P1, v1.104.0): izrecno alergensko opozorilo + kode iz posnetka —
    // kuhinja/bar ju VIDITA na tiskanem listu (enako kot KDS zaslon)
    if (it.allergenWarning) {
      out.push({ text: `⚠ ALERGIJA: ${it.allergenWarning}`, bold: true })
    }
    if (Array.isArray(it.allergenCodes) && it.allergenCodes.length > 0) {
      out.push({ text: `   alergeni: ${allergenLabels(it.allergenCodes, 'sl')}` })
    }
    if (it.note) out.push({ text: `   opomba: ${it.note}` })
  }
  out.push({ text: '--------------------------------' })
  out.push({ text: `Št. artiklov: ${items.reduce((s, i) => s + i.qty, 0)}` })
  return out
}

/** Issue #24 — etiketa z QR kodo (print pot kot printLines, + QR). */
export interface LabelPrintPayload {
  title: string
  lines: PrintLine[]
  /** URL, ki ga QR nosi (agent ga zagrize v ESC/POS QR; browser prikaže sliko). */
  qrText?: string
  /** PNG data URL (strežnik ga izdá prek /api/labels/[id]/print) za browser izpis. */
  qrDataUrl?: string
  ctx?: PrintContext
}

/** Natisni ETIKETO prek konfiguriranega cilja (+ QR). ACK evidence: kind='label', refId. */
export async function printLabelDocument(payload: LabelPrintPayload): Promise<PrintResult> {
  const cfg = getPrintConfig()
  if (cfg.target === 'simulator') {
    console.info(
      `[PRINT SIMULATOR] ${payload.title}`,
      payload.lines.map((l) => l.text).join('\n'),
      payload.qrText || '',
    )
    const res: PrintResult = { ok: true, simulated: true }
    sendPrintAck(payload.title, 'simulator', res, payload.ctx)
    return res
  }
  if (cfg.target === 'agent') {
    const res = await fetch('/label?XTransformPort=3031', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: cfg.host,
        port: cfg.port,
        title: payload.title,
        lines: payload.lines,
        qrText: payload.qrText || '',
        qrSize: 5,
        cut: true,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    // Issue #3 §C: enaka poštenost kot printLines — agent ok = 'sent' (dostava do
    // vtičnice, ne potrjen tisk etikete)
    const out: PrintResult = data.ok
      ? { ok: true, ackStatus: 'sent' }
      : { ok: false, error: data.error || 'Tiskalnik ni odziven.' }
    sendPrintAck(payload.title, 'agent', out, payload.ctx, `${cfg.host}:${cfg.port}`)
    return out
  }
  printLabelBrowser(payload)
  const out: PrintResult = { ok: true }
  sendPrintAck(payload.title, 'browser', out, payload.ctx)
  return out
}

/** 80mm HTML izpis etikete z QR sliko (browser cilj). */
function printLabelBrowser(payload: LabelPrintPayload) {
  const w = window.open('', '_blank', 'width=380,height=560')
  if (!w) return
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = payload.lines
    .map((l) => {
      const cls = [
        l.align === 'center' ? 'center' : l.align === 'right' ? 'right' : 'left',
        l.bold ? 'bold' : '',
        l.size === 'large' ? 'large' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `<div class="${cls}">${esc(l.text)}</div>`
    })
    .join('')
  w.document.write(
    `<!doctype html><html><head><title>${esc(payload.title)}</title><style>body{font-family:monospace;width:72mm;margin:0 auto;padding:4mm}.center{text-align:center}.right{text-align:right}.bold{font-weight:700}.large{font-size:18px}img.qr{display:block;margin:2mm auto;width:30mm;height:30mm}</style></head><body>${rows}${
      payload.qrDataUrl ? `<img class="qr" src="${payload.qrDataUrl}" alt="QR"/>` : ''
    }</body></html>`,
  )
  w.document.close()
  w.focus()
  w.print()
}
