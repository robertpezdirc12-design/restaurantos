'use client'

/**
 * v1.84.0 — P0-1 iz TRZNA-VRZELI-2026 — HANDHELD: enoročni PWA tok natakarja.
 * (Mize → naroči → POŠLJI V KUHINJO → plačaj pri mizi) — pariteta z Toast/Lightspeed
 * tableside, #1 prodajni argument vrstnih POS sistemov (gl. docs/TRZNA-VRZELI-2026.md §3 vrstica 1).
 *
 * Oblikovno za ENO ROKO: vsi primarni CTA v lepljivem dnu (cona palca), cilji ≥48px
 * (min-h-16 artikli, min-h-12 CTA), velike pisave, minimalen chrome, mreža 2 stolpcev.
 *
 * Backend: 100 % kanonični obstoječi endpoint-i (nič nove strežniške logike):
 *  - GET  /api/tables /api/orders /api/menus (15 s polling, enako kot /tablica)
 *  - POST /api/orders { tableId, items, guests, clientOperationId } (orders.create)
 *  - PATCH /api/orders/[id] { addItems } (orders.create)
 *  - POST /api/orders/[id]/fire (orders.create) — NOVO glede na /tablica
 *  - GET  /api/orders/[id]/bill (orders.pay) — NOVO: kanonični predogled računa
 *  - POST /api/furs { orderId, type, tip?, terminal? } (orders.pay) — NOVO: plačilo
 *    pri mizi s fiskalizacijo; po uspehu strežnik samodejno: plačano + miza → DIRTY
 *  - POST /api/orders/[id]/paylink (orders.pay) — NOVO v1.85.0: javna plačilna
 *    povezava (P0-2) — QR pokažeš gostu, ta plača na svojem telefonu (/pay)
 * Offline: order.create / order.addItems v vrsti (src/lib/offline-queue, enako kot
 * tablica/dashboard); fire in plačilo ZAVESNO nista v vrsti (kuhinja je realnočasovna
 * akcija, plačila se po domeni nikoli ne čakajo) → ob izpadu jasno obvestilo.
 * 86 artikli: prikazani sivo/prečrtano z Badge "Razprodano" + onemogočeni (v1.83.0
 * konvencija — strežnik ostaja avtoritativen prek menu.availability).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { api, fmtEUR, getToken, getUser } from '@/lib/client'
import { flushQueue, isNetworkError, newOperationId, subscribeQueue, tryEnqueueOp } from '@/lib/offline-queue'
import { menuRefreshDue } from '@/lib/poll-plan'
import { processTerminalPayment } from '@/lib/devices/terminal'
import { tableStatusLabelKey } from '@/lib/table-status'
import { I18nProvider, LanguageToggle, useI18n } from '@/components/i18n'
import { ManagerCallButton } from '@/components/manager-call-dialog'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Loader2, LogOut, ChevronLeft, ChevronDown, Smartphone, Search, CheckCircle2, MessageSquare, Monitor, ArrowUpRight, QrCode, Users} from 'lucide-react'

interface OrderItemT { id: string; name: string; qty: number; unitPrice: number; status: string; station?: string; note?: string | null; voided?: boolean }
interface OrderT { id: string; orderNumber?: number | null; type: string; status: string; guests: number; total: number; createdAt: string; tableId?: string | null; items: OrderItemT[]; paymentStatus?: string | null }
interface TableT { id: string; name: string; zone: string; status: string; seats: number; number?: number; locationId?: string | null; activeOrder?: { id: string; total: number } | null }
interface MenuT { id: string; name: string; price: number; station: string; available: boolean; categoryId?: string | null; locationId?: string | null }
interface CategoryT { id: string; name: string }
interface BillT { subtotal: number; tax: number; grossTotal: number; discountTotal: number; totalDue: number; autoDiscounts?: { name: string; amount: number }[] }

type View = 'tables' | 'order' | 'bill' | 'paid'
type PayMethod = 'cash' | 'card' | 'mobile'

const TAB_COLORS: Record<string, string> = {
  FREE: 'bg-emerald-600 text-white active:bg-emerald-700',
  OCCUPIED: 'bg-amber-600 text-white active:bg-amber-700',
  RESERVED: 'bg-stone-400 text-white active:bg-stone-500',
  DIRTY: 'bg-stone-600 text-white active:bg-stone-700',
}

/** barvne oznake statusa postavke (UI preslikava: PENDING/PREPARING/READY/SERVED) */
const ITEM_STATUS_BADGE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800 border-amber-300',
  PREPARING: 'bg-orange-100 text-orange-800 border-orange-300',
  READY: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  SERVED: 'bg-stone-100 text-stone-600 border-stone-300',
}

const r2v = (v: number) => Math.round(v * 100) / 100

/* v1.234.0 (Toast/Square): barvni LEVI ROB kategorije na ploščici artikla —
   ista 8-barvna paleta in deterministični hash kot kompaktni grid POS v
   dashboardu (barva = kategorija, nikoli fotografija). Fotografije kategorij
   so ODSTRANJENE: vse ploščice ene kategorije so kazale isto sliko, ki ni
   odražala artikla — zavajujoča slika je hujša od brez nje (lastnikova
   odločitev po produkciji). */
const SALE_CAT_BORDER = [
  'border-l-emerald-600', 'border-l-amber-500', 'border-l-orange-600', 'border-l-rose-500',
  'border-l-violet-500', 'border-l-teal-600', 'border-l-lime-600', 'border-l-yellow-500',
] as const
const saleCatBorderCls = (key: string): string => {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 9973
  return SALE_CAT_BORDER[h % SALE_CAT_BORDER.length]
}

/** navigator.onLine je zunanji vir (useSyncExternalStore): naročnik na dogodka
 *  'online'/'offline'; getServerSnapshot = true = prejšnje začetno stanje, tako
 *  da sta izris SSR in prva hidracija nespremenjena. */
function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function HandheldInner() {
  const { t } = useI18n()
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState<{ name?: string; role?: string } | null>(null)
  const [tables, setTables] = useState<TableT[]>([])
  const [orders, setOrders] = useState<OrderT[]>([])
  const [menu, setMenu] = useState<MenuT[]>([])
  const [categories, setCategories] = useState<CategoryT[]>([])
  const [notice, setNotice] = useState('')

  const [view, setView] = useState<View>('tables')
  const [selTableId, setSelTableId] = useState<string | null>(null)
  const [guests, setGuests] = useState(2)
  const [cart, setCart] = useState<Record<string, number>>({})
  // N-27-1 (v1.195.0): aktivni sedež pri naročanju — postavke, dodane medtem, ko
  // je sedež aktiven, ga nosijo (Square vzorec: sedež izbereš ŽE pri naročanju,
  // ne samo v plačilnem dialogu). null = brez sedeža (obstoječe obnašanje).
  const [activeSeat, setActiveSeat] = useState<number | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  // Issue #7 (P1, v1.104.0): izrecno alergensko opozorilo na postavki (gost prijavi alergijo)
  const [allergenNotes, setAllergenNotes] = useState<Record<string, string>>({})
  const [noteOpen, setNoteOpen] = useState<string | null>(null)
  /* v1.259.0 (§33): VRSTICA NAROČILA — zložljiva, LEPILJIVA sekcija obstoječih
     postavk nad menijem (Lightspeed nov 2026 »Keep active orders visible while
     browsing menus« — slide-out menu layer). Med brskanjem menija povzetek
     naročila OSTANE v pogledu (prej: seznam je odpadel iz pogleda pri drsanju).
     Prehodno stanje per obisk (enako noteOpen) — BREZ persist. Privzeto ZLOŽENO. */
  const [orderBarOpen, setOrderBarOpen] = useState(false)
  const [cat, setCat] = useState('ALL')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'FREE' | 'OCCUPIED' | 'DIRTY'>('ALL')

  const [bill, setBill] = useState<BillT | null>(null)
  const [payMethod, setPayMethod] = useState<PayMethod>('cash')
  const [tipPct, setTipPct] = useState(0)
  const [tipCustom, setTipCustom] = useState('')
  const [paidInfo, setPaidInfo] = useState<{ invoiceNumber: string | null; eor: string | null; total: number; tip: number } | null>(null)

  const [sending, setSending] = useState(false)
  const [firing, setFiring] = useState(false)
  const [paying, setPaying] = useState(false)
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const [queueN, setQueueN] = useState(0)
  // P0-2 (v1.85.0): plačilna povezava (QR položnica) iz pogleda RAČUN
  interface PlinkRow { id: string; url: string; qrDataUrl: string; amount: number | null; splitIndex: number; splitCount: number; sms: { sent: boolean; detail: string } | null }
  const [plinks, setPlinks] = useState<PlinkRow[] | null>(null)
  const [plinkPhone, setPlinkPhone] = useState('')
  const [plinkSplit, setPlinkSplit] = useState(1)
  const [plinkPhones, setPlinkPhones] = useState<Record<string, string>>({})
  const [plinkBusy, setPlinkBusy] = useState(false)
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
      setMenu(mn.items ?? [])
      setCategories(mn.categories ?? [])
    }
  }, [])

  useEffect(() => {
    // QA-val #10 (P2): vrata so od v1.219.0 (issue #90) preverjala SAMO legacy
    // žeton v localStorage (ro_token) — nove prijave ga ne pišejo več (seja živi
    // v httpOnly piškotku ro_session), zato je bil handheld za VSE nove seje
    // nedosegljiva (→/ → avtodetekt → /dashboard zanka). Vrata zdaj spustijo
    // tudi sejo z ro_user (piškotek overi /api/auth/me; api() ob 401 preusmeri
    // samo) — enaka disciplina kot dashboard, ki vrata sploh nima.
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
    // v1.164.0 (Neon egress): meni vsak 4. cikel (60 s); mize/naročila ostanejo 15 s
    let tick = 1
    pollRef.current = setInterval(() => {
      void load(menuRefreshDue(tick)).catch(() => null)
      tick += 1
    }, 15000)
    // Issue #3 §D (P1): flush tudi ob ZAGONU (ne samo ob 'online' dogodku) —
    // natakar po prekinitvi omrežja ponovno odpre PWA, ko je omrežje ŽE nazaj
    // (dogodka 'online' ni bilo, ker je bil ob odprtju že online) — vrsta
    // bi sicer čakala do naslednje spremembe omrežja.
    void flushQueue().catch(() => null)
    const onOnline = () => {
      void flushQueue().catch(() => null)
      void load(true).catch(() => null)
    }
    window.addEventListener('online', onOnline)
    const unsub = subscribeQueue((ops) => setQueueN(ops.length))
    return () => {
      alive = false
      if (pollRef.current) clearInterval(pollRef.current)
      window.removeEventListener('online', onOnline)
      unsub()
    }
  }, [router, load])

  /** izbrana miza — vedno iz svežih podatkov (po osvežitvi se activeOrder samodejno prikaže) */
  const selTable = useMemo(() => tables.find((tb) => tb.id === selTableId) ?? null, [tables, selTableId])
  const openOrder = useMemo(() => {
    if (!selTable?.activeOrder) return null
    return orders.find((o) => o.id === selTable.activeOrder!.id) ?? null
  }, [selTable, orders])
  const activeItems = useMemo(() => (openOrder ? openOrder.items.filter((it) => !it.voided) : []), [openOrder])
  const pendingCount = useMemo(() => activeItems.filter((it) => it.status === 'PENDING').length, [activeItems])
  /* v1.259.0 (§33): faze za POVZETEK vrstice naročila — najbolj relevantna
     odgovori na vprašanje natakarja med brskanjem: »se mi že kuha?«
     (priprava, amber) oz. »je že pripravljeno?« (emerald). */
  const prepCount = useMemo(() => activeItems.filter((it) => it.status === 'PREPARING').length, [activeItems])
  const readyCount = useMemo(() => activeItems.filter((it) => it.status === 'READY').length, [activeItems])

  /** mize → koliko postavk še NI poslanih v kuhinjo (varnostna mreža Toast-style) */
  const pendingByOrder = useMemo(() => {
    const m: Record<string, number> = {}
    for (const o of orders) m[o.id] = o.items.filter((it) => !it.voided && it.status === 'PENDING').length
    return m
  }, [orders])

  const items = useMemo(() => menu.filter((m) =>
    (cat === 'ALL' || m.categoryId === cat)
    && m.name.toLowerCase().includes(search.trim().toLowerCase())
  ), [menu, cat, search])

  const cartQty = Object.values(cart).reduce((s, q) => s + q, 0)
  const cartTotal = Object.entries(cart).reduce((s, [id, q]) => s + (menu.find((x) => x.id === id)?.price ?? 0) * q, 0)

  const filteredTables = useMemo(() => {
    if (filter === 'ALL') return tables
    return tables.filter((tb) => tb.status === filter)
  }, [tables, filter])

  const tipEur = useMemo(() => {
    if (!bill) return 0
    const c = tipCustom.trim().replace(',', '.')
    if (c) {
      const n = Number(c)
      return Number.isFinite(n) && n > 0 ? r2v(n) : 0
    }
    return tipPct > 0 ? r2v(bill.totalDue * tipPct / 100) : 0
  }, [bill, tipPct, tipCustom])
  const payTotal = bill ? r2v(bill.totalDue + tipEur) : 0

  function tapTable(tb: TableT) {
    if (tb.status === 'RESERVED') return
    if (tb.status === 'DIRTY' && !tb.activeOrder) { void markClean(tb); return }
    setNotice(''); setCart({}); setNotes({}); setNoteOpen(null); setCat('ALL'); setSearch('')
    setGuests(2); setBill(null); setPaidInfo(null); setTipPct(0); setTipCustom(''); setPayMethod('cash')
    setActiveSeat(null) // N-27-1: aktivni sedež se resetira pri izbiri mize
    setSelTableId(tb.id)
    setView('order')
  }

  async function markClean(tb: TableT) {
    try {
      await api(`/api/tables/${tb.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FREE' }) })
      await load(true)
      if (view === 'paid') { setView('tables'); setSelTableId(null) }
    } catch (err) { setNotice((err as Error).message) }
  }

  function dec(id: string) {
    setCart((p) => { const q = (p[id] || 0) - 1; const nx = { ...p }; if (q <= 0) { delete nx[id]; if (noteOpen === id) setNoteOpen(null) } else nx[id] = q; return nx })
  }
  function inc(id: string) {
    setCart((p) => ({ ...p, [id]: (p[id] || 0) + 1 }))
  }

  async function submitCreate() {
    if (!selTable || cartQty === 0 || sending) return
    const itemsPayload = Object.entries(cart).map(([menuItemId, qty]) => ({
      menuItemId, qty,
      ...(notes[menuItemId]?.trim() ? { note: notes[menuItemId].trim() } : {}),
      ...(allergenNotes[menuItemId]?.trim() ? { allergenWarning: allergenNotes[menuItemId].trim().slice(0, 200) } : {}),
      ...(activeSeat != null ? { seat: activeSeat } : {}),
    }))
    setSending(true); setNotice('')
    const clientOperationId = newOperationId()
    try {
      // v1.86.2: centralna vloga brez lokacije (ADMIN loc=null) pošlje lokacijo IZ MIZE —
      // requireUserLocation jo sprejme; osebje s lokacijo je strežnik ignorira (user.loc zmaga)
      await api('/api/orders', { method: 'POST', body: JSON.stringify({ tableId: selTable.id, items: itemsPayload, guests, clientOperationId, locationId: selTable.locationId || undefined }) })
      setCart({}); setNotes({}); setAllergenNotes({}); setNoteOpen(null)
      await load(true)
    } catch (err) {
      if (isNetworkError(err)) {
        const rezultat = tryEnqueueOp('order.create', { tableId: selTable.id, items: itemsPayload, guests, note: '', locationId: selTable.locationId || undefined }, clientOperationId)
        if (!rezultat.ok) { setNotice(t('net.queueFull')); return }
        setCart({}); setNotes({}); setAllergenNotes({}); setNoteOpen(null); setView('tables'); setSelTableId(null)
        setNotice(t('tlb.queued'))
      } else setNotice((err as Error).message)
    } finally { setSending(false) }
  }

  async function submitAdd() {
    if (!openOrder || cartQty === 0 || sending) return
    const addItems = Object.entries(cart).map(([menuItemId, qty]) => ({
      menuItemId, qty,
      ...(notes[menuItemId]?.trim() ? { note: notes[menuItemId].trim() } : {}),
      ...(allergenNotes[menuItemId]?.trim() ? { allergenWarning: allergenNotes[menuItemId].trim().slice(0, 200) } : {}),
      ...(activeSeat != null ? { seat: activeSeat } : {}),
    }))
    setSending(true); setNotice('')
    const clientOperationId = newOperationId()
    try {
      await api(`/api/orders/${openOrder.id}`, { method: 'PATCH', body: JSON.stringify({ addItems, clientOperationId }) })
      setCart({}); setNotes({}); setNoteOpen(null)
      await load(true)
    } catch (err) {
      if (isNetworkError(err)) {
        const rezultat = tryEnqueueOp('order.addItems', { orderId: openOrder.id, addItems }, clientOperationId)
        if (!rezultat.ok) { setNotice(t('net.queueFull')); return }
        setCart({}); setNotes({}); setNoteOpen(null); setView('tables'); setSelTableId(null)
        setNotice(t('tlb.queuedAdd'))
      } else setNotice((err as Error).message)
    } finally { setSending(false) }
  }

  async function fireOrder() {
    if (!openOrder || firing) return
    if (!online) { setNotice(t('hh.fireNeedsNet')); return }
    setFiring(true); setNotice('')
    try {
      const d = await api<{ firedCount: number; alreadyFired: boolean }>(`/api/orders/${openOrder.id}/fire`, { method: 'POST', body: JSON.stringify({}) })
      setNotice(d.alreadyFired ? t('hh.noPending') : t('hh.firedOk', { n: d.firedCount }))
      await load(true)
    } catch (err) { setNotice((err as Error).message) } finally { setFiring(false) }
  }

  async function goBill() {
    if (!openOrder) return
    if (!online) { setNotice(t('hh.payNeedsNet')); return }
    setNotice('')
    try {
      const b = await api<{ bill: BillT }>(`/api/orders/${openOrder.id}/bill`)
      setBill(b.bill)
      setTipPct(0); setTipCustom(''); setPayMethod('cash'); setPlinks(null); setPlinkSplit(1)
      setView('bill')
    } catch (err) {
      setNotice((err as Error).message)
      await load(true).catch(() => null)
    }
  }

  async function pay() {
    if (!openOrder || !bill || paying) return
    if (!online) { setNotice(t('hh.payNeedsNet')); return }
    setPaying(true); setNotice('')
    try {
      let terminal: { approvalCode: string } | undefined
      if (payMethod !== 'cash') {
        const term = await processTerminalPayment(payTotal)
        if (!term.approved) {
          setNotice(term.error || t('payment.terminalDeclined', { amount: fmtEUR(payTotal) }))
          return
        }
        terminal = { approvalCode: term.approvalCode as string }
      }
      const d = await api<{ invoice: { eor?: string; invoiceNumber?: string } }>('/api/furs', {
        method: 'POST',
        body: JSON.stringify({
          orderId: openOrder.id,
          clientOperationId: newOperationId(),
          type: payMethod,
          ...(terminal ? { terminal } : {}),
          ...(tipEur > 0 ? { tip: tipEur } : {}),
        }),
      })
      setPaidInfo({ invoiceNumber: d.invoice?.invoiceNumber ?? null, eor: d.invoice?.eor ?? null, total: payTotal, tip: tipEur })
      setView('paid')
      await load(true)
    } catch (err) {
      setNotice((err as Error).message)
      await load(true).catch(() => null)
    } finally { setPaying(false) }
  }

  /** P0-2 (v1.85.0): ustvari javno plačilno povezavo (+ QR za gosta, SMS izbirno).
   *  P1-6 (v1.87.0): splitCount > 1 → N povezav (vsak gost svoj QR/delež). */
  async function createPayLink() {
    if (!openOrder || plinkBusy) return
    if (!online) { setNotice(t('hh.payNeedsNet')); return }
    setPlinkBusy(true); setNotice('')
    try {
      const d = await api<{ links: PlinkRow[] }>(`/api/orders/${openOrder.id}/paylink`, {
        method: 'POST',
        body: JSON.stringify({
          phone: plinkSplit <= 1 && plinkPhone.trim() ? plinkPhone.trim() : undefined,
          ...(plinkSplit > 1 ? { splitCount: plinkSplit } : {}),
        }),
      })
      setPlinks(d.links ?? [])
      setPlinkPhones({})
    } catch (err) {
      setNotice((err as Error).message)
    } finally { setPlinkBusy(false) }
  }

  /** P1-6: SMS (ponovno) pošiljanje na POSAMEZNI povezavi niza (brez rotacije). */
  async function sendSmsForLink(linkId: string) {
    if (!openOrder || plinkBusy) return
    if (!online) { setNotice(t('hh.payNeedsNet')); return }
    const phone = (plinkPhones[linkId] || '').trim()
    if (!phone) { setNotice(t('hh.plinkPhone')); return }
    setPlinkBusy(true); setNotice('')
    try {
      const d = await api<{ links: PlinkRow[] }>(`/api/orders/${openOrder.id}/paylink`, {
        method: 'POST',
        body: JSON.stringify({ sms: [{ linkId, phone }] }),
      })
      setPlinks(d.links ?? null)
    } catch (err) {
      setNotice((err as Error).message)
    } finally { setPlinkBusy(false) }
  }

  function backToTables() {
    setNotice(''); setBill(null); setPaidInfo(null); setCart({}); setNotes({}); setNoteOpen(null)
    setPlinks(null)
    setActiveSeat(null) // N-27-1: aktivni sedež se resetira ob vrnitvi na mize
    setSelTableId(null)
    setView('tables')
  }

  function logout() {
    // Issue #90 (QA): piškotek seje pobriše strežnik (httpOnly — JS ne more).
    void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    localStorage.removeItem('ro_token')
    localStorage.removeItem('ro_user')
    router.replace('/')
  }

  if (!ready) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-stone-50">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-700" aria-label={t('hh.title')} />
      </div>
    )
  }

  return (
    <main data-screen="handheld-pos" className="flex flex-col min-h-dvh bg-stone-50">
      {/* header — minimalen chrome, veliki cilji */}
      <header data-region="handheld-header" className="sticky top-0 z-20 bg-emerald-700 text-white px-4 py-3 flex items-center gap-2">
        <Smartphone className="w-5 h-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-bold leading-tight truncate">{t('hh.title')}</p>
          <p className="text-xs opacity-90 truncate">{me?.name} · {t('hh.sub')}</p>
        </div>
        <LanguageToggle />
        {/* Issue #21 (v1.111.0) — klic vodje (kontekst izbrane mize, če je) */}
        {/* i69 vizualni QA: h-11 izenači z Odjava v isti vrstici (36→44px, boljši dotik) */}
        <ManagerCallButton size="sm" className="h-11" tableNumber={selTable?.number} />
        <button aria-label={t('header.logout')} onClick={logout} className="p-2 rounded-lg hover:bg-emerald-800 min-h-11 min-w-11 flex items-center justify-center"><LogOut className="w-5 h-5" /></button>
      </header>

      {/* offline trak — isti vzorec kot dashboard (vrsta se ob povratku splakne) */}
      {!online && (
        <p className="sticky top-[60px] z-10 bg-amber-100 text-amber-900 text-xs font-semibold px-4 py-2 border-b border-amber-200">
          {t('net.offline')} {queueN > 0 ? `· ${t('header.queued', { n: queueN })}` : ''}
        </p>
      )}
      {notice && <p role="status" className="mx-4 mt-3 text-xs rounded-md px-3 py-2 bg-emerald-50 text-emerald-800 border border-emerald-200">{notice}</p>}

      {/* ── VIEW: MIZE ── */}
      {view === 'tables' && (
        <>
          <div className="sticky top-[60px] z-10 bg-stone-50 border-b border-stone-200 px-4 py-2 flex gap-1.5 overflow-x-auto">
            {([['ALL', 'hh.filterAll'], ['FREE', 'hh.filterFree'], ['OCCUPIED', 'hh.filterOccupied'], ['DIRTY', 'hh.filterDirty']] as const).map(([v, k]) => (
              <button key={v} onClick={() => setFilter(v)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold border min-h-8 ${filter === v ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200 text-stone-600'}`}>
                {t(k)}
              </button>
            ))}
          </div>
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filteredTables.map((tb) => {
              const pend = tb.activeOrder ? pendingByOrder[tb.activeOrder.id] ?? 0 : 0
              return (
                <button
                  key={tb.id}
                  onClick={() => tapTable(tb)}
                  className={`relative w-full rounded-2xl p-4 text-left shadow min-h-24 transition ${TAB_COLORS[tb.status] ?? 'bg-stone-500 text-white'}`}
                >
                  <p className="font-bold text-lg leading-tight">{tb.name}</p>
                  <p className="text-xs opacity-90 mt-0.5">{tb.zone} · {t('tables.seats', { n: tb.seats })}</p>
                  {tb.activeOrder && <p className="text-sm font-bold mt-1">{fmtEUR(tb.activeOrder.total)}</p>}
                  <p className="text-xs mt-1 opacity-80">
                    {/* Issue #70 §1: oznaka IZKLJUČNO iz kanonskega statusa (/api/tables) —
                        prej je handheld za OCCUPIED brez activeOrder pokazal "Na voljo" (neskladje z dashboardom) */}
                    {t(tableStatusLabelKey(tb.status))}
                  </p>
                  {pend > 0 && (
                    <span className="absolute top-2 right-2 rounded-full bg-white/95 text-amber-700 text-xs font-bold px-2 py-0.5 border border-amber-300">
                      {t('hh.unfired', { n: pend })}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {tables.length === 0 && <p className="p-4 text-sm text-stone-500">{t('tlb.noTables')}</p>}
          <div className="mt-auto p-4 pt-6 flex gap-4 justify-center text-xs">
            <button onClick={() => router.push('/tablica')} className="text-emerald-700 font-semibold flex items-center gap-1 min-h-8"><ArrowUpRight className="w-3.5 h-3.5" />{t('hh.quickMode')}</button>
            <button onClick={() => router.push('/dashboard')} className="text-emerald-700 font-semibold flex items-center gap-1 min-h-8"><Monitor className="w-3.5 h-3.5" />{t('tlb.fullPos')}</button>
          </div>
        </>
      )}

      {/* ── VIEW: NAROČI ── */}
      {view === 'order' && selTable && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="shrink-0 bg-white border-b border-stone-200 px-2 py-2 flex items-center gap-2">
            <button aria-label={t('hh.backTables')} onClick={backToTables} className="p-2 rounded-lg hover:bg-stone-100 min-h-11 min-w-11 flex items-center justify-center"><ChevronLeft className="w-6 h-6" /></button>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-base leading-tight truncate">{openOrder ? t('hh.orderMeta', { n: openOrder.orderNumber ?? '—' }) : t('hh.newOrderFor', { name: selTable.name })}</p>
              <p className="text-xs text-stone-500 truncate">{selTable.name} · {selTable.zone} · {t('tables.seats', { n: selTable.seats })}</p>
            </div>
            {openOrder && <Badge className="bg-amber-600 shrink-0">{fmtEUR(openOrder.total)}</Badge>}
          </div>

          {/* FIX (zaključna verifikacija v1.259.0, runtime izmerjeno na produkciji): glavni
              del strani je min-h-dvh (okno je drsalni mehanizem te površine — glava in
              filtrna vrstica sta vedno lepljivi na OKNO), zato je bil overflow-y-auto na
              tem vsebniku MRTVI drseči vsebnik: nikoli ni drsal (zrasel je na višino
              vsebine, drsalo je okno), a kot scroll-container je UGRABIL lepljivo
              zavezo vrstice — vrstica je zdrsnila z oknom (izmerjeno: po 700 px drsanja
              je bil rob vrstice na −550 px, obljuba »povzetek ostane v pogledu« NI
              delovala). Odstranjen overflow-y-auto → vrstica se lepi na OKNO. */}
          <div className="flex-1 min-h-0 px-4 py-3 space-y-3">
            {/* v1.259.0 (§33): VRSTICA NAROČILA — obstoječe postavke v ZLOŽLJIVI
                LEPILJIVI sekciji na vrhu območja menija (Lightspeed nov 2026
                »Keep active orders visible while browsing menus« — slide-out
                menu layer). Povzetek (števec + znesek + faza) OSTANE v pogledu
                med brskanjem menija; razpenjanje razkrije poln seznam nad menijem
                (meni ne izgine — plast je nad njim). -mx-4/-mt-3 raztegne sekcijo
                čez odmik vsebnika, da se pod njo ne vidi drseče vsebine.
                FIX (zaključna verifikacija): lepljiva na OKNO pod glavo — top-[65px]
                je 77 px glave (py-3 ×2 + 54 px LanguageToggle, izmerjeno) − 12 px
                -mt-3 (lepljivi rob je ROB ROBE z robom odmika → obroba vrstice
                pristane točno ob spodnjem robu glave, brez pasu, ki bi kaksel). */}
            {activeItems.length > 0 && (
              <div data-region="hh-order-bar" className="sticky top-[65px] z-10 -mx-4 -mt-3 bg-white/95 backdrop-blur-sm border-b border-stone-200 shadow-sm">
                <button
                  type="button"
                  data-region="hh-order-bar-toggle"
                  aria-expanded={orderBarOpen}
                  aria-controls="hh-order-bar-list"
                  aria-label={t('hh.orderBarAria')}
                  onClick={() => setOrderBarOpen((v) => !v)}
                  className="flex w-full items-center gap-2 min-h-11 px-4 py-1.5 text-left active:bg-stone-50"
                >
                  <span className="text-xs font-semibold uppercase text-stone-500 shrink-0">{t('hh.existingItems')}</span>
                  <span className="text-sm font-bold tabular-nums shrink-0">{t('hh.orderBar', { n: activeItems.length })}</span>
                  {/* najbolj relevantna faza: priprava (amber) > pripravljeno (emerald) */}
                  {prepCount > 0 && (
                    <span className="rounded-full border border-amber-300 bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-semibold shrink-0">{t('hh.orderBarPrep', { n: prepCount })}</span>
                  )}
                  {prepCount === 0 && readyCount > 0 && (
                    <span className="rounded-full border border-emerald-300 bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold shrink-0">{t('hh.orderBarReady', { n: readyCount })}</span>
                  )}
                  <span className="text-sm font-bold tabular-nums ml-auto shrink-0">{fmtEUR(openOrder?.total ?? 0)}</span>
                  <ChevronDown className={`w-5 h-5 shrink-0 text-stone-400 transition-transform ${orderBarOpen ? 'rotate-180' : ''}`} aria-hidden />
                </button>
                {orderBarOpen && (
                  <div id="hh-order-bar-list" data-region="hh-order-bar-list" className="max-h-64 overflow-y-auto px-4 pb-2 space-y-1.5">
                    {activeItems.map((it) => (
                      <div key={it.id} className="flex items-center gap-2 text-sm">
                        <span className="flex-1 truncate">
                          {it.qty}× {it.name}
                          {it.note ? <span className="text-stone-400"> ({it.note})</span> : null}
                        </span>
                        <span className="text-stone-500 shrink-0 text-xs">{fmtEUR(it.unitPrice * it.qty)}</span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${ITEM_STATUS_BADGE[it.status] ?? ITEM_STATUS_BADGE.PENDING}`}>
                          {['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(it.status) ? t(`status.${it.status}`) : it.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {openOrder && activeItems.length === 0 && <p className="text-sm text-stone-500">{t('tlb.emptyOrder')}</p>}

            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-3 text-stone-400" />
              <Input aria-label={t('sale.search')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sale.search')} className="pl-8 min-h-11" />
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              <button onClick={() => setCat('ALL')} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border min-h-8 ${cat === 'ALL' ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>{t('sale.allCat')}</button>
              {categories.map((c) => (
                <button key={c.id} onClick={() => setCat(c.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border min-h-8 ${cat === c.id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>{c.name}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {items.map((mi) => (
                /* v1.234.0: besedilna ploščica z barvnim levim robom kategorije
                   (enak vzorec kot hitra prodaja v dashboardu) — brez fotografije. */
                <button
                  key={mi.id}
                  disabled={!mi.available}
                  onClick={() => inc(mi.id)}
                  className={`flex min-h-20 flex-col justify-between rounded-xl border border-l-4 px-3 py-2 text-left transition ${mi.available
                    ? `${saleCatBorderCls(mi.categoryId || mi.name)} border-y-stone-200 border-r-stone-200 bg-white active:scale-[0.98] active:shadow`
                    : 'cursor-not-allowed border-l-red-400 border-y-red-200 border-r-red-200 bg-stone-100'}`}
                >
                  <p className={`min-w-0 self-stretch text-sm font-semibold leading-tight line-clamp-2 break-words ${mi.available ? 'text-stone-900' : 'line-through text-stone-400'}`}>{mi.name}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <p className={`text-xs font-medium tabular-nums ${mi.available ? 'text-stone-500' : 'text-stone-400'}`}>{fmtEUR(mi.price)}</p>
                    {!mi.available && <Badge className="bg-stone-500 text-xs leading-none">{t('hh.soldOut')}</Badge>}
                  </div>
                </button>
              ))}
            </div>
            {items.length === 0 && <p className="text-sm text-stone-500">{t('sale.empty')}</p>}
          </div>

          {/* lepljivo dno — cona palca: košarica + gosti + CTA vrstni red POSESTVENO: dodaj → fire → račun */}
          <div className="shrink-0 border-t border-stone-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-2">
            {/* N-27-1: aktivni sedež (naročanje) — isti obseg sedežev kot plačilni dialog (1–5) */}
            {cartQty > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={t('order.activeSeat')}>
                <span className="text-xs font-semibold uppercase text-stone-500 mr-1 shrink-0">{t('order.activeSeat')}</span>
                <button aria-pressed={activeSeat == null} onClick={() => setActiveSeat(null)} className={`min-h-11 px-3 rounded-lg text-sm font-bold ${activeSeat == null ? 'bg-stone-800 text-white' : 'bg-stone-100 active:bg-stone-200 text-stone-700'}`}>{t('order.seatNone')}</button>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} aria-pressed={activeSeat === n} onClick={() => setActiveSeat(n)} className={`min-h-11 px-3 rounded-lg text-sm font-bold ${activeSeat === n ? 'bg-emerald-700 text-white' : 'bg-stone-100 active:bg-stone-200 text-stone-700'}`}>{t('payment.seatShort', { n })}</button>
                ))}
              </div>
            )}
            {cartQty > 0 && (
              <div className="max-h-44 overflow-y-auto space-y-2 border-b border-stone-100 pb-2">
                {Object.entries(cart).map(([id, qty]) => {
                  const mi = menu.find((x) => x.id === id)
                  return (
                    <div key={id} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate font-medium">{mi?.name}</span>
                        <span className="text-stone-500 shrink-0 text-xs">{fmtEUR((mi?.price ?? 0) * qty)}</span>
                        <button aria-label={t('hh.remove')} onClick={() => dec(id)} className="w-9 h-9 rounded-lg bg-stone-100 active:bg-stone-200 text-lg font-bold flex items-center justify-center">−</button>
                        <span className="w-6 text-center font-bold">{qty}</span>
                        <button aria-label={t('hh.addItem')} onClick={() => inc(id)} className="w-9 h-9 rounded-lg bg-emerald-100 active:bg-emerald-200 text-emerald-800 text-lg font-bold flex items-center justify-center">+</button>
                        <button aria-label={t('hh.note')} onClick={() => setNoteOpen(noteOpen === id ? null : id)} className={`w-9 h-9 rounded-lg flex items-center justify-center ${notes[id]?.trim() ? 'bg-emerald-700 text-white' : 'bg-stone-100 active:bg-stone-200'}`}><MessageSquare className="w-4 h-4" /></button>
                      </div>
                      {noteOpen === id && (
                        <div className="space-y-1.5 mt-1.5">
                          <div className="flex items-center gap-2">
                            <Input aria-label={t('hh.notePlaceholder')}
                              value={notes[id] ?? ''}
                              onChange={(e) => setNotes((p) => ({ ...p, [id]: e.target.value }))}
                              placeholder={t('hh.notePlaceholder')}
                              className="min-h-11 text-sm"
                              maxLength={80}
                            />
                            <button onClick={() => { setNotes((p) => { const nx = { ...p }; delete nx[id]; return nx }); setNoteOpen(null) }} className="text-xs text-stone-500 underline min-h-11 px-1 shrink-0">{t('hh.remove')}</button>
                          </div>
                          {/* Issue #7: izrecno alergensko opozorilo (rdeče) — viden na KDS + tisku */}
                          <Input aria-label={t('hh.allergenWarningPlaceholder')}
                            value={allergenNotes[id] ?? ''}
                            onChange={(e) => setAllergenNotes((p) => ({ ...p, [id]: e.target.value }))}
                            placeholder={t('hh.allergenWarningPlaceholder')}
                            className="min-h-11 text-sm border-red-200 focus-visible:ring-red-300 text-red-800"
                            maxLength={200}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center justify-between text-sm pt-1">
                  <span>{t('tlb.cart', { n: cartQty })}</span>
                  <span className="font-bold">{fmtEUR(cartTotal)}</span>
                </div>
              </div>
            )}
            {!openOrder && (
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-stone-600 shrink-0">{t('hh.guests')}</span>
                <button aria-label={t('hh.guests')} onClick={() => setGuests((g) => Math.max(1, g - 1))} className="w-10 h-10 rounded-lg bg-stone-100 active:bg-stone-200 text-lg font-bold flex items-center justify-center">−</button>
                <span className="text-base font-bold w-6 text-center">{guests}</span>
                <button aria-label={t('hh.guests')} onClick={() => setGuests((g) => Math.min(20, g + 1))} className="w-10 h-10 rounded-lg bg-stone-100 active:bg-stone-200 text-lg font-bold flex items-center justify-center">+</button>
              </div>
            )}
            {cartQty > 0 && (
              <button
                disabled={sending}
                onClick={() => void (openOrder ? submitAdd() : submitCreate())}
                className="w-full min-h-14 rounded-xl bg-emerald-700 active:bg-emerald-800 text-white text-base font-bold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : `${fmtEUR(cartTotal)} · ${openOrder ? t('hh.addItem') : t('hh.createOrder')}`}
              </button>
            )}
            {openOrder && pendingCount > 0 && (
              <button
                disabled={firing || !online}
                onClick={() => void fireOrder()}
                className="w-full min-h-14 rounded-xl bg-orange-600 active:bg-orange-700 text-white text-base font-bold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {firing ? <Loader2 className="w-5 h-5 animate-spin" /> : t('hh.fireN', { n: pendingCount })}
              </button>
            )}
            {openOrder && activeItems.length > 0 && (
              <button
                onClick={() => void goBill()}
                className="w-full min-h-12 rounded-xl border-2 border-emerald-700 text-emerald-800 text-sm font-bold flex items-center justify-center gap-1 active:bg-emerald-50"
              >
                {t('hh.bill')} {openOrder.total > 0 ? `· ${fmtEUR(openOrder.total)}` : ''}
                <ChevronLeft className="w-4 h-4 rotate-180" />
              </button>
            )}
            {openOrder && pendingCount === 0 && activeItems.length > 0 && (
              <p className="text-xs text-stone-400 text-center">{t('hh.noPending')}</p>
            )}
          </div>
        </div>
      )}

      {/* ── VIEW: RAČUN ── */}
      {view === 'bill' && openOrder && bill && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="shrink-0 bg-white border-b border-stone-200 px-2 py-2 flex items-center gap-2">
            <button aria-label={t('hh.backOrder')} onClick={() => setView('order')} className="p-2 rounded-lg hover:bg-stone-100 min-h-11 min-w-11 flex items-center justify-center"><ChevronLeft className="w-6 h-6" /></button>
            <div className="flex-1">
              <p className="font-bold text-base leading-tight">{t('hh.bill')} · {t('hh.orderMeta', { n: openOrder.orderNumber ?? '—' })}</p>
              <p className="text-xs text-stone-500 truncate">{selTable?.name}</p>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
            {pendingCount > 0 && (
              <p className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-semibold px-3 py-2 flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                {t('hh.unpaidWarn', { n: pendingCount })}
              </p>
            )}
            <div className="space-y-1.5 bg-white rounded-xl border border-stone-200 p-3">
              {activeItems.map((it) => (
                <div key={it.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">{it.qty}× {it.name}</span>
                  <span className="text-stone-600 shrink-0 ml-2">{fmtEUR(it.unitPrice * it.qty)}</span>
                </div>
              ))}
              <div className="border-t border-stone-100 pt-2 mt-2 space-y-1 text-sm">
                <div className="flex justify-between text-stone-500"><span>{t('hh.subtotal')}</span><span>{fmtEUR(bill.subtotal)}</span></div>
                <div className="flex justify-between text-stone-500"><span>{t('hh.tax')}</span><span>{fmtEUR(bill.tax)}</span></div>
                {bill.discountTotal > 0 && (
                  <div className="flex justify-between text-emerald-700 font-semibold"><span>{t('hh.discount')}</span><span>−{fmtEUR(bill.discountTotal)}</span></div>
                )}
                <div className="flex justify-between font-bold text-base pt-1"><span>{t('hh.totalDue')}</span><span>{fmtEUR(bill.totalDue)}</span></div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-stone-500 uppercase">{t('hh.tip')}</p>
              <div className="grid grid-cols-5 gap-1.5">
                {[0, 5, 10, 15].map((p) => (
                  <button key={p} onClick={() => { setTipPct(p); setTipCustom('') }} className={`min-h-11 rounded-lg border text-sm font-bold ${tipPct === p && !tipCustom ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>
                    {p === 0 ? '0' : `${p}%`}
                  </button>
                ))}
                <div className="relative">
                  <Input aria-label={t('hh.customTip')}
                    value={tipCustom}
                    onChange={(e) => { setTipCustom(e.target.value); setTipPct(0) }}
                    placeholder={t('hh.customTip')}
                    inputMode="decimal"
                    className="min-h-11 text-center text-sm px-1"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-stone-500 uppercase">{t('hh.method')}</p>
              <div className="grid grid-cols-3 gap-1.5">
                {([['cash', 'hh.cash'], ['card', 'hh.card'], ['mobile', 'hh.mobile']] as const).map(([v, k]) => (
                  <button key={v} onClick={() => setPayMethod(v)} className={`min-h-12 rounded-lg border text-sm font-bold ${payMethod === v ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200'}`}>
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
            {/* P0-2 (v1.85.0) + P1-6 (v1.87.0): plačilna povezava — gost plača na
                svojem telefonu; split → N povezav (vsak gost svoj QR/delež) */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-stone-500 uppercase">{t('hh.plink')}</p>
              {!plinks || plinks.length === 0 ? (
                <div className="space-y-2 bg-white rounded-xl border border-stone-200 p-3">
                  <div className="flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-stone-400 shrink-0" aria-hidden />
                    <p className="text-xs font-semibold text-stone-500 flex-1">{t('hh.plinkSplit')}</p>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          onClick={() => setPlinkSplit(n)}
                          aria-pressed={plinkSplit === n}
                          className={`min-h-9 min-w-9 rounded-lg border text-xs font-bold ${plinkSplit === n ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white border-stone-200 text-stone-600'}`}
                        >
                          {n === 1 ? '1' : n}
                        </button>
                      ))}
                    </div>
                  </div>
                  {plinkSplit <= 1 && (
                    <Input
                      value={plinkPhone}
                      onChange={(e) => setPlinkPhone(e.target.value)}
                      placeholder={t('hh.plinkPhone')}
                      inputMode="tel"
                      className="min-h-11"
                      aria-label={t('hh.plinkPhone')}
                    />
                  )}
                  <button
                    disabled={plinkBusy || !online}
                    onClick={() => void createPayLink()}
                    className="w-full min-h-12 rounded-lg border border-emerald-700 text-emerald-800 text-sm font-bold flex items-center justify-center gap-2 active:bg-emerald-50 disabled:opacity-60"
                  >
                    {plinkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                    {plinkSplit > 1 ? `${t('hh.plinkCreate')} · ${plinkSplit}×` : t('hh.plinkCreate')}
                  </button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[340px] overflow-y-auto">
                  {plinks.map((pl, i) => (
                    <div key={pl.id} className="space-y-2 bg-white rounded-xl border border-stone-200 p-3">
                      <div className="flex gap-3">
                        <img src={pl.qrDataUrl} alt={`${t('hh.plinkQr')} ${i + 1}`} className="w-24 h-24 shrink-0" />
                        <div className="min-w-0 flex-1 space-y-1">
                          {pl.splitCount > 1 ? (
                            <p className="text-xs font-bold text-stone-700">
                              {t('hh.plinkShare')} {pl.splitIndex}/{pl.splitCount}
                              {pl.amount != null && <span className="text-emerald-700"> · {fmtEUR(pl.amount)}</span>}
                            </p>
                          ) : null}
                          <p className="text-xs text-stone-500 break-all select-all leading-tight">{pl.url}</p>
                          {pl.sms && (
                            <p className={`text-xs font-semibold ${pl.sms.sent ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {pl.sms.sent ? t('hh.plinkSent') : `${t('hh.plinkSendFail')} — ${pl.sms.detail}`}
                            </p>
                          )}
                          <div className="flex gap-1.5">
                            <Input
                              value={plinkPhones[pl.id] || ''}
                              onChange={(e) => setPlinkPhones((m) => ({ ...m, [pl.id]: e.target.value }))}
                              placeholder={t('hh.plinkPhone')}
                              inputMode="tel"
                              className="min-h-9 h-9 text-xs flex-1"
                              aria-label={`${t('hh.plinkPhone')} ${pl.splitIndex}/${pl.splitCount}`}
                            />
                            <button
                              disabled={plinkBusy || !online}
                              onClick={() => void sendSmsForLink(pl.id)}
                              className="min-h-9 h-9 px-3 rounded-lg border border-stone-200 text-xs font-bold active:bg-stone-100 disabled:opacity-60 shrink-0"
                            >
                              {plinkBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('hh.plinkSmsSend')}
                            </button>
                          </div>
                        </div>
                      </div>
                      {plinks.length === 1 && (
                        <button
                          onClick={() => { void navigator.clipboard?.writeText(pl.url).catch(() => null); setNotice(t('hh.plinkCopied')) }}
                          className="w-full min-h-11 rounded-lg border border-stone-200 text-sm font-bold active:bg-stone-100"
                        >
                          {t('hh.plinkCopy')}
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => void createPayLink()}
                    disabled={plinkBusy || !online}
                    className="w-full min-h-11 rounded-lg border border-stone-200 text-sm font-bold active:bg-stone-100 disabled:opacity-60"
                  >
                    {t('hh.plinkNew')}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 border-t border-stone-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span>{t('hh.totalDue')}{tipEur > 0 ? ` + ${t('hh.tip')}` : ''}</span>
              <span className="font-bold text-lg">{fmtEUR(payTotal)}</span>
            </div>
            <button
              disabled={paying || !online || payTotal <= 0}
              onClick={() => void pay()}
              className="w-full min-h-14 rounded-xl bg-emerald-700 active:bg-emerald-800 text-white text-base font-bold flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {paying ? <><Loader2 className="w-5 h-5 animate-spin" /> {t('hh.paying')}</> : `${t('hh.pay')} ${fmtEUR(payTotal)}`}
            </button>
            {!online && <p className="text-xs text-amber-700 text-center font-semibold">{t('hh.payNeedsNet')}</p>}
          </div>
        </div>
      )}

      {/* ── VIEW: PLAČANO ── */}
      {view === 'paid' && paidInfo && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 flex flex-col items-center justify-center px-6 text-center space-y-3">
            <CheckCircle2 className="w-16 h-16 text-emerald-600" />
            <p className="text-2xl font-bold text-emerald-800">{t('hh.paid')}</p>
            <p className="text-3xl font-extrabold">{fmtEUR(paidInfo.total)}</p>
            {paidInfo.tip > 0 && <p className="text-sm text-stone-500">{t('hh.tip')}: {fmtEUR(paidInfo.tip)}</p>}
            {paidInfo.invoiceNumber && <p className="text-sm text-stone-600">{t('hh.receipt', { n: paidInfo.invoiceNumber })}</p>}
            {paidInfo.eor && <p className="text-xs text-stone-400 font-mono break-all max-w-xs">{t('hh.eor', { code: paidInfo.eor })}</p>}
            <p className="text-xs text-stone-500 pt-2">{t('hh.tableDirty')}</p>
          </div>
          <div className="shrink-0 border-t border-stone-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-2">
            {selTable && (
              <button
                onClick={() => void markClean(selTable)}
                className="w-full min-h-14 rounded-xl bg-emerald-700 active:bg-emerald-800 text-white text-base font-bold flex items-center justify-center gap-2"
              >
                {t('hh.cleanTable')}
              </button>
            )}
            <button onClick={backToTables} className="w-full min-h-12 rounded-xl border-2 border-stone-300 text-stone-600 text-sm font-bold active:bg-stone-50">
              {t('hh.backTables')}
            </button>
          </div>
        </div>
      )}
    </main>
  )
}

export default function HandheldPage() {
  return (
    <I18nProvider>
      <HandheldInner />
    </I18nProvider>
  )
}
