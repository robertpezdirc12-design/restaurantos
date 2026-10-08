/**
 * Issue #11 §8 — system-health: hitri zdravstveni pregled sistema.
 * Poganjanje: bun scripts/system-health.ts  (izhodni kod 0 = zdravo, 1 = opozorilo, 2 = kritično)
 * Preverja: DB dostopnost, dogodkovna vrsta (pending/failed), naprave (online),
 * zadnji dogodki, drift sheme (klic check-schema-drift).
 */
import { db } from '../src/lib/db'
import { spawnSync } from 'node:child_process'

async function main(): Promise<void> {
  const problems: string[] = []
  const warnings: string[] = []

  // 1) DB ping
  let dbOk = false
  try {
    await db.$queryRaw`SELECT 1`
    dbOk = true
    console.log('✓ DB: dostopna')
  } catch (e) {
    console.error('✗ DB: nedostopna —', (e as Error).message)
    process.exit(2)
  }

  // 2) dogodkovna vrsta
  const [pending, failed, lastEvent] = await Promise.all([
    db.eventLog.count({ where: { status: 'pending' } }),
    db.eventLog.count({ where: { status: 'failed' } }),
    db.eventLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { type: true, status: true, createdAt: true } }),
  ])
  console.log(`✓ EventLog: pending=${pending} failed=${failed}${lastEvent ? ` (zadnji: ${lastEvent.type}/${lastEvent.status} @ ${lastEvent.createdAt.toISOString()})` : ' (prazna vrsta)'}`)
  if (failed > 0) warnings.push(`EventLog: ${failed} neuspelih dogodkov (retry do 5 poskusov; ročno: POST /api/events/dispatch)`)
  if (pending > 100) warnings.push(`EventLog: ${pending} čakajočih — preveri dispatch`)

  // 3) naprave
  const since = new Date(Date.now() - 10 * 60_000)
  const [devicesTotal, devicesOnline] = await Promise.all([
    db.deviceRegistry.count(),
    db.deviceRegistry.count({ where: { lastSeenAt: { gte: since } } }).catch(() => -1),
  ])
  if (devicesOnline >= 0) {
    console.log(`✓ Naprave: ${devicesOnline}/${devicesTotal} online (zadnjih 10 min)`)
    if (devicesTotal > 0 && devicesOnline === 0) warnings.push('Naprave: nobena online')
  } else {
    console.log(`~ Naprave: ${devicesTotal} registriranih (lastSeenAt ni na voljo)`)
  }

  // 4) drift sheme
  const drift = spawnSync('node', ['scripts/check-schema-drift.cjs'], { encoding: 'utf8' })
  const driftOk = drift.status === 0
  console.log(driftOk ? '✓ Shema: brez drifta (schema.prisma ↔ sqlite zrcalo)' : '✗ Shema: DRIFT!')
  if (!driftOk) problems.push('Schema drift — zagon: python3 scripts/build-sqlite-mirror.py')

  // 5) kritične številke
  const [ordersToday, openOrders] = await Promise.all([
    db.order.count({ where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }).catch(() => -1),
    db.order.count({ where: { status: 'open' } }).catch(() => -1),
  ])
  console.log(`✓ Naročila: danes=${ordersToday} odprtih=${openOrders}`)

  await db.$disconnect()

  if (problems.length) {
    console.error('\nKRITIČNO:', problems.join('; '))
    process.exit(2)
  }
  if (warnings.length) {
    console.warn('\nOPOZORILA:', warnings.join('; '))
    process.exit(1)
  }
  console.log('\nSISTEM: zdrav ✓')
  process.exit(0)
}

void main()
