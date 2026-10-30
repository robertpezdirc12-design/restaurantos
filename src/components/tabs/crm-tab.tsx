'use client'

/**
 * Issue #11 (v1.126.0) — CRM TAB: segmenti, gostje s soglasjem, podvojeni
 * profili, kampanje (življenjski cikel + meritve).
 *
 * Podatke si naloži SAM (api() klici ob odprtju/ponovnem nalaganju) — page.tsx
 * dostavi samo canManage (settings.manage) + centralLocationId (pogled
 * centralne vloge). Vse izpise gostov so MASKIRANI (strežnik); soglasje se
 * podeli/prekliče IZKLJUČNO z dokazom izrecnega dejanja (GDPR člen 7).
 * Alergeni/prehranjevalne preference se za segmentacijo NE prikazujejo niti
 * uporabljajo (varna postrežba).
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client'
import { useI18n } from '@/components/i18n'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Users, Megaphone, Copy, Merge, ShieldCheck, Download, Plus, RefreshCw, Send } from 'lucide-react'
import { CouponsCard } from '@/components/tabs/coupons-card'

/* ── tipi (strežniški odgovori) ── */
interface SegmentT {
  type: string; total: number; emailEligible: number; smsEligible: number; whatsappEligible?: number
  missingContact: number; criterionKey: string; criterionParams: Record<string, number>; periodDays: number
}
interface GuestT {
  id: string; name: string; email: string | null; phone: string | null; isVip: boolean
  loyaltyMember: boolean; totalVisits: number; totalSpent: number
  lastVisitAt?: string | null; consentEmail: string | null; consentSms: string | null
  consentWhatsapp?: string | null
}
interface DupPairT {
  canonical: { id: string; name: string; email: string; phone: string; totalVisits: number }
  duplicate: { id: string; name: string; email: string; phone: string; totalVisits: number }
  matchedOn: 'email' | 'phone'
}
interface CampaignT {
  id: string; name: string; channel: string; segmentType: string; segmentPeriodDays: number
  subject: string; status: string; scheduledAt?: string | null; sentAt?: string | null
  completedAt?: string | null; eligibleCount: number; sentCount: number; failedCount: number
  unsubscribedCount: number; testRecipient: string; lastError: string; createdAt: string
}
interface SendT {
  id: string; guestName: string; status: string; attempts: number; recipientMasked: string | null
  sentAt?: string | null; errorMessage: string; createdAt: string
}
interface PerfT { sentToProvider: number; failed: number; skipped: number; unsubscribed: number; queued: number; repeatOrders: number; windowDays: number }

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-stone-200 text-stone-700',
  approved: 'bg-amber-100 text-amber-800',
  scheduled: 'bg-sky-100 text-sky-800',
  sending: 'bg-amber-100 text-amber-800',
  sent: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-stone-200 text-stone-600',
}

function statusLabel(t: (k: string) => string, s: string): string {
  const map: Record<string, string> = {
    draft: t('crm.st.draft'), approved: t('crm.st.approved'), scheduled: t('crm.st.scheduled'),
    sending: t('crm.st.sending'), sent: t('crm.st.sent'), failed: t('crm.st.failed'),
    cancelled: t('crm.st.cancelled'),
  }
  return map[s] ?? s
}

/** OSS-7 (v1.205.0) — oznaka kanala (znamke se ne prevajajo); fail-closed privzetek
 * 'E-mail' (kanal iz baze je String — neznan = email obnašanje, kot campaignChannel). */
function channelLabel(channel: string): string {
  if (channel === 'sms') return 'SMS'
  if (channel === 'whatsapp') return 'WhatsApp'
  return 'E-mail'
}

export function CrmTab({ canManage, centralLocationId = '' }: { canManage: boolean; centralLocationId?: string }) {
  const { t } = useI18n()
  const [periodDays, setPeriodDays] = useState(90)
  const [segments, setSegments] = useState<SegmentT[]>([])
  const [guests, setGuests] = useState<GuestT[]>([])
  const [pairs, setPairs] = useState<DupPairT[]>([])
  const [campaigns, setCampaigns] = useState<CampaignT[]>([])
  const [busy, setBusy] = useState(false)

  const [consentFor, setConsentFor] = useState<GuestT | null>(null)
  const [consentForm, setConsentForm] = useState({ channel: 'email', action: 'grant', proof: '' })
  const [cBusy, setCBusy] = useState(false)
  const [newCampaign, setNewCampaign] = useState<{ name: string; channel: string; segmentType: string; segmentPeriodDays: number; subject: string; bodySl: string; bodyHr: string; testRecipient: string } | null>(null)
  const [nBusy, setNBusy] = useState(false)
  const [detail, setDetail] = useState<{ campaign: CampaignT; sends: SendT[]; performance: PerfT } | null>(null)
  const [dBusy, setDBusy] = useState(false)

  const locParam = centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}${periodDays ? `&periodDays=${periodDays}` : ''}` : `?periodDays=${periodDays}`

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [seg, gst, cmp] = await Promise.all([
        api<{ segments: SegmentT[] }>(`/api/crm/segments${locParam}`),
        api<{ guests: GuestT[] }>(`/api/crm/guests${centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}` : ''}`),
        api<{ campaigns: CampaignT[] }>(`/api/crm/campaigns${centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}` : ''}`),
      ])
      setSegments(seg.segments ?? [])
      setGuests(gst.guests ?? [])
      setCampaigns(cmp.campaigns ?? [])
      if (canManage) {
        const dup = await api<{ pairs: DupPairT[] }>(`/api/crm/duplicates${centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}` : ''}`).catch(() => ({ pairs: [] as DupPairT[] }))
        setPairs(dup.pairs ?? [])
      }
    } catch (err) {
      toast({ title: (err as Error).message, variant: 'destructive' })
    } finally { setBusy(false) }
  }, [canManage, centralLocationId, locParam])

  useEffect(() => { void (async () => { await load() })() }, [load])
  // osveži segmente ob spremembi obdobja
  useEffect(() => {
    void api<{ segments: SegmentT[] }>(`/api/crm/segments${locParam}`)
      .then((r) => setSegments(r.segments ?? []))
      .catch(() => null)
  }, [periodDays, locParam])

  async function saveConsent() {
    if (!consentFor) return
    setCBusy(true)
    try {
      await api('/api/crm/consent', {
        method: 'POST',
        body: JSON.stringify({
          guestId: consentFor.id, channel: consentForm.channel, action: consentForm.action,
          proof: consentForm.action === 'grant' ? consentForm.proof : undefined,
        }),
      })
      toast({ title: t('crm.toast.consentSaved') })
      setConsentFor(null); setConsentForm({ channel: 'email', action: 'grant', proof: '' })
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setCBusy(false) }
  }

  async function createCampaign() {
    if (!newCampaign) return
    setNBusy(true)
    try {
      await api('/api/crm/campaigns', {
        method: 'POST',
        body: JSON.stringify({ ...newCampaign, locationId: centralLocationId || undefined }),
      })
      toast({ title: t('crm.toast.campaignCreated') })
      setNewCampaign(null)
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setNBusy(false) }
  }

  async function openDetail(id: string) {
    setDBusy(true)
    try {
      const d = await api<{ campaign: CampaignT; sends: SendT[]; performance: PerfT }>(`/api/crm/campaigns/${id}`)
      setDetail(d)
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setDBusy(false) }
  }

  async function campaignAction(id: string, action: string, extra: Record<string, unknown> = {}) {
    setDBusy(true)
    try {
      const res = await api<{ dispatch?: Record<string, number>; audience?: Record<string, number>; campaign?: CampaignT; testSent?: boolean }>(`/api/crm/campaigns/${id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action, ...extra }),
      })
      if (action === 'preview' && res.audience) {
        toast({ title: t('crm.toast.preview'), description: t('crm.toast.previewDetail', {
          n: String(res.audience.eligible ?? 0), s: String(res.audience.suppressed ?? 0), m: String(res.audience.missingContact ?? 0),
        }) })
      } else if (action === 'dispatch' && res.dispatch) {
        toast({ title: t('crm.toast.dispatched'), description: t('crm.toast.dispatchDetail', {
          n: String(res.dispatch.sent ?? 0), f: String(res.dispatch.failed ?? 0), k: String(res.dispatch.skipped ?? 0),
        }) })
      } else if (action === 'send-test') {
        toast({ title: t('crm.toast.testSent') })
      } else {
        toast({ title: t('crm.toast.actionDone') })
      }
      await openDetail(id)
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) } finally { setDBusy(false) }
  }

  async function resolveDup(action: 'merge' | 'dismiss', canonicalId: string, duplicateId: string) {
    try {
      await api('/api/crm/duplicates', { method: 'POST', body: JSON.stringify({ action, canonicalId, duplicateId }) })
      toast({ title: action === 'merge' ? t('crm.toast.merged') : t('crm.toast.dismissed') })
      await load()
    } catch (err) { toast({ title: (err as Error).message, variant: 'destructive' }) }
  }

  const totalGuests = guests.length
  const consented = guests.filter((g) => g.consentEmail === 'granted' || g.consentSms === 'granted').length
  const suppressed = guests.filter((g) => g.consentEmail === 'revoked' || g.consentSms === 'revoked').length

  return (
    <div className="space-y-4">
      {/* ── 1) segmenti: razložljivi kriteriji + obdobje ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5 flex-wrap">
            <Users className="w-4 h-4" aria-hidden="true" /> {t('crm.segments.title')}
            <span className="ml-auto flex items-center gap-1">
              {[30, 90, 365].map((d) => (
                <Button key={d} size="sm" variant={periodDays === d ? 'default' : 'outline'}
                  className={`h-8 px-2 text-xs ${periodDays === d ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`}
                  aria-pressed={periodDays === d} onClick={() => setPeriodDays(d)}>
                  {d} {t('crm.segments.days')}
                </Button>
              ))}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {segments.map((s) => (
              <div key={s.type} className="rounded-lg border border-stone-200 bg-white p-3">
                <p className="text-xs font-medium text-stone-500">{t(s.criterionKey, { n: String(s.criterionParams.n ?? 0), days: String(s.criterionParams.days ?? periodDays) })}</p>
                <p className="text-2xl font-bold">{s.total}</p>
                <p className="text-xs text-emerald-700">{t('crm.segments.eligible', { n: s.emailEligible })}</p>
                <p className="sr-only">{t('crm.segments.period', { days: periodDays })}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-stone-500">{t('crm.segments.note')}</p>
        </CardContent>
      </Card>

      {/* ── 2) gostje: soglasje po kanalu (maskirani kontakti) ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" aria-hidden="true" /> {t('crm.guests.title')}
            <Badge variant="secondary" className="ml-1">{t('crm.guests.total', { n: totalGuests })}</Badge>
            <Badge className="bg-emerald-100 text-emerald-800">{t('crm.guests.consented', { n: consented })}</Badge>
            <Badge className="bg-red-100 text-red-800">{t('crm.guests.suppressed', { n: suppressed })}</Badge>
            {canManage && (
              <a
                href={`/api/crm/guests/export${centralLocationId ? `?locationId=${encodeURIComponent(centralLocationId)}` : ''}`}
                className="ml-auto inline-flex items-center gap-1 text-xs underline text-stone-600 hover:text-stone-900"
                download
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('crm.guests.export')}
              </a>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {guests.length === 0 && <p className="text-sm text-stone-500">{t('crm.guests.none')}</p>}
          <ScrollArea className="max-h-96">
            <div className="grid gap-2">
              {guests.map((g) => (
                <div key={g.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-medium truncate flex items-center gap-1.5">
                      {g.name}
                      {g.isVip && <Badge className="bg-amber-500 text-white">VIP</Badge>}
                      {g.loyaltyMember && <Badge variant="secondary">{t('crm.guests.loyalty')}</Badge>}
                    </p>
                    <p className="text-xs text-stone-500 break-words">
                      {g.email || '—'} · {g.phone || '—'} · {t('crm.guests.visits', { n: g.totalVisits })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    <Badge className={g.consentEmail === 'granted' ? 'bg-emerald-100 text-emerald-800' : g.consentEmail === 'revoked' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600'}>
                      {t('crm.guests.email')}: {g.consentEmail === 'granted' ? t('crm.consent.granted') : g.consentEmail === 'revoked' ? t('crm.consent.revoked') : t('crm.consent.none')}
                    </Badge>
                    <Badge className={g.consentSms === 'granted' ? 'bg-emerald-100 text-emerald-800' : g.consentSms === 'revoked' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600'}>
                      {t('crm.guests.sms')}: {g.consentSms === 'granted' ? t('crm.consent.granted') : g.consentSms === 'revoked' ? t('crm.consent.revoked') : t('crm.consent.none')}
                    </Badge>
                    <Badge className={g.consentWhatsapp === 'granted' ? 'bg-emerald-100 text-emerald-800' : g.consentWhatsapp === 'revoked' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600'}>
                      {t('crm.guests.whatsapp')}: {g.consentWhatsapp === 'granted' ? t('crm.consent.granted') : g.consentWhatsapp === 'revoked' ? t('crm.consent.revoked') : t('crm.consent.none')}
                    </Badge>
                    {canManage && (
                      <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => { setConsentFor(g); setConsentForm({ channel: 'email', action: 'grant', proof: '' }) }}>
                        {t('crm.guests.consentBtn')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <p className="mt-2 text-xs text-stone-500">{t('crm.guests.piiNote')}</p>
        </CardContent>
      </Card>

      {/* ── 2b) P2-10b (v1.187.0): kuponi — rojstnodnevni (cron) + ročni ── */}
      <CouponsCard canManage={canManage} centralLocationId={centralLocationId} />

      {/* ── 3) podvojeni profili (ročni pregled) ── */}
      {canManage && pairs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-1.5">
              <Copy className="w-4 h-4" aria-hidden="true" /> {t('crm.dup.title')}
              <Badge className="bg-amber-100 text-amber-800">{t('crm.dup.count', { n: pairs.length })}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {pairs.map((p, i) => (
                <div key={`${p.canonical.id}-${p.duplicate.id}-${i}`} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0 text-sm">
                    <p className="break-words">
                      <span className="font-medium">{p.canonical.name}</span> ({p.canonical.totalVisits} {t('crm.dup.visits')})
                      <span className="mx-1 text-stone-400">←</span>
                      <span className="font-medium">{p.duplicate.name}</span> ({p.duplicate.totalVisits} {t('crm.dup.visits')})
                    </p>
                    <p className="text-xs text-stone-500">{t('crm.dup.matchedOn')}: {p.matchedOn === 'email' ? t('crm.dup.email') : t('crm.dup.phone')}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" className="h-8 bg-emerald-700 hover:bg-emerald-800 text-xs" onClick={() => resolveDup('merge', p.canonical.id, p.duplicate.id)}>
                      <Merge className="w-3.5 h-3.5" aria-hidden="true" /> {t('crm.dup.merge')}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => resolveDup('dismiss', p.canonical.id, p.duplicate.id)}>
                      {t('crm.dup.dismiss')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-stone-500">{t('crm.dup.note')}</p>
          </CardContent>
        </Card>
      )}

      {/* ── 4) kampanje ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-1.5">
            <Megaphone className="w-4 h-4" aria-hidden="true" /> {t('crm.campaigns.title')}
            {canManage && (
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" className="h-8" onClick={() => void load()} disabled={busy}>
                  <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('crm.reload')}
                </Button>
                <Button size="sm" className="h-8 bg-emerald-700 hover:bg-emerald-800" onClick={() => setNewCampaign({ name: '', channel: 'email', segmentType: 'all', segmentPeriodDays: 90, subject: '', bodySl: '', bodyHr: '', testRecipient: '' })}>
                  <Plus className="w-4 h-4" aria-hidden="true" /> {t('crm.campaigns.new')}
                </Button>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 && <p className="text-sm text-stone-500">{t('crm.campaigns.none')}</p>}
          <div className="grid gap-2">
            {campaigns.map((c) => (
              <div key={c.id} className="rounded-lg border border-stone-200 bg-white p-3 flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <p className="font-medium truncate flex items-center gap-1.5 flex-wrap">
                    {c.name}
                    <Badge className={STATUS_BADGE[c.status] ?? 'bg-stone-100'}>{statusLabel(t, c.status)}</Badge>
                    <Badge variant="secondary">{channelLabel(c.channel)}</Badge>
                    <Badge variant="outline">{t(`crm.seg.${c.segmentType}`) === `crm.seg.${c.segmentType}` ? c.segmentType : t(`crm.seg.${c.segmentType}`)}</Badge>
                  </p>
                  <p className="text-xs text-stone-500 break-words">
                    {t('crm.campaigns.stats', { e: c.eligibleCount, n: c.sentCount, f: c.failedCount, u: c.unsubscribedCount })}
                    {c.lastError ? ` · ${c.lastError}` : ''}
                  </p>
                </div>
                {canManage && (
                  <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => void openDetail(c.id)} disabled={dBusy}>
                    {t('crm.campaigns.detail')}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-stone-500">{t('crm.campaigns.note')}</p>
        </CardContent>
      </Card>

      {/* ── dialog: soglasje ── */}
      <Dialog open={Boolean(consentFor)} onOpenChange={(v) => !v && setConsentFor(null)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('crm.consent.dialogTitle', { name: consentFor?.name ?? '' })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="cons-channel">{t('crm.consent.channel')}</Label>
              <Select value={consentForm.channel} onValueChange={(v) => setConsentForm({ ...consentForm, channel: v })}>
                <SelectTrigger id="cons-channel" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">E-mail</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cons-action">{t('crm.consent.action')}</Label>
              <Select value={consentForm.action} onValueChange={(v) => setConsentForm({ ...consentForm, action: v, proof: v === 'grant' ? '' : consentForm.proof })}>
                <SelectTrigger id="cons-action" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="grant">{t('crm.consent.grant')}</SelectItem>
                  <SelectItem value="revoke">{t('crm.consent.revoke')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {consentForm.action === 'grant' && (
              <div>
                <Label htmlFor="cons-proof">{t('crm.consent.proof')}</Label>
                <Textarea id="cons-proof" className="mt-1" rows={3} value={consentForm.proof}
                  onChange={(e) => setConsentForm({ ...consentForm, proof: e.target.value })}
                  placeholder={t('crm.consent.proofPlaceholder')} />
                <p className="mt-1 text-xs text-stone-500">{t('crm.consent.proofNote')}</p>
              </div>
            )}
            <p className="text-xs text-stone-500">{t('crm.consent.gdprNote')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentFor(null)}>{t('crm.cancel')}</Button>
            <Button onClick={() => void saveConsent()} disabled={cBusy || (consentForm.action === 'grant' && consentForm.proof.trim().length < 3)} className="bg-emerald-700 hover:bg-emerald-800">
              {cBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} {t('crm.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── dialog: nova kampanja ── */}
      <Dialog open={Boolean(newCampaign)} onOpenChange={(v) => !v && setNewCampaign(null)}>
        <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('crm.new.title')}</DialogTitle></DialogHeader>
          {newCampaign && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="nc-name">{t('crm.new.name')}</Label>
                  <Input id="nc-name" className="mt-1" value={newCampaign.name} onChange={(e) => setNewCampaign({ ...newCampaign, name: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="nc-channel">{t('crm.new.channel')}</Label>
                  <Select value={newCampaign.channel} onValueChange={(v) => setNewCampaign({ ...newCampaign, channel: v })}>
                    <SelectTrigger id="nc-channel" className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">E-mail</SelectItem>
                      <SelectItem value="sms">SMS</SelectItem>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="nc-seg">{t('crm.new.segment')}</Label>
                  <Select value={newCampaign.segmentType} onValueChange={(v) => setNewCampaign({ ...newCampaign, segmentType: v })}>
                    <SelectTrigger id="nc-seg" className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['all', 'vip', 'loyalty', 'frequent', 'new', 'inactive'].map((s) => (
                        <SelectItem key={s} value={s}>{t(`crm.seg.${s}`) === `crm.seg.${s}` ? s : t(`crm.seg.${s}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="nc-period">{t('crm.new.period')}</Label>
                  <Input id="nc-period" type="number" min={7} max={730} className="mt-1" value={newCampaign.segmentPeriodDays}
                    onChange={(e) => setNewCampaign({ ...newCampaign, segmentPeriodDays: Number(e.target.value) || 90 })} />
                </div>
              </div>
              <div>
                <Label htmlFor="nc-subject">{t('crm.new.subject')}</Label>
                <Input id="nc-subject" className="mt-1" value={newCampaign.subject} onChange={(e) => setNewCampaign({ ...newCampaign, subject: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="nc-bodysl">{t('crm.new.bodySl')}</Label>
                <Textarea id="nc-bodysl" rows={4} className="mt-1" value={newCampaign.bodySl} onChange={(e) => setNewCampaign({ ...newCampaign, bodySl: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="nc-bodyhr">{t('crm.new.bodyHr')}</Label>
                <Textarea id="nc-bodyhr" rows={4} className="mt-1" value={newCampaign.bodyHr} onChange={(e) => setNewCampaign({ ...newCampaign, bodyHr: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="nc-test">{t('crm.new.testRecipient')}</Label>
                <Input id="nc-test" className="mt-1" value={newCampaign.testRecipient} onChange={(e) => setNewCampaign({ ...newCampaign, testRecipient: e.target.value })}
                  placeholder={newCampaign.channel === 'email' ? t('crm.new.testPlaceholder') : t('crm.new.testPlaceholderPhone')} />
                <p className="mt-1 text-xs text-stone-500">{t('crm.new.testNote')}</p>
              </div>
              <p className="text-xs text-stone-500">{t('crm.new.footerNote')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewCampaign(null)}>{t('crm.cancel')}</Button>
            <Button onClick={() => void createCampaign()} disabled={nBusy} className="bg-emerald-700 hover:bg-emerald-800">
              {nBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null} {t('crm.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── dialog: detajl kampanje + življenjski cikel ── */}
      <Dialog open={Boolean(detail)} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
          <DialogHeader><DialogTitle className="break-words">{detail?.campaign.name}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <Badge className={STATUS_BADGE[detail.campaign.status] ?? 'bg-stone-100'}>{statusLabel(t, detail.campaign.status)}</Badge>
                <Badge variant="secondary">{channelLabel(detail.campaign.channel)}</Badge>
                <Badge variant="outline">{t('crm.detail.eligible', { n: detail.performance.sentToProvider + detail.performance.failed + detail.performance.skipped + detail.performance.unsubscribed + detail.performance.queued || detail.campaign.eligibleCount })}</Badge>
                <Badge className="bg-emerald-100 text-emerald-800">{t('crm.detail.sent', { n: detail.performance.sentToProvider })}</Badge>
                <Badge className="bg-red-100 text-red-800">{t('crm.detail.failed', { n: detail.performance.failed })}</Badge>
                <Badge className="bg-stone-200 text-stone-700">{t('crm.detail.skipped', { n: detail.performance.skipped })}</Badge>
                <Badge className="bg-amber-100 text-amber-800">{t('crm.detail.unsub', { n: detail.performance.unsubscribed })}</Badge>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-3 text-sm">
                <p className="font-medium">{t('crm.detail.performance')}</p>
                <p className="text-sm text-stone-600">{t('crm.detail.repeat', { n: detail.performance.repeatOrders, days: detail.performance.windowDays })}</p>
                <p className="mt-1 text-xs text-stone-500">{t('crm.detail.evidenceNote')}</p>
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  {detail.campaign.status === 'draft' && (
                    <>
                      <Button size="sm" variant="outline" className="h-9" onClick={() => void campaignAction(detail.campaign.id, 'preview')} disabled={dBusy}>
                        {t('crm.act.preview')}
                      </Button>
                      <Button size="sm" className="h-9 bg-amber-600 hover:bg-amber-700" onClick={() => void campaignAction(detail.campaign.id, 'approve')} disabled={dBusy}>
                        {t('crm.act.approve')}
                      </Button>
                    </>
                  )}
                  {(detail.campaign.status === 'approved' || detail.campaign.status === 'draft') && (
                    <Button size="sm" variant="outline" className="h-9" onClick={() => void campaignAction(detail.campaign.id, 'send-test')} disabled={dBusy}>
                      <Send className="w-4 h-4" aria-hidden="true" /> {t('crm.act.sendTest')}
                    </Button>
                  )}
                  {detail.campaign.status === 'approved' && (
                    <>
                      <Button size="sm" variant="outline" className="h-9" onClick={() => {
                        const iso = new Date(Date.now() + 3600_000).toISOString()
                        void campaignAction(detail.campaign.id, 'schedule', { scheduledAt: iso })
                      }} disabled={dBusy}>
                        {t('crm.act.schedule1h')}
                      </Button>
                      <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" onClick={() => void campaignAction(detail.campaign.id, 'dispatch')} disabled={dBusy}>
                        <Send className="w-4 h-4" aria-hidden="true" /> {t('crm.act.sendNow')}
                      </Button>
                    </>
                  )}
                  {detail.campaign.status === 'scheduled' && (
                    <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" onClick={() => void campaignAction(detail.campaign.id, 'dispatch')} disabled={dBusy}>
                      <Send className="w-4 h-4" aria-hidden="true" /> {t('crm.act.dispatchDue')}
                    </Button>
                  )}
                  {detail.campaign.status === 'sending' && (
                    <Button size="sm" className="h-9 bg-emerald-700 hover:bg-emerald-800" onClick={() => void campaignAction(detail.campaign.id, 'dispatch')} disabled={dBusy}>
                      {t('crm.act.retry')}
                    </Button>
                  )}
                  {!['sent', 'cancelled'].includes(detail.campaign.status) && (
                    <Button size="sm" variant="destructive" className="h-9" onClick={() => void campaignAction(detail.campaign.id, 'cancel')} disabled={dBusy}>
                      {t('crm.act.cancel')}
                    </Button>
                  )}
                </div>
              )}
              <div>
                <p className="text-sm font-medium mb-1">{t('crm.detail.sends')}</p>
                <ScrollArea className="max-h-64">
                  <div className="grid gap-1.5">
                    {detail.sends.length === 0 && <p className="text-sm text-stone-500">{t('crm.detail.noSends')}</p>}
                    {detail.sends.map((s) => (
                      <div key={s.id} className="rounded-sm border border-stone-200 bg-white p-2 text-xs flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium">{s.guestName} · {s.recipientMasked || '—'}</span>
                        <span className="flex items-center gap-1.5">
                          <Badge className={
                            s.status === 'sent_to_provider' ? 'bg-emerald-100 text-emerald-800' :
                            s.status === 'failed' ? 'bg-red-100 text-red-800' :
                            s.status === 'unsubscribed' ? 'bg-amber-100 text-amber-800' :
                            s.status === 'skipped' ? 'bg-stone-200 text-stone-600' : 'bg-sky-100 text-sky-800'
                          }>
                            {t(`crm.send.${s.status}`) === `crm.send.${s.status}` ? s.status : t(`crm.send.${s.status}`)}
                          </Badge>
                          {s.errorMessage && <span className="text-stone-500 max-w-48 truncate" title={s.errorMessage}>{s.errorMessage}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}
          {dBusy && <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t('crm.detail.loading')}</div>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
