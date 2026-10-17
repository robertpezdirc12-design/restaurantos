'use client'

/**
 * Issue #13 (P1/P2, v1.110.0) — Nastavitvena kartica javnega rezervacijskega
 * widgeta (zavihek Nastavitve).
 *
 * Vsebina: vklop widgeta, javna povezava (kopiraj / odpri / zamenjaj = rotacija
 * skrivnosti → stara povezava takoj preneha delovati), politika terminov
 * (korak mreže, min/max oseb, predhodni čas, horizont, mest na termin).
 *
 * Vir: /api/reservations/widget (GET reservations.manage; PUT/DELETE
 * settings.manage — kartica se izriše SAMO uporabnikom z settings.manage,
 * ostali v zavihku vidijo ostale kartice).
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
import { Loader2, Link2, Copy, RefreshCw, ExternalLink, CalendarDays } from 'lucide-react'

interface WidgetPolicyT {
  slotMinutes: number
  minParty: number
  maxParty: number
  leadMinutes: number
  maxAdvanceDays: number
  maxCoversPerSlot: number
}
interface WidgetT {
  id: string
  locationId: string
  enabled: boolean
  policy: WidgetPolicyT
  createdAt: string
  updatedAt: string
}

const POLICY_FIELDS: { key: keyof WidgetPolicyT; labelKey: string; min: number; max: number }[] = [
  { key: 'slotMinutes', labelKey: 'resv.wid.slotMinutes', min: 5, max: 240 },
  { key: 'minParty', labelKey: 'resv.wid.minParty', min: 1, max: 40 },
  { key: 'maxParty', labelKey: 'resv.wid.maxParty', min: 1, max: 40 },
  { key: 'leadMinutes', labelKey: 'resv.wid.leadMinutes', min: 0, max: 1440 },
  { key: 'maxAdvanceDays', labelKey: 'resv.wid.maxAdvanceDays', min: 1, max: 365 },
  { key: 'maxCoversPerSlot', labelKey: 'resv.wid.maxCovers', min: 0, max: 500 },
]

export function ReservationWidgetCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  // kartica samo za settings.manage (backend dvokratno zaščiti PUT)
  const canConfigure = Boolean(user && (user.permissions ?? []).includes('settings.manage') || user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER')
  const [widget, setWidget] = useState<WidgetT | null>(null)
  const [exists, setExists] = useState<boolean | null>(null)
  const [publicUrl, setPublicUrl] = useState('')
  const [policy, setPolicy] = useState<WidgetPolicyT | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      // Issue #71 audit-4: GET brez locationId je za uporabnika brez lastne lokacije
      // (admin/centralna vloga) vrnil HTTP 400 (manjka lokacija) kot surov
      // razvijalski error. Zdaj: eksplicitno pošljemo locationId iz profila (če ga ima)
      // in napako prevedemo v čLOVEŠKO sporočilo z naslednjim korakom.
      const qs = user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''
      const d = await api<{ widget: WidgetT | null; token?: string; publicUrl?: string }>(`/api/reservations/widget${qs}`)
      if (d.widget) {
        setWidget(d.widget)
        setExists(true)
        setPolicy(d.widget.policy)
        setEnabled(d.widget.enabled)
        // GET razkrije povezavo imetnikom settings.manage (ista oseba, ki jo izda)
        if (d.token && d.publicUrl) setPublicUrl(`${window.location.origin}${d.publicUrl}`)
      } else {
        setExists(false)
      }
    } catch (e) {
      // Issue #71 audit-4: razvijalska napaka → človeško sporočilo z akcijo
      const raw = String((e as Error).message || e)
      if (/locationId|lokacij/i.test(raw)) setErr(t('resv.wid.errNoLocation'))
      else setErr(t('resv.wid.errGeneric', { msg: raw.slice(0, 120) }))
    } finally {
      setLoading(false)
    }
  }, [t, user?.locationId])

  useEffect(() => { if (canConfigure) void load() }, [canConfigure, load])

  async function save(opts: { rotate?: boolean; init?: boolean } = {}) {
    setBusy(true)
    setErr('')
    try {
      const body: Record<string, unknown> = { locationId: user?.locationId ?? undefined }
      if (!opts.init) {
        body.enabled = enabled
        if (policy) {
          for (const f of POLICY_FIELDS) body[f.key] = policy[f.key]
        }
      } else {
        body.enabled = enabled
      }
      if (opts.rotate) body.rotateToken = true
      const d = await api<{ widget: WidgetT; token?: string; publicUrl: string }>('/api/reservations/widget', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      setWidget(d.widget)
      setExists(true)
      setPolicy(d.widget.policy)
      setEnabled(d.widget.enabled)
      if (d.token) {
        // sestavi absolutni URL iz trenutnega izvora (token je skrivnost — v
        // naslovni vrstici gostuje, zato je prikaz osebju namenjen kopiranju)
        setPublicUrl(`${window.location.origin}${d.publicUrl}`)
      } else if (!publicUrl) {
        setPublicUrl(`${window.location.origin}/r/…`)
      }
      toast({ description: t('resv.wid.saved') })
      // po inicializaciji takoj ponovno naloži (GET ne vrača tokena)
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
      toast({ description: t('resv.wid.copied') })
    } catch {
      toast({ description: publicUrl })
    }
  }

  if (!canConfigure) return null
  if (loading) {
    return (
      <Card><CardContent className="flex items-center gap-2 text-sm text-stone-500 py-6"><Loader2 className="h-4 w-4 animate-spin" /> {t('resv.public.loading')}</CardContent></Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4" /> {t('resv.wid.title')}
          {widget && (
            <Badge variant={widget.enabled ? 'default' : 'secondary'} className="ml-1">
              {widget.enabled ? t('resv.wid.enabled') : t('integ.offF')}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-stone-500 -mt-1">{t('resv.wid.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-red-700">{err}</p>}

        {exists === false ? (
          <div className="rounded-xl border border-dashed border-stone-300 p-4 text-center">
            <p className="text-sm text-stone-500 mb-3">{t('resv.wid.notConfigured')}</p>
            <Button disabled={busy} onClick={() => save({ init: true })}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              {t('resv.wid.init')}
            </Button>
          </div>
        ) : widget && policy ? (
          <>
            {/* povezava */}
            <div className="space-y-2">
              <Label>{t('resv.wid.url')}</Label>
              <div className="flex gap-2">
                <Input readOnly value={publicUrl || `${window.location.origin}/r/…`} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" size="icon" onClick={copyUrl} title={t('resv.wid.copy')} aria-label={t('resv.wid.copy')}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title={t('resv.wid.rotate')}
                  aria-label={t('resv.wid.rotate')}
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t('resv.wid.rotateConfirm'))) void save({ rotate: true })
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {widget.enabled && publicUrl && (
                  <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                    <Button type="button" variant="outline" size="icon" title={t('resv.wid.open')} aria-label={t('resv.wid.open')}>
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </a>
                )}
              </div>
              <p className="text-xs text-stone-400">{t('resv.wid.rotateHint')}</p>
            </div>

            {/* vklop */}
            <div className="flex items-center justify-between rounded-xl border border-stone-200 px-3 py-2.5">
              <Label htmlFor="resv-widget-enabled">{t('resv.wid.enabled')}</Label>
              <Switch id="resv-widget-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
            </div>

            {/* politika */}
            <div className="grid gap-3 sm:grid-cols-3">
              {POLICY_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`rw-${f.key}`}>{t(f.labelKey)}</Label>
                  <Input
                    id={`rw-${f.key}`}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    value={String(policy[f.key])}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      if (Number.isFinite(n)) setPolicy((p) => (p ? { ...p, [f.key]: n } : p))
                    }}
                    className="h-9"
                  />
                </div>
              ))}
            </div>

            <Button disabled={busy} onClick={() => save()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('resv.wid.save')}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
