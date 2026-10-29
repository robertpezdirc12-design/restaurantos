'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { newOperationId } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, Legend, BarChart, Bar,
} from 'recharts'
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'


/* ─────────────────────────── GOSTINSKE OPERACIJE (AUDIT-FIX val 3) ─────────────────────────── */

/*
 * AUDIT-FIX val 3 (v1.82.3) — drugi val razreza monolita dashboard-tabs.tsx:
 * DarilneKarticeTab + OdpadTab + CakalnaListaTab (~1150 vrst.), dobesedno
 * prenesene (pure move). Barrel dashboard-tabs.tsx re-exporta vse tri —
 * porabniki nespremenjeni.
 */

/* ─────────────────────────── DARILNE KARTICE (triage ③ — izdaja → polnjenje → unovčenje) ─────────────────────────── */

interface GiftCardT {
  id: string; cardNumber: string; balance: number; initialBalance: number
  status: string; effectiveStatus: string; ownerName: string
  purchasedAt: string; expiresAt: string | null; locationId: string | null; createdAt: string
}
interface GiftCardTxT {
  id: string; type: string; amount: number; balanceAfter: number
  orderId?: string | null; checkId?: string | null; note: string; createdAt: string
}
interface GiftCardStatsT { total: number; active: number; totalBalance: number; issued30: number; redeemed30: number }

const GC_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'gc.stActive', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  inactive: { label: 'gc.stInactive', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  exhausted: { label: 'gc.stExhausted', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  expired: { label: 'gc.stExpired', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const GC_TX: Record<string, { label: string; cls: string }> = {
  issue: { label: 'gc.txIssue', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  topup: { label: 'gc.txTopup', cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  redeem: { label: 'gc.txRedeem', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  refund: { label: 'gc.txRefund', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
  adjust: { label: 'gc.txAdjust', cls: 'border-stone-300 bg-stone-50 text-stone-700' },
}

const gcEur = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Issue #1 (triage ③): darilne kartice — pregled, izdaja, polnjenje, ledžer, deaktivacija. */
export function DarilneKarticeTab({ canPay, canManage }: { canPay: boolean; canManage: boolean }) {
  const { t } = useI18n()
  const [cards, setCards] = useState<GiftCardT[]>([])
  const [stats, setStats] = useState<GiftCardStatsT | null>(null)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // izdaja
  const [issueOpen, setIssueOpen] = useState(false)
  const [issueForm, setIssueForm] = useState({ ownerName: '', initialBalance: '', expiresAt: '', note: '' })
  // polnjenje
  const [topupCard, setTopupCard] = useState<GiftCardT | null>(null)
  const [topupForm, setTopupForm] = useState({ amount: '', note: '' })
  // detalj + ledžer
  const [detail, setDetail] = useState<{ card: GiftCardT; transactions: GiftCardTxT[] } | null>(null)

  async function load(search = q) {
    setLoading(true)
    setErr('')
    try {
      const d = await api<{ cards: GiftCardT[]; stats: GiftCardStatsT }>(`/api/giftcards?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`)
      setCards(d.cards)
      setStats(d.stats)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  async function submitIssue() {
    const eur = gcEur(issueForm.initialBalance)
    if (Number.isNaN(eur) || eur < 0) {
      setErr(t('gc.errInitialBalance'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ card: GiftCardT; replayed: boolean }>('/api/giftcards', {
        method: 'POST',
        body: JSON.stringify({
          ownerName: issueForm.ownerName,
          initialBalance: eur,
          expiresAt: issueForm.expiresAt || null,
          note: issueForm.note || undefined,
          clientOperationId: newOperationId(),
        }),
      })
      setOkMsg(d.replayed ? t('gc.okReplayIssue', { num: d.card.cardNumber }) : t('gc.okIssued', { num: d.card.cardNumber }))
      setIssueOpen(false)
      setIssueForm({ ownerName: '', initialBalance: '', expiresAt: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submitTopup() {
    if (!topupCard) return
    const eur = gcEur(topupForm.amount)
    if (Number.isNaN(eur) || eur <= 0) {
      setErr(t('gc.errTopupAmount'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ card: { balance: number }; replayed: boolean }>(`/api/giftcards/${topupCard.id}/topup`, {
        method: 'POST',
        body: JSON.stringify({ amount: eur, note: topupForm.note || undefined, clientOperationId: newOperationId() }),
      })
      setOkMsg(d.replayed ? t('gc.okReplayTopup', { balance: fmtEUR(d.card.balance) }) : t('gc.okTopped', { amount: fmtEUR(eur), balance: fmtEUR(d.card.balance) }))
      setTopupCard(null)
      setTopupForm({ amount: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function openDetail(c: GiftCardT) {
    setErr('')
    try {
      const d = await api<{ card: GiftCardT; transactions: GiftCardTxT[] }>(`/api/giftcards/${c.id}`)
      setDetail(d)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function toggleStatus(c: GiftCardT) {
    const next = c.status === 'active' ? 'inactive' : 'active'
    if (!window.confirm(next === 'inactive' ? t('gc.confirmDeactivate', { num: c.cardNumber }) : t('gc.confirmReactivate', { num: c.cardNumber }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/giftcards/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      setOkMsg(next === 'inactive' ? t('gc.okDeactivated') : t('gc.okReactivated'))
      setDetail(null)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex-1 flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder={t('gc.searchPlaceholder')}
            className="max-w-xs"
            aria-label={t('gc.searchAria')}
          />
          <Button variant="outline" onClick={() => void load()} disabled={loading}>{t('gc.searchBtn')}</Button>
          {q && <Button variant="ghost" onClick={() => { setQ(''); void load('') }}>{t('gc.clearBtn')}</Button>}
        </div>
        {canPay && (
          <Button className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5" onClick={() => { setErr(''); setOkMsg(''); setIssueOpen(true) }}>
            <Plus className="w-4 h-4" /> {t('gc.newCard')}
          </Button>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            [t('gc.statActive'), String(stats.active), t('gc.statActiveSub')],
            [t('gc.statTotal'), fmtEUR(stats.totalBalance), t('gc.statTotalSub')],
            [t('gc.statIssued'), String(stats.issued30), t('gc.statIssuedSub')],
            [t('gc.statRedeemed'), fmtEUR(stats.redeemed30), t('gc.statRedeemedSub')],
          ] as [string, string, string][]).map(([label, val, sub]) => (
            <Card key={label}>
              <CardContent className="p-4">
                <p className="text-xs text-stone-500">{label}</p>
                <p className="text-xl font-bold">{val}</p>
                <p className="text-xs text-stone-400">{sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {okMsg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">{okMsg}</p>}
      {err && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">{err}</p>}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t('gc.cards')} {cards.length > 0 && <span className="text-stone-400 font-normal">({cards.length})</span>}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-4 text-sm text-stone-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {t('gc.loading')}</p>
          ) : cards.length === 0 ? (
            <p className="p-4 text-sm text-stone-500">{t('gc.none')}{q ? t('gc.noneSearch') : ''}. {canPay ? t('gc.noneFirst') : ''}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-stone-500 border-b border-stone-200 sticky top-0 bg-white">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('gc.thNumber')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thOwner')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thSaldo')}</th>
                    <th className="px-4 py-2 font-medium hidden sm:table-cell">{t('gc.thIssued')}</th>
                    <th className="px-4 py-2 font-medium hidden md:table-cell">{t('gc.thValidUntil')}</th>
                    <th className="px-4 py-2 font-medium">{t('gc.thStatus')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => (
                    <tr key={c.id} className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer" onClick={() => void openDetail(c)}>
                      <td className="px-4 py-2.5 font-mono text-xs">{c.cardNumber}</td>
                      <td className="px-4 py-2.5">{c.ownerName || <span className="text-stone-400">—</span>}</td>
                      <td className="px-4 py-2.5 font-semibold">{fmtEUR(c.balance)}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-stone-500">{new Date(c.purchasedAt).toLocaleDateString('sl-SI')}</td>
                      <td className="px-4 py-2.5 hidden md:table-cell text-xs text-stone-500">{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('sl-SI') : '∞'}</td>
                      <td className="px-4 py-2.5"><Badge variant="outline" className={GC_STATUS[c.effectiveStatus]?.cls || ''}>{GC_STATUS[c.effectiveStatus] ? t(GC_STATUS[c.effectiveStatus].label) : c.effectiveStatus}</Badge></td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {canPay && (
                          <Button variant="outline" size="sm" className="h-8 mr-1.5" onClick={() => { setTopupCard(c); setTopupForm({ amount: '', note: '' }); setErr(''); setOkMsg('') }}>
                            {t('gc.topupBtn')}
                          </Button>
                        )}
                        {canManage && c.status !== 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8 text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(c)}>
                            {t('gc.deactivateBtn')}
                          </Button>
                        )}
                        {canManage && c.status === 'inactive' && (
                          <Button variant="outline" size="sm" className="h-8" onClick={() => void toggleStatus(c)}>
                            {t('gc.reactivateBtn')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* dialog: izdaja nove kartice */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader><DialogTitle className="text-lg">{t('gc.issueTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.ownerOptional')}</Label>
              <Input value={issueForm.ownerName} onChange={(e) => setIssueForm((f) => ({ ...f, ownerName: e.target.value }))} placeholder={t('gc.ownerPlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.initialBalance')}</Label>
              <Input type="number" step="0.01" min="0" value={issueForm.initialBalance} onChange={(e) => setIssueForm((f) => ({ ...f, initialBalance: e.target.value }))} placeholder={t('gc.initialBalancePlaceholder')} />
              <p className="text-xs text-stone-500">{t('gc.initialBalanceHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.validUntilOptional')}</Label>
              <Input type="date" value={issueForm.expiresAt} onChange={(e) => setIssueForm((f) => ({ ...f, expiresAt: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('gc.noteOptional')}</Label>
              <Input value={issueForm.note} onChange={(e) => setIssueForm((f) => ({ ...f, note: e.target.value }))} placeholder={t('gc.noteIssuePlaceholder')} />
            </div>
          </div>
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setIssueOpen(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitIssue()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('gc.issueBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: polnjenje */}
      <Dialog open={!!topupCard} onOpenChange={(v) => !v && setTopupCard(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('gc.topupTitle')} {topupCard?.cardNumber}</DialogTitle>
          </DialogHeader>
          {topupCard && (
            <div className="space-y-3">
              <div className="rounded-lg bg-stone-50 border border-stone-200 p-3 text-sm space-y-0.5">
                <p>{t('gc.currentSaldo')} <b>{fmtEUR(topupCard.balance)}</b></p>
                {topupCard.ownerName && <p className="text-stone-500">{t('gc.ownerColon')} {topupCard.ownerName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('gc.topupAmount')}</Label>
                <Input inputMode="decimal" value={topupForm.amount} onChange={(e) => setTopupForm((f) => ({ ...f, amount: e.target.value.replace(/[^\d.,]/g, '') }))} placeholder="10,00" autoFocus />
                <p className="text-xs text-stone-500">{t('gc.topupMaxHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('gc.noteOptional')}</Label>
                <Input value={topupForm.note} onChange={(e) => setTopupForm((f) => ({ ...f, note: e.target.value }))} placeholder={t('gc.noteTopupPlaceholder')} />
              </div>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setTopupCard(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => void submitTopup()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('gc.topupBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dialog: detalj + ledžer transakcij */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-lg">{t('gc.detailTitle')} {detail?.card.cardNumber}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5">
                  <p className="text-xs text-stone-500">{t('gc.thSaldo')}</p>
                  <p className="text-lg font-bold">{fmtEUR(detail.card.balance)}</p>
                  <p className="text-xs text-stone-400">{t('gc.initialLower')} {fmtEUR(detail.card.initialBalance)}</p>
                </div>
                <div className="rounded-lg bg-stone-50 border border-stone-200 p-2.5 space-y-0.5">
                  <p className="text-xs text-stone-500">{t('gc.thStatus')}</p>
                  <Badge variant="outline" className={GC_STATUS[detail.card.effectiveStatus]?.cls || ''}>{GC_STATUS[detail.card.effectiveStatus] ? t(GC_STATUS[detail.card.effectiveStatus].label) : detail.card.effectiveStatus}</Badge>
                  <p className="text-xs text-stone-400">{detail.card.ownerName ? t('gc.ownerLine', { name: detail.card.ownerName }) : t('payment.noOwner')}</p>
                  <p className="text-xs text-stone-400">{detail.card.expiresAt ? t('gc.validUntilLine', { date: new Date(detail.card.expiresAt).toLocaleDateString('sl-SI') }) : t('gc.noExpiry')}</p>
                </div>
              </div>
              {canManage && detail.card.status !== 'inactive' && (
                <Button variant="outline" size="sm" className="text-red-700 border-red-200 hover:bg-red-50" onClick={() => void toggleStatus(detail.card)}>{t('gc.deactivateCardBtn')}</Button>
              )}
              {canManage && detail.card.status === 'inactive' && (
                <Button variant="outline" size="sm" onClick={() => void toggleStatus(detail.card)}>{t('gc.reactivateCardBtn')}</Button>
              )}
              <div>
                <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-1.5">{t('gc.ledger')}</p>
                {detail.transactions.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('gc.noTx')}</p>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-stone-500 border-b border-stone-200 bg-stone-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 font-medium">{t('gc.thType')}</th>
                          <th className="px-3 py-2 font-medium text-right">{t('tips.amount')}</th>
                          <th className="px-3 py-2 font-medium text-right">{t('gc.thBalanceAfter')}</th>
                          <th className="px-3 py-2 font-medium hidden sm:table-cell">{t('proc.note')}</th>
                          <th className="px-3 py-2 font-medium">{t('exp.csvDate')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.transactions.map((tx) => (
                          <tr key={tx.id} className="border-b border-stone-100">
                            <td className="px-3 py-2"><Badge variant="outline" className={GC_TX[tx.type]?.cls || ''}>{GC_TX[tx.type] ? t(GC_TX[tx.type].label) : tx.type}</Badge></td>
                            <td className={`px-3 py-2 text-right font-semibold ${tx.amount < 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{tx.amount > 0 ? '+' : ''}{fmtEUR(tx.amount)}</td>
                            <td className="px-3 py-2 text-right">{fmtEUR(tx.balanceAfter)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell text-xs text-stone-500 max-w-40 truncate" title={tx.note}>{tx.note}</td>
                            <td className="px-3 py-2 text-xs text-stone-500 whitespace-nowrap">{new Date(tx.createdAt).toLocaleString('sl-SI')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter className="sm:items-center">
            <Button variant="outline" onClick={() => setDetail(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ODPAD (issue #1, triage ④) ─────────────────────────── */


interface WasteT {
  id: string
  inventoryItemId: string
  itemName: string
  unit: string
  quantity: number
  reason: string
  reasonLabel: string
  note: string
  costPerUnit: number
  totalCost: number
  reversedAt: string | null
  recordedByUserId: string | null
  createdAt: string
}

interface WasteReasonStatT { reason: string; label: string; count: number; totalCents: number }
interface WasteStatsT { count: number; totalCents: number; byReason: WasteReasonStatT[]; topReason: string | null }

/** Kanonični razlogi (v ravnovesju z src/lib/waste.ts) */
const WASTE_REASON_OPTIONS: { value: string; label: string }[] = [
  { value: 'pokvarjeno', label: 'waste.rPokvareno' },
  { value: 'preteklo', label: 'waste.rPretekelRok' },
  { value: 'priprava', label: 'waste.rPriprava' },
  { value: 'razlitje', label: 'waste.rRazlitje' },
  { value: 'hlajenje', label: 'waste.rHlajenje' },
  { value: 'reklamacija', label: 'waste.rReklamacija' },
  { value: 'drugo', label: 'waste.rDrugo' },
]
const wasteReasonBadgeCls = (reason: string): string => ({
  pokvarjeno: 'border-red-300 bg-red-50 text-red-800',
  preteklo: 'border-amber-300 bg-amber-50 text-amber-800',
  priprava: 'border-orange-300 bg-orange-50 text-orange-800',
  razlitje: 'border-stone-300 bg-stone-50 text-stone-700',
  hlajenje: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  reklamacija: 'border-purple-200 bg-purple-50 text-purple-800',
  drugo: 'border-stone-300 bg-stone-50 text-stone-700',
}[reason] ?? 'border-stone-300 bg-stone-50 text-stone-700')

/** i18n ključi razlogov (vzorec DEVICE_TYPE_KEYS — neznani razlog → surovi label iz API-ja) */
const WASTE_REASON_KEYS: Record<string, string> = {
  pokvarjeno: 'waste.rPokvareno', preteklo: 'waste.rPretekelRok', priprava: 'waste.rPriprava', razlitje: 'waste.rRazlitje', hlajenje: 'waste.rHlajenje', reklamacija: 'waste.rReklamacija', drugo: 'waste.rDrugo',
}

const wasteNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** OdpadTab: lokalni podtip odgovora /api/inventory (vzorec nabava-tab lokalnih tipov). */
interface OdpadInvT { id: string; name: string; unit: string; qty: number; cost: number }

/** Issue #1 (triage ④): odpad hrane — evidenca (zaloga ↓, StockTransaction WASTE), statistika po razlogih, reverzija pomote. */
export function OdpadTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [records, setRecords] = useState<WasteT[]>([])
  const [stats, setStats] = useState<WasteStatsT | null>(null)
  const [items, setItems] = useState<OdpadInvT[]>([])
  const [days, setDays] = useState('30')
  const [reasonFilter, setReasonFilter] = useState('vsi')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // nov odpad
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ itemId: '', quantity: '', reason: '', note: '' })

  async function load(d = days, r = reasonFilter) {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams({ days: d })
      if (r && r !== 'vsi') params.set('reason', r)
      const [w, inv] = await Promise.all([
        api<{ records: WasteT[]; stats: WasteStatsT }>(`/api/waste?${params.toString()}`),
        api<{ inventory: OdpadInvT[] }>('/api/inventory'),
      ])
      setRecords(w.records)
      setStats(w.stats)
      setItems(inv.inventory)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function submitNew() {
    const sel = items.find((i) => i.id === form.itemId)
    if (!sel) {
      setErr(t('waste.errSelectItem'))
      return
    }
    const qty = wasteNum(form.quantity)
    if (Number.isNaN(qty) || qty <= 0) {
      setErr(t('waste.errQty'))
      return
    }
    if (!form.reason) {
      setErr(t('waste.errReason'))
      return
    }
    if (qty > sel.qty) {
      setErr(t('waste.errOverStock', { qty: sel.qty, unit: sel.unit }))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ record: { id: string; quantity: number; totalCost: number; newQty?: number }; replayed: boolean }>('/api/waste', {
        method: 'POST',
        body: JSON.stringify({ itemId: form.itemId, quantity: qty, reason: form.reason, note: form.note || undefined, idempotencyKey: newOperationId() }),
      })
      const idx = items.find((i) => i.id === form.itemId)
      const newQty = d.record.newQty ?? (idx ? idx.qty - d.record.quantity : undefined)
      setOkMsg(d.replayed
        ? t('waste.okReplay')
        : `${t('waste.okRecord', { qty: d.record.quantity, unit: idx?.unit ?? '', cost: fmtEUR(idx?.cost ?? 0), total: fmtEUR(d.record.totalCost) })}${idx && newQty !== undefined ? t('waste.okRecordTail', { qty: idx.qty, newQty: newQty ?? '' }) : ''}`)
      setNewOpen(false)
      setForm({ itemId: '', quantity: '', reason: '', note: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function reverseRecord(w: WasteT) {
    if (!window.confirm(t('waste.confirmReverse', { name: w.itemName, qty: w.quantity, unit: w.unit }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waste/${w.id}/reverse`, { method: 'POST' })
      setOkMsg(t('waste.okReversed', { qty: w.quantity, unit: w.unit, name: w.itemName }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selected = items.find((i) => i.id === form.itemId)
  const selQty = wasteNum(form.quantity)
  const previewCost = selected && Number.isFinite(selQty) && selQty > 0 ? Math.round((Math.round(selQty * 1000) * Math.round(selected.cost * 100)) / 1000) / 100 : null
  const selOver = selected && Number.isFinite(selQty) && selQty > selected.qty

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex-1 flex items-center gap-2 flex-wrap">
          <Select value={days} onValueChange={(v) => { setDays(v); void load(v, reasonFilter) }}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t('waste.days7')}</SelectItem>
              <SelectItem value="30">{t('waste.days30')}</SelectItem>
              <SelectItem value="90">{t('waste.days90')}</SelectItem>
              <SelectItem value="365">{t('waste.days365')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={reasonFilter} onValueChange={(v) => { setReasonFilter(v); void load(days, v) }}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vsi">{t('waste.allReasons')}</SelectItem>
              {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5">
            <Plus className="w-4 h-4" /> {t('waste.newBtn')}
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('waste.inPeriod')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-red-700">{fmtEUR(stats.totalCents / 100)}</p><p className="text-xs text-stone-500">{t('waste.recordsCount', { n: stats.count })}</p></CardContent>
          </Card>
          {stats.byReason.slice(0, 3).map((r) => (
            <Card key={r.reason}>
              <CardHeader className="pb-2"><CardDescription className="text-xs">{WASTE_REASON_KEYS[r.reason] ? t(WASTE_REASON_KEYS[r.reason]) : r.label}</CardDescription></CardHeader>
              <CardContent><p className="text-xl font-semibold">{fmtEUR(r.totalCents / 100)}</p><p className="text-xs text-stone-500">{t('waste.recordsCount', { n: r.count })}</p></CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('waste.title')}</CardTitle>
          <CardDescription className="text-xs">{t('waste.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('waste.loading')}</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-stone-500">{t('waste.none')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">{t('exp.csvDate')}</th>
                    <th className="px-3 py-2 font-medium">{t('proc.article')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('proc.qty')}</th>
                    <th className="px-3 py-2 font-medium">{t('loy.reason')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('waste.thCost')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="px-3 py-2"><span className="sr-only">{t('common.actions')}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {records.map((w) => (
                    <tr key={w.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-xs text-stone-500 whitespace-nowrap">{new Date(w.createdAt).toLocaleString('sl-SI')}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{w.itemName}</span>
                        {w.note && <span className="block text-xs text-stone-500 max-w-56 truncate" title={w.note}>{w.note}</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{w.quantity} {w.unit}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${wasteReasonBadgeCls(w.reason)}`}>{WASTE_REASON_KEYS[w.reason] ? t(WASTE_REASON_KEYS[w.reason]) : w.reasonLabel}</Badge></td>
                      <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{fmtEUR(w.totalCost)}</td>
                      <td className="px-3 py-2">
                        {w.reversedAt ? <Badge variant="outline" className="text-xs border-stone-300 bg-stone-50 text-stone-600">{t('waste.reversedBadge')}</Badge> : <Badge variant="outline" className="text-xs border-emerald-300 bg-emerald-50 text-emerald-800">{t('waste.validBadge')}</Badge>}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2 text-right">
                          {!w.reversedAt && (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => void reverseRecord(w)}>{t('waste.reverseBtn')}</Button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Nov odpad */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('waste.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="waste-item">{t('proc.article')}</Label>
              <Select value={form.itemId} onValueChange={(v) => setForm({ ...form, itemId: v })}>
                <SelectTrigger id="waste-item"><SelectValue placeholder={t('waste.itemPlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name} ({i.qty} {i.unit} {t('waste.onStock')})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="waste-qty">{t('proc.qty')} {selected ? `(${selected.unit})` : ''}</Label>
                <Input id="waste-qty" inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder={t('waste.qtyPlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="waste-reason">{t('loy.reason')}</Label>
                <Select value={form.reason} onValueChange={(v) => setForm({ ...form, reason: v })}>
                  <SelectTrigger id="waste-reason"><SelectValue placeholder={t('waste.reasonPlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {WASTE_REASON_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{t(r.label)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="waste-note">{t('waste.noteOptional')}</Label>
              <Input id="waste-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('waste.notePlaceholder')} />
            </div>
            {selected && (
              <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 space-y-0.5">
                <p>{t('waste.onStockColon')} <strong>{selected.qty} {selected.unit}</strong> {t('waste.priceColon')} {fmtEUR(selected.cost)} / {selected.unit}</p>
                {Number.isFinite(selQty) && selQty > 0 && previewCost !== null && (
                  <p className={selOver ? 'text-red-700 font-medium' : ''}>
                    {t('waste.estimatedCost')} <strong>{fmtEUR(previewCost)}</strong>
                    {selOver ? t('waste.overStockSuffix', { qty: selected.qty, unit: selected.unit }) : t('waste.afterWasteSuffix', { qty: Math.round((selected.qty - selQty) * 1000) / 1000, unit: selected.unit })}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.itemId || !form.reason || !form.quantity}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('waste.submitBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}

/* ─────────────────────────── ČAKALNA LISTA (issue #1, triage ⑤) ─────────────────────────── */

interface WaitlistEntryT {
  id: string
  guestName: string
  guestPhone: string
  partySize: number
  quotedWaitMinutes: number
  actualWaitMinutes: number
  preferredArea: string
  specialNeeds: string
  notes: string
  status: string
  checkedInAt: string
  notifiedAt: string | null
  notifyStatus: string | null
  seatedAt: string | null
  leftAt: string | null
  tableId: string | null
  tableNumber: number | null
  locationId: string | null
}

interface WaitlistStatsT { waiting: number; notified: number; seated: number; left: number; waitingParty: number; avgActualWait: number; maxActualWait: number }

interface TableLiteT { id: string; name: string; number: number; zone: string; seats: number; status: string }

/** Slovenska n-tev "oseba" (v ravnovesju z src/lib/waitlist.ts) */
const wlParty = (n: number, tx: (key: string, vars?: Record<string, string | number>) => string): string => {
  const v = Math.max(0, Math.floor(n))
  if (v === 1) return tx('wl.party1')
  if (v === 2) return tx('wl.party2')
  if (v === 3 || v === 4) return tx('wl.party34', { n: v })
  return tx('wl.partyN', { n: v })
}
const wlMin = (s: string, now: number): number => {
  const a = new Date(s).getTime()
  return Number.isFinite(a) && now > a ? Math.floor((now - a) / 60_000) : 0
}
const wlDur = (m: number): string => {
  const v = Math.max(0, Math.floor(m))
  return v < 60 ? `${v} min` : `${Math.floor(v / 60)} h ${v % 60} min`
}
const wlStatusBadge = (status: string, tx: (key: string) => string): { label: string; cls: string } => ({
  waiting: { label: tx('wl.stWaiting'), cls: 'border-amber-300 bg-amber-50 text-amber-800' },
  notified: { label: tx('wl.stNotified'), cls: 'border-emerald-300 bg-emerald-50 text-emerald-800' },
  seated: { label: tx('wl.stSeated'), cls: 'border-green-300 bg-green-50 text-green-800' },
  left: { label: tx('wl.stLeft'), cls: 'border-stone-300 bg-stone-50 text-stone-600' },
}[status] ?? { label: status, cls: 'border-stone-300 bg-stone-50 text-stone-700' })

/** v1.188.0 (P2-14): sporočilo izida SMS poskusa (tzv. tihi uspeh — uporabno le, ko kaj ni v redu). */
const smsOutcomeMsg = (notifyStatus: string, tx: (key: string) => string): string => ({
  sent: tx('wl.smsSent'),
  failed: tx('wl.smsFailed'),
  no_phone: tx('wl.smsNoPhone'),
  sms_unconfigured: tx('wl.smsUnconfigured'),
}[notifyStatus] ?? '')

/** Issue #1 (triage ⑤): čakalna lista — prijava → obvestilo → usaditev (zaklene mizo) / odhod + statistika. */

export function CakalnaListaTab({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [active, setActive] = useState<WaitlistEntryT[]>([])
  const [finished, setFinished] = useState<WaitlistEntryT[]>([])
  const [stats, setStats] = useState<WaitlistStatsT | null>(null)
  const [tables, setTables] = useState<TableLiteT[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [tick, setTick] = useState(0) // živo osveževanje minut čakanja

  // nova prijava
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ guestName: '', guestPhone: '', partySize: '2', quotedWaitMinutes: '15', preferredArea: '', specialNeeds: '', notes: '' })
  // usaditev
  const [seatFor, setSeatFor] = useState<WaitlistEntryT | null>(null)
  const [seatTableId, setSeatTableId] = useState('')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const [w, t] = await Promise.all([
        api<{ active: WaitlistEntryT[]; finished: WaitlistEntryT[]; stats: WaitlistStatsT }>('/api/waitlist?days=1'),
        api<{ tables: TableLiteT[] }>('/api/tables'),
      ])
      setActive(w.active)
      setFinished(w.finished)
      setStats(w.stats)
      setTables(t.tables)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const iv = setInterval(() => setTick((x) => x + 1), 30_000) // žive minute brez ponovnega nalaganja
    return () => clearInterval(iv)
  }, [])

  async function submitNew() {
    const party = Number(form.partySize)
    if (!form.guestName.trim()) {
      setErr(t('wl.errName'))
      return
    }
    if (!Number.isInteger(party) || party < 1) {
      setErr(t('wl.errParty'))
      return
    }
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      await api('/api/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          guestName: form.guestName,
          guestPhone: form.guestPhone || undefined,
          partySize: party,
          quotedWaitMinutes: form.quotedWaitMinutes === '' ? 0 : Number(form.quotedWaitMinutes.replace(',', '.')),
          preferredArea: form.preferredArea || undefined,
          specialNeeds: form.specialNeeds || undefined,
          notes: form.notes || undefined,
        }),
      })
      setOkMsg(t('wl.okAdded', { name: form.guestName.trim() }))
      setNewOpen(false)
      setForm({ guestName: '', guestPhone: '', partySize: '2', quotedWaitMinutes: '15', preferredArea: '', specialNeeds: '', notes: '' })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function resendSms(w: WaitlistEntryT) {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ entry: { id: string; status: string }; notifyStatus: string }>('/api/waitlist', {
        method: 'PATCH',
        body: JSON.stringify({ id: w.id, resend: true }),
      })
      const sms = smsOutcomeMsg(d.notifyStatus, t)
      setOkMsg(sms || t('wl.okNotified', { name: w.guestName }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function transition(w: WaitlistEntryT, status: string, tableId?: string) {
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ entry: { id: string; status: string; actualWaitMinutes?: number | null }; notifyStatus?: string }>('/api/waitlist', {
        method: 'PATCH',
        body: JSON.stringify({ id: w.id, status, tableId: tableId || undefined }),
      })
      if (status === 'notified') {
        // v1.188.0 (P2-14): izid SMS poskusa — uspeh je tih (glavno sporočilo že
        // pravi obveščen), napaka/brez številke/brez nastavitve pa vidi gostinec.
        const sms = d.notifyStatus ? smsOutcomeMsg(d.notifyStatus, t) : ''
        setOkMsg(t('wl.okNotified', { name: w.guestName }) + (sms ? ` ${sms}` : ''))
      }
      else if (status === 'seated') setOkMsg(t('wl.okSeated', { name: w.guestName, wait: d.entry.actualWaitMinutes !== null && d.entry.actualWaitMinutes !== undefined ? t('wl.okSeatedWait', { dur: wlDur(d.entry.actualWaitMinutes) }) : '' }))
      else setOkMsg(t('wl.okLeft', { name: w.guestName }))
      setSeatFor(null)
      setSeatTableId('')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function seatEntry() {
    if (!seatFor) return
    if (!seatTableId) {
      setErr(t('wl.errSelectTable'))
      return
    }
    await transition(seatFor, 'seated', seatTableId)
  }

  async function releaseTable(w: WaitlistEntryT) {
    if (!window.confirm(t('wl.confirmRelease', { name: w.guestName, table: w.tableNumber ? t('wl.tableN', { n: w.tableNumber }) : '' }))) return
    setBusy(true)
    setErr('')
    setOkMsg('')
    try {
      const d = await api<{ released: boolean }>('/api/waitlist', {
        method: 'PATCH',
        body: JSON.stringify({ id: w.id, releaseTable: true }),
      })
      const table = w.tableNumber ? t('wl.tableN', { n: w.tableNumber }) : ''
      setOkMsg(d.released ? t('wl.okReleased', { table }) : t('wl.okReleaseNoop', { table }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteEntry(w: WaitlistEntryT) {
    if (!window.confirm(t('wl.confirmDelete', { name: w.guestName }))) return
    setBusy(true)
    setErr('')
    try {
      await api(`/api/waitlist?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' })
      setOkMsg(t('wl.okDeleted', { name: w.guestName }))
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const nowMs = Date.now() + tick * 0 // tick sproži ponovni izris živih minut
  const freeTables = tables.filter((t) => t.status !== 'OCCUPIED')

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-sm text-stone-600">
          {t('wl.desc')}
        </div>
        {canManage && (
          <Button onClick={() => { setErr(''); setOkMsg(''); setNewOpen(true) }} className="gap-1.5 shrink-0">
            <Plus className="w-4 h-4" /> {t('wl.newBtn')}
          </Button>
        )}
      </div>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statWaiting')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-amber-700">{stats.waiting}</p><p className="text-xs text-stone-500">{wlParty(stats.waitingParty, t)} {t('wl.naListo')}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statNotified')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-emerald-700">{stats.notified}</p><p className="text-xs text-stone-500">{t('wl.preparingTable')}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statSeated')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold text-green-700">{stats.seated}</p><p className="text-xs text-stone-500">{t('wl.leftCount', { n: stats.left })}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardDescription className="text-xs">{t('wl.statAvgWait')}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold">{wlDur(stats.avgActualWait)}</p><p className="text-xs text-stone-500">{t('wl.longest', { dur: wlDur(stats.maxActualWait) })}</p></CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('wl.activeTitle')}</CardTitle>
          <CardDescription className="text-xs">{t('wl.activeDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('gc.loading')}</p>
          ) : active.length === 0 ? (
            <p className="text-sm text-stone-500">{t('wl.empty')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">{t('wl.thGuest')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('wl.thWait')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="px-3 py-2 text-right"><span className="sr-only">{t('common.actions')}</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {active.map((w, i) => {
                    const mins = wlMin(w.checkedInAt, nowMs)
                    const over = w.quotedWaitMinutes > 0 && mins > w.quotedWaitMinutes
                    const badge = wlStatusBadge(w.status, t)
                    return (
                      <tr key={w.id} className="border-b last:border-0 align-top">
                        <td className="px-3 py-2 text-xs text-stone-400 font-medium">{i + 1}.</td>
                        <td className="px-3 py-2">
                          <span className="font-medium">{w.guestName}</span>
                          <span className="block text-xs text-stone-500">{wlParty(w.partySize, t)}{w.guestPhone ? ` · ${w.guestPhone}` : ''}{w.preferredArea ? ` · ${w.preferredArea}` : ''}</span>
                          {(w.specialNeeds || w.notes) && (
                            <span className="block text-xs text-stone-500 max-w-64 truncate" title={w.specialNeeds || w.notes}>ℹ {w.specialNeeds || w.notes}</span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right whitespace-nowrap ${over ? 'text-red-700 font-semibold' : ''}`}>
                          {wlDur(mins)}
                          <span className="block text-xs text-stone-400">{t('wl.forecast')} {w.quotedWaitMinutes > 0 ? `≈ ${w.quotedWaitMinutes} min` : '—'}</span>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-xs ${badge.cls}`}>{badge.label}</Badge>
                          {w.status === 'notified' && w.notifyStatus && w.notifyStatus !== 'sent' && (
                            <span className="block text-xs text-stone-500 mt-0.5">{smsOutcomeMsg(w.notifyStatus, t)}</span>
                          )}
                        </td>
                        {canManage && (
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {w.status === 'waiting' && (
                                <Button variant="outline" size="sm" disabled={busy} onClick={() => void transition(w, 'notified')} title={t('wl.notifyTitle')}>
                                  <Bell className="w-3.5 h-3.5" /> {t('wl.notifyBtn')}
                                </Button>
                              )}
                              {w.status === 'notified' && w.notifyStatus === 'failed' && (
                                <Button variant="outline" size="sm" disabled={busy} onClick={() => void resendSms(w)} title={t('wl.smsResend')}>
                                  <Bell className="w-3.5 h-3.5" /> {t('wl.smsResend')}
                                </Button>
                              )}
                              <Button size="sm" disabled={busy} onClick={() => { setSeatFor(w); setSeatTableId('') }} title={t('wl.seatTitle')}>
                                <UserCheck className="w-3.5 h-3.5" /> {t('wl.seatBtn')}
                              </Button>
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(t('wl.confirmLeft', { name: w.guestName }))) void transition(w, 'left') }}>
                                {t('wl.leftBtn')}
                              </Button>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void deleteEntry(w)} aria-label={t('wl.deleteAria', { name: w.guestName })} title={t('wl.deleteTitle')}>
                                <Trash2 className="w-3.5 h-3.5 text-stone-400" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {finished.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('wl.finishedTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('wl.finishedDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-stone-500 border-b">
                    <th className="px-3 py-2 font-medium">{t('wl.thGuest')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('wl.thWaited')}</th>
                    <th className="px-3 py-2 font-medium">{t('wl.thTable')}</th>
                    <th className="px-3 py-2 font-medium">{t('shifts.csvStatus')}</th>
                    <th className="px-3 py-2 font-medium text-right">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {finished.map((w) => {
                    const badge = wlStatusBadge(w.status, t)
                    return (
                      <tr key={w.id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{w.guestName} <span className="text-xs text-stone-400 font-normal">{wlParty(w.partySize, t)}</span></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{w.status === 'seated' ? wlDur(w.actualWaitMinutes) : '—'}</td>
                        <td className="px-3 py-2 text-xs text-stone-600">{w.tableNumber ? t('wl.tableN', { n: w.tableNumber }) : '—'}</td>
                        <td className="px-3 py-2"><Badge variant="outline" className={`text-xs ${badge.cls}`}>{badge.label}</Badge></td>
                        <td className="px-3 py-2 text-right">
                          {w.status === 'seated' && w.tableId && tables.find((tb) => tb.id === w.tableId)?.status === 'OCCUPIED' ? (
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => void releaseTable(w)}>
                              {t('wl.releaseBtn')}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Nova prijava */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('wl.newTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-name">{t('loy.guestName')}</Label>
                <Input id="wl-name" value={form.guestName} onChange={(e) => setForm({ ...form, guestName: e.target.value })} placeholder={t('wl.namePlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-phone">{t('wl.phoneOptional')}</Label>
                <Input id="wl-phone" value={form.guestPhone} onChange={(e) => setForm({ ...form, guestPhone: e.target.value })} placeholder="041 234 567" />
                <p className="text-xs text-stone-400">{t('wl.smsHint')}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="wl-party">{t('wl.partyLabel')}</Label>
                <Input id="wl-party" inputMode="numeric" value={form.partySize} onChange={(e) => setForm({ ...form, partySize: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="wl-quote">{t('wl.quoteLabel')}</Label>
                <Input id="wl-quote" inputMode="numeric" value={form.quotedWaitMinutes} onChange={(e) => setForm({ ...form, quotedWaitMinutes: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-area">{t('wl.areaLabel')}</Label>
              <Input id="wl-area" value={form.preferredArea} onChange={(e) => setForm({ ...form, preferredArea: e.target.value })} placeholder={t('wl.areaPlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-needs">{t('wl.needsLabel')}</Label>
              <Input id="wl-needs" value={form.specialNeeds} onChange={(e) => setForm({ ...form, specialNeeds: e.target.value })} placeholder={t('wl.needsPlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wl-notes">{t('waste.noteOptional')}</Label>
              <Input id="wl-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={t('wl.notesPlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => void submitNew()} disabled={busy || !form.guestName.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('wl.submitBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Usaditev */}
      <Dialog open={!!seatFor} onOpenChange={(o) => !o && setSeatFor(null)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('wl.seatTitleDialog', { name: seatFor?.guestName ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {seatFor && (
              <p className="text-sm text-stone-600">
                {wlParty(seatFor.partySize, t)} {t('wl.waitingSince')} <strong>{wlDur(wlMin(seatFor.checkedInAt, Date.now()))}</strong>
                {seatFor.preferredArea ? t('wl.wantsSuffix', { area: seatFor.preferredArea }) : ''}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="wl-table">{t('wl.thTable')}</Label>
              <Select value={seatTableId} onValueChange={setSeatTableId}>
                <SelectTrigger id="wl-table"><SelectValue placeholder={t('wl.tablePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {freeTables.map((tbl) => (
                    <SelectItem key={tbl.id} value={tbl.id}>
                      {tbl.name} ({t('tables.seats', { n: tbl.seats })} · {tbl.zone}{tbl.status !== 'FREE' ? ` · ${tbl.status === 'RESERVED' ? t('wl.tblReserved') : tbl.status === 'DIRTY' ? t('wl.tblDirty') : ''}` : ''})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {seatFor && freeTables.length === 0 && (
                <p className="text-xs text-red-600">{t('wl.noFreeTables')}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeatFor(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void seatEntry()} disabled={busy || !seatTableId}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />} {t('wl.seatBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
    </div>
  )
}
