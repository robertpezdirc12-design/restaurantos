import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { describeDbError, logDbError } from '@/lib/db-error'

/**
 * Javna endpointa (kot v originalu): vrača lokacije za izbor na prijavi.
 *
 * Issue #76: prej je db.location.findMany() ob izpadu baze vrglo NEUJETO
 * izjemo → Next.js je vrnil HTTP 500 s PRAZNIM telesom (login stran je
 * pokazala le "napaka strežnika"). Zdaj: 503 s strukturiranim JSON
 * (code: DB_UNAVAILABLE + varna kategorija dbError) in console.error z
 * izjemo/stackom v Vercel runtime logih.
 */
export async function GET() {
  try {
    const locations = await db.location.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ locations })
  } catch (err) {
    logDbError('GET /api/auth/locations — db.location.findMany', err)
    const { code, category } = describeDbError(err)
    return NextResponse.json(
      {
        error: 'Podatkovna baza trenutno ni dosegljiva. Poskusite znova kasneje.',
        code: 'DB_UNAVAILABLE',
        dbError: { code, category },
      },
      { status: 503 },
    )
  }
}
