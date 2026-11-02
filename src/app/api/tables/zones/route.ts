import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * POST /api/tables/zones — v1.233.0 (PRIMERJAVA-VMESNIKOV-2026 §4, ZADNJA
 * vrzel restavracije 21/22 → 22/22): UREDJEVALNIK CON kot samostojen objekt
 * (Toast/TouchBistro praksa — cone se upravljajo skupaj, ne miza-po-mizi).
 *
 * Telo: { from: string, to: string, locationId?: string }.
 * Operacija: vse mize lokacije s cono `from` dobejo cono `to` (updateMany —
 * ena operacija, ne N klicev PATCH). Pokriva OBE UI dejanji: PREIMENUJ
 * (prosto besedilo) in ZDRUŽI (izbira obstoječe ciljne cone) — za DB je to
 * ista sprememba area, razliko naredi samo UI.
 *
 * Varnost: cona je konfiguracija prostora → menu.manage (enako kot PATCH
 * number/seats/zone na /api/tables/[id]); lokacijska disciplina enaka
 * POST /api/tables (requireUserLocation + assertOrgScope — centralna vloga
 * MORA poslati locationId, osebje = lastna lokacija). Cona je vedno
 * znotraj ENOJNE lokacije — preimenovanje čez lokacije ni mogoče (varno).
 *
 * Revizija: ZONE_RENAME z { from, to, count } — en zapis na operacijo
 * (ne N TABLE_UPDATE vrstic po mizi).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const from = String(body?.from ?? '').trim()
  const to = String(body?.to ?? '').trim()
  if (!from) return fail('Ime cone je obvezno.')
  if (!to) return fail('Novo ime cone je obvezno.')
  if (to.length > 40) return fail('Ime cone je lahko dolgo največ 40 znakov.')
  if (from === to) return fail('Novo ime je enako staremu.')

  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const res = await db.table.updateMany({ where: { area: from, locationId }, data: { area: to } })
  if (res.count === 0) return fail('Cona ne obstaja (ali nima miz).', 404)

  await writeAudit(db, {
    userId: user.sub,
    action: 'ZONE_RENAME',
    entityType: 'Table',
    entityId: locationId,
    details: jstr({ from, to, count: res.count }),
    locationId,
  })
  return ok({ updated: res.count, from, to })
}
