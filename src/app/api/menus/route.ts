import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, requireUserLocation, assertResourceLocation, isCentralRole, isResponse, ok, fail } from '@/lib/api'
import { mapMenuItem, mapCategory, nid, num, jstr, stationToUI } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

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
  return ok({
    items: items.map((m) => mapMenuItem({ ...m, prepStation: m.PrepStation })),
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
  const categoryId = body.categoryId || (await db.category.findFirst())?.id
  if (!categoryId) return fail('Kategorija ne obstaja. Ustvari kategorijo in meni najprej.', 400)
  // Issue #4 §1: kategorija mora pripadati lokaciji (MenuItem nima locationId — lanec do Menu.locationId)
  const cat = await db.category.findUnique({
    where: { id: categoryId },
    select: { Menu: { select: { locationId: true } } },
  })
  if (!cat) return fail('Kategorija ne obstaja. Ustvari kategorijo in meni najprej.', 400)
  if (!isCentralRole(user)) {
    const catLocRes = assertResourceLocation(user, cat.Menu?.locationId)
    if (catLocRes) return catLocRes
  } else if (body?.locationId && cat.Menu?.locationId !== locId) {
    return fail('Kategorija ne pripada podani lokaciji.', 400)
  }
  let prepStationId: string | null = null
  if (body.station) {
    const ps = await db.prepStation.findFirst({
      where: { type: stationToUI(body.station) === 'BAR' ? 'bar' : 'kitchen' },
    })
    prepStationId = ps?.id ?? null
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
  // 33-c (audit §6): kreiranje artikla menija je zdaj revidirano (prej brez revizije)
  const __aId = nid(); const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'MENU_ITEM_CREATE',
    entityType: 'MenuItem',
    entityId: item.id,
    details: jstr({ name: item.name, price: Number(item.price), vatRate: Number(item.vatRate), categoryId }),
    locationId: cat.Menu?.locationId ?? locId,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'MENU_ITEM_CREATE',
      entityType: 'MenuItem',
      entityId: item.id,
      details: jstr({ name: item.name, price: Number(item.price), vatRate: Number(item.vatRate), categoryId }),
      locationId: cat.Menu?.locationId ?? locId,
    },
  })
  return ok({ item: mapMenuItem(item) }, 201)
}
