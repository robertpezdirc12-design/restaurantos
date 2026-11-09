import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  console.log('=== DeliveryInfo polne vrstice ===')
  for (const d of await db.deliveryInfo.findMany()) console.log('  ' + JSON.stringify(d).slice(0, 200))
  console.log('=== Integracije (vse) ===')
  for (const i of await db.integration.findMany({ select: { id: true, name: true, type: true, locationId: true } })) console.log(`  id=${i.id.slice(0,14)} name="${i.name}" type=${i.type} loc=${i.locationId?.slice(0,14)}`)
}
main().finally(() => db.$disconnect())
