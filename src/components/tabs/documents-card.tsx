'use client'

/*
 * OSS-2 (v1.203.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — documents
 * card: SOP-i, pogodbe, recepture, navodila z datotekami (vsebina v bazi).
 * Mounted in dashboard Settings → Ops section (settings.manage render gate).
 * i18n REGRESSION TRAP: this file is inside the scanned family (dashboard-tabs
 * family) — comments use English and key names ONLY; every user-visible string
 * goes through t().
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { FileText, AlertTriangle, RefreshCw, Plus, Download } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { DocumentDto } from '@/lib/documents'
import { MAX_DOCUMENT_BYTES } from '@/lib/documents'

interface LocationRowT { id: string; name: string }

const EMPTY_FORM = {
  locationId: '',
  title: '',
  category: 'sop',
  description: '',
  fileName: '',
  mimeType: '',
  contentBase64: '',
  size: 0,
}

const CATEGORY_KEYS: Record<string, string> = {
  sop: 'doc.cat.sop',
  pogodba: 'doc.cat.pogodba',
  receptura: 'doc.cat.receptura',
  navodilo: 'doc.cat.navodilo',
  ostalo: 'doc.cat.ostalo',
}

function day(s: string | null): string {
  return s ? s.slice(0, 10) : '—'
}

function humanSizeUI(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace(/\.0$/, '')} kB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}

export function DocumentsCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const perms = user?.permissions ?? []
  const canConfigure =
    perms.includes('settings.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'

  const [rows, setRows] = useState<DocumentDto[]>([])
  const [locations, setLocations] = useState<LocationRowT[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState('')

  const [replaceFor, setReplaceFor] = useState<DocumentDto | null>(null)
  const [replaceFile, setReplaceFile] = useState<{ fileName: string; mimeType: string; contentBase64: string; size: number } | null>(null)
  const [replacing, setReplacing] = useState(false)

  const [deleteFor, setDeleteFor] = useState<DocumentDto | null>(null)
  const [busy, setBusy] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<{ documents: DocumentDto[]; locations: LocationRowT[] }>('/api/documents')
      setRows(d.documents ?? [])
      setLocations(d.locations ?? [])
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canConfigure) return
    void (async () => { await load() })()
  }, [load, canConfigure])

  if (!canConfigure) return null

  /** 503 pre-DDL detection (haccp/payroll pattern: fail() message contains 'migracij'). */
  const migrPending = /migracij/.test(err)

  const migrBox = (retry: () => void) => (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-amber-800 flex items-center gap-1.5">
        <AlertTriangle className="h-4 w-4 shrink-0" /> {t('doc.hint')}
      </p>
      <Button size="sm" variant="outline" onClick={retry}>
        <RefreshCw className="h-3.5 w-3.5" /> {t('common.retry')}
      </Button>
    </div>
  )

  /** FileReader → data: URL → čist base64 (stripBase64DataUrl na strežniku še enkrat). */
  function readInto(
    file: File,
    onDone: (v: { fileName: string; mimeType: string; contentBase64: string; size: number }) => void,
    onErr: (msg: string) => void,
  ) {
    if (file.size > MAX_DOCUMENT_BYTES) {
      onErr(t('doc.errTooBig'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => onErr(t('doc.errFile'))
    reader.onload = () => {
      const raw = String(reader.result ?? '')
      const idx = raw.indexOf(',')
      onDone({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: idx >= 0 ? raw.slice(idx + 1) : raw,
        size: file.size,
      })
    }
    reader.readAsDataURL(file)
  }

  function onPickFile(f: File | undefined) {
    if (!f) return
    setFormErr('')
    readInto(f, (v) => setForm((cur) => ({ ...cur, ...v })), (m) => setFormErr(m))
  }

  function onPickReplaceFile(f: File | undefined) {
    if (!f) return
    readInto(f, setReplaceFile, (m) => toast({ variant: 'destructive', description: m }))
  }

  async function create() {
    const title = form.title.trim()
    if (!title || title.length > 120) {
      setFormErr(t('doc.errTitle'))
      return
    }
    if (!form.contentBase64) {
      setFormErr(t('doc.errFile'))
      return
    }
    setCreating(true)
    setFormErr('')
    try {
      // Select displays the first location as fallback — the payload must send
      // the SAME value (central users have no default location server-side).
      const locationId = form.locationId || locations[0]?.id || undefined
      await api('/api/documents', {
        method: 'POST',
        body: JSON.stringify({
          title,
          category: form.category,
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(locationId ? { locationId } : {}),
          fileName: form.fileName,
          mimeType: form.mimeType,
          contentBase64: form.contentBase64,
        }),
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      setForm(EMPTY_FORM)
      setFormOpen(false)
      toast({ description: t('doc.saved') })
      await load()
    } catch (e) {
      setFormErr(String((e as Error).message || e))
    } finally {
      setCreating(false)
    }
  }

  async function saveReplace() {
    if (!replaceFor || !replaceFile || replacing) return
    setReplacing(true)
    try {
      await api(`/api/documents/${replaceFor.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fileName: replaceFile.fileName,
          mimeType: replaceFile.mimeType,
          contentBase64: replaceFile.contentBase64,
        }),
      })
      toast({ description: t('doc.edited') })
      setReplaceFor(null)
      setReplaceFile(null)
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setReplacing(false)
    }
  }

  async function download(d: DocumentDto) {
    if (busy) return
    setBusy(d.id)
    try {
      const token = getToken()
      const res = await fetch(`/api/documents/${d.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = d.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
    }
  }

  async function remove(d: DocumentDto) {
    if (busy) return
    setBusy(d.id)
    try {
      await api(`/api/documents/${d.id}`, { method: 'DELETE' })
      toast({ description: t('doc.saved') })
      setDeleteFor(null)
      await load()
    } catch (e) {
      toast({ variant: 'destructive', description: String((e as Error).message || e) })
    } finally {
      setBusy('')
      setDeleteFor(null)
    }
  }

  const locName = (id: string): string => locations.find((l) => l.id === id)?.name ?? id

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <FileText className="h-4 w-4" /> {t('doc.title')}
          <Badge variant="secondary" className="ml-1">{rows.length}</Badge>
          <Button size="sm" variant="outline" className="h-8 gap-1 ml-auto" onClick={() => { void load() }} title={t('common.refresh')}>
            <RefreshCw className="h-3.5 w-3.5" /> {t('common.refresh')}
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setFormOpen(!formOpen)} aria-expanded={formOpen}>
            <Plus className="h-3.5 w-3.5" /> {t('doc.add')}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4">
        {migrPending ? (
          migrBox(() => { void load() })
        ) : (
          <>
            {err && <p className="text-sm text-destructive">{err}</p>}

            {formOpen && (
              <form
                className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4"
                onSubmit={(e) => { e.preventDefault(); void create() }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="doc-title">{t('doc.name')} *</Label>
                  <Input id="doc-title" value={form.title} maxLength={120} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="doc-cat">{t('doc.category')}</Label>
                  <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                    <SelectTrigger id="doc-cat" aria-label={t('doc.category')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sop">{t('doc.cat.sop')}</SelectItem>
                      <SelectItem value="pogodba">{t('doc.cat.pogodba')}</SelectItem>
                      <SelectItem value="receptura">{t('doc.cat.receptura')}</SelectItem>
                      <SelectItem value="navodilo">{t('doc.cat.navodilo')}</SelectItem>
                      <SelectItem value="ostalo">{t('doc.cat.ostalo')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="doc-file">{t('doc.file')} *</Label>
                  <Input
                    id="doc-file"
                    ref={fileInputRef}
                    type="file"
                    onChange={(e) => onPickFile(e.target.files?.[0])}
                    placeholder={t('doc.filePh')}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="doc-desc">{t('doc.description')}</Label>
                  <Input id="doc-desc" value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                {locations.length > 1 && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="doc-loc">{t('doc.location')}</Label>
                    <Select value={form.locationId || locations[0]?.id} onValueChange={(v) => setForm({ ...form, locationId: v })}>
                      <SelectTrigger id="doc-loc" aria-label={t('doc.location')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {form.contentBase64 && (
                  <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
                    {t('doc.file')}: {form.fileName} ({humanSizeUI(form.size)})
                  </p>
                )}
                {formErr && <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">{formErr}</p>}
                <div className="sm:col-span-2 lg:col-span-4">
                  <Button type="submit" size="sm" disabled={creating}>
                    {creating ? t('doc.uploading') : t('common.save')}
                  </Button>
                </div>
              </form>
            )}

            {loading ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('doc.empty')}</p>
            ) : (
              <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto">
                {rows.map((d) => (
                  <li key={d.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{d.title}</span>
                      <Badge variant="outline">{t(CATEGORY_KEYS[d.category] ?? 'doc.cat.ostalo')}</Badge>
                      <Badge variant="secondary">v{d.version}</Badge>
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          size="sm" variant="outline" className="h-8 gap-1"
                          disabled={busy === d.id || !!deleteFor}
                          onClick={() => { void download(d) }} title={t('doc.download')}
                        >
                          <Download className="h-3.5 w-3.5" /> {t('doc.download')}
                        </Button>
                        <Button
                          size="sm" variant="outline" className="h-8 gap-1" disabled={!!deleteFor}
                          onClick={() => { setReplaceFor(d); setReplaceFile(null) }}
                        >
                          {t('doc.replace')}
                        </Button>
                        <Button size="sm" variant="outline" className="h-8" disabled={busy === d.id} onClick={() => setDeleteFor(d)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{t('doc.location')}: {locName(d.locationId)}</span>
                      <span>{t('doc.file')}: {d.fileName}</span>
                      <span>{t('doc.size')}: {humanSizeUI(d.sizeBytes)}</span>
                      <span>{t('doc.version')}: {d.version}</span>
                      <span>{day(d.updatedAt)}</span>
                      {d.description && <span>{t('doc.description')}: {d.description}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {/* Replace dialog: full package fileName+mimeType+content → server bumps version */}
      <Dialog open={!!replaceFor} onOpenChange={(o) => { if (!o) { setReplaceFor(null); setReplaceFile(null) } }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('doc.replaceTitle', { title: replaceFor?.title ?? '' })}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="doc-replace-file">{t('doc.file')} *</Label>
              <Input
                id="doc-replace-file"
                ref={replaceInputRef}
                type="file"
                onChange={(e) => onPickReplaceFile(e.target.files?.[0])}
              />
              {replaceFile && (
                <p className="text-xs text-muted-foreground">
                  {replaceFile.fileName} ({humanSizeUI(replaceFile.size)}) → v{replaceFor ? replaceFor.version + 1 : '?'}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReplaceFor(null); setReplaceFile(null) }}>{t('common.cancel')}</Button>
            <Button onClick={() => { void saveReplace() }} disabled={!replaceFile || replacing}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteFor} onOpenChange={(o) => { if (!o) setDeleteFor(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.delete')} — {deleteFor?.title}</AlertDialogTitle>
            <AlertDialogDescription>{t('doc.confirmDelete')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy === deleteFor?.id}
              onClick={(e) => {
                e.preventDefault()
                if (deleteFor) void remove(deleteFor)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
