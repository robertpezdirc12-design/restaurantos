/**
 * Issue #11 §8 — sync-status: status sinhronizacije (git + deviceskе sync operacije).
 * Poganjanje: bun scripts/sync-status.ts  (izhod 0 = OK, 1 = opozorilo)
 * Poroča: git remote-ji + zadnji commit,DeviceSyncOperation statistika (pending/failed),
 * nedavni sync dogodki po napravi.
 */
import { db } from '../src/lib/db'
import { execSync } from 'node:child_process'

function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim()
  } catch {
    return '(ni na voljo)'
  }
}

async function main(): Promise<void> {
  let warn = false

  console.log('── GIT ──')
  console.log('branch :', git('git rev-parse --abbrev-ref HEAD'))
  console.log('head   :', git('git log -1 --format=%h %s'))
  console.log('origin :', git('git remote get-url origin').replace(/\/\/[^@]*@/, '//***@'))
  console.log('github :', git('git remote get-url github').replace(/\/\/[^@]*@/, '//***@'))
  const unpushed = git('git log origin/main..HEAD --oneline | wc -l')
  if (unpushed !== '(ni na voljo)' && Number(unpushed) > 0) {
    console.warn(`⚠ ${unpushed} commit(ov) še ni pushanih na origin/main`)
    warn = true
  } else {
    console.log('origin/main: sinhroniziran ✓')
  }

  console.log('\n── NAPRAVE (DeviceSyncOperation) ──')
  try {
    const [pending, failed, total, recent] = await Promise.all([
      db.deviceSyncOperation.count({ where: { status: 'applied' } }).catch(() => -1),
      db.deviceSyncOperation.count({ where: { status: 'failed' } }).catch(() => -1),
      db.deviceSyncOperation.count().catch(() => -1),
      db.deviceSyncOperation.findMany({
        orderBy: { receivedAt: 'desc' },
        take: 5,
        select: { id: true, deviceId: true, operationType: true, status: true, receivedAt: true },
      }).catch(() => []),
    ])
    if (pending >= 0) console.log(`operacije: total=${total} applied=${pending} failed=${failed}`)
    if (failed > 0) {
      console.warn(`⚠ ${failed} neuspelih sync operacij`)
      warn = true
    }
    for (const r of recent) {
      console.log(`  ${r.receivedAt.toISOString()} ${r.deviceId.slice(0, 12)} ${r.operationType} ${r.status}`)
    }
  } catch (e) {
    console.log('~ DeviceSyncOperation ni na voljo:', (e as Error).message.slice(0, 80))
  }

  console.log('\n── EVENTLOG (dogodkovna vrsta) ──')
  try {
    const [pending, failed] = await Promise.all([
      db.eventLog.count({ where: { status: 'pending' } }),
      db.eventLog.count({ where: { status: 'failed' } }),
    ])
    console.log(`dogodki: pending=${pending} failed=${failed}`)
    if (failed > 0) warn = true
  } catch (e) {
    console.log('~ EventLog ni na voljo:', (e as Error).message.slice(0, 80))
  }

  await db.$disconnect()
  process.exit(warn ? 1 : 0)
}

void main()
