'use client'

/**
 * Issue #13 (P1/P2, v1.110.0) — JAVNA rezervacijska stran gosta (/r/<token>).
 * "Google Business povezava": gost odpre povezavo (QR, social, spletna stran)
 * → izbere datum / št. oseb / prost termin → vpiše stik → REZERVIRA.
 *
 * Isto disciplino kot /m/<token> in /pay/<token>:
 *  - brez prijave; token JE skrivnost; termini in prostost STREŽNIŠKO
 *    (gost ne more oddati termina, ki plošča ni pokazala kot prostega);
 *  - GuestI18nProvider (SL/HR/EN, isti slovar + localStorage);
 *  - mobilno-prvi: CTA v coni palca (h-14 + safe-area), brez vodoravnih
 *    prelivov na 390 px;
 *  - replay: dvojni klik vrača isto rezervacijo (strežnik, replayed:true).
 */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, RefreshCw, CheckCircle2, WifiOff, CalendarDays, Users, Clock, Minus, Plus } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle, useGuestApiError } from '@/components/guest-i18n'

interface SlotInfo {
  time: string
  available: boolean
  remaining: number
}

interface SlotsState {
  restaurant: string
  date: string
  open: boolean
  note: string
  capacity: number
  durationMinutes: number
  policy: { minParty: number; maxParty: number; maxAdvanceDays: number }
  slots: SlotInfo[]
}

interface BookingResult {
  replayed: boolean
  reservation: { id: string; dateTime: string; partySize: number; status: string }
}

/** Danes v pasu LOKACIJE (ne brskalnika) — začetni datum plošče. */
function addDaysKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

export default function GuestReservationPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <GuestI18nProvider>
      <GuestReservationInner params={params} />
    </GuestI18nProvider>
  )
}

function GuestReservationInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { t, locale } = useGuestT()
  const pageErr = useGuestApiError()
  const formErr = useGuestApiError()
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<SlotsState | null>(null)
  const [dateKey, setDateKey] = useState<string | null>(null)
  const [party, setParty] = useState(2)
  const [time, setTime] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<BookingResult | null>(null)

  // stabilni setri iz useGuestApiError (useCallback [] — identiteta se ne spreminja);
  // pageErr SAM objekt ni stabilen → ne sme biti v deps (sicer neskončna zanka fetch)
  const { set: setPageErr, setKey: setPageErrKey, clear: clearPageErr } = pageErr

  const load = useCallback(async (date?: string) => {
    clearPageErr()
    try {
      const url = `/api/public/reservations?token=${encodeURIComponent(token)}${date ? `&date=${date}` : ''}`
      const res = await fetch(url, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { setPageErr(data?.error, 'resv.public.notFound'); setState(null); return }
      const s = data as SlotsState
      setState(s)
      setDateKey(s.date)
    } catch {
      // omrežna napaka pri PREKLOPU dneva ne uniči že naložene plošče —
      // samo začetna nalagalna napaka postavi state null → error ekran
      if (!date && !state) setPageErrKey('guest.error.unreachableRetry')
    } finally {
      setLoading(false)
    }
  }, [token, clearPageErr, setPageErr, setPageErrKey, state])

  // začetno nalaganje — SAMO enkrat (bootstrappovanje ne sledi spreminjanju load)
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void load()
  }, [load])

  // zagon party v meje politike (brez ponovnega fetcha)
  useEffect(() => {
    if (!state) return
    setParty((p) => Math.min(Math.max(p, state.policy.minParty), state.policy.maxParty))
  }, [state?.policy.minParty, state?.policy.maxParty])

  const dayChips = useMemo(() => {
    if (!state) return [] as { key: string; label: string; sub: string }[]
    const days = Math.min(14, state.policy.maxAdvanceDays)
    const fmtDay = (key: string) => {
      const [y, m, d] = key.split('-').map(Number)
      const dt = new Date(Date.UTC(y, m - 1, d))
      const weekday = dt.toLocaleDateString(locale === 'hr' ? 'hr-HR' : locale === 'en' ? 'en-GB' : 'sl-SI', { weekday: 'short', timeZone: 'UTC' })
      const dayLabel = dt.toLocaleDateString(locale === 'hr' ? 'hr-HR' : locale === 'en' ? 'en-GB' : 'sl-SI', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      return { key, label: weekday, sub: dayLabel }
    }
    return Array.from({ length: days }, (_, i) => fmtDay(addDaysKey(state.date, i)))
  }, [state, locale])

  const slots = state?.slots ?? []

  async function submit() {
    if (!state || !dateKey || !time) return
    formErr.clear()
    setSubmitting(true)
    try {
      const res = await fetch('/api/public/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, date: dateKey, time, partySize: party, name, phone, email, note }),
      })
      const data = await res.json()
      if (!res.ok) { formErr.set(data?.error, 'resv.public.errorRetry'); return }
      setDone(data as BookingResult)
    } catch {
      formErr.setKey('guest.error.unreachableRetry')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="flex flex-col items-center gap-3 text-stone-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('resv.public.loading')}</span>
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
          <Button className="mt-4 w-full" onClick={() => load()}>
            <RefreshCw className="mr-2 h-4 w-4" />{t('guest.common.retry')}
          </Button>
        </div>
      </div>
    )
  }

  if (done) {
    const when = new Date(done.reservation.dateTime)
    const whenText = when.toLocaleString(locale === 'hr' ? 'hr-HR' : locale === 'en' ? 'en-GB' : 'sl-SI', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    })
    return (
      <Shell t={t} name={state?.restaurant}>
        <div className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center">
          <CheckCircle2 className="h-10 w-10 mx-auto text-green-600" />
          <h2 className="mt-2 text-xl font-bold text-green-900">{t('resv.public.doneTitle')}</h2>
          <p className="text-sm text-green-700 mt-1">{t('resv.public.doneNote')}</p>
          <dl className="mt-4 space-y-1.5 text-sm text-stone-700 bg-white rounded-xl border border-green-100 p-4 text-left">
            <Row label={t('resv.public.when')} value={whenText} strong />
            <Row label={t('resv.public.party')} value={String(done.reservation.partySize)} />
            {done.replayed && <Row label={t('resv.public.replay')} value={t('resv.public.replayNote')} />}
          </dl>
          {email || phone ? (
            <p className="text-xs text-stone-500 mt-3">{t('resv.public.confirmationNote')}</p>
          ) : null}
        </div>
      </Shell>
    )
  }

  if (!state) return null // varovalka: brez plošče ne izrisujemo glavne forme (error ekran je že pokrival)
  const s = state
  const canSubmit = Boolean(dateKey && time && name.trim().length >= 2 && phone.trim().replace(/[^\d+]/g, '').length >= 5 && !submitting)

  return (
    <Shell t={t} name={s.restaurant}>
      {/* 1) datum */}
      <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <SectionTitle icon={<CalendarDays className="h-4 w-4" />} text={t('resv.public.pickDate')} />
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="radiogroup" aria-label={t('resv.public.pickDate')}>
          {dayChips.map((d) => {
            const active = d.key === dateKey
            return (
              <button
                key={d.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => { setDateKey(d.key); setTime(null); load(d.key) }}
                className={`shrink-0 min-w-[64px] rounded-xl border px-3 py-2 text-center transition-colors ${active ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'}`}
              >
                <span className="block text-xs font-medium capitalize">{d.label}</span>
                <span className="block text-sm font-bold">{d.sub}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* 2) št. oseb */}
      <section className="mt-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <SectionTitle icon={<Users className="h-4 w-4" />} text={t('resv.public.party')} />
        <div className="flex items-center justify-center gap-4">
          <Button type="button" variant="outline" size="icon" className="h-11 w-11" aria-label={t('resv.public.less')} disabled={party <= s.policy.minParty} onClick={() => { setParty((p) => Math.max(s.policy.minParty, p - 1)); setTime(null) }}>
            <Minus className="h-5 w-5" />
          </Button>
          <span className="text-2xl font-bold text-stone-900 tabular-nums w-10 text-center" aria-live="polite">{party}</span>
          <Button type="button" variant="outline" size="icon" className="h-11 w-11" aria-label={t('resv.public.more')} disabled={party >= s.policy.maxParty} onClick={() => { setParty((p) => Math.min(s.policy.maxParty, p + 1)); setTime(null) }}>
            <Plus className="h-5 w-5" />
          </Button>
        </div>
        <p className="text-xs text-stone-500 text-center mt-1">{t('resv.public.partyRange', { min: s.policy.minParty, max: s.policy.maxParty })}</p>
      </section>

      {/* 3) termin */}
      <section className="mt-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <SectionTitle icon={<Clock className="h-4 w-4" />} text={t('resv.public.pickTime')} />
        {s.slots.length === 0 ? (
          <p className="text-sm text-stone-500 py-4 text-center">{t('resv.public.noSlots')}</p>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {s.slots.map((slot) => {
              const okForParty = slot.available && slot.remaining >= party
              const active = time === slot.time
              return (
                <button
                  key={slot.time}
                  type="button"
                  disabled={!okForParty}
                  onClick={() => setTime(slot.time)}
                  aria-pressed={active}
                  className={`h-11 rounded-xl border text-sm font-semibold tabular-nums transition-colors ${active
                    ? 'border-stone-900 bg-stone-900 text-white'
                    : okForParty
                      ? 'border-stone-200 bg-white text-stone-800 hover:border-stone-400'
                      : 'border-stone-100 bg-stone-50 text-stone-300 cursor-not-allowed'}`}
                >
                  {slot.time}
                </button>
              )
            })}
          </div>
        )}
        <p className="text-xs text-stone-400 mt-2">{t('resv.public.durationNote', { min: s.durationMinutes })}</p>
      </section>

      {/* 4) stik */}
      <section className="mt-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        <SectionTitle icon={<Users className="h-4 w-4" />} text={t('resv.public.contact')} />
        <div className="space-y-3">
          <div>
            <label htmlFor="resv-name" className="block text-xs font-medium text-stone-600 mb-1">{t('resv.public.name')}</label>
            <Input id="resv-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="h-12" placeholder={t('resv.public.namePh')} />
          </div>
          <div>
            <label htmlFor="resv-phone" className="block text-xs font-medium text-stone-600 mb-1">{t('resv.public.phone')}</label>
            <Input id="resv-phone" type="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} className="h-12" placeholder={t('resv.public.phonePh')} />
          </div>
          <div>
            <label htmlFor="resv-email" className="block text-xs font-medium text-stone-600 mb-1">{t('resv.public.email')} ({t('resv.public.optional')})</label>
            <Input id="resv-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} className="h-12" placeholder="ime@primer.si" />
          </div>
          <div>
            <label htmlFor="resv-note" className="block text-xs font-medium text-stone-600 mb-1">{t('resv.public.note')} ({t('resv.public.optional')})</label>
            <Input id="resv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="h-12" placeholder={t('resv.public.notePh')} />
          </div>
        </div>
      </section>

      {formErr.error && (
        <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formErr.text}
        </div>
      )}

      {/* CTA — cona palca */}
      <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-stone-50 via-stone-50 to-transparent">
        <Button className="w-full h-14 text-base font-bold" disabled={!canSubmit} onClick={submit}>
          {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CalendarDays className="mr-2 h-5 w-5" />}
          {t('resv.public.cta')}
        </Button>
        <p className="text-[11px] text-stone-400 text-center mt-1.5">{t('resv.public.termsNote')}</p>
      </div>
    </Shell>
  )
}

function SectionTitle({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900 mb-3">
      <span className="text-stone-400">{icon}</span>
      {text}
    </h2>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-stone-500">{label}</dt>
      <dd className={strong ? 'font-bold text-stone-900' : 'text-stone-700'}>{value}</dd>
    </div>
  )
}

function Shell({ t, name, children }: { t: (k: string) => string; name?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-bold text-stone-900 leading-tight truncate">{name || t('resv.public.title')}</h1>
            <p className="text-xs text-stone-500">{t('resv.public.title')}</p>
          </div>
          <GuestLanguageToggle variant="light" />
        </div>
      </header>
      <main className="flex-1 w-full max-w-lg mx-auto px-4 pt-4 pb-4">{children}</main>
    </div>
  )
}
