/**
 * v1.180.1 — ime izdelka sme biti napisano samo na en način.
 *
 * ODLOČITEV: lastnik jo je 2026-10-26 izrecno prepustil meni ("sam se odloči,
 * kako je pravilno"). Kanonična oblika je `RestaurantOS`; napačna oblika je v
 * tej datoteki sestavljena iz treh delov (spodaj) in kot celota v viru nikoli ne
 * nastopi — utemeljeno izmerjeno:
 *   - ime je v kodi zapisano 162-krat proti 50-krat v napačni obliki,
 *   - repo se imenuje `restaurantos` na GitHubu in na GitLabu (dvojna sinhronizacija),
 *   - revizijski dokument je `docs/RESTAURANTOS-AUDIT.md`,
 *   - slovarja že imata kanonični ključ `common.app` = `RestaurantOS`.
 * Napačna oblika ni črkovna napaka pisave, ampak pomota, ki jo je prinesel
 * zgodnji seed in so jo nato kopirale nove datoteke.
 *
 * DVA RAZLOGA ZA OBLIKO GATE-A:
 *  (1) Vsebina je pomembna, ne samo datoteke: pravilo A prepove stari zapis po
 *      CELOTNEM drevesu (ne samo po `src/`), ker je bil prav nedosleden obseg
 *      tisti, ki je dopustil 50 pojavitev v 25 datotekah.
 *  (2) Zgodovina je nedotakljiva: `worklog.md`, `DEPLOYMENT-STATUS.md` in
 *      `RECOVERY-REPORT.md` so revizijski zapisnik datumiranih meritv. Njihovo
 *      samodejno preimenovanje bi napisalo zgodovino na novo, zato sme ostati
 *      stara oblika samo tam — in pravilo C to VEŽE, da ne bo "po nesreči"
 *      počiščena naslednjič, ko nekdo uvede globalni find-and-replace.
 *
 * Vsi pripeti so sestavljeni iz `KANON`, zato bo naslednje preimenovanje imena
 * zahtevalo eno samo spremembo v tej datoteki in eno v vsakem viru.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, posix } from 'node:path'

const KOREN = join(import.meta.dir, '..')
const KANON = 'RestaurantOS'

/**
 * Stari zapis je sestavljen iz treh delov: nikoli ne sme biti zapisan kot
 * celota, sicer bi gate prijavljal sam sebe in bil rdeč zaradi lastnega besedila.
 */
const STARI = new RegExp(['Rest', 'avrant', '\\s*OS'].join(''), 'i')

const IZPUSCENE_MAPI = new Set([
  'node_modules', '.git', '.next', '.superpowers', 'out', 'dist', 'build',
  'coverage', 'test-results', '.turbo', '.swc', '.worktrees',
])

/** Samo besedilne končnice; `.env` (`extname` = '') je zato izven dosega. */
const BESEDILNE_KONCENICE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.prisma',
  '.py', '.sh', '.sql', '.html', '.css', '.scss', '.yaml', '.yml', '.txt',
  '.example',
])

/** Datumirani revizijski zapisniki: zgodovina, ki sme obdržati stari zapis. */
const ZGODOVINA = ['worklog.md', 'DEPLOYMENT-STATUS.md', 'RECOVERY-REPORT.md']

function datoteke(dir: string, izto: string[]): string[] {
  const out: string[] = []
  for (const ime of readdirSync(dir).sort()) {
    const abs = join(dir, ime)
    const rel = posix.join(...izto, ime)
    if (dir === KOREN && ZGODOVINA.includes(rel)) continue
    if (statSync(abs).isDirectory()) {
      if (IZPUSCENE_MAPI.has(ime)) continue
      out.push(...datoteke(abs, [...izto, ime]))
      continue
    }
    if (!BESEDILNE_KONCENICE.has(extname(ime))) continue
    out.push(rel)
  }
  return out
}

const POVRSINA = datoteke(KOREN, [])
const ber = (rel: string) => readFileSync(join(KOREN, ...rel.split('/')), 'utf-8')

/**
 * Izpis ob odpovedi: v sporočilu sme ostati samo vrstica, ki jo iščemo, ne cela
 * datoteka — sicer je mutacijski dokaz (kjer se napaka pojavi stokrat) neberljiv.
 */
function vsebuje(rel: string, igla: string) {
  const najdena = ber(rel)
    .split('\n')
    .find((v) => v.includes(igla))
  if (najdena === undefined) throw new Error(`${rel}: manjka ${igla}`)
  return najdena.trim()
}

function prestej(rel: string, vzorec: RegExp) {
  return (ber(rel).match(vzorec) || []).length
}

function najdiStari(recenzije: string[]) {
  const zadetki: string[] = []
  for (const rel of recenzije) {
    ber(rel)
      .split('\n')
      .forEach((vrstica, i) => {
        if (STARI.test(vrstica)) zadetki.push(`${rel}:${i + 1}: ${vrstica.trim().slice(0, 90)}`)
      })
  }
  return zadetki
}

describe('v1.180.1 §A — površina drevesa ne pozna starega zapisa', () => {
  test(`površina je dovolj velika, da gate sploh kaj vidi (${POVRSINA.length} datotek)`, () => {
    // Brez te veje bi bila utišana napaka v sprehodu (npr. prezri vse mape) videti
    // kot uspeh: prazen seznam zadetkov ni dokaz, če je prazen tudi seznam datotek.
    expect(POVRSINA.length).toBeGreaterThan(300)
    expect(POVRSINA).toContain('src/lib/receipt.ts')
    expect(POVRSINA).toContain('prisma/seed.ts')
    expect(POVRSINA).toContain('public/sw.js')
    expect(POVRSINA).toContain('README.md')
    expect(POVRSINA).toContain('.env.example')
    expect(POVRSINA.some((f) => f.startsWith('.github/'))).toBe(true)
    // Dvema vejema se mora sprehod izogniti NAMENO in ne zato, ker ju drevo
    // slučajno nima: lockfile izpade, ker `.lock` ni besedilna končnica (ta pin ga
    // drži, če nekdo končnice razširi), `.env` pa izpade, ker nima končnice — zato
    // je preverjena posebej, v naslednjem preizkusu.
    expect(POVRSINA.some((f) => /\.(lock|lockb)$/.test(f))).toBe(false)
    expect(POVRSINA).not.toContain('.env')
  })

  test('nobena besedilna datoteka (razen datumirane zgodovine) ne sme vsebovati „starega zapisa“', () => {
    expect(najdiStari(POVRSINA)).toEqual([])
  })

  test('datoteka brez končnice je preverjena posebej, ker je sprehod ne vidi', () => {
    // `extname('.env')` je prazen niz, zato jo sprehod zavrne — lokalna `.env` pa
    // je bila ustvarjena iz takratnega `.env.example`, torej takrat, ko je ime še
    // bilo narobe. Brez tega preizkusa bi gate trdil „površina je čista“ o
    // površini, ki te datoteke sploh ne pozna. Kjer je ni (CI, čisto drevo), se
    // preizkus umakne.
    if (!existsSync(join(KOREN, '.env'))) return
    expect(najdiStari(['.env'])).toEqual([])
  })

  test('dokumenti, ki govorijo danes, imajo ime napisano kanonično', () => {
    expect(ber('README.md').split('\n')[0]).toBe(`# ${KANON}`)
    const docs = POVRSINA.filter((f) => f.startsWith('docs/') && f.endsWith('.md'))
    expect(docs.length).toBeGreaterThan(5)
    for (const rel of docs) expect(STARI.test(ber(rel))).toBe(false)
  })
})

describe('v1.180.1 §B — kanonični nizi so pripeti, ne naključno prisotni', () => {
  test('slovar: `common.app` je en sam vir imena, `dash.h1` ga uporablja v obeh jezikih', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    expect(sl['common.app']).toBe(KANON)
    expect(hr['common.app']).toBe(KANON)
    expect(sl['dash.h1']).toBe(`Nadzorna plošča — ${KANON}`)
    expect(hr['dash.h1']).toBe(`Kontrolna ploča — ${KANON}`)
  })

  test('račun: privzeto ime na vrhu računa je kanonično', () => {
    expect(vsebuje('src/lib/receipt.ts', `d.businessName || '${KANON}'`)).toContain(KANON)
  })

  test('opomnika za rezervaciji: privzeto ime restavracije je kanonično', () => {
    expect(vsebuje('src/app/api/reservations/reminders/route.ts', `loc?.name || '${KANON}'`)).toContain(KANON)
    expect(vsebuje('src/app/api/reservations/[id]/reminder/route.ts', `location?.name || '${KANON}'`)).toContain(KANON)
  })

  test('preizkusni push in privzeti naslov service workerja sta kanonična', () => {
    expect(vsebuje('src/app/api/push/test/route.ts', `'${KANON} — test'`)).toContain(KANON)
    expect(prestej('public/sw.js', new RegExp(`'${KANON}'`, 'g'))).toBe(2)
  })

  test('oznaka v konzoli (`error.tsx`) je kanonična', () => {
    expect(vsebuje('src/app/error.tsx', `[${KANON}] Neujeta napaka:`)).toContain(KANON)
  })

  test('dnevna pošta: štiri zadeve in dva podpisa uporabita kanonično ime', () => {
    expect(prestej('src/lib/daily-email.ts', new RegExp(`${KANON} — dnevni povzetek`, 'g'))).toBe(4)
    expect(prestej('src/lib/daily-email.ts', new RegExp(`— Samodejno sporočilo ${KANON}`, 'g'))).toBe(2)
  })

  test('seeda: ime lokacije in ime nastavitev sta kanonična', () => {
    expect(vsebuje('prisma/seed.ts', `name: '${KANON} Ljubljana'`)).toContain(KANON)
    expect(vsebuje('prisma/seed.ts', `name: '${KANON}'`)).toContain(KANON)
    expect(prestej('prisma/seed.ts', STARI)).toBe(0)
    expect(prestej('prisma/seed-demo.ts', STARI)).toBe(0)
  })

  test('zrcalna shema in njen generator se morata ujemati (generator ne sme pisati drugega imena kot zrcalo)', () => {
    // Glava generirane datoteke je prepisana iz `header` v generatorju: če nekdo
    // popravi samo eno stran, je naslednji `python3 scripts/build-sqlite-mirror.py`
    // tiho povrne star zapis v shemo, ki jo rabijo vsa vrata.
    const generator = ber('scripts/build-sqlite-mirror.py')
    const izvod = generator.match(/^header = '''(.*)$/m)
    if (!izvod) throw new Error('v generatorju ni več spremenljivke `header` — posodobi gate')
    const glavaGenerator = izvod[1]
    const glavaSheme = ber('prisma/schema.sqlite.prisma').split('\n')[0]
    expect(glavaSheme).toBe(glavaGenerator)
    expect(glavaSheme).toContain(KANON)
  })

  test('skripti in konfiguracijski vzorci so kanonični', () => {
    expect(ber('scripts/neon-smoke.mjs').split('\n')[0]).toBe(`// ${KANON} — Neon ephemeral-branch smoke test (CI)`)
    expect(STARI.test(ber('.env.example'))).toBe(false)
    expect(vsebuje('.env.example', `# ${KANON} — .env.example`)).toContain(KANON)
    expect(STARI.test(ber('scripts/local-setup.ts'))).toBe(false)
    expect(STARI.test(ber('scripts/local-start.ts'))).toBe(false)
  })
})

describe('v1.180.1 §C — zgodovina ostane nedotaknjena (in to je vezano, ne naključje)', () => {
  test('datumirani zapisniki še vedno vsebujejo takratni zapis', () => {
    for (const rel of ZGODOVINA) {
      const besedilo = ber(rel)
      expect(STARI.test(besedilo)).toBe(true)
    }
  })

  test('delovni dnevnik ni bil prepisan: meritev iz preteklosti ne sme biti popravljena nazaj', () => {
    // Ob nastanku tega testa je imel `worklog.md` devet vrstic s starim zapisom,
    // danes jih je deset (točno število veže §D). Številka pade, če jih nekdo
    // "očisti" — sicer se izniči tudi dokaz, kje in kdaj je bila napaka.
    const vrstice = ber('worklog.md').split('\n').filter((v) => STARI.test(v))
    expect(vrstice.length).toBeGreaterThanOrEqual(9)
  })

  test('nov blok o tej izdaji v worklog.md dokumentira odločitev', () => {
    const w = ber('worklog.md')
    expect(w.split('\n').some((v) => v.includes('v1.180.1'))).toBe(true)
    expect(w.split('\n').some((v) => v.includes(KANON) && v.includes('ime izdelka'))).toBe(true)
  })
})

describe('v1.180.1 §D — pozitivna kontrola bralnika (brez nje §A ne pomeni ničesar)', () => {
  test('isti bralnik v datumirani zgodovini DEJANSKO vidi stari zapis', () => {
    // §A trdi, da na površini ni nobenega zadetka. Enako trditev bi izpisal
    // bralnik, ki nič ne bere, ali regex, ki nikoli ne ustreza. Jedro gate-a je
    // torej dokazano šele takrat, ko isti mehanizem dokaže, da kaj najde. Merjeno
    // po vrsticah: worklog.md 10, DEPLOYMENT-STATUS.md 1, RECOVERY-REPORT.md 3.
    const zadetki = najdiStari(ZGODOVINA)
    expect(zadetki.length).toBe(14)
    expect(zadetki.filter((z) => z.startsWith('worklog.md:')).length).toBe(10)
    expect(zadetki.filter((z) => z.startsWith('DEPLOYMENT-STATUS.md:')).length).toBe(1)
    expect(zadetki.filter((z) => z.startsWith('RECOVERY-REPORT.md:')).length).toBe(3)
  })

  test('kontrola je občutljiva tudi na drugo kapitalizacijo in na presledek', () => {
    // Kontrolni nizi so sestavljeni iz fragmentov. V viru samega gate-a ne sme
    // stati dobeseden stari zapis — takoj ga ujame §A, ki skenira tudi to
    // datoteko — med izvajanjem pa morajo biti sestavljeni, da jih regex vidi.
    // Vsak od treh primerov sicer lahko ostane mrtva trditev.
    const a = 'Rest'
    const b = 'avrant'
    const c = 'OS'
    expect(STARI.test(`${a.toUpperCase()}${b.toUpperCase()}${c}`)).toBe(true)
    expect(STARI.test(`v ${a.toLowerCase()}${b}${c} vedno eksplicitno`)).toBe(true)
    expect(STARI.test(`${a}${b} ${c} z presledkom`)).toBe(true)
    expect(STARI.test(`# ${KANON}`)).toBe(false)
  })
})
