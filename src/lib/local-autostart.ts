/**
 * v1.175.0 — R2b2: samodejni zagon lokalnega profila ob prijavi.
 *
 * Modul samo GENERIRA artefakt operacijskega sistema in zaporedje ukazov; ukaze
 * zažene šele klicatelj z `dryRun: false`. Zagon ob prijavi je edina R2b2
 * sprememba, ki ostane v sistemu, ko proces davno konča, zato je suhi tek
 * privzet in tujega artefekta nikoli ne prepišemo.
 *
 * Omejitve, ki jih testi ne morejo dokazati (zapisane, ne zamaskirane):
 *  - Windows XML je sestavljen iz imenovanih elementov, kot jih je na tej
 *    napravi izpisal `schtasks /Query /XML` (merjeno: vključeno stanje =
 *    `Enabled`, `InteractiveToken` v principalu, `PT0S` za brez omejitve).
 *    Vrstnega reda elementov v `Settings` izvoz ne spoštuje, zato ga ne trdimo
 *    kot zahtevo; `schtasks /Create` na pravem računalniku še ni bil
 *    pognan — to stori prvi `--install`;
 *  - `launchctl` in `systemctl` sta povzeta po njihovih uradnih CLI oblikah;
 *    izvajalec ustavi ob prvem padlem ukazu in javi korak, zato napačna
 *    predpostavka pomeni glasno napako in ne delno nameščenega sistema.
 */
import nodePath from 'node:path'

export type PodprtiSistem = 'win32' | 'darwin' | 'linux'

/**
 * Kodiranje artefakta se ne izbere lepo — izbere se po tem, kar uvozni program
 * operacijskega sistema dejansko prebere. `schtasks /Create /XML` na tej napravi
 * sprejme izvoz, ki ga je dal `/Query /XML`; to je UTF-16 LE z BOM-om. Plist in
 * systemd unit sta UTF-8.
 */
export type ArtifactEncoding = 'utf16le' | 'utf8'

export const AUTOSTART_TASK = 'RestaurantOS Local'
export const AUTOSTART_LABEL = 'com.restaurantos.local'
export const AUTOSTART_UNIT = 'restaurantos-local.service'
export const AUTOSTART_MARKER = 'RestaurantOS lokalni profil - samodejni zagon ob prijavi'

export interface AutostartInput {
  platform: string
  homeDir: string
  dataDir: string
  cwd: string
  command: string
  args: string[]
  uid?: number
}

export interface AutostartPlan {
  platform: PodprtiSistem
  taskName: string
  artifactPath: string
  artifactContent: string
  artifactEncoding: ArtifactEncoding
  installArgv: string[][]
  uninstallArgv: string[][]
  /**
   * Preverba obstoja, ki samo bere — sistema ne spremeni. Nosi jo samo sistem,
   * kjer je izstopna koda IZMERJENA; odločitev nikoli ne sloni na besedilu
   * napake, ki je na drugo jezično nastavljenem sistemu prevedeno.
   */
  probeArgv: string[] | null
}

export interface ApplyAutostartOptions {
  plan: AutostartPlan
  dryRun?: boolean
  run: (argv: string[]) => { status: number; stdout: string; stderr: string }
  readFile: (p: string) => string | undefined
  writeFile: (p: string, vsebina: string) => void
  exists: (p: string) => boolean
}

export interface ApplyAutostartResult {
  ok: boolean
  dryRun: boolean
  artifactWritten: boolean
  step?: string
  message: string
}

function ubeziXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function navediArg(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}

/**
 * argv za človeka. Izpis, ki ga lastnik prilepi v lupino, mora veljati takoj:
 * `schtasks /TN RestaurantOS Local` brez narekovajev sta dva argumenta in pade.
 * Sam argv je ves čas pravilen — napaka je lahko samo v prikazu.
 */
export function izvedljivUkaz(argv: string[]): string {
  return argv.map(navediArg).join(' ')
}

/** Systemd ExecStart si sposodi navajanje: presleki zahtevajo narekovaje. */
function execStart(i: AutostartInput): string {
  return izvedljivUkaz([i.command, ...i.args])
}

function windowsXml(i: AutostartInput): string {
  const pripona = izvedljivUkaz(i.args)
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<!-- ${AUTOSTART_MARKER} -->`,
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${ubeziXml(AUTOSTART_MARKER)}</Description>`,
    '  </RegistrationInfo>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '      <LogonType>InteractiveToken</LogonType>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <RestartOnFailure>',
    '      <Count>3</Count>',
    '      <Interval>PT1M</Interval>',
    '    </RestartOnFailure>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '  </Settings>',
    '  <Triggers>',
    // Vsa tri na tej napravi izmerjena samodejna opravila imajo v LogonTrigger
    // element Delay; izvoza brez otrok na tej napravi ni, zato oblike brez njega
    // ne tvegamo. Noben izvoz v triggerju ne nosi Enabled — izpust pomeni
    // "vklopljen".
    '    <LogonTrigger>',
    '      <Delay>PT30S</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${ubeziXml(i.command)}</Command>`,
    `      <Arguments>${ubeziXml(pripona)}</Arguments>`,
    `      <WorkingDirectory>${ubeziXml(i.cwd)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n')
}

function macosPlist(i: AutostartInput): string {
  const program = [i.command, ...i.args].map((v) => `      <string>${ubeziXml(v)}</string>`).join('\n')
  const log = `${i.dataDir}/logs`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${AUTOSTART_MARKER} -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${AUTOSTART_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    program,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${ubeziXml(i.cwd)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${ubeziXml(`${log}/autostart.log`)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${ubeziXml(`${log}/autostart-greska.log`)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function linuxUnit(i: AutostartInput): string {
  return [
    `# ${AUTOSTART_MARKER}`,
    '[Unit]',
    'Description=RestaurantOS - lokalni profil ob prijavi',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${i.cwd}`,
    `ExecStart=${execStart(i)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function buildAutostartPlan(i: AutostartInput): AutostartPlan {
  const uid = i.uid ?? 0
  if (i.platform === 'win32') {
    // Ločila izbere pot gostitelja: lastnik kopira pot iz suhega teka, mešanica
    // `\` in `/` pa je na Windowsu sicer veljavna, a izgleda kot pokvarjena.
    const artifactPath = nodePath.win32.join(i.dataDir, 'autostart', `${AUTOSTART_TASK}.xml`)
    return {
      platform: 'win32',
      taskName: AUTOSTART_TASK,
      artifactPath,
      artifactContent: windowsXml(i),
      artifactEncoding: 'utf16le',
      installArgv: [['schtasks', '/Create', '/TN', AUTOSTART_TASK, '/XML', artifactPath, '/F']],
      uninstallArgv: [['schtasks', '/Delete', '/TN', AUTOSTART_TASK, '/F']],
      probeArgv: ['schtasks', '/Query', '/TN', AUTOSTART_TASK],
    }
  }
  if (i.platform === 'darwin') {
    const artifactPath = nodePath.posix.join(i.homeDir, 'Library/LaunchAgents', `${AUTOSTART_LABEL}.plist`)
    const cilj = `gui/${uid}/${AUTOSTART_LABEL}`
    return {
      platform: 'darwin',
      taskName: AUTOSTART_LABEL,
      artifactPath,
      artifactContent: macosPlist(i),
      artifactEncoding: 'utf8',
      installArgv: [
        ['launchctl', 'bootstrap', `gui/${uid}`, artifactPath],
        ['launchctl', 'kickstart', '-k', cilj],
      ],
      uninstallArgv: [['launchctl', 'bootout', cilj]],
      probeArgv: null,
    }
  }
  if (i.platform === 'linux') {
    const artifactPath = nodePath.posix.join(i.homeDir, '.config/systemd/user', AUTOSTART_UNIT)
    return {
      platform: 'linux',
      taskName: AUTOSTART_UNIT,
      artifactPath,
      artifactContent: linuxUnit(i),
      artifactEncoding: 'utf8',
      installArgv: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', AUTOSTART_UNIT],
      ],
      uninstallArgv: [
        ['systemctl', '--user', 'disable', '--now', AUTOSTART_UNIT],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      probeArgv: null,
    }
  }
  throw new Error(`[autostart] nepodprt sistem "${i.platform}" — podprti so win32, darwin in linux.`)
}

export function jeNasArtefakt(vsebina: string): boolean {
  return vsebina.includes(AUTOSTART_MARKER)
}

/** BOM vedno zapišemo, kadar ga kodiranje zahteva — `decodeArtifact` se nanj zanaša. */
export function encodeArtifact(content: string, encoding: ArtifactEncoding): Buffer {
  const telo = Buffer.from(content, encoding)
  return encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), telo]) : telo
}

/**
 * Beri tako, kot je bilo zapisano: UTF-16 LE prepozna po BOM-u, vse ostalo je
 * UTF-8. UTF-16 BE z BOM-om `fe ff` tu NI podprt — Node ga ne zna dekodirati,
 * zato se prebere kot nesmisel, `jeNasArtefakt` vrne false in `--install`
 * datoteke ne prepiše. Napaka torej gre v varno smer.
 */
export function decodeArtifact(raw: Buffer): string {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le')
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf8')
  return raw.toString('utf8')
}

export const LOCAL_START_SCRIPT = 'scripts/local-start.ts'

export const AUTOSTART_USAGE = `Uporaba: bun run local:autostart [možnosti]

  (brez možnosti)          Suhi tek — samo pokaže, kaj bi bilo napisano (privzeto)
  --install                Zapiši artefakt in izvedi ukaze za zagon ob prijavi
  --uninstall              Razveljavi zagon ob prijavi (artefakt ostane na disku)
  --data-dir <pot>         Podatkovna mapa (privzeto %LOCALAPPDATA%\\RestaurantOS)
  -h, --help               Ta pomoč

Pravi zagon spremeni sistem: opravilo se ob prijavi zažene samo. Zato najprej
poženi ukaz brez možnosti in preberi, kaj bi se napisalo.
`

export interface AutostartArgs {
  install: boolean
  uninstall: boolean
  help: boolean
  dataDir?: string
}

export function parseAutostartArgs(argv: string[]): AutostartArgs {
  const args: AutostartArgs = { install: false, uninstall: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--install') args.install = true
    else if (a === '--uninstall') args.uninstall = true
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--data-dir') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) throw new Error(`[autostart] Možnost --data-dir zahteva vrednost.\n\n${AUTOSTART_USAGE}`)
      args.dataDir = v
      i++
    } else throw new Error(`[autostart] Neznana možnost: ${a}\n\n${AUTOSTART_USAGE}`)
  }
  if (args.install && args.uninstall) throw new Error(`[autostart] --install in --uninstall se izključujeta.\n\n${AUTOSTART_USAGE}`)
  return args
}

export interface AutostartEnvironment {
  platform: string
  homeDir: string
  dataDir: string
  root: string
  bunPath: string
  uid?: number
  /** Dodatne zastavice, ki jih mora ukaz samodejnega zagona nositi (npr. --data-dir). */
  extraArgs?: string[]
}

/**
 * Kaj samodejni zagon dejansko požene. `--https` je tu z razlogom: brez njega bi
 * se ob ponovnem zagonu računalnika zagnal goli HTTP in acceptance pogoj
 * «PWA ostane dostopna po ponovnem zagonu» ne bi držal.
 */
export function autostartInput(o: AutostartEnvironment): AutostartInput {
  if (o.platform !== 'win32' && o.platform !== 'darwin' && o.platform !== 'linux') {
    throw new Error(`[autostart] nepodprt sistem "${o.platform}" — podprti so win32, darwin in linux.`)
  }
  return {
    platform: o.platform,
    homeDir: o.homeDir,
    dataDir: o.dataDir,
    cwd: o.root,
    command: o.bunPath,
    args: [LOCAL_START_SCRIPT, '--https', ...(o.extraArgs ?? [])],
    uid: o.uid,
  }
}

/**
 * `schtasks /Create` v korenski mapi Načrtovalnika opravil sme pisati samo
 * povišana lupina. Merjeno 24. 10. na tej napravi: `--install` vrne izstop 1 in
 * «ERROR: Access is denied.», enak izstop pa je vrnil tudi poskus s povsem tujim
 * opravilom (`/TN ROSprobe /TR cmd.exe /SC ONLOGON`) — torej je to lastnost
 * sistema in ne napaka v najinem XML-u, ki bi ga bilo treba predelati.
 * Namig je zato vezan samo na `schtasks` in samo na besedilo o dostopu: k
 * katerikoli drugi napaki bi skrbniški nasvet naredil resno sporočilo lažne.
 */
function namigOPravicah(ukaz: string, izpis: string): string {
  if (ukaz !== 'schtasks') return ''
  if (!/access is denied|0x80070005/i.test(izpis)) return ''
  return ' To je Windows omejitev, ne napaka v artefaktu: v korensko mapo Načrtovalnika opravil sme pisati samo skrbniška lupina. Zaženi ukaz zgoraj še enkrat iz lupine «Zaženi kot skrbnik»; datoteka že čaka na spodnji poti, predelati ni treba ničesar.'
}

export function applyAutostart(o: ApplyAutostartOptions): ApplyAutostartResult {
  const dryRun = o.dryRun ?? true
  const path = o.plan.artifactPath
  const razveljavi = o.plan.uninstallArgv.map(izvedljivUkaz).join('  nato  ')
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      artifactWritten: false,
      message: `Suhi tek: ${path} — vsebina je pripravljena. Ukazi pravega zagona: ${o.plan.installArgv.map(izvedljivUkaz).join(' ; ')}. Z --install jih zapišem in izvedem.`,
    }
  }
  const obstoji = o.exists(path)
  if (obstoji && !jeNasArtefakt(o.readFile(path) ?? '')) {
    return {
      ok: false,
      dryRun: false,
      artifactWritten: false,
      step: 'artefakt',
      message: `Datoteka ${path} obstaja in ni narejena po naši predlogi (manjka znak lastništva). Nisem je prepisal in nisem izvedel nobenega ukaza.`,
    }
  }
  const zapisan = !obstoji || o.readFile(path) !== o.plan.artifactContent
  if (zapisan) o.writeFile(path, o.plan.artifactContent)
  for (const argv of o.plan.installArgv) {
    const r = o.run(argv)
    if (r.status !== 0) {
      const izpis = r.stderr.trim() || r.stdout.trim() || 'brez izpisa'
      const namig = namigOPravicah(argv[0], izpis)
      const pika = /\.\s*$/.test(izpis) ? '' : '.'
      return {
        ok: false,
        dryRun: false,
        artifactWritten: zapisan,
        step: argv[0],
        message: `Ukaz "${izvedljivUkaz(argv)}" je padel (izstop ${r.status}): ${izpis}${pika}${namig} Artefakt ostane na ${path}; razveljavitev: ${razveljavi}`,
      }
    }
  }
  return {
    ok: true,
    dryRun: false,
    artifactWritten: zapisan,
    message: `Zagon ob prijavi nastavljen (${o.plan.platform}); artefakt ${zapisan ? 'zapisan' : 'že sovpadal'}: ${path}. Razveljavi z: ${razveljavi}`,
  }
}

export interface ApplyUninstallOptions {
  plan: AutostartPlan
  dryRun?: boolean
  run: (argv: string[]) => { status: number; stdout: string; stderr: string }
}

export interface ApplyUninstallResult {
  ok: boolean
  dryRun: boolean
  /**
   * Razveljavitev ni uspela, ker v sistemu ni bilo kaj razveljaviti. Ločeno polje
   * zato, ker mora skripta to povedati brez alarmantnega izstopa — sicer bi drugi
   * `--uninstall` vrnil izstop 1 in lastnik bi iskal okvaro, ki je ni.
   */
  niBiloNameščeno: boolean
  step?: string
  message: string
}

/**
 * Zrcalo `applyAutostart`: ukazi v zaporedju, ustavitev ob prvem padlem, artefakt
 * pa NAMERNO ostane na disku. Je vhod za `schtasks /Create` in edini zapis o tem,
 * kaj je bilo sploh registrirano; brisanje bi ponovno namestitev vrnilo na
 * generiranje od nič in lastniku vzelo dokaz o stanju.
 */
export function applyUninstall(o: ApplyUninstallOptions): ApplyUninstallResult {
  const dryRun = o.dryRun ?? true
  const zaporedje = o.plan.uninstallArgv.map(izvedljivUkaz).join('  nato  ')
  const artefakt = `artefakt ostane na ${o.plan.artifactPath}`
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      niBiloNameščeno: false,
      message: `Suhi tek: ukazi razveljavitve bi bili ${zaporedje}. ${artefakt}; z --uninstall jih izvedem.`,
    }
  }
  if (o.plan.probeArgv) {
    const preizkus = o.run(o.plan.probeArgv)
    if (preizkus.status !== 0) {
      return {
        ok: true,
        dryRun: false,
        niBiloNameščeno: true,
        message: `Preverba "${izvedljivUkaz(o.plan.probeArgv)}" je vrnila izstop ${preizkus.status}, zato v sistemu ni opravila, ki bi ga bilo kaj brisati. ${artefakt}.`,
      }
    }
  }
  for (const argv of o.plan.uninstallArgv) {
    const r = o.run(argv)
    if (r.status !== 0) {
      const izpis = r.stderr.trim() || r.stdout.trim() || 'brez izpisa'
      return {
        ok: false,
        dryRun: false,
        niBiloNameščeno: false,
        step: argv[0],
        message: `Ukaz "${izvedljivUkaz(argv)}" je padel (izstop ${r.status}): ${izpis}. ${artefakt}; zagon ob prijavi je lahko še vedno registriran — preveri ga z "${izvedljivUkaz(o.plan.probeArgv ?? argv)}".`,
      }
    }
  }
  return {
    ok: true,
    dryRun: false,
    niBiloNameščeno: false,
    message: `Zagon ob prijavi razveljavljen (${o.plan.platform}). ${artefakt}.`,
  }
}
