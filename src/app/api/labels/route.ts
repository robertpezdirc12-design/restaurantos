import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail, locationScope } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { nid, num, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { batchBucket, BATCH_SELECT_FULL } from '@/lib/lot-governance'
import { computeExpiry, LABEL_NOTE_MAX, PRINT_BLOCK_MESSAGES } from '@/lib/label'
import { newQrToken } from '@/lib/guest'
import { parseAllergenCodes } from '@/lib/allergen-catalog'
import { labelTablesReady, labelOut, labelUrl } from '@/lib/label-schema'

/**
 * Issue #24 (P2, v1.114.0) — etikete za pripravljeno hrano in odprte serije.
 *
 * POST /api/labels  — izdaja etikete iz OBSTOJEČEGA zapisa (issue: "vsebino
 *   etikete veži na pravi InventoryBatch/BatchPreparation, ne na besedilo"):
 *     { source: 'batch' | 'preparation', batchId? | preparationId?,
 *       manualExpiresAt? (ISO, obvezen če ni pravila in hočemo rok),
 *       preparedAt? (privzeto: batch=zdaj/odprtje, preparation=completedAt),
 *       quantity? (override), note? }
 *   ZAMRZNJEN POSNETEK ob izdaji. ROK: iz POTRJENEGA pravila (LabelShelfRule
 *   po artiklu) → ročni vnos (needsReview) → brez roka ("potreben pregled").
 *   BLOKIRANO (409): karantena/odpoklic/poteklo/odstranitev/izčrpana serija —
 *   tiskanje ne sme ustvariti vtisa primernosti.
 *
 * GET /api/labels?batchId=&preparationId=&itemId=&status=&take=
 *   — seznam etiket znotraj obsega uporabnika (locationScope) + scan status.
 *
 * Pravice: POST requireAuth (kuhinja tiska etikete — operativna naloga),
 * print/void/rules imajo svoje rute. Pre-DDL: 503 (graceful).
 */

export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.mfaEnrollOnly) return fail('Dostop zavrnjen — dokončajte prijavo z MFA.', 403)
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return fail('Neveljavno telo zahtevka.', 400)

  const source = String(body.source || '')
  if (source !== 'batch' && source !== 'preparation') {
    return fail('Vir etikete mora biti "batch" (odprta serija) ali "preparation" (priprava).', 400)
  }

  let locationId: string
  let itemId: string
  let itemName: string
  let itemUnit: string
  let allergensRaw: unknown
  let lotNumber: string
  let quantity: number
  let preparedAt: Date
  let scanBucket: string | null = null

  const now = new Date()

  if (source === 'batch') {
    const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : ''
    if (!batchId) return fail('Manjka batchId.', 400)
    const batch = await db.inventoryBatch.findUnique({
      where: { id: batchId },
      include: { InventoryItem: true },
    })
    if (!batch) return fail('Serija ne obstaja.', 404)
    const locErr = await guardResource(user, batch.locationId)
    if (locErr) return locErr
    if (!batch.locationId) return fail('Serija nima dodeljene lokacije.', 400)
    const bucket = batchBucket(batch, now)
    scanBucket = bucket
    const blockMsg = PRINT_BLOCK_MESSAGES[bucket]
    if (blockMsg) return fail(blockMsg, 409)
    locationId = batch.locationId
    itemId = batch.inventoryItemId
    itemName = batch.InventoryItem?.name ?? ''
    itemUnit = batch.InventoryItem?.unit ?? batch.unit
    allergensRaw = batch.InventoryItem?.allergens
    lotNumber = batch.lotNumber || ''
    quantity = body.quantity !== undefined ? num(body.quantity, -1) : num(batch.quantityRemaining)
    preparedAt = body.preparedAt ? new Date(String(body.preparedAt)) : now
  } else {
    const preparationId = typeof body.preparationId === 'string' ? body.preparationId.trim() : ''
    if (!preparationId) return fail('Manjka preparationId.', 400)
    const prep = await db.batchPreparation.findUnique({
      where: { id: preparationId },
      include: { InventoryItem: true },
    })
    if (!prep) return fail('Priprava ne obstaja.', 404)
    if (String(prep.status).toUpperCase() !== 'COMPLETED') {
      return fail('Etiketa se izda le za zaključeno pripravo.', 409)
    }
    const locErr = await guardResource(user, prep.locationId)
    if (locErr) return locErr
    locationId = prep.locationId
    itemId = prep.outputItemId
    itemName = prep.InventoryItem?.name ?? ''
    itemUnit = prep.InventoryItem?.unit ?? prep.outputUnit
    allergensRaw = prep.InventoryItem?.allergens
    // NIMAMO izmišljenih številk — serijo/preparacijo reši preparationId (izvor)
    lotNumber = ''
    quantity = body.quantity !== undefined ? num(body.quantity, -1) : num(prep.outputQuantity)
    preparedAt = body.preparedAt ? new Date(String(body.preparedAt)) : (prep.completedAt ?? now)
  }

  if (isNaN(preparedAt.getTime())) return fail('Neveljaven datum priprave/odprtja.', 400)
  if (quantity <= 0) return fail('Količina mora biti pozitivna.', 400)
  if (quantity > 1_000_000) return fail('Količina je prevelika.', 400)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, LABEL_NOTE_MAX) : ''

  let manualExpiresAt: Date | null = null
  const rawManual = body.manualExpiresAt
  if (rawManual !== undefined && rawManual !== null && rawManual !== '') {
    manualExpiresAt = new Date(String(rawManual))
    if (isNaN(manualExpiresAt.getTime())) return fail('Neveljaven ročni rok.', 400)
    if (manualExpiresAt.getTime() <= now.getTime()) {
      return fail('Ročni rok ne sme biti v preteklosti — etiketa ne sme nositi navidezno veljavnega datuma.', 400)
    }
  }

  const rule = await db.labelShelfRule.findUnique({ where: { inventoryItemId: itemId } })
  const decision = computeExpiry(
    preparedAt,
    rule ? { hours: rule.shelfLifeHours, confirmedByName: rule.confirmedByName } : null,
    manualExpiresAt,
  )

  const loc = locationId
    ? await db.location.findUnique({ where: { id: locationId }, select: { name: true } })
    : null
  const area = loc?.name ?? ''
  const allergenCodes = parseAllergenCodes(allergensRaw).codes

  let created: Awaited<ReturnType<typeof db.prepLabel.create>> | null = null
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    const token = newQrToken()
    try {
      created = await db.prepLabel.create({
        data: {
          id: nid(),
          locationId,
          source,
          batchId: source === 'batch' ? (body.batchId as string).trim() : null,
          preparationId: source === 'preparation' ? (body.preparationId as string).trim() : null,
          inventoryItemId: itemId,
          itemName,
          itemUnit,
          lotNumber,
          quantity,
          area,
          preparedAt,
          expiresAt: decision.expiresAt,
          ruleSource: decision.ruleSource,
          ruleHours: decision.ruleHours,
          ruleConfirmedBy: decision.ruleConfirmedBy,
          needsReview: decision.needsReview,
          allergens: jstr(allergenCodes),
          preparedById: user.sub,
          preparedByName: user.name,
          status: 'ACTIVE',
          token,
          printCount: 0,
          note,
        },
      })
    } catch (e) {
      const msg = String((e as Error).message || e)
      if (attempt < 2 && /unique|P2002/i.test(msg)) continue // naslov QR žetona trčenje — nov žeton
      throw e
    }
  }
  if (!created) return fail('Etikete ni bilo mogoče ustvariti (QR žeton).', 500)

  await writeAudit(db, {
    userId: user.sub,
    action: 'LABEL_CREATED',
    entityType: 'PrepLabel',
    entityId: created.id,
    details: jstr({
      source,
      batchId: created.batchId,
      preparationId: created.preparationId,
      inventoryItemId: itemId,
      itemName,
      expiresAt: decision.expiresAt,
      ruleSource: decision.ruleSource,
      ruleHours: decision.ruleHours,
      needsReview: decision.needsReview,
      quantity,
    }),
    locationId: created.locationId,
  })

  return ok(
    {
      label: labelOut(created, { bucket: scanBucket }, now),
      qrUrl: labelUrl(req, created.token),
      needsReview: decision.needsReview,
    },
    201,
  )
}

export async function GET(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const take = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('take') || '100', 10) || 100, 1), 200)
  const batchId = req.nextUrl.searchParams.get('batchId') || ''
  const preparationId = req.nextUrl.searchParams.get('preparationId') || ''
  const itemId = req.nextUrl.searchParams.get('itemId') || ''
  const status = (req.nextUrl.searchParams.get('status') || '').toUpperCase()

  const labels = await db.prepLabel.findMany({
    where: {
      ...(await locationScope(user)),
      ...(batchId ? { batchId } : {}),
      ...(preparationId ? { preparationId } : {}),
      ...(itemId ? { inventoryItemId: itemId } : {}),
      ...(status === 'ACTIVE' || status === 'VOID' ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  })

  const now = new Date()
  const batchIds = [...new Set(labels.filter((l) => l.batchId).map((l) => l.batchId as string))]
  const batches = batchIds.length
    ? await db.inventoryBatch.findMany({ where: { id: { in: batchIds } }, select: BATCH_SELECT_FULL })
    : []
  const bucketById = new Map(batches.map((b) => [b.id, batchBucket(b, now)]))

  return ok({
    labels: labels.map((l) => labelOut(l, l.batchId ? { bucket: bucketById.get(l.batchId) ?? null } : null, now)),
  })
}
