/**
 * v1.175.0 — R2b2: vpenjanje HTTPS fronte in samodejnega zagona v lokalni profil.
 *
 * Tu so samo ČISTE odločitve, ki ju `scripts/local-start.ts` in
 * `scripts/local-autostart.ts` nato izvedeta. Obe skripte imata stranske učinke
 * (vžig vrat, pisanje po disku), zato jima test ne more zaupati — zaupati lahko
 * samo funkcijam, ki so dokumentirane tu in testirane spodaj.
 *
 * Odločitve, zapisane tu, ker jih je mogoče obrniti brez testa:
 *  - ko je HTTPS vklopljen, Next posluša SAMO na 127.0.0.1: sicer v LAN ostane
 *    goli HTTP tik ob obljubljenem HTTPS, naslov, ki obljublja zaklenjeno sejo,
 *    pa zanj ni nobena garancija;
 *  - javna shema je https in javna vrata so vrata fronte — izpis za tablico
 *    mora vsebovati naslov, ki mu bo dejansko lahko sledila;
 *  - certifikat mora imeti LAN IPv4 v SAN, ker tablica ne tipka `localhost`.
 */
import { describe, expect, it } from 'bun:test'
import { lanIpv4, lanUrls, servingPlan } from '../src/lib/local-runtime'
import { identityFromNetwork } from '../src/lib/local-tls'
import { AUTOSTART_USAGE, autostartInput, parseAutostartArgs } from '../src/lib/local-autostart'
import type { NetworkInterfaceLike } from '../src/lib/local-runtime'

const IFACE: Record<string, NetworkInterfaceLike[] | undefined> = {
  'Wi-Fi': [
    { address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: 'fe80::1122:3344:5566:7788%12', family: 'IPv6', internal: false },
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
}

describe('S. strežni načrt', () => {
  it('S1: brez HTTPS je javni vnos goli HTTP na 0.0.0.0', () => {
    const p = servingPlan({ port: 3000, https: false })
    expect(p.nextHost).toBe('0.0.0.0')
    expect(p.scheme).toBe('http')
    expect(p.publicPort).toBe(3000)
    expect(p.frontPort).toBe(0)
  })

  it('S2: ko je HTTPS vklopljen, je Next zaprt na zanko, javni vnos pa je front', () => {
    const p = servingPlan({ port: 3000, https: true })
    expect(p.nextHost).toBe('127.0.0.1')
    expect(p.frontPort).toBe(3443)
    expect(p.scheme).toBe('https')
    expect(p.publicPort).toBe(3443)
  })

  it('S3: izrecna HTTPS vrata upoštevajo, privzeta pa ostanejo rezervna', () => {
    expect(servingPlan({ port: 3000, https: true, httpsPort: 8443 }).frontPort).toBe(8443)
    expect(servingPlan({ port: 3000, https: false, httpsPort: 8443 }).frontPort).toBe(0)
  })

  it('S4: javni URL je sestavljen iz dejanskih javnih vrat in sheme', () => {
    const p = servingPlan({ port: 3000, https: true })
    expect(lanUrls(p.publicPort, IFACE, p.scheme)).toEqual(['https://192.168.1.20:3443'])
    expect(lanUrls(3000, IFACE)).toEqual(['http://192.168.1.20:3000'])
  })

  it('S5: LAN IPv4 za certifikat izpusti zanko in IPv6, a obdrži 127.0.0.1', () => {
    const id = identityFromNetwork({ hostname: 'POS-ROBERT', interfaces: IFACE })
    // točen seznam DNS imen je stvar local-tls (tam živi tudi restaurantos.local);
    // tu se sme trditi samo, kaj iz omrežja prenese v identiteto.
    expect(id.ips).toEqual(['127.0.0.1', '192.168.1.20'])
    expect(id.dnsNames[0]).toBe('localhost')
    expect(id.dnsNames).toContain('POS-ROBERT')
    expect(id.ips.every((i) => /^\d+\.\d+\.\d+\.\d+$/.test(i))).toBe(true)
  })
})

describe('N. avtozagon iz okolja', () => {
  it('N1: brez zastavice je privzet suhi tek; --install je edini, ki zapiše', () => {
    expect(parseAutostartArgs([])).toEqual({ install: false, uninstall: false, help: false, dataDir: undefined })
    expect(parseAutostartArgs(['--install']).install).toBe(true)
    expect(parseAutostartArgs(['--uninstall']).uninstall).toBe(true)
    expect(parseAutostartArgs(['-h']).help).toBe(true)
    expect(() => parseAutostartArgs(['--install', '--uninstall'])).toThrow(/izključujeta/)
  })

  it('N2: neznana zastavica javi uporabo in ne tiho ignorira', () => {
    expect(() => parseAutostartArgs(['--instal'])).toThrow(/Uporaba/)
    expect(() => parseAutostartArgs(['--data-dir'])).toThrow(/zahteva vrednost/)
    expect(AUTOSTART_USAGE).toContain('--install')
    expect(AUTOSTART_USAGE).toContain('--data-dir')
  })

  it('N3: vneseni ukaz vsebuje --https, sicer se ob zagonu prikaže samo goli HTTP', () => {
    const i = autostartInput({
      platform: 'win32',
      homeDir: 'C:/Users/robert',
      dataDir: 'C:/Users/robert/.restaurantos',
      root: 'C:/Users/robert/repos/ros',
      bunPath: 'C:/Program Files/bun/bun.exe',
    })
    expect(i.command).toBe('C:/Program Files/bun/bun.exe')
    expect(i.args).toEqual(['scripts/local-start.ts', '--https'])
    expect(i.cwd).toBe('C:/Users/robert/repos/ros')
    expect(i.dataDir).toBe('C:/Users/robert/.restaurantos')
    expect(i.platform).toBe('win32')
  })

  it('N4: napačna platforma javi jasno napako, ne tiho generira Windows datoteke', () => {
    expect(() =>
      autostartInput({
        platform: 'sunos',
        homeDir: '/home/robert',
        dataDir: '/home/robert/.restaurantos',
        root: '/home/robert/repos/ros',
        bunPath: '/usr/bin/bun',
      }),
    ).toThrow(/nepodprt sistem/)
  })
})
