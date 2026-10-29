/**
 * v1.184.0 — vrata `typecheck:cloud` morajo produkcijske tipe preverjati z
 * orodjem, ki je v projektu res nameščeno, in ne z izbiro pognalnika.
 *
 * Zakaj sploh predelava — izmerjeno 28. 10. 2026 na tej napravi (node 24.18.0,
 * npm 11.19.1, bun 1.4.3, Windows): `node scripts/typecheck-cloud.cjs` v
 * prejšnji različici ⇒ izhodna koda **1** v 40 268 ms. V treh korakih je izbrala
 * `npx`, ker `npm_config_user_agent` v golem `node` procesu ni nastavljen.
 * `npx prisma` je deloval (paket `prisma` v `node_modules` res obstaja),
 * `npx tsc` pa ne: izpis zadnjega koraka je bil placeholder iz npm predpomnika
 * `_npx/<zgošček>/node_modules/tsc` — „This is not the tsc command you are
 * looking for". Vrata so torej razglasila „RDEČE — produkcijski tipi se ne
 * ujemata" v primeru, kjer **nikdo ni nič tipiziral**: lažna obtožba kode,
 * ravno tista napaka, ki jo je vrata v1.166.0 namenoma preprečila. Na isti
 * napravi je `bun run typecheck:cloud` dala kodo **0**, ker `bun run` nastavi
 * `npm_config_user_agent="bun/…"` in skript izbere `bunx`. Ena koda, dva izida,
 * odvisnost od spremenljivke, ki je obrat ne more vedeti.
 *
 * Novi skript pognalnika več ne povprašuje: obe orodji razreši z
 * `require.resolve` glede na korensko mapo projekta in ju požene z
 * `process.execPath`. Meritev po predelavi: `node scripts/typecheck-cloud.cjs`
 * ⇒ koda **0** v 49 352 ms, tokrat se je `tsc --noEmit` res zavrtel.
 *
 * Obljuba testa: noben primer NE sme zagnati pravih vrat čez prava orodja, ker
 * `prisma generate` prepušči `node_modules/.prisma/client` med Postgresom in
 * SQLitejem — sočasen `bun test` bi dobil lažne padce. Zato (a) grejo klici le
 * preko `pozeniGate`, ki brez varne zastavice javi napako, in (b) skupina F
 * pogne celoten tek čez LAŽNA orodja v začasni mapi: resnične izstopne kode,
 * resničen red korakov, pravi klient pa se ne dotakne.
 */
import { describe, it, expect, afterAll, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

const zahtevaj = createRequire(import.meta.url)
const SKRIPT = resolve('scripts/typecheck-cloud.cjs')
const gate = zahtevaj(SKRIPT) as {
  KODA: Record<string, number>
  ORODJE: Record<string, string>
  KOREN: string
  USAGE: string
  razresi: (cwd: string, ime: string) => string
  oznaci: (cwd: string, skript: string) => string
  izKod: (rezultat: { status: number | null; signal?: string | null }) => number
  izvedi: (cwd: string, skript: string, argumenti: string[], label: string, izvršljiva?: string) => number
  razcleni: (argv: string[]) => { args?: Record<string, string | boolean>; napaka?: string }
  main: (argv: string[]) => number
}

const KOREN = gate.KOREN
const IZVOR = readFileSync(SKRIPT, 'utf8')

/**
 * Kode ali pripomka ne morem presojati z istim vzorcem: dokumentacija vratov
 * namerno omenja `npx`, ker pravi, da ga NE sme uporabiti.
 */
function brezKomentarjev(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const kodaVira = brezKomentarjev(IZVOR)

/**
 * Napaka in USAGE smeta omenjati `npx` — prav zato, da ga koda prepove.
 * Za sojenje kodi torej najprej odvzamem enojne, dvojne in predpisne nize.
 */
function brezNizov(src: string): string {
  return src.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``')
}

const temps: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'v184-'))
  temps.push(d)
  return d
}

function praznaMapa(): string {
  const d = join(tempDir(), 'ni-namesceno')
  mkdirSync(d, { recursive: true })
  return d
}

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

/**
 * Varnostno varovalo: polni tek vratov zamenja Prisma klient. Test, ki pozabi
 * varno zastavico, mora pasti tukaj, ne sredi `bun test`.
 */
const VARNI_ZASTAVICE = ['--probe', '--help', '--neznano']
function pozeniGate(args: string[]): { code: number; stdout: string; stderr: string } {
  if (!args.some((a) => VARNI_ZASTAVICE.includes(a))) {
    throw new Error(`pozeniGate: brez varne zastavice bi zagnal prava vrata (${args.join(' ')}). Dodaj --probe.`)
  }
  const r = spawnSync(process.execPath, [SKRIPT, ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function datasource(): string {
  const p = join(KOREN, 'node_modules/.prisma/client/schema.prisma')
  const m = /datasource[^}]*provider\s*=\s*"([^"]+)"/m.exec(readFileSync(p, 'utf8'))
  return m ? m[1] : 'neprepoznan'
}

describe('A — razrešitev orodij brez pognalnika', () => {
  it('A1 tsc se razreši na obstoječo datoteko v node_modules/typescript', () => {
    const pot = gate.razresi(KOREN, 'tsc')
    expect(isAbsolute(pot)).toBe(true)
    expect(existsSync(pot)).toBe(true)
    expect(pot.split(sep).join('/')).toContain('node_modules/typescript/bin/tsc')
  })

  it('A2 prisma se razreši na build/index.js v node_modules/prisma', () => {
    const pot = gate.razresi(KOREN, 'prisma')
    expect(isAbsolute(pot)).toBe(true)
    expect(existsSync(pot)).toBe(true)
    expect(pot.split(sep).join('/')).toContain('node_modules/prisma/build/index.js')
  })

  it('A3 ORODJE hrani poti paketov, ne .bin pripone ali absolutnih poti', () => {
    for (const [ime, pot] of Object.entries(gate.ORODJE)) {
      expect(pot.startsWith('.')).toBe(false)
      expect(isAbsolute(pot)).toBe(false)
      expect(pot).not.toContain('.bin')
      expect(pot.split('/').length).toBe(3)
      expect(gate.razresi(KOREN, ime)).toBe(zahtevaj.resolve(pot, { paths: [KOREN] }))
    }
  })

  it('A4 neznano orodje je napaka, ne tiha pot v nil', () => {
    expect(() => gate.razresi(KOREN, 'eslint')).toThrow(/Neznano orodje "eslint"/)
    expect(() => gate.razresi(KOREN, 'eslint')).toThrow(/Znani: tsc, prisma/)
  })

  it('A5 manjkajoče orodje javi `bun install` in izrecno zavrne npx', () => {
    let spor = ''
    try {
      gate.razresi(praznaMapa(), 'tsc')
    } catch (e) {
      spor = (e as Error).message
    }
    expect(spor).toContain('ni nameščeno')
    expect(spor).toContain('bun install')
    expect(spor).toContain('NE padajo nazaj na `npx`')
    expect(spor).toContain('This is not the tsc command you are looking for')
  })

  it('A6 razrešitev je glede na podano korensko mapo, ne glede na process.cwd', () => {
    expect(gate.razresi(KOREN, 'tsc')).toBe(gate.razresi(dirname(SKRIPT), 'tsc'))
    expect(() => gate.razresi(praznaMapa(), 'tsc')).toThrow(/ni nameščeno/)
  })

  it('A7 koda ne pozna več izbire pognalnika', () => {
    expect(kodaVira).not.toContain('npm_config_user_agent')
    expect(kodaVira).not.toContain('execSync')
    expect(kodaVira).toContain('require.resolve')
    expect(kodaVira).toContain('izvršljiva = process.execPath')
    const gola = brezNizov(kodaVira)
    expect(gola).not.toMatch(/\bnpx\b/)
    expect(gola).not.toMatch(/\bbunx\b/)
    expect(gola.match(/spawnSync\(/g) || []).toHaveLength(1)
  })

  it('A8 package.json vratov kliče z node, ne z bun', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['typecheck:cloud']).toBe('node scripts/typecheck-cloud.cjs')
  })
})

describe('B — --probe: razreši, a ne piše', () => {
  it('B1 probe --json vrne kodo 0 in obe resnični poti', () => {
    const r = pozeniGate(['--probe', '--json'])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.stdout.trim()) as Record<string, string>
    expect(j.ok).toBe(true)
    expect(existsSync(j.tsc)).toBe(true)
    expect(existsSync(j.prisma)).toBe(true)
    expect(j.cwd).toBe(KOREN)
  })

  it('B2 probe ne spremeni Prisma klienta: provider ostane tisto, kar je bil', () => {
    const pred = datasource()
    const r = pozeniGate(['--probe'])
    expect(r.code).toBe(0)
    expect(datasource()).toBe(pred)
    expect(r.stdout).not.toContain('Prisma schema loaded')
  })

  it('B3 besedilni probe našteje obe orodji z imenom', () => {
    const r = pozeniGate(['--probe'])
    expect(r.stdout).toContain('orodji: tsc=')
    expect(r.stdout).toContain('prisma=')
  })

  it('B4 prazna korenska mapa ⇒ koda 4 in napaka z `bun install`', () => {
    const r = pozeniGate(['--probe', '--cwd', praznaMapa()])
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('ni nameščeno')
    expect(r.stderr).toContain('bun install')
  })

  it('B5 --json na prazni mapi je strojno berljiv odgovor, ne izjema', () => {
    const r = pozeniGate(['--probe', '--json', '--cwd', praznaMapa()])
    expect(r.code).toBe(4)
    const j = JSON.parse(r.stdout.trim()) as Record<string, string>
    expect(j.ok).toBe(false)
    expect(j.error).toContain('bun install')
  })

  it('B6 --help izpiše uporabo in vseh šest izstopnih kod', () => {
    const r = pozeniGate(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Uporaba: bun run typecheck:cloud')
    for (const koda of Object.values(gate.KODA)) expect(r.stdout).toContain(`${koda} `)
    expect(r.stdout).toContain('--probe')
  })

  it('B7 neznana možnost ⇒ 64 in uporaba na stderr', () => {
    const r = pozeniGate(['--neznano'])
    expect(r.code).toBe(64)
    expect(r.stderr).toContain('Neznana možnost "--neznano"')
    expect(r.stderr).toContain('Uporaba:')
  })

  it('B8 možnost brez vrednosti ⇒ 64, ne NaN ali undefined', () => {
    const r = pozeniGate(['--probe', '--cwd'])
    expect(r.code).toBe(64)
    expect(r.stderr).toContain('--cwd rabi vrednost')
  })

  it('B9 goli klic ustavi varovalo proti samoprevari testa', () => {
    expect(() => pozeniGate([])).toThrow(/brez varne zastavice/)
    expect(() => pozeniGate(['--schema', 'x.prisma'])).toThrow(/brez varne zastavice/)
  })

  it('B10 oznaci izpiše pot glede na korensko mapo ne pa zgolj index.js', () => {
    const r = pozeniGate(['--probe', '--json'])
    const j = JSON.parse(r.stdout.trim()) as Record<string, string>
    expect(gate.oznaci(KOREN, j.prisma)).toBe('node_modules/prisma/build/index.js')
    expect(gate.oznaci(KOREN, j.tsc)).toBe('node_modules/typescript/bin/tsc')
    expect(gate.oznaci(praznaMapa(), SKRIPT)).toBe(SKRIPT)
  })
})

describe('C — pogodba izidov', () => {
  it('C1 KODA ima šest dogovorjenih vrednosti', () => {
    expect(gate.KODA).toEqual({
      zelena: 0,
      tscRdec: 1,
      generatePadlo: 2,
      obnovitevNuspelo: 3,
      orodjeNiNamesceno: 4,
      neznanaMoznost: 64,
    })
  })

  it('C2 USAGE našteje vsako kodo iz KODA', () => {
    for (const koda of Object.values(gate.KODA)) expect(gate.USAGE).toContain(`${koda} `)
  })

  it('C3 izvedba vrne izhodno kodo otroka, tudi če ni 0 ali 1', () => {
    const d = tempDir()
    const la = join(d, 'izhod.cjs')
    writeFileSync(la, 'process.exit(7)\n')
    expect(gate.izvedi(d, la, [], 'lažno orodje')).toBe(7)
  })

  /**
   * Kar je bilo zamisljeno kot test veje `status === null`, na Windows te veje
   * nikoli ne doseže: izmerjeno 28. 10. 2026 samoubitje s SIGKILL in timeout
   * oba vrneta `status = 1, signal = null`. Test torej sodi dejanski izid
   * pokončanega otroka; vejo `null` zajema C7 nad izvlečenim `izKod`.
   */
  it('C4 pokončan otrok vrne kodo 1, nikoli ničle — na tej platformi tudi ne null', () => {
    const d = tempDir()
    const la = join(d, 'umri.cjs')
    writeFileSync(la, "process.kill(process.pid, 'SIGKILL')\n")
    expect(gate.izvedi(d, la, [], 'ubit otrok')).toBe(1)
  })

  /**
   * Izmerjeno, ne domnevano: `spawnSync` uspe TUDI, ko ciljna datoteka manjka —
   * node jo pogreši, vrne kodo 1, `rezultat.error` pa ostane prazen. Veje
   * »napaka zagona« torej ne morem doseči z manjkajočo datoteko, ampak samo z
   * nezagnanljivim programom (C6); če bi to trdila kar naprej, bi test skrival
   * nedokazano vejo namesto kazal napako.
   */
  it('C5 manjkajoča ciljna datoteka je rdeča koda otroka, ne izjema starša', () => {
    const d = tempDir()
    expect(gate.izvedi(d, join(d, 'nimate-te-te.cjs'), [], 'manjkajoč')).toBe(1)
  })

  it('C6 nezagnanljiv program je izjema, ki jo skript javi', () => {
    const d = tempDir()
    const tuji = join(d, 'ni-node.exe')
    expect(() => gate.izvedi(d, join(d, 'karkoli.cjs'), [], 'tuji pognalnik', tuji)).toThrow(/ni bilo mogoče zagnati/)
  })

  /**
   * Veja `status === null` je edini primer, kjer otrok sploh ne javi izhodne
   * kode (POSIX: ubit s signalom). Ker je na tej napravi ni mogoče izzvati skozi
   * `spawnSync`, je izvlečena v `izKod` in sodi neposredno — sicer bi mutacija
   * `null ? 1 : status` → `null ? 0` preživela, kar se je tukrat zgodilo (M4).
   */
  it('C7 izKod: brez izhodne kode ni uspeha, vedno koda 1', () => {
    expect(gate.izKod({ status: null, signal: 'SIGKILL' })).toBe(1)
    expect(gate.izKod({ status: null, signal: 'SIGTERM' })).toBe(1)
    expect(gate.izKod({ status: null })).toBe(1)
  })

  it('C8 izKod: koda otroka gre naprej nespremenjena', () => {
    expect(gate.izKod({ status: 0 })).toBe(0)
    expect(gate.izKod({ status: 1 })).toBe(1)
    expect(gate.izKod({ status: 7 })).toBe(7)
  })
})

describe('F — celoten tek čez lažna orodja (pravi klient se ne dotakne)', () => {
  interface Lutka {
    root: string
    log: string
  }

  function laznaOrodja(tscKoda = 0, prismaProd = 0, prismaZrcalo = 0): Lutka {
    const root = tempDir()
    const log = join(root, 'klici.log')
    writeFileSync(log, '')
    const tsDir = join(root, 'node_modules', 'typescript', 'bin')
    const prDir = join(root, 'node_modules', 'prisma', 'build')
    mkdirSync(tsDir, { recursive: true })
    mkdirSync(prDir, { recursive: true })
    writeFileSync(
      join(tsDir, 'tsc'),
      "require('fs').appendFileSync(process.env.V184_LOG, 'tsc ' + process.argv.slice(2).join(' ') + '\\n')\nprocess.exit(Number(process.env.V184_TSC_KODA || 0))\n",
    )
    writeFileSync(
      join(prDir, 'index.js'),
      "const fs=require('fs');const a=process.argv.slice(2);const zrcalo=a.includes('zrcalo.prisma');" +
        "fs.appendFileSync(process.env.V184_LOG,'generate '+a.join(' ')+'\\n');" +
        'process.exit(Number(zrcalo ? process.env.V184_PRISMA_ZRCALO || 0 : process.env.V184_PRISMA_PROD || 0))\n',
    )
    process.env.V184_LOG = log
    process.env.V184_TSC_KODA = String(tscKoda)
    process.env.V184_PRISMA_PROD = String(prismaProd)
    process.env.V184_PRISMA_ZRCALO = String(prismaZrcalo)
    return { root, log }
  }

  const okolje = ['V184_LOG', 'V184_TSC_KODA', 'V184_PRISMA_PROD', 'V184_PRISMA_ZRCALO'] as const
  afterEach(() => {
    for (const k of okolje) delete process.env[k]
  })

  function zaznamke(log: string): string[] {
    return readFileSync(log, 'utf8')
      .split(/\r?\n/)
      .filter((v) => v.length > 0)
  }

  it('F1 zeleni tek: produkcijski klient, tsc, obnova — v tem redu, koda 0', () => {
    const l = laznaOrodja()
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(0)
    const z = zaznamke(l.log)
    expect(z.length).toBe(3)
    expect(z[0]).toContain('generate --schema shema.prisma')
    expect(z[1]).toContain('tsc --noEmit')
    expect(z[2]).toContain('generate --schema zrcalo.prisma')
  })

  it('F2 rdeč tsc ⇒ koda 1, obnova gre vseeno zadnja', () => {
    const l = laznaOrodja(1)
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(1)
    const z = zaznamke(l.log)
    expect(z[1]).toContain('tsc --noEmit')
    expect(z[z.length - 1]).toContain('generate --schema zrcalo.prisma')
  })

  it('F3 padlo produkcijsko generiranje ⇒ koda 2, tsc se NE zažene, obnova teče', () => {
    const l = laznaOrodja(0, 2)
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(2)
    const z = zaznamke(l.log)
    expect(z.some((v) => v.startsWith('tsc'))).toBe(false)
    expect(z[z.length - 1]).toContain('generate --schema zrcalo.prisma')
  })

  it('F4 obnova, ki odpove, na zelenih tipih ⇒ koda 3, ne lažna 0', () => {
    const l = laznaOrodja(0, 0, 3)
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(3)
  })

  it('F5 obnova, ki odpove, ne prekrije že rdečih tipov: koda ostane 1', () => {
    const l = laznaOrodja(1, 0, 3)
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(1)
    expect(zaznamke(l.log)[2]).toContain('generate --schema zrcalo.prisma')
  })

  it('F6 brez orodja tek ne more začeti: koda 4 in noben klic', () => {
    const l = laznaOrodja()
    rmSync(join(l.root, 'node_modules', 'typescript'), { recursive: true, force: true })
    expect(gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])).toBe(4)
    expect(zaznamke(l.log).length).toBe(0)
  })

  it('F7 pravi Prisma klient se po skupini F ni spremenil', () => {
    const l = laznaOrodja(0, 0, 0)
    const pred = datasource()
    gate.main(['--cwd', l.root, '--schema', 'shema.prisma', '--mirror', 'zrcalo.prisma'])
    expect(datasource()).toBe(pred)
  })
})

describe('D — invarianta obnove klientov', () => {
  it('D1 pred vrnitvijo SQLite klienta ne sme biti zgodnjega izhoda', () => {
    const doObnove = kodaVira.split("'vrni SQLite klient'")[0]
    expect(doObnove.length).toBeGreaterThan(0)
    expect(doObnove).not.toContain('process.exit(')
  })

  it('D2 obe veji obnovitve (izhodna koda in izjema) dvigneta kodo 3', () => {
    expect(kodaVira.split('if (izhodnaKoda === KODA.zelena) izhodnaKoda = KODA.obnovitevNuspelo').length - 1).toBe(2)
  })

  it('D3 generiranje produkcijskega klienta je prvi korak, tsc drugi, obnova zadnji', () => {
    const i = kodaVira.indexOf("'produkcijski klient'")
    const t = kodaVira.indexOf("'tsc proti Postgres klientu'")
    const o = kodaVira.indexOf("'vrni SQLite klient'")
    expect(i).toBeGreaterThan(-1)
    expect(t).toBeGreaterThan(i)
    expect(o).toBeGreaterThan(t)
  })

  it('D4 rdeč tsc prevzame izhodno kodo, ne tiha koda 0', () => {
    expect(kodaVira).toContain('izhodnaKoda = koda')
  })

  it('D5 obnovitev je vedno proti zrcalni shemi, ne proti produkcijski', () => {
    const args = gate.razcleni([]).args as Record<string, string>
    expect(args.shema).toBe('prisma/schema.prisma')
    expect(args.zrcalo).toBe('prisma/schema.sqlite.prisma')
    expect(gate.razcleni(['--mirror', 'x.prisma']).args).toMatchObject({ zrcalo: 'x.prisma' })
  })

  it('D6 zrcalna shema obstaja, sicer obnova ne more vrniti SQLite klienta', () => {
    const args = gate.razcleni([]).args as Record<string, string>
    expect(existsSync(join(KOREN, args.zrcalo))).toBe(true)
    expect(existsSync(join(KOREN, args.shema))).toBe(true)
  })
})

describe('E — dokumentacija in popravek dnevnika', () => {
  const dnevnik = readFileSync('worklog.md', 'utf8')
  const glava = dnevnik.slice(0, dnevnik.indexOf('Task ID: v1.183.0'))

  it('E1 dnevnik v1.184.0 ima izmerjen vzrok, ne domneve', () => {
    expect(glava).toContain('_npx')
    expect(glava).toContain('npm_config_user_agent')
    expect(glava).toContain('40 268 ms')
    expect(glava).toContain('49 352 ms')
  })

  /**
   * Zgodovina se ne prepisuje: napačna alineja ostane dobesedno, dobiti mora
   * oznako PRED seboj in popravek ZA seboj. Iskanje je zato ožje na glavo
   * v1.183.0 — glava v1.184.0 napačno trditev upravičeno citira, in test, ki bi
   * sodil po celem dnevniku, bi imel citiranega za neoznačenega.
   */
  it('E2 napačna trditev iz v1.183.0 je označena in popravljena, ne izbrisana', () => {
    const vrstice = dnevnik.split(/\r?\n/)
    const zacetek = vrstice.findIndex((v) => v.startsWith('Task ID: v1.183.0'))
    const konec = vrstice.findIndex((v, i) => i > zacetek && v.startsWith('Task ID: v1.182.0'))
    expect(zacetek).toBeGreaterThan(-1)
    expect(konec).toBeGreaterThan(zacetek)
    const blok183 = vrstice.slice(zacetek, konec).join('\n')
    const trditev = blok183.indexOf('`node_modules/.bin/tsc` ni nameščen')
    const oznaka = blok183.indexOf('ZAVEDLO')
    expect(trditev).toBeGreaterThan(-1)
    expect(oznaka).toBeGreaterThan(-1)
    expect(oznaka).toBeLessThan(trditev)
    expect(blok183.slice(trditev, trditev + 4000)).toContain('Popravek trditve zgoraj')
    expect(glava).toContain('ZAVEDLO')
  })

  it('E3 dokument vratov opisuje lokalno razrešitev in izstopne kode', () => {
    const docs = readFileSync('docs/DEPLOYMENT-RESILIENCE.md', 'utf8')
    expect(docs).toContain('typecheck:cloud')
    expect(docs).toContain('require.resolve')
    expect(docs).toMatch(/izstopn\w* kod/i)
  })

  it('E4 skripta ne more več razglasiti tipov za usklajene brez dejanskega pregleda', () => {
    expect(kodaVira).toContain("['--noEmit']")
    // Zagnani program nikoli ni besedilni niz: `spawnSync('npx …')` je bila prav
    // ta pot, po kateri so vrata nekoč pograbila tuj paket.
    expect(brezNizov(kodaVira)).not.toMatch(/spawnSync\(\s*['"`]/)
  })

  it('E5 izdaja je v kodi, ne samo v dokumentu', () => {
    expect(readFileSync('src/lib/version.ts', 'utf8')).toMatch(/'1\.190\.0'/)
  })
})
