'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, fmtEUR, getToken } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, FileText, Send, RotateCcw, Plus, Trash2, FileDown, Eye, Clock } from 'lucide-react'

/*
 * Issue #4 (P1, v1.125.0) — E-računi podjetjem SI/HR (odhodni B2B tok).
 *
 * Kartica v Nabavi zraven obstoječega eSLOG UVOZA (prejeti tok): izdaja
 * strukturiranega e-računa (AR + EInvoiceOutbox osnutek z XML + hash),
 * pošiljanje prek izbrane poti (mock adapter dokler lastnik ne potrdi
 * ponudnika — ključavnica), statusi izmenjave + statusni dogodki (AuditLog
 * veriga), webhook nasvet, XML dokaz (prenos/ogled).
 *
 * REST pogodba: GET /api/einvoices (filtri country/status/q), POST
 * /api/einvoices/issue, POST /[id]/send|retry, GET /[id] (events), GET
 * /[id]/xml (dokaz poslanega dokumenta). RBAC: branje reports.view,
 * dejanja inventory.manage (isti domeni kot eSLOG uvoz).
 */

interface EInvoiceRowT {
  id: string
  arId: string | null
  country: string
  documentType: string
  profile: string
  currency: string
  invoiceNumber: string
  receiverName: string
  receiverTaxId: string
  status: string
  lastReason: string
  externalRef: string
  attempts: number
  subtotal: number
  vatAmount: number
  totalAmount: number
  createdAt: string
  sentAt: string | null
}

interface EInvoiceEventT {
  id: string
  action: string
  details: string
  userId: string | null
  timestamp: string
}

interface DetailT {
  eInvoice: EInvoiceRowT & { xmlHash: string; idempotencyKey: string }
  events: EInvoiceEventT[]
}

const EI_STATUSES = ['draft', 'validated', 'queued', 'sent', 'delivered', 'accepted', 'rejected', 'failed', 'needs_review']

/** Badge razredi po statusu (forward-only življenjski cikel — barve po resnosti). */
const STATUS_BADGE: Record<string, string> = {
  draft: 'border-stone-300 bg-stone-50 text-stone-600',
  validated: 'border-amber-300 bg-amber-50 text-amber-800',
  queued: 'border-amber-300 bg-amber-50 text-amber-800',
  sent: 'border-violet-300 bg-violet-50 text-violet-800',
  delivered: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  accepted: 'border-emerald-600 bg-emerald-100 text-emerald-800 font-semibold',
  rejected: 'border-rose-300 bg-rose-50 text-rose-700',
  failed: 'border-rose-300 bg-rose-50 text-rose-700',
  needs_review: 'border-amber-500 bg-amber-100 text-amber-900 font-semibold',
}

const RETRYABLE = new Set(['failed', 'rejected', 'needs_review'])

/** RFC3339/ISO → dd.MM.yyyy HH:mm (lokalna cona). */
function eiWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Detail dogodka → {origin, reason, correlationId} toleranten parse. */
function eventMeta(details: string): { origin: string; reason: string; correlationId: string } {
  try {
    const d = JSON.parse(details || '{}') as Record<string, unknown>
    return {
      origin: String(d.origin ?? 'user'),
      reason: String(d.reason ?? d.to ?? ''),
      correlationId: String(d.correlationId ?? ''),
    }
  } catch {
    return { origin: 'user', reason: '', correlationId: '' }
  }
}

export function EInvoiceCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<EInvoiceRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [fCountry, setFCountry] = useState('all')
  const [fStatus, setFStatus] = useState('all')
  const [fQ, setFQ] = useState('')

  // izdaja (dialog)
  const [issueOpen, setIssueOpen] = useState(false)
  const [issueBusy, setIssueBusy] = useState(false)
  const [custName, setCustName] = useState('')
  const [custTaxId, setCustTaxId] = useState('')
  const [custCountry, setCustCountry] = useState('SI')
  const [custEmail, setCustEmail] = useState('')
  const [orderId, setOrderId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [docType, setDocType] = useState('invoice')
  const [lines, setLines] = useState<{ name: string; qty: string; priceNet: string; vat: string; kpd: string }[]>([
    { name: '', qty: '1', priceNet: '', vat: '22', kpd: '' },
  ])
  const [issueErrors, setIssueErrors] = useState<{ field: string; message: string }[]>([])

  // detail (dialog)
  const [detail, setDetail] = useState<DetailT | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailXml, setDetailXml] = useState('')

  const [sendBusy, setSendBusy] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams()
      if (fCountry !== 'all') params.set('country', fCountry)
      if (fStatus !== 'all') params.set('status', fStatus)
      if (fQ.trim()) params.set('q', fQ.trim())
      const data = await api<{ eInvoices: EInvoiceRowT[] }>(`/api/einvoices?${params.toString()}`)
      setRows(data.eInvoices ?? [])
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [fCountry, fStatus, fQ])

  useEffect(() => {
    const id = setTimeout(load, fQ ? 300 : 0)
    return () => clearTimeout(id)
  }, [load, fQ])

  async function issueSubmit() {
    setIssueBusy(true)
    setIssueErrors([])
    try {
      const body: Record<string, unknown> = {
        customerName: custName.trim(),
        customerTaxId: custTaxId.replace(/\D/g, ''),
        customerCountry: custCountry,
        documentType: docType,
        ...(custEmail.trim() ? { customerEmail: custEmail.trim() } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(orderId.trim() ? { orderId: orderId.trim() } : {}),
        ...(orderId.trim()
          ? {}
          : {
              lines: lines
                .filter((l) => l.name.trim())
                .map((l) => ({
                  name: l.name.trim(),
                  quantity: Number(l.qty.replace(',', '.')) || 0,
                  unitPriceNet: Number(l.priceNet.replace(',', '.')) || 0,
                  vatRate: Number(l.vat.replace(',', '.')) || 0,
                  ...(l.kpd.trim() ? { kpdCode: l.kpd.trim() } : {}),
                })),
            }),
      }
      const data = await api<{ ar: { arNumber: string }; eInvoice: { id: string } }>('/api/einvoices/issue', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      toast({ title: t('ei.ok.issued', { ar: data.ar.arNumber }) })
      setIssueOpen(false)
      setCustName(''); setCustTaxId(''); setCustEmail(''); setOrderId(''); setDueDate(''); setDocType('invoice')
      setLines([{ name: '', qty: '1', priceNet: '', vat: '22', kpd: '' }])
      await load()
    } catch (e) {
      const msg = String((e as Error).message || e)
      try {
        // 400 z errors poljem (api helper vrže Error z error sporočilom — parsamo field napake ločeno)
        const m = /\{[\s\S]*\}/.exec(msg)
        if (m) {
          const parsed = JSON.parse(m[0]) as { errors?: { field: string; message: string }[] }
          if (parsed.errors) setIssueErrors(parsed.errors)
        }
      } catch { /* sporočilo brez JSON */ }
      if (!issueErrors.length) toast({ title: msg, variant: 'destructive' })
    } finally {
      setIssueBusy(false)
    }
  }

  async function sendOrRetry(id: string, retry: boolean) {
    setSendBusy(id)
    try {
      const data = await api<{ sent?: boolean; status?: string; externalRef?: string }>(`/api/einvoices/${id}/${retry ? 'retry' : 'send'}`, { method: 'POST' })
      toast({ title: t(data.status === 'queued' ? 'ei.ok.queued' : 'ei.ok.sent', { ar: '' }) + (data.externalRef ? ` (${data.externalRef})` : '') })
      await load()
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setSendBusy('')
    }
  }

  async function openDetail(id: string, withXml: boolean) {
    setDetailBusy(true)
    setDetail(null)
    setDetailXml('')
    try {
      const data = await api<DetailT>(`/api/einvoices/${id}`)
      setDetail(data)
      setDetailOpen(true)
      if (withXml) {
        const token = getToken()
        const res = await fetch(`/api/einvoices/${id}/xml`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
        if (res.ok) setDetailXml(await res.text())
      }
    } catch (e) {
      toast({ title: String((e as Error).message || e), variant: 'destructive' })
    } finally {
      setDetailBusy(false)
    }
  }

  const [detailOpen, setDetailOpen] = useState(false)

  function statusBadge(status: string) {
    return (
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 whitespace-nowrap ${STATUS_BADGE[status] ?? 'border-stone-300 bg-stone-50 text-stone-600'}`}>
        {t(`ei.status.${status}`)}
      </Badge>
    )
  }

  return (
    <Card id="einvice-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <FileText className="w-4 h-4" /> {t('ei.card')}
          {canManage && (
            <span className="ml-auto">
              <Button size="sm" className="h-8 px-2 text-xs bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => setIssueOpen(true)}>
                <Plus className="w-3.5 h-3.5" /> {t('ei.issue.title')}
              </Button>
            </span>
          )}
        </CardTitle>
        <CardDescription>{t('ei.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* filtri */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 w-32">
            <Label className="text-xs" htmlFor="ei-f-country">{t('ei.filter.country')}</Label>
            <Select value={fCountry} onValueChange={setFCountry}>
              <SelectTrigger id="ei-f-country" className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ei.filter.all')}</SelectItem>
                <SelectItem value="SI">SI</SelectItem>
                <SelectItem value="HR">HR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 w-44">
            <Label className="text-xs" htmlFor="ei-f-status">{t('ei.filter.status')}</Label>
            <Select value={fStatus} onValueChange={setFStatus}>
              <SelectTrigger id="ei-f-status" className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('ei.filter.all')}</SelectItem>
                {EI_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{t(`ei.status.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex-1 min-w-48">
            <Label className="text-xs" htmlFor="ei-f-q">{t('ei.filter.q')}</Label>
            <Input id="ei-f-q" className="h-9 text-sm" value={fQ} onChange={(e) => setFQ(e.target.value)} />
          </div>
          <Button size="sm" variant="outline" className="h-9 text-xs" disabled={loading} onClick={load}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          </Button>
        </div>

        {/* seznam */}
        {loading ? (
          <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</p>
        ) : err ? (
          <p className="text-sm text-rose-700">{err}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-stone-500">{t('recs.empty')}</p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                <tr>
                  <th className="p-2">{t('ei.col.number')}</th>
                  <th className="p-2">{t('ei.col.receiver')}</th>
                  <th className="p-2">{t('ei.col.status')}</th>
                  <th className="p-2 text-right">{t('ei.col.attempts')}</th>
                  <th className="p-2">{t('ei.col.externalRef')}</th>
                  <th className="p-2 text-right">{t('ei.col.total')}</th>
                  <th className="p-2 text-right">{t('recs.colCost') === t('recs.colCost') ? '' : ''}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-stone-100 bg-white">
                    <td className="p-2 font-medium whitespace-nowrap">{r.invoiceNumber}</td>
                    <td className="p-2 max-w-40 truncate" title={r.receiverName}>
                      {r.receiverName}
                      <span className="block text-[10px] text-stone-400">{r.receiverTaxId} · {r.country}</span>
                    </td>
                    <td className="p-2">
                      {statusBadge(r.status)}
                      {r.lastReason && <span className="block text-[10px] text-rose-600 max-w-44 truncate" title={r.lastReason}>{r.lastReason}</span>}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.attempts}</td>
                    <td className="p-2 text-xs text-stone-600 max-w-32 truncate" title={r.externalRef}>{r.externalRef || '—'}</td>
                    <td className="p-2 text-right font-bold tabular-nums">{fmtEUR(r.totalAmount)}</td>
                    <td className="p-2">
                      <span className="flex items-center justify-end gap-1">
                        {canManage && (r.status === 'draft' || RETRYABLE.has(r.status)) && (
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-emerald-300 text-emerald-800 hover:bg-emerald-50" disabled={sendBusy === r.id} onClick={() => sendOrRetry(r.id, RETRYABLE.has(r.status))}>
                            {sendBusy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            {RETRYABLE.has(r.status) ? t('ei.action.retry') : t('ei.action.send')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={detailBusy} onClick={() => openDetail(r.id, false)}>
                          <Eye className="w-3 h-3" />
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* webhook nasvet (statusi pridejo prek podpisanega webhooka) */}
        <p className="text-xs text-stone-500 flex items-start gap-1.5">
          <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span><strong>{t('ei.webhook.title')}:</strong> {t('ei.webhook.desc')}</span>
        </p>
      </CardContent>

      {/* ── izdaja (dialog) ── */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><FileText className="w-4 h-4" /> {t('ei.issue.title')}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-stone-500">{t('ei.issue.desc')}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-name" className="text-xs">{t('ei.issue.customer')} *</Label>
              <Input id="ei-c-name" className="h-9 text-sm" value={custName} onChange={(e) => setCustName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-tax" className="text-xs">{t('ei.issue.taxId')} *</Label>
              <Input id="ei-c-tax" className="h-9 text-sm" value={custTaxId} onChange={(e) => setCustTaxId(e.target.value)} placeholder="12345678" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-country" className="text-xs">{t('ei.issue.country')}</Label>
              <Select value={custCountry} onValueChange={setCustCountry}>
                <SelectTrigger id="ei-c-country" className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SI">SI</SelectItem>
                  <SelectItem value="HR">HR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-email" className="text-xs">{t('ei.issue.email')}</Label>
              <Input id="ei-c-email" className="h-9 text-sm" value={custEmail} onChange={(e) => setCustEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-order" className="text-xs">{t('ei.issue.fromOrder')}</Label>
              <Input id="ei-c-order" className="h-9 text-sm" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-due" className="text-xs">{t('ei.issue.dueDate')}</Label>
              <Input id="ei-c-due" type="date" className="h-9 text-sm" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ei-c-type" className="text-xs">Tip dokumenta</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger id="ei-c-type" className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="invoice">{t('ei.status.draft') === 'Osnutek' ? 'Račun' : 'Račun'}</SelectItem>
                  <SelectItem value="credit_note">Dobropis</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* vrstice (samo ročna izdaja — iz naročila se prekopirajo) */}
          {!orderId.trim() && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold">{t('ei.issue.lines')} *</Label>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-1.5 items-end">
                  <div className="col-span-4 space-y-1">
                    {i === 0 && <Label className="text-[10px]" htmlFor={`ei-l-name-${i}`}>{t('ei.issue.name')}</Label>}
                    <Input id={`ei-l-name-${i}`} className="h-8 text-xs" value={l.name} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-1 space-y-1">
                    {i === 0 && <Label className="text-[10px]" htmlFor={`ei-l-qty-${i}`}>{t('ei.issue.qty')}</Label>}
                    <Input id={`ei-l-qty-${i}`} className="h-8 text-xs" inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-2 space-y-1">
                    {i === 0 && <Label className="text-[10px]" htmlFor={`ei-l-price-${i}`}>{t('ei.issue.priceNet')}</Label>}
                    <Input id={`ei-l-price-${i}`} className="h-8 text-xs" inputMode="decimal" value={l.priceNet} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, priceNet: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-1 space-y-1">
                    {i === 0 && <Label className="text-[10px]" htmlFor={`ei-l-vat-${i}`}>{t('ei.issue.vat')}</Label>}
                    <Input id={`ei-l-vat-${i}`} className="h-8 text-xs" inputMode="decimal" value={l.vat} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, vat: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-3 space-y-1">
                    {i === 0 && <Label className="text-[10px]" htmlFor={`ei-l-kpd-${i}`}>{t('ei.issue.kpd')}</Label>}
                    <Input id={`ei-l-kpd-${i}`} className="h-8 text-xs" inputMode="numeric" maxLength={6} value={l.kpd} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kpd: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-1">
                    <Button size="sm" variant="outline" className="h-8 w-8 p-0 text-xs border-red-200 text-red-700 hover:bg-red-50" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Odstrani vrstico">
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setLines([...lines, { name: '', qty: '1', priceNet: '', vat: '22', kpd: '' }])}>
                <Plus className="w-3 h-3" /> {t('ei.issue.lines')}
              </Button>
              {custCountry === 'HR' && <p className="text-[10px] text-amber-800">{t('ei.issue.kpdHint')}</p>}
            </div>
          )}

          {issueErrors.length > 0 && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 space-y-1">
              {issueErrors.map((e, i) => (
                <p key={i}>• <strong>{e.field}</strong>: {e.message}</p>
              ))}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={issueBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={issueSubmit} disabled={issueBusy}>
              {issueBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} {t('ei.issue.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── detail (dialog) ── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><Eye className="w-4 h-4" /> {t('ei.detail.title')}</DialogTitle>
          </DialogHeader>
          {detailBusy && !detail ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</p>
          ) : detail ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <div><span className="block text-xs text-stone-500">{t('ei.col.number')}</span><strong>{detail.eInvoice.invoiceNumber}</strong></div>
                <div><span className="block text-xs text-stone-500">{t('ei.col.receiver')}</span><strong className="block truncate">{detail.eInvoice.receiverName}</strong><span className="text-[10px] text-stone-400">{detail.eInvoice.receiverTaxId}</span></div>
                <div><span className="block text-xs text-stone-500">{t('ei.detail.status')}</span>{statusBadge(detail.eInvoice.status)}</div>
                <div><span className="block text-xs text-stone-500">{t('ei.col.total')}</span><strong className="tabular-nums">{fmtEUR(detail.eInvoice.totalAmount)}</strong></div>
                <div><span className="block text-xs text-stone-500">Profil</span><span className="text-xs">{detail.eInvoice.profile}</span></div>
                <div><span className="block text-xs text-stone-500">{t('ei.col.externalRef')}</span><span className="text-xs">{detail.eInvoice.externalRef || '—'}</span></div>
                <div className="col-span-2"><span className="block text-xs text-stone-500 break-all">XML hash</span><span className="text-[10px] font-mono break-all">{detail.eInvoice.xmlHash}</span></div>
              </div>

              <div>
                <Label className="text-xs font-semibold">{t('ei.detail.timeline')}</Label>
                <div className="mt-1 space-y-1 max-h-56 overflow-y-auto pr-1">
                  {detail.events.length === 0 ? (
                    <p className="text-xs text-stone-500">—</p>
                  ) : detail.events.map((ev) => {
                    const meta = eventMeta(ev.details)
                    return (
                      <div key={ev.id} className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="font-semibold">{eiWhen(ev.timestamp)}</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 border-stone-300 text-stone-600">{ev.action}</Badge>
                        <span className="text-stone-600">{t('ei.detail.origin')}: {meta.origin}</span>
                        {meta.correlationId && <span className="text-stone-400 truncate max-w-32" title={meta.correlationId}>{t('ei.detail.correlation')}: {meta.correlationId}</span>}
                        {meta.reason && <span className="text-rose-600 truncate max-w-44" title={meta.reason}>{meta.reason}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* XML dokaz (nalagamo ob zahtevi) */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Label className="text-xs font-semibold">XML</Label>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={detailBusy} onClick={() => openDetail(detail.eInvoice.id, true)}>
                    {detailBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />} {t('ei.action.xml')}
                  </Button>
                  {detailXml && (
                    <a
                      className="inline-flex items-center gap-1 h-7 px-2 text-xs rounded-md border border-stone-200 bg-white hover:bg-stone-50"
                      href={`data:application/xml;charset=utf-8,${encodeURIComponent(detailXml)}`}
                      download={`einvoice-${detail.eInvoice.invoiceNumber || detail.eInvoice.id}.xml`}
                    >
                      <FileDown className="w-3 h-3" /> {t('ei.action.xml')}
                    </a>
                  )}
                </div>
                {detailXml && (
                  <pre className="text-[10px] font-mono bg-stone-900 text-stone-100 rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{detailXml.slice(0, 4000)}{detailXml.length > 4000 ? '\n…' : ''}</pre>
                )}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
