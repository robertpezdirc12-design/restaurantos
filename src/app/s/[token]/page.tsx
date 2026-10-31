'use client'

/**
 * P1 #8 (v1.190.0) — LASTNI SPLETNI PORTAL ZA NAROČILA (/s/<token>).
 * Javna gostujoča stran: brez prijave, mobilna, ENOTEN meni (isti DB kot POS).
 * Naročilo (prevzem ali dostava) gre skozi ISTI kanonični pipeline
 * (createOrderCore, vir 'web') → KDS/Bar → plačilo ob prevzemu → račun/FURS.
 * Idempotencija: clientOperationId v sessionStorage — refresh NE ustvari dvojnika.
 * Sledenje: trackKey = HMAC (strežnik ga izda ob oddaji) v localStorage —
 * gost po osvežitvi še vedno vidi status svojega naročila (brez prijave).
 * i18n: SL/HR/EN prek GuestI18nProvider (isti slovar + isti localStorage ključ
 * kot ostale gostujoče strani; preklop brez reload-a).
 */
import { use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Loader2, ShoppingCart, Plus, Minus, WifiOff, RefreshCw, CheckCircle2, Clock, Store, Bike } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle, guestStatusKey, useGuestApiError } from '@/components/guest-i18n'
import { vatFromGross } from '@/lib/billing'
import type { BrandThemeView } from '@/lib/brand-themes'
import { BrandLogo } from '@/components/brand-logo'

interface ModifierOption { id: string; name: string; price: number }
interface ModifierGroup { id: string; name: string; required: boolean; minSelect: number; maxSelect: number | null; options: ModifierOption[] }
interface MenuItem { id: string; name: string; description: string; price: number; vatRate: number; isAvailable: boolean; categoryId: string; modifierGroups: ModifierGroup[] }
interface StorePayload {
  restaurant: string
  note: string
  open: boolean
  closedKnown: boolean
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number
  minOrder: number
  etaMinutes: number
  categories: { id: string; name: string }[]
  items: MenuItem[]
  theme?: BrandThemeView
}
interface CartLine { key: string; item: MenuItem; qty: number; note: string; allergenWarning: string; modifiers: ModifierOption[] }
interface TrackT { n: number; k: string }

const fmt = (n: number) => `${n.toFixed(2).replace('.', ',')} €`
const TRACK_KEY = (token: string) => `ro_web_track_${token}`

export default function WebStorePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <GuestI18nProvider>
      <WebStoreInner params={params} />
    </GuestI18nProvider>
  )
}

function WebStoreInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { t } = useGuestT()
  const [store, setStore] = useState<StorePayload | null>(null)
  // OSS-11 (v1.213.0): tema znamke (aditivno — brez teme = izgled nespremenjen).
  const theme = store?.theme ?? null
  const acc = theme ? { backgroundColor: theme.accent, color: theme.textOn } : undefined
  const accBorder = theme ? { borderColor: theme.accent } : undefined
  const pageErr = useGuestApiError()
  const { set: setPageErr, setKey: setPageErrKey, clear: clearPageErr } = pageErr // stabilni setri — NE v deps s samim objektom (vzorec /m)
  const [loading, setLoading] = useState(true)
  const [activeCat, setActiveCat] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [detail, setDetail] = useState<MenuItem | null>(null)
  const [detailQty, setDetailQty] = useState(1)
  const [detailNote, setDetailNote] = useState('')
  const [detailAllergenWarning, setDetailAllergenWarning] = useState('')
  const [detailMods, setDetailMods] = useState<Record<string, string[]>>({})
  const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>('pickup')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [postCode, setPostCode] = useState('')
  const [instructions, setInstructions] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [track, setTrack] = useState<TrackT | null>(null)
  const [trackStatus, setTrackStatus] = useState('')
  const [eta, setEta] = useState<number | null>(null)
  // online/offline — zunanja vrednost prek useSyncExternalStore (getServerSnapshot = true,
  // isti prvi izris kot prejšnji useState(true); posodobitve prek online/offline dogodkov)
  const subscribeOnline = useCallback((cb: () => void) => {
    window.addEventListener('online', cb)
    window.addEventListener('offline', cb)
    return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) }
  }, [])
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

  const opIdRef = useRef<string>('')
  // isti clientOperationId preživi refresh → idempotenten replay (brez dvojnika).
  // Refa ne beremo med renderom (pravilo refs) — zagotovimo jo ob prvi uporabi
  // v submitOrder (edini potrošnik; dogodek = klik, torej po mount efektih).
  const ensureOpId = (): string => {
    if (!opIdRef.current && typeof window !== 'undefined') {
      opIdRef.current = sessionStorage.getItem(`ro_web_op_${token}`) || ''
      if (!opIdRef.current) {
        opIdRef.current = crypto.randomUUID()
        sessionStorage.setItem(`ro_web_op_${token}`, opIdRef.current)
      }
    }
    return opIdRef.current
  }

  // ── ob prvem risanju: obnovi sledenje (preživi osvežitev/zaprtje zavihka) ──
  // (mikrotaska — ne setState sinhrono v telesu efekta; še vedno pred prvim izrisom
  // po mountu, torej brez vidnega zamika)
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(TRACK_KEY(token))
        if (raw) {
          const p = JSON.parse(raw) as TrackT
          if (p && typeof p.n === 'number' && typeof p.k === 'string') setTrack(p)
        }
      } catch { /* pošteno ignoriramo — sledenje je priročnost, ne resnica */ }
    })
  }, [token])

  const loadStore = useCallback(async () => {
    clearPageErr()
    try {
      const res = await fetch(`/api/public/web-portal?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { setPageErr(data?.error, 'web.store.unavailable'); return }
      setStore(data)
      setActiveCat(data.categories?.[0]?.id || '')
      setFulfillment((prev) => (data.deliveryEnabled && !data.pickupEnabled ? 'delivery' : prev))
    } catch {
      setPageErrKey('web.store.unreachable')
    } finally {
      setLoading(false)
    }
  }, [token, clearPageErr, setPageErr, setPageErrKey])

  useEffect(() => {
    // mikrotaska: loadStore sinhrono samo počisti pageErr (setState) — iz telesa
    // efekta ga izmaknemo iz sinhronne poti (obnašanje: fetch starta enako zgodaj)
    queueMicrotask(() => { void loadStore() })
  }, [loadStore])

  // status polling (15 s — priročnost, ne realnočasovni kanal)
  useEffect(() => {
    if (!track) return
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch(`/api/public/web-portal/status?token=${encodeURIComponent(token)}&n=${track.n}&k=${encodeURIComponent(track.k)}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json()
        if (alive && d.status) setTrackStatus(String(d.status))
      } catch { /* tiho — naslednji cikel */ }
    }
    poll()
    const iv = setInterval(poll, 15_000)
    return () => { alive = false; clearInterval(iv) }
  }, [track, token])

  const itemsByCat = useMemo(() => {
    const m = new Map<string, MenuItem[]>()
    for (const it of store?.items || []) {
      const list = m.get(it.categoryId) || []
      list.push(it)
      m.set(it.categoryId, list)
    }
    return m
  }, [store])

  const cartCount = cart.reduce((s, l) => s + l.qty, 0)
  const lineTotal = (l: CartLine) => (l.item.price + l.modifiers.reduce((s, m) => s + m.price, 0)) * l.qty
  const subtotal = cart.reduce((s, l) => s + lineTotal(l), 0)
  const vatTotal = cart.reduce((s, l) => s + vatFromGross(lineTotal(l), l.item.vatRate), 0)
  const fee = fulfillment === 'delivery' && store ? store.deliveryFee : 0
  const grandTotal = subtotal + fee
  const belowMin = !!store && store.minOrder > 0 && subtotal + 1e-9 < store.minOrder
  const closedNow = !!store && store.closedKnown && !store.open

  function openDetail(it: MenuItem) {
    setDetail(it)
    setDetailQty(1)
    setDetailNote('')
    setDetailAllergenWarning('')
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

  function detailModsTotal(): number {
    if (!detail) return 0
    let sum = 0
    for (const g of detail.modifierGroups) {
      for (const mid of detailMods[g.id] || []) {
        const opt = g.options.find((o) => o.id === mid)
        if (opt) sum += opt.price
      }
    }
    return sum
  }

  function addToCart() {
    if (!detail) return
    for (const g of detail.modifierGroups) {
      if (g.required && (detailMods[g.id] || []).length < Math.max(1, g.minSelect)) return
    }
    const mods = detail.modifierGroups.flatMap((g) => (detailMods[g.id] || []).map((mid) => g.options.find((o) => o.id === mid)!).filter(Boolean))
    setCart((prev) => [...prev, { key: `${detail.id}-${Date.now()}`, item: detail, qty: detailQty, note: detailNote.trim(), allergenWarning: detailAllergenWarning.trim(), modifiers: mods }])
    setDetail(null)
  }

  async function submitOrder() {
    if (cart.length === 0 || submitting || closedNow || belowMin) return
    setSubmitting(true)
    clearPageErr()
    try {
      const res = await fetch('/api/public/web-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          clientOperationId: ensureOpId(),
          fulfillment,
          customerName: name.trim(),
          customerPhone: phone.trim(),
          ...(fulfillment === 'delivery' ? { address: address.trim(), city: city.trim(), postCode: postCode.trim(), instructions: instructions.trim() } : {}),
          items: cart.map((l) => ({
            menuItemId: l.item.id,
            qty: l.qty,
            note: l.note || undefined,
            allergenWarning: l.allergenWarning || undefined,
            modifierIds: l.modifiers.map((m) => m.id),
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setPageErr(data?.error, 'web.store.orderFailed'); return }
      const nt: TrackT = { n: data.orderNumber, k: data.track?.k || '' }
      setTrack(nt)
      setTrackStatus(String(data.status || ''))
      try { localStorage.setItem(TRACK_KEY(token), JSON.stringify(nt)) } catch { /* priročnost */ }
      setCart([])
      setCartOpen(false)
      sessionStorage.removeItem(`ro_web_op_${token}`)
      opIdRef.current = ''
      if (typeof data.etaMinutes === 'number') setEta(data.etaMinutes)
    } catch {
      // NE ustvari lažno uspešnega naročila (issue #8 vzorec: jasna napaka)
      setPageErrKey('web.store.notSubmitted')
    } finally {
      setSubmitting(false)
    }
  }

  const etaShown = eta ?? store?.etaMinutes ?? null

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="flex flex-col items-center gap-3 text-stone-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('web.store.loading')}</span>
        </div>
      </div>
    )
  }

  if (pageErr.error && !store) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
        <GuestLanguageToggle variant="light" className="fixed top-3 right-3 z-50" />
        <div className="max-w-sm w-full rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <WifiOff className="h-10 w-10 mx-auto text-stone-400" />
          <h1 className="mt-3 font-semibold text-stone-900">{pageErr.text}</h1>
          <Button className="mt-4 min-h-11 w-full" onClick={loadStore}><RefreshCw className="mr-2 h-4 w-4" />{t('guest.common.retry')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div data-screen="web-store" className="min-h-screen bg-stone-50 pb-28">
      <header data-region="web-store-header" className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3" style={accBorder}>
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2">
            {theme?.logoUrl && <BrandLogo src={theme.logoUrl} />}
            <div className="min-w-0">
            <h1 className="font-bold text-stone-900 leading-tight truncate">{store?.restaurant}</h1>
            <p className="text-xs text-stone-500">
              {closedNow ? t('web.store.closedBadge') : t('web.store.subtitle', { n: etaShown ?? 20 })}
            </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!online && (
              <Badge variant="destructive" className="shrink-0"><WifiOff className="h-3 w-3 mr-1" />{t('guest.common.offline')}</Badge>
            )}
            {closedNow && <Badge variant="secondary" className="shrink-0">{t('web.store.closedBadge')}</Badge>}
            <GuestLanguageToggle variant="light" />
          </div>
        </div>
      </header>

      {/* sledenje obstoječega naročila (preživi osvežitev) */}
      {track && (
        <div data-region="web-store-track" className="max-w-lg mx-auto px-4 pt-4">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-700 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-emerald-900">{t('web.store.trackTitle', { n: track.n })}</p>
                <p className="text-sm text-emerald-800">
                  {trackStatus
                    ? t('web.store.trackStatus', { s: guestStatusKey(trackStatus) ? t(guestStatusKey(trackStatus)!) : trackStatus })
                    : t('web.store.trackHint', { n: etaShown ?? 20 })}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {store?.note && (
        <div className="max-w-lg mx-auto px-4 pt-4" data-region="web-store-note">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{store.note}</div>
        </div>
      )}

      {/* kategorije */}
      <nav data-region="web-store-cats" aria-label={t('web.store.categoriesAria')} className="max-w-lg mx-auto px-4 pt-4">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {store?.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCat(c.id)}
              aria-pressed={activeCat === c.id}
              className={`shrink-0 rounded-full px-4 min-h-11 flex items-center text-sm font-medium transition-colors ${activeCat === c.id ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-700'}`}
              style={activeCat === c.id ? acc : undefined}
            >
              {c.name}
            </button>
          ))}
        </div>
      </nav>

      {/* artikli */}
      <main className="max-w-lg mx-auto px-4 pt-2">
        {(itemsByCat.get(activeCat) || []).map((it) => (
          <div key={it.id} data-region="web-store-item" className="mt-3">
            <button
              type="button"
              onClick={() => it.isAvailable && openDetail(it)}
              disabled={!it.isAvailable}
              className="w-full text-left rounded-2xl border border-stone-200 bg-white p-4 flex items-start justify-between gap-3 disabled:opacity-50 enabled:hover:border-stone-400 transition-colors"
              aria-label={`${it.name}, ${fmt(it.price)}${it.isAvailable ? '' : `, ${t('web.store.soldOut')}`}`}
            >
              <span className="min-w-0">
                <span className="block font-semibold text-stone-900">{it.name}</span>
                {it.description && <span className="block text-sm text-stone-500 mt-0.5 line-clamp-2">{it.description}</span>}
                <span className="block text-sm font-medium text-stone-700 mt-1">{fmt(it.price)}</span>
              </span>
              {it.isAvailable ? (
                <span className="shrink-0 rounded-full bg-stone-900 text-white p-2" aria-hidden="true" style={acc}><Plus className="h-4 w-4" /></span>
              ) : (
                <Badge variant="secondary" className="shrink-0">{t('web.store.soldOut')}</Badge>
              )}
            </button>
          </div>
        ))}
      </main>

      {/* košarica (plavajoči gumb) */}
      {cart.length > 0 && (
        <div className="fixed bottom-4 left-0 right-0 px-4 z-30">
          <div className="max-w-lg mx-auto">
            <Sheet open={cartOpen} onOpenChange={setCartOpen}>
              <SheetTrigger asChild>
                <Button size="lg" className="w-full min-h-12 rounded-full shadow-lg" style={acc} aria-label={t('web.store.cartOpenAria', { n: cartCount })}>
                  <ShoppingCart className="mr-2 h-5 w-5" />
                  {t('web.store.cartButton', { n: cartCount, s: fmt(subtotal) })}
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-[85vh] flex flex-col">
                <SheetHeader>
                  <SheetTitle>{t('web.store.cartTitle')}</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3" data-region="web-store-cart">
                  {cart.map((l) => (
                    <div key={l.key} className="rounded-xl border border-stone-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-stone-900 text-sm">{l.item.name}</span>
                        <button type="button" onClick={() => setCart((p) => p.filter((x) => x.key !== l.key))} className="text-xs text-red-700 min-h-11 px-2" aria-label={t('web.store.removeAria', { s: l.item.name })}>
                          {t('web.store.remove')}
                        </button>
                      </div>
                      {l.modifiers.length > 0 && (
                        <p className="text-xs text-stone-500 mt-0.5">{l.modifiers.map((m) => m.name).join(', ')}</p>
                      )}
                      {l.note && <p className="text-xs text-stone-500 mt-0.5">{l.note}</p>}
                      {l.allergenWarning && <p className="text-xs text-red-700 mt-0.5">{l.allergenWarning}</p>}
                      <div className="flex items-center justify-between mt-2">
                        <span className="flex items-center gap-2">
                          <button type="button" onClick={() => setCart((p) => p.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x)))} className="rounded-full border border-stone-300 p-2" aria-label={t('web.store.qtyMinusAria', { s: l.item.name })}><Minus className="h-3.5 w-3.5" /></button>
                          <span className="w-6 text-center text-sm font-medium" aria-live="polite">{l.qty}</span>
                          <button type="button" onClick={() => setCart((p) => p.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))} className="rounded-full border border-stone-300 p-2" aria-label={t('web.store.qtyPlusAria', { s: l.item.name })}><Plus className="h-3.5 w-3.5" /></button>
                        </span>
                        <span className="text-sm font-semibold">{fmt(lineTotal(l))}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* podatki gosta + način prevzema */}
                <div className="px-4 pb-4 space-y-3 border-t border-stone-200 pt-3" data-region="web-store-checkout">
                  {(store?.pickupEnabled && store?.deliveryEnabled) && (
                    <div role="radiogroup" aria-label={t('web.store.fulfillmentAria')} className="grid grid-cols-2 gap-2">
                      <button type="button" role="radio" aria-checked={fulfillment === 'pickup'} onClick={() => setFulfillment('pickup')} className={`rounded-xl border min-h-11 flex items-center justify-center gap-1.5 text-sm font-medium ${fulfillment === 'pickup' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white text-stone-700'}`} style={fulfillment === 'pickup' ? acc : undefined}>
                        <Store className="h-4 w-4" /> {t('web.store.pickup')}
                      </button>
                      <button type="button" role="radio" aria-checked={fulfillment === 'delivery'} onClick={() => setFulfillment('delivery')} className={`rounded-xl border min-h-11 flex items-center justify-center gap-1.5 text-sm font-medium ${fulfillment === 'delivery' ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white text-stone-700'}`} style={fulfillment === 'delivery' ? acc : undefined}>
                        <Bike className="h-4 w-4" /> {t('web.store.delivery')}
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="ws-name">{t('web.store.name')}</Label>
                      <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="mt-1" autoComplete="name" />
                    </div>
                    <div>
                      <Label htmlFor="ws-phone">{t('web.store.phone')}</Label>
                      <Input id="ws-phone" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} inputMode="tel" className="mt-1" autoComplete="tel" />
                    </div>
                  </div>
                  {fulfillment === 'delivery' && (
                    <div className="space-y-2" data-region="web-store-delivery">
                      <div>
                        <Label htmlFor="ws-address">{t('web.store.address')}</Label>
                        <Input id="ws-address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} className="mt-1" autoComplete="street-address" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label htmlFor="ws-city">{t('web.store.city')}</Label>
                          <Input id="ws-city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} className="mt-1" />
                        </div>
                        <div>
                          <Label htmlFor="ws-zip">{t('web.store.postCode')}</Label>
                          <Input id="ws-zip" value={postCode} onChange={(e) => setPostCode(e.target.value)} maxLength={16} inputMode="numeric" className="mt-1" />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="ws-instr">{t('web.store.instructions')}</Label>
                        <Input id="ws-instr" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={300} className="mt-1" />
                      </div>
                    </div>
                  )}

                  <div className="text-sm space-y-1">
                    <div className="flex justify-between text-stone-600"><span>{t('web.store.subtotal')}</span><span>{fmt(subtotal)}</span></div>
                    {fee > 0 && <div className="flex justify-between text-stone-600"><span>{t('web.store.fee')}</span><span>{fmt(fee)}</span></div>}
                    <div className="flex justify-between font-semibold text-stone-900"><span>{t('web.store.total')}</span><span>{fmt(grandTotal)}</span></div>
                    {store && store.minOrder > 0 && (
                      <p className="text-xs text-stone-500">{belowMin ? t('web.store.minOrderHint', { s: fmt(store.minOrder) }) : t('web.store.minOrderOk', { s: fmt(store.minOrder) })}</p>
                    )}
                  </div>

                  {pageErr.error && <p className="text-sm text-red-700" role="alert">{pageErr.text}</p>}
                  {closedNow && <p className="text-sm text-stone-700" role="alert">{t('web.store.closedNow')}</p>}

                  <Button
                    size="lg"
                    className="w-full min-h-12"
                    style={acc}
                    disabled={submitting || closedNow || belowMin || !name.trim() || !phone.trim() || (fulfillment === 'delivery' && !address.trim())}
                    onClick={submitOrder}
                  >
                    {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Clock className="mr-2 h-5 w-5" />}
                    {t('web.store.submit')}
                  </Button>
                  <p className="text-[11px] text-stone-400 text-center">{t('web.store.payNote')}</p>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      )}

      {/* dialog artikla (opcije + opomba + alergensko opozorilo) */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3" data-region="web-store-item-dialog">
                {detail.description && <p className="text-sm text-stone-500">{detail.description}</p>}
                {detail.modifierGroups.map((g) => (
                  <div key={g.id}>
                    <p className="text-sm font-medium text-stone-800 mb-1">
                      {g.name}{g.required ? ` (${t('web.store.required')})` : ''}
                    </p>
                    <div className="space-y-1.5">
                      {g.options.map((o) => (
                        <label key={o.id} className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 min-h-11 cursor-pointer">
                          <Checkbox
                            checked={(detailMods[g.id] || []).includes(o.id)}
                            onCheckedChange={() => toggleMod(g.id, o.id, g.maxSelect)}
                            aria-label={`${g.name}: ${o.name}`}
                          />
                          <span className="text-sm flex-1">{o.name}</span>
                          <span className="text-sm text-stone-500">{o.price > 0 ? `+${fmt(o.price)}` : ''}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div>
                  <Label htmlFor="ws-note">{t('web.store.itemNote')}</Label>
                  <Input id="ws-note" value={detailNote} onChange={(e) => setDetailNote(e.target.value)} maxLength={200} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="ws-allergen">{t('web.store.allergenWarning')}</Label>
                  <Input id="ws-allergen" value={detailAllergenWarning} onChange={(e) => setDetailAllergenWarning(e.target.value)} maxLength={200} className="mt-1" placeholder={t('web.store.allergenPlaceholder')} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <button type="button" onClick={() => setDetailQty((q) => Math.max(1, q - 1))} className="rounded-full border border-stone-300 p-2.5" aria-label={t('web.store.qtyMinusAria', { s: detail.name })}><Minus className="h-4 w-4" /></button>
                    <span className="w-8 text-center font-medium" aria-live="polite">{detailQty}</span>
                    <button type="button" onClick={() => setDetailQty((q) => q + 1)} className="rounded-full border border-stone-300 p-2.5" aria-label={t('web.store.qtyPlusAria', { s: detail.name })}><Plus className="h-4 w-4" /></button>
                  </span>
                  <Button className="min-h-11" onClick={addToCart}>
                    <Plus className="mr-1 h-4 w-4" /> {t('web.store.addToCart')} · {fmt((detail.price + detailModsTotal()) * detailQty)}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <footer className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-stone-200 py-2 px-4 z-10">
        <p className="max-w-lg mx-auto text-center text-[11px] text-stone-400">
          {t('web.store.footer', { s: store?.restaurant || '' })}
        </p>
      </footer>
    </div>
  )
}
