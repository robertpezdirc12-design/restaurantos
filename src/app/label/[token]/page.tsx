'use client'

/**
 * Issue #24 (P2, v1.114.0) — JAVNA statusna stran etikete (/label/<token>).
 * Kuhinja/osebje skenira QR z etikete → stran pokaže pošten status, usklajen
 * z lot-governance #15: veljavna / kmalu poteče / potekla / izčrpana / v
 * karanteni / odpoklic / zahteva pregled / razveljavljena.
 *
 * Isto disciplino kot /r/<token>, /m/<token> in /pay/<token>:
 *  - brez prijave; token JE skivnost (32 hex);
 *  - BREZ PII: samo naziv + rok + status (fizično na etiketi); brez količin,
 *    brez lokacije, brez imen, brez ID-jev;
 *  - GuestI18nProvider (SL/HR/EN — isti centralni slovar);
 *  - mobilno-prvi (safe-area cona palca).
 * Podrobnosti (izvor, serija, tiskalni poskusi) zahtevajo prijavo
 * (dashboard → Skladišče) — QR na etiketi vodi na status, ne na podatke.
 */
import { use, useEffect, useState } from 'react'
import { Loader2, ShieldCheck, Clock, XCircle, Ban, HelpCircle, PackageX, AlertTriangle } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle } from '@/components/guest-i18n'

type ScanStatus = 'ok' | 'alert' | 'expired' | 'exhausted' | 'quarantined' | 'recalled' | 'review' | 'void'

interface StatusState {
  status: ScanStatus
  itemName: string
  expiresAt: string | null
  preparedAt: string | null
  unit: string
}

const STATUS_STYLES: Record<
  ScanStatus,
  { icon: typeof ShieldCheck; ring: string; badge: string; iconColor: string }
> = {
  ok: { icon: ShieldCheck, ring: 'border-emerald-300', badge: 'bg-emerald-100 text-emerald-900', iconColor: 'text-emerald-600' },
  alert: { icon: Clock, ring: 'border-amber-300', badge: 'bg-amber-100 text-amber-900', iconColor: 'text-amber-600' },
  expired: { icon: XCircle, ring: 'border-rose-300', badge: 'bg-rose-100 text-rose-900', iconColor: 'text-rose-600' },
  exhausted: { icon: PackageX, ring: 'border-stone-300', badge: 'bg-stone-100 text-stone-900', iconColor: 'text-stone-500' },
  quarantined: { icon: Ban, ring: 'border-rose-300', badge: 'bg-rose-100 text-rose-900', iconColor: 'text-rose-600' },
  recalled: { icon: AlertTriangle, ring: 'border-rose-400', badge: 'bg-rose-200 text-rose-950', iconColor: 'text-rose-700' },
  review: { icon: HelpCircle, ring: 'border-amber-300', badge: 'bg-amber-100 text-amber-900', iconColor: 'text-amber-600' },
  void: { icon: Ban, ring: 'border-stone-300', badge: 'bg-stone-200 text-stone-700', iconColor: 'text-stone-500' },
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

export default function LabelStatusPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <GuestI18nProvider>
      <LabelStatusInner params={params} />
    </GuestI18nProvider>
  )
}

function LabelStatusInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { t } = useGuestT()
  const [state, setState] = useState<StatusState | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/label-status?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as StatusState & { error?: string }
        if (!r.ok) throw new Error(d.error || 'not-found')
        return d
      })
      .then((d: StatusState) => {
        if (!cancelled) setState(d)
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <main className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-3">
          <GuestLanguageToggle variant="light" />
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 text-stone-500 py-16" role="status" aria-live="polite">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
            <span>{t('lbl.public.loading')}</span>
          </div>
        )}
        {notFound && (
          <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center" role="alert">
            <HelpCircle className="w-10 h-10 mx-auto text-stone-400" aria-hidden />
            <p className="mt-3 font-semibold text-stone-800">{t('lbl.public.notFoundTitle')}</p>
            <p className="mt-1 text-sm text-stone-500">{t('lbl.public.notFoundBody')}</p>
          </div>
        )}
        {state && (
          <div
            className={`rounded-2xl border-2 bg-white p-8 text-center shadow-sm ${STATUS_STYLES[state.status].ring}`}
            role="status"
            aria-live="polite"
          >
            {(() => {
              const Icon = STATUS_STYLES[state.status].icon
              return <Icon className={`w-14 h-14 mx-auto ${STATUS_STYLES[state.status].iconColor}`} aria-hidden />
            })()}
            <p
              className={`mt-4 inline-block rounded-full px-4 py-1.5 text-sm font-bold ${STATUS_STYLES[state.status].badge}`}
            >
              {t(`lbl.public.status.${state.status}`)}
            </p>
            <h1 className="mt-4 text-2xl font-bold text-stone-900 break-words">{state.itemName}</h1>
            {state.expiresAt ? (
              <p className="mt-2 text-lg font-semibold text-stone-700">
                {t('lbl.public.expiry')}: {fmtDate(state.expiresAt)}
              </p>
            ) : (
              state.status !== 'exhausted' && (
                <p className="mt-2 text-lg font-bold text-amber-700">{t('lbl.public.noExpiry')}</p>
              )
            )}
            {state.preparedAt && (
              <p className="mt-1 text-sm text-stone-500">
                {t('lbl.public.prepared')}: {fmtDate(state.preparedAt)}
              </p>
            )}
            <p className="mt-6 text-xs text-stone-400">{t('lbl.public.footer')}</p>
          </div>
        )}
      </div>
    </main>
  )
}
