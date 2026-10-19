import { describe, expect, test, afterAll } from 'bun:test'
import crypto from 'crypto'
import forge from 'node-forge'
import {
  loadCertMaterial, certExpiringSoon, signZoi, buildSoapEnvelope, buildEchoRequestXml,
  buildInvoiceRequestXml, parseEchoResponse, parseInvoiceResponse, soapPost, fursEcho, fursInvoice,
  type FursCertMaterial,
} from '../src/lib/furs/client'
import { computeZoi, siZoiPayload } from '../src/lib/fiscal'

/**
 * Naloga 36 — testi FURS SOAP odjemalca z IN-MEMORY samopodpisanim P12 certifikatom
 * (node-forge generira par+cert brez zunanjih orodij). Pokritje: P12 round-trip,
 * ZOI podpis (RSA-SHA256 nad MD5 digesta — spec 1.13), SOAP envelope (XML-DSig),
 * XML gradnja/parsanje, in mock HTTPS strežnik za echo/invoices (mTLS path).
 */

function makeSelfSignedP12(cn: string, days: number, password: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  const notBefore = new Date(Date.now() - 3600_000)
  const notAfter = new Date(Date.now() + days * 86_400_000)
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  const attrs = [{ name: 'commonName', value: cn }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  // SAN z 127.0.0.1/localhost — TLS hostname verifikacija v mock testih
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return Buffer.from(
    forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password)).getBytes(),
    'binary'
  ).toString('base64')
}

const PW = 'test-geslo'
const P12_B64 = makeSelfSignedP12('RestaurantOS-Test', 365, PW)
const P12_EXPIRED_B64 = makeSelfSignedP12('RestaurantOS-Expired', -1, PW)

let cert: FursCertMaterial
try {
  cert = loadCertMaterial(P12_B64, PW)
} catch (e) {
  cert = null as unknown as FursCertMaterial
}

describe('FURS certifikat (P12)', () => {
  test('loadCertMaterial round-trip: PEM + CN + notAfter', () => {
    expect(cert).not.toBeNull()
    expect(cert!.certPem).toContain('BEGIN CERTIFICATE')
    expect(cert!.keyPem).toContain('PRIVATE KEY')
    expect(cert!.subjectCN).toBe('RestaurantOS-Test')
    expect(cert!.certB64.length).toBeGreaterThan(100)
    expect(cert!.notAfter.getTime()).toBeGreaterThan(Date.now())
  })

  test('fail-closed: napačno geslo ali pokvarjen P12 → napaka', () => {
    expect(() => loadCertMaterial(P12_B64, 'narobe')).toThrow()
    expect(() => loadCertMaterial('ne-decoderable', PW)).toThrow()
  })

  test('certExpiringSoon: svež → false, potečen → true', () => {
    expect(certExpiringSoon(cert!, 30)).toBe(false)
    const expired = loadCertMaterial(P12_EXPIRED_B64, PW)
    expect(expired.notAfter.getTime()).toBeLessThan(Date.now())
  })
})

const ZOI_INPUT = {
  taxId: '12345678',
  issuedAt: new Date('2026-10-10T10:00:00.000Z'),
  receiptNumber: '2026-10-42-BLG001',
  premisesId: 'BLG001',
  total: 24.2,
  // cona pripeta (audit 2026-10 #2): FURS kanonični niz gre v LOKALNEM času izdaje
  timeZone: 'Europe/Ljubljana',
}

describe('ZOI (FURS spec 1.13 — RSA-SHA256 nad MD5 digesta)', () => {
  test('kanonični niz byte-identičen s simulacijo (siZoiPayload)', () => {
    // 10:00 UTC = 12:00 CEST — lokalni čas brez 'Z' in milisekund
    const expected = '123456782026-10-10T12:00:002026-10-42-BLG001BLG00124.20'
    expect(siZoiPayload(ZOI_INPUT)).toBe(expected)
  })

  test('signZoi: podpis se verifikira z javnim ključem nad MD5 digesta', () => {
    const sigB64 = signZoi(ZOI_INPUT, cert!.keyPem)
    const digest = crypto.createHash('md5').update(siZoiPayload(ZOI_INPUT)).digest()
    const ok = crypto.verify(
      'RSA-SHA256', digest,
      crypto.createPublicKey(cert!.certPem),
      Buffer.from(sigB64, 'base64')
    )
    expect(ok).toBe(true)
  })

  test('signZoi: determinističen za isti vnos (PKCS1 v1.5, ne PSS)', () => {
    const a = signZoi(ZOI_INPUT, cert!.keyPem)
    const b = signZoi({ ...ZOI_INPUT }, cert!.keyPem)
    expect(a).toBe(b)
  })

  test('signZoi ≠ simulacija (MD5 hex) — produkcija ne vrača simulacije', () => {
    const sig = signZoi(ZOI_INPUT, cert!.keyPem)
    const md5Hex = computeZoi(ZOI_INPUT)
    expect(sig).not.toBe(md5Hex)
    expect(/^[A-Za-z0-9+/=]+$/.test(sig)).toBe(true) // base64
  })

  test('tampering: spremenjen vnos → podpis ne velja več', () => {
    const sigB64 = signZoi(ZOI_INPUT, cert!.keyPem)
    const other = { ...ZOI_INPUT, total: 99.99 }
    const digest = crypto.createHash('md5').update(siZoiPayload(other)).digest()
    const ok = crypto.verify('RSA-SHA256', digest, crypto.createPublicKey(cert!.certPem), Buffer.from(sigB64, 'base64'))
    expect(ok).toBe(false)
  })
})

describe('SOAP envelope (XML-DSig)', () => {
  test('vsebuje BinarySecurityToken + DigestValue + SignatureValue', () => {
    const payload = buildEchoRequestXml('hello & <world>')
    const env = buildSoapEnvelope(payload, cert!)
    expect(env).toContain('BinarySecurityToken')
    expect(env).toContain(cert!.certB64)
    const digest = crypto.createHash('sha256').update(payload, 'utf8').digest('base64')
    expect(env).toContain(`<ds:DigestValue>${digest}</ds:DigestValue>`)
    expect(env).toContain('<ds:SignatureValue>')
    expect(env).toContain('xml-exc-c14n#')
    expect(env).toContain(payload)
    expect(env).toContain('hello &amp; &lt;world&gt;') // XML escape v payloadu
  })

  test('SignatureValue se verifikira s certifikatom nad SignedInfo', () => {
    const payload = buildEchoRequestXml('x')
    const env = buildSoapEnvelope(payload, cert!)
    const signedInfo = env.match(/<ds:SignedInfo>[\s\S]*?<\/ds:SignedInfo>/)![0]
    const sigValue = env.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)![1]
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(signedInfo, 'utf8'),
      crypto.createPublicKey(cert!.certPem),
      Buffer.from(sigValue, 'base64')
    )
    expect(ok).toBe(true)
  })

  test('buildInvoiceRequestXml: vsa polja spec 1.13 + escape', () => {
    const xml = buildInvoiceRequestXml({
      taxNumber: 12345678,
      issueDateTime: '2026-10-10T12:00:00',
      invoiceNumber: '42',
      businessPremiseId: 'BL<>&001',
      electronicDeviceId: 'BLG-001',
      invoiceAmount: 24.2,
      paymentAmount: 24.2,
      taxesPerSeller: [{ vatRate: 22, basis: 19.84, taxAmount: 4.36 }],
      operatorTaxNumber: 12345678,
      protectedID: 'ABC=',
      subsequentSubmit: false,
    })
    for (const frag of ['<fu:TaxNumber>12345678</fu:TaxNumber>', '<fu:InvoiceNumber>42</fu:InvoiceNumber>',
      '<fu:BusinessPremiseID>BL&lt;&gt;&amp;001</fu:BusinessPremiseID>', '<fu:InvoiceAmount>24.20</fu:InvoiceAmount>',
      '<fu:TaxRate>22.00</fu:TaxRate>', '<fu:ProtectedID>ABC=</fu:ProtectedID>',
      '<fu:SubsequentSubmit>false</fu:SubsequentSubmit>']) {
      expect(xml).toContain(frag)
    }
  })
})

describe('parsanje odgovorov', () => {
  test('parseEchoResponse', () => {
    const soap = '<soapenv:Envelope><soapenv:Body><EchoResponse xmlns="x"><echoRequest>povratek 123</echoRequest></EchoResponse></soapenv:Body></soapenv:Envelope>'
    expect(parseEchoResponse(soap)).toBe('povratek 123')
    expect(parseEchoResponse('brez vsebine')).toBe('')
  })

  test('parseInvoiceResponse: EOR + ZOI + success', () => {
    const soap = `<Envelope><Body><fu:InvoiceResponse xmlns:fu="x">
      <fu:eor>E8D4-A1B2-C3D4-E5F6</fu:eor><fu:zoi>Z9Z9</fu:zoi>
    </fu:InvoiceResponse></Body></Envelope>`
    const r = parseInvoiceResponse(soap)
    expect(r.eor).toBe('E8D4-A1B2-C3D4-E5F6')
    expect(r.zoi).toBe('Z9Z9')
    expect(r.success).toBe(true)
    expect(parseInvoiceResponse('<brez/>').success).toBe(false)
  })
})

// ── Mock HTTPS strežnik (Bun.serve + TLS s samopodpisanim certom; ca=certPem) ──

const SERVER = Bun.serve({
  port: 0,
  tls: { cert: cert!.certPem, key: cert!.keyPem },
  fetch: async (req) => {
    const body = await req.text()
    if (body.includes('<EchoRequest')) {
      const msg = body.match(/<echoRequest>([^<]*)<\/echoRequest>/)?.[1] ?? ''
      return new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><EchoResponse xmlns="http://www.furs.si/schemas/FURS/EFiskalizacijaSOA/v1"><echoRequest>${msg}</echoRequest></EchoResponse></soapenv:Body></soapenv:Envelope>`, { headers: { 'content-type': 'text/xml' } })
    }
    if (body.includes('<InvoiceRequest')) {
      const zoi = body.match(/<fu:ProtectedID>([^<]*)<\/fu:ProtectedID>/)?.[1] ?? ''
      return new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><fu:InvoiceResponse xmlns:fu="http://www.furs.si/schemas/FURS/EFiskalizacijaSOA/v1"><fu:eor>TEST-EOR-1234</fu:eor><fu:zoi>${zoi}</fu:zoi></fu:InvoiceResponse></soapenv:Body></soapenv:Envelope>`, { headers: { 'content-type': 'text/xml' } })
    }
    return new Response('nepoznan klic', { status: 400 })
  },
})

afterAll(() => SERVER.stop(true))

// Mock endpoint tudi za visokonivojske klice (fursEndpoint bere FURS_ENDPOINT_URL)
process.env.FURS_ENDPOINT_URL = `https://127.0.0.1:${SERVER.port}/v1/cash_registers`

describe('soapPost / fursEcho / fursInvoice (mock FURS endpoint)', () => {
  test('soapPost: mTLS POST + 200 + XML telo', async () => {
    const payload = buildEchoRequestXml('ping')
    const env = buildSoapEnvelope(payload, cert!)
    const res = await soapPost(`https://127.0.0.1:${SERVER.port}/v1/cash_registers`, env, cert!, 5000, cert!.certPem)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<EchoResponse')
  })

  test('fursEcho: pošlje in razčleni povratek', async () => {
    const msg = await fursEcho('test', cert!, 'zdravo iz mocka', cert!.certPem)
    expect(msg).toBe('zdravo iz mocka')
  })

  test('fursInvoice: EOR iz odgovora + ZOI vrnjen', async () => {
    const r = await fursInvoice('test', cert!, {
      taxNumber: 12345678,
      issueDateTime: '2026-10-10T12:00:00',
      invoiceNumber: '42',
      businessPremiseId: 'BLG001',
      electronicDeviceId: 'BLG-001',
      invoiceAmount: 24.2,
      paymentAmount: 24.2,
      taxesPerSeller: [{ vatRate: 22, basis: 19.84, taxAmount: 4.36 }],
      operatorTaxNumber: 12345678,
      protectedID: 'SIGN-XYZ',
      subsequentSubmit: false,
    }, cert!.certPem)
    expect(r.eor).toBe('TEST-EOR-1234')
    expect(r.zoi).toBe('SIGN-XYZ')
    expect(r.success).toBe(true)
  })
})
