import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, requireUserLocation, locationScope, isResponse, ok, fail, isCentralRole } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #14 (P1/P2, v1.112.0) — KDS poimenovane postaje: CRUD.
 *
 * GET  /api/prep-stations — seznam postaj lokacije (AKTIVNE + neaktivne, z
 *      številom vezanih artiklov) za nastavitveno ploščo. Dovoljenje:
 *      kitchen.update (kuhinja/šank/vodstvo vidi postaje svoje lokacije —
 *      nastavitvena kartica je render-gated na settings.manage, branje ni
 *      občutljivo; isti prag kot KDS vrsta).
 *      + ?active=true → samo aktivne (postajni izbirnik).
 *
 * POST /api/prep-stations — USTVARI postajo (settings.manage + lokacijski
 *      obseg + org scope — konfiguracija je vodstveno dejanje):
 *      {name, type?, avgPrepTime?, sortOrder?, isExpo?, isActive?, locationId?}
 *      - name: 1..60 znakov, enoličnost na lokaciji (409)
 *      - type: slug ^[a-z0-9_-]{1,30}$ (privzeto 'kitchen'; 'bar'/'kitchen'
 *        ohranjata legacy vedra; 'expo' priporočamo izraziti z isExpo flagom)
 *      - avgPrepTime: 1..60 min (clamp), sortOrder: 0..999, isExpo: izdajna
 *      - audit PREP_STATION_CREATE (brez PII)
 */
const TYPE_RE = /^[a-z0-9_-]{1,30}$/

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'kitchen.update')
  if (isResponse(user)) return user
  const activeOnly = new URL(req.url).searchParams.get('active') === 'true'
  const locParam = new URL(req.url).searchParams.get('locationId')
  let scope: { locationId?: string | { in: string[] } }
  if (locParam && isCentralRole(user)) {
    const orgGuard = await assertOrgScope(user, locParam)
    if (orgGuard) return orgGuard
    scope = { locationId: locParam }
  } else {
    scope = await locationScope(user)
  }
  const stations = await db.prepStation.findMany({
    where: { ...(activeOnly ? { isActive: true } : {}), ...scope },
    select: {
      id: true, name: true, type: true, avgPrepTime: true, isActive: true, sortOrder: true, isExpo: true, createdAt: true,
      _count: { select: { MenuItem: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return ok({
    stations: stations.map((s) => ({
      id: s.id, name: s.name, type: s.type, avgPrepTime: s.avgPrepTime,
      isActive: s.isActive, sortOrder: s.sortOrder, isExpo: s.isExpo,
      menuItemCount: s._count.MenuItem,
    })),
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.name || typeof body.name !== 'string') return fail('Ime postaje je obvezno (1–60 znakov).')
  const name = body.name.trim().slice(0, 60)
  if (!name) return fail('Ime postaje je obvezno (1–60 znakov).')

  const locId = requireUserLocation(user, body?.locationId)
  if (isResponse(locId)) return locId
  const orgGuard = await assertOrgScope(user, locId)
  if (orgGuard) return orgGuard

  let type = typeof body.type === 'string' && body.type.trim() ? body.type.trim().toLowerCase() : 'kitchen'
  if (!TYPE_RE.test(type)) return fail('Tip postaje: male črke/številke/-/_ (največ 30).')
  const rawAvg = Math.round(Number(body.avgPrepTime ?? 15))
  const avgPrepTime = Number.isFinite(rawAvg) ? Math.min(60, Math.max(1, rawAvg)) : 15
  const rawSort = Math.round(Number(body.sortOrder ?? 0))
  const sortOrder = Number.isFinite(rawSort) ? Math.min(999, Math.max(0, rawSort)) : 0
  const isExpo = body.isExpo === true
  const isActive = body.isActive !== false

  // enoličnost imena na lokaciji (dve postaji z istim imenom bi zmedli KDS)
  const dupe = await db.prepStation.findFirst({ where: { locationId: locId, name }, select: { id: true } })
  if (dupe) return fail('Postaja s tem imenom že obstaja na tej lokaciji.', 409)

  const station = await db.prepStation.create({
    data: { id: nid(), name, type, avgPrepTime, sortOrder, isExpo, isActive, locationId: locId },
    select: { id: true, name: true, type: true, avgPrepTime: true, sortOrder: true, isExpo: true, isActive: true },
  })
  await writeAudit(db, {
    userId: user.sub, action: 'PREP_STATION_CREATE', entityType: 'PrepStation', entityId: station.id,
    details: jstr({ name, type, avgPrepTime, sortOrder, isExpo, isActive }),
    locationId: locId,
  })
  return ok({ station }, 201)
}
