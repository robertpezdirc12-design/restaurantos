import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, forbidden } from '@/lib/api'
import { jstr, jparse, num } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { runDueRecurringRules } from '@/lib/recurring-run'
import { sendDailyDigest, type OverdueApEntry } from '@/lib/daily-email'
import { pushEvent, apOverduePushPayload } from '@/lib/push'
import { runDailyLotAlerts } from '@/lib/lot-alert'
import {
  CRON_DAILY_MARKER,
  MAX_OVERDUE_APS,
  daysOverdue,
  filterOverdueAps,
  localDateKey,
  shouldRunDaily,
  startOfDay,
} from '@/lib/cron-daily'

/**
 * OPS-11 val 3 (v1.82.0) — daily Vercel cron: GET /api/cron/daily (POST accepted
 * too; Vercel always sends GET with header `Authorization: Bearer ${CRON_SECRET}`).
 *
 * Steps (each isolated in try/catch — a failing step never aborts the run):
 *   1. recurring — runDueRecurringRules({ actor: 'cron' }) — shared core with the
 *      UI route (draft POs for due recurring rules, RECURRING_PO_CREATED audit).
 *   2. apOverdue — open AccountsPayable with dueDate < today 00:00 (max 20):
 *      fire-and-forget AP_OVERDUE push per invoice + a "Zapadle obveznosti"
 *      section inside the digest.
 *   3. digest — sendDailyDigest() — yesterday's sales window + recurringToday +
 *      overdue-AP section; ScheduledEmailLog reportType 'DAILY_DIGEST'.
 *
 * Auth: CRON_SECRET set → timing-safe Bearer compare (Vercel cron); NOT set +
 * dev → admin/manager session only (curl-able with the login Bearer token);
 * NOT set + production → 401 fail-closed (issue #27 — session fallback ne sme
 * tiho nadomeščati manjkajoče skrivnosti na produkciji).
 *
 * Idempotency (Vercel retries): Integration marker 'cron-daily-state'
 * config { lastRunDate: 'YYYY-MM-DD' } — a same-day re-invocation returns
 * 200 { ran: false, reason: 'already_ran_today' } WITHOUT running the steps.
 * The marker is updated AFTER the steps (only a fully dispatched run locks the day).
 *
 * Audit: CRON_DAILY_RAN with details = steps summary (append-only).
 */

/** Timing-safe `Authorization: Bearer <secret>` check. */
function bearerMatches(headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const actual = Buffer.from(headerValue, 'utf8')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** CRON_SECRET → Bearer; dev brez skrivnosti → admin/manager session; produkcija
 *  brez CRON_SECRET → 401 fail-closed (issue #27 — prej je session fallback tekel
 *  tudi v produkciji: napačno/manjkajočo konfiguracijo bi tiho nadomestil z sejo). */
async function authorize(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const secret = process.env.CRON_SECRET
  if (secret) {
    if (!bearerMatches(req.headers.get('authorization'), secret)) {
      return fail('Neveljaven cron žeton (Authorization: Bearer <CRON_SECRET>).', 401)
    }
    return { userId: 'cron' }
  }
  // Issue #27: fail-closed v produkciji (uradni Vercel vzorec: manjkajoča skrivnost
  // = 401, NIKOLI fallback na sejo — sproži tudi recurring PO, AP_OVERDUE push in
  // dnevni digest, kar ni ročna operacija za prijavljene uporabnike). Dev
  // (NODE_ENV !== 'production') obdrži session pot za ročno testiranje.
  if (process.env.NODE_ENV === 'production') {
    return fail('CRON_SECRET ni nastavljen — produkcija zahteva CRON_SECRET (Vercel → Settings → Environment Variables; Vercel cron pošilja Authorization: Bearer <CRON_SECRET>).', 401)
  }
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!['ADMIN', 'MANAGER', 'OWNER'].includes(user.role)) return forbidden()
  return { userId: user.sub }
}

interface OverdueApRow {
  id: string
  apNumber: string
  totalAmount: unknown
  dueDate: Date
  status: string
  locationId: string | null
  Supplier: { name: string } | null
}

/** Overdue APs (open, dueDate < today 00:00) — DB filter + pure re-check/clamp. */
async function loadOverdueAps(now: Date): Promise<OverdueApRow[]> {
  const rows = await db.accountsPayable.findMany({
    where: { status: 'open', dueDate: { lt: startOfDay(now) } },
    orderBy: { dueDate: 'asc' },
    take: 50,
    // status is selected so the pure filterOverdueAps re-check can verify it
    select: { id: true, apNumber: true, totalAmount: true, dueDate: true, status: true, locationId: true, Supplier: { select: { name: true } } },
  })
  return filterOverdueAps(rows, now, MAX_OVERDUE_APS)
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const auth = await authorize(req)
  if (isResponse(auth)) return auth

  const now = new Date()
  const at = now.toISOString()
  const todayKey = localDateKey(now)
  const errors: string[] = []

  // 0) idempotency guard — Vercel cron may retry; the second same-day call is a no-op
  let lastRunDate: string | null = null
  let markerId: string | null = null
  try {
    const marker = await db.integration.findFirst({ where: { name: CRON_DAILY_MARKER, type: 'other' } })
    if (marker) {
      markerId = marker.id
      lastRunDate = jparse<{ lastRunDate?: string }>(marker.config, {}).lastRunDate || null
    }
  } catch (e) {
    // fail-open (a corrupted marker must not disable the daily job) but record it
    errors.push(`guard: ${String((e as Error).message || e).slice(0, 200)}`)
  }
  if (!shouldRunDaily(lastRunDate, now)) {
    return ok({ ran: false, at, reason: 'already_ran_today', ...(lastRunDate ? { lastRunDate } : {}) })
  }

  const steps: {
    recurring: { created: number; skipped: number }
    digest: { sent: boolean; reason?: string }
    apOverdue: { count: number }
    lotAlert: { count: number }
  } = {
    recurring: { created: 0, skipped: 0 },
    digest: { sent: false },
    apOverdue: { count: 0 },
    lotAlert: { count: 0 },
  }

  // 1) recurring purchase-order rules (shared core with the UI route)
  try {
    const run = await runDueRecurringRules({ actor: 'cron' })
    steps.recurring = { created: run.created.length, skipped: run.skipped }
    for (const err of run.errors) errors.push(`recurring: ${err}`)
  } catch (e) {
    errors.push(`recurring: ${String((e as Error).message || e).slice(0, 200)}`)
  }

  // 2) overdue supplier invoices — AP_OVERDUE push (fire-and-forget, max 20/day)
  let overdue: OverdueApRow[] = []
  try {
    overdue = await loadOverdueAps(now)
  } catch (e) {
    errors.push(`apOverdue: ${String((e as Error).message || e).slice(0, 200)}`)
  }
  steps.apOverdue = { count: overdue.length }
  for (const ap of overdue) {
    void pushEvent(
      'AP_OVERDUE',
      apOverduePushPayload({
        apNumber: ap.apNumber,
        supplierName: ap.Supplier?.name || '(dobavitelj)',
        amount: num(ap.totalAmount),
        daysOverdue: daysOverdue(ap.dueDate, now),
      }),
      { roles: ['accounting', 'manager'], locationId: ap.locationId ?? undefined },
    )
  }

  // 3) daily digest e-mail (receives the same overdue entries → "Zapadle obveznosti")
  // 3b) Issue #15 (v1.105.0): lot alerts — serije s PRETEKELIM izrecnim
  //     opozorilnim datumom (alertDate) → LOT_ALERT push (fire-and-forget,
  //     state marker preprečuje dnevno ponavljanje; brez alertDate brez opozorila)
  try {
    steps.lotAlert = { count: await runDailyLotAlerts(now) }
  } catch (e) {
    errors.push(`lotAlert: ${String((e as Error).message || e).slice(0, 200)}`)
  }
  try {
    const overdueEntries: OverdueApEntry[] = overdue.map((ap) => ({
      apNumber: ap.apNumber,
      supplier: ap.Supplier?.name || '(dobavitelj)',
      daysOverdue: daysOverdue(ap.dueDate, now),
      amount: num(ap.totalAmount),
    }))
    const digest = await sendDailyDigest({ overdueAps: overdueEntries })
    steps.digest = digest.sent ? { sent: true } : { sent: false, ...(digest.reason ? { reason: digest.reason } : {}) }
    if (digest.error) errors.push(`digest: ${digest.error}`)
  } catch (e) {
    errors.push(`digest: ${String((e as Error).message || e).slice(0, 200)}`)
  }

  // 4) persist the idempotency marker (after a fully dispatched run)
  try {
    const cfgJson = JSON.stringify({ lastRunDate: todayKey, lastRunAt: at })
    if (markerId) {
      await db.integration.update({ where: { id: markerId }, data: { config: cfgJson } })
    } else {
      await db.integration.create({
        data: {
          id: `cron-daily-${Date.now().toString(36)}`,
          name: CRON_DAILY_MARKER,
          type: 'other',
          provider: 'internal',
          config: cfgJson,
          isActive: true,
          syncEnabled: false,
        },
      })
    }
  } catch (e) {
    errors.push(`marker: ${String((e as Error).message || e).slice(0, 200)}`)
  }

  // 5) audit (append-only; never fails the response)
  try {
    await writeAudit(db, { userId: auth.userId, action: 'CRON_DAILY_RAN', entityType: 'System', entityId: `cron-daily-${todayKey}`, details: jstr({ steps, errors }) })
  } catch {
    // audit must never break the cron response
  }

  return ok({ ran: true, at, steps, ...(errors.length > 0 ? { errors } : {}) })
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
