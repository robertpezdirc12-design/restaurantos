'use client'

/**
 * Issue #16 (P1/P2, v1.108.0) — Blagajniški premiki denarja (kartica v zavihku
 * Izmene, pod odprto izmeno).
 *
 * Vir: /api/shifts/movements?shiftId= (cash.manage). Prikaz:
 *  - živo pričakovano stanje predala + razčlenitev (SLEPI POPIS: politika
 *    cashBlindCount skrije pričakovano NE-vodstveni vlogi do oddaje štetja);
 *  - obrazec za nov premik (6 tipov, smer izpeljana; menjalni fond izrecen);
 *  - zgodovina premikov (vrstni red, razlog, uporabnik, čas, naprava,
 *    prejšnje→novo pričakovano, status kompenzacijskega zapisa);
 *  - razveljavitev = KOMPENZACIJSKI zapis z razlogom (urejanje/brisanje sta
 *    prepovedana — strežnik zavrača, UI ponudi samo void);
 *  - CSV izvoz za računovodstvo (NEPRODAJNI premiki — ločeno od prodaje).
 *
 * UI jasno ločuje »gotovina v predalu« (pričakovano stanje) od »gotovinska
 * prodaje« (cashSales) in »denar odveden v sef« (safeDrop) — issue §3.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, fmtEUR } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, RefreshCw, ArrowDownToLine, ArrowUpFromLine, Ban, FileDown, Coins, Vault } from 'lucide-react'

interface MovementT {
  id: string
  type: string
  direction: 'in' | 'out'
  amount: number
  reasonId: string | null
  reasonName: string
  reasonText: string
  note: string
  userName: string
  deviceId: string
  receiptRef: string
  status: string
  voidedByName: string
  voidReason: string
  reversalOfId: string | null
  expectedAfter: number
  createdAt: string
}

interface MovementsResp {
  movements: MovementT[]
  summary: {
    paidIn?: number
    paidOut?: number
    safeDrop?: number
    guestRefund?: number
    net?: number
    count: number
    voidedCount: number
    blind?: boolean
  }
  runningExpected: number | null
  shiftStatus: string
  startingCash: number
  policy: { varianceThresholdCents: number; blindCount: boolean }
  reasons: { id: string; name: string }[]
  ddlPending?: boolean
}

const TYPE_ORDER = ['paid_in', 'paid_out', 'supplier_payment', 'safe_drop', 'guest_refund', 'change_fund'] as const

const TYPE_STYLE: Record<string, string> = {
  paid_in: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  paid_out: 'bg-amber-100 text-amber-800 border-amber-200',
  supplier_payment: 'bg-orange-100 text-orange-800 border-orange-200',
  safe_drop: 'bg-violet-100 text-violet-800 border-violet-200',
  guest_refund: 'bg-rose-100 text-rose-800 border-rose-200',
  change_fund: 'bg-sky-100 text-sky-800 border-sky-200',
}

/** Tipi z obvezno opombo (isti seznam kot strežnik). */
const NOTE_REQUIRED = new Set(['supplier_payment', 'safe_drop', 'guest_refund'])
/** Tipi z obveznim razlogom. */
const REASON_REQUIRED = new Set(['supplier_payment', 'guest_refund'])

export function CashMovementsCard({ shiftId, isManager }: { shiftId: string; isManager: boolean }) {
  const { t } = useI18n()
  const [data, setData] = useState<MovementsResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // obrazec
  const [type, setType] = useState<string>('paid_out')
  const [direction, setDirection] = useState<'in' | 'out'>('out')
  const [amount, setAmount] = useState('')
  const [reasonId, setReasonId] = useState<string>('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [receiptRef, setReceiptRef] = useState('')

  // razveljavitev
  const [voidTarget, setVoidTarget] = useState<MovementT | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [approverEmail, setApproverEmail] = useState('')
  const [approverPin, setApproverPin] = useState('')
  const [idemKey, setIdemKey] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      const d = await api<MovementsResp>(`/api/shifts/movements?shiftId=${shiftId}`)
      setData(d)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [shiftId])

  useEffect(() => {
    void load()
  }, [load])

  // posodobi smer ob izbiri tipa (change_fund obdrži izrecno)
  useEffect(() => {
    if (type === 'paid_in') setDirection('in')
    else if (type !== 'change_fund') setDirection('out')
  }, [type])

  async function submit() {
    const amt = Number(amount.replace(',', '.'))
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: t('cmv.errAmount') })
      return
    }
    if (NOTE_REQUIRED.has(type) && note.trim().length < 3) {
      toast({ title: t('cmv.errNote') })
      return
    }
    if (REASON_REQUIRED.has(type) && !reasonId && reason.trim().length < 3) {
      toast({ title: t('cmv.errReason') })
      return
    }
    setBusy(true)
    try {
      const key = idemKey || `cmv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await api('/api/shifts/movements', {
        method: 'POST',
        body: JSON.stringify({
          shiftId,
          type,
          direction: type === 'change_fund' ? direction : undefined,
          amount: amt,
          reasonId: reasonId || undefined,
          reason: reasonId ? undefined : reason.trim() || undefined,
          note: note.trim() || undefined,
          receiptRef: receiptRef.trim() || undefined,
          idempotencyKey: key,
        }),
      })
      setIdemKey('')
      setAmount('')
      setNote('')
      setReason('')
      setReasonId('')
      setReceiptRef('')
      toast({ title: t('cmv.created') })
      await load()
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function submitVoid() {
    if (!voidTarget) return
    if (voidReason.trim().length < 10) {
      toast({ title: t('cmv.errVoidReason') })
      return
    }
    setBusy(true)
    try {
      await api('/api/shifts/movements', {
        method: 'PATCH',
        body: JSON.stringify({
          id: voidTarget.id,
          action: 'void',
          reason: voidReason.trim(),
          approverEmail: approverEmail.trim() || undefined,
          approverPin: approverPin.trim() || undefined,
        }),
      })
      setVoidTarget(null)
      setVoidReason('')
      setApproverEmail('')
      setApproverPin('')
      toast({ title: t('cmv.voided') })
      await load()
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  function typeLabel(tp: string): string {
    return t(`cmv.type.${tp}`)
  }

  if (err && !data) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-red-600">{err}</CardContent>
      </Card>
    )
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="pt-4 space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }
  if (data.ddlPending) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-stone-500">{t('cmv.ddlPending')}</CardContent>
      </Card>
    )
  }

  const blind = !!data.summary.blind
  const hasMovements = data.movements.length > 0
  const varianceEur = data.policy.varianceThresholdCents / 100

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <Coins className="w-4 h-4" /> {t('cmv.title')}
          <Button variant="ghost" size="sm" onClick={() => void load()} aria-label={t('common.refresh')}>
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* živo pričakovano stanje predala (SLEPI POPIS: skrito NE-vodstvenim) */}
        {data.shiftStatus === 'open' && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 space-y-1.5">
            <div className="flex justify-between text-sm font-medium">
              <span>{t('cmv.expectedDrawer')}</span>
              <b>{blind ? t('cmv.blindHidden') : data.runningExpected !== null ? fmtEUR(data.runningExpected) : '—'}</b>
            </div>
            {!blind && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge variant="outline" className="bg-white">{t('cmv.starting')}: {fmtEUR(data.startingCash)}</Badge>
                <Badge variant="outline" className="bg-emerald-50 border-emerald-200 text-emerald-800">
                  <ArrowDownToLine className="w-3 h-3 mr-1" /> {t('cmv.paidIn')}: {fmtEUR(data.summary.paidIn ?? 0)}
                </Badge>
                <Badge variant="outline" className="bg-amber-50 border-amber-200 text-amber-800">
                  <ArrowUpFromLine className="w-3 h-3 mr-1" /> {t('cmv.paidOut')}: {fmtEUR(data.summary.paidOut ?? 0)}
                </Badge>
                <Badge variant="outline" className="bg-violet-50 border-violet-200 text-violet-800">
                  <Vault className="w-3 h-3 mr-1" /> {t('cmv.safeDrop')}: {fmtEUR(data.summary.safeDrop ?? 0)}
                </Badge>
                {data.summary.blind === undefined || data.summary.blind === false ? (
                  <Badge variant="outline" className="bg-rose-50 border-rose-200 text-rose-800">
                    {t('cmv.guestRefund')}: {fmtEUR(data.summary.guestRefund ?? 0)}
                  </Badge>
                ) : null}
              </div>
            )}
            {blind && <p className="text-xs text-stone-500">{t('cmv.blindNote')}</p>}
            {varianceEur > 0 && (
              <p className="text-xs text-stone-500">{t('cmv.thresholdNote', { amount: fmtEUR(varianceEur) })}</p>
            )}
          </div>
        )}

        {/* obrazec za nov premik */}
        {data.shiftStatus === 'open' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cmv-type">{t('cmv.typeLabel')}</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="cmv-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_ORDER.map((tp) => (
                    <SelectItem key={tp} value={tp}>{typeLabel(tp)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {type === 'change_fund' && (
              <div className="space-y-1.5">
                <Label htmlFor="cmv-dir">{t('cmv.direction')}</Label>
                <Select value={direction} onValueChange={(v) => setDirection(v as 'in' | 'out')}>
                  <SelectTrigger id="cmv-dir">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in">{t('cmv.dirIn')}</SelectItem>
                    <SelectItem value="out">{t('cmv.dirOut')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="cmv-amount">{t('cmv.amount')}</Label>
              <Input
                id="cmv-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.'))}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cmv-reason">{t('cmv.reasonLabel')}</Label>
              {data.reasons.length > 0 && !reason ? (
                <Select value={reasonId || 'free'} onValueChange={(v) => { setReasonId(v === 'free' ? '' : v); if (v !== 'free') setReason('') }}>
                  <SelectTrigger id="cmv-reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.reasons.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                    <SelectItem value="free">{t('cmv.reasonFree')}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="cmv-reason"
                  value={reasonId ? '' : reason}
                  onChange={(e) => { setReason(e.target.value); setReasonId('') }}
                  placeholder={t('cmv.reasonPlaceholder')}
                />
              )}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cmv-note">
                {t('cmv.noteLabel')} {NOTE_REQUIRED.has(type) && <span className="text-red-600">*</span>}
              </Label>
              <Input id="cmv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cmv.notePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cmv-receipt">{t('cmv.receiptRef')}</Label>
              <Input id="cmv-receipt" value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} placeholder={t('cmv.receiptPlaceholder')} />
            </div>
            <div className="flex items-end">
              <Button className="w-full bg-emerald-700 hover:bg-emerald-800" disabled={busy} onClick={submit}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : direction === 'in' ? <ArrowDownToLine className="w-4 h-4" /> : <ArrowUpFromLine className="w-4 h-4" />}
                <span className="ml-1.5">{t('cmv.submit')}</span>
              </Button>
            </div>
          </div>
        )}

        {/* zgodovina premikov */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">{t('cmv.history')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open('/api/shifts/movements?format=csv&from=' + new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), '_blank')}
            >
              <FileDown className="w-4 h-4" /> {t('cmv.csv')}
            </Button>
          </div>
          {!hasMovements && <p className="text-sm text-stone-500">{t('cmv.none')}</p>}
          {hasMovements && (
            <ScrollArea className="max-h-96">
              <div className="space-y-1.5 pr-2">
                {data.movements.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-lg border p-2.5 text-sm flex flex-wrap items-center justify-between gap-2 ${
                      m.status === 'voided' ? 'border-stone-200 bg-stone-50 opacity-75' : 'border-stone-200 bg-white'
                    }`}
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <Badge variant="outline" className={TYPE_STYLE[m.type] ?? 'bg-stone-100 text-stone-700'}>
                        {m.direction === 'in' ? <ArrowDownToLine className="w-3 h-3 mr-1" /> : <ArrowUpFromLine className="w-3 h-3 mr-1" />}
                        {typeLabel(m.type)}
                      </Badge>
                      <span className={`font-semibold ${m.direction === 'in' ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {m.direction === 'in' ? '+' : '−'}{fmtEUR(m.amount)}
                      </span>
                      <span className="text-xs text-stone-500 truncate">
                        {m.reasonName || m.reasonText || '—'} · {m.userName} ·{' '}
                        {new Date(m.createdAt).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {m.status === 'confirmed' && m.expectedAfter > 0 && data.shiftStatus === 'open' && !blind && (
                        <span className="text-xs text-stone-400">→ {fmtEUR(m.expectedAfter)}</span>
                      )}
                      {m.status === 'voided' && (
                        <Badge variant="outline" className="bg-stone-200 text-stone-600">
                          <Ban className="w-3 h-3 mr-1" /> {t('cmv.voidedBadge')}
                        </Badge>
                      )}
                      {m.reversalOfId && (
                        <Badge variant="outline" className="bg-stone-100 text-stone-500">{t('cmv.reversalBadge')}</Badge>
                      )}
                      {m.status === 'confirmed' && !m.reversalOfId && data.shiftStatus === 'open' && (
                        <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setVoidTarget(m)}>
                          <Ban className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
          {data.summary.voidedCount > 0 && (
            <p className="text-xs text-stone-400 mt-1">{t('cmv.voidedCount', { n: data.summary.voidedCount })}</p>
          )}
        </div>

        {/* dialog razveljavitve (kompenzacijski zapis) */}
        <Dialog open={!!voidTarget} onOpenChange={(v) => !v && setVoidTarget(null)}>
          <DialogContent className="max-w-sm" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Ban className="w-4 h-4 text-red-600" /> {t('cmv.voidTitle')}
              </DialogTitle>
            </DialogHeader>
            {voidTarget && (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span>{typeLabel(voidTarget.type)}</span>
                  <b>{fmtEUR(voidTarget.amount)}</b>
                </div>
                <p className="text-xs text-stone-500">{t('cmv.voidHint')}</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="cmv-void-reason">{t('cmv.voidReason')} <span className="text-red-600">*</span></Label>
              <Input
                id="cmv-void-reason"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder={t('cmv.voidReasonPlaceholder')}
              />
            </div>
            {!isManager && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cmv-appr-mail">{t('cmv.approverEmail')}</Label>
                  <Input id="cmv-appr-mail" type="email" value={approverEmail} onChange={(e) => setApproverEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cmv-appr-pin">{t('cmv.approverPin')}</Label>
                  <Input id="cmv-appr-pin" inputMode="numeric" value={approverPin} onChange={(e) => setApproverPin(e.target.value.replace(/\D/g, ''))} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setVoidTarget(null)}>{t('common.cancel')}</Button>
              <Button className="bg-red-600 hover:bg-red-700" disabled={busy} onClick={submitVoid}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {t('cmv.voidConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
