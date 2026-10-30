import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { fail, isResponse, requireAuth } from '@/lib/api'
import { guardResource } from '@/lib/tenant'
import { documentsTableReady } from '@/lib/documents-store'
import { contentDispositionValue } from '@/lib/documents'

/**
 * OSS-2 (v1.203.0) — prenos vsebine dokumenta (GET, vsi avtenticirani z
 * lokacijskim obsegom — SOP-i so za operaterje; guardResource fail-closed).
 *
 * Varnost (deterministično): Content-Disposition VEDNO attachment (nikoli
 * inline izvedba), X-Content-Type-Options: nosniff, Cache-Control private +
 * no-store. Mime prišel iz allowliste (documents.ts) — SVG/HTML ni mogoče
 * shraniti. Prisma Bytes (Uint8Array) gre direktno v telo — brez pretvorb.
 * Do DDL: 503.
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(req)
  if (isResponse(ctx)) return ctx
  const user = ctx

  if (!(await documentsTableReady())) {
    return fail('Dokumenti čakajo na shemsko migracijo (Enterprise → Shema migracije → documents).', 503)
  }

  const { id } = await params
  const row = await db.document.findUnique({ where: { id } })
  if (!row) return fail('Dokument ne obstaja.', 404)
  const guarded = await guardResource(user, row.locationId)
  if (guarded) return guarded

  const bytes = new Uint8Array(row.content)
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': row.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': contentDispositionValue(row.fileName),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
