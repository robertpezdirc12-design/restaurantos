import { NextRequest } from 'next/server'
import { requireAuth, isResponse, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  const user = requireAuth(req)
  if (isResponse(user)) return user
  return ok({ webhookEndpoints: [] })
}
