import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { num, nid, r2, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'

/**
 * N5 (revizija §4): GET je finančni seznam (dobaviteljski računi) — UI prikazuje
 * zavihek Stroški samo z 'reports.view' (TAB_PERM.stroski), zato backend uveljavlja
 * isto kanonično dovoljenje (prej: requireAuth — natakar je prek API-ja videl finance).
 */
export async function GET(req: NextRequest) {
  const user = await requirePermission(req, 'reports.view')
  if (isResponse(user)) return user
  const rows = await db.accountsPayable.findMany({
    // Issue #4 §1: stroški po lokaciji (AccountsPayable.locationId)
    where: await locationScope(user),
    orderBy: { invoiceDate: 'desc' },
    take: 100,
    include: { Supplier: { select: { name: true } } },
  })
  return ok({
    // Task 61: obogateno mapping — status/apNumber/dueDate/paidAmount/supplierName
    // (UI: plačilo, zapadlost, preklic, urejanje). Zadnji 2 polji sta nazajkompatibilni.
    expenses: rows.map((r) => ({
      id: r.id,
      apNumber: r.apNumber,
      category: 'OSTALO',
      description: r.invoiceNumber || r.notes || 'Dobaviteljev račun',
      amount: num(r.totalAmount),
      paidAmount: num(r.paidAmount),
      status: r.status || 'open',
      paidAt: r.paidAt || r.invoiceDate,
      dueDate: r.dueDate,
      locationId: r.locationId,
      supplierName: r.Supplier?.name || null,
    })),
  })
}

/**
 * Nov strošek (dobaviteljev račun / AccountsPayable).
 * N3 (audit P1): kanonično dovoljenje `settings.manage` namesto trdo kodiranih vlog —
 * enterprise vloge s to pravico in permissionOverrides delujejo na pisanje (DB lookup).
 * opomba: supplierId je FK na Supplier — strošek brez dobavitelja se VEDNO veže na
 * privzetega "Razno" (idempotentno, race-varno). apNumber je unique brez defaulta → generiramo.
 *
 * R12 (revizija §6 + Task 41 popavek): dve težavi zapored —
 *  (1) prejšnji findFirst→create je pod konkurenco ustvaril več "Razno" (dve zahtevi
 *      sta oba prebrali prazen seznam in oba ustvarili),
 *  (2) findFirst je iskal KATERIKOLI dobavitelj (brez filtra imena) — pri obstoječih
 *      dobaviteljih (npr. "Kmetija Sonce" v dev bazi) se "Razno" sploh ni ustvaril in
 *      je strošek semantično napačno visel na najstarejšem dobavitelju.
 * Zdaj: VEDNO upsert po unique ključu name + P2002 re-read fallback → pod konkurenco
 * obstaja natanko EN "Razno" dobavitelj, nanj pa so vezani vsi stroški brez dobavitelja.
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const description = String(body?.description || '').trim()
  const amount = num(body?.amount)
  if (!description) return fail('Opis je obvezen.', 400)
  if (!(amount > 0)) return fail('Znesek mora biti pozitiven.', 400)
  // Issue #4 §10: brez findFirst() fallback — staff = svoja lokacija, centralna poda body.locationId
  const locationId = requireUserLocation(user, body?.locationId)
  if (isResponse(locationId)) return locationId
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  // R12 + Task 41: vedno "Razno" — unique name upsert + P2002 re-read/retry zanka.
  // Dve P2002 possibilities: (a) name-'Razno' kolizija (vzporedna zahteva ga je
  // pravkar ustvarila) → re-read po imenu vrne obstoječega; (b) code-kolizija —
  // `code @unique @default("")` pomeni, da INSERT s praznim code trči, če že
  // obstaja dobavitelj s privzetim praznim code (npr. ročen/uvožen vnos), zato
  // eksplicitno code 'RAZNO' (attempt 0) oziroma naključna pripona (retry).
  const supplier = await (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.supplier.upsert({
          where: { name: 'Razno' },
          update: {},
          create: { id: nid(), name: 'Razno', code: attempt === 0 ? 'RAZNO' : `RAZNO-${nid().slice(0, 6).toUpperCase()}` },
        })
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e
        const byName = await db.supplier.findUnique({ where: { name: 'Razno' } })
        if (byName) return byName
        // sicer: code-kolizija → naslednji poskus z novim code
      }
    }
    throw new Error('Razno dobavitelj ni bil mogoče razrešiti (P2002 zanka izčrpana).')
  })()

  const now = new Date()
  const due = new Date(now)
  due.setDate(due.getDate() + 30)
  const row = await db.accountsPayable.create({
    data: {
      id: nid(),
      apNumber: `AP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${nid().slice(0, 6).toUpperCase()}`,
      supplierId: supplier.id,
      invoiceNumber: description.slice(0, 120),
      invoiceDate: now,
      dueDate: due,
      subtotal: r2(amount),
      totalAmount: r2(amount),
      notes: description,
      locationId,
    },
  })
  // 33-c (audit §6): ustvarjanje stroška je zdaj revidirano (prej brez revizije)
  const __aId = nid(); const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'EXPENSE_CREATE',
    entityType: 'AccountsPayable',
    entityId: row.id,
    details: jstr({ category: 'OSTALO', amount: r2(amount), supplier: supplier.name, description: description.slice(0, 120), apNumber: row.apNumber }),
    locationId,
  })
  await db.auditLog.create({
    data: {
      ...__chain,
      id: __aId,
      userId: user.sub,
      action: 'EXPENSE_CREATE',
      entityType: 'AccountsPayable',
      entityId: row.id,
      details: jstr({ category: 'OSTALO', amount: r2(amount), supplier: supplier.name, description: description.slice(0, 120), apNumber: row.apNumber }),
      locationId,
    },
  })
  return ok({
    expense: {
      id: row.id,
      category: 'OSTALO',
      description: row.invoiceNumber || row.notes,
      amount: num(row.totalAmount),
      paidAt: row.paidAt || row.invoiceDate,
    },
  }, 201)
}
