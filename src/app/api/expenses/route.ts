import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation } from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { num, nid, r2, jstr } from '@/lib/map'
import { auditChainFields } from '@/lib/audit-chain'
import { expenseCategoriesAvailable, normalizeExpenseCategory } from '@/lib/expenses-categories'

/**
 * Task 67 (v1.65.0) — kategorije stroškov, runtime-gated:
 *  - stolpec AccountsPayable.category je NA MNO produkciji odvisen od uporabnikovega
 *    DDL klika (Enterprise → konzola → stroski-kategorije), zato main schema.prisma
 *    polja (še) NE pozna — branje/pisanje kategorije gre izključno prek raw SQL
 *    z vezanimi parametri (dialekt-agnostično), gated z memoizirano probo
 *    (src/lib/expenses-categories.ts, 60 s TTL → lambda se po DDL samozdravi).
 *  - probe false → odgovor je identičen prejšnjemu ('OSTALO' fallback) — UI polje
 *    skrije; pisanje kategorije v tem stanju → 503 (enak vzorec kot haccp).
 *  - GET poleg tega vrne categoriesEnabled + distinct kategorije (za UI filter
 *    in datalist — izvid znotraj GET okna zadnjih 100 zapisov).
 */

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
  // Task 67: runtime-gated enrichment — realna kategorija SAMO če stolpec obstaja
  const catsEnabled = await expenseCategoriesAvailable()
  let catById = new Map<string, string>()
  if (catsEnabled && rows.length > 0) {
    const catRows = await db.$queryRaw<{ id: string; category: string }[]>`
      SELECT "id", "category" FROM "AccountsPayable" WHERE "id" IN (${Prisma.join(rows.map((r) => r.id))})`
    catById = new Map(catRows.map((c) => [c.id, c.category ?? '']))
  }
  return ok({
    // Task 61: obogateno mapping — status/apNumber/dueDate/paidAmount/supplierName
    // (UI: plačilo, zapadlost, preklic, urejanje). Zadnji 2 polji sta nazajkompatibilni.
    expenses: rows.map((r) => ({
      id: r.id,
      apNumber: r.apNumber,
      // Task 67: realna kategorija ko je stolpec prisoten ('' = brez), sicer legacy 'OSTALO'
      category: catsEnabled ? (catById.get(r.id) ?? '') : 'OSTALO',
      description: r.invoiceNumber || r.notes || 'Dobaviteljev račun',
      amount: num(r.totalAmount),
      paidAmount: num(r.paidAmount),
      status: r.status || 'open',
      paidAt: r.paidAt || r.invoiceDate,
      dueDate: r.dueDate,
      locationId: r.locationId,
      supplierName: r.Supplier?.name || null,
    })),
    categoriesEnabled: catsEnabled,
    ...(catsEnabled
      ? {
          categories: Array.from(new Set(rows.map((r) => catById.get(r.id) ?? '').filter(Boolean))).sort(
            (a, b) => a.localeCompare(b, 'sl'),
          ),
        }
      : {}),
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

  // Task 67: kategorija (opcijsko) — validacija 400, pending DDL → 503 (haccp vzorec)
  let category = ''
  if (body?.category !== undefined) {
    const normalized = normalizeExpenseCategory(body.category)
    if (normalized === null) return fail('Kategorija je predolga (največ 60 znakov).', 400)
    category = normalized
    if (category) {
      const catsEnabled = await expenseCategoriesAvailable()
      if (!catsEnabled) {
        return fail('Kategorije stroškov čakajo DDL korak (Enterprise → Shema migracije → stroski-kategorije).', 503)
      }
    }
  }

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
  const apNumber = `AP-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${nid().slice(0, 6).toUpperCase()}`
  // Task 67: create + kategorija v ENI interaktivni transakciji (raw UPDATE z vezanimi
  // parametri — dialekt-agnostično; main schema polja ne pozna, zato tipiziran create
  // ne sme vsebovati category). Transakcija = oba ali noben.
  const row = await db.$transaction(async (tx) => {
    const created = await tx.accountsPayable.create({
      data: {
        id: nid(),
        apNumber,
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
    if (category) {
      await tx.$executeRaw`UPDATE "AccountsPayable" SET "category" = ${category} WHERE "id" = ${created.id}`
    }
    return created
  })
  // 33-c (audit §6): ustvarjanje stroška je zdaj revidirano (prej brez revizije)
  const __aId = nid(); const __chain = await auditChainFields(db, {
    id: __aId,
    action: 'EXPENSE_CREATE',
    entityType: 'AccountsPayable',
    entityId: row.id,
    details: jstr({ category: category || 'OSTALO', amount: r2(amount), supplier: supplier.name, description: description.slice(0, 120), apNumber: row.apNumber }),
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
      details: jstr({ category: category || 'OSTALO', amount: r2(amount), supplier: supplier.name, description: description.slice(0, 120), apNumber: row.apNumber }),
      locationId,
    },
  })
  return ok({
    expense: {
      id: row.id,
      category: category || 'OSTALO',
      description: row.invoiceNumber || row.notes,
      amount: num(row.totalAmount),
      paidAt: row.paidAt || row.invoiceDate,
    },
  }, 201)
}
