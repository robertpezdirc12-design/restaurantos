import { PrismaClient, Prisma } from '@prisma/client'

// Query log je IZBIREN (audit okt-2026 №23). Pri prižganem logu celoten testni
// proračun natisne 17.044.192 B (59.255 `prisma:query` vrstic), kar je nad
// 4.194.304 B omejitvijo GitLab-jevega jobskega loga: quality-gate umre sredi
// testov, zato se `check-secrets.sh` in `check-schema-drift.cjs` nikoli ne
// izvedeta. V produkciji isti izpis nosi obliko vsakega posega v log drain.
// Prejšnja vrednost `['query']` je bila hkrati edina stopnja, zato Prisma
// svojih `warn`/`error` sporočil ni pisala nikoli.
// Ročno razhroščevanje lokalno: PRISMA_LOG_QUERIES=1.
const LOG_LEVELS: Prisma.LogLevel[] =
  process.env.PRISMA_LOG_QUERIES === '1' ? ['query', 'warn', 'error'] : ['warn', 'error']

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: LOG_LEVELS,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db