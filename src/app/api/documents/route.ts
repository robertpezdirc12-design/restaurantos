import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import {
  ok,
  fail,
  isResponse,
  requireAuth,
  requirePermission,
  requireUserLocation,
  locationScope,
  isCentralRole,
} from '@/lib/api'
import { assertOrgScope } from '@/lib/tenant'
import { nid, jstr } from '@/lib/map'
import { writeAudit } from '@/lib/audit-chain'
import { documentsTableReady } from '@/lib/documents-store'
import { documentDto, parseDocumentInput } from '@/lib/documents'

/**
 * OSS-2 (v1.203.0, docs/GAP-ANALIZA-odprtokodna-konkurenca.md) — dokumenti s
 * priponkami: SOP-i, pogodbe, recepture, navodila (obseg HACCP ostaja ločen).
 *
 * GET  — seznam (DTO BREZ vsebine — seznam je lahek; prenos prek /download).
 *        Dostop: VSI avtenticirani z lokacijskim obsegom (SOP-i so za
 *        operaterje); staff izključno svoja lokacija (fail-closed), centralne
 *        org obseg / ?locationId filter, ?category filter.
 * POST — nov dokument (settings.manage). Vsebina gre V BAZO (Prisma Bytes —
 *        produkcija ima read-only disk; ap-attachments budget vzorec, 1 MB raw).
 *        Mime allowlist BREZ SVG/HTML; verzija se začne na 1.
 * Do DDL (Enterprise → Shema migracije → documents): 503.
 */

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req)
  if (isResponse(ctx)) return ctx
  const user = ctx

  if (!(await documentsTableReady())) {
    return fail('Dokumenti čakajo na shemsko migracijo (Enterprise → Shema migracije → documents).', 503)
  }

  const url = new URL(req.url)
  const categoryParam = url.searchParams.get('category')
  const locParam = url.searchParams.get('locationId')
  let scope: { locationId?: string | { in: string[] } }
  if (locParam && isCentralRole(user)) {
    const orgGuard = await assertOrgScope(user, locParam)
    if (orgGuard) return orgGuard
    scope = { locationId: locParam }
  } else {
    scope = await locationScope(user)
  }

  const rows = await db.document.findMany({
    where: { ...scope, ...(categoryParam ? { category: categoryParam } : {}) },
    orderBy: [{ updatedAt: 'desc' }],
  })

  const locations = await db.location.findMany({
    where: scope.locationId ? { id: scope.locationId } : {},
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
  })

  return ok({
    documents: rows.map(documentDto),
    locations,
  })
}

export async function POST(req: NextRequest) {
  const user = await requirePermission(req, 'settings.manage')
  if (isResponse(user)) return user

  if (!(await documentsTableReady())) {
    return fail('Dokumenti čakajo na shemsko migracijo (Enterprise → Shema migracije → documents).', 503)
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const parsed = parseDocumentInput(body)
  if (!parsed.ok) return fail(parsed.error)

  const locGuard = requireUserLocation(user, body?.locationId)
  if (isResponse(locGuard)) return locGuard
  const locationId = locGuard
  const orgGuard = await assertOrgScope(user, locationId)
  if (orgGuard) return orgGuard

  const buffer = Buffer.from(parsed.value.contentBase64, 'base64')
  const created = await db.document.create({
    data: {
      id: nid(),
      locationId,
      title: parsed.value.title,
      category: parsed.value.category,
      description: parsed.value.description,
      fileName: parsed.value.fileName,
      mimeType: parsed.value.mimeType,
      sizeBytes: parsed.value.sizeBytes,
      content: new Uint8Array(buffer),
      version: 1,
      createdById: user.sub,
      updatedById: user.sub,
    },
  })

  await writeAudit(db, {
    userId: user.sub,
    action: 'DOCUMENT_CREATE',
    entityType: 'Document',
    entityId: created.id,
    details: jstr({
      locationId,
      title: created.title,
      category: created.category,
      fileName: created.fileName,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
    }),
    locationId,
  })

  return ok({ document: documentDto(created) }, 201)
}
