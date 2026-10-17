'use client'

/**
 * Issue #14 (P1/P2, v1.112.0) — KDS task board for NAMED (custom) station views.
 *
 * Rendered from the KDS tab when `kdsStation` holds a custom station id
 * (any PrepStation whose type is NOT 'bar'/'kitchen' — those stay legacy
 * buckets). Props come from the ADDITIVE GET /api/kitchen fields
 * (stations / tasks / stationStats):
 *  - PREP board: tasks of the station (kind prep|modifier) grouped per order
 *    (header: table/orderType + #orderNumber + oldest task age);
 *  - EXPO board (station.isExpo): kind 'expo' tasks grouped per order — each
 *    row shows sibling prep-task readiness chips (issue §3 sync status) and
 *    an issue button, client-side disabled until every sibling is ready
 *    (the server re-checks and answers 409 with the blocker list);
 *  - actions PATCH /api/kitchen {taskId, action} via RAW fetch so 409
 *    (blocked by a predecessor station / CAS) surfaces the server error —
 *    same pattern as manager-calls-card;
 *  - timer per task: minutes since firedAt, red/amber classes share the
 *    legacy kdsAgeClass semantics with threshold delayThresholdForTarget
 *    (station.avgPrepTime) from @/lib/kds-delays;
 *  - re-render cadence: the dashboard 15 s poll replaces the tasks array
 *    (new identity) which re-renders this board — same as the legacy board.
 *
 * This file lives in src/components/ (NOT tabs/) on purpose — it is outside
 * the i18n regression-scan family; comments still use English/key names only
 * and every user-visible string goes through t().
 *
 * Issue #69 (2. val, P2 vizualni QA): gostota listka — glava vsake skupine je
 * razdeljena v dve vrstici (identiteta / ČASOVNIK + tiskanje), vrstice nalog
 * so kompaktnejše (py-1.5, space-y-1), starostne oznake so tabular-nums
 * text-xs, dejanja imajo cilj na dotik 44 px (h-11) in data-region="kds-*"
 * markerji pokrivajo strukturo (testi #69). IZKLJUČNO izris — dejanja,
 * sortiranje, zastarela logika (issue #70 §2) ostanejo pri istih klicih.
 */
import { useCallback, useState } from 'react'
import { useI18n } from '@/components/i18n'
import { getToken } from '@/lib/client'
import { toast } from '@/hooks/use-toast'
import { delayThresholdForTarget, isStaleKdsTicket, staleTicketHours } from '@/lib/kds-delays'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Check, Clock, Loader2, Lock, Printer, Ship } from 'lucide-react'

/** Station as returned by GET /api/kitchen (additive `stations` field). */
export interface KdsStationT {
  id: string
  name: string
  type: string
  isExpo: boolean
  sortOrder: number
  avgPrepTime: number
}

/** Active station task as returned by GET /api/kitchen (additive `tasks` field). */
export interface KdsTaskT {
  id: string
  itemId: string
  orderId: string
  orderNumber: number | null
  tableNumber: number | null
  orderType: string
  stationId: string
  stationName: string
  stationType: string
  viewKey: string
  kind: 'prep' | 'modifier' | 'expo'
  sequence: number
  status: 'waiting' | 'pending' | 'preparing' | 'ready'
  title: string
  detail: string
  quantity: number
  firedAt: string | null
  startedAt: string | null
  readyAt: string | null
  issuedAt: string | null
  readyByName: string
}

/** Per-station queue stats (issue §4) as returned by GET /api/kitchen. */
export interface KdsStationStatT {
  stationId: string
  stationName: string
  waiting: number
  pending: number
  preparing: number
  ready: number
  target: number | null
}

/** Status chip style + i18n label key (stone + amber/emerald palette only). */
export const KDS_TASK_STATUS: Record<string, { cls: string; labelKey: string }> = {
  waiting: { cls: 'bg-stone-100 text-stone-500 border-stone-300', labelKey: 'kds.stWaiting' },
  pending: { cls: 'bg-amber-50 text-amber-800 border-amber-300', labelKey: 'kds.stQueued' },
  preparing: { cls: 'bg-amber-500 text-white border-amber-600', labelKey: 'kds.stInPrep' },
  ready: { cls: 'bg-emerald-600 text-white border-emerald-700', labelKey: 'kds.stReady' },
}

/** Status icon for chips (a11y: aria-hidden, the chip carries the label). */
function TaskStatusIcon({ status }: { status: string }) {
  if (status === 'waiting') return <Lock className="w-3 h-3" aria-hidden />
  if (status === 'pending') return <Clock className="w-3 h-3" aria-hidden />
  if (status === 'preparing') return <Loader2 className="w-3 h-3 animate-pulse" aria-hidden />
  return <Check className="w-3 h-3" aria-hidden />
}

/** Minutes since firedAt (never negative, 0 without a timestamp). */
const taskAge = (iso: string | null): number =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)) : 0

/** Legacy kdsAgeClass semantics with the station-specific threshold. */
const ageClass = (m: number, threshold: number): string =>
  m >= threshold ? 'bg-red-100 text-red-700 border-red-200' : m >= 5 ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'

/** Oldest task age of a group (order header clock). */
const oldestAge = (tasks: KdsTaskT[]): number => {
  const ms = tasks
    .map((task) => (task.firedAt ? new Date(task.firedAt).getTime() : Number.POSITIVE_INFINITY))
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
  return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : 0
}

/** Issue #70 §2: skupina je zastarjša (> 8 h) — določi z najstarejšo nalogo skupine. */
const groupIsStale = (g: TaskGroupT): boolean => isStaleKdsTicket(oldestAge(g.tasks))

interface TaskGroupT { orderId: string; orderNumber: number | null; tableNumber: number | null; orderType: string; tasks: KdsTaskT[] }

/** Group tasks by order, oldest order first (server order: sequence, createdAt). */
function groupByOrder(tasks: KdsTaskT[]): TaskGroupT[] {
  const byOrder = new Map<string, KdsTaskT[]>()
  for (const task of tasks) {
    const cur = byOrder.get(task.orderId)
    if (cur) cur.push(task)
    else byOrder.set(task.orderId, [task])
  }
  const groups: TaskGroupT[] = [...byOrder.values()].map((ts) => ({
    orderId: ts[0].orderId,
    orderNumber: ts[0].orderNumber,
    tableNumber: ts[0].tableNumber,
    orderType: ts[0].orderType,
    tasks: ts,
  }))
  groups.sort((a, b) => {
    const aMs = Math.min(...a.tasks.map((task) => (task.firedAt ? new Date(task.firedAt).getTime() : Number.POSITIVE_INFINITY)))
    const bMs = Math.min(...b.tasks.map((task) => (task.firedAt ? new Date(task.firedAt).getTime() : Number.POSITIVE_INFINITY)))
    return aMs - bMs
  })
  return groups
}

export function KdsStationBoard({
  station,
  tasks,
  onDone,
  onPrintOrder,
}: {
  station: KdsStationT
  /** ALL active tasks of the location (the expo view needs sibling tasks). */
  tasks: KdsTaskT[]
  /** reload callback (dashboard load() — 15 s poll keeps the board fresh). */
  onDone: () => void | Promise<void>
  /** optional kitchen ticket print for an order id (wired in dashboard). */
  onPrintOrder?: (orderId: string) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState('')

  /** PATCH /api/kitchen {taskId, action} — raw fetch to READ the 409 body. */
  const act = useCallback(
    async (task: KdsTaskT, action: 'start' | 'ready' | 'issue') => {
      if (busy) return
      setBusy(`${task.id}:${action}`)
      const token = getToken()
      try {
        const res = await fetch('/api/kitchen', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ taskId: task.id, action }),
        })
        if (!res.ok) {
          let msg = `HTTP ${res.status}`
          try {
            msg = String(((await res.json()) as { error?: string }).error || msg)
          } catch { /* no body */ }
          toast({ variant: 'destructive', description: msg })
        }
        await onDone()
      } catch (e) {
        toast({ variant: 'destructive', description: String((e as Error).message || e) })
      } finally {
        setBusy('')
      }
    },
    [busy, onDone],
  )

  const threshold = delayThresholdForTarget(station.avgPrepTime)
  const prepTasks = tasks.filter((task) => task.stationId === station.id && task.kind !== 'expo')
  const expoTasks = station.isExpo ? tasks.filter((task) => task.stationId === station.id && task.kind === 'expo') : []
  // Issue #70 §2: zastarele skupine (> 8 h — demo/prejšnja izmena) NA KONEC table (stabilno —
  // znotraj skupine ohrani najstarejša-prvi vrstni red); aktivne naloge ostanejo na vrhu.
  const staleLast = (groups: TaskGroupT[]): TaskGroupT[] => {
    const active = groups.filter((g) => !groupIsStale(g))
    const stale = groups.filter((g) => groupIsStale(g))
    return [...active, ...stale]
  }
  const prepGroups = staleLast(groupByOrder(prepTasks))
  const expoGroups = staleLast(groupByOrder(expoTasks))
  const total = prepTasks.length + expoTasks.length

  const orderLabel = (g: TaskGroupT): string =>
    g.tableNumber ? t('kds.stTable', { n: g.tableNumber }) : g.orderType

  const orderHeader = (g: TaskGroupT, age: number, stale = false) => (
    /* Issue #69 (2. val): gostota — identiteta + # v prvi vrstici, ČASOVNIK dominantno
       v drugi vrstici (fiksna lega v glavi listka, ne med postavkami). Samo izris. */
    <CardTitle className="space-y-1.5">
      <div data-region="kds-ticket-identity" className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        <span className="text-sm sm:text-base font-bold truncate max-w-full min-w-0">{orderLabel(g)}</span>
        <span className="text-xs font-normal text-stone-500 min-w-0 shrink">#{g.orderNumber ?? '?'}</span>
      </div>
      <div data-region="kds-ticket-timer-row" className="flex items-center gap-2 flex-wrap">
        {/* Issue #70 §2: zastareli listek — siva oznaka ZASTARELO + starost v urah (ne minutah) */}
        <span
          data-region="kds-ticket-timer"
          className={`text-sm font-extrabold tabular-nums px-2.5 py-1 rounded-full border shrink-0 ${stale ? 'bg-stone-100 text-stone-600 border-stone-300' : ageClass(age, threshold)}`}
          title={stale ? `${t('kds.stale')} — ${t('kds.minutes', { m: age })}` : undefined}
        >
          {stale ? `${t('kds.stale')}: ${t('kds.staleHours', { h: staleTicketHours(age) })}` : t('kds.minutes', { m: age })}
        </span>
        {onPrintOrder && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1 h-9 text-xs ml-auto shrink-0"
            onClick={() => onPrintOrder(g.orderId)}
            title={t('kitchen.printKitchenTitle')}
            aria-label={t('kitchen.printKitchenTitle')}
          >
            <Printer className="w-3 h-3" />
          </Button>
        )}
      </div>
    </CardTitle>
  )

  return (
    <Card data-component="kds-station-card" data-region="kds-ticket" className="min-w-0 gap-2 py-3 sm:py-4 border-stone-200">
      <CardHeader data-region="kds-ticket-header" className="pb-0">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <span className="truncate min-w-0">{station.name}</span>
          {station.isExpo && (
            <Badge variant="outline" className="gap-1 shrink-0 border-emerald-300 bg-emerald-50 text-emerald-800">
              <Ship className="w-3 h-3" aria-hidden /> {t('kds.stExpo')}
            </Badge>
          )}
          <Badge variant="outline" className="shrink-0 text-stone-600">{t('kds.stTarget', { n: station.avgPrepTime })}</Badge>
          <Badge variant="secondary" className="shrink-0">{t('kds.stQueue', { n: total })}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent data-region="kds-ticket-items" className="space-y-2.5">
        {total === 0 && <p className="text-sm text-stone-500">{t('kitchen.queueEmpty')}</p>}

        {/* ── expo view (dispatch): per-order readiness of ALL prep stations (issue §3) ── */}
        {expoGroups.map((g) => {
          const age = oldestAge(tasks.filter((task) => task.orderId === g.orderId))
          return (
            <div key={`expo-${g.orderId}`} data-region="kds-ticket-item-group" className={`rounded-xl border p-3 space-y-2 min-w-0 ${groupIsStale(g) ? 'border-dashed border-stone-300 bg-stone-50' : 'border-emerald-200 bg-emerald-50/40'}`}>
              {orderHeader(g, age, groupIsStale(g))}
              {g.tasks.map((task) => {
                // sibling prep tasks of the SAME item — sync chips (issue §3)
                const siblings = tasks.filter((s) => s.itemId === task.itemId && s.kind !== 'expo')
                const blockers = siblings.filter((s) => s.status !== 'ready')
                const taskBusy = busy.startsWith(task.id + ':')
                return (
                  <div key={task.id} data-region="kds-ticket-item" className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 space-y-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <p className="text-sm sm:text-base font-semibold truncate min-w-0">{task.quantity}× {task.title}</p>
                      {/* Issue #70 §2: zastareli listki — starost naloge v urah (ne "13.496′") */}
                      <span className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-full border shrink-0 ${groupIsStale(g) ? 'bg-stone-100 text-stone-600 border-stone-300' : ageClass(taskAge(task.firedAt), threshold)}`}>{groupIsStale(g) ? t('kds.staleHours', { h: staleTicketHours(taskAge(task.firedAt)) }) : `${taskAge(task.firedAt)}′`}</span>
                    </div>
                    {task.detail && <p className="text-xs text-stone-500 min-w-0">ℹ {task.detail}</p>}
                    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('kds.stStatsTitle')}>
                      {siblings.map((s) => (
                        <span
                          key={s.id}
                          title={`${s.stationName} — ${t(KDS_TASK_STATUS[s.status]?.labelKey ?? 'kds.stWaiting')}`}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${KDS_TASK_STATUS[s.status]?.cls ?? KDS_TASK_STATUS.waiting.cls}`}
                        >
                          <TaskStatusIcon status={s.status} />
                          <span className="max-w-24 truncate">{s.stationName}</span>
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      {blockers.length > 0 ? (
                        <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 text-amber-800">
                          <Clock className="w-3 h-3" aria-hidden /> {t('kds.stExpoWait')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-800">
                          <Check className="w-3 h-3" aria-hidden /> {t('kds.stAtStation')}
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        className="h-11 gap-1 bg-emerald-700 hover:bg-emerald-800"
                        disabled={blockers.length > 0 || !!busy}
                        onClick={() => void act(task, 'issue')}
                      >
                        {taskBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Ship className="w-4 h-4" aria-hidden />}
                        {t('kds.stIssue')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* ── prep board: tasks of THIS station grouped per order ── */}
        {prepGroups.map((g) => {
          const age = oldestAge(g.tasks)
          return (
            <div key={g.orderId} data-region="kds-ticket-item-group" className={`rounded-xl border p-3 space-y-2 min-w-0 ${groupIsStale(g) ? 'border-dashed border-stone-300 bg-stone-50' : 'border-stone-200'}`}>
              {orderHeader(g, age, groupIsStale(g))}
              {groupIsStale(g) && (
                <p className="rounded border border-stone-300 bg-stone-100 px-2 py-1 text-xs text-stone-600">{t('kds.staleHint')}</p>
              )}
              {g.tasks.map((task) => {
                const st = KDS_TASK_STATUS[task.status] ?? KDS_TASK_STATUS.pending
                const taskBusy = busy.startsWith(task.id + ':')
                return (
                  <div key={task.id} data-region="kds-ticket-item" className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 space-y-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <p className="text-sm sm:text-base font-semibold truncate min-w-0">
                        {task.quantity}× {task.title}
                        {task.kind === 'modifier' && (
                          <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0 shrink-0">{t('kds.stTaskKind.modifier')}</Badge>
                        )}
                        {task.kind === 'expo' && (
                          <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0 shrink-0">{t('kds.stTaskKind.expo')}</Badge>
                        )}
                      </p>
                      {/* Issue #70 §2: zastareli listki — starost postavke v urah (ne minutah) */}
                      <span className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-full border shrink-0 ${groupIsStale(g) ? 'bg-stone-100 text-stone-600 border-stone-300' : ageClass(taskAge(task.firedAt), threshold)}`}>{groupIsStale(g) ? t('kds.staleHours', { h: staleTicketHours(taskAge(task.firedAt)) }) : `${taskAge(task.firedAt)}′`}</span>
                    </div>
                    {task.detail && <p className="text-xs text-stone-500 min-w-0">ℹ {task.detail}</p>}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <Badge variant="outline" className={`gap-1 shrink-0 ${st.cls}`}>
                        <TaskStatusIcon status={task.status} />
                        {t(st.labelKey)}
                      </Badge>
                      <div className="flex gap-1.5 shrink-0">
                        {task.status === 'waiting' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-11 gap-1"
                            disabled
                            title={t('kds.stBlocked')}
                          >
                            <Lock className="w-4 h-4" aria-hidden /> {t('kds.stWaiting')}
                          </Button>
                        )}
                        {task.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-11"
                            disabled={!!busy}
                            onClick={() => void act(task, 'start')}
                          >
                            {taskBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
                            {t('kds.stStart')}
                          </Button>
                        )}
                        {task.status === 'preparing' && (
                          <Button
                            size="sm"
                            className="h-11 bg-emerald-700 hover:bg-emerald-800"
                            disabled={!!busy}
                            onClick={() => void act(task, 'ready')}
                          >
                            {taskBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
                            {t('kds.stMarkReady')}
                          </Button>
                        )}
                        {task.status === 'ready' && (
                          <span className="text-[11px] text-stone-500 truncate min-w-0" title={task.readyByName}>
                            {task.readyByName ? `${task.readyByName} · ` : ''}{t('kds.stReady')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
