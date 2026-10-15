import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { guardResource, assertOrgScope } from '@/lib/tenant'
import { mapMenuItem, mapCategory, nid, num, jstr, stationToUI } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { getMenuItemAllergenProfiles } from '@/lib/allergen-profile'
import { validateStationsForLocation } from '@/lib/station-task-service'

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  // Task 51 (UX pregled): opcijski filter lokacije — naročilni dialog naj ne bi
  // mešal menijev različnih lokacij (server v ops.ts ostane avtoritativa; tukaj
  // samo UX scoping). staff = VEDNO svoja lokacija; centralna vloga = ?locationId=
  // ali vse (Vse lokacije — upravljanje menija ostaja nespremenjeno).
  let locFilter: string | null = null
  if (!isCentralRole(user)) {
    locFilter = user.loc ?? null
  } else {
    const q = req.nextUrl.searchParams.get('locationId')
    if (q && q.trim()) locFilter = q.trim()
  }
  const [items, categories] = await Promise.all([
    db.menuItem.findMany({
      where: locFilter ? { Category: { Menu: { locationId: locFilter } } } : undefined,
      include: { Category: { include: { Menu: { select: { locationId: true } } } }, PrepStation: true },
      orderBy: { name: 'asc' },
    }),
    db.category.findMany({
      where: locFilter ? { Menu: { locationId: locFilter } } : undefined,
      orderBy: { sortOrder: 'asc' }, take: 200,
    }),
  ])
  // Issue #7 (P1, v1.104.0): BULK alergenski profili za prikaz stanja v meni tabu
  const allergenSummaries = await getMenuItemAllergenProfiles(items.map((m) => m.id)).catch(
    () => new Map<string, { codes: string[]; status: 'confirmed' | 'review_required' | 'needs_confirmation'; reviewFlag: boolean }>(),
  )
  // Issue #14 (v1.112.0): usmeritve postaj PO artikelu (M:N) za urejevalnik
  // usmerjanja (nastavitve kartica); pre-DDL → prazni seznami (graceful)
  let stationRows: { menuItemId: string; stationId: string }[] = []
  try {
    stationRows = await db.menuItemStation.findMany({
      where: { menuItemId: { in: items.map((m) => m.id) } },
      select: { menuItemId: true, stationId: true },
    })
  } catch {
    // DDL pending (MenuItemStation) — brez usmeritev
  }
  const stationsByItem = new Map<string, string[]>()
  for (const r of stationRows) {
    const arr = stationsByItem.get(r.menuItemId) ?? []
    arr.push(r.stationId)
    stationsByItem.set(r.menuItemId, arr)
  }
  return ok({
    items: items.map((m) => {
      // Issue #7 (P1, v1.104.0): alergenski povzetek artiklov (status + kode +
      // zastavica) — meni tab prikaže stanje in odpre dialog za potrditev/popravek.
      // Padec izračuna (pred DDL) NE podre seznama — povzetek manjka, UI degradira.
      const p = allergenSummaries.get(m.id)
      return {
        ...mapMenuItem({ ...m, prepStation: m.PrepStation }),
        // Issue #14: trenutne usmeritve (idji postaj; primarna + dodatne)
        prepStationId: m.prepStationId ?? null,
        stationIds: stationsByItem.get(m.id) ?? [],
        allergenStatus: p?.status ?? 'needs_confirmation',
        allergenCodes: p?.codes ?? [],
        allergenReviewFlag: p?.reviewFlag ?? false,
      }
    }),
    categories: categories.map(mapCategory),
  })
}

export async function POST(req: NextRequest) {
  // Issue #4 §1: inline role check → kanonično dovoljenje menu.manage
  const user = await requirePermission(req, 'menu.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  if (!body?.name || body?.price === undefined) return fail('Ime in cena sta obvezna.')
  // Issue #4 §10: forsiraj lokacijo — staff = svoja, centralna lahko poda body.locationId
  const locId = requireUserLocation(user, body?.locationId)
  if (isResponse(locId)) return locId
  const orgGuard = await assertOrgScope(user, locId)
  if (orgGuard) return orgGuard
  const categoryId = body.categoryId || (await db.category.findFirst())?.id
  if (!categoryId) return fail('Kategorija ne obstaja. Ustvari kategorijo in meni najprej.', 400)
  // Issue #4 §1: kategorija mora pripadati lokaciji (MenuItem nima locationId — lanec do Menu.locationId)
  const cat = await db.category.findUnique({
    where: { id: categoryId },
    select: { Menu: { select: { locationId: true } } },
  })
  if (!cat) return fail('Kategorija ne obstaja. Ustvari kategorijo in meni najprej.', 400)
  if (!isCentralRole(user)) {
    const catLocRes = await guardResource(user, cat.Menu?.locationId)
    if (catLocRes) return catLocRes
  } else if (body?.locationId && cat.Menu?.locationId !== locId) {
    return fail('Kategorija ne pripada podani lokaciji.', 400)
  }
  let prepStationId: string | null = null
  const itemLocationId = cat.Menu?.locationId ?? locId
  // Issue #14 (v1.112.0): EKSPlicitNA postaja (id, strežniško preverjena + lokacijsko
  // obsegovana) ima prednost pred legacy bucket izbiro (body.station BAR/KITCHEN —
  // zgodovinsko je iskanje potekalo BREZ lokacijskega filtra: tu popravljeno).
  if (typeof body.prepStationId === 'string' && body.prepStationId.trim()) {
    const ps = await db.prepStation.findUnique({ where: { id: body.prepStationId.trim() }, select: { id: true, locationId: true } })
    if (!ps || ps.locationId !== itemLocationId) return fail('Postaja ne obstaja na tej lokaciji.', 400)
    prepStationId = ps.id
  } else if (body.station) {
    const ps = await db.prepStation.findFirst({
      where: { type: stationToUI(body.station) === 'BAR' ? 'bar' : 'kitchen', locationId: itemLocationId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    prepStationId = ps?.id ?? null
  }
  // Issue #14: dodatne postaje artikla (M:N — MenuItemStation), strežniško preverjene
  let extraStationIds: string[] = []
  if (body.stationIds !== undefined) {
    const check = await validateStationsForLocation(body.stationIds, itemLocationId)
    if (!check.ok) return fail(check.error, check.status)
    extraStationIds = check.ids.filter((sid) => sid !== prepStationId)
  }
  const item = await db.menuItem.create({
    data: {
      id: nid(),
      name: String(body.name),
      price: Number(body.price),
      description: String(body.description || ''),
      categoryId,
      vatRate: Number(body.taxRate ?? body.vatRate) || 22,
      isAvailable: body.available !== false,
      prepStationId,
    },
  })
  if (extraStationIds.length > 0) {
    try {
      await db.menuItemStation.createMany({
        data: extraStationIds.map((sid) => ({ id: nid(), menuItemId: item.id, stationId: sid, locationId: itemLocationId })),
      })
    } catch {
      // DDL pending — usmeritev se aktivira po migrate-kds-stations
    }
  }
  // 33-c (audit §6): kreiranje artikla menija je zdaj revidirano (prej brez revizije)
  await writeAudit(db, { userId: user.sub, action: 'MENU_ITEM_CREATE', entityType: 'MenuItem', entityId: item.id, details: jstr({ name: item.name, price: Number(item.price), vatRate: Number(item.vatRate), categoryId, prepStationId, stationIds: extraStationIds }), locationId: cat.Menu?.locationId ?? locId })
  return ok({ item: mapMenuItem(item), prepStationId, stationIds: extraStationIds }, 201)
}
