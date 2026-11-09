import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
const db = new PrismaClient()
const demoId = createHash('sha1').update('loc-main').digest('hex').slice(0, 20)
async function main() {
  const loc = await db.location.findFirst({ select: { id: true, name: true, premisesId: true } })
  console.log('demo nid(loc-main)=', demoId)
  console.log('ediná lokacija:', JSON.stringify(loc))
  const ev = await db.eventLog.findMany({ take: 2, orderBy: { createdAt: 'desc' } })
  for (const e of ev) console.log('eventLog locId=', e.locationId)
}
main().finally(() => db.$disconnect())
