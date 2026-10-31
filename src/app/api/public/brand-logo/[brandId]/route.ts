import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { fail } from '@/lib/api'
import { rateLimitPublic, clientIp } from '@/lib/guest'
import { brandLogoBytesForBrand } from '@/lib/brand-themes-server'

/**
 * OSS-11 B-del (v1.214.0) — JAVNA strežba logotipa znamke (GET, brez prijave).
 *
 * Pot izpelje čisti sloj (publicLogoPath — `theme.logoUrl` v javnih odgovorih
 * menu/web-portal/pay/reservations). Bajti prihajajo IZKLJUČNO iz shrambe,
 * ki jo je zapisal POST /api/brand-themes/logo po validaciji (allowlist +
 * magic-byte preverjanje) — tu se ob vsakem odgovoru PONOVNO preverita
 * (obramba v globino nad ročno pokvarjeno vrstico): neujemanje → 404, gostovska
 * stran logotip tiho skrije (BrandLogo onError — nič se ne laže).
 *
 * Glava (deterministično): Content-Type = preverjeni mime (samo slike),
 * X-Content-Type-Options: nosniff, Content-Length, ETag (sha1 bajtov — 304 na
 * If-None-Match), Cache-Control public 5 min + must-revalidate (logotip se
 * med zamenjavami spremeni — nov ETags samodejno razveljavi predpomnilnik).
 * Content-Disposition NAMERNO ni nastavljen: privzeta vrednost je inline in
 * mime je iz slikovne allowliste (SVG/HTML ne moreta skozi vrata POST niti
 * routa — documents.ts vzame attachment KER dopušča ne-slikovne tipe).
 *
 * Meja: brandId je javen že z same teme strani (logo se vseeno prikaže
 * gostom); rate limit 60/min/IP — enako kot javni meni.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ brandId: string }> }) {
  if (!(await rateLimitPublic(`brandlogo:${clientIp(req)}`, 60))) {
    return fail('Preveč zahtevkov. Poskusi čez minuto.', 429)
  }

  const { brandId } = await params
  // vratá [brandId] segmenta so prek encodeURIComponent — Next dekodira segment
  const logo = await brandLogoBytesForBrand(decodeURIComponent(brandId))
  if (!logo) return fail('Logotip ni na voljo.', 404)

  const etag = `"${createHash('sha1').update(logo.bytes).digest('hex')}"`
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, must-revalidate' } })
  }

  return new Response(logo.bytes, {
    status: 200,
    headers: {
      'Content-Type': logo.mime,
      'Content-Length': String(logo.bytes.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300, must-revalidate',
      ETag: etag,
    },
  })
}
