'use client'

/**
 * v1.246.0 (PRIMERJAVA-VMESNIKOV-2026 §20) — OPERATIVNI VAL: zavihek
 * OPRAVILA (digitalni checklisti, Lightspeed Tasks marec 2026).
 *
 * Plošča terminov: kartice seznamov (zapadlo / v teku / prihaja /
 * zaključeno + pokritost n/N) z odštickanjem postavk PO POSTAVKI —
 * check (potrditev), count (številka), text (opomba); pod vsakim odzivom
 * KDO + KDAJ (»track progress and see who completed what«). Zaključek
 * izpelje STREŽNIK iz pokritosti (POST /api/checklists/board vrne run;
 * klient le zrcali odgovor — ne more prijaviti "completed").
 *
 * Urejevalnik predlog (settings.manage): ime, kategorija, vseh sedem
 * pogostosti Lightspeed (dnevno … vsakih 6 mesecev) s pogojnimi polji
 * (dan v tednu / dan v mesecu / prvi dan-faza), rok, aktivnost, postavke
 * (besedilo + odzivni tip) — PUT /api/checklists/templates (stroga
 * strežniška validacija).
 *
 * Pravice: plošča = prijava (TAB_PERM_ALL — odpiralni seznam izpolni
 * kdor odpira); predloge = settings.manage (kartica urejevalnika se
 * izriše samo uporabnikom z dovoljenjem — backend uveljavlja neodvisno).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Loader2, ClipboardCheck, Plus, Trash2, ChevronDown, X, ListChecks } from 'lucide-react'

/* ── Tipe (zrcalijo src/lib/ops-checklists.ts — strežnik je resnica) ─────── */

interface ChecklistItemT {
  id: string
  label: string
  response: 'check' | 'count' | 'text'
}

interface ChecklistTemplateT {
  id: string
  name: string
  category: 'opening' | 'closing' | 'cleaning' | 'maintenance' | 'security' | 'other'
  repeat: 'daily' | 'weekly' | 'biweekly' | 'every4weeks' | 'monthly' | 'quarterly' | 'semiannual'
  weekday: number | null
  monthDay: number | null
  anchorDate: string
  /** §22 C — končni datum (null/'' = brez konca). */
  validUntil: string | null
  dueTime: string
  active: boolean
  items: ChecklistItemT[]
}

interface ChecklistRunT {
  id: string
  templateId: string
  templateName: string
  occurrenceKey: string
  state: string
  itemResults: Record<string, { kind: string; value: boolean | number | string; at: string; byId: string; byName: string }>
  completedById: string
  completedByName: string
  completedAt: string | null
}

interface ChecklistBoardItemT {
  template: ChecklistTemplateT
  date: string
  dueAt: string
  state: 'overdue' | 'pending' | 'upcoming' | 'completed'
  progress: { done: number; total: number }
  run: ChecklistRunT | null
}

interface BoardResponseT {
  checklists: ChecklistBoardItemT[]
  summary: Record<string, number>
  templates: ChecklistTemplateT[]
  timezone: string
  locationId: string
  ddlPending: boolean
}

const CATEGORIES: ChecklistTemplateT['category'][] = ['opening', 'closing', 'cleaning', 'maintenance', 'security', 'other']
const REPEATS: ChecklistTemplateT['repeat'][] = ['daily', 'weekly', 'biweekly', 'every4weeks', 'monthly', 'quarterly', 'semiannual']
const WEEKLY_REPEATS: ChecklistTemplateT['repeat'][] = ['weekly', 'biweekly', 'every4weeks']
const MONTHLY_REPEATS: ChecklistTemplateT['repeat'][] = ['monthly', 'quarterly', 'semiannual']
const RESPONSES: ChecklistItemT['response'][] = ['check', 'count', 'text']

const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const timeOf = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function OpravilaTab() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const canManageTemplates = Boolean(
    user && ((user.permissions ?? []).includes('settings.manage') || user?.role === 'OWNER' || user?.role === 'ADMIN'),
  )

  const [board, setBoard] = useState<BoardResponseT | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyItem, setBusyItem] = useState('') // `${templateId}|${date}|${itemId}` — spinner na postavki
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<ChecklistTemplateT | null>(null) // urejevalnik predloge
  const [draftErr, setDraftErr] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const qs = user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''
      const d = await api<BoardResponseT>(`/api/checklists/board${qs}`)
      setBoard(d)
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 160))
    } finally {
      setLoading(false)
    }
  }, [user?.locationId])

  useEffect(() => {
    // v1.198.0 disciplina (react-hooks/set-state-in-effect): async kontinuacija
    // po await — vzorec ReservationPacingCard
    void (async () => {
      await load()
    })()
  }, [load])

  // 30 s osvežitev MED MONTAŽO (zavihek je odprt — ekipa odšticka vzporedno);
  // pavza, ko je zavihek skrit (document.hidden). TabsContent se ob preklopu
  // zavihkov unmounta → naslednja montaža prinese sveže podatke vseeno.
  useEffect(() => {
    const h = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 30_000)
    return () => window.clearInterval(h)
  }, [load])

  /** Odštickaj/odgovori na postavko — POST vrne run; lokalno zrcalimo odgovor
   *  (zaključek izpelje strežnik — klient ne more prijaviti "completed"). */
  async function respond(item: ChecklistBoardItemT, boardItem: ChecklistItemT, value: boolean | number | string | null) {
    const key = `${item.template.id}|${item.date}|${boardItem.id}`
    setBusyItem(key)
    try {
      const d = await api<{ run: ChecklistRunT; progress: { done: number; total: number } }>('/api/checklists/board', {
        method: 'POST',
        body: JSON.stringify({
          locationId: user?.locationId ?? undefined,
          templateId: item.template.id,
          date: item.date,
          itemId: boardItem.id,
          value,
        }),
      })
      setBoard((prev) => {
        if (!prev) return prev
        const now = Date.now()
        return {
          ...prev,
          checklists: prev.checklists.map((it) =>
            it.template.id === item.template.id && it.date === item.date
              ? {
                  ...it,
                  run: d.run,
                  progress: d.progress,
                  state:
                    d.run.state === 'completed'
                      ? ('completed' as const)
                      : new Date(it.dueAt).getTime() <= now
                        ? ('overdue' as const)
                        : ('pending' as const),
                }
              : it,
          ),
        }
      })
      if (d.run.state === 'completed' && item.run?.state !== 'completed') {
        toast({ title: t('opv.completed') })
      }
    } catch (e) {
      toast({ title: String((e as Error).message || e).slice(0, 160) })
      void load() // server je resnica — osveži
    } finally {
      setBusyItem('')
    }
  }

  /* ── Urejevalnik predlog ──────────────────────────────────────────────── */

  function newTemplate(): ChecklistTemplateT {
    return {
      id: `tpl-${Date.now().toString(36)}`,
      name: '',
      category: 'opening',
      repeat: 'daily',
      weekday: 1,
      monthDay: 1,
      anchorDate: todayKey(),
      validUntil: null,
      dueTime: '09:00',
      active: true,
      items: [{ id: `it-${Date.now().toString(36)}`, label: '', response: 'check' }],
    }
  }

  async function saveDraft() {
    if (!draft) return
    setSaving(true)
    setDraftErr('')
    try {
      const templates = [...(board?.templates ?? []).filter((x) => x.id !== draft.id), draft]
      await api<{ templates: ChecklistTemplateT[] }>('/api/checklists/templates', {
        method: 'PUT',
        body: JSON.stringify({ locationId: user?.locationId ?? undefined, templates }),
      })
      setDraft(null)
      toast({ title: t('opv.saved') })
      await load()
    } catch (e) {
      setDraftErr(String((e as Error).message || e).slice(0, 200))
    } finally {
      setSaving(false)
    }
  }

  async function deleteTemplate(id: string) {
    if (!board) return
    setSaving(true)
    setDraftErr('')
    try {
      const templates = board.templates.filter((x) => x.id !== id)
      await api<{ templates: ChecklistTemplateT[] }>('/api/checklists/templates', {
        method: 'PUT',
        body: JSON.stringify({ locationId: user?.locationId ?? undefined, templates }),
      })
      setDraft(null)
      toast({ title: t('opv.deleted') })
      await load()
    } catch (e) {
      setDraftErr(String((e as Error).message || e).slice(0, 200))
    } finally {
      setSaving(false)
    }
  }

  /* ── Izris ────────────────────────────────────────────────────────────── */

  const grouped = useMemo(() => {
    const g: Record<string, ChecklistBoardItemT[]> = { overdue: [], pending: [], upcoming: [], completed: [] }
    for (const it of board?.checklists ?? []) g[it.state]?.push(it)
    return g
  }, [board])

  const stateBadge = (state: ChecklistBoardItemT['state']) => {
    switch (state) {
      case 'overdue':
        return <Badge className="bg-red-700">{t('opv.state.overdue')}</Badge>
      case 'pending':
        return <Badge className="bg-amber-600">{t('opv.state.pending')}</Badge>
      case 'upcoming':
        return <Badge variant="secondary">{t('opv.state.upcoming')}</Badge>
      default:
        return <Badge className="bg-emerald-700">{t('opv.state.completed')}</Badge>
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-stone-500">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> …
      </div>
    )
  }

  return (
    <div className="space-y-4" data-region="opravila-tab">
      {err && <p className="text-sm text-red-700 break-words" role="alert">{err}</p>}

      {board?.ddlPending && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-900">{t('opv.ddlPending')}</CardContent>
        </Card>
      )}

      {/* ── Plošča terminov ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="w-4 h-4" aria-hidden /> {t('opv.board')}
          </CardTitle>
          <div className="flex items-center gap-2">
            {(board?.summary.overdue ?? 0) > 0 && <Badge className="bg-red-700">{board?.summary.overdue}</Badge>}
            {(board?.summary.pending ?? 0) > 0 && <Badge className="bg-amber-600">{board?.summary.pending}</Badge>}
            {(board?.summary.completed ?? 0) > 0 && <Badge className="bg-emerald-700">{board?.summary.completed}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {(board?.checklists?.length ?? 0) === 0 && (
            <p className="text-sm text-stone-500">
              {(board?.templates?.length ?? 0) === 0 ? t('opv.noTemplates') : t('opv.emptyBoard')}
            </p>
          )}
          <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            {[...grouped.overdue, ...grouped.pending, ...grouped.upcoming, ...grouped.completed].map((it) => (
              <Card key={`${it.template.id}|${it.date}`} className={it.state === 'completed' ? 'border-emerald-300' : it.state === 'overdue' ? 'border-red-300' : ''}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="truncate">{it.template.name}</span>
                      {stateBadge(it.state)}
                    </CardTitle>
                    <p className="mt-1 text-xs text-stone-500">
                      {t(`opv.cat.${it.template.category}`)} · {t(`opv.rep.${it.template.repeat}`)} · {it.template.dueTime}
                      {it.date !== todayKey() ? ` · ${it.date}` : ''} · {t('opv.progress')} {it.progress.done}/{it.progress.total}
                    </p>
                  </div>
                  {it.run?.state === 'completed' && it.run.completedByName && (
                    <p className="ml-2 shrink-0 text-xs text-emerald-800">
                      {t('opv.completedBy')}: {it.run.completedByName}
                      {it.run.completedAt ? ` · ${timeOf(it.run.completedAt)}` : ''}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-1.5 px-4 pb-3">
                  {it.template.items.map((item) => {
                    const res = it.run?.itemResults?.[item.id]
                    const key = `${it.template.id}|${it.date}|${item.id}`
                    return (
                      <div key={item.id} className="flex flex-col gap-0.5 rounded-md border border-stone-100 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          {item.response === 'check' ? (
                            <Checkbox
                              id={`chk-${it.template.id}-${it.date}-${item.id}`}
                              checked={res?.value === true}
                              disabled={busyItem === key}
                              onCheckedChange={(v) => void respond(it, item, v === true)}
                              aria-label={item.label}
                            />
                          ) : item.response === 'count' ? (
                            <Input
                              type="number"
                              inputMode="decimal"
                              className="h-8 w-24"
                              placeholder="–"
                              defaultValue={typeof res?.value === 'number' ? res.value : ''}
                              disabled={busyItem === key}
                              onBlur={(e) => {
                                const raw = e.target.value.trim()
                                if (raw === '') return
                                const n = Number(raw.replace(',', '.'))
                                if (Number.isFinite(n) && n !== res?.value) void respond(it, item, n)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                              }}
                              aria-label={item.label}
                            />
                          ) : (
                            <Input
                              type="text"
                              className="h-8 max-w-[16rem]"
                              placeholder={t('opv.resp.text')}
                              defaultValue={typeof res?.value === 'string' ? res.value : ''}
                              disabled={busyItem === key}
                              onBlur={(e) => {
                                const v = e.target.value.trim()
                                if (v && v !== res?.value) void respond(it, item, v.slice(0, 500))
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                              }}
                              aria-label={item.label}
                            />
                          )}
                          <label
                            htmlFor={`chk-${it.template.id}-${it.date}-${item.id}`}
                            className="min-w-0 flex-1 text-sm leading-tight"
                          >
                            {item.label}
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-stone-400">{t(`opv.resp.${item.response}`)}</span>
                          </label>
                          {busyItem === key ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" aria-hidden />
                          ) : res ? (
                            <button
                              type="button"
                              onClick={() => void respond(it, item, null)}
                              className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                              aria-label={t('opv.clear')}
                              title={t('opv.clear')}
                            >
                              <X className="w-3.5 h-3.5" aria-hidden />
                            </button>
                          ) : null}
                        </div>
                        {res && (
                          <p className="pl-8 text-[11px] text-stone-500">
                            {res.byName || '—'} · {timeOf(res.at)}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Urejevalnik predlog (settings.manage) ── */}
      {canManageTemplates && (
        <Collapsible open={editorOpen} onOpenChange={setEditorOpen}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardCheck className="w-4 h-4" aria-hidden /> {t('opv.templates')}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(newTemplate())
                    setDraftErr('')
                    setEditorOpen(true)
                  }}
                >
                  <Plus className="w-4 h-4 mr-1" aria-hidden /> {t('opv.addTemplate')}
                </Button>
                <CollapsibleTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label={t('opv.templates')}>
                    <ChevronDown className={`w-4 h-4 transition-transform ${editorOpen ? 'rotate-180' : ''}`} aria-hidden />
                  </Button>
                </CollapsibleTrigger>
              </div>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="space-y-3">
                {(board?.templates?.length ?? 0) === 0 && !draft && (
                  <p className="text-sm text-stone-500">{t('opv.noTemplates')}</p>
                )}
                <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {(board?.templates ?? []).map((tpl) => (
                    <div key={tpl.id} className="flex items-center justify-between gap-2 rounded-md border border-stone-100 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {tpl.name} {!tpl.active && <span className="text-xs text-stone-400">· {t('opv.inactive')}</span>}
                        </p>
                        <p className="text-xs text-stone-500">
                          {t(`opv.cat.${tpl.category}`)} · {t(`opv.rep.${tpl.repeat}`)} · {tpl.dueTime} · {tpl.items.length} {t('opv.items').toLowerCase()}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setDraft(structuredClone(tpl))
                            setDraftErr('')
                          }}
                          aria-label={t('common.edit')}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void deleteTemplate(tpl.id)} disabled={saving} aria-label={t('common.delete')}>
                          <Trash2 className="w-4 h-4 text-red-700" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {draft && (
                  <div className="space-y-3 rounded-md border border-stone-200 p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="opv-name" className="text-sm">{t('opv.templateName')}</Label>
                        <Input id="opv-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="opv-cat" className="text-sm">{t('opv.category')}</Label>
                        <select
                          id="opv-cat"
                          className="flex h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm"
                          value={draft.category}
                          onChange={(e) => setDraft({ ...draft, category: e.target.value as ChecklistTemplateT['category'] })}
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>{t(`opv.cat.${c}`)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="opv-repeat" className="text-sm">{t('opv.repeat')}</Label>
                        <select
                          id="opv-repeat"
                          className="flex h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm"
                          value={draft.repeat}
                          onChange={(e) => setDraft({ ...draft, repeat: e.target.value as ChecklistTemplateT['repeat'] })}
                        >
                          {REPEATS.map((r) => (
                            <option key={r} value={r}>{t(`opv.rep.${r}`)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="opv-due" className="text-sm">{t('opv.dueTime')}</Label>
                        <Input id="opv-due" type="time" value={draft.dueTime} onChange={(e) => setDraft({ ...draft, dueTime: e.target.value })} />
                      </div>
                      {WEEKLY_REPEATS.includes(draft.repeat) && (
                        <div className="space-y-1.5">
                          <Label htmlFor="opv-weekday" className="text-sm">{t('opv.weekday')}</Label>
                          <select
                            id="opv-weekday"
                            className="flex h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm"
                            value={draft.weekday ?? 1}
                            onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
                          >
                            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                              <option key={d} value={d}>
                                {new Date(2024, 0, d).toLocaleDateString('sl-SI', { weekday: 'long' })}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {MONTHLY_REPEATS.includes(draft.repeat) && (
                        <div className="space-y-1.5">
                          <Label htmlFor="opv-monthday" className="text-sm">{t('opv.monthDay')}</Label>
                          <Input
                            id="opv-monthday"
                            type="number"
                            min={1}
                            max={28}
                            value={draft.monthDay ?? 1}
                            onChange={(e) => setDraft({ ...draft, monthDay: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                          />
                        </div>
                      )}
                      {(WEEKLY_REPEATS.includes(draft.repeat) || MONTHLY_REPEATS.includes(draft.repeat)) && (
                        <div className="space-y-1.5">
                          <Label htmlFor="opv-anchor" className="text-sm">{t('opv.anchorDate')}</Label>
                          <Input id="opv-anchor" type="date" value={draft.anchorDate} onChange={(e) => setDraft({ ...draft, anchorDate: e.target.value })} />
                        </div>
                      )}
                      {/* §22 C (raziskava junij 2026 »optional end dates«): sezonski
                          seznam preneha rojevati termine po tem datumu; prazno = brez konca. */}
                      <div className="space-y-1.5">
                        <Label htmlFor="opv-until" className="text-sm">{t('opv.validUntil')}</Label>
                        <Input
                          id="opv-until"
                          type="date"
                          value={draft.validUntil ?? ''}
                          onChange={(e) => setDraft({ ...draft, validUntil: e.target.value || null })}
                        />
                        {draft.validUntil && (
                          <p className="text-xs text-stone-500">{t('opv.validUntilHint')}</p>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="opv-active" className="text-sm">{t('opv.active')}</Label>
                        <Switch id="opv-active" checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-sm">{t('opv.items')}</Label>
                      {draft.items.map((item, idx) => (
                        <div key={item.id} className="flex items-center gap-2">
                          <Input
                            value={item.label}
                            maxLength={160}
                            placeholder={t('opv.itemLabel')}
                            onChange={(e) => {
                              const items = [...draft.items]
                              items[idx] = { ...item, label: e.target.value }
                              setDraft({ ...draft, items })
                            }}
                            aria-label={`${t('opv.items')} ${idx + 1}`}
                          />
                          <select
                            className="h-10 shrink-0 rounded-md border border-stone-200 bg-white px-2 text-sm"
                            value={item.response}
                            onChange={(e) => {
                              const items = [...draft.items]
                              items[idx] = { ...item, response: e.target.value as ChecklistItemT['response'] }
                              setDraft({ ...draft, items })
                            }}
                            aria-label={t('opv.respType')}
                          >
                            {RESPONSES.map((r) => (
                              <option key={r} value={r}>{t(`opv.resp.${r}`)}</option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDraft({ ...draft, items: draft.items.filter((x) => x.id !== item.id) })}
                            disabled={draft.items.length <= 1}
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="w-4 h-4 text-red-700" aria-hidden />
                          </Button>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            items: [...draft.items, { id: `it-${Date.now().toString(36)}`, label: '', response: 'check' }],
                          })
                        }
                      >
                        <Plus className="w-4 h-4 mr-1" aria-hidden /> {t('opv.newItem')}
                      </Button>
                    </div>

                    {draftErr && <p className="text-sm text-red-700 break-words" role="alert">{draftErr}</p>}

                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
                        {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null} {t('common.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}
    </div>
  )
}
