import crypto from 'crypto'
import { NextRequest } from 'next/server'

/**
 * Issue #4 §15 — secret hygiene:
 * V produkciji (NODE_ENV=production) APP_SECRET MORA biti nastavljen prek env
 * — hardkodiran dev fallback je bilo DOVOLJENO podpisovati produkcijske žetone
 * (kdorkoli z repozitorijem je lahko koval žetone). Fail-closed: brez env se
 * modul ne zažene (Vercel env je nastavljen pred tem deployem).
 * Lokalni dev sme uporabiti fallback.
 */
const isProd = process.env.NODE_ENV === 'production'
const APP_SECRET = process.env.APP_SECRET || (isProd ? '' : 'restaurantos-reconstruction-dev-secret')
if (isProd && !APP_SECRET) {
  throw new Error('APP_SECRET ni nastavljen — produkcija zahteva APP_SECRET env (issue #4 §15).')
}
// PIN_LOOKUP_SALT: rotacija bi zaklenila obstoječe PIN-e (scrypt hash je vezan na salt)
// → rotacija samo z usklajeno ponastavitvijo vseh PIN-ov (glej PRODUCTION-HARDENING-REPORT.md)
const PIN_LOOKUP_SALT = process.env.PIN_LOOKUP_SALT || 'restaurantos-pin-lookup-v1'

export interface AuthPayload {
  sub: string
  name: string
  role: string
  loc: string | null
  exp: number
  /** Issue #4 D4: sessionVersion ob izdaji žetona — sprememba PIN-a/deaktivacija prekliče sejo. */
  sv?: number
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

/**
 * Issue #4 D4 — session revokacija (fail-closed):
 * žeton brez sv (starejši kot ta deploy) velja za preklicanega → prisilna ponovna prijava.
 * Odstopanje od trenutnega Employee.sessionVersion (PIN reset / deaktivacija) → preklic.
 * Bootstrap admin (brez Employee vrstice) te poti ne doseže (fast-path v api.ts).
 */
export function sessionRevoked(tokenSv: number | undefined | null, dbSv: number): boolean {
  if (typeof tokenSv !== 'number' || !Number.isFinite(tokenSv)) return true
  return tokenSv !== dbSv
}

/** Capability check — poenostavljen kanon (v duhu R268): FAIL-CLOSED */
export function canAccessModule(user: AuthPayload | null, module: string, adminOnly = false): boolean {
  if (!user) return false
  if (adminOnly) return user.role === 'ADMIN'
  if (user.role === 'OWNER' || user.role === 'ADMIN' || user.role === 'MANAGER') return true
  const allowed: Record<string, string[]> = {
    WAITER: ['tables', 'orders', 'menus', 'dashboard', 'reservations'],
    KITCHEN: ['kitchen', 'menus', 'dashboard'],
    KIOSK: ['orders', 'menus'],
  }
  return (allowed[user.role] || []).includes(module)
}

/**
 * PIN shema (produkcijska polja Employee.pin + Employee.pinLookup):
 *  - pin       = scryptSync(pin, email, 32).hex  (nepovratno, per-employee sol)
 *  - pinLookup = HMAC-SHA256(pin, konstanta)     (determinističen indeks za iskanje)
 */
export function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 32).toString('hex')
}

export function pinLookupValue(pin: string): string {
  return crypto.createHmac('sha256', PIN_LOOKUP_SALT).update(pin).digest('hex')
}

export function employeePinFields(pin: string, email: string): { pin: string; pinLookup: string } {
  return {
    pin: hashPin(pin, email.trim().toLowerCase()),
    pinLookup: pinLookupValue(pin),
  }
}

/** Bootstrap prijava prek env (za obnovo dostopa — nastavi BOOTSTRAP_ADMIN_EMAIL/PIN na Vercelu) */
export function matchesBootstrap(email: string, pin: string): boolean {
  const bEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
  const bPin = process.env.BOOTSTRAP_ADMIN_PIN
  if (!bEmail || !bPin) return false
  if (email.trim().toLowerCase() !== bEmail.trim().toLowerCase()) return false
  const a = Buffer.from(pin)
  const b = Buffer.from(bPin)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
