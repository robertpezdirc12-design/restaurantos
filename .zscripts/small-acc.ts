import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  console.log('=== Counter (15) ===')
  for (const c of await db.counter.findMany({ select: { name: true, value: true } })) console.log(`  ${c.name} = ${c.value}`)
  console.log('=== DeliveryInfo ===')
  for (const d of await db.deliveryInfo.findMany()) console.log(`  orderId=${d.orderId?.slice(0,14)} phone=${d.phone} addr=${(d as any).address?.slice(0,30)}`)
  console.log('=== AIConversation ===')
  for (const a of await db.aIConversation.findMany({ select: { id: true, locationId: true } })) console.log(`  id=${a.id.slice(0,10)} loc=${a.locationId?.slice(0,16)}`)
  console.log('=== IntegrationLog (clean) ===')
  for (const l of await db.integrationLog.findMany()) console.log(`  integrationId=${l.integrationId.slice(0,14)} action=${l.action} status=${l.status}`)
  console('=== reservation FK otroci check: waitlistEntry ===')
  const wl = await db.waitlistEntry.count()
  console.log(`waitlistEntry: ${wl}`)
}
main().finally(() => db.$disconnect())
