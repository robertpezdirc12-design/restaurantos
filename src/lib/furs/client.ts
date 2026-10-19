/**
 * FURS SOAP odjemalec (SI fiskalizacija — ZOI podpis + echo + invoices).
 *
 * Naloga 36: kodekska priprava na pravi certifikat (runbook docs/FURS-CERT-RUNBOOK.md).
 * Brez certifikata (FURS_CERT_P12_B64/FURS_CERT_PASSWORD) se nič ne spremeni —
 * produkcija ostane 'pending' (obstoječe vedenje). Z certifikatom:
 *   ZOI  = RSASSA-PKCS1-v1_5 (SHA256withRSA) podpis MD5 zgoščene vrednosti kanoničnega
 *          niza (FURS spec 1.13, §ZOI) — kanonični niz je byte-identičen simulaciji
 *          (src/lib/fiscal siZoiPayload).
 *   EOR  = odgovor FURS `invoices` SOAP klica (mTLS s certifikatom).
 *
 * XML-DSig zapis (exclusive C14N + SHA256, BinarySecurityToken) je zgrajen po FURS
 * specifikaciji 1.13 — TOČNOST canonicalization mora biti validirana v FURS TESTNEM
 * okolju (echo klic z testnim certifikatom) PRED produkcijo (runbook korak 3).
 *
 * HR (Fiskalizacija 2.0) gre v ločenem koraku — adapter vzorec je v src/lib/fiscal.
 */

import crypto from 'crypto'
import https from 'https'
import forge from 'node-forge'
import { siZoiPayload, type SiFiscalInput } from '@/lib/fiscal'
import { isoLocal } from '@/lib/fiscal-time'

// ── Certifikat (P12 → PEM) ──

export interface FursCertMaterial {
  certPem: string
  keyPem: string
  certB64: string
  subjectCN: string
  notAfter: Date
}

/** Naloži .p12 (base64) z geslom → PEM certifikat + ključ. Fail-closed ob napačnem geslu. */
export function loadCertMaterial(p12B64: string, password: string): FursCertMaterial {
  const der = Buffer.from(p12B64, 'base64')
  const p12Asn1 = forge.asn1.fromDer(der.toString('binary'))
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })
  const certBag = bags[forge.pki.oids.certBag]?.[0]
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]
  if (!certBag?.cert || !keyBag) {
    throw new Error('FURS_CERT: P12 ne vsebuje certifikata ali zasebnega ključa (preveri geslo/datoteko).')
  }
  const certPem = forge.pki.certificateToPem(certBag.cert)
  const keyPem = forge.pki.privateKeyToPem(keyBag.key as forge.pki.PrivateKey)
  return {
    certPem,
    keyPem,
    certB64: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert)).getBytes(), 'binary').toString('base64'),
    subjectCN: certBag.cert.subject.getField('CN')?.value || '',
    notAfter: certBag.cert.validity.notAfter,
  }
}

/** Opozorilo, če certifikat v 30 dneh poteče (klicatelj zaloguje v odgovor). */
export function certExpiringSoon(m: FursCertMaterial, days = 30): boolean {
  return m.notAfter.getTime() - Date.now() < days * 86_400_000
}

// ── ZOI (produkcija) ──

/**
 * Produkcijski ZOI: RSA-SHA256 podpis MD5 digesta kanoničnega niza (FURS spec 1.13).
 * Kanonični niz je ISTER kot simulacija (siZoiPayload) — razlika je le v podpisu.
 */
export function signZoi(input: SiFiscalInput, keyPem: string): string {
  const payload = siZoiPayload(input)
  const md5Digest = crypto.createHash('md5').update(payload).digest() // 16 bajtov
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(md5Digest)
  return signer.sign(keyPem).toString('base64')
}

// ── SOAP (XML-DSig envelope po FURS spec 1.13) ──

const NS_FU = 'http://www.furs.si/schemas/FURS/EFiskalizacijaSOA/v1'

export type FursEnvironment = 'test' | 'production'

/** Privzeti endpointa (FURS spec; prekrito z FURS_ENDPOINT_URL, če se spremenita). */
export function fursEndpoint(env: FursEnvironment): string {
  const override = process.env.FURS_ENDPOINT_URL
  if (override) return override
  return env === 'production'
    ? 'https://blagajne.furs.si:9003/v1/cash_registers'
    : 'https://blagajne-test.furs.si:9002/v1/cash_registers'
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Podpisani SOAP envelope: SignedInfo (exclusive C14N, SHA256) nad vsebino `signedXml`,
 * SignatureValue = RSA-SHA256 podpis, BinarySecurityToken = base64 certifikat.
 * FURS zahteva podpis nad `<EchoRequest>` oz. `<InvoiceRequest>` elementom.
 */
export function buildSoapEnvelope(signedXml: string, cert: FursCertMaterial): string {
  const digest = crypto.createHash('sha256').update(signedXml, 'utf8').digest('base64')
  const signedInfo =
    `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<ds:Reference URI="#data"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(signedInfo, 'utf8')
  const signatureValue = signer.sign(cert.keyPem).toString('base64')
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Header>` +
    `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" soapenv:mustUnderstand="1">` +
    `<wsse:BinarySecurityToken EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#Base64Binary" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#X509v3" wsu:Id="cert">${cert.certB64}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}` +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:SecurityTokenReference><ds:Reference URI="#cert" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#X509v3"/></ds:SecurityTokenReference></ds:KeyInfo>` +
    `</ds:Signature></wsse:Security></soapenv:Header>` +
    `<soapenv:Body><fu:data xmlns:fu="${NS_FU}" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" id="data">${signedXml}</fu:data></soapenv:Body>` +
    `</soapenv:Envelope>`
}

/** `<EchoRequest>` — test razpoložljivosti/povezave (brez poslovnih podatkov). */
export function buildEchoRequestXml(message: string): string {
  return `<EchoRequest xmlns="${NS_FU}"><echoRequest>${xmlEscape(message)}</echoRequest></EchoRequest>`
}

/** `<InvoiceRequest>` — pošiljanje računa (ZOI → EOR). Polja po spec 1.13. */
export interface FursInvoiceRequest {
  taxNumber: number // davčna številka zavezanca (8 števk, brez SI)
  issueDateTime: string // 'YYYY-MM-DDTHH:MM:SS' (lokalni čas izdaje)
  invoiceNumber: string // zaporedna
  businessPremiseId: string
  electronicDeviceId: string
  invoiceAmount: number
  paymentAmount: number
  taxesPerSeller: { vatRate: number; basis: number; taxAmount: number }[]
  operatorTaxNumber: number
  protectedID: string // ZOI (produkcija: podpis; test: simulacija)
  subsequentSubmit: boolean
  /** IANA cona lokacije (audit 2026-10 #2) — `<fu:DateTime>` zaglavlja je lokalni čas. */
  timeZone?: string | null
}

export function buildInvoiceRequestXml(inv: FursInvoiceRequest): string {
  const taxes = inv.taxesPerSeller
    .map(
      (t) =>
        `<fu:VAT><fu:TaxRate>${t.vatRate.toFixed(2)}</fu:TaxRate><fu:TaxableAmount>${t.basis.toFixed(2)}</fu:TaxableAmount>` +
        `<fu:TaxAmount>${t.taxAmount.toFixed(2)}</fu:TaxAmount></fu:VAT>`
    )
    .join('')
  return (
    `<InvoiceRequest xmlns="${NS_FU}" Id="data">` +
    `<fu:Header><fu:MessageID>${crypto.randomUUID().toUpperCase()}</fu:MessageID>` +
    `<fu:DateTime>${isoLocal(new Date(), inv.timeZone)}</fu:DateTime></fu:Header>` +
    `<fu:Invoice>` +
    `<fu:TaxNumber>${inv.taxNumber}</fu:TaxNumber>` +
    `<fu:IssueDateTime>${xmlEscape(inv.issueDateTime)}</fu:IssueDateTime>` +
    `<fu:NumberingStructure><fu:InvoiceNumber>${xmlEscape(inv.invoiceNumber)}</fu:InvoiceNumber>` +
    `<fu:BusinessPremiseID>${xmlEscape(inv.businessPremiseId)}</fu:BusinessPremiseID>` +
    `<fu:ElectronicDeviceID>${xmlEscape(inv.electronicDeviceId)}</fu:ElectronicDeviceID></fu:NumberingStructure>` +
    `<fu:InvoiceAmount>${inv.invoiceAmount.toFixed(2)}</fu:InvoiceAmount>` +
    `<fu:PaymentAmount>${inv.paymentAmount.toFixed(2)}</fu:PaymentAmount>` +
    `<fu:TaxesPerSeller>${taxes}</fu:TaxesPerSeller>` +
    `<fu:OperatorTaxNumber>${inv.operatorTaxNumber}</fu:OperatorTaxNumber>` +
    `<fu:ProtectedID>${xmlEscape(inv.protectedID)}</fu:ProtectedID>` +
    `<fu:SubsequentSubmit>${inv.subsequentSubmit}</fu:SubsequentSubmit>` +
    `</fu:Invoice></InvoiceRequest>`
  )
}

// ── Odgovori ──

export interface FursInvoiceResponse {
  eor: string
  zoi: string
  success: boolean
}

function extractElement(xml: string, tag: string): string {
  // namespace-tolerantno: ujame <eor> in <fu:eor> (FURS odgovori uporabljajo prefiks)
  const m = xml.match(new RegExp(`<(?:[\\w.\\-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.\\-]+:)?${tag}>`, 'i'))
  return m?.[1]?.trim() ?? ''
}

export function parseEchoResponse(soapXml: string): string {
  const outer = extractElement(soapXml, 'EchoResponse')
  if (!outer) return ''
  // vrednost povratka je v vgnezdenem <echoRequest> elementu (FURS spec 1.13)
  return extractElement(outer, 'echoRequest') || outer
}

export function parseInvoiceResponse(soapXml: string): FursInvoiceResponse {
  const inner = extractElement(soapXml, 'InvoiceResponse')
  return {
    eor: extractElement(inner || soapXml, 'eor'),
    zoi: extractElement(inner || soapXml, 'zoi'),
    success: Boolean(extractElement(inner || soapXml, 'eor')),
  }
}

// ── mTLS HTTPS POST (node https — deluje na Vercelu brez dodatnih odvisnosti) ──

export function soapPost(url: string, xml: string, cert: FursCertMaterial, timeoutMs = 10_000, ca?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset=utf-8',
          'SOAPAction': '/furs/efiskalizacija',
        },
        cert: cert.certPem,
        key: cert.keyPem,
        timeout: timeoutMs,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode || 0, body }))
      }
    )
    req.on('timeout', () => req.destroy(new Error(`FURS: timeout po ${timeoutMs} ms`)))
    req.on('error', reject)
    req.write(xml)
    req.end()
  })
}

// ── Visokonivojski klici ──

export async function fursEcho(env: FursEnvironment, cert: FursCertMaterial, message = 'echo test', ca?: string): Promise<string> {
  const payloadXml = buildEchoRequestXml(message)
  const envelope = buildSoapEnvelope(payloadXml, cert)
  const { status, body } = await soapPost(fursEndpoint(env), envelope, cert, 10_000, ca)
  if (status !== 200) throw new Error(`FURS echo HTTP ${status}: ${body.slice(0, 200)}`)
  return parseEchoResponse(body)
}

export async function fursInvoice(env: FursEnvironment, cert: FursCertMaterial, inv: FursInvoiceRequest, ca?: string): Promise<FursInvoiceResponse> {
  const payloadXml = buildInvoiceRequestXml(inv)
  const envelope = buildSoapEnvelope(payloadXml, cert)
  const { status, body } = await soapPost(fursEndpoint(env), envelope, cert, 10_000, ca)
  if (status !== 200) throw new Error(`FURS invoices HTTP ${status}: ${body.slice(0, 200)}`)
  const parsed = parseInvoiceResponse(body)
  if (!parsed.success) throw new Error(`FURS invoices brez EOR: ${body.slice(0, 200)}`)
  return parsed
}

// ── Env vezava (runbook korak 2) ──

/** Vrne cert material, če je env nastavljen; null pomeni "obnašaj se kot doslej (pending)". */
export function certFromEnv(): { cert: FursCertMaterial; env: FursEnvironment } | null {
  const p12 = process.env.FURS_CERT_P12_B64
  const pw = process.env.FURS_CERT_PASSWORD
  if (!p12 || !pw) return null
  const cert = loadCertMaterial(p12, pw)
  const env = (process.env.FURS_ENVIRONMENT === 'production' ? 'production' : 'test') as FursEnvironment
  return { cert, env }
}

/**
 * CA veriga, s katero verifikujemo FURS strežnik (mTLS v obe smeri). Brez nje
 * Node uporabi svoj privzeti nabor koreninskih certifikatov — kar v praktikah
 * pomeni, da FURS-ova (ACNP/PoCC) veriga ali TESTNI strežnik z lastno CA odpadata
 * z napako `self signed certificate` in račun ostane 'pending' (fail-safe).
 * Simetrično s HR stranjo (FURS_HR_CA_PEM); PEM ali base64 PEM.
 *
 * POMEMBNO: Node ob nastavljenem `ca` ZAMENJA privzeti nabor koreninskih certifikatov,
 * zato mora biti podana CELA veriga do korenine (ne samo certifikat servisa).
 */
export function fursCaFromEnv(): string | undefined {
  const raw = process.env.FURS_CA_PEM
  if (!raw) return undefined
  const t = raw.trim()
  if (t.includes('-----BEGIN')) return t.replace(/\\n/g, '\n')
  return Buffer.from(t, 'base64').toString('utf8')
}
