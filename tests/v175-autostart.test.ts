/**
 * v1.175.0 — R2b2: samodejni zagon lokalnega profila ob prijavi.
 *
 * Testi so namenoma čisti (brez registriranja opravil v sistemu): modul samo
 * ZGENERIRA artefakt in zaporedje ukazov, izvajalec pa ukaze požene šele, ko dobi
 * `--install`. Tako je celotna oblika dokazljiva brez spremembe sistema.
 *
 * Odločitve, zapisane tu, ker jih je mogoče obrniti brez testa:
 *  - osnova sta surova zaporedja argv, nikoli `cmd /c "..."` ali `sh -c "..."` —
 *    pot do repozitorija je lahko uporabniška in z njo polna posebnih znakov;
 *  - artefakt mora vsebovati znak lastništva, preden se sploh kaj zapiše: tuj
 *    plist, unit ali XML je lahko uporabnikov in ga ne smeva prepisati;
 *  - izhod je determinističen (brez časovnih žigov), sicer `--install` pri
 *     vsakem zagonu pokaže drugačen prst datoteke in ga ni mogoče primerjati;
 *  - suhi tek je privzet, ker zagon ob prijavi spremeni sistem tudi, ko proces
 *    davno konča — lastnik mora najprej videti, kaj bo napisano.
 */
import { describe, expect, it } from 'bun:test'
import {
  AUTOSTART_MARKER,
  AUTOSTART_TASK,
  applyAutostart,
  applyUninstall,
  buildAutostartPlan,
  decodeArtifact,
  encodeArtifact,
  izvedljivUkaz,
  jeNasArtefakt,
  type AutostartInput,
} from '../src/lib/local-autostart'

const OSNOVNO: AutostartInput = {
  platform: 'win32',
  homeDir: 'C:/Users/robert',
  dataDir: 'C:/Users/robert/.restaurantos',
  cwd: 'C:/Users/robert/repos/ros',
  command: 'C:/Program Files/bun/bun.exe',
  args: ['scripts/local-start.ts', '--https'],
  uid: 1000,
}

const LINUX: AutostartInput = {
  ...OSNOVNO,
  platform: 'linux',
  homeDir: '/home/robert',
  cwd: '/home/robert/repos/ros',
  command: '/usr/local/bin/bun',
}

function lazniSistem(zacetneDatoteke: Array<[string, string]> = []) {
  const datoteke = new Map<string, string>(zacetneDatoteke)
  const klici: string[][] = []
  return {
    datoteke,
    klici,
    opts: {
      run: (argv: string[]) => {
        klici.push(argv)
        return { status: 0, stdout: '', stderr: '' }
      },
      readFile: (p: string) => datoteke.get(p),
      writeFile: (p: string, vsebina: string) => {
        datoteke.set(p, vsebina)
      },
      exists: (p: string) => datoteke.has(p),
    },
  }
}

describe('A. nacrt', () => {
  it('A1: Windows načrt ima opravilo s stikalom ob prijavi in potjo do zagona', () => {
    const p = buildAutostartPlan(OSNOVNO)
    expect(p.platform).toBe('win32')
    expect(p.taskName).toBe(AUTOSTART_TASK)
    expect(p.artifactPath).toEndWith('.xml')
    expect(p.artifactContent).toContain('<LogonTrigger>')
    expect(p.artifactContent).toContain(`<Command>${OSNOVNO.command}</Command>`)
    expect(p.artifactContent).toContain('<WorkingDirectory>')
    expect(p.artifactContent).toContain('scripts/local-start.ts')
    expect(p.artifactContent).toContain('--https')
    expect(p.artifactContent).toContain(AUTOSTART_MARKER)
    expect(p.installArgv[0]).toEqual(['schtasks', '/Create', '/TN', AUTOSTART_TASK, '/XML', p.artifactPath, '/F'])
    expect(p.uninstallArgv[0]).toEqual(['schtasks', '/Delete', '/TN', AUTOSTART_TASK, '/F'])
    // Merjeno s `schtasks /Query /XML` na treh dejansko nameščenih avtozagonskih
    // opravilih (OneDrive Startup, Opera GX Autoupdate, Hermes_Gateway): vsako
    // ima v principalu InteractiveToken — brez njega proces ne bi dobil
    // uporabnikove seje in brskalnik na tablici ne bi dosegel frontskega vrat.
    expect(p.artifactContent).toContain('<LogonType>InteractiveToken</LogonType>')
  })

  it('A2: Windows opravilo je vklopljeno, si opomore po napaki in nima časovne omejitve', () => {
    const p = buildAutostartPlan(OSNOVNO)
    expect(p.artifactContent).toContain('<RestartOnFailure>')
    expect(p.artifactContent).toContain('<Interval>PT1M</Interval>')
    expect(p.artifactContent).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    // Izmerjeno s `schtasks /Query /XML` na tej napravi: onemogočeno opravilo
    // (.NET NGEN v4.0.30319 Critical) se serializira kot <Enabled>false</Enabled>.
    // Element <Disabled> v izvozu 1.2/1.6 sploh ne nastopi, zato stanje trdimo
    // prek Enabled in ne prek <Disabled>.
    expect(p.artifactContent).toContain('<Enabled>true</Enabled>')
    expect(p.artifactContent).not.toContain('<Enabled>false</Enabled>')
    // Trgovska točka stoji na bateriji: vsa tri merjena opravila imajo
    // DisallowStartIfOnBatteries=false, sicer se ob izklopu napajanja ne bi zgnala.
    expect(p.artifactContent).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(p.artifactContent).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  })

  it('A3: macOS plit je LaunchAgent z RunAtLoad in brez KeepAlive', () => {
    const p = buildAutostartPlan({ ...OSNOVNO, platform: 'darwin' })
    expect(p.artifactPath).toBe('C:/Users/robert/Library/LaunchAgents/com.restaurantos.local.plist')
    expect(p.artifactContent).toContain('<key>RunAtLoad</key>')
    expect(p.artifactContent).toContain('<key>KeepAlive</key>')
    expect(p.artifactContent).toContain('<false/>')
    expect(p.artifactContent).toContain(AUTOSTART_MARKER)
    expect(p.installArgv.map((a) => a[0])).toEqual(['launchctl', 'launchctl'])
    expect(p.installArgv[0].join(' ')).toContain('bootstrap')
    expect(p.uninstallArgv[0].join(' ')).toContain('bootout')
  })

  it('A4: Linux unit se zagne po omrežju in se znova ob napaki', () => {
    const p = buildAutostartPlan(LINUX)
    expect(p.artifactPath).toBe('/home/robert/.config/systemd/user/restaurantos-local.service')
    expect(p.artifactContent).toContain('[Unit]')
    expect(p.artifactContent).toContain('After=network-online.target')
    expect(p.artifactContent).toContain('ExecStart=/usr/local/bin/bun scripts/local-start.ts --https')
    expect(p.artifactContent).toContain('WorkingDirectory=/home/robert/repos/ros')
    expect(p.artifactContent).toContain('Restart=on-failure')
    expect(p.artifactContent).toContain('WantedBy=default.target')
    expect(p.artifactContent).toContain(AUTOSTART_MARKER)
    expect(p.installArgv).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'restaurantos-local.service'],
    ])
    expect(p.uninstallArgv).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'restaurantos-local.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ])
  })

  it('A5: izhod je determinističen — enak vhod vedno da enak artefakt', () => {
    const a = buildAutostartPlan(OSNOVNO)
    const b = buildAutostartPlan({ ...OSNOVNO })
    expect(a.artifactContent).toBe(b.artifactContent)
    expect(a.artifactContent).not.toMatch(/20\d\d-\d\d-\d\d/)
  })

  it('A6: pot s presledki in oklepaji ostane en element argv, ne spojena ukazna lupina', () => {
    const p = buildAutostartPlan({ ...LINUX, command: '/opt/a b (x)/bun' })
    const splosci = p.installArgv.flat()
    expect(splosci.some((a) => a.startsWith('sh ') || a.includes(' && '))).toBe(false)
    expect(p.artifactContent).toContain('ExecStart="/opt/a b (x)/bun" scripts/local-start.ts --https')
  })

  it('A7: poseben znak v poti (&, <) je v XML-u ubežen, ne lasti si strukture', () => {
    const p = buildAutostartPlan({ ...OSNOVNO, cwd: 'C:/Users/a&b/x<y' })
    expect(p.artifactContent).toContain('C:/Users/a&amp;b/x&lt;y')
    expect(p.artifactContent).not.toContain('<x<y')
  })

  it('A8: neznani sistem javi jasno napako in ne generira polovične oblike', () => {
    expect(() => buildAutostartPlan({ ...OSNOVNO, platform: 'freebsd' })).toThrow(/win32|darwin|linux/)
  })

  it('A9: Windows ima preverbo obstoja, ki samo bere; macOS in Linux je nimata', () => {
    const p = buildAutostartPlan(OSNOVNO)
    expect(p.probeArgv).toEqual(['schtasks', '/Query', '/TN', AUTOSTART_TASK])
    // Merjeno na tej napravi (\Hermes_Gateway = izstop 0, ROS-PR0BE-NEOBSTOJA-175
    // = izstop 1): stanje opravila prepoznamo po IZSTOPNI KODI, nikoli po besedilu
    // napake — `schtasks` na drugo jezično nastavljenem Windowsu izpiše prevedeno
    // besedilo, na kar se ne sme opirati nobena odločitev.
    expect(p.probeArgv).not.toContain('/Delete')
    expect(buildAutostartPlan({ ...OSNOVNO, platform: 'darwin' }).probeArgv).toBeNull()
    expect(buildAutostartPlan(LINUX).probeArgv).toBeNull()
  })
})

describe('B. izvajalec', () => {
  it('B1: suhi tek ne zapiše artefakta in ne zažene nobenega ukaza', () => {
    const sistem = lazniSistem()
    const plan = buildAutostartPlan(OSNOVNO)
    const res = applyAutostart({ plan, ...sistem.opts, dryRun: true })
    expect(res.ok).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.artifactWritten).toBe(false)
    expect(sistem.klici).toEqual([])
    expect(sistem.datoteke.size).toBe(0)
    expect(res.message).toContain(plan.artifactPath)
  })

  it('B2: pravi tek zapiše artefakt in izvede zaporedje v navedenem vrstnem redu', () => {
    const sistem = lazniSistem()
    const plan = buildAutostartPlan(LINUX)
    const res = applyAutostart({ plan, ...sistem.opts, dryRun: false })
    expect(res.ok).toBe(true)
    expect(res.artifactWritten).toBe(true)
    expect(sistem.datoteke.get(plan.artifactPath)).toBe(plan.artifactContent)
    expect(sistem.klici).toEqual(plan.installArgv)
  })

  it('B3: tujega artefakta ne prepiše in ne zažene nobenega ukaza', () => {
    const plan = buildAutostartPlan(OSNOVNO)
    const sistem = lazniSistem([[plan.artifactPath, '<ent>ne moj izvoz</ent>']])
    const res = applyAutostart({ plan, ...sistem.opts, dryRun: false })
    expect(res.ok).toBe(false)
    expect(res.step).toBe('artefakt')
    expect(res.artifactWritten).toBe(false)
    expect(sistem.datoteke.get(plan.artifactPath)).toBe('<ent>ne moj izvoz</ent>')
    expect(sistem.klici).toEqual([])
    expect(res.message).toContain(plan.artifactPath)
  })

  it('B4: lasten artefakt z enako vsebino se ne piše znova, ukazi pa se izvedejo', () => {
    const plan = buildAutostartPlan(OSNOVNO)
    const sistem = lazniSistem([[plan.artifactPath, plan.artifactContent]])
    const res = applyAutostart({ plan, ...sistem.opts, dryRun: false })
    expect(res.ok).toBe(true)
    expect(res.artifactWritten).toBe(false)
    expect(sistem.klici).toEqual(plan.installArgv)
  })

  it('B5: padel ukaz javi korak in stderr, artefakt ostane za ročni pregled', () => {
    const plan = buildAutostartPlan(LINUX)
    const klici: string[][] = []
    const datoteke = new Map<string, string>()
    // Pade PRVI ukaz, ne zadnji: tako test razlikuje "ustavi" od "grei naprej".
    // Ob padlem zadnjem ukazu bi bil seznam klicev enak ne glede na to, ali
    // zanka nadaljuje — to sem imel v prvi različici in je bil napačno zelen.
    const gresni = plan.installArgv[0]
    expect(plan.installArgv.length).toBeGreaterThan(1)
    const res = applyAutostart({
      plan,
      dryRun: false,
      run: (argv) => {
        klici.push(argv)
        if (argv === gresni) return { status: 1, stdout: '', stderr: 'Unit file not found' }
        return { status: 0, stdout: '', stderr: '' }
      },
      readFile: (p) => datoteke.get(p),
      writeFile: (p, v) => void datoteke.set(p, v),
      exists: (p) => datoteke.has(p),
    })
    expect(res.ok).toBe(false)
    expect(res.step).toBe('systemctl')
    expect(res.message).toContain('Unit file not found')
    expect(klici).toEqual([gresni])
    expect(res.message).toContain(plan.uninstallArgv[0].join(' '))
    expect(datoteke.get(plan.artifactPath)).toBe(plan.artifactContent)
  })

  it('B6: brez podanega dryRun je privzet suhi tek — klic po nesreči ne spremeni sistema', () => {
    const sistem = lazniSistem()
    const plan = buildAutostartPlan(LINUX)
    const res = applyAutostart({ plan, ...sistem.opts })
    expect(res.dryRun).toBe(true)
    expect(sistem.klici).toEqual([])
    expect(sistem.datoteke.size).toBe(0)
    expect(res.message).toContain(plan.artifactPath)
  })

  it('B7: jeNasArtefakt prepozna samo najino predlogo, ne katerekoli datoteke', () => {
    expect(jeNasArtefakt(buildAutostartPlan(OSNOVNO).artifactContent)).toBe(true)
    expect(jeNasArtefakt(buildAutostartPlan({ ...OSNOVNO, platform: 'darwin' }).artifactContent)).toBe(true)
    expect(jeNasArtefakt('<plist><dict/></plist>')).toBe(false)
    expect(jeNasArtefakt('')).toBe(false)
    expect(jeNasArtefakt(`opomba: ${AUTOSTART_MARKER}`)).toBe(true)
  })
})

const USPEH = () => ({ status: 0, stdout: '', stderr: '' })

function izved(lazni: (argv: string[]) => { status: number; stdout: string; stderr: string } = USPEH) {
  const klici: string[][] = []
  return {
    klici,
    run: (argv: string[]) => {
      klici.push(argv)
      return lazni(argv)
    },
  }
}

describe('C. razveljavitev', () => {
  it('C1: suhi tek razveljavitve ne zažene nobenega ukaza, a pove točno, kaj bi šlo', () => {
    const plan = buildAutostartPlan(OSNOVNO)
    const { klici, run } = izved()
    const res = applyUninstall({ plan, run })
    expect(res.ok).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.niBiloNameščeno).toBe(false)
    expect(klici).toEqual([])
    expect(res.message).toContain(izvedljivUkaz(plan.uninstallArgv[0]))
    expect(res.message).toContain(plan.artifactPath)
  })

  it('C2: če preverba javi, da opravila ni, se izbris ne izvede in rezultat ni napaka', () => {
    const plan = buildAutostartPlan(OSNOVNO)
    const preizkus = plan.probeArgv!.join(' ')
    const { klici, run } = izved((argv) =>
      argv.join(' ') === preizkus ? { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } : USPEH(),
    )
    const res = applyUninstall({ plan, dryRun: false, run })
    expect(res.ok).toBe(true)
    expect(res.niBiloNameščeno).toBe(true)
    // /Delete se ne sme zgoditi: drugačni izkazi bi bili na slepo brisanje.
    expect(klici).toEqual([plan.probeArgv!])
    // Zaključek mora biti preverljiv — sporočilo zato ponuka ukaz, ki ga je
    // lastnik lahko požene sam, in ne samo trditve «ni nameščeno».
    expect(res.message).toContain(izvedljivUkaz(plan.probeArgv!))
  })

  it('C3: nameščeno opravilo se zbriše za preverbo, artefakt pa ostane na disku', () => {
    const plan = buildAutostartPlan(OSNOVNO)
    const { klici, run } = izved()
    const res = applyUninstall({ plan, dryRun: false, run })
    expect(res.ok).toBe(true)
    expect(res.niBiloNameščeno).toBe(false)
    expect(klici).toEqual([plan.probeArgv!, ...plan.uninstallArgv])
    // Datoteke NI brisati: je vhod za `schtasks /Create` in edini zapis o tem,
    // kaj je bilo sploh nameščeno.
    expect(res.message).toContain(plan.artifactPath)
  })

  it('C4: kjer preizkusa ni (macOS, Linux), zaporedje teče neposredno', () => {
    const plan = buildAutostartPlan(LINUX)
    const { klici, run } = izved()
    const res = applyUninstall({ plan, dryRun: false, run })
    expect(klici).toEqual(plan.uninstallArgv)
    expect(res.ok).toBe(true)
  })

  it('C5: padel ukaz javi korak in izvor napake, ne «uspešno odstranjeno»', () => {
    const plan = buildAutostartPlan(LINUX)
    const { klici, run } = izved(() => ({ status: 1, stdout: '', stderr: 'Unit restaurantos-local.service not loaded.' }))
    const res = applyUninstall({ plan, dryRun: false, run })
    expect(res.ok).toBe(false)
    expect(res.niBiloNameščeno).toBe(false)
    expect(res.step).toBe('systemctl')
    expect(res.message).toContain('Unit restaurantos-local.service not loaded.')
    expect(res.message).not.toMatch(/odstranjen/)
    expect(klici).toEqual([plan.uninstallArgv[0]])
  })
})

describe('D. kodiranje artefakta', () => {
  it('D1: Windows artefakt se zapiše kot UTF-16, ker prolog UTF-16 napoveduje', () => {
    const p = buildAutostartPlan(OSNOVNO)
    // Izmerjeno: `schtasks /Query /XML` na tej napravi izpiše UTF-16 LE z BOM-om.
    // Predloga, ki si na prvem vrstici obljublja UTF-16, mora biti tudi zapisana
    // kot UTF-16 — sicer `/Create` dobi bajte, ki ne sovpadajo z deklaracijo.
    expect(p.artifactContent).toMatch(/encoding="UTF-16"/)
    expect(p.artifactEncoding).toBe('utf16le')
    const b = encodeArtifact(p.artifactContent, p.artifactEncoding)
    expect(b[0]).toBe(0xff)
    expect(b[1]).toBe(0xfe)
  })

  it('D2: plist in systemd unit ostaneta UTF-8 brez BOM-a', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const p = buildAutostartPlan({ ...OSNOVNO, platform })
      expect(p.artifactEncoding).toBe('utf8')
      expect(encodeArtifact(p.artifactContent, p.artifactEncoding).toString('utf8')).toBe(p.artifactContent)
    }
  })

  it('D3: lastno datoteko preberemo nazaj identično, sicer --install vidi sebe kot tujko', () => {
    const p = buildAutostartPlan(OSNOVNO)
    const nazaj = decodeArtifact(encodeArtifact(p.artifactContent, p.artifactEncoding))
    expect(nazaj).toBe(p.artifactContent)
    expect(jeNasArtefakt(nazaj)).toBe(true)
    // BOM ne sme preživeti branja: z njim se lastna vsebina ne bi ujemala z
    // generirano, vsak `--install` bi datoteko pisal znova in — huje — lastnik
    // bi bil po `readFile` videti kot tuj artefakt, ki se ga ne sme prepisati.
    expect(decodeArtifact(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x', 'utf8')]))).toBe('x')
    expect(decodeArtifact(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x', 'utf16le')]))).toBe('x')
    expect(decodeArtifact(Buffer.from('úradni', 'utf8'))).toBe('úradni')
  })
})

describe('E. izpis, ki mu lastnik verjame', () => {
  it('E1: izpisan ukaz je pripravljen za lepljenje — element s presledkom je naveden', () => {
    expect(izvedljivUkaz(['schtasks', '/Create', '/TN', 'RestaurantOS Local', '/F'])).toBe(
      'schtasks /Create /TN "RestaurantOS Local" /F',
    )
    expect(izvedljivUkaz(['a', 'b"c'])).toBe('a "b\\"c"')
    expect(izvedljivUkaz(['brez', 'presledka'])).toBe('brez presledka')
  })

  it('E2: Windows pot do artefakta ima samo Windows ločila, ne mešanice', () => {
    const p = buildAutostartPlan(OSNOVNO)
    // Merjeno: suhi tek je izpisal `C:\Users\...\RestaurantOS/autostart/...` —
    // Windows to sprejme, a lastnik kopira pot iz izpisa in mešanica izgleda kot
    // pokvarjena datoteka, ne kot veljavna pot.
    expect(p.artifactPath).toBe('C:\\Users\\robert\\.restaurantos\\autostart\\RestaurantOS Local.xml')
    expect(p.artifactPath).not.toContain('/')
    expect(buildAutostartPlan(LINUX).artifactPath).toBe('/home/robert/.config/systemd/user/restaurantos-local.service')
  })

  it('E3: suhi tek napiše ukaz, ki ga lastnik lahko prilepi takoj', () => {
    const sistem = lazniSistem()
    const plan = buildAutostartPlan(OSNOVNO)
    const res = applyAutostart({ plan, ...sistem.opts, dryRun: true })
    expect(res.message).toContain(`/TN "${AUTOSTART_TASK}"`)
    expect(res.message).toContain(`/XML "${plan.artifactPath}"`)
    const u = applyUninstall({ plan, dryRun: true, run: () => USPEH() })
    expect(u.message).toContain(`/TN "${AUTOSTART_TASK}"`)
  })
})
