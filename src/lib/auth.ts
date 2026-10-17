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
// AUDIT-FIX v1.82.1: javna konstanta v repozitoriju kot fallback = DB leak omogoča
// offline brute-force 4–8-mestnega PIN prostora (10^4–10^8 HMAC izračunov).
// Brez env vrednosti v produkciji sedaj sol IZVEDEMO iz APP_SECRET (nejavna,
// unikatna per deployment). Prijava ostane združljiva: pinOk sprejema pinLookup
// ALI scrypt(pin, email) — obstoječi PIN-i se preverijo prek scrypt poti,
// novi/resetirani zapišejo novi pinLookup. Eksplicitna env vrednost ima prednost.
// Fail-closed throw bi ONEMOGOČIL deploy, če env ni nastavljen (za razliko od
// APP_SECRET ga ne moremo preveriti iz repozitorija) — izvedena sol je varna
// alternativa brez izpadov.
const PIN_LOOKUP_SALT = process.env.PIN_LOOKUP_SALT
  || (isProd
    ? crypto.createHmac('sha256', APP_SECRET).update('restaurantos-pin-lookup-salt-v1').digest('hex')
    : 'restaurantos-pin-lookup-v1')
if (isProd && !process.env.PIN_LOOKUP_SALT) {
  // glasen zapis — operator naj nastavi eksplicitni env (rotacija: glej komentar zgoraj)
  console.error('[auth] PIN_LOOKUP_SALT ni nastavljen — izveden iz APP_SECRET. Priporočeno: nastavite PIN_LOOKUP_SALT env na Vercelu.')
}

export interface AuthPayload {
  sub: string
  name: string
  /** Email for temporary environment-backed bootstrap identities. */
  email?: string
  role: string
  loc: string | null
  exp: number
  /** Issue #4 D4: sessionVersion ob izdaji žetona — sprememba PIN-a/deaktivacija prekliče sejo. */
  sv?: number
  /**
   * Issue #31 (v1.94.0): omejen mfa-enrollment-only žeton — izda se SAMO ob
   * prijavi privilegiranega računa brez MFA, ko je enforcement aktiven
   * (MFA_ENFORCE_AFTER). Dovoljuje SAMO /api/auth/mfa/** + /api/auth/me
   * (requireAuth); vsak dovoljenjski sloj (requirePermission*) ga zavrne.
   * Umrne ob enable (sessionVersion bump) ali spremembi stanja.
   */
  mfaEnrollOnly?: boolean
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

/**
 * AUDIT-FIX v1.82.1 — dosledno timing-safe primerjava nizov (enaka disciplina kot
 * verifyToken/matchesBootstrap/delivery webhook/MFA/CRON_SECRET). Uporabljeno v
 * login poti za pinLookup/pin primerjave. Dolžina se primerja ločeno (varno —
 * dolžina ni skrivnost za hex digest fiksne dolžine).
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
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
