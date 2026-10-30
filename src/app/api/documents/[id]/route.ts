import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, fail, isResponse, requirePermission } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { documentsTableReady } from '@/lib/documents-store'
import { documentDto, parseDocumentPatch } from '@/lib/documents'

/**
 * OSS-2 (v1.203.0) — PATCH/DELETE dokumenta (settings.manage).
 *
 * PATCH  — metapodatki (naziv/kategorija/opis) in/ali ZAMENJAVA vsebine:
 *          cel paket fileName+mimeType+contentBase64 → verzija +1
 *          (deterministično izpeljano iz obstoječe verzije, brez cron stanja).
 * DELETE — briše dokument (vsebina v istem zapisu — brez osirotelih delov).
 * Do DDL: 503. Audit: DOCUMENT_UPDATED / DOCUMENT_DELETED.
 */

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await documentsTableReady())) {
    return fail('Dokumenti čakajo na shemsko migracijo (Enterprise → Shema migracije → documents).', 503)
  }

  const { id } = await params
  const body = await req.json().catch(() => null)
  const parsed = parseDocumentPatch(body)
  if (!parsed.ok) return fail(parsed.error)
  const patch = parsed.value

  const existing = await db.document.findUnique({ where: { id } })
  if (!existing) return fail('Dokument ne obstaja.', 404)
  const guarded = await guardResource(user, existing.locationId)
  if (guarded) return guarded

  const contentReplaced = patch.contentBase64 !== undefined
  const data = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(contentReplaced
      ? {
          fileName: patch.fileName as string,
          mimeType: patch.mimeType as string,
          sizeBytes: patch.sizeBytes as number,
          content: new Uint8Array(Buffer.from(patch.contentBase64 as string, 'base64')),
          version: existing.version + 1,
        }
      : {}),
    updatedById: user.sub,
  }

  const updated = await db.document.update({ where: { id }, data })

  await writeAudit(db, {
    userId: user.sub,
    action: 'DOCUMENT_UPDATED',
    entityType: 'Document',
    entityId: updated.id,
    details: jstr({
      locationId: updated.locationId,
      title: updated.title,
      version: updated.version,
      contentReplaced,
      fileName: contentReplaced ? updated.fileName : undefined,
    }),
    locationId: updated.locationId,
  })

  return ok({ document: documentDto(updated) })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await documentsTableReady())) {
    return fail('Dokumenti čakajo na shemsko migracijo (Enterprise → Shema migracije → documents).', 503)
  }

  const { id } = await params
  const existing = await db.document.findUnique({
    where: { id },
    select: { id: true, locationId: true, title: true },
  })
  if (!existing) return fail('Dokument ne obstaja.', 404)
  const guarded = await guardResource(user, existing.locationId)
  if (guarded) return guarded

  await db.document.delete({ where: { id } })

  await writeAudit(db, {
    userId: user.sub,
    action: 'DOCUMENT_DELETED',
    entityType: 'Document',
    entityId: existing.id,
    details: jstr({ locationId: existing.locationId, title: existing.title }),
    locationId: existing.locationId,
  })

  return ok({ deleted: true })
}
