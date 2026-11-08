/**
 * OPS-8 val 3 (v1.73.0) — daily summary e-mail on shift close (Z-report).
 *
 * Reuses the OPS-7 SMTP transport builder (lib/reminders.ts → RestaurantSettings
 * emailEnabled/emailSmtp* fields). Fire-and-forget by contract: the caller must
 * never await this on the critical path, and this module itself never throws —
 * failures are logged to ScheduledEmailLog (status 'failed').
 *
 * Recipient: RestaurantSettings.email (the venue contact address); if the venue
 * also configured emailReportRecipients (JSON array), up to 5 extra addresses
 * are added. E-mail content is Slovenian literal text (no i18n — accepted scope).
 *
 * OPS-11 val 3 (v1.82.0) — Vercel cron support:
 *  - sendDailyDigest({ locationId?, now?, overdueAps? }) — request-free digest
 *    for /api/cron/daily: aggregates YESTERDAY's sales window (local 00:00→00:00)
 *    and sends the same daily summary layout (recurringToday + new "Zapadle
 *    obveznosti" overdue-AP section). ScheduledEmailLog reportType 'DAILY_DIGEST'.
 *  - shiftSummaryEmailText output for pre-existing inputs is UNCHANGED (byte-identical
 *    refactor into shared summaryBodyLines; overdue/window fields are additive).
 *
 * v1.167.0 — digest sme biti poslan ENKRAT na zajeti dan. Cron marker se ob
 *  napaki NAMERNO ne zapiše (lažni uspeh v markerju je slabši od ponovitve),
 *  zato istodnevna ročna ponovitev zažene vse korake znova; e-pošte ni mogoče
 *  umakniti. Varovalka bere ScheduledEmailLog (reportType 'DAILY_DIGEST',
 *  status 'sent', reportDate = zajeti dan) in je prva pred SMTP preverbo.
 *  Status 'failed' NE blokira — nedostavljeno sporočilo mora biti ponovljeno.
 */
import { db } from '@/lib/db'
import { nid, num } from '@/lib/map'
import { smtpTransportForLocation, findEmailSettings } from '@/lib/reminders'
import { dueTodayRules, parseRecurringConfig } from '@/lib/recurring-po'
import { daysOverdue, localDateKey, startOfDay } from '@/lib/cron-daily'
import { hourlyReportSection, type HourlyEmailBucket } from '@/lib/hourly-email'
import { dailyTaskSummarySection, weeklyTaskSummaryEmailText, weeklyCoveragePct, type TaskSummaryLine, type WeeklyTaskRow } from '@/lib/task-summary-email'
import {
  loadChecklistTemplates,
  checklistOccurrenceForDate,
  parseItemResults,
  coverageOf,
  runCompletedFromCoverage,
} from '@/lib/ops-checklists'
import { localDateFromKey } from '@/lib/ops-checklists'
import { aggregateSalesByVariant } from '@/lib/item-variants'
import type { SendMailOptions } from 'nodemailer'

/**
 * Minimalni vmesnik pošiljanja — `Transporter` ga izpolnjuje. Obstoji samo
 * zato, da je veja pošiljanja sploh dosegljiva testu (brez SMTP v bazi in brez
 * mock-a celega modula, ki v bunu uhane v naslednje testne datoteke); produkcija
 * uporabi privzeti `smtpTransportForLocation`.
 */
export interface DigestMailer {
  sendMail(mail: SendMailOptions): Promise<unknown>
}

export interface RecurringTodayEntry {
  supplier: string
  itemCount: number
  /** scheduled hour (local) — rendered as HH:00 */
  hour: number
}

/** OPS-11 val 3 — one overdue AccountsPayable entry for the digest section. */
export interface OverdueApEntry {
  apNumber: string
  supplier: string
  /** whole days past due (>= 1) */
  daysOverdue: number
  amount: number
}

export interface ShiftSummaryData {
  shiftId: string
  shiftDate: Date
  from: Date
  to: Date
  locationId: string | null
  gross: number
  net: number
  vat: number
  covers: number
  payments: { method: string; amount: number }[]
  topItems: { name: string; qty: number }[]
  /** OPS-10 val 3 (v1.79.0): recurring POs whose nextRun falls today (additive, optional) */
  recurringToday?: RecurringTodayEntry[]
  /** OPS-11 val 3 (v1.82.0): overdue supplier invoices — "Zapadle obveznosti" section (additive, optional; empty → no section) */
  overdueAps?: OverdueApEntry[]
  /** OPS-11 val 3: label for the window header line (default 'Izmena'; cron digest passes 'Dan') */
  windowLabel?: string
  /**
   * OSS-8 (v1.206.0): urne vedre prodaje (additive, optional; absent/empty →
   * NO section — output for pre-existing inputs stays byte-identical).
   * Cron digest izpelje iz že naloženih Receipt.createdAt — brez nove poizvedbe.
   */
  hourlyBuckets?: HourlyEmailBucket[]
  /**
   * STREŽNI VAL v1.248.0 (§22 C — Lightspeed junij 2026 »daily … Tasks summary
   * emails«): izpolnjenost seznamov dneva (additive, optional; absent/empty
   * → NO section — izhod za obstoječe vhode ostane byte-identičen).
   * Čisti sestavljalnik živi v task-summary-email.ts (0 uvozov).
   */
  taskSummary?: TaskSummaryLine[]
}

const eur = (v: number): string => `${(Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2)} EUR`

const METHOD_LABELS: Record<string, string> = {
  cash: 'Gotovina',
  card: 'Kartica',
  mobile: 'Mobilno plačilo',
  other: 'Drugo',
}

const fmtWindow = (d: Date): string =>
  d.toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Shared body lines (pure) — everything between the subject and the footer.
 * OPS-11 val 3 refactor: extracted so shiftSummaryEmailText and the cron
 * dailyDigestEmailText render the SAME sections; output for pre-existing
 * inputs is byte-identical (additive overdueAps/windowLabel only).
 */
function summaryBodyLines(d: ShiftSummaryData): string[] {
  const avgCheck = d.covers > 0 ? d.net / d.covers : 0
  const lines: string[] = []
  lines.push('Dnevni povzetek prodaje')
  lines.push('')
  lines.push(`${d.windowLabel || 'Izmena'}: ${fmtWindow(d.shiftDate)}`)
  lines.push(`Obdobje: ${fmtWindow(d.from)} – ${fmtWindow(d.to)}`)
  lines.push('')
  lines.push(`Bruto promet (z DDV): ${eur(d.gross)}`)
  lines.push(`Neto promet (brez DDV): ${eur(d.net)}`)
  lines.push(`DDV: ${eur(d.vat)}`)
  lines.push(`Št. računov (covers): ${d.covers}`)
  lines.push(`Povprečni račun: ${eur(avgCheck)}`)
  if (d.payments.length > 0) {
    lines.push('')
    lines.push('Plačila po načinih:')
    for (const p of d.payments) lines.push(`  ${METHOD_LABELS[p.method] || p.method}: ${eur(p.amount)}`)
  }
  if (d.topItems.length > 0) {
    lines.push('')
    lines.push('Najbolj prodani artikli:')
    // defensive slice — the caller normally passes at most 3, enforce it here too
    d.topItems.slice(0, 3).forEach((it, i) => lines.push(`  ${i + 1}. ${it.name} — ${it.qty}×`))
  }
  // OSS-8 (v1.206.0): urna razčlenitev prodaje — sekcija "Prodaja po urah:" po
  // topItems, pred naročilnicami (additive; absent/empty → NO section). Čisto
  // sestavljanje živi v hourly-email.ts (0 uvozov) — tukaj samo glue.
  if (Array.isArray(d.hourlyBuckets) && d.hourlyBuckets.length > 0) {
    for (const line of hourlyReportSection(d.hourlyBuckets)) lines.push(line)
  }
  // STREŽNI VAL v1.248.0 (§22 C): sekcija »Opravila« — izpolnjenost seznamov
  // dneva (additive; absent/empty → NO section). Čisti sestavljalnik živi v
  // task-summary-email.ts (0 uvozov) — tukaj samo glue.
  if (Array.isArray(d.taskSummary) && d.taskSummary.length > 0) {
    for (const line of dailyTaskSummarySection(d.taskSummary)) lines.push(line)
  }
  // OPS-10 val 3: "Naročilnice za zagon danes" — recurring PO rules due today (additive)
  if (Array.isArray(d.recurringToday) && d.recurringToday.length > 0) {
    // Slovenian plural: 1 artikel, 2 artikla, 3-4 artikli, 5+ artiklov
    const itemWord = (n: number): string => (n === 1 ? 'artikel' : n === 2 ? 'artikla' : n >= 3 && n <= 4 ? 'artikli' : 'artiklov')
    lines.push('')
    lines.push('Naročilnice za zagon danes:')
    d.recurringToday.slice(0, 10).forEach((r, i) => {
      const hh = String(Math.max(0, Math.min(23, Math.round(r.hour)))).padStart(2, '0')
      lines.push(`  ${i + 1}. ${r.supplier} — ${r.itemCount} ${itemWord(r.itemCount)} ob ${hh}:00`)
    })
  }
  // OPS-11 val 3: "Zapadle obveznosti" — overdue supplier invoices (additive,
  // optional; absent/empty → NO section). Rendered before the footer.
  if (Array.isArray(d.overdueAps) && d.overdueAps.length > 0) {
    const dayWord = (n: number): string => (n === 1 ? 'dan' : n === 2 ? 'dneva' : 'dni')
    lines.push('')
    lines.push('Zapadle obveznosti (neplačani računi dobaviteljev):')
    d.overdueAps.slice(0, 10).forEach((a, i) => {
      const days = Math.max(0, Math.round(a.daysOverdue))
      lines.push(`  ${i + 1}. ${a.apNumber} · ${a.supplier} — ${days} ${dayWord(days)} zamude · ${eur(a.amount)}`)
    })
  }
  return lines
}

/** Pure text builder (unit-tested) — shift-close digest. */
export function shiftSummaryEmailText(d: ShiftSummaryData): { subject: string; body: string } {
  const subject = `RestaurantOS — dnevni povzetek (izmena ${fmtWindow(d.shiftDate)})`
  const body = [...summaryBodyLines(d), '', '— Samodejno sporočilo RestaurantOS'].join('\n')
  return { subject, body }
}

/**
 * OPS-11 val 3 — pure text builder for the CRON daily digest (same layout,
 * different subject/window label: it covers a calendar DAY, not a shift).
 */
export function dailyDigestEmailText(d: ShiftSummaryData): { subject: string; body: string } {
  const subject = `RestaurantOS — dnevni povzetek (dan ${fmtWindow(d.shiftDate)})`
  const body = [...summaryBodyLines({ ...d, windowLabel: d.windowLabel || 'Dan' }), '', '— Samodejno sporočilo RestaurantOS'].join('\n')
  return { subject, body }
}

/**
 * OPS-11 val 3 — overdue AccountsPayable rows for the digest section
 * (fail-soft, never throws). status 'open' AND dueDate < today 00:00,
 * oldest due first, clamped to MAX_OVERDUE_APS (20).
 */
async function loadOverdueApsForDigest(now: Date): Promise<OverdueApEntry[]> {
  try {
    const t0 = startOfDay(now)
    const rows = await db.accountsPayable.findMany({
      where: { status: 'open', dueDate: { lt: t0 } },
      orderBy: { dueDate: 'asc' },
      take: 20,
      select: { apNumber: true, totalAmount: true, dueDate: true, Supplier: { select: { name: true } } },
    })
    return rows.map((r) => ({
      apNumber: r.apNumber,
      supplier: r.Supplier?.name || '(dobavitelj)',
      daysOverdue: daysOverdue(r.dueDate, now),
      amount: num(r.totalAmount),
    }))
  } catch {
    return []
  }
}

export interface DailyDigestResult {
  sent: boolean
  /** Skip reason when sent === false: 'already_sent' | 'email_not_configured' | 'smtp_not_configured'. */
  reason?: string
  /** Failure message when sending threw (also logged to ScheduledEmailLog 'failed'). */
  error?: string
}

/**
 * OPS-11 val 3 — request-free daily digest for /api/cron/daily.
 * Covers YESTERDAY's local calendar day (from = yesterday 00:00, to = today
 * 00:00 — at the 05:00 UTC cron the previous day is already complete) and
 * always includes the recurringToday + overdue-AP sections. Never throws:
 * the caller gets { sent: false, reason | error } and the cron run continues.
 * @param args.locationId — optional receipt filter (default: all locations)
 * @param args.overdueAps — pre-loaded entries (cron passes them so the push
 *                         and the digest share a single query)
 * @param args.transportFactory — mailer resolver (default: SMTP config from the
 *                         database). A test seam only: without it the send
 *                         branch needs a live SMTP host and was never executed.
 */
export async function sendDailyDigest(
  args: { locationId?: string | null; now?: Date; overdueAps?: OverdueApEntry[]; transportFactory?: (locationId: string | null) => Promise<DigestMailer | null> } = {},
): Promise<DailyDigestResult> {
  const now = args.now ?? new Date()
  const to = startOfDay(now)
  const from = new Date(to.getTime())
  from.setDate(from.getDate() - 1)
  const shiftDate = from
  const reportType = 'DAILY_DIGEST'
  try {
    // v1.167.0 — isti dan dvakrat ne sme poštati. Cron marker (`already_ran_today`)
    // se ob napaki NE zapiše, zato istodnevna ročna ponovitev zažge vse korake
    // znova; edini trajni dokaz dostavljenega digesta je ta vrstica. 'failed'
    // NE šteje — poskus, ki ni bil dostavljen, sme (mora) biti ponovljen.
    const alreadySent = await db.scheduledEmailLog.findFirst({
      where: { reportType, status: 'sent', reportDate: from },
      select: { id: true },
    })
    if (alreadySent) return { sent: false, reason: 'already_sent' }
    const settings = await findEmailSettings()
    if (!settings?.email) return { sent: false, reason: 'email_not_configured' }
    const transport = await (args.transportFactory ?? smtpTransportForLocation)(args.locationId ?? null)
    if (!transport) return { sent: false, reason: 'smtp_not_configured' }

    // yesterday's sales window — same aggregation as the shift-close digest
    const receipts = await db.receipt.findMany({
      where: {
        ...(args.locationId ? { locationId: args.locationId } : {}),
        createdAt: { gte: from, lt: to },
      },
      // OSS-8 (v1.206.0): + createdAt — urna razčlenitev iz ISTE poizvedbe (brez nove)
      select: { orderId: true, subtotal: true, total: true, totalVat: true, isStorno: true, paymentMethod: true, createdAt: true },
      take: 5000,
    })
    let gross = 0, net = 0, vat = 0, covers = 0
    const payTotals = new Map<string, number>()
    const orderIds = new Set<string>()
    // OSS-8 (v1.206.0): urne vedre — polnjene v ISTI zanki (storno izključeni z
    // istim continue; manjkajoč/neveljaven createdAt preskočen — fail-soft)
    const hourAgg = new Map<number, { sum: number; orders: number }>()
    for (const rc of receipts) {
      if (rc.isStorno) continue
      gross += num(rc.total)
      net += num(rc.subtotal)
      vat += num(rc.totalVat)
      covers += 1
      orderIds.add(rc.orderId)
      const m = ['cash', 'card', 'mobile'].includes(rc.paymentMethod) ? rc.paymentMethod : 'other'
      payTotals.set(m, Math.round(((payTotals.get(m) || 0) + num(rc.total)) * 100) / 100)
      const at = rc.createdAt instanceof Date ? rc.createdAt : null
      const ph = at ? at.getHours() : -1
      if (ph >= 0 && ph <= 23) {
        const cur = hourAgg.get(ph) ?? { sum: 0, orders: 0 }
        cur.sum += num(rc.total)
        cur.orders += 1
        hourAgg.set(ph, cur)
      }
    }
    const hourlyBuckets: HourlyEmailBucket[] = [...hourAgg.entries()]
      .map(([hour, agg]) => ({ hour, revenue: agg.sum, orders: agg.orders }))
    // v1.212.0 (OSS-10 C-del): top 3 artiklov v digestu SE ZDAJ RAZCEPLJAJO po
    // varianti (»Pizza · 0,5 L« ≠ »Pizza · 0,33 L«); dodatki razcepa ne naredijo.
    const items = orderIds.size
      ? await db.orderItem.findMany({
          where: { orderId: { in: [...orderIds] }, voided: false },
          select: {
            menuItemName: true,
            quantity: true,
            OrderItemModifier: {
              select: { name: true, ModifierGroup: { select: { required: true, maxSelect: true } } },
            },
          },
          take: 5000,
        })
      : []
    const topItems = aggregateSalesByVariant(items.map((it) => ({
      name: it.menuItemName,
      qty: it.quantity,
      modifiers: it.OrderItemModifier.map((m) => ({
        name: m.name,
        groupRequired: m.ModifierGroup?.required,
        groupMaxSelect: m.ModifierGroup?.maxSelect,
      })),
    }))).slice(0, 3)

    // digest sections are best-effort — a failure never blocks the e-mail
    const recurringToday = await loadRecurringToday()
    const overdueAps = args.overdueAps ?? (await loadOverdueApsForDigest(now))
    // §22 C: izpolnjenost seznamov dneva (fail-soft — brez ChecklistRun
    // tabele/ predlog sekcija preprosto izostane, digest OSTANE)
    const taskSummary = await loadTaskSummaryForDigest(from, args.locationId ?? null)

    const extra = Array.isArray(settings.emailReportRecipients)
      ? (settings.emailReportRecipients as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 5)
      : []
    const { subject, body } = dailyDigestEmailText({
      shiftId: `daily-${localDateKey(from)}`,
      shiftDate,
      from,
      to,
      locationId: args.locationId ?? null,
      gross: Math.round(gross * 100) / 100,
      net: Math.round(net * 100) / 100,
      vat: Math.round(vat * 100) / 100,
      covers,
      payments: [...payTotals.entries()].map(([method, amount]) => ({ method, amount })),
      topItems,
      hourlyBuckets,
      taskSummary,
      recurringToday,
      overdueAps,
      windowLabel: 'Dan',
    })
    await transport.sendMail({
      from: settings.emailFromAddress || undefined,
      to: settings.email,
      ...(extra.length > 0 ? { cc: extra.join(', ') } : {}),
      subject,
      text: body,
    })
    await db.scheduledEmailLog.create({
      data: {
        id: nid(),
        reportType,
        recipient: settings.email,
        subject,
        body,
        status: 'sent',
        sentAt: new Date(),
        reportDate: from,
      },
    })
    return { sent: true }
  } catch (e) {
    const error = String((e as Error).message || e).slice(0, 250)
    try {
      await db.scheduledEmailLog.create({
        data: {
          id: nid(),
          reportType,
          recipient: '(neznano)',
          subject: `RestaurantOS — dnevni povzetek (dan ${localDateKey(from)})`,
          body: '',
          status: 'failed',
          errorMessage: error,
          reportDate: from,
        },
      })
    } catch {
      // logging must never break the caller — swallow
    }
    return { sent: false, error }
  }
}

/**
 * OPS-10 val 3 — recurring PO rules due today (fail-soft, never throws).
 * Active rules with nextRun on today's local day, resolved to supplier names.
 */
async function loadRecurringToday(): Promise<RecurringTodayEntry[]> {
  try {
    const row = await db.integration.findFirst({ where: { name: 'recurring-po', type: 'other' } })
    const rules = dueTodayRules(parseRecurringConfig(row?.config), new Date())
    if (rules.length === 0) return []
    const supplierIds = [...new Set(rules.map((r) => r.supplierId).filter(Boolean))]
    const suppliers = supplierIds.length
      ? await db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
      : []
    const nameById = new Map(suppliers.map((s) => [s.id, s.name]))
    return rules.map((r) => ({
      supplier: nameById.get(r.supplierId) || '(dobavitelj)',
      itemCount: Array.isArray(r.items) ? r.items.length : 0,
      hour: r.hour,
    }))
  } catch {
    return []
  }
}

/**
 * Sends the summary (fail-soft, never throws) and writes a ScheduledEmailLog row
 * (status sent/failed). Returns silently when e-mail is not configured.
 */
export async function sendShiftDailySummary(d: ShiftSummaryData): Promise<void> {
  try {
    const settings = await findEmailSettings()
    if (!settings?.email) return
    const transport = await smtpTransportForLocation(d.locationId)
    if (!transport) return
    // OPS-10 val 3: digest section is best-effort — a failure never blocks the e-mail
    const recurringToday = d.recurringToday ?? (await loadRecurringToday())
    const extra = Array.isArray(settings.emailReportRecipients)
      ? (settings.emailReportRecipients as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 5)
      : []
    const { subject, body } = shiftSummaryEmailText({ ...d, recurringToday })
    await transport.sendMail({
      from: settings.emailFromAddress || undefined,
      to: settings.email,
      ...(extra.length > 0 ? { cc: extra.join(', ') } : {}),
      subject,
      text: body,
    })
    await db.scheduledEmailLog.create({
      data: {
        id: nid(),
        reportType: 'SHIFT_DAILY_SUMMARY',
        recipient: settings.email,
        subject,
        body,
        status: 'sent',
        sentAt: new Date(),
        reportDate: d.shiftDate,
      },
    })
  } catch (e) {
    try {
      await db.scheduledEmailLog.create({
        data: {
          id: nid(),
          reportType: 'SHIFT_DAILY_SUMMARY',
          recipient: '(neznano)',
          subject: `RestaurantOS — dnevni povzetek (izmena ${d.shiftId})`,
          body: '',
          status: 'failed',
          errorMessage: (e as Error).message.slice(0, 250),
          reportDate: d.shiftDate,
        },
      })
    } catch {
      // logging must never break the caller — swallow
    }
  }
}

/* ═══════ STREŽNI VAL v1.248.0 (§22 C) — POVZETKI OPRAVIL (nalagalca) ═══════ */

/**
 * Izpolnjenost seznamov za EN dan (digest sekcija). Fail-soft: brez
 * ChecklistRun tabele (DDL pending), brez predlog ali brez terminov → []
 * (sekcija izostane, digest ostane). Več lokacij: vrstica nosi ime
 * lokacije (renderer prikaže predpono samodejno, ko jih je več).
 */
export async function loadTaskSummaryForDigest(day: Date, locationId: string | null): Promise<TaskSummaryLine[]> {
  try {
    const locations = await db.location.findMany({
      ...(locationId ? { where: { id: locationId } } : {}),
      select: { id: true, name: true, timezone: true },
      take: 50,
    })
    if (locations.length === 0) return []
    const dayKey = localDateKey(day)
    const out: TaskSummaryLine[] = []
    for (const loc of locations) {
      const templates = (await loadChecklistTemplates(db, loc.id)).filter((t) => t.active)
      if (templates.length === 0) continue
      const tz = loc.timezone || 'Europe/Ljubljana'
      const due = templates
        .map((t) => ({ t, occ: checklistOccurrenceForDate(t, localDateFromKey(dayKey)!, tz) }))
        .filter((x) => x.occ !== null)
      if (due.length === 0) continue
      const keys = due.map((x) => x.occ!.key)
      const runs = await db.checklistRun.findMany({
        where: { locationId: loc.id, occurrenceKey: { in: keys } },
        select: { occurrenceKey: true, itemResults: true, completedById: true },
      })
      const byKey = new Map(runs.map((r) => [r.occurrenceKey, r]))
      for (const { t } of due) {
        const key = `${t.id}|${dayKey}`
        const run = byKey.get(key)
        const results = run ? parseItemResults(run.itemResults) : {}
        const { done, total } = coverageOf(t, results)
        out.push({
          template: t.name,
          done,
          total,
          completed: runCompletedFromCoverage(t, results),
          location: locations.length > 1 ? loc.name : null,
        })
      }
    }
    return out
  } catch {
    // DDL pending / infra — sekvenca je best-effort, nikoli ne mine izjemo
    return []
  }
}

/**
 * TEDENSKI povzetek opravil (ponedelki, Lightspeed junij 2026 »weekly Tasks
 * summary emails«). Samostojno pismo z lastno varovalko že_poslano
 * (reportType TASK_WEEKLY + reportDate = ponedeljek tedna) — cron pokliče
 * ob ponedeljkih; prejšnji ISO teden (pon–ned) po LOKALNEM koledarju
 * strežnika (ista disciplina datumov kot digest okno).
 */
export async function sendWeeklyTaskSummary(args: { now?: Date; transportFactory?: (locationId: string | null) => Promise<DigestMailer | null> } = {}): Promise<{ sent: boolean; reason?: string }> {
  const now = args.now ?? new Date()
  // ponedeljek? (0 = ned … 1 = pon) — drugi dnevi so hitra izhodna pot
  if (now.getDay() !== 1) return { sent: false, reason: 'not_monday' }
  // ponedeljek tekočega tedna (reportDate) + prejšnji teden pon..ned
  const mondayThis = startOfDay(now)
  mondayThis.setDate(mondayThis.getDate() - (mondayThis.getDay() - 1))
  const weekStart = new Date(mondayThis)
  weekStart.setDate(weekStart.getDate() - 7)
  const weekEnd = new Date(mondayThis) // ekskluzivno (ponedeljek 00:00)
  const reportType = 'TASK_WEEKLY'
  try {
    const already = await db.scheduledEmailLog.findFirst({
      where: { reportType, status: 'sent', reportDate: weekStart },
      select: { id: true },
    })
    if (already) return { sent: false, reason: 'already_sent' }
    const settings = await findEmailSettings()
    if (!settings?.email) return { sent: false, reason: 'email_not_configured' }
    const transport = await (args.transportFactory ?? smtpTransportForLocation)(null)
    if (!transport) return { sent: false, reason: 'smtp_not_configured' }

    const rows = await loadWeeklyTaskRows(weekStart, weekEnd)
    const label = `${weekStart.toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit' })} – ${new Date(weekEnd.getTime() - 1).toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
    const email = weeklyTaskSummaryEmailText({ rows, weekLabel: label })
    if (!email) return { sent: false, reason: 'no_occurrences' }
    const extra = Array.isArray(settings.emailReportRecipients)
      ? (settings.emailReportRecipients as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 5)
      : []
    await transport.sendMail({
      from: settings.emailFromAddress || undefined,
      to: settings.email,
      ...(extra.length > 0 ? { cc: extra.join(', ') } : {}),
      subject: email.subject,
      text: email.body,
    })
    await db.scheduledEmailLog.create({
      data: {
        id: nid(),
        reportType,
        recipient: settings.email,
        subject: email.subject,
        body: email.body,
        status: 'sent',
        sentAt: new Date(),
        reportDate: weekStart,
      },
    })
    return { sent: true }
  } catch (e) {
    const error = String((e as Error).message || e).slice(0, 250)
    try {
      await db.scheduledEmailLog.create({
        data: {
          id: nid(),
          reportType,
          recipient: '(neznano)',
          subject: 'RestaurantOS — Opravila tedenski povzetek',
          body: '',
          status: 'failed',
          errorMessage: error,
          reportDate: weekStart,
        },
      })
    } catch {
      // logging must never break the caller — swallow
    }
    return { sent: false, reason: 'error' }
  }
}

/** Agregat predlog cez teden [weekStart, weekEnd) — pojavitve × zaključki × pokritost. */
async function loadWeeklyTaskRows(weekStart: Date, weekEnd: Date, locationId: string | null = null): Promise<WeeklyTaskRow[]> {
  try {
    const locations = await db.location.findMany({
      ...(locationId ? { where: { id: locationId } } : {}),
      select: { id: true, name: true, timezone: true },
      take: 50,
    })
    if (locations.length === 0) return []
    const out: WeeklyTaskRow[] = []
    for (const loc of locations) {
      const templates = (await loadChecklistTemplates(db, loc.id)).filter((t) => t.active)
      if (templates.length === 0) continue
      const tz = loc.timezone || 'Europe/Ljubljana'
      for (const t of templates) {
        let occurrences = 0
        let completedCount = 0
        const parts: { done: number; total: number }[] = []
        for (let d = new Date(weekStart); d < weekEnd; d.setDate(d.getDate() + 1)) {
          const occ = checklistOccurrenceForDate(t, localDateFromKey(localDateKey(d))!, tz)
          if (!occ) continue
          occurrences += 1
          parts.push({ done: 0, total: t.items.length })
        }
        if (occurrences === 0) continue
        const keys: string[] = []
        for (let d = new Date(weekStart); d < weekEnd; d.setDate(d.getDate() + 1)) {
          const occ = checklistOccurrenceForDate(t, localDateFromKey(localDateKey(d))!, tz)
          if (occ) keys.push(occ.key)
        }
        const runs = keys.length
          ? await db.checklistRun.findMany({
              where: { locationId: loc.id, occurrenceKey: { in: keys } },
              select: { occurrenceKey: true, itemResults: true },
            })
          : []
        const byKey = new Map(runs.map((r) => [r.occurrenceKey, r]))
        for (const key of keys) {
          const run = byKey.get(key)
          const results = run ? parseItemResults(run.itemResults) : {}
          const cov = coverageOf(t, results)
          if (runCompletedFromCoverage(t, results)) completedCount += 1
          const idx = keys.indexOf(key)
          if (idx >= 0 && parts[idx]) parts[idx] = cov
        }
        out.push({
          template: t.name,
          occurrences,
          completedCount,
          coveragePct: weeklyCoveragePct(parts),
          location: locations.length > 1 ? loc.name : null,
        })
      }
    }
    return out.sort((a, b) => a.template.localeCompare(b.template, 'sl'))
  } catch {
    return []
  }
}
