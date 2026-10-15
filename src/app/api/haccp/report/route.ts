import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, isResponse, ok, fail, locationScope } from '@/lib/api'
import { num } from '@/lib/map'
import type { HaccpCategory } from '@/lib/prisma-types'
import { haccpReportCsv, haccpOpsColumnsReady, stateOfEntry } from '@/lib/haccp-ops'

/**
 * Issue #20 (P1/P2, v1.109.0) — filtrirano poročilo HACCP kontrol z izvozom.
 *
 * GET ?from=&to=&category=&state=&format=csv|json
 *  - obdobje (from/to ISO datum; privzeto zadnjih 30 dni),
 *  - kategorija (temperature/cleaning/…), stanje (done/deviation/…),
 *  - CSV: BOM + `;` + Content-Disposition (računovodska konvencija projekta),
 *    vrstice so sledljive do originalnega zapisa (ID).
 *
 * Revizijska doktrina (issue): zapis vsebuje korektivni ukrep + verifikacijo
 * (iz HaccpAction dogodkov — append-only), izvedelca, meritev, načrt (posnetek
 * imena) in stanje. Sistem NE izbriše ničesar — retencija je dokler lokacija
 * hrani podatke; nadzoru se predloži ta izvoz. Sistem je orodje dosledne
 * izvedbe HACCP načel (852/2004 čl. 5), NE pa nadomestilo odgovorne osebe.
 *
 * Dovoljenja: settings.manage ALI haccp.execute + tenant sloj (locationScope).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  if (!ctx.perms.includes('settings.manage') && !ctx.perms.includes('haccp.execute')) {
    return fail('Dostop zavrnjen — manjka dovoljenje: settings.manage | haccp.execute.', 403)
  }
  const user = ctx.user
  if (!(await haccpOpsColumnsReady())) {
    return fail('Poročilo še ni aktivirano — zahteva DDL korak na strežniku (/api/admin/migrate-haccp-ops).', 503)
  }

  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const category = url.searchParams.get('category')
  const state = url.searchParams.get('state')
  const format = (url.searchParams.get('format') || 'json').toLowerCase()

  const toDate = (v: string | null, fallback: Date): Date | null => {
    if (!v) return fallback
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const now = new Date()
  const dateFrom = toDate(from, new Date(now.getTime() - 30 * 24 * 3600 * 1000))
  const dateTo = toDate(to, now)
  if (!dateFrom || !dateTo) return fail('from/to morata biti veljavna datuma (ISO).', 400)
  if (dateFrom > dateTo) return fail('from mora biti pred to.', 400)
  // zgornja meja vključi cel dan "to"
  const dayEnd = new Date(dateTo.getTime() + 24 * 3600 * 1000)

  const entries = await db.haccpEntry.findMany({
    where: {
      ...(await locationScope(user)),
      date: { gte: dateFrom, lte: dayEnd },
      ...(category ? { category: category as HaccpCategory } : {}),
      ...(state ? { entryState: state } : {}),
    },
    orderBy: { date: 'desc' },
    take: 2000,
  })
  const entryIds = entries.map((e) => e.id)
  const actions = entryIds.length
    ? await db.haccpAction.findMany({ where: { entryId: { in: entryIds } }, orderBy: { createdAt: 'asc' } })
    : []
  const actionsByEntry = new Map<string, typeof actions>()
  for (const a of actions) {
    const list = actionsByEntry.get(a.entryId) || []
    list.push(a)
    actionsByEntry.set(a.entryId, list)
  }

  const rows = entries.map((e) => {
    const list = actionsByEntry.get(e.id) || []
    const corrective = list.filter((a) => a.kind === 'corrective').map((a) => a.note).join(' | ')
    const verifications = list
      .filter((a) => a.kind === 'verify')
      .map((a) => (a.method === 'recheck' ? `ponovni odčitek ${a.recheckValue === null ? '' : num(a.recheckValue)}: ${a.outcome}` : `potrditev vodje (${a.performedByName})`))
      .join(' | ')
    const planLabel = e.planName || e.title
    return {
      id: e.id,
      date: e.date.toISOString().slice(0, 16).replace('T', ' '),
      planName: planLabel,
      category: String(e.category),
      target: e.title,
      value:
        e.numericValue !== null && e.numericValue !== undefined
          ? `${num(e.numericValue)} ${e.unit || ''}`.trim()
          : e.value || (e.measureKind === 'confirm' ? (e.status === 'ok' ? 'OK' : 'NE V REDU') : ''),
      status: e.status,
      state: e.planId ? e.entryState : stateOfEntry({ entryState: e.entryState, status: e.status }),
      corrective,
      verified: verifications,
      employee: e.employeeName || '',
    }
  })

  if (format === 'csv') {
    const csv = haccpReportCsv(rows)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="haccp-porocilo-${dateFrom.toISOString().slice(0, 10)}_${dateTo.toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    })
  }
  return ok({ rows, count: rows.length, from: dateFrom.toISOString(), to: dateTo.toISOString() })
}
