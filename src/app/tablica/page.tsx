'use client'

/**
 * OPS-4 (v1.67.0) — TABLICA natakarja (PWA, handheld mode).
 *
 * Namenski mobilni vmesnik za natakarja/sanka (PWA namestitev prek manifest +
 * passthrough SW): mize → nova naročila / dodajanje artiklov obstoječemu
 * naročilu → pošlji v pripravo. Plačilo ostane na glavnem POS (gumb "Plačilo
 * na blagajni" pelje v /dashboard?tab=mize, kjer teče kanonični predogled
 * računa + FURS izdaja — ničesar ne podvajamo).
 *
 * v1.84.0: gumb Handheld v glavi vodi na /handheld — enoročni tok s fire +
 * plačilom pri mizi (ta stran ostane hitri način brez obeh).
 *
 * Offline: enaka vrsta kot glavni POS (src/lib/offline-queue) — order.create /
 * order.addItems z idempotentnim clientOperationId, flush prek /api/sync.
 *
 * Varnost: enaka prijava kot dashboard (ro_token); endpoint-i so kanonični
 * (POST /api/orders = orders.create; PATCH /api/orders/[id] addItems =
 * orders.create) — backend uveljavlja dovoljenja neodvisno od tega UI-ja.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getToken, getUser } from '@/lib/client'
import { flushQueue, isNetworkError, newOperationId, tryEnqueueOp } from '@/lib/offline-queue'
import { menuRefreshDue } from '@/lib/poll-plan'
import { tableStatusLabelKey } from '@/lib/table-status'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Loader2, LogOut, Monitor, Search, Smartphone, Utensils, ChevronDown } from 'lucide-react'

interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station: string; note?: string | null; voided?: boolean }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; tableId?: string | null; items: OrderItemT[]; paymentStatus?: string | null }
interface TableT { id: string; name: string; zone: string; status: string; seats: number; locationId?: string | null; activeOrder?: { id: string; total: number } | null }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null; locationId?: string | null }
interface CategoryT { id: string; name: string }

const TAB_COLORS: Record<string, string> = {
  FREE: 'bg-emerald-600 text-white active:bg-emerald-700',
  OCCUPIED: 'bg-amber-600 text-white active:bg-amber-700',
  RESERVED: 'bg-stone-400 text-white active:bg-stone-500',
  DIRTY: 'bg-stone-600 text-white active:bg-stone-700',
}

function TablicaInner() {
  const { t } = useI18n()
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState<{ name?: string; role?: string } | null>(null)
  const [tables, setTables] = useState<TableT[]>([])
  const [orders, setOrders] = useState<OrderT[]>([])
  const [menu, setMenu] = useState<MenuT[]>([])
  const [categories, setCategories] = useState<CategoryT[]>([])
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(false)
  const [openTable, setOpenTable] = useState<TableT | null>(null)
  const [cart, setCart] = useState<Record<string, number>>({})
  const [cat, setCat] = useState('ALL')
  const [search, setSearch] = useState('')
  /* v1.259.0 (§33): VRSTICA NAROČILA — zložljiva, lepljiva sekcija obstoječih
     postavk nad menijem v listku (Lightspeed nov 2026 »Keep active orders visible
     while browsing menus«). Povzetek ostane v pogledu med brskanjem; prehodno
     stanje per obisk, BREZ persist, privzeto ZLOŽENO (enako handheld). */
  const [orderBarOpen, setOrderBarOpen] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (withMenu: boolean) => {
    const [tb, or, mn] = await Promise.all([
      api<{ tables: TableT[] }>('/api/tables'),
      api<{ orders: OrderT[] }>('/api/orders'),
      // v1.164.0 (Neon egress): meni le ob withMenu (vsak 4. cikel); mize/naročila 15 s
      withMenu ? api<{ items: MenuT[]; categories: CategoryT[] }>('/api/menus') : Promise.resolve(null),
    ])
    setTables(tb.tables ?? [])
    setOrders(or.orders ?? [])
    if (mn) {
      setMenu((mn.items ?? []).filter((m) => m.available))
      setCategories(mn.categories ?? [])
    }
  }, [])

  useEffect(() => {
    // QA-val #10 (P2): vrata so od v1.219.0 (issue #90) preverjala SAMO legacy
    // žeton v localStorage (ro_token) — nove prijave ga ne pišejo več (seja živi
    // v httpOnly piškotku ro_session), zato je bila tablica za VSE nove seje
    // nedosegljiva (/* → prijava → avtodetekt → /dashboard zanka). Vrata zdaj
    // spustijo tudi sejo z ro_user (piškotek overi /api/auth/me; api() ob 401
    // preusmeri samo) — enaka disciplina kot dashboard, ki vrata sploh nima.
    if (!getToken() && !getUser()) { router.replace('/'); return }
    let alive = true
    void (async () => {
      try {
        const meRes = await api<{ employee: { name: string; role: string } }>('/api/auth/me')
        if (!alive) return
        setMe(meRes.employee ?? getUser())
        await load(true)
        if (!alive) return
        setReady(true)
      } catch { /* api() ob 401 samo preusmeri */ }
    })()
    // Issue #3 §D (P1): tablica prej NI splaknila vrste (uvozila je SAMO enqueueOp —
    // vrsta je splaknila šele, ko je isti natakar odprl dashboard/handheld v istem
    // brskalniku). Zdaj: flush ob zagonu (ostanki po ponovnem zagonu PWA) + ob dogodku
    // 'online' (zrcalno handheld page.tsx ~137) — offline naročila odidejo, takoj ko je
    // omrežje spet na voljo, iz KATERE KOLI površine.
    void flushQueue().catch(() => null)
    const onOnline = () => { void flushQueue().catch(() => null) }
    window.addEventListener('online', onOnline)
    // v1.164.0 (Neon egress): meni vsak 4. cikel (60 s); mize/naročila ostanejo 15 s
    let tick = 1
    pollRef.current = setInterval(() => {
      void load(menuRefreshDue(tick)).catch(() => null)
      tick += 1
    }, 15000)
    return () => {
      alive = false
      window.removeEventListener('online', onOnline)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [router, load])

  /** naročilo odprte mize (aktivno = tekoče, neplačano ali delno plačano) */
  const openOrder = useMemo(() => {
    if (!openTable?.activeOrder) return null
    return orders.find((o) => o.id === openTable.activeOrder!.id) ?? null
  }, [openTable, orders])

  const items = useMemo(() => menu.filter((m) =>
    (cat === 'ALL' || m.categoryId === cat)
    && m.name.toLowerCase().includes(search.trim().toLowerCase())
  ), [menu, cat, search])

  const cartQty = Object.values(cart).reduce((s, q) => s + q, 0)
  const cartTotal = Object.entries(cart).reduce((s, [id, q]) => s + (menu.find((x) => x.id === id)?.price ?? 0) * q, 0)

  function openSheet(tb: TableT) {
    if (tb.status === 'RESERVED') return
    setNotice(''); setCart({}); setCat('ALL'); setSearch('')
    setOpenTable(tb)
  }

  async function markClean(tb: TableT) {
    try {
      await api(`/api/tables/${tb.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FREE' }) })
      await load(true)
    } catch (err) { setNotice((err as Error).message) }
  }

  function dec(id: string) {
    setCart((p) => { const q = (p[id] || 0) - 1; const nx = { ...p }; if (q <= 0) delete nx[id]; else nx[id] = q; return nx })
  }

  async function submitCreate() {
    if (!openTable) return
    const items = Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
    if (items.length === 0) return
    setSending(true); setNotice('')
    const clientOperationId = newOperationId()
    try {
      // v1.86.2: lokacija iz mize za centralno vlogo brez lokacije (server ignorira za osebje)
      // v1.241.0 (§16 E): autoFire — gumb »Pošlji v pripravo« (tlb.send) končno drži
      // obljubo: postavke grejo takoj v fired + postajne naloge (prej so visele v
      // pending in natakar je moral ročno poslati iz dashboarda).
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: openTable.id, items, guests: 2, clientOperationId, autoFire: true, locationId: openTable.locationId || undefined }) })
      setCart({}); setOpenTable(null); await load(true)
    } catch (err) {
      if (isNetworkError(err)) {
        const rezultat = tryEnqueueOp('order.create', { tableId: openTable.id, items, guests: 2, note: '', autoFire: true, locationId: openTable.locationId || undefined }, clientOperationId)
        if (!rezultat.ok) { setNotice(t('net.queueFull')); return }
        setCart({}); setOpenTable(null); setNotice(t('tlb.queued'))
      } else setNotice((err as Error).message)
    } finally { setSending(false) }
  }

  async function submitAdd() {
    if (!openOrder) return
    const addItems = Object.entries(cart).map(([menuItemId, qty]) => ({ menuItemId, qty }))
    if (addItems.length === 0) return
    setSending(true); setNotice('')
    const clientOperationId = newOperationId()
    try {
      await api(`/api/orders/${openOrder.id}`, { method: 'PATCH', body: JSON.stringify({ addItems }) })
      setCart({}); await load(true)
      setOpenTable(null)
    } catch (err) {
      if (isNetworkError(err)) {
        const rezultat = tryEnqueueOp('order.addItems', { orderId: openOrder.id, addItems }, clientOperationId)
        if (!rezultat.ok) { setNotice(t('net.queueFull')); return }
        setCart({}); setOpenTable(null); setNotice(t('tlb.queuedAdd'))
      } else setNotice((err as Error).message)
    } finally { setSending(false) }
  }

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-700" />
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-stone-50 pb-24">
      {/* header — veliki gumbi za tablico */}
      <header className="sticky top-0 z-20 bg-emerald-700 text-white px-4 py-3 flex items-center gap-2">
        <Utensils className="w-5 h-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-bold leading-tight truncate">{t('tlb.title')}</p>
          <p className="text-xs opacity-90 truncate">{me?.name} · {t('tlb.sub')}</p>
        </div>
        <LanguageToggle />
        <button aria-label={t('tlb.handheld')} onClick={() => router.push('/handheld')} className="p-2 rounded-lg hover:bg-emerald-800"><Smartphone className="w-5 h-5" /></button>
        <button aria-label={t('tlb.fullPos')} onClick={() => router.push('/dashboard')} className="p-2 rounded-lg hover:bg-emerald-800"><Monitor className="w-5 h-5" /></button>
        <button aria-label={t('header.logout')} onClick={() => { /* Issue #90 (QA): piškotek seje pobriše strežnik (httpOnly). */ void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); localStorage.removeItem('ro_token'); localStorage.removeItem('ro_user'); router.replace('/') }} className="p-2 rounded-lg hover:bg-emerald-800"><LogOut className="w-5 h-5" /></button>
      </header>

      {notice && <p className="mx-4 mt-3 text-xs rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 border border-emerald-200">{notice}</p>}

      {/* mize — veliki cilji za palec (≥48px) */}
      <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
        {tables.map((tb) => (
          <div key={tb.id} className="relative">
            <button
              onClick={() => (tb.status === 'DIRTY' && !tb.activeOrder ? void markClean(tb) : openSheet(tb))}
              className={`w-full rounded-2xl p-4 text-left shadow min-h-24 transition ${TAB_COLORS[tb.status] ?? 'bg-stone-500 text-white'}`}
            >
              <p className="font-bold text-lg leading-tight">{tb.name}</p>
              <p className="text-xs opacity-90 mt-0.5">{tb.zone} · {t('tables.seats', { n: tb.seats })}</p>
              {tb.activeOrder && <p className="text-sm font-bold mt-1">{fmtEUR(tb.activeOrder.total)}</p>}
              <p className="text-xs mt-1 opacity-80">
                {/* Issue #70 §1: oznaka IZKLJUČNO iz kanonskega statusa (/api/tables) —
                    enaka preslikava kot handheld (src/lib/table-status) */}
                {t(tableStatusLabelKey(tb.status))}
              </p>
            </button>
          </div>
        ))}
      </div>
      {tables.length === 0 && <p className="p-4 text-sm text-stone-500">{t('tlb.noTables')}</p>}

      {/* list za naročanje — od spodaj (palec doseže vse) */}
      <Sheet open={openTable !== null} onOpenChange={(v) => { if (!v) setOpenTable(null) }}>
        <SheetContent side="bottom" className="h-[88vh] p-0 flex flex-col">
          <SheetHeader className="shrink-0 px-4 pt-4 pb-2 border-b border-stone-200">
            <SheetTitle className="flex items-center gap-2 text-base">
              {openTable?.name}
              {openTable?.activeOrder && <Badge className="bg-amber-600">{fmtEUR(openTable.activeOrder.total)}</Badge>}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {/* v1.259.0 (§33): VRSTICA NAROČILA — obstoječe postavke v zložljivi
                LEPILJIVI sekciji na vrhu drsečega območja listka (Lightspeed nov
                2026 »Keep active orders visible while browsing menus«). Povzetek
                ostane v pogledu med brskanjem menija; razpenjanje razkrije seznam
                nad menijem. Brez statusnih pilul — hiter način te površine
                (status quo). PRAZNO naročilo ostane kot prej, izven plasti.
                FIX (zaključna verifikacija v1.259.0, živo preverjeno na produkciji
                PO deployju): Sheet je višinsko OMEJEN (fixed inset-y-0), zato
                vsebnik RES drsa notranje in lepljivost deluje — a je bila vrstica
                prilepljena 12 px POD zgornjim robom vsebnika, zato je nad
                prilepljeno vrstico PEK 12 px pas z vsebino menija (izmerjeno:
                gumb »Bela Kava…« nad vrstico). Vzrok: odmik lepljive vrstice se
                meri od ROBA VSEBINE drsečega vsebnika — pt-3 obloga vsebnika
                premakne izhodišče za 12 px. -top-3 (top: −12 px) kompenzira
                oblogo → obroba vrstice pristane TOČNO na zgornjem robu vsebnika
                (živo po deployju: flush 138=138, pas izgine). */}
            {openOrder && openOrder.items.filter((it) => !it.voided).length > 0 && (
              <div data-region="tlb-order-bar" className="sticky -top-3 z-10 -mx-4 -mt-3 bg-white/95 backdrop-blur-sm border-b border-stone-200 shadow-sm">
                <button
                  type="button"
                  data-region="tlb-order-bar-toggle"
                  aria-expanded={orderBarOpen}
                  aria-controls="tlb-order-bar-list"
                  aria-label={t('tlb.orderBarAria')}
                  onClick={() => setOrderBarOpen((v) => !v)}
                  className="flex w-full items-center gap-2 min-h-11 px-4 py-1.5 text-left active:bg-stone-50"
                >
                  <span className="text-xs font-semibold uppercase text-stone-500 shrink-0">{t('tlb.currentOrder')} #{openOrder.orderNumber ?? '—'}</span>
                  <span className="text-sm font-bold tabular-nums shrink-0">{t('tlb.orderBar', { n: openOrder.items.filter((it) => !it.voided).length })}</span>
                  <span className="text-sm font-bold tabular-nums ml-auto shrink-0">{fmtEUR(openOrder.total)}</span>
                  <ChevronDown className={`w-5 h-5 shrink-0 text-stone-400 transition-transform ${orderBarOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                {orderBarOpen && (
                  <div id="tlb-order-bar-list" data-region="tlb-order-bar-list" className="max-h-56 overflow-y-auto px-4 pb-2 space-y-1.5">
                    {openOrder.items.filter((it) => !it.voided).map((it) => (
                      <div key={it.id} className="flex items-center justify-between text-sm">
                        <span className="truncate">{it.qty}× {it.name}</span>
                        <span className="text-stone-500 shrink-0 ml-2">{fmtEUR(it.unitPrice * it.qty)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {openOrder && openOrder.items.filter((it) => !it.voided).length === 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-stone-500 uppercase">{t('tlb.currentOrder')} #{openOrder.orderNumber ?? '—'}</p>
                <p className="text-sm text-stone-500">{t('tlb.emptyOrder')}</p>
              </div>
            )}
            {/* izbira postavk */}
            <div className="flex gap-2 items-center">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-stone-400" />
                <Input aria-label={t('sale.search')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sale.search')} className="pl-8" />
              </div>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              <button onClick={() => setCat('ALL')} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border ${cat === 'ALL' ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>{t('sale.allCat')}</button>
              {categories.map((c) => (
                <button key={c.id} onClick={() => setCat(c.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border ${cat === c.id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>{c.name}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {items.map((mi) => (
                <button key={mi.id} onClick={() => setCart((p) => ({ ...p, [mi.id]: (p[mi.id] || 0) + 1 }))}
                  className="rounded-xl border border-stone-200 bg-white p-3 text-left min-h-14 active:border-emerald-600 active:shadow">
                  <p className="text-sm font-medium leading-tight">{mi.name}</p>
                  <p className="text-xs text-stone-500 mt-0.5">{fmtEUR(mi.price)}</p>
                </button>
              ))}
            </div>
            {items.length === 0 && <p className="text-sm text-stone-500">{t('sale.empty')}</p>}
          </div>
          {/* košarica + pošlji — lepljivo dno */}
          <div className="shrink-0 border-t border-stone-200 bg-white p-4 space-y-2">
            {cartQty > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span>{t('tlb.cart', { n: cartQty })}</span>
                <span className="font-bold">{fmtEUR(cartTotal)}</span>
              </div>
            )}
            <Button className="w-full bg-emerald-700 hover:bg-emerald-800 min-h-12 text-base font-bold" disabled={sending || cartQty === 0} onClick={() => void (openOrder ? submitAdd() : submitCreate())}>
              {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : openOrder ? t('tlb.sendAdd') : t('tlb.send')}
            </Button>
            {openOrder && (
              <Button variant="outline" className="w-full min-h-12" onClick={() => { setOpenTable(null); router.push('/dashboard?tab=mize') }}>
                {t('tlb.payAtPos')}
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  )
}

export default function TablicaPage() {
  return (
    <I18nProvider>
      <TablicaInner />
    </I18nProvider>
  )
}
