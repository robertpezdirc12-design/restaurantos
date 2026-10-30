/**
 * Issue #11 (v1.126.0) — CRM GOSTOV IN KAMPANJE: soglasje, segmentacija,
 * odjava, kampanjski življenjski cikel in merjenje rezultatov.
 *
 * NAČELA (issue #11):
 *  1. SOGLASJE PRED POŠILJANJEM — privzeto stanje gosta je »ni potrjenega
 *     soglasja«; vnos e-pošte/telefona ob rezervaciji/računu NI soglasje.
 *     Sled je append-only (GuestConsent); kanonično stanje = najnovejša
 *     vrstica po (guestId, channel, purpose). Email in SMS sta LOČENA.
 *  2. PREKLIC/ODJAVA JE TAKOJ UČINKOVITA — pošiljanje preveri trenutno
 *     stanje OB VSAKI pošiljki (send-time re-check, ne predizračun).
 *     Preživi retry (idempotenca po @@unique(campaignId, guestId)) in
 *     ponovljene dogodke (uvoz ne more »vzkrisiti« soglasja — uvoz ne
 *     piše v GuestConsent).
 *  3. STATUSI SO DOKAZOVANI — SMTP potrditev sprejema = 'sent_to_provider'
 *     (poslano ponudniku), NE dostava. 'delivered'/'bounced' se ne
 *     zapisujeta, ker SMTP ne daje dokaza o dostavi (gl. docs/CRM-GOSTI-SI-HR.md).
 *  4. TRANSAKCIJSKO ≠ MARKETING — obstoječi opomniki/potrditve rezervacij
 *     (reminders.ts) so transakcijski in NE gredo skozi ta modul; ta modul
 *     pošilja IZKLJUČNO marketing, ki zahteva soglasje.
 *  5. SEGMENTI IZ POSLOVNIH PODATKOV — obiski/poraba/VIP/zvestoba na
 *     kanoničnem profilu Guest; alergeni/prehranjevalne preference se
 *     NIKOLI ne uporabijo za segmentacijo (varna postrežba, GDPR člen 9).
 *  6. POŠILJANJE OMEJENO, IDEMPOTENTNO — BATCH_LIMIT po dispatch klicu;
 *     posodobitve CampaignSend so pogojne (status queued) → ponovni zagon
 *     NE podvoji posiljk niti števcev.
 *
 * PONUDNIK: SMTP iz RestaurantSettings (smtpTransportForLocation — obstoječi
 * okvir), SMS iz Integrations (sendSms). sendFn je vbrizgljiv (testi → simulator,
 * 0 omrežja). Brez konfiguracije se ne pošilja resničnim gostom.
 */

import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { jparse, jstr, nid } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { smtpTransportForLocation, sendSms, smsConfigForLocation } from '@/lib/reminders'

/* ─────────────────────────── konstante ─────────────────────────── */

/** Različica besedila soglasja (issue: "različico besedila") — dvig ob spremembi formulacije. */
export const CRM_CONSENT_TEXT_VERSION = 'crm-consent-v1'

/** OSS-7 (v1.205.0) — tretji kanal WHATSAPP v kampanjnem modelu + opt-out
 * (OrderRestro #14). A-del je MODELSKO RAVEN: vrednost teče skozi obstoječe
 * String polje `channel` (0 DDL), soglasje/odjava/idempotenca delujejo
 * kanalno neodvisno po istih pravilih. TRANSPORT = B/C (Meta Business API
 * je lastnikova odločitev) — whatsappSendFn je zato determinističen
 * fail-soft: kampanja se izvede, vrstice ostanejo IZRECNO neuspešne z
 * razlogom (dokazano stanje — nič se ne laže o pošiljanju). */
export const CRM_CHANNELS = ['email', 'sms', 'whatsapp'] as const
export type CrmChannel = (typeof CRM_CHANNELS)[number]

/** Fail-closed preslikava vrednosti kanala iz baze/UI: 'sms' → 'sms',
 * 'whatsapp' → 'whatsapp', VSE ostalo → 'email' (privzeti kanal). Zamenja
 * prejšnje vgrajene ternarje `channel === 'sms' ? 'sms' : 'email'`, ki so
 * tretjemu kanalu tiho vračali email obnašanje. */
export function campaignChannel(value: string): CrmChannel {
  if (value === 'sms') return 'sms'
  if (value === 'whatsapp') return 'whatsapp'
  return 'email'
}

/** Kanali s TELEFONSKIM kontaktom (validacija ≥ 6 števk, normalizacija
 * normalizePhoneDigits) — email je edini z naslovom. */
export function isPhoneChannel(channel: CrmChannel): boolean {
  return channel === 'sms' || channel === 'whatsapp'
}

export const CRM_SEGMENT_TYPES = ['all', 'vip', 'loyalty', 'frequent', 'new', 'inactive'] as const
export type SegmentType = (typeof CRM_SEGMENT_TYPES)[number]

/** Min. št. obiskov za segment 'frequent' (razložljiv kriterij, izpostavljen v UI). */
export const FREQUENT_MIN_VISITS = 3

/** Okno za merjenje ponovnih nakupov po kampanji (dnevih od pošiljanja). */
export const REPEAT_WINDOW_DAYS = 14

/** Zgornja meja pošiljk na EN dispatch klic (omejeno pošiljanje, issue §3). */
export const CRM_BATCH_LIMIT = 25

/** Zgornja meja kampanj na EN dispatchDueCampaigns klic (cron varnost). */
export const CRM_CAMPAIGNS_PER_RUN = 3

/** Max. poskusov na CampaignSend (nato ostane 'failed', brez ponavljanja v neskončnost). */
export const CRM_MAX_ATTEMPTS = 3

/* ─────────────────────────── čisti pripomočki ─────────────────────────── */

/** Normalizacija e-pošte za primerjavo/dedupe (lowercase + trim). */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Normalizacija telefona za primerjavo/dedupe: števke, vodilna '00'
 * (mednarodna predpona) se odstrani → '+386…' in '00386…' sta ENAKA. */
export function normalizePhoneDigits(value: unknown): string {
  let digits = String(value ?? '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  return digits
}

/** Maskiranje e-pošte v seznamih (PII — enaka politika kot maskPhone). */
export function maskEmail(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim()
  if (!s || !s.includes('@')) return s ? '***' : null
  const [local, domain] = s.split('@')
  const head = local.slice(0, 1)
  return `${head}***@${domain}`
}

/** Enkratni žeton za odjavo (32 heks znakov, neuganjiv — guest.ts vzorec). */
export function newUnsubscribeToken(): string {
  return randomBytes(16).toString('hex')
}

/* ─────────────────────────── soglasje ─────────────────────────── */

export interface ConsentState {
  email: 'granted' | 'revoked' | null
  sms: 'granted' | 'revoked' | null
  whatsapp: 'granted' | 'revoked' | null
}

/** Kanonično stanje = NAJNOVEJŠA vrstica sledi po (guestId, channel, purpose='marketing'). */
export async function currentConsentMap(guestIds: string[]): Promise<Map<string, ConsentState>> {
  const out = new Map<string, ConsentState>()
  if (guestIds.length === 0) return out
  const rows = await db.guestConsent.findMany({
    where: { guestId: { in: guestIds }, purpose: 'marketing' },
    orderBy: [{ createdAt: 'asc' }, { actedAt: 'asc' }],
  })
  for (const r of rows) {
    if (!CRM_CHANNELS.includes(r.channel as CrmChannel)) continue
    const ch = r.channel as CrmChannel
    const cur = out.get(r.guestId) ?? { email: null, sms: null, whatsapp: null }
    cur[ch] = r.status === 'granted' ? 'granted' : 'revoked'
    out.set(r.guestId, cur)
  }
  return out
}

/** Je za kanal TRENUTNO veljavno soglasje (granted)? */
export function consentGranted(state: ConsentState | undefined, channel: CrmChannel): boolean {
  return state?.[channel] === 'granted'
}

export interface RecordConsentArgs {
  guestId: string
  channel: CrmChannel
  status: 'granted' | 'revoked'
  source: string
  proof?: string
  recordedBy?: string | null
  locationId?: string | null
}

/**
 * Zapiše vrstico v append-only sled (NI posodabljanja zgodovine!). Grant brez
 * dokaza izrecnega dejanja (proof) se ZAVRNE — GDPR člen 7 (upravljavec mora
 * znati dokazati privolitev).
 */
export async function recordConsent(args: RecordConsentArgs): Promise<{ ok: true }> {
  if (args.status === 'granted' && String(args.proof ?? '').trim().length < 3) {
    throw new Error('Grant zahteva dokaz izrecnega dejanja (opis, min. 3 znaki).')
  }
  await db.guestConsent.create({
    data: {
      id: nid(),
      guestId: args.guestId,
      channel: args.channel,
      purpose: 'marketing',
      status: args.status,
      source: args.source,
      textVersion: CRM_CONSENT_TEXT_VERSION,
      proof: String(args.proof ?? '').slice(0, 500),
      recordedBy: args.recordedBy ?? null,
      locationId: args.locationId ?? null,
      actedAt: new Date(),
    },
  })
  return { ok: true }
}

/* ─────────────────────────── segmenti ─────────────────────────── */

export interface SegmentDef {
  type: SegmentType
  /** i18n ključ razložljivega kriterija (UI prikaže kriterij + obdobje + št. gostov). */
  criterionKey: string
  minVisits?: number
}

export const SEGMENT_DEFS: SegmentDef[] = [
  { type: 'all', criterionKey: 'crm.seg.all' },
  { type: 'vip', criterionKey: 'crm.seg.vip' },
  { type: 'loyalty', criterionKey: 'crm.seg.loyalty' },
  { type: 'frequent', criterionKey: 'crm.seg.frequent', minVisits: FREQUENT_MIN_VISITS },
  { type: 'new', criterionKey: 'crm.seg.new' },
  { type: 'inactive', criterionKey: 'crm.seg.inactive' },
]

/**
 * Čisti Prisma where za segment (determinističen na fiksturah). IZKLJUČNO
 * poslovni podatki: obiski/poraba/VIP/zvestoba — alergeni/prehranjevalne
 * preference se NE bereta (varna postrežba, GDPR člen 9).
 */
export function segmentWhere(
  type: SegmentType,
  periodDays: number,
  now: Date,
  scope: { locationId?: string | { in: string[] } },
): Record<string, unknown> {
  const periodStart = new Date(now.getTime() - periodDays * 24 * 3600 * 1000)
  const base: Record<string, unknown> = { locationId: scope.locationId }
  switch (type) {
    case 'vip':
      return { ...base, isVip: true }
    case 'loyalty':
      return { ...base, loyaltyAccountId: { not: null } }
    case 'frequent':
      return { ...base, totalVisits: { gte: FREQUENT_MIN_VISITS } }
    case 'new':
      return { ...base, firstVisitAt: { gte: periodStart } }
    case 'inactive': {
      // neaktiven: JE bil (vsaj en obisk) in zadnji obisk PRED obdobjem
      return { ...base, totalVisits: { gt: 0 }, lastVisitAt: { lt: periodStart } }
    }
    case 'all':
    default:
      return base
  }
}

/* ─────────────────────────── publika ─────────────────────────── */

export interface AudienceRow {
  guestId: string
  firstName: string
  lastName: string
  recipient: string // e-pošta (email) ali telefon (sms)
}

export interface AudienceResult {
  total: number
  consentGranted: number
  suppressed: number // odjavljeni/preklicano soglasje
  missingContact: number
  eligible: AudienceRow[]
}

/**
 * Publika kampanje: segment → preverba SOGLASJA (trenutno stanje!) → preverba
 * kontakta. Obseg = gosti z locationId = kampanjina lokacija (staff meja;
 * centralna vloga izbere lokacijo ob ustvarjanju — org obseg se uveljavi
 * prek guardResource/lokacijskega sloja). NULL-lokacijski gostje NISO
 * naslovniki (fail-closed — niso v nobenem potrjenem obsegu).
 */
export async function computeAudience(campaign: {
  segmentType: string
  segmentPeriodDays: number
  channel: string
  locationId: string | null
}): Promise<AudienceResult> {
  const type = (CRM_SEGMENT_TYPES as readonly string[]).includes(campaign.segmentType)
    ? (campaign.segmentType as SegmentType)
    : 'all'
  const channel = campaignChannel(campaign.channel)
  const where = segmentWhere(type, campaign.segmentPeriodDays, new Date(), {
    locationId: campaign.locationId ?? '__no_location__',
  })
  const guests = await db.guest.findMany({
    where,
    select: {
      id: true, firstName: true, lastName: true, email: true, phone: true, locationId: true,
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    take: 5000,
  })
  const consent = await currentConsentMap(guests.map((g) => g.id))
  const out: AudienceResult = { total: guests.length, consentGranted: 0, suppressed: 0, missingContact: 0, eligible: [] }
  for (const g of guests) {
    const st = consent.get(g.id)
    const granted = consentGranted(st, channel)
    const contact = isPhoneChannel(channel) ? normalizePhoneDigits(g.phone) : normalizeEmail(g.email)
    if (!granted) {
      if (st?.[channel] === 'revoked') out.suppressed++
      continue
    }
    out.consentGranted++
    if (!contact || (channel === 'email' && !contact.includes('@')) || (isPhoneChannel(channel) && contact.length < 6)) {
      out.missingContact++
      continue
    }
    out.eligible.push({
      guestId: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      recipient: contact,
    })
  }
  return out
}

/* ─────────────────────────── vsebina ─────────────────────────── */

export function campaignSubject(campaign: { subject: string }, test = false): string {
  return test ? `[TEST] ${campaign.subject}` : campaign.subject
}

/** Telo pošiljke z OBAVEZNO nogo pošiljatelja + enostavne odjave (issue §3). */
export function campaignBody(
  campaign: { bodySl: string; bodyHr: string; channel: string },
  locale: 'sl' | 'hr',
  unsubscribeUrl: string,
  test = false,
): string {
  const body = locale === 'hr' ? campaign.bodyHr : campaign.bodySl
  const footer =
    locale === 'hr'
      ? `\n\n---\nNe želite više primati ove poruke? Odjavite se jednim klikom:\n${unsubscribeUrl}`
      : `\n\n---\n\nNe želite več prejemati teh sporočil? Odjavite se z enim klikom:\n${unsubscribeUrl}`
  return `${test ? '[TEST — Simulator testnega prejemnika, brez gostov]\n\n' : ''}${body}${footer}`
}

/* ─────────────────────────── pošiljanje (vbrizgljivo) ─────────────────────────── */

export interface SendFnArgs {
  campaignId: string
  guestId: string
  channel: CrmChannel
  to: string
  subject: string
  text: string
  locationId: string | null
  /** Kampanje: obvezen en klik odjava (issue §3). P2-10b rojstnodnevno
   * obvestilo: OPCIONALNO — pošiljamo SAMO gostom z veljavnim 'granted'
   * soglasjem (re-check ob pošiljanju), odjava pa prek CRM (recordConsent
   * revoke, takoj učinkovito); brez žetona CampaignSend ni List-Unsubscribe
   * glave, zato se tudi ne laže o en-klik odjavi. */
  unsubscribeUrl?: string
}

export interface SendFnResult {
  ok: boolean
  detail: string
  messageId?: string
}

export type CampaignSendFn = (args: SendFnArgs) => Promise<SendFnResult>

/** Privatni base URL za odjavne povezave (javna ruta, brez avtentikacije). */
function publicBaseUrl(): string {
  const env = process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL
  if (env) return env.replace(/\/$/, '')
  // Vercel production fallback (brez env spremenljivke)
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  return 'http://localhost:3000'
}

export function unsubscribeUrlFor(token: string): string {
  return `${publicBaseUrl()}/api/public/crm/unsubscribe?token=${token}`
}

/** Privzeti email pošiljatelj (SMTP iz nastavitev — obstoječi okvir reminders.ts). */
export const smtpSendFn: CampaignSendFn = async (args) => {
  if (args.channel !== 'email') {
    return { ok: false, detail: 'Kanal ni email' }
  }
  const transport = await smtpTransportForLocation(args.locationId)
  if (!transport) return { ok: false, detail: 'SMTP ni konfiguriran (nastavitve → e-pošta).' }
  try {
    const settings = await db.restaurantSettings.findFirst()
    const info = (await transport.sendMail({
      from: settings?.emailFromAddress || undefined,
      to: args.to,
      subject: args.subject,
      text: args.text,
      headers: {
        // RFC 6068 List-Unsubscribe: enostavna odjava na nivoju poštnega odjemalca
        // (samo ko obstaja žeton — kampanje; rojstnodnevno obvestilo gre brez)
        ...(args.unsubscribeUrl ? { 'List-Unsubscribe': `<${args.unsubscribeUrl}>` } : {}),
      },
    })) as { messageId?: string }
    return { ok: true, detail: 'OK', messageId: String(info?.messageId ?? '') }
  } catch (e) {
    return { ok: false, detail: String((e as Error).message || e).slice(0, 200) }
  }
}

/** Privzeti SMS pošiljatelj (Integrations type='sms' — obstoječi adapter). */
export const smsSendFn: CampaignSendFn = async (args) => {
  if (args.channel !== 'sms') return { ok: false, detail: 'Kanal ni sms' }
  const cfg = await smsConfigForLocation(args.locationId)
  if (!cfg) return { ok: false, detail: 'SMS ponudnik ni konfiguriran (Integracije → SMS).' }
  const res = await sendSms(cfg, args.to, args.text.slice(0, 480))
  return { ok: res.ok, detail: res.detail }
}

/** OSS-7 (v1.205.0) — WhatsApp pošiljatelj: TRANSPORT = B/C (Meta Business
 * API je lastnikova odločitev), zato je privzeti pošiljatelj determinističen
 * fail-soft: vrstica ostane 'failed' z IZRECNO razlogom — dokazano stanje
 * (nič se ne laže o pošiljanju, princip 3). Ko lastnik odobri transport,
 * se ta funkcija razširi po vzorcu smsSendFn (konfiguracija iz Integracij).
 * 0 omrežja, 0 odvisnosti, 0 AI. */
export const whatsappSendFn: CampaignSendFn = async (args) => {
  if (args.channel !== 'whatsapp') return { ok: false, detail: 'Kanal ni whatsapp' }
  return { ok: false, detail: 'WhatsApp ponudnik ni konfiguriran (transport čaka lastnikovo odobritev — B/C).' }
}

/* ─────────────────────────── dispatch ─────────────────────────── */

export interface DispatchResult {
  campaignId: string
  created: number
  sent: number
  failed: number
  skipped: number
  status: string
  completed: boolean
  smtpConfigured: boolean
}

/**
 * Pošiljanje ENE kampanje — OMEJENO (limit), IDEMPOTENTNO, varno za ponovni
 * zagon:
 *  1. publika → CampaignSend vrstice (samo OB PRVEM zagonu; @@unique varuje);
 *  2. pošiljanje: send-time re-check soglasja (odjava IZLOČI tudi že
 *     načrtovane vrstice), pogojne posodobitve (samo status='queued');
 *  3. števci se preštejejo IZ VRSTIC (ne seštevajo — ponovni zagon
 *     podvajanja ne more povzročiti).
 */
export async function dispatchCampaign(
  campaignId: string,
  opts: { sendFn?: CampaignSendFn; limit?: number; now?: Date } = {},
): Promise<DispatchResult> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) throw new Error('Kampanja ne obstaja.')
  const allowed = ['approved', 'scheduled', 'sending']
  if (!allowed.includes(campaign.status)) {
    return {
      campaignId, created: 0, sent: 0, failed: 0, skipped: 0,
      status: campaign.status, completed: false, smtpConfigured: false,
    }
  }
  // scheduled: pošiljaj SAMO po načrtovanem času
  if (campaign.status === 'scheduled' && campaign.scheduledAt && campaign.scheduledAt.getTime() > (opts.now ?? new Date()).getTime()) {
    return {
      campaignId, created: 0, sent: 0, failed: 0, skipped: 0,
      status: campaign.status, completed: false, smtpConfigured: false,
    }
  }
  const channel = campaignChannel(campaign.channel)
  const sendFn = opts.sendFn ?? (channel === 'sms' ? smsSendFn : channel === 'whatsapp' ? whatsappSendFn : smtpSendFn)
  const limit = Math.max(1, Math.min(opts.limit ?? CRM_BATCH_LIMIT, CRM_BATCH_LIMIT))
  const now = opts.now ?? new Date()
  const locale = await localeForLocation(campaign.locationId)

  // 1) prvi zagon: naredi vrstice CampaignSend (snapshot publike)
  let created = 0
  if (!campaign.sentAt) {
    const audience = await computeAudience(campaign)
    const existing = await db.campaignSend.findMany({
      where: { campaignId },
      select: { guestId: true },
    })
    const seen = new Set(existing.map((s) => s.guestId))
    for (const row of audience.eligible) {
      if (seen.has(row.guestId)) continue
      await db.campaignSend.create({
        data: {
          id: nid(),
          campaignId,
          guestId: row.guestId,
          channel,
          recipient: row.recipient,
          status: 'queued',
          unsubscribeToken: newUnsubscribeToken(),
          locationId: campaign.locationId,
        },
      })
      created++
      seen.add(row.guestId)
    }
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: 'sending', sentAt: now, eligibleCount: audience.eligible.length, lastError: '' },
    })
  }

  // 2) pošiljanje vrstice (send-time re-check soglasja!)
  const queued = await db.campaignSend.findMany({
    where: { campaignId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  const guestIds = queued.map((s) => s.guestId)
  const consent = await currentConsentMap(guestIds)
  let sent = 0
  let failed = 0
  let skipped = 0
  for (const s of queued) {
    if (s.attempts >= CRM_MAX_ATTEMPTS) {
      await db.campaignSend.update({
        where: { id: s.id },
        data: { status: 'failed', failedAt: new Date(), errorMessage: 'Presežen max. poskusov.' },
      })
      failed++
      continue
    }
    if (!consentGranted(consent.get(s.guestId), channel)) {
      // odjava/preklic PO vrstico v vrsti → IZLOČI (takoj učinkovito)
      await db.campaignSend.update({
        where: { id: s.id },
        data: { status: 'skipped', errorMessage: 'Ni soglasja ob pošiljanju (odjava/prenešenje).' },
      })
      skipped++
      continue
    }
    const url = unsubscribeUrlFor(s.unsubscribeToken)
    const result = await sendFn({
      campaignId, guestId: s.guestId, channel, to: s.recipient,
      subject: campaignSubject(campaign),
      text: campaignBody(campaign, locale, url),
      locationId: campaign.locationId, unsubscribeUrl: url,
    })
    if (result.ok) {
      await db.campaignSend.update({
        where: { id: s.id },
        data: {
          status: 'sent_to_provider',
          sentAt: new Date(),
          attempts: { increment: 1 },
          providerMessageId: String(result.messageId ?? '').slice(0, 200),
          errorMessage: '',
        },
      })
      sent++
    } else {
      await db.campaignSend.update({
        where: { id: s.id },
        data: { status: 'failed', failedAt: new Date(), attempts: { increment: 1 }, errorMessage: result.detail.slice(0, 250) },
      })
      failed++
    }
  }

  // 3) števci IZ VRSTIC (idempotentni), status kampanje
  const statusCount = (st: string): Promise<number> =>
    db.campaignSend.count({ where: { campaignId, status: st } })
  const [nSent, nFailed, nSkipped, nUnsub, nQueued] = await Promise.all([
    statusCount('sent_to_provider'), statusCount('failed'), statusCount('skipped'),
    statusCount('unsubscribed'), statusCount('queued'),
  ])
  const fresh = await db.campaign.findUnique({ where: { id: campaignId } })
  const done = nQueued === 0
  void nSkipped
  await db.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount: nSent,
      failedCount: nFailed,
      unsubscribedCount: nUnsub,
      status: done ? (nFailed > 0 && nSent === 0 && fresh?.sentAt ? 'failed' : 'sent') : 'sending',
      completedAt: done ? new Date() : null,
      lastError: done && nFailed > 0 ? `${nFailed} neuspelih pošiljk` : '',
    },
  })
  return {
    campaignId, created, sent, failed, skipped,
    status: done ? 'sent' : 'sending',
    completed: done,
    smtpConfigured: true,
  }
}

/** Vse zapadle (scheduled ≤ now) in nedokončane (sending) kampanje — za cron. */
export async function dispatchDueCampaigns(
  opts: { sendFn?: CampaignSendFn; now?: Date; limit?: number } = {},
): Promise<DispatchResult[]> {
  const now = opts.now ?? new Date()
  const due = await db.campaign.findMany({
    where: {
      OR: [
        { status: 'scheduled', scheduledAt: { lte: now } },
        { status: 'sending' },
      ],
    },
    orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
    take: CRM_CAMPAIGNS_PER_RUN,
    select: { id: true },
  })
  const out: DispatchResult[] = []
  for (const c of due) {
    try {
      out.push(await dispatchCampaign(c.id, opts))
    } catch (e) {
      out.push({
        campaignId: c.id, created: 0, sent: 0, failed: 0, skipped: 0,
        status: 'error', completed: false, smtpConfigured: false,
      })
      await db.campaign.update({
        where: { id: c.id },
        data: { lastError: String((e as Error).message || e).slice(0, 250) },
      }).catch(() => null)
    }
  }
  return out
}

/* ─────────────────────────── testno pošiljanje ─────────────────────────── */

/** Testna pošiljka na testni naslov (NI gost, brez CampaignSend vrstice). */
export async function sendTestEmail(
  campaignId: string,
  to: string,
  opts: { sendFn?: CampaignSendFn } = {},
): Promise<SendFnResult> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) throw new Error('Kampanja ne obstaja.')
  const channel = campaignChannel(campaign.channel)
  const sendFn = opts.sendFn ?? (channel === 'sms' ? smsSendFn : channel === 'whatsapp' ? whatsappSendFn : smtpSendFn)
  const locale = await localeForLocation(campaign.locationId)
  // OSS-7: testni prejemnik je kanalsko vezan — email = naslov, sms/whatsapp = telefon
  const clean = isPhoneChannel(channel) ? normalizePhoneDigits(to) : normalizeEmail(to)
  if (channel === 'email' && (!clean || !clean.includes('@'))) {
    throw new Error('Neveljaven testni e-poštni naslov.')
  }
  if (isPhoneChannel(channel) && clean.length < 6) {
    throw new Error('Neveljavna testna telefonska številka (najmanj 6 števk).')
  }
  return sendFn({
    campaignId, guestId: 'test-recipient', channel, to: clean,
    subject: campaignSubject(campaign, true),
    text: campaignBody(campaign, locale, unsubscribeUrlFor(newUnsubscribeToken()), true),
    locationId: campaign.locationId,
    unsubscribeUrl: unsubscribeUrlFor(newUnsubscribeToken()),
  })
}

/* ─────────────────────────── odjava (javna) ─────────────────────────── */

export interface UnsubscribeOutcome {
  kind: 'ok' | 'already' | 'invalid'
  channel?: CrmChannel
}

/**
 * Enklik odjava prek žetona iz pošiljke: appends 'revoked' v sled (KANAL
 * specifičen!) + CampaignSend.unsubscribedAt. Idempotentna (ponovni klik ne
 * podvoji vrstic). Naslednje in že načrtovane pošiljke gosta so izključene
 * (send-time re-check v dispatchCampaign).
 */
export async function unsubscribeByToken(token: string): Promise<UnsubscribeOutcome> {
  const clean = String(token ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(clean)) return { kind: 'invalid' }
  const send = await db.campaignSend.findUnique({ where: { unsubscribeToken: clean } })
  if (!send) return { kind: 'invalid' }
  if (send.unsubscribedAt) return { kind: 'already', channel: campaignChannel(send.channel) }
  const channel = campaignChannel(send.channel)
  const nUnsub = await db.$transaction(async (tx) => {
    await tx.campaignSend.update({
      where: { id: send.id },
      data: { unsubscribedAt: new Date(), status: 'unsubscribed' },
    })
    await tx.guestConsent.create({
      data: {
        id: nid(),
        guestId: send.guestId,
        channel,
        purpose: 'marketing',
        status: 'revoked',
        source: 'unsubscribe_link',
        textVersion: CRM_CONSENT_TEXT_VERSION,
        proof: 'Enklik odjava prek povezave v e-pošiljki (token ni shranjen).',
        locationId: send.locationId,
        actedAt: new Date(),
      },
    })
    return tx.campaignSend.count({ where: { campaignId: send.campaignId, status: 'unsubscribed' } })
  })
  // števci kampanje + audit IZVEN transakcije (varno — ne more pokači tx)
  await db.campaign.update({
    where: { id: send.campaignId },
    data: { unsubscribedCount: nUnsub },
  }).catch(() => null)
  await db.auditLog.create({
    data: {
      id: nid(),
      action: 'CRM_GUEST_UNSUBSCRIBED',
      entityType: 'CampaignSend',
      entityId: send.id,
      details: jstr({ campaignId: send.campaignId, channel, locationId: send.locationId }),
      locationId: send.locationId,
    },
  }).catch(() => null)
  return { kind: 'ok', channel }
}

/* ─────────────────────────── meritve ─────────────────────────── */

export interface CampaignPerformance {
  sentToProvider: number
  failed: number
  skipped: number
  unsubscribed: number
  queued: number
  /** Ponovni nakupi (naročila) prejemnikov v oknu REPEAT_WINDOW_DAYS po pošiljki. */
  repeatOrders: number
  windowDays: number
}

/**
 * Merjenje DEJANSKEGA rezultata: ponovni nakupi = naročila prejemnikov
 * (po guestId VEZ ali normalizirani e-pošti) v oknu po sentAt. Brez sledenja
 * klikom (ni utemeljene infrastrukture — dokumentirano v docs/CRM-GOSTI-SI-HR.md).
 */
export async function campaignPerformance(campaignId: string): Promise<CampaignPerformance> {
  const sends = await db.campaignSend.findMany({
    where: { campaignId },
    select: { status: true, guestId: true, recipient: true, sentAt: true, channel: true },
  })
  const sent = sends.filter((s) => s.status === 'sent_to_provider' && s.sentAt)
  const guestIds = sent.map((s) => s.guestId).filter(Boolean)
  // OSS-7: ponovni nakupi po e-pošti se ujemajo SAMO z email pošiljkami —
  // sms/whatsapp prejemniki so telefonski (telefona NIKOLI ne pošiljamo v
  // customerEmail filtra — lažno ujemanje).
  const emails = sent.filter((s) => s.channel === 'email').map((s) => normalizeEmail(s.recipient)).filter((e) => e.includes('@'))
  let repeatOrders = 0
  if (sent.length > 0) {
    const earliest = sent.reduce((min, s) => Math.min(min, (s.sentAt as Date).getTime()), Number.POSITIVE_INFINITY)
    const windowStart = new Date(earliest)
    const windowEnd = new Date(earliest + REPEAT_WINDOW_DAYS * 24 * 3600 * 1000)
    const where = guestIds.length > 0 || emails.length > 0
      ? {
          createdAt: { gte: windowStart, lte: windowEnd },
          OR: [
            ...(guestIds.length > 0 ? [{ guestId: { in: guestIds } }] : []),
            ...(emails.length > 0 ? [{ customerEmail: { in: emails } }] : []),
          ],
        }
      : { id: '__none__' }
    repeatOrders = await db.order.count({ where })
  }
  return {
    sentToProvider: sent.length,
    failed: sends.filter((s) => s.status === 'failed').length,
    skipped: sends.filter((s) => s.status === 'skipped').length,
    unsubscribed: sends.filter((s) => s.status === 'unsubscribed').length,
    queued: sends.filter((s) => s.status === 'queued').length,
    repeatOrders,
    windowDays: REPEAT_WINDOW_DAYS,
  }
}

/* ─────────────────────────── deduplikacija ─────────────────────────── */

export interface DuplicatePair {
  canonical: { id: string; name: string; email: string; phone: string; totalVisits: number }
  duplicate: { id: string; name: string; email: string; phone: string; totalVisits: number }
  matchedOn: 'email' | 'phone'
}

/** Integration marker za ročno razrešene (dismissed) pare — zero-DDL (cron-daily-state vzorec). */
const DUP_DISMISS_MARKER = 'crm-dup-dismissed'

async function dismissedPairs(): Promise<Set<string>> {
  const rows = await db.integration.findMany({ where: { name: DUP_DISMISS_MARKER } })
  const out = new Set<string>()
  for (const r of rows) {
    const cfg = jparse<{ pairs?: string[] }>(r.config, {})
    for (const p of cfg?.pairs ?? []) out.add(p)
  }
  return out
}

async function addDismissedPair(key: string): Promise<void> {
  const rows = await db.integration.findMany({ where: { name: DUP_DISMISS_MARKER } })
  const row = rows[0]
  if (row) {
    const cfg = jparse<{ pairs?: string[] }>(row.config, {})
    const pairs = new Set([...(cfg?.pairs ?? []), key])
    await db.integration.update({ where: { id: row.id }, data: { config: jstr({ pairs: [...pairs] }) } })
  } else {
    await db.integration.create({
      data: {
        id: `crm-dup-${Date.now().toString(36)}`,
        name: DUP_DISMISS_MARKER,
        type: 'other',
        provider: 'internal',
        config: jstr({ pairs: [key] }),
        isActive: true,
        syncEnabled: false,
      },
    })
  }
}

/**
 * Zaznava podvojenih profilov: enak normaliziran email ALI telefon (≥6 števk)
 * znotraj obsega. Pare, ki so bile ročno razrešene (dismissed), se ne vračajo.
 */
export async function findDuplicateGuests(
  scope: { locationId?: string | { in: string[] } },
): Promise<DuplicatePair[]> {
  const guests = await db.guest.findMany({
    where: { locationId: scope.locationId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, totalVisits: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  })
  const dismissed = await dismissedPairs()
  const byEmail = new Map<string, typeof guests>()
  const byPhone = new Map<string, typeof guests>()
  for (const g of guests) {
    const e = normalizeEmail(g.email)
    if (e.includes('@')) byEmail.set(e, [...(byEmail.get(e) ?? []), g])
    const p = normalizePhoneDigits(g.phone)
    if (p.length >= 6) byPhone.set(p, [...(byPhone.get(p) ?? []), g])
  }
  const pairs: DuplicatePair[] = []
  const seen = new Set<string>()
  const emit = (group: typeof guests, matchedOn: 'email' | 'phone') => {
    const sorted = [...group].sort((a, b) =>
      b.totalVisits - a.totalVisits || a.createdAt.getTime() - b.createdAt.getTime())
    for (let i = 1; i < sorted.length; i++) {
      const [c, d] = [sorted[0], sorted[i]]
      const key = [c.id, d.id].sort().join('|')
      if (dismissed.has(key) || seen.has(key)) continue
      seen.add(key)
      const name = (g: typeof guests[number]) => `${g.firstName} ${g.lastName}`.trim() || '—'
      pairs.push({
        canonical: { id: c.id, name: name(c), email: c.email, phone: c.phone, totalVisits: c.totalVisits },
        duplicate: { id: d.id, name: name(d), email: d.email, phone: d.phone, totalVisits: d.totalVisits },
        matchedOn,
      })
    }
  }
  for (const group of byEmail.values()) if (group.length > 1) emit(group, 'email')
  for (const group of byPhone.values()) if (group.length > 1) emit(group, 'phone')
  return pairs.slice(0, 50)
}

/** Ročna razrešitev »ni duplikat« — par se ne vrača v prihodnjih pregledih. */
export async function dismissDuplicatePair(guestAId: string, guestBId: string): Promise<void> {
  const key = [guestAId, guestBId].sort().join('|')
  await addDismissedPair(key)
}

export interface MergeResult {
  canonicalId: string
  ordersMoved: number
  visitsMoved: number
  feedbackMoved: number
  consentMoved: number
  sendsMoved: number
}

/**
 * ZDružitev podvojenega profila v kanoničnega (transakcijsko):
 *  - relacijske vrstice se PREVEŽEJO (Order/GuestVisit/GuestFeedback/
 *    GuestConsent/CampaignSend) — nakupi/točke se NE podvoji (agregati =
 *    MAX ne vsota);
 *  - loyalty: če ima SAMO podvojeni profil račun → se prenese; če OBA →
 *    zavrnjeno (ročna razrešitev — transakcije računov se ne sme mešati);
 *  - alergeni/preference: UNIJA (varna postrežba — podatek sme samo dodati,
 *    nikoli izgubiti).
 */
export async function mergeGuests(canonicalId: string, duplicateId: string): Promise<MergeResult> {
  if (canonicalId === duplicateId) throw new Error('Identa sta enaka.')
  return db.$transaction(async (tx) => {
    const canonical = await tx.guest.findUnique({ where: { id: canonicalId } })
    const duplicate = await tx.guest.findUnique({ where: { id: duplicateId } })
    if (!canonical || !duplicate) throw new Error('Gost ne obstaja.')
    if (canonical.loyaltyAccountId && duplicate.loyaltyAccountId) {
      throw new Error('Oba profila imata zvestobni račun — najprej ročno združi točke (transakcije se ne smejo mešati).')
    }
    // preveži otroke (unikatna omejitev campaignId+guestId lahko zavrne → vidna napaka)
    const ordersMoved = await tx.order.updateMany({ where: { guestId: duplicateId }, data: { guestId: canonicalId } })
    const visitsMoved = await tx.guestVisit.updateMany({ where: { guestId: duplicateId }, data: { guestId: canonicalId } })
    const feedbackMoved = await tx.guestFeedback.updateMany({ where: { guestId: duplicateId }, data: { guestId: canonicalId } })
    const consentMoved = await tx.guestConsent.updateMany({ where: { guestId: duplicateId }, data: { guestId: canonicalId } })
    const sendsMoved = await tx.campaignSend.updateMany({ where: { guestId: duplicateId }, data: { guestId: canonicalId } })
    // loyalty: samo če podvojeni ima račun (kanonični ga nima) — NAJPREJ sprosti
    // unikatno vez na duplikatu (@@unique loyaltyAccountId), nato preveži na kanoničnega
    let loyaltyMoved = false
    if (!canonical.loyaltyAccountId && duplicate.loyaltyAccountId) {
      await tx.guest.update({ where: { id: duplicateId }, data: { loyaltyAccountId: null } })
      await tx.guest.update({ where: { id: canonicalId }, data: { loyaltyAccountId: duplicate.loyaltyAccountId } })
      loyaltyMoved = true
    }
    void loyaltyMoved
    // agregati: MAX (nikoli vsota — isto osebo ne štejemo dvakrat)
    // `unknown` (ne `string`): na Postgresu so Json polja VRAČENA kot objekt,
    // na SQLite kot String — jparse obvlada obe oblike, nossa pa ne.
    const unionJson = (a: unknown, b: unknown): string => {
      const list = [...(jparse<string[]>(a, []) ?? []), ...(jparse<string[]>(b, []) ?? [])]
      return jstr([...new Set(list)])
    }
    await tx.guest.update({
      where: { id: canonicalId },
      data: {
        totalVisits: Math.max(canonical.totalVisits, duplicate.totalVisits),
        totalSpent: Number(canonical.totalSpent) >= Number(duplicate.totalSpent) ? canonical.totalSpent : duplicate.totalSpent,
        lastVisitAt: canonical.lastVisitAt && duplicate.lastVisitAt
          ? new Date(Math.max(canonical.lastVisitAt.getTime(), duplicate.lastVisitAt.getTime()))
          : (canonical.lastVisitAt ?? duplicate.lastVisitAt),
        firstVisitAt: canonical.firstVisitAt && duplicate.firstVisitAt
          ? new Date(Math.min(canonical.firstVisitAt.getTime(), duplicate.firstVisitAt.getTime()))
          : (canonical.firstVisitAt ?? duplicate.firstVisitAt),
        isVip: canonical.isVip || duplicate.isVip,
        vipSince: canonical.vipSince && duplicate.vipSince
          ? new Date(Math.min(canonical.vipSince.getTime(), duplicate.vipSince.getTime()))
          : (canonical.vipSince ?? duplicate.vipSince),
        email: normalizeEmail(canonical.email).includes('@') ? canonical.email : duplicate.email,
        phone: canonical.phone.trim() || duplicate.phone,
        notes: [canonical.notes, duplicate.notes].filter((n) => n && n.trim()).join(' | ').slice(0, 2000),
        allergens: unionJson(canonical.allergens, duplicate.allergens),
        dietaryPrefs: unionJson(canonical.dietaryPrefs, duplicate.dietaryPrefs),
        dislikes: unionJson(canonical.dislikes, duplicate.dislikes),
        favoriteItems: unionJson(canonical.favoriteItems, duplicate.favoriteItems),
      },
    })
    await tx.guest.delete({ where: { id: duplicateId } })
    return {
      canonicalId,
      ordersMoved: ordersMoved.count,
      visitsMoved: visitsMoved.count,
      feedbackMoved: feedbackMoved.count,
      consentMoved: consentMoved.count,
      sendsMoved: sendsMoved.count,
    }
  })
}

/* ─────────────────────────── pripomočki ─────────────────────────── */

/** Locale lokacije (hr → HR vsebina, sicer SL). */
export async function localeForLocation(locationId: string | null): Promise<'sl' | 'hr'> {
  if (!locationId) return 'sl'
  try {
    const loc = await db.location.findUnique({ where: { id: locationId }, select: { locale: true } })
    return String(loc?.locale ?? '').toLowerCase().startsWith('hr') ? 'hr' : 'sl'
  } catch {
    return 'sl'
  }
}

/** Audit helper — brez vsebine sporočil (samo id-ji/števci/statusi). */
export async function crmAudit(
  action: string,
  entityType: string,
  entityId: string | undefined,
  details: Record<string, unknown>,
  opts: { userId?: string | null; locationId?: string | null } = {},
): Promise<void> {
  try {
    await writeAudit(db, {
      userId: opts.userId ?? undefined,
      action,
      entityType,
      entityId,
      details: jstr(details),
      locationId: opts.locationId ?? undefined,
    })
  } catch {
    // audit nikoli ne pokaže API klica
  }
}
