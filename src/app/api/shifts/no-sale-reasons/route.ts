import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, forbidden, isCentralRole, requireUserLocation } from '@/lib/api'
import { nid } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'

/**
 * Issue #16 (P1/P2, v1.108.0) — katalog razlogov za blagajniške premike.
 *
 * NOVA uporaba OBSTOJEČEGA modela NoSaleReason (dosedaj popolnoma speč —
 * nikoli brez rute; issue #16 ga je predvidel prav za "no-sale" premike):
 * lokacijsko-scoped kategorizacija vplačil/izplačil/odvodov. Ni vzporednega
 * sistema razlogov — ista disciplina kot VoidReason v #19.
 *
 *  - GET    (cash.manage): aktivni razlogi lokacije (POS izbirnik)
 *  - POST/PATCH/DELETE (settings.manage): urejanje kataloga (vodstvo)
 *    + guardResource na lokaciji vrstice. Brisanje v uporabi ni mogoče
 *    (CashMovement.reasonId posnetek ostaja, a katalog ne sme tiho izginiti)
 *    → namesto brisanja deaktivacija (isActive=false, 409 pri odstranjevanju
 *    uporabljenega razloga).
 */
const NAME_MAX = 60

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'cash.manage')
  if (isResponse(user)) return user
  const locationId = requireUserLocation(user, new URL(req.url).searchParams.get('locationId'))
  if (typeof locationId !== 'string') return locationId
  const reasons = await db.noSaleReason.findMany({
    where: { locationId, isActive: true },
    orderBy: { sortOrder: 'asc' },
    take: 200,
    select: { id: true, name: true, sortOrder: true },
  })
  return ok({ reasons })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Manjkajo podatki.')
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : ''
  if (name.length < 2) return fail('Ime razloga je obvezno (vsaj 2 znaki).')
  const locationId = requireUserLocation(user, body.locationId)
  if (typeof locationId !== 'string') return locationId
  const sortOrder = Number(body.sortOrder ?? 0)

  const dup = await db.noSaleReason.findFirst({ where: { name, locationId } })
  if (dup) return fail('Razlog s tem imenom že obstaja na lokaciji.', 409)

  const reason = await db.noSaleReason.create({
    data: { id: nid(), name, isActive: true, sortOrder: Number.isFinite(sortOrder) ? Math.trunc(sortOrder) : 0, locationId },
  })
  await writeAudit(db, {
    userId: user.sub,
    action: 'NO_SALE_REASON_CREATE',
    entityType: 'NoSaleReason',
    entityId: reason.id,
    details: JSON.stringify({ name, locationId }),
    locationId,
  })
  return ok({ reason }, 201)
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Manjkajo podatki.')
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return fail('Manjka id.')
  const reason = await db.noSaleReason.findUnique({ where: { id } })
  if (!reason) return fail('Razlog ne obstaja.', 404)

  // tenant: staff IZKLJUČNO lastna lokacija vrstice (centralna vloga org-obseg
  // prek requireUserLocation pri pisanju — enaka disciplina kot void-reasons)
  if (!isCentralRole(user)) {
    if (!user.loc || reason.locationId !== user.loc) return forbidden()
  } else if (user.loc && reason.locationId !== user.loc && body.locationId === undefined) {
    // centralna vloga brez izrecne lokacije ureja samo svojo
    return forbidden()
  }

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, NAME_MAX)
    if (name.length < 2) return fail('Ime razloga je obvezno (vsaj 2 znaki).')
    data.name = name
  }
  if (typeof body.isActive === 'boolean') data.isActive = body.isActive
  if (body.sortOrder !== undefined) {
    const so = Number(body.sortOrder)
    if (Number.isFinite(so)) data.sortOrder = Math.trunc(so)
  }
  if (Object.keys(data).length === 0) return fail('Ni sprememb.')

  const updated = await db.noSaleReason.update({ where: { id }, data })
  await writeAudit(db, {
    userId: user.sub,
    action: 'NO_SALE_REASON_UPDATE',
    entityType: 'NoSaleReason',
    entityId: id,
    details: JSON.stringify({ changed: Object.keys(data), locationId: reason.locationId }),
    locationId: reason.locationId,
  })
  return ok({ reason: updated })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!id) return fail('Manjka id.')
  const reason = await db.noSaleReason.findUnique({ where: { id } })
  if (!reason) return fail('Razlog ne obstaja.', 404)
  if (!isCentralRole(user)) {
    if (!user.loc || reason.locationId !== user.loc) return forbidden()
  }

  // uporabljen v premikih? posnetki reasonId ostanejo, a katalog NE sme tiho
  // izginiti iz izbire brez sledu → 409 + deaktivacija (mehka). Pre-DDL
  // (tabela še ne obstaja) uporabe preprosto ni — preskoči preverbo.
  const { cashMovementsAvailable } = await import('@/lib/cash-movements')
  if (await cashMovementsAvailable()) {
    const used = await db.cashMovement.findFirst({ where: { reasonId: id } })
    if (used) {
      return fail(
        'Razlog je uporabljen v zgodovini premikov — izbrišite ga lahko šele po ' +
          'deaktivaciji (isActive=false) brez novih knjiženj.',
        409,
      )
    }
  }
  await db.noSaleReason.delete({ where: { id } })
  await writeAudit(db, {
    userId: user.sub,
    action: 'NO_SALE_REASON_DELETE',
    entityType: 'NoSaleReason',
    entityId: id,
    details: JSON.stringify({ name: reason.name, locationId: reason.locationId }),
    locationId: reason.locationId,
  })
  return ok({ deleted: id })
}
