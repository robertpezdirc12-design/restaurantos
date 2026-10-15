import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { reasonKindColumnAvailable } from '@/lib/exception-approval'

/**
 * Issue #5 (komentar #3): katalog razlogov preklica postavke (VoidReason — model
 * obstaja v shemi od N3, bil je mrtev). Seznam aktivnih razlogov za obseg
 * uporabnika (locationScope — razlogi so lokacijski). Branje potrebuje
 * orders.void (isti nabor kot sam preklic — UI izbirnik).
 *
 * Issue #19 (v1.107.0, P1/P2): katalog je razširjen iz »samo void« v katalog
 * razlogov VSEH finančnih izjem (kind: void|discount|cancel|storno|any) + CRUD
 * za pooblaščene osebe (settings.manage — politika izjem je vodstvena
 * konfiguracija, ne natakarjeva). DDL-gated (migrate-exception-reasons):
 *  - GET ?kind=<vrsta> (privzeto 'void' — vzdržuje dosedanji POS izbirnik):
 *    vrne razloge svojega kind-a + 'any'. Brez DDL: kind stolpca ni → vse
 *    vrstice so 'void' (dosedanja semantika; kind izpuščen iz odgovora).
 *  - POST   { name, kind?, requireComment?, locationId? } — ustvari (settings.manage)
 *  - PATCH  { id, name? | isActive? | sortOrder? | requireComment? } — uredi
 *    (settings.manage + guardResource — tuje lokacije zavrnjene)
 *  - DELETE ?id= — samo ČE razlog ni v uporabi (OrderItem.voidReasonId sled);
 *    sicer 409 z navodilom deaktivacije (zgodovina ostane nespremenjena).
 *
 * Baza: OSNOVNA polja (id/name/isActive/sortOrder/locationId) gredo prek
 * tipiziranega Prisma klienta (glavna shema); DDL stolpca kind/requireComment
 * gresta prek OZNAČENE PREDLOGE $queryRaw/$executeRaw (parametrizirano za oba
 * dialekta — brez niz interpolacije uporabniških vnosov).
 */
const CATALOG_KINDS = ['void', 'discount', 'cancel', 'storno', 'any'] as const
type CatalogKind = (typeof CATALOG_KINDS)[number]

function parseKind(v: string | null): CatalogKind {
  const k = String(v ?? '').toLowerCase()
  return (CATALOG_KINDS as readonly string[]).includes(k) ? (k as CatalogKind) : 'void'
}

interface ReasonRow {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  locationId: string
  kind: string
  requireComment: boolean
}

/** Katalog vrstica z kind/requireComment (DDL-gated; brez DDL → 'void'/false). */
async function readReason(id: string): Promise<ReasonRow | null> {
  const base = await db.voidReason.findUnique({ where: { id } })
  if (!base) return null
  if (!(await reasonKindColumnAvailable())) {
    return { id: base.id, name: base.name, isActive: !!base.isActive, sortOrder: base.sortOrder, locationId: base.locationId, kind: 'void', requireComment: false }
  }
  const rows = await db.$queryRaw<{ kind: string; requireComment: number }[]>`
    SELECT "kind", "requireComment" FROM "VoidReason" WHERE "id" = ${id} LIMIT 1`
  const r = rows?.[0]
  return {
    id: base.id,
    name: base.name,
    isActive: !!base.isActive,
    sortOrder: base.sortOrder,
    locationId: base.locationId,
    kind: r?.kind || 'void',
    requireComment: !!r?.requireComment,
  }
}

export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'orders.void')
  if (isResponse(user)) return user
  const kind = parseKind(req.nextUrl.searchParams.get('kind'))
  const scope = await locationScope(user)

  // 1) lokacijsko-obsegana baza (tipiziran klient — obstoječa varnostna pot)
  const allowed = await db.voidReason.findMany({
    where: { isActive: true, ...scope },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 200,
    select: { id: true, name: true, sortOrder: true },
  })
  if (allowed.length === 0) return ok({ voidReasons: [], kind })

  // 2) kind/requireComment (DDL-gated) — ena raw poizvedba za vse dovoljene
  if (!(await reasonKindColumnAvailable())) {
    // brez DDL: dosedanja semantika (vse vrstice = void) — izpišemo samo za void
    const out = kind === 'void' ? allowed.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sortOrder })) : []
    return ok({ voidReasons: out, kind })
  }
  const ids = allowed.map((a) => a.id)
  // Prisma.join — IN seznam, deluje na OBA dialekta (SQLite zavrača gola polja)
  const rows = await db.$queryRaw<{ id: string; kind: string; requireComment: number }[]>`
    SELECT "id", "kind", "requireComment" FROM "VoidReason" WHERE "id" IN (${Prisma.join(ids)})`
  const kindById = new Map(rows.map((r) => [r.id, r]))
  const wanted = kind === 'any' ? (CATALOG_KINDS as readonly string[]) : [kind, 'any']
  const merged = allowed
    .map((a) => {
      const k = kindById.get(a.id)
      return { id: a.id, name: a.name, sortOrder: a.sortOrder, kind: k?.kind || 'void', requireComment: !!k?.requireComment }
    })
    .filter((m) => wanted.includes(m.kind))
  return ok({ voidReasons: merged.slice(0, 50), kind })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''
  if (name.length < 2) return fail('Ime razloga je obvezno (vsaj 2 znaka).', 400)
  const kind = parseKind(typeof body?.kind === 'string' ? body.kind : 'void')
  const requireComment = body?.requireComment === true

  if (!(await reasonKindColumnAvailable())) {
    return fail('Katalog vrst razlogov čaka DDL korak (Enterprise → Shema migracije → exception-reasons).', 503)
  }

  const locationId = requireUserLocation(user, body?.locationId)
  if (typeof locationId !== 'string') return locationId
  const loc = await db.location.findUnique({ where: { id: locationId }, select: { id: true } })
  if (!loc) return fail('Lokacija ne obstaja.', 400)

  // osnovna polja prek tipiziranega klienta (varna parametrizacija)
  const created = await db.voidReason.create({
    data: { id: nid(), name, isActive: true, sortOrder: 0, locationId },
    select: { id: true },
  })
  // DDL stolpca prek parametrizirane raw predloge — BOOLEAN param (NE 1/0:
  // Postgres zavrne integer → boolean pretvorbo; SQLite prek Prisma mapira na 0/1)
  await db.$executeRaw`UPDATE "VoidReason" SET "kind" = ${kind}, "requireComment" = ${requireComment} WHERE "id" = ${created.id}`

  await writeAudit(db, {
    userId: user.sub,
    action: 'EXCEPTION_REASON_CREATED',
    entityType: 'VoidReason',
    entityId: created.id,
    details: jstr({ name, kind, requireComment, locationId, by: user.name }),
    locationId,
  })
  return ok({ reason: { id: created.id, name, kind, requireComment } }, 201)
}

export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id) return fail('id je obvezen.', 400)

  const row = await readReason(id)
  if (!row) return fail('Razlog ne obstaja.', 404)
  const guard = await guardResource(user, row.locationId)
  if (guard) return guard

  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : row.name
  if (name.length < 2) return fail('Ime razloga je obvezno (vsaj 2 znaka).', 400)
  const isActive = typeof body?.isActive === 'boolean' ? body.isActive : row.isActive
  const sortOrder = body?.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder)) ? Math.max(0, Math.trunc(Number(body.sortOrder))) : row.sortOrder
  const requireComment = typeof body?.requireComment === 'boolean' ? body.requireComment : row.requireComment

  const changed: string[] = []
  if (name !== row.name) changed.push('name')
  if (isActive !== row.isActive) changed.push('isActive')
  if (sortOrder !== row.sortOrder) changed.push('sortOrder')
  if (requireComment !== row.requireComment) changed.push('requireComment')
  if (changed.length === 0) return ok({ reason: row, changed: [] })

  await db.voidReason.update({
    where: { id },
    data: { name, isActive, sortOrder },
  })
  if (changed.includes('requireComment') && (await reasonKindColumnAvailable())) {
    await db.$executeRaw`UPDATE "VoidReason" SET "requireComment" = ${requireComment} WHERE "id" = ${id}`
  }
  await writeAudit(db, {
    userId: user.sub,
    action: 'EXCEPTION_REASON_UPDATED',
    entityType: 'VoidReason',
    entityId: id,
    details: jstr({ changed, name, isActive, sortOrder, requireComment, by: user.name }),
    locationId: row.locationId,
  })
  return ok({ reason: { ...row, name, isActive, sortOrder, requireComment }, changed })
}

export async function DELETE(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const id = (req.nextUrl.searchParams.get('id') || '').trim()
  if (!id) return fail('id je obvezen (query).', 400)

  const row = await readReason(id)
  if (!row) return fail('Razlog ne obstaja.', 404)
  const guard = await guardResource(user, row.locationId)
  if (guard) return guard

  // V uporabi? OrderItem.voidReasonId nosi zgodovinske preklice — brisanje
  // razloga v uporabi bi odsekalo konteksto (ime razloga živi sicer kot snapshot
  // v auditu, a vrstica OrderItem kaže na razlog). Zahtevamo deaktivacijo.
  const used = await db.orderItem.count({ where: { voidReasonId: id } })
  if (used > 0) {
    return fail(`Razlog je v uporabi (${used} postavk) — deaktivirajte ga (isActive=false), izbrisati lahko samo neuporabljenega.`, 409)
  }

  await db.voidReason.delete({ where: { id } })
  await writeAudit(db, {
    userId: user.sub,
    action: 'EXCEPTION_REASON_DELETED',
    entityType: 'VoidReason',
    entityId: id,
    details: jstr({ name: row.name, kind: row.kind, by: user.name }),
    locationId: row.locationId,
  })
  return ok({ deleted: true })
}
