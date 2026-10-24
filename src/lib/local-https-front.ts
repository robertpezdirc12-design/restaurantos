/**
 * v1.175.0 — R2b2: HTTPS front pred lokalnim `next start`.
 *
 * Front je namenoma tanek: TLS prekine na njem, vse ostalo gre surovo naprej.
 * Posreduje glave (razen hop-by-hop), telo in tok brez bufferiranja. Zahteve za
 * nadgradnjo (WebSocket, HMR) se ne preoblikujejo: zahtevna glava se zapiše v
 * goli TCP soket in naprej grejo samo še bajti, ker brskalnikova odzivna
 * glava 101 v nekaterih izvajalcih ne razkrije glav.
 * Ob nedosegljivem viru front javi 502 in proces ostane živ — sicer bi ena
 * sama zaprta povezava pomenila črn zaslon, ki ga zagon ob prijavi (drugi del
 * R2b2) ne more več odpreti.
 */
import { type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TlsOptions } from 'node:tls'

export interface HttpsFrontHandle {
  port: number
  close: () => Promise<void>
}

export interface HttpsFrontOptions {
  keyPem: string
  certPem: string
  targetPort: number
  httpsPort: number
  host?: string
  tlsOptions?: TlsOptions
}

/** Glave, ki veljajo samo za povezavo brskalnik↔front; naprej se ne smejo. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function glaveZaVir(req: IncomingMessage, hraniUpgrade: boolean, odveteniPort: number): Record<string, string | string[]> {
  const izhod: Record<string, string | string[]> = {}
  for (const [ime, vrednost] of Object.entries(req.headers)) {
    if (vrednost === undefined) continue
    if (hraniUpgrade || !HOP_BY_HOP.has(ime.toLowerCase())) izhod[ime] = vrednost
  }
  izhod['x-forwarded-proto'] = 'https'
  if (req.headers.host) {
    izhod['x-forwarded-host'] = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  }
  izhod['x-forwarded-port'] = String(odveteniPort)
  return izhod
}

function posreduj(req: IncomingMessage, res: ServerResponse, targetPort: number, odveteniPort: number) {
  const vir = httpRequest(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: glaveZaVir(req, false, odveteniPort), agent: false },
    (virRes) => {
      res.writeHead(virRes.statusCode ?? 502, virRes.headers)
      virRes.pipe(res)
      virRes.on('error', () => res.destroy())
    },
  )
  vir.on('error', (e) => {
    if (res.headersSent || res.writableEnded) {
      res.destroy()
      return
    }
    res.statusCode = 502
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('connection', 'close')
    res.end(`[localni profil] Aplikacijski strežnik na strani ${targetPort} ni dosegljiv (${(e as NodeJS.ErrnoException).code ?? e.message}). Počakaj, da se zagne, ali zaženi znova.\n`)
  })
  req.pipe(vir)
  req.on('error', () => vir.destroy())
}

function serijaGlave(req: IncomingMessage, odveteniPort: number): string {
  const vrstice = [`${req.method} ${req.url} HTTP/1.1`]
  for (const [ime, vrednost] of Object.entries(glaveZaVir(req, true, odveteniPort))) {
    for (const v of Array.isArray(vrednost) ? vrednost : [vrednost]) vrstice.push(`${ime}: ${v}`)
  }
  return `${vrstice.join('\r\n')}\r\n\r\n`
}

function posredujUpgrade(
  req: IncomingMessage,
  tok: Duplex,
  glava: Buffer,
  targetPort: number,
  odveteniPort: number,
  odprti: Set<Duplex>,
) {
  const vir = connect({ host: '127.0.0.1', port: targetPort })
  odprti.add(tok)
  tok.on('close', () => {
    odprti.delete(tok)
    vir.destroy()
  })
  // Zaprtje se po pipe() prenese samo: virjev FIN konča `vir.pipe(tok)` in s tem
  // zapre brskalnikovo povezavo (izmerjeno na obeh izvajalcih, brez ročnih
  // `end`/`close` handlerjev). Error handlerja pa morata biti: Node 24 brez
  // poslušalca na `vir` javi nelovljen izjemo `read ECONNRESET` (izmerjeno z
  // sondo, kjer je soket na drugi strani poslal RST), Bun pa ob istem razmeru dogodek
  // `error` kar požre — zato ga testna vrsta ne more dokazati.
  vir.on('error', () => tok.destroy())
  tok.on('error', () => vir.destroy())
  vir.on('connect', () => {
    vir.write(serijaGlave(req, odveteniPort))
    if (glava.length > 0) vir.write(glava)
    tok.pipe(vir)
    vir.pipe(tok)
  })
}

export async function startLocalHttpsFront(o: HttpsFrontOptions): Promise<HttpsFrontHandle> {
  const odprti = new Set<Duplex>()
  let odveteniPort = o.httpsPort

  const front = createHttpsServer({ key: o.keyPem, cert: o.certPem, ...(o.tlsOptions ?? {}) }, (req, res) => {
    posreduj(req, res, o.targetPort, odveteniPort)
  })
  front.on('upgrade', (req, tok, glava) => {
    posredujUpgrade(req, tok as unknown as Duplex, glava, o.targetPort, odveteniPort, odprti)
  })

  await new Promise<void>((r) => front.listen(o.httpsPort, o.host ?? '0.0.0.0', r))
  odveteniPort = (front.address() as AddressInfo).port

  return {
    port: odveteniPort,
    close: () =>
      new Promise<void>((resolve) => {
        // Izmerjeno (Bun 1.4.3 in Node 24.22): close() se vrže tudi ob prostem
        // keep-alive soketu, zato closeAllConnections() ni potreben.
        front.close(() => resolve())
        for (const tok of odprti) tok.destroy()
      }),
  }
}
