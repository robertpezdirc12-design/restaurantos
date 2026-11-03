'use client'

/**
 * v1.244.0 (PRIMERJAVA-VMESNIKOV-2026 §18 A) — Nastavitvena kartica RITMA
 * PRIHODOV (zavihek Nastavitve, poleg widgeta).
 *
 * Vsebina: vklop varovala, širina okna prihodov (10–120 min, privzeto 30),
 * največ gostov na okno. Vir: /api/reservations/pacing (GET reservations.manage,
 * PUT reservations.manage + settings.manage — kartica se izriše SAMO uporabnikom
 * z settings.manage, ista disciplina kot ReservationWidgetCard).
 *
 * Industrijska referenca: Lightspeed »Arrival Pacing« (april 2026) — »Max
 * guests arriving within 30 minutes«; Toast table management pacing.
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
import { Loader2, Gauge, Save } from 'lucide-react'

interface PacingConfigT {
  enabled: boolean
  windowMin: number
  maxGuests: number
}

const WINDOW_OPTIONS = [15, 30, 45, 60, 90, 120]

export function ReservationPacingCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  const canConfigure = Boolean(user && (user.permissions ?? []).includes('settings.manage') || user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER')
  const [config, setConfig] = useState<PacingConfigT | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      const qs = user?.locationId ? `?locationId=${encodeURIComponent(user.locationId)}` : ''
      const d = await api<{ config: PacingConfigT }>(`/api/reservations/pacing${qs}`)
      setConfig(d.config)
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 160))
    } finally {
      setLoading(false)
    }
  }, [user?.locationId])

  useEffect(() => { if (canConfigure) void (async () => { await load() })() }, [canConfigure, load])

  if (!canConfigure) return null

  async function save() {
    if (!config) return
    setBusy(true)
    setErr('')
    try {
      const d = await api<{ config: PacingConfigT }>('/api/reservations/pacing', {
        method: 'PUT',
        body: JSON.stringify({
          locationId: user?.locationId ?? undefined,
          enabled: config.enabled,
          windowMin: config.windowMin,
          maxGuests: config.maxGuests,
        }),
      })
      setConfig(d.config)
      toast({ title: t('resv.pacingSaved') })
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 160))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-region="resv-pacing-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Gauge className="w-4 h-4" aria-hidden /> {t('resv.pacingTitle')}</CardTitle>
        {config && (
          <Badge variant={config.enabled ? 'default' : 'secondary'} className={config.enabled ? 'bg-emerald-700' : ''}>
            {config.enabled ? t('resv.pacingOn') : t('resv.pacingOff')}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" aria-hidden /> …</div>
        ) : err ? (
          <p className="text-sm text-red-700 break-words" role="alert">{err}</p>
        ) : config ? (
          <>
            <p className="text-sm text-stone-600">{t('resv.pacingHint')}</p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="pacing-enabled" className="text-sm font-medium">{t('resv.pacingTitle')}</Label>
              <Switch
                id="pacing-enabled"
                checked={config.enabled}
                onCheckedChange={(v) => setConfig({ ...config, enabled: v })}
                aria-label={t('resv.pacingTitle')}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pacing-window" className="text-sm">{t('resv.pacingWindow')}</Label>
                <select
                  id="pacing-window"
                  className="flex h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400"
                  value={config.windowMin}
                  onChange={(e) => setConfig({ ...config, windowMin: Number(e.target.value) })}
                  disabled={!config.enabled}
                >
                  {WINDOW_OPTIONS.map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pacing-max" className="text-sm">{t('resv.pacingMax')}</Label>
                <Input
                  id="pacing-max"
                  type="number"
                  min={1}
                  max={500}
                  inputMode="numeric"
                  value={config.maxGuests || ''}
                  placeholder="npr. 40"
                  onChange={(e) => setConfig({ ...config, maxGuests: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })}
                  disabled={!config.enabled}
                />
              </div>
            </div>
            <Button size="sm" className="bg-emerald-700 hover:bg-emerald-800 gap-1" onClick={() => void save()} disabled={busy || (config.enabled && config.maxGuests <= 0)}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Save className="w-4 h-4" aria-hidden />} {t('resv.pacingSave')}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
