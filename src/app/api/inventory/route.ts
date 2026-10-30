import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuthWithPerms, requirePermission, isResponse, ok, fail, locationScope, requireUserLocation, isCentralRole } from '@/lib/api'
import { guardResource, assertOrgScope } from '@/lib/tenant'
import { num, nid, jstr } from '@/lib/map'
import { publishEvent } from '@/lib/events'
import { writeAudit } from '@/lib/audit-chain'
import { parseInventoryField, sanitizeUnit, roundCost2 } from '@/lib/inventory-validate'
import { normalizeEan, validateEanFormat } from '@/lib/ean'

/**
 * OSS-9 (v1.202.0): EAN / črtna koda dobavitelja. Skupna validacija za POST/PATCH:
 * normalizacija (trim/whitespace/uppercase — src/lib/ean.ts) + oblika (3–48,
 * [0-9A-Z_-]; prazno = artikel brez kode). Duplikat check → 409 (aplikačni sloj;
 * delni unique indeks bi lomil baseline 1:1 konvencijo). EAN je operativen podatek
 * (sken pri prevzemu) — NI občutljiv kot cena, GET payload nosi ean ZA VSE vloge.
 */
async function resolveEanForWrite(
  raw: unknown,
  selfId?: string,
): Promise<{ ean: string } | { error: string; status: number }> {
  const ean = normalizeEan(typeof raw === 'string' ? raw : '')
  if (!ean) return { ean: '' } // prazno = brez kode (dovoljeno)
  const v = validateEanFormat(ean)
  if (!v.ok) {
    const msg =
      v.error === 'too_short'
        ? 'Koda je prekratka (najmanj 3 znaki).'
        : v.error === 'too_long'
          ? 'Koda je predolga (največ 48 znakov).'
          : 'Koda vsebuje nedovoljene znake (dovoljene: črke, številke, pomišljaj).'
    return { error: msg, status: 400 }
  }
  const dup = await db.inventoryItem.findFirst({
    where: { ean, ...(selfId ? { id: { not: selfId } } : {}) },
    select: { name: true },
  })
  if (dup) return { error: `Koda ${ean} je že dodeljena artiklu »${dup.name}«.`, status: 409 }
  return { ean }
}

/**
 * Issue #5 (P0 §C): količine so operativne (kuhinja vidi zalogo) — NABAVNA CENA pa
 * je občutljiva (issue: »loči minimalen operativni vpogled v artikle/količine od
 * občutljivejših cen«). Zdaj: cost/supplierId samo za inventory.manage
 * (zaloge/nabava-tab, skladišče) ali reports.view; ostali dobijo minimalni
 * operativni DTO (ključi ostanejo — null vrednosti, UI ne prelomi).
 */
export async function GET(req: NextRequest) {
  const ctx = await requireAuthWithPerms(req)
  if (isResponse(ctx)) return ctx
  const user = ctx.user
  const showCost = ctx.perms.includes('inventory.manage') || ctx.perms.includes('reports.sales')
  const rows = await db.inventoryItem.findMany({
    // Issue #4 §1: staff vidi samo zalogo svoje lokacije
    where: await locationScope(user),
    orderBy: { name: 'asc' },
    // Demo nabor podatkov: ~160 artiklov zaloge — prag dvignjen s 100 na 500,
    // da zaloga tab pokaže CELO zalogo (iskanje/filtri so odjemalec).
    take: 500,
  })
  return ok({
    inventory: rows.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      qty: num(r.quantity),
      minQty: num(r.minQuantity),
      cost: showCost ? num(r.costPerUnit) : 0,
      supplierId: showCost ? r.supplier || null : null,
      locationId: r.locationId,
      // OSS-9: koda dobavitelja — operativen podatek (sken pri prevzemu), ni cena
      ean: r.ean || '',
    })),
  })
}

/**
 * Nov artikel zaloge (sprejem blaga).
 * N3 (audit P1): kanonično dovoljenje `inventory.manage` namesto trdo kodiranih vlog —
 * tudi vloga warehouse (in enterprise vloge s to pravico) lahko zdaj sprejema blago;
 * permissionOverrides delujejo na pisanje (DB lookup na vsak klic).
 *
 * Issue #55 (P1): lokacija je IZRECNA in tenant-preverjena — findFirst() fallback
 * ("prva lokacija v bazi", lahko tuje org) je UKINJEN. Staff/warehouse vedno vezajo
 * na svojo lokacijo; centralna vloga lahko podamo eksplicitno lokacijo v telesu,
 * vendar jo assertOrgScope preveri proti org uporabnika. Staff, ki pošlje
 * tujo body.locationId, dobi 403 (klientovo polje ne sme preusmeriti artikla).
 *
 * Issue #58 (P1): stroga strežniška validacija količin/cen (skupni helper s PATCH):
 * NaN/±Infinity/neštevilski vhodi in negativne/prevelike vrednosti → 400,
 * NIKOLI tiho v 0. Začetno stanje (qty > 0) se evidentira kot EKSPICITEN
 * StockTransaction (type='RECEIVE', "Začetno stanje (ročni vnos)") — NI GRN
 * (brez PO/dobaviteljevega dokumenta, brez serijske sledljivosti).
 */
export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim().slice(0, 120)
  if (!name) return ok({ error: 'Naziv artikla je obvezen.' }, 400)

  // ── Issue #55: izrecna, tenant-preverjena lokacija (bREZ findFirst fallback) ──
  const bodyLoc = typeof body?.locationId === 'string' ? body.locationId.trim() : ''
  if (bodyLoc && !isCentralRole(user) && bodyLoc !== user.loc) {
    // lokalna vloga ne sme preusmeriti svojega artikla na tujo lokacijo s klientovim poljem
    return fail('Lokacija v zahtevi se ne ujema z vašo dodeljeno lokacijo.', 403)
  }
  const locRes = requireUserLocation(user, bodyLoc || undefined)
  if (isResponse(locRes)) return locRes
  const locationId = locRes
  const orgRes = await assertOrgScope(user, locationId)
  if (orgRes) return orgRes

  // ── Issue #58: stroga validacija (isti helper kot PATCH) ──
  const qtyP = parseInventoryField(body?.qty, 'Količina')
  if (!qtyP.ok) return fail(qtyP.error, 400)
  const minP = parseInventoryField(body?.minQty, 'Minimalna količina')
  if (!minP.ok) return fail(minP.error, 400)
  const costP = parseInventoryField(body?.cost, 'Nabavna cena', { isCost: true })
  if (!costP.ok) return fail(costP.error, 400)
  const qty = qtyP.value ?? 0
  const minQty = minP.value ?? 0
  const cost = costP.value ?? 0
  const unit = sanitizeUnit(body?.unit)
  // OSS-9: EAN (prazno = brez kode; 400 oblika / 409 duplikat)
  const eanRes = await resolveEanForWrite(body?.ean)
  if ('error' in eanRes) return ok({ error: eanRes.error }, eanRes.status)
  const ean = eanRes.ean

  const openingTxId = qty > 0 ? nid() : null
  const row = await db.$transaction(async (tx) => {
    const created = await tx.inventoryItem.create({
      data: {
        id: nid(),
        name,
        unit,
        quantity: qty,
        minQuantity: minQty,
        costPerUnit: cost,
        supplier: String(body?.supplierName || '').trim().slice(0, 120),
        category: String(body?.category || 'general').trim().slice(0, 60) || 'general',
        locationId,
        ean,
      },
    })
    // #58: opening balance — ekspliciten RECEIVE dogodek v ISTI transakciji
    // (evidence ne odstopa od stanja). NI GRN: brez dobaviteljevega dokumenta,
    // brez InventoryBatch/serije — untracked/legacy označba v note.
    if (openingTxId) {
      await tx.stockTransaction.create({
        data: {
          id: openingTxId,
          inventoryItemId: created.id,
          type: 'RECEIVE',
          quantity: qty,
          previousQty: 0,
          newQty: qty,
          costPerUnit: cost,
          totalCost: roundCost2(cost * qty),
          reason: 'Začetno stanje (ročni vnos)',
          note: 'Opening balance brez serijske sledljivosti (ni GRN/dobaviteljev prevzem) — za prevzem uporabi nabavo.',
          employeeId: user.sub,
          employeeName: user.name,
        },
      })
    }
    // 33-c (audit §6): INVENTORY_CREATE dobi locationId (prej neviden location-scoped uporabnikom)
    await writeAudit(tx, {
      userId: user.sub, action: 'INVENTORY_CREATE', entityType: 'InventoryItem', entityId: created.id,
      details: jstr({ name, qty, minQuantity: minQty, costPerUnit: cost, unit, ean, openingTx: openingTxId ? 'RECEIVE/začetno stanje' : 'brez začetne količine' }),
      locationId,
    })
    return created
  })
  return ok({ item: { id: row.id, name: row.name, locationId, openingTxId } }, 201)
}

/**
 * Prilagoditev zaloge: prejem (delta > 0), popravek količine/min/cene.
 * N3 (audit P1): kanonično dovoljenje `inventory.manage` namesto trdo kodiranih vlog
 * (warehouse/enterprise + override-i delujejo); lokacijski gate ostaja fail-closed.
 *
 * Issue #58 (P1): ISTA validacija kot POST (parseInventoryField) — neveljavni
 * vhodi (NaN/Infinity/neštevilski) → 400 namesto tihe 0/ignoriranja; negativni
 * setQty/minQty/cost → 400; |delta| prevelika → 400. previousQty se prebere
 * FRESH znotraj transakcije (issue #52 duh — sledi dejanskemu stanju, ne
 * zastarelemu branju izven nje).
 */
export async function PATCH(req: NextRequest) {
  const user = await requirePermission(req, 'inventory.manage')
  if (isResponse(user)) return user
  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  const item = id ? await db.inventoryItem.findUnique({ where: { id } }) : null
  if (!item) return ok({ error: 'Artikel ne obstaja.' }, 404)
  // Issue #4 §1: prilagoditev zaloge tujega artikla (druga lokacija) je zavrnjena (fail-closed)
  const locRes = await guardResource(user, item.locationId)
  if (locRes) return locRes

  // ── Issue #58: stroga validacija (isti helper kot POST) ──
  const deltaP = parseInventoryField(body?.delta, 'Delta', { allowNegative: true })
  if (!deltaP.ok) return fail(deltaP.error, 400)
  const setQtyP = parseInventoryField(body?.setQty, 'Količina (nastavi)')
  if (!setQtyP.ok) return fail(setQtyP.error, 400)
  const minQtyP = parseInventoryField(body?.minQty, 'Minimalna količina')
  if (!minQtyP.ok) return fail(minQtyP.error, 400)
  const costP = parseInventoryField(body?.cost, 'Nabavna cena', { isCost: true })
  if (!costP.ok) return fail(costP.error, 400)
  const delta = deltaP.value
  const setQty = setQtyP.value
  const minQty = minQtyP.value
  const cost = costP.value
  // OSS-9: EAN — OPCIJONO polje (undefined = ne spreminjaj; '' = odstrani kodo)
  let ean: string | undefined
  if (body?.ean !== undefined) {
    const eanRes = await resolveEanForWrite(body.ean, id)
    if ('error' in eanRes) return ok({ error: eanRes.error }, eanRes.status)
    ean = eanRes.ean
  }
  if (delta === null && setQty === null && minQty === null && cost === null && ean === undefined) return ok({ error: 'Ni podatkov za posodobitev.' }, 400)

  // R4 popravek (P0 audit): transakcija + atomarne spremembe količine (increment/decrement
  // s pogojem) — brez lost update; StockTransaction + AuditLog v ISTI transakciji,
  // da evidence gibanja ne odstopa od dejanskega stanja (prej: trije ločeni klici).
  // #58: previousQty se prebere FRESH znotraj transakcije (ne zastareli item.quantity
  // izven nje) — ledger snapshot ≡ dejansko DB stanje ob spremembi.
  const result = await db.$transaction(async (tx) => {
    const cur = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
    const prevQty = Math.max(0, num(cur?.quantity))
    let newQty = prevQty
    let variance = 0
    if (delta !== null && delta > 0) {
      await tx.inventoryItem.updateMany({ where: { id }, data: { quantity: { increment: delta }, lastRestocked: new Date() } })
      const after = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
      newQty = num(after?.quantity)
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    } else if (delta !== null && delta < 0) {
      const dec = -delta
      const res = await tx.inventoryItem.updateMany({ where: { id, quantity: { gte: dec } }, data: { quantity: { decrement: dec } } })
      if (res.count === 0) {
        // talna omejitev na 0 (enako kot prejšnji max(0, qty + delta))
        const cur = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
        const avail = Math.max(0, num(cur?.quantity))
        if (avail > 0) await tx.inventoryItem.updateMany({ where: { id, quantity: { gte: avail } }, data: { quantity: { decrement: avail } } })
      }
      const after = await tx.inventoryItem.findUnique({ where: { id }, select: { quantity: true } })
      newQty = num(after?.quantity)
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    } else if (setQty !== null) {
      // inventurni popravek (absolutna vrednost) — namenoma last-writer-wins
      newQty = Math.max(0, setQty)
      await tx.inventoryItem.updateMany({ where: { id }, data: { quantity: newQty } })
      variance = Math.round((newQty - prevQty) * 1000) / 1000
    }
    if (minQty !== null) await tx.inventoryItem.updateMany({ where: { id }, data: { minQuantity: minQty } })
    if (cost !== null) await tx.inventoryItem.updateMany({ where: { id }, data: { costPerUnit: cost } })
    if (ean !== undefined) await tx.inventoryItem.updateMany({ where: { id }, data: { ean } })

    // Evidence gibanja zaloge (razvidnost za računovodski izvoz): prejem/odpis/popravek
    if (variance !== 0) {
      const unitCost = cost !== null ? cost : num(item.costPerUnit)
      await tx.stockTransaction.create({
        data: {
          id: nid(),
          inventoryItemId: id,
          type: variance > 0 ? 'RECEIVE' : 'ADJUST',
          quantity: variance,
          previousQty: prevQty,
          newQty,
          costPerUnit: unitCost,
          totalCost: Math.round(Math.abs(variance) * unitCost * 100) / 100,
          reason: variance > 0 ? 'Prejem blaga (ročni vnos)' : 'Popravek/odpis zaloge (ročni vnos)',
          employeeId: user.sub,
          employeeName: user.name,
        },
      })
    }

    await writeAudit(tx, { userId: user.sub, action: 'INVENTORY_ADJUST', entityType: 'InventoryItem', entityId: id, details: jstr({ name: item.name, previousQty: prevQty, newQty, delta, setQty, minQuantity: minQty, costPerUnit: cost, ean: ean ?? undefined }) })
    return { newQty, variance, name: item.name }
  })

  // Issue #11 §3 — dogodek spremembe zaloge (variance != 0 pomeni dejanski premik)
  if (result.variance !== 0) {
    // 33-c: locationId v payloadu (lokacijsko vidni dogodki — audit §6)
    await publishEvent('StockChanged', { entityType: 'InventoryItem', entityId: id, payload: { name: result.name, variance: result.variance, newQty: result.newQty, by: user.name, locationId: item.locationId }, locationId: item.locationId }).catch(() => undefined)
  }
  return ok({ item: { id, name: item.name, qty: result.newQty } })
}
