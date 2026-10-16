import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isResponse, ok, fail } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { batchBucket, BATCH_SELECT_FULL } from '@/lib/lot-governance'
import { labelTablesReady, labelOut } from '@/lib/label-schema'

/**
 * Issue #24 — GET /api/labels/[id]: podrobnosti etikete + vezana serija +
 * tiskalni poskusi (PrintJob kind='label', refId=id — evidence #10).
 * requireAuth + guardResource (lokacijska varovalka + org meja centralnih vlog).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  if (!(await labelTablesReady())) {
    return fail('Etikete čakajo na shemsko migracijo (Enterprise → Shema migracije → prep-labels).', 503)
  }
  const { id } = await params
  const label = await db.prepLabel.findUnique({ where: { id } })
  if (!label) return fail('Etiketa ne obstaja.', 404)
  const locErr = await guardResource(user, label.locationId)
  if (locErr) return locErr

  const now = new Date()
  let batchInfo: {
    id: string
    lotNumber: string
    status: string
    bucket: string
    quantityRemaining: number
    expiryDate: Date | null
  } | null = null
  if (label.batchId) {
    const batch = await db.inventoryBatch.findUnique({
      where: { id: label.batchId },
      select: BATCH_SELECT_FULL,
    })
    if (batch) {
      batchInfo = {
        id: batch.id,
        lotNumber: batch.lotNumber,
        status: batch.status,
        bucket: batchBucket(batch, now),
        quantityRemaining: Number(batch.quantityRemaining),
        expiryDate: batch.expiryDate,
      }
    }
  }

  const printJobs = await db.printJob.findMany({
    where: { kind: 'label', refId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return ok({
    label: labelOut(label, batchInfo ? { bucket: batchInfo.bucket } : null, now),
    batch: batchInfo,
    printJobs,
  })
}
