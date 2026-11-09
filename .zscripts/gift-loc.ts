import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  for (const gc of await db.giftCard.findMany({ select: { id: true, locationId: true } })) console.log(`GC locId=${gc.locationId}`)
  for (const la of await db.loyaltyAccount.findMany({ select: { id: true, locationId: true } })) console.log(`LA locId=${la.locationId}`)
}
main().finally(() => db.$disconnect())
