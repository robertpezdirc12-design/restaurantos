'use client'

/**
 * Issue #24 (P2, v1.114.0) — label issue + print dialog for prepared food
 * and open batches (used from the inventory batches / batch prep cards,
 * but also reusable anywhere).
 *
 * NOTE: this file lives in src/components/ root — OUTSIDE the i18n scan
 * family (tabs/*). Comments stay English; every user-visible string goes
 * through t() (lbl.* keys in src/lib/i18n/sl.ts + hr.ts).
 *
 * Flow:
 *  1. POST /api/labels (raw fetch + Bearer — 201/409 must be distinguishable;
 *     api() swallows the status code). 409 = print block (quarantine/recall/
 *     expired/removal/exhausted batch) → destructive toast with server text;
 *  2. needsReview → amber banner (role="status");
 *  3. POST /api/labels/[id]/print → buildLabelLines() (pure engine,
 *     src/lib/label.ts) + printLabelDocument() (client print adapter:
 *     browser / agent / simulator — ctx.kind='label' ack evidence);
 *  4. lazy "recent labels" list (GET /api/labels?batchId=|preparationId=)
 *     with scan-status badges (same colors as the public /label/<token>
 *     page), reprint (same print flow) and void (inventory.manage +
 *     mandatory reason, AlertDialog confirm);
 *  5. every successful action → onDone?.() so the parent card can reload.
 */
import { useCallback, useState } from 'react'
import { getToken, api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Ban, ChevronDown, Loader2, Printer, Tag } from 'lucide-react'
import { buildLabelLines, LABEL_NOTE_MAX, type LabelPrintData, type LabelPrintStrings, type LabelSource } from '@/lib/label'
import type { AllergenCode } from '@/lib/allergen-catalog'
import { printLabelDocument } from '@/lib/devices/print'

/** Read-only context the caller knows from its own row (server re-reads the record anyway). */
export interface LabelDialogContext {
  itemName: string
  lotNumber: string
  unit: string
  defaultQuantity: number
  area?: string
}

interface LabelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: LabelSource
  batchId?: string
  preparationId?: string
  context: LabelDialogContext
  canManage: boolean
  onDone?: () => void
}

/** labelOut DTO (src/lib/label-schema.ts) as the client sees it over JSON. */
interface LabelT {
  id: string
  source: string
  batchId: string | null
  preparationId: string | null
  inventoryItemId: string
  itemName: string
  itemUnit: string
  lotNumber: string
  quantity: number
  area: string
  preparedAt: string | null
  expiresAt: string | null
  ruleSource: string
  ruleHours: number | null
  ruleConfirmedBy: string
  needsReview: boolean
  allergens: AllergenCode[]
  preparedById: string
  preparedByName: string
  status: string
  printCount: number
  lastPrintedAt: string | null
  note: string
  createdAt: string
  scanStatus: string
}

/** Scan-status badge colors — mirrors the public /label/<token> page (stone/emerald/amber/rose). */
const SCAN_STYLE: Record<string, string> = {
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  alert: 'border-amber-300 bg-amber-100 text-amber-900',
  expired: 'border-rose-300 bg-rose-50 text-rose-800',
  quarantined: 'border-rose-300 bg-rose-100 text-rose-900',
  recalled: 'border-rose-400 bg-rose-100 text-rose-900',
  exhausted: 'border-stone-300 bg-stone-100 text-stone-600',
  void: 'border-stone-300 bg-stone-200 text-stone-700',
  review: 'border-amber-300 bg-white text-amber-800',
}

/** Raw fetch + Bearer (manager-calls-card pattern): 201/409 must stay distinguishable. */
async function labelFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const token = getToken()
  try {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    let data: Record<string, unknown> | null = null
    try { data = (await res.json()) as Record<string, unknown> } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

/** Server error text ({ error }) with an HTTP fallback — never an empty message. */
function serverMsg(d: Record<string, unknown> | null, status: number): string {
  const m = d && typeof d.error === 'string' ? d.error : ''
  return m || (status > 0 ? `HTTP ${status}` : 'fetch failed')
}

export function LabelDialog({
  open,
  onOpenChange,
  source,
  batchId,
  preparationId,
  context,
  canManage,
  onDone,
}: LabelDialogProps) {
  const { t, locale } = useI18n()

  // form
  const [quantity, setQuantity] = useState('')
  const [manualExpiry, setManualExpiry] = useState('')
  const [note, setNote] = useState('')
  const [formErr, setFormErr] = useState('')
  const [banner, setBanner] = useState(false)
  const [busy, setBusy] = useState(false)

  // recent labels (lazy)
  const [recentOpen, setRecentOpen] = useState(false)
  const [recent, setRecent] = useState<LabelT[] | null>(null)
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentErr, setRecentErr] = useState('')
  const [actionBusy, setActionBusy] = useState('')

  // void
  const [voidFor, setVoidFor] = useState<LabelT | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidErr, setVoidErr] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)

  /* reset + prefill whenever the dialog opens for a (new) row.
     BUG (E2E 8-e2e): the component stays mounted while the caller swaps the target
     row (labelFor → different batch), so the form reset alone is not enough — the
     lazy "recent labels" list kept the PREVIOUS row's scope (batchId filter never
     re-ran because recent !== null) and stayed expanded. Reset the recent list and
     void sub-dialog on every (re)open keyed by the target id, not just quantity.

     Implemented as guarded setState during render (React "you might not need
     an effect" — adjusting state when props change): the seen-key changes on
     every (open × target × defaultQuantity) transition, reset only while open,
     exactly like the previous effect (which no-op'ed while closed). */
  const targetKey = source === 'batch' ? batchId ?? '' : preparationId ?? ''
  const resetKey = open ? `${targetKey}\u0000${context.defaultQuantity}` : null
  const [seenResetKey, setSeenResetKey] = useState<string | null>(null)
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey)
    if (open) {
      setQuantity(context.defaultQuantity > 0 ? String(context.defaultQuantity) : '')
      setManualExpiry('')
      setNote('')
      setFormErr('')
      setBanner(false)
      setRecentOpen(false)
      setRecent(null)
      setActionBusy('')
      setVoidFor(null)
      setVoidReason('')
      setVoidErr('')
    }
  }

  const loadRecent = useCallback(async () => {
    setRecentLoading(true)
    setRecentErr('')
    try {
      const q = source === 'batch'
        ? `batchId=${encodeURIComponent(batchId ?? '')}`
        : `preparationId=${encodeURIComponent(preparationId ?? '')}`
      const d = await api<{ labels: LabelT[] }>(`/api/labels?${q}&take=20`)
      setRecent(d.labels ?? [])
    } catch (e) {
      setRecentErr(String((e as Error).message || e))
    } finally {
      setRecentLoading(false)
    }
  }, [source, batchId, preparationId])

  /* labelOut DTO → pure engine input (src/lib/label.ts) */
  const toPrintData = useCallback((l: LabelT): LabelPrintData => ({
    itemName: l.itemName,
    itemUnit: l.itemUnit,
    lotNumber: l.lotNumber,
    quantity: l.quantity,
    area: l.area,
    preparedAt: l.preparedAt,
    expiresAt: l.expiresAt,
    needsReview: l.needsReview,
    preparedByName: l.preparedByName,
    allergenCodes: l.allergens,
    locale,
  }), [locale])

  /* print strings stay localized client-side (i18n is a client concern) */
  const printStrings = useCallback((): LabelPrintStrings => ({
    title: t('lbl.print.title'),
    item: t('lbl.print.item'),
    prepared: t('lbl.print.prepared'),
    expiry: t('lbl.print.expiry'),
    needsReview: t('lbl.print.needsReview'),
    lot: t('lbl.print.lot'),
    qty: t('lbl.print.qty'),
    area: t('lbl.print.area'),
    by: t('lbl.print.by'),
    allergens: t('lbl.print.allergens'),
    scanNote: t('lbl.print.scanNote'),
  }), [t])

  /* server print prep (QR data + printCount++) → client physical print */
  async function printLabel(l: LabelT) {
    const res = await labelFetch(`/api/labels/${encodeURIComponent(l.id)}/print`, { method: 'POST' })
    if (!res.ok) {
      // 409 = print block (void/quarantine/recall/expired/removal/exhausted)
      toast({ variant: 'destructive', description: serverMsg(res.data, res.status) })
      return
    }
    const pr = (res.data ?? {}) as { label: LabelT; qrText: string; qrDataUrl: string; printCount: number }
    const printed = pr.label ?? l
    const out = await printLabelDocument({
      title: t('lbl.title'),
      lines: buildLabelLines(toPrintData(printed), printStrings()),
      qrText: pr.qrText,
      qrDataUrl: pr.qrDataUrl,
      ctx: { kind: 'label', refId: printed.id },
    })
    if (out.ok) {
      toast({ description: out.simulated ? t('lbl.printedSimulated') : t('lbl.printed') })
    } else {
      toast({ variant: 'destructive', description: `${t('lbl.printFailed')}${out.error ? ` — ${out.error}` : ''}` })
    }
  }

  async function createAndPrint() {
    if (busy) return
    const planned = Number(quantity.replace(',', '.'))
    if (!(planned > 0)) {
      setFormErr(t('batch.errQty'))
      return
    }
    setBusy(true)
    setFormErr('')
    setBanner(false)
    try {
      const res = await labelFetch('/api/labels', {
        method: 'POST',
        body: JSON.stringify({
          source,
          ...(source === 'batch' ? { batchId } : { preparationId }),
          quantity: planned,
          ...(manualExpiry ? { manualExpiresAt: manualExpiry } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      })
      if (res.status !== 201) {
        toast({ variant: 'destructive', description: serverMsg(res.data, res.status) })
        return
      }
      const created = (res.data ?? {}) as { label: LabelT; needsReview: boolean }
      if (created.needsReview) setBanner(true)
      await printLabel(created.label)
      onDone?.()
      if (recent !== null) await loadRecent()
    } finally {
      setBusy(false)
    }
  }

  async function reprint(l: LabelT) {
    if (actionBusy) return
    setActionBusy(l.id)
    try {
      await printLabel(l)
      onDone?.()
      if (recent !== null) await loadRecent()
    } finally {
      setActionBusy('')
    }
  }

  async function voidLabel() {
    if (!voidFor || voidBusy) return
    const reason = voidReason.trim()
    if (reason.length < 3) {
      setVoidErr(t('lbl.voidReasonHint'))
      return
    }
    setVoidBusy(true)
    setVoidErr('')
    try {
      const res = await labelFetch(`/api/labels/${encodeURIComponent(voidFor.id)}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) {
        toast({ variant: 'destructive', description: serverMsg(res.data, res.status) })
        return
      }
      toast({ description: t('lbl.voided') })
      setVoidFor(null)
      setVoidReason('')
      onDone?.()
      if (recent !== null) await loadRecent()
    } finally {
      setVoidBusy(false)
    }
  }

  const closeVoid = () => {
    setVoidFor(null)
    setVoidReason('')
    setVoidErr('')
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5 flex-wrap">
              <Tag className="w-4 h-4" aria-hidden /> {t('lbl.title')}
            </DialogTitle>
            <DialogDescription className="font-medium text-stone-700 break-words">
              {context.itemName}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            {/* read-only origin data (server re-reads the record — this is a preview) */}
            <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t('lbl.subtitle')}</p>
              <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-xs text-stone-500">{t('lbl.lot')}</dt>
                  <dd className="font-mono text-xs text-stone-800 break-all min-w-0">{context.lotNumber || '—'}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-stone-500">{t('lbl.qty')}</dt>
                  <dd className="text-stone-800">
                    {context.defaultQuantity > 0 ? `${context.defaultQuantity} ${context.unit}` : '—'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-stone-500">{t('lbl.area')}</dt>
                  <dd className="text-stone-800 truncate" title={context.area}>{context.area || '—'}</dd>
                </div>
              </dl>
            </div>

            {/* inputs */}
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="lbl-qty" className="text-xs">{t('lbl.qty')}</Label>
                <Input
                  id="lbl-qty"
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="h-10"
                  aria-describedby={context.unit ? `lbl-qty-unit` : undefined}
                />
                {context.unit && <p id="lbl-qty-unit" className="text-xs text-stone-400">{context.unit}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="lbl-expiry" className="text-xs">{t('lbl.manualExpiry')}</Label>
                <Input
                  id="lbl-expiry"
                  type="date"
                  value={manualExpiry}
                  onChange={(e) => setManualExpiry(e.target.value)}
                  className="h-10"
                />
                <p className="text-xs text-stone-400">{t('lbl.manualExpiryHint')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="lbl-note" className="text-xs">{t('lbl.note')}</Label>
                <Textarea
                  id="lbl-note"
                  rows={2}
                  maxLength={LABEL_NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('lbl.noteHint')}
                  className="min-h-16"
                />
                <p className="text-xs text-stone-400">{t('lbl.noteHint')}</p>
              </div>

              {/* rule hint (issue #24: shelf life comes ONLY from a confirmed rule) */}
              <p role="note" className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                {t('lbl.ruleHint')}
              </p>
            </div>

            {/* needsReview banner (label created without a confirmed shelf rule) */}
            {banner && (
              <p role="status" className="rounded-md border border-amber-300 bg-amber-100 p-2.5 font-medium text-amber-900">
                {t('lbl.needsReviewBanner')}
              </p>
            )}

            {formErr && <p role="alert" className="text-sm text-red-600">{formErr}</p>}

            {/* recent labels — lazy load on first expand */}
            <Collapsible
              open={recentOpen}
              onOpenChange={(v) => {
                setRecentOpen(v)
                if (v && recent === null && !recentLoading) void loadRecent()
              }}
            >
              <div className="border-t border-stone-200 pt-3 space-y-2">
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-left">
                  <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${recentOpen ? 'rotate-180' : ''}`} aria-hidden />
                  <span className="text-sm font-semibold">{t('lbl.recent')}</span>
                  {recent !== null && <Badge variant="secondary" className="ml-1">{recent.length}</Badge>}
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2 pt-1">
                  {recentLoading && <Skeleton className="h-16 w-full" />}
                  {!recentLoading && recentErr && <p className="text-xs text-red-600">{recentErr}</p>}
                  {!recentLoading && !recentErr && recent !== null && recent.length === 0 && (
                    <p className="text-xs text-stone-500">{t('common.none')}</p>
                  )}
                  {!recentLoading && !recentErr && (recent ?? []).length > 0 && (
                    <div className="max-h-72 overflow-y-auto pr-1 space-y-1.5">
                      {(recent ?? []).map((l) => {
                        const rowBusy = actionBusy === l.id
                        const isVoid = String(l.status).toUpperCase() === 'VOID'
                        return (
                          <div key={l.id} className="rounded-lg border border-stone-200 bg-white p-2.5 space-y-1.5 min-w-0">
                            <div className="flex items-center justify-between gap-2 min-w-0 flex-wrap">
                              <p className="text-sm font-medium truncate min-w-0">{l.itemName}</p>
                              <Badge variant="outline" className={`shrink-0 text-xs ${SCAN_STYLE[l.scanStatus] ?? ''}`}>
                                {t(`lbl.scan.${l.scanStatus}`)}
                              </Badge>
                            </div>
                            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                              <span>{new Date(l.createdAt).toLocaleDateString('sl-SI')}</span>
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-stone-600"
                                aria-label={`${t('lbl.reprint')}: ${l.printCount}`}
                              >
                                <Printer className="w-3 h-3" aria-hidden /> {l.printCount}×
                              </span>
                              {/* Staff surface must NOT use guest-prefix keys (lbl.public.*):
                                  in an EN-detected browser those render English while the rest
                                  of the staff dialog falls back to SL (EN is guest-only by design).
                                  lbl.print.expiry = staff key, SL/HR parity, same label text. */}
                              {l.expiresAt && <span className="truncate">{t('lbl.print.expiry')}: {new Date(l.expiresAt).toLocaleDateString('sl-SI')}</span>}
                              {l.note && <span className="truncate max-w-56" title={l.note}>{l.note}</span>}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {!isVoid && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-9 gap-1"
                                  disabled={rowBusy}
                                  onClick={() => void reprint(l)}
                                >
                                  {rowBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" aria-hidden />}
                                  {t('lbl.reprint')}
                                </Button>
                              )}
                              {canManage && !isVoid && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-9 gap-1 text-red-700 hover:bg-red-50 hover:text-red-800"
                                  disabled={rowBusy}
                                  onClick={() => { setVoidFor(l); setVoidReason(''); setVoidErr('') }}
                                >
                                  <Ban className="w-3.5 h-3.5" aria-hidden /> {t('lbl.void')}
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>

          <DialogFooter className="gap-2 flex-wrap">
            <Button variant="outline" className="h-10" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              className="h-10 gap-1.5 bg-emerald-700 hover:bg-emerald-800"
              disabled={busy}
              onClick={() => void createAndPrint()}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" aria-hidden />}
              {busy ? t('lbl.creating') : t('lbl.createAndPrint')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* void confirm — mandatory reason (inventory.manage, server-enforced ≥ 3 chars) */}
      <AlertDialog open={voidFor !== null} onOpenChange={(v) => { if (!v) closeVoid() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lbl.voidConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>{t('lbl.voidConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lbl-void-reason" className="text-xs">{t('lbl.voidReason')}</Label>
            <Textarea
              id="lbl-void-reason"
              rows={3}
              maxLength={200}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t('lbl.voidReasonHint')}
              className="min-h-16"
            />
            {voidErr && <p role="alert" className="text-xs text-red-600">{voidErr}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={voidBusy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={voidBusy}
              onClick={(e) => { e.preventDefault(); void voidLabel() }}
            >
              {voidBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('lbl.voidConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
