import { describe, it, expect } from 'bun:test'
import { splitTips, tipChainHash, verifyTipChain, dayRange, parseTipMethod, entryMinutesInRange } from '@/lib/tips'

/* Issue #1 (triage ①) — napitnine: čista logika (brez DB).
   Ključna garancija: vsota delov je TOČNO skupni znesek (nič centov ne izgine),
   hash-veriga je tamper-evident, dnevno okno je UTC. */

describe('splitTips — delitev brez izgube centov', () => {
  it('osnovna delitev: 10.00 EUR na 3 enakovredne → 334+333+333', () => {
    expect(splitTips(1000, [1, 1, 1])).toEqual([334, 333, 333])
  })

  it('vsota delov je TOČNO total za raznolike uteži (ure)', () => {
    const weights = [480, 300, 195, 0, 62]
    const parts = splitTips(4567, weights)
    expect(parts.reduce((a, b) => a + b, 0)).toBe(4567)
    expect(parts[3]).toBe(0) // utež 0 → nič
  })

  it('največji ostanek gre k največji frakciji: (7,[10,1]) → [6,1] (frakciji 0.36 vs 0.64)', () => {
    expect(splitTips(7, [10, 1])).toEqual([6, 1])
  })

  it('(1,[1,1]) → [1,0]: neodločeno odloči nižji indeks', () => {
    expect(splitTips(1, [1, 1])).toEqual([1, 0])
  })

  it('total 0 → vse nič; prazne uteži → []', () => {
    expect(splitTips(0, [5, 5])).toEqual([0, 0])
    expect(splitTips(500, [])).toEqual([])
  })

  it('frakcijske uteži (točke 2.5) so dovoljene in vsota ostane točna', () => {
    const parts = splitTips(999, [2.5, 1, 0.5, 3.75])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(999)
  })

  it('napake: negativen total, ne-integer total, negativna utež, NaN', () => {
    expect(() => splitTips(-1, [1])).toThrow()
    expect(() => splitTips(10.5, [1])).toThrow()
    expect(() => splitTips(100, [1, -2])).toThrow()
    expect(() => splitTips(Number.NaN, [1])).toThrow()
  })
})

describe('tipChainHash + verifyTipChain — tamper-evident veriga', () => {
  const rows = (amounts: number[]) => {
    let prev = ''
    return amounts.map((amount, i) => {
      const previousHash = prev
      const chainHash = tipChainHash(prev, 'emp-' + i, 100, amount)
      prev = chainHash
      return { previousHash, chainHash, employeeId: 'emp-' + i, basis: 100, amount }
    })
  }

  it('veljavna veriga (3 člena) se potrdi', () => {
    expect(verifyTipChain(rows([500, 300, 200]))).toBe(true)
  })

  it('sprememba zneska prelomi verigo', () => {
    const r = rows([500, 300, 200])
    const tampered = r.map((x, i) => (i === 1 ? { ...x, amount: 301 } : x))
    expect(verifyTipChain(tampered)).toBe(false)
  })

  it('prekinjena povezava (previousHash) prelomi verigo', () => {
    const r = rows([500, 300])
    const broken = [{ ...r[0], previousHash: 'x' }, r[1]]
    expect(verifyTipChain(broken)).toBe(false)
  })

  it('prazna veriga je veljavna (trivialno)', () => {
    expect(verifyTipChain([])).toBe(true)
  })

  it('isti vhod → isti hash (determinizem)', () => {
    expect(tipChainHash('a', 'e1', 100, 500)).toBe(tipChainHash('a', 'e1', 100, 500))
    expect(tipChainHash('a', 'e1', 100, 500)).not.toBe(tipChainHash('b', 'e1', 100, 500))
  })
})

describe('dayRange — UTC dnevno okno', () => {
  it('2026-10-07 → [07T00:00Z, 08T00:00Z)', () => {
    const { from, to } = dayRange('2026-10-07')
    expect(from.toISOString()).toBe('2026-10-07T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-08T00:00:00.000Z')
  })

  it('napačne oblike zavrže', () => {
    expect(() => dayRange('7. 10. 2026')).toThrow()
    expect(() => dayRange('2026-13-40')).toThrow()
    expect(() => dayRange('')).toThrow()
  })
})

describe('parseTipMethod', () => {
  it('sprejeme samo hours/equal/points', () => {
    expect(parseTipMethod('hours')).toBe('hours')
    expect(parseTipMethod('equal')).toBe('equal')
    expect(parseTipMethod('points')).toBe('points')
    expect(parseTipMethod('greedy')).toBeNull()
    expect(parseTipMethod(null)).toBeNull()
  })
})

describe('entryMinutesInRange — ure za osnovo delitve', () => {
  const D = (s: string) => new Date(s).getTime()

  it('popolna izmena znotraj dneva: 8h − 30 min odmora = 450 min', () => {
    const m = entryMinutesInRange(D('2026-10-07T08:00Z'), D('2026-10-07T16:00Z'), 30, D('2026-10-07T00:00Z'), D('2026-10-08T00:00Z'))
    expect(m).toBe(450)
  })

  it('odprt vnos (brez clockOut) se šteje do konca dneva', () => {
    const m = entryMinutesInRange(D('2026-10-07T20:00Z'), null, 0, D('2026-10-07T00:00Z'), D('2026-10-08T00:00Z'))
    expect(m).toBe(240)
  })

  it('izmena, ki se konča naslednji dan, se prižge na konec dneva', () => {
    const m = entryMinutesInRange(D('2026-10-07T22:00Z'), D('2026-10-08T06:00Z'), 0, D('2026-10-07T00:00Z'), D('2026-10-08T00:00Z'))
    expect(m).toBe(120)
  })

  it('vnos pred oknom šteje 0 (pripada prejšnjemu dnevu)', () => {
    const m = entryMinutesInRange(D('2026-10-06T22:00Z'), D('2026-10-07T02:00Z'), 0, D('2026-10-07T00:00Z'), D('2026-10-08T00:00Z'))
    expect(m).toBe(0)
  })
})
