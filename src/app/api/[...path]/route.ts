import { NextRequest, NextResponse } from 'next/server'

/**
 * Issue #91 (QA): neznane /api/* poti so doslej vračale Next.js HTML 404 stran
 * (Content-Type: text/html). API klienti, ki pričakujejo JSON, so padli na
 * `SyntaxError: Unexpected token '<'` v response.json() — razlikovanje med
 * »pot ne obstaja« in »strežnik napaka« ni bilo mogoče.
 *
 * Catch-all pod /api se izvede SAMO za poti, ki se ne ujemajo z nobeno
 * obstoječo (statično ali dinamično) ruto — obstoječe poti imajo prednost
 * (Next.js resolucija: specifična ruta > catch-all). Odgovor je vedno JSON:
 *
 *   { "error": "Not found", "path": "/api/menu" }
 *
 * Brez namigovanja na bližnje poti (avtodopolnjevalna logika bi bila lažna
 * gotovost pri preimenovanih rutah) — pot je izpisana dobesedno, kot je bila
 * zahtevana, kar je dovolj za razhroščevanje integratorjev.
 *
 * Vse metode pokrite: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS (pri HEAD
 * NextResponse sam izpusti prazno telo ob pravem statusu).
 */
async function apiNotFound(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const params = await ctx.params.catch(() => ({ path: [] as string[] | undefined }))
  const path = '/api/' + (params?.path || []).join('/')
  return NextResponse.json(
    { error: 'Not found', path },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}

export const GET = apiNotFound
export const POST = apiNotFound
export const PUT = apiNotFound
export const PATCH = apiNotFound
export const DELETE = apiNotFound
export const HEAD = apiNotFound
export const OPTIONS = apiNotFound
