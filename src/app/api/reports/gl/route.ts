/**
 * OPS-8 val 3 (v1.73.0) — GL dnevnik (orientation) — automatic DAILY sales journal.
 *
 * GET /api/reports/gl?from=YYYY-MM-DD&to=YYYY-MM-DD   (reports.view)
 *
 * For each DAY in the range with at least one receipt it builds (and PERSISTS,
 * idempotently) a JournalEntry that balances:
 *   debit  101 Blagajna                = cash payments of the day
 *   debit  204 Terjatve od kupcev      = card / other non-cash payments
 *   credit 401 Prihodki od prodaje     = net sales
 *   debit  402 Vrnjena prodaja/popusti = discounts (contra revenue)
 *   credit 221 Obveznosti za davke     = VAT
 * Balancing rule (incl. rounding drift and mismatch absorption) is documented in
 * src/lib/gl.ts → buildGlEntry.
 *
 * Idempotency: one entry per day, entryNumber `GL-YYYYMMDD-01` (unique). If the
 * entry already exists it is returned from the DB untouched. If persistence fails
 * (e.g. missing table) the route responds 200 with `persisted: false` and the
 * computed preview — never a 500 — so the UI can always render the orientation view.
 */
import { NextRequest } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope } from '@/lib/api'
import { nid, num, r2 } from '@/lib/map'
import { seedStandardAccounts, buildGlEntry, glEntryNumber, glMemo } from '@/lib/gl'
import type { AccountType } from '@/lib/prisma-types'

export const dynamic = 'force-dynamic'

const dayIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

interface DayAgg {
  cash: number
  nonCash: number
  net: number
  vat: number
  discounts: number
  receipts: number
}

interface GlEntryView {
  date: string
  entryNo: string
  memo: string
  persisted: boolean
  adjustedAccount: string | null
  lines: { accountCode: string; accountName: string; debit: number; credit: number }[]
  debit: number
  credit: number
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const now = new Date()
  const fromP = url.searchParams.get('from')
  const toP = url.searchParams.get('to')
  const from = fromP ? new Date(`${fromP}T00:00:00`) : (() => { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d })()
  const to = toP ? new Date(`${toP}T23:59:59.999`) : now
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return fail('Neveljaven datum (pričakovano YYYY-MM-DD).', 400)
  if (from > to) return fail('Datum "from" je za datumom "to".', 400)

  const startDay = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const endDay = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  const spanDays = Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000) + 1
  if (spanDays > 370) return fail('Obdobje je predolgo (največ 370 dni).', 400)

  // Issue #4 §1: location-scoped like the other report routes.
  // Issue #5 (P0, komentar #6): payScope prej ročni centralni bypass {} = plačila VSEH
  // organizacij pomešana z org-scoped računi. Zdaj org allow-lista prek Check → Order.
  const locScope = await locationScope(user)
  const payScope = { Check: { Order: locScope } }
  // scopeKey — deterministični hash niza lokacij obsega (idempotenca PO organizaciji;
  // vključno z osebjem z eno lokacijo — en same set = enak ključ = deljen vnos)
  const scopeKey = (() => {
    const lid = locScope.locationId
    if (typeof lid === 'string') return createHash('sha256').update(lid).digest('hex').slice(0, 8)
    if (lid && typeof lid === 'object' && Array.isArray((lid as { in: string[] }).in)) {
      const ids = [...(lid as { in: string[] }).in].sort()
      if (ids.length === 0) return 'EMPTY'
      return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 8)
    }
    return '*' // bootstrap / neznana org — globalni break-glass
  })()
  const range = { gte: startDay, lte: to }

  const [receipts, payments] = await Promise.all([
    db.receipt.findMany({
      // storno receipts keep their NEGATIVE amounts (FURS-consistent) — the 402
      // balancing rule absorbs the payment-side asymmetry (see buildGlEntry).
      where: { createdAt: range, ...locScope },
      select: { createdAt: true, subtotal: true, totalVat: true, discount: true },
      take: 50000,
    }),
    db.payment.findMany({
      where: { createdAt: range, status: 'completed', ...payScope },
      select: { createdAt: true, type: true, amount: true },
      take: 50000,
    }),
  ])

  const byDay = new Map<string, DayAgg>()
  const ensure = (k: string): DayAgg => {
    let a = byDay.get(k)
    if (!a) {
      a = { cash: 0, nonCash: 0, net: 0, vat: 0, discounts: 0, receipts: 0 }
      byDay.set(k, a)
    }
    return a
  }
  for (const rc of receipts) {
    const a = ensure(dayIso(rc.createdAt))
    a.receipts += 1
    a.net += num(rc.subtotal)
    a.vat += num(rc.totalVat)
    a.discounts += num(rc.discount)
  }
  for (const p of payments) {
    const a = ensure(dayIso(p.createdAt))
    if (p.type === 'cash') a.cash += num(p.amount)
    else a.nonCash += num(p.amount)
  }

  // Lazy, idempotent seed of the standard SI accounts (once per process).
  // Failure → preview-only mode (persisted: false), never a 500.
  let seedOk = true
  try {
    await seedStandardAccounts()
  } catch {
    seedOk = false
  }

  const entries: GlEntryView[] = []
  let persistFailed = false
  const cur = new Date(startDay)
  while (cur <= endDay) {
    const k = dayIso(cur)
    cur.setDate(cur.getDate() + 1)
    const agg = byDay.get(k)
    if (!agg || agg.receipts === 0) continue
    // Issue #5: entryNumber po obsegu — tuja organizacija ima DRUG ključ → najden
    // vnos je vedno LASTNI obseg (prej: globalni GL-YYYYMMDD-01 = tuje vrstice)
    const entryNo = glEntryNumber(k, scopeKey)

    const existing = await db.journalEntry.findUnique({
      where: { entryNumber: entryNo },
      include: { JournalLine: { orderBy: { createdAt: 'asc' as const } } },
    })
    if (existing) {
      const lines = existing.JournalLine.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, debit: num(l.debit), credit: num(l.credit) }))
      entries.push({
        date: k,
        entryNo,
        memo: existing.description,
        persisted: true,
        adjustedAccount: null,
        lines,
        debit: r2(lines.reduce((s, l) => s + l.debit, 0)),
        credit: r2(lines.reduce((s, l) => s + l.credit, 0)),
      })
      continue
    }

    const preview = buildGlEntry({
      cash: r2(agg.cash),
      nonCash: r2(agg.nonCash),
      netSales: r2(agg.net),
      vatTotal: r2(agg.vat),
      discountsTotal: r2(agg.discounts),
    })
    const view: GlEntryView = {
      date: k,
      entryNo,
      memo: glMemo(k),
      persisted: false,
      adjustedAccount: preview.adjustedAccount,
      lines: preview.lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, debit: l.debit, credit: l.credit })),
      debit: preview.debits,
      credit: preview.credits,
    }

    if (seedOk) {
      try {
        await db.journalEntry.create({
          data: {
            id: nid(),
            entryNumber: entryNo,
            date: new Date(`${k}T12:00:00`),
            description: glMemo(k),
            source: 'auto',
            status: 'posted',
            postedAt: new Date(),
            postedBy: 'avtomatika',
            locationId: user.loc || null,
            JournalLine: {
              create: preview.lines.map((l) => ({
                id: nid(),
                accountCode: l.accountCode,
                accountName: l.accountName,
                accountType: l.accountType as AccountType,
                debit: l.debit,
                credit: l.credit,
                description: 'Avtomatski dnevni obračun prodaje',
                chartOfAccountCode: l.accountCode,
                locationId: user.loc || null,
              })),
            },
          },
        })
        view.persisted = true
      } catch {
        // concurrent create (unique entryNumber) or schema/table problem → preview stays
        persistFailed = true
      }
    } else {
      persistFailed = true
    }
    entries.push(view)
  }

  const totals = {
    debits: r2(entries.reduce((s, e) => s + e.debit, 0)),
    credits: r2(entries.reduce((s, e) => s + e.credit, 0)),
  }

  return ok({ from: dayIso(startDay), to: dayIso(endDay), persisted: !persistFailed, entries, totals })
}
