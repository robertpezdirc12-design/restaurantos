'use client'

/**
 * Issue #3 — Kiosk (zaklenjen samopostrežni terminal).
 * Aktivacija: vnesi device token kiosk naprave (iz Device Registry onboardinga) — enkrat, shrani v localStorage.
 * Tok: meni (ENOTEN vir) → artikel + opcije → košarica → naročilo → številka → samodejni reset.
 * Timeout/reset: po oddaji 45 s ali 90 s nedejavnosti v košarici — prejšnji gost ni ostane prijavljen.
 * Naročilo gre skozi ISTI createOrderCore pipeline → KDS.
 * i18n (33-b): dvojezičnost SL/HR prek GuestI18nProvider (isti slovar + isti
 * localStorage ključ kot glavna aplikacija; preklop brez reload-a).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, Plus, Minus, Monitor, CheckCircle2, Lock } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle, useGuestApiError } from '@/components/guest-i18n'
import { ALLERGEN_CODES, allergenLabel, labelToAllergenCode, type AllergenLocale } from '@/lib/allergen-catalog'
import { parseAllergens } from '@/lib/allergens'

interface ModifierOption { id: string; name: string; price: number; allergenCodes?: string[] }
interface ModifierGroup { id: string; name: string; required: boolean; minSelect: number; maxSelect: number | null; options: ModifierOption[] }
interface MenuItem { id: string; name: string; description: string; price: number; isAvailable: boolean; allergens: string; categoryId: string; modifierGroups: ModifierGroup[]; image?: string; allergenCodes?: string[]; allergenCrossContact?: string[]; allergenStatus?: string }
interface CartLine { key: string; item: MenuItem; qty: number; note: string; modifiers: ModifierOption[] }
/** OPS-10 val 2: upsell map from /api/public/menu — { menuItemId: [suggestedId, …] } */
interface UpsellMap { [menuItemId: string]: string[] }
/** OPS-10 val 2: max unique suggestions shown in the "Dodaj še" strip. */
const UPSELL_STRIP_MAX = 3

const TOKEN_KEY = 'ro_kiosk_device_token'
const fmt = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const IDLE_RESET_SEC = 45

/** Samodejni ponovni poskus nalaganja menija ob odpovedi omrežja (ms). */
const RETRY_MS = 5000
/** Največje število zaporednih samodejnih poskusov (nato čaka na `online`). */
const MAX_RETRIES = 6

export default function KioskPage() {
  return (
    <GuestI18nProvider>
      <KioskInner />
    </GuestI18nProvider>
  )
}

function KioskInner() {
  const { t, locale } = useGuestT()
  const [token, setToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [menu, setMenu] = useState<{ restaurant: string; categories: { id: string; name: string }[]; items: MenuItem[]; upsells?: UpsellMap } | null>(null)
  const pageErr = useGuestApiError() // issue #2 §C: surov niz → prevod ob izrisu
  const [retryHint, setRetryHint] = useState(false)
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
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttempts = useRef(0)

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY) || ''
    setToken(t)
    if (t) loadMenu(t)
  }, [])

  /* Issue #9 (v1.119.0) — osveževanje razpoložljivosti (86) brez ponovnega nalaganja:
     lahkotna javna ruta /api/public/menu/availability (isti napravin žeton, ETag/304),
     polling vsakih 30 s + takoj ob vrnitvi v vidno stanje. Kiosk je 24/7 naprava —
     razprodani artikel izgine iz naročanja (disabled) v ≤30 s; strežnik je edini vir. */
  useEffect(() => {
    if (!token || !menu) return
    let alive = true
    const refresh = async () => {
      try {
        const res = await fetch('/api/public/menu/availability', { cache: 'no-store', headers: { 'X-Device-Token': token } })
        if (!res.ok || res.status === 304) return
        const d = (await res.json()) as { availability?: { id: string; isAvailable: boolean }[] }
        if (!alive || !d.availability?.length) return
        const byId = new Map(d.availability.map((a) => [a.id, a.isAvailable]))
        setMenu((prev) => (prev
          ? { ...prev, items: prev.items.map((it) => (byId.has(it.id) ? { ...it, isAvailable: byId.get(it.id)! } : it)) }
          : prev))
      } catch { /* tiho — naslednji cikel */ }
    }
    const iv = setInterval(refresh, 30_000)
    const onVis = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [token, menu !== null])

  // vrnitev omrežja — takojšen poskus (svež budget poskusov), če meni še ni naložen
  useEffect(() => {
    const onOnline = () => {
      stopRetry()
      const tok = localStorage.getItem(TOKEN_KEY) || ''
      if (tok && !menu) loadMenu(tok)
    }
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
      if (retryTimer.current) clearTimeout(retryTimer.current)
    }
  }, [menu])

  const resetAll = useCallback(() => {
    setCart([])
    setDetail(null)
    setDone(null)
    pageErr.clear()
    setRetryHint(false)
  }, [pageErr])

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

  async function loadMenu(tok: string) {
    setLoading(true)
    pageErr.clear()
    try {
      const res = await fetch('/api/public/menu', { headers: { 'X-Device-Token': tok }, cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) {
        // poslovna napaka (npr. kiosk ni aktiviran) — ponavljanje ne pomaga
        stopRetry()
        setRetryHint(false)
        pageErr.set(data?.error, 'guest.kiosk.notActivated')
        return
      }
      stopRetry()
      setMenu(data)
      setActiveCat(data.categories?.[0]?.id || '')
    } catch {
      // omrežje nedosegljivo — kiosk (24/7 naprava) naj se sam pozdravi:
      // omejeno število samodejnih poskusov, ob `online` dogodku takoj znova
      const attempt = retryAttempts.current + 1
      retryAttempts.current = attempt
      // pripona autoRetry je LOČEN state — izriše se ob vsakem izrisu (issue #2 §C)
      setRetryHint(attempt <= MAX_RETRIES)
      pageErr.setKey('guest.error.unreachable')
      if (attempt <= MAX_RETRIES) {
        if (retryTimer.current) clearTimeout(retryTimer.current)
        retryTimer.current = setTimeout(() => loadMenu(tok), RETRY_MS)
      }
    } finally {
      setLoading(false)
    }
  }

  /** Ponastavi samodejne poskuse nalaganja menija (uspeh ali poslovna napaka). */
  function stopRetry() {
    retryAttempts.current = 0
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
  }

  async function activate() {
    const val = tokenInput.trim()
    pageErr.clear()
    // Issue #4 §2.2: aktivacija z ENKRATNO vpisno kodo (8 števk) ALI neposredno z rodev_ tokenom
    if (/^\d{8}$/.test(val)) {
      setLoading(true)
      try {
        const res = await fetch('/api/devices/enroll', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: val }),
        })
        const data = await res.json()
        if (!res.ok || !data.device?.token) { pageErr.set(data?.error, 'guest.kiosk.activationFailed'); return }
        localStorage.setItem(TOKEN_KEY, data.device.token)
        setToken(data.device.token)
        await loadMenu(data.device.token)
      } catch {
        pageErr.setKey('guest.error.unreachable')
      } finally { setLoading(false) }
      return
    }
    if (val.length < 10) { pageErr.setKey('guest.kiosk.tokenHint'); return }
    localStorage.setItem(TOKEN_KEY, val)
    setToken(val)
    loadMenu(val)
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

  // OPS-10 val 2: up to 3 UNIQUE upsell candidates for the "Dodaj še" strip —
  // seeded from the cart's items, never suggesting something already in the cart
  // (or unavailable). Shown only while the cart holds items and the order is not submitted.
  const upsellSuggestions = useMemo<MenuItem[]>(() => {
    if (!menu || done || cart.length === 0) return []
    const cartIds = new Set(cart.map((l) => l.item.id))
    const byId = new Map(menu.items.map((i) => [i.id, i]))
    const out: MenuItem[] = []
    const seen = new Set<string>()
    for (const line of cart) {
      for (const id of menu.upsells?.[line.item.id] || []) {
        if (out.length >= UPSELL_STRIP_MAX) return out
        if (seen.has(id) || cartIds.has(id)) continue
        const it = byId.get(id)
        if (!it || !it.isAvailable) continue
        seen.add(id)
        out.push(it)
      }
      if (out.length >= UPSELL_STRIP_MAX) return out
    }
    return out
  }, [menu, cart, done])

  /** OPS-10 val 2: one-tap add. Items with required modifier choices open the normal detail dialog. */
  function addUpsell(it: MenuItem) {
    if (it.modifierGroups.some((g) => g.required && g.minSelect > 0 && g.options.length)) { openDetail(it); return }
    setCart((p) => [...p, { key: `${it.id}-${Date.now()}`, item: it, qty: 1, note: '', modifiers: [] }])
  }

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
      if (!res.ok) { pageErr.set(data?.error, 'guest.error.orderFailed'); return }
      setDone({ orderNumber: data.orderNumber, total: data.total })
      setCart([])
    } catch {
      pageErr.setKey('guest.error.orderNotSubmitted')
    } finally {
      setSubmitting(false)
    }
  }

  // ——— Aktivacija (onboarding) ———
  if (!token || (!menu && !loading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-900 p-6">
        <GuestLanguageToggle variant="dark" className="fixed top-3 right-3 z-50" />
        <div className="w-full max-w-md rounded-3xl bg-stone-800 border border-stone-700 p-8 text-stone-100">
          <div className="flex items-center gap-3 mb-4">
            <Monitor className="h-8 w-8" />
            <h1 className="text-2xl font-bold">{t('guest.kiosk.title')}</h1>
          </div>
          <p className="text-sm text-stone-400 mb-4">
            {t('guest.kiosk.instructions')}
          </p>
          <Input
            className="bg-stone-900 border-stone-600 text-stone-100 h-12"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t('guest.kiosk.tokenPlaceholder')}
          />
          {pageErr.error && <p className="mt-3 text-sm text-red-400">{pageErr.text}{retryHint ? ` ${t('guest.kiosk.autoRetry')}` : ''}</p>}
          <Button className="w-full mt-4 h-12 text-base" onClick={activate} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
            {t('guest.kiosk.activate')}
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
      <header className="px-6 py-4 border-b border-stone-800 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate">{menu?.restaurant}</h1>
          <p className="text-sm text-stone-400">{t('guest.kiosk.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <GuestLanguageToggle variant="dark" />
          <button
            title={t('guest.kiosk.lockTitle')}
            className="text-stone-600 hover:text-stone-400"
            onDoubleClick={() => { localStorage.removeItem(TOKEN_KEY); resetAll(); setToken('') }}
          >
            <Lock className="h-5 w-5" />
          </button>
        </div>
      </header>

      {done && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <CheckCircle2 className="h-24 w-24 text-green-500" />
          <h2 className="mt-6 text-4xl font-bold">{t('guest.common.thanks')}</h2>
          <p className="mt-2 text-2xl text-stone-300">{t('guest.kiosk.yourNumber')}</p>
          <p className="mt-4 text-7xl font-extrabold tracking-tight text-white">#{done.orderNumber}</p>
          <p className="mt-4 text-xl text-stone-400">{t('guest.common.amount')}: <b className="text-white">{fmt(done.total)}</b> {t('guest.common.payAtCashier')}</p>
          <p className="mt-8 text-sm text-stone-500">{t('guest.kiosk.autoReset')}</p>
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
                  {/* OPS-11 val 1: main menu item thumbnails (80×80 left of the text, lazy, onError hide).
                      Items WITHOUT an image render exactly as before (plain tile, no layout change);
                      shrink-0 keeps the grid rows even. */}
                  <div className={it.image ? 'flex items-start gap-3' : undefined}>
                    {it.image && (
                      <img
                        src={it.image}
                        alt={it.name}
                        loading="lazy"
                        className="h-20 w-20 rounded-2xl object-cover shrink-0 bg-stone-700"
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-xl font-semibold leading-snug">{it.name}</p>
                      {it.description && <p className="text-sm text-stone-400 mt-1 line-clamp-2">{it.description}</p>}
                      <p className="mt-3 text-2xl font-bold">{fmt(it.price)}</p>
                      {!it.isAvailable && <p className="text-sm text-red-400 mt-1">{t('guest.common.unavailable')}</p>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </main>

          {/* OPS-10 val 2: "Dodaj še" upsell strip — up to 3 unique suggestions, one tap to add.
              Skipped entirely when nothing is configured / nothing matches (already in cart). */}
          {!done && upsellSuggestions.length > 0 && (
            <div className="border-t border-stone-800 px-6 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="max-w-6xl mx-auto">
                <p className="text-sm font-semibold uppercase tracking-wide text-stone-500 mb-2">{t('guest.kiosk.upsellTitle')}</p>
                <div className="flex gap-3 overflow-x-auto no-scrollbar">
                  {upsellSuggestions.map((it) => (
                    <button
                      key={it.id}
                      onClick={() => addUpsell(it)}
                      className="shrink-0 w-60 rounded-2xl bg-stone-800 border border-stone-700 p-2.5 flex items-center gap-3 text-left transition-transform hover:border-stone-500 active:scale-[0.97]"
                    >
                      {it.image && (
                        // small upsell thumb (h-16, OPS-10 val 2) — main grid thumbs are rendered separately (OPS-11 val 1)
                        <img src={it.image} alt={it.name} loading="lazy" className="h-16 w-16 rounded-xl object-cover shrink-0 bg-stone-700" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-snug truncate">{it.name}</span>
                        <span className="block text-lg font-bold">{fmt(it.price)}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-white text-stone-900 p-1.5" aria-hidden="true"><Plus className="h-4 w-4" /></span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <footer className="border-t border-stone-800 p-4">
            <div className="max-w-6xl mx-auto flex items-center gap-4">
              <div className="flex-1 min-h-[56px] flex items-center gap-3 overflow-x-auto no-scrollbar">
                {cart.length === 0 && <span className="text-stone-500">{t('guest.kiosk.cartEmpty')}</span>}
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
                {t('guest.kiosk.submit')} · {fmt(total)}
              </Button>
            </div>
            {pageErr.error && <p className="max-w-6xl mx-auto mt-2 text-red-400">{pageErr.text}{retryHint ? ` ${t('guest.kiosk.autoRetry')}` : ''}</p>}
          </footer>
        </>
      )}

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg bg-stone-800 border-stone-700 text-stone-100 max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              {/* OPS-9 val 3: allergens in the kiosk item detail (same format as the QR menu) */}
              <DialogHeader>
                <DialogTitle className="text-2xl">{detail.name}</DialogTitle>
                {/* Issue #7: kanonične kode (enoten SL/HR prikaz) + "lahko vsebuje" + status */}
                {(() => {
                  const set = new Set<string>(detail.allergenCodes || [])
                  for (const raw of parseAllergens(detail.allergens)) {
                    const code = labelToAllergenCode(raw)
                    if (code) set.add(code)
                  }
                  const kLoc: AllergenLocale = locale === 'hr' ? 'hr' : locale === 'en' ? 'en' : 'sl'
                  const kLbl = (code: string) => ((ALLERGEN_CODES as readonly string[]).includes(code) ? allergenLabel(code, kLoc) : code)
                  return (
                    <div className="space-y-0.5">
                      {set.size > 0 && <p className="text-sm text-stone-400">{t('guest.menu.allergens', { allergens: [...set].map(kLbl).join(', ') })}</p>}
                      {(detail.allergenCrossContact ?? []).length > 0 && <p className="text-xs text-amber-400">⚠ {t('guest.menu.allergenMayContain', { allergens: (detail.allergenCrossContact ?? []).map(kLbl).join(', ') })}</p>}
                      {detail.allergenStatus && detail.allergenStatus !== 'confirmed' && (
                        <p className="text-xs text-stone-400">⚠ {detail.allergenStatus === 'review_required' ? t('guest.menu.allergenReview') : t('guest.menu.allergenConfirmNeeded')}</p>
                      )}
                    </div>
                  )
                })()}
              </DialogHeader>
              <div className="space-y-4">
                {detail.modifierGroups.map((g) => (
                  <div key={g.id}>
                    <p className="font-semibold mb-2">{g.name} {g.required ? <span className="text-red-400">*</span> : <span className="text-stone-400 font-normal text-sm">({t('guest.common.optional')})</span>}</p>
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
                  <p className="text-sm font-medium text-stone-400 mb-1">{t('guest.common.note')}</p>
                  <Input className="bg-stone-900 border-stone-600 text-stone-100" value={detailNote} onChange={(e) => setDetailNote(e.target.value)} placeholder={t('guest.kiosk.notePlaceholder')} maxLength={200} />
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setDetailQty((q) => Math.max(1, q - 1))}><Minus className="h-5 w-5" /></Button>
                  <span className="text-2xl font-bold w-10 text-center">{detailQty}</span>
                  <Button variant="outline" size="icon" className="h-12 w-12" onClick={() => setDetailQty((q) => Math.min(30, q + 1))}><Plus className="h-5 w-5" /></Button>
                  <Button
                    className="flex-1 ml-auto h-12 text-lg"
                    onClick={addToCart}
                  >
                    {t('guest.common.add')} · {fmt(detailLineTotal())}
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
