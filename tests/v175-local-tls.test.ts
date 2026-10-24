/**
 * v1.175.0 — R2b2 (PRD docs/PRD-LOKALNA-BAZA.md): lokalni profil mora streči
 * HTTPS v lokalnem omrežju, sicer se PWA na tablico ne da namestiti — Chrome
 * in Edge dovolita »namesti aplikacijo« samo nad HTTPS.
 *
 * Meritve, ki so rodile te teste (Windows, 24. 10. 2026):
 *  - `caddy` in `mkcert` na tej napravi NISTA, kljub PRD-ovi odločitvi »Caddy z
 *    lokalnim CA«; zato CA izdaja lasten OpenSSL:
 *    `C:\Program Files\Git\ucrt64\bin\openssl.exe` (OpenSSL 3.5.9), ki je del
 *    Git for Windows in je zato povsod tam, kjer je že Git Bash — nujna
 *    predpostavka lokalnega profila;
 *  - `spawnSync('openssl', …)` BREZ `shell: true` binar najde in argv ji pride
 *    nespremenjen; `node-forge` 1.4.0 verige, ki bi jo Node sprejel, NI zmogel
 *    (`unable to verify the first certificate` v vseh kombinacijah critical /
 *    pathLength / SKI), zato X.509 sploh ne generiramo v JS;
 *  - `-subj "/O=…"` skozi Git Bash razpade, ker MSYS pot `/O=…` pretvori v
 *    `C:/Program Files/Git/O=…`. Izmera: `req: subject name is expected to be in
 *    the format /type0=value0…`. Rešitev je neposredna spawnska pot brez lupine,
 *    kar preprečuje tudi vsak shell injection v imenih vmesnikov;
 *  - izmerjeno delujoča veriga: `openssl verify -CAfile ca-cert.pem leaf-cert.pem`
 *    → `OK` in Node TLS nad njo → `authorized: true`; z napačnim sidrom pade na
 *    `unable to verify the first certificate` (negativna kontrola v testu B6).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import tls from 'node:tls'
import { spawnSync } from 'node:child_process'
import {
  LOCAL_CA_COMMON_NAME,
  LOCAL_CA_DAYS,
  LOCAL_LEAF_DAYS,
  LOCAL_TLS_DIR,
  caArgv,
  csrArgv,
  daysUntil,
  ensureLocalTls,
  identityDrift,
  leafArgv,
  leafExtText,
  leafSanFor,
  sanListText,
  shouldReissue,
  tlsPathsFor,
  type Identity,
} from '../src/lib/local-tls'

const HAS_OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

const tmpDirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ros-v175-tls-'))
  tmpDirs.push(d)
  return d
}

/** Vredje zastavice (`-out`, `-keyout`) v OpenSSL argv — sam zastavica ni pot. */
function potZastavice(argv: string[], zastavica: string): string | undefined {
  const i = argv.indexOf(zastavica)
  return i === -1 ? undefined : argv[i + 1]
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const ID: Identity = { dnsNames: ['restaurantos.local', 'localhost'], ips: ['127.0.0.1', '192.168.1.50'] }

describe('A. identiteta lista', () => {
  it('B1: vedno vsebuje localhost in 127.0.0.1, tudi če ju vmesniki ne dajo', () => {
    const san = leafSanFor(['10.0.0.7'])
    expect(san.dnsNames).toContain('localhost')
    expect(san.ips).toContain('127.0.0.1')
    expect(san.ips).toContain('10.0.0.7')
  })

  it('B2: podvojeni naslovi in prazni vmesniki ne ustvarijo podvojenih vnosov', () => {
    const san = leafSanFor(['10.0.0.7', '10.0.0.7', '', '  ', '10.0.0.8'])
    expect(san.ips.filter((x) => x === '10.0.0.7')).toEqual(['10.0.0.7'])
    expect(san.ips).not.toContain('')
    expect(san.ips).not.toContain('  ')
  })

  it('B3: IPv6-naslovi so zavrnjeni, ne zapisani v SAN', () => {
    const san = leafSanFor(['fe80::1', '::1', '192.168.1.50'])
    expect(san.ips).toEqual(['127.0.0.1', '192.168.1.50'])
  })

  it('B4: SAN seznam je determinističen — enak vnos, enak vrstni red', () => {
    const prva = sanListText(leafSanFor(['192.168.1.50', '10.0.0.7']))
    const druga = sanListText(leafSanFor(['10.0.0.7', '192.168.1.50']))
    expect(prva).toBe(druga)
    expect(prva).toStartWith('DNS:localhost,')
    expect(prva).toContain('IP:127.0.0.1')
    expect(prva).toContain('IP:192.168.1.50')
  })

  it('B5: naslov, ki ni naslov, ne more vsebati SAN ločil', () => {
    expect(() => leafSanFor(['1.2.3.4, DNS:napad.example'])).toThrow()
    expect(() => leafSanFor(['1.2.3.4\nkeyUsage=critical'])).toThrow()
  })
})

describe('C. razširitve lista in argv OpenSSL', () => {
  it('C1: ext-fajst ima vse razširitve, ki jih zahteva brskalnik, in je LF', () => {
    const ext = leafExtText(ID)
    expect(ext).toContain('basicConstraints=critical,CA:FALSE')
    expect(ext).toContain('keyUsage=critical,digitalSignature,keyEncipherment')
    expect(ext).toContain('extendedKeyUsage=serverAuth')
    expect(ext).toContain('subjectAltName=DNS:restaurantos.local,DNS:localhost,IP:127.0.0.1,IP:192.168.1.50')
    expect(ext).toContain('authorityKeyIdentifier=keyid,issuer')
    expect(ext).not.toContain('\r')
    expect(ext.endsWith('\n')).toBe(true)
  })

  it('C2: CA argv razglasi CA:TRUE in keyCertSign — brez njiju Node zavrne sidro', () => {
    const argv = caArgv(tlsPathsFor('/podatki'), { commonName: LOCAL_CA_COMMON_NAME, days: LOCAL_CA_DAYS })
    expect(argv[0]).toBe('req')
    expect(argv).toContain('-x509')
    expect(argv).toContain('basicConstraints=critical,CA:TRUE')
    expect(argv).toContain('keyUsage=critical,keyCertSign,cRLSign')
    expect(argv).toContain(String(LOCAL_CA_DAYS))
    expect(argv.some((a) => a.includes(';') || a.includes('|') || a.includes('`'))).toBe(false)
  })

  it('C3: list je podpisan s CA, ne samosvojstno, in traja najdlje 398 dni', () => {
    const p = tlsPathsFor('/podatki')
    const a1 = csrArgv(p)
    expect(a1).toContain('req')
    expect(a1).toContain(p.leafKey)
    const a2 = leafArgv(p, { days: LOCAL_LEAF_DAYS })
    expect(a2).toContain('x509')
    expect(a2).toContain('-CA')
    expect(a2).toContain('-extfile')
    expect(a2).toContain(String(LOCAL_LEAF_DAYS))
    expect(LOCAL_LEAF_DAYS).toBeLessThanOrEqual(398)
    expect(a2.indexOf('-CA')).toBeLessThan(a2.indexOf('-CAkey'))
    expect(a2).toContain(p.caCert)
    expect(a2).toContain(p.caKey)
  })

  it('C4: poti so absolutne iz podatkovne mape, ključi in certifikati imajo ločena imena', () => {
    const p = tlsPathsFor('/podatki')
    expect(p.dir).toBe(join('/podatki', LOCAL_TLS_DIR))
    expect(p.caKey).toBe(join(p.dir, 'ca-key.pem'))
    expect(p.caCert).toBe(join(p.dir, 'ca-cert.pem'))
    expect(p.leafKey).toBe(join(p.dir, 'leaf-key.pem'))
    expect(p.leafCert).toBe(join(p.dir, 'leaf-cert.pem'))
    expect(p.leafExt).toBe(join(p.dir, 'leaf.ext'))
    expect(new Set(Object.values(p).filter((v) => typeof v === 'string')).size).toBeGreaterThan(5)
  })
})

describe('D. ponovni zagon in nova IP po DHCP', () => {
  it('D1: nova IP po ponovnem zagonu je drift in zahteva novo izdajo lista', () => {
    const obstojeca: Identity = { dnsNames: ['restaurantos.local', 'localhost'], ips: ['127.0.0.1', '192.168.1.50'] }
    const nova: Identity = { dnsNames: ['restaurantos.local', 'localhost'], ips: ['127.0.0.1', '192.168.1.77'] }
    const d = identityDrift(obstojeca, nova)
    expect(d.missing).toEqual(['192.168.1.77'])
    expect(d.extra).toEqual(['192.168.1.50'])
    expect(shouldReissue({ current: obstojeca, wanted: nova, nowMs: 0, notAfterMs: 86_400_000 * 300 })).toBe(true)
  })

  it('D2: enak nabor in daleč od poteka — list NE sme biti ponovno izdan', () => {
    expect(shouldReissue({ current: ID, wanted: ID, nowMs: 0, notAfterMs: 86_400_000 * 300 })).toBe(false)
  })

  it('D3: list, ki poteče v manj kot 14 dneh, je treba obnoviti, starejši pa ne', () => {
    const day = 86_400_000
    expect(shouldReissue({ current: ID, wanted: ID, nowMs: 0, notAfterMs: 13 * day })).toBe(true)
    expect(shouldReissue({ current: ID, wanted: ID, nowMs: 0, notAfterMs: 15 * day })).toBe(false)
    expect(daysUntil(10 * day, 0)).toBeCloseTo(10, 5)
  })

  it('D4: potekel CA ni tiho — zahteva izrecno rotacijo', () => {
    const d = tempDir()
    const p = tlsPathsFor(d)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.caCert, 'LAŽNI CA\n')
    writeFileSync(p.caKey, 'LAŽNI CA KLJUČ\n')
    let klici = 0
    const res = ensureLocalTls({
      dataDir: d,
      identity: ID,
      nowMs: 0,
      run: () => {
        klici++
        return { status: 0, stdout: '', stderr: '' }
      },
      readNotAfter: () => -1,
    })
    expect(res.ok).toBe(false)
    expect(res.caExpired).toBe(true)
    expect(res.reissued).toBe(false)
    expect(klici).toBe(0)
    expect(res.message).toContain('CA')
  })

  it('D5: izvajalec spravi tri korake v pravem vrstnem redu in zapiše ext-fajst', () => {
    const d = tempDir()
    const zaporedje: string[][] = []
    const res = ensureLocalTls({
      dataDir: d,
      identity: ID,
      nowMs: 0,
      run: (argv) => {
        zaporedje.push(argv)
        const p = potZastavice(argv, '-out')
        if (p) writeFileSync(p, 'PEM\n')
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    expect(zaporedje.map((a) => a[0])).toEqual(['req', 'req', 'x509'])
    expect(res.created).toBe(true)
    const ext = readFileSync(join(d, LOCAL_TLS_DIR, 'leaf.ext'), 'utf8')
    expect(ext).toContain('subjectAltName=')
  })

  it('D6: napaka pri drugem koraku ne pusti pol-izdanega lista in javi, kateri korak je padel', () => {
    const d = tempDir()
    const res = ensureLocalTls({
      dataDir: d,
      identity: ID,
      nowMs: 0,
      run: (argv) => {
        if (argv[0] === 'x509') return { status: 1, stdout: '', stderr: 'x509 je napak' }
        const izhod = potZastavice(argv, '-out')
        if (izhod) writeFileSync(izhod, 'PEM\n')
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    expect(res.ok).toBe(false)
    expect(res.step).toBe('x509')
    expect(res.message).toContain('x509 je napak')
    expect(existsSync(res.paths.leafCert)).toBe(false)
  })

  it('D7: drugi klic z isto identiteto ne izdaja znova; nova IP po DHCP-ju izda samo list, ne CA-ja', () => {
    const d = tempDir()
    let klici: string[][] = []
    const zapisi = new Map<string, Identity>()
    const p = tlsPathsFor(d)
    const run = (argv: string[]) => {
      klici.push(argv)
      const out = potZastavice(argv, '-out')
      const keyout = potZastavice(argv, '-keyout')
      if (out) writeFileSync(out, 'PEM\n')
      if (keyout) writeFileSync(keyout, 'PEM\n')
      if (out === p.leafCert) zapisi.set('list', ID)
      return { status: 0, stdout: '', stderr: '' }
    }
    const opts = {
      dataDir: d,
      identity: ID,
      nowMs: 0,
      run,
      readNotAfter: () => 86_400_000 * 300,
      readIdentity: () => (zapisi.get('list') ?? ID),
    }
    const prvi = ensureLocalTls(opts)
    expect(prvi.ok).toBe(true)
    expect(prvi.created).toBe(true)
    expect(prvi.reissued).toBe(true)
    const klicevPrvi = klici.length
    expect(klicevPrvi).toBe(3)

    klici = []
    const drugi = ensureLocalTls(opts)
    expect(drugi.ok).toBe(true)
    expect(drugi.created).toBe(false)
    expect(drugi.reissued).toBe(false)
    expect(klici).toEqual([])

    klici = []
    const novaIp: Identity = { dnsNames: ['restaurantos.local', 'localhost'], ips: ['127.0.0.1', '192.168.1.77'] }
    const tretji = ensureLocalTls({ ...opts, identity: novaIp })
    expect(tretji.ok).toBe(true)
    expect(tretji.created).toBe(false)
    expect(tretji.reissued).toBe(true)
    expect(klici.map((a) => a[0])).toEqual(['req', 'x509'])
  })
})

describe.skipIf(!HAS_OPENSSL)('B. živi OpenSSL', () => {
  it('B6: izdana veriga velja in jo Node spreje; z napačnim sidrom pade', async () => {
    const d = tempDir()
    const res = ensureLocalTls({ dataDir: d, identity: ID, nowMs: Date.now() })
    expect(res.ok).toBe(true)
    const ca = readFileSync(res.paths.caCert, 'utf8')
    const key = readFileSync(res.paths.leafKey, 'utf8')
    const cert = readFileSync(res.paths.leafCert, 'utf8')

    const v = spawnSync('openssl', ['verify', '-CAfile', res.paths.caCert, res.paths.leafCert], { encoding: 'utf8' })
    expect(v.status).toBe(0)
    expect(v.stdout).toContain('OK')

    const streznik = createServer({ key, cert }, (_req, rsp) => rsp.end('ok'))
    await new Promise<void>((r) => streznik.listen(0, '127.0.0.1', r))
    const port = (streznik.address() as { port: number }).port

    const good = await handshake(port, ca, 'localhost')
    expect(good.authorized).toBe(true)
    expect(good.error).toBeUndefined()
    expect(good.peerSubjectAltName || '').toContain('IP Address:127.0.0.1')

    const bad = await handshake(port, cert, 'localhost')
    expect(bad.authorized).toBe(false)
    expect(bad.error).toInclude('unable to verify')

    await new Promise<void>((r) => streznik.close(() => r()))
  })
})

function handshake(port: number, ca: string, servername: string): Promise<{ authorized: boolean; error?: string; peerSubjectAltName?: string }> {
  return new Promise((resolve) => {
    const c = tls.connect({ port, host: '127.0.0.1', ca: [ca], servername }, () => {
      // Izmerjeno 24. 10. 2026 pod Bun 1.4.3: ob uspehu je `authorizationError` === null (Node ima undefined),
      // SAN je pod ključem `subjectaltname` z malimi tiskanimi črkami (Node: `subjectAltName`).
      const peer = c.getPeerCertificate() as Record<string, string | undefined>
      resolve({
        authorized: c.authorized,
        error: c.authorizationError ?? undefined,
        peerSubjectAltName: peer.subjectAltName ?? peer.subjectaltname,
      })
      c.destroy()
    })
    c.on('error', (e) => resolve({ authorized: false, error: e.message }))
    c.setTimeout(8000, () => {
      c.destroy()
      resolve({ authorized: false, error: 'timeout' })
    })
  })
}
