/**
 * v1.174.0 — alarmno besedilo mora držati isti jezikovni standard kot izdelek.
 *
 * Merjeno 23. 10. 2026 (issue #79, run #182): `.github/workflows/ci.yml:245` je
 * edini alarmni niz v repozitoriju, ki je zapisan BREZ šumnikov — «Ce je padel tsc,
 * je v produkciji ze verjetno deployano isto stanje».
 *
 * Zakaj krivda NE pade na dostavo, je razvidno iz samega telesa issue-a #79, kamor
 * gresta oba zapisa z ENOTNIM curl klicem: besedi «sprožil» in «izsečka», ki ju je
 * napisal `action.yml`, prideta do prejemnika nepoškodovani, stavek iz `hint` pa
 * pride dobesedno pokvarjen. En transport, dva izida — okvara je v IZVORNEM besedilu,
 * zato jo more varovati branje vira in ne HTTP stub.
 *
 * Zakaj je to vredno vrat in ne samo tipkarskega popravka: alarmno besedilo je edini
 * tekst, ki ga lastnik prebere brez odpiranja zaslona Actions (obvestilo → issue →
 * e-pošta). Stavek brez šumnikov med pravilno zapisanimi sosedi vzbudi upravičeno
 * sumnjo, da ga je pisal stroj, lastnik pa mu ne verjame. Gre za isti razred kot
 * izpisi, ki jih je popravila v1.168.0: alarm, ki ni razumljiv, je enako neuporaben
 * kot alarm, ki ne pošlje nič.
 *
 * Zakaj statična pogodba in ne vedenjski test: transliteracijo v VIRU vidi samo
 * bralec vira. Vedenjski del je že zavarovan v tests/v168-ci-alarm-delivery.test.ts,
 * kjer se `payload.title` primerja z naslovom, ki vsebuje «zaključenega» s pravim č —
 * morebitna vrnitev na `argv` (MSYS pretvori UTF-8 v «?») bi takoj padla.
 *
 * Nevarnost, ki jo pokriva prvi test: varovalka, ki ne najde NIČ za preveriti, je
 * zelena za vedno. Zato zahteva število nizov in njihovo prisotnost v vsaki datoteki.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'

const WORKFLOWS = '.github/workflows'

interface AlarmString {
  file: string
  line: number
  key: 'scope' | 'hint'
  value: string
}

/**
 * Alarmni nizi, ki jih vidi uporabnik: `scope` je del naslova issue-a, `hint` del
 * telesa. Oba se v `action.yml` podata prek env, zato ju bralec išče kot navadna
 * niza v enojnih ali dvojitih narekovajih, vsakega na svoji vrstici.
 */
function alarmStrings(): AlarmString[] {
  const out: AlarmString[] = []
  for (const name of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort()) {
    const file = `${WORKFLOWS}/${name}`
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((l, i) => {
        const m = l.match(/^\s*(scope|hint):\s*(?:'([^']*)'|"([^"]*)")\s*$/)
        if (!m) return
        out.push({ file, line: i + 1, key: m[1] as 'scope' | 'hint', value: (m[2] ?? m[3]) as string })
      })
  }
  return out
}

/**
 * Slovenske besede na črkah č, š, ž, ki se v operativnem besedilu izpišejo tudi z
 * ASCII črkami — bodisi ker tipkovnica brez šumnikov izpusti črko, bodisi ker se je
 * pisec izognil kodni strani. Seznam je zbirka IZMERJENIH oblik iz tega repozitorija,
 * ne splošni črkovalnik.
 *
 * Tabeli sta ločeni, ker en sam seznam korenov povzroči lažne zadetke:
 *  - NATANNE: samo cela beseda. Dovoljena pripona bi ujela «celoten» pri `ce` in
 *    veljaven rodilnik «nice» pri `nic` — obe sta pravilna slovenščina.
 *  - STEVKI: osnova, ki sme dobiti pripono («zakljuc» ujame «zakljucenega»,
 *    «naroc» ujame «narocilo»). Nobena pravilna slovenska beseda se ne začne tako.
 */
const NATANNE: Record<string, string> = {
  ce: 'če',
  ze: 'že',
  nic: 'nič',
  cetudi: 'četudi',
  moc: 'moč',
  rezim: 'režim',
}

const STEVKI: Record<string, string> = {
  zakljuc: 'zaključ',
  doloc: 'določ',
  naroc: 'naroč',
  zacet: 'začet',
  pocist: 'počist',
  clove: 'člove',
  tisic: 'tisoč',
  kljuc: 'ključ',
}

/** Najdene transliteracije v nizu, v obliki «Ce → Če». */
function transliteracije(text: string): string[] {
  const hits: string[] = []
  for (const [skupina, tabela] of [['natanne', NATANNE], ['stevki', STEVKI]] as const) {
    for (const [osnova, pravilno] of Object.entries(tabela)) {
      const re = new RegExp(`\\b${osnova}${skupina === 'stevki' ? '\\w*' : ''}\\b`, 'i')
      const m = text.match(re)
      if (!m) continue
      const pripona = m[0].slice(osnova.length).toLowerCase()
      const osnovaPravilno = m[0][0] === m[0][0].toUpperCase() ? pravilno[0].toUpperCase() + pravilno.slice(1) : pravilno
      hits.push(`${m[0]} → ${osnovaPravilno}${pripona}`)
    }
  }
  return hits
}

describe('v1.174.0 — alarmni nizi so dejansko prebrani', () => {
  test('pobran je vsak `scope` in `hint` vseh workflowov, ki lahko pošljejo alarm', () => {
    const found = alarmStrings()
    // Merjeno 23. 10.: 16 nizov v 6 datotekah. Pragi so nizki namensko — jedro ni
    // število, ampak prisotnost: če bralec neha najti nize, ta test pade.
    expect(found.length).toBeGreaterThanOrEqual(16)
    expect([...new Set(found.map((f) => f.file))].sort()).toEqual(
      ['ci-canary.yml', 'ci.yml', 'neon-backup.yml', 'prod-smoke.yml', 'sync.yml', 'vercel-ops.yml'].map((f) => `${WORKFLOWS}/${f}`),
    )
    expect(found.filter((f) => f.key === 'hint').length).toBeGreaterThanOrEqual(6)
    for (const f of found) expect(f.value.trim().length).toBeGreaterThan(10)
  })
})

describe('v1.174.0 — alarmno besedilo ne sme biti transliterirano', () => {
  test('noben alarmni niz ne vsebuje slovenske besede brez šumnikov', () => {
    const pokvarjeni = alarmStrings()
      .map((f) => ({ ...f, najdbe: transliteracije(f.value) }))
      .filter((f) => f.najdbe.length > 0)
    expect(pokvarjeni.map((f) => `${f.file}:${f.line} [${f.key}] ${f.najdbe.join(', ')}`)).toEqual([])
  })

  test('NEGATIVNA KONTROLA: ASCII vzorec, izmerjen v ci.yml:245, mora biti javljen', () => {
    const vzorec =
      'Ta job je objektivna varovalka pred Vercel deployom. Ce je padel tsc, je v produkciji ze verjetno deployano isto stanje.'
    const najdbe = transliteracije(vzorec)
    expect(najdbe).toContain('Ce → Če')
    expect(najdbe).toContain('ze → že')
  })

  test('POZITIVNA KONTROLA: enaka povedba s šumniki ne sme biti javljena', () => {
    const vzorec =
      'Ta job je objektivna varovalka pred Vercel deployom. Če je padel tsc, je v produkciji že najverjetneje deployano isto stanje.'
    expect(transliteracije(vzorec)).toEqual([])
  })

  test('javljene so tudi sklonjene oblike, ne samo imenovalnik', () => {
    expect(transliteracije('Ali je zadnji run zakljucenega tipa?')).toEqual(['zakljucenega → zaključenega'])
    expect(transliteracije('Postavi narocila in doloceno vrednost.')).toEqual(['doloceno → določeno', 'narocila → naročila'])
    expect(transliteracije('Nepričakovano: nic ni blokirano.')).toEqual(['nic → nič'])
  })

  test('upravičene oblike ne smejo biti javljene (celoten in nice sta pravilna slovenščina)', () => {
    expect(transliteracije('tests (tsc + lint + celoten suite na SQLite)')).toEqual([])
    expect(transliteracije('Vrednost rodilnika: nice in cena storitve.')).toEqual([])
    expect(transliteracije('sinhronizacija GitLab <-> GitHub')).toEqual([])
  })

  test('jezikovni prepis hinta ne sme izgubiti nobenega od obeh navodil', () => {
    // Iz v1.168.0: ključno navodilo je že enkrat med prepisom izginilo iz telesa.
    const hint = alarmStrings().find(
      (f) => f.file === `${WORKFLOWS}/ci.yml` && f.key === 'hint' && f.value.includes('objektivna varovalka'),
    )
    expect(hint).toBeDefined()
    expect(transliteracije(hint?.value ?? '')).toEqual([])
    expect(hint?.value).toMatch(/padel tsc[\s\S]*deployment/)
    expect(hint?.value).toMatch(/`a56-`[\s\S]*`i4-`/)
  })
})
