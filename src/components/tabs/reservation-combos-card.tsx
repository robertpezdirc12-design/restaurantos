'use client'

/**
 * v1.245.0 (PRIMERJAVA-VMESNIKOV-2026 §19) — Nastavitvena kartica
 * KOMBINACIJ MIZ + REZERVABILNIH MIZ (zavihek Nastavitve, skupina rezervacij).
 *
 * DVE plasti (obe Integration vrstici per lokacija — 0 DDL):
 *  1. KOMBINACIJSKE MIZE: [{ id, tableIds }] — skupine miz, ki jih osebje
 *     rezervira SKUPAJ za velike družbe (Lightspeed »table combinations«
 *     november 2026). Rezervacija blokira VSE članice.
 *  2. REZERVABILNE MIZE (walk-in rezerva): izklopljene mize se ne štejejo
 *     v spletno kapaciteto terminov (Lightspeed »preserve space for
 *     walk-ins«) — telefonska pot ni omejena.
 *
 * Vir: /api/tables/combos (GET/PUT reservations.manage; isti lastnik kot
 * widget + ritem). Kartica se izriše SAMO uporabnikom z settings.manage
 * (ista disciplina kot ReservationWidgetCard).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, Link2, Save, Trash2, Plus, Footprints } from 'lucide-react'

interface ComboT {
  id: string
  tableIds: string[]
}
interface TableLite {
  id: string
  name: string
  seats: number
  number?: number
}

export function ReservationCombosCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const canConfigure = Boolean(user && (user.permissions ?? []).includes('settings.manage') || user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER')
  const [combos, setCombos] = useState<ComboT[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [tables, setTables] = useState<TableLite[]>([])
  const [draft, setDraft] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const [d, tRows] = await Promise.all([
        api<{ combos: ComboT[]; excludedTableIds: string[] }>(`/api/tables/combos${user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''}`),
        // mize že naložene na dashboardu — tu lokalni minimalni fetch (isti vir)
        api<{ tables: TableLite[] }>(`/api/tables${user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''}`),
      ])
      setCombos(d.combos)
      setExcluded(d.excludedTableIds)
      setTables(tRows.tables.map((x: TableLite & { seats?: number; number?: number }) => ({ id: x.id, name: x.name, seats: x.seats ?? 0, number: x.number })))
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 160))
    } finally {
      setLoading(false)
    }
  }, [user?.locationId])

  useEffect(() => { if (canConfigure) void (async () => { await load() })() }, [canConfigure, load])

  if (!canConfigure) return null

  const nameOf = (id: string) => tables.find((x) => x.id === id)?.name ?? id.slice(0, 8)
  const seatsOf = (ids: string[]) => ids.reduce((s, id) => s + (tables.find((x) => x.id === id)?.seats ?? 0), 0)
  // oznaka iz ŠTEVILKE mize (ne iz imena) — i18n čistost: beseda za mizo gre
  // vedno skozi t('wl.thTable'), številke so jezikovno nevtralne
  const num = (id: string) => {
    const tb = tables.find((x) => x.id === id)
    return tb?.number ?? tb?.name ?? id.slice(0, 6)
  }
  const comboLabel = (ids: string[]) => ids.map(num).join('+')

  function addCombo() {
    if (draft.length < 2) return
    const ids = [...draft]
    setCombos((prev) => [...prev, { id: `combo-${ids.join('-').slice(0, 40)}`, tableIds: ids }])
    setDraft([])
  }

  async function save() {
    setBusy(true)
    setErr('')
    try {
      const d = await api<{ combos: ComboT[]; excludedTableIds: string[] }>('/api/tables/combos', {
        method: 'PUT',
        body: JSON.stringify({
          locationId: user?.locationId ?? undefined,
          combos: combos.map((c) => ({ id: c.id, tableIds: c.tableIds })),
          excludedTableIds: excluded,
        }),
      })
      setCombos(d.combos)
      setExcluded(d.excludedTableIds)
      toast({ title: t('resv.comboSaved') })
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-region="resv-combos-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Link2 className="w-4 h-4" aria-hidden /> {t('resv.comboTitle')}</CardTitle>
        <Badge variant="outline" className="shrink-0">{combos.length}</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" aria-hidden /> …</div>
        ) : err ? (
          <p className="text-sm text-red-700 break-words" role="alert">{err}</p>
        ) : (
          <>
            {/* 1) KOMBINACIJSKE MIZE */}
            <section className="space-y-3" aria-label={t('resv.comboTitle')}>
              <p className="text-sm text-stone-600">{t('resv.comboHint')}</p>
              {combos.length === 0 && (
                <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-500">{t('resv.comboEmpty')}</p>
              )}
              <ul className="space-y-1.5" data-region="resv-combos-list">
                {combos.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-stone-200 px-3 py-2">
                    <span className="min-w-0 truncate text-sm">
                      <span className="font-semibold">{t('wl.thTable')} {comboLabel(c.tableIds)}</span>
                      <span className="text-stone-500"> · {t('resv.comboSeats', { n: seatsOf(c.tableIds) })}</span>
                    </span>
                    <Button
                      size="sm" variant="outline" className="h-9 shrink-0 gap-1 text-red-700 hover:bg-red-50"
                      aria-label={t('resv.comboRemove')}
                      onClick={() => setCombos((prev) => prev.filter((x) => x.id !== c.id))}
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              {/* nova kombinacija: izbor 2–5 miz */}
              <div className="space-y-2 rounded-md border border-stone-200 p-3" data-region="resv-combos-draft">
                <div className="flex flex-wrap gap-1.5">
                  {tables.map((tb) => (
                    <label key={tb.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-stone-200 px-2 py-1 text-xs has-[:checked]:border-emerald-600 has-[:checked]:bg-emerald-50">
                      <Checkbox
                        checked={draft.includes(tb.id)}
                        onCheckedChange={(v) => setDraft((prev) => v === true ? [...prev, tb.id] : prev.filter((x) => x !== tb.id))}
                        aria-label={tb.name}
                      />
                      {tb.name} · {tb.seats}
                    </label>
                  ))}
                </div>
                <Button
                  size="sm" variant="outline" className="gap-1"
                  disabled={draft.length < 2}
                  onClick={addCombo}
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden /> {t('resv.comboAdd')}{draft.length >= 2 ? `: ${draft.map(num).join('+')}` : ''}
                </Button>
              </div>
            </section>

            {/* 2) REZERVABILNE MIZE (walk-in rezerva) */}
            <section className="space-y-3 border-t border-stone-100 pt-4" aria-label={t('resv.bookableTitle')}>
              <div>
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-stone-700"><Footprints className="w-4 h-4" aria-hidden /> {t('resv.bookableTitle')}</h4>
                <p className="mt-1 text-sm text-stone-600">{t('resv.bookableHint')}</p>
              </div>
              {excluded.length === 0 && <p className="text-xs text-stone-400">{t('resv.bookableAll')}</p>}
              <div className="flex flex-wrap gap-1.5" data-region="resv-bookable-list">
                {tables.map((tb) => (
                  <label key={tb.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-stone-200 px-2 py-1 text-xs has-[:checked]:border-amber-500 has-[:checked]:bg-amber-50">
                    <Checkbox
                      checked={excluded.includes(tb.id)}
                      onCheckedChange={(v) => setExcluded((prev) => v === true ? [...prev, tb.id] : prev.filter((x) => x !== tb.id))}
                      aria-label={tb.name}
                    />
                    {tb.name}
                  </label>
                ))}
              </div>
              <p className="sr-only"><Label>{t('resv.bookableTitle')}</Label></p>
            </section>

            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void save()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Save className="w-4 h-4" aria-hidden />} {t('common.save')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
