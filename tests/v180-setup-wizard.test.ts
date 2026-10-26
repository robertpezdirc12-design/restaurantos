/**
 * v1.180.0 — R3: prva namestitev brez terminala.
 *
 * IZMERJENA VRZEL (drevo na veji feat/wcag-gostove-strani-v1.177.0, 25. 10. 2026):
 *  1. `src/lib/local-setup.ts:162-174` ustvari lokacijo **brez** `taxId`,
 *     `businessId` in `registerNumber` — teh stolpcev danes ne zapiše nobena pot;
 *  2. edini vhod za identiteto obrata so zastavice terminala
 *     (`scripts/local-setup.ts:42-45`, `scripts/local-start.ts:115-121`:
 *     `--owner-email`, `--owner-pin`, `--restaurant-name`). Brez terminala
 *     namestitev torej obstaja, a brez imena, brez davčne številke in s
 *     6-mestnim PIN-om, ki ga mora lastnik prebrati iz `PRVIC-ZAGON.txt`;
 *  3. `src/app/setup/` ne obstaja (`existsSync` = false), `src/app/api/setup/`
 *     ima samo `status/route.ts`, ki ga ne bere nobena uporabniška vmesnost
 *     (izmerjeno z grep: edina klica sta v `tests/`);
 *  4. `src/lib/local-https-front.ts:45-57` (`glaveZaVir`) izvoru nastavi
 *     `x-forwarded-proto`, `x-forwarded-host` in `x-forwarded-port`, NE pa
 *     `x-forwarded-for` (`grep -c x-forwarded-for` po tej datoteki = 0). Front se
 *     na Next poveže z `host: '127.0.0.1'` (vrstica 61), zato po pogledu
 *     aplikacije KATERAKOLI klient iz LAN pride iz zanke — vsak pogoj „samo iz
 *     tega stroja" bi danes popustil, ne pa deloval;
 *  5. v oblaku `DATABASE_URL` ni `file:` (`src/lib/runtime-info.ts`), zato tam
 *     `runLocalSetup()` ne sme teči nikoli — nov javni endpoint to preveri.
 *
 * Merilo izdaje ni „obstaja čarovnik", ampak: **štiri identifikacijska polja
 * (ime obrata, davčna številka, e-pošta lastnika, PIN) se dajo zapisati iz
 * brskalnika, in sicer (a) samo na stroju, kjer teče RestaurantOS, (b) samo
 * dokler namestitev nima nobenega zaposlenega, (c) prek ISTE poti kot CLI, da se
 * logika prvega zagona ne podvoji, in (d) ponovni zagon ne prepiše tistega, kar
 * je lastnik vmes popravil.** Tožna oblika pogoja (a): klient, ki si izmisli
 * `x-forwarded-for: 127.0.0.1`, ne sme dobiti 200 — zato ima izdaja lastno
 * varnostno plast (§E) in ne zaupa glavi, ki jo je poslal klient.
 *
 * Zapisani dve odločitvi, ki sta bili doslej sicer samoumevni:
 *  - datoteka `PRVIC-ZAGON.txt` PIN- razkrije (je 0600 in je edino okrevanje
 *    dostopa — to že pinna `tests/v165-local-setup.test.ts:104`), zaslonska
 *    natisljiva sled pa ga NE, ker jo tiskajo in puščajo na pultu (§D2);
 *  - identiteta se ob ponovnem zagonu samo DOPOLNI, nikoli ne PREPIŠE (§H3).
 */
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { checkDigitHrOib, checkDigitSiTaxId, validateSiTaxId } from '../src/lib/einvoice-validate'
import { hashPin } from '../src/lib/auth'
import { lintJsxString } from './helpers/guest-a11y'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const SI_TAX = `1234567${checkDigitSiTaxId('1234567')}`
const SI_TAX_2 = `7654321${checkDigitSiTaxId('7654321')}`
const SI_TAX_BAD = SI_TAX.slice(0, 7) + String((Number(SI_TAX[7]) + 1) % 10)
const HR_OIB = `1234567890${checkDigitHrOib('1234567890')}`

if (SI_TAX === SI_TAX_2) throw new Error('testna davčna številka se podvoji')

// ── §0 — kaj mora obstajati, da padec imenuje manjkajočo datoteko ────────────

describe('v1.180.0 §0 — površine prve namestitve', () => {
  it('O1: tri nove datoteke obstajajo (njihova imena so del vmesnika)', () => {
    const REQUIRED = ['src/lib/setup-claim.ts', 'src/app/api/setup/claim/route.ts', 'src/app/setup/page.tsx']
    expect(REQUIRED.filter((rel) => !existsSync(join(ROOT, rel)))).toEqual([])
  })
})

async function claimModule(): Promise<any> {
  const p = join(ROOT, 'src', 'lib', 'setup-claim.ts')
  if (!existsSync(p)) throw new Error('manjka src/lib/setup-claim.ts — §A, §B, §D in §E5 brez vmesnika')
  return import(p)
}

async function routeModule(): Promise<any> {
  const p = join(ROOT, 'src', 'app', 'api', 'setup', 'claim', 'route.ts')
  if (!existsSync(p)) throw new Error('manjka src/app/api/setup/claim/route.ts — §C brez handlerja')
  return import(p)
}

async function frontModule(): Promise<any> {
  return import('../src/lib/local-https-front')
}

// ── §A — ograja: KDO sme prevzeti namestitev ─────────────────────────────────

const STANJE = { localProfile: true, employees: 0, clientIp: '127.0.0.1', frontTrusted: true, rateAllowed: true }

describe('v1.180.0 §A — `claimDecision` odloča po vseh petih pogojih', () => {
  it('A1: vseh pet pogojev izpolnjenih = dovoljeno', async () => {
    const { claimDecision } = await claimModule()
    expect(claimDecision(STANJE)).toMatchObject({ allowed: true, status: 200 })
  })

  it('A2: oblačni profil = zavrnjeno, ker `runLocalSetup` čez njega nikoli ne sme teči', async () => {
    const { claimDecision } = await claimModule()
    expect(claimDecision({ ...STANJE, localProfile: false })).toMatchObject({ allowed: false, status: 403, razlog: 'profil' })
  })

  it('A3: zaposlenih > 0 = 409 in sporočilo, ki ne obeta ponovnega prevzema', async () => {
    const { claimDecision } = await claimModule()
    const odlocba = claimDecision({ ...STANJE, employees: 1 })
    expect(odlocba.status).toBe(409)
    expect(odlocba.razlog).toBe('zasedeno')
    expect(odlocba.sporocilo).not.toMatch(/ponovno prevzemi|reset/)
  })

  it('A4: neoverjena fronta = 403 in NE 409 — tuji klient ne sme brati stanja namestitve', async () => {
    const { claimDecision } = await claimModule()
    expect(claimDecision({ ...STANJE, frontTrusted: false, employees: 5 })).toMatchObject({ status: 403, razlog: 'fronta' })
  })

  it('A5: overjena fronta, a klient ni na stroju = 403 `zanka`', async () => {
    const { claimDecision } = await claimModule()
    expect(claimDecision({ ...STANJE, clientIp: '10.0.0.9' })).toMatchObject({ status: 403, razlog: 'zanka' })
  })

  it('A6: presežen limit = 429', async () => {
    const { claimDecision } = await claimModule()
    expect(claimDecision({ ...STANJE, rateAllowed: false })).toMatchObject({ status: 429, razlog: 'limit' })
  })

  it('A7: `isLoopbackIp` pozna 127/8, ::1 in preslikano IPv4; link-local in prazen niz nista zanka', async () => {
    const { isLoopbackIp } = await claimModule()
    const zanka = ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1', 'localhost']
    const niZanka = ['10.0.0.9', '192.168.1.20', '169.254.1.1', '8.8.8.8', '::ffff:10.0.0.9', '', 'ne-ip']
    expect(zanka.filter((ip) => !isLoopbackIp(ip))).toEqual([])
    expect(niZanka.filter((ip) => isLoopbackIp(ip))).toEqual([])
  })

  it('A8: vseh pet pogojev je nosilnih — en sam obrjen pokrene zavrnitev (proti prazni ograji)', async () => {
    const { claimDecision } = await claimModule()
    const flipi: Array<[string, Record<string, unknown>]> = [
      ['localProfile=false', { localProfile: false }],
      ['employees=3', { employees: 3 }],
      ['clientIp=10.1.2.3', { clientIp: '10.1.2.3' }],
      ['frontTrusted=false', { frontTrusted: false }],
      ['rateAllowed=false', { rateAllowed: false }],
    ]
    expect(flipi.filter(([, delta]) => claimDecision({ ...STANJE, ...delta }).allowed).map(([ime]) => ime)).toEqual([])
  })

  it('A9: vsaka zavrnitev je dokumentirana z razlogom in slovenskim sporočilom (surov 403 = neuporabno)', async () => {
    const { claimDecision } = await claimModule()
    const slabo: string[] = []
    for (const delta of [{ localProfile: false }, { employees: 2 }, { clientIp: '10.0.0.9' }, { frontTrusted: false }, { rateAllowed: false }]) {
      const odlocba = claimDecision({ ...STANJE, ...delta })
      if (typeof odlocba.razlog !== 'string') slabo.push(`${JSON.stringify(delta)}: brez razloga`)
      if (typeof odlocba.sporocilo !== 'string' || odlocba.sporocilo.length < 20) slabo.push(`${JSON.stringify(delta)}: kratko sporočilo`)
    }
    expect(slabo).toEqual([])
  })
})

// ── §B — veljavnost štirih polj, brez izmišljenih novih pravil ───────────────

const TELO = {
  restaurantName: 'Gostilna Zeleni Hrib',
  email: '  Lastnik@Primer.TEST ',
  pin: '481516',
  taxId: SI_TAX,
  businessId: 'SI-ZN-1234',
  country: 'SI',
}

describe('v1.180.0 §B — `parseClaim` validira in normalizira', () => {
  it('B1: veljavno telo = ok, e-pošta skrčena in v malici, ime ohranjeno', async () => {
    const { parseClaim } = await claimModule()
    const rezultat = parseClaim(TELO)
    expect(rezultat.ok).toBe(true)
    expect(rezultat.value.email).toBe('lastnik@primer.test')
    expect(rezultat.value.restaurantName).toBe('Gostilna Zeleni Hrib')
    expect(rezultat.value.taxId).toBe(SI_TAX)
  })

  it('B2: ime obrata je obvezno in omejeno (prazno, samo presledek, > 120)', async () => {
    const { parseClaim } = await claimModule()
    const pari: Array<[string, boolean]> = [
      ['', false],
      ['   ', false],
      ['x'.repeat(121), false],
      ['x'.repeat(120), true],
    ]
    expect(pari.filter(([ime, doloci]) => parseClaim({ ...TELO, restaurantName: ime }).ok !== doloci).map(([ime]) => JSON.stringify(ime.slice(0, 8)))).toEqual([])
  })

  it('B3: e-pošta uporablja ISTI obrazec kot `runLocalSetup`, ne novega', async () => {
    const { parseClaim } = await claimModule()
    const napacne = ['a@', '@b.c', 'a b@c.d', '', 'a@b@c.d']
    expect(napacne.filter((slab) => parseClaim({ ...TELO, email: slab }).ok)).toEqual([])
    expect(napacne.filter((slab) => !Object.keys(parseClaim({ ...TELO, email: slab }).errors ?? {}).includes('email'))).toEqual([])
    expect(parseClaim({ ...TELO, email: 'ime.priimek@prim-er.si' }).ok).toBe(true)
  })

  it('B4: PIN 4–8 števk, enako kot v obstoječi CLI poti; število in presledek sta zavrnjena', async () => {
    const { parseClaim } = await claimModule()
    const slabi: unknown[] = ['123', '123456789', '12a456', 1234, '1234 567', null]
    const dobri = ['1234', '12345678']
    expect(slabi.filter((slab) => parseClaim({ ...TELO, pin: slab }).ok).map(String)).toEqual([])
    expect(dobri.filter((dober) => !parseClaim({ ...TELO, pin: dober }).ok)).toEqual([])
  })

  it('B5: davčna številka se validira s POSTOJEČIM mod 11-10, ne z novim regexom; prazna je dovoljena', async () => {
    const { parseClaim } = await claimModule()
    expect(validateSiTaxId(SI_TAX)).toBe(true)
    expect([SI_TAX_BAD, '1234567', '1234567890', 'SI12345678'].filter((t) => parseClaim({ ...TELO, taxId: t }).ok)).toEqual([])
    expect(['', undefined].filter((t) => !parseClaim({ ...TELO, taxId: t as string }).ok)).toEqual([])
  })

  it('B6: država določi validacijo — HR OIB v SI profilu pade, na HR trgu gre skozi', async () => {
    const { parseClaim } = await claimModule()
    expect(parseClaim({ ...TELO, taxId: HR_OIB, country: 'SI' }).ok).toBe(false)
    expect(parseClaim({ ...TELO, taxId: HR_OIB, country: 'HR' }).ok).toBe(true)
    expect(parseClaim({ ...TELO, taxId: SI_TAX, country: 'HR' }).ok).toBe(false)
  })

  it('B7: neznan ključ ne pride v zapisan nabor (ne poznam `vloga`, ne `demo`)', async () => {
    const { parseClaim } = await claimModule()
    const r = parseClaim({ ...TELO, vloga: 'admin', demo: true })
    expect(r.ok).toBe(true)
    expect(Object.keys(r.value).sort()).toEqual(['businessId', 'country', 'email', 'pin', 'restaurantName', 'taxId'])
  })

  it('B8: napaka imenuje polje in nikoli ne ponovi vpisanega PIN-a', async () => {
    const { parseClaim } = await claimModule()
    const r = parseClaim({ ...TELO, pin: '123456789' })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.errors)).toContain('pin')
    expect(JSON.stringify(r)).not.toContain('123456789')
  })

  it('B9: telo ni JSON, je niz, je število ali je prazno → urejena napaka, ne nezajeta izjema', async () => {
    const { parseClaim } = await claimModule()
    const izjeme: string[] = []
    for (const sestavina of [undefined, null, 'niz', 42, [], {}]) {
      try {
        const r = parseClaim(sestavina)
        if (r.ok !== false) izjeme.push(`${JSON.stringify(sestavina)}: sprejet`)
      } catch (err) {
        izjeme.push(`${JSON.stringify(sestavina)}: izjema ${(err as Error).message}`)
      }
    }
    expect(izjeme).toEqual([])
  })
})

// ── §C — pot od HTTP-ja do `runLocalSetup` (lažne odvisnosti, zaresna odločitev) ──

function zahteva(telo: unknown, glave: Record<string, string> = {}) {
  return new Request('http://localhost/api/setup/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...glave },
    body: typeof telo === 'string' ? telo : JSON.stringify(telo),
  })
}

const DOKAZ = 'dokaz-fronte-v180'
const GLAVE_ZANKA = { 'x-forwarded-for': '127.0.0.1', 'x-local-front': DOKAZ }

const USPEH = {
  dataDir: 'C:/podatki',
  dbPath: 'C:/podatki/data/restaurantos.db',
  ownerCreated: true,
  existingEmployees: 0,
  journalMode: 'wal',
  ownerEmail: 'lastnik@primer.test',
}

function lazneOdvise(poklici: any[], o: { zaposleni?: number; lokalniProfil?: boolean; rezultat?: any; limit?: boolean } = {}) {
  return {
    employees: async () => o.zaposleni ?? 0,
    isLocalProfile: () => o.lokalniProfil ?? true,
    rateLimit: (_kljuc: string) => o.limit ?? true,
    complete: async (opts: any) => {
      poklici.push(opts)
      return o.rezultat ?? USPEH
    },
  }
}

describe('v1.180.0 §C — `claimWith` wiring', () => {
  it('C1: veljavna zahteva pokliče `runLocalSetup` z normirano identiteto in brez generiranja odjemalca', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(200)
    expect(poklici).toHaveLength(1)
    expect(poklici[0]).toMatchObject({
      restaurantName: 'Gostilna Zeleni Hrib',
      ownerEmail: 'lastnik@primer.test',
      ownerPin: '481516',
      taxId: SI_TAX,
      businessId: 'SI-ZN-1234',
      allowGenerate: false,
    })
  })

  it('C2: ponarejen `x-forwarded-for: 127.0.0.1` brez dokaza fronte = 403 in nikakršen zapis', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, { 'x-forwarded-for': '127.0.0.1' }), DOKAZ)
    expect(res.status).toBe(403)
    expect(poklici).toHaveLength(0)
  })

  it('C3: dokazana fronta, a pravi klient je tablica v LAN = 403 (zanka je pogoj, ne okras)', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, { 'x-forwarded-for': '10.0.0.9', 'x-local-front': DOKAZ }), DOKAZ)
    expect(res.status).toBe(403)
    expect(poklici).toHaveLength(0)
  })

  it('C4: manjkajoča installationska skrivnost (brez `APP_SECRET`) = 403, ne 500 in ne prevzem', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, GLAVE_ZANKA), null)
    expect(res.status).toBe(403)
    expect(poklici).toHaveLength(0)
  })

  it('C5: oblak (ne-`file:` DATABASE_URL) = 403 `profil`, preden se sploh prebere baza', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    let brano = 0
    const deps = {
      employees: async () => {
        brano++
        return 0
      },
      isLocalProfile: () => false,
      rateLimit: () => true,
      complete: async (opts: any) => {
        poklici.push(opts)
        return USPEH
      },
    }
    const res = await claimWith(deps, zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(403)
    expect(brano).toBe(0)
    expect(poklici).toHaveLength(0)
  })

  it('C6: zasedena namestitev = 409 in nikoli ne pokliče `complete` (ne piše čez obstoječe podatke)', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici, { zaposleni: 7 }), zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(409)
    expect(poklici).toHaveLength(0)
  })

  it('C7: neveljavno telo = 400 s seznamom polj, brez branja števila zaposlenih', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    let brano = 0
    const deps = {
      employees: async () => {
        brano++
        return 0
      },
      isLocalProfile: () => true,
      rateLimit: () => true,
      complete: async (opts: any) => {
        poklici.push(opts)
        return USPEH
      },
    }
    const res = await claimWith(deps, zahteva({ ...TELO, taxId: SI_TAX_BAD }, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(400)
    expect(brano).toBe(0)
    expect(poklici).toHaveLength(0)
    expect(Object.keys((await res.json()).errors)).toContain('taxId')
  })

  it('C8: smeti namesto JSON-a = 400, ne nezajeta izjema', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva('{ni json', GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(400)
    expect(poklici).toHaveLength(0)
  })

  it('C9: 200 NE vrne PIN-a, ki ga je izbral lastnik — niti v vrednosti niti v ključu `pin`', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici, { rezultat: { ...USPEH, pin: '481516' } }), zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    const besedilo = await res.text()
    expect(res.status).toBe(200)
    expect(besedilo).not.toContain('481516')
    expect(besedilo).not.toMatch(/"pin"/)
  })

  it('C10: odgovor vsebuje natisljivo sled iz ISTEME vira kot datoteka (`credentialsSheet`)', async () => {
    const { claimWith } = await routeModule()
    const { credentialsSheet } = await claimModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    const telo = await res.json()
    expect(typeof telo.sheet).toBe('string')
    expect(telo.sheet.length).toBeGreaterThan(80)
    expect(telo.sheet).toBe(
      credentialsSheet({
        restaurantName: 'Gostilna Zeleni Hrib',
        ownerEmail: 'lastnik@primer.test',
        dataDir: 'C:/podatki',
        dbPath: 'C:/podatki/data/restaurantos.db',
        taxId: SI_TAX,
      }),
    )
  })

  it('C11: če `runLocalSetup` vrže, je odgovor 500 s slovenskim sporočilom in ne razkrije notranjosti', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const deps = {
      employees: async () => 0,
      isLocalProfile: () => true,
      rateLimit: () => true,
      complete: async () => {
        throw new Error('[local] Prisma (db push) je prekinil ukaz. SQLITE_LOGIC_ERROR skriti detajl')
      },
    }
    const res = await claimWith(deps, zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(500)
    const telo = await res.json()
    expect(telo.ok).toBe(false)
    expect(JSON.stringify(telo).toLowerCase()).toContain('namestitev')
    expect(JSON.stringify(telo)).not.toContain('SQLITE_LOGIC_ERROR')
  })

  it('C12: limit je vezan na IP klientovega, ne na `unknown` (brez fronte bi bili vsi v istem košu)', async () => {
    const { claimWith } = await routeModule()
    const kljuci: string[] = []
    const poklici: any[] = []
    const deps = { ...lazneOdvise(poklici), rateLimit: (k: string) => (kljuci.push(k), true) }
    await claimWith(deps, zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(kljuci).toHaveLength(1)
    expect(kljuci[0]).toContain('127.0.0.1')
    expect(kljuci[0]).not.toContain('unknown')
  })

  it('C13: presežen limit = 429 in `complete` ne pokliče', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici, { limit: false }), zahteva(TELO, GLAVE_ZANKA), DOKAZ)
    expect(res.status).toBe(429)
    expect(poklici).toHaveLength(0)
  })

  it('C14: `POST` je izvožen, `GET` ne (metoda, ki je ne sme biti, = 405)', async () => {
    const m = await routeModule()
    expect(typeof m.POST).toBe('function')
    expect(m.GET).toBeUndefined()
  })

  it('C15: glava `x-local-front` se ne primerja z `includes` — niz, ki je prefix, ne zadostuje', async () => {
    const { claimWith } = await routeModule()
    const poklici: any[] = []
    const res = await claimWith(lazneOdvise(poklici), zahteva(TELO, { 'x-forwarded-for': '127.0.0.1', 'x-local-front': DOKAZ.slice(0, 4) }), DOKAZ)
    expect(res.status).toBe(403)
    expect(poklici).toHaveLength(0)
  })
})

// ── §D — natisljive poverilnice: en vir, dva izpisa ──────────────────────────

describe('v1.180.0 §D — `credentialsSheet`', () => {
  const OSNOVA = {
    restaurantName: 'Gostilna Zeleni Hrib',
    ownerEmail: 'lastnik@primer.test',
    dataDir: 'C:/podatki',
    dbPath: 'C:/podatki/data/restaurantos.db',
  }

  it('D1: sled vsebuje ime obrata, prijavo, podatkovno mapo, bazo in davčno številko', async () => {
    const { credentialsSheet } = await claimModule()
    const sled = credentialsSheet({ ...OSNOVA, taxId: SI_TAX })
    const potrebuje = ['Gostilna Zeleni Hrib', 'lastnik@primer.test', 'C:/podatki', 'restaurantos.db', SI_TAX]
    expect(potrebuje.filter((del) => !sled.includes(del))).toEqual([])
  })

  it('D2: izpis ZA BRSKALNIK PIN-a razkrije nikoli, izpis ZA DATOTEKO (0600) ga vedno', async () => {
    const { credentialsSheet } = await claimModule()
    expect(credentialsSheet({ ...OSNOVA, pin: '481516' })).not.toContain('481516')
    expect(credentialsSheet({ ...OSNOVA, pin: '481516', pinMode: 'reveal' })).toContain('481516')
  })

  it('D3: `local-setup.ts` piše datoteko skozi `credentialsSheet`, ne več iz lastnih vrstic', () => {
    const mod = read('src/lib/local-setup.ts')
    expect(mod).toMatch(/credentialsSheet\(/)
    expect(mod).not.toMatch(/function firstRunCredentials/)
  })

  it('D4: datoteka poverilnic ostane 0600', () => {
    expect(read('src/lib/local-setup.ts')).toMatch(/mode:\s*0o600/)
  })
})

// ── §E — front mora izvoru povedati resnico o klientu ─────────────────────────

describe('v1.180.0 §E — `glaveZaVir` (edini pošten vir IP-ja je soket fronte)', () => {
  it('E1: gradnik glav je izvožen — dokler je zaseben, ga ni mogoče preizkusiti', async () => {
    const m = await frontModule()
    expect(typeof (m as any).glaveZaVir).toBe('function')
  })

  it('E2: PRAVI naslov soketa prepiše client-supplied `x-forwarded-for` in se ne prilepi', async () => {
    const { glaveZaVir } = await frontModule()
    const req = { headers: { host: 'primer.si:3443', 'x-forwarded-for': '8.8.8.8', cookie: 'a=1' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }
    const glave = glaveZaVir(req, false, 3443, DOKAZ)
    expect(glave['x-forwarded-for']).toBe('127.0.0.1')
    expect(glave['cookie']).toBe('a=1')
  })

  it('E3: klient brez obstoječe glave dobi svoj pravi naslov, preslikana IPv4 je razpakirana', async () => {
    const { glaveZaVir } = await frontModule()
    const req = { headers: { host: '10.0.0.5:3443' }, socket: { remoteAddress: '::ffff:10.0.0.9' } }
    expect(glaveZaVir(req, false, 3443, DOKAZ)['x-forwarded-for']).toBe('10.0.0.9')
  })

  it('E4: dokaz fronte je nastavljen samo, kadar ga je launcher podal; brez njega glava ni', async () => {
    const { glaveZaVir } = await frontModule()
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    expect(glaveZaVir(req, false, 3443, DOKAZ)['x-local-front']).toBe(DOKAZ)
    expect('x-local-front' in glaveZaVir(req, false, 3443, null)).toBe(false)
  })

  it('E5: `localFrontProof(appSecret)` = 64 hex znakov, determiniran in različen po sekretu', async () => {
    const { localFrontProof } = await claimModule()
    const a = localFrontProof('sekret-1')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(localFrontProof('sekret-1'))
    expect(localFrontProof('sekret-2')).not.toBe(a)
    expect(localFrontProof('')).not.toBe(a)
  })

  it('E6: dosedanje ohranjene glave fronte (v1.175.0) ostanejo: proto, host, port', async () => {
    const { glaveZaVir } = await frontModule()
    const req = { headers: { host: 'primer.si:3443' }, socket: { remoteAddress: '127.0.0.1' } }
    const glave = glaveZaVir(req, false, 3443, DOKAZ)
    expect(glave['x-forwarded-proto']).toBe('https')
    expect(glave['x-forwarded-host']).toBe('primer.si:3443')
    expect(glave['x-forwarded-port']).toBe('3443')
  })

  it('E7: front in launcher sta povezana prek dokaza (`startLocalHttpsFront` ga sprejme in posreduje)', async () => {
    expect(read('src/lib/local-https-front.ts')).toMatch(/frontProof/)
    expect(read('scripts/local-start.ts')).toMatch(/frontProof/)
  })

  /**
   * Izpust klientovega `x-forwarded-for` (front:82) je samostojna varovalka: ko
   * front ne more prebrati nasloka soketa, noben prepis ne nastopi in tuja trditev
   * bi potovala naprej kot dejstvo. Aplikacija jo mora dojeti kot „ne vem", sicer
   * je prevzem namestitve mamljiv z eno glavo.
   */
  it('E8: brez nasloka soketa klientova trditev o IP-ju ne potuje naprej (glava je odsotna)', async () => {
    const { glaveZaVir } = await frontModule()
    const req = { headers: { 'x-forwarded-for': '127.0.0.1' }, socket: {} }
    expect('x-forwarded-for' in glaveZaVir(req, false, 3443, DOKAZ)).toBe(false)
  })
})

// ── §F — čarovnik v brskalniku (merilo: štiri polja brez terminala) ──────────

describe('v1.180.0 §F — `src/app/setup/page.tsx`', () => {
  it('F1: čarovnik ponudi VSAKA štiri identifikacijska polja z imenovano glavo', () => {
    const src = read('src/app/setup/page.tsx')
    const POLJA: Array<[string, string]> = [
      ['restaurantName', 'Ime obrata'],
      ['taxId', 'Davčna številka'],
      ['email', 'E-pošta lastnika'],
      ['pin', 'PIN'],
    ]
    const manjkajoc = POLJA.flatMap(([id, ime]) => {
      const tezave: string[] = []
      if (!new RegExp(`id="${id}"`).test(src)) tezave.push(`manjka id="${id}"`)
      if (!new RegExp(`htmlFor="${id}"`).test(src)) tezave.push(`manjka htmlFor="${id}"`)
      if (!src.includes(ime)) tezave.push(`manjka besedilo „${ime}"`)
      return tezave
    })
    expect(manjkajoc).toEqual([])
  })

  it('F2: stanje se bere iz `/api/setup/status`, oddaja gre na `/api/setup/claim`', () => {
    const src = read('src/app/setup/page.tsx')
    expect(src).toContain('/api/setup/status')
    expect(src).toContain('/api/setup/claim')
    expect(src).toMatch(/method:\s*['"]POST['"]/)
  })

  it('F3: opozorilo, kdaj čarovnik ne more delovati (brez fronte, oblačni profil), je na strani', () => {
    const src = read('src/app/setup/page.tsx')
    expect(src).toMatch(/--https/)
    expect(src).toMatch(/zank|localhost/i)
    expect(src).toMatch(/profil|oblak/i)
  })

  it('F4: poverilnice so natisljive — `print:` ali `@media print` in dejanje tiskanja', () => {
    const src = read('src/app/setup/page.tsx')
    expect(src).toMatch(/print:|@media print/)
    expect(src).toMatch(/window\.print|Natisni/)
  })

  it('F5: nov zaslon ne poslabša WCAG-meril iz v1.177.0 in v1.179.0 (obe paleti)', () => {
    const kršitve = lintJsxString(read('src/app/setup/page.tsx'))
    expect(kršitve.map((v) => `${v.rule}: ${v.message}`)).toEqual([])
  })

  it('F6: nova pot ne vsebuje javnih demo PIN-ov in ne kliče demo seje', () => {
    const REL = ['src/app/setup/page.tsx', 'src/app/api/setup/claim/route.ts', 'src/lib/setup-claim.ts']
    const kršitve = REL.flatMap((rel) => {
      const src = read(rel)
      const out: string[] = []
      if (/\b(1234|2345)\b/.test(src)) out.push(`${rel}: javni demo PIN`)
      if (/seed|DEMO_LOGIN/.test(src)) out.push(`${rel}: sklic na demo sejo`)
      return out
    })
    expect(kršitve).toEqual([])
  })

  it('F7: kalibracijska sonda — F5 ne more zeleneti iz praznega nabora', () => {
    expect(lintJsxString('<div className="text-stone-400 bg-stone-500">x</div>').length).toBeGreaterThan(0)
  })

  it('F8: kalibracijska sonda — F1 ne more zeleneti, če polje obstaja a nima glave', () => {
    const brezGlave = '<input id="restaurantName" />'
    expect(new RegExp('id="restaurantName"').test(brezGlave)).toBe(true)
    expect(new RegExp('htmlFor="restaurantName"').test(brezGlave)).toBe(false)
  })

  it('F9: kalibracijska sonda — F6 ne more zeleneti na vzorcu, ki javni PIN vsebuje', () => {
    expect(/\b(1234|2345)\b/.test('const privzeto = "1234"')).toBe(true)
  })

  /**
   * Izmerjeno v živo (HTTPS fronta, 3543): zaslon PO PREVZEMU sploh ni imel naslova
   * — `document.querySelectorAll('h1,h2,h3')` je vrnil prazno sezono, medtem ko ga
   * obrazec pred tem ima. S tem sam prehod izgubi dokumentni okvir, po katerem se
   * bralnik zaslona giblje, in to prav na strani, kjer je edini uporabnikov
   * poverilnici. Merilo torej velja za VSAK zaslon čarovnika, ne samo za prvega.
   */
  it('F10: zaslon po prevzemu obdrži dokumentni okvir — tudi uspeh ima svoj naslov', () => {
    const src = read('src/app/setup/page.tsx')
    const zacetek = src.indexOf('if (uspeh)')
    const blok = src.slice(zacetek, src.indexOf('if (preverjam)', zacetek))
    expect(blok.length).toBeGreaterThan(40)
    expect(blok).toMatch(/<h1[\s>]/)
  })
})

// ── §G — nič od obstoječega ne sme izginiti ──────────────────────────────────

describe('v1.180.0 §G — brez regresa in brez novih skrivnosti', () => {
  it('G1: CLI ostane nepoškodovan, novima zastavicama pa doda razlago v pomoči', () => {
    const cli = read('scripts/local-setup.ts')
    const obstojec = ['--owner-email', '--owner-pin', '--restaurant-name', '--data-dir', '--json', '--no-generate', '--tax-id', '--business-id']
    expect(obstojec.filter((z) => !cli.includes(z))).toEqual([])
    const pomoc = spawnSync(process.execPath, [join(ROOT, 'scripts', 'local-setup.ts'), '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(pomoc.status).toBe(0)
    expect(pomoc.stdout).toContain('--tax-id')
    expect(pomoc.stdout).toContain('--business-id')
  })

  it('G2: `/api/setup/status` ostane javen in brez številk — razkrije samo profil in stanje', async () => {
    const { GET } = await import('../src/app/api/setup/status/route')
    const res = await GET(new Request('http://localhost/api/setup/status', { headers: { 'x-forwarded-for': '203.0.113.99' } }) as any)
    expect(res.status).toBe(200)
    const telo = await res.json()
    expect(telo.counts).toBe(null)
    expect(telo.databaseUrl).toBe('configured')
    expect(['local', 'cloud']).toContain(telo.mode)
    expect(typeof telo.isInitialized).toBe('boolean')
    expect(JSON.stringify(telo)).not.toMatch(/pin|secret|hash/i)
  })

  it('G3: nova ruta je registrirana kot javna z utemeljitvijo (sicer `route-coverage` pade)', () => {
    const rc = read('tests/route-coverage.test.ts')
    expect(rc).toMatch(/path: '\/api\/setup\/claim'/)
    expect(rc).toMatch(/methods: \['POST'\]/)
  })

  it('G4: `LocalSetupOptions` ostane nazaj združljiv in dobi identiteto kot neobvezni polji', () => {
    const mod = read('src/lib/local-setup.ts')
    expect(mod).toMatch(/taxId\?:\s*string/)
    expect(mod).toMatch(/businessId\?:\s*string/)
    expect(mod).toMatch(/allowGenerate\?:\s*boolean/)
    expect(mod).toMatch(/ownerPin\?:\s*string/)
  })

  it('G5: generiran PIN se vrne samo takrat, ko ga je ustvaril setup (neobstoječa razveljavitev v1.165.0)', () => {
    expect(read('src/lib/local-setup.ts')).toMatch(/ownerCreated && generated && pin/)
  })

  it('G6: čarovnik je povezan z obstoječo prijavo, sicer do njega ni poti brez terminala', () => {
    const prijava = read('src/app/page.tsx')
    expect(prijava).toMatch(/\/setup/)
  })
})

// ── §H — end-to-end: identiteta v stolpce in nadgradnja jo ohrani ────────────

const SETUP_CLI = join(ROOT, 'scripts', 'local-setup.ts')
const tempDirs: string[] = []
let e2eDir = ''
let e2eDb = ''

function zagon(dodatno: string[], mapa = e2eDir) {
  const r = spawnSync(process.execPath, [SETUP_CLI, '--data-dir', mapa, '--json', '--no-generate', ...dodatno], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DATABASE_URL: '' },
  })
  let json: any = null
  try {
    json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null')
  } catch {
    json = null
  }
  return { code: r.status ?? -1, out: r.stdout || '', err: r.stderr || '', json }
}

function lokacija(): Record<string, any> {
  const db = new Database(e2eDb, { readonly: true })
  try {
    return db.query('SELECT name, taxId, businessId, registerNumber FROM Location WHERE id = ?').get('local-main') as Record<string, any>
  } finally {
    db.close()
  }
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

describe('v1.180.0 §H — zaresen prvi zagon v začasno mapo', () => {
  it(
    'H1: `--tax-id` in `--business-id` prideta v stolpca `Location`, ne samo v besedilo datoteke',
    () => {
      e2eDir = mkdtempSync(join(tmpdir(), 'ros-v180-'))
      tempDirs.push(e2eDir)
      e2eDb = join(e2eDir, 'data', 'restaurantos.db')
      const prvi = zagon([
        '--owner-email', 'lastnik-v180@primer.test',
        '--owner-pin', '481516',
        '--restaurant-name', 'Gostilna Zeleni Hrib',
        '--tax-id', SI_TAX,
        '--business-id', 'SI-ZN-1234',
      ])
      expect(prvi.err).not.toContain('--accept-data-loss')
      expect(prvi.code).toBe(0)
      expect(prvi.json?.ownerCreated).toBe(true)
      expect(prvi.json?.journalMode).toBe('wal')

      const lok = lokacija()
      expect(lok.name).toBe('Gostilna Zeleni Hrib')
      expect(lok.taxId).toBe(SI_TAX)
      expect(lok.businessId).toBe('SI-ZN-1234')
      expect(lok.registerNumber ?? '').toBe('')

      const db = new Database(e2eDb, { readonly: true })
      try {
        const lastnik = db.query('SELECT pin, pinLookup, email, role FROM Employee WHERE id = ?').get('local-owner') as Record<string, any>
        expect(lastnik.pin).toBe(hashPin('481516', 'lastnik-v180@primer.test'))
        expect(lastnik.pin).not.toBe('481516')
        expect(lastnik.role).toBe('admin')
        expect((db.query("SELECT COUNT(*) AS n FROM Employee WHERE email LIKE '%restaurantos.app'").get() as { n: number }).n).toBe(0)
      } finally {
        db.close()
      }
      const datoteka = readFileSync(join(e2eDir, 'PRVIC-ZAGON.txt'), 'utf8')
      expect(datoteka).toContain('481516')
      expect(datoteka).toContain(SI_TAX)
    },
    { timeout: 240_000 },
  )

  it(
    'H2: ponovni zagon brez identitete ne prepiše tistega, kar je lastnik vmes popravil (nadgradnja ohrani podatke)',
    () => {
      if (!e2eDb) throw new Error('H1 ni ustvaril baze, zato H2 nima kaj preverjati')
      const db = new Database(e2eDb)
      try {
        db.run("UPDATE Location SET name = 'Ime, ki ga je lastnik popravil v nastavitvah' WHERE id = 'local-main'")
      } finally {
        db.close()
      }
      const datotekaPred = readFileSync(join(e2eDir, 'PRVIC-ZAGON.txt'), 'utf8')
      const drugi = zagon([])
      expect(drugi.code).toBe(0)
      expect(drugi.json?.ownerCreated).toBe(false)
      expect(drugi.json?.existingEmployees).toBe(1)

      const lok = lokacija()
      expect(lok.name).toBe('Ime, ki ga je lastnik popravil v nastavitvah')
      expect(lok.taxId).toBe(SI_TAX)
      expect(lok.businessId).toBe('SI-ZN-1234')
      expect(readFileSync(join(e2eDir, 'PRVIC-ZAGON.txt'), 'utf8')).toBe(datotekaPred)
    },
    { timeout: 240_000 },
  )

  it(
    'H3: izpraznjen stolpec se ob naslednjem zagonu dopolni, zasedenega pa nikoli ne prepiše',
    () => {
      if (!e2eDb) throw new Error('H1 ni ustvaril baze, zato H3 nima kaj preverjati')
      const db = new Database(e2eDb)
      try {
        db.run("UPDATE Location SET taxId = '' WHERE id = 'local-main'")
      } finally {
        db.close()
      }
      expect(lokacija().taxId).toBe('')
      expect(zagon(['--tax-id', SI_TAX]).code).toBe(0)
      expect(lokacija().taxId).toBe(SI_TAX)

      const treti = zagon(['--tax-id', SI_TAX_2, '--business-id', 'NE-SME-PREPISATI'])
      expect(treti.code).toBe(0)
      expect(lokacija().taxId).toBe(SI_TAX)
      expect(lokacija().businessId).toBe('SI-ZN-1234')
    },
    { timeout: 240_000 },
  )

  it(
    'H4: napačna davčna številka pade že v CLI in ne pusti pol-baze',
    () => {
      if (!e2eDb) throw new Error('H1 ni ustvaril baze, zato H4 nima kaj preverjati')
      const napacni = zagon(['--tax-id', SI_TAX_BAD])
      expect(napacni.code).not.toBe(0)
      expect(`${napacni.out}\n${napacni.err}`).toMatch(/davč|taxId/i)
      expect(lokacija().taxId).toBe(SI_TAX)
    },
    { timeout: 240_000 },
  )
})

// ── §I — če identiteto določi brskalnik, terminal ne sme priti pred njega ─────

/**
 * Merilo R3 („nova namestitev brez terminala") je bilo do tukaj izpolnjeno le
 * na pol: `bun run local --https` je vedno ustvaril lastnika z privzetim imenom in
 * naključnim PIN-om v `PRVIC-ZAGON.txt`, brskalniški prevzem pa zahteva PRAZNO
 * bazo (§A3). Čarovnik je torej bil dostopen samo tistemu, ki je vedel, da sme
 * odpreti bazo brez uvoza — torej nikomur. Odločitev, kdo določi identiteto, mora
 * biti ena sama funkcija, sicer se launcher in CLI razidreta.
 */
describe('v1.180.0 §I — z `--https` identiteto prevzame brskalnik', () => {
  it('I1: `provisionFromTerminal` — brez fronte vedno terminal, z fronto brez zastavic nikoli', async () => {
    const { provisionFromTerminal } = await claimModule()
    expect(provisionFromTerminal({ https: false, identityGiven: false })).toBe(true)
    expect(provisionFromTerminal({ https: false, identityGiven: true })).toBe(true)
    expect(provisionFromTerminal({ https: true, identityGiven: true })).toBe(true)
    expect(provisionFromTerminal({ https: true, identityGiven: false })).toBe(false)
  })

  it(
    'I2: zagon, ki čaka na brskalnik, ne ustvari ničesar in ne izda poverilnic',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ros-v180-cakam-'))
      tempDirs.push(dir)
      const r = zagon(['--wait-for-browser'], dir)
      expect(r.code).toBe(0)
      expect(r.json?.setupPending).toBe(true)
      expect(r.json?.ownerCreated).toBe(false)
      expect(r.json?.pin ?? '').toBe('')
      expect(existsSync(join(dir, 'PRVIC-ZAGON.txt'))).toBe(false)
      // Baza MORA obstajati in biti pripravljena (push + WAL): brskalniški prevzem
      // piše vanjo, sicer bi čakal na prazno skledo.
      expect(r.json?.journalMode).toBe('wal')
      const db = new Database(join(dir, 'data', 'restaurantos.db'), { readonly: true })
      try {
        expect(db.query('SELECT COUNT(*) AS n FROM Employee').get()).toEqual({ n: 0 })
        expect(db.query('SELECT COUNT(*) AS n FROM Location').get()).toEqual({ n: 0 })
      } finally {
        db.close()
      }
    },
    { timeout: 240_000 },
  )

  it(
    'I3: če se lastnik premisli, naslednji zagon z zastavicami obrat vseeno ustanovi',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ros-v180-premisli-'))
      tempDirs.push(dir)
      expect(zagon(['--wait-for-browser'], dir).json?.setupPending).toBe(true)
      const drugi = zagon(['--restaurant-name', 'Gostilna Premislek', '--owner-pin', '741852', '--tax-id', SI_TAX], dir)
      expect(drugi.code).toBe(0)
      expect(drugi.json?.ownerCreated).toBe(true)
      const db = new Database(join(dir, 'data', 'restaurantos.db'), { readonly: true })
      try {
        expect(db.query('SELECT COUNT(*) AS n FROM Employee').get()).toEqual({ n: 1 })
        expect(db.query('SELECT name FROM Location').get()).toEqual({ name: 'Gostilna Premislek' })
      } finally {
        db.close()
      }
      expect(existsSync(join(dir, 'PRVIC-ZAGON.txt'))).toBe(true)
    },
    { timeout: 240_000 },
  )

  it('I4: launcher sprejme odločitev IN pove lastniku, kam naj odpre brskalnik', () => {
    const launcher = read('scripts/local-start.ts')
    expect(launcher).toMatch(/provisionFromTerminal/)
    expect(launcher).toMatch(/provisionOwner/)
    expect(launcher).toMatch(/\/setup/)
  })

  it('I5: čarovnik ob prazni bazi ne sme ostati brez vsebine — pot `setup` obstaja v aplikaciji', () => {
    expect(existsSync(join(ROOT, 'src', 'app', 'setup', 'page.tsx'))).toBe(true)
    expect(read('src/app/setup/page.tsx')).toMatch(/data-screen="setup"/)
  })
})
