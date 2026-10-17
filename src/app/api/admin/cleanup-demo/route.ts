import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireCentralRole, isResponse, ok, fail } from '@/lib/api'
import { nid, ORDER_ACTIVE_DB } from '@/lib/map'

/**
 * Issue #71 audit-9 — ENKRATNO čiščenje demo/verifikacijskih sledi iz PRODUKCIJE.
 *
 * Problem: osebje v živem okolju vidi zapise, ki so jih pustili verifikacijski
 * testi/e2e skripti (»verify96 dobavitelj«, popisi »verify100 — event write pot«,
 * »Ana Demo (Manager)«, »Super Admin superadmin@restaurantos.local«, HACCP načrt
 * »VERIF hlajenje vitrina 1«, »I15 Testna sestavina prod15«) in ZASTARELI listki
 * v KDS vrsti (22 h / 60 h / 245 h stari). Lastnik ne zaupa seznamom, ki mešajo
 * demo z realnim poslovanjem.
 *
 * Varnostna zasnova:
 *  - mode='scan' (privzeto): SAMO branje — vrne števce + vzorce po kategorijah,
 *    nič se ne spremeni (lastnik pregleda, kaj bi bilo izbrisano);
 *  - mode='purge' zahteva confirm='IZBRISI-DEMO' (eksplicitno potrditev besedila);
 *  - brisanje je po VRSTICAH z try/catch — FK-referenčirani zapisi (npr. zaposleni
 *    z naročili) se ne izbrišejo, ampak se izpišejo kot »preskočeno (razlog)«,
 *    kjer je varno, se deaktivirajo;
 *  - zastarele LISTKE se ne brišejo (fiskalna sled!) — zaključijo se kot
 *    preklicane in miza gre v 'cleaning' (enak tok kot običajni zaključek).
 *  - celoten poseg se zapiše v revizijski dnevnik (AUDIT_DEMO_CLEANUP).
 *
 * Prepreka za prihodnje sledi: e2e/verifikacijski skripti morajo svoje zapise
 * brisati ob koncu (to ruto pokličejo z mode='purge', confirm, names=[...]).
 */
const CONFIRM_PHRASE = 'IZBRISI-DEMO'

/** Šest kategorij demo vzorcev — namerno OZKI vzorci (ne požirajo pravih podatkov). */
const RX = {
  employeeName: /^(verify\d*|ana demo|super admin|demo|test\w*)\b/i,
  employeeEmail: /(verify\d*@|superadmin@restaurantos\.local|^demo@|^test@)/i,
  supplier: /^(verify\d*|demo|test\w*)\b/i,
  stocktake: /verify\d*|— event write|— serializacija|demo popis/i,
  haccpPlan: /^(verif|demo|test)\w*\b/i,
  menuItem: /(testna sestavina|^verify\d*\b|^demo test|^i\d+ test)/i,
}

const STALE_H = 8

export async function POST(req: NextRequest) {
  const user = await requireCentralRole(req)
  if (isResponse(user)) return user

  let body: { mode?: string; confirm?: string } = {}
  try { body = (await req.json()) as typeof body } catch { /* prazno telo = scan */ }
  const purge = body.mode === 'purge'
  if (purge && body.confirm !== CONFIRM_PHRASE) {
    return fail(`Potrditevčiščenje zahteva besedilo »${CONFIRM_PHRASE}« v confirm polju.`, 400)
  }

  /* ── 1) Zastareli listki: aktivna naročila, starejša od 8 h (demo/prejšnja izmena) ── */
  const staleCutoff = new Date(Date.now() - STALE_H * 3600_000)
  const staleOrders = await db.order.findMany({
    where: { status: { in: ORDER_ACTIVE_DB }, createdAt: { lt: staleCutoff } },
    select: { id: true, orderNumber: true, createdAt: true, status: true, tableId: true },
    orderBy: { createdAt: 'asc' },
  })

  /* ── 2) Demo zaposleni ── */
  // celoten nabor v pomnilniku (restavracija: < 100 zaposlenih) — regex nad imenom
  // ALI e-pošto (Prisma contains ne zmore alternacije verify\d*|demo|test)
  const demoEmployees = await db.employee.findMany({
    select: { id: true, name: true, email: true, status: true },
  })
  const employeesHit = demoEmployees.filter(
    (e) => RX.employeeName.test(e.name) || RX.employeeEmail.test(e.email ?? ''),
  )

  /* ── 3) Demo dobavitelji ── */
  const demoSuppliers = (await db.supplier.findMany({ select: { id: true, name: true } }))
    .filter((s) => RX.supplier.test(s.name))

  /* ── 4) Demo popisi ── */
  const demoStocktakes = (await db.stocktake.findMany({ select: { id: true, note: true, status: true } }))
    .filter((st) => RX.stocktake.test(st.note ?? ''))

  /* ── 5) Demo HACCP načrti ── */
  const demoHaccpPlans = (await db.haccpPlan.findMany({ select: { id: true, name: true } }))
    .filter((p) => RX.haccpPlan.test(p.name))

  /* ── 6) Demo meni artikli ── */
  const demoMenuItems = (await db.menuItem.findMany({ select: { id: true, name: true } }))
    .filter((m) => RX.menuItem.test(m.name))

  const scan = {
    staleOrders: {
      count: staleOrders.length,
      samples: staleOrders.slice(0, 8).map((o) => `#${o.orderNumber ?? o.id.slice(0, 6)} · ${o.status} · ${new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`),
      action: 'zaključijo se kot preklicane (fiskalna sled ostane), miza → cleaning',
    },
    demoEmployees: {
      count: employeesHit.length,
      samples: employeesHit.slice(0, 8).map((e) => `${e.name} <${e.email ?? '—'}> (${e.status})`),
      action: 'izbrisani; FK-referenčirani → deaktivirani',
    },
    demoSuppliers: {
      count: demoSuppliers.length,
      samples: demoSuppliers.slice(0, 8).map((s) => s.name),
      action: 'izbrisani (FK-referenčirani preskočeni)',
    },
    demoStocktakes: {
      count: demoStocktakes.length,
      samples: demoStocktakes.slice(0, 8).map((st) => st.note || st.id),
      action: 'izbrisani skupaj s postavkami',
    },
    demoHaccpPlans: {
      count: demoHaccpPlans.length,
      samples: demoHaccpPlans.slice(0, 8).map((p) => p.name),
      action: 'izbrisani (FK-referenčirani preskočeni)',
    },
    demoMenuItems: {
      count: demoMenuItems.length,
      samples: demoMenuItems.slice(0, 8).map((m) => m.name),
      action: 'izbrisani (FK-referenčirani preskočeni)',
    },
  }

  if (!purge) {
    return ok({ mode: 'scan', scan, hint: `Za izvedbo: mode='purge', confirm='${CONFIRM_PHRASE}'` })
  }

  /* ═══════════ PURGE (potrjeno z besedilom) ═══════════ */
  const results: Record<string, { changed: number; skipped: string[] }> = {
    staleOrders: { changed: 0, skipped: [] },
    demoEmployees: { changed: 0, skipped: [] },
    demoSuppliers: { changed: 0, skipped: [] },
    demoStocktakes: { changed: 0, skipped: [] },
    demoHaccpPlans: { changed: 0, skipped: [] },
    demoMenuItems: { changed: 0, skipped: [] },
  }

  // 1) zastareli listki → preklic (NE brisanje — fiskalna/interna sled)
  for (const o of staleOrders) {
    try {
      await db.order.update({ where: { id: o.id }, data: { status: 'cancelled', cancelledAt: new Date() } })
      if (o.tableId) {
        await db.table.update({ where: { id: o.tableId }, data: { status: 'cleaning' } }).catch(() => undefined)
      }
      results.staleOrders.changed++
    } catch (e) {
      results.staleOrders.skipped.push(`#${o.orderNumber ?? o.id}: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  // 2) demo zaposleni — brisanje, FK → deaktivacija
  for (const e of employeesHit) {
    try {
      await db.employee.delete({ where: { id: e.id } })
      results.demoEmployees.changed++
    } catch {
      try {
        await db.employee.update({ where: { id: e.id }, data: { status: 'inactive' } })
        results.demoEmployees.changed++
        results.demoEmployees.skipped.push(`${e.name}: FK-reference → deaktiviran (ne izbrisan)`)
      } catch (e2) {
        results.demoEmployees.skipped.push(`${e.name}: ${(e2 as Error).message.slice(0, 80)}`)
      }
    }
  }

  // 3) demo dobavitelji
  for (const s of demoSuppliers) {
    try {
      await db.supplier.delete({ where: { id: s.id } })
      results.demoSuppliers.changed++
    } catch (e) {
      results.demoSuppliers.skipped.push(`${s.name}: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  // 4) demo popisi (postavke kaskadirajo)
  for (const st of demoStocktakes) {
    try {
      await db.stocktake.delete({ where: { id: st.id } })
      results.demoStocktakes.changed++
    } catch (e) {
      results.demoStocktakes.skipped.push(`${st.note || st.id}: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  // 5) demo HACCP načrti
  for (const p of demoHaccpPlans) {
    try {
      await db.haccpPlan.delete({ where: { id: p.id } })
      results.demoHaccpPlans.changed++
    } catch (e) {
      results.demoHaccpPlans.skipped.push(`${p.name}: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  // 6) demo meni artikli
  for (const m of demoMenuItems) {
    try {
      await db.menuItem.delete({ where: { id: m.id } })
      results.demoMenuItems.changed++
    } catch (e) {
      results.demoMenuItems.skipped.push(`${m.name}: ${(e as Error).message.slice(0, 80)}`)
    }
  }

  await db.auditLog.create({
    data: {
      id: nid(),
      userId: user.sub,
      action: 'AUDIT_DEMO_CLEANUP',
      entityType: 'Maintenance',
      entityId: 'cleanup-demo',
      details: JSON.stringify({
        staleOrders: results.staleOrders.changed,
        demoEmployees: results.demoEmployees.changed,
        demoSuppliers: results.demoSuppliers.changed,
        demoStocktakes: results.demoStocktakes.changed,
        demoHaccpPlans: results.demoHaccpPlans.changed,
        demoMenuItems: results.demoMenuItems.changed,
        skipped: Object.values(results).reduce((s, r) => s + r.skipped.length, 0),
      }),
    },
  }).catch(() => null)

  return ok({ mode: 'purge', results })
}
