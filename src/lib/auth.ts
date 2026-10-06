import crypto from 'crypto'
import { NextRequest } from 'next/server'

const APP_SECRET = process.env.APP_SECRET || 'restaurantos-reconstruction-dev-secret'

export interface AuthPayload {
  sub: string
  name: string
  role: string
  loc: string | null
  exp: number
}

function sign(data: string): string {
  return crypto.createHmac('sha256', APP_SECRET).update(data).digest('base64url')
}

export function createToken(p: Omit<AuthPayload, 'exp'>, hours = 12): string {
  const payload: AuthPayload = { ...p, exp: Date.now() + hours * 3600_000 }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

export function verifyToken(token: string): AuthPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = sign(body)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AuthPayload
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function getAuth(req: NextRequest): AuthPayload | null {
  const header = req.headers.get('authorization') || ''
  if (!header.startsWith('Bearer ')) return null
  return verifyToken(header.slice(7))
}

/** Capability check — poenostavljen kanon (v duhu R268): FAIL-CLOSED */
export function canAccessModule(user: AuthPayload | null, module: string, adminOnly = false): boolean {
  if (!user) return false
  if (adminOnly) return user.role === 'ADMIN'
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return true
  const allowed: Record<string, string[]> = {
    WAITER: ['tables', 'orders', 'menus', 'dashboard', 'reservations'],
    KITCHEN: ['kitchen', 'menus', 'dashboard'],
    KIOSK: ['orders', 'menus'],
  }
  return (allowed[user.role] || []).includes(module)
}

export function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 32).toString('hex')
}
