'use client'

/**
 * Issue #3 — Customer-facing display (CFD).
 * Drugi zaslon, povezan s POS napravo: aktivacija preko 6-mestne paring kode (POS ustvari kodo v Nastavitvah).
 * Polling 2s: artikli, količine, opcije, DDV, končni znesek; stanja pred naročilom / med / po plačilu.
 * Brez občutljivih podatkov zaposlenih (payload postavi POS, display samo prikaže).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Monitor, CheckCircle2, Link2, Unlink } from 'lucide-react'

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
  const [token, setToken] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [info, setInfo] = useState<{ paired: boolean; posName?: string; posOnline?: boolean } | null>(null)
  const [state, setState] = useState<{ payload: DisplayPayload | null; posOnline: boolean; updatedAt?: string } | null>(null)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY) || ''
    setToken(t)
  }, [])

  const refresh = useCallback(async (t: string) => {
    try {
      const res = await fetch('/api/devices/display/state', { headers: { 'X-Device-Token': t }, cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Display naprava ni registrirana.'); return }
      setError('')
      setInfo({ paired: data.paired, posName: data.posName, posOnline: data.posOnline })
      setState({ payload: data.payload, posOnline: data.posOnline, updatedAt: data.updatedAt })
    } catch {
      // povezava nedosegljiva — pusti zadnje stanje, ne lažnega
    }
  }, [])

  useEffect(() => {
    if (!token) return
    refresh(token)
    const iv = setInterval(() => refresh(token), 2000)
    return () => clearInterval(iv)
  }, [token, refresh])

  async function connect() {
    if (!/^\d{6}$/.test(codeInput.trim())) { setError('Koda je 6-mestna številka (POS → Nastavitve → Customer display).'); return }
    setConnecting(true)
    try {
      const res = await fetch('/api/devices/display', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
        body: JSON.stringify({ action: 'connect', code: codeInput.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Povezava ni uspela.'); return }
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
        <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-8 text-stone-100">
          <div className="flex items-center gap-3 mb-4">
            <Monitor className="h-8 w-8" />
            <h1 className="text-2xl font-bold">Customer display</h1>
          </div>
          <p className="text-sm text-stone-400 mb-4">
            Vnesi token naprave tipa <b>customer_display</b> (Nastavitve → Naprave → dodaj napravo).
          </p>
          <Input
            className="bg-stone-950 border-stone-700 text-stone-100 h-12"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder="rodev_…"
          />
          <Button
            className="w-full mt-4 h-12 text-base"
            onClick={() => {
              const t = codeInput.trim()
              if (t.length < 10) { setError('Vnesi veljaven token naprave.'); return }
              localStorage.setItem(TOKEN_KEY, t)
              setToken(t)
            }}
          >
            Prikaži zaslon
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
        <div className="w-full max-w-md rounded-3xl bg-stone-900 border border-stone-800 p-8 text-stone-100 text-center">
          <Link2 className="h-10 w-10 mx-auto text-stone-500" />
          <h1 className="text-xl font-bold mt-3">Poveži z POS</h1>
          <p className="text-sm text-stone-400 mt-2">
            Na POS: Nastavitve → Customer display → <b>Pokaži kodo</b>. Vnesi 6-mestno kodo:
          </p>
          <Input
            className="bg-stone-950 border-stone-700 text-stone-100 h-14 text-center text-3xl tracking-[0.4em] mt-4"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
          />
          <Button className="w-full mt-4 h-12 text-base" onClick={connect} disabled={connecting}>
            {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Poveži
          </Button>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button
            className="mt-6 text-xs text-stone-600 hover:text-stone-400"
            onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken('') }}
          >
            Zamenjaj napravo
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
            {state?.posOnline ? 'povezan' : 'brez povezave'}
          </span>
        </div>
        <button onClick={unpair} className="text-stone-600 hover:text-stone-400 flex items-center gap-1 text-sm">
          <Unlink className="h-4 w-4" />Razveži
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-10">
        {phase === 'idle' && (
          <div className="text-center">
            <h2 className="text-5xl font-bold text-stone-300">Dobrodošli!</h2>
            <p className="mt-4 text-2xl text-stone-500">Vaše naročilo lahko sledite na tem zaslonu.</p>
            {p?.message && <p className="mt-8 text-xl text-stone-400">{p.message}</p>}
          </div>
        )}

        {phase === 'ordering' && p && (
          <div className="w-full max-w-3xl">
            <h2 className="text-3xl font-bold text-stone-300">{p.tableName || 'Trenutno naročilo'}</h2>
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
                <div key={v.rate} className="flex justify-between"><span>DDV {v.rate}%</span><span>{fmt(v.amount)}</span></div>
              ))}
              <div className="flex justify-between text-4xl font-bold text-white pt-4 border-t border-stone-700">
                <span>SKUPAJ</span><span>{fmt(p.total || 0)}</span>
              </div>
            </div>
          </div>
        )}

        {phase === 'paid' && p && (
          <div className="text-center">
            <CheckCircle2 className="h-24 w-24 text-green-500 mx-auto" />
            <h2 className="mt-6 text-5xl font-bold">Hvala!</h2>
            {p.orderNumber && <p className="mt-3 text-2xl text-stone-400">Naročilo #{p.orderNumber}</p>}
            <p className="mt-2 text-3xl font-bold">{fmt(p.total || 0)}</p>
            <p className="mt-8 text-xl text-stone-500">{p.message || 'Uživajte v obroku!'}</p>
          </div>
        )}

        {phase === 'ordering' && !p?.lines?.length && (
          <div className="flex items-center gap-3 text-stone-500"><Loader2 className="h-6 w-6 animate-spin" />Čakam na podatke POS-a …</div>
        )}
      </main>
    </div>
  )
}
