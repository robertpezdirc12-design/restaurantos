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
 */
import { db } from '@/lib/db'
import { nid } from '@/lib/map'
import { smtpTransportForLocation } from '@/lib/reminders'
import { dueTodayRules, parseRecurringConfig } from '@/lib/recurring-po'

export interface RecurringTodayEntry {
  supplier: string
  itemCount: number
  /** scheduled hour (local) — rendered as HH:00 */
  hour: number
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

/** Pure text builder (unit-tested). */
export function shiftSummaryEmailText(d: ShiftSummaryData): { subject: string; body: string } {
  const avgCheck = d.covers > 0 ? d.net / d.covers : 0
  const subject = `RestavrantOS — dnevni povzetek (izmena ${fmtWindow(d.shiftDate)})`
  const lines: string[] = []
  lines.push('Dnevni povzetek prodaje')
  lines.push('')
  lines.push(`Izmena: ${fmtWindow(d.shiftDate)}`)
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
  lines.push('')
  lines.push('— Samodejno sporočilo RestavrantOS')
  return { subject, body: lines.join('\n') }
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
    const settings = await db.restaurantSettings.findFirst()
    if (!settings?.emailEnabled || !settings.email) return
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
          subject: `RestavrantOS — dnevni povzetek (izmena ${d.shiftId})`,
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
