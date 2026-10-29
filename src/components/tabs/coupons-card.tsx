'use client'

/**
 * P2-10b (v1.187.0) — KUPONI KARTICA (CRM zavihek).
 *
 * Seznam zadnjih kuponov (kod, gost, vrednost, status, veljavnost, obvestilo) +
 * ročna izdaja (settings.manage) + preklic izdanih. Rojstnodnevni kuponi
 * izdaja dnevni cron (P2-10b) — tu so VIDNI in sledljivi, ne ročno ponovljivi.
 * Podatke naloži sama (api()); page.tsx dostavi canManage + centralLocationId.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Ticket, Plus, Search } from 'lucide-react'

interface CouponRowT {
  id: string; code: string; guestId: string; reason: string; year: number | null
  percent: number | null; fixedAmount: string | number; status: string
  issuedAt: string; expiresAt: string; redeemedAt?: string | null
  note: string; notifyStatus: string
  Guest?: { firstName: string; lastName: string; email: string } | null
}
interface GuestRowT { id: string; name: string; email: string | null; phone: string | null }

const STATUS_CLS: Record<string, string> = {
  issued: 'bg-emerald-100 text-emerald-800',
  redeemed: 'bg-sky-100 text-sky-800',
  void: 'bg-stone-200 text-stone-600',
}

/** Izpeljani prikaz statusa: issued + pretekel → 'expired' (kot ob odkupu). */
function displayStatus(row: CouponRowT, now: number): string {
  if (row.status === 'issued' && new Date(row.expiresAt).getTime() < now) return 'expired'
  return row.status
}

export function CouponsCard({ canManage, centralLocationId = '' }: { canManage: boolean; centralLocationId?: string }) {
  const { t, locale } = useI18n()
  const [rows, setRows] = useState<CouponRowT[]>([])
  const [busy, setBusy] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [iBusy, setIBusy] = useState(false)
  const [voidingId, setVoidingId] = useState('')

  // obrazec za ročno izdajo
  const [guests, setGuests] = useState<GuestRowT[]>([])
  const [guestQuery, setGuestQuery] = useState('')
  const [guestSel, setGuestSel] = useState<GuestRowT | null>(null)
  const [valueMode, setValueMode] = useState<'percent' | 'fixed'>('percent')
  const [percent, setPercent] = useState('15')
  const [fixed, setFixed] = useState('10.00')
  const [daysValid, setDaysValid] = useState('30')
  const [note, setNote] = useState('')

  const locParam = centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}` : ''

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const d = await api<{ coupons: CouponRowT[] }>(`/api/coupons${locParam ? `${locParam}&take=50` : '?take=50'}`)
      setRows(d.coupons ?? [])
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }, [locParam])

  useEffect(() => { void load() }, [load])

  const filteredGuests = useMemo(() => {
    const q = guestQuery.trim().toLowerCase()
    if (q.length < 2) return []
    return guests
      .filter((g) => g.name.toLowerCase().includes(q) || (g.email ?? '').toLowerCase().includes(q) || (g.phone ?? '').includes(q))
      .slice(0, 8)
  }, [guestQuery, guests])

  async function openIssue() {
    setIssuing(true)
    setGuestQuery(''); setGuestSel(null); setValueMode('percent'); setPercent('15'); setFixed('10.00'); setDaysValid('30'); setNote('')
    try {
      const d = await api<{ guests: GuestRowT[] }>(`/api/crm/guests${locParam}`)
      setGuests(d.guests ?? [])
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    }
  }

  async function submitIssue() {
    if (!guestSel) return
    setIBusy(true)
    try {
      const body: Record<string, unknown> = {
        guestId: guestSel.id,
        daysValid: Number(daysValid) || 30,
        ...(note.trim() ? { note: note.trim() } : {}),
      }
      if (valueMode === 'percent') body.percent = Number(percent)
      else body.fixedAmount = Number(fixed.replace(',', '.'))
      await api('/api/coupons', { method: 'POST', body: JSON.stringify(body) })
      toast({ title: t('cp.issued') })
      setIssuing(false)
      await load()
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setIBusy(false) }
  }

  async function voidCoupon(id: string) {
    setVoidingId(id)
    try {
      await api(`/api/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({}) })
      toast({ title: t('cp.voided') })
      await load()
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setVoidingId('') }
  }

  const nowMs = Date.now()

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
          <Ticket className="w-4 h-4" aria-hidden="true" /> {t('cp.title')}
          <span className="ml-auto flex items-center gap-1.5">
            {busy && <Loader2 className="w-4 h-4 animate-spin text-stone-400" aria-hidden="true" />}
            {canManage && (
              <Button size="sm" className="h-8 bg-emerald-700 hover:bg-emerald-800" onClick={() => void openIssue()}>
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('cp.issue')}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs text-stone-500">{t('cp.desc')}</p>
        {rows.length === 0 && !busy && <p className="text-sm text-stone-500">{t('cp.empty')}</p>}
        <ScrollArea className={rows.length > 0 ? 'max-h-72' : ''}>
          <div className="grid gap-1.5">
            {rows.map((c) => {
              const st = displayStatus(c, nowMs)
              const value = c.percent != null ? `${c.percent} %` : `${Number(c.fixedAmount).toFixed(2)} €`
              return (
                <div key={c.id} className="rounded-md border border-stone-200 bg-white p-2.5 text-xs flex items-center justify-between gap-2 flex-wrap">
                  <span className="flex items-center gap-2 min-w-0">
                    <code className="font-mono font-semibold text-stone-800">{c.code}</code>
                    <span className="font-medium truncate max-w-40">
                      {c.Guest ? `${c.Guest.firstName} ${c.Guest.lastName}`.trim() : c.guestId}
                    </span>
                    <span className="text-stone-500">{value}</span>
                    <Badge variant="secondary" className="text-[10px]">{t(c.reason === 'birthday' ? 'cp.reason.birthday' : 'cp.reason.manual')}</Badge>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-stone-500">{t('cp.expires')}: {new Date(c.expiresAt).toLocaleDateString(locale === 'hr' ? 'hr-HR' : 'sl-SI')}</span>
                    <Badge className={STATUS_CLS[st] ?? 'bg-stone-200 text-stone-600'}>
                      {t(`cp.status.${st}`) === `cp.status.${st}` ? st : t(`cp.status.${st}`)}
                    </Badge>
                    {c.reason === 'birthday' && c.notifyStatus && c.status === 'issued' && (
                      <span
                        className="text-[10px] text-stone-500"
                        title={t(`cp.notify.${c.notifyStatus}`) === `cp.notify.${c.notifyStatus}` ? c.notifyStatus : t(`cp.notify.${c.notifyStatus}`)}
                      >
                        {c.notifyStatus === 'sent' ? '✉' : ''}
                      </span>
                    )}
                    {canManage && c.status === 'issued' && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={voidingId === c.id}
                        onClick={() => void voidCoupon(c.id)}>
                        {t('cp.void')}
                      </Button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>

      {/* ročna izdaja */}
      <Dialog open={issuing} onOpenChange={(o) => (!o ? setIssuing(false) : undefined)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('cp.issueTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {guestSel ? (
              <div className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm">
                <span className="font-medium">{guestSel.name}</span>
                <Button size="sm" variant="outline" className="h-7" onClick={() => setGuestSel(null)}>{t('payment.remove')}</Button>
              </div>
            ) : (
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" aria-hidden="true" />
                <Input
                  className="h-9 pl-8"
                  placeholder={t('cp.guestSearch')}
                  aria-label={t('cp.guestSearchAria')}
                  value={guestQuery}
                  onChange={(e) => setGuestQuery(e.target.value)}
                />
                {filteredGuests.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full rounded-lg border border-stone-200 bg-white shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                    {filteredGuests.map((g) => (
                      <button key={g.id} type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50 active:bg-stone-100"
                        onClick={() => { setGuestSel(g); setGuestQuery('') }}>
                        <span className="font-medium">{g.name}</span>
                        {g.phone && <span className="text-stone-500"> · {g.phone}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant={valueMode === 'percent' ? 'default' : 'outline'}
                className={`h-8 flex-1 ${valueMode === 'percent' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`}
                aria-pressed={valueMode === 'percent'} onClick={() => setValueMode('percent')}>
                {t('cp.percent')}
              </Button>
              <Button size="sm" variant={valueMode === 'fixed' ? 'default' : 'outline'}
                className={`h-8 flex-1 ${valueMode === 'fixed' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`}
                aria-pressed={valueMode === 'fixed'} onClick={() => setValueMode('fixed')}>
                {t('cp.fixed')}
              </Button>
            </div>
            {valueMode === 'percent' ? (
              <div className="space-y-1">
                <Label htmlFor="cp-percent" className="text-xs">{t('cp.percent')}</Label>
                <Input id="cp-percent" type="number" min={1} max={100} step={1} inputMode="numeric"
                  className="h-9" value={percent} onChange={(e) => setPercent(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="cp-fixed" className="text-xs">{t('cp.fixed')}</Label>
                <Input id="cp-fixed" type="number" min={0.5} step="0.5" inputMode="decimal"
                  className="h-9" value={fixed} onChange={(e) => setFixed(e.target.value)} />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="cp-days" className="text-xs">{t('cp.daysValid')}</Label>
              <Input id="cp-days" type="number" min={1} max={365} step={1} inputMode="numeric"
                className="h-9" value={daysValid} onChange={(e) => setDaysValid(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-note" className="text-xs">{t('cp.note')}</Label>
              <Input id="cp-note" className="h-9" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssuing(false)}>{t('cp.void')}</Button>
            <Button className="bg-emerald-700 hover:bg-emerald-800" disabled={!guestSel || iBusy}
              onClick={() => void submitIssue()}>
              {iBusy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} {t('cp.issue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
