/**
 * v1.175.0 — R2b2: HTTPS front pred lokalnim `next start`.
 * v1.180.0 — R3: front je edini, ki ve, OD KOD je zahteva prišla. Do te izdaje je
 * aplikacija videla samo `host: 127.0.0.1` (povezuje se na zanko), zato je bil vsak
 * klient v LAN zanjo lokalni. Zdaj front PREPIŠE `x-forwarded-for` z naslovom svojega
 * soketa in prilepi HMAC dokaz (`frontProof`), ki ga klient ne more sestaviti — brez
 * dokaza prevzem namestitve iz brskalnika ni mogoč (`setup-claim.ts`).
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
  /**
   * Vrednost glave `x-local-front` (HMAC iz `APP_SECRET`, `localFrontProof`).
   * Brez nje front ne trdi, da je lokalna — aplikacija takrat prevzem namestitve
   * zavrne, ne pa ga dovoli na pamet.
   */
  frontProof?: string | null
}

/** Minimalna oblika zahteve, ki jo `glaveZaVir` res rabi (preverljivo brez soketa). */
export interface FrontRequestLike {
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string } | null
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

/** `::ffff:10.0.0.9` je dvojni zapis istega naslova; aplikacija naj bere enega. */
function soketovNaslov(remoteAddress: string | undefined): string {
  const raw = String(remoteAddress ?? '').trim()
  if (!raw) return ''
  return raw.toLowerCase().startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw
}

export function glaveZaVir(
  req: FrontRequestLike,
  hraniUpgrade: boolean,
  odveteniPort: number,
  proof: string | null,
): Record<string, string | string[]> {
  const izhod: Record<string, string | string[]> = {}
  for (const [ime, vrednost] of Object.entries(req.headers)) {
    if (vrednost === undefined) continue
    const niz = ime.toLowerCase()
    // Klientova trditev, od kod prihaja, nikoli ne potuje naprej — naslov zna
    // povedati samo soket fronte. Brez naslova glava ostane odsotna in aplikacija
    // to obravnav kot „ne vem", ne kot „verjamem".
    if (niz === 'x-forwarded-for') continue
    if (hraniUpgrade || !HOP_BY_HOP.has(niz)) izhod[ime] = vrednost
  }
  const naslov = soketovNaslov(req.socket?.remoteAddress)
  if (naslov) izhod['x-forwarded-for'] = naslov
  if (proof) izhod['x-local-front'] = proof
  izhod['x-forwarded-proto'] = 'https'
  if (req.headers.host) {
    izhod['x-forwarded-host'] = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  }
  izhod['x-forwarded-port'] = String(odveteniPort)
  return izhod
}

function posreduj(req: IncomingMessage, res: ServerResponse, targetPort: number, odveteniPort: number, proof: string | null) {
  const vir = httpRequest(
    { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: glaveZaVir(req, false, odveteniPort, proof), agent: false },
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

function serijaGlave(req: IncomingMessage, odveteniPort: number, proof: string | null): string {
  const vrstice = [`${req.method} ${req.url} HTTP/1.1`]
  for (const [ime, vrednost] of Object.entries(glaveZaVir(req, true, odveteniPort, proof))) {
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
  proof: string | null,
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
    vir.write(serijaGlave(req, odveteniPort, proof))
    if (glava.length > 0) vir.write(glava)
    tok.pipe(vir)
    vir.pipe(tok)
  })
}

export async function startLocalHttpsFront(o: HttpsFrontOptions): Promise<HttpsFrontHandle> {
  const odprti = new Set<Duplex>()
  let odveteniPort = o.httpsPort
  const proof = o.frontProof ?? null

  const front = createHttpsServer({ key: o.keyPem, cert: o.certPem, ...(o.tlsOptions ?? {}) }, (req, res) => {
    posreduj(req, res, o.targetPort, odveteniPort, proof)
  })
  front.on('upgrade', (req, tok, glava) => {
    posredujUpgrade(req, tok as unknown as Duplex, glava, o.targetPort, odveteniPort, odprti, proof)
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
