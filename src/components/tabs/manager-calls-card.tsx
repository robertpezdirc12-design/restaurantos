'use client'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje iz POS-a: PLOŠČA VODJE (zavihek Pregled).
 *
 * `ManagerCallsCard` je odzivna plošča vodstva (kartica se izriše samo za
 * canManage; backend za scope=all neodvisno zahteva vodstveno vlogo):
 *  - GET /api/manager-call?scope=all&limit=60 — polling 15 s MEDTEM ko je
 *    zavihek aktiven (Radix TabsContent se odmontira, ko ni izbran) — ta poll
 *    hkrati POGONI leno eskalacijo zapadlih klicev (strežniški komentar v #21 §2);
 *  - filtri: aktivni / zapadli / rešeni / vsi + statistike časa do
 *    potrditve/rešitve (issue §4: poročanje);
 *  - akcije statusnega avtomata: ack (prevzem) / progress / resolve
 *    (obvezen zapis ≥ 2) / cancel. 409 konflikt (sočasen prevzem dveh vodij)
 *    → toast + takojšnja osvežitev.
 *
 * Akcije so podprte s @/lib/manager-call-registry canTransition() — EN vir
 * resnice za veljavne prehode (isti kot PATCH ruta). PATCH gre prek raw fetch,
 * ker api() zavže HTTP status (409 konflikt ima telo { error, call }).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getToken } from '@/lib/client'
import { isNetworkError } from '@/lib/offline-queue'
import { useI18n } from '@/components/i18n'
import { EmptyStat } from '@/components/empty-stat'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { BellRing, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { canTransition, MANAGER_CALL_TERMINAL_STATUSES, type ManagerCallAction } from '@/lib/manager-call-registry'
import type { ManagerCallT } from '@/components/manager-call-dialog'
/* ISSUE #73 audit-33 (v1.139.0) — inline term tooltip + one-time module intro. */
import { TermTip } from '@/components/term-tip'
import { ModuleIntro } from '@/components/module-intro'

interface CallsStatsT {
  total: number
  byStatus: { open: number; escalated: number; acknowledged: number; inProgress: number; resolved: number; cancelled: number }
  avgMinutesToAcknowledge: number | null
  avgMinutesToResolve: number | null
  escalatedRounds: number
}
interface AllResp {
  calls: ManagerCallT[]
  stats?: CallsStatsT
}

type FilterT = 'active' | 'overdue' | 'resolved' | 'all'

/** Barvne oznake statusa (kamna + emerald paleta, brez indigo/modre) */
const STATUS_STYLE: Record<string, string> = {
  OPEN: 'bg-amber-100 text-amber-800 border-amber-300',
  ESCALATED: 'bg-rose-100 text-rose-800 border-rose-300',
  ACKNOWLEDGED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  IN_PROGRESS: 'bg-orange-100 text-orange-800 border-orange-300',
  RESOLVED: 'bg-stone-200 text-stone-700 border-stone-300',
  CANCELLED: 'bg-stone-100 text-stone-400 border-stone-200',
}

const FILTERS: { key: FilterT; labelKey: string }[] = [
  { key: 'active', labelKey: 'callv.card.filter.active' },
  { key: 'overdue', labelKey: 'callv.card.filter.overdue' },
  { key: 'resolved', labelKey: 'callv.card.filter.resolved' },
  { key: 'all', labelKey: 'callv.card.filter.all' },
]

/** Pre-DDL stanje: tabela ManagerCall še ni aplicirana (Enterprise → Shema migracije). */
function isDdlPendingError(msg: string): boolean {
  return /P2021|no such table|does not exist|internal server error|unexpected token/i.test(msg)
}

export function ManagerCallsCard() {
  const { t } = useI18n()
  const [calls, setCalls] = useState<ManagerCallT[]>([])
  const [stats, setStats] = useState<CallsStatsT | null>(null)
  const [filter, setFilter] = useState<FilterT>('active')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [actionBusy, setActionBusy] = useState('')
  const [resolveFor, setResolveFor] = useState<string | null>(null)
  const [resolveNote, setResolveNote] = useState('')

  /* polling 15 s — SAMO medtem ko je kartica odmontirana v AKTIVNEM zavihku;
     stabilne deps (useCallback []) — lekcija v1.110 o neskončnih fetch zankah. */
  const load = useCallback(async () => {
    try {
      const d = await api<AllResp>('/api/manager-call?scope=all&limit=60')
      setCalls(d.calls ?? [])
      setStats(d.stats ?? null)
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => { await load() })()
    const iv = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(iv)
  }, [load])

  /** PATCH prek raw fetch — 409 (sočasnost) ima posebno telo { error, call }. */
  const patchCall = useCallback(async (id: string, action: ManagerCallAction, note?: string): Promise<{ ok: boolean; conflict: boolean }> => {
    const token = getToken()
    try {
      const res = await fetch(`/api/manager-call/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action, ...(note !== undefined ? { note } : {}) }),
      })
      if (res.ok) return { ok: true, conflict: false }
      if (res.status === 409) return { ok: false, conflict: true }
      let msg = ''
      try { msg = String(((await res.json()) as { error?: string }).error || '') } catch { /* brez telesa */ }
      toast({ description: msg || `HTTP ${res.status}` })
      return { ok: false, conflict: false }
    } catch (e) {
      toast({ description: isNetworkError(e) ? t('callv.offline') : String((e as Error).message || e) })
      return { ok: false, conflict: false }
    }
  }, [t])

  async function act(id: string, action: ManagerCallAction, note?: string) {
    if (actionBusy) return
    setActionBusy(`${id}:${action}`)
    const r = await patchCall(id, action, note)
    if (r.ok) {
      setResolveFor(null)
      setResolveNote('')
    } else if (r.conflict) {
      toast({ description: t('callv.card.conflict') })
    }
    await load()
    setActionBusy('')
  }

  const terminal = (s: string) => (MANAGER_CALL_TERMINAL_STATUSES as readonly string[]).includes(s)

  const filtered = calls.filter((c) => {
    if (filter === 'active') return !terminal(c.status)
    if (filter === 'overdue') return c.overdue === true
    if (filter === 'resolved') return terminal(c.status)
    return true
  })

  /* ISSUE #74 V-14: prazen modul = ena vrstica (active filter, 0 klicev, ni napake). */
  const emptyActive = !loading && !err && filtered.length === 0 && filter === 'active'

  const fmtMin = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(n))
  /* ISSUE #74 V-15: NI PODATKA ni enako vrednosti — sivi »Povprečno — min do
     potrditve« je bil vizualno enak skeletonu nalaganja. Ko povprečja še ni, se
     izpiše razločno stanje (emptystat.noData + tooltip z razlago), ne »—«. */
  const hasWaitStats = stats != null
    && stats.avgMinutesToAcknowledge !== null && stats.avgMinutesToAcknowledge !== undefined
    && stats.avgMinutesToResolve !== null && stats.avgMinutesToResolve !== undefined

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <BellRing className="w-4 h-4" /> {t('callv.card.title')}
          {stats && (
            <Badge variant="secondary" className="ml-1">
              {filter === 'active' ? stats.total - stats.byStatus.resolved - stats.byStatus.cancelled : filtered.length}
            </Badge>
          )}
          {/* ISSUE #74 V-14: PRAZEN modul je ENA VRSTICA — v glavi enovrstično
              »ni aktivnih«, brez naloženega praznega Content bloka (prej je
              »Klici vodje 0« zasedel celotno širino in višino nad gubo). */}
          {emptyActive && <span className="text-xs font-normal text-stone-400">— {t('callv.card.empty')}</span>}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 ml-auto"
            onClick={() => { void load() }}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </CardTitle>
        <p className="text-xs text-stone-500">
          {t('callv.card.desc')}{' '}
          {/* ISSUE #73 audit-33: izraz eskalacija razložen na mestu uporabe */}
          <TermTip tipKey="term.escTip">{t('term.esc')}</TermTip>
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ISSUE #73 audit-33: kratka pomoč ob prvem vhodu v modul klicev —
            pot klica, potrditev in eskalacija. */}
        <ModuleIntro module="calls" titleKey="intro.calls.title" bodyKey="intro.calls.body" />
        {/* filtri — skriti, ko je modul prazen (V-14: ena vrstica, ne tri) */}
        {!emptyActive && (
          <div role="group" aria-label={t('common.all')} className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`min-h-8 rounded-full px-3 py-1 text-xs font-semibold border transition ${
                  filter === f.key
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-white border-stone-200 text-stone-600 hover:border-stone-400'
                }`}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>
        )}

        {loading && <Skeleton className="h-24 w-full" />}
        {err && (
          <p className={`text-sm ${isDdlPendingError(err) ? 'text-amber-700' : 'text-red-600'}`}>
            {isDdlPendingError(err) ? t('callv.card.ddlPending') : err}
          </p>
        )}

        {/* statistike (issue §4: časi do potrditve/rešitve + eskalacije);
            ISSUE #74 V-15: ločena stanja — povprečja obstajajo → številke; ni
     podatkov → razločno besedilo z tooltipom (ne sivi »—« pill) */}
        {stats && (
          hasWaitStats ? (
            <p className="text-xs text-stone-500 flex flex-wrap gap-x-1">
              {t('callv.card.stats', { ack: fmtMin(stats.avgMinutesToAcknowledge), resolve: fmtMin(stats.avgMinutesToResolve), esc: stats.escalatedRounds })}
            </p>
          ) : (
            <EmptyStat kind="no-data" />
          )
        )}

        {/* seznam — V-14: ko je modul prazen (emptyActive), je empty že v glavi */}
        {!emptyActive && !loading && !err && (
          <>
            {filtered.length === 0 && (
              <p className="text-sm text-stone-500">{filter === 'active' ? t('callv.card.empty') : t('common.none')}</p>
            )}
            {filtered.length > 0 && (
              <div className="max-h-96 overflow-y-auto pr-1 space-y-2">
                {filtered.map((c) => {
                  const busy = actionBusy.startsWith(c.id + ':')
                  const resolving = resolveFor === c.id
                  return (
                    <div key={c.id} className="rounded-xl border border-stone-200 bg-white p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <p className="text-sm font-medium truncate min-w-0">{t(`callv.type.${c.type}`)}</p>
                        <Badge variant="outline" className={`shrink-0 ${STATUS_STYLE[c.status] ?? ''}`}>{t(`callv.status.${c.status}`)}</Badge>
                      </div>
                      <p className="text-xs text-stone-500 min-w-0">
                        {t('callv.card.requestedBy', { name: c.requestorName })}
                        {(c.tableNumber || c.orderNumber) && (
                          <>
                            {' · '}
                            <span className="min-w-0 truncate">
                              {c.tableNumber ? t('callv.card.tableCtx', { n: c.tableNumber }) : ''}
                              {c.tableNumber && c.orderNumber ? ' · ' : ''}
                              {c.orderNumber ? t('callv.card.orderCtx', { n: c.orderNumber }) : ''}
                            </span>
                          </>
                        )}
                      </p>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs">
                        {c.ageMinutes !== null && c.ageMinutes !== undefined && !terminal(c.status) && (
                          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-600">{t('callv.card.age', { n: Math.round(c.ageMinutes) })}</span>
                        )}
                        {c.escalatedCount > 0 && (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-800 font-semibold">{t('callv.card.escalatedBadge', { n: c.escalatedCount })}</span>
                        )}
                        {c.overdue && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 font-semibold">{t('callv.card.overdueBadge')}</span>
                        )}
                        {c.minutesToAcknowledge !== null && c.minutesToAcknowledge !== undefined && (
                          <span className="text-stone-400">{t('callv.card.toAck', { n: c.minutesToAcknowledge })}</span>
                        )}
                        {c.minutesToResolve !== null && c.minutesToResolve !== undefined && (
                          <span className="text-stone-400">{t('callv.card.toResolve', { n: c.minutesToResolve })}</span>
                        )}
                      </p>
                      {c.note && <p className="text-xs text-stone-600 min-w-0">{c.note}</p>}
                      <p className="text-xs text-stone-400 min-w-0">
                        {c.acknowledgedByName ? t('callv.card.ackBy', { name: c.acknowledgedByName }) : ''}
                        {c.acknowledgedByName && c.resolvedByName ? ' · ' : ''}
                        {c.resolvedByName ? t('callv.card.resolvedBy', { name: c.resolvedByName }) : ''}
                      </p>
                      {c.resolutionNote && (
                        <p className="text-xs text-emerald-800 flex items-start gap-1.5 min-w-0">
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span className="min-w-0">{c.resolutionNote}</span>
                        </p>
                      )}

                      {resolving ? (
                        <div className="space-y-1.5 pt-1">
                          <label htmlFor={`mcc-res-${c.id}`} className="text-xs font-medium">{t('callv.card.resolveNote')}</label>
                          <Textarea
                            id={`mcc-res-${c.id}`}
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
                      ) : (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {canTransition('ack', c.status) && (
                            <Button
                              size="sm"
                              className="h-9 bg-emerald-700 hover:bg-emerald-800"
                              disabled={busy}
                              onClick={() => { void act(c.id, 'ack') }}
                            >
                              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t('callv.card.ack')}
                            </Button>
                          )}
                          {canTransition('progress', c.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9"
                              disabled={busy}
                              onClick={() => { void act(c.id, 'progress') }}
                            >
                              {t('callv.card.progress')}
                            </Button>
                          )}
                          {canTransition('resolve', c.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9"
                              disabled={busy}
                              onClick={() => { setResolveFor(c.id); setResolveNote('') }}
                            >
                              {t('callv.card.resolve')}
                            </Button>
                          )}
                          {canTransition('cancel', c.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9 text-red-700 hover:bg-red-50 hover:text-red-800"
                              disabled={busy}
                              onClick={() => { void act(c.id, 'cancel') }}
                            >
                              {t('callv.card.cancel')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
