'use client'

/**
 * PRIMERJAVA §34 (v1.260.0; Square Vol 13 september 2026 »Create revenue centers
 * to group and compare sales«): »Grouping the Sales summary report by revenue
 * center then shows how each area performed.« — kartica v zavihku Računi
 * (dom poročila o prodaji) grupira PLAČANA naročila izbranega obdobja po
 * prihodkovnih centrih: CONA mize (DINE_IN) + kanala ODNES in DOSTAVA.
 *
 * Obdobje NADZORUJE zavihek (ista from/to kot knjigovodski portal in seznam
 * računov — Issue #94 vzorec); kartica nima lastnih datumov, SAMO prikaz.
 * Data: GET /api/reports/revenue-centers (READ-ONLY, izpeljava ob branju —
 * 0 DDL, 0 mutacij; center = Table.area | Order.type, glej ruto za prevod).
 *
 * Vrstni red = neto padajoče (»who is carrying the day«); prazne cone so
 * vidne (mrtvo območje je informacija — Square izrise vse centre).
 */
import { useEffect, useState } from 'react'
import { api, fmtEUR } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartPie, Loader2, RefreshCw } from 'lucide-react'

interface RcRowT {
  key: string
  kind: 'zone' | 'takeaway' | 'delivery' | 'none'
  label: string | null
  orders: number
  gross: number
  net: number
  tips: number
  avgCheck: number
  share: number
}
interface RcRespT {
  from: string
  to: string
  rows: RcRowT[]
  totals: { orders: number; gross: number; net: number; tips: number }
}

/** Oznaka vrste vrstice — cone so uporabniški podatek, kanali/»brez« iz besednjaka
 *  (order.type.* POZIVAMO — en vir resnice z ostalim UI, brez podvajanja prevodov). */
function centerLabel(r: RcRowT, t: (k: string) => string): string {
  if (r.kind === 'zone') return r.label || '—'
  if (r.kind === 'takeaway') return t('order.type.TAKEAWAY')
  if (r.kind === 'delivery') return t('order.type.DELIVERY')
  return t('rc.none')
}

export function RevenueCentersCard(props: {
  /** Issue #94 vzorec: obdobje je NADZOROVANO iz zavihka Računi (isti okvir kot
   *  portal + seznam računov) — kartica ga samo bere. */
  from: string
  to: string
}) {
  const { t } = useI18n()
  const [data, setData] = useState<RcRespT | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setBusy(true); setErr('')
      try {
        const d = await api<RcRespT>(`/api/reports/revenue-centers?from=${props.from}&to=${props.to}`)
        if (alive) setData(d)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => { alive = false }
  }, [props.from, props.to, reload])

  const rows = data?.rows || []
  const hasData = !!data && data.totals.orders > 0

  return (
    <Card data-region="revenue-centers-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <ChartPie className="w-4 h-4" /> {t('rc.title')}
          <span className="ml-auto flex items-center gap-2">
            {data && (
              <span className="text-xs font-normal text-stone-500" data-region="rc-window">
                {new Date(data.from).toLocaleDateString('sl-SI')} – {new Date(data.to).toLocaleDateString('sl-SI')}
              </span>
            )}
            <Button
              size="sm" variant="outline" className="h-8 w-8 p-0" aria-label={t('common.refresh')}
              disabled={busy} onClick={() => setReload((n) => n + 1)}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-stone-500">{t('rc.desc')}</p>

        {busy && !data && (
          <div className="space-y-2" data-region="rc-skeleton">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        )}
        {err && (
          <p className="text-sm text-red-700" role="alert" data-region="rc-error">
            {t('rc.loadErr')} <span className="text-xs text-stone-500">({err})</span>
          </p>
        )}
        {data && !err && !hasData && (
          <p className="text-sm text-stone-500" data-region="rc-empty">{t('rc.empty')}</p>
        )}

        {data && hasData && (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm" data-region="rc-table">
              <thead>
                <tr className="text-left text-xs text-stone-500 border-b border-stone-200">
                  <th scope="col" className="py-2 pr-3 font-medium">{t('rc.colCenter')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">{t('rc.colOrders')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right hidden sm:table-cell">{t('rc.colGross')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right">{t('rc.colNet')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right hidden md:table-cell">{t('rc.colTips')}</th>
                  <th scope="col" className="py-2 pr-3 font-medium text-right hidden sm:table-cell">{t('rc.colAvg')}</th>
                  <th scope="col" className="py-2 font-medium text-right min-w-[110px]">{t('rc.colShare')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-region="rc-row" data-kind={r.kind} className="border-b border-stone-100 last:border-0">
                    <td className="py-2.5 pr-3 min-w-[120px]">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-stone-900">{centerLabel(r, t)}</span>
                        {r.kind === 'zone' && <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-stone-50 text-stone-500 border-stone-200">{t('rc.zone')}</Badge>}
                        {r.kind !== 'zone' && r.kind !== 'none' && <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-50 text-amber-800 border-amber-200">{t('rc.channel')}</Badge>}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-stone-600">{r.orders}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-stone-600 hidden sm:table-cell">{fmtEUR(r.gross)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-stone-900">{fmtEUR(r.net)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-stone-600 hidden md:table-cell">{fmtEUR(r.tips)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums text-stone-600 hidden sm:table-cell">{fmtEUR(r.avgCheck)}</td>
                    <td className="py-2.5 text-right">
                      <span className="flex items-center justify-end gap-2">
                        <span
                          aria-hidden
                          className={`h-2 rounded-full ${r.kind === 'zone' ? 'bg-emerald-700' : r.kind === 'none' ? 'bg-stone-400' : 'bg-amber-700'}`}
                          style={{ width: `${Math.max(2, Math.min(100, r.share))}%`, minWidth: 4 }}
                        />
                        <span className="tabular-nums text-stone-700 w-12">{r.share.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} %</span>
                        <span className="sr-only">{t('rc.ariaShare', { p: r.share.toLocaleString('sl-SI', { maximumFractionDigits: 1 }) })}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-region="rc-total-row" className="border-t-2 border-stone-300 font-semibold text-stone-900">
                  <td className="py-2.5 pr-3">{t('rc.total')}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{data.totals.orders}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums hidden sm:table-cell">{fmtEUR(data.totals.gross)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{fmtEUR(data.totals.net)}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums hidden md:table-cell">{fmtEUR(data.totals.tips)}</td>
                  <td className="py-2.5 pr-3 hidden sm:table-cell" />
                  <td className="py-2.5 text-right tabular-nums">100 %</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
