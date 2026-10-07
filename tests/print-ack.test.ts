/**
 * Issue #10 P2-3 — unit testi za print ACK validacijo (čista logika brez DB).
 */
import { describe, it, expect } from 'bun:test'
import { parsePrintAck, inferPrintKind, cleanPrintError } from '@/lib/print'

describe('parsePrintAck (Issue #10 P2-3)', () => {
  it('veljaven ACK (agent, failed z napako)', () => {
    const r = parsePrintAck({ kind: 'receipt', refId: 'ord_1', target: 'agent', status: 'failed', error: 'Tiskalnik ni odziven.', device: '192.168.1.100:9100', attempts: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.kind).toBe('receipt')
      expect(r.data.status).toBe('failed')
      expect(r.data.attempts).toBe(2)
      expect(r.data.error).toBe('Tiskalnik ni odziven.')
      expect(r.data.device).toBe('192.168.1.100:9100')
    }
  })

  it('neznani status/cilj → zavrnjen (fail-closed)', () => {
    const badStatus = parsePrintAck({ target: 'agent', status: 'exploded' })
    expect(badStatus.ok).toBe(false)
    const badTarget = parsePrintAck({ target: 'fax', status: 'printed' })
    expect(badTarget.ok).toBe(false)
  })

  it('manjkajoče telo → zavrnjeno', () => {
    expect(parsePrintAck(null).ok).toBe(false)
    expect(parsePrintAck('x').ok).toBe(false)
    expect(parsePrintAck([1]).ok).toBe(false)
  })

  it('neznan kind pade na other; attempts izven obsega sanirana', () => {
    const r = parsePrintAck({ kind: 'fax-tisk', target: 'browser', status: 'printed', attempts: 999 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.kind).toBe('other')
      expect(r.data.attempts).toBe(50)
    }
  })

  it('error se shrani SAMO pri statusu failed (uspeh ne nosi napake)', () => {
    const okPrint = parsePrintAck({ target: 'agent', status: 'printed', error: 'nekaj' })
    expect(okPrint.ok).toBe(true)
    if (okPrint.ok) expect(okPrint.data.error).toBe('')
  })

  it('dolgi nizi so odrezani (error 500, refId 64, device 120)', () => {
    const r = parsePrintAck({ target: 'agent', status: 'failed', error: 'E'.repeat(2000), refId: 'R'.repeat(200), device: 'D'.repeat(300) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.error.length).toBe(500)
      expect(r.data.refId.length).toBe(64)
      expect(r.data.device.length).toBe(120)
    }
  })
})

describe('inferPrintKind (Issue #10 P2-3)', () => {
  it('sklepa kind iz naslova dokumenta', () => {
    expect(inferPrintKind('=== KUHINJSKI LIST ===')).toBe('kitchen')
    expect(inferPrintKind('=== BAR LIST ===')).toBe('bar')
    expect(inferPrintKind('RAČUN #42')).toBe('receipt')
    expect(inferPrintKind('Z-POROČILO')).toBe('report')
    expect(inferPrintKind('Naslov brez konteksta')).toBe('other')
  })
})

describe('cleanPrintError (Issue #10 P2-3)', () => {
  it('Error objekt → sporočilo, dolg → odrezan na 500', () => {
    expect(cleanPrintError(new Error('boom'))).toBe('boom')
    expect(cleanPrintError('E'.repeat(900)).length).toBe(500)
    expect(cleanPrintError(undefined)).toBe('')
  })
})
