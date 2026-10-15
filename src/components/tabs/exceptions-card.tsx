'use client'

/**
 * Issue #19 (P1/P2, v1.107.0) — Poročilo finančnih izjem (kartica v zavihku Računi).
 *
 * Vir: /api/reports/exceptions (reports.view + locationScope) — KANONIČNE audit
 * vrstice (en vir resnice). Prikaz: KPI ploščice po vrstah (popust/odstranjen
 * popust/preklic postavke/preklic naročila/fiskalni storno), tabela z razlogom,
 * izvedel/odobril + zneskom, CSV izvoz. Zgodovinske vrstice pred v1.107.0 so
 * pošteno označene (brez razloga) — revizijska sled je append-only.
 */
import { useEffect, useState } from 'react'
import { api, getToken } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2, RefreshCw, Ban, Percent, FileDown, ShieldCheck } from 'lucide-react'

interface ExcRow {
  id: string
  at: string
  kind: string
  action: string
  actorName: string | null
  amount: number | null
  orderNumber: number | null
  receiptNumber: string | null
  reasonName: string | null
  reasonText: string | null
  reasonComment: string | null
  approved: boolean
  approvalMethod: string | null
  approverName: string | null
}
interface ExcResp {
  from: string
  to: string
  rows: ExcRow[]
  total: number
  truncated: boolean
  byKind: Record<string, { count: number; amount: number | null }>
  byReason: Record<string, { count: number; amount: number | null }>
  withoutReasonCount: number
}

const KIND_ORDER = ['discount', 'discount_remove', 'void', 'cancel', 'storno']
const KIND_STYLE: Record<string, string> = {
  discount: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  discount_remove: 'bg-amber-100 text-amber-800 border-amber-200',
  void: 'bg-rose-100 text-rose-800 border-rose-200',
  cancel: 'bg-stone-200 text-stone-700 border-stone-300',
  storno: 'bg-violet-100 text-violet-800 border-violet-200',
}

export function ExceptionsReportCard() {
  const { t } = useI18n()
  const now = new Date()
  const [from, setFrom] = useState(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10))
  const [to, setTo] = useState(now.toISOString().slice(0, 10))
  const [data, setData] = useState<ExcResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true)
      setErr('')
      try {
        const d = await api<ExcResp>(`/api/reports/exceptions?from=${from}&to=${to}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [from, to, reload])

  const downloadCsv = async () => {
    try {
      const token = getToken()
      const res = await fetch(`/api/reports/exceptions?from=${from}&to=${to}&format=csv`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `izjeme-${from}_${to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast({ description: t('exc.report.csv') + ': napaka' })
    }
  }

  const kindLabel = (k: string) =>
    t(`exc.report.kind.${k}`) === `exc.report.kind.${k}` ? k : t(`exc.report.kind.${k}`)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" /> {t('exc.report.title')}
        </CardTitle>
        <p className="text-xs text-stone-500">{t('exc.report.subtitle')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="exc-from">{t('exp.csvDate')} od</label>
            <Input id="exc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase text-stone-400" htmlFor="exc-to">do</label>
            <Input id="exc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" />
          </div>
          <Button size="sm" variant="outline" className="h-9 gap-1.5" disabled={busy} onClick={() => setReload((r) => r + 1)}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {t('exc.report.refresh')}
          </Button>
          <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => void downloadCsv()} disabled={!data || data.total === 0}>
            <FileDown className="w-3.5 h-3.5" /> {t('exc.report.csv')}
          </Button>
        </div>

        {busy && <Skeleton className="h-24 w-full" />}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {data && !busy && data.total === 0 && <p className="text-sm text-stone-500">{t('exc.report.none')}</p>}

        {data && !busy && data.total > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {KIND_ORDER.filter((k) => data.byKind[k]).map((k) => (
                <div key={k} className="rounded-lg border border-stone-200 p-2.5">
                  <p className="text-xs text-stone-500 truncate">{kindLabel(k)}</p>
                  <p className="text-lg font-bold">{data.byKind[k].count}</p>
                  {data.byKind[k].amount !== null && (
                    <p className="text-[11px] text-stone-400">{data.byKind[k].amount?.toFixed(2)} €</p>
                  )}
                </div>
              ))}
            </div>

            {data.withoutReasonCount > 0 && (
              <p className="text-xs text-amber-700">
                {data.withoutReasonCount} × {t('exc.report.legacyNoReason')} — {t('exc.report.noReason')}
              </p>
            )}
            {data.truncated && <p className="text-xs text-amber-700">⇥ {data.total}+</p>}

            <div className="max-h-96 overflow-y-auto pr-1 space-y-1.5">
              {data.rows.map((e) => (
                <div key={e.id} className="rounded-lg border border-stone-200 bg-white p-2.5 text-sm flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className={KIND_STYLE[e.kind] || ''}>{kindLabel(e.kind)}</Badge>
                      {e.amount !== null && <span className="font-semibold">{e.amount.toFixed(2)} €</span>}
                      {e.orderNumber !== null && <span className="text-xs text-stone-400">#{e.orderNumber}</span>}
                      {e.receiptNumber && <span className="text-xs text-stone-400 font-mono">{e.receiptNumber}</span>}
                    </p>
                    <p className="text-xs text-stone-600 mt-1">
                      {e.reasonName || e.reasonText || t('exc.report.noReason')}
                      {e.reasonComment ? ` · ${e.reasonComment}` : ''}
                    </p>
                    <p className="text-[11px] text-stone-400 mt-0.5">
                      {new Date(e.at).toLocaleString('sl-SI')} · {e.actorName || '—'}
                      {e.approved && e.approverName ? ` · ${t('exc.report.approvers')}: ${e.approverName} (${e.approvalMethod})` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
