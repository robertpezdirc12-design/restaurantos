import { NextRequest } from 'next/server'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { db } from '@/lib/db'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { parseSurchargeRates } from '@/lib/payroll-rates'
import {
  lookupSurchargeRates,
  saveSurchargeRates,
  surchargeRatesTableReady,
} from '@/lib/payroll-rates-store'

/**
 * N-27-3 (v1.197.0, docs/TRZNA-VRZELI-2027.md) — konfiguracija NOG DOPLAČIL.
 *
 * GET  /api/payroll/surcharge-rates?locationId=X   (brez parametra = privzete/NULL)
 *   → { rates: null } (niso nastavljene) | { rates: { locationId, source, ... } }
 *     source 'location' = vrstica lokacije; 'default' = pad na NULL vrstico.
 * PUT  /api/payroll/surcharge-rates { locationId?: string|null, nightPct, sundayPct,
 *      holidayPct, overtimePct }
 *   → validacija prek čistega sloja (0..100, ≤ 2 decimali, vsa štiri polja
 *     obvezna — manjkajoče polje je napaka, NE tiha nula); upsert; audit
 *     PAYROLL_SURCHARGE_RATES_UPDATED.
 *
 * ISKRENOST: noga je uporabniški vhod po kolektivni pogodbi — sistem ne trdi,
 * da je zakonska; zakonitost potrdi zunanji payroll sistem (biro).
 *
 * Zgradbe: requirePermission('employees.manage') (ista pravica kot obračun,
 * tab obracun); do DDL (PayrollSurchargeRate) → 503 (graceful — obračun sam
 * ostane delujoč, samo minute brez zneskov).
 */

function ratesDto(r: Awaited<ReturnType<typeof lookupSurchargeRates>>) {
  if (!r) return null
  return {
    locationId: r.locationId,
    source: r.source,
    nightPct: r.nightPct,
    sundayPct: r.sundayPct,
    holidayPct: r.holidayPct,
    overtimePct: r.overtimePct,
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await surchargeRatesTableReady())) {
    return fail('Noge doplačil čakajo na shemsko migracijo (Enterprise → Shema migracije → payroll-surcharge-rates).', 503)
  }
  const url = new URL(req.url)
  const locationIdParam = url.searchParams.get('locationId')
  const locationId = locationIdParam && locationIdParam.trim() !== '' ? locationIdParam.trim() : null
  const guarded = await guardResource(user, locationId)
  if (guarded) return guarded
  const rates = await lookupSurchargeRates(locationId)
  return ok({ rates: ratesDto(rates) })
}

export async function PUT(req: NextRequest) {
  const user = await requirePermission(req, 'employees.manage')
  if (isResponse(user)) return user
  if (!(await surchargeRatesTableReady())) {
    return fail('Noge doplačil čakajo na shemsko migracijo (Enterprise → Shema migracije → payroll-surcharge-rates).', 503)
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Manjka telo zahteve.', 400)

  const locationId =
    body.locationId === undefined || body.locationId === null || String(body.locationId).trim() === ''
      ? null
      : String(body.locationId).trim()
  const guarded = await guardResource(user, locationId)
  if (guarded) return guarded

  const parsed = parseSurchargeRates(body)
  if (!parsed.ok) return fail(parsed.error, 400)

  const saved = await saveSurchargeRates(locationId, parsed.rates, user.sub)
  await writeAudit(db, {
    userId: user.sub,
    action: 'PAYROLL_SURCHARGE_RATES_UPDATED',
    entityType: 'PayrollSurchargeRate',
    entityId: locationId ?? 'default',
    details: jstr({
      locationId,
      source: saved.source,
      nightPct: saved.nightPct,
      sundayPct: saved.sundayPct,
      holidayPct: saved.holidayPct,
      overtimePct: saved.overtimePct,
    }),
    locationId,
  })
  return ok({ rates: ratesDto(saved) })
}
