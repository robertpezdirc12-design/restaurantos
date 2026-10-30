'use client'

/**
 * P1 #8 (v1.190.0) — Nastavitvena kartica lastnega spletnega portala za
 * naročila (zavihek Nastavitve, /s/<token>).
 *
 * Vsebina: vklop portala, načina prevzema/dostave, dostavna pristojbina,
 * minimalni znesek, ocena priprave, opomba za goste, javna povezava
 * (kopiraj / odpri / zamenjaj = rotacija skrivnosti → stara povezava takoj
 * preneha veljati; sledenje tekočega naročila preživi rotacijo).
 *
 * Vir: /api/web-portal (vse operacije settings.manage — kartica se izriše
 * SAMO uporabnikom z settings.manage, isto disciplina kot ReservationWidgetCard).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Link2, Copy, RefreshCw, ExternalLink, ShoppingCart } from 'lucide-react'

interface PortalT {
  id: string
  locationId: string
  enabled: boolean
  pickupEnabled: boolean
  deliveryEnabled: boolean
  deliveryFee: number
  minOrder: number
  prepMinutes: number
  note: string
  createdAt: string
  updatedAt: string
}

export function WebPortalCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  // kartica samo za settings.manage (backend dvokratno zaščiti PUT)
  const canConfigure = Boolean(
    user && ((user.permissions ?? []).includes('settings.manage') || user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER'),
  )
  const [portal, setPortal] = useState<PortalT | null>(null)
  const [exists, setExists] = useState<boolean | null>(null)
  const [publicUrl, setPublicUrl] = useState('')
  const [form, setForm] = useState<PortalT | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const qs = user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''
      const d = await api<{ portal: PortalT | null; token?: string; publicUrl?: string }>(`/api/web-portal${qs}`)
      if (d.portal) {
        setPortal(d.portal)
        setForm(d.portal)
        setNote(d.portal.note)
        setExists(true)
        if (d.token && d.publicUrl) setPublicUrl(`${window.location.origin}${d.publicUrl}`)
      } else {
        setExists(false)
      }
    } catch (e) {
      const raw = String((e as Error).message || e)
      if (/locationId|lokacij/i.test(raw)) setErr(t('web.portal.errNoLocation'))
      else setErr(t('web.portal.errGeneric', { msg: raw.slice(0, 120) }))
    } finally {
      setLoading(false)
    }
  }, [t, user?.locationId])

  useEffect(() => { if (canConfigure) void (async () => { await load() })() }, [canConfigure, load])

  async function save(opts: { rotate?: boolean; init?: boolean } = {}) {
    setBusy(true)
    setErr('')
    try {
      const body: Record<string, unknown> = { locationId: user?.locationId ?? undefined }
      if (!opts.init) {
        if (form) {
          body.enabled = form.enabled
          body.pickupEnabled = form.pickupEnabled
          body.deliveryEnabled = form.deliveryEnabled
          body.prepMinutes = form.prepMinutes
          body.minOrder = form.minOrder
          body.deliveryFee = form.deliveryFee
        }
        body.note = note
      } else {
        body.enabled = false // inicializacija: vrstica + token, vklop šele po shrambi
      }
      if (opts.rotate) body.rotateToken = true
      const d = await api<{ portal: PortalT; token?: string; publicUrl?: string }>('/api/web-portal', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      setPortal(d.portal)
      setForm(d.portal)
      setNote(d.portal.note)
      setExists(true)
      if (d.token && d.publicUrl) {
        // sestavi absolutni URL iz trenutnega izvora (token je skrivnost — prikaz osebju za kopiranje)
        setPublicUrl(`${window.location.origin}${d.publicUrl}`)
      } else if (!publicUrl) {
        setPublicUrl(`${window.location.origin}/s/…`)
      }
      toast({ description: t('web.portal.saved') })
      if (opts.init || opts.rotate) await load()
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(false)
    }
  }

  async function copyUrl() {
    if (!publicUrl) return
    try {
      await navigator.clipboard.writeText(publicUrl)
      toast({ description: t('web.portal.copied') })
    } catch {
      toast({ description: publicUrl })
    }
  }

  if (!canConfigure) return null
  if (loading) {
    return (
      <Card><CardContent className="flex items-center gap-2 text-sm text-stone-500 py-6"><Loader2 className="h-4 w-4 animate-spin" /> {t('web.portal.loading')}</CardContent></Card>
    )
  }

  const numField = (key: 'prepMinutes' | 'minOrder' | 'deliveryFee', labelKey: string, step: string, min: number, max: number) => (
    <div className="space-y-1">
      <Label htmlFor={`wp-${key}`}>{t(labelKey)}</Label>
      <Input
        id={`wp-${key}`}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={form ? String(form[key]) : ''}
        disabled={busy}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) setForm((p) => (p ? { ...p, [key]: n } : p))
        }}
        className="h-9"
      />
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          <ShoppingCart className="w-4 h-4" /> {t('web.portal.title')}
          {portal && (
            <Badge variant={portal.enabled ? 'default' : 'secondary'} className="ml-1">
              {portal.enabled ? t('web.portal.enabled') : t('web.portal.off')}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-stone-500 -mt-1">{t('web.portal.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-red-700">{err}</p>}

        {exists === false ? (
          <div className="rounded-xl border border-dashed border-stone-300 p-4 text-center">
            <p className="text-sm text-stone-500 mb-3">{t('web.portal.notConfigured')}</p>
            <Button disabled={busy} onClick={() => save({ init: true })}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              {t('web.portal.init')}
            </Button>
          </div>
        ) : portal && form ? (
          <>
            {/* povezava */}
            <div className="space-y-2">
              <Label htmlFor="wp-url">{t('web.portal.url')}</Label>
              <div className="flex gap-2">
                <Input id="wp-url" readOnly value={publicUrl || `${window.location.origin}/s/…`} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" size="icon" onClick={copyUrl} title={t('web.portal.copy')} aria-label={t('web.portal.copy')}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title={t('web.portal.rotate')}
                  aria-label={t('web.portal.rotate')}
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t('web.portal.rotateConfirm'))) void save({ rotate: true })
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {portal.enabled && publicUrl && (
                  <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                    <Button type="button" variant="outline" size="icon" title={t('web.portal.open')} aria-label={t('web.portal.open')}>
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </a>
                )}
              </div>
              <p className="text-xs text-stone-400">{t('web.portal.rotateHint')}</p>
            </div>

            {/* vklop + načini */}
            <div className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2.5">
              <Label htmlFor="wp-enabled">{t('web.portal.enabled')}</Label>
              <Switch id="wp-enabled" checked={form.enabled} onCheckedChange={(v) => setForm((p) => (p ? { ...p, enabled: v } : p))} disabled={busy} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2.5">
                <Label htmlFor="wp-pickup">{t('web.portal.pickup')}</Label>
                <Switch id="wp-pickup" checked={form.pickupEnabled} onCheckedChange={(v) => setForm((p) => (p ? { ...p, pickupEnabled: v } : p))} disabled={busy} />
              </div>
              <div className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2.5">
                <Label htmlFor="wp-delivery">{t('web.portal.delivery')}</Label>
                <Switch id="wp-delivery" checked={form.deliveryEnabled} onCheckedChange={(v) => setForm((p) => (p ? { ...p, deliveryEnabled: v } : p))} disabled={busy} />
              </div>
            </div>

            {/* politika */}
            <div className="grid gap-3 sm:grid-cols-3">
              {numField('prepMinutes', 'web.portal.prepMinutes', '1', 5, 180)}
              {numField('minOrder', 'web.portal.minOrder', '0.01', 0, 500)}
              {numField('deliveryFee', 'web.portal.deliveryFee', '0.01', 0, 50)}
            </div>

            {/* opomba za goste */}
            <div className="space-y-1">
              <Label htmlFor="wp-note">{t('web.portal.note')}</Label>
              <Textarea id="wp-note" value={note} maxLength={300} rows={2} disabled={busy} onChange={(e) => setNote(e.target.value)} className="min-h-11" />
              <p className="text-xs text-stone-400">{t('web.portal.noteHint')}</p>
            </div>

            <Button disabled={busy} onClick={() => save()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('web.portal.save')}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
