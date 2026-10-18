'use client'

/**
 * Issue #8 (P2, v1.116.0) — ZAVIHEK PRENOSI (medlokacijski prenosi zalog).
 *
 * Vir podatkov (backend Task 8-backend, živ na dev :3007 — DDL #28 stock-transfers):
 *  - GET/POST /api/transfers                — seznam (filtri status/from/to/q/datum,
 *    take ≤ 100) + ustvarjanje osnutka (201 {transfer} | replay 200; 503 pre-DDL)
 *  - GET /api/transfers/[id]                — detalj: {transfer:{...,lines,variance}}
 *  - POST /api/transfers/[id]/dispatch      — DRAFT → DISPATCHED ({note?}; 409 CAS)
 *  - POST /api/transfers/[id]/receive       — DISPATCHED → RECEIVED|PARTIAL
 *    ({note?, lines:[{transferItemId, receivedQty, damagedQty?, note?}]})
 *  - POST /api/transfers/[id]/cancel        — DRAFT → CANCELLED ({reason 3–500})
 *  - GET /api/inventory                     — izbirnik artiklov (DTO: id/name/unit/
 *    qty/minQty/cost/supplierId/locationId — klient filtrira po izvorni lokaciji)
 *  - GET /api/inventory/batches?take=200&filter=usable — serije (id/itemName/
 *    lotNumber/expiryDate/quantityRemaining/status/locationId) za serijske postavke
 *
 * Konvencije (družina tabs/): PayrollTab (locations + canManage propi, seznam ↔
 * detail preklopnik, migrBox 503 z isMigrationPendingMsg, AlertDialog za težke
 * odločitve, Skeleton, fmtEUR iz @/lib/client), NabavaTab (vrstični urejevalnik
 * postavk + prevzem z sprejeto/zavrnjeno količino na postavko, nabavaNum
 * vejica→pika), OdpadTab (statusne barve badge). i18n skupina trf.* (PROST predpona,
 * polna SL/HR pariteta). Količine do 3 decimalke (r3, kot strežnik), denar fmtEUR.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, fmtEUR, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Loader2, RefreshCw, Plus, ChevronDown, ArrowLeft, ArrowLeftRight, Truck, PackageCheck, Ban,
  AlertTriangle, Trash2,
} from 'lucide-react'

/* ─────────────────────────── TIPI (API pogodba 8-backend) ─────────────────────────── */

/** transferLineDto iz src/lib/stock-transfer.ts (natančno zrcalo). */
export interface TransferLineT {
  id: string
  inventoryItemId: string
  itemName: string
  unit: string
  requestedQty: number
  dispatchedQty: number
  receivedQty: number
  damagedQty: number
  missingQty: number
  unitCost: number | null
  batchId: string | null
  lotNumber: string | null
  expiryDate: string | null
  targetItemId: string | null
  note: string
}

/** transferDto iz src/lib/stock-transfer.ts (natančno zrcalo). */
export interface TransferT {
  id: string
  transferNumber: string
  status: string
  fromLocationId: string
  fromLocationName: string | null
  toLocationId: string
  toLocationName: string | null
  note: string
  createdAt: string
  dispatchedAt: string | null
  receivedAt: string | null
  cancelledAt: string | null
  cancelReason: string
  itemCount: number
  /** prisotne v GET seznamu in GET [id] (include items); akcijske rute vračajo brez */
  lines?: TransferLineT[]
  /** SAMO terminalna stanja (RECEIVED/PARTIAL — prejet/poškodovan je dokončen) */
  variance?: { missingQty: number; damagedQty: number }
}

/** GET /api/inventory → inventory[] (operativni DTO — cena samo za inventory.manage). */
interface PickItemT {
  id: string
  name: string
  unit: string
  qty: number
  minQty: number
  cost: number
  supplierId: string | null
  locationId: string | null
}

/** GET /api/inventory/batches → batches[] (filter=usable; ID po artiklu prek itemName). */
interface PickBatchT {
  id: string
  itemName: string
  itemUnit: string
  lotNumber: string
  expiryDate: string | null
  quantityRemaining: number
  quantityInitial: number
  supplierName: string
  status: string
  locationId: string | null
}

/** Vrstica urejevalnika osnutka (količina/serija kot string za Input). */
interface NewLineT {
  itemId: string
  qty: string
  batchId: string
  serOpen: boolean
}

/** Vrstica prevzema (prejeto/poškodovano kot string za Input). */
interface RecvLineT {
  received: string
  damaged: string
  note: string
}

/* ─────────────────────────── POMOČNIKI (modul) ─────────────────────────── */

/** Status → i18n ključ (neznan status pade na suho vrednost). */
const STATUS_KEY: Record<string, string> = {
  DRAFT: 'trf.st.draft',
  DISPATCHED: 'trf.st.dispatched',
  RECEIVED: 'trf.st.received',
  PARTIAL: 'trf.st.partial',
  CANCELLED: 'trf.st.cancelled',
}

/** Status → badge barve (nabava-tab NABAVA_STATUS konvencija). */
const STATUS_CLS: Record<string, string> = {
  DRAFT: 'border-stone-300 bg-stone-100 text-stone-700',
  DISPATCHED: 'border-amber-300 bg-amber-100 text-amber-800',
  RECEIVED: 'border-emerald-300 bg-emerald-100 text-emerald-800',
  PARTIAL: 'border-orange-300 bg-orange-100 text-orange-800',
  CANCELLED: 'border-stone-300 bg-stone-50 text-stone-500',
}

/** Vrstica → stanje (badge v tabeli postavk). Končni odmik (complete/variance) je
 *  smiseln ŠTELE po prevzemu (RECEIVED/PARTIAL) — v tranzitu vrstica čaka prevzem. */
function lineState(l: TransferLineT, status: string): 'pending' | 'complete' | 'variance' {
  if (status !== 'RECEIVED' && status !== 'PARTIAL') return 'pending'
  if (l.dispatchedQty <= 0.0005) return 'pending'
  if (Math.abs(l.receivedQty - l.dispatchedQty) <= 0.0005 && l.damagedQty <= 0.0005) return 'complete'
  return 'variance'
}
const LN_KEY: Record<'pending' | 'complete' | 'variance', string> = {
  pending: 'trf.ln.pending',
  complete: 'trf.ln.complete',
  variance: 'trf.ln.variance',
}
const LN_CLS: Record<'pending' | 'complete' | 'variance', string> = {
  pending: 'border-stone-300 bg-stone-100 text-stone-600',
  complete: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  variance: 'border-amber-300 bg-amber-50 text-amber-800',
}

/** r3 normalizacija (isti prag kot strežnik — največ 3 decimalke). */
const r3 = (n: number) => Math.round(n * 1000) / 1000

/** Izbis številskih vrednosti: odrezane odvečne ničle, do 3 decim. (zaloga-tab vzorec). */
const fmtQty = (n: number) => String(r3(n))

/** '12.10.2026 09:41' (payroll fmtStamp). */
const fmtStamp = (iso: string) => new Date(iso).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Datum brez časa (rok uporabe serije). */
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('sl-SI')

/** '1,5' → 1.5 (nabava-tab nabavaNum konvencija — sprejmemo vejico). */
const parseNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** 4 naključne znake za idempotencyKey (`trf:${ms36}:${rand4}` — ≥ 8 znakov). */
const rand4 = () => Math.random().toString(36).slice(2, 6).padEnd(4, '0')

/** 503 pre-DDL detekcija (vzorec haccp/payroll: fail() sporočilo vsebuje 'migracij'). */
function isMigrationPendingMsg(msg: string): boolean {
  return msg.includes('migracij')
}

/**
 * Strežniška napaka → lokalizirano sporočilo. Znani vzorci (SL sporočila rut)
 * preslikamo v trf.* ključe; podrobna sporočila (premalo zaloge s številkami,
 * CAS 409 …) in neznane napake gredo naprej surove — bolj uporabne kot generika.
 */
function mapErr(t: (k: string) => string, msg: string, fallbackKey: string): string {
  if (!msg) return t(fallbackKey)
  if (msg.includes('podvojen')) return t('trf.errDupe')
  if (msg.includes('sta enaki') || msg.includes('isto lokacijo')) return t('trf.errSameLoc')
  if (msg.includes('blokirana')) return t('trf.errBlocked')
  if (msg.includes('mora biti pozitivno') || msg.includes('decimalke')) return t('trf.errQty')
  return msg
}

/** ime lokacije iz DTO (null → pika — lokacija je lahko pobrisana). */
const locName = (n: string | null | undefined) => n || '—'

/* ─────────────────────────── ZAVIHEK ─────────────────────────── */

const MAX_LINES = 50

export function TransfersTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useI18n()

  // ── seznam ──
  const [list, setList] = useState<TransferT[] | null>(null)
  const [listBusy, setListBusy] = useState(true)
  const [listErr, setListErr] = useState('')
  const [migrPending, setMigrPending] = useState(false)
  const [reload, setReload] = useState(0)

  // ── filtri (ALL = brez filtra; q debounce 350 ms) ──
  const [fStatus, setFStatus] = useState('ALL')
  const [fFrom, setFFrom] = useState('ALL')
  const [fTo, setFTo] = useState('ALL')
  const [fQ, setFQ] = useState('')
  const [qDeb, setQDeb] = useState('')
  const [fDateFrom, setFDateFrom] = useState('')
  const [fDateTo, setFDateTo] = useState('')

  // ── detail ──
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TransferT | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailErr, setDetailErr] = useState('')
  const [detailMigr, setDetailMigr] = useState(false)

  // ── nov prenos ──
  const [newOpen, setNewOpen] = useState(false)
  const [newFrom, setNewFrom] = useState('')
  const [newTo, setNewTo] = useState('')
  const [newNote, setNewNote] = useState('')
  const [newLines, setNewLines] = useState<NewLineT[]>([])
  const [newErr, setNewErr] = useState('')
  const [newBusy, setNewBusy] = useState(false)
  const [pickItems, setPickItems] = useState<PickItemT[] | null>(null)
  const [pickBatches, setPickBatches] = useState<PickBatchT[] | null>(null)
  const [pickErr, setPickErr] = useState('')

  // ── odpremitev ──
  const [dispOpen, setDispOpen] = useState(false)
  const [dispNote, setDispNote] = useState('')
  const [dispErr, setDispErr] = useState('')
  const [dispBusy, setDispBusy] = useState(false)

  // ── prevzem ──
  const [recvOpen, setRecvOpen] = useState(false)
  const [recvLines, setRecvLines] = useState<Record<string, RecvLineT>>({})
  const [recvNote, setRecvNote] = useState('')
  const [recvErr, setRecvErr] = useState('')
  const [recvBusy, setRecvBusy] = useState(false)

  // ── preklic ──
  const [cancOpen, setCancOpen] = useState(false)
  const [cancReason, setCancReason] = useState('')
  const [cancErr, setCancErr] = useState('')
  const [cancBusy, setCancBusy] = useState(false)

  /* ── nalaganja ── */

  const loadList = useCallback(async () => {
    setListBusy(true)
    setListErr('')
    try {
      const p = new URLSearchParams()
      if (fStatus !== 'ALL') p.set('status', fStatus)
      if (fFrom !== 'ALL') p.set('fromLocationId', fFrom)
      if (fTo !== 'ALL') p.set('toLocationId', fTo)
      if (qDeb) p.set('q', qDeb)
      if (fDateFrom) p.set('dateFrom', fDateFrom)
      // zgornja meja vključno (strežnik primerja lt — 23:59:59.999 lokalno)
      if (fDateTo) p.set('dateTo', `${fDateTo}T23:59:59.999`)
      p.set('take', '100')
      const d = await api<{ transfers: TransferT[] }>(`/api/transfers?${p.toString()}`)
      setList(d.transfers ?? [])
      setMigrPending(false)
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (isMigrationPendingMsg(msg)) setMigrPending(true)
      else setListErr(msg)
    } finally {
      setListBusy(false)
    }
  }, [fStatus, fFrom, fTo, qDeb, fDateFrom, fDateTo])

  useEffect(() => {
    void loadList()
  }, [loadList, reload])

  // debounce iskanja (q sproži nov fetch šele 350 ms po utihnjenju tipkovnice)
  useEffect(() => {
    const id = setTimeout(() => setQDeb(fQ.trim()), 350)
    return () => clearTimeout(id)
  }, [fQ])

  const loadDetail = useCallback(async (id: string) => {
    setDetailBusy(true)
    setDetailErr('')
    setDetailMigr(false)
    try {
      const d = await api<{ transfer: TransferT }>(`/api/transfers/${id}`)
      setDetail(d.transfer ?? null)
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (isMigrationPendingMsg(msg)) setDetailMigr(true)
      else setDetailErr(msg)
    } finally {
      setDetailBusy(false)
    }
  }, [])

  useEffect(() => {
    if (detailId) void loadDetail(detailId)
    else { setDetail(null); setDetailErr(''); setDetailMigr(false) }
  }, [detailId, loadDetail])

  /** Izbor za nov prenos — lenobno ob odprtju dialoga (en API klic na odprtje). */
  async function loadPickers() {
    setPickErr('')
    try {
      const [inv, bat] = await Promise.all([
        api<{ inventory: PickItemT[] }>('/api/inventory'),
        api<{ batches: PickBatchT[] }>('/api/inventory/batches?take=200&filter=usable'),
      ])
      setPickItems(inv.inventory ?? [])
      setPickBatches(bat.batches ?? [])
    } catch (e) {
      setPickErr(String((e as Error).message || e))
    }
  }

  /* ── nov prenos ── */

  function openNew() {
    // privzeti izvor = trenutna lokacija uporabnika (če je v ponudbi), sicer prva
    const u = typeof window !== 'undefined' ? getUser() : null
    const from = u?.locationId && locations.some((l) => l.id === u.locationId) ? u.locationId : locations[0]?.id || ''
    const to = locations.find((l) => l.id !== from)?.id || ''
    setNewFrom(from)
    setNewTo(to)
    setNewNote('')
    setNewLines([{ itemId: '', qty: '', batchId: '', serOpen: false }])
    setNewErr('')
    setNewOpen(true)
    if (pickItems === null && pickBatches === null) void loadPickers()
  }

  /** Sprememba izvora: postavke so vezane na lokacijo artiklov → počisti izbire. */
  function changeFrom(v: string) {
    setNewFrom(v)
    setNewErr('')
    setNewLines((ls) => ls.map((l) => ({ ...l, itemId: '', batchId: '', serOpen: false })))
    if (newTo === v) setNewTo(locations.find((l) => l.id !== v)?.id || '')
  }

  function addLine() {
    setNewLines((ls) => (ls.length >= MAX_LINES ? ls : [...ls, { itemId: '', qty: '', batchId: '', serOpen: false }]))
  }
  function removeLine(idx: number) {
    setNewLines((ls) => ls.filter((_, i) => i !== idx))
  }
  function updateLine(idx: number, patch: Partial<NewLineT>) {
    setNewLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }
  /** Izbor artikla v vrstici — serija (če je bila izbrana) ne velja več. */
  function pickItem(idx: number, itemId: string) {
    updateLine(idx, { itemId, batchId: '' })
  }

  /** Artikli iz izvorne lokacije z pozitivno zalogo (izbirnik). */
  const fromItems = (pickItems ?? []).filter((i) => i.locationId === newFrom && i.qty > 0)

  /** Serije, ki pripadajo artiklu vrstice (ACTIVE, > 0, ista lokacija ali brez). */
  function batchesFor(itemName: string): PickBatchT[] {
    if (!itemName || !pickBatches) return []
    return pickBatches.filter(
      (b) => b.status === 'ACTIVE' && b.quantityRemaining > 0.0005
        && (b.locationId == null || b.locationId === newFrom)
        && b.itemName === itemName,
    )
  }

  async function createTransfer() {
    if (!newFrom || !newTo) { setNewErr(t('trf.errSameLoc')); return }
    if (newFrom === newTo) { setNewErr(t('trf.errSameLoc')); return }
    if (newLines.length === 0) { setNewErr(t('trf.errLineRequired')); return }
    const seen = new Set<string>()
    const out: { inventoryItemId: string; requestedQty: number; batchId?: string }[] = []
    for (let i = 0; i < newLines.length; i++) {
      const l = newLines[i]
      if (!l.itemId) { setNewErr(t('trf.errItemRequired')); return }
      if (seen.has(l.itemId)) { setNewErr(t('trf.errDupe')); return }
      seen.add(l.itemId)
      const qty = parseNum(l.qty)
      if (!Number.isFinite(qty) || qty <= 0 || r3(qty) !== qty) { setNewErr(t('trf.errQty')); return }
      out.push({ inventoryItemId: l.itemId, requestedQty: r3(qty), ...(l.batchId ? { batchId: l.batchId } : {}) })
    }
    setNewBusy(true)
    setNewErr('')
    try {
      const d = await api<{ transfer: TransferT }>('/api/transfers', {
        method: 'POST',
        body: JSON.stringify({
          fromLocationId: newFrom,
          toLocationId: newTo,
          note: newNote.trim() || undefined,
          // klientski idempotencyKey (ops.ts clientOperationId prag: ≥ 8, ≤ 64)
          idempotencyKey: `trf:${Date.now().toString(36)}:${rand4()}`,
          lines: out,
        }),
      })
      toast({ title: t('trf.saved') })
      setNewOpen(false)
      await loadList()
      if (d.transfer?.id) setDetailId(d.transfer.id)
    } catch (e) {
      setNewErr(mapErr(t, String((e as Error).message || e), 'trf.errCreate'))
    } finally {
      setNewBusy(false)
    }
  }

  /* ── odpremitev / prevzem / preklic ── */

  async function doDispatch() {
    if (!detail) return
    setDispBusy(true)
    setDispErr('')
    try {
      await api(`/api/transfers/${detail.id}/dispatch`, {
        method: 'POST',
        body: JSON.stringify({ note: dispNote.trim() || undefined }),
      })
      toast({ title: t('trf.toastDispatched') })
      setDispOpen(false)
      setDispNote('')
      await loadDetail(detail.id)
      setReload((r) => r + 1)
    } catch (e) {
      setDispErr(mapErr(t, String((e as Error).message || e), 'trf.errDispatch'))
    } finally {
      setDispBusy(false)
    }
  }

  function openReceive() {
    if (!detail?.lines) return
    const pre: Record<string, RecvLineT> = {}
    for (const l of detail.lines) {
      // predloga: vse prejeto, nič poškodovanega (varianco vpiše prejemnik)
      pre[l.id] = { received: String(l.dispatchedQty), damaged: '0', note: '' }
    }
    setRecvLines(pre)
    setRecvNote('')
    setRecvErr('')
    setRecvOpen(true)
  }

  function updateRecvLine(id: string, patch: Partial<RecvLineT>) {
    setRecvLines((ls) => ({ ...ls, [id]: { ...(ls[id] || { received: '0', damaged: '0', note: '' }), ...patch } }))
  }

  async function doReceive() {
    if (!detail?.lines) return
    const out: { transferItemId: string; receivedQty: number; damagedQty: number; note?: string }[] = []
    for (const l of detail.lines) {
      const rl = recvLines[l.id] || { received: '0', damaged: '0', note: '' }
      const rec = parseNum(rl.received)
      const dam = parseNum(rl.damaged)
      if (!Number.isFinite(rec) || !Number.isFinite(dam) || rec < 0 || dam < 0 || r3(rec) !== rec || r3(dam) !== dam) {
        setRecvErr(t('trf.errQty'))
        return
      }
      if (r3(rec + dam) > l.dispatchedQty + 0.0005) {
        setRecvErr(t('trf.errRecvQty'))
        return
      }
      out.push({
        transferItemId: l.id,
        receivedQty: r3(rec),
        damagedQty: r3(dam),
        ...(rl.note.trim() ? { note: rl.note.trim() } : {}),
      })
    }
    setRecvBusy(true)
    setRecvErr('')
    try {
      await api(`/api/transfers/${detail.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ note: recvNote.trim() || undefined, lines: out }),
      })
      toast({ title: t('trf.toastReceived') })
      setRecvOpen(false)
      await loadDetail(detail.id)
      setReload((r) => r + 1)
    } catch (e) {
      setRecvErr(mapErr(t, String((e as Error).message || e), 'trf.errReceive'))
    } finally {
      setRecvBusy(false)
    }
  }

  async function doCancel() {
    if (!detail) return
    if (cancReason.trim().length < 3) { setCancErr(t('trf.reasonShort')); return }
    setCancBusy(true)
    setCancErr('')
    try {
      await api(`/api/transfers/${detail.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancReason.trim() }),
      })
      toast({ title: t('trf.toastCancelled') })
      setCancOpen(false)
      setCancReason('')
      await loadDetail(detail.id)
      setReload((r) => r + 1)
    } catch (e) {
      setCancErr(mapErr(t, String((e as Error).message || e), 'trf.errCancel'))
    } finally {
      setCancBusy(false)
    }
  }

  /* ── izpis ── */

  const migrBox = (retry: () => void) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-amber-800 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {t('trf.migr')}</p>
      <Button size="sm" variant="outline" onClick={retry} className="shrink-0 gap-1 h-11"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
    </div>
  )

  /** Statusna oznaka (barvna mapa po stanju). */
  const statusBadge = (status: string) => {
    const key = STATUS_KEY[status]
    return (
      <Badge variant="outline" className={STATUS_CLS[status] || 'border-stone-300 bg-stone-100 text-stone-700'}>
        {key ? t(key) : status}
      </Badge>
    )
  }

  const canCreate = canManage && locations.length >= 2

  const tr = detail
  /** terminalno stanje = varianca (missing/damaged) je dokončna (8-backend TrfRow) */
  const terminal = tr?.status === 'RECEIVED' || tr?.status === 'PARTIAL'

  return (
    <div className="space-y-4">
      {detailId ? (
        /* ════════════ DETALJ PRENOSA ════════════ */
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" className="h-11 gap-1 px-2" onClick={() => setDetailId(null)} aria-label={t('trf.back')}>
                <ArrowLeft className="w-4 h-4" /> {t('trf.back')}
              </Button>
              <CardTitle className="text-base font-mono">{tr ? tr.transferNumber : '—'}</CardTitle>
              {tr && statusBadge(tr.status)}
            </div>
            {tr && (
              <CardDescription>
                {t('trf.fromTo', { from: locName(tr.fromLocationName), to: locName(tr.toLocationName) })}
                {tr.note ? ` · ${tr.note}` : ''}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {detailBusy && <Skeleton className="h-24 w-full" />}
            {detailMigr && !detailBusy && migrBox(() => detailId && void loadDetail(detailId))}
            {detailErr && !detailBusy && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{t('trf.loadErr')} <span className="text-red-500/80">{detailErr}</span></p>
                <Button size="sm" variant="outline" onClick={() => detailId && void loadDetail(detailId)} className="shrink-0 gap-1 h-11"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            )}

            {tr && !detailBusy && !detailMigr && !detailErr && (
              <>
                {/* ── povzetek ── */}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('trf.requested')}</p>
                    <p className="text-lg font-bold">{fmtQty(sumRequested(tr))}</p>
                    <p className="text-xs text-stone-400">{tr.itemCount} × {t('trf.lines')}</p>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('trf.sumDispatched')}</p>
                    <p className="text-lg font-bold">{fmtQty(sumQty(tr, 'dispatchedQty'))}</p>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('trf.sumReceived')}</p>
                    <p className={`text-lg font-bold ${tr.status === 'PARTIAL' ? 'text-orange-700' : ''}`}>{fmtQty(sumQty(tr, 'receivedQty'))}</p>
                    {tr.variance && tr.variance.damagedQty > 0.0005 && (
                      <p className="text-xs text-amber-700">{t('trf.damaged')}: {fmtQty(tr.variance.damagedQty)}</p>
                    )}
                  </div>
                  <div className={`rounded-xl border p-3 ${
                    tr.variance && (tr.variance.missingQty > 0.0005 || tr.variance.damagedQty > 0.0005)
                      ? 'border-amber-300 bg-amber-50'
                      : 'border-stone-200 bg-stone-50'
                  }`}>
                    <p className="text-xs text-stone-500">{t('trf.variance')}</p>
                    <p className={`text-lg font-bold ${
                      tr.variance && (tr.variance.missingQty > 0.0005 || tr.variance.damagedQty > 0.0005) ? 'text-amber-700' : ''
                    }`}>
                      {tr.variance ? fmtQty(r3(tr.variance.missingQty + tr.variance.damagedQty)) : '—'}
                    </p>
                    {tr.variance && (tr.variance.missingQty > 0.0005 || tr.variance.damagedQty > 0.0005) && (
                      <p className="text-xs text-amber-700">{t('trf.missing')} {fmtQty(tr.variance.missingQty)} · {t('trf.damaged')} {fmtQty(tr.variance.damagedQty)}</p>
                    )}
                  </div>
                </div>

                {tr.variance && (tr.variance.missingQty > 0.0005 || tr.variance.damagedQty > 0.0005) && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {t('trf.varianceNote')}
                  </div>
                )}

                {tr.status === 'DISPATCHED' && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    {t('trf.transitNote')}
                  </div>
                )}

                {/* ── meta ── */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                  <span>{t('trf.created')}: {fmtStamp(tr.createdAt)}</span>
                  {tr.dispatchedAt && <span>{t('trf.dispatchedAt')}: {fmtStamp(tr.dispatchedAt)}</span>}
                  {tr.receivedAt && <span>{t('trf.receivedAt')}: {fmtStamp(tr.receivedAt)}</span>}
                  {tr.cancelledAt && <span>{t('trf.cancelledAt')}: {fmtStamp(tr.cancelledAt)}</span>}
                </div>
                {tr.cancelReason && (
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600">
                    <span className="font-semibold">{t('trf.reason')}:</span> {tr.cancelReason}
                  </div>
                )}

                {/* ── akcije po stanju ── */}
                <div className="flex flex-wrap gap-2">
                  {canManage && tr.status === 'DRAFT' && (
                    <>
                      <Button
                        disabled={dispBusy}
                        onClick={() => { setDispOpen(true); setDispErr('') }}
                        className="h-11 bg-amber-700 hover:bg-amber-800 text-white"
                      >
                        {dispBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} {t('trf.dispatchBtn')}
                      </Button>
                      <Button variant="outline" disabled={cancBusy} onClick={() => { setCancOpen(true); setCancErr('') }} className="h-11 border-red-300 text-red-700 hover:bg-red-50">
                        {cancBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} {t('trf.cancelBtn')}
                      </Button>
                    </>
                  )}
                  {canManage && tr.status === 'DISPATCHED' && (
                    <Button disabled={recvBusy} onClick={openReceive} className="h-11 bg-emerald-700 hover:bg-emerald-800 text-white">
                      {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />} {t('trf.receiveBtn')}
                    </Button>
                  )}
                </div>

                {/* ── postavke ── */}
                {!tr.lines || tr.lines.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('trf.noLines')}</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-stone-200">
                    <table className="w-full min-w-[880px] text-sm">
                      <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('trf.lines')}</th>
                          <th className="p-2 text-right">{t('trf.requested')}</th>
                          <th className="p-2 text-right">{t('trf.dispatched')}</th>
                          <th className="p-2 text-right">{t('trf.received')}</th>
                          <th className="p-2 text-right">{t('trf.damaged')}</th>
                          <th className="p-2 text-right">{t('trf.missing')}</th>
                          <th className="p-2 text-right">{t('trf.cost')}</th>
                          <th className="p-2">{t('trf.lot')}</th>
                          <th className="p-2">{t('trf.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tr.lines.map((l) => {
                          const st = lineState(l, tr.status)
                          return (
                            <tr key={l.id} className="border-t border-stone-100">
                              <td className="p-2 font-medium">
                                {l.itemName}
                                {l.unit ? <span className="block text-xs text-stone-400 font-normal">{l.unit}</span> : null}
                                {l.note ? <span className="block text-xs text-stone-400 font-normal truncate max-w-56" title={l.note}>{l.note}</span> : null}
                              </td>
                              <td className="p-2 text-right whitespace-nowrap">{fmtQty(l.requestedQty)}</td>
                              <td className="p-2 text-right whitespace-nowrap">{l.dispatchedQty > 0.0005 ? fmtQty(l.dispatchedQty) : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{l.receivedQty > 0.0005 ? fmtQty(l.receivedQty) : (l.dispatchedQty > 0.0005 ? '0' : '—')}</td>
                              <td className={`p-2 text-right whitespace-nowrap ${l.damagedQty > 0.0005 ? 'text-amber-700 font-semibold' : ''}`}>{l.damagedQty > 0.0005 ? fmtQty(l.damagedQty) : '—'}</td>
                              {/* manjka = odpremljeno − prejeto − poškodovano (DTO); končno
                                  šele po prevzemu — v tranzitu/osnutku ne sklepamo */}
                              <td className={`p-2 text-right whitespace-nowrap ${terminal && l.missingQty > 0.0005 ? 'text-orange-700 font-semibold' : ''}`}>{terminal && l.missingQty > 0.0005 ? fmtQty(l.missingQty) : '—'}</td>
                              <td className="p-2 text-right whitespace-nowrap">{l.unitCost != null ? fmtEUR(l.unitCost) : '—'}</td>
                              <td className="p-2">
                                <div className="flex flex-wrap gap-1">
                                  {l.lotNumber && <Badge variant="outline" className="font-mono text-xs">{l.lotNumber}</Badge>}
                                  {l.expiryDate && <Badge variant="outline" className="text-xs">{t('trf.expiry')}: {fmtDay(l.expiryDate)}</Badge>}
                                  {!l.lotNumber && !l.expiryDate && <span className="text-stone-400">—</span>}
                                </div>
                              </td>
                              <td className="p-2"><Badge variant="outline" className={LN_CLS[st]}>{t(LN_KEY[st])}</Badge></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        /* ════════════ SEZNAM PRENOSOV ════════════ */
        <Card>
          <CardHeader className="flex-col items-start justify-between gap-2 space-y-0 pb-2 sm:flex-row">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5"><ArrowLeftRight className="w-4 h-4" /> {t('trf.title')}</CardTitle>
              <CardDescription>{t('trf.desc')}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={listBusy} onClick={() => setReload((r) => r + 1)} className="gap-1 h-11">
                {listBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {t('trf.refresh')}
              </Button>
              {canManage && (
                <Button size="sm" disabled={!canCreate} onClick={openNew} title={canCreate ? undefined : t('trf.needTwoLocs')} className="h-11">
                  <Plus className="w-4 h-4" /> {t('trf.new')}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManage && locations.length < 2 && (
              <p className="text-xs text-amber-700">{t('trf.needTwoLocs')}</p>
            )}

            {/* ── filter bara ── */}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-status">{t('trf.status')}</Label>
                <Select value={fStatus} onValueChange={setFStatus}>
                  <SelectTrigger id="trf-f-status" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('trf.all')}</SelectItem>
                    <SelectItem value="DRAFT">{t('trf.st.draft')}</SelectItem>
                    <SelectItem value="DISPATCHED">{t('trf.st.dispatched')}</SelectItem>
                    <SelectItem value="RECEIVED">{t('trf.st.received')}</SelectItem>
                    <SelectItem value="PARTIAL">{t('trf.st.partial')}</SelectItem>
                    <SelectItem value="CANCELLED">{t('trf.st.cancelled')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-from">{t('trf.from')}</Label>
                <Select value={fFrom} onValueChange={setFFrom}>
                  <SelectTrigger id="trf-f-from" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('trf.all')}</SelectItem>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-to">{t('trf.to')}</Label>
                <Select value={fTo} onValueChange={setFTo}>
                  <SelectTrigger id="trf-f-to" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('trf.all')}</SelectItem>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-q">{t('common.search')}</Label>
                <Input id="trf-f-q" className="h-11" value={fQ} onChange={(e) => setFQ(e.target.value)} placeholder={t('trf.search')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-df">{t('trf.dateFrom')}</Label>
                <Input id="trf-f-df" className="h-11" type="date" value={fDateFrom} onChange={(e) => setFDateFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-f-dt">{t('trf.dateTo')}</Label>
                <Input id="trf-f-dt" className="h-11" type="date" value={fDateTo} onChange={(e) => setFDateTo(e.target.value)} />
              </div>
            </div>

            {listBusy && <Skeleton className="h-24 w-full" />}
            {migrPending && !listBusy && migrBox(() => setReload((r) => r + 1))}
            {listErr && !listBusy && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{t('trf.loadErr')} <span className="text-red-500/80">{listErr}</span></p>
                <Button size="sm" variant="outline" onClick={() => setReload((r) => r + 1)} className="shrink-0 gap-1 h-11"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            )}

            {list && !listBusy && !migrPending && list.length === 0 && (
              <p className="text-sm text-stone-500">{t('trf.empty')}</p>
            )}

            {list && !listBusy && !migrPending && list.length > 0 && (
              <>
                {/* Namizna tabela (md+) — horizontalni scroll ZNOTRAJ kartice */}
                <div className="hidden md:block overflow-x-auto rounded-xl border border-stone-200">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                      <tr>
                        <th className="p-2">{t('trf.doc')}</th>
                        <th className="p-2">{t('trf.status')}</th>
                        <th className="p-2">{t('trf.from')} → {t('trf.to')}</th>
                        <th className="p-2 text-right">{t('trf.itemCount')}</th>
                        <th className="p-2 text-right">{t('trf.total')}</th>
                        <th className="p-2 text-right">{t('trf.dispatchedAt')}</th>
                        <th className="p-2 text-right">{t('trf.receivedAt')}</th>
                        <th className="p-2 text-right">{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <tr key={r.id} className="border-t border-stone-100 hover:bg-stone-50/60">
                          <td className="p-2 font-mono text-xs whitespace-nowrap">{r.transferNumber}</td>
                          <td className="p-2">{statusBadge(r.status)}</td>
                          <td className="p-2 whitespace-nowrap">
                            {t('trf.fromTo', { from: locName(r.fromLocationName), to: locName(r.toLocationName) })}
                          </td>
                          <td className="p-2 text-right">{r.itemCount}</td>
                          <td className="p-2 text-right whitespace-nowrap">{fmtQty(sumRequested(r))}</td>
                          <td className="p-2 text-right whitespace-nowrap text-stone-500">{r.dispatchedAt ? fmtStamp(r.dispatchedAt) : '—'}</td>
                          <td className="p-2 text-right whitespace-nowrap text-stone-500">{r.receivedAt ? fmtStamp(r.receivedAt) : '—'}</td>
                          <td className="p-2 text-right">
                            <Button size="sm" variant="outline" className="h-9 px-4" onClick={() => setDetailId(r.id)} aria-label={`${t('trf.open')} ${r.transferNumber}`}>
                              {t('trf.open')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobilne kartice (390 px) — skladne vrstice namesto tabele */}
                <div className="md:hidden space-y-2">
                  {list.map((r) => (
                    <div key={r.id} className="rounded-xl border border-stone-200 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-stone-500">{r.transferNumber}</span>
                        {statusBadge(r.status)}
                      </div>
                      <p className="text-sm font-medium">
                        {t('trf.fromTo', { from: locName(r.fromLocationName), to: locName(r.toLocationName) })}
                      </p>
                      <p className="text-xs text-stone-500">
                        {fmtStamp(r.createdAt)} · {r.itemCount} × {t('trf.lines')} · {t('trf.total')} {fmtQty(sumRequested(r))}
                      </p>
                      <Button size="sm" variant="outline" className="h-11 w-full" onClick={() => setDetailId(r.id)}>
                        {t('trf.open')}
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ════════════ NOV PRENOS ════════════ */}
      <Dialog open={newOpen} onOpenChange={(v) => { setNewOpen(v); if (!v) setNewErr('') }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('trf.newTitle')}</DialogTitle>
            <DialogDescription>{t('trf.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="trf-new-from">{t('trf.from')}</Label>
                <Select value={newFrom} onValueChange={changeFrom}>
                  <SelectTrigger id="trf-new-from" className="h-11"><SelectValue placeholder={t('trf.from')} /></SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="trf-new-to">{t('trf.to')}</Label>
                <Select value={newTo} onValueChange={setNewTo}>
                  <SelectTrigger id="trf-new-to" className="h-11"><SelectValue placeholder={t('trf.to')} /></SelectTrigger>
                  <SelectContent>
                    {locations.filter((l) => l.id !== newFrom).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trf-new-note">{t('trf.note')}</Label>
              <Input id="trf-new-note" className="h-11" maxLength={500} value={newNote} onChange={(e) => setNewNote(e.target.value)} />
            </div>

            {pickErr && <p className="text-sm text-red-600" role="alert">{pickErr}</p>}
            {pickItems === null && <Skeleton className="h-16 w-full" />}
            {pickItems !== null && fromItems.length === 0 && (
              <p className="text-sm text-stone-500">{t('trf.noSourceItems')}</p>
            )}

            {pickItems !== null && (
              <div className="space-y-2">
                {newLines.map((l, i) => {
                  const item = fromItems.find((it) => it.id === l.itemId)
                  const itemBatches = item ? batchesFor(item.name) : []
                  const batch = l.batchId ? itemBatches.find((b) => b.id === l.batchId) : undefined
                  const qty = parseNum(l.qty)
                  const over = item && Number.isFinite(qty) && qty > item.qty + 0.0005
                  return (
                    <div key={i} className="rounded-lg border border-stone-200 p-2.5 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_auto] gap-2 items-end">
                        <div className="space-y-1">
                          <Label htmlFor={`trf-item-${i}`} className="text-xs text-stone-500">{t('trf.lines')} {i + 1}</Label>
                          {/* value je VEDNO nadzorovan ('' = brez izbire → placeholder;
                              Radix: item vrednosti so neprazne, korenska vrednost sme biti '') */}
                          <Select value={l.itemId} onValueChange={(v) => pickItem(i, v)}>
                            <SelectTrigger id={`trf-item-${i}`} className="h-11"><SelectValue placeholder={t('trf.pickItem')} /></SelectTrigger>
                            <SelectContent>
                              {fromItems
                                .filter((it) => it.id === l.itemId || !newLines.some((x) => x.itemId === it.id))
                                .map((it) => (
                                  <SelectItem key={it.id} value={it.id}>
                                    {t('trf.itemLabel', { name: it.name, qty: fmtQty(it.qty), unit: it.unit || t('trf.unit') })}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`trf-qty-${i}`} className="text-xs text-stone-500">
                            {t('trf.qty')}{item?.unit ? ` (${item.unit})` : ''}
                          </Label>
                          <Input
                            id={`trf-qty-${i}`}
                            className="h-11"
                            inputMode="decimal"
                            step="0.001"
                            min="0.001"
                            value={l.qty}
                            onChange={(e) => updateLine(i, { qty: e.target.value.replace(',', '.') })}
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-11 w-11 p-0 text-stone-400 hover:text-red-700"
                          onClick={() => removeLine(i)}
                          aria-label={t('trf.removeLine')}
                          title={t('trf.removeLine')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>

                      {item && (
                        <p className="text-xs text-stone-400">
                          {t('trf.available')}: {fmtQty(item.qty)} {item.unit || t('trf.unit')} · {t('trf.cost')}: {fmtEUR(item.cost || 0)}
                          {over ? <span className="block text-amber-700">{t('trf.qtyOver')}</span> : null}
                        </p>
                      )}

                      {/* serija (razširljiv odsek — neobvezno) */}
                      <Collapsible open={l.serOpen} onOpenChange={(v) => updateLine(i, { serOpen: v })}>
                        <CollapsibleTrigger asChild>
                          <button type="button" className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 min-h-11 py-1" aria-expanded={l.serOpen}>
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${l.serOpen ? 'rotate-180' : ''}`} />
                            {t('trf.batchSection')}
                          </button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-1">
                          <div className="space-y-1.5">
                            <Select value={l.batchId || 'NONE'} onValueChange={(v) => updateLine(i, { batchId: v === 'NONE' ? '' : v })}>
                              <SelectTrigger id={`trf-batch-${i}`} className="h-11" aria-label={t('trf.batchSection')}><SelectValue placeholder={t('trf.pickBatch')} /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="NONE">{t('trf.batchNone')}</SelectItem>
                                {itemBatches.map((b) => (
                                  <SelectItem key={b.id} value={b.id}>
                                    {b.lotNumber} · {fmtQty(b.quantityRemaining)} {t('trf.available')}{b.expiryDate ? ` · ${t('trf.expiry')}: ${fmtDay(b.expiryDate)}` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {item && itemBatches.length === 0 && (
                              <p className="text-xs text-stone-400">{t('trf.batchesNone')}</p>
                            )}
                            {batch && (
                              <div className="flex flex-wrap gap-1">
                                {batch.lotNumber && <Badge variant="outline" className="font-mono text-xs">{batch.lotNumber}</Badge>}
                                {batch.expiryDate && <Badge variant="outline" className="text-xs">{t('trf.expiry')}: {fmtDay(batch.expiryDate)}</Badge>}
                              </div>
                            )}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  )
                })}

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={newLines.length >= MAX_LINES} onClick={addLine} className="h-11">
                    <Plus className="w-3.5 h-3.5" /> {t('trf.addLine')}
                  </Button>
                  {newLines.length >= MAX_LINES && <p className="text-xs text-amber-700">{t('trf.lineMax')}</p>}
                </div>
              </div>
            )}

            {newErr && <p className="text-sm text-red-600" role="alert">{newErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={newBusy} onClick={() => setNewOpen(false)} className="h-11">{t('common.cancel')}</Button>
            <Button disabled={newBusy} onClick={() => void createTransfer()} className="h-11">
              {newBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('trf.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════ ODPREMNICA (AlertDialog) ════════════ */}
      <AlertDialog open={dispOpen} onOpenChange={(v) => { setDispOpen(v); if (!v) setDispErr('') }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('trf.dispatchTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('trf.dispatchDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            {detail?.lines && detail.lines.length > 0 && (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-2.5 text-sm space-y-1 max-h-48 overflow-y-auto">
                {detail.lines.map((l) => (
                  <p key={l.id} className="flex justify-between gap-2">
                    <span className="truncate">{l.itemName}</span>
                    <span className="font-semibold whitespace-nowrap">{fmtQty(l.requestedQty)} {l.unit}</span>
                  </p>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="trf-disp-note">{t('trf.dispatchNote')}</Label>
              <Textarea id="trf-disp-note" rows={3} maxLength={500} value={dispNote} onChange={(e) => setDispNote(e.target.value)} />
            </div>
            {dispErr && <p className="text-sm text-red-600" role="alert">{dispErr}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispBusy} className="h-11">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-amber-700 hover:bg-amber-800 text-white"
              disabled={dispBusy}
              onClick={(e) => { e.preventDefault(); void doDispatch() }}
            >
              {dispBusy && <Loader2 className="w-4 h-4 animate-spin" />} <Truck className="w-4 h-4" /> {t('trf.dispatchBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ════════════ PREVZEM (per-postavka) ════════════ */}
      <Dialog open={recvOpen} onOpenChange={(v) => { setRecvOpen(v); if (!v) setRecvErr('') }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('trf.receiveTitle', { n: tr?.transferNumber || '' })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {t('trf.receiveHint')}
            </div>
            {tr?.lines?.map((l) => {
              const rl = recvLines[l.id] || { received: '0', damaged: '0', note: '' }
              const rec = parseNum(rl.received)
              const dam = parseNum(rl.damaged)
              const miss = Number.isFinite(rec) && Number.isFinite(dam) ? r3(Math.max(0, l.dispatchedQty - rec - dam)) : null
              return (
                <div key={l.id} className="rounded-lg border border-stone-200 bg-stone-50 p-2.5">
                  <p className="text-sm font-medium">{l.itemName}</p>
                  <p className="text-xs text-stone-500 mb-2">
                    {t('trf.dispatched')}: {fmtQty(l.dispatchedQty)} {l.unit}
                    {l.lotNumber ? ` · ${t('trf.lot')}: ${l.lotNumber}` : ''}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3 items-end">
                    <div className="space-y-1">
                      <Label htmlFor={`trf-recv-${l.id}`} className="text-xs text-stone-500">{t('trf.received')}</Label>
                      <Input
                        id={`trf-recv-${l.id}`}
                        className="h-11"
                        inputMode="decimal"
                        value={rl.received}
                        onChange={(e) => updateRecvLine(l.id, { received: e.target.value.replace(',', '.') })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`trf-dmg-${l.id}`} className="text-xs text-stone-500">{t('trf.damaged')}</Label>
                      <Input
                        id={`trf-dmg-${l.id}`}
                        className="h-11"
                        inputMode="decimal"
                        value={rl.damaged}
                        onChange={(e) => updateRecvLine(l.id, { damaged: e.target.value.replace(',', '.') })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`trf-lnote-${l.id}`} className="text-xs text-stone-500">{t('trf.lineNote')}</Label>
                      <Input
                        id={`trf-lnote-${l.id}`}
                        className="h-11"
                        maxLength={500}
                        value={rl.note}
                        onChange={(e) => updateRecvLine(l.id, { note: e.target.value })}
                      />
                    </div>
                  </div>
                  {miss != null && miss > 0.0005 && (
                    <p className="text-xs text-amber-700 mt-1">{t('trf.missing')}: {fmtQty(miss)} {l.unit}</p>
                  )}
                </div>
              )
            })}
            <div className="space-y-1.5">
              <Label htmlFor="trf-recv-note">{t('trf.recvNote')}</Label>
              <Input id="trf-recv-note" className="h-11" maxLength={500} value={recvNote} onChange={(e) => setRecvNote(e.target.value)} />
            </div>
            {recvErr && <p className="text-sm text-red-600" role="alert">{recvErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={recvBusy} onClick={() => setRecvOpen(false)} className="h-11">{t('common.cancel')}</Button>
            <Button disabled={recvBusy} onClick={() => void doReceive()} className="h-11 bg-emerald-700 hover:bg-emerald-800 text-white">
              {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />} {t('trf.receiveBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════ PREKLIC (razlog ≥ 3) ════════════ */}
      <Dialog open={cancOpen} onOpenChange={(v) => { setCancOpen(v); if (!v) setCancErr('') }}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('trf.cancelTitle')}</DialogTitle>
            <DialogDescription>{t('trf.cancelDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="trf-canc-reason">{t('trf.reason')}</Label>
              <Textarea id="trf-canc-reason" rows={3} maxLength={500} value={cancReason} onChange={(e) => setCancReason(e.target.value)} placeholder={t('trf.reasonPh')} />
            </div>
            {cancErr && <p className="text-sm text-red-600" role="alert">{cancErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={cancBusy} onClick={() => setCancOpen(false)} className="h-11">{t('common.cancel')}</Button>
            <Button disabled={cancBusy} onClick={() => void doCancel()} variant="outline" className="h-11 border-red-300 text-red-700 hover:bg-red-50">
              {cancBusy && <Loader2 className="w-4 h-4 animate-spin" />} <Ban className="w-4 h-4" /> {t('trf.cancelBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ─────────────────────────── POMOČNIKI VSTOPA (modul) ─────────────────────────── */

/** Vsota zahtevanih količin (seznam vključuje vrstice; fallback 0). */
function sumRequested(tr: TransferT): number {
  return r3((tr.lines ?? []).reduce((s, l) => s + l.requestedQty, 0))
}

/** Vsota izbrane količne kolone čez vrstice. */
function sumQty(tr: TransferT, key: 'dispatchedQty' | 'receivedQty'): number {
  return r3((tr.lines ?? []).reduce((s, l) => s + l[key], 0))
}
