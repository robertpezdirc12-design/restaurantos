'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { api, fmtEUR, downloadCSV, getToken } from '@/lib/client'
import { newOperationId } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, Legend, BarChart, Bar,
} from 'recharts'
import { Loader2, Plug, RefreshCw, PackageSearch, Clock, Thermometer, Wallet, HeartHandshake, TrendingUp, AlertTriangle, Truck, UtensilsCrossed, Star, Briefcase, Store, MonitorSmartphone, ShieldAlert, Plus, Bell, UserCheck, Trash2, Hourglass, LogIn, LogOut, Coffee, CheckCircle2, XCircle, Timer, CalendarClock, CalendarDays, Percent, Ticket, Pencil, RotateCcw, Building2, Link2, ClipboardList, Database, ChevronDown, Eye, FileUp, Repeat, Zap, Layers, Paperclip, Download } from 'lucide-react'
import { deltaArrow } from '@/lib/xz-report'
import { heatClass } from '@/lib/sales-by-hour'
import { durationLabel } from '@/lib/timeclock'
import { scaleBatchLines } from '@/lib/batch'
import { dueInMs, isRemindable, remindMsForRule } from '@/lib/recurring-po'
import { PUSH_EVENT_TYPES } from '@/lib/push-events'
import { isAdInWindow, isValidDateStr } from '@/lib/display-promos'

/* ─────────────────────────── ZALOGE ─────────────────────────── */

import { DursCheckButton } from './ops-cards'

/*
 * AUDIT-FIX v1.82.1 — prvi val razreza monolita dashboard-tabs.tsx: NABAVA tab
 * (dobavitelji → naročila → prevzem → eSLOG uvoz → ponavljajoča naročila), ~1380 vrst.
 */


interface NabavaSupplier {
  id: string; name: string; contact?: string | null; phone?: string | null; email?: string | null; address?: string | null
  code?: string | null; city?: string | null; country?: string | null; taxId?: string | null; iban?: string | null; paymentTerms?: string | null
  isActive: boolean; purchaseOrdersCount: number; itemsCount: number
}
interface NabavaInvItem { id: string; name: string; unit: string; qty: number; minQty: number; cost: number; locationId?: string | null }
interface NabavaPoItem { id: string; description: string; quantityOrdered: number; quantityReceived: number; quantityRejected: number; unit: string; unitPrice: number; vatRate: number; totalPrice: number; status: string; inventoryItemId?: string | null }
interface NabavaPo {
  id: string; poNumber: string; status: string; supplierId: string; supplierName: string
  orderDate: string; expectedDate?: string | null; receivedDate?: string | null
  subtotal: number; vatAmount: number; totalAmount: number; locationId?: string | null
  notes?: string | null; requestedBy?: string | null; approvedBy?: string | null
  receiptsCount: number; items: NabavaPoItem[]
}
interface NabavaPoDetail {
  id: string; poNumber: string; status: string
  supplier?: { id: string; name: string; contactPerson?: string | null; email?: string | null; phone?: string | null } | null
  orderDate: string; expectedDate?: string | null; receivedDate?: string | null
  subtotal: number; vatAmount: number; totalAmount: number; notes?: string | null
  requestedBy?: string | null; approvedBy?: string | null
  items: NabavaPoItem[]
  receipts: { id: string; grnNumber: string; status: string; supplierDocNumber?: string | null; notes?: string | null; receivedByName?: string | null; receivedAt?: string | null; items: { description: string; quantityAccepted: number; quantityRejected: number; rejectReason?: string | null; unit: string }[] }[]
  priceHistory: { inventoryItemId: string | null; unitPrice: number; vatRate: number | null; unit: string; source: string; observedAt: string }[]
}
interface NabavaSupForm { editingId: string | null; name: string; contact: string; phone: string; email: string; address: string; city: string; taxId: string; iban: string; paymentTerms: string }
interface NabavaNewLine { inventoryItemId: string; description: string; quantity: string; unit: string; unitPrice: string; vatRate: string }
interface NabavaRecvLine { accept: string; reject: string; reason: string; expiry: string }
interface NabavaSuggestion { itemId: string; itemName: string; unit: string; qty: number; par: number; incoming: number; suggested: number; supplierId: string | null; supplierName: string; costEstimate: number }
interface NabavaSuggGroup { supplierId: string | null; supplierName: string; items: NabavaSuggestion[]; total: number }
/** issue #12 — consumption-based recommendation (server shape, src/lib/reorder-recommend.ts). */
interface NabavaRec {
  itemId: string; itemName: string; unit: string; verdict: 'RECOMMEND' | 'WATCH'
  onHand: number; incoming: number; avgDailyUse: number
  leadTimeDays: number; safetyStock: number; reorderPoint: number; reviewDays: number
  targetQty: number; needQty: number; suggestedPacks: number; suggestedQty: number; estCost: number
  supplierId: string | null; supplierName: string
  coverageDays: number | null; stockoutDate: string | null
  flags: { noHistory: boolean; noLeadTime: boolean; noSupplier: boolean; belowPar: boolean }
}
interface NabavaRecGroup { supplierId: string | null; supplierName: string; items: NabavaRec[]; total: number }
interface NabavaRecsPayload {
  recommendations: NabavaRec[]; groupedBySupplier: NabavaRecGroup[]; watch: NabavaRec[]
  summary: { windowDays: number; reviewDays: number; computedAt: string; itemsConsidered: number; recommend: number; watch: number; estTotal: number; skipped?: number }
}
/** OPS-9 val 2 — recurring PO rule (server shape, src/lib/recurring-po.ts). */
interface RecRuleT {
  id: string; supplierId: string
  items: { inventoryItemId: string; qty: number }[]
  weekdays: number[]; hour: number; everyWeeks: number
  active: boolean; lastRun: string | null; nextRun: string | null
  /** OPS-10 val 3 — reminder lead time (minutes; server normalizes, default 60) */
  remindMinutesBefore?: number
}
/** Display order for weekday toggles: Monday-first (0 = Sunday, JS getDay). */
const REC_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const NABAVA_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'proc.stDraft', cls: 'border-stone-300 bg-stone-100 text-stone-700' },
  submitted: { label: 'proc.stSubmitted', cls: 'border-amber-300 bg-amber-100 text-amber-800' },
  approved: { label: 'proc.stApproved', cls: 'border-emerald-300 bg-emerald-100 text-emerald-800' },
  partial: { label: 'proc.stPartial', cls: 'border-orange-300 bg-orange-100 text-orange-800' },
  received: { label: 'proc.stReceived', cls: 'border-green-300 bg-green-100 text-green-800' },
  cancelled: { label: 'proc.stCancelled', cls: 'border-red-300 bg-red-100 text-red-700' },
}
const NABAVA_ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'proc.itPending', cls: 'border-stone-300 text-stone-600' },
  partial: { label: 'proc.itPartial', cls: 'border-orange-300 bg-orange-50 text-orange-800' },
  received: { label: 'proc.itReceived', cls: 'border-green-300 bg-green-50 text-green-800' },
}

const nabavaNum = (s: string): number => {
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
const nabavaDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('sl-SI') : '—')

export function NabavaTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useI18n()
  const [suppliers, setSuppliers] = useState<NabavaSupplier[]>([])
  const [invItems, setInvItems] = useState<NabavaInvItem[]>([])
  const [orders, setOrders] = useState<NabavaPo[]>([])
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // — Dobavitelji (dodaj / uredi) —
  const [supDialog, setSupDialog] = useState<NabavaSupForm | null>(null)
  const [supBusy, setSupBusy] = useState(false)
  const [supErr, setSupErr] = useState('')

  // — Novo nabavno naročilo —
  const [poDialog, setPoDialog] = useState(false)
  const [poSupplierId, setPoSupplierId] = useState('')
  const [poLocationId, setPoLocationId] = useState('')
  const [poExpected, setPoExpected] = useState('')
  const [poNotes, setPoNotes] = useState('')
  const [poLines, setPoLines] = useState<NabavaNewLine[]>([])
  const [poBusy, setPoBusy] = useState(false)
  const [poErr, setPoErr] = useState('')

  // — Detajl naročila —
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<NabavaPoDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailErr, setDetailErr] = useState('')

  // — Prevzem (GRN) —
  const [recvOrder, setRecvOrder] = useState<NabavaPo | null>(null)
  const [recvLines, setRecvLines] = useState<Record<string, NabavaRecvLine>>({})
  const [recvDoc, setRecvDoc] = useState('')
  const [recvNotes, setRecvNotes] = useState('')
  const [recvBusy, setRecvBusy] = useState(false)
  const [recvErr, setRecvErr] = useState('')
  const [recvDone, setRecvDone] = useState<{ grnNumber: string; warnings: string[] } | null>(null)

  // — Reorder suggestions (OPS-8 val 2) —
  const [suggGroups, setSuggGroups] = useState<NabavaSuggGroup[]>([])
  const [suggLoading, setSuggLoading] = useState(true)
  const [suggErr, setSuggErr] = useState('')

  // — Consumption-based recommendations (issue #12) —
  const [recs, setRecs] = useState<NabavaRecsPayload | null>(null)
  const [recsLoading, setRecsLoading] = useState(true)
  const [recsErr, setRecsErr] = useState('')
  const [recsApplyBusy, setRecsApplyBusy] = useState(false)

  // — eSLOG e-invoice import (OPS-9 val 2) —
  const [eslogFile, setEslogFile] = useState<File | null>(null)
  const [eslogBusy, setEslogBusy] = useState(false)
  const [eslogResult, setEslogResult] = useState<{ apNumber: string; supplierName: string; totalAmount: number; dueDate: string; lines: number } | null>(null)
  const [eslogWarn, setEslogWarn] = useState<{ error: string; supplierName?: string; taxId?: string } | null>(null)
  const [eslogDup, setEslogDup] = useState('')

  // — Recurring purchase orders (OPS-9 val 2) —
  const [recRules, setRecRules] = useState<RecRuleT[]>([])
  const [recLoading, setRecLoading] = useState(true)
  const [recBusy, setRecBusy] = useState(false)
  const [recErr, setRecErr] = useState('')
  const [recDialog, setRecDialog] = useState(false)
  const [recSupplierId, setRecSupplierId] = useState('')
  const [recItemId, setRecItemId] = useState('')
  const [recItems, setRecItems] = useState<{ inventoryItemId: string; name: string; qty: string }[]>([])
  const [recWeekdays, setRecWeekdays] = useState<number[]>([1])
  const [recHour, setRecHour] = useState('8')
  const [recEvery, setRecEvery] = useState('1')
  const recTriggered = useRef(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [s, inv, o, sg, rc] = await Promise.all([
          api<{ suppliers: NabavaSupplier[] }>('/api/suppliers'),
          api<{ inventory: NabavaInvItem[] }>('/api/inventory'),
          api<{ orders: NabavaPo[] }>('/api/purchase-orders'),
          api<{ groupedBySupplier: NabavaSuggGroup[] }>('/api/purchase-orders/suggestions').catch(() => ({ groupedBySupplier: [] as NabavaSuggGroup[] })),
          api<NabavaRecsPayload>('/api/purchase-orders/recommendations').catch((e) => { setRecsErr(String((e as Error).message || e)); return null }),
        ])
        if (!alive) return
        setSuppliers(s.suppliers || [])
        setInvItems(inv.inventory || [])
        setOrders(o.orders || [])
        setSuggGroups(sg.groupedBySupplier || [])
        if (rc) setRecs(rc)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) { setLoading(false); setSuggLoading(false); setRecsLoading(false) }
      }
    })()
    return () => { alive = false }
  }, [])

  const loadOrders = async () => {
    const o = await api<{ orders: NabavaPo[] }>('/api/purchase-orders')
    setOrders(o.orders || [])
  }
  const loadSuppliers = async () => {
    const s = await api<{ suppliers: NabavaSupplier[] }>('/api/suppliers')
    setSuppliers(s.suppliers || [])
  }
  /* OPS-9 val 2 — recurring rules list */
  const loadRecRules = async () => {
    const r = await api<{ rules: RecRuleT[] }>('/api/recurring-po')
    setRecRules(r.rules || [])
  }
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await loadRecRules()
      } catch (e) {
        if (alive) setRecErr(String((e as Error).message || e))
      } finally {
        if (alive) setRecLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])
  /* OPS-9 val 2 — lazy trigger: evaluate due recurring rules once per tab mount.
   * Fire-and-forget; when drafts were created the order list refreshes silently.
   * Users without inventory.manage get a silent 403 here (best-effort by design). */
  useEffect(() => {
    if (recTriggered.current) return
    recTriggered.current = true
    api<{ created: { poNumber: string }[]; skipped: number }>('/api/purchase-orders/run-recurring', { method: 'POST', body: JSON.stringify({}) })
      .then((r) => { if (r.created?.length) void loadOrders() })
      .catch(() => { /* best-effort — the explicit "run now" button reports errors */ })
  }, [])
  const fetchDetail = async (id: string) => {
    setDetailBusy(true); setDetailErr('')
    try {
      const d = await api<{ order: NabavaPoDetail }>(`/api/purchase-orders/${id}`)
      setDetail(d.order)
    } catch (e) {
      setDetailErr(String((e as Error).message || e))
    } finally {
      setDetailBusy(false)
    }
  }
  const openDetail = (id: string) => { setDetail(null); setDetailId(id); fetchDetail(id) }

  /* statusni prehodi naročila: oddaja / odobritev / preklic */
  const poAction = async (id: string, action: 'submit' | 'approve' | 'cancel') => {
    if (action === 'cancel' && !window.confirm(t('proc.cancelConfirm'))) return
    setBusy(true); setErr(''); setOkMsg('')
    try {
      await api(`/api/purchase-orders/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      setOkMsg(action === 'submit' ? t('proc.msgSubmitted') : action === 'approve' ? t('proc.msgApproved') : t('proc.msgCancelled'))
      await loadOrders()
      if (detailId === id) await fetchDetail(id)
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  /* — dobavitelji — */
  const openSupDialog = (s?: NabavaSupplier) => {
    setSupErr('')
    setSupDialog(s
      ? { editingId: s.id, name: s.name, contact: s.contact || '', phone: s.phone || '', email: s.email || '', address: s.address || '', city: s.city || '', taxId: s.taxId || '', iban: s.iban || '', paymentTerms: s.paymentTerms || '' }
      : { editingId: null, name: '', contact: '', phone: '', email: '', address: '', city: '', taxId: '', iban: '', paymentTerms: '' })
  }
  const saveSupplier = async () => {
    if (!supDialog) return
    if (!supDialog.name.trim()) { setSupErr(t('proc.supNameRequired')); return }
    setSupBusy(true); setSupErr('')
    const body = {
      name: supDialog.name.trim(),
      contact: supDialog.contact.trim(),
      phone: supDialog.phone.trim(),
      email: supDialog.email.trim(),
      address: supDialog.address.trim(),
      city: supDialog.city.trim(),
      taxId: supDialog.taxId.trim(),
      iban: supDialog.iban.trim(),
      paymentTerms: supDialog.paymentTerms.trim(),
    }
    try {
      if (supDialog.editingId) {
        await api('/api/suppliers', { method: 'PATCH', body: JSON.stringify({ id: supDialog.editingId, ...body }) })
        setOkMsg(t('proc.supUpdated'))
      } else {
        await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) })
        setOkMsg(t('proc.supAdded'))
      }
      setSupDialog(null)
      await loadSuppliers()
    } catch (e) {
      setSupErr(String((e as Error).message || e))
    } finally {
      setSupBusy(false)
    }
  }

  /* — novo naročilo — */
  const openPoDialog = () => {
    setPoSupplierId(suppliers.find((s) => s.isActive)?.id || '')
    setPoLocationId(''); setPoExpected(''); setPoNotes(''); setPoLines([]); setPoErr('')
    setPoDialog(true)
  }
  /* OPS-8 val 2 — prefill PO creator from a suggestion group (per supplier) */
  const openPoDialogPrefilled = (group: NabavaSuggGroup) => {
    if (!group.supplierId) return
    setPoSupplierId(group.supplierId)
    setPoLocationId(''); setPoExpected(''); setPoNotes(''); setPoErr('')
    setPoLines(group.items.map((s) => {
      const inv = invItems.find((i) => i.id === s.itemId)
      return {
        inventoryItemId: s.itemId,
        description: s.itemName,
        quantity: String(s.suggested),
        unit: s.unit || inv?.unit || 'kos',
        unitPrice: inv && inv.cost > 0 ? String(inv.cost) : '',
        vatRate: '22',
      }
    }))
    setPoDialog(true)
  }
  /* issue #12 — convert a recommendation group into a DRAFT PO: the server
   * does the pack math + SupplierItem pricing; the human then reviews and
   * submits the draft (a draft is NOT a confirmed incoming delivery). */
  const applyRecommendationGroup = async (g: NabavaRecGroup) => {
    if (!g.supplierId || g.items.length === 0) return
    setRecsApplyBusy(true); setRecsErr('')
    try {
      const r = await api<{ order: { poNumber: string } }>('/api/purchase-orders/recommendations/apply', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: g.supplierId,
          notes: t('recs.poNote'),
          lines: g.items.filter((s) => s.suggestedPacks > 0).map((s) => ({ inventoryItemId: s.itemId, packs: s.suggestedPacks })),
        }),
      })
      toast({ title: t('recs.created', { po: r.order.poNumber }) })
      await loadOrders()
      const rc = await api<NabavaRecsPayload>('/api/purchase-orders/recommendations').catch(() => null)
      if (rc) setRecs(rc)
    } catch (e) {
      setRecsErr(String((e as Error).message || e))
    } finally {
      setRecsApplyBusy(false)
    }
  }
  const addPoLineFromInventory = (invId: string) => {
    if (!invId) return
    const it = invItems.find((i) => i.id === invId)
    if (!it || poLines.some((l) => l.inventoryItemId === invId)) return
    setPoLines((ls) => [...ls, { inventoryItemId: it.id, description: it.name, quantity: '', unit: it.unit, unitPrice: it.cost > 0 ? String(it.cost) : '', vatRate: '22' }])
  }
  const addManualPoLine = () => {
    setPoLines((ls) => [...ls, { inventoryItemId: '', description: '', quantity: '', unit: 'kos', unitPrice: '', vatRate: '22' }])
  }
  const updatePoLine = (idx: number, patch: Partial<NabavaNewLine>) => {
    setPoLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }
  const removePoLine = (idx: number) => setPoLines((ls) => ls.filter((_, i) => i !== idx))
  const poLineNet = (l: NabavaNewLine) => {
    const q = nabavaNum(l.quantity), p = nabavaNum(l.unitPrice)
    return Number.isFinite(q) && Number.isFinite(p) ? q * p : 0
  }
  const poLineVat = (l: NabavaNewLine) => {
    const v = nabavaNum(l.vatRate)
    return (poLineNet(l) * (Number.isFinite(v) ? v : 0)) / 100
  }
  const poSubtotal = poLines.reduce((s, l) => s + poLineNet(l), 0)
  const poVatTotal = poLines.reduce((s, l) => s + poLineVat(l), 0)

  const savePo = async () => {
    if (!poSupplierId) { setPoErr(t('proc.chooseSupplierErr')); return }
    if (poLines.length === 0) { setPoErr(t('proc.addLineRequired')); return }
    for (let i = 0; i < poLines.length; i++) {
      const l = poLines[i]
      if (!l.inventoryItemId && !l.description.trim()) { setPoErr(t('proc.lineDescRequired', { n: i + 1 })); return }
      const q = nabavaNum(l.quantity)
      if (!Number.isFinite(q) || q <= 0) { setPoErr(t('proc.lineQtyRequired', { n: i + 1 })); return }
      const p = nabavaNum(l.unitPrice)
      if (!Number.isFinite(p) || p < 0) { setPoErr(t('proc.linePriceRequired', { n: i + 1 })); return }
    }
    setPoBusy(true); setPoErr('')
    try {
      await api('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId,
          locationId: poLocationId || undefined,
          expectedDate: poExpected || undefined,
          notes: poNotes.trim() || undefined,
          lines: poLines.map((l) => ({
            inventoryItemId: l.inventoryItemId || undefined,
            description: l.inventoryItemId ? undefined : l.description.trim(),
            quantity: nabavaNum(l.quantity),
            unit: l.unit.trim() || undefined,
            unitPrice: nabavaNum(l.unitPrice),
            vatRate: nabavaNum(l.vatRate) || undefined,
          })),
        }),
      })
      setPoDialog(false); setPoLines([]); setOkMsg(t('proc.poCreated'))
      await loadOrders()
    } catch (e) {
      setPoErr(String((e as Error).message || e))
    } finally {
      setPoBusy(false)
    }
  }

  /* — prevzem (GRN) — */
  const openReceive = (o: NabavaPo) => {
    const lines: Record<string, NabavaRecvLine> = {}
    for (const it of o.items) {
      const remaining = Math.max(0, it.quantityOrdered - it.quantityReceived)
      lines[it.id] = { accept: remaining > 0 ? String(remaining) : '0', reject: '0', reason: '', expiry: '' }
    }
    setRecvOrder(o); setRecvLines(lines); setRecvDoc(''); setRecvNotes(''); setRecvErr(''); setRecvDone(null)
  }
  const updateRecvLine = (id: string, patch: Partial<NabavaRecvLine>) => {
    setRecvLines((ls) => ({ ...ls, [id]: { ...(ls[id] || { accept: '0', reject: '0', reason: '', expiry: '' }), ...patch } }))
  }
  const submitReceive = async () => {
    if (!recvOrder) return
    const payloadLines: { purchaseOrderItemId: string; quantityAccepted: number; quantityRejected: number; rejectReason?: string; expiryDate?: string }[] = []
    for (const it of recvOrder.items) {
      const l = recvLines[it.id] || { accept: '0', reject: '0', reason: '', expiry: '' }
      const a = nabavaNum(l.accept), r = nabavaNum(l.reject)
      if (!Number.isFinite(a) || a < 0 || !Number.isFinite(r) || r < 0) { setRecvErr(t('proc.lineQtyNumbers', { name: it.description })); return }
      if (a === 0 && r === 0) continue
      if (r > 0 && !l.reason.trim()) { setRecvErr(t('proc.lineReasonRequired', { name: it.description })); return }
      payloadLines.push({
        purchaseOrderItemId: it.id,
        quantityAccepted: a,
        quantityRejected: r,
        rejectReason: r > 0 ? l.reason.trim() : undefined,
        expiryDate: l.expiry || undefined,
      })
    }
    if (payloadLines.length === 0) { setRecvErr(t('proc.enterQty')); return }
    setRecvBusy(true); setRecvErr('')
    try {
      const res = await api<{ receipt: { id: string; grnNumber: string; status: string; poStatus: string; warnings?: string[] } }>(`/api/purchase-orders/${recvOrder.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ supplierDocNumber: recvDoc.trim() || undefined, notes: recvNotes.trim() || undefined, lines: payloadLines }),
      })
      setRecvDone({ grnNumber: res.receipt.grnNumber, warnings: res.receipt.warnings || [] })
      await loadOrders()
      if (detailId === recvOrder.id) await fetchDetail(recvOrder.id)
    } catch (e) {
      setRecvErr(String((e as Error).message || e))
    } finally {
      setRecvBusy(false)
    }
  }

  /* — eSLOG e-račun uvoz (OPS-9 val 2) —
   * raw fetch instead of api(): the 422 body carries the parsed invoice
   * (supplier name/taxId) for the inline "create the supplier first" hint. */
  const importEslog = async () => {
    if (!eslogFile) return
    setEslogBusy(true); setEslogWarn(null); setEslogDup(''); setEslogResult(null)
    try {
      const xml = await eslogFile.text()
      const token = getToken()
      const res = await fetch('/api/ap/import-eslog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ xml }),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string; duplicate?: boolean
        ap?: { apNumber: string; dueDate: string; totalAmount: number }
        supplier?: { id: string; name: string }
        parsed?: { lines: unknown[]; supplier: { name: string; taxId: string } } | null
      }
      if (res.status === 422) {
        const tax = data?.parsed?.supplier?.taxId || ''
        const name = data?.parsed?.supplier?.name || ''
        setEslogWarn({ error: tax ? t('eslog.errSupplier', { tax, name }) : String(data.error || t('common.error')), supplierName: name, taxId: tax })
        return
      }
      if (!res.ok) throw new Error(data?.error || 'Napaka zahteve')
      if (data.duplicate && data.ap) {
        setEslogDup(data.ap.apNumber)
        toast({ title: t('eslog.dup', { ap: data.ap.apNumber }) })
        return
      }
      if (data.ap) {
        setEslogResult({
          apNumber: data.ap.apNumber,
          supplierName: data.supplier?.name || '',
          totalAmount: Number(data.ap.totalAmount),
          dueDate: data.ap.dueDate ? nabavaDate(data.ap.dueDate) : '—',
          lines: data.parsed?.lines?.length || 0,
        })
        toast({ title: t('eslog.ok', { ap: data.ap.apNumber }) })
      }
    } catch (e) {
      setEslogWarn({ error: String((e as Error).message || e) })
    } finally {
      setEslogBusy(false)
    }
  }

  /* — ponavljajoča naročila (OPS-9 val 2) — */
  const runRecurringNow = async () => {
    setRecBusy(true); setRecErr('')
    try {
      const res = await api<{ created: { poNumber: string }[]; skipped: number }>('/api/purchase-orders/run-recurring', { method: 'POST', body: JSON.stringify({}) })
      toast({ title: t('recurring.created', { n: res.created.length, s: res.skipped }) })
      if (res.created.length > 0) await loadOrders()
      await loadRecRules()
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const toggleRule = async (rule: RecRuleT) => {
    setRecBusy(true); setRecErr('')
    try {
      const res = await api<{ rule: RecRuleT }>('/api/recurring-po', { method: 'PATCH', body: JSON.stringify({ id: rule.id, active: !rule.active }) })
      setRecRules((rs) => rs.map((r) => (r.id === rule.id ? res.rule : r)))
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const deleteRule = async (id: string) => {
    if (!window.confirm(t('recurring.confirmDelete'))) return
    setRecBusy(true); setRecErr('')
    try {
      await api(`/api/recurring-po?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      setRecRules((rs) => rs.filter((r) => r.id !== id))
      toast({ title: t('recurring.deleted') })
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }
  const openRecDialog = () => {
    setRecSupplierId(suppliers.find((s) => s.isActive)?.id || '')
    setRecItemId(''); setRecItems([]); setRecWeekdays([1]); setRecHour('8'); setRecEvery('1'); setRecErr('')
    setRecDialog(true)
  }
  const addRecItem = () => {
    if (!recItemId) return
    const it = invItems.find((i) => i.id === recItemId)
    if (!it || recItems.some((x) => x.inventoryItemId === recItemId)) return
    setRecItems((xs) => [...xs, { inventoryItemId: it.id, name: it.name, qty: '' }])
    setRecItemId('')
  }
  const saveRecRule = async () => {
    if (!recSupplierId) { setRecErr(t('recurring.errSupplier')); return }
    if (recItems.length === 0 || recItems.some((x) => !(nabavaNum(x.qty) > 0))) { setRecErr(t('recurring.errItems')); return }
    if (recWeekdays.length === 0) { setRecErr(t('recurring.errWeekdays')); return }
    setRecBusy(true); setRecErr('')
    try {
      await api('/api/recurring-po', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: recSupplierId,
          items: recItems.map((x) => ({ inventoryItemId: x.inventoryItemId, qty: nabavaNum(x.qty) })),
          weekdays: recWeekdays,
          hour: Number(recHour) || 8,
          everyWeeks: Number(recEvery) || 1,
        }),
      })
      setRecDialog(false)
      toast({ title: t('recurring.saved') })
      await loadRecRules()
    } catch (e) {
      setRecErr(String((e as Error).message || e))
    } finally {
      setRecBusy(false)
    }
  }

  const filteredOrders = statusFilter === 'all' ? orders : orders.filter((o) => o.status === statusFilter)

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">{t('proc.desc')}</p>

      {/* OPS-10 val 3 — reminder banner for recurring POs due soon / freshly overdue (no polling:
          computed from the rules already fetched on mount; "run now" reuses the existing trigger) */}
      {(() => {
        const nowD = new Date()
        const remindable = recRules.filter((r) => isRemindable(r, nowD, remindMsForRule(r)))
        if (remindable.length === 0) return null
        const r = remindable[0]
        const due = dueInMs(r, nowD)
        const mins = Math.max(0, Math.round(Math.abs(due) / 60000))
        const sName = suppliers.find((s) => s.id === r.supplierId)?.name || ''
        const nd = r.nextRun ? new Date(r.nextRun) : null
        const time = nd ? `${String(nd.getHours()).padStart(2, '0')}:${String(nd.getMinutes()).padStart(2, '0')}` : ''
        return (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 flex flex-wrap items-center gap-2 text-sm text-amber-900" role="status">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1 min-w-48">
              {due > 0
                ? t('recurring.remindUpcoming', { name: sName, time, mins })
                : t('recurring.remindOverdue', { name: sName, mins })}
              {remindable.length > 1 ? ` (+${remindable.length - 1})` : ''}
            </span>
            <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white" disabled={recBusy} onClick={runRecurringNow}>
              <Repeat className="w-3.5 h-3.5" /> {t('recurring.runNow')}
            </Button>
          </div>
        )
      })()}

      {/* 0a — consumption-based recommendations (issue #12): predicted use in
          lead-time + review cycle + safety stock − on-hand − confirmed incoming,
          rounded up to supplier packs; WATCH = below threshold but already covered */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <PackageSearch className="w-4 h-4" /> {t('recs.title')}
            {recs && recs.summary.recommend > 0 && (
              <Badge variant="outline" className="ml-1 border-emerald-300 bg-emerald-50 text-emerald-800">{recs.summary.recommend}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {recs ? t('recs.window', { days: recs.summary.windowDays, review: recs.summary.reviewDays }) : t('recs.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recsLoading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('recs.loading')}</p>
          ) : !recs ? (
            <p className="text-sm text-rose-700">{t('recs.error')}</p>
          ) : recs.groupedBySupplier.length === 0 && recs.watch.length === 0 ? (
            <p className="text-sm text-stone-500">{t('recs.empty')}</p>
          ) : (
            <div className="space-y-3">
              {recs.groupedBySupplier.map((g) => (
                <div key={g.supplierId || `none-${g.supplierName}`} className="rounded-xl border border-stone-200">
                  <div className="flex items-center justify-between gap-2 flex-wrap border-b border-stone-100 bg-stone-50 px-3 py-2 rounded-t-xl">
                    <span className="font-semibold text-sm">{g.supplierName || t('recs.supplierNone')}</span>
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-stone-500">{t('recs.estTotal')}: <strong>{fmtEUR(g.total)}</strong></span>
                      {canManage && g.supplierId && (
                        <Button size="sm" className="h-7 px-2 text-xs bg-emerald-700 hover:bg-emerald-800 text-white" disabled={recsApplyBusy} onClick={() => applyRecommendationGroup(g)}>
                          {recsApplyBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <PackageSearch className="w-3 h-3" />} {t('recs.createPo')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-white text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('recs.colItem')}</th>
                          <th className="p-2 text-right">{t('recs.colStock')}</th>
                          <th className="p-2 text-right">{t('recs.colUse')}</th>
                          <th className="p-2 text-right">{t('recs.colCover')}</th>
                          <th className="p-2 text-right">{t('recs.colNeed')}</th>
                          <th className="p-2 text-right">{t('recs.colPacks')}</th>
                          <th className="p-2 text-right">{t('recs.colQty')}</th>
                          <th className="p-2 text-right">{t('recs.colCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((s) => (
                          <tr key={s.itemId} className="border-t border-stone-100">
                            <td className="p-2 font-medium max-w-48 truncate" title={s.itemName}>
                              {s.itemName}
                              {s.flags.noHistory && <Badge variant="outline" className="ml-1.5 border-amber-300 bg-amber-50 text-amber-800 text-[10px] px-1 py-0">{t('recs.noHistory')}</Badge>}
                              {s.flags.noLeadTime && <Badge variant="outline" className="ml-1.5 border-amber-300 bg-amber-50 text-amber-800 text-[10px] px-1 py-0">{t('recs.noLead')}</Badge>}
                            </td>
                            <td className="p-2 text-right">{s.onHand} {s.unit}</td>
                            <td className="p-2 text-right">{s.avgDailyUse}</td>
                            <td className="p-2 text-right">
                              {s.coverageDays == null ? '—' : t('recs.days', { n: s.coverageDays })}
                              {s.stockoutDate && <span className="block text-[10px] text-stone-400">{s.stockoutDate}</span>}
                            </td>
                            <td className="p-2 text-right">{s.needQty}</td>
                            <td className="p-2 text-right">{s.suggestedPacks}</td>
                            <td className="p-2 text-right font-bold text-emerald-700">{s.suggestedQty} {s.unit}</td>
                            <td className="p-2 text-right">{fmtEUR(s.estCost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              {recs.watch.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-amber-800 font-medium py-1">
                    <ChevronDown className="w-4 h-4" /> {t('recs.watch')} ({recs.watch.length})
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="text-xs text-stone-500 mb-1.5">{t('recs.watchDesc')}</p>
                    <div className="rounded-xl border border-amber-200 bg-amber-50/60 divide-y divide-amber-100 max-h-48 overflow-y-auto">
                      {recs.watch.map((s) => (
                        <div key={s.itemId} className="px-3 py-1.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-medium">{s.itemName}</span>
                          <span className="text-xs text-stone-600">{t('recs.colStock')}: {s.onHand} {s.unit} · {t('recs.colPar')}: {s.reorderPoint}</span>
                          {s.flags.noHistory && <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800 text-[10px] px-1 py-0">{t('recs.noHistory')}</Badge>}
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          )}
          {recsErr && recs && <p className="text-sm text-rose-700">{t('recs.error')} {recsErr}</p>}
        </CardContent>
      </Card>

      {/* 0 — reorder suggestions (OPS-8 val 2): PAR - stock - incoming, per supplier */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <TrendingUp className="w-4 h-4" /> {t('sugg.title')}
          </CardTitle>
          <CardDescription>{t('sugg.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {suggLoading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('sugg.loading')}</p>
          ) : suggGroups.length === 0 ? (
            <p className="text-sm text-stone-500">{t('sugg.empty')}</p>
          ) : (
            <div className="space-y-3">
              {suggGroups.map((g) => (
                <div key={g.supplierId || `none-${g.supplierName}`} className="rounded-xl border border-stone-200">
                  <div className="flex items-center justify-between gap-2 flex-wrap border-b border-stone-100 bg-stone-50 px-3 py-2 rounded-t-xl">
                    <span className="font-semibold text-sm">{g.supplierName || t('sugg.noSupplier')}</span>
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-stone-500">{t('sugg.total')}: <strong>{fmtEUR(g.total)}</strong></span>
                      {canManage && g.supplierId && (
                        <Button size="sm" className="h-7 px-2 text-xs bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => openPoDialogPrefilled(g)}>
                          <Plus className="w-3 h-3" /> {t('sugg.createPo')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-white text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('sugg.colItem')}</th>
                          <th className="p-2 text-right">{t('sugg.colQty')}</th>
                          <th className="p-2 text-right">{t('sugg.colPar')}</th>
                          <th className="p-2 text-right">{t('sugg.colIncoming')}</th>
                          <th className="p-2 text-right">{t('sugg.colSuggested')}</th>
                          <th className="p-2 text-right">{t('sugg.colCost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((s) => (
                          <tr key={s.itemId} className="border-t border-stone-100">
                            <td className="p-2 font-medium max-w-48 truncate" title={s.itemName}>{s.itemName}</td>
                            <td className="p-2 text-right">{s.qty} {s.unit}</td>
                            <td className="p-2 text-right">{s.par}</td>
                            <td className="p-2 text-right">{s.incoming}</td>
                            <td className="p-2 text-right font-bold text-emerald-700">{s.suggested}</td>
                            <td className="p-2 text-right">{fmtEUR(s.costEstimate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
          {suggErr && <p className="text-sm text-rose-700">{t('sugg.error')} {suggErr}</p>}
        </CardContent>
      </Card>

      {/* 0b — eSLOG e-invoice import (OPS-9 val 2): XML file → AccountsPayable */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <FileUp className="w-4 h-4" /> {t('eslog.card')}
          </CardTitle>
          <CardDescription>{t('eslog.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="nb-eslog-file">{t('eslog.file')}</Label>
              <Input
                id="nb-eslog-file"
                type="file"
                accept=".xml,text/xml,application/xml"
                className="w-full sm:w-72 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-stone-100 file:px-2 file:py-1 file:text-xs"
                disabled={eslogBusy}
                onChange={(e) => { setEslogFile(e.target.files?.[0] || null); setEslogWarn(null); setEslogDup(''); setEslogResult(null) }}
              />
            </div>
            <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800 text-white" disabled={eslogBusy || !eslogFile} onClick={importEslog}>
              {eslogBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
              {eslogBusy ? t('eslog.importing') : t('eslog.importBtn')}
            </Button>
          </div>
          {eslogDup && (
            <p className="text-sm text-stone-700 rounded-xl border border-stone-200 bg-stone-50 p-3">{t('eslog.dup', { ap: eslogDup })}</p>
          )}
          {eslogWarn && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-semibold flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {eslogWarn.error}</p>
            </div>
          )}
          {eslogResult && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 space-y-1">
              <p className="font-semibold">{t('eslog.summary')}: {eslogResult.apNumber}</p>
              <p>
                {t('eslog.colSupplier')}: <strong>{eslogResult.supplierName}</strong> · {t('eslog.colAmount')}: <strong>{fmtEUR(eslogResult.totalAmount)}</strong> · {t('eslog.colDue')}: {eslogResult.dueDate} · {t('eslog.lines', { n: eslogResult.lines })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 0c — recurring purchase orders (OPS-9 val 2): rules → draft POs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Repeat className="w-4 h-4" /> {t('recurring.card')}
            {canManage && (
              <span className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={recBusy} onClick={runRecurringNow}>
                  <RotateCcw className="w-3.5 h-3.5" /> {recBusy ? t('recurring.running') : t('recurring.runNow')}
                </Button>
                <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={openRecDialog}>
                  <Plus className="w-3.5 h-3.5" /> {t('recurring.new')}
                </Button>
              </span>
            )}
          </CardTitle>
          <CardDescription>{t('recurring.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {recLoading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}</p>
          ) : recRules.length === 0 ? (
            <p className="text-sm text-stone-500">{t('recurring.empty')}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {recRules.map((rule) => {
                const sup = suppliers.find((s) => s.id === rule.supplierId)
                return (
                  <div key={rule.id} className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{sup?.name || rule.supplierId}</span>
                        <Badge variant="outline" className={rule.active ? 'border-emerald-600 text-emerald-700' : 'text-stone-500'}>
                          {rule.active ? t('recurring.active') : t('proc.inactiveF')}
                        </Badge>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <Switch checked={rule.active} disabled={recBusy} onCheckedChange={() => toggleRule(rule)} aria-label={t('recurring.active')} />
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs border-red-200 text-red-700 hover:bg-red-50" disabled={recBusy} onClick={() => deleteRule(rule.id)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-stone-600 mt-1">
                      {rule.items.map((it) => `${invItems.find((i) => i.id === it.inventoryItemId)?.name || it.inventoryItemId} × ${it.qty}`).join(', ')}
                    </p>
                    <p className="text-xs text-stone-500 mt-0.5">
                      {t('recurring.weekdays')}: {REC_DAY_ORDER.filter((d) => rule.weekdays.includes(d)).map((d) => t(`recurring.day${d}`)).join(', ')} · {t('recurring.hour')}: {rule.hour}:00 · {t('recurring.every')}: {t(`recurring.every${Math.max(1, Math.min(4, rule.everyWeeks))}`)}
                    </p>
                    <p className="text-xs text-stone-500">
                      {t('recurring.next')}: {rule.nextRun ? nabavaDate(rule.nextRun) : t('recurring.never')} · {t('recurring.lastRun')}: {rule.lastRun ? nabavaDate(rule.lastRun) : t('recurring.never')}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
          {recErr && <p className="text-sm text-red-600">{recErr}</p>}
        </CardContent>
      </Card>

      {/* A — DOBAVITELJI */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Truck className="w-4 h-4" /> {t('inv.suppliers')}
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={() => openSupDialog()}>
                <Plus className="w-3.5 h-3.5" /> {t('inv.newSupplier')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suppliers.length === 0 ? (
            <p className="text-sm text-stone-500">{t('proc.noSuppliers')} {canManage ? t('proc.noSuppliersAdd') : t('proc.noSuppliersManager')}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                  <tr>
                    <th className="p-2">{t('jobs.name')}</th>
                    <th className="p-2">{t('proc.contact')}</th>
                    <th className="p-2">{t('proc.phoneEmail')}</th>
                    <th className="p-2">{t('set.city')}</th>
                    <th className="p-2 text-right">{t('proc.ordersCount')}</th>
                    <th className="p-2 text-right">{t('proc.itemsCol')}</th>
                    <th className="p-2">{t('shifts.csvStatus')}</th>
                    {canManage && <th className="p-2 text-right">{t('common.edit')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.id} className="border-t border-stone-100">
                      <td className="p-2 font-medium">{s.name}</td>
                      <td className="p-2 text-stone-600">{s.contact || '—'}</td>
                      <td className="p-2 text-stone-600">{[s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="p-2 text-stone-600">{s.city || '—'}</td>
                      <td className="p-2 text-right">{s.purchaseOrdersCount}</td>
                      <td className="p-2 text-right">{s.itemsCount}</td>
                      <td className="p-2">
                        {s.isActive
                          ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">{t('proc.activeF')}</Badge>
                          : <Badge variant="outline" className="text-stone-500">{t('proc.inactiveF')}</Badge>}
                      </td>
                      {canManage && (
                        <td className="p-2 text-right">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => openSupDialog(s)}>{t('common.edit')}</Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* B — NABAVNA NAROČILA */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <PackageSearch className="w-4 h-4" /> {t('proc.ordersTitle')}
            {canManage && (
              <Button size="sm" className="ml-auto bg-emerald-700 hover:bg-emerald-800 text-white" onClick={openPoDialog}>
                <Plus className="w-3.5 h-3.5" /> {t('proc.newOrder')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="sm:max-w-xs space-y-1.5">
            <Label>{t('proc.statusFilter')}</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('proc.allStatuses')}</SelectItem>
                {Object.entries(NABAVA_STATUS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{t(v.label)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {loading ? (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('proc.loading')}</p>
          ) : filteredOrders.length === 0 ? (
            <p className="text-sm text-stone-500">{orders.length === 0 ? t('proc.noOrders') : t('proc.noOrdersStatus')}</p>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
              {filteredOrders.map((o) => {
                const st = NABAVA_STATUS[o.status]
                const active = o.status === 'draft' || o.status === 'submitted' || o.status === 'approved' || o.status === 'partial'
                return (
                  <div
                    key={o.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(o.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openDetail(o.id) }}
                    className="rounded-xl border border-stone-200 bg-stone-50 p-3 cursor-pointer hover:border-emerald-400 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{o.poNumber}</span>
                        <Badge variant="outline" className={st?.cls || ''}>{st?.label ? t(st.label) : o.status}</Badge>
                      </div>
                      <span className="font-bold">{fmtEUR(o.totalAmount)}</span>
                    </div>
                    <p className="text-xs text-stone-500 mt-1">
                      {o.supplierName || '—'} · {t('proc.ordered')} {nabavaDate(o.orderDate)}
                      {o.expectedDate ? ` · ${t('proc.expected')} ${nabavaDate(o.expectedDate)}` : ''}
                      {' · '}{t('proc.linesCount', { n: o.items.length })} · {o.receiptsCount === 1 ? t('proc.receiptOne') : o.receiptsCount === 2 ? t('proc.receiptTwo') : t('proc.receiptMany', { n: o.receiptsCount })}
                    </p>
                    {canManage && active && (
                      <div className="flex flex-wrap gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                        {o.status === 'draft' && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => poAction(o.id, 'submit')}>{t('proc.submitBtn')}</Button>
                        )}
                        {o.status === 'submitted' && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => poAction(o.id, 'approve')}>{t('proc.approveBtn')}</Button>
                        )}
                        {(o.status === 'approved' || o.status === 'partial') && (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={busy} onClick={() => openReceive(o)}>
                            <Truck className="w-3.5 h-3.5" /> {t('proc.receiveBtn')}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy} onClick={() => poAction(o.id, 'cancel')}>{t('common.cancel')}</Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {busy && <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('common.processing')}</p>}
      {okMsg && <p className="text-sm text-emerald-700">{okMsg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Dialog: dobavitelj (nov / uredi) */}
      <Dialog open={supDialog !== null} onOpenChange={(v) => { if (!v) setSupDialog(null) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{supDialog?.editingId ? t('proc.editSupplier') : t('inv.newSupplier')}</DialogTitle></DialogHeader>
          {supDialog && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-name">{t('inv.name')}</Label>
                <Input id="nb-sup-name" value={supDialog.name} onChange={(e) => setSupDialog({ ...supDialog, name: e.target.value })} placeholder={t('proc.supNamePlaceholder')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-contact">{t('inv.contactPerson')}</Label>
                  <Input id="nb-sup-contact" value={supDialog.contact} onChange={(e) => setSupDialog({ ...supDialog, contact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-phone">{t('inv.phone')}</Label>
                  <Input id="nb-sup-phone" value={supDialog.phone} onChange={(e) => setSupDialog({ ...supDialog, phone: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-email">{t('set.email')}</Label>
                  <Input id="nb-sup-email" type="email" value={supDialog.email} onChange={(e) => setSupDialog({ ...supDialog, email: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-city">{t('set.city')}</Label>
                  <Input id="nb-sup-city" value={supDialog.city} onChange={(e) => setSupDialog({ ...supDialog, city: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-tax">{t('set.taxId')}</Label>
                  <Input id="nb-sup-tax" value={supDialog.taxId} onChange={(e) => setSupDialog({ ...supDialog, taxId: e.target.value })} />
                  {/* OPS-8 val 2 — DURS VAT payer check (badge + autofill name + bank account) */}
                  <DursCheckButton
                    query={supDialog.taxId}
                    compact
                    onName={(name) => setSupDialog((d) => (d && !d.name.trim() ? { ...d, name } : d))}
                    onIban={(iban) => setSupDialog((d) => (d && !d.iban.trim() ? { ...d, iban } : d))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-iban">{t('proc.iban')}</Label>
                  <Input id="nb-sup-iban" value={supDialog.iban} onChange={(e) => setSupDialog({ ...supDialog, iban: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-sup-terms">{t('proc.paymentTerms')}</Label>
                  <Input id="nb-sup-terms" value={supDialog.paymentTerms} onChange={(e) => setSupDialog({ ...supDialog, paymentTerms: e.target.value })} placeholder={t('proc.termsPlaceholder')} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-sup-addr">{t('set.address')}</Label>
                <Input id="nb-sup-addr" value={supDialog.address} onChange={(e) => setSupDialog({ ...supDialog, address: e.target.value })} />
              </div>
              {supErr && <p className="text-sm text-red-600">{supErr}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSupDialog(null)} disabled={supBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={saveSupplier} disabled={supBusy}>
              {supBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: novo nabavno naročilo */}
      <Dialog open={poDialog} onOpenChange={(v) => { if (!v) setPoDialog(false) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('proc.newOrderTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('proc.supplierLabel')}</Label>
                <Select value={poSupplierId} onValueChange={setPoSupplierId}>
                  <SelectTrigger><SelectValue placeholder={suppliers[0]?.name || t('proc.chooseSupplier')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {suppliers.filter((s) => s.isActive).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {suppliers.length === 0 && <p className="text-xs text-amber-700">{t('proc.noActiveSuppliers')}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>{t('dev.location')}</Label>
                {locations.length > 0 ? (
                  <Select value={poLocationId} onValueChange={setPoLocationId}>
                    <SelectTrigger><SelectValue placeholder={t('proc.defaultLocation')} /></SelectTrigger>
                    <SelectContent>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input disabled value={t('proc.defaultLocation')} />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-expected">{t('proc.expectedDate')}</Label>
                <Input id="nb-po-expected" type="date" value={poExpected} onChange={(e) => setPoExpected(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-po-notes">{t('proc.note')}</Label>
                <Input id="nb-po-notes" value={poNotes} onChange={(e) => setPoNotes(e.target.value)} placeholder={t('proc.notePlaceholder')} />
              </div>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1.5 grow min-w-48">
                <Label>{t('proc.addInvItem')}</Label>
                <Select value="" onValueChange={addPoLineFromInventory}>
                  <SelectTrigger><SelectValue placeholder={t('proc.itemPlaceholder')} /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {invItems.filter((i) => !poLines.some((l) => l.inventoryItemId === i.id)).map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" size="sm" className="h-9" onClick={addManualPoLine}>
                <Plus className="w-3.5 h-3.5" /> {t('proc.manualLine')}
              </Button>
            </div>

            {poLines.length === 0 ? (
              <p className="text-xs text-stone-500">{t('proc.noLines')}</p>
            ) : (
              <div className="space-y-2">
                {poLines.map((l, idx) => (
                  <div key={l.inventoryItemId || `m${idx}`} className="rounded-lg border border-stone-200 bg-stone-50 p-2">
                    <div className="grid gap-2 sm:grid-cols-12 items-end">
                      <div className="sm:col-span-4 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.itemDesc')}</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm font-medium py-1.5">{l.description}</p>
                        ) : (
                          <Input value={l.description} onChange={(e) => updatePoLine(idx, { description: e.target.value })} placeholder={t('proc.lineDescPlaceholder')} />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.qty')}</Label>
                        <Input inputMode="decimal" value={l.quantity} onChange={(e) => updatePoLine(idx, { quantity: e.target.value })} />
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('inv.unit')}</Label>
                        {l.inventoryItemId ? (
                          <p className="text-sm py-1.5 text-stone-600">{l.unit}</p>
                        ) : (
                          <Input value={l.unit} onChange={(e) => updatePoLine(idx, { unit: e.target.value })} />
                        )}
                      </div>
                      <div className="sm:col-span-2 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.pricePerUnit')}</Label>
                        <Input inputMode="decimal" value={l.unitPrice} onChange={(e) => updatePoLine(idx, { unitPrice: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 space-y-1">
                        <Label className="text-xs text-stone-500">{t('proc.vatPercent')}</Label>
                        <Input inputMode="decimal" value={l.vatRate} onChange={(e) => updatePoLine(idx, { vatRate: e.target.value })} />
                      </div>
                      <div className="sm:col-span-1 flex justify-end">
                        <Button size="sm" variant="outline" className="h-9 w-9 p-0 text-red-600" aria-label={t('proc.removeLine')} onClick={() => removePoLine(idx)}>×</Button>
                      </div>
                    </div>
                    <p className="text-xs text-stone-500 mt-1 text-right">{t('proc.lineAmount')} <b>{fmtEUR(poLineNet(l))}</b></p>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-stone-600">{t('proc.netTotal')}</span><span>{fmtEUR(poSubtotal)}</span></div>
              <div className="flex justify-between"><span className="text-stone-600">{t('proc.vat')}</span><span>{fmtEUR(poVatTotal)}</span></div>
              <div className="flex justify-between font-bold"><span>{t('proc.total')}</span><span>{fmtEUR(poSubtotal + poVatTotal)}</span></div>
            </div>

            {poErr && <p className="text-sm text-red-600">{poErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPoDialog(false)} disabled={poBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={savePo} disabled={poBusy}>
              {poBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('proc.createDraft')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: detajl naročila (naročeno/prejeto/zavrnjeno, prevzemi, zgodovina cen) */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) { setDetailId(null); setDetail(null) } }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              {t('proc.order')} {detail?.poNumber || '…'}
              {detail && (
                <Badge variant="outline" className={NABAVA_STATUS[detail.status]?.cls || ''}>
                  {NABAVA_STATUS[detail.status]?.label ? t(NABAVA_STATUS[detail.status].label) : detail.status}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailBusy && !detail && (
            <p className="text-sm text-stone-500 flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> {t('proc.loadingDetail')}</p>
          )}
          {detailErr && <p className="text-sm text-red-600">{detailErr}</p>}
          {detail && (
            <div className="space-y-4">
              <div className="text-xs text-stone-600 space-y-0.5">
                <p>
                  {t('proc.supplierColon')} <b>{detail.supplier?.name || '—'}</b>
                  {detail.supplier?.contactPerson ? ` · ${detail.supplier.contactPerson}` : ''}
                  {detail.supplier?.phone ? ` · ${detail.supplier.phone}` : ''}
                  {detail.supplier?.email ? ` · ${detail.supplier.email}` : ''}
                </p>
                <p>{t('proc.orderedColon')} {nabavaDate(detail.orderDate)} · {t('proc.expectedColon')} {nabavaDate(detail.expectedDate)} · {t('proc.receivedColon')} {nabavaDate(detail.receivedDate)}</p>
                <p>{t('proc.submittedBy')} {detail.requestedBy || '—'} · {t('proc.approvedByLabel')} {detail.approvedBy || '—'}</p>
                {detail.notes && <p>{t('proc.noteColon')} {detail.notes}</p>}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.linesHeader')}</p>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-stone-200">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                      <tr>
                        <th className="p-2">{t('proc.item')}</th>
                        <th className="p-2 text-right">{t('proc.thOrdered')}</th>
                        <th className="p-2 text-right">{t('proc.thReceived')}</th>
                        <th className="p-2 text-right">{t('proc.thRejected')}</th>
                        <th className="p-2 text-right">{t('proc.thPriceUnit')}</th>
                        <th className="p-2 text-right">{t('proc.total')}</th>
                        <th className="p-2">{t('shifts.csvStatus')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((it) => {
                        const ist = NABAVA_ITEM_STATUS[it.status]
                        return (
                          <tr key={it.id} className="border-t border-stone-100">
                            <td className="p-2 font-medium">{it.description}</td>
                            <td className="p-2 text-right">{it.quantityOrdered} {it.unit}</td>
                            <td className="p-2 text-right text-emerald-700">{it.quantityReceived}</td>
                            <td className="p-2 text-right text-red-600">{it.quantityRejected > 0 ? it.quantityRejected : '—'}</td>
                            <td className="p-2 text-right">{fmtEUR(it.unitPrice)}</td>
                            <td className="p-2 text-right font-semibold">{fmtEUR(it.totalPrice)}</td>
                            <td className="p-2">
                              <Badge variant="outline" className={ist?.cls || ''}>{ist?.label ? t(ist.label) : it.status}</Badge>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-stone-600 mt-2 text-right">
                  {t('proc.netLabel')} {fmtEUR(detail.subtotal)} · {t('proc.vat')}: {fmtEUR(detail.vatAmount)} · <b>{t('proc.total')}: {fmtEUR(detail.totalAmount)}</b>
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.receiptsCount', { n: detail.receipts.length })}</p>
                {detail.receipts.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('proc.noReceipts')}</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto space-y-2">
                    {detail.receipts.map((g) => (
                      <div key={g.id} className="rounded-lg border border-stone-200 bg-stone-50 p-2 text-sm">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-semibold">{g.grnNumber}</span>
                          <span className="text-xs text-stone-500">
                            {g.receivedAt ? new Date(g.receivedAt).toLocaleString('sl-SI') : '—'}{g.receivedByName ? ` · ${g.receivedByName}` : ''}
                          </span>
                        </div>
                        {g.supplierDocNumber && <p className="text-xs text-stone-500">{t('proc.supplierDoc')} {g.supplierDocNumber}</p>}
                        <ul className="text-xs text-stone-600 mt-1 space-y-0.5">
                          {g.items.map((gi, i) => (
                            <li key={i}>
                              {gi.description}: {t('proc.acceptedShort')} {gi.quantityAccepted} {gi.unit}
                              {gi.quantityRejected > 0 ? ` · ${t('proc.rejectedShort')} ${gi.quantityRejected}${gi.rejectReason ? ` (${gi.rejectReason})` : ''}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-stone-500 mb-1">{t('proc.priceHistory')}</p>
                {detail.priceHistory.length === 0 ? (
                  <p className="text-sm text-stone-500">{t('proc.noPriceHistory')}</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded-xl border border-stone-200">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                        <tr>
                          <th className="p-2">{t('proc.article')}</th>
                          <th className="p-2 text-right">{t('proc.thPriceUnit')}</th>
                          <th className="p-2 text-right">{t('proc.vat')}</th>
                          <th className="p-2">{t('proc.source')}</th>
                          <th className="p-2 text-right">{t('proc.observed')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.priceHistory.slice(0, 10).map((h, i) => {
                          const inv = invItems.find((x) => x.id === h.inventoryItemId)
                          return (
                            <tr key={i} className="border-t border-stone-100">
                              <td className="p-2">{inv?.name || h.inventoryItemId || '—'}</td>
                              <td className="p-2 text-right font-semibold">{fmtEUR(h.unitPrice)}</td>
                              <td className="p-2 text-right">{h.vatRate != null ? `${h.vatRate} %` : '—'}</td>
                              <td className="p-2 text-stone-600">{h.source === 'goods_receipt' ? t('proc.srcReceipt') : h.source === 'purchase_order' ? t('proc.srcOrder') : h.source}</td>
                              <td className="p-2 text-right text-stone-500">{new Date(h.observedAt).toLocaleDateString('sl-SI')}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: prevzem (GRN) */}
      <Dialog open={recvOrder !== null} onOpenChange={(v) => { if (!v) setRecvOrder(null) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('proc.receiveTitle', { po: recvOrder?.poNumber || '' })}</DialogTitle></DialogHeader>
          {recvDone ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
                {t('proc.recvSavedA')} <b>{recvDone.grnNumber}</b>{t('proc.recvSavedB')}
              </div>
              {recvDone.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {t('proc.warnings')}</p>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {recvDone.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : recvOrder ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="nb-recv-doc">{t('proc.supplierDocLabel')}</Label>
                  <Input id="nb-recv-doc" value={recvDoc} onChange={(e) => setRecvDoc(e.target.value)} placeholder={t('proc.docPlaceholder')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="nb-recv-notes">{t('proc.note')}</Label>
                  <Input id="nb-recv-notes" value={recvNotes} onChange={(e) => setRecvNotes(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                {recvOrder.items.map((it) => {
                  const l = recvLines[it.id] || { accept: '0', reject: '0', reason: '', expiry: '' }
                  const rejNum = nabavaNum(l.reject)
                  const remaining = Math.max(0, it.quantityOrdered - it.quantityReceived)
                  return (
                    <div key={it.id} className="rounded-lg border border-stone-200 bg-stone-50 p-2">
                      <p className="text-sm font-medium">{it.description}</p>
                      <p className="text-xs text-stone-500 mb-2">
                        {t('proc.orderedColon')} {it.quantityOrdered} {it.unit} · {t('proc.alreadyReceived')} {it.quantityReceived}
                        {it.quantityRejected > 0 ? ` · ${t('proc.rejectedColon')} ${it.quantityRejected}` : ''} · {t('proc.remaining')} {remaining} {it.unit}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-4 items-end">
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.accepted')}</Label>
                          <Input inputMode="decimal" value={l.accept} onChange={(e) => updateRecvLine(it.id, { accept: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.thRejected')}</Label>
                          <Input inputMode="decimal" value={l.reject} onChange={(e) => updateRecvLine(it.id, { reject: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.rejectReason')}{rejNum > 0 ? ' *' : ''}</Label>
                          <Input value={l.reason} onChange={(e) => updateRecvLine(it.id, { reason: e.target.value })} placeholder={t('proc.reasonPlaceholder')} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-stone-500">{t('proc.expiry')}</Label>
                          <Input type="date" value={l.expiry} onChange={(e) => updateRecvLine(it.id, { expiry: e.target.value })} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {recvErr && <p className="text-sm text-red-600">{recvErr}</p>}
            </div>
          ) : null}
          <DialogFooter>
            {recvDone ? (
              <Button variant="outline" onClick={() => setRecvOrder(null)}>{t('common.close')}</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setRecvOrder(null)} disabled={recvBusy}>{t('common.cancel')}</Button>
                <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={submitReceive} disabled={recvBusy}>
                  {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />} {t('proc.submitReceive')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: ponavljajoče naročilo — novo pravilo (OPS-9 val 2) */}
      <Dialog open={recDialog} onOpenChange={(v) => { if (!v) setRecDialog(false) }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t('recurring.dialogTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="nb-rec-sup">{t('recurring.supplier')}</Label>
              <Select value={recSupplierId} onValueChange={setRecSupplierId}>
                <SelectTrigger id="nb-rec-sup"><SelectValue placeholder={t('proc.chooseSupplier')} /></SelectTrigger>
                <SelectContent className="max-h-60">
                  {suppliers.filter((s) => s.isActive).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="nb-rec-item">{t('recurring.items')}</Label>
              <div className="flex gap-2 items-end">
                <Select value={recItemId} onValueChange={setRecItemId}>
                  <SelectTrigger id="nb-rec-item" className="flex-1"><SelectValue placeholder={t('recurring.itemPick')} /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    {invItems.map((i) => (
                      <SelectItem key={i.id} value={i.id}>{i.name} ({i.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" className="h-9" onClick={addRecItem} disabled={!recItemId}>
                  <Plus className="w-3.5 h-3.5" /> {t('recurring.addItem')}
                </Button>
              </div>
              {recItems.length === 0 ? (
                <p className="text-xs text-stone-500">{t('recurring.errItems')}</p>
              ) : (
                <div className="space-y-1.5">
                  {recItems.map((x, idx) => (
                    <div key={x.inventoryItemId} className="flex items-center gap-2">
                      <span className="text-sm flex-1 truncate" title={x.name}>{x.name}</span>
                      <Input
                        inputMode="decimal"
                        className="w-24 h-9 text-sm"
                        value={x.qty}
                        aria-label={t('recurring.qty')}
                        placeholder={t('recurring.qty')}
                        onChange={(e) => setRecItems((xs) => xs.map((y, i) => (i === idx ? { ...y, qty: e.target.value } : y)))}
                      />
                      <Button size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={() => setRecItems((xs) => xs.filter((_, i) => i !== idx))} aria-label={t('common.delete')}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t('recurring.weekdays')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {REC_DAY_ORDER.map((d) => {
                  const on = recWeekdays.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setRecWeekdays((ws) => (on ? ws.filter((w) => w !== d) : [...ws, d]))}
                      aria-pressed={on}
                      className={`h-9 min-w-12 rounded-md border px-2 text-xs font-medium transition-colors ${on ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300'}`}
                    >
                      {t(`recurring.day${d}`)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="nb-rec-hour">{t('recurring.hour')}</Label>
                <Select value={recHour} onValueChange={setRecHour}>
                  <SelectTrigger id="nb-rec-hour"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    {Array.from({ length: 13 }, (_, i) => String(i + 6)).map((h) => (
                      <SelectItem key={h} value={h}>{h}:00</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nb-rec-every">{t('recurring.every')}</Label>
                <Select value={recEvery} onValueChange={setRecEvery}>
                  <SelectTrigger id="nb-rec-every"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['1', '2', '3', '4'].map((n) => (
                      <SelectItem key={n} value={n}>{t(`recurring.every${n}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {recErr && <p className="text-sm text-red-600">{recErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecDialog(false)} disabled={recBusy}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" onClick={saveRecRule} disabled={recBusy}>
              {recBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} {t('recurring.new')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

