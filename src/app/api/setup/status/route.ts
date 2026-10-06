import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const [employees, locations, settings] = await Promise.all([
    db.employee.count(),
    db.location.count(),
    db.setting.count(),
  ])
  return NextResponse.json({
    isInitialized: employees > 0,
    mode: locations > 1 ? 'multi' : 'single',
    hasEmployees: employees > 0,
    hasLocations: locations > 0,
    hasSettings: settings > 0,
    counts: null,
    multiLocationReady: locations > 0,
    databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing',
  })
}
