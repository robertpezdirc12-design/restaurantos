'use client'

/**
 * Issue #3 — QR meni + self-order iz telefona (/m/<qrToken>).
 * Javna gostujoča stran: brez prijave, mobilna, ENOTEN meni (isti DB kot POS).
 * Naročilo gre skozi ISTI kanonični pipeline (createOrderCore) → KDS/Bar → plačilo → račun.
 * Idempotencija: clientOperationId v sessionStorage — refresh NE ustvari dvojnika.
 * i18n (33-b): dvojezičnost SL/HR prek GuestI18nProvider (isti slovar + isti
 * localStorage ključ kot glavna aplikacija; preklop brez reload-a). Imena
 * artikelov/kategorij ostanejo podatki iz baze (niso prevajana).
 */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, ShoppingCart, Plus, Minus, WifiOff, RefreshCw, CheckCircle2, Star } from 'lucide-react'
import { GuestI18nProvider, useGuestT, GuestLanguageToggle, guestStatusKey, useGuestApiError } from '@/components/guest-i18n'
import { parseAllergens, allergenUnion, filterByAllergens } from '@/lib/allergens'
import { vatFromGross } from '@/lib/billing'
import { ALLERGEN_CODES, ALLERGEN_LABELS, allergenLabel, labelToAllergenCode, type AllergenCode, type AllergenLocale } from '@/lib/allergen-catalog'

interface ModifierOption { id: string; name: string; price: number; allergenCodes?: string[] }
interface ModifierGroup { id: string; name: string; required: boolean; minSelect: number; maxSelect: number | null; options: ModifierOption[] }
interface MenuItem { id: string; name: string; description: string; price: number; vatRate: number; isAvailable: boolean; allergens: string; categoryId: string; modifierGroups: ModifierGroup[]; image?: string; allergenCodes?: string[]; allergenCrossContact?: string[]; allergenStatus?: string }
interface MenuPayload { restaurant: string; tableNumber: number | null; categories: { id: string; name: string }[]; items: MenuItem[]; allergenFilterEnabled?: boolean }
interface CartLine { key: string; item: MenuItem; qty: number; note: string; allergenWarning: string; modifiers: ModifierOption[] }

const fmt = (n: number) => `${n.toFixed(2).replace('.', ',')} €`

export default function GuestMenuPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <GuestI18nProvider>
      <GuestMenuInner params={params} />
    </GuestI18nProvider>
  )
}

function GuestMenuInner({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const { t, locale } = useGuestT()
  const [menu, setMenu] = useState<MenuPayload | null>(null)
  const pageErr = useGuestApiError() // issue #2 §C: surov niz → prevod ob izrisu
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [activeCat, setActiveCat] = useState<string>('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [detail, setDetail] = useState<MenuItem | null>(null)
  const [detailQty, setDetailQty] = useState(1)
  const [detailNote, setDetailNote] = useState('')
  // Issue #7 (P1, v1.104.0): izrecno alergensko opozorilo gosta (kuhinja ga VIDIA na KDS/tisku)
  const [detailAllergenWarning, setDetailAllergenWarning] = useState('')
  const [detailMods, setDetailMods] = useState<Record<string, string[]>>({})
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ orderNumber: number; status: string; total: number } | null>(null)
  const [online, setOnline] = useState(true)

  // OPS-9 val 3 (v1.76.0): allergen filter — selected chips EXCLUDE items containing them
  const [selAllergens, setSelAllergens] = useState<string[]>([])
  const allergenFilterOn = menu?.allergenFilterEnabled !== false

  // Mnenje gosta (P1 audit točka 6) — vnos končno ima kam (POST /api/public/feedback)
  const [fbOpen, setFbOpen] = useState(false)
  const [fbOverall, setFbOverall] = useState(0)
  const [fbFood, setFbFood] = useState(0)
  const [fbService, setFbService] = useState(0)
  const [fbAtmos, setFbAtmos] = useState(0)
  const [fbComment, setFbComment] = useState('')
  const [fbName, setFbName] = useState('')
  const [fbSending, setFbSending] = useState(false)
  const [fbDone, setFbDone] = useState(false)
  const fbErr = useGuestApiError()

  // Status naročila, viden gostu — javni API vrne fiksne SL nize; preslikava v i18n ključe
  const statusLabel = useCallback((raw: string) => {
    const k = guestStatusKey(raw)
    return k ? t(k) : raw
  }, [t])

  // Zadnji t v ref-u — loadMenu se NE znova sproži ob preklopu jezika (brez reload-a podatkov)
  const opIdRef = useRef<string>('')
  if (!opIdRef.current && typeof window !== 'undefined') {
    // Isti clientOperationId preživi refresh → idempotenten replay (brez dvojnika)
    opIdRef.current = sessionStorage.getItem(`ro_guest_op_${token}`) || ''
    if (!opIdRef.current) {
      opIdRef.current = crypto.randomUUID()
      sessionStorage.setItem(`ro_guest_op_${token}`, opIdRef.current)
    }
  }

  const loadMenu = useCallback(async () => {
    pageErr.clear()
    try {
      const res = await fetch(`/api/public/menu?qr=${encodeURIComponent(token)}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) { pageErr.set(data?.error, 'guest.menu.unavailable'); return }
      setMenu(data)
      setActiveCat(data.categories?.[0]?.id || '')
    } catch {
      pageErr.setKey('guest.error.unreachableRetry')
    } finally {
      setLoading(false)
    }
  }, [token, pageErr])

  useEffect(() => {
    loadMenu()
    const upd = () => setOnline(navigator.onLine)
    upd()
    window.addEventListener('online', upd)
    window.addEventListener('offline', upd)
    return () => { window.removeEventListener('online', upd); window.removeEventListener('offline', upd) }
  }, [loadMenu])

  /* Issue #9 (v1.119.0) — osveževanje razpoložljivosti (86) brez ponovnega nalaganja:
     lahkotna javna ruta /api/public/menu/availability (isti qr žeton, ETag/304),
     polling vsakih 30 s + takoj, ko zavihek postane spet viden. Samo isAvailable
     se splakne v obstoječi menu (cena/struktura se osvežita ob ponovnem nalaganju);
     strežnik ostaja edini vir resnice. */
  useEffect(() => {
    if (!menu || done) return
    let alive = true
    const refresh = async () => {
      try {
        const res = await fetch(`/api/public/menu/availability?qr=${encodeURIComponent(token)}`, { cache: 'no-store' })
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
  }, [token, menu !== null, done])

  // status polling po oddaji
  useEffect(() => {
    if (!done) return
    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/orders/status?qr=${encodeURIComponent(token)}&orderNumber=${done.orderNumber}`, { cache: 'no-store' })
        if (res.ok) {
          const d = await res.json()
          setDone((p) => (p ? { ...p, status: d.status } : p))
        }
      } catch { /* tiho — naslednji cikel */ }
    }, 5000)
    return () => clearInterval(iv)
  }, [done, token])

  const itemsByCat = useMemo(() => {
    const m = new Map<string, MenuItem[]>()
    for (const it of menu?.items || []) {
      const list = m.get(it.categoryId) || []
      list.push(it)
      m.set(it.categoryId, list)
    }
    return m
  }, [menu])

  // OPS-9 val 3: chip union across ALL menu items (stable across category switches)
  // Issue #7: čipi so zdaj KANONIČNE KODE (enoten SL/HR prikaz prek kataloga);
  // legacy prosto besedilo se preslika (nepreslikljive oznake NE sodelujejo v
  // filtriranju — prikazne ostanejo pod besedilom artikla).
  const gLoc: AllergenLocale = locale === 'hr' ? 'hr' : locale === 'en' ? 'en' : 'sl'
  const gLbl = (code: string) => ((ALLERGEN_CODES as readonly string[]).includes(code) ? allergenLabel(code, gLoc) : code)
  const itemCodes = (it: MenuItem): string[] => {
    const set = new Set<string>(it.allergenCodes || [])
    for (const raw of parseAllergens(it.allergens)) {
      const code = labelToAllergenCode(raw)
      if (code) set.add(code)
    }
    return [...set]
  }
  const allergenChips = useMemo(
    () => (allergenFilterOn ? [...new Set((menu?.items || []).flatMap(itemCodes))] : []),
    [menu, allergenFilterOn, gLoc],
  )
  const visibleItems = useMemo(
    () => {
      if (!allergenFilterOn || selAllergens.length === 0) return itemsByCat.get(activeCat) || []
      const sel = new Set(selAllergens)
      return (itemsByCat.get(activeCat) || []).filter((it) => !itemCodes(it).some((c) => sel.has(c)))
    },
    [itemsByCat, activeCat, selAllergens, allergenFilterOn],
  )

  const toggleAllergen = (code: string) => {
    setSelAllergens((prev) => {
      const has = prev.includes(code)
      return has ? prev.filter((x) => x !== code) : [...prev, code]
    })
  }

  const cartCount = cart.reduce((s, l) => s + l.qty, 0)
  const lineTotal = (l: CartLine) => (l.item.price + l.modifiers.reduce((s, m) => s + m.price, 0)) * l.qty
  const subtotal = cart.reduce((s, l) => s + lineTotal(l), 0)
  const vatTotal = cart.reduce((s, l) => s + vatFromGross(lineTotal(l), l.item.vatRate), 0)

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
    if (cart.length === 0 || submitting) return
    setSubmitting(true)
    pageErr.clear()
    try {
      const res = await fetch('/api/public/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qrToken: token,
          clientOperationId: opIdRef.current,
          customerName: name.trim(),
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
      if (!res.ok) { pageErr.set(data?.error, 'guest.error.orderFailed'); return }
      setDone({ orderNumber: data.orderNumber, status: data.status, total: data.total })
      setCart([])
      setCartOpen(false)
      sessionStorage.removeItem(`ro_guest_op_${token}`)
      opIdRef.current = ''
    } catch {
      // NE ustvari lažno uspešnega naročila (issue #8: jasna napaka)
      pageErr.setKey('guest.error.orderNotSubmittedRetry')
    } finally {
      setSubmitting(false)
    }
  }

  // Mnenje gosta — pošlji prek javnega vnosa (token = edina identifikacija mize)
  async function submitFeedback() {
    if (fbOverall < 1 || fbSending) return
    setFbSending(true)
    fbErr.clear()
    try {
      const res = await fetch('/api/public/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          overallRating: fbOverall,
          foodRating: fbFood,
          serviceRating: fbService,
          atmosphereRating: fbAtmos,
          comment: fbComment.trim() || undefined,
          guestName: fbName.trim() || undefined,
          wouldReturn: fbOverall >= 4,
          wouldRecommend: fbOverall >= 4,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { fbErr.set(data?.error, 'guest.feedback.failed'); return }
      setFbDone(true)
      setFbOpen(false)
    } catch {
      fbErr.setKey('guest.error.feedbackNotSubmitted')
    } finally {
      setFbSending(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="flex flex-col items-center gap-3 text-stone-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-sm">{t('guest.menu.loading')}</span>
        </div>
      </div>
    )
  }

  if (pageErr.error && !menu) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
        <GuestLanguageToggle variant="light" className="fixed top-3 right-3 z-50" />
        <div className="max-w-sm w-full rounded-2xl border border-stone-200 bg-white p-6 text-center shadow-sm">
          <WifiOff className="h-10 w-10 mx-auto text-stone-400" />
          <h1 className="mt-3 font-semibold text-stone-900">{pageErr.text}</h1>
          <Button className="mt-4 w-full" onClick={loadMenu}><RefreshCw className="mr-2 h-4 w-4" />{t('guest.common.retry')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div data-screen="qr-menu" className="min-h-screen bg-stone-50 pb-28">
      <header data-region="qr-menu-header" className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-stone-200 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="font-bold text-stone-900 leading-tight truncate">{menu?.restaurant}</h1>
            <p className="text-xs text-stone-500">
              {menu?.tableNumber != null ? t('guest.menu.tableSelfOrder', { n: menu.tableNumber }) : t('guest.menu.selfOrder')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!online && (
              <Badge variant="destructive" className="shrink-0"><WifiOff className="h-3 w-3 mr-1" />{t('guest.common.offline')}</Badge>
            )}
            <GuestLanguageToggle variant="light" />
          </div>
        </div>
      </header>

      {done && (
        <div className="max-w-lg mx-auto px-4 pt-4">
          <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
            <div className="flex items-center gap-2 text-green-800">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-semibold">{t('guest.menu.orderDone', { n: done.orderNumber })}</span>
            </div>
            <p className="text-sm text-green-700 mt-1">Status: <b>{statusLabel(done.status)}</b> · {t('guest.common.amount')}: <b>{fmt(done.total)}</b> {t('guest.common.payAtCashier')}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => setDone(null)}>{t('guest.menu.newOrder')}</Button>
          </div>
        </div>
      )}

      {/* Mnenje gosta (P1 audit točka 6) — prikazan tudi po oddanem naročilu */}
      <div className="max-w-lg mx-auto px-4 pt-4">
        {fbDone ? (
          <div className="rounded-2xl border border-green-200 bg-green-50 p-4 flex items-center gap-2 text-green-800 text-sm font-medium">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            {t('guest.feedback.thanks')}
          </div>
        ) : (
          <div className="rounded-2xl border border-stone-200 bg-white p-4">
            {!fbOpen ? (
              /* i69 vizualni QA: cilj na dotik je bil le 20px — py-2.5 ga približa 40px (className-only) */
              <button type="button" className="w-full flex items-center justify-between py-2.5 text-sm font-semibold text-stone-800" onClick={() => setFbOpen(true)}>
                <span>{t('guest.feedback.cta')}</span>
                <Star className="h-4 w-4 text-amber-500" />
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-stone-800">{t('guest.feedback.title')}</p>
                {([
                  [t('guest.feedback.overall'), fbOverall, setFbOverall],
                  [t('guest.feedback.food'), fbFood, setFbFood],
                  [t('guest.feedback.service'), fbService, setFbService],
                  [t('guest.feedback.atmosphere'), fbAtmos, setFbAtmos],
                ] as const).map(([label, val, set]) => (
                  <div key={label} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-stone-600">{label}</span>
                    <span className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} type="button" aria-label={t('guest.feedback.starAria', { label, n })} onClick={() => set(n)} className="p-0.5">
                          <Star className={`h-5 w-5 ${n <= val ? 'fill-amber-400 text-amber-400' : 'text-stone-300'}`} />
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                <textarea
                  value={fbComment}
                  onChange={(e) => setFbComment(e.target.value)}
                  placeholder={t('guest.feedback.commentPlaceholder')}
                  maxLength={1000}
                  rows={3}
                  className="w-full rounded-xl border border-stone-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
                />
                <Input value={fbName} onChange={(e) => setFbName(e.target.value)} placeholder={t('guest.common.nameOptional')} maxLength={80} />
                {fbErr.error && <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm p-3">{fbErr.text}</div>}
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => { setFbOpen(false); fbErr.clear() }}>{t('guest.common.close')}</Button>
                  <Button className="flex-1" onClick={submitFeedback} disabled={fbOverall < 1 || fbSending}>
                    {fbSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {fbSending ? t('guest.common.sending') : t('guest.feedback.submit')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {pageErr.error && menu && (
        <div className="max-w-lg mx-auto px-4 pt-4">
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm p-3">{pageErr.text}</div>
        </div>
      )}

      <nav data-region="qr-menu-categories" className="sticky top-[70px] z-10 bg-stone-50 border-b border-stone-200">
        <div className="max-w-lg mx-auto flex gap-2 overflow-x-auto px-4 py-2 no-scrollbar">
          {menu?.categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCat(c.id)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${activeCat === c.id ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-700'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </nav>

      <main data-region="qr-menu-content" className="max-w-lg mx-auto px-4 py-4 space-y-3">
        {/* OPS-9 val 3 (v1.76.0): allergen filter chips (gate: RestaurantSettings.allergenFilterEnabled)
            Selected chip = HIDE items containing that allergen (client-side exclusion). */}
        {allergenFilterOn && allergenChips.length > 0 && (
          <section aria-label={t('guest.menu.allergenFilter')} className="rounded-2xl bg-white border border-stone-200 p-3">
            <p className="text-xs font-semibold text-stone-500 mb-2">{t('guest.menu.allergenFilter')}</p>
            <div className="flex flex-wrap gap-2">
              {allergenChips.map((label) => {
                const on = selAllergens.includes(label)
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleAllergen(label)}
                    className={`min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors ${on ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-200 bg-white text-stone-700'}`}
                  >
                    {gLbl(label)}
                  </button>
                )
              })}
              {selAllergens.length > 0 && (
                <button type="button" onClick={() => setSelAllergens([])} className="min-h-11 rounded-full px-3 text-sm text-stone-500 underline underline-offset-2">
                  {t('guest.menu.allergenClear')}
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-stone-400">{t('guest.menu.allergenFilterHint')}</p>
          </section>
        )}
        {visibleItems.map((it) => (
          <button
            key={it.id}
            onClick={() => it.isAvailable && openDetail(it)}
            disabled={!it.isAvailable}
            className={`w-full text-left rounded-2xl bg-white border border-stone-200 p-4 shadow-sm ${it.isAvailable ? 'active:scale-[0.99] transition-transform' : 'opacity-50 cursor-not-allowed'}`}
          >
            <div className="flex justify-between gap-3">
              {/* OPS-11 val 1: menu item thumbnails (80×80 left of the text, lazy, onError hide).
                  Items without an image render exactly as before; allergen labels (OPS-9) stay in the text column. */}
              {it.image && (
                <img
                  src={it.image}
                  alt={it.name}
                  loading="lazy"
                  className="h-20 w-20 rounded-2xl object-cover shrink-0 bg-stone-200"
                  onError={(e) => { e.currentTarget.style.display = 'none' }}
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-stone-900">{it.name}</p>
                {it.description && <p className="text-sm text-stone-500 line-clamp-2 mt-0.5">{it.description}</p>}
                {/* Issue #7: kanonične kode (enoten SL/HR prikaz) + status — nikoli lažno "brez alergenov" */}
                {itemCodes(it).length > 0 && (
                  <p className="text-xs text-stone-400 mt-1">{t('guest.menu.allergens', { allergens: itemCodes(it).map(gLbl).join(', ') })}</p>
                )}
                {(it.allergenCrossContact ?? []).length > 0 && (
                  <p className="text-[11px] text-amber-700 mt-0.5">{t('guest.menu.allergenMayContain', { allergens: (it.allergenCrossContact ?? []).map(gLbl).join(', ') })}</p>
                )}
                {it.allergenStatus && it.allergenStatus !== 'confirmed' && (
                  <p className="text-[11px] text-stone-500 mt-0.5">⚠ {it.allergenStatus === 'review_required' ? t('guest.menu.allergenReview') : t('guest.menu.allergenConfirmNeeded')}</p>
                )}
                {itemCodes(it).length === 0 && it.allergenStatus === 'confirmed' && (
                  <p className="text-xs text-stone-400 mt-1">{t('guest.menu.allergenNoneKnown')}</p>
                )}
                {!it.isAvailable && <p className="text-xs text-red-500 mt-1 font-medium">{t('guest.common.unavailableNow')}</p>}
              </div>
              <span className="shrink-0 font-bold text-stone-900">{fmt(it.price)}</span>
            </div>
          </button>
        ))}
        {(itemsByCat.get(activeCat) || []).length === 0 && (
          <p className="text-center text-stone-400 text-sm py-10">{t('guest.menu.emptyCategory')}</p>
        )}
        {allergenFilterOn && selAllergens.length > 0 && (itemsByCat.get(activeCat) || []).length > 0 && visibleItems.length === 0 && (
          <p className="text-center text-stone-400 text-sm py-10">{t('guest.menu.allergenNoneLeft')}</p>
        )}
        <p className="text-center text-[11px] text-stone-400 pt-4">
          {t('guest.menu.vatNote')}
        </p>
      </main>

      {/* Drsna košarica (fiksna na dnu) */}
      <div className="fixed bottom-0 inset-x-0 z-30 p-3 bg-gradient-to-t from-stone-50 via-stone-50 to-transparent">
        <div className="max-w-lg mx-auto">
          <Sheet open={cartOpen} onOpenChange={setCartOpen}>
            <SheetTrigger asChild>
              <Button size="lg" className="w-full h-14 rounded-2xl text-base shadow-lg" disabled={cartCount === 0}>
                <ShoppingCart className="mr-2 h-5 w-5" />
                {t('guest.cart.button')} · {cartCount} {cartCount === 1 ? t('guest.cart.itemOne') : t('guest.cart.itemMany')} · {fmt(subtotal)}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="h-[85vh] rounded-t-3xl p-0 flex flex-col">
              <SheetHeader className="px-4 pt-4 pb-2 border-b border-stone-100">
                <SheetTitle>{t('guest.cart.title')}</SheetTitle>
              </SheetHeader>
              {/* Naloga #8: v stolpčnem flex staršu ima flex-1 otrok min-height:auto,
                  ki raztegne seznam čez 85vh — brez min-h-0 ni notranjega pomika in
                  plačilni gumb izgine pod dnom (audit: 27 postavk = 1093 px). */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {cart.map((l) => (
                  <div key={l.key} className="rounded-xl border border-stone-200 p-3">
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-stone-900">{l.item.name}</p>
                        {l.modifiers.length > 0 && (
                          <p className="text-xs text-stone-500">+ {l.modifiers.map((m) => m.name).join(', ')}</p>
                        )}
                        {l.note && <p className="text-xs text-stone-400 italic">{l.note}</p>}
                        {l.allergenWarning && <p className="text-xs text-red-700 font-medium">⚠ {l.allergenWarning}</p>}
                      </div>
                      <span className="font-semibold shrink-0">{fmt(lineTotal(l))}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCart((p) => l.qty > 1 ? p.map((x) => x.key === l.key ? { ...x, qty: x.qty - 1 } : x) : p.filter((x) => x.key !== l.key))}>
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="text-sm font-semibold w-6 text-center">{l.qty}</span>
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setCart((p) => p.map((x) => x.key === l.key ? { ...x, qty: x.qty + 1 } : x))}>
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="rounded-xl bg-stone-100 p-3 text-sm space-y-1">
                  <div className="flex justify-between"><span>{t('guest.cart.vatExcl')}</span><span>{fmt(subtotal - vatTotal)}</span></div>
                  <div className="flex justify-between"><span>{t('guest.common.vat')}</span><span>{fmt(vatTotal)}</span></div>
                  <div className="flex justify-between font-bold text-base pt-1 border-t border-stone-200"><span>{t('guest.common.total')}</span><span>{fmt(subtotal)}</span></div>
                </div>
                <div>
                  <label className="text-xs font-medium text-stone-500">{t('guest.common.nameOptional')}</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('guest.cart.nameHint')} maxLength={80} />
                </div>
                {pageErr.error && <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm p-3">{pageErr.text}</div>}
              </div>
              <div className="shrink-0 p-4 border-t border-stone-100">
                <Button size="lg" className="w-full h-14 rounded-2xl text-base" onClick={submitOrder} disabled={submitting || cart.length === 0}>
                  {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                  {submitting ? t('guest.common.submitting') : `${t('guest.cart.submit')} · ${fmt(subtotal)}`}
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Artikel + opcije */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.name}</DialogTitle>
                {detail.description && <p className="text-sm text-stone-500">{detail.description}</p>}
                {/* Issue #7: kanonične kode + "lahko vsebuje" + status + alergeni dodatkov */}
                {itemCodes(detail).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-xs font-medium text-stone-500">{t('guest.menu.allergenFilter')}:</span>
                    {itemCodes(detail).map((code) => (
                      <Badge key={code} variant="outline" className="text-[11px] border-stone-300 text-stone-600">{gLbl(code)}</Badge>
                    ))}
                  </div>
                )}
                {(detail.allergenCrossContact ?? []).length > 0 && (
                  <p className="text-[11px] text-amber-700">⚠ {t('guest.menu.allergenMayContain', { allergens: (detail.allergenCrossContact ?? []).map(gLbl).join(', ') })}</p>
                )}
                {detail.allergenStatus && detail.allergenStatus !== 'confirmed' && (
                  <p className="text-[11px] text-stone-500">⚠ {detail.allergenStatus === 'review_required' ? t('guest.menu.allergenReview') : t('guest.menu.allergenConfirmNeeded')}</p>
                )}
                {(() => {
                  const modCodes = [...new Set(detail.modifierGroups.flatMap((g) => (g.options ?? []).flatMap((o) => o.allergenCodes || [])))]
                  return modCodes.length > 0 ? (
                    <p className="text-[11px] text-stone-500">{t('guest.menu.allergenModifier', { allergens: modCodes.map(gLbl).join(', ') })}</p>
                  ) : null
                })()}
              </DialogHeader>
              <div className="space-y-4">
                {detail.modifierGroups.map((g) => (
                  <div key={g.id}>
                    <p className="text-sm font-semibold mb-2">
                      {g.name} {g.required ? <span className="text-red-500">*</span> : <span className="text-stone-400 font-normal">({t('guest.common.optional')})</span>}
                    </p>
                    <div className="space-y-2">
                      {g.options.map((o) => (
                        <label key={o.id} className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2.5 cursor-pointer has-[:checked]:border-stone-900">
                          <span className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={(detailMods[g.id] || []).includes(o.id)}
                              onCheckedChange={() => toggleMod(g.id, o.id, g.maxSelect)}
                            />
                            {o.name}
                          </span>
                          <span className="text-sm text-stone-500">{o.price > 0 ? `+${fmt(o.price)}` : t('guest.common.noSurcharge')}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div>
                  <label className="text-xs font-medium text-stone-500">{t('guest.common.noteKitchen')}</label>
                  <Input value={detailNote} onChange={(e) => setDetailNote(e.target.value)} placeholder={t('guest.menu.notePlaceholder')} maxLength={200} />
                </div>
                {/* Issue #7: izrecno alergensko opozorilo — preide na postavko naročila (KDS + tisk) */}
                <div>
                  <label className="text-xs font-medium text-red-700">⚠ {t('guest.order.allergenWarningLabel')}</label>
                  <Input value={detailAllergenWarning} onChange={(e) => setDetailAllergenWarning(e.target.value)} placeholder={t('guest.order.allergenWarningPlaceholder')} maxLength={200} className="border-red-200 focus-visible:ring-red-300" />
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="icon" onClick={() => setDetailQty((q) => Math.max(1, q - 1))}><Minus className="h-4 w-4" /></Button>
                  <span className="font-bold text-lg w-8 text-center">{detailQty}</span>
                  <Button variant="outline" size="icon" onClick={() => setDetailQty((q) => Math.min(30, q + 1))}><Plus className="h-4 w-4" /></Button>
                  <Button className="flex-1 ml-auto" onClick={addToCart}>
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
