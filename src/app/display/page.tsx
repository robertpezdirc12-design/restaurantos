'use client'

/**
 * Issue #3 — Customer-facing display (CFD).
 * Drugi zaslon, povezan s POS napravo: aktivacija preko 6-mestne paring kode (POS ustvari kodo v Nastavitvah).
 * Polling 2s: artikli, količine, opcije, DDV, končni znesek; stanja pred naročilom / med / po plačilu.
 * Brez občutljivih podatkov zaposlenih (payload postavi POS, display samo prikaže).
 * i18n (49): dvojezičnost SL/HR prek GuestI18nProvider (isti slovar + isti
 * localStorage ključ kot kiosk/QR; zadnji ostanek audit §137 "gostujoče strani").
 * Server-side napake ostajajo SL (dokumentirana omejitev) — fallbacki so prevedeni.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Monitor, CheckCircle2, Link2, Unlink } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle } from '@/components/guest-i18n'

const TOKEN_KEY = 'ro_cfd_device_token'
const fmt = (n: number) => `${n.toFixed(2).replace('.', ',')} €`

interface DisplayPayload {
  state?: 'idle' | 'ordering' | 'paid'
  tableName?: string
  orderNumber?: number
  lines?: { name: string; qty: number; modifiers?: string[]; price: number }[]
  subtotal?: number
  tax?: number
  vatBreakdown?: { rate: number; amount: number }[]
  total?: number
  message?: string
}

export default function DisplayPage() {
  return (
    <GuestI18nProvider>
      <DisplayInner />
    </GuestI18nProvider>
  )
}

function DisplayInner() {
  const { t } = useGuestT()
  const [token, setToken] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [info, setInfo] = useState<{ paired: boolean; posName?: string; posOnline?: boolean } | null>(null)
  const [state, setState] = useState<{ payload: DisplayPayload | null; posOnline: boolean; updatedAt?: string } | null>(null)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const tok = localStorage.getItem(TOKEN_KEY) || ''
    setToken(tok)
  }, [])

  const refresh = useCallback(async (tok: string) => {
    try {
      const res = await fetch('/api/devices/display/state', { headers: { 'X-Device-Token': tok }, cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { setError(data.error || t('guest.display.notRegistered')); return }
      setError('')
      setInfo({ paired: data.paired, posName: data.posName, posOnline: data.posOnline })
      setState({ payload: data.payload, posOnline: data.posOnline, updatedAt: data.updatedAt })
    } catch {
      // povezava nedosegljiva — pusti zadnje stanje, ne lažnega
    }
  }, [t])

  useEffect(() => {
    if (!token) return
    refresh(token)
    const iv = setInterval(() => refresh(token), 2000)
    return () => clearInterval(iv)
  }, [token, refresh])

  async function connect() {
    if (!/^\d{6}$/.test(codeInput.trim())) { setError(t('guest.display.codeFormat')); return }
    setConnecting(true)
    try {
      const res = await fetch('/api/devices/display', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
        body: JSON.stringify({ action: 'connect', code: codeInput.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || t('guest.display.connectFailed')); return }
      setCodeInput('')
      refresh(token)
    } finally {
      setConnecting(false)
    }
  }

  async function unpair() {
    await fetch('/api/devices/display', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
      body: JSON.stringify({ action: 'unpair' }),
    })
    refresh(token)
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-950 p-6">
        <GuestLanguageToggle variant="dark" className="fixed top-4 right-4" />
        <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-8 text-stone-100">
          <div className="flex items-center gap-3 mb-4">
            <Monitor className="h-8 w-8" />
            <h1 className="text-2xl font-bold">{t('guest.display.title')}</h1>
          </div>
          <p className="text-sm text-stone-400 mb-4">{t('guest.display.tokenHint')}</p>
          <Input
            className="bg-stone-950 border-stone-700 text-stone-100 h-12"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder="rodev_…"
          />
          <Button
            className="w-full mt-4 h-12 text-base"
            onClick={() => {
              const t2 = codeInput.trim()
              if (t2.length < 10) { setError(t('guest.display.invalidToken')); return }
              localStorage.setItem(TOKEN_KEY, t2)
              setToken(t2)
            }}
          >
            {t('guest.display.showScreen')}
          </Button>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>
      </div>
    )
  }

  // Parjenje
  if (info && !info.paired) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-950 p-6">
        <GuestLanguageToggle variant="dark" className="fixed top-4 right-4" />
        <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-8 text-stone-100 text-center">
          <Link2 className="h-10 w-10 mx-auto text-stone-500" />
          <h1 className="text-xl font-bold mt-3">{t('guest.display.connectPos')}</h1>
          <p className="text-sm text-stone-400 mt-2">{t('guest.display.pairHint')}</p>
          <Input
            className="bg-stone-950 border-stone-700 text-stone-100 h-14 text-center text-3xl tracking-[0.4em] mt-4"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
          />
          <Button className="w-full mt-4 h-12 text-base" onClick={connect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t('guest.display.connect')}
          </Button>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button
            className="mt-6 text-xs text-stone-600 hover:text-stone-400"
            onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken('') }}
          >
            {t('guest.display.changeDevice')}
          </button>
        </div>
      </div>
    )
  }

  const p = state?.payload
  const phase = p?.state || 'idle'

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 flex flex-col">
      <header className="px-8 py-5 border-b border-stone-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="h-6 w-6 text-stone-500" />
          <span className="text-lg font-semibold">{info?.posName || 'POS'}</span>
          <span className={`text-sm px-2 py-0.5 rounded-full ${state?.posOnline ? 'bg-green-900/60 text-green-400' : 'bg-stone-800 text-stone-500'}`}>
            {state?.posOnline ? t('guest.display.online') : t('guest.display.offline')}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <GuestLanguageToggle variant="dark" />
          <button onClick={unpair} className="text-stone-600 hover:text-stone-400 flex items-center gap-1 text-sm">
            <Unlink className="h-4 w-4" />{t('guest.display.unpair')}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-10">
        {phase === 'idle' && (
          <div className="text-center">
            <h2 className="text-5xl font-bold text-stone-300">{t('guest.display.welcome')}</h2>
            <p className="mt-4 text-2xl text-stone-500">{t('guest.display.followHint')}</p>
            {p?.message && <p className="mt-8 text-xl text-stone-400">{p.message}</p>}
          </div>
        )}

        {phase === 'ordering' && p && (
          <div className="w-full max-w-3xl">
            <h2 className="text-3xl font-bold text-stone-300">{p.tableName || t('guest.display.currentOrder')}</h2>
            <div className="mt-6 space-y-3">
              {(p.lines || []).map((l, i) => (
                <div key={i} className="flex items-baseline justify-between border-b border-stone-800 pb-3">
                  <div>
                    <span className="text-2xl font-semibold">{l.qty}× {l.name}</span>
                    {l.modifiers && l.modifiers.length > 0 && (
                      <span className="ml-2 text-lg text-stone-500">+ {l.modifiers.join(', ')}</span>
                    )}
                  </div>
                  <span className="text-2xl text-stone-300">{fmt(l.price)}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 space-y-2 text-xl text-stone-400">
              {p.vatBreakdown?.map((v) => (
                <div key={v.rate} className="flex justify-between">
                  <span>{t('guest.display.vatRate', { rate: v.rate })}</span>
                  <span>{fmt(v.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between text-4xl font-bold text-white pt-4 border-t border-stone-700">
                <span>{t('guest.display.total')}</span><span>{fmt(p.total || 0)}</span>
              </div>
            </div>
          </div>
        )}

        {phase === 'paid' && p && (
          <div className="text-center">
            <CheckCircle2 className="h-24 w-24 text-green-500 mx-auto" />
            <h2 className="mt-6 text-5xl font-bold">{t('guest.common.thanks')}</h2>
            {p.orderNumber && <p className="mt-3 text-2xl text-stone-400">{t('guest.display.orderNo', { n: p.orderNumber })}</p>}
            <p className="mt-2 text-3xl font-bold">{fmt(p.total || 0)}</p>
            <p className="mt-8 text-xl text-stone-500">{p.message || t('guest.display.enjoy')}</p>
          </div>
        )}

        {phase === 'ordering' && !p?.lines?.length && (
          <div className="flex items-center gap-3 text-stone-500"><Loader2 className="h-6 w-6 animate-spin" />{t('guest.display.waitingPos')}</div>
        )}
      </main>
    </div>
  )
}
