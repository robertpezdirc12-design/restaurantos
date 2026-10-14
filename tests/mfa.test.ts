import { describe, it, expect } from 'bun:test'
import {
  base32Encode, base32Decode, hotp, totpVerify, generateSecret, otpauthUri,
  generateRecoveryCodes, recoveryCodeHash, recoveryHashesToStore, consumeRecoveryCode,
  roleRequiresMfa,
} from '@/lib/mfa'

/**
 * Issue #12 §3 — MFA testi (čista logika, brez DB).
 * RFC 6238 testni vektorji (SHA-1, skrivnost "12345678901234567890", 8-mestne kode).
 */
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('mfa base32 (RFC 4648)', () => {
  it('encode: znani vektorji (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6')
    expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ')
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB')
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })
  it('decode: znani vektorji + toleranca na velikost/presledke/padding', () => {
    expect(Buffer.from(base32Decode('MZXW6')!).toString()).toBe('foo')
    expect(Buffer.from(base32Decode('mzxw6yq')!).toString()).toBe('foob')
    expect(Buffer.from(base32Decode('MZXW6YTB')!).toString()).toBe('fooba')
    expect(Buffer.from(base32Decode('MZXW6YTB OI')!).toString()).toBe('foobar')
    expect(Buffer.from(base32Decode('MZXW6===')!).toString()).toBe('foo')
  })
  it('roundtrip: naključni bajti preživijo encode→decode', () => {
    for (let i = 0; i < 20; i++) {
      const buf = new Uint8Array(Array.from({ length: 20 }, () => Math.floor(Math.random() * 256)))
      expect(base32Decode(base32Encode(Buffer.from(buf)))!.equals(Buffer.from(buf))).toBe(true)
    }
  })
  it('decode: neveljaven znak → null, prazen → null', () => {
    expect(base32Decode('ABC1!')).toBeNull() // 1 ni v base32 abecedi
    expect(base32Decode('')).toBeNull()
  })
})

describe('mfa TOTP — RFC 6238 testni vektorji (SHA-1, 8 digit)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [t, code] of vectors) {
    it(`T=${t} → ${code}`, () => {
      const counter = Math.floor(t / 30) // RFC: counter = T/X, celo število
      expect(hotp(RFC_SECRET_BASE32, counter, 8)).toBe(code)
      expect(totpVerify(RFC_SECRET_BASE32, code, { digits: 8, nowMs: t * 1000, window: 0 })).not.toBeNull()
    })
  }
})

describe('mfa TOTP — 6 mest + okno ±1 (produkcija)', () => {
  const secret = generateSecret()
  it('koda trenutnega koraka je sprejeta', () => {
    const now = 1_700_000_000_000
    const counter = Math.floor(now / 1000 / 30)
    const code = hotp(secret, counter, 6)!
    expect(code).toMatch(/^\d{6}$/)
    expect(totpVerify(secret, code, { nowMs: now })).toBe(counter)
  })
  it('koda ±1 korak je sprejeta (toleranca ure)', () => {
    const now = 1_700_000_000_000
    const counter = Math.floor(now / 1000 / 30)
    expect(totpVerify(secret, hotp(secret, counter + 1, 6)!, { nowMs: now })).toBe(counter + 1)
    expect(totpVerify(secret, hotp(secret, counter - 1, 6)!, { nowMs: now })).toBe(counter - 1)
  })
  it('koda ±2+ korakov je zavrnjena (okno je samo ±1)', () => {
    const now = 1_700_000_000_000
    const counter = Math.floor(now / 1000 / 30)
    expect(totpVerify(secret, hotp(secret, counter + 2, 6)!, { nowMs: now })).toBeNull()
    expect(totpVerify(secret, hotp(secret, counter - 5, 6)!, { nowMs: now })).toBeNull()
  })
  it('napačna/malformirana koda je zavrnjena (fail-closed)', () => {
    const now = 1_700_000_000_000
    expect(totpVerify(secret, '000000', { nowMs: now, window: 0 })).toBeNull()
    expect(totpVerify(secret, '12345', { nowMs: now })).toBeNull()
    expect(totpVerify(secret, 'abcdef', { nowMs: now })).toBeNull()
    expect(totpVerify(secret, '', { nowMs: now })).toBeNull()
  })
  it('presledki v kodi so tolerantni (100 000 oblika), vsebina pomen', () => {
    const now = 1_700_000_000_000
    const counter = Math.floor(now / 1000 / 30)
    const code = hotp(secret, counter, 6)!
    expect(totpVerify(secret, code.slice(0, 3) + ' ' + code.slice(3), { nowMs: now })).toBe(counter)
  })
})

describe('mfa skrivnost + otpauth URI', () => {
  it('skrivnost: base32, 160 bitov (32 znakov), unikatna', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).toMatch(/^[A-Z2-7]{32}$/)
    expect(a).not.toBe(b)
    expect(base32Decode(a)!.length).toBe(20)
  })
  it('otpauth URI vsebuje issuer, skrivnost in parametre', () => {
    const uri = otpauthUri('admin@restaurantos.app', 'ABC234DEF567')
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('RestaurantOS%3Aadmin%40restaurantos.app')
    expect(uri).toContain('secret=ABC234DEF567')
    expect(uri).toContain('issuer=RestaurantOS')
    expect(uri).toContain('digits=6')
  })
})

describe('mfa recovery kode (enkratna uporaba, v DB samo hashi)', () => {
  it('generacija: 8 kod v obliki XXXX-XXXX brez zmedenih znakov', () => {
    const codes = generateRecoveryCodes(8)
    expect(codes).toHaveLength(8)
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(new Set(codes).size).toBe(8)
  })
  it('hashi se razlikujejo od plain kode (v DB ni plain kode)', () => {
    const codes = generateRecoveryCodes(3)
    const hashes = recoveryHashesToStore(codes)
    expect(hashes).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(hashes[i]).not.toBe(codes[i])
    expect(recoveryCodeHash(codes[0])).toMatch(/^[0-9a-f]{64}$/)
  })
  it('poraba: veljavna koda ok + remaining 7; ista koda znova NEUSPEŠNA', () => {
    const codes = generateRecoveryCodes(8)
    const hashes = recoveryHashesToStore(codes)
    const first = consumeRecoveryCode(codes[0], hashes)
    expect(first.ok).toBe(true)
    expect(first.remaining).toHaveLength(7)
    // ista koda je porabljena — ponovna uporaba ne uspe (replay zaščita)
    expect(consumeRecoveryCode(codes[0], first.remaining).ok).toBe(false)
  })
  it('normalizacija: velike/male črke in manjkajoč pomišljaj so enakovredni', () => {
    const codes = generateRecoveryCodes(4)
    const hashes = recoveryHashesToStore(codes)
    expect(consumeRecoveryCode(codes[0].toLowerCase(), hashes).ok).toBe(true)
    expect(consumeRecoveryCode(codes[1].replace('-', ''), hashes).ok).toBe(true)
    expect(consumeRecoveryCode(codes[2].toLowerCase().replace('-', ' '), hashes).ok).toBe(true)
  })
  it('neznana koda → fail, prazen seznam → fail', () => {
    const codes = generateRecoveryCodes(4)
    const hashes = recoveryHashesToStore(codes)
    expect(consumeRecoveryCode('XXXX-XXXX', hashes).ok).toBe(false)
    expect(consumeRecoveryCode(codes[0], []).ok).toBe(false)
    expect(consumeRecoveryCode('', hashes).ok).toBe(false)
  })
})

describe('mfa vloge (privilegirane po issue #12 §3 + #31 v1.94.0)', () => {
  it('owner/admin/manager/group_owner/org_admin/property_manager zahtevajo MFA', () => {
    for (const r of ['owner', 'admin', 'manager', 'group_owner', 'org_admin', 'property_manager']) {
      expect(roleRequiresMfa(r)).toBe(true)
    }
  })
  it('operativne vloge NE zahtevajo MFA (PIN prijava ostaja)', () => {
    // v1.94.0 (#31): manager PREMAŠČEN med privilegirane — permissions.ts mu dodeli
    // VSA kanonična dovoljenja (enak obseg kot owner/admin) → MFA obvezna;
    // dokumentirano v docs/SECURITY-BOUNDARY.md (izrecna odločitev issue #31).
    for (const r of ['staff', 'waiter', 'bar', 'chef', 'kitchen', 'warehouse', 'accounting']) {
      expect(roleRequiresMfa(r)).toBe(false)
    }
    expect(roleRequiresMfa('')).toBe(false)
  })
})
