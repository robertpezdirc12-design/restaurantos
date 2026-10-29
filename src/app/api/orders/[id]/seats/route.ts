import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requirePermission, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { parseSeatAssignments, seatOverview } from '@/lib/seat-assignments'
import { seatsColumnAvailable } from '@/lib/seat-db'

/**
 * P3 #20 (v1.193.0) — SEAT-LEVEL management: dodelitev sedežev postavkam.
 *
 * GET  /api/orders/[id]/seats → pregled po sedežih (ne-voided postavke, skupine
 *                               naraščajoče, »brez sedeža« zadnji; vsote po sedežu)
 * PUT  /api/orders/[id]/seats { assignments: [{ seat, itemIds }] }
 *                              → POLNI nadomestni načrt: omenjene postavke dobijo
 *                                sedež, neomenjene ga izgubijo (idempotentno,
 *                                odjemalec pošlje celotno sedežno razporeditev;
 *                                prazen seznam = počisti vse sedeže).
 *
 * Zakaj LOČENA ruta in ne del Obstoječih rut: sedež je oznaka IZVORA postavke
 * (kdo jo je naročil — Square seat-level), ortogonalna izstavkom (Check = plačilna
 * skupina) in tekom (Course) — čista metapodatka naročila, ki ju kasneje izkoristi
 * split po sedežih (POST /api/orders/[id]/checks/seats) in pregledi. Odjemalec NE
 * sme biti vir resnice — validacija in pisanje sta strežniški, atomski v transakciji,
 * enkrat revizijsko označeni (ORDER_SEAT_ASSIGN z načrtom).
 *
 * Pravila (isti konservativni okvir kot split po gostih/izstavkih):
 *  - dovoljenje `orders.pay` (namen: plačilni dialog — upravljanje izstavkov/sedežev);
 *  - SAMO dokler ni plačan še noben izstavek IN noben izstavek nima plačila;
 *  - delitev samo dokler je naročilo odprto (ne paid/cancelled);
 *  - samo ne-voided postavke TEGA naročila (tuj ali voided id → 400);
 *  - sedež 1..10 (MAX_SEAT) — zgornja meja enaka split po gostih;
 *  - dokler DDL stolpca ni apliciran (produkcijski Neon), rute odgovarjajo 503 z
 *    jasnim sporočilom — nikoli tihe odpovedi (isti politiki kot capability probe).
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  if (!(await seatsColumnAvailable())) {
    return fail('Sedeži niso na voljo: shematska migracija »sedeži« še ni aplicirana (konzola Enterprise → Shema migracije).', 503)
  }

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard

  const items = order.OrderItem.filter((it) => !it.voided).map((it) => ({
    id: it.id,
    name: it.menuItemName,
    quantity: it.quantity,
    price: Number(it.price),
    seat: it.seat ?? null,
    voided: it.voided,
  }))
  return ok({ overview: seatOverview(items), items })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'orders.pay')
  if (isResponse(user)) return user
  const { id } = await params
  if (!(await seatsColumnAvailable())) {
    return fail('Sedeži niso na voljo: shematska migracija »sedeži« še ni aplicirana (konzola Enterprise → Shema migracije).', 503)
  }

  const body = await req.json().catch(() => null)
  const parsed = parseSeatAssignments(body)
  if (!parsed.ok) return fail(parsed.error, 400)

  const order = await db.order.findUnique({ where: { id }, include: { OrderItem: true } })
  if (!order) return fail('Naročilo ne obstaja.', 404)
  const guard = await guardResource(user, order.locationId)
  if (guard) return guard
  if (order.status === 'paid' || order.status === 'cancelled' || order.paymentStatus === 'paid') {
    return fail('Zaključenemu naročilu ni mogoče spreminjati sedežev.', 409)
  }

  const checks = await db.check.findMany({
    where: { orderId: id },
    orderBy: { checkNumber: 'asc' },
    include: { _count: { select: { Payment: true } } },
  })
  if (checks.some((c) => c.paymentStatus === 'paid')) {
    return fail('Sedeži se urejajo samo dokler ni plačan še noben izstavek.', 409)
  }
  if (checks.some((c) => c._count.Payment > 0)) {
    return fail('Izstavek s plačilom ne dovoljuje spremembe sedežev.', 409)
  }

  // vsi navedeni id-ji morajo biti ne-voided postavke TEGA naročila
  const byId = new Map(order.OrderItem.filter((it) => !it.voided).map((it) => [it.id, it]))
  for (const a of parsed.assignments) {
    for (const itemId of a.itemIds) {
      if (!byId.has(itemId)) {
        return fail(`Postavka ${itemId} ne pripada temu naročilu (ali je voided).`, 400)
      }
    }
  }

  const result = await db.$transaction(async (tx) => {
    // polni nadomestni: najprej počisti, potem dodeli omenjene
    await tx.orderItem.updateMany({ where: { orderId: id, voided: false }, data: { seat: null } })
    let assigned = 0
    for (const a of parsed.assignments) {
      const r = await tx.orderItem.updateMany({ where: { id: { in: a.itemIds }, voided: false }, data: { seat: a.seat } })
      assigned += r.count
    }
    return assigned
  })

  const items = order.OrderItem.filter((it) => !it.voided).map((it) => ({
    id: it.id,
    name: it.menuItemName,
    quantity: it.quantity,
    price: Number(it.price),
    seat: parsed.assignments.find((a) => a.itemIds.includes(it.id))?.seat ?? null,
    voided: it.voided,
  }))

  await writeAudit(db, {
    userId: user.sub,
    action: 'ORDER_SEAT_ASSIGN',
    entityType: 'Order',
    entityId: id,
    details: jstr({ assigned: result, by: user.name, assignments: parsed.assignments }),
    locationId: order.locationId,
  })

  return ok({ assigned: result, overview: seatOverview(items) })
}
