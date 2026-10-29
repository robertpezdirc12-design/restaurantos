import { NextRequest } from 'next/server'
import { requirePermission, isResponse, ok } from '@/lib/api'
import { dayKeyOf } from '@/lib/sales-by-hour'
import { forecastLabor } from '@/lib/labor-forecast'
import { loadLaborForecastInputs } from '@/lib/labor-forecast-data'

/** Meje zgodovinskega okna (dni nazaj): 7..90, privzeto 28. */
export function clampHistory(raw: string | null): number {
  // Number(null) in Number('') sta 0 — manjkajoč parameter MORA pasti na
  // privzeto (28), ne na spodnjo mejo 7.
  if (raw === null || String(raw).trim() === '') return 28
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 28
  return Math.min(90, Math.max(7, n))
}

/** Meje horizonta napovedi: 1..14, privzeto 7 (LF vzorec). */
export function clampHorizon(raw: string | null): number {
  if (raw === null || String(raw).trim() === '') return 7
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 7
  return Math.min(14, Math.max(1, n))
}

/**
 * P1-4 (v1.186.0) — GET /api/reports/labor-forecast?days=28&horizon=7
 *
 * Napoved dela (potrebne ure/priporočeno osebje po urah) za prihodnjih
 * `horizon` dni iz zgodovine neto prodaje (zadnjih `days` dni) + vrzeli
 * vs. načrtovane StaffShift izmene. Vsi viri nalaga skupni loader
 * src/lib/labor-forecast-data.ts (ENAK obračun kot export sekcija
 * labor-forecast — vzorec labor-coverage-data); vsa matematika poteka v
 * čistem sloju src/lib/labor-forecast.ts (0 DB uvozov).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.labour')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const days = clampHistory(url.searchParams.get('days'))
  const horizon = clampHorizon(url.searchParams.get('horizon'))

  const input = await loadLaborForecastInputs(user, days, horizon)
  const result = forecastLabor(input.history, input.scheduled, {
    avgWageCentsPerHour: input.wage.centsPerHour,
    horizonDays: horizon,
    // sidro = DANES: okno napovedi (jutri … danes+horizon) je natanko enako
    // oknu poizvedbe izmen v loaderju — vrzeli so vedno izračunljive.
    anchorDate: dayKeyOf(new Date()),
  })

  return ok({
    generatedAt: new Date().toISOString(),
    parameters: { historyDays: days, horizonDays: horizon },
    wage: input.wage,
    counts: input.counts,
    ...result,
  })
}
