/**
 * Issue #2 — dostava (unit, čista logika brez DB).
 * Pokrije acceptance criteria: podpis preverjen pred zapisom, idempotencija,
 * maskiranje občutljivih podatkov, validacija preslikave, rate limiting.
 */
import { describe, it, expect } from 'bun:test'
import { createHmac } from 'crypto'
import {
  verifyWebhookSignature,
  webhookIdempotencyKey,
  maskPhone,
  validateMapped,
  rateLimit,
  type MappedPlatformOrder,
} from '@/lib/delivery'

const SECRET = 'test-secret-za-unit-teste'

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
}

describe('verifyWebhookSignature (Issue #2 §5)', () => {
  const body = JSON.stringify({ order: { id: 'G-1' } })

  it('veljaven podpis z sha256= prefixom', () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true)
  })

  it('veljaven podpis brez prefixa (gol hex)', () => {
    const bare = sign(body).replace(/^sha256=/, '')
    expect(verifyWebhookSignature(body, bare, SECRET)).toBe(true)
  })

  it('tamberan body → zavrnjen', () => {
    expect(verifyWebhookSignature(body + ' ', sign(body), SECRET)).toBe(false)
  })

  it('napačen podpis → zavrnjen', () => {
    expect(verifyWebhookSignature(body, 'sha256=' + '0'.repeat(64), SECRET)).toBe(false)
  })

  it('manjkajoči header ali secret → fail-closed', () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false)
    expect(verifyWebhookSignature(body, sign(body), '')).toBe(false)
  })
})

describe('webhookIdempotencyKey (Issue #2 — proti podvojenim webhookom)', () => {
  it('format platforma:orderId', () => {
    expect(webhookIdempotencyKey('glovo', 'G-100')).toBe('glovo:G-100')
    expect(webhookIdempotencyKey('wolt', 'W-200')).toBe('wolt:W-200')
  })

  it('dvojnemu webhooku nastane ist ključ', () => {
    expect(webhookIdempotencyKey('glovo', 'X-9')).toBe(webhookIdempotencyKey('glovo', 'X-9'))
  })

  it('dolg ID je odrezan na 64 znakov', () => {
    const long = 'A'.repeat(200)
    expect(webhookIdempotencyKey('glovo', long).length).toBeLessThanOrEqual(64)
  })
})

describe('maskPhone (Issue #2 §5 — občutljivi podatki v logih)', () => {
  it('pokaže samo zadnje 3 številke', () => {
    expect(maskPhone('+38640123456')).toBe('*********456')
  })

  it('prekratki / manjkajoči vnos → popolnoma maskiran', () => {
    expect(maskPhone('123')).toBe('***')
    expect(maskPhone('')).toBe('***')
    expect(maskPhone(null)).toBe('***')
  })
})

function mapped(overrides: Partial<MappedPlatformOrder>): MappedPlatformOrder {
  return {
    platformOrderId: 'G-1',
    platform: 'glovo',
    recipientName: 'Test Oseba',
    recipientPhone: '+38640123456',
    address: 'Ulica 1',
    city: 'Ljubljana',
    postCode: '1000',
    instructions: '',
    items: [{ menuItemId: 'mi_1', qty: 2 }],
    unmappedItems: [],
    deliveryFee: 0,
    packagingFee: 0,
    note: 'Glovo #G-1',
    ...overrides,
  }
}

describe('validateMapped (Issue #2 — validacija pred zapisom)', () => {
  it('veljavna preslikava → brez napake', () => {
    expect(validateMapped(mapped({}))).toBeNull()
  })

  it('manjka platformski ID → napaka', () => {
    expect(validateMapped(mapped({ platformOrderId: '' }))).toContain('platformski ID')
  })

  it('brez artiklov z neznanimi artikli → napaka z seznamom', () => {
    const err = validateMapped(mapped({ items: [], unmappedItems: ['Pica XL'] }))
    expect(err).toContain('Pica XL')
  })

  it('prazen payload → napaka', () => {
    const err = validateMapped(mapped({ items: [], unmappedItems: [] }))
    expect(err).toContain('artiklov')
  })
})

describe('rateLimit (Issue #2 §5 — javni webhook endpointi)', () => {
  it('dovoli do 30 zahtev/min, nato blokira', async () => {
    const key = `test:${Date.now()}:${Math.random()}`
    for (let i = 0; i < 30; i++) {
      expect(await rateLimit(key)).toBe(true)
    }
    expect(await rateLimit(key)).toBe(false)
    expect(await rateLimit(key)).toBe(false)
  })

  it('drugi ključ je neodvisen', async () => {
    const k1 = `t1:${Date.now()}:${Math.random()}`
    const k2 = `t2:${Date.now()}:${Math.random()}`
    await rateLimit(k1)
    await rateLimit(k1)
    expect(await rateLimit(k2)).toBe(true)
  })
})
