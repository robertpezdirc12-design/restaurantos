import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const gcs = await db.giftCard.findMany()
  for (const gc of gcs) console.log(`GC ${JSON.stringify(gc).slice(0, 150)}`)
  const gs = await db.guest.findMany()
  for (const g of gs) console.log(`GOST ${JSON.stringify(g).slice(0, 120)}`)
  const cs = await db.coupon.findMany()
  for (const c of cs) console.log(`KUPON ${JSON.stringify(c).slice(0, 130)}`)
}
main().finally(() => db.$disconnect())
