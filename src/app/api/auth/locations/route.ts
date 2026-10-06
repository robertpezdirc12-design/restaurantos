import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Javna endpointa (kot v originalu): vrača lokacije za izbor na prijavi */
export async function GET() {
  const locations = await db.location.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json({ locations })
}
