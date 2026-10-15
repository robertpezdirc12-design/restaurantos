'use client'

/**
 * Issue #21 (P1/P2, v1.111.0) — klic vodje: NASTAVITVE (zavihek Nastavitve).
 *
 * Dovoljene vrste zahtev (katere chip dialog ponudi osebju) + čas eskalacije
 * (minute brez potrditve pred prvim eskalacijskim krogom). Ciljne vloge push
 * prejemnikov se NE nastavljajo tukaj — to dela obstoječa notifikacijska matrika
 * (vrstici MANAGER_CALL / MANAGER_CALL_ESCALATED), gl. callv.set.desc.
 *
 * Vir: /api/manager-call/settings
 *  - GET — vsaka prijavljena vloga (dialog rabi allowedTypes)
 *  - PUT — SAMO settings.manage (kartica se izriše samo imetnikom; backend
 *    zahteva dovoljenje neodvisno — ISTA disciplina kot ReservationWidgetCard)
 */
import { useEffect, useState } from 'react'
import { api, getUser } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { BellRing, Loader2 } from 'lucide-react'
import {
  MANAGER_CALL_TYPES,
  MIN_ACK_TIMEOUT_MINUTES,
  MAX_ACK_TIMEOUT_MINUTES,
  type ManagerCallType,
} from '@/lib/manager-call-registry'

interface SettingsT {
  ackTimeoutMinutes: number
  allowedTypes: ManagerCallType[]
}

export function ManagerCallSettingsCard() {
  const { t } = useI18n()
  const user = typeof window !== 'undefined' ? getUser() : null
  // kartica samo za settings.manage (backend dvokratno zaščiti PUT)
  const canConfigure = Boolean(
    (user?.permissions ?? []).includes('settings.manage') ||
    user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'MANAGER',
  )

  const [timeout, setTimeoutVal] = useState<number>(5)
  const [types, setTypes] = useState<ManagerCallType[]>([...MANAGER_CALL_TYPES])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!canConfigure) return
    let alive = true
    void (async () => {
      try {
        const d = await api<{ settings: SettingsT }>('/api/manager-call/settings')
        if (!alive) return
        setTimeoutVal(d.settings.ackTimeoutMinutes)
        setTypes(d.settings.allowedTypes)
      } catch (e) {
        if (alive) setErr(String((e as Error).message || e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [canConfigure])

  if (!canConfigure) return null

  function toggleType(ty: ManagerCallType, checked: boolean) {
    setTypes((prev) => {
      const next = checked ? [...prev, ty] : prev.filter((x) => x !== ty)
      // vrstni red po registru (stabilen prikaz)
      return MANAGER_CALL_TYPES.filter((x) => next.includes(x))
    })
  }

  async function save() {
    if (saving) return
    const t0 = Math.round(timeout)
    if (!Number.isFinite(t0) || t0 < MIN_ACK_TIMEOUT_MINUTES || t0 > MAX_ACK_TIMEOUT_MINUTES) {
      setErr(`${t('callv.set.timeout')}: ${MIN_ACK_TIMEOUT_MINUTES}–${MAX_ACK_TIMEOUT_MINUTES}`)
      return
    }
    if (types.length === 0) {
      setErr(`${t('callv.set.types')}: ${t('common.no')}`)
      return
    }
    setSaving(true)
    setErr('')
    try {
      const d = await api<{ settings: SettingsT }>('/api/manager-call/settings', {
        method: 'PUT',
        body: JSON.stringify({ ackTimeoutMinutes: t0, allowedTypes: types }),
      })
      setTimeoutVal(d.settings.ackTimeoutMinutes)
      setTypes(d.settings.allowedTypes)
      toast({ description: t('callv.set.saved') })
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          <BellRing className="w-4 h-4" /> {t('callv.set.title')}
        </CardTitle>
        <p className="text-xs text-stone-500">{t('callv.set.desc')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <Skeleton className="h-24 w-full" />}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {!loading && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mc-set-timeout">{t('callv.set.timeout')}</Label>
                <Input
                  id="mc-set-timeout"
                  type="number"
                  inputMode="numeric"
                  min={MIN_ACK_TIMEOUT_MINUTES}
                  max={MAX_ACK_TIMEOUT_MINUTES}
                  step={1}
                  value={String(timeout)}
                  disabled={saving}
                  onChange={(e) => setTimeoutVal(Math.round(Number(e.target.value)))}
                  className="h-9 w-24"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t('callv.set.types')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {MANAGER_CALL_TYPES.map((ty) => (
                  <label
                    key={ty}
                    htmlFor={`mc-set-type-${ty}`}
                    className="flex items-center gap-2.5 min-h-11 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm cursor-pointer hover:border-stone-400 transition"
                  >
                    <Checkbox
                      id={`mc-set-type-${ty}`}
                      checked={types.includes(ty)}
                      disabled={saving}
                      onCheckedChange={(v) => toggleType(ty, v === true)}
                    />
                    <span className="min-w-0 truncate">{t(`callv.type.${ty}`)}</span>
                  </label>
                ))}
              </div>
            </div>

            <Button disabled={saving || types.length === 0} onClick={() => void save()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {saving ? t('callv.set.saving') : t('common.save')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
