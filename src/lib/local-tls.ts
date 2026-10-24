/**
 * v1.175.0 — lokalni CA in list za HTTPS v obratu (PRD docs/PRD-LOKALNA-BAZA.md, R2b2).
 *
 * Zakaj sploh CA: Chrome in Edge dovolita namestitev PWA-ja samo čez HTTPS,
 * tablica v lokalnem omrežju pa nima javno veljavnega imena. Lasten korenski
 * certifikat, ki ga operater enkrat zaupa, je edina pot brez javne DNS dome
 * (merjeno 24. 10. 2026: `caddy` in `mkcert` na razvini napravi nista, njuna
 * namestitev pa je tuja binarna odvisnost).
 *
 * Zakaj OpenSSL in ne node-forge: `node-forge` 1.4.0 zna sestaviti DER, a
 * izmerjena veriga Node-u ni bila sprejeta (`unable to verify the first
 * certificate`) v nobeni od preizkušenih kombinacij — critical/necritical
 * basicConstraints, s `pathLength` in brez njega, s ročno izračunanim
 * subjectKeyIdentifier. Namesto da bi pravilnost X.509 kodiranja reševali sami,
 * jo prepustimo OpenSSLu, ki je že del Git for Windows in ga lokalni profil
 * potrebuje tako ali tako.
 *
 * Vsa pota živijo v podatkovni mapi zunaj repozitorija (isti dogovor kot
 * `local-runtime.ts`), tipke so 0600, certifikati 0644.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lanIpv4, type NetworkInterfaceLike } from './local-runtime'

export const LOCAL_TLS_DIR = 'tls'
export const LOCAL_CA_ORG = 'RestaurantOS'
export const LOCAL_CA_COMMON_NAME = 'RestaurantOS Local CA'
export const LOCAL_LEAF_DNS = 'restaurantos.local'
/** 825 dni je najdaljši življenjski čas korenskega certifikata, ki ga sprejmejo operacijski sistemi. */
export const LOCAL_CA_DAYS = 825
/** 398 dni je meja, ki jo zahtevata Apple in Chrome za TLS strežniški certifikat. */
export const LOCAL_LEAF_DAYS = 398
/** List se obnovi, ko ostane manj kot toliko dni — zagon ob prijavi ga lahko podaljša sam. */
export const LOCAL_RENEW_BEFORE_DAYS = 14

export interface Identity {
  dnsNames: string[]
  ips: string[]
}

export interface TlsPaths {
  dir: string
  caKey: string
  caCert: string
  caSerial: string
  csr: string
  leafKey: string
  leafCert: string
  leafExt: string
}

export function tlsPathsFor(dataDir: string): TlsPaths {
  const dir = join(dataDir, LOCAL_TLS_DIR)
  return {
    dir,
    caKey: join(dir, 'ca-key.pem'),
    caCert: join(dir, 'ca-cert.pem'),
    caSerial: join(dir, 'ca.srl'),
    csr: join(dir, 'leaf.csr'),
    leafKey: join(dir, 'leaf-key.pem'),
    leafCert: join(dir, 'leaf-cert.pem'),
    leafExt: join(dir, 'leaf.ext'),
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
/** Znaki, ki bi v OpenSSL konfigu pomenili novo razširitev — naslov ih ne sme nikoli vsebovati. */
const NEVARNO = /[;,`$&|<>\n\r\t\\]/

function jeIPv4(v: string): boolean {
  const m = IPV4.exec(v)
  return !!m && m.slice(1).every((oktet) => Number(oktet) <= 255)
}

function primerajIPv4(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * Identiteta lista iz IPv4-naslovov vmesnikov. Loopback in ime domene sta vedno
 * notri, sicer zagon na istem računalniku ne more odpreti strani. IPv6 se
 * namerno izpusti: link-lokalni naslov `fe80::…%wlan0` ni veljaven SAN vnos.
 */
export function leafSanFor(ips: string[], dnsNames: string[] = []): Identity {
  const cisti: string[] = []
  for (const surov of ips) {
    const v = (surov ?? '').trim()
    if (!v) continue
    if (NEVARNO.test(v)) {
      throw new Error(`[tls] "${v}" ni veljaven IPv4-naslov (vsebuje znake, ki bi spremenili OpenSSL konfiguracijo).`)
    }
    if (jeIPv4(v)) {
      if (!cisti.includes(v)) cisti.push(v)
      continue
    }
    if (/^[0-9a-fA-F:]+$/.test(v)) continue
    throw new Error(`[tls] "${v}" ni veljaven IPv4-naslov.`)
  }
  const dodatniDns = dnsNames.map((d) => (d ?? '').trim()).filter((d) => d && !NEVARNO.test(d))
  const dns = ['localhost', LOCAL_LEAF_DNS, ...dodatniDns.filter((d) => d !== 'localhost' && d !== LOCAL_LEAF_DNS)]
  const ipi = ['127.0.0.1', ...cisti.filter((i) => i !== '127.0.0.1').sort(primerajIPv4)]
  return { dnsNames: dns, ips: ipi }
}

/**
 * Identiteta lista iz dejanskega omrežja gostitelja: zankin naslov vedno, LAN
 * IPv4 po velikosti, ime naprave ker tablica ne tipka `localhost`. Prazen ali
 * nevaren hostname in IPv6 izpusti že `leafSanFor` (merjeno: link-lokalni
 * `fe80::…%wlan0` OpenSSL zavrne).
 */
export function identityFromNetwork(o: {
  hostname: string
  interfaces: Record<string, NetworkInterfaceLike[] | undefined>
}): Identity {
  return leafSanFor(lanIpv4(o.interfaces), [o.hostname])
}

export function sanListText(id: Identity): string {
  return [...id.dnsNames.map((d) => `DNS:${d}`), ...id.ips.map((i) => `IP:${i}`)].join(',')
}

export function leafExtText(id: Identity): string {
  return [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${sanListText(id)}`,
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
    '',
  ].join('\n')
}

export function caArgv(
  p: TlsPaths,
  { commonName = LOCAL_CA_COMMON_NAME, days = LOCAL_CA_DAYS }: { commonName?: string; days?: number } = {},
): string[] {
  return [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-noenc',
    '-days',
    String(days),
    '-keyout',
    p.caKey,
    '-out',
    p.caCert,
    '-subj',
    `/O=${LOCAL_CA_ORG}/CN=${commonName}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    'subjectKeyIdentifier=hash',
  ]
}

export function csrArgv(p: TlsPaths): string[] {
  return ['req', '-newkey', 'rsa:2048', '-noenc', '-keyout', p.leafKey, '-out', p.csr, '-subj', `/CN=${LOCAL_LEAF_DNS}`]
}

export function leafArgv(p: TlsPaths, { days = LOCAL_LEAF_DAYS }: { days?: number } = {}): string[] {
  return [
    'x509',
    '-req',
    '-in',
    p.csr,
    '-CA',
    p.caCert,
    '-CAkey',
    p.caKey,
    '-CAcreateserial',
    '-out',
    p.leafCert,
    '-days',
    String(days),
    '-extfile',
    p.leafExt,
  ]
}

const danMs = 86_400_000

export function daysUntil(notAfterMs: number, nowMs: number): number {
  return (notAfterMs - nowMs) / danMs
}

/** Set razlika: vrstni red v certifikatu ni pomemben, pomembno je, česa manjka in kaj je odveč. */
export function identityDrift(current: Identity, wanted: Identity): { missing: string[]; extra: string[] } {
  const vse = (i: Identity) => [...i.dnsNames, ...i.ips]
  const a = new Set(vse(current))
  const b = new Set(vse(wanted))
  return { missing: [...b].filter((x) => !a.has(x)), extra: [...a].filter((x) => !b.has(x)) }
}

export function shouldReissue(o: {
  current: Identity
  wanted: Identity
  nowMs: number
  notAfterMs: number
  renewBeforeDays?: number
}): boolean {
  const d = identityDrift(o.current, o.wanted)
  if (d.missing.length > 0 || d.extra.length > 0) return true
  return daysUntil(o.notAfterMs, o.nowMs) < (o.renewBeforeDays ?? LOCAL_RENEW_BEFORE_DAYS)
}

export type RunOpenssl = (argv: string[]) => { status: number | null; stdout: string; stderr: string }

function privzetiIzvajalec(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('openssl', argv, { encoding: 'utf8', windowsHide: true })
  if (r.error) return { status: null, stdout: '', stderr: `OpenSSL ni dosegljiv: ${r.error.message}` }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function preberiPoteko(exec: RunOpenssl, datoteka: string): number {
  const r = exec(['x509', '-in', datoteka, '-noout', '-enddate'])
  const m = /notAfter=(.+)$/m.exec(r.stdout)
  if (r.status !== 0 || !m) return -1
  const ms = Date.parse(m[1].trim())
  return Number.isNaN(ms) ? -1 : ms
}

function preberiIdentiteto(exec: RunOpenssl, datoteka: string): Identity | null {
  const r = exec(['x509', '-in', datoteka, '-noout', '-ext', 'subjectAltName'])
  if (r.status !== 0) return null
  const vrstica = r.stdout.split(/\r?\n/).find((l) => l.trim().startsWith('DNS:') || l.trim().startsWith('IP Address:'))
  if (!vrstica) return null
  const dnsNames: string[] = []
  const ips: string[] = []
  for (const del of vrstica.trim().split(',')) {
    const d = del.replace(/^DNS:/, '').trim()
    const i = del.replace(/^IP Address:/, '').trim()
    if (del.startsWith('DNS:') && d) dnsNames.push(d)
    else if (del.startsWith('IP Address:') && i) ips.push(i)
  }
  return { dnsNames, ips }
}

export interface EnsureTlsResult {
  ok: boolean
  created: boolean
  reissued: boolean
  caExpired: boolean
  step?: string
  paths: TlsPaths
  message: string
}

export interface EnsureTlsOptions {
  dataDir: string
  identity: Identity
  nowMs?: number
  run?: RunOpenssl
  readNotAfter?: (path: string) => number
  readIdentity?: (path: string) => Identity | null
  force?: boolean
  rotateCa?: boolean
  renewBeforeDays?: number
}

/**
 * Pripravi lokalni CA in HTTPS list. Funkcija je idempotentna: obstoječ veljaven
 * par ne sme biti ponovno izdan, nov IP po ponovnem zagonu ali DHCP-ju pa zahteva
 * nov list — CA ostane isti, zato tablica zaupanja ne izgubi.
 */
export function ensureLocalTls(o: EnsureTlsOptions): EnsureTlsResult {
  const paths = tlsPathsFor(o.dataDir)
  const nowMs = o.nowMs ?? Date.now()
  const exec = o.run ?? privzetiIzvajalec
  const readNa = o.readNotAfter ?? ((p: string) => preberiPoteko(exec, p))
  const readId = o.readIdentity ?? ((p: string) => preberiIdentiteto(exec, p))

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })

  const fail = (step: string, message: string, dodatno: Partial<EnsureTlsResult> = {}): EnsureTlsResult => ({
    ok: false,
    created: false,
    reissued: false,
    caExpired: false,
    step,
    message,
    paths,
    ...dodatno,
  })

  const caObstoji = existsSync(paths.caCert) && existsSync(paths.caKey)
  if (caObstoji && !o.rotateCa) {
    const na = readNa(paths.caCert)
    if (na <= nowMs) {
      return fail(
        'ca',
        `Lokalni CA je potekel ali ga ni bilo mogoče prebrati (${paths.caCert}). Nov CA pomeni, da morajo naprave zaupanje ponoviti — izrecno zaželi z --rotate-ca.`,
        { caExpired: true },
      )
    }
  }

  let created = false
  if (!caObstoji || o.rotateCa) {
    const r = exec(caArgv(paths, { days: LOCAL_CA_DAYS }))
    if (r.status !== 0) return fail('req', `CA ni bil izdan: ${r.stderr || r.stdout}`, { caExpired: caObstoji })
    created = true
  }

  const listObstoji = existsSync(paths.leafCert) && existsSync(paths.leafKey)
  if (listObstoji && !o.force) {
    const current = readId(paths.leafCert)
    const na = readNa(paths.leafCert)
    if (current && !shouldReissue({ current, wanted: o.identity, nowMs, notAfterMs: na, renewBeforeDays: o.renewBeforeDays })) {
      return {
        ok: true,
        created,
        reissued: false,
        caExpired: false,
        paths,
        message: `HTTPS list je veljaven (${sanListText(current)}), ni bilo treba ga izdati znova.`,
      }
    }
  }

  writeFileSync(paths.leafExt, leafExtText(o.identity), { mode: 0o644 })

  const csr = exec(csrArgv(paths))
  if (csr.status !== 0) return fail('req', `Zahtevek za list (CSR) ni uspel: ${csr.stderr || csr.stdout}`, { created })

  const sign = exec(leafArgv(paths, { days: LOCAL_LEAF_DAYS }))
  if (sign.status !== 0) return fail('x509', `List ni bil podpisan: ${sign.stderr || sign.stdout}`, { created })

  return {
    ok: true,
    created,
    reissued: true,
    caExpired: false,
    paths,
    message: `HTTPS list izdan za ${sanListText(o.identity)}.`,
  }
}
