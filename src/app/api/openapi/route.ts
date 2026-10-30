import { NextRequest } from 'next/server'
import { ok } from '@/lib/api'
import { buildOpenApiSpec } from '@/lib/openapi-spec'
import { APP_VERSION } from '@/lib/version'

/**
 * OSS-5 (v1.201.0) — Odprta API specifikacija.
 * GET /api/openapi → OpenAPI 3.0.3 opis javne/integracijske površine.
 *
 * Javno BREZ prijave (spec je metapodatki javne površine — vsebuje le IMENA
 * parametrov, nikoli vrednosti žetonov; tests/v201-openapi.test.ts uveljavlja
 * pokritost disk↔spec v OBEH smerah + odsotnost skrivnosti). Kratki cache,
 * ker verzija raste z deployem.
 */
export async function GET(_req: NextRequest) {
  const spec = buildOpenApiSpec(APP_VERSION)
  const res = ok(spec)
  res.headers.set('Cache-Control', 'public, max-age=300')
  return res
}
