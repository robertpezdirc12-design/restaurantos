'use client'

/**
 * P2-13 (v1.189.0) — knjigovodski portal (read-only agregacija).
 *
 * Tržna vrzel P2-13 (docs/TRZNA-VRZELI-2026.md §4 #13): GL/CSV izvozi že
 * obstajajo — manjkal je PRIKAZ. Knjigovodja (vloga ACCOUNTING, dovoljenja
 * reports.sales/reports.labour/einvoices.issue) danes mora skakati med
 * zavihki; eSlog kartica je sploh v nabavi (inventory.manage) in je ne vidi.
 *
 * Ta kartica ZBIRA obstoječe API-je (0 novih rut, 0 DDL, 0 mutacij):
 *  - GET /api/reports/export?section=zz&format=json  → promet/DDV/plačila
 *  - GET /api/reports/gl                             → GL obračun + balansa
 *  - GET /api/einvoices?from&to&limit=100            → odprema (statusi)
 *  - GET /api/expenses?from&to                       → stroški obdobja
 *
 * READ-ONLY: noben POST/PATCH/DELETE — dejanja ostajajo v obstoječih
 * karticah (AccountingExportCard izvoz, EInvoiceCard pošiljanje).
 * Izračuni so v čistem sloju src/lib/accounting-portal.ts (testabilno).
 */
import { useEffect, useState } from 'react'
import { api, fmtEUR } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2, BookOpenCheck, Scale, Send, FileText, TrendingUp } from 'lucide-react'
import { EINVOICE_STATUSES } from '@/lib/einvoice-lifecycle'
import { eInvoiceOutboxSummary, glBalanceState } from '@/lib/accounting-portal'

/** Podmnožica X/Z payloada (GET /api/reports/export?section=zz&format=json). */
interface PortalXzT {
  netSales: number
  vatTotal: number
  vatByRate: { rate: number; base: number; amount: number }[]
  paymentsByMethod: { method: string; amount: number }[]
  discountsTotal: number
  tipsTotal: number
  covers: number
  avgCheck: number
}

/** Podmnožica GET /api/reports/gl — za balanso potrebujem samo totals. */
interface PortalGlT {
  persisted: boolean
  entries: unknown[]
  totals: { debits: number; credits: number }
}

/** Podmnožica GET /api/einvoices — statusi za števec. */
interface PortalEinvT {
  eInvoices: { status: string; totalAmount: number }[]
  total: number
}

/** Podmnožica GET /api/expenses z P2-13 agregati (nad celotno periodo). */
interface PortalExpT {
  expenses: { amount: number; paidAmount: number }[]
  periodTotal?: number
  periodPaid?: number
  periodCount?: number
}

const fmtNumSI = (n: number): string => n.toLocaleString('sl-SI', { maximumFractionDigits: 1 })

export function AccountingPortalCard() {
  const { t } = useI18n()
  const firstOfMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) })()
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  const [xz, setXz] = useState<PortalXzT | null>(null)
  const [gl, setGl] = useState<PortalGlT | null>(null)
  const [einv, setEinv] = useState<PortalEinvT | null>(null)
  const [exp, setExp] = useState<PortalExpT | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true)
      setErr('')
      try {
        const [xzD, glD, einvD, expD] = await Promise.all([
          api<PortalXzT>(`/api/reports/export?from=${from}&to=${to}&format=json&section=zz`),
          api<PortalGlT>(`/api/reports/gl?from=${from}&to=${to}`),
          api<PortalEinvT>(`/api/einvoices?from=${from}&to=${to}&limit=100`),
          api<PortalExpT>(`/api/expenses?from=${from}&to=${to}`),
        ])
        if (alive) { setXz(xzD); setGl(glD); setEinv(einvD); setExp(expD) }
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [from, to, reload])

  const outbox = einv ? eInvoiceOutboxSummary(einv.eInvoices) : null
  const balance = gl ? glBalanceState(gl.totals) : null
  const expTotal = exp ? (exp.periodTotal ?? exp.expenses.reduce((s, r) => s + (Number(r.amount) || 0), 0)) : null
  const expPaid = exp ? (exp.periodPaid ?? exp.expenses.reduce((s, r) => s + (Number(r.paidAmount) || 0), 0)) : null
  const expCount = exp ? (exp.periodCount ?? exp.expenses.length) : null
  const expOutstanding = expTotal !== null && expPaid !== null ? Math.round((expTotal - expPaid + Number.EPSILON) * 100) / 100 : null

  const Kpi = ({ label, value }: { label: string; value: string | null }) => (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-stone-500">{label}</CardTitle></CardHeader>
      <CardContent className="pb-3"><p className="text-lg font-bold text-stone-900">{value ?? '—'}</p></CardContent>
    </Card>
  )
  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-stone-600">{label}</span>
      <span className="font-semibold text-stone-900">{value}</span>
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpenCheck className="w-4 h-4" /> {t('portal.title')}
          <Badge variant="outline" className="ml-auto text-xs bg-stone-50 text-stone-600 border-stone-200">{t('portal.readonly').split('.')[0]}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-stone-500">{t('portal.desc')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="portal-from" className="text-xs">{t('acct.from')}</Label>
            <Input id="portal-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="portal-to" className="text-xs">{t('acct.to')}</Label>
            <Input id="portal-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white min-h-10 gap-1.5" disabled={busy} onClick={() => setReload((r) => r + 1)}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpenCheck className="w-4 h-4" />} {t('common.refresh')}
          </Button>
        </div>
        {err && <p className="text-sm text-red-600">{t('portal.loadFailed')}: {err}</p>}

        {busy && !xz && !gl && !einv && !exp && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" />
          </div>
        )}

        {(xz || gl || einv || exp) && (
          <>
            {/* KPI vrstica */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi label={t('portal.kpiNet')} value={xz ? fmtEUR(xz.netSales) : null} />
              <Kpi label={t('portal.kpiVat')} value={xz ? fmtEUR(xz.vatTotal) : null} />
              <Kpi label={t('portal.kpiDiscounts')} value={xz ? fmtEUR(xz.discountsTotal) : null} />
              <Kpi label={t('portal.kpiExpenses')} value={expTotal !== null ? fmtEUR(expTotal) : null} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* DDV po stopnjah + plačila po načinih (X/Z payload) */}
              <div className="rounded-lg border border-stone-200 bg-white p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t('portal.vatByRate')}</p>
                {(xz?.vatByRate ?? []).length === 0 ? (
                  <p className="text-xs text-stone-400">{t('common.none')}</p>
                ) : (
                  (xz?.vatByRate ?? []).map((v) => <Row key={v.rate} label={`${t('acct.xzVatRate')} ${fmtNumSI(v.rate)} %`} value={fmtEUR(v.amount)} />)
                )}
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 pt-1">{t('portal.paymentsByMethod')}</p>
                {(xz?.paymentsByMethod ?? []).length === 0 ? (
                  <p className="text-xs text-stone-400">{t('common.none')}</p>
                ) : (
                  (xz?.paymentsByMethod ?? []).map((p) => <Row key={p.method} label={p.method.toUpperCase()} value={fmtEUR(p.amount)} />)
                )}
                {xz && (
                  <p className="text-xs text-stone-400 pt-1">
                    {t('acct.xzTips')}: {fmtEUR(xz.tipsTotal)} · {t('acct.xzCovers')}: {fmtNumSI(xz.covers)} · {t('acct.xzAvgCheck')}: {fmtEUR(xz.avgCheck)}
                  </p>
                )}
              </div>

              {/* GL obračun + balansa */}
              <div className="rounded-lg border border-stone-200 bg-white p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 flex items-center gap-1.5">
                  <Scale className="w-3.5 h-3.5" /> {t('portal.glTitle')}
                </p>
                {gl ? (
                  <>
                    {balance && (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-xs ${balance.balanced ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                          {balance.balanced ? t('portal.glBalanced') : t('portal.glUnbalanced')}
                        </Badge>
                        {!balance.balanced && <span className="text-xs text-red-700">{t('portal.glDiff')}: {fmtEUR(balance.diff)}</span>}
                      </div>
                    )}
                    <Row label={t('portal.glEntries')} value={String(gl.entries.length)} />
                    <Row label={t('gl.totalsDebit')} value={fmtEUR(gl.totals.debits)} />
                    <Row label={t('gl.totalsCredit')} value={fmtEUR(gl.totals.credits)} />
                    {gl.entries.length === 0 && <p className="text-xs text-stone-400">{t('portal.glEmpty')}</p>}
                  </>
                ) : (
                  <p className="text-xs text-stone-400">—</p>
                )}
              </div>

              {/* eSlog odprema */}
              <div className="rounded-lg border border-stone-200 bg-white p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 flex items-center gap-1.5">
                  <Send className="w-3.5 h-3.5" /> {t('portal.einvTitle')}
                </p>
                {outbox ? (
                  <>
                    <Row label={t('portal.einvTotal')} value={String(outbox.total)} />
                    <Row label={t('portal.einvOutstanding')} value={String(outbox.outstandingCount)} />
                    <div className="flex items-center gap-2">
                      <span className="text-stone-600">{t('portal.einvAlerts')}</span>
                      <Badge variant="outline" className={`text-xs ${outbox.alertCount > 0 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {outbox.alertCount}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {EINVOICE_STATUSES.filter((s) => (outbox.byStatus[s] ?? 0) > 0).map((s) => (
                        <Badge key={s} variant="outline" className="text-[11px] bg-stone-50 text-stone-600 border-stone-200">
                          {t(`ei.status.${s}`)}: {outbox.byStatus[s]}
                        </Badge>
                      ))}
                      {outbox.total === 0 && <span className="text-xs text-stone-400">{t('common.none')}</span>}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-stone-400">—</p>
                )}
              </div>

              {/* Portal: stroški (prejeti računi) */}
              <div className="rounded-lg border border-stone-200 bg-white p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-400 flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" /> {t('portal.expTitle')}
                </p>
                <Row label={t('portal.expCount')} value={expCount !== null ? String(expCount) : '—'} />
                <Row label={t('portal.expOutstanding')} value={expOutstanding !== null ? fmtEUR(expOutstanding) : '—'} />
              </div>
            </div>

            <p className="text-xs text-stone-400 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5" /> {t('portal.readonly')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
