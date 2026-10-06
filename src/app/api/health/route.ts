import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { APP_VERSION, APP_COMMIT } from '@/lib/api'

export async function GET() {
  let database = 'connected'
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    database = 'disconnected'
  }
  return NextResponse.json({
    status: database === 'connected' ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    commit: APP_COMMIT,
    database,
  })
}
