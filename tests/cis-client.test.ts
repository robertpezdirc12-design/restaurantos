import { describe, expect, test, afterAll } from 'bun:test'
import crypto from 'crypto'
import forge from 'node-forge'
import { loadCertMaterial, type FursCertMaterial } from '../src/lib/furs/client'
import {
  hrZkiDateTime, hrMessageDateTime, hrDeviceId, hrPremisesId, hrInvoiceNumber,
  hrZkiPayload, signZki, hrNacinPlac, buildRacunZahtjevContent, buildSignedEnvelope,
  buildEchoRequestXml, parseEchoResponse, parseRacunResponse, cisPost, cisEcho, cisInvoice,
  cisEndpoint, cisCaFromEnv, cisCertFromEnv, NS_TNS, NS_DS,
  type FursCertMaterial, type HrInvoiceRequest,
} from '../src/lib/cis/client'
import { computeHrTestZki } from '../src/lib/fiscal'

/**
 * Naloga 38 — testi HR CIS odjemalca z IN-MEMORY samopodpisanim P12 certifikatom
 * (isti vzorec kot furs-client.test.ts). Pokritje: oblike podatkov (spec v2.7),
 * ZKI algoritem (MD5hex(RSA-SHA256(podpis)) — pogl. 12, str. 208), enveloped XML-DSig
 * (digest = SHA-256 nad vsebino brez Signature; SignatureValue = RSA-SHA256 nad
 * SignedInfo), XML gradnja/parsanje (JIR + greške), mock HTTPS strežnik (1-way TLS)
 * za echo/RacunZahtjev, env vezava (FURS_HR_CERT_P12_B64, FURS_HR_CA_PEM).
 */

function makeSelfSignedP12(cn: string, days: number, password: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 3600_000)
  cert.validity.notAfter = new Date(Date.now() + days * 86_400_000)
  const attrs = [{ name: 'commonName', value: cn }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return Buffer.from(
    forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, cert, password)).getBytes(),
    'binary'
  ).toString('base64')
}

const PW = 'test-geslo-hr'
const P12_B64 = makeSelfSignedP12('RestaurantOS-HR-Test', 365, PW)

let cert: FursCertMaterial
try {
  cert = loadCertMaterial(P12_B64, PW)
} catch {
  cert = null as unknown as FursCertMaterial
}

const PUB_PEM = forge.pki.publicKeyToPem(
  forge.pki.certificateFromPem(cert!.certPem).publicKey as forge.pki.PublicKey
)

// ── Oblike podatkov (spec v2.7) ──

describe('HR oblike podatkov (spec v2.7 pogl. 12 + 2.1)', () => {
  test('hrZkiDateTime: dd.MM.yyyy HH:mm:ss (PRESLEDEK — ZKI kanonični niz)', () => {
    // lokalno zgrajen datum (getHours je lokalni čas — deterministično v vseh časovnih pasovih)
    expect(hrZkiDateTime(new Date(2026, 9, 10, 21, 10, 34))).toBe('10.10.2026 21:10:34')
    expect(hrZkiDateTime(new Date(2026, 0, 1, 0, 5, 9))).toBe('01.01.2026 00:05:09')
  })

  test('hrMessageDateTime: dd.MM.yyyyTHH:mm:ss (T — Zaglavlje/DatVrijeme)', () => {
    expect(hrMessageDateTime(new Date(2026, 9, 10, 21, 10, 34))).toBe('10.10.2026T21:10:34')
  })

  test('hrDeviceId: samo številke brez vodilnih ničel; privzetek 1', () => {
    expect(hrDeviceId('12')).toBe('12')
    expect(hrDeviceId('BLG-001')).toBe('1')
    expect(hrDeviceId('007')).toBe('7')
    expect(hrDeviceId('')).toBe('1')
    expect(hrDeviceId(null)).toBe('1')
    expect(hrDeviceId('000')).toBe('1')
  })

  test('hrPremisesId: alnum; privzetek PP1', () => {
    expect(hrPremisesId('POSL1')).toBe('POSL1')
    expect(hrPremisesId('blg 001-')).toBe('blg001')
    expect(hrPremisesId('')).toBe('PP1')
    expect(hrPremisesId('---')).toBe('PP1')
  })

  test('hrInvoiceNumber: brez vodilnih ničel', () => {
    expect(hrInvoiceNumber('123456789')).toBe('123456789')
    expect(hrInvoiceNumber(42)).toBe('42')
    expect(hrInvoiceNumber('0007')).toBe('7')
    expect(hrInvoiceNumber('')).toBe('0')
  })

  test('hrNacinPlac: cash→G, card/mobile→K, ostalo→O (spec G|K|T|O)', () => {
    expect(hrNacinPlac('cash')).toBe('G')
    expect(hrNacinPlac('card')).toBe('K')
    expect(hrNacinPlac('mobile')).toBe('K')
    expect(hrNacinPlac('giftcard')).toBe('O')
    expect(hrNacinPlac('loyalty')).toBe('O')
    expect(hrNacinPlac('voucher')).toBe('O')
    expect(hrNacinPlac('alternate')).toBe('O')
    expect(hrNacinPlac('mixed')).toBe('O')
  })
})

// ── ZKI algoritem (spec v2.7 pogl. 12) ──

const ZKI_INPUT = {
  oib: '98765432198',
  issuedAt: new Date(2026, 9, 10, 12, 0, 0), // lokalno → 10.10.2026 12:00:00
  invoiceNumber: '42',
  premisesId: 'POSL1',
  deviceId: '12',
  total: 1245.56,
}

describe('ZKI (MD5hex(RSA-SHA256(podpis)) — spec v2.7 pogl. 12)', () => {
  test('kanonični niz: OIB + dd.MM.yyyy HH:mm:ss + br + prostor + uređaj + iznos (pika)', () => {
    expect(hrZkiPayload(ZKI_INPUT)).toBe('9876543219810.10.2026 12:00:0042POSL1121245.56')
  })

  test('signZki: 32 malih hex; podpis = RSA-SHA256 nad payloadom (verifikacija z javnim ključem)', () => {
    const zki = signZki(ZKI_INPUT, cert!.keyPem)
    expect(zki).toMatch(/^[0-9a-f]{32}$/)
    // ZKI = MD5hex(podpis) → neizvirna podpisni bajtov ni mogoče rekonstruirati iz hex;
    // namesto tega podpišemo payload z ISTIM algoritmom in primerjamo + verifikiramo:
    const sig = crypto.createSign('RSA-SHA256').update(hrZkiPayload(ZKI_INPUT), 'utf8').sign(cert!.keyPem)
    const md5Hex = crypto.createHash('md5').update(sig).digest('hex')
    expect(zki).toBe(md5Hex)
    const ok = crypto.createVerify('RSA-SHA256').update(hrZkiPayload(ZKI_INPUT), 'utf8').verify(PUB_PEM, sig)
    expect(ok).toBe(true)
  })

  test('determinističen (PKCS1 v1.5) in različen od simulacije', () => {
    const a = signZki(ZKI_INPUT, cert!.keyPem)
    const b = signZki(ZKI_INPUT, cert!.keyPem)
    expect(a).toBe(b)
    const sim = computeHrTestZki({ taxId: ZKI_INPUT.oib, issuedAt: ZKI_INPUT.issuedAt, receiptNumber: ZKI_INPUT.invoiceNumber, premisesId: ZKI_INPUT.premisesId, total: ZKI_INPUT.total, simulation: false })
    expect(a).not.toBe(sim)
  })

  test('tampering: sprememba payloada → drugačen ZKI, podpis nad izvirnikom ne velja', () => {
    const zki = signZki(ZKI_INPUT, cert!.keyPem)
    const tampered = { ...ZKI_INPUT, total: 999.99 }
    const zki2 = signZki(tampered, cert!.keyPem)
    expect(zki2).not.toBe(zki)
    const ok = crypto.createVerify('RSA-SHA256').update(hrZkiPayload(tampered), 'utf8').verify(PUB_PEM, Buffer.from(zki, 'hex'))
    expect(ok).toBe(false)
  })
})

// ── RacunZahtjev XML (spec §2.1.2.1) ──

const REQ: HrInvoiceRequest = {
  oib: '98765432198',
  inVatSystem: true,
  issuedAt: new Date(2026, 9, 10, 21, 10, 34),
  invoiceNumber: '123456789',
  premisesId: 'POSL1',
  deviceId: '12',
  vatRates: [
    { rate: 25, base: 10, amount: 2.5 },
    { rate: 10, base: 10, amount: 1 },
  ],
  total: 30,
  paymentMethod: 'K',
  operatorOib: '01234567890',
  zki: 'e4d909c290d0fb1ca068ffaddf22cbd0',
  subsequentSubmit: false,
  idPoruke: 'F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6',
}

describe('buildRacunZahtjevContent (spec §2.1.2.1 — vrstni red + oblike)', () => {
  test('vsa polja v točnem vrstnem redu + tns namespace + Id, brez xmlns:xsi', () => {
    const xml = buildRacunZahtjevContent(REQ)
    expect(xml.startsWith(`<tns:RacunZahtjev Id="RacunZahtjev" xmlns:tns="${NS_TNS}">`)).toBe(true)
    expect(xml).toContain('<tns:IdPoruke>F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6</tns:IdPoruke>')
    // Zaglavlje.DatumVrijeme = čas pošiljanja (now) — oblika dd.MM.yyyyTHH:mm:ss
    expect(xml).toMatch(/<tns:DatumVrijeme>\d{2}\.\d{2}\.\d{4}T\d{2}:\d{2}:\d{2}<\/tns:DatumVrijeme>/)
    expect(xml).toContain('<tns:Oib>98765432198</tns:Oib>')
    expect(xml).toContain('<tns:USustPdv>true</tns:USustPdv>')
    expect(xml).toContain('<tns:DatVrijeme>10.10.2026T21:10:34</tns:DatVrijeme>')
    expect(xml).toContain('<tns:OznSlijed>P</tns:OznSlijed>')
    expect(xml).toContain('<tns:BrOznRac>123456789</tns:BrOznRac><tns:OznPosPr>POSL1</tns:OznPosPr><tns:OznNapUr>12</tns:OznNapUr>')
    expect(xml).toContain('<tns:Stopa>25.00</tns:Stopa><tns:Osnovica>10.00</tns:Osnovica><tns:Iznos>2.50</tns:Iznos>')
    expect(xml).toContain('<tns:Stopa>10.00</tns:Stopa><tns:Osnovica>10.00</tns:Osnovica><tns:Iznos>1.00</tns:Iznos>')
    expect(xml).toContain('<tns:IznosUkupno>30.00</tns:IznosUkupno>')
    expect(xml).toContain('<tns:NacinPlac>K</tns:NacinPlac>')
    expect(xml).toContain('<tns:OibOper>01234567890</tns:OibOper>')
    expect(xml).toContain('<tns:ZastKod>e4d909c290d0fb1ca068ffaddf22cbd0</tns:ZastKod>')
    expect(xml).toContain('<tns:NakDost>false</tns:NakDost>')
    // exc-c14n odstrani neuporabljene namespace deklaracije → xsi namenoma NI deklariran
    expect(xml).not.toContain('xmlns:xsi')
  })

  test('XML escape nevarnih znakov (nesanitarizirana polja) + Pdv izpuščen + sanitarizacija', () => {
    // Oib ni sanitariziran (samo escape) → escape test; OznPosPr je sanitiziran PRED escape
    const xml = buildRacunZahtjevContent({ ...REQ, oib: '98765432<>&"1', premisesId: 'PO<S>1&"X"', deviceId: '0007', vatRates: [] })
    expect(xml).toContain('<tns:Oib>98765432&lt;&gt;&amp;&quot;1</tns:Oib>')
    expect(xml).toContain('<tns:OznPosPr>POS1X</tns:OznPosPr>')
    expect(xml).toContain('<tns:OznNapUr>7</tns:OznNapUr>')
    expect(xml).not.toContain('<tns:Pdv>')
    expect(xml).toContain('<tns:USustPdv>true</tns:USustPdv>')
  })
})

// ── XML-DSig enveloped potpis (spec §7) ──

describe('buildSignedEnvelope (XML-DSig — enveloped, spec v2.7 §7)', () => {
  const content = buildRacunZahtjevContent(REQ)
  const envelope = buildSignedEnvelope(content, cert!)

  test('struktura: Signature ZNOTRAJ korenskega elementa, Reference/Transforms/algoritmi', () => {
    expect(envelope).toContain('<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>')
    expect(envelope).toContain(`<Signature xmlns="${NS_DS}">`)
    expect(envelope.indexOf('<Signature xmlns=')).toBeGreaterThan(envelope.indexOf('<tns:ZastKod>'))
    expect(envelope).toContain('<Reference URI="#RacunZahtjev">')
    expect(envelope).toContain('<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>')
    expect(envelope).toContain('<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>')
    expect(envelope).toContain('<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>')
    expect(envelope).toContain('<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>')
    expect(envelope).toContain('<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>')
    expect(envelope).toContain(`<X509Certificate>${cert!.certB64}</X509Certificate>`)
  })

  test('DigestValue = SHA-256 base64 nad vsebino BREZ Signature (enveloped transform)', () => {
    const digestB64 = envelope.match(/<DigestValue>([^<]+)<\/DigestValue>/)?.[1] ?? ''
    const expected = crypto.createHash('sha256').update(content, 'utf8').digest('base64')
    expect(digestB64).toBe(expected)
  })

  test('SignatureValue = RSA-SHA256 podpis nad SignedInfo; verifikiran z javnim ključem', () => {
    const signedInfo = envelope.match(/<SignedInfo>[\s\S]*?<\/SignedInfo>/)?.[0] ?? ''
    const sigB64 = envelope.match(/<SignatureValue>([^<]+)<\/SignatureValue>/)?.[1] ?? ''
    expect(signedInfo).toContain('<DigestValue>')
    const ok = crypto.createVerify('RSA-SHA256').update(signedInfo, 'utf8').verify(PUB_PEM, Buffer.from(sigB64, 'base64'))
    expect(ok).toBe(true)
  })

  test('tampering vsebine → digest ne ustreza več', () => {
    const tamperedEnvelope = buildSignedEnvelope(content.replace('<tns:IznosUkupno>30.00', '<tns:IznosUkupno>999.00'), cert!)
    const digestB64 = tamperedEnvelope.match(/<DigestValue>([^<]+)<\/DigestValue>/)?.[1] ?? ''
    const recomputed = crypto.createHash('sha256').update(content, 'utf8').digest('base64')
    expect(digestB64).not.toBe(recomputed)
  })
})

// ── Parsanje odgovorov ──

describe('parsanje odgovorov (namespace-tolerantno)', () => {
  test('parseEchoResponse', () => {
    expect(parseEchoResponse('<EchoResponse xmlns="...">proizvoljan tekst</EchoResponse>')).toBe('proizvoljan tekst')
    expect(parseEchoResponse('<tns:EchoResponse xmlns:tns="...">zdravo</tns:EchoResponse>')).toBe('zdravo')
    expect(parseEchoResponse('nismo odgovor')).toBe('')
  })

  test('parseRacunResponse: JIR (uspeh, s tns prefiksom in brez)', () => {
    const ok1 = '<tns:RacunOdgovor xmlns:tns="X"><tns:Zaglavlje><tns:IdPoruke>u</tns:IdPoruke><tns:DatumVrijeme>10.10.2026T21:10:34</tns:DatumVrijeme></tns:Zaglavlje><tns:Jir>2cf55235-9470-4b5c-a539-463f52b109d2</tns:Jir></tns:RacunOdgovor>'
    const r1 = parseRacunResponse(ok1)
    expect(r1.success).toBe(true)
    expect(r1.jir).toBe('2cf55235-9470-4b5c-a539-463f52b109d2')
    expect(r1.errors).toHaveLength(0)
    const r2 = parseRacunResponse('<RacunOdgovor><Jir>2cf55235-9470-4b5c-a539-463f52b109d2</Jir></RacunOdgovor>')
    expect(r2.success).toBe(true)
  })

  test('parseRacunResponse: Greske (sXXX + PorukaGreske)', () => {
    const err = '<tns:RacunOdgovor xmlns:tns="X"><tns:Zaglavlje><tns:IdPoruke>u</tns:IdPoruke><tns:DatumVrijeme>d</tns:DatumVrijeme></tns:Zaglavlje><tns:Greske><tns:Greska><tns:SifraGreske>s002</tns:SifraGreske><tns:PorukaGreske>Certifikat ni veljaven.</tns:PorukaGreske></tns:Greska><tns:Greska><tns:SifraGreske>s004</tns:SifraGreske><tns:PorukaGreske>Metoda potpisivanja nije dozvoljena.</tns:PorukaGreske></tns:Greska></tns:Greske></tns:RacunOdgovor>'
    const r = parseRacunResponse(err)
    expect(r.success).toBe(false)
    expect(r.jir).toBe('')
    expect(r.errors).toEqual([
      { code: 's002', message: 'Certifikat ni veljaven.' },
      { code: 's004', message: 'Metoda potpisivanja nije dozvoljena.' },
    ])
  })
})

// ── Mock HTTPS strežnik (Bun.serve + TLS; 1-way — klient ne pošilja certifikata) ──

const SERVER = Bun.serve({
  port: 0,
  tls: { cert: cert!.certPem, key: cert!.keyPem },
  fetch: async (req) => {
    const body = await req.text()
    if (body.includes('<tns:EchoRequest')) {
      const msg = body.match(/<tns:EchoRequest[^>]*>([^<]*)<\/tns:EchoRequest>/)?.[1] ?? ''
      return new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><tns:EchoResponse xmlns:tns="${NS_TNS}">${msg}</tns:EchoResponse></soapenv:Body></soapenv:Envelope>`, { headers: { 'content-type': 'text/xml' } })
    }
    if (body.includes('RacunZahtjev')) {
      // zahteva mora biti PODPISANA (Signature znotraj korenskega elementa)
      if (!body.includes('<Signature xmlns=') || !body.includes('<DigestValue>')) {
        return new Response('_unsigned request_', { status: 400 })
      }
      const oib = body.match(/<tns:Oib>([^<]*)<\/tns:Oib>/)?.[1] ?? ''
      const zki = body.match(/<tns:ZastKod>([^<]*)<\/tns:ZastKod>/)?.[1] ?? ''
      if (oib === '99999999999') {
        return new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><tns:RacunOdgovor xmlns:tns="${NS_TNS}"><tns:Zaglavlje><tns:IdPoruke>u</tns:IdPoruke><tns:DatumVrijeme>10.10.2026T21:10:34</tns:DatumVrijeme></tns:Zaglavlje><tns:Greske><tns:Greska><tns:SifraGreske>s002</tns:SifraGreske><tns:PorukaGreske>Certifikat nije valjan.</tns:PorukaGreske></tns:Greska></tns:Greske></tns:RacunOdgovor></soapenv:Body></soapenv:Envelope>`, { headers: { 'content-type': 'text/xml' } })
      }
      return new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><tns:RacunOdgovor xmlns:tns="${NS_TNS}"><tns:Zaglavlje><tns:IdPoruke>u</tns:IdPoruke><tns:DatumVrijeme>10.10.2026T21:10:34</tns:DatumVrijeme></tns:Zaglavlje><tns:Jir>2cf55235-9470-4b5c-a539-463f52b109d2</tns:Jir></tns:RacunOdgovor></soapenv:Body></soapenv:Envelope><!--zki:${zki}-->`, { headers: { 'content-type': 'text/xml' } })
    }
    return new Response('nepoznan klic', { status: 400 })
  },
})

const PREV_HR_URL = process.env.FURS_HR_ENDPOINT_URL
const PREV_HR_P12 = process.env.FURS_HR_CERT_P12_B64
const PREV_HR_PW = process.env.FURS_HR_CERT_PASSWORD
const PREV_HR_ENV = process.env.FURS_HR_ENVIRONMENT
const PREV_HR_CA = process.env.FURS_HR_CA_PEM

/** restore varno tudi za undefined (process.env.X = undefined bi zapisal niz "undefined") */
function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterAll(() => {
  SERVER.stop(true)
  restoreEnv('FURS_HR_ENDPOINT_URL', PREV_HR_URL)
  restoreEnv('FURS_HR_CERT_P12_B64', PREV_HR_P12)
  restoreEnv('FURS_HR_CERT_PASSWORD', PREV_HR_PW)
  restoreEnv('FURS_HR_ENVIRONMENT', PREV_HR_ENV)
  restoreEnv('FURS_HR_CA_PEM', PREV_HR_CA)
})

process.env.FURS_HR_ENDPOINT_URL = `https://127.0.0.1:${SERVER.port}/FiskalizacijaServiceTest`

describe('cisPost / cisEcho / cisInvoice (mock CIS endpoint, 1-way TLS)', () => {
  test('cisPost: HTTPS POST (brez klient certifikata) + 200 + XML telo', async () => {
    const res = await cisPost(`https://127.0.0.1:${SERVER.port}/FiskalizacijaServiceTest`, buildEchoRequestXml('ping'), 5000, cert!.certPem)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<tns:EchoResponse')
  })

  test('cisEcho: povratek teksta', async () => {
    const msg = await cisEcho('test', 'zdravo iz mocka HR', cert!.certPem)
    expect(msg).toBe('zdravo iz mocka HR')
  })

  test('cisInvoice: JIR round-trip (podpisana zahteva je sprejeta)', async () => {
    const req = { ...REQ, zki: signZki(ZKI_INPUT, cert!.keyPem) }
    const r = await cisInvoice('test', cert!, req, cert!.certPem)
    expect(r.success).toBe(true)
    expect(r.jir).toBe('2cf55235-9470-4b5c-a539-463f52b109d2')
  })

  test('cisInvoice: greška s002 → throw s opisom (fail-safe klicatelja)', async () => {
    const req = { ...REQ, oib: '99999999999' }
    let msg = ''
    try {
      await cisInvoice('test', cert!, req, cert!.certPem)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('s002')
    expect(msg).toContain('Certifikat nije valjan.')
  })
})

// ── Endpointi + env vezava ──

describe('endpointi + env vezava', () => {
  test('cisEndpoint: uradni URL-ja iz spec v2.7 §6.1; override deluje', () => {
    delete process.env.FURS_HR_ENDPOINT_URL
    expect(cisEndpoint('test')).toBe('https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest')
    expect(cisEndpoint('production')).toBe('https://cis.porezna-uprava.hr:8449/FiskalizacijaService')
    process.env.FURS_HR_ENDPOINT_URL = 'https://mock.local/x'
    expect(cisEndpoint('test')).toBe('https://mock.local/x')
    restoreEnv('FURS_HR_ENDPOINT_URL', PREV_HR_URL)
  })

  test('cisCertFromEnv: null brez env; z env → cert + okolje (FURS_HR_ENVIRONMENT > FURS_ENVIRONMENT)', () => {
    process.env.FURS_HR_CERT_P12_B64 = ''
    process.env.FURS_HR_CERT_PASSWORD = ''
    expect(cisCertFromEnv()).toBeNull()
    process.env.FURS_HR_CERT_P12_B64 = P12_B64
    process.env.FURS_HR_CERT_PASSWORD = PW
    process.env.FURS_HR_ENVIRONMENT = 'production'
    const bound = cisCertFromEnv()
    expect(bound).not.toBeNull()
    expect(bound!.env).toBe('production')
    expect(bound!.cert.subjectCN).toBe('RestaurantOS-HR-Test')
    process.env.FURS_HR_ENVIRONMENT = 'test'
    expect(cisCertFromEnv()!.env).toBe('test')
    delete process.env.FURS_HR_ENVIRONMENT
    process.env.FURS_ENVIRONMENT = 'production'
    expect(cisCertFromEnv()!.env).toBe('production') // fallback na SI spremenljivko
    restoreEnv('FURS_ENVIRONMENT', undefined)
  })

  test('cisCaFromEnv: PEM (z \\n) in base64; null brez', () => {
    delete process.env.FURS_HR_CA_PEM
    expect(cisCaFromEnv()).toBeNull()
    process.env.FURS_HR_CA_PEM = '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----'
    expect(cisCaFromEnv()).toBe('-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----')
    process.env.FURS_HR_CA_PEM = Buffer.from('-----BEGIN CERTIFICATE-----\nXYZ\n-----END CERTIFICATE-----').toString('base64')
    expect(cisCaFromEnv()).toContain('XYZ')
    restoreEnv('FURS_HR_CA_PEM', PREV_HR_CA)
  })
})
