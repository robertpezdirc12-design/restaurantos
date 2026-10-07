'use client'

/**
 * Issue #3 — Kiosk (zaklenjen samopostrežni terminal).
 * Aktivacija: vnesi device token kiosk naprave (iz Device Registry onboardinga) — enkrat, shrani v localStorage.
 * Tok: meni (ENOTEN vir) → artikel + opcije → košarica → naročilo → številka → samodejni reset.
 * Timeout/reset: po oddaji 45 s ali 90 s nedejavnosti v košarici — prejšnji gost ni ostane prijavljen.
 * Naročilo gre skozi ISTI createOrderCore pipeline → KDS.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, Plus, Minus, Monitor, CheckCircle2, Lock } from 'lucide-react'

interface ModifierOption { id: string; name: string; price: number }
interface ModifierGroup { id: string; name: string; required: boolean; minSelect: number; maxSelect: number | null; options: ModifierOption[] }
interface MenuItem { id: string; name: string; description: string; price: number; isAvailable: boolean; categoryId: string; modifierGroups: ModifierGroup[] }
interface CartLine { key: string; item: MenuItem; qty: number; note: string; modifiers: ModifierOption[] }

const TOKEN_KEY = 'ro_kiosk_device_token'
const fmt = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const IDLE_RESET_SEC = 45

export default function KioskPage() {
  const [token, setToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [menu, setMenu] = useState<{ restaurant: string; categories: { id: string; name: string }[]; items: MenuItem[] } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeCat, setActiveCat] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [detail, setDetail] = useState<MenuItem | null>(null)
  const [detailQty, setDetailQty] = useState(1)
  const [detailNote, setDetailNote] = useState('')
  const [detailMods, setDetailMods] = useState<Record<string, string[]>>({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ orderNumber: number; total: number } | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY) || ''
    setToken(t)
    if (t) loadMenu(t)
  }, [])

  const resetAll = useCallback(() => {
    setCart([])
    setDetail(null)
    setDone(null)
    setError('')
  }, [])

  // Samodejni reset — timeout ne sme pustiti prejšnjega gosta v toku
  useEffect(() => {
    if (!menu || done) return
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(resetAll, 90_000)
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current) }
  }, [cart, detail, menu, done, resetAll])

  // števec do reset-a po oddaji
  useEffect(() => {
    if (!done) return
    const iv = setInterval(() => {
      resetAll()
    }, IDLE_RESET_SEC * 1000)
    return () => clearInterval(iv)
  }, [done, resetAll])

  async function loadMenu(t: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/public/menu', { headers: { 'X-Device-Token': t }, cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Kiosk ni aktiviran.'); return }
      setMenu(data)
      setActiveCat(data.categories?.[0]?.id || '')
    } catch {
      setError('Povezava ni dosegljiva.')
    } finally {
      setLoading(false)
    }
  }

  function activate() {
    const t = tokenInput.trim()
    if (t.length < 10) { setError('Vnesi veljaven token naprave (rodev_…).'); return }
    localStorage.setItem(TOKEN_KEY, t)
    setToken(t)
    loadMenu(t)
  }

  function openDetail(it: MenuItem) {
    setDetail(it); setDetailQty(1); setDetailNote('')
    const init: Record<string, string[]> = {}
    for (const g of it.modifierGroups) if (g.required && g.minSelect > 0 && g.options.length) init[g.id] = [g.options[0].id]
    setDetailMods(init)
  }

  function toggleMod(groupId: string, optionId: string, maxSelect: number | null) {
    setDetailMods((prev) => {
      const cur = prev[groupId] || []
      if (cur.includes(optionId)) return { ...prev, [groupId]: cur.filter((x) => x !== optionId) }
      const next = maxSelect && cur.length >= maxSelect ? [...cur.slice(1), optionId] : [...cur, optionId]
      return { ...prev, [groupId]: next }
    })
  }

  function addToCart() {
    if (!detail) return
    for (const g of detail.modifierGroups) if (g.required && (detailMods[g.id] || []).length < Math.max(1, g.minSelect)) return
    const mods = detail.modifierGroups.flatMap((g) => (detailMods[g.id] || []).map((mid) => g.options.find((o) => o.id === mid)!).filter(Boolean))
    setCart((p) => [...p, { key: `${detail.id}-${Date.now()}`, item: detail, qty: detailQty, note: detailNote.trim(), modifiers: mods }])
    setDetail(null)
  }

  function detailLineTotal(): number {
    if (!detail) return 0
    let modsSum = 0
    for (const g of detail.modifierGroups) {
      for (const mid of detailMods[g.id] || []) {
        const opt = g.options.find((o) => o.id === mid)
        if (opt) modsSum += opt.price
      }
    }
    return (detail.price + modsSum) * detailQty
  }

  const lineTotal = (l: CartLine) => (l.item.price + l.modifiers.reduce((s, m) => s + m.price, 0)) * l.qty
  const total = cart.reduce((s, l) => s + lineTotal(l), 0)
  const itemsByCat = useMemo(() => {
    const m = new Map<string, MenuItem[]>()
    for (const it of menu?.items || []) { const list = m.get(it.categoryId) || []; list.push(it); m.set(it.categoryId, list) }
    return m
  }, [menu])

  async function submit() {
    if (cart.length === 0 || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/public/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
        body: JSON.stringify({
          clientOperationId: crypto.randomUUID(),
          items: cart.map((l) => ({ menuItemId: l.item.id, qty: l.qty, note: l.note || undefined, modifierIds: l.modifiers.map((m) => m.id) })),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Naročila ni bilo mogoče oddati.'); return }
      setDone({ orderNumber: data.orderNumber, total: data.total })
      setCart([])
    } catch {
      setError('Povezava ni dosegljiva — naročilo NI oddano.')
    } finally {
      setSubmitting(false)
    }
  }

  // ——— Aktivacija (onboarding) ———
  if (!token || (!menu && !loading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-900 p-6">
        <div className="w-full max-w-md rounded-3xl bg-stone-800 border border-stone-700 p-8 text-stone-100">
          <div className="flex items-center gap-3 mb-4">
            <Monitor className="h-8 w-8" />
            <h1 className="text-2xl font-bold">Kiosk aktivacija</h1>
          </div>
          <p className="text-sm text-stone-400 mb-4">
            Vnesi token kiosk naprave (Nastavitve → Naprave → dodaj napravo tipa Kiosk).
          </p>
          <Input
            className="bg-stone-900 border-stone-600 text-stone-100 h-12"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="rodev_…"
          />
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <Button className="w-full mt-4 h-12 text-base" onClick={activate} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
            Aktiviraj kiosk
          </Button>
        </div>
      </div>
    )
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-stone-900 text-stone-400"><Loader2 className="h-10 w-10 animate-spin" /></div>
  }

  return (
    <div className="min-h-screen bg-stone-900 text-stone-100 flex flex-col">
      <header className="px-6 py-4 border-b border-stone-800 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{menu?.restaurant}</h1>
          <p className="text-sm text-stone-400">Samopostrežni kiosk — izberi artikle in oddaj naročilo</p>
        </div>
        <button
          title="Zakleni/ponastavi kiosk (zahteva dolg pritisk)"
          className="text-stone-600 hover:text-stone-400"
          onDoubleClick={() => { localStorage.removeItem(TOKEN_KEY); resetAll(); setToken('') }}
        >
          <Lock className="h-5 w-5" />
        </button>
      </header>

      {done && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <CheckCircle2 className="h-24 w-24 text-green-500" />
          <h2 className="mt-6 text-4xl font-bold">Hvala!</h2>
          <p className="mt-2 text-2xl text-stone-300">Tvoja številka naročila:</p>
          <p className="mt-4 text-7xl font-extrabold tracking-tight text-white">#{done.orderNumber}</p>
          <p className="mt-4 text-xl text-stone-400">Znesek: <b className="text-white">{fmt(done.total)}</b> · plačilo na blagajni</p>
          <p className="mt-8 text-sm text-stone-500">Kiosk se samodejno ponastavi …</p>
        </div>
      )}

      {!done && (
        <>
          <nav className="flex gap-2 overflow-x-auto px-6 py-3 border-b border-stone-800 no-scrollbar">
            {menu?.categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCat(c.id)}
                className={`shrink-0 rounded-full px-5 py-2.5 text-lg font-medium ${activeCat === c.id ? 'bg-white text-stone-900' : 'bg-stone-800 text-stone-300'}`}
              >
                {c.name}
              </button>
            ))}
          </nav>

          <main className="flex-1 overflow-y-auto p-6">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
              {(itemsByCat.get(activeCat) || []).map((it) => (
                <button
                  key={it.id}
                  onClick={() => it.isAvailable && openDetail(it)}
                  disabled={!it.isAvailable}
                  className={`rounded-2xl bg-stone-800 border p-5 text-left transition-transform ${it.isAvailable ? 'border-stone-700 active:scale-[0.98] hover:border-stone-500' : 'border-stone-800 opacity-40 cursor-not-allowed'}`}
                >
                  <p className="text-xl font-semibold leading-snug">{it.name}</p>
                  {it.description && <p className="text-sm text-stone-400 mt-1 line-clamp-2">{it.description}</p>}
                  <p className="mt-3 text-2xl font-bold">{fmt(it.price)}</p>
                  {!it.isAvailable && <p className="text-sm text-red-400 mt-1">Ni na voljo</p>}
                </button>
              ))}
            </div>
          </main>

          <footer className="border-t border-stone-800 p-4">
            <div className="max-w-6xl mx-auto flex items-center gap-4">
              <div className="flex-1 min-h-[56px] flex items-center gap-3 overflow-x-auto no-scrollbar">
                {cart.length === 0 && <span className="text-stone-500">Košarica je prazna — tapni artikel za začetek.</span>}
                {cart.map((l) => (
                  <div key={l.key} className="shrink-0 rounded-xl bg-stone-800 border border-stone-700 px-3 py-2 flex items-center gap-2">
                    <span className="font-medium">{l.qty}× {l.item.name}</span>
                    <button onClick={() => setCart((p) => l.qty > 1 ? p.map((x) => x.key === l.key ? { ...x, qty: x.qty - 1 } : x) : p.filter((x) => x.key !== l.key))} className="text-stone-500 hover:text-white"><Minus className="h-4 w-4" /></button>
                    <button onClick={() => setCart((p) => p.map((x) => x.key === l.key ? { ...x, qty: x.qty + 1 } : x))} className="text-stone-500 hover:text-white"><Plus className="h-4 w-4" /></button>
                    <span className="font-bold ml-1">{fmt(lineTotal(l))}</span>
                  </div>
                ))}
              </div>
              <Button size="lg" className="h-16 px-10 text-xl rounded-2xl" onClick={submit} disabled={submitting || cart.length === 0}>
                {submitting ? <Loader2 className="mr-2 h-6 w-6 animate-spin" /> : null}
                Oddaj · {fmt(total)}
              </Button>
            </div>
            {error && <p className="max-w-6xl mx-auto mt-2 text-red-400">{error}</p>}
          </footer>
        </>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg bg-stone-800 border-stone-700 text-stone-100 max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader><DialogTitle className="text-2xl">{detail.name}</DialogTitle></DialogHeader>
              <div className="space-y-4">
                {detail.modifierGroups.map((g) => (
                  <div key={g.id}>
                    <p className="font-semibold mb-2">{g.name} {g.required ? <span className="text-red-400">*</span> : <span className="text-stone-400 font-normal text-sm">(neobvezno)</span>}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {g.options.map((o) => (
                        <label key={o.id} className="flex items-center justify-between rounded-xl border border-stone-600 px-3 py-2.5 cursor-pointer has-[:checked]:border-white">
                          <span className="flex items-center gap-2">
                            <Checkbox checked={(detailMods[g.id] || []).includes(o.id)} onCheckedChange={() => toggleMod(g.id, o.id, g.maxSelect)} />
                            {o.name}
                          </span>
                          <span className="text-stone-400">{o.price > 0 ? `+${fmt(o.price)}` : ''}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div>
                  <p className="text-sm font-medium text-stone-400 mb-1">Opomba</p>
                  <Input className="bg-stone-900 border-stone-600 text-stone-100" value={detailNote} onChange={(e) => setDetailNote(e.target.value)} placeholder="npr. brez ledenika" maxLength={200} />
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setDetailQty((q) => Math.max(1, q - 1))}><Minus className="h-5 w-5" /></Button>
                  <span className="text-2xl font-bold w-10 text-center">{detailQty}</span>
                  <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setDetailQty((q) => Math.min(30, q + 1))}><Plus className="h-5 w-5" /></Button>
                  <Button
                    className="flex-1 ml-auto h-12 text-lg"
                    onClick={addToCart}
                  >
                    Dodaj · {fmt(detailLineTotal())}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
