/**
 * v1.217.0 (R4b del 2) — PODPISANI NADGRADNI PAKET (PRD
 * docs/PRD-LOKALNA-BAZA.md §8, R4b: »podpisani paket«).
 *
 * Zakaj sploh in zakaj tako:
 *  - v1.216.0 (del 1) je prinesel obveščanje o novi različici in v mejah
 *    zapisal: »pred podpisanim paketom je to obveščanje, ne varnostna meja«.
 *    Ta val je ta ostanek kot ORODJE: program ne more izdati zaupanja
 *    (ključ je lastnikov, PRD §13), zmore pa: keygen, podpis, preverbo in
 *    zamenjavo kode z varnostno kopijo — in vsak korak mora pasti točno tam,
 *    kjer laže, če je pokvarjen. Ti testi so ta padec.
 *  - vzorec testov je R5a (v182-offsite-backup): roundtrip čez disk, matrika
 *    odpovedi z RAZLOGOM (ne le »false«), obramba v globini (žigi se
 *    preverjajo TUDI takrat, ko podpis formalno zadosti — podpisnik z.l. bi
 *    mogel sestaviti paket z lažnim manifestom, sprehod po telesu ga ulovi).
 *
 * Kaj je tudokaj DOKAZANO (in kaj namerno ni):
 *  - determinizem gradnje (enak vir + enak ključ + enak čas = enak paket) —
 *    izmerjeno nad gzip (determinističen v bun) + Ed25519 (RFC 8032) +
 *    fiksno zgrajeno glavo (JSON vstavljanje po vrsti);
 *  - podpis pokriva TOČNO bajte, kot so zapisani: sprememba ENEGA bajta
 *    kjerkoli (glava, telo, podpis sam) pade;
 *  - apply je VSE ALI NIČ: napaka sredi zamenjave razveljavi vse zamenjano
 *    in pusti namestitev v prejšnjem stanju (namerno omogočen tudi ROLLBACK
 *    prek resnične napake datotečnega sistema, ne preskoka testa);
 *  - ni pa tu dokazan prenos po omrežju (paket potuje po mediju, ki ga
 *    lastnik odnese sam — R5a vzorec; oblak ostaja R5b) niti zaupanje
 *    javnega ključa na ogroženi napravi (dokumentirana meja v LOKALNI-ZAGON).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  DIST_PACKAGES_DIR,
  ED25519_PUB_BYTES,
  ED25519_SEED_BYTES,
  SIGNING_KEYS_DIR,
  SIGNING_KEY_ENV,
  SIGNING_KEY_FILE,
  SIGNING_PUB_ENV,
  SIGNING_PUB_FILE,
  UPDATE_BACKUP_PREFIX,
  UPDATE_MAX_CODE_BACKUPS,
  UPDATE_PKG_EXT,
  UPDATE_PKG_FORMAT,
  UPDATE_PKG_MAX_CONTENT_BYTES,
  UPDATE_PKG_MAX_FILES,
  UPDATE_PKG_PREFIX,
  UPDATE_PKG_SIG_ALG,
  UPDATE_PKG_SIG_BYTES,
  applyUpdatePackage,
  buildUpdatePackage,
  collectUpdateSource,
  generateSigningKeyPair,
  guardPkgPath,
  inspectUpdatePackage,
  keyFingerprint,
  parseSigningPublicKey,
  parseSigningSeed,
  rawOfPublicKey,
  readInstalledVersion,
  readKeyFile,
  readSigningKeyEnv,
  readSigningPubEnv,
  seedOfPrivateKey,
  updatePackageNameFor,
  verifyUpdatePackage,
} from '../src/lib/update-package'
import { APP_VERSION } from '../src/lib/version'

const ROOT = join(import.meta.dir, '..')

const TMP = mkdtempSync(join(tmpdir(), 'v217-pkg-'))
const fiksniNow = new Date('2026-10-31T15:00:00.000Z')

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/** Par ključev za ta test ( vsak test lahko naredi svojega, ta je skupni). */
const lastnik = generateSigningKeyPair()
const tujec = generateSigningPairDrugi()

function generateSigningPairDrugi() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey }
}

const dveDatoteki = (): Array<{ path: string; bytes: Buffer }> => [
  { path: 'a-prva.txt', bytes: Buffer.from('vsebina A') },
  { path: 'b-druga.txt', bytes: Buffer.from('vsebina B, malo daljša') },
]

// ── Č1: ključi (čista logika) ────────────────────────────────────────────────

describe('v217 Č1 — ključi Ed25519 (čisti sloj)', () => {
  test('generateSigningKeyPair da seme in javni ključ točno 32 bajtov, oba berljiva', () => {
    expect(Buffer.from(lastnik.seedB64, 'base64').length).toBe(ED25519_SEED_BYTES)
    expect(Buffer.from(lastnik.pubB64, 'base64').length).toBe(ED25519_PUB_BYTES)
    expect(parseSigningSeed(lastnik.seedB64)).not.toBeNull()
    expect(parseSigningPublicKey(lastnik.pubB64)).not.toBeNull()
  })

  test('parseSigningSeed zavrne: ne-niz, smeti, 31 in 33 bajtov', () => {
    expect(parseSigningSeed(42)).toBeNull()
    expect(parseSigningSeed('ni-veljavna b64!!!')).toBeNull()
    expect(parseSigningSeed(Buffer.alloc(31).toString('base64'))).toBeNull()
    expect(parseSigningSeed(Buffer.alloc(33).toString('base64'))).toBeNull()
    expect(parseSigningSeed('')).toBeNull()
  })

  test('parseSigningPublicKey zavrne iste razrede smeti', () => {
    expect(parseSigningPublicKey(null)).toBeNull()
    expect(parseSigningPublicKey('%%%')).toBeNull()
    expect(parseSigningPublicKey(Buffer.alloc(31).toString('base64'))).toBeNull()
    expect(parseSigningPublicKey(Buffer.alloc(64).toString('base64'))).toBeNull()
  })

  test('seedOfPrivateKey/rawOfPublicKey sta inverzija parsanja', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    expect(parseSigningSeed(seedOfPrivateKey(privateKey))).not.toBeNull()
    expect(rawOfPublicKey(publicKey).toString('base64')).toBe(Buffer.from(rawOfPublicKey(publicKey)).toString('base64'))
  })

  test('keyFingerprint: 16 šestnajstiških znakov, determinističen, različen med ključi', () => {
    const a1 = keyFingerprint(lastnik.publicKey)
    const a2 = keyFingerprint(lastnik.publicKey)
    expect(a1).toBe(a2)
    expect(a1).toMatch(/^[0-9a-f]{16}$/)
    expect(keyFingerprint(tujec.publicKey)).not.toBe(a1)
  })

  test('readKeyFile odstrani EN končnik (LF in CRLF), brez trganja presledkov', async () => {
    const lf = join(TMP, 'k-lf.txt')
    const crlf = join(TMP, 'k-crlf.txt')
    writeFileSync(lf, 'abc123==\n')
    writeFileSync(crlf, 'abc123==\r\n')
    expect(readKeyFile(lf)).toBe('abc123==')
    expect(readKeyFile(crlf)).toBe('abc123==')
  })

  test('readKeyFile ob manjkajoči datoteki javi pošteno napako', () => {
    expect(() => readKeyFile(join(TMP, 'ni-je-tu.key'))).toThrow('Branje ključa')
  })

  test('readSigningKeyEnv / readSigningPubEnv: nenastavljeno in prazno → null, vrednost → vrne', () => {
    expect(readSigningKeyEnv({})).toBeNull()
    expect(readSigningKeyEnv({ [SIGNING_KEY_ENV]: '' })).toBeNull()
    expect(readSigningKeyEnv({ [SIGNING_KEY_ENV]: '  ' })).toBeNull()
    expect(readSigningKeyEnv({ [SIGNING_KEY_ENV]: 'xyz' })).toBe('xyz')
    expect(readSigningPubEnv({})).toBeNull()
    expect(readSigningPubEnv({ [SIGNING_PUB_ENV]: 'xyz' })).toBe('xyz')
  })

  test('ključ prihaja SAMO iz okolja/datoteke: skripte nosijo --key-file (POT, isti vzorec kot --passphrase-file offsite) in branje okolja, nikoli vrednost v argv', () => {
    for (const [skripta, envIme] of [
      ['local-package.ts', SIGNING_KEY_ENV],
      ['local-package-verify.ts', SIGNING_PUB_ENV],
      ['local-package-apply.ts', SIGNING_PUB_ENV],
    ] as const) {
      const vir = readFileSync(join(ROOT, 'scripts', skripta), 'utf8')
      // vir okolja je izrecno prebran
      expect(vir).toContain(envIme)
      // zastavica, ki sprejema POT do datoteke (ne vrednost), je dovoljena po vzorcu R5a
      if (skripta === 'local-package.ts') expect(vir).toContain('--key-file')
      // NE obstaja pa zastavica, ki bi nosila VREDNOST ključa kot argument (–-key brez -file)
      expect(vir).not.toMatch(/'--key'(?!-file)/)
      expect(vir).not.toMatch(/"--key"(?!-file)/)
    }
  })
})

// ── Č2: vrata gradnje ─────────────────────────────────────────────────────────

describe('v217 Č2 — vrata poti in gradnje', () => {
  test('guardPkgPath spusti veljavno relativno pot (tudi znotraj deploy/)', () => {
    expect(guardPkgPath('src/lib/version.ts')).toBe('src/lib/version.ts')
    expect(guardPkgPath('deploy/.env.example')).toBe('deploy/.env.example')
    expect(guardPkgPath('public/pwa-icon-192.png')).toBe('public/pwa-icon-192.png')
  })

  test('guardPkgPath zavrne: skok ven, absolutna, poševnica nazaj, prazno, . in .. segmente, kontrolne znake, predolgo', () => {
    expect(() => guardPkgPath('../zunaj.txt')).toThrow('skok')
    expect(() => guardPkgPath('/absolutna.txt')).toThrow('absolutna')
    expect(() => guardPkgPath('C:\\windows\\x')).toThrow('absolutna')
    expect(() => guardPugPathNazaj('a\\b.txt')).toThrow('poševnico nazaj')
    expect(() => guardPkgPath('')).toThrow('ni veljaven niz')
    expect(() => guardPkgPath('a/./b')).toThrow('segment')
    expect(() => guardPkgPath('a/../b')).toThrow('segment')
    expect(() => guardPkgPath('a//b')).toThrow('segment')
    expect(() => guardPkgPath('a\u0000b')).toThrow('kontrolne')
    expect(() => guardPkgPath('x'.repeat(201))).toThrow('daljša')
  })

  function guardPugPathNazaj(p: string): string {
    return guardPkgPath(p)
  }

  test('gradnja zavrne neberljivo različico (1.217.0-beta ni trojka)', () => {
    expect(() => buildUpdatePackage({ files: dveDatoteki(), version: '1.217.0-beta', privateKey: lastnik.keyObject })).toThrow('trojka')
  })

  test('gradnja zavrne prazen seznam in podvojeno pot', () => {
    expect(() => buildUpdatePackage({ files: [], version: '1.0.0', privateKey: lastnik.keyObject })).toThrow('brez datotek')
    const podvojene = [...dveDatoteki(), { path: 'a-prva.txt', bytes: Buffer.from('x') }]
    expect(() => buildUpdatePackage({ files: podvojene, version: '1.0.0', privateKey: lastnik.keyObject })).toThrow('dvakrat')
  })

  test('meji sta živi (maxFiles / maxContentBytes) — zavrnitev, ne opomba', () => {
    expect(() => buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: lastnik.keyObject, maxFiles: 1 })).toThrow('meja')
    expect(() => buildUpdatePackage({ files: [{ path: 'velika.bin', bytes: Buffer.alloc(64) }], version: '1.0.0', privateKey: lastnik.keyObject, maxContentBytes: 32 })).toThrow('meja')
  })

  test('glava: manifest je SORTIRAN po poti in vsa križna polja se ujemajo', () => {
    const zgrajen = buildUpdatePackage({ files: dveDatoteki().reverse(), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    const poti = zgrajen.header.files.map((f) => f.path)
    expect(poti).toEqual([...poti].sort())
    expect(zgrajen.header.format).toBe(UPDATE_PKG_FORMAT)
    expect(zgrajen.header.sig).toBe(UPDATE_PKG_SIG_ALG)
    expect(zgrajen.header.fileCount).toBe(2)
    expect(zgrajen.header.contentBytes).toBe(Buffer.from('vsebina A').length + Buffer.from('vsebina B, malo daljša').length)
    expect(zgrajen.header.bodyBytes).toBeGreaterThan(0)
    expect(zgrajen.header.keyHint).toBe(keyFingerprint(lastnik.publicKey))
    expect(zgrajen.header.createdAt).toBe(fiksniNow.toISOString())
  })

  test('DETERMINIZEM: enak vir + ključ + čas → bajt-identičen paket (gzip + Ed25519 + fiksna glava)', () => {
    const a = buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    const b = buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(a.buffer.equals(b.buffer)).toBe(true)
  })

  test('drug ključ → drug paket (keyHint se razlikuje, podpis se razlikuje)', () => {
    const a = buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    const b = buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: tujec.privateKey, now: fiksniNow })
    expect(a.buffer.equals(b.buffer)).toBe(false)
    expect(a.header.keyHint).not.toBe(b.header.keyHint)
  })

  test('updatePackageNameFor: restaurantos-<verzija>.rospkg; neberljiva verzija → napaka', () => {
    expect(updatePackageNameFor('1.217.0')).toBe(`${UPDATE_PKG_PREFIX}1.217.0${UPDATE_PKG_EXT}`)
    expect(() => updatePackageNameFor('ni-verzija')).toThrow('trojka')
  })
})

// ── Č3: preverba — roundtrip in matrika posegov ───────────────────────────────

describe('v217 Č3 — podpis in celovitost', () => {
  const zgrajen = buildUpdatePackage({ files: dveDatoteki(), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })

  test('roundtrip: preverjen paket nosi glavo, žig sha256 celotne datoteke in dolžino', () => {
    const preverjen = verifyUpdatePackage(zgrajen.buffer, lastnik.publicKey)
    expect(preverjen.header.version).toBe('1.0.0')
    expect(preverjen.header.fileCount).toBe(2)
    expect(preverjen.totalBytes).toBe(zgrajen.buffer.length)
    expect(preverjen.sha256).toBe(zgrajen.sha256)
  })

  test('NAPAČEN KLJUČ: zavrnitev javi, KATERI ključ je podpisal (namig iz glave, ne ugiban)', () => {
    expect(() => verifyUpdatePackage(zgrajen.buffer, tujec.publicKey)).toThrow('podpisan z drugim ključem')
  })

  test('POSEG V TELO: en bajt v gzip telesu → podpis ni veljaven', () => {
    const pokvarjen = Buffer.from(zgrajen.buffer)
    const zacetekTela = zgrajen.buffer.indexOf(0x0a) + 1
    pokvarjen[zacetekTela + 2] ^= 0xff
    expect(() => verifyUpdatePackage(pokvarjen, lastnik.publicKey)).toThrow('Podpis paketa ni veljaven')
  })

  test('POSEG V GLAVO: sprememba verzije v JSON glavi → podpis ni veljaven', () => {
    const pokvarjen = Buffer.from(zgrajen.buffer)
    const tekstGlave = pokvarjen.subarray(0, pokvarjen.indexOf(0x0a)).toString('utf8')
    const zlobnaGlava = Buffer.from(tekstGlave.replace('"version":"1.0.0"', '"version":"9.9.9"') + '\n', 'utf8')
    expect(zlobnaGlava.length).toBe(pokvarjen.indexOf(0x0a) + 1) // enaka dolžina, brez premika
    const sestavljen = Buffer.concat([zlobnaGlava, pokvarjen.subarray(pokvarjen.indexOf(0x0a) + 1)])
    expect(() => verifyUpdatePackage(sestavljen, lastnik.publicKey)).toThrow('Podpis paketa ni veljaven')
  })

  test('POSEG V PODPIS: zadnji bajt → zavrnitev', () => {
    const pokvarjen = Buffer.from(zgrajen.buffer)
    pokvarjen[pokvarjen.length - 1] ^= 0x01
    expect(() => verifyUpdatePackage(pokvarjen, lastnik.publicKey)).toThrow('Podpis')
  })

  test('REZANJE: paket brez repa → nepopoln (obljubljena dolžina se ne ujema)', () => {
    const porezan = zgrajen.buffer.subarray(0, zgrajen.buffer.length - 10)
    expect(() => verifyUpdatePackage(porezan, lastnik.publicKey)).toThrow('nepopoln')
  })

  test('PRILEPRAVEK: dodatni bajti za repom → zavrnitev (nič se ne ignorira)', () => {
    const podaljšan = Buffer.concat([zgrajen.buffer, Buffer.from('smeti')])
    expect(() => verifyUpdatePackage(podaljšan, lastnik.publicKey)).toThrow('nepopoln')
  })

  test('inspect brez ključa prebere glavo; --inspect izpis ni "preverjen" (ločena resnici)', () => {
    const header = inspectUpdatePackage(zgrajen.buffer)
    expect(header.version).toBe('1.0.0')
    expect(header.fileCount).toBe(2)
  })

  test('inspect odpade nad smetmi (prekratko / brez glave / slab JSON)', () => {
    expect(() => inspectUpdatePackage(Buffer.alloc(4))).toThrow('prekratka')
    const brezVrstice = Buffer.from('x'.repeat(100)) // dovolj dolg, a brez 0x0a — vrata dolžine NE udarijo prva
    expect(() => inspectUpdatePackage(brezVrstice)).toThrow('glave')
    const slabJson = Buffer.from('{{{\\\n' + 'x'.repeat(100))
    expect(() => inspectUpdatePackage(slabJson)).toThrow('JSON')
  })

  test('fileCount, ki laže o manifestu, pade ŽE na inspect (pred podpisom)', () => {
    const kraj = zgrajen.buffer.indexOf(0x0a)
    const header = JSON.parse(zgrajen.buffer.subarray(0, kraj).toString('utf8'))
    header.fileCount = 5
    const zlobnaGlava = Buffer.from(`${JSON.stringify(header)}\n`)
    const telo = zgrajen.buffer.subarray(kraj + 1)
    expect(() => inspectUpdatePackage(Buffer.concat([zlobnaGlava, telo]))).toThrow('fileCount')
  })

  test('OBRAMBA V GLOBINO: PRAVILNO podpisan paket z LAŽNIM žigom datoteke pade na sprehodu manifesta', () => {
    const kraj = zgrajen.buffer.indexOf(0x0a)
    const header = JSON.parse(zgrajen.buffer.subarray(0, kraj).toString('utf8'))
    header.files[0].sha256 = '0'.repeat(64)
    const zlobnaGlava = Buffer.from(`${JSON.stringify(header)}\n`)
    const telo = zgrajen.buffer.subarray(kraj + 1, zgrajen.buffer.length - UPDATE_PKG_SIG_BYTES)
    const zlobniPodpis = sign(null, Buffer.concat([zlobnaGlava, telo]), lastnik.keyObject)
    const zlobni = Buffer.concat([zlobnaGlava, telo, zlobniPodpis])
    expect(() => verifyUpdatePackage(zlobni, lastnik.publicKey)).toThrow('sha256')
  })

  test('OBRAMBA V GLOBINO: pravilno podpisan paket s POKVARJENIM gzip telesom pade na razširitvi', () => {
    const kraj = zgrajen.buffer.indexOf(0x0a)
    const telo = Buffer.from(zgrajen.buffer.subarray(kraj + 1, zgrajen.buffer.length - UPDATE_PKG_SIG_BYTES))
    telo[3] ^= 0xff
    const glava = zgrajen.buffer.subarray(0, kraj + 1)
    const zlobniPodpis = sign(null, Buffer.concat([glava, telo]), lastnik.keyObject)
    expect(() => verifyUpdatePackage(Buffer.concat([glava, telo, zlobniPodpis]), lastnik.publicKey)).toThrow('gzip')
  })
})

// ── Č4: zbiranje vira ─────────────────────────────────────────────────────────

describe('v217 Č4 — zbiranje vira (ogledalo Dockerfile COPY + deploy/)', () => {
  test('zahteva vse korenske datoteke in mape — napaka našteje, kaj manjka', () => {
    const prazen = join(TMP, 'prazen-vir')
    mkdirSync(prazen, { recursive: true })
    expect(() => collectUpdateSource(prazen)).toThrow('manjka')
  })

  test('zbere strukturo, sortira poti in BAZO ZAVRŽE (prisma/dev.db ne sme v vir)', () => {
    const vir = join(TMP, 'vir')
    for (const m of ['prisma', 'public/img', 'src/lib', 'scripts', 'deploy']) mkdirSync(join(vir, m), { recursive: true })
    for (const f of ['package.json', 'bun.lock', 'next.config.ts', 'tsconfig.json', 'components.json', 'postcss.config.mjs', 'tailwind.config.ts']) {
      writeFileSync(join(vir, f), 'x')
    }
    writeFileSync(join(vir, 'prisma/schema.prisma'), 'model A {}')
    writeFileSync(join(vir, 'prisma/dev.db'), 'baza se ne pakira')
    writeFileSync(join(vir, 'prisma/dev.db-wal'), 'tudi rep ne')
    writeFileSync(join(vir, 'public/img/logo.svg'), '<svg/>')
    writeFileSync(join(vir, 'src/lib/version.ts'), "export const APP_VERSION = '1.0.0'")
    writeFileSync(join(vir, 'scripts/x.ts'), 'x')
    writeFileSync(join(vir, 'deploy/Dockerfile'), 'FROM x')

    const zbrano = collectUpdateSource(vir)
    const poti = zbrano.map((f) => f.path)
    expect(poti).toContain('package.json')
    expect(poti).toContain('prisma/schema.prisma')
    expect(poti).toContain('public/img/logo.svg')
    expect(poti).toContain('src/lib/version.ts')
    expect(poti).toContain('deploy/Dockerfile')
    expect(poti.filter((p) => p.endsWith('.db') || p.endsWith('.db-wal'))).toEqual([])
    expect(poti).toEqual([...poti].sort())
  })

  test('SIMBOLNE POVEZAVE (hotfix v1.217.1): povezava IZVEN drevesa NE pride v paket — zunanja vsebina ne more pristati v podpisani datoteki', () => {
    const zunanja = join(TMP, 'zunanja-skrivnost.txt')
    writeFileSync(zunanja, 'SECRETTOKEN123')
    const vir = join(TMP, 'vir-sym')
    for (const m of ['prisma', 'public/img', 'src/lib', 'scripts', 'deploy']) mkdirSync(join(vir, m), { recursive: true })
    for (const f of ['package.json', 'bun.lock', 'next.config.ts', 'tsconfig.json', 'components.json', 'postcss.config.mjs', 'tailwind.config.ts']) {
      writeFileSync(join(vir, f), 'x')
    }
    writeFileSync(join(vir, 'src/lib/version.ts'), 'x')
    symlinkSync(zunanja, join(vir, 'public', 'img', 'skrivnost.txt')) // povezava NAVZVEN
    symlinkSync(join(TMP, 'ne-obstaja-nikoli'), join(vir, 'public', 'img', 'zlomljena.txt')) // ZLOMLJENA

    // v1.217.0 je tu sledila povezavi (zunanja vsebina bi pristala v paketu) in
    // padla na zlomljeni z surovim ENOENT — izmerjeno pred popravkom.
    const zbrano = collectUpdateSource(vir)
    const poti = zbrano.map((f) => f.path)
    expect(poti).not.toContain('public/img/skrivnost.txt')
    expect(poti).not.toContain('public/img/zlomljena.txt')
    // vsebina zunanjega cilja ne sme biti v NOVEM bajtu paketa:
    expect(zbrano.some((f) => f.bytes.toString().includes('SECRETTOKEN'))).toBe(false)
    // gradnja nad takim virom uspe in je paket PREVERJiv (povezave so tiho izven)
    const zgrajen = buildUpdatePackage({ files: zbrano, version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(verifyUpdatePackage(zgrajen.buffer, lastnik.publicKey).header.fileCount).toBe(zbrano.length)
  })

  test('SIMBOLNA POVEZAVA na korenski datoteki (package.json → zunanji cilj): zbiranje jo zavrne kot »manjka« (ne sledi)', () => {
    const zunanja = join(TMP, 'korenska-zunanja.txt')
    writeFileSync(zunanja, 'TUJA VSEBINA')
    const vir = join(TMP, 'vir-root-sym')
    for (const m of ['prisma', 'public', 'src/lib', 'scripts', 'deploy']) mkdirSync(join(vir, m), { recursive: true })
    for (const f of ['bun.lock', 'next.config.ts', 'tsconfig.json', 'components.json', 'postcss.config.mjs', 'tailwind.config.ts']) {
      writeFileSync(join(vir, f), 'x')
    }
    writeFileSync(join(vir, 'src/lib/version.ts'), 'x')
    symlinkSync(zunanja, join(vir, 'package.json')) // korenska datoteka JE povezava

    expect(() => collectUpdateSource(vir)).toThrow('manjka package.json')
  })
})

// ── Č5: apply — zamenjava kode ────────────────────────────────────────────────

describe('v217 Č5 — nadgradnja namestitve (apply)', () => {
  function mkRoot(mapa: string, verzija = '1.0.0'): string {
    mkdirSync(join(mapa, 'src/lib'), { recursive: true })
    writeFileSync(join(mapa, 'package.json'), '{"name":"fixture"}')
    writeFileSync(join(mapa, 'src/lib/version.ts'), `export const APP_VERSION = '${verzija}'\n`)
    writeFileSync(join(mapa, 'a-stara.txt'), 'stara vsebina')
    writeFileSync(join(mapa, 'nedotaknjeno.txt'), 'to se ne sme spremeniti')
    return mapa
  }

  const paketDatoteke = (verzija: string): Array<{ path: string; bytes: Buffer }> => [
    { path: 'a-stara.txt', bytes: Buffer.from('nova vsebina') },
    { path: 'b-nova.txt', bytes: Buffer.from('novo datoteka') },
    { path: 'src/lib/version.ts', bytes: Buffer.from(`export const APP_VERSION = '${verzija}'\n`) },
  ]

  const dbPotKiNi = join(TMP, 'baze-ni', 'restaurantos.db')

  test('uspešna zamenjava: zamenjane + nove + kopija stare kode + nedotaknjeno ostane', () => {
    const root = mkRoot(join(TMP, 'apply-ok'))
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.1'), version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    const rezultat = applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => false })
    expect(rezultat.replaced).toBe(2) // a-stara.txt + src/lib/version.ts
    expect(rezultat.created).toBe(1) // b-nova.txt
    expect(readFileSync(join(root, 'a-stara.txt'), 'utf8')).toBe('nova vsebina')
    expect(readFileSync(join(root, 'b-nova.txt'), 'utf8')).toBe('novo datoteka')
    expect(readFileSync(join(root, 'nedotaknjeno.txt'), 'utf8')).toBe('to se ne sme spremeniti')
    expect(readInstalledVersion(root)).toBe('1.0.1')
    // kopija stare kode nosi STARO vsebino in zapis o zamenjavi
    expect(existsSync(join(rezultat.backupDir, 'a-stara.txt'))).toBe(true)
    expect(readFileSync(join(rezultat.backupDir, 'a-stara.txt'), 'utf8')).toBe('stara vsebina')
    const zapis = JSON.parse(readFileSync(join(rezultat.backupDir, 'zamenjava.json'), 'utf8'))
    expect(zapis.from).toBe('1.0.0')
    expect(zapis.to).toBe('1.0.1')
    expect(rezultat.recipe.length).toBe(4)
  })

  test('vrata različice: enaka/starejša brez --force → zavrnitev, disk nedotaknjen', () => {
    const root = mkRoot(join(TMP, 'apply-vrata'))
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.0'), version: '1.0.0', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(() => applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => false })).toThrow('vračanje kode')
    expect(readFileSync(join(root, 'a-stara.txt'), 'utf8')).toBe('stara vsebina')
    // z --force gre (nalašč vračanje kode, npr. slaba izdaja)
    const rezultat = applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => false, force: true })
    expect(rezultat.replaced).toBe(2)
  })

  test('varovalka tečeče aplikacije: poln -wal → zavrnitev pred vsakim zapisom', () => {
    const root = mkRoot(join(TMP, 'apply-busy'))
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.1'), version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(() => applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => true })).toThrow('teče')
    expect(readFileSync(join(root, 'a-stara.txt'), 'utf8')).toBe('stara vsebina')
  })

  test('napačen ključ: zavrnitev pred dotikom diska (podpis je prva vrata)', () => {
    const root = mkRoot(join(TMP, 'apply-tuj'))
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.1'), version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(() => applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: tujec.publicKey, isBusy: () => false })).toThrow('drugim ključem')
    expect(readFileSync(join(root, 'a-stara.txt'), 'utf8')).toBe('stara vsebina')
  })

  test('ni koren namestitve: zavrnitev z razlago', () => {
    const prazen = join(TMP, 'ni-koren')
    mkdirSync(prazen, { recursive: true })
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.1'), version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    expect(() => applyUpdatePackage({ buffer: paket.buffer, root: prazen, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => false })).toThrow('koren namestitve')
  })

  test('VSE ALI NIČ: napaka sredi pisanja razveljavi zamenjano in pobriše novo (resnična napaka datotečnega sistema)', () => {
    const root = mkRoot(join(TMP, 'apply-rollback'))
    // 'fuss' je OBIČAJNA DATOTEKA — pisanje fuss/x.txt pade na mkdir (ENOTDIR).
    // Vrstni red manifesta je sortiran: a-stara.txt se zapiše PRVI (uspe),
    // fuss/x.txt pade NAPREJ — razveljavitev mora vrniti a-stara.txt.
    writeFileSync(join(root, 'fuss'), 'ovira')
    const datoteke = [
      ...paketDatoteke('1.0.1'),
      { path: 'fuss/x.txt', bytes: Buffer.from('nikoli ne bo zapisan') },
    ]
    const paket = buildUpdatePackage({ files: datoteke, version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    let ulovljeno: unknown
    try {
      applyUpdatePackage({ buffer: paket.buffer, root, dbPath: dbPotKiNi, publicKey: lastnik.publicKey, isBusy: () => false })
    } catch (err) {
      ulovljeno = err
    }
    expect(ulovljeno).toBeInstanceOf(Error)
    expect((ulovljeno as Error).message).toContain('RAZVELJAVLJENA')
    // namestitev je v PREJŠNJEM stanju — ne polovična
    expect(readFileSync(join(root, 'a-stara.txt'), 'utf8')).toBe('stara vsebina')
    expect(readFileSync(join(root, 'fuss'), 'utf8')).toBe('ovira')
    expect(readInstalledVersion(root)).toBe('1.0.0')
    expect(existsSync(join(root, 'b-nova.txt'))).toBe(false)
    // kopija padle nadgradnje se POBRIŠE (ni smeti iz neuspeha)
    const ostanki = readdirSync(root).filter((ime) => ime.startsWith(UPDATE_BACKUP_PREFIX))
    expect(ostanki).toEqual([])
  })

  test('zadrževanje: po 4 zamenjavah ostanejo 3 kopije, najstarejša je počiščena', () => {
    const root = mkRoot(join(TMP, 'apply-prune'))
    const paket = buildUpdatePackage({ files: paketDatoteke('1.0.1'), version: '1.0.1', privateKey: lastnik.keyObject, now: fiksniNow })
    for (let i = 0; i < 4; i++) {
      applyUpdatePackage({
        buffer: paket.buffer,
        root,
        dbPath: dbPotKiNi,
        publicKey: lastnik.publicKey,
        isBusy: () => false,
        force: true,
        now: new Date(fiksniNow.getTime() + i * 1000),
      })
    }
    // readdirSync vrstni red ni zagotovljen — razvrstimo pred primerjavo (ulov lastnega testa)
    const kopije = readdirSync(root).filter((ime) => ime.startsWith(UPDATE_BACKUP_PREFIX)).sort()
    expect(kopije.length).toBe(UPDATE_MAX_CODE_BACKUPS)
    // najstarejša kopija (žig prve zamenjave, 15-00-00) je počiščena — to je trditev o zadrževanju
    expect(kopije).not.toContain(`${UPDATE_BACKUP_PREFIX}2026-10-31T15-00-00-000Z`)
    expect(kopije).toEqual([...kopije].sort())
  })
})

// ── Č6: statika — skripte, registri, meje ─────────────────────────────────────

describe('v217 Č6 — statika (skripte, registri, 0 DDL)', () => {
  test('štiri skripte obstajajo in so v package.json', () => {
    for (const skripta of ['local-keygen.ts', 'local-package.ts', 'local-package-verify.ts', 'local-package-apply.ts']) {
      expect(existsSync(join(ROOT, 'scripts', skripta))).toBe(true)
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['local:keygen']).toContain('local-keygen.ts')
    expect(pkg.scripts['local:package']).toContain('local-package.ts')
    expect(pkg.scripts['local:package-verify']).toContain('local-package-verify.ts')
    expect(pkg.scripts['local:package-apply']).toContain('local-package-apply.ts')
  })

  test('sloj uvozi SAMO node vgradne module + čisti update-check (0 aplikacijskih uvozov, vzorec offsite-backup)', () => {
    const vir = readFileSync(join(ROOT, 'src/lib/update-package.ts'), 'utf8')
    const uvozi = [...vir.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(uvozi.length).toBeGreaterThan(0)
    for (const u of uvozi) {
      expect(u.startsWith('node:') || u === './update-check').toBe(true)
    }
  })

  test('.gitignore ščiti: ključi, paketi, kopije kode (zasebni ključ nikoli v git)', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(gi).toContain(`/${SIGNING_KEYS_DIR}/`)
    expect(gi).toContain(`/${DIST_PACKAGES_DIR}/`)
    expect(gi).toContain(`*${UPDATE_PKG_EXT}`)
    expect(gi).toContain(`/${UPDATE_BACKUP_PREFIX.replace('.', '.')}`)
  })

  test('.env.example nosi oba okoljski imeni (ključ gradbene naprave + javni ključ namestitve)', () => {
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8')
    expect(env).toContain(SIGNING_KEY_ENV)
    expect(env).toContain(SIGNING_PUB_ENV)
  })

  test('0 DDL: shemi ne poznata pojma paketa (vse je datotečna operacija)', () => {
    for (const shema of ['prisma/schema.prisma', 'prisma/schema.sqlite.prisma']) {
      const vir = readFileSync(join(ROOT, shema), 'utf8')
      expect(vir).not.toContain('UpdatePackage')
      expect(vir).not.toContain('rospkg')
    }
  })

  test('verzija je dvignjena na 1.238.0 (version.ts + compose oznaka + selfhost-check vir)', () => {
    expect(APP_VERSION).toBe('1.266.0')
    expect(readFileSync(join(ROOT, 'src/lib/version.ts'), 'utf8')).toMatch(/APP_VERSION = '1\.266\.0'/)
    expect(readFileSync(join(ROOT, 'deploy/docker-compose.yml'), 'utf8')).toContain('restaurantos:1.266.0')
  })

  test('DOKUMENTI: LOKALNI-ZAGON §7 pozna paketno pot; PRD R4b vrstica nosi dokaz', () => {
    const lz = readFileSync(join(ROOT, 'docs/LOKALNI-ZAGON.md'), 'utf8')
    expect(lz).toContain('local:keygen')
    expect(lz).toContain('local:package-apply')
    expect(lz).toContain('signing.pub')
    const prd = readFileSync(join(ROOT, 'docs/PRD-LOKALNA-BAZA.md'), 'utf8')
    expect(prd).toContain('v1.217.0')
    expect(prd).toContain('local:package-apply')
    // hotfix v1.217.1: utrjevanje zbirnika (simbolne povezave) je del R4b dokaza
    expect(prd).toContain('v1.220.0')
  })

  test('worklog vnos na vrhu (Task ID: v1.228.0)', () => {
    const wl = readFileSync(join(ROOT, 'worklog.md'), 'utf8')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.266.0-finalna-verifikacija')
  })

  test('meje paketa so izmerjene in zapisane (623 datotek / ~10,2 MB osnova @ v1.217.0)', () => {
    expect(UPDATE_PKG_MAX_FILES).toBe(8000)
    expect(UPDATE_PKG_MAX_CONTENT_BYTES).toBe(268_435_456)
  })
})
