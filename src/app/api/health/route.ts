import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { APP_VERSION, DEPLOY_COMMIT } from '@/lib/api'
import { describeDbError, dbErrorHint, logDbError, type DbErrorPublic } from '@/lib/db-error'
import { databaseEngine, runtimeMode } from '@/lib/runtime-info'

/**
 * Issue #76 — dvostopenjska sonda:
 *  1. CONNECTIVITY  — `SELECT 1` (pošten probe povezave, brez sheme);
 *  2. SCHEMA        — `SELECT 1 FROM "Location" LIMIT 1` (tabela obstaja?).
 *
 * Prej: en sam catch → `database: "disconnected"` brez vzroka; izjema tiho
 * pogoltnjena, Vercel logi prazni, telo 500 odgovorov auth endpointov prazno.
 * Zdaj: javno se vrne VARNA klasifikacija ({ code, category, hint } — brez
 * sporočila izjeme, hosta ali poverilnic), polna izjema pa gre v console.error
 * (Vercel runtime logi) prek logDbError.
 */
export async function GET() {
  const started = Date.now()
  let database: 'connected' | 'disconnected' = 'connected'
  let schema: 'ok' | 'drift' | 'skipped' = 'skipped'
  let dbError: DbErrorPublic | undefined

  // 1. connectivity probe
  try {
    await db.$queryRaw`SELECT 1`
  } catch (err) {
    database = 'disconnected'
    dbError = describeDbError(err)
    logDbError('GET /api/health — connectivity probe ($queryRaw SELECT 1)', err)
  }

  // 2. schema probe (samo če je povezava vzpostavljena)
  if (database === 'connected') {
    try {
      await db.$queryRaw`SELECT 1 FROM "Location" LIMIT 1`
      schema = 'ok'
    } catch (err) {
      schema = 'drift'
      dbError = describeDbError(err)
      logDbError('GET /api/health — schema probe (SELECT 1 FROM "Location")', err)
    }
  }

  const ok = database === 'connected' && schema === 'ok'
  return NextResponse.json({
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    commit: DEPLOY_COMMIT,
    mode: runtimeMode(),
    databaseEngine: databaseEngine(),
    database,
    schema,
    latencyMs: Date.now() - started,
    ...(dbError ? { dbError: { ...dbError, hint: dbErrorHint(dbError.category) } } : {}),
  })
}
