import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  console.log('=== Counter (15) ===')
  for (const c of await db.counter.findMany({ select: { name: true, value: true } })) console.log(`  ${c.name} = ${c.value}`)
  console.log('=== DeliveryInfo ===')
  for (const d of await db.deliveryInfo.findMany()) console.log(`  orderId=${(d as any).orderId} phone=${(d as any).phone}`)
  console.log('=== AIConversation ===')
  for (const a of await db.aIConversation.findMany({ select: { employeeId: true, type: true } })) console.log(`  emp=${a.employeeId?.slice(0,18)} type=${a.type}`)
  console.log('=== IntegrationLog ===')
  for (const l of await db.integrationLog.findMany()) console.log(`  intId=${l.integrationId.slice(0,16)} action=${l.action}`)
}
main().finally(() => db.$disconnect())
