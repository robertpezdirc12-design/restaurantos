'use client'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: DIALOG (gumb + pošiljanje).
 *
 * `ManagerCallButton` je CTA za osebje VSEH vlog (issue §1: "zaposleni sproži
 * zahtevo z enega klika"): Bell ikona → dialog z izbiro vrste (dovoljene iz
 * nastavitev), neobvezno opombo, kontekstom (miza/naročilo) in pošiljanjem.
 *
 * Vir podatkov:
 *  - GET  /api/manager-call (settings.allowedTypes — ob vsakem odprtju, fallback
 *    = vseh 5 vrst iz client-safe registra MANAGER_CALL_TYPES)
 *  - POST /api/manager-call { type, note?, orderId?, tableNumber?, idempotencyKey }
 *    → 201 { call, replayed:false } | 200 { call, replayed:true } (dedup okno)
 *  - GET  /api/manager-call?scope=mine → "Moji klici" (samo AKTIVNI statusi),
 *    polling 15 s SAMO medtem ko je dialog odprt
 *  - PATCH /api/manager-call/[id] { action:'resolve'|'cancel', note? } — resolve
 *    samo vodstvo (strežnik neodvisno uveljavja), cancel prosilec svojega klica
 *
 * Dostava je POŠTENA (issue §4: brez trditve o prejemu brez dokazila): pod
 * ravnokaj poslanim klicom izrišemo deliveryStatus (sent/none/off) iz odgovora
 * strežnika — potrditev je IZKLJUČNO ack akcija vodje.
 *
 * Finančna ločenost (issue §3): tip APPROVAL je samo ZAHTLEVA — ob izbiri
 * pokažemo opombo callv.finNote (klic NE odobri popusta/storna).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { isNetworkError } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Bell, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  MANAGER_CALL_TYPES,
  MANAGER_CALL_ACTIVE_STATUSES,
  MANAGER_CALL_TERMINAL_STATUSES,
  type ManagerCallType,
} from '@/lib/manager-call-registry'

/** API oblika ManagerCall (serializeManagerCall) — polja, ki jih UI dejansko bere */
export interface ManagerCallT {
  id: string
  type: string
  status: string
  note: string
  orderId: string | null
  orderNumber: string | null
  tableNumber: number | null
  requestorId: string
  requestorName: string
  deliveryStatus: string
  notifiedCount: number
  escalatedCount: number
  acknowledgedAt: string | null
  acknowledgedByName: string | null
  resolvedAt: string | null
  resolvedByName: string | null
  resolutionNote: string
  cancelledAt: string | null
  createdAt: string
  ageMinutes: number | null
  minutesToAcknowledge: number | null
  minutesToResolve: number | null
  overdue: boolean
}

/** Vodstvene vloge — SAMO prikaz (resolve gumb); strežnik uveljavja neodvisno. */
const MANAGERIAL_UI_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'GROUP_OWNER', 'ORG_ADMIN', 'PROPERTY_MANAGER']

/** Barvne oznake statusa (kamna + emerald paleta, brez indigo/modre) */
const STATUS_STYLE: Record<string, string> = {
  OPEN: 'bg-amber-100 text-amber-800 border-amber-300',
  ESCALATED: 'bg-rose-100 text-rose-800 border-rose-300',
  ACKNOWLEDGED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  IN_PROGRESS: 'bg-orange-100 text-orange-800 border-orange-300',
  RESOLVED: 'bg-stone-200 text-stone-700 border-stone-300',
  CANCELLED: 'bg-stone-100 text-stone-400 border-stone-200',
}

/** Poštena dostavna vrstica pod ravnokaj poslanim klicem (issue §4). */
function deliveryText(t: (k: string, vars?: Record<string, string | number>) => string, call: ManagerCallT): string {
  if (call.deliveryStatus === 'sent') return t('callv.delivery.sent', { n: call.notifiedCount })
  if (call.deliveryStatus === 'none') return t('callv.delivery.none')
  if (call.deliveryStatus === 'off') return t('callv.delivery.off')
  return t('callv.delivery.pending')
}

export function ManagerCallButton({
  orderId,
  tableNumber,
  /** SAMO prikaz konteksta (številka naročila v listu naročila) — strežnik jo izpelje iz orderId */
  orderNumber,
  size = 'default',
  className,
}: {
  orderId?: string
  tableNumber?: number
  orderNumber?: string | number
  size?: 'sm' | 'default'
  className?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ManagerCallType | null>(null)
  const [allowedTypes, setAllowedTypes] = useState<readonly ManagerCallType[]>(MANAGER_CALL_TYPES)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState<{ call: ManagerCallT; replayed: boolean } | null>(null)
  const [mine, setMine] = useState<ManagerCallT[]>([])
  const [actionBusy, setActionBusy] = useState('')
  const [resolveFor, setResolveFor] = useState<string | null>(null)
  const [resolveNote, setResolveNote] = useState('')

  const user = typeof window !== 'undefined' ? getUser() : null
  // resolve je vodstvena akcija (PATCH 403 za nevodstvene) — gumb pokažemo samo vodstvu
  const managerial = MANAGERIAL_UI_ROLES.includes(String(user?.role ?? '').toUpperCase())

  /* dovoljene vrste (nastavitve) — enkrat na odprtje dialoga; fallback = vseh 5 */
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const d = await api<{ settings?: { allowedTypes?: ManagerCallType[] } }>('/api/manager-call?scope=active&limit=1')
        if (alive && d.settings?.allowedTypes && d.settings.allowedTypes.length > 0) {
          setAllowedTypes(d.settings.allowedTypes)
        }
      } catch { /* fallback: MANAGER_CALL_TYPES (že privzeto) */ }
    })()
    return () => { alive = false }
  }, [open])

  /* "Moji klici" — nalaganje ob odprtju + polling 15 s MEDTEM ko je dialog odprt.
     LEKCIJA (v1.110): stabilne deps (useCallback []) — sicer nestabilni objekti
     naredijo neskončno fetch zanko. Interval se počisti ob zaprtju. */
  const loadMine = useCallback(async () => {
    try {
      const d = await api<{ calls: ManagerCallT[] }>('/api/manager-call?scope=mine')
      setMine((d.calls ?? []).filter((c) => (MANAGER_CALL_ACTIVE_STATUSES as readonly string[]).includes(c.status)))
    } catch { /* tiho — naslednji polling poskusi znova */ }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadMine()
    const iv = setInterval(() => { void loadMine() }, 15_000)
    return () => clearInterval(iv)
  }, [open, loadMine])

  /* privzeta izbira = prva dovoljena vrsta (en klik — issue §1) */
  useEffect(() => {
    if (!type || !allowedTypes.includes(type)) setType(allowedTypes[0] ?? null)
  }, [allowedTypes, type])

  function onOpenChange(v: boolean) {
    setOpen(v)
    if (!v) {
      setSent(null)
      setNote('')
      setResolveFor(null)
      setResolveNote('')
    }
  }

  async function send() {
    if (!type || pending) return
    setPending(true)
    try {
      const body: Record<string, unknown> = {
        type,
        idempotencyKey: `mc-${Date.now()}`,
        ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}),
        ...(orderId ? { orderId } : {}),
        ...(tableNumber ? { tableNumber } : {}),
      }
      const d = await api<{ call: ManagerCallT; replayed: boolean }>('/api/manager-call', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setSent(d)
      setNote('')
      void loadMine()
    } catch (e) {
      if (isNetworkError(e)) toast({ description: t('callv.offline') })
      else toast({ description: `${t('callv.error')}: ${String((e as Error).message || e)}` })
    } finally {
      setPending(false)
    }
  }

  async function act(callId: string, action: 'resolve' | 'cancel', resolveNoteText: string) {
    if (actionBusy) return
    setActionBusy(`${callId}:${action}`)
    try {
      await api(`/api/manager-call/${callId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action, ...(action === 'resolve' ? { note: resolveNoteText } : {}) }),
      })
      setResolveFor(null)
      setResolveNote('')
      void loadMine()
    } catch (e) {
      if (isNetworkError(e)) toast({ description: t('callv.offline') })
      else toast({ description: `${t('callv.error')}: ${String((e as Error).message || e)}` })
      void loadMine()
    } finally {
      setActionBusy('')
    }
  }

  const terminal = (s: string) => (MANAGER_CALL_TERMINAL_STATUSES as readonly string[]).includes(s)

  return (
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        className={cn(size === 'sm' ? 'h-9' : 'h-11', className)}
        onClick={() => onOpenChange(true)}
        aria-label={t('callv.cta')}
        title={t('callv.cta')}
      >
        <Bell className="w-4 h-4" />
        <span className="hidden sm:inline">{t('callv.cta')}</span>
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-full max-w-md sm:max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-1.5">
              <Bell className="w-4 h-4" /> {t('callv.title')}
            </DialogTitle>
            <DialogDescription>{t('callv.desc')}</DialogDescription>
          </DialogHeader>

          {/* kontekst (miza / naročilo) — SAMO prikaz potrditve, kaj se priloži */}
          {(tableNumber || orderNumber !== undefined) && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 -mt-1">
              {typeof tableNumber === 'number' && (
                <span className="rounded-full border border-stone-200 px-2 py-0.5">{t('callv.card.tableCtx', { n: tableNumber })}</span>
              )}
              {orderNumber !== undefined && orderNumber !== null && orderNumber !== '' && (
                <span className="rounded-full border border-stone-200 px-2 py-0.5">{t('callv.card.orderCtx', { n: String(orderNumber) })}</span>
              )}
            </p>
          )}

          {sent ? (
            /* ── uspeh: poštena dostava + kontekst poslanega klica ── */
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-1">
                <p className="text-sm font-semibold text-emerald-800 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="min-w-0 truncate">{sent.replayed ? t('callv.replayed') : t('callv.sent')}</span>
                </p>
                {!sent.replayed && <p className="text-xs text-emerald-700">{t('callv.sentDesc')}</p>}
                <p className="text-xs text-stone-600 min-w-0 truncate">{t(`callv.type.${sent.call.type}`)}</p>
                <p className="text-xs text-stone-500">{deliveryText(t, sent.call)}</p>
                {(sent.call.tableNumber || sent.call.orderNumber) && (
                  <p className="text-xs text-stone-500 flex flex-wrap items-center gap-1.5">
                    {typeof sent.call.tableNumber === 'number' && (
                      <span className="rounded-full border border-emerald-200 px-2 py-0.5">{t('callv.card.tableCtx', { n: sent.call.tableNumber })}</span>
                    )}
                    {sent.call.orderNumber && (
                      <span className="rounded-full border border-emerald-200 px-2 py-0.5">{t('callv.card.orderCtx', { n: sent.call.orderNumber })}</span>
                    )}
                  </p>
                )}
              </div>
              <Button type="button" variant="outline" className="h-11 w-full" onClick={() => setSent(null)}>
                {t('callv.new')}
              </Button>
            </div>
          ) : (
            /* ── obrazec: vrsta + opomba ── */
            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t('callv.type')}</p>
                <div role="radiogroup" aria-label={t('callv.type')} className="grid gap-2 sm:grid-cols-2">
                  {allowedTypes.map((ty) => (
                    <button
                      key={ty}
                      type="button"
                      role="radio"
                      aria-checked={type === ty}
                      onClick={() => setType(ty)}
                      className={`min-h-11 rounded-xl border px-3 py-2 text-left text-sm font-medium transition ${
                        type === ty
                          ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
                          : 'border-stone-200 bg-white text-stone-700 hover:border-stone-400'
                      }`}
                    >
                      {t(`callv.type.${ty}`)}
                    </button>
                  ))}
                </div>
              </div>

              {type === 'APPROVAL' && (
                <p className="text-xs text-amber-700 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">{t('callv.finNote')}</p>
              )}

              <div className="space-y-1.5">
                <label htmlFor="mc-note" className="text-sm font-medium">{t('callv.note')}</label>
                <Textarea
                  id="mc-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t('callv.notePh')}
                  maxLength={300}
                  className="min-h-20"
                />
              </div>
            </div>
          )}

          {/* ── "Moji klici" — aktivni statusi, 15 s polling med odprtim dialogom ── */}
          <div className="space-y-2">
            <p className="text-sm font-semibold">{t('callv.mine')}</p>
            {mine.length === 0 && <p className="text-sm text-stone-500">{t('callv.mineEmpty')}</p>}
            {mine.length > 0 && (
              <div className="max-h-72 overflow-y-auto pr-1 space-y-2" role="list" aria-label={t('callv.mine')}>
                {mine.map((c) => {
                  const busy = actionBusy.startsWith(c.id + ':')
                  const resolving = resolveFor === c.id
                  const canAct = !terminal(c.status)
                  return (
                    <div key={c.id} role="listitem" className="rounded-xl border border-stone-200 p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <p className="text-sm font-medium truncate min-w-0">{t(`callv.type.${c.type}`)}</p>
                        <Badge variant="outline" className={`shrink-0 ${STATUS_STYLE[c.status] ?? ''}`}>{t(`callv.status.${c.status}`)}</Badge>
                      </div>
                      <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {c.ageMinutes !== null && c.ageMinutes !== undefined && (
                          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">{t('callv.card.age', { n: Math.round(c.ageMinutes) })}</span>
                        )}
                        {c.escalatedCount > 0 && (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-800 font-semibold">{t('callv.card.escalatedBadge', { n: c.escalatedCount })}</span>
                        )}
                        {c.overdue && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 font-semibold">{t('callv.card.overdueBadge')}</span>
                        )}
                        {(c.tableNumber || c.orderNumber) && (
                          <span className="text-stone-500 min-w-0 truncate">
                            {c.tableNumber ? t('callv.card.tableCtx', { n: c.tableNumber }) : ''}
                            {c.tableNumber && c.orderNumber ? ' · ' : ''}
                            {c.orderNumber ? t('callv.card.orderCtx', { n: c.orderNumber }) : ''}
                          </span>
                        )}
                      </p>
                      {c.note && <p className="text-xs text-stone-600 min-w-0">{c.note}</p>}
                      {c.acknowledgedByName && <p className="text-[11px] text-stone-500">{t('callv.card.ackBy', { name: c.acknowledgedByName })}</p>}

                      {resolving ? (
                        <div className="space-y-1.5 pt-1">
                          <label htmlFor={`mc-res-${c.id}`} className="text-xs font-medium">{t('callv.card.resolveNote')}</label>
                          <Textarea
                            id={`mc-res-${c.id}`}
                            className="min-h-16"
                            value={resolveNote}
                            placeholder={t('callv.card.resolveNotePh')}
                            maxLength={300}
                            onChange={(e) => setResolveNote(e.target.value)}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              className="h-9 bg-emerald-700 hover:bg-emerald-800"
                              disabled={busy || resolveNote.trim().length < 2}
                              onClick={() => { void act(c.id, 'resolve', resolveNote.trim()) }}
                            >
                              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('callv.card.resolve')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9"
                              disabled={busy}
                              onClick={() => { setResolveFor(null); setResolveNote('') }}
                            >
                              {t('common.cancel')}
                            </Button>
                          </div>
                        </div>
                      ) : canAct ? (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {managerial && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9"
                              onClick={() => { setResolveFor(c.id); setResolveNote('') }}
                            >
                              {t('callv.card.resolve')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 text-red-700 hover:bg-red-50 hover:text-red-800"
                            disabled={busy}
                            onClick={() => { void act(c.id, 'cancel', '') }}
                          >
                            {t('callv.card.cancel')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {!sent && (
            <DialogFooter>
              <Button
                type="button"
                className="h-11 w-full bg-emerald-700 hover:bg-emerald-800"
                disabled={!type || pending}
                onClick={() => void send()}
              >
                {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                {pending ? t('callv.sending') : t('callv.send')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
