/**
 * Najdba №23 (v1.151.0) — izmerljivi sondažni klic.
 *
 * Namen: audit testu omogočiti, da BEZ celotnega suite-a dokaže, ali
 * `src/lib/db.ts` res logira poizvedbe. Cena: en sam $queryRaw klic.
 * Namerno ni v `tests/`, da ne povečuje števila testov in ne teče v CI.
 */
import { db } from '../src/lib/db'

await db.$queryRaw`SELECT 1`
console.log('PROBE_OK')
await db.$disconnect()
