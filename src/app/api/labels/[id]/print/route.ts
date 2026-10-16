import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { batchBucket, BATCH_SELECT_FULL } from '@/lib/lot-governance'
import { printBlockedReason, PRINT_BLOCK_MESSAGES } from '@/lib/label'
import { labelTablesReady, labelOut, labelUrl } from '@/lib/label-schema'

/**
 * Issue #24 — POST /api/labels/[id]/print: priprava TISKA (strežniški del).
 *
 *  1. RE-VALIDACIJA blokade (karantena/odpoklic/poteklo/odstranitev/izčrpana
 *     serija ali potekel rok etikete → 409 — "tiskanje ne sme ustvariti vtisa
 *     primernosti");
 *  2. printCount++ + lastPrintedAt (ponovni tisk = ISTA etiketa — ne podvoji
 *     serije/količine/StockTransaction; vsak poskus = nov PrintJob prek
 *     obstoječega /api/print/ack z kind='label', refId=id);
 *  3. vrne QR podatke: qrText (URL za agent ESC/POS QR) + qrDataUrl
 *     (PNG data URL za browser predogled/izpis).
 *
 * FIZIČNI izpis opravi client (devices/print.ts → agent/browser/simulator).
 * POŠTENOST (issue #3/#10): "agent sprejel" ≠ "tiskalnik potrdil" — ESC/POS
 * ne omogoča potrditve; PrintJob statusi ločujejo poskus/neuspeh/simulacijo.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (user.mfaEnrollOnly) return fail('Dostop zavrnjen — dokončajte prijavo z MFA.', 403)
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const { id } = await params
  const label = await db.prepLabel.findUnique({ where: { id } })
  if (!label) return fail('Etiketa ne obstaja.', 404)
  const locErr = await guardResource(user, label.locationId)
  if (locErr) return locErr

  const now = new Date()
  // tip: izpeljan iz BATCH_SELECT_FULL izbire (delna vrstica vsebuje vsa
  // polja, ki jih potrebuje batchBucket — Awaited<ReturnType<findUnique>>
  // bi zahteval CEL model InventoryBatch in tipovno padel na selectu)
  const batch = label.batchId
    ? await db.inventoryBatch.findUnique({ where: { id: label.batchId }, select: BATCH_SELECT_FULL })
    : null
  const bucket = batch ? batchBucket(batch, now) : null
  const blocked = printBlockedReason(label, batch ? { bucket } : null, now)
  if (blocked) {
    const msg = PRINT_BLOCK_MESSAGES[blocked]
    if (msg) return fail(msg, 409)
    return fail('Tiskanje etikete je blokirano.', 409)
  }

  const updated = await db.prepLabel.update({
    where: { id },
    data: { printCount: { increment: 1 }, lastPrintedAt: now },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'LABEL_PRINTED',
    entityType: 'PrepLabel',
    entityId: id,
    details: jstr({
      printCount: updated.printCount,
      source: updated.source,
      batchId: updated.batchId,
      preparationId: updated.preparationId,
      itemName: updated.itemName,
    }),
    locationId: updated.locationId,
  })

  const url = labelUrl(req, updated.token)
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 })

  return ok({
    label: labelOut(updated, batch ? { bucket } : null, now),
    qrText: url,
    qrDataUrl,
    printCount: updated.printCount,
  })
}
