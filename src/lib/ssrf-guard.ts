/**
 * Issue #30 (P0) — POPOLNA SSRF zaščita strežniških odhodnih klicev na
 * uporabniško nastavljive cilje (Integration.baseUrl, SMS webhook url).
 *
 * Predhodno stanje (potrjena vrzel): test integracije je URL validiral SAMO
 * po nizu hostname (isPrivateHost) — brez razreševanja DNS (domena, ki se
 * razreši na interni naslov, in DNS rebinding nista bila pokrita), brez
 * normalizacije oglatih oklepajev IPv6, z `redirect: 'follow'` (cilj preusmeritve
 * bi lahko prejel credential glave) in z neizčrpnim seznamom rezerviranih naslovov.
 *
 * Zasnovano po OWASP SSRF Prevention Cheat Sheet:
 *  1. URL politika: shema https (http IZKLJUČNO izven produkcije — dokumentirana
 *     izjema za izolirana/dev okolja), brez userinfo, dovoljeni porti 80/443/8443;
 *  2. IP politika: izčrpen IPv4 (loopback, RFC1918, CGNAT, link-local+metadata,
 *     multicast, reserved, TEST-NET, broadcast …) in IPv6 (loopback, unspecified,
 *     ULA, link-local, multicast, documentation, discard, IPv4-mapped, NAT64) —
 *     WHATWG URL parser že normalizira oddoblike IPv4 (2130706433→127.0.0.1) in
 *     stisne vgrajeni IPv4 v hex (::ffff:a00:1), zato parser razširi NAZAJ;
 *  3. DNS politika: VSI A/AAAA rezultati se validirajo (mešani zapisi → zavrnitev,
 *     fail-closed); povezava se VZEZE na preverjeni IP (substitucija IP v URL +
 *     izvirni Host/SNI) — med preverbo in povezavo NI druge razrešitve → DNS
 *     rebinding/TOCTOU ni mogoč;
 *  4. Preusmeritve: NIKOLI se ne sledi (3xx je rezultat, ki ga uporabnik pregleda;
 *     Location se poroča, credential glave se ne prenesejo nikamor naprej);
 *  5. Credential politika (issue §B): apiKey/apiSecret na testni klic se pošljejo
 *     SAMO ob izrecnem opt-in (config.sendCredentialsOnTest === true) IN samo na
 *     https cilj — glej credentialHeadersFor() v integrations/[id]/test ruti.
 *
 * Egress na ravni infrastrukture (issue §A zadnja točka): na Vercelu funkcija
 * teče v izoliranem omrežju brez dostopa do internih storitev naročnika —
 * ta plast ostaja odgovornost platforme; koda zagotavlja plast aplikacije.
 */
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import type { LookupAddress } from 'node:dns'

/* ────────────────────── IPv4 ────────────────────── */

/** Special-purpose/rezervirana IPv4 območja (IANA + OWASP SSRF cheat sheet). */
export function isBlockedIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return true // nedotted oblike po WHATWG normalizaciji ne smejo priti do sem
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return true
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback (celoten /8)
  if (a === 169 && b === 254) return true // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // 192.0.0.0/24 (IETF) + 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark 198.18/15
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224 && a <= 239) return true // multicast
  if (a >= 240) return true // reserved + broadcast 255.255.255.255
  return false
}

/* ────────────────────── IPv6 ────────────────────── */

/**
 * Razširi IPv6 literal v 8 16-bit skupin; obvlada '::' kompresijo (ena), hex
 * vgrajeni IPv4 rep (::ffff:a00:1 — WHATWG stisne dotted obliko) in dotted rep,
 * če prispe iz surovega niza (DNS odgovori nimajo oklepajev). Napačna oblika →
 * null (klicatelj zavre — fail-closed).
 */
export function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase().trim()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const zone = h.indexOf('%')
  if (zone >= 0) h = h.slice(0, zone) // zone-id (%eth0)
  if (!h.includes(':')) return null

  const toGroups = (section: string): number[] | null => {
    const parts = section === '' ? [] : section.split(':')
    const out: number[] = []
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i]
      // dotted IPv4 rep sme biti SAMO zadnja skupina
      if (p.includes('.')) {
        if (i !== parts.length - 1) return null
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(p)
        if (!m) return null
        const [a, b, c, d] = m.slice(1).map(Number)
        if ([a, b, c, d].some((n) => n > 255)) return null
        out.push((a << 8) | b, (c << 8) | d)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null
        out.push(parseInt(p, 16))
      }
    }
    return out
  }

  const sections = h.split('::')
  if (sections.length > 2) return null // '::' se sme pojaviti največ enkrat
  let groups: number[]
  if (sections.length === 2) {
    const head = toGroups(sections[0])
    const tail = toGroups(sections[1])
    if (!head || !tail) return null
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill(0), ...tail]
  } else {
    const full = toGroups(h)
    if (!full || full.length !== 8) return null
    groups = full
  }
  return groups.length === 8 ? groups : null
}

function ipFromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/** Special-purpose IPv6 območja + vgrajeni IPv4 (mapped/NAT64). */
export function isBlockedIpv6(host: string): boolean {
  const g = expandIpv6(host)
  if (!g) return true // nerazširljiv literal = zavrnemo (fail-closed)
  const [g0, g1, , , , g5, g6, g7] = g
  if (g.every((x) => x === 0)) return true // :: unspecified
  if (g0 === 0 && g1 === 0 && g6 === 0 && g7 === 1 && g.slice(2, 6).every((x) => x === 0)) return true // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA (fc/fd — prej nizu 'fc'/'fd' prefix)
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32 documentation
  if (g0 === 0x0100 && g1 === 0 && g6 === 0 && g7 === 0 && g.slice(2, 6).every((x) => x === 0)) return true // 100::/64 discard-only
  // IPv4-mapped ::ffff:0:0/96 → vgrajeni IPv4 je pravi cilj
  if (g0 === 0 && g1 === 0 && g.slice(2, 5).every((x) => x === 0) && g5 === 0xffff) {
    return isBlockedIpv4(ipFromGroups(g6, g7))
  }
  // NAT64 64:ff9b::/96 → vgrajeni IPv4 (javni ostane dovoljen, zasebni blokiran)
  if (g0 === 0x64 && g1 === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIpv4(ipFromGroups(g6, g7))
  }
  return false
}

/* ────────────────────── hostname/IP dispatch ────────────────────── */

const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.corp', '.lan', '.intranet', '.localdomain']

/**
 * Ali je hostname blokiran (ime ali IP literal). WHATWG URL parser že
 * normalizira: oddoblike IPv4 → dotted (2130706433→127.0.0.1), IPv6 → oglati
 * oklepaji + stisnjen hex vgrajeni IPv6 (::ffff:a00:1). DNS odgovori prispejo
 * brez oklepajev. Oboje pokrito.
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (h === 'localhost' || h === 'broadcasthost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true
  if (LOCAL_NAME_SUFFIXES.some((s) => h.endsWith(s))) return true
  if (h.startsWith('[') || h.includes(':')) return isBlockedIpv6(h)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isBlockedIpv4(h)
  if (/^\d+$/.test(h)) return true // go številski hostname (URL ga ionako normalizira v IPv4)
  return false
}

/* ────────────────────── URL politika ────────────────────── */

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

/** Dovoljeni porti (javni spletni API-ji; internih storitev ne preizkušamo). */
export const ALLOWED_PORTS = new Set([80, 443, 8443])

export interface UrlPolicyOpts {
  /** TEST-ONLY: preskoči preverbo zasebnih naslovov (rute NIKOLI ne podajo). */
  allowPrivate?: boolean
}

export function validateTargetUrl(raw: string, opts: UrlPolicyOpts = {}): UrlValidation {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'BaseUrl ni veljaven URL — najprej uredite povezavo.' }
  }
  // shema: https vedno; http IZKLJUČNO izven produkcije (izolirana/dev/test okolja)
  const allowHttp = process.env.NODE_ENV !== 'production' || process.env.SSRF_ALLOW_HTTP === 'true'
  if (url.protocol === 'http:') {
    if (!allowHttp) return { ok: false, reason: 'V produkciji je dovoljen samo https naslov.' }
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Podprta sta le http in https.' }
  }
  if (url.username || url.password) return { ok: false, reason: 'URL ne sme vsebovati uporabniških podatkov (userinfo).' }
  if (!opts.allowPrivate && isBlockedHostname(url.hostname)) {
    return { ok: false, reason: 'Testiranje zasebnih/lokalnih naslovov ni dovoljeno.' }
  }
  if (url.port) {
    const p = Number(url.port)
    if (!ALLOWED_PORTS.has(p)) return { ok: false, reason: `Port ${url.port} ni dovoljen (dovoljeni: 80, 443, 8443).` }
  }
  return { ok: true, url }
}

/* ────────────────────── DNS validacija ────────────────────── */

export type DnsResolver = (hostname: string) => Promise<LookupAddress[]>

const defaultResolver: DnsResolver = (hostname) =>
  dns.promises.lookup(hostname, { family: 0, all: true, verbatim: false })

/**
 * Validiraj VSE naslove, na katere se gostitelj razreši. Vsak zasebni/rezerviran
 * A/AAAA naslov → zavrnitev (fail-closed, ne "izberi javnega"): domena z mešanimi
 * zapisi ali preusmerjajoč DNS se NE sme uporabiti.
 */
export async function resolveValidatedAddresses(
  hostname: string,
  opts: { resolver?: DnsResolver; allowPrivate?: boolean } = {},
): Promise<LookupAddress[]> {
  const stripped = hostname.replace(/^\[|\]$/g, '')
  const resolve = opts.resolver ?? defaultResolver
  const all = await resolve(stripped)
  if (!all || all.length === 0) throw new Error('dns_empty')
  if (!opts.allowPrivate) {
    for (const a of all) {
      if (isBlockedHostname(a.address)) throw new Error('dns_blocked_address')
    }
  }
  return all
}

/* ────────────────────── varni transport ────────────────────── */

export interface SsrfRequestInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** TEST-ONLY: dovoli zasebne cilje (lokalni testni strežnik; rute NIKOLI ne podajo) */
  _testAllowPrivate?: boolean
}

export interface SsrfResponse {
  /** HTTP status; 0 = omrežna/validacijska napaka */
  status: number
  /** 2xx */
  ok: boolean
  durationMs: number
  /** varna kategorija napake (logi/odgovori BREZ surovih sporočil z URL-ji) */
  errorCategory: '' | 'invalid' | 'dns' | 'timeout' | 'refused' | 'tls' | 'network'
  /** Location glava pri 3xx (NE sledimo — samo poročamo) */
  location?: string | null
}

/**
 * Strežniški klic na uporabniško nastavljen cilj z DNS pinningom:
 *  1. URL validacija (shema/userinfo/hostname/port — razlog v SsrfResponse.invalid);
 *  2. IP literali → neposredna preverba; imena → resolveValidatedAddresses
 *     (vsak naslov validiran; pinned = PRVI preverjeni naslov);
 *  3. povezava se vzpostavi NA preverjeni IP (substitucija v URL; izvirno ime
 *     ostane v Host glavi + TLS SNI `servername`) — povezovalna plast NE razrešuje
 *     DNS znova → rebinding med preverbo in povezavo ni možen;
 *  4. preusmeritve se NE sledijo (3xx = rezultat; Location se poroča);
 *  5. telo odgovora se NE prebere (porabi omejen del in uniči).
 */
export async function ssrfSafeRequest(rawUrl: string, init: SsrfRequestInit): Promise<SsrfResponse> {
  const started = Date.now()
  const v = validateTargetUrl(rawUrl, { allowPrivate: init._testAllowPrivate === true })
  if (!v.ok) return { status: 0, ok: false, durationMs: 0, errorCategory: 'invalid' }
  const url = v.url
  const bareHost = url.hostname.replace(/^\[|\]$/g, '')
  const isIpLiteral = bareHost.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost)
  let pinned: string
  try {
    if (isIpLiteral) {
      pinned = bareHost
    } else {
      const all = await resolveValidatedAddresses(url.hostname, { allowPrivate: init._testAllowPrivate === true })
      pinned = all[0].address
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg === 'dns_blocked_address') {
      return { status: 0, ok: false, durationMs: Date.now() - started, errorCategory: 'invalid' }
    }
    return { status: 0, ok: false, durationMs: Date.now() - started, errorCategory: 'dns' }
  }

  // substitucija: poveži se NA preverjeni IP; Host glava + SNI ohranita izvirno ime
  const hostHeader = url.port ? `${bareHost}:${url.port}` : bareHost
  const isV6 = pinned.includes(':')
  const connectUrl = new URL(url.toString())
  connectUrl.hostname = isV6 ? `[${pinned}]` : pinned
  const transport = connectUrl.protocol === 'https:' ? https : http

  return await new Promise<SsrfResponse>((resolve) => {
    const headers: Record<string, string> = { ...init.headers, host: hostHeader }
    const req = transport.request(connectUrl, {
      method: init.method || 'GET',
      headers,
      ...(connectUrl.protocol === 'https:' ? { servername: bareHost } : {}),
    })
    let settled = false
    const finish = (r: SsrfResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(r)
    }
    const timeout = setTimeout(() => {
      req.destroy(new Error('timeout'))
      finish({ status: 0, ok: false, durationMs: Date.now() - started, errorCategory: 'timeout' })
    }, init.timeoutMs ?? 5000)
    req.on('response', (res) => {
      const status = res.statusCode || 0
      const location = status >= 300 && status < 400 ? res.headers.location || null : null
      // telo NE prebiramo — porabi omejen del in uniči (dovolj je status+location)
      let seen = 0
      res.on('data', (chunk: Buffer) => {
        seen += chunk.length
        if (seen > 65536) res.destroy()
      })
      const done = () => finish({ status, ok: status >= 200 && status < 300, durationMs: Date.now() - started, errorCategory: '', location })
      res.on('end', done)
      res.on('close', done)
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = String(err.code || err.message || '')
      let cat: SsrfResponse['errorCategory'] = 'network'
      if (code === 'timeout' || code === 'ETIMEDOUT') cat = 'timeout'
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') cat = 'dns'
      else if (code === 'ECONNREFUSED') cat = 'refused'
      else if (code.includes('certificate') || code.includes('TLS') || code.includes('ERR_TLS')) cat = 'tls'
      finish({ status: 0, ok: false, durationMs: Date.now() - started, errorCategory: cat })
    })
    if (init.body != null) req.write(init.body)
    req.end()
  })
}

/** Varna kategorija napake → prijazno SL besedilo (logi/odgovori BREZ surovih URL-jev). */
export function ssrfErrorText(cat: SsrfResponse['errorCategory']): string {
  switch (cat) {
    case 'invalid': return 'Cilj je zavrnjen (varnostna politika).'
    case 'dns': return 'Domena ni dosegljiva (DNS).'
    case 'timeout': return 'Odgovor je potekel (timeout).'
    case 'refused': return 'Povezava je zavrnjena.'
    case 'tls': return 'Varnostna povezava ni uspela (TLS).'
    case 'network': return 'Omrežna napaka.'
    default: return ''
  }
}
