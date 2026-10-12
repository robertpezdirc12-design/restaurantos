import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'
import { pushNotify } from '@/lib/push'

/**
 * OPS-7 (v1.70.0) — testno push obvestilo prijavljenemu zaposlenemu.
 * POST /api/push/test → pošlje obvestilo na vse aktivne naročnine prijavljenega.
 */
export async function POST(req: NextRequest) {
  const user = await requireAuth(req)
  if (isResponse(user)) return user
  void pushNotify(
    { title: 'RestavrantOS — test', body: `Push obvestila delujejo (${user.name}).`, url: '/dashboard', tag: 'test' },
    { employeeIds: [user.sub] },
  )
  return ok({ sent: true })
}
