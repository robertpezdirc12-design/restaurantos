'use client'

/**
 * P0-2 TRZNA-VRZELI (v1.85.0) — JAVNA plačilna stran gosta (/pay/<token>).
 * "QR položnica": gost odpre povezavo (QR na napravi osebja ali SMS) → vidi
 * račun (kanonični computeBill) → izbere napitnino → PLAČA.
 *
 * Isto disciplino kot /m/<token> (Issue #3):
 *  - brez prijave; token JE skrivnost; vsi zneski strežniški;
 *  - GuestI18nProvider (SL/HR, isti slovar + localStorage ključ);
 *  - simulator: vidna značka "Simulacija" (nikoli se ne izdaja za produkcijo);
 *    Stripe: preusmeritev na Checkout (kartica se vnese NA Stripe domeni).
 *
 * Idempotenca: strežnik ključi na 'plk:<token>' — dvojni klik/refresh vrača
 * isti račun (replay), brez dvojnikov.
 */
import { use, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw, CheckCircle2, WifiOff, CreditCard, Ban, Clock, PartyPopper, Smartphone } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle, useGuestApiError } from '@/components/guest-i18n'

interface ReceiptInfo {
  receiptNumber: string
  eor: string | null
  zoi: string | null
  jir: string | null
  zki: string | null
  total: number
  tip: number
  totalWithTip: number
  paymentMethod: string
  fiscalStatus: string
}

interface SplitInfo {
  index: number
  count: number
  share?: number | null
  paidShares?: number
  paidTotal?: number
  remaining?: number
  receiptPending?: boolean
}

interface PayState {
  status: 'open' | 'paid' | 'revoked' | 'superseded' | 'expired'
  provider?: 'simulator' | 'stripe'
  /** v1.156.0: ali strežnik dovoljuje simulator za to lokacijo (fiskalni profil). */
  simulatorAllowed?: boolean
  expiresAt?: string | null
  order?: { orderNumber: number; table: string | null }
  location?: { name: string }
  bill?: { subtotal: number; tax: number; discountTotal: number; totalDue: number }
  tipPresets?: number[]
  receipt?: ReceiptInfo | null
  paidAt?: string | null
  /** P1-6: delež gosta (split po gostih — fiksni delež povezave). */
  share?: number | null
  tipPaid?: number | null
  approvalCode?: string | null
  receiptPending?: boolean
  split?: SplitInfo
}

const fmt = (n: number) => `${(Number.isFinite(n) ? n : 0).toFixed(2).replace('.', ',')} €`

/**
 * Javni API vrača oznako mize kot SL fiksni format "Miza N" (issue + javna rute —
 * isti vir). Lokaliziramo samo predpono; številka/neznan format ostane nespremenjen
 * (P1-5 — angleški/hrvaški gost vidi "Table 1"/"Stol 1").
 */
function localizedTableLabel(label: string, t: (k: string) => string): string {
  const m = /^Miza\s+(.+)$/.exec(label.trim())
  return m ? `${t('pay.table')} ${m[1]}` : label
}

export default function GuestPayPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <GuestI18nProvider>
      <GuestPayInner params={params} />
    </GuestI18nProvider>
  )
}

function GuestPayInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { t } = useGuestT()
  const [state, setState] = useState<PayState | null>(null)
  const pageErr = useGuestApiError() // issue #2 §C: surov niz → prevod ob izrisu
  const payErr = useGuestApiError()
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)
  const [tipPct, setTipPct] = useState(0)
  const [tipCustom, setTipCustom] = useState('')
  const [verifying, setVerifying] = useState(false)

  const load = useCallback(async () => {
    pageErr.clear()
    try {
      const res = await fetch(`/api/public/pay/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { pageErr.set(data?.error, 'pay.notFound'); setState(null); return }
      setState(data as PayState)
    } catch {
      pageErr.setKey('guest.error.unreachableRetry')
    } finally {
      setLoading(false)
    }
  }, [token, pageErr])

  // Začetno nalaganje + Stripe vrnitev (?s=<sessionId>): najprej stanje, nato potrditev
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const s = new URLSearchParams(window.location.search).get('s')
    if (!s) return
    ;(async () => {
      // počakaj prvo stanje (load zapiše state) — potrditveni klic izvedi takoj za njim
      await load()
      setVerifying(true)
      payErr.clear()
      try {
        const res = await fetch(`/api/public/pay/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verifySession: s }),
        })
        const data = await res.json()
        if (res.ok) {
          setState(data as PayState)
        } else if (res.status === 409) {
          // konflikt stanja (plačano/preklicano/poteklo) — naj stanje samo pove
          await load()
        } else {
          payErr.set(data?.error, 'pay.pending')
        }
      } catch {
        payErr.setKey('guest.error.unreachableRetry')
      } finally {
        setVerifying(false)
        // URL očisti (F5 ne ponovi potrditve; strežnik je idempotenten vseeno)
        window.history.replaceState(null, '', window.location.pathname)
      }
    })()
  }, [token, load])

  const totalDue = state?.bill?.totalDue ?? 0
  // P1-6: v split načinu gost plačuje SVOJ DELEŽ (fiksna vrstica povezave),
  // napitnina se izbere NA delež (0 … delež)
  const share = state?.split?.share ?? null
  const splitAmount = share != null && share > 0 ? share : totalDue
  const tip = tipCustom.trim() !== '' ? Math.max(0, Number(tipCustom.replace(',', '.')) || 0) : (splitAmount * tipPct) / 100
  const payTotal = Math.round((splitAmount + Math.min(tip, splitAmount)) * 100) / 100

  const pay = async () => {
    setPaying(true)
    payErr.clear()
    try {
      const res = await fetch(`/api/public/pay/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tip: Math.round(tip * 100) / 100 }),
      })
      const data = await res.json()
      if (!res.ok) {
        payErr.set(data?.error, 'pay.errorRetry')
        if (res.status === 409) await load() // stanje se je spremenilo (plačano/preklicano)
        return
      }
      if (data.redirect && typeof data.redirect === 'string') {
        window.location.href = data.redirect // Stripe Checkout — kartica na Stripe domeni
        return
      }
      setState(data as PayState)
    } catch {
      payErr.setKey('guest.error.unreachableRetry')
    } finally {
      setPaying(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="flex flex-col items-center gap-3 text-stone-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('pay.loading')}</span>
        </div>
      </div>
    )
  }

  if (pageErr.error && !state) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 p-6">
        <GuestLanguageToggle variant="light" className="fixed top-3 right-3 z-50" />
        <div className="max-w-sm w-full rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <WifiOff className="h-10 w-10 mx-auto text-stone-400" />
          <h1 className="mt-3 font-semibold text-stone-900">{pageErr.text}</h1>
          <Button className="mt-4 w-full" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" />{t('guest.common.retry')}
          </Button>
        </div>
      </div>
    )
  }

  const s = state!

  // ── plačano ──
  if (s.status === 'paid') {
    // P1-6: VMESNI delež (račun še ni izdan — čaka ostale goste)
    if (!s.receipt && (s.receiptPending || (s.split && s.split.count > 1))) {
      return (
        <Shell t={t} name={s.location?.name}>
          <div className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto text-green-600" />
            <h2 className="mt-2 text-xl font-bold text-green-900">{t('pay.sharePaid')}</h2>
            <dl className="mt-4 space-y-1.5 text-sm text-stone-700 bg-white rounded-xl border border-green-100 p-4 text-left">
              {s.share != null && <Row label={t('pay.share')} value={fmt(s.share)} strong />}
              {s.tipPaid != null && s.tipPaid > 0 && <Row label={t('pay.tip')} value={fmt(s.tipPaid)} />}
              {s.share != null && s.tipPaid != null && <Row label={t('pay.totalWithTip')} value={fmt(s.share + s.tipPaid)} strong />}
              {s.approvalCode && <Row label="Odobritev" value={s.approvalCode} mono />}
            </dl>
            <p className="text-sm text-green-700 mt-3">{t('pay.sharePaidNote')}</p>
          </div>
        </Shell>
      )
    }
    return (
      <Shell t={t} name={s.location?.name}>
        <div className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center">
          <PartyPopper className="h-10 w-10 mx-auto text-green-600" />
          <h2 className="mt-2 text-xl font-bold text-green-900">{t('pay.paid')}</h2>
          <p className="text-sm text-green-700 mt-1">{t('pay.thanks')}</p>
          {s.receipt && (
            <dl className="mt-4 space-y-1.5 text-sm text-stone-700 bg-white rounded-xl border border-green-100 p-4 text-left">
              {s.split && s.split.count > 1 && s.share != null && <Row label={t('pay.share')} value={fmt(s.share)} />}
              {s.split && s.split.count > 1 && s.tipPaid != null && s.tipPaid > 0 && <Row label={t('pay.tip')} value={fmt(s.tipPaid)} />}
              <Row label={t('pay.receipt')} value={s.receipt.receiptNumber} strong />
              <Row label={t('pay.totalDue')} value={fmt(s.receipt.total)} />
              <Row label={t('pay.tip')} value={fmt(s.receipt.tip)} />
              <Row label={t('pay.totalWithTip')} value={fmt(s.receipt.totalWithTip)} strong />
              {s.receipt.eor ? <Row label={t('pay.eor')} value={s.receipt.eor.slice(0, 18) + '…'} mono /> : null}
              {s.receipt.jir ? <Row label={t('pay.jir')} value={s.receipt.jir.slice(0, 18) + '…'} mono /> : null}
            </dl>
          )}
        </div>
      </Shell>
    )
  }

  // ── mrtve povezave ──
  if (s.status === 'revoked' || s.status === 'expired' || s.status === 'superseded') {
    const icon = s.status === 'revoked' ? <Ban className="h-10 w-10 mx-auto text-stone-400" /> : s.status === 'expired' ? <Clock className="h-10 w-10 mx-auto text-stone-400" /> : <CheckCircle2 className="h-10 w-10 mx-auto text-green-500" />
    const title = s.status === 'revoked' ? t('pay.revoked') : s.status === 'expired' ? t('pay.expired') : t('pay.superseded')
    const note = s.status === 'revoked' ? t('pay.revokedNote') : s.status === 'expired' ? t('pay.expiredNote') : t('pay.supersededNote')
    return (
      <Shell t={t} name={s.location?.name}>
        <div className="rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          {icon}
          <h2 className="mt-3 font-semibold text-stone-900">{title}</h2>
          <p className="text-sm text-stone-500 mt-1">{note}</p>
        </div>
      </Shell>
    )
  }

  // ── odprto: račun + napitnina + plačilo ──
  const presets = s.tipPresets && s.tipPresets.length ? s.tipPresets : [0, 5, 10, 15]
  const isSplit = !!s.split && (s.split.count > 1 || (s.split.share != null && s.split.share > 0))
  return (
    <Shell t={t} name={s.location?.name}>
      {/* P1-6: delež gosta (split) — fiksni znesek, napredek niza */}
      {isSplit && (
        <div className="rounded-2xl border border-stone-900 bg-stone-900 text-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold opacity-90">{t('pay.share')} {s.split!.count > 1 ? `${s.split!.index}/${s.split!.count}` : ''}</p>
            <p className="text-xs opacity-75">{t('pay.shareOf')} {fmt(totalDue)}</p>
          </div>
          <p className="mt-1 text-3xl font-bold">{fmt(splitAmount)}</p>
          {s.split!.count > 1 && (
            <div className="mt-3">
              <div className="h-1.5 rounded-full bg-white/20 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={s.split!.count} aria-valuenow={s.split!.paidShares ?? 0}>
                <div className="h-full bg-emerald-400 transition-all" style={{ width: `${Math.min(100, ((s.split!.paidShares ?? 0) / s.split!.count) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-xs opacity-75">{s.split!.paidShares ?? 0}/{s.split!.count} {t('pay.splitProgress')}</p>
            </div>
          )}
        </div>
      )}
      {/* Račun */}
      <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-stone-900">
            {t('pay.order')} #{s.order?.orderNumber}
          </h2>
          {s.order?.table && (
            <Badge variant="outline" className="border-stone-300 text-stone-600">
              {localizedTableLabel(s.order.table, t)}
            </Badge>
          )}
        </div>
        <dl className="mt-4 space-y-1.5 text-sm text-stone-700">
          <Row label={t('pay.subtotal')} value={fmt(s.bill?.subtotal ?? 0)} />
          <Row label={t('pay.tax')} value={fmt(s.bill?.tax ?? 0)} />
          {(s.bill?.discountTotal ?? 0) > 0 && <Row label={t('pay.discount')} value={`−${fmt(s.bill!.discountTotal)}`} />}
          <div className="border-t border-stone-200 pt-2 mt-2" />
          <Row label={t('pay.totalDue')} value={fmt(totalDue)} strong big />
        </dl>
      </div>

      {/* Napitnina */}
      <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-stone-900">{t('pay.tip')}</p>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={tipPct === p && tipCustom.trim() === ''}
              onClick={() => { setTipPct(p); setTipCustom('') }}
              className={`h-12 rounded-xl border text-sm font-semibold transition ${tipPct === p && tipCustom.trim() === '' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'}`}
            >
              {p === 0 ? t('pay.tipNone') : `${p} %`}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            inputMode="decimal"
            value={tipCustom}
            onChange={(e) => setTipCustom(e.target.value)}
            placeholder={t('pay.tipCustom')}
            className="flex-1"
            aria-label={t('pay.tipCustom')}
          />
          <span className="text-sm text-stone-500">{fmt(Math.round(tip * 100) / 100)}</span>
        </div>
      </div>

      {/* Ponudnik — simulator je VEDNO vidno označen (honest) */}
      {s.provider === 'simulator' && s.simulatorAllowed !== false && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <Smartphone className="h-4 w-4 shrink-0" />
          <span>{t('pay.simulationNote')}</span>
        </div>
      )}
      {s.provider === 'simulator' && s.simulatorAllowed === false && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="status">
          <Ban className="h-4 w-4 shrink-0" />
          <span>{t('pay.unavailable')}</span>
        </div>
      )}

      {(payErr.error || verifying) && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
          {verifying ? t('pay.verify') : payErr.text}
        </div>
      )}

      {/* CTA — cona palca */}
      <div className="sticky bottom-0 inset-x-0 -mx-4 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-stone-50 via-stone-50 to-transparent">
        <Button
          className="w-full h-14 text-base font-bold"
          disabled={paying || splitAmount <= 0 || (s.provider === 'simulator' && s.simulatorAllowed === false)}
          onClick={pay}
        >
          {paying ? (
            <><Loader2 className="mr-2 h-5 w-5 animate-spin" />{t('pay.paying')}</>
          ) : (
            <><CreditCard className="mr-2 h-5 w-5" />{isSplit ? t('pay.payShare') : t('pay.pay')} · {fmt(payTotal)}</>
          )}
        </Button>
        <p className="mt-2 text-center text-xs text-stone-400">{t('pay.footer')}</p>
      </div>
    </Shell>
  )
}

function Row({ label, value, strong, big, mono }: { label: string; value: string; strong?: boolean; big?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className={`${strong ? 'font-bold text-stone-900' : 'text-stone-700'} ${big ? 'text-lg' : ''} ${mono ? 'font-mono text-xs break-all' : ''}`}>{value}</dd>
    </div>
  )
}

function Shell({ t, name, children }: { t: (k: string) => string; name?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-bold text-stone-900 leading-tight truncate">{name || t('pay.title')}</h1>
            <p className="text-xs text-stone-500">{t('pay.title')}</p>
          </div>
          <GuestLanguageToggle variant="light" />
        </div>
      </header>
      <main className="flex-1 w-full max-w-lg mx-auto px-4 pt-4 pb-4">{children}</main>
    </div>
  )
}
