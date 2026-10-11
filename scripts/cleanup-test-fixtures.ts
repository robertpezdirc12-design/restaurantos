/**
 * Task 58 — one-time čiščenje testnih fiksur iz dev SQLite.
 *
 * Uporaba:  bun run scripts/cleanup-test-fixtures.ts [--dry]
 *   --dry   samo poročaj, ne briši (ni implementirano potrebe — brisanje je
 *           vedno omejeno na testne id-predpone)
 *
 * Primer izhoda:
 *   location: 25  menu: 25  ...
 *   remainingLocations: 0   errors: 0
 *
 * VARNOST: ključavnica v tests/helpers/fixture-sweep.ts dovoli izključno
 * DATABASE_URL=file:… (dev SQLite). Oddaljena baza → trda napaka.
 */
import { db } from '../src/lib/db'
import { TEST_PREFIXES, sweepTestFixtures } from '../tests/helpers/fixture-sweep'

async function main() {
  const res = await sweepTestFixtures(db, TEST_PREFIXES)
  const entries = Object.entries(res.tables)
  if (entries.length === 0) {
    console.log('Čisto — ni ostankov testnih fiksur.')
  } else {
    for (const [table, count] of entries.sort((a, b) => b[1] - a[1])) {
      console.log(`${table}: ${count}`)
    }
  }
  console.log(`remainingLocations: ${res.remainingLocations}`)
  console.log(`errors: ${res.errors.length}`)
  for (const e of res.errors.slice(0, 10)) console.log(`  ! ${e}`)
  await db.$disconnect()
  if (res.remainingLocations > 0) process.exitCode = 1
}

void main()
