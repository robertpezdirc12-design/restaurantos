'use client'

/**
 * Issue #22 (P2, v1.115.0) — ZAVIHEK OBRAČUN (plače, pripravljeni podatki).
 *
 * Vir podatkov (backend 3-a, živ na dev :3007):
 *  - GET/POST /api/payroll              — seznam/ustvarjanje obdobij (503 pre-DDL)
 *  - GET /api/payroll/[id]              — detail: totals (ŽIVE za draft), zaposleni
 *    po delovnih mestih, izjeme + exceptionsSummary, bazeni napitnin, izvozi
 *  - POST /api/payroll/[id]/close       — 409 { error, exceptions } brez ack
 *  - POST /api/payroll/[id]/reopen      — reason 3–500
 *  - GET /api/payroll/[id]/export       — ?format=csv (attachment) | json (ok JSON)
 *  - GET/PUT /api/employees/[id]/jobs   — plačne postavke (EmployeeJob REPLACE SET)
 *  - GET /api/employees, /api/jobs      — izbirniki (oblike v interfejsih spodaj)
 *
 * Konvencije (kopirane iz družine tabs/): NapitnineTab (locations + canManage
 * propi, fmtEUR centi/100), exceptions-card (blob izvoz z Bearer + imenom iz
 * Content-Disposition), DelovniCasTab (tabele max-h-96 overflow-y-auto, badge
 * barve tipov), analitika-tab (Collapsible), LaborCostCard (error vrstica s
 * Ponovi). i18n skupina payr.* — predpona 'pay.' je ZASEDENA (gostovska plačilna
 * stran, EN delni slovar tests/i18n-guest.test.ts), zato živi payroll domena
 * pod payr.* (polna SL/HR pariteta, tests/i18n.test.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, fmtEUR, getToken } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Loader2, RefreshCw, Plus, ChevronDown, ArrowLeft, Lock, RotateCcw, FileDown, FileJson,
  AlertTriangle, Coins, Trash2, Users, Moon, Percent,
} from 'lucide-react'

/* ─────────────────────────── TIPI (API pogodba 3-a) ─────────────────────────── */

/** periodDto + exportCount/lastExportAt (GET /api/payroll). */
export interface PayrollPeriodT {
  id: string
  locationId: string | null
  periodStart: string
  periodEnd: string
  startISO: string
  endISO: string
  timezone: string
  status: 'draft' | 'closed'
  closedAt: string | null
  closedById: string | null
  closeNote: string
  reopenCount: number
  version: number
  /** snapshot polja — za OSNUTEK so 0 (žive vsote so šele v detail) */
  entryCount: number
  approvedCount: number
  exceptionCount: number
  netMinutesApproved: number
  grossPayCents: number
  cashTipsCents: number
  cardTipsCents: number
  tipsPendingCents: number
  tipsPaidCents: number
  exportCount: number
  lastExportAt: string | null
}

interface PayrollTotalsT {
  entryCount: number
  approvedCount: number
  netMinutesApproved: number
  grossPayCents: number
  cashTipsCents: number
  cardTipsCents: number
  tipsPendingCents: number
  tipsPaidCents: number
}

/** Združeno po (zaposleni × delovno mesto) + načrt/varianca. */
interface EmployeeAggT {
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  entryCount: number
  approvedCount: number
  netMinutes: number
  grossCents: number
  byType: Record<string, number>
  rateRangeCents: [number, number] | null
  plannedMinutes: number
  varianceMinutes: number
}

interface PayrollExceptionT {
  code: string
  employeeName: string
  entryId?: string
  shiftId?: string
  detail: string
}

interface TipPoolT {
  id: string
  poolDate: string
  status: string
  cashCents: number
  cardCents: number
  totalCents: number
  distributions: number
}

interface ExportRowT {
  id: string
  seq: number
  format: string
  exportedAt: string
  exportedById: string
  changedEntries: number
  identicalToPrevious: boolean
  contentHash8: string
}

/** N-27-3 (v1.197.0): noge doplačil uporabljene pri izračunu zneskov (ali null). */
interface SurchargeRatesT {
  locationId: string | null
  source: 'location' | 'default'
  nightPct: number
  sundayPct: number
  holidayPct: number
  overtimePct: number
}

interface PayrollDetailT {
  period: PayrollPeriodT
  totals: PayrollTotalsT
  employees: EmployeeAggT[]
  /** P3 #19 (v1.192.0) — doplačilne osnove (minute; odstotek potrdi biro) */
  surchargeBases: { perEmployeeJob: SurchargeBasisRowT[]; overtime: OvertimeBasisRowT[] }
  /** N-27-3 (v1.197.0) — noge doplačil (zneski ob minutah, ko nastavljene) */
  surchargeRates: SurchargeRatesT | null
  exceptions: PayrollExceptionT[]
  exceptionsSummary: Record<string, number>
  tipPools: TipPoolT[]
  exports: ExportRowT[]
  meta: { generatedAt: string; version: number }
}

/** GET /api/employees → mapEmployee oblika. */
interface EmployeeT { id: string; name: string; email: string; role: string; active: boolean }

/** Doplačilna osnova po zaposlenem+delu (noč/nedelja/praznik, pred odmorom). */
interface SurchargeBasisRowT {
  employeeId: string
  employeeName: string
  jobId: string | null
  jobName: string
  approvedMinutes: number
  nightMinutes: number
  sundayMinutes: number
  holidayMinutes: number
  /** N-27-3: zneski v centih — prisotni, kadar so noge nastavljene */
  nightAmtCents?: number
  sundayAmtCents?: number
  holidayAmtCents?: number
}

/** Osnova nadur po zaposlenem (dnevni presežek neto minut nad pragom). */
interface OvertimeBasisRowT {
  employeeId: string
  employeeName: string
  overtimeBasisMinutes: number
  daysOverThreshold: number
  /** N-27-3: znesek nadur v centih po povprečni urni postavki obdobja */
  overtimeAmtCents?: number
}

/** GET /api/jobs → jobContexts oblika. */
interface JobT { id: string; title: string; active: boolean }

/** GET/PUT /api/employees/[id]/jobs. */
interface EmployeeJobT {
  jobId: string
  name: string
  isActive: boolean
  payRate: number
  payRateCents: number
  isPrimary: boolean
}

/** Urejanje vrstice postavke (payRate kot string za Input). */
interface RateRowT { jobId: string; payRate: string; isPrimary: boolean }

/* ─────────────────────────── POMOČNIKI (modul) ─────────────────────────── */

const EXCEPTION_ORDER = ['OPEN_ENTRY', 'UNAPPROVED', 'RATE_ZERO', 'RATE_MISMATCH', 'OVERLAP', 'LONG_NO_BREAK', 'SHIFT_NO_ENTRY'] as const

const EX_BADGE: Record<string, string> = {
  OPEN_ENTRY: 'bg-amber-100 text-amber-800 border-amber-200',
  UNAPPROVED: 'bg-rose-100 text-rose-800 border-rose-200',
  RATE_ZERO: 'bg-red-100 text-red-800 border-red-200',
  RATE_MISMATCH: 'bg-violet-100 text-violet-800 border-violet-200',
  OVERLAP: 'bg-orange-100 text-orange-800 border-orange-200',
  LONG_NO_BREAK: 'bg-stone-200 text-stone-700 border-stone-300',
  SHIFT_NO_ENTRY: 'bg-amber-100 text-amber-800 border-amber-200',
}

/** Tip vnosa → obstoječi tc.* ključi (badge barve kot DelovniCasTab). */
const TYPE_KEY: Record<string, string> = {
  regular: 'tc.typeRegular', overtime: 'tc.typeOvertime', holiday: 'tc.typeHoliday',
  sick: 'tc.typeSick', vacation: 'tc.typeVacation',
}
const TYPE_BADGE: Record<string, string> = {
  regular: 'bg-stone-100 text-stone-700',
  overtime: 'bg-amber-100 text-amber-800',
  holiday: 'bg-violet-100 text-violet-800',
  sick: 'bg-rose-100 text-rose-800',
  vacation: 'bg-teal-100 text-teal-800',
}

/** Lokalni YYYY-MM-DD brez UTC zamika (toISOString bi za UTC+1/2 odrezal prejšnji dan). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Privzeti razpon = PREJŠNJI mesec (prvi & zadnji dan). */
function prevMonthRange(): { start: string; end: string } {
  const now = new Date()
  return {
    start: isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    end: isoDay(new Date(now.getFullYear(), now.getMonth(), 0)),
  }
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`)

/** 'YYYY-MM-DD' (lokalni datum) → 'd. m. ll' brez časovnega zamika. */
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('sl-SI')

const fmtStamp = (iso: string) => new Date(iso).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 503 pre-DDL detekcija (vzorec haccp-tab: fail() sporočilo vsebuje 'migracijo'). */
function isMigrationPendingMsg(msg: string): boolean {
  return msg.includes('migracij')
}

/** Izjema → lokalizirana oznaka (neznan padec kode vrne kodo sama). */
function exLabel(t: (k: string) => string, code: string): string {
  const key = `payr.ex.${code}`
  const out = t(key)
  return out === key ? code : out
}

/** Blob prenos (vzorec exceptions-card). */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/* ─────────────────────────── ZAVIHEK ─────────────────────────── */

export function PayrollTab({ locations, canManage }: { locations: { id: string; name: string }[]; canManage: boolean }) {
  const { t } = useI18n()

  // ── seznam obdobij ──
  const [periods, setPeriods] = useState<PayrollPeriodT[] | null>(null)
  const [listBusy, setListBusy] = useState(true)
  const [listErr, setListErr] = useState('')
  const [listReload, setListReload] = useState(0)
  const [migrPending, setMigrPending] = useState(false)

  // ── detail ──
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PayrollDetailT | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailErr, setDetailErr] = useState('')
  const [detailMigr, setDetailMigr] = useState(false)

  // ── novo obdobje ──
  const [newOpen, setNewOpen] = useState(false)
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newLocId, setNewLocId] = useState('')
  const [newErr, setNewErr] = useState('')
  const [newBusy, setNewBusy] = useState(false)

  // ── zaklep ──
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [closeAck, setCloseAck] = useState(false)
  const [closeErr, setCloseErr] = useState('')
  const [closeBusy, setCloseBusy] = useState(false)

  // ── ponovno odprtje ──
  const [reopenOpen, setReopenOpen] = useState(false)
  const [reopenReason, setReopenReason] = useState('')
  const [reopenErr, setReopenErr] = useState('')
  const [reopenBusy, setReopenBusy] = useState(false)

  // ── izvozi ──
  const [csvBusy, setCsvBusy] = useState(false)
  const [jsonBusy, setJsonBusy] = useState(false)

  const loadList = useCallback(async () => {
    setListBusy(true)
    setListErr('')
    try {
      const d = await api<{ periods: PayrollPeriodT[] }>('/api/payroll')
      setPeriods(d.periods ?? [])
      setMigrPending(false)
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (isMigrationPendingMsg(msg)) setMigrPending(true)
      else setListErr(msg)
    } finally {
      setListBusy(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    setDetailBusy(true)
    setDetailErr('')
    setDetailMigr(false)
    try {
      const d = await api<PayrollDetailT>(`/api/payroll/${id}`)
      setDetail(d)
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (isMigrationPendingMsg(msg)) setDetailMigr(true)
      else setDetailErr(msg)
    } finally {
      setDetailBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, listReload])

  useEffect(() => {
    if (detailId) void loadDetail(detailId)
    else { setDetail(null); setDetailErr(''); setDetailMigr(false) }
  }, [detailId, loadDetail])

  /* ── dejanja ── */

  async function createPeriod() {
    if (!newStart || !newEnd) { setNewErr(t('payr.dateRequired')); return }
    if (newEnd < newStart) { setNewErr(t('payr.dateInvalid')); return }
    setNewBusy(true)
    setNewErr('')
    try {
      await api<{ period: PayrollPeriodT }>('/api/payroll', {
        method: 'POST',
        body: JSON.stringify({ locationId: newLocId || locations[0]?.id, start: newStart, end: newEnd }),
      })
      toast({ title: t('payr.createdOk') })
      setNewOpen(false)
      setNewStart('')
      setNewEnd('')
      await loadList()
    } catch (e) {
      const msg = String((e as Error).message || e)
      setNewErr(msg.includes('prekriva') ? t('payr.overlap') : msg)
    } finally {
      setNewBusy(false)
    }
  }

  async function closePeriod() {
    if (!detail) return
    const hasExceptions = detail.exceptions.length > 0
    if (hasExceptions && !closeAck) { setCloseErr(t('payr.ackRequired')); return }
    setCloseBusy(true)
    setCloseErr('')
    try {
      await api<{ period: PayrollPeriodT }>(`/api/payroll/${detail.period.id}/close`, {
        method: 'POST',
        body: JSON.stringify({
          note: closeNote.trim() || undefined,
          ...(hasExceptions ? { acknowledgeExceptions: true } : {}),
        }),
      })
      toast({ title: t('payr.closedOk') })
      setCloseOpen(false)
      setCloseNote('')
      setCloseAck(false)
      await loadDetail(detail.period.id)
      await loadList()
    } catch (e) {
      setCloseErr(String((e as Error).message || e))
    } finally {
      setCloseBusy(false)
    }
  }

  async function reopenPeriod() {
    if (!detail) return
    if (reopenReason.trim().length < 3) { setReopenErr(t('payr.reopenShort')); return }
    setReopenBusy(true)
    setReopenErr('')
    try {
      await api<{ period: PayrollPeriodT; message: string }>(`/api/payroll/${detail.period.id}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reopenReason.trim() }),
      })
      toast({ title: t('payr.reopenDone') })
      setReopenOpen(false)
      setReopenReason('')
      await loadDetail(detail.period.id)
      await loadList()
    } catch (e) {
      setReopenErr(String((e as Error).message || e))
    } finally {
      setReopenBusy(false)
    }
  }

  /** Izvoz (CSV attachment / JSON ok-json → Blob). Po uspehu osveži detail (nova vrstica zgodovine). */
  async function doExport(format: 'csv' | 'json') {
    if (!detail) return
    if (format === 'csv') setCsvBusy(true)
    else setJsonBusy(true)
    try {
      const token = getToken()
      const res = await fetch(`/api/payroll/${detail.period.id}/export?format=${format}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || t('payr.exportErr'))
      }
      const p = detail.period
      if (format === 'csv') {
        // strežnik nastavi Content-Disposition z imenom datoteke — uporabi ga
        const cd = res.headers.get('content-disposition') || ''
        const m = /filename="?([^";]+)"?/i.exec(cd)
        saveBlob(await res.blob(), m?.[1] || `obracun-${p.startISO}_${p.endISO}-v${p.version}.csv`)
      } else {
        // JSON format vrača ok(json) — zložimo lepo formatiran Blob
        const data = await res.json()
        saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `obracun-${p.startISO}_${p.endISO}-v${p.version}.json`)
      }
      toast({ title: t('payr.exportedOk') })
      await loadDetail(p.id)
      await loadList()
    } catch (e) {
      const msg = String((e as Error).message || e)
      toast({ title: msg.includes('zaključen') ? t('payr.notClosed') : msg, variant: 'destructive' })
    } finally {
      if (format === 'csv') setCsvBusy(false)
      else setJsonBusy(false)
    }
  }

  /* ── izpis ── */

  const migrBox = (retry: () => void) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-amber-800 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {t('payr.migr')}</p>
      <Button size="sm" variant="outline" onClick={retry} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
    </div>
  )

  const p = detail?.period

  return (
    <div className="space-y-4">
      {/* ── Plačne postavke zaposlenih (manage gating — cel zavihek je employees.manage) ── */}
      {canManage && <RatesCard />}

      {/* ── Noge doplačil (N-27-3, v1.197.0 — konfiguracija odstotkov po kolektivni pogodbi) ── */}
      {canManage && <SurchargeRatesCard locations={locations} />}

      {/* ── Seznam / detail ── */}
      {detailId ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" className="h-8 gap-1 px-2" onClick={() => setDetailId(null)} aria-label={t('payr.back')}>
                <ArrowLeft className="w-4 h-4" /> {t('payr.back')}
              </Button>
              <CardTitle className="text-base">
                {p ? `${fmtDate(p.startISO)} – ${fmtDate(p.endISO)}` : '—'}
              </CardTitle>
              {p && (
                <Badge variant={p.status === 'closed' ? 'default' : 'secondary'} className={p.status === 'closed' ? 'bg-emerald-700' : ''}>
                  {p.status === 'closed' ? t('payr.closed') : t('payr.draft')}
                </Badge>
              )}
            </div>
            {p && <CardDescription>{t('payr.detailDesc', { tz: p.timezone })}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-4">
            {detailBusy && <Skeleton className="h-24 w-full" />}
            {detailMigr && !detailBusy && migrBox(() => void loadDetail(detailId))}
            {detailErr && !detailBusy && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{t('payr.loadErr')} <span className="text-red-500/80">{detailErr}</span></p>
                <Button size="sm" variant="outline" onClick={() => void loadDetail(detailId)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            )}

            {detail && p && !detailBusy && !detailMigr && !detailErr && (
              <>
                {/* povzetek + akcije */}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('payr.sumNeto')}</p>
                    <p className="text-lg font-bold">{fmtMin(detail.totals.netMinutesApproved)}</p>
                    <p className="text-xs text-stone-400">{detail.totals.approvedCount}/{detail.totals.entryCount} {t('payr.entries')}</p>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('payr.sumGross')}</p>
                    <p className="text-lg font-bold">{fmtEUR(detail.totals.grossPayCents / 100)}</p>
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('payr.tips')}</p>
                    <p className="text-lg font-bold">{fmtEUR((detail.totals.tipsPaidCents + detail.totals.tipsPendingCents) / 100)}</p>
                    {detail.totals.tipsPendingCents > 0 && (
                      <p className="text-xs text-amber-700">{fmtEUR(detail.totals.tipsPendingCents / 100)} · {t('payr.tipsPendingNote')}</p>
                    )}
                  </div>
                  <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
                    <p className="text-xs text-stone-500">{t('payr.exceptions')}</p>
                    <p className={`text-lg font-bold ${detail.exceptions.length > 0 ? 'text-red-700' : ''}`}>{detail.exceptions.length}</p>
                    <p className="text-xs text-stone-400">
                      {t('payr.version')} v{p.version}{p.reopenCount > 0 ? ` · ${p.reopenCount}× ${t('payr.reopenedF')}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {p.status === 'draft' && (
                    <Button
                      disabled={closeBusy}
                      onClick={() => { setCloseOpen(true); setCloseErr('') }}
                      className="bg-emerald-700 hover:bg-emerald-800 text-white"
                    >
                      {closeBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />} {t('payr.close')}
                    </Button>
                  )}
                  {p.status === 'closed' && (
                    <Button variant="outline" disabled={reopenBusy} onClick={() => { setReopenOpen(true); setReopenErr('') }}>
                      {reopenBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {t('payr.reopen')}
                    </Button>
                  )}
                  {p.status === 'closed' && (
                    <>
                      <Button variant="outline" disabled={csvBusy} onClick={() => void doExport('csv')}>
                        {csvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} {t('payr.exportCsv')}
                      </Button>
                      <Button variant="outline" disabled={jsonBusy} onClick={() => void doExport('json')}>
                        {jsonBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileJson className="w-4 h-4" />} {t('payr.exportJson')}
                      </Button>
                    </>
                  )}
                </div>

                <EmployeeTable rows={detail.employees} />
                <SurchargeTable bases={detail.surchargeBases} rates={detail.surchargeRates} />
                <ExceptionsTable rows={detail.exceptions} />
                <TipsTable pools={detail.tipPools} />
                <ExportsTable rows={detail.exports} />
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-col items-start justify-between gap-2 space-y-0 pb-2 sm:flex-row">
            <div>
              <CardTitle className="text-base flex items-center gap-1.5"><Coins className="w-4 h-4" /> {t('payr.listTitle')}</CardTitle>
              <CardDescription>{t('payr.desc')}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={listBusy} onClick={() => setListReload((r) => r + 1)} className="gap-1">
                {listBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {t('payr.refresh')}
              </Button>
              <Button size="sm" disabled={listBusy} onClick={() => { const r = prevMonthRange(); setNewStart(r.start); setNewEnd(r.end); setNewErr(''); setNewOpen(true) }}>
                <Plus className="w-4 h-4" /> {t('payr.new')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {listBusy && <Skeleton className="h-24 w-full" />}
            {migrPending && !listBusy && migrBox(() => setListReload((r) => r + 1))}
            {listErr && !listBusy && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700">{t('payr.loadErr')} <span className="text-red-500/80">{listErr}</span></p>
                <Button size="sm" variant="outline" onClick={() => setListReload((r) => r + 1)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            )}

            {periods && !listBusy && !migrPending && periods.length === 0 && (
              <p className="text-sm text-stone-500">{t('payr.empty')}</p>
            )}
            {periods && !listBusy && !migrPending && periods.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
                    <tr>
                      <th className="p-2">{t('payr.span')}</th>
                      <th className="p-2">{t('payr.status')}</th>
                      <th className="p-2 text-right">{t('payr.entries')}</th>
                      <th className="p-2 text-right">{t('payr.exceptions')}</th>
                      <th className="p-2 text-right">{t('payr.netoMin')}</th>
                      <th className="p-2 text-right">{t('payr.gross')}</th>
                      <th className="p-2 text-right">{t('payr.tips')}</th>
                      <th className="p-2 text-right">{t('payr.version')}</th>
                      <th className="p-2 text-right">{t('payr.exports')}</th>
                      <th className="p-2 text-right">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((row) => {
                      // Osnutek NIMA zaklenjenih (snapshot) vsot — žive so v detalju
                      const draft = row.status === 'draft'
                      const tipsTotal = row.tipsPendingCents + row.tipsPaidCents
                      return (
                        <tr key={row.id} className="border-t border-stone-100 hover:bg-stone-50/60">
                          <td className="p-2 font-medium whitespace-nowrap">{fmtDate(row.startISO)} – {fmtDate(row.endISO)}</td>
                          <td className="p-2">
                            <Badge variant={row.status === 'closed' ? 'default' : 'secondary'} className={row.status === 'closed' ? 'bg-emerald-700' : ''}>
                              {row.status === 'closed' ? t('payr.closed') : t('payr.draft')}
                            </Badge>
                          </td>
                          <td className="p-2 text-right whitespace-nowrap" title={draft ? t('payr.snapshotHint') : t('payr.approvedOf')}>
                            {draft ? '—' : `${row.approvedCount}/${row.entryCount}`}
                          </td>
                          <td className="p-2 text-right" title={draft ? t('payr.snapshotHint') : undefined}>
                            {!draft && row.exceptionCount > 0 ? (
                              <Badge variant="destructive">{row.exceptionCount}</Badge>
                            ) : draft ? '—' : <span className="text-stone-400">0</span>}
                          </td>
                          <td className="p-2 text-right whitespace-nowrap" title={draft ? t('payr.snapshotHint') : undefined}>
                            {draft ? '—' : fmtMin(row.netMinutesApproved)}
                          </td>
                          <td className="p-2 text-right whitespace-nowrap" title={draft ? t('payr.snapshotHint') : undefined}>
                            {draft ? '—' : fmtEUR(row.grossPayCents / 100)}
                          </td>
                          <td className="p-2 text-right whitespace-nowrap" title={draft ? t('payr.snapshotHint') : (row.lastExportAt ? `${t('payr.lastExport')}: ${fmtStamp(row.lastExportAt)}` : undefined)}>
                            {draft ? (
                              '—'
                            ) : (
                              <>
                                {fmtEUR(tipsTotal / 100)}
                                {row.tipsPendingCents > 0 && <span className="block text-xs text-amber-700">+ {fmtEUR(row.tipsPendingCents / 100)} {t('payr.pendingF')}</span>}
                              </>
                            )}
                          </td>
                          <td className="p-2 text-right whitespace-nowrap">v{row.version}</td>
                          <td className="p-2 text-right">{row.exportCount}</td>
                          <td className="p-2 text-right">
                            <Button size="sm" variant="outline" className="h-8" onClick={() => setDetailId(row.id)} aria-label={`${t('payr.open')} ${row.startISO} – ${row.endISO}`}>
                              {t('payr.open')}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Novo obdobje ── */}
      <Dialog open={newOpen} onOpenChange={(v) => { setNewOpen(v); if (!v) setNewErr('') }}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('payr.newTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {locations.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="payr-loc">{t('dev.location')}</Label>
                <Select value={newLocId || undefined} onValueChange={setNewLocId}>
                  <SelectTrigger id="payr-loc"><SelectValue placeholder={locations[0]?.name || '—'} /></SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="payr-start">{t('payr.start')}</Label>
                <Input id="payr-start" type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payr-end">{t('payr.end')}</Label>
                <Input id="payr-end" type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-stone-500">{t('payr.newHint')}</p>
            {newErr && <p className="text-sm text-red-600" role="alert">{newErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={newBusy} onClick={() => setNewOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={newBusy} onClick={() => void createPeriod()}>
              {newBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('payr.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Zaklep (AlertDialog: izjeme → ack; brez izjem → preprosta potrditev) ── */}
      <AlertDialog open={closeOpen} onOpenChange={(v) => { setCloseOpen(v); if (!v) { setCloseErr(''); setCloseAck(false) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('payr.closeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('payr.closeDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            {detail && detail.exceptions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold uppercase text-stone-400">{t('payr.closeExceptions')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {summaryCodes(detail.exceptionsSummary).map(([code, n]) => (
                    <Badge key={code} variant="outline" className={EX_BADGE[code] || ''}>
                      {exLabel(t, code)} × {n}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="payr-note">{t('payr.closeNote')}</Label>
              <Textarea id="payr-note" rows={3} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            </div>
            {detail && detail.exceptions.length > 0 && (
              <label className="flex items-start gap-2 text-sm" htmlFor="payr-ack">
                <Checkbox id="payr-ack" className="mt-0.5" checked={closeAck} onCheckedChange={(v) => setCloseAck(v === true)} />
                <span>{t('payr.acknowledge')}</span>
              </label>
            )}
            {closeErr && <p className="text-sm text-red-600" role="alert">{closeErr}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closeBusy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-700 hover:bg-emerald-800"
              disabled={closeBusy || (detail ? detail.exceptions.length > 0 && !closeAck : false)}
              onClick={(e) => { e.preventDefault(); void closePeriod() }}
            >
              {closeBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('payr.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Ponovno odprtje ── */}
      <Dialog open={reopenOpen} onOpenChange={(v) => { setReopenOpen(v); if (!v) setReopenErr('') }}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('payr.reopenTitle')}</DialogTitle>
            <DialogDescription>{t('payr.reopenDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="payr-reason">{t('payr.reopenReason')}</Label>
              <Textarea id="payr-reason" rows={3} value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
            </div>
            {reopenErr && <p className="text-sm text-red-600" role="alert">{reopenErr}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={reopenBusy} onClick={() => setReopenOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={reopenBusy} onClick={() => void reopenPeriod()} variant="outline" className="border-red-300 text-red-700 hover:bg-red-50">
              {reopenBusy && <Loader2 className="w-4 h-4 animate-spin" />} {t('payr.reopen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** exceptionsSummary → urejeni pari [code, n] (stabilna vrstica po EXCEPTION_ORDER, neznane kode na konec). */
function summaryCodes(summary: Record<string, number>): [string, number][] {
  const known = EXCEPTION_ORDER.filter((c) => (summary[c] ?? 0) > 0).map((c) => [c, summary[c]] as [string, number])
  const extra = Object.entries(summary).filter(([c, n]) => n > 0 && !EXCEPTION_ORDER.includes(c as (typeof EXCEPTION_ORDER)[number]))
  return [...known, ...extra]
}

/* ─────────────────────────── DETAIL PODTABELE (modul) ─────────────────────────── */

/** Zaposleni po delovnih mestih (approved plačilna osnova + načrt/varianca). */
function EmployeeTable({ rows }: { rows: EmployeeAggT[] }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold flex items-center gap-1.5"><Users className="w-4 h-4" /> {t('payr.empTitle')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">{t('payr.empEmpty')}</p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
              <tr>
                <th className="p-2">{t('shifts.csvEmployee')}</th>
                <th className="p-2">{t('payr.colJob')}</th>
                <th className="p-2 text-right">{t('payr.entries')}</th>
                <th className="p-2 text-right">{t('payr.netoMin')}</th>
                <th className="p-2 text-right">{t('payr.gross')}</th>
                <th className="p-2 text-right">{t('payr.planned')}</th>
                <th className="p-2 text-right">{t('payr.variance')}</th>
                <th className="p-2">{t('payr.byType')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = r.varianceMinutes
                const vCls = Math.abs(v) < 60 ? 'text-stone-500' : v <= -60 ? 'text-red-700 font-semibold' : 'text-amber-700 font-semibold'
                const types = Object.entries(r.byType).filter(([, m]) => m > 0)
                return (
                  <tr key={`${r.employeeId}-${r.jobId ?? 'none'}`} className="border-t border-stone-100">
                    <td className="p-2 font-medium">{r.employeeName}</td>
                    <td className="p-2 text-stone-600">{r.jobName || '—'}</td>
                    <td className="p-2 text-right whitespace-nowrap" title={t('payr.approvedOf')}>{r.approvedCount}/{r.entryCount}</td>
                    <td className="p-2 text-right whitespace-nowrap">{fmtMin(r.netMinutes)}</td>
                    <td className="p-2 text-right whitespace-nowrap">{fmtEUR(r.grossCents / 100)}</td>
                    <td className="p-2 text-right whitespace-nowrap">{r.plannedMinutes > 0 ? fmtMin(r.plannedMinutes) : '—'}</td>
                    <td className={`p-2 text-right whitespace-nowrap ${vCls}`} title={t('payr.varianceNote')}>
                      {v > 0 ? `+${fmtMin(v)}` : v < 0 ? `−${fmtMin(-v)}` : '0'}
                    </td>
                    <td className="p-2">
                      {types.length === 0 ? (
                        '—'
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {types.map(([type, m]) => (
                            <Badge key={type} className={TYPE_BADGE[type] || 'bg-stone-100 text-stone-700'}>
                              {TYPE_KEY[type] ? t(TYPE_KEY[type]) : type} · {fmtMin(m)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="p-2 text-xs text-stone-400 border-t border-stone-100">{t('payr.varianceNote')} · {t('payr.approvedOnlyNote')}</p>
        </div>
      )}
    </div>
  )
}

/**
 * Doplačilne osnove (P3 #19, v1.192.0) — noč/nedelja/praznik po zaposlenem in
 * delovnem mestu (pred odmorom) + nadure po zaposlenem (dnevni presežek nad
 * pragom). N-27-3 (v1.197.0): kadar so noge nastavljene (rates), kolona
 * "Doplačilo (€)" = Σ zneskov kategorij vrstice (+ nadure pri prvi vrstici
 * zaposlenega — ista pravila prikaza kot minutna kolona nadur); brez nog
 * opomba o manjkajočih nogah (izvoz nosi samo minute).
 */
function SurchargeTable({
  bases,
  rates,
}: {
  bases: { perEmployeeJob: SurchargeBasisRowT[]; overtime: OvertimeBasisRowT[] }
  rates: SurchargeRatesT | null
}) {
  const { t } = useI18n()
  const rows = bases.perEmployeeJob.filter((b) => b.nightMinutes > 0 || b.sundayMinutes > 0 || b.holidayMinutes > 0)
  const hasAny = rows.length > 0 || bases.overtime.some((o) => o.overtimeBasisMinutes > 0)
  // nadure = PO ZAPOSLENEM — prikaži v PRVI vrstici zaposlenega (druge vrstice
  // istega zaposlenega drugega dela nosijo '—')
  const otShown = new Set<string>()
  const rowTotalCents = (b: SurchargeBasisRowT): number | null =>
    rates && b.nightAmtCents !== undefined
      ? (b.nightAmtCents ?? 0) + (b.sundayAmtCents ?? 0) + (b.holidayAmtCents ?? 0)
      : null
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold flex items-center gap-1.5"><Moon className="w-4 h-4" /> {t('payr.surch.title')}</p>
      {!hasAny ? (
        <p className="text-sm text-stone-500">{t('payr.surch.empty')}</p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
              <tr>
                <th className="p-2">{t('shifts.csvEmployee')}</th>
                <th className="p-2">{t('payr.colJob')}</th>
                <th className="p-2 text-right">{t('payr.surch.night')}</th>
                <th className="p-2 text-right">{t('payr.surch.sunday')}</th>
                <th className="p-2 text-right">{t('payr.surch.holiday')}</th>
                <th className="p-2 text-right">{t('payr.surch.overtime')}</th>
                {rates && <th className="p-2 text-right">{t('payr.rates.amount')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const firstOfEmp = !otShown.has(b.employeeId)
                if (firstOfEmp) otShown.add(b.employeeId)
                const ot = bases.overtime.find((o) => o.employeeId === b.employeeId)
                const totalC = rowTotalCents(b)
                const otC = rates ? ot?.overtimeAmtCents : undefined
                return (
                  <tr key={`${b.employeeId}-${b.jobId ?? 'none'}`} className="border-t border-stone-100">
                    <td className="p-2 font-medium">{b.employeeName}</td>
                    <td className="p-2 text-stone-600">{b.jobName || '—'}</td>
                    <td className={`p-2 text-right whitespace-nowrap ${b.nightMinutes > 0 ? 'text-violet-700' : 'text-stone-400'}`}>{b.nightMinutes > 0 ? fmtMin(b.nightMinutes) : '—'}</td>
                    <td className={`p-2 text-right whitespace-nowrap ${b.sundayMinutes > 0 ? 'text-amber-700' : 'text-stone-400'}`}>{b.sundayMinutes > 0 ? fmtMin(b.sundayMinutes) : '—'}</td>
                    <td className={`p-2 text-right whitespace-nowrap ${b.holidayMinutes > 0 ? 'text-rose-700' : 'text-stone-400'}`}>{b.holidayMinutes > 0 ? fmtMin(b.holidayMinutes) : '—'}</td>
                    <td className="p-2 text-right whitespace-nowrap text-stone-600">{firstOfEmp && ot && ot.overtimeBasisMinutes > 0 ? `${fmtMin(ot.overtimeBasisMinutes)} · ${ot.daysOverThreshold} ${t('payr.surch.days')}` : '—'}</td>
                    {rates && (
                      <td className="p-2 text-right whitespace-nowrap font-medium text-stone-800">
                        {(() => {
                          if (totalC === null) return '—'
                          const sum = totalC + (firstOfEmp ? otC ?? 0 : 0)
                          return sum > 0 ? fmtEUR(sum / 100) : '—'
                        })()}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="p-2 text-xs text-stone-400 border-t border-stone-100">
            {t('payr.surch.note')}{rates ? ` ${t('payr.rates.usedHint')}` : ` ${t('payr.rates.notSet')}`}
          </p>
        </div>
      )}
    </div>
  )
}

/** Podatkovne izjeme (max-h-96 overflow-y-auto — pravilo dolgih seznamov). */
function ExceptionsTable({ rows }: { rows: PayrollExceptionT[] }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold flex items-center gap-1.5">
        <AlertTriangle className="w-4 h-4" /> {t('payr.exTitle')}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">{t('payr.exEmpty')}</p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 space-y-1.5">
          {rows.map((x, i) => (
            <div key={`${x.code}-${i}`} className="rounded-lg border border-stone-200 bg-white p-2.5 text-sm">
              <p className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="outline" className={EX_BADGE[x.code] || ''}>{exLabel(t, x.code)}</Badge>
                <span className="font-medium">{x.employeeName || '—'}</span>
                {x.entryId && <span className="text-xs text-stone-400 font-mono" title={t('payr.entryId')}>…{x.entryId.slice(-8)}</span>}
                {x.shiftId && <span className="text-xs text-stone-400 font-mono" title={t('payr.shiftId')}>…{x.shiftId.slice(-8)}</span>}
              </p>
              <p className="text-xs text-stone-600 mt-1">{x.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Napitnine v obdobju (bazeni + distribucije). */
function TipsTable({ pools }: { pools: TipPoolT[] }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold">{t('payr.tipsTitle')}</p>
      {pools.length === 0 ? (
        <p className="text-sm text-stone-500">{t('payr.tipsEmpty')}</p>
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-stone-200">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
              <tr>
                <th className="p-2">{t('payr.pool')}</th>
                <th className="p-2">{t('payr.day')}</th>
                <th className="p-2 text-right">{t('payr.cash')}</th>
                <th className="p-2 text-right">{t('payr.card')}</th>
                <th className="p-2 text-right">{t('tips.total')}</th>
                <th className="p-2">{t('payr.status')}</th>
                <th className="p-2 text-right">{t('payr.distr')}</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((pool) => (
                <tr key={pool.id} className="border-t border-stone-100">
                  <td className="p-2 font-mono text-xs text-stone-500">…{pool.id.slice(-8)}</td>
                  <td className="p-2 whitespace-nowrap">{fmtDate(pool.poolDate)}</td>
                  <td className="p-2 text-right">{fmtEUR(pool.cashCents / 100)}</td>
                  <td className="p-2 text-right">{fmtEUR(pool.cardCents / 100)}</td>
                  <td className="p-2 text-right font-semibold">{fmtEUR(pool.totalCents / 100)}</td>
                  <td className="p-2">
                    {pool.status === 'paid'
                      ? <Badge variant="outline" className="border-emerald-600 text-emerald-700">{t('tips.paid')}</Badge>
                      : <Badge variant="outline">{t('tips.pending')}</Badge>}
                  </td>
                  <td className="p-2 text-right">{pool.distributions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Zgodovina izvozov (seq/datum/format/diff/hash). */
function ExportsTable({ rows }: { rows: ExportRowT[] }) {
  const { t } = useI18n()
  return (
    <div>
      <p className="mb-1.5 text-sm font-semibold">{t('payr.exportsTitle')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">{t('payr.exportsEmpty')}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-xl border border-stone-200">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs text-stone-500 sticky top-0">
              <tr>
                <th className="p-2">{t('payr.seq')}</th>
                <th className="p-2">{t('payr.day')}</th>
                <th className="p-2">{t('payr.format')}</th>
                <th className="p-2 text-right">{t('payr.changed')}</th>
                <th className="p-2">{t('payr.hash')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} className="border-t border-stone-100">
                  <td className="p-2 font-semibold">#{x.seq}</td>
                  <td className="p-2 whitespace-nowrap">{fmtStamp(x.exportedAt)}</td>
                  <td className="p-2"><Badge variant="outline" className="uppercase">{x.format}</Badge></td>
                  <td className="p-2 text-right whitespace-nowrap">
                    {x.identicalToPrevious ? (
                      <span className="inline-flex items-center gap-1.5"><span className="text-stone-400">0</span><Badge variant="secondary">{t('payr.identical')}</Badge></span>
                    ) : (
                      <span className="font-semibold">{x.changedEntries}</span>
                    )}
                  </td>
                  <td className="p-2 font-mono text-xs text-stone-500">{x.contentHash8}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────── PLAČNE POSTAVKE (EmployeeJob editor) ─────────────────────────── */

const MAX_RATE_ROWS = 8

/**
 * Collapsible kartica plačnih postavk zaposlenih (GET /api/employees/[id]/jobs,
 * PUT REPLACE SET). Lenobno nalaganje (zaposleni + delovna mesta ob prvem
 * razpretju). Primarna postavka = radio-semantika (natanko ena — ob prihodu
 * clock-in zajema snapshot primarne postavke).
 */
/**
 * N-27-3 (v1.197.0) — kartica NOGE DOPLAČIL (konfiguracija): lastnik vnese
 * odstotke (noč/nedelja/praznik/nadure) po SVOJI kolektivni pogodbi; sistem
 * izračuna zneske iz minut obračuna in posnetkov postavk. Noga je uporabniški
 * vhod — zakonitost potrdi biro (iskrena meja izvoza). Ena konfiguracija na
 * lokacijo (+ privzete za NULL); do DDL → 503 (migrBox stil).
 */
function SurchargeRatesCard({ locations }: { locations: { id: string; name: string }[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // '' = privzete noge (locationId null) — uglašeno z GET/PUT (prazno → null)
  const [selLoc, setSelLoc] = useState('')
  const [rates, setRates] = useState<{ nightPct: string; sundayPct: string; holidayPct: string; overtimePct: string }>({
    nightPct: '', sundayPct: '', holidayPct: '', overtimePct: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [blocked, setBlocked] = useState(false)

  const loadRates = useCallback(async (locKey: string) => {
    setErr('')
    setBlocked(false)
    try {
      const q = locKey ? `?locationId=${encodeURIComponent(locKey)}` : ''
      const d = await api<{ rates: SurchargeRatesT | null }>(`/api/payroll/surcharge-rates${q}`)
      setRates({
        nightPct: d.rates ? String(d.rates.nightPct) : '',
        sundayPct: d.rates ? String(d.rates.sundayPct) : '',
        holidayPct: d.rates ? String(d.rates.holidayPct) : '',
        overtimePct: d.rates ? String(d.rates.overtimePct) : '',
      })
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (msg.includes('503') || msg.toLowerCase().includes('migrac')) setBlocked(true)
      setErr(msg)
    }
  }, [])

  useEffect(() => {
    if (open) void (async () => { await loadRates(selLoc) })()
  }, [open, selLoc, loadRates])

  function pickLoc(v: string) {
    setSelLoc(v)
  }

  function upd(key: keyof typeof rates, v: string) {
    setRates((r) => ({ ...r, [key]: v }))
  }

  async function saveRates() {
    // validacija pred PUT (strežnik validira enako — 0–100, ≤ 2 decimali)
    const out: Record<string, number> = {}
    for (const [key, label] of [
      ['nightPct', t('payr.rates.night')],
      ['sundayPct', t('payr.rates.sunday')],
      ['holidayPct', t('payr.rates.holiday')],
      ['overtimePct', t('payr.rates.overtime')],
    ] as const) {
      const raw = rates[key].trim().replace(',', '.')
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || n > 100 || Math.round(n * 100) !== n * 100) {
        setErr(`${label}: ${t('payr.rates.invalid')}`)
        return
      }
      out[key] = Math.round(n * 100) / 100
    }
    setBusy(true)
    setErr('')
    try {
      await api<{ rates: SurchargeRatesT | null }>('/api/payroll/surcharge-rates', {
        method: 'PUT',
        body: JSON.stringify({ locationId: selLoc || null, ...out }),
      })
      toast({ title: t('payr.rates.saved') })
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-2 cursor-pointer select-none">
            <CardTitle className="text-base flex items-center gap-1.5"><Percent className="w-4 h-4" /> {t('payr.rates.title')}</CardTitle>
            <CardDescription>{t('payr.rates.hint')}</CardDescription>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {blocked ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-amber-800 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {t('payr.rates.migr')}</p>
                <Button size="sm" variant="outline" onClick={() => void loadRates(selLoc)} className="shrink-0 gap-1"><RefreshCw className="w-3.5 h-3.5" /> {t('common.retry')}</Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="surchRatesLoc" className="text-xs text-stone-500">{t('payr.rates.location')}</Label>
                    <Select value={selLoc || 'default'} onValueChange={pickLoc}>
                      <SelectTrigger id="surchRatesLoc" size="sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t('payr.rates.defaultLoc')}</SelectItem>
                        {locations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {([
                    ['nightPct', t('payr.rates.night')],
                    ['sundayPct', t('payr.rates.sunday')],
                    ['holidayPct', t('payr.rates.holiday')],
                    ['overtimePct', t('payr.rates.overtime')],
                  ] as const).map(([key, label]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`surchRates-${key}`} className="text-xs text-stone-500">{label}</Label>
                      <Input
                        id={`surchRates-${key}`}
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        max="100"
                        value={rates[key]}
                        onChange={(e) => upd(key, e.target.value)}
                        className="h-9"
                      />
                    </div>
                  ))}
                </div>
                {err && <p className="text-sm text-destructive">{err}</p>}
                <Button size="sm" onClick={() => void saveRates()} disabled={busy} className="gap-1">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Percent className="w-3.5 h-3.5" />} {t('payr.rates.save')}
                </Button>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function RatesCard() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  const [employees, setEmployees] = useState<EmployeeT[]>([])
  const [jobs, setJobs] = useState<JobT[]>([])
  const [selEmp, setSelEmp] = useState('')
  const [rows, setRows] = useState<RateRowT[]>([])
  const [rowsBusy, setRowsBusy] = useState(false)
  const [rowsErr, setRowsErr] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)

  async function loadOptions() {
    setRowsErr('')
    try {
      const [emp, job] = await Promise.all([
        api<{ employees: EmployeeT[] }>('/api/employees'),
        api<{ jobContexts: JobT[] }>('/api/jobs'),
      ])
      setEmployees((emp.employees ?? []).filter((e) => e.active))
      setJobs((job.jobContexts ?? []).filter((j) => j.active))
    } catch (e) {
      setRowsErr(String((e as Error).message || e))
    }
  }

  async function loadRows(employeeId: string) {
    setRowsBusy(true)
    setRowsErr('')
    setSaveErr('')
    try {
      const d = await api<{ jobs: EmployeeJobT[] }>(`/api/employees/${employeeId}/jobs`)
      setRows((d.jobs ?? []).map((j) => ({ jobId: j.jobId, payRate: String(j.payRate ?? 0), isPrimary: j.isPrimary })))
    } catch (e) {
      setRowsErr(String((e as Error).message || e))
      setRows([])
    } finally {
      setRowsBusy(false)
    }
  }

  function pickEmployee(v: string) {
    setSelEmp(v)
    setSaveErr('')
    if (v) void loadRows(v)
    else setRows([])
  }

  function setPrimary(idx: number) {
    setRows((rs) => rs.map((r, i) => ({ ...r, isPrimary: i === idx })))
  }

  function addRow() {
    setRows((rs) => (rs.length >= MAX_RATE_ROWS ? rs : [...rs, { jobId: '', payRate: '', isPrimary: rs.length === 0 }]))
  }

  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx))
  }

  function updateRow(idx: number, patch: Partial<RateRowT>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  async function saveRates() {
    if (!selEmp) return
    // validacija pred PUT (strežnik validira enako — 0–10000 €, ≤ 2 decimali)
    const out: { jobId: string; payRate: number; isPrimary: boolean }[] = []
    for (const r of rows) {
      if (!r.jobId) { setSaveErr(t('payr.jobRequired')); return }
      const rate = Number(r.payRate.replace(',', '.'))
      if (!Number.isFinite(rate) || rate < 0 || rate > 10000 || Math.round(rate * 100) !== rate * 100) {
        setSaveErr(t('payr.rateInvalid'))
        return
      }
      out.push({ jobId: r.jobId, payRate: Math.round(rate * 100) / 100, isPrimary: r.isPrimary })
    }
    setSaveBusy(true)
    setSaveErr('')
    try {
      const d = await api<{ jobs: EmployeeJobT[] }>(`/api/employees/${selEmp}/jobs`, {
        method: 'PUT',
        body: JSON.stringify({ jobs: out }),
      })
      setRows((d.jobs ?? []).map((j) => ({ jobId: j.jobId, payRate: String(j.payRate ?? 0), isPrimary: j.isPrimary })))
      toast({ title: t('payr.ratesSaved') })
    } catch (e) {
      setSaveErr(String((e as Error).message || e))
    } finally {
      setSaveBusy(false)
    }
  }

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); if (v && employees.length === 0 && jobs.length === 0) void loadOptions() }}>
      <Card>
        <CardHeader className="pb-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center gap-1.5 text-left" aria-expanded={open}>
              <Coins className="w-4 h-4" />
              <CardTitle className="text-base flex-1">{t('payr.ratesTitle')}</CardTitle>
              <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          </CollapsibleTrigger>
          <CardDescription>{t('payr.ratesDesc')}</CardDescription>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="payr-emp">{t('payr.employee')}</Label>
                <Select value={selEmp || undefined} onValueChange={pickEmployee}>
                  <SelectTrigger id="payr-emp"><SelectValue placeholder={t('payr.employeePlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {employees.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {rowsErr && <p className="text-sm text-red-600">{rowsErr}</p>}
            {rowsBusy && <Skeleton className="h-16 w-full" />}

            {!rowsBusy && selEmp && rows.length === 0 && (
              <p className="text-sm text-stone-500">{t('payr.noJobs')}</p>
            )}

            {!rowsBusy && selEmp && (
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_auto_auto] gap-2 items-end rounded-lg border border-stone-200 p-2.5">
                    <div className="space-y-1">
                      <Label htmlFor={`payr-job-${i}`} className="text-xs text-stone-500">{t('payr.colJob')}</Label>
                      <Select value={r.jobId || undefined} onValueChange={(v) => updateRow(i, { jobId: v })}>
                        <SelectTrigger id={`payr-job-${i}`}><SelectValue placeholder={t('payr.jobPlaceholder')} /></SelectTrigger>
                        <SelectContent>
                          {jobs.filter((j) => j.id === r.jobId || !rows.some((x) => x.jobId === j.id)).map((j) => (
                            <SelectItem key={j.id} value={j.id}>{j.title}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`payr-rate-${i}`} className="text-xs text-stone-500">{t('payr.rate')}</Label>
                      <Input
                        id={`payr-rate-${i}`}
                        type="number"
                        step="0.01"
                        min="0"
                        max="10000"
                        inputMode="decimal"
                        value={r.payRate}
                        onChange={(e) => updateRow(i, { payRate: e.target.value })}
                      />
                    </div>
                    <label className="flex items-center gap-1.5 text-sm pb-2.5" htmlFor={`payr-prim-${i}`}>
                      <Checkbox id={`payr-prim-${i}`} checked={r.isPrimary} onCheckedChange={() => setPrimary(i)} />
                      {t('payr.primary')}
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 w-9 p-0 text-stone-400 hover:text-red-700"
                      onClick={() => removeRow(i)}
                      aria-label={t('payr.removeJob')}
                      title={t('payr.removeJob')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={rows.length >= MAX_RATE_ROWS} onClick={addRow}>
                    <Plus className="w-3.5 h-3.5" /> {t('payr.addJob')}
                  </Button>
                  <Button size="sm" disabled={saveBusy || !selEmp} onClick={() => void saveRates()}>
                    {saveBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t('payr.saveRates')}
                  </Button>
                  <p className="text-xs text-stone-500 basis-full sm:basis-auto">{t('payr.rateHint')}</p>
                </div>
                {rows.length >= MAX_RATE_ROWS && <p className="text-xs text-amber-700">{t('payr.jobsMax')}</p>}
                {saveErr && <p className="text-sm text-red-600" role="alert">{saveErr}</p>}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
