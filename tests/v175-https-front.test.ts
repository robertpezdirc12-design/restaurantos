/**
 * v1.175.0 — R2b2: HTTPS front pred lokalnim Next strežnikom.
 *
 * Zakaj front in ne TLS v Next-u: `next start` posluša SAMO HTTP (izmerjeno v
 * lokalnem profilu v1.165.0+ — `localEnv()` nastavi HOSTNAME 0.0.0.0 brez
 * certifikatov), lastnoročno prerocanje pa je edini način, da ostane celotna
 * aplikacijska plast nespremenjena. Front je namenoma tanek: prenese glave,
 * telo in `upgrade`, ničesar ne bufferira in ničesar ne prevaja.
 *
 * Odločitve, zapisane tu, ker jih je mogoče obrniti brez testa:
 *  - BREZ `strict-transport-security`: na IP-naslovu v LAN ga brskalniki tako
 *    ali tako ne upoštevajo (HSTS velja samo za imena z javnim certifikatom),
 *    na `localhost` pa bi operaterju trajno blokiral obstoječi http:// zalog;
 *  - ob nedosegljivem izvoru JE napaka 502 z besedilom v slovenščini in proces
 *    NE sme umreti — sicer samodejni zagon ob prijavi (R2b2 drugi del) pomeni
 *    en sam klik in zaprt zaslon;
 *  - `x-forwarded-proto` je nastavljen na https, ker aplikacija sicer misli, da
 *    je oblečena v HTTP, in zavrne varne piškotke;
 *  - nadgradje (HMR, WebSocket) se NE preoblikujejo: izmerjeno je, da Bun ob
 *    odzivu 101 klientu pokaže prazne `headers`, zato front piše surove bajte
 *    in odgovor vrne nespremenjen (F9);
 *  - `error` na soketu: Bun ga ob RST požre, Node 24 pa brez poslušalca pusti
 *    neujeto izjemo `read ECONNRESET` in proces umre (izmerjeno s sondo
 *    probe175rst, 1 neujeta izjema brez handlerja / 0 z handlerjem). Testna
 *    vrsta tega ne more dokazati, ker je Bun izvajalec testov.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { spawnSync } from 'node:child_process'
import { ensureLocalTls } from '../src/lib/local-tls'
import { startLocalHttpsFront, type HttpsFrontHandle } from '../src/lib/local-https-front'

const HAS_OPENSSL = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

let ca = ''
let keyPem = ''
let certPem = ''
let targetPort = 0
let streznik: Server
let front: HttpsFrontHandle
let rok: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end('osnovni handler')
const zapeti: Array<Record<string, unknown>> = []

function poizvedba(
  sc: { port: number; ca?: string },
  pot: string,
  opcije: { method?: string; telo?: string; glave?: Record<string, string> } = {},
): Promise<{ status: number; glave: Record<string, string | string[] | undefined>; telo: string }> {
  return new Promise((resolve, reject) => {
    const { telo, glave, ...ostalo } = opcije
    const r = https.request(
      { host: '127.0.0.1', port: sc.port, path: pot, ca: sc.ca ? [sc.ca] : undefined, headers: glave, ...ostalo },
      (res) => {
        const kosi: Buffer[] = []
        res.on('data', (k) => kosi.push(k))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, glave: res.headers as Record<string, string | string[] | undefined>, telo: Buffer.concat(kosi).toString('utf8') }),
        )
      },
    )
    r.on('error', reject)
    if (opcije.telo) r.write(opcije.telo)
    r.end()
  })
}

beforeAll(async () => {
  const d = mkdtempSync(join(tmpdir(), 'ros-v175-front-'))
  const res = ensureLocalTls({ dataDir: d, identity: { dnsNames: ['localhost'], ips: ['127.0.0.1'] }, nowMs: Date.now() })
  expect(res.ok).toBe(true)
  ca = readFileSync(res.paths.caCert, 'utf8')
  keyPem = readFileSync(res.paths.leafKey, 'utf8')
  certPem = readFileSync(res.paths.leafCert, 'utf8')

  streznik = createServer((req, rsp) => {
    zapeti.push({ pot: req.url, method: req.method, glave: req.headers })
    rok(req, rsp)
  })
  await new Promise<void>((r) => streznik.listen(0, '127.0.0.1', r))
  targetPort = (streznik.address() as net.AddressInfo).port
  front = await startLocalHttpsFront({ keyPem, certPem, targetPort, httpsPort: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await front?.close()
  streznik?.close()
})

describe.skipIf(!HAS_OPENSSL)('F. front', () => {
  it('F1: prijavljen je vera razporejen port in HTTPS odziv steče skozenj', async () => {
    expect(front.port).toBeGreaterThan(0)
    const r = await poizvedba({ port: front.port, ca }, '/api/zivi')
    expect(r.status).toBe(200)
    expect(r.telo).toBe('osnovni handler')
  })

  it('F2: metoda in pot ostaneta nespremenjena', async () => {
    await poizvedba({ port: front.port, ca }, '/api/reports?od=2026-10-01', { method: 'DELETE' })
    const zadnji = zapeti[zapeti.length - 1] as { pot: string; method: string }
    expect(zadnji.method).toBe('DELETE')
    expect(zadnji.pot).toBe('/api/reports?od=2026-10-01')
  })

  it('F3: telo POST zahteve pride do vira byte-enako', async () => {
    const plašč = JSON.stringify({ vrsta: 'racun', znesek: 13.37, opomba: 'čšž šumnik' })
    rok = (_req, res) => {
      const kosi: Buffer[] = []
      _req.on('data', (k) => kosi.push(k))
      _req.on('end', () => res.end(Buffer.concat(kosi).toString('utf8')))
    }
    const r = await poizvedba({ port: front.port, ca }, '/api/posli', { method: 'POST', telo: plašč, glave: { 'content-type': 'application/json' } })
    expect(r.telo).toBe(plašč)
    rok = (_req, res) => res.end('osnovni handler')
  })

  it('F4: piškotek se posreduje, sicer prijava v aplikaciji izgine', async () => {
    await poizvedba({ port: front.port, ca }, '/api/auth/session', { glave: { cookie: 'ros_seja=test' } })
    const glave = (zapeti[zapeti.length - 1] as { glave: Record<string, string> }).glave
    expect(glave.cookie).toBe('ros_seja=test')
  })

  it('F5: vir je obveščen, da je seja prišla čez HTTPS', async () => {
    await poizvedba({ port: front.port, ca }, '/api/auth/locations')
    const glave = (zapeti[zapeti.length - 1] as { glave: Record<string, string> }).glave
    expect(glave['x-forwarded-proto']).toBe('https')
    expect(String(glave.host)).toContain(String(front.port))
  })

  it('F6: SSE tok pride kos po kosu, ne šele ob zadnjem', async () => {
    const prihod: number[] = []
    rok = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: ena\n\n')
      setTimeout(() => res.write('data: dva\n\n'), 400)
      setTimeout(() => res.end(), 800)
    }
    const telo = await new Promise<string>((resolve, reject) => {
      const q = https.request({ host: '127.0.0.1', port: front.port, path: '/api/tok', ca: [ca] }, (res) => {
        const kosi: Buffer[] = []
        res.on('data', (k) => {
          prihod.push(Date.now())
          kosi.push(k as Buffer)
        })
        res.on('end', () => resolve(Buffer.concat(kosi).toString('utf8')))
      })
      q.on('error', reject)
      q.end()
    })
    expect(telo).toBe('data: ena\n\ndata: dva\n\n')
    expect(prihod.length).toBe(2)
    expect(prihod[1] - prihod[0]).toBeGreaterThanOrEqual(250)
    rok = (_req, res) => res.end('osnovni handler')
  })

  it('F7: HSTS ni nastavljen — na localhostu bi trajno blokiral obstoječi http://', async () => {
    rok = (_req, res) => {
      res.setHeader('x-prejeti', 'da')
      res.end('v redu')
    }
    const r = await poizvedba({ port: front.port, ca }, '/api/hsts')
    expect(r.glave['strict-transport-security']).toBeUndefined()
    expect(r.glave['x-prejeti']).toBe('da')
    rok = (_req, res) => res.end('osnovni handler')
  })

  it('F8: ob nedosegljivem viru je 502 z besedilom in proces ne umre', async () => {
    const mrtev = await startLocalHttpsFront({ keyPem, certPem, targetPort: 1, httpsPort: 0, host: '127.0.0.1' })
    let r: { status: number; telo: string }
    try {
      r = await poizvedba({ port: mrtev.port, ca }, '/api/kje-si')
    } finally {
      await mrtev.close()
    }
    expect(r!.status).toBe(502)
    expect(r!.telo).toInclude('ni dosegljiv')
    const ancora = await poizvedba({ port: front.port, ca }, '/api/se-zivi')
    expect(ancora.status).toBe(200)
  })

  it('F9: upgrade zahteve gre surovo naprej (HMR in WebSocket)', async () => {
    let odprt = 0
    streznik.removeAllListeners('upgrade')
    streznik.on('upgrade', (_req, socket, head) => {
      odprt++
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n')
      // Bajti takoj za glavami pridejo do vira kot `head`, ne kot `data` dogodek,
      // zato jih mora lažni vir vrniti ročno — sicer se prenos ne bi nic dokazal.
      if (head.length > 0) socket.write(head)
      socket.on('data', (k) => socket.write(k))
      socket.on('error', () => socket.destroy())
    })
    // Front streži TLS, zato mora biti nadgradnja poslana po šifriranem soketu (wss), ne po golem TCP.
    const odgovor = await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ port: front.port, host: '127.0.0.1', ca: [ca], servername: 'localhost' }, () => {
        // Prve bajte takoj za glavami razčlenjevalnik postavi v `head`, ne v
        // `data`. Realni WebSocket odjemalec tako pošlje prvi okvir brez
        // čakanja na 101 — če front teh bajtov ne prenese, se seja ustavi.
        s.write(
          `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${front.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\ntakoj`,
        )
      })
      const kosi: Buffer[] = []
      let poslan = false
      s.on('data', (k) => {
        kosi.push(k)
        const tekst = Buffer.concat(kosi).toString('latin1')
        if (!poslan && tekst.includes('101 Switching Protocols')) {
          poslan = true
          s.write('zdravo')
        }
        if (poslan && tekst.includes('zdravo')) {
          s.destroy()
          resolve(tekst)
        }
      })
      s.on('error', reject)
      s.setTimeout(9000, () => {
        s.destroy()
        reject(new Error('upgrade timeout'))
      })
    })
    expect(odgovor).toContain('101 Switching Protocols')
    expect(odgovor).toContain('Sec-WebSocket-Accept: test')
    expect(odgovor).toContain('takoj')
    expect(odgovor.endsWith('zdravo')).toBe(true)
    expect(odprt).toBe(1)
  })

  it('F10: dve sočasni zahtevi se ne zmešata', async () => {
    rok = (req, res) => setTimeout(() => res.end(String(req.url)), Number(req.url === '/a' ? 120 : 10))
    const [ena, dva] = await Promise.all([poizvedba({ port: front.port, ca }, '/a'), poizvedba({ port: front.port, ca }, '/b')])
    expect(ena.telo).toBe('/a')
    expect(dva.telo).toBe('/b')
    rok = (_req, res) => res.end('osnovni handler')
  })

  it('F11: hop-by-hop glave in pooblastila posrednika ne grejo naprej', async () => {
    await poizvedba(
      { port: front.port, ca },
      '/api/ni-posredovano',
      { glave: { connection: 'keep-alive', te: 'trailers', 'proxy-authorization': 'geslo-brskalnika' } },
    )
    const glave = (zapeti[zapeti.length - 1] as { glave: Record<string, string> }).glave
    expect(glave['proxy-authorization']).toBeUndefined()
    expect(glave.te).toBeUndefined()
    // Frontov lastni odjemalec lahko nastavi svoj `connection`, nikoli pa ne sme
    // prenesti vrednosti brskalnika — sicer bi `keep-alive` iz LAN zahteve silil
    // trajno odprto povezavo do `next start`.
    expect(String(glave.connection ?? '')).not.toContain('keep-alive')
  })

  it('F12: vir je obveščen o pravih razmerah (razporejen port in gostiteljska glava)', async () => {
    await poizvedba({ port: front.port, ca }, '/api/razmere')
    const glave = (zapeti[zapeti.length - 1] as { glave: Record<string, string> }).glave
    expect(glave['x-forwarded-port']).toBe(String(front.port))
    expect(glave['x-forwarded-host']).toBe(`127.0.0.1:${front.port}`)
  })

  it('F13: zaprtje fronta zapre tudi odprto nadgradjo pri viru', async () => {
    let prejeta = false
    let zaprta = false
    streznik.removeAllListeners('upgrade')
    streznik.on('upgrade', (_req, socket) => {
      prejeta = true
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('end', () => (zaprta = true))
      socket.on('close', () => (zaprta = true))
      socket.on('error', () => socket.destroy())
    })
    const h = await startLocalHttpsFront({ keyPem, certPem, targetPort, httpsPort: 0, host: '127.0.0.1' })
    const odtec = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ port: h.port, host: '127.0.0.1', ca: [ca], servername: 'localhost' }, () => {
        s.write(
          `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
        resolve(s)
      })
      s.on('error', reject)
    })
    for (let i = 0; i < 40 && !prejeta; i++) await new Promise((r) => setTimeout(r, 25))
    expect(prejeta).toBe(true)
    // Izmerjeno: dokler je front živ, vir ne vidi FIN-a; `zaprta` sme zatem
    // postati resnična šele ob klicu close().
    expect(zaprta).toBe(false)
    await h.close()
    for (let i = 0; i < 40 && !zaprta; i++) await new Promise((r) => setTimeout(r, 25))
    expect(zaprta).toBe(true)
    odtec.destroy()
    streznik.removeAllListeners('upgrade')
  })

  it('F14: ko vir zapre nadgradjo, jo zapre tudi front do brskalnika', async () => {
    let prejeta = false
    streznik.removeAllListeners('upgrade')
    streznik.on('upgrade', (_req, socket) => {
      prejeta = true
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      // Navidezni `next start` umre takoj po rokobanju (znova zagon, zaustavitev).
      setTimeout(() => socket.destroy(), 40)
    })
    const h = await startLocalHttpsFront({ keyPem, certPem, targetPort, httpsPort: 0, host: '127.0.0.1' })
    const stanje = await new Promise<'zaprt' | 'odprta'>((resolve) => {
      const s = tls.connect({ port: h.port, host: '127.0.0.1', ca: [ca], servername: 'localhost' }, () => {
        s.write(
          `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      let končano = false
      const končaj = () => {
        if (končano) return
        končano = true
        s.destroy()
        resolve('zaprt')
      }
      s.on('data', () => {})
      // Izmerjeno: brez porabnika podatkov Bun soketa drži v paused stanju in
      // FIN od sogovornika ne sproži `end`/`close`, čeprav je povezava mrtva.
      s.on('close', končaj)
      s.on('end', končaj)
      s.on('error', () => {})
      setTimeout(() => {
        if (končano) return
        končano = true
        s.destroy()
        resolve('odprta')
      }, 3000)
    })
    expect(prejeta).toBe(true)
    expect(stanje).toBe('zaprt')
    await h.close()
    streznik.removeAllListeners('upgrade')
  })

  it('F15: ko brskalnik zapre nadgradjo, front zapre tudi povezavo do vira', async () => {
    let prejeta = false
    let končanaPriViru = false
    streznik.removeAllListeners('upgrade')
    streznik.on('upgrade', (_req, socket) => {
      prejeta = true
      socket.on('data', () => {})
      socket.on('close', () => (končanaPriViru = true))
      socket.on('end', () => (končanaPriViru = true))
      socket.on('error', () => (končanaPriViru = true))
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    const h = await startLocalHttpsFront({ keyPem, certPem, targetPort, httpsPort: 0, host: '127.0.0.1' })
    const odtec = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ port: h.port, host: '127.0.0.1', ca: [ca], servername: 'localhost' }, () => {
        s.write(
          `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
        resolve(s)
      })
      s.on('error', reject)
    })
    for (let i = 0; i < 40 && !prejeta; i++) await new Promise((r) => setTimeout(r, 25))
    expect(prejeta).toBe(true)
    expect(končanaPriViru).toBe(false)
    // Tablica zapre zavihek: brskalnikovo povezavo uniči klient, čisti povezava
    // do `next start` pa mora slediti — sicer vir drži mrtvo HMR sejo.
    odtec.destroy()
    for (let i = 0; i < 40 && !končanaPriViru; i++) await new Promise((r) => setTimeout(r, 25))
    expect(končanaPriViru).toBe(true)
    await h.close()
    streznik.removeAllListeners('upgrade')
  })
})
