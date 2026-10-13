'use client'

import { useEffect, useState } from 'react'
import { api, fmtEUR, downloadCSV } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Clock, Wallet, TrendingUp, AlertTriangle, CheckCircle2, Trash2, Hourglass, Pencil, RotateCcw, Eye, Paperclip, Download } from 'lucide-react'

export interface ShiftT { id: string; employeeId?: string | null; employee?: { name: string; role: string } | null; startedAt: string; endedAt?: string | null; openingCash: number; closingCash: number; status: string }
export interface FinancialT { today: { revenue: number; tax: number; invoices: number }; month: { revenue: number; tax: number; invoices: number; expenses: number; profit: number }; taxBreakdown: { taxRate: number; qty: number }[] }

export function ShiftsTab({ shifts, financial, canManage, onReload }: { shifts: ShiftT[]; financial: FinancialT | null; canManage: boolean; onReload: () => Promise<void> }) {
  const { t } = useI18n()
  const [cash, setCash] = useState('')
  const [busy, setBusy] = useState(false)
  const openShift = shifts.find((s) => s.status === 'open')
  // OPS-7 (v1.70.0): Z poročilo po zaključku izmene (Lightspeed vzorec — pokaži povzetek)
  const [zRep, setZRep] = useState<{ totalSales: number; cash: number; card: number; totalTax: number; receipts: number; totalStorno: number; cashDifference: number } | null>(null)

  async function startShift() {
    setBusy(true)
    try { await api('/api/shifts', { method: 'POST', body: JSON.stringify({ openingCash: Number(cash) || 0 }) }); setCash(''); await onReload() }
    catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }
  async function stopShift() {
    setBusy(true)
    try {
      const d = await api<{ zReport: { totalSales: number; cash: number; card: number; totalTax: number; receipts: number; totalStorno: number; cashDifference: number } | null }>('/api/shifts', { method: 'POST', body: JSON.stringify({ action: 'stop', closingCash: Number(cash) || 0 }) })
      setCash('')
      if (d.zReport) setZRep(d.zReport)
      await onReload()
    }
    catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> {t('shifts.revenueMonth')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.revenue) : '—'}</p><p className="text-xs text-stone-400">{t('shifts.tax')} {financial ? fmtEUR(financial.month.tax) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> {t('exp.month')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.month.expenses) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.profitMonth')}</CardTitle></CardHeader><CardContent><p className={`text-xl font-bold ${(financial?.month.profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{financial ? fmtEUR(financial.month.profit) : '—'}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.invoicesMonth')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial?.month.invoices ?? '—'}</p></CardContent></Card>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><TrendingUp className="w-4 h-4" /> {t('shifts.revenueToday')}</CardTitle></CardHeader><CardContent><p className="text-xl font-bold">{financial ? fmtEUR(financial.today.revenue) : '—'}</p><p className="text-xs text-stone-400">{t('shifts.todayDetail', { n: financial?.today.invoices ?? '—', tax: financial ? fmtEUR(financial.today.tax) : '—' })}</p></CardContent></Card>
        <Card className="col-span-2 lg:col-span-3"><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500">{t('shifts.taxBreakdown')}</CardTitle></CardHeader><CardContent>
          {!financial || financial.taxBreakdown.length === 0 ? <p className="text-sm text-stone-500">{t('shifts.noTraffic')}</p> : (
            <div className="flex flex-wrap gap-2">
              {financial.taxBreakdown.map((tb) => (
                <Badge key={tb.taxRate} variant="outline" className="text-sm px-2.5 py-1">{t('shifts.vatBadge', { rate: tb.taxRate, qty: tb.qty })}</Badge>
              ))}
            </div>
          )}
        </CardContent></Card>
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => {
          if (!financial) return
          const d = new Date()
          downloadCSV(`porocilo-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
            [t('shifts.csvTitle'), new Date().toLocaleDateString('sl-SI')],
            [],
            [t('shifts.csvPeriod'), t('shifts.csvRevenue'), t('shifts.csvTax'), t('shifts.csvExpenses'), t('shifts.csvProfit'), t('shifts.csvInvoices')],
            [t('shifts.csvToday'), financial.today.revenue, financial.today.tax, '', '', financial.today.invoices],
            [t('shifts.csvMonth'), financial.month.revenue, financial.month.tax, financial.month.expenses, financial.month.profit, financial.month.invoices],
            [],
            [t('shifts.csvTaxRate'), t('shifts.csvItems')],
            ...financial.taxBreakdown.map((t) => [t.taxRate, t.qty]),
            [],
            [t('shifts.csvShift'), t('shifts.csvEmployee'), t('shifts.csvRole'), t('shifts.csvStart'), t('shifts.csvEnd'), t('shifts.csvOpening'), t('shifts.csvClosing'), t('shifts.csvStatus')],
            ...shifts.map((s) => [s.id, s.employee?.name || '', s.employee?.role || '', s.startedAt, s.endedAt || '', s.openingCash, s.closingCash, s.status]),
          ])
        }}>
          {t('shifts.exportCsv')}
        </Button>
      </div>

      {/* OPS-7: Z poročilo po zaključku izmene */}
      <Dialog open={!!zRep} onOpenChange={(v) => !v && setZRep(null)}>
        <DialogContent className="max-w-sm" aria-describedby={undefined}>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-600" /> {t('zrep.title')}</DialogTitle></DialogHeader>
          {zRep && (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span>{t('zrep.sales')}</span><b>{fmtEUR(zRep.totalSales)}</b></div>
              <div className="flex justify-between"><span>{t('zrep.tax')}</span><span>{fmtEUR(zRep.totalTax)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.cash')}</span><span>{fmtEUR(zRep.cash)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.card')}</span><span>{fmtEUR(zRep.card)}</span></div>
              <div className="flex justify-between"><span>{t('zrep.receipts')}</span><span>{zRep.receipts}</span></div>
              {zRep.totalStorno > 0 && <div className="flex justify-between text-red-600"><span>{t('zrep.storno')}</span><span>−{fmtEUR(zRep.totalStorno)}</span></div>}
              <div className={`flex justify-between border-t border-stone-200 pt-1 ${Math.abs(zRep.cashDifference) >= 0.01 ? 'text-amber-700 font-semibold' : 'text-stone-500'}`}><span>{t('zrep.diff')}</span><span>{fmtEUR(zRep.cashDifference)}</span></div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setZRep(null)}>{t('zrep.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4" /> {openShift ? t('shifts.openShift', { name: openShift.employee?.name || '' }) : t('shifts.noOpenShift')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="cash">{openShift ? t('shifts.closingCashLabel') : t('shifts.openingCashLabel')}</Label>
              <Input id="cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))} placeholder="0.00" className="w-44" />
            </div>
            {openShift ? (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={stopShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('shifts.stopShift')}</Button>
            ) : (
              <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={startShift}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('shifts.startShift')}</Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('shifts.recent')}</CardTitle></CardHeader>
        <CardContent>
          {shifts.length === 0 && <p className="text-sm text-stone-500">{t('shifts.none')}</p>}
          <ScrollArea className="max-h-80">
            <div className="space-y-2">
              {shifts.map((s) => (
                <div key={s.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.employee?.name || '—'} <span className="text-xs text-stone-400">· {s.employee?.role || ''}</span></p>
                    <p className="text-xs text-stone-500">{new Date(s.startedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{s.endedAt ? ` → ${new Date(s.endedAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-stone-500">{t('shifts.opening')} {fmtEUR(s.openingCash)}</span>
                    {s.status === 'closed' && <span className="text-xs font-semibold">{t('shifts.closing')} {fmtEUR(s.closingCash)}</span>}
                    <Badge className={s.status === 'open' ? 'bg-amber-600 text-white' : 'bg-stone-500 text-white'}>{s.status === 'open' ? t('shifts.openF') : t('shifts.closedF')}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

/* ─────────────────────────── STROŠKI ─────────────────────────── */

export interface ExpenseT {
  id: string
  category: string
  description: string
  amount: number
  paidAt: string
  status?: string
  apNumber?: string
  dueDate?: string | null
  paidAmount?: number
  supplierName?: string | null
}

/**
 * Task 61 (revizija §7 vrstica 122): admin nadzor nad stroški — prej samo vnos+seznam (PARTIAL),
 * zdaj: urejanje (dialog), plačilo/odprtje, mehko preklicanje (status 'void') + status
 * oznake + zapadlost KPI. API: PATCH/DELETE /api/expenses/[id] (settings.manage +
 * lokacijski gate). Knjigovodska varnost: znesek plačanega zapisa se ureja šele po
 * odprtju plačila (backend 409) — UI onemogoči vnos v dialogu.
 *
 * Task 67 (v1.65.0): kategorije stroškov (runtime-gated na categoriesEnabled — API
 * vrne true, ko stolpec AccountsPayable.category obstaja; do uporabnikovega DDL klika
 * se UI polja/filter NE prikažejo). Vnos: datalist iz obstoječih kategorij (prost
 * tekst, ≤60), urejanje + brisanje kategorije v dialogu, oznaka v seznamu + filter.
 */
/** OPS-10 val 3 — archived eSLOG attachment (server shape, src/lib/ap-attachments.ts). */
interface ApAttT { mimeCode: string; filename: string; sizeB: number; dataBase64?: string }

export function ExpensesTab({ expenses, canManage, onReload, categoriesEnabled }: { expenses: ExpenseT[]; canManage: boolean; onReload: () => Promise<void>; categoriesEnabled?: boolean }) {
  const { t } = useI18n()
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ description: '', amount: '', dueDate: '', category: '' })
  const [catFilter, setCatFilter] = useState('all')
  const [err, setErr] = useState('')

  // OPS-10 val 3 — eSLOG attachment archive (lazy badge index + per-AP dialog)
  const [attIndex, setAttIndex] = useState<Record<string, number>>({})
  const [attDialog, setAttDialog] = useState<{ apNumber: string; description: string } | null>(null)
  const [attList, setAttList] = useState<ApAttT[] | null>(null)
  const [attTruncated, setAttTruncated] = useState(false)
  const [attBusy, setAttBusy] = useState(false)
  const [attErr, setAttErr] = useState('')
  const [attPreview, setAttPreview] = useState<{ name: string; uri: string } | null>(null)

  useEffect(() => {
    let alive = true
    api<{ attachmentsIndex: Record<string, number> }>('/api/expenses?attachmentsIndex=1')
      .then((r) => { if (alive) setAttIndex(r.attachmentsIndex || {}) })
      .catch(() => { /* best-effort badge index */ })
    return () => { alive = false }
  }, [])

  const openAttachments = async (apNumber: string, description: string) => {
    setAttDialog({ apNumber, description }); setAttList(null); setAttErr(''); setAttTruncated(false); setAttPreview(null)
    setAttBusy(true)
    try {
      const r = await api<{ attachments: ApAttT[]; truncated: boolean }>(`/api/expenses?withAttachments=1&apNumber=${encodeURIComponent(apNumber)}`)
      setAttList(r.attachments || [])
      setAttTruncated(r.truncated === true)
    } catch (e) {
      setAttErr(String((e as Error).message || e))
    } finally { setAttBusy(false) }
  }

  const monthTotal = expenses
    .filter((e) => e.status !== 'void' && new Date(e.paidAt).getMonth() === new Date().getMonth() && new Date(e.paidAt).getFullYear() === new Date().getFullYear())
    .reduce((s, e) => s + e.amount, 0)
  const openTotal = expenses.filter((e) => e.status === 'open').reduce((s, e) => s + e.amount, 0)
  const overdueCount = expenses.filter((e) => e.status === 'open' && e.dueDate && new Date(e.dueDate) < new Date()).length
  const isPaid = (e: ExpenseT) => e.status === 'paid' || (e.paidAmount ?? 0) >= e.amount
  // Task 67: distinct kategorije (iz GET okna) + klienti filter prikaza
  const categories = categoriesEnabled
    ? Array.from(new Set(expenses.map((e) => e.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'sl'))
    : []
  const visible = catFilter && catFilter !== 'all' ? expenses.filter((e) => e.category === catFilter) : expenses

  function openEdit(e: ExpenseT) {
    setEditId(e.id)
    setEditForm({
      description: e.description,
      amount: String(e.amount).replace('.', ','),
      dueDate: e.dueDate ? new Date(e.dueDate).toISOString().slice(0, 10) : '',
      category: e.category && e.category !== 'OSTALO' ? e.category : '',
    })
    setErr('')
    setOpen(true)
  }

  async function saveEdit() {
    if (!editId) return
    const amt = Number(editForm.amount.replace(',', '.'))
    setBusy(true); setErr('')
    try {
      await api(`/api/expenses/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: editForm.description,
          amount: amt,
          dueDate: editForm.dueDate || undefined,
          // Task 67: kategorija samo ko je funkcija aktivna ('' = brisanje)
          ...(categoriesEnabled ? { category: editForm.category.trim() } : {}),
        }),
      })
      setOpen(false); await onReload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  async function togglePaid(e: ExpenseT) {
    setBusy(true); setErr('')
    try {
      await api(`/api/expenses/${e.id}`, { method: 'PATCH', body: JSON.stringify({ status: isPaid(e) ? 'open' : 'paid' }) })
      await onReload()
    } catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function remove(e: ExpenseT) {
    if (!window.confirm(t('exp.deleteConfirm', { d: e.description }))) return
    setBusy(true); setErr('')
    try { await api(`/api/expenses/${e.id}`, { method: 'DELETE' }); await onReload() }
    catch (err) { setErr((err as Error).message) } finally { setBusy(false) }
  }

  async function submit() {
    setBusy(true)
    try {
      await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          description,
          amount: Number(amount.replace(',', '.')),
          // Task 67: kategorija samo ko je funkcija aktivna
          ...(categoriesEnabled && category.trim() ? { category: category.trim() } : {}),
        }),
      })
      setDescription(''); setAmount(''); setCategory(''); await onReload()
    } catch (err) { alert((err as Error).message) } finally { setBusy(false) }
  }

  const statusBadge = (e: ExpenseT) => {
    if (e.status === 'void') return <Badge variant="outline" className="text-stone-400 line-through">{t('exp.statusVoid')}</Badge>
    if (isPaid(e)) return <Badge className="bg-emerald-700 text-white">{t('exp.statusPaid')}</Badge>
    if (e.dueDate && new Date(e.dueDate) < new Date()) return <Badge variant="outline" className="text-red-600 border-red-300">{t('exp.statusOverdue')}</Badge>
    return <Badge variant="outline" className="text-amber-700 border-amber-300">{t('exp.statusOpen')}</Badge>
  }

  // OPS-10 val 3 — human attachment size (B/KB/MB)
  const fmtSize = (b: number) => {
    if (!Number.isFinite(b) || b <= 0) return '0 B'
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(Math.round((b / 1024) * 10) / 10).toFixed(1)} KB`
    return `${(Math.round((b / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`
  }
  const attUri = (a: ApAttT) => `data:${a.mimeCode || 'application/octet-stream'};base64,${a.dataBase64 || ''}`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> {t('exp.month')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(monthTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><Hourglass className="w-4 h-4" /> {t('exp.kpiOpen')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{fmtEUR(openTotal)}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-stone-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('exp.kpiOverdue')}</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{overdueCount}</p></CardContent></Card>
      </div>

      {err && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>}

      {canManage && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{t('exp.new')}</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5 min-w-48 flex-1">
              <Label htmlFor="ex-desc">{t('exp.description')}</Label>
              <Input id="ex-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('exp.descPlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ex-amount">{t('exp.amount')}</Label>
              <Input id="ex-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0.00" className="w-32" />
            </div>
            {categoriesEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-cat">{t('exp.category')}</Label>
                <Input id="ex-cat" list="ex-cats" value={category} onChange={(e) => setCategory(e.target.value.slice(0, 60))} placeholder={t('exp.categoryPlaceholder')} className="w-44" maxLength={60} />
                <datalist id="ex-cats">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            )}
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !description || !(Number(amount.replace(',', '.')) > 0)} onClick={submit}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('exp.submit')}</Button>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => {
          const d = new Date()
          downloadCSV(`stroski-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`, [
            [t('exp.csvDate'), t('exp.description'), t('exp.csvCategory'), t('exp.csvAmount')],
            ...expenses.map((e) => [new Date(e.paidAt).toLocaleDateString('sl-SI'), e.description, e.category || '', e.amount]),
          ])
        }}>
          {t('exp.exportCsv')}
        </Button>
      </div>
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('exp.title')}</CardTitle>
          <div className="flex items-center gap-3">
            {categories.length > 0 && (
              <Select value={catFilter} onValueChange={setCatFilter}>
                <SelectTrigger className="h-8 w-44 text-xs" aria-label={t('exp.category')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('exp.allCategories')}</SelectItem>
                  {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <span className="text-xs text-stone-500">{t('exp.totalRecords')}: {visible.length}{catFilter !== 'all' ? ` / ${expenses.length}` : ''}</span>
          </div>
        </CardHeader>
        <CardContent>
          {visible.length === 0 && <p className="text-sm text-stone-500">{t('exp.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="space-y-2">
              {visible.map((e) => {
                const voided = e.status === 'void'
                return (
                  <div key={e.id} className={`rounded-lg border p-3 flex flex-wrap items-center justify-between gap-2 ${voided ? 'border-stone-200 bg-stone-50 opacity-70' : 'border-stone-200 bg-white'}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={`font-medium truncate ${voided ? 'line-through text-stone-400' : ''}`}>{e.description}</p>
                        {statusBadge(e)}
                        {categoriesEnabled && e.category && e.category !== 'OSTALO' && <Badge variant="outline" className="text-stone-600 border-stone-300">{e.category}</Badge>}
                        {/* OPS-10 val 3 — archived eSLOG attachments (click opens the preview dialog) */}
                        {e.apNumber && (attIndex[e.apNumber] || 0) > 0 && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[11px] text-stone-700 hover:bg-stone-100"
                            onClick={() => void openAttachments(e.apNumber as string, e.description)}
                            aria-label={t('apatt.badge', { n: attIndex[e.apNumber] })}
                          >
                            <Paperclip className="w-3 h-3" /> {t('apatt.badge', { n: attIndex[e.apNumber] })}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-stone-500 mt-1">
                        {new Date(e.paidAt).toLocaleDateString('sl-SI')}
                        {e.supplierName ? ` · ${e.supplierName}` : ''}
                        {e.apNumber ? ` · ${e.apNumber}` : ''}
                        {e.dueDate && !voided && !isPaid(e) ? ` · ${t('exp.dueDate')}: ${new Date(e.dueDate).toLocaleDateString('sl-SI')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <p className={`font-bold ${voided ? 'line-through text-stone-400' : ''}`}>{fmtEUR(e.amount)}</p>
                      {canManage && !voided && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => void togglePaid(e)} disabled={busy} aria-label={isPaid(e) ? t('exp.markOpen') : t('exp.markPaid')}>
                            {isPaid(e) ? <RotateCcw className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openEdit(e)} disabled={busy} aria-label={t('exp.editAria', { d: e.description })}><Pencil className="w-4 h-4" /></Button>
                          <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" onClick={() => void remove(e)} disabled={busy} aria-label={t('exp.deleteAria', { d: e.description })}><Trash2 className="w-4 h-4" /></Button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('exp.editTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ex-edit-desc">{t('exp.description')}</Label>
              <Input id="ex-edit-desc" value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} maxLength={120} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-amount">{t('exp.amount')}</Label>
                <Input id="ex-edit-amount" inputMode="decimal" value={editForm.amount} onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-due">{t('exp.dueDate')}</Label>
                <Input id="ex-edit-due" type="date" value={editForm.dueDate} onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))} />
              </div>
            </div>
            {categoriesEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-edit-cat">{t('exp.category')}</Label>
                <Input id="ex-edit-cat" list="ex-cats-edit" value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value.slice(0, 60) }))} placeholder={t('exp.categoryPlaceholder')} maxLength={60} />
                <datalist id="ex-cats-edit">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
            )}
            {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t('exp.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={busy || !editForm.description.trim() || !(Number(editForm.amount.replace(',', '.')) > 0)} onClick={saveEdit}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('exp.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OPS-10 val 3 — attachment archive dialog (list + inline PDF preview + download) */}
      <Dialog open={!!attDialog} onOpenChange={(v) => { if (!v) { setAttDialog(null); setAttPreview(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5"><Paperclip className="w-4 h-4" /> {t('apatt.title')}</DialogTitle>
            <CardDescription>{attDialog?.description}{attDialog ? ` · ${attDialog.apNumber}` : ''}</CardDescription>
          </DialogHeader>
          <div className="space-y-3">
            {attBusy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('apatt.loading')}</p>}
            {attErr && <p role="alert" className="text-sm text-red-600">{attErr}</p>}
            {attList !== null && attList.length === 0 && <p className="text-sm text-stone-500">{t('apatt.none')}</p>}
            {attList !== null && attList.length > 0 && (
              <div className="space-y-2">
                {attList.map((a, i) => (
                  <div key={`${a.filename}-${i}`} className="rounded-lg border border-stone-200 p-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate max-w-56" title={a.filename || '(brez imena)'}>{a.filename || '(brez imena)'}</p>
                      <p className="text-xs text-stone-500">{a.mimeCode || '—'} · {fmtSize(a.sizeB)}{!a.dataBase64 ? ` · ${t('apatt.metaOnly')}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {a.dataBase64 && (a.mimeCode || '').includes('pdf') && (
                        <Button size="sm" variant="outline" onClick={() => setAttPreview({ name: a.filename || 'priloga.pdf', uri: attUri(a) })}>
                          <Eye className="w-3.5 h-3.5" /> {t('apatt.preview')}
                        </Button>
                      )}
                      {a.dataBase64 && (
                        <a href={attUri(a)} download={a.filename || 'priloga'} className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-stone-200 bg-white px-3 text-xs font-medium hover:bg-stone-50">
                          <Download className="w-3.5 h-3.5" /> {t('apatt.download')}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
                {attTruncated && <p className="text-xs text-amber-700">{t('apatt.truncated')}</p>}
                <p className="text-[11px] text-stone-400">{t('apatt.retention')}</p>
              </div>
            )}
            {attPreview && (
              <div className="rounded-lg border border-stone-200 overflow-hidden">
                <div className="flex items-center justify-between gap-2 bg-stone-50 px-2.5 py-1.5">
                  <span className="text-xs font-medium truncate">{attPreview.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => setAttPreview(null)} aria-label={t('apatt.closePreview')}>{t('apatt.closePreview')}</Button>
                </div>
                <iframe src={attPreview.uri} title={attPreview.name} className="w-full h-72 bg-white" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAttDialog(null); setAttPreview(null) }}>{t('exp.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

