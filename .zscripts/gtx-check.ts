import { PrismaClient } from '@prisma/client'
import { TEST_PREFIXES } from '../tests/helpers/fixture-sweep'
const db = new PrismaClient()
function pref(v: string): string | null { for (const p of TEST_PREFIXES) if (v && (v.startsWith(p) || v.includes(p))) return p; return null }
async function main() {
  for (const t of await db.giftCardTransaction.findMany()) {
    const hits: Record<string, string> = {}
    for (const [k, v] of Object.entries(t)) if (typeof v === 'string' && pref(v)) hits[k] = v.slice(0, 40)
    console.log(`GTX ${JSON.stringify(hits).slice(0, 120)} type=${t.type}`)
  }
  const la = await db.loyaltyAccount.findMany({ select: { customerName: true, customerEmail: true } })
  for (const a of la) console.log(`LA ime="${a.customerName}" email=${a.customerEmail}`)
}
main().finally(() => db.$disconnect())
