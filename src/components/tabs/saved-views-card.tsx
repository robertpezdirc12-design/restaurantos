'use client'

/**
 * v1.247.0 (PRIMERJAVA-VMESNIKOV-2026 §21) — POGLEDI VAL: kartica SHRANJENIH
 * POGLEDOV POROČIL (Lightspeed april 2026 »saved report views«).
 *
 * Merjena situacija: mesečni računovodski izvoz je vsak mesec ISTA ročna
 * naloga (sekcija + Od + Do + format na AccountingExportCard) — 4 izbire,
 * da prideš do datoteke, ki jo knjigovodja čaka vsak 1. v mesecu. Zdaj:
 * enkrat definiran pogled (ime + poročilo + RELATIVNO obdobje) → gumb
 * »Zaženi« → datoteka pade dol z danes rešenim obdobjem (»ta mesec« je
 * vedno trenutni mesec — pogled ne zastara).
 *
 * Iskrena meja v1: dodajanje + brisanje + zagon (brez preimenovanja/urejanja
 * — pogled je poceni znova sestaviti); zagon gre klient prek obstoječih
 * GET rut (/api/reports/export|food-cost) — strežniška varovala (pravice,
 * location scope) ostanejo enaka kot pri ročnem zagonu.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getToken } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { BookmarkPlus, Download, Loader2, Play, Trash2 } from 'lucide-react'
import {
  REPORT_RANGE_PRESETS,
  resolveReportRange,
  type SavedReportView,
} from '@/lib/report-views'

/** Ime datoteke po sekciji izvoza (zrcalo AccountingExportCard). */
function exportFileName(view: SavedReportView, from: string, to: string): string {
  if (view.report === 'food-cost') return `food-cost-varianca-${from}_${to}.csv`
  const base = view.section === 'dnevnik' ? 'dnevnik-prodaje' : view.section === 'ddv' ? 'ddv-povzetek' : view.section === 'zz' ? 'xz-porocilo' : 'izvoz'
  return `${base}-${from}_${to}.${view.format ?? 'csv'}`
}

/** URL GET rute za pogled (isto kot ročna pot na karticah poročil). */
function runUrl(view: SavedReportView, from: string, to: string): string {
  if (view.report === 'food-cost') return `/api/reports/food-cost?from=${from}&to=${to}&format=csv`
  return `/api/reports/export?from=${from}&to=${to}&format=${view.format ?? 'csv'}&section=${view.section ?? 'summary'}`
}

export function SavedViewsCard() {
  const { t } = useI18n()
  const [views, setViews] = useState<SavedReportView[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [runningId, setRunningId] = useState('')
  const [dlgOpen, setDlgOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // obrazec novega pogleda
  const [fName, setFName] = useState('')
  const [fReport, setFReport] = useState<'export' | 'food-cost'>('export')
  const [fSection, setFSection] = useState<'summary' | 'dnevnik' | 'ddv' | 'zz'>('summary')
  const [fFormat, setFFormat] = useState<'csv' | 'json'>('csv')
  const [fRange, setFRange] = useState<string>('thisMonth')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')

  const load = useCallback(async () => {
    try {
      const d = await api<{ views: SavedReportView[] }>('/api/reports/views')
      setViews(d.views ?? [])
      setLoadErr('')
    } catch (e) {
      setLoadErr(String((e as Error).message || e))
    }
  }, [])

  // mount fetch (vzorec pacing/combos kartic — setState šele po await, nikoli
  // sinhrono v telesu efekta: react-hooks/set-state-in-effect)
  useEffect(() => { void (async () => { await load() })() }, [load])

  /** Zagon: reši obdobje danes → GET → datoteka (blob download). */
  const run = async (v: SavedReportView) => {
    setRunningId(v.id)
    try {
      const { from, to } = resolveReportRange(v.range, new Date(), { from: v.from, to: v.to })
      if (!from || !to) throw new Error(t('rv.runFailed'))
      const token = getToken()
      const res = await fetch(runUrl(v, from, to), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((data as { error?: string })?.error || t('rv.runFailed'))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(v, from, to)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast({ description: String((e as Error).message || t('rv.runFailed')) })
    } finally {
      setRunningId('')
    }
  }

  /** PUT celega seznama (kanonična oblika registra — vzorec templates/combos).
   *  Nov vnos gre kot surovi osnutek (id dodeli strežnik ob validaciji). */
  const persist = async (next: (SavedReportView | Record<string, unknown>)[]) => {
    setSaving(true)
    try {
      const d = await api<{ views: SavedReportView[] }>('/api/reports/views', {
        method: 'PUT',
        body: JSON.stringify({ views: next }),
      })
      setViews(d.views ?? [])
      return true
    } catch (e) {
      toast({ description: String((e as Error).message || e) })
      return false
    } finally {
      setSaving(false)
    }
  }

  const addView = async () => {
    // pred-pogoj klienta je SAMO UX — strežnik validira znova (kanonična pot)
    if (!fName.trim()) { toast({ description: t('rv.nameMissing') }); return }
    const raw = {
      name: fName,
      report: fReport,
      range: fRange,
      ...(fReport === 'export' ? { section: fSection, format: fFormat } : {}),
      ...(fRange === 'custom' ? { from: fFrom, to: fTo } : {}),
    }
    if (await persist([...(views ?? []), raw])) {
      toast({ description: t('rv.saved') })
      setDlgOpen(false)
      setFName(''); setFRange('thisMonth'); setFFrom(''); setFTo(''); setFReport('export'); setFSection('summary'); setFFormat('csv')
    }
  }

  const removeView = async (v: SavedReportView) => {
    if (!window.confirm(t('rv.deleteConfirm', { name: v.name }))) return
    if (await persist((views ?? []).filter((x) => x.id !== v.id))) toast({ description: t('rv.deleted') })
  }

  /** Danes rešeno obdobje za prikaz pod imenom (iskrenost: uporabnik VIDI, kaj bo poteženo). */
  const resolvedNow = (v: SavedReportView): { from: string; to: string } => resolveReportRange(v.range, new Date(), { from: v.from, to: v.to })

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <BookmarkPlus className="w-4 h-4 text-stone-500" aria-hidden />
              {t('rv.title')}
            </CardTitle>
            <p className="mt-1 text-xs text-stone-500 max-w-2xl">{t('rv.desc')}</p>
          </div>
          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 text-white h-8 gap-1.5" onClick={() => setDlgOpen(true)} disabled={(views?.length ?? 0) >= 20}>
            <BookmarkPlus className="w-3.5 h-3.5" aria-hidden /> {t('rv.new')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {loadErr && <p className="text-sm text-red-700" role="alert">{loadErr}</p>}
        {views === null && !loadErr && (
          <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-2/3" /></div>
        )}
        {views !== null && views.length === 0 && (
          <div className="rounded-lg border border-dashed border-stone-200 p-4 text-center">
            <p className="text-sm text-stone-500">{t('rv.none')}</p>
            <p className="mt-1 text-xs text-stone-400">{t('rv.noneHint')}</p>
          </div>
        )}
        {views?.map((v) => {
          const r = resolvedNow(v)
          return (
            <div key={v.id} className="rounded-lg border border-stone-200 bg-white p-3 flex flex-wrap items-center gap-2 justify-between" data-testid="saved-view-row">
              <div className="min-w-0">
                <p className="font-medium truncate flex items-center gap-2 flex-wrap">
                  {v.name}
                  <Badge variant="outline" className="h-5 px-1.5 text-xs bg-stone-50 text-stone-600 border-stone-200">
                    {t(v.report === 'export' ? 'rv.report.export' : 'rv.report.foodcost')}
                  </Badge>
                  {v.report === 'export' && (
                    <Badge variant="outline" className="h-5 px-1.5 text-xs bg-stone-50 text-stone-600 border-stone-200">
                      {t(`acc.${v.section === 'summary' ? 'summary' : v.section === 'dnevnik' ? 'dnevnik' : v.section === 'ddv' ? 'vat' : 'xz'}`)} · {(v.format ?? 'csv').toUpperCase()}
                    </Badge>
                  )}
                  <Badge variant="outline" className="h-5 px-1.5 text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                    {t(`rv.range.${v.range}`)}
                  </Badge>
                </p>
                <p className="mt-0.5 text-xs text-stone-500" data-testid="saved-view-range">
                  {t('rv.resolved', { from: r.from, to: r.to })}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" className="h-8 gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white" disabled={runningId === v.id} onClick={() => void run(v)}>
                  {runningId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Play className="w-3.5 h-3.5" aria-hidden />}
                  {runningId === v.id ? t('rv.running') : t('rv.run')}
                </Button>
                <Button size="sm" variant="outline" className="h-8 w-8 p-0 border-red-200 text-red-700 hover:bg-red-50" disabled={saving} onClick={() => void removeView(v)} title={t('common.delete')} aria-label={t('common.delete')}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          )
        })}
        {views !== null && views.length > 0 && (
          <p className="text-xs text-stone-400 flex items-center gap-1"><Download className="w-3 h-3" aria-hidden /> {t('rv.footerHint')}</p>
        )}
      </CardContent>

      {/* Nov pogled */}
      <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rv.new')}</DialogTitle>
            <DialogDescription>{t('rv.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rv-name">{t('rv.name')}</Label>
              <Input id="rv-name" value={fName} maxLength={80} placeholder={t('rv.namePh')} onChange={(e) => setFName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('rv.report')}</Label>
              <Select value={fReport} onValueChange={(v) => setFReport(v as 'export' | 'food-cost')}>
                <SelectTrigger aria-label={t('rv.report')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="export">{t('rv.report.export')}</SelectItem>
                  <SelectItem value="food-cost">{t('rv.report.foodcost')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {fReport === 'export' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>{t('acc.section')}</Label>
                  <Select value={fSection} onValueChange={(v) => setFSection(v as 'summary' | 'dnevnik' | 'ddv' | 'zz')}>
                    <SelectTrigger aria-label={t('acc.section')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="summary">{t('acc.summary')}</SelectItem>
                      <SelectItem value="dnevnik">{t('acc.dnevnik')}</SelectItem>
                      <SelectItem value="ddv">{t('acc.vat')}</SelectItem>
                      <SelectItem value="zz">{t('acc.xz')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('rv.format')}</Label>
                  <Select value={fFormat} onValueChange={(v) => setFFormat(v as 'csv' | 'json')}>
                    <SelectTrigger aria-label={t('rv.format')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="csv">CSV</SelectItem>
                      <SelectItem value="json">JSON</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label>{t('rv.range')}</Label>
              <Select value={fRange} onValueChange={setFRange}>
                <SelectTrigger aria-label={t('rv.range')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REPORT_RANGE_PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>{t(`rv.range.${p}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {fRange === 'custom' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="rv-from">{t('acct.from')}</Label>
                  <Input id="rv-from" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rv-to">{t('acct.to')}</Label>
                  <Input id="rv-to" type="date" value={fTo} min={fFrom || undefined} onChange={(e) => setFTo(e.target.value)} />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlgOpen(false)}>{t('common.cancel')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800 text-white" disabled={saving || !fName.trim()} onClick={() => void addView()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <BookmarkPlus className="w-4 h-4" aria-hidden />} {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
