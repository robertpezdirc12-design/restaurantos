/**
 * Testi fiskalnih adapterjev po državi (issue #1 triage — SI/HR fiskalizacija).
 *
 * Uradni viri (brez ugibanja, po triage odločitvi):
 *  - SI: obstoječa FURS simulacija — ZOI = MD5(taxId + ISO + št. računa + prostor + total.toFixed(2)),
 *    EOR = UUID (simulacija); produkcija → '' + 'pending' (certifikat FURS).
 *  - HR: Zakon o fiskalizaciji (NN 89/2025) + Pravilnik (NN 153/2025) + Tehnička specifikacija
 *    Porezne uprave: QR = https://porezna.gov.hr/rn?jir=<36 znakov>&datv=YYYYMMDD_HHMM&izn=<znesek>,
 *    ali ?zki=<32 znakov> pred prijavo; JIR = UUID (36), ZKI = 32 znakov; produkcija → cert FINA.
 */
import { describe, expect, test } from 'bun:test'
import crypto from 'crypto'
import {
  fiscalAdapterFor, computeZoi, computeHrTestZki, hrDatv, hrIzn, hrQrContent, siZoiPayload,
} from '../src/lib/fiscal'

// deterministični vektor — cona je PRIPETA, da niz ne odvisna od časovnega pasu
// runnerja (prej: odvisna, ker se je primerjal z `new Date().toISOString()`).
const VEC = {
  taxId: 'SI12345678',
  issuedAt: new Date('2026-01-15T12:30:45.000Z'),
  receiptNumber: '2026-1-42-BLG001',
  premisesId: 'BLG001',
  total: 125.5,
  timeZone: 'Europe/Ljubljana',
}
// FURS kanonični datum = LOKALNI čas izdaje (12:30 UTC → 13:30 CET), brez 'Z' in
// milisekund (audit 2026-10 #2). Literal, ne rekonstrukcija z isto funkcijo.
const VEC_ZOI_PAYLOAD = 'SI123456782026-01-15T13:30:452026-1-42-BLG001BLG001125.50'

describe('SI adapter — FURS (§18: byte-identična pot)', () => {
  test('fabrika: SI je privzet (tudi za neznano/prazno državo)', () => {
    expect(fiscalAdapterFor('SI').country).toBe('SI')
    expect(fiscalAdapterFor('si').country).toBe('SI')
    expect(fiscalAdapterFor('').country).toBe('SI')
    expect(fiscalAdapterFor(undefined).country).toBe('SI')
    expect(fiscalAdapterFor('DE').country).toBe('SI')
  })

  test('computeZoi — byte-identičen prejšnji vgradnji v /api/furs', () => {
    // referenčna implementacija = dobesedno nekdanja koda iz route.ts, ZDAY s
    // lokalnim (FURS) formatom datuma in pripetim literalom niza
    const expected = crypto.createHash('md5').update(VEC_ZOI_PAYLOAD).digest('hex')
    expect(computeZoi(VEC)).toBe(expected)
    expect(computeZoi(VEC)).toMatch(/^[0-9a-f]{32}$/)
  })

  test('audit #2: kanonični niz je v lokalnem času izdaje, ne v UTC', () => {
    // 23:30 UTC = naslednji dan 00:30 CET — FURS bi z UTC-jem dobil PREJŠNJI dan
    const night = { ...VEC, issuedAt: new Date('2026-01-15T23:30:45.000Z') }
    expect(siZoiPayload(night)).toContain('2026-01-16T00:30:45')
    // izpuščena cona → sistemski lokalni čas (nazaj-kompatibilno, brez tipkanja)
    expect(siZoiPayload({ ...night, timeZone: undefined })).not.toContain('2026-01-16T00:30:45Z')
    // neveljavna cona v nastavitvah lokacije NE sme pasti na UTC — privzeto Ljubljana
    expect(siZoiPayload({ ...night, timeZone: 'Mars/Olympus_Mons' })).toContain('2026-01-16T00:30:45')
  })

  test('simulacija: ZOI + EOR UUID, označena simulacija', () => {
    const codes = fiscalAdapterFor('SI').computeCodes({ ...VEC, simulation: true })
    expect(codes.protective).toBe(computeZoi(VEC))
    expect(codes.verification).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    expect(codes.algo).toBe('SI-ZOI-MD5')
    expect(codes.simulated).toBe(true)
  })

  test('produkcija: brez certifikata → prazne kode (route označi pending)', () => {
    const codes = fiscalAdapterFor('SI').computeCodes({ ...VEC, simulation: false })
    expect(codes.protective).toBe('')
    expect(codes.verification).toBe('')
    expect(codes.simulated).toBe(false)
    expect(fiscalAdapterFor('SI').requiresCertificate).toBe(true)
  })

  test('SI: QR ni del toka, EOR passthrough', () => {
    const a = fiscalAdapterFor('SI')
    expect(a.codeLabel).toBe('ZOI')
    expect(a.verifyLabel).toBe('EOR')
    expect(a.qrContent({ verification: 'X', protective: 'Y', issuedAt: new Date(), total: 1 })).toBeNull()
    expect(a.isValidVerificationCode('karkoli')).toBe(true)
  })
})

describe('HR adapter — Fiskalizacija 2.0 (NN 89/2025, Pravilnik NN 153/2025)', () => {
  test('fabrika: HR po državi lokacije', () => {
    expect(fiscalAdapterFor('HR').country).toBe('HR')
    expect(fiscalAdapterFor('hr').country).toBe('HR')
  })

  test('oznake: ZKI (zaščitni) / JIR (verifikacija)', () => {
    const a = fiscalAdapterFor('HR')
    expect(a.codeLabel).toBe('ZKI')
    expect(a.verifyLabel).toBe('JIR')
    expect(a.requiresCertificate).toBe(true)
  })

  test('simulacija: testni ZKI ima 32 znakov (spec) in je determinističen', () => {
    const a = fiscalAdapterFor('HR')
    const c1 = a.computeCodes({ ...VEC, simulation: true })
    const c2 = a.computeCodes({ ...VEC, simulation: true })
    expect(c1.protective).toBe(computeHrTestZki(VEC))
    expect(c1.protective).toBe(c2.protective)
    expect(c1.protective).toMatch(/^[0-9a-f]{32}$/) // točno 32 znakov
    expect(c1.algo).toBe('HR-ZKI-SHA256-TEST')
    expect(c1.simulated).toBe(true)
  })

  test('simulacija: JIR = UUID (36 znakov, spec)', () => {
    const c = fiscalAdapterFor('HR').computeCodes({ ...VEC, simulation: true })
    expect(c.verification).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    expect(c.verification).toHaveLength(36)
  })

  test('produkcija: brez certifikata FINA → prazne kode + pending (ni lažnih podatkov)', () => {
    const c = fiscalAdapterFor('HR').computeCodes({ ...VEC, simulation: false })
    expect(c.protective).toBe('')
    expect(c.verification).toBe('')
    expect(c.simulated).toBe(false)
  })

  test('datv: uradna oblika YYYYMMDD_HHMM (spec primer 20200921_0630)', () => {
    expect(hrDatv(new Date(2026, 0, 15, 9, 5))).toBe('20260115_0905')
    expect(hrDatv(new Date(2020, 8, 21, 6, 30))).toBe('20200921_0630')
  })

  test('izn: znesek z vejico in 2 decimalkama (spec primer izn=1000000,00)', () => {
    expect(hrIzn(125.5)).toBe('125,50')
    expect(hrIzn(1000000)).toBe('1000000,00')
    expect(hrIzn(0.05)).toBe('0,05')
  })

  test('QR vsebina: porezna.gov.hr/rn z JIR (po prijavi)', () => {
    const jir = '12345678-1234-1234-1234-123456789012'
    const url = hrQrContent({ verification: jir, protective: 'abc', issuedAt: new Date(2020, 8, 21, 6, 30), total: 1525.99 })
    expect(url).toBe('https://porezna.gov.hr/rn?jir=12345678-1234-1234-1234-123456789012&datv=20200921_0630&izn=1525,99')
  })

  test('QR vsebina: zki= pred prijavo (offline ZKI pot)', () => {
    const zki = 'a'.repeat(32)
    const url = hrQrContent({ verification: '', protective: zki, issuedAt: new Date(2026, 0, 15, 9, 5), total: 10 })
    expect(url).toBe(`https://porezna.gov.hr/rn?zki=${zki}&datv=20260115_0905&izn=10,00`)
    expect(url).not.toContain('jir=')
  })

  test('adapter qrContent: null brez kod (produkcija pending), sicer URL', () => {
    const a = fiscalAdapterFor('HR')
    expect(a.qrContent({ verification: '', protective: '', issuedAt: new Date(), total: 1 })).toBeNull()
    expect(a.qrContent({ verification: 'j', protective: 'z', issuedAt: new Date(), total: 1 })).toContain('porezna.gov.hr/rn')
  })

  test('validacija JIR: 36 znakov UUID (spec), zavrne druge oblike', () => {
    const a = fiscalAdapterFor('HR')
    expect(a.isValidVerificationCode('12345678-1234-1234-1234-123456789012')).toBe(true)
    expect(a.isValidVerificationCode('12345678-1234-1234-1234-12345678901x')).toBe(false)
    expect(a.isValidVerificationCode('')).toBe(false)
    expect(a.isValidVerificationCode('32 znakov hex aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
  })
})

describe('Lokacijska vezava — ne glede na jezik UI (fiskalizacija ni prevodna funkcija)', () => {
  test('ista lokacija → isti adapter neodvisno od i18n', () => {
    const a = fiscalAdapterFor('HR')
    const b = fiscalAdapterFor('HR')
    expect(a.computeCodes({ ...VEC, simulation: true }).protective)
      .toBe(b.computeCodes({ ...VEC, simulation: true }).protective)
  })

  test('SI lokacija nikoli ne dobi HR QR-ja (ločena pot po državi)', () => {
    const si = fiscalAdapterFor('SI')
    expect(si.qrContent({ verification: 'EOR', protective: 'ZOI', issuedAt: new Date(), total: 5 })).toBeNull()
  })
})
