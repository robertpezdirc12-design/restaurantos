// RestaurantOS — Neon ephemeral-branch smoke test (CI)
// Verifies on REAL Postgres (Neon): full prisma DDL applies, FK-chain CRUD,
// enum roundtrip, numeric roundtrip, FK enforcement. Ephemeral branch +
// throwaway role + dedicated database are deleted with the branch afterwards.
//
// Env:
//   SMOKE_URL  postgresql://user:pass@host/db?sslmode=require  (db owned by user)
//   DDL_FILE   path to prisma migrate diff --script output (full schema DDL)
// Exit 0 = pass, 1 = fail.

import postgres from 'postgres';
import { readFileSync } from 'fs';

const SMOKE_URL = process.env.SMOKE_URL || '';
const DDL_FILE = process.env.DDL_FILE || '/tmp/schema_ddl.sql';

if (!SMOKE_URL.startsWith('postgresql://')) {
  console.error('SMOKE-FAIL: SMOKE_URL missing or not postgresql://');
  process.exit(1);
}

const SUFFIX = (process.env.SMOKE_SUFFIX || 'ci').replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20);
const sql = postgres(SMOKE_URL, { ssl: 'require', max: 1, idle_timeout: 5, connect_timeout: 30 });
const t0 = Date.now();
const step = (n, msg) => console.log(`  [${n}] ${msg}`);

try {
  // 0. Warmup — Neon role password propagation can briefly lag compute start
  step(0, 'connection warmup (retries for role propagation)...');
  let warmed = false;
  for (let i = 1; i <= 6; i++) {
    try {
      await sql.unsafe('SELECT 1');
      warmed = true;
      console.log(`  connected (attempt ${i})`);
      break;
    } catch (e) {
      console.log(`  attempt ${i} failed: ${(e.message || '').slice(0, 90)}`);
      if (i === 6) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (!warmed) throw new Error('warmup exhausted');
  // 1. Greenfield DDL apply — every CREATE from prisma/schema.prisma on real PG
  const ddl = readFileSync(DDL_FILE, 'utf8');
  const stmts = ddl
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  step(1, `applying ${stmts.length} DDL statement block(s)...`);
  for (const s of stmts) await sql.unsafe(s);
  const tabs = await sql.unsafe(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
  );
  const tableCount = tabs[0].n;
  console.log(`  DDL applied: ${tableCount} base tables in public schema`);
  if (tableCount < 110) throw new Error(`expected >=110 tables, got ${tableCount}`);

  // 2. FK-chain CRUD: Location -> Menu -> Category -> MenuItem, Location -> Employee
  step(2, 'CRUD golden chain (Location/Menu/Category/MenuItem/Employee)...');
  await sql`INSERT INTO "Location" (id, name, code, "updatedAt") VALUES (${'smk_loc_' + SUFFIX}, 'Smoke Location', 'SM1', now())`;
  await sql`INSERT INTO "Menu" (id, name, "locationId", "updatedAt") VALUES (${'smk_menu_' + SUFFIX}, 'Smoke Menu', ${'smk_loc_' + SUFFIX}, now())`;
  await sql`INSERT INTO "Category" (id, name, "menuId", "updatedAt") VALUES (${'smk_cat_' + SUFFIX}, 'Smoke Cat', ${'smk_menu_' + SUFFIX}, now())`;
  const mi = await sql`INSERT INTO "MenuItem" (id, name, price, "categoryId", allergens, "updatedAt") VALUES (${'smk_item_' + SUFFIX}, 'Burek Smoke', 8.50, ${'smk_cat_' + SUFFIX}, 'gluten', now()) RETURNING id`;
  const emp = await sql`INSERT INTO "Employee" (id, name, email, role, "locationId", "updatedAt") VALUES (${'smk_emp_' + SUFFIX}, 'Smoke Employee', 'smoke@ci.si', 'waiter', ${'smk_loc_' + SUFFIX}, now()) RETURNING id, role`;
  if (emp[0].role !== 'waiter') throw new Error(`enum roundtrip failed: role=${emp[0].role}`);
  console.log(`  inserted MenuItem=${mi[0].id} Employee=${emp[0].id} role=${emp[0].role} (enum OK)`);

  // 3. Numeric roundtrip (DECIMAL) + read-back
  step(3, 'update + numeric read-back...');
  await sql`UPDATE "MenuItem" SET price = 9.00 WHERE id = ${'smk_item_' + SUFFIX}`;
  const back = await sql`SELECT price::float AS p, allergens FROM "MenuItem" WHERE id = ${'smk_item_' + SUFFIX}`;
  if (Number(back[0].p) !== 9.0) throw new Error(`price roundtrip failed: ${back[0].p}`);
  if (back[0].allergens !== 'gluten') throw new Error(`allergens roundtrip failed: ${back[0].allergens}`);
  console.log(`  price 8.50 -> 9.00 OK, allergens=${back[0].allergens}`);

  // 4. FK integrity must be enforced
  step(4, 'FK enforcement check...');
  let fkThrew = false;
  try {
    await sql`INSERT INTO "MenuItem" (id, name, price, "categoryId", "updatedAt") VALUES (${'smk_bad_' + SUFFIX}, 'X', 1, 'nonexistent_cat', now())`;
  } catch (e) {
    fkThrew = /foreign key/i.test(e.message || '');
  }
  if (!fkThrew) throw new Error('FK violation NOT enforced!');
  console.log('  FK violation correctly rejected');

  // 5. JSONB column write/read (mirrors prod Json usage)
  step(5, 'JSONB column check...');
  const jv = await sql`SELECT "permissionOverrides"::text AS j FROM "Employee" WHERE id = ${'smk_emp_' + SUFFIX}`;
  if (!/^(\[\]|\[\s*\])$/.test(jv[0].j.trim())) throw new Error(`JSONB default unexpected: ${jv[0].j}`);

  // 6. Cleanup
  step(6, 'cleanup smoke rows...');
  await sql`DELETE FROM "MenuItem" WHERE id LIKE ${'smk_%_' + SUFFIX}`;
  await sql`DELETE FROM "MenuItem" WHERE id = ${'smk_bad_' + SUFFIX}`;
  await sql`DELETE FROM "Category" WHERE id = ${'smk_cat_' + SUFFIX}`;
  await sql`DELETE FROM "Menu" WHERE id = ${'smk_menu_' + SUFFIX}`;
  await sql`DELETE FROM "Employee" WHERE id = ${'smk_emp_' + SUFFIX}`;
  await sql`DELETE FROM "Location" WHERE id = ${'smk_loc_' + SUFFIX}`;

  console.log(`\nSMOKE PASS in ${((Date.now() - t0) / 1000).toFixed(1)}s — DDL apply + CRUD + enum + DECIMAL + FK + JSONB verified on real Postgres`);
  process.exit(0);
} catch (e) {
  console.error(`SMOKE FAIL: ${(e && e.message) || e}`.slice(0, 400));
  process.exit(1);
} finally {
  try { await sql.end({ timeout: 2 }); } catch {}
}
