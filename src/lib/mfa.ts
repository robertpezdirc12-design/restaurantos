/**
 * Issue #12 §3 — MFA (TOTP, RFC 6238/4226) za privilegirane račune.
 *
 * Načrtovanje:
 *  - čista node crypto (HMAC-SHA1) — BREZ novih odvisnosti (§9: razširi obstoječe);
 *  - base32 kodiranje skrivnosti (RFC 4648) — združljivo z Google Authenticator/Aegis;
 *  - 6-mestne kode, korak 30 s, okno ±1 korak (toleranca za ure/omrežje);
 *  - RFC 6238 testni vektorji (8-mestne) podprti prek `digits` parametra za teste;
 *  - recovery kode: 8× enkratna uporaba, v DB SAMO SHA-256 hashi (leak → ne uporabne);
 *  - ne lomi PIN prijave navadnih zaposlenih: MFA je aktivna SAMO ko je mfaEnabled=true.
 */

import crypto from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 encode (brez presledkov, velike črke, brez '=' paddinga). */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
      // porabljene bite odstranimo — value ostane < 2^5 (brez 32-bit overflowa pri dolgih vhodih)
      value &= (1 << bits) - 1
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** RFC 4648 base32 decode — toleranten na presledke/velikost/padding; null ob neveljavnem vnosu. */
export function base32Decode(input: string): Buffer | null {
  const clean = (input || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!clean) return null
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** HOTP (RFC 4226) — HMAC-SHA1, dinamično odrezavanje. */
export function hotp(secretBase32: string, counter: number, digits = 6): string | null {
  const key = base32Decode(secretBase32)
  if (!key || !Number.isInteger(counter) || counter < 0) return null
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(code % 10 ** digits).padStart(digits, '0')
}

export interface TotpVerifyOptions {
  /** časovno okno v korakih (30 s) — privzeto ±1 */
  window?: number
  digits?: number
  /** čas v ms (za teste); privzeto now() */
  nowMs?: number
  stepSeconds?: number
}

/**
 * TOTP preverba (RFC 6238) — primerja kandidatne kode za ±window korakov.
 * Konstantnočasovno primerjanje (timingSafeEqual) — brez timing puščanj.
 * Vrne korak (counter) pri uspehu, pri neuspehu null (uporabno proti replay znotraj istega koraka).
 */
export function totpVerify(secretBase32: string, code: string, opts: TotpVerifyOptions = {}): number | null {
  const { window = 1, digits = 6, nowMs = Date.now(), stepSeconds = 30 } = opts
  const clean = String(code || '').replace(/\s+/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return null
  const counter = Math.floor(nowMs / 1000 / stepSeconds)
  for (let drift = -window; drift <= window; drift++) {
    const candidate = hotp(secretBase32, counter + drift, digits)
    if (!candidate) continue
    const a = Buffer.from(candidate)
    const b = Buffer.from(clean)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return counter + drift
  }
  return null
}

/** Nova naključna skrivnost (20 bajtov = 160 bitov, base32) — Apple/Google priporočilo. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20))
}

/** otpauth:// URI za QR kode (združljivo z Google Authenticator). */
export function otpauthUri(email: string, secret: string, issuer = 'RestaurantOS'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}

/* ─────────────── Recovery kode (enkratna uporaba, v DB samo hashi) ─────────────── */

/** 8 recovery kod (XXXX-XXXX, brez zmedi znakov 0/O/1/I). */
export function generateRecoveryCodes(count = 8): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8)
    let code = ''
    for (let j = 0; j < 8; j++) code += alphabet[bytes[j] % alphabet.length]
    out.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return out
}

/** SHA-256 hash recovery kode (kanonska oblika: brez ločil, velike črke). */
export function recoveryCodeHash(code: string): string {
  return crypto.createHash('sha256').update(String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex')
}

export function recoveryHashesToStore(codes: string[]): string[] {
  return codes.map(recoveryCodeHash)
}

/**
 * Poraba recovery kode — najde indeks hash-a (timing-varen), vrnitveni seznam brez porabljenega.
 * Vrne { ok, remaining } — caller shrani remaining v DB SAMO pri ok=true (atomsko).
 */
export function consumeRecoveryCode(code: string, storedHashes: string[]): { ok: boolean; remaining: string[] } {
  const hash = recoveryCodeHash(code)
  if (!hash || storedHashes.length === 0) return { ok: false, remaining: storedHashes }
  const remaining: string[] = []
  let ok = false
  for (const h of storedHashes) {
    if (h === hash) {
      ok = true // porabljena — ne gre nazaj v remaining
      continue
    }
    remaining.push(h)
  }
  return { ok, remaining }
}

/**
 * Privilegirane vloge (DB nivo) — MFA zahtevana po issue #12 §3.
 *
 * Issue #31 (v1.94.0) — IZRECNA odločitev o MANAGER:
 * src/lib/permissions.ts dodeli 'manager' VSA kanonična dovoljenja (enak
 * obseg kot owner/admin, dokler #5 ne zoži profila). Varstvo skrivnosti in
 * pravic brez MFA bi bilo neskladno z ostalimi centralnimi vlogami →
 * manager ZDAJ zahteva MFA. Ostale operativne vloge (staff/waiter/bar/chef/
 * kitchen/warehouse/accounting) ostajajo na PIN prijavi (brez MFA).
 */
export const PRIVILEGED_MFA_ROLES = ['owner', 'admin', 'manager', 'group_owner', 'org_admin', 'property_manager'] as const

export function roleRequiresMfa(role: string): boolean {
  return (PRIVILEGED_MFA_ROLES as readonly string[]).includes(String(role || '').toLowerCase())
}

/* ─────────────── Issue #31 — strežniško uveljavljanje (enforcement) ─────────────── */

/**
 * Veljavnost enrollment-only žetona (sub=Employee.id, mfaEnrollOnly: true).
 * 1 h: dovolj časa za enroll + enable, prekratko za dolgotrajno zlorabo.
 */
export const MFA_ENROLLMENT_ONLY_HOURS = 1

/**
 * Issue #31 §A — prehod iz migracijskega (soft prompt) v STROGO uveljavljanje.
 *
 * MFA_ENFORCE_AFTER (Vercel env): ISO datum ali epoch-ms niz. Po tem trenutku
 * privilegiran račun brez mfaEnabled=true pri prijavi dobi SAMO omejen
 * mfa-enrollment-only žetoni (1 h), requireAuth pa takoj zavrne občutljive
 * klice (401 mfaRequired). Vsa ostala seja ostane na mehki politiki
 * (mfaMandatory zastavica + UI nagovor) — obstoječi računi se NE zaklenejo
 * nenapovedano (migracijska zahteva issue-ja).
 *
 * Nastavitev/unveljaven → false (migracijsko obdobje). Prebere se ob vsakem
 * klicu (testi lahko env prosto nastavljajo; operater lahko datum prestavi).
 */
export function mfaEnforcementActive(nowMs = Date.now()): boolean {
  const raw = (process.env.MFA_ENFORCE_AFTER || '').trim()
  if (!raw) return false
  const ts = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
  return Number.isFinite(ts) && nowMs >= ts
}
