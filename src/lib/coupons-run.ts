/**
 * P2-10b (v1.187.0) — izdaja rojstnodnevnih kuponov (strežniški sloj).
 *
 * Pokliče jo dnevni cron (`/api/cron/daily`, korak 'coupons') in ročno UI
 * (ni — izdaja je avtomatska; ročni kuponi gredo prek POST /api/coupons).
 *
 * Idempotenca: @@unique([guestId, reason, year]) — 'year' je leto POJAVLJANJA
 * (ne tekoče leto), zato gost rojen 29. 2. dobi v ne-prestopnem letu kupon za
 * pojavljanje 28. 2. in ta isti kupon ni izdan dvakrat, če cron teče večkrat
 * znotraj okna. Ponovni zagon → 'skipped'.
 *
 * Obvestilo: best-effort, fail-soft — SAMO gostu z e-pošto IN veljavnim
 * 'granted' soglasjem za kanal email (re-check ob pošiljanju, GDPR issue #11).
 * Brez SMTP konfiguracije se kupon VEDNO izda, obvestilo pa se ob posegu
 * (notifyStatus 'smtp_unconfigured') — izdaja kupona ni odvisna od pošte.
 */
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { consentGranted, crmAudit, currentConsentMap, localeForLocation, smtpSendFn } from './crm'
import {
  birthdayCouponExpiry,
  birthdayInWindow,
  BIRTHDAY_COUPON_PERCENT,
  BIRTHDAY_WINDOW_DAYS,
  generateCouponCode,
  nextBirthday,
} from './coupons'

export interface BirthdayCouponsRun {
  issued: number
  notified: number
  skipped: number
  failed: number
  errors: string[]
}

const SUBJECT_SL = 'Srečno! 🎂 Vaš rojstnodnevni kupon je pripravljen'
const BODY_SL = (code: string, percent: number, until: string): string =>
  `Iskren čestitke!\n\nZa vaš praznik smo vam pripravili kupon: ${percent} % popusta na račun.\nKoda kupona: ${code}\nVelja do: ${until}\n\nKodo povejte natakarju ob plačilu. Veselimo se vašega obiska!`
const SUBJECT_HR = 'Čestitke! 🎂 Vaš rođendanski kupon je spreman'
const BODY_HR = (code: string, percent: number, until: string): string =>
  `Iskrene čestitke!\n\nZa vaš praznik pripremili smo kupon: ${percent} % popusta na račun.\nKod kupona: ${code}\nVrijedi do: ${until}\n\nKod recite konobaru prilikom plaćanja. Radujemo se vašem dolasku!`

/** Mapa SMTP napake → notifyStatus (za razločevanje v UI/anitiki). */
function notifyStatusOf(detail: string): 'failed' | 'smtp_unconfigured' {
  return /SMTP ni konfiguriran/i.test(detail) ? 'smtp_unconfigured' : 'failed'
}

export async function issueBirthdayCoupons(
  opts: { now?: Date; actor?: string; sendEmail?: boolean } = {},
): Promise<BirthdayCouponsRun> {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? 'cron'
  const sendEmail = opts.sendEmail ?? true
  const errors: string[] = []
  let issued = 0
  let notified = 0
  let skipped = 0
  let failed = 0

  // Okno se računa v čistem sloju (prestopna pravila) — SQL bi znal laži.
  const guests = await db.guest.findMany({
    where: { birthday: { not: null } },
    select: { id: true, firstName: true, lastName: true, email: true, birthday: true, locationId: true },
  })
  const eligible = guests.filter((g) => birthdayInWindow(g.birthday as Date, now, BIRTHDAY_WINDOW_DAYS))
  if (eligible.length === 0) return { issued, notified, skipped, failed, errors }

  const consent = await currentConsentMap(eligible.map((g) => g.id))

  for (const g of eligible) {
    try {
      const occ = nextBirthday(g.birthday as Date, now)
      const year = occ.getFullYear()
      const exists = await db.coupon.findUnique({
        where: { guestId_reason_year: { guestId: g.id, reason: 'birthday', year } },
        select: { id: true },
      })
      if (exists) {
        skipped++
        continue
      }
      const expiresAt = birthdayCouponExpiry(occ)
      // Koda: generiraj do 5 poskusov; @@unique(code) je varovalka sočasnosti.
      let code = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateCouponCode(year)
        const clash = await db.coupon.findUnique({ where: { code: candidate }, select: { id: true } })
        if (!clash) {
          code = candidate
          break
        }
      }
      if (!code) {
        failed++
        errors.push(`koda: 5 generacij je trčilo ob unikatnost (gost ${g.id})`)
        continue
      }
      const coupon = await db.coupon.create({
        data: {
          id: nid(),
          code,
          guestId: g.id,
          reason: 'birthday',
          year,
          percent: BIRTHDAY_COUPON_PERCENT,
          fixedAmount: 0,
          status: 'issued',
          issuedAt: now,
          expiresAt,
          locationId: g.locationId,
          issuedBy: actor,
        },
      })
      issued++
      await crmAudit(
        'COUPON_ISSUED',
        'Coupon',
        coupon.id,
        { code, reason: 'birthday', year, percent: BIRTHDAY_COUPON_PERCENT, expiresAt: expiresAt.toISOString(), guestId: g.id, by: actor },
        { userId: null, locationId: g.locationId },
      )

      if (!sendEmail) continue
      const email = String(g.email ?? '').trim()
      if (!email) {
        await db.coupon.update({ where: { id: coupon.id }, data: { notifyStatus: 'no_email' } })
        continue
      }
      if (!consentGranted(consent.get(g.id), 'email')) {
        await db.coupon.update({ where: { id: coupon.id }, data: { notifyStatus: 'no_consent' } })
        continue
      }
      const locale = await localeForLocation(g.locationId)
      const until = expiresAt.toLocaleDateString(locale === 'hr' ? 'hr-HR' : 'sl-SI')
      const result = await smtpSendFn({
        campaignId: '',
        guestId: g.id,
        channel: 'email',
        to: email,
        subject: locale === 'hr' ? SUBJECT_HR : SUBJECT_SL,
        text: (locale === 'hr' ? BODY_HR : BODY_SL)(code, BIRTHDAY_COUPON_PERCENT, until),
        locationId: g.locationId,
      })
      if (result.ok) {
        notified++
        await db.coupon.update({ where: { id: coupon.id }, data: { notifiedAt: new Date(), notifyStatus: 'sent' } })
      } else {
        await db.coupon.update({ where: { id: coupon.id }, data: { notifyStatus: notifyStatusOf(result.detail) } })
      }
    } catch (e) {
      failed++
      errors.push(`${g.id}: ${String((e as Error).message || e).slice(0, 160)}`)
    }
  }
  return { issued, notified, skipped, failed, errors }
}

/** Ročna izdaja (POST /api/coupons) — skupna koda-generacija + audit. */
export async function createManualCoupon(args: {
  guestId: string
  percent?: number | null
  fixedAmount?: number | null
  expiresAt: Date
  note?: string
  issuedBy: string
}): Promise<{ ok: true; couponId: string; code: string } | { ok: false; error: string }> {
  let code = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCouponCode(new Date().getFullYear())
    const clash = await db.coupon.findUnique({ where: { code: candidate }, select: { id: true } })
    if (!clash) {
      code = candidate
      break
    }
  }
  if (!code) return { ok: false, error: 'Generacija kode ni uspela (5 poskusov).' }
  const guest = await db.guest.findUnique({ where: { id: args.guestId }, select: { locationId: true } })
  if (!guest) return { ok: false, error: 'Gost ne obstaja.' }
  const coupon = await db.coupon.create({
    data: {
      id: nid(),
      code,
      guestId: args.guestId,
      reason: 'manual',
      year: null,
      percent: args.percent ?? null,
      fixedAmount: args.percent == null ? (args.fixedAmount ?? 0) : 0,
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: args.expiresAt,
      note: String(args.note ?? '').slice(0, 300),
      issuedBy: args.issuedBy,
      locationId: guest.locationId,
    },
  })
  await crmAudit(
    'COUPON_ISSUED',
    'Coupon',
    coupon.id,
    { code, reason: 'manual', percent: args.percent ?? null, fixedAmount: args.fixedAmount ?? null, expiresAt: args.expiresAt.toISOString(), guestId: args.guestId, by: args.issuedBy },
    { userId: args.issuedBy, locationId: guest.locationId },
  )
  return { ok: true, couponId: coupon.id, code }
}
