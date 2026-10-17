import { NextRequest } from 'next/server'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { laborCoverageReport } from '@/lib/labor-coverage'
import { loadLaborCoverageData, resolveLaborCoverageWindow } from '@/lib/labor-coverage-data'

/**
 * GET /api/reports/labor-coverage?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId?&jobId?
 *
 * Issue #10 (P2, v1.117.0) — Strošek dela in napoved pokritosti izmen glede na
 * prodajo (brez AI, 0 novih tabel — čisti izračuni nad Order/TimeEntry/
 * StaffShift/EmployeeJob/Job/Location).
 *
 *  - from/to: privzeto zadnjih 28 dni (to = danes po UTC); 400 slab format,
 *    400 from > to, clamp to > danes → danes, okno ≤ LCOV_MAX_DAYS (90);
 *  - locationId: neobvezen filter z varovalkami (404 neznana → guardResource
 *    403 fail-closed → 403 izven obsega); brez njega = cel locationScope;
 *  - jobId: filter SAMO na labor strani (TimeEntry + StaffShift) — prodaja
 *    NI vezana na vlogo (dokumentirano: naročila so lokacijska, ne vloga);
 *  - dow/hour NISTA query parametra: vračamo CELO 7×24 matriko (majhna,
 *    filtri so client-side v UI — 10-design odločitev).
 *
 * Izhod: {parameters, days, hours (7×24), roles, totals, dataQuality,
 * forecast {method, days, coverage}} + generatedAt (datum doda RUTA —
 * motor je determinističen, čista funkcija vhodov).
 *
 * PII: izhod vsebuje SAMO agregate (dnevi/ure/vloge) — BREZ vrstic po
 * zaposlenem; osebni plačni detalji ostanejo v obračunu (employees.manage).
 * Audit: NE (read-only poročilo — vzorec labor-cost/sbh poročil).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.labour')
  if (isResponse(user)) return user

  const url = new URL(req.url)
  const win = resolveLaborCoverageWindow(url.searchParams.get('from'), url.searchParams.get('to'))
  if ('error' in win) return fail(win.error, 400)

  const locationId = url.searchParams.get('locationId')
  const jobId = url.searchParams.get('jobId')

  const data = await loadLaborCoverageData(user, win.from, win.to, locationId, jobId)
  if (isResponse(data)) return data

  const report = laborCoverageReport(data.input)
  return ok({ ...report, generatedAt: new Date().toISOString() })
}
