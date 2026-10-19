/**
 * HR CIS SOAP odjemalec (Hrvaška fiskalizacija — ZKI podpis + echo + računi).
 *
 * Naloga 38: kodekska priprava na FINA/eIDAS certifikat (zrcalno Nalogi 36 za SI;
 * runbook docs/FURS-CERT-RUNBOOK.md, razdelek HR). Brez certifikata
 * (FURS_HR_CERT_P12_B64/FURS_HR_CERT_PASSWORD) se NIČ ne spremeni — cisStatus ostane
 * 'pending' (obstoječe vedenje). Z certifikatom:
 *   ZKI  = MD5hex(RSA-SHA256 podpis kanoničnega niza) — ALGORITEM po URAJNI specifikaciji
 *          Porezne uprave v2.7 (21.07.2026), poglavje 12 (pseudokod str. 208):
 *          kanonični niz = OIB + 'dd.MM.yyyy HH:mm:ss' (VEZAJ presledek!) + BrOznRac +
 *          OznPosPr + OznNapUr + ukupni iznos (PIKA kot decimalno ločilo),
 *          podpis = SHA256withRSA nad UTF-8 bajti niza, ZKI = MD5(signature) → 32 malih hex.
 *          (RSA-SHA1 je od 01.01.2027 v produkciji ZAVRJEN — implementiramo takoj RSA-SHA256.)
 *   JIR  = odgovor CIS `RacunZahtjev` SOAP klica (36 znakov UUID) → cisJir + cisStatus 'verified'.
 *
 * Transport (spec v2.7 §3–6): 1-way TLS (strežnik se predstavi s certifikatom; klient
 * se NE overja z mTLS!), SOAP 1.1 document-literal, UTF-8, porta 8449:
 *   TEST:  https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest
 *   PROD:  https://cis.porezna-uprava.hr:8449/FiskalizacijaService
 * Strežniški certifikat podpisuje FINA RDC CA (prod) / FINA DEMO CA (test) — ki NI
 * v privzetih Node trust store-ih → podaj verigo prek FURS_HR_CA_PEM (PEM ali base64);
 * brez nje TLS verifikacija fail-closed (račun ostane 'pending').
 *
 * XML-DSig (spec v2.7 §7 — RAZLIČNO od FURS!): podpis je ZNOTRAJ korenskega elementa
 * zahtevka (enveloped), ne v SOAP Security headerju:
 *   Reference URI="#RacunZahtjev", Transforms: enveloped-signature + exclusive C14N,
 *   DigestMethod sha256, SignatureMethod rsa-sha256, KeyInfo/X509Data/X509Certificate.
 * Digest = SHA-256 nad exclusive-C14N serializacijo korenskega elementa BREZ <Signature>
 * (enveloped-signature transform). Naš serializer gradi deterministični XML brez
 * neuporabljenih namespace deklaracij (exc-c14n odstrani neuporabljene — zato
 * xmlns:xsi NAMENOMA ne dodajamo, da so naši bajti = canonical form).
 *
 * Omejitve/dokumentirane odločitve:
 *  - OibOper: Employee nima OIB polja → kot operaterjev OIB se pošlje OIB izdajalca
 *    (spec dovoljuje za samopostrežne uređaje; za osebno blagajno pride ločeno polje
 *    z validacijo testnega okolja — rezidual, prim. SI OperatorTaxNumber).
 *  - NacinPlac: cash→G, card/mobile→K, vse ostalo (voucher/loyalty/giftcard/alternate/
 *    mixed)→O ('Ostalo' po spec — več načinov ali neopredeljeno); T (transakcijski
 *    račun) ni v uporabi.
 *  - OznNapUr/OznPosPr se sanitarizirajo na spec format (številke brez vodilnih ničel /
 *    alnum) z varnimi privzetki — HR lokacija naj ima registerNumber = št. naplatnega
 *    uređaja (npr. '1', '12').
 */

import crypto from 'crypto'
import https from 'https'
import { loadCertMaterial, type FursCertMaterial } from '@/lib/furs/client'
import { hrLocalDateTime, hrLocalDateTimeT } from '@/lib/fiscal-time'

export type { FursCertMaterial }

// ── Oblike podatkov (spec v2.7, poglavje 12 + 2.1) ──

/** 'dd.MM.yyyy HH:mm:ss' (presledek!) — ZKI kanonični niz (spec pogl. 12).
 *  timeZone: lokalni čas izdaje računa (audit 2026-10 #2); izpuščen = sistemski čas. */
export function hrZkiDateTime(d: Date, timeZone?: string | null): string {
  return hrLocalDateTime(d, timeZone)
}

/** 'dd.MM.yyyyTHH:mm:ss' (T!) — Zaglavlje.DatumVrijeme + Racun.DatVrijeme (spec primeri). */
export function hrMessageDateTime(d: Date, timeZone?: string | null): string {
  return hrLocalDateTimeT(d, timeZone)
}

/** OznNapUr: samo številke 0-9 brez vodilnih ničel (spec) — varni privzetek '1'. */
export function hrDeviceId(raw: string | null | undefined): string {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^0+/, '')
  return digits || '1'
}

/** OznPosPr: samo 0-9 a-z A-Z (spec) — varni privzetek 'PP1'. */
export function hrPremisesId(raw: string | null | undefined): string {
  const alnum = String(raw || '').replace(/[^0-9a-zA-Z]/g, '')
  return alnum || 'PP1'
}

/** BrOznRac: samo številke brez vodilnih ničel (spec). */
export function hrInvoiceNumber(raw: string | number): string {
  const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '')
  return digits || '0'
}

/** ZKI input — kanonični niz kot ga definira spec v2.7 pogl. 12 (javno, za teste). */
export interface HrZkiInput {
  oib: string // 11 števk
  issuedAt: Date
  invoiceNumber: string // BrOznRac (brez vodilnih ničel)
  premisesId: string // OznPosPr
  deviceId: string // OznNapUr
  total: number // ukupni iznos (pika kot decimalno ločilo, 2 decalki)
  /** IANA cona lokacije — DatVrijeme in ZKI morata biti v lokalnem času (audit #2). */
  timeZone?: string | null
}

/** Kanonični niz za ZKI (spec v2.7 pogl. 12) — javen, ker ga podpisujemo. */
export function hrZkiPayload(input: HrZkiInput): string {
  return (
    input.oib +
    hrZkiDateTime(input.issuedAt, input.timeZone) +
    input.invoiceNumber +
    input.premisesId +
    input.deviceId +
    input.total.toFixed(2)
  )
}

/**
 * Produkciski ZKI: MD5hex(RSA-SHA256(podpis nad kanoničnim nizom)) → 32 malih hex znakov.
 * (Psevdokod spec v2.7: "elektronički potpiši medjurezultat koristeći RSA-SHA256 potpis;
 * rezultatIspis = izračunajMD5(elektronički potpisani medjurezultat)".)
 */
export function signZki(input: HrZkiInput, keyPem: string): string {
  const payload = hrZkiPayload(input)
  const signature = crypto.createSign('RSA-SHA256').update(payload, 'utf8').sign(keyPem)
  return crypto.createHash('md5').update(signature).digest('hex')
}

// ── Način plačila (spec: G|K|T|O; več načinov/neopredeljeno → O) ──

export type HrNacinPlac = 'G' | 'K' | 'T' | 'O'

export function hrNacinPlac(method: string): HrNacinPlac {
  if (method === 'cash') return 'G'
  if (method === 'card' || method === 'mobile') return 'K'
  return 'O'
}

// ── RacunZahtjev (XML brez Signature — digest se računa nad tem) ──

export const NS_TNS = 'http://www.apis-it.hr/fin/2012/types/f73'
export const NS_DS = 'http://www.w3.org/2000/09/xmldsig#'

export interface HrVatLine {
  rate: number
  base: number
  amount: number
}

export interface HrInvoiceRequest {
  oib: string // OIB obveznika (11 števk)
  inVatSystem: boolean // USustPdv
  issuedAt: Date // DatVrijeme (in ZKI)
  invoiceNumber: string // BrOznRac
  premisesId: string // OznPosPr
  deviceId: string // OznNapUr
  vatRates: HrVatLine[] // Pdv/Porez (samo če obstajajo)
  total: number // IznosUkupno
  paymentMethod: HrNacinPlac
  operatorOib: string // OibOper
  zki: string // ZastKod (32 hex malih)
  subsequentSubmit: boolean // NakDost
  idPoruke?: string // UUID — samodejno, če ni podan
  /** IANA cona lokacije (audit #2) — velja za DatumVrijeme in DatVrijeme. */
  timeZone?: string | null
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const dec2 = (n: number): string => n.toFixed(2)

/**
 * `<tns:RacunZahtjev>` BREZ podpisa — točno ta niz (byte-identično) gre v digest.
 * Vrstni red elementov točno po spec v2.7 (§2.1.2.1 primer); opcijske skupine (Pnp,
 * OstaliPor, oslobođenja, marža, Naknade, ParagonBrRac, SpecNamj, OibPrimateljaRacuna)
 * se ne pošiljajo — naš izdajalni tok ima samo PDV razčlenbo.
 */
export function buildRacunZahtjevContent(inv: HrInvoiceRequest): string {
  const idPoruke = inv.idPoruke || crypto.randomUUID().toUpperCase()
  const pdv = inv.vatRates.length
    ? `<tns:Pdv>${inv.vatRates
        .map(
          (t) =>
            `<tns:Porez><tns:Stopa>${dec2(t.rate)}</tns:Stopa><tns:Osnovica>${dec2(t.base)}</tns:Osnovica>` +
            `<tns:Iznos>${dec2(t.amount)}</tns:Iznos></tns:Porez>`
        )
        .join('')}</tns:Pdv>`
    : ''
  return (
    `<tns:RacunZahtjev Id="RacunZahtjev" xmlns:tns="${NS_TNS}">` +
    `<tns:Zaglavlje>` +
    `<tns:IdPoruke>${xmlEscape(idPoruke)}</tns:IdPoruke>` +
    `<tns:DatumVrijeme>${xmlEscape(hrMessageDateTime(new Date(), inv.timeZone))}</tns:DatumVrijeme>` +
    `</tns:Zaglavlje>` +
    `<tns:Racun>` +
    `<tns:Oib>${xmlEscape(inv.oib)}</tns:Oib>` +
    `<tns:USustPdv>${inv.inVatSystem ? 'true' : 'false'}</tns:USustPdv>` +
    `<tns:DatVrijeme>${xmlEscape(hrMessageDateTime(inv.issuedAt, inv.timeZone))}</tns:DatVrijeme>` +
    `<tns:OznSlijed>P</tns:OznSlijed>` +
    `<tns:BrRac>` +
    `<tns:BrOznRac>${xmlEscape(hrInvoiceNumber(inv.invoiceNumber))}</tns:BrOznRac>` +
    `<tns:OznPosPr>${xmlEscape(hrPremisesId(inv.premisesId))}</tns:OznPosPr>` +
    `<tns:OznNapUr>${xmlEscape(hrDeviceId(inv.deviceId))}</tns:OznNapUr>` +
    `</tns:BrRac>` +
    pdv +
    `<tns:IznosUkupno>${dec2(inv.total)}</tns:IznosUkupno>` +
    `<tns:NacinPlac>${inv.paymentMethod}</tns:NacinPlac>` +
    `<tns:OibOper>${xmlEscape(inv.operatorOib)}</tns:OibOper>` +
    `<tns:ZastKod>${xmlEscape(inv.zki)}</tns:ZastKod>` +
    `<tns:NakDost>${inv.subsequentSubmit ? 'true' : 'false'}</tns:NakDost>` +
    `</tns:Racun>` +
    `</tns:RacunZahtjev>`
  )
}

// ── XML-DSig (enveloped — spec v2.7 §7) ──

/**
 * Podpisan SOAP envelope: `<RacunZahtjev>` (ali drug korenski element spec oblike
 * `{rootName}`) s `<Signature>` kot zadnjim otrokom. Digest = SHA-256 nad `contentXml`
 * (BREZ Signature — enveloped-signature transform); SignatureValue = RSA-SHA256 nad
 * exclusive-C14N obliko SignedInfo (naš deterministični niz, default ds namespace
 * deklariran na Signature/SignedInfo — exc-c14n ga ohrani, ker je uporabljen).
 */
export function buildSignedEnvelope(
  contentXml: string,
  cert: FursCertMaterial,
  rootName = 'RacunZahtjev'
): string {
  const digest = crypto.createHash('sha256').update(contentXml, 'utf8').digest('base64')
  const signedInfo =
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>` +
    `<Reference URI="#${rootName}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(signedInfo, 'utf8')
  const signatureValue = signer.sign(cert.keyPem).toString('base64')
  // contentXml je `<tns:RacunZahtjev ...>...</tns:RacunZahtjev>` — Signature gre ZNOTRAJ
  const inner = contentXml.replace(`</tns:${rootName}>`, `<Signature xmlns="${NS_DS}">${signedInfo}<SignatureValue>${signatureValue}</SignatureValue><KeyInfo><X509Data><X509Certificate>${cert.certB64}</X509Certificate></X509Data></KeyInfo></Signature></tns:${rootName}>`)
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>${inner}</soapenv:Body>` +
    `</soapenv:Envelope>`
  )
}

/** `<tns:EchoRequest>` — test povezljivosti (spec §2.4: brez podpisa/certifikata). */
export function buildEchoRequestXml(message: string): string {
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>` +
    `<tns:EchoRequest xmlns:tns="${NS_TNS}">${xmlEscape(message)}</tns:EchoRequest>` +
    `</soapenv:Body></soapenv:Envelope>`
}

// ── Odgovori ──

export interface HrInvoiceResponse {
  jir: string // 36 znakov UUID — samo ob uspehu
  success: boolean
  errors: { code: string; message: string }[] // sXXX + PorukaGreske
}

function extractElement(xml: string, tag: string): string {
  // namespace-tolerantno: ujame <Jir>, <tns:Jir>, <fu:Jir> …
  const m = xml.match(new RegExp(`<(?:[\\w.\\-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.\\-]+:)?${tag}>`, 'i'))
  return m?.[1]?.trim() ?? ''
}

export function parseEchoResponse(soapXml: string): string {
  return extractElement(soapXml, 'EchoResponse')
}

export function parseRacunResponse(soapXml: string): HrInvoiceResponse {
  const inner = extractElement(soapXml, 'RacunOdgovor') || soapXml
  const jir = extractElement(inner, 'Jir')
  const errors: { code: string; message: string }[] = []
  const greskeBlock = extractElement(inner, 'Greske')
  const greskaMatches = (greskeBlock || '').match(/<(?:[\w.\-]+:)?Greska(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.\-]+:)?Greska>/gi) || []
  for (const g of greskaMatches) {
    const code = extractElement(g, 'SifraGreske')
    const message = extractElement(g, 'PorukaGreske')
    if (code || message) errors.push({ code, message })
  }
  return { jir, success: Boolean(jir), errors }
}

// ── HTTPS POST (1-way TLS — spec §3.2; klient NE pošilja certifikata) ──

export function cisPost(url: string, xml: string, timeoutMs = 10_000, ca?: string): Promise<{ status: number; body: string }> {
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
          'SOAPAction': '""',
        },
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
    req.on('timeout', () => req.destroy(new Error(`CIS: timeout po ${timeoutMs} ms`)))
    req.on('error', reject)
    req.write(xml)
    req.end()
  })
}

// ── Endpointi + visokonivojski klici ──

export type HrEnvironment = 'test' | 'production'

/** Endpointa po spec v2.7 §6.1 (prekrito s FURS_HR_ENDPOINT_URL). */
export function cisEndpoint(env: HrEnvironment): string {
  const override = process.env.FURS_HR_ENDPOINT_URL
  if (override) return override
  return env === 'production'
    ? 'https://cis.porezna-uprava.hr:8449/FiskalizacijaService'
    : 'https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest'
}

/** CA veriga za TLS (FINA RDC CA / FINA DEMO CA) iz env — PEM ali base64; null = brez. */
export function cisCaFromEnv(): string | null {
  const raw = process.env.FURS_HR_CA_PEM
  if (!raw) return null
  const t = raw.trim()
  if (t.includes('-----BEGIN')) return t.replace(/\\n/g, '\n')
  try {
    return Buffer.from(t, 'base64').toString('utf8')
  } catch {
    return null
  }
}

export async function cisEcho(env: HrEnvironment, message = 'echo test', ca?: string): Promise<string> {
  const envelope = buildEchoRequestXml(message)
  const { status, body } = await cisPost(cisEndpoint(env), envelope, 10_000, ca ?? cisCaFromEnv() ?? undefined)
  if (status !== 200) throw new Error(`CIS echo HTTP ${status}: ${body.slice(0, 200)}`)
  return parseEchoResponse(body)
}

export async function cisInvoice(env: HrEnvironment, cert: FursCertMaterial, inv: HrInvoiceRequest, ca?: string): Promise<HrInvoiceResponse> {
  const content = buildRacunZahtjevContent(inv)
  const envelope = buildSignedEnvelope(content, cert)
  const { status, body } = await cisPost(cisEndpoint(env), envelope, 10_000, ca ?? cisCaFromEnv() ?? undefined)
  if (status !== 200) throw new Error(`CIS RacunZahtjev HTTP ${status}: ${body.slice(0, 200)}`)
  const parsed = parseRacunResponse(body)
  if (!parsed.success) {
    const desc = parsed.errors.map((e) => `${e.code}${e.message ? `: ${e.message}` : ''}`).join('; ') || body.slice(0, 200)
    throw new Error(`CIS RacunZahtjev brez JIR (${desc})`)
  }
  return parsed
}

// ── Env vezava (runbook razdelek HR) ──

/** Vrne cert material, če je env nastavljen; null pomeni "obnašaj se kot doslej (pending)". */
export function cisCertFromEnv(): { cert: FursCertMaterial; env: HrEnvironment } | null {
  const p12 = process.env.FURS_HR_CERT_P12_B64
  const pw = process.env.FURS_HR_CERT_PASSWORD
  if (!p12 || !pw) return null
  const cert = loadCertMaterial(p12, pw)
  const rawEnv = (process.env.FURS_HR_ENVIRONMENT ?? process.env.FURS_ENVIRONMENT ?? 'test').toLowerCase()
  const env = (rawEnv === 'production' ? 'production' : 'test') as HrEnvironment
  return { cert, env }
}
