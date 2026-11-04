'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, MessageSquareText, Plus, Trash2 } from 'lucide-react'

/**
 * STREŽNI VAL v1.248.0 (PRIMERJAVA-VMESNIKOV-2026 §22 B — Lightspeed maj
 * 2026 »preset notes … keep kitchen instructions consistent«) — REGISTAR
 * PREDNASTAVLJENIH OPOMB ZA KUHINJO.
 *
 * Kartica v zavihku Meni (poleg Skupin opcij — Lightspeed dom: Back Office >
 * Menu > Production instructions > Notes). Urejanje: menu.manage; branje
 * pokriva GET /api/preset-notes (vsI prijavljeni — natakar izbira v košarici).
 * Prazno stanje ločeno (brez registra ni doslednosti, ne prazen zaslon).
 *
 * ISKRENA MEJA (§22 B): ena opomba per vrstica naročila, ki gre VEDNO na KDS
 * in na tisk — per-note stikalo tiska je Back Office niansa, ki bi shranjevala
 * zastavico na postavki; tukaj je ena resnica povsod.
 */

interface PresetNoteT { id: string; label: string; sortOrder: number }

export function PresetNotesCard({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const [notes, setNotes] = useState<PresetNoteT[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api<{ notes: PresetNoteT[] }>('/api/preset-notes')
      setNotes(res.notes)
    } catch {
      setNotes([])
    }
  }, [])

  // mikrotaska — setState izven sinhronega telesa efekta (react-hooks pravilo;
  // vzorec payCue iz glavnega dashboarda)
  useEffect(() => { queueMicrotask(() => { void load() }) }, [load])

  async function save(next: PresetNoteT[]): Promise<boolean> {
    setBusy(true)
    try {
      const res = await api<{ notes: PresetNoteT[] }>('/api/preset-notes', { method: 'PUT', body: JSON.stringify({ notes: next }) })
      setNotes(res.notes)
      return true
    } catch (e) {
      toast({ title: (e as Error).message || t('pn.saveFailed'), variant: 'destructive' })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addNote() {
    const label = newLabel.trim()
    if (!label || !notes) return
    if (await save([...notes, { id: `pn-${Date.now().toString(36)}`, label, sortOrder: notes.length }])) {
      setNewLabel('')
      toast({ title: t('pn.saved') })
    }
  }

  async function removeNote(id: string) {
    if (!notes) return
    if (!window.confirm(t('pn.deleteConfirm'))) return
    if (await save(notes.filter((n) => n.id !== id).map((n, i) => ({ ...n, sortOrder: i })))) {
      toast({ title: t('pn.deleted') })
    }
  }

  return (
    <Card data-component="preset-notes-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareText className="w-4 h-4" aria-hidden />
          {t('pn.title')}
        </CardTitle>
        <p className="text-sm text-stone-500">{t('pn.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {notes === null ? (
          <div className="flex items-center gap-2 text-sm text-stone-500" role="status">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> {t('common.loading')}
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-stone-500">{t('pn.empty')}</p>
        ) : (
          <ul className="space-y-1.5" data-region="pn-list">
            {notes.map((n) => (
              <li key={n.id} className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2">
                <span className="flex-1 text-sm break-words">{n.label}</span>
                {canManage && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    onClick={() => void removeNote(n.id)}
                    disabled={busy}
                    aria-label={t('pn.delete', { label: n.label })}
                  >
                    <Trash2 className="w-4 h-4 text-red-700" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="pn-new" className="text-sm">{t('pn.newLabel')}</Label>
              <Input
                id="pn-new"
                value={newLabel}
                maxLength={60}
                placeholder={t('pn.placeholder')}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addNote() } }}
              />
            </div>
            <Button size="sm" onClick={() => void addNote()} disabled={busy || !newLabel.trim()}>
              {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : <Plus className="w-4 h-4 mr-1" aria-hidden />}
              {t('common.add')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
