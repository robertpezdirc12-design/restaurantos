/**
 * v1.216.0 — R4b del 1: PREVERJANJE NOVIH RAZLIČIC (update check).
 *
 * Kontekst: LOKALNI-ZAGON.md je do tega vala zapisoval »aplikacija sama ne
 * preverja, ali je nova različica izšla« (R4b). Pogoj za R4b (lokalni
 * migracijski pogon) je bil izpolnjen v v1.183.0; ta val izvede del 1 —
 * preverjanje — prek živega javnega vira različice (produkcijski /api/health,
 * nadomestljiv z UPDATE_CHECK_URL). Del 2 (podpisani paket) ostaja lastniku.
 *
 * Kontrakt:
 *  - čisti sloj update-check.ts (0 uvozov): parse/compare/isNewerVersion/
 *    sanitizeUpdateCheckUrl/resolveUpdateCheckUrl — deterministično, striktno;
 *  - POŠTENOST: updateAvailable === true SAMO ob dokazano novejši trojki;
 *    neznano (unreachable/bad_response/bad_version) → false + razlog — nikoli
 *    »na voljo« brez dokaza, nikoli »posodobljeno« brez odgovora;
 *  - odhodni klic SAMO prek ssrfSafeJson (DNS pinning, timeout, omejeno telo);
 *    predpomnilnica: uspeh 1 h, odpoved 60 s (vbrizgljivi fetchJson/now —
 *    vzorec transportFactory iz daily-email.ts);
 *  - ruta GET /api/update-check: requireAuth + rate limit 30/min, odgovor
 *    VEDNO fail-soft 200 (razlog je del rezultata);
 *  - UI: vrstica v kartici »O sistemu« (Nastavitve), jantarno SAMO ob novejši;
 *    tip LOKALEN (ne iz strežniškega sloja — client bundle higiena v1.124.0);
 *  - i18n sys.upd* 6 ključev SL/HR (3731 → 3737); 0 DDL, 0 odvisnosti.
 *
 * Merila:
 *  Č1 čisti sloj (PURE) + vedenje strežniškega sloja proti stub fetchJson
 *     (novejša/enaka/starejša/nedosegljiva/slaba oblika/izklopljeno/napačno
 *     + TTL predpomnilnica) — 0 omrežja, 0 fikstur baze.
 *  Č2 disk kontrakt: ruta, ssrf-guard (ssrfSafeJson + skupni pinning),
 *     dashboard ožičenje (pozitivno + negativno: NI uvoza strežniškega sloja),
 *     i18n pariteta, .env.example, LOKALNI-ZAGON + PRD vrstica, 0 DDL dokaz,
 *     openapi NE nosi osebjske rute (ni javna).
 *  Č3 registri: verzija 1.216.0 (toBe + ubežen regex), compose ↔ APP_VERSION,
 *     AUDIT §8 števec 3738 + nota, worklog vnos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_UPDATE_CHECK_URL,
  UPDATE_CHECK_FAIL_TTL_MS,
  UPDATE_CHECK_JSON_MAX_BYTES,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  UPDATE_CHECK_URL_MAX,
  compareAppVersions,
  isNewerVersion,
  parseAppVersion,
  resolveUpdateCheckUrl,
  sanitizeUpdateCheckUrl,
} from '../src/lib/update-check'
import {
  __resetUpdateCheckCacheForTests,
  getUpdateCheckResult,
  type FetchLatestJson,
} from '../src/lib/update-check-server'
import type { SsrfJsonCategory, SsrfJsonResponse } from '../src/lib/ssrf-guard'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

/* ── pripomočki vedenjskih testov (0 omrežja) ─────────────────────────────── */

/**
 * NOVEJŠA različica, izpeljana iz APP_VERSION (lekcija v1.217.1: hardkodirani
 * relativni stub '1.218.0' je tiho prenehal biti novejši ob dvigu — test, ki
 * preverja POŠTENOST preverjanja posodobitev, ne sme pasti ravno na svojem
 * lastnem nepoštenem fiksni stanju).
 */
const NOVEJSA_OD_CURRENT = (() => {
  const [maj, min] = APP_VERSION.split('.').map(Number)
  return `${maj}.${min + 1}.0`
})()

/** Stub odgovor ssrfSafeJson (uspeh). */
const okJson = (json: unknown, durationMs = 12): SsrfJsonResponse =>
  ({ ok: true, status: 200, json, durationMs })

/** Stub odgovor ssrfSafeJson (odpoved — kategorija po SsrfJsonCategory). */
const failJson = (errorCategory: SsrfJsonCategory, durationMs = 34): SsrfJsonResponse =>
  ({ ok: false, status: 0, errorCategory, durationMs })

/** Štejoč stub: beleži klice (URL, init) in odgovarja iz vrste. */
function countingFetch(responses: SsrfJsonResponse[]): { fetch: FetchLatestJson; calls: { url: string; init: Record<string, unknown> }[] } {
  const calls: { url: string; init: Record<string, unknown> }[] = []
  let i = 0
  const fetch: FetchLatestJson = (url, init) => {
    calls.push({ url, init: init as unknown as Record<string, unknown> })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return Promise.resolve(r)
  }
  return { fetch, calls }
}

/** Fixni čas — checkedAt determinističen. */
const T0 = 1_700_000_000_000

let envBackup: string | undefined

beforeEach(() => {
  envBackup = process.env.UPDATE_CHECK_URL
  __resetUpdateCheckCacheForTests()
})

afterEach(() => {
  if (envBackup === undefined) delete process.env.UPDATE_CHECK_URL
  else process.env.UPDATE_CHECK_URL = envBackup
  __resetUpdateCheckCacheForTests()
})

/* ── Č1 — čisti sloj: razčlenitev, primerjava, poštenost ───────────────────── */

describe('v1.216.0 — Č1: parseAppVersion (striktna trojka)', () => {
  it('veljavne oblike: trim, vodilne ničle, večji minor', () => {
    expect(parseAppVersion('1.216.0')).toEqual([1, 216, 0])
    expect(parseAppVersion(' 1.216.0 ')).toEqual([1, 216, 0])
    expect(parseAppVersion('2.0.0')).toEqual([2, 0, 0])
    expect(parseAppVersion('1.007.3')).toEqual([1, 7, 3])
    expect(parseAppVersion('10.20.30')).toEqual([10, 20, 30])
  })

  it('zavrnjene oblike: prefiks, 2/4 deli, črke, ne-nizi, prazno', () => {
    expect(parseAppVersion('v1.216.0')).toBeNull()
    expect(parseAppVersion('1.216')).toBeNull()
    expect(parseAppVersion('1.216.0.1')).toBeNull()
    expect(parseAppVersion('1.216.0-beta')).toBeNull()
    expect(parseAppVersion('1.2l6.0')).toBeNull()
    expect(parseAppVersion('')).toBeNull()
    expect(parseAppVersion('   ')).toBeNull()
    expect(parseAppVersion(1.216)).toBeNull()
    expect(parseAppVersion(null)).toBeNull()
    expect(parseAppVersion(undefined)).toBeNull()
    expect(parseAppVersion({ v: '1.216.0' })).toBeNull()
  })

  it('NOVEJSA_OD_CURRENT je dokazano novejša od APP_VERSION (varovala lekcije v1.217.1)', () => {
    expect(parseAppVersion(NOVEJSA_OD_CURRENT)).not.toBeNull()
    expect(isNewerVersion(NOVEJSA_OD_CURRENT, APP_VERSION)).toBe(true)
    expect(NOVEJSA_OD_CURRENT).not.toBe(APP_VERSION)
  })

  it('APP_VERSION samega vala je berljiva (register — ne lokalen niz)', () => {
    expect(parseAppVersion(APP_VERSION)).not.toBeNull()
  })
})

describe('v1.216.0 — Č1: compareAppVersions + isNewerVersion (determinizem)', () => {
  it('primerjava po teži major > minor > patch, -1|0|1', () => {
    expect(compareAppVersions([1, 216, 0], [1, 216, 0])).toBe(0)
    expect(compareAppVersions([1, 216, 0], [1, 216, 1])).toBe(-1)
    expect(compareAppVersions([1, 217, 0], [1, 216, 99])).toBe(1)
    expect(compareAppVersions([2, 0, 0], [1, 999, 999])).toBe(1)
    expect(compareAppVersions([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('isNewerVersion: true SAMO ob strogo novejši; null ob neberljivi (neznanost NI ne)', () => {
    expect(isNewerVersion('1.217.0', '1.216.0')).toBe(true)
    expect(isNewerVersion('1.216.1', '1.216.0')).toBe(true)
    expect(isNewerVersion('1.216.0', '1.216.0')).toBe(false)
    expect(isNewerVersion('1.215.0', '1.216.0')).toBe(false)
    expect(isNewerVersion('v-next', '1.216.0')).toBeNull()
    expect(isNewerVersion('1.217.0', 'smeti')).toBeNull()
    expect(isNewerVersion(null, '1.216.0')).toBeNull()
  })

  it('lokalno NAPREJ oblačne različije je »ni novejša« (isti dan dviga — pošteno)', () => {
    // dan dviga je lokal 1.216.0, oblak še 1.215.0 → NI posodobitev na voljo
    expect(isNewerVersion('1.215.0', APP_VERSION)).toBe(false)
  })
})

describe('v1.216.0 — Č1: sanitizeUpdateCheckUrl (SAMO https, isti vratarji kot logoUrl)', () => {
  it('veljaven https URL ohranjen (trim)', () => {
    expect(sanitizeUpdateCheckUrl('https://restaurantos-theta.vercel.app/api/health')).toBe('https://restaurantos-theta.vercel.app/api/health')
    expect(sanitizeUpdateCheckUrl('  https://zgled.si/health  ')).toBe('https://zgled.si/health')
  })

  it('zavrnjeno: http, data, javascript, presledki, predolgo, ne-nizi', () => {
    expect(sanitizeUpdateCheckUrl('http://zgled.si/health')).toBeNull()
    expect(sanitizeUpdateCheckUrl('data:text/html,napaka')).toBeNull()
    expect(sanitizeUpdateCheckUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeUpdateCheckUrl('https://zgled .si/health')).toBeNull()
    expect(sanitizeUpdateCheckUrl('https://zgled.si/health\u0000')).toBeNull()
    expect(sanitizeUpdateCheckUrl(`https://zgled.si/${'a'.repeat(UPDATE_CHECK_URL_MAX)}`)).toBeNull()
    expect(sanitizeUpdateCheckUrl('')).toBeNull()
    expect(sanitizeUpdateCheckUrl(null)).toBeNull()
    expect(sanitizeUpdateCheckUrl(42)).toBeNull()
  })
})

describe('v1.216.0 — Č1: resolveUpdateCheckUrl (env → vir, pošteno poročilo)', () => {
  it('NENASTAVLJENO → privzeti produkcijski health (deluje brez konfiguracije)', () => {
    const r = resolveUpdateCheckUrl(undefined)
    expect(r.source).toBe('default')
    expect(r.url).toBe(DEFAULT_UPDATE_CHECK_URL)
    expect(r.url).toBe('https://restaurantos-theta.vercel.app/api/health')
  })

  it('PRAZNO / sami presledki → izklopljeno (izrecna odločitev operaterja)', () => {
    expect(resolveUpdateCheckUrl('')).toEqual({ url: null, source: 'disabled' })
    expect(resolveUpdateCheckUrl('   ')).toEqual({ url: null, source: 'disabled' })
  })

  it('veljaven https → env (trim); neveljaven → invalid (NE tiha zamenjava s privzetim)', () => {
    expect(resolveUpdateCheckUrl(' https://moj-zgled.si/api/health ')).toEqual({ url: 'https://moj-zgled.si/api/health', source: 'env' })
    expect(resolveUpdateCheckUrl('http://zgled.si')).toEqual({ url: null, source: 'invalid' })
    expect(resolveUpdateCheckUrl('ftp://zgled.si')).toEqual({ url: null, source: 'invalid' })
    expect(resolveUpdateCheckUrl('https://zgled.si\u0007')).toEqual({ url: null, source: 'invalid' })
    expect(resolveUpdateCheckUrl(123)).toEqual({ url: null, source: 'invalid' })
  })

  it('konstante vala so usklajene (TTL/timeout/telo so pinjene vrednosti)', () => {
    expect(UPDATE_CHECK_TTL_MS).toBe(3_600_000)
    expect(UPDATE_CHECK_FAIL_TTL_MS).toBe(60_000)
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(5_000)
    expect(UPDATE_CHECK_JSON_MAX_BYTES).toBe(16_384)
    expect(UPDATE_CHECK_URL_MAX).toBe(300)
  })

  it('čisti sloj BREZ uvozov (disciplina brand-themes/item-variants)', () => {
    const src = read('src/lib/update-check.ts')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/\brequire\s*\(/)
  })
})

/* ── Č1 — vedenje strežniškega sloja (stub fetchJson, 0 omrežja) ───────────── */

describe('v1.216.0 — Č1: getUpdateCheckResult vedenje (fail-soft + poštenost)', () => {
  it('odgovor z NOVEJŠO različico → updateAvailable true + latest', async () => {
    const { fetch, calls } = countingFetch([okJson({ version: NOVEJSA_OD_CURRENT, status: 'ok' })])
    const r = await getUpdateCheckResult({ fetchJson: fetch, now: T0 })
    expect(r.updateAvailable).toBe(true)
    expect(r.latest).toBe(NOVEJSA_OD_CURRENT)
    expect(r.current).toBe(APP_VERSION)
    expect(r.reason).toBe('')
    expect(r.source).toBe('default')
    expect(r.checkedAt).toBe(new Date(T0).toISOString())
    expect(r.durationMs).toBe(12)
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(DEFAULT_UPDATE_CHECK_URL)
    expect(calls[0].init.timeoutMs).toBe(UPDATE_CHECK_TIMEOUT_MS)
    expect(calls[0].init.maxBytes).toBe(UPDATE_CHECK_JSON_MAX_BYTES)
  })

  it('odgovor z ENAKO in STAREJŠO različico → false + latest znana (lokal naprej = posodobljeno)', async () => {
    const a = await getUpdateCheckResult({ fetchJson: countingFetch([okJson({ version: APP_VERSION })]).fetch, now: T0 })
    expect(a.updateAvailable).toBe(false)
    expect(a.latest).toBe(APP_VERSION)
    expect(a.reason).toBe('')
    __resetUpdateCheckCacheForTests()
    const b = await getUpdateCheckResult({ fetchJson: countingFetch([okJson({ version: '1.215.0' })]).fetch, now: T0 })
    expect(b.updateAvailable).toBe(false)
    expect(b.latest).toBe('1.215.0')
  })

  it('omrežna odpoved → latest null + reason unreachable (NE »posodobljeno«)', async () => {
    for (const cat of ['dns', 'timeout', 'refused', 'tls', 'network', 'bad_status', 'bad_json', 'too_large'] as const) {
      __resetUpdateCheckCacheForTests()
      const r = await getUpdateCheckResult({ fetchJson: countingFetch([failJson(cat)]).fetch, now: T0 })
      expect(r.updateAvailable).toBe(false)
      expect(r.latest).toBeNull()
      expect(r.reason).toBe('unreachable')
      expect(r.durationMs).toBe(34)
    }
  })

  it('odgovor BREZ polja version → bad_response; neberljiva različija → bad_version', async () => {
    const a = await getUpdateCheckResult({ fetchJson: countingFetch([okJson({ status: 'degraded', database: 'disconnected' })]).fetch, now: T0 })
    expect(a.latest).toBeNull()
    expect(a.reason).toBe('bad_response')
    __resetUpdateCheckCacheForTests()
    const b = await getUpdateCheckResult({ fetchJson: countingFetch([okJson({ version: 'v-next' })]).fetch, now: T0 })
    expect(b.latest).toBeNull()
    expect(b.reason).toBe('bad_version')
  })

  it('izklopljeno (prazni env) → off; napačen env → invalid_url — OBA brez odhodnega klica', async () => {
    let called = 0
    const never: FetchLatestJson = () => { called++; return Promise.resolve(okJson({ version: '9.9.9' })) }
    process.env.UPDATE_CHECK_URL = ''
    const a = await getUpdateCheckResult({ fetchJson: never, now: T0 })
    expect(a.reason).toBe('off')
    expect(a.source).toBe('disabled')
    expect(a.latest).toBeNull()
    expect(a.durationMs).toBeNull()
    __resetUpdateCheckCacheForTests()
    process.env.UPDATE_CHECK_URL = 'http://nekaj'
    const b = await getUpdateCheckResult({ fetchJson: never, now: T0 })
    expect(b.reason).toBe('invalid_url')
    expect(b.source).toBe('invalid')
    expect(b.latest).toBeNull()
    // operaterjeva napaka/izklop NE prožita omrežja — vir ni bil nikdar vprašan
    expect(called).toBe(0)
  })

  it('env https URL → klic na TA URL (vir po meri)', async () => {
    process.env.UPDATE_CHECK_URL = 'https://moj-zgled.si/api/health'
    const { fetch, calls } = countingFetch([okJson({ version: '1.100.0' })])
    const r = await getUpdateCheckResult({ fetchJson: fetch, now: T0 })
    expect(calls[0].url).toBe('https://moj-zgled.si/api/health')
    expect(r.source).toBe('env')
    expect(r.updateAvailable).toBe(false)
  })

  it('predpomnilnica: uspeh 1 h (drugi klic brez omrežja), odpoved 60 s', async () => {
    // uspeh: klic ob T0, ponovna zahteva znotraj TTL → NI drugega klica
    let n = 0
    const fetchOk: FetchLatestJson = () => { n++; return Promise.resolve(okJson({ version: NOVEJSA_OD_CURRENT })) }
    await getUpdateCheckResult({ fetchJson: fetchOk, now: T0 })
    const cached = await getUpdateCheckResult({ fetchJson: fetchOk, now: T0 + UPDATE_CHECK_TTL_MS - 1 })
    expect(n).toBe(1)
    expect(cached.updateAvailable).toBe(true)
    expect(cached.checkedAt).toBe(new Date(T0).toISOString()) // izvirni čas preverjanja
    // po TTL → svež klic
    await getUpdateCheckResult({ fetchJson: fetchOk, now: T0 + UPDATE_CHECK_TTL_MS })
    expect(n).toBe(2)

    // odpoved: krajša doba — okrevanje vira se zazna v 60 s
    __resetUpdateCheckCacheForTests()
    let m = 0
    const fetchFail: FetchLatestJson = () => { m++; return Promise.resolve(failJson('network')) }
    await getUpdateCheckResult({ fetchJson: fetchFail, now: T0 })
    await getUpdateCheckResult({ fetchJson: fetchFail, now: T0 + UPDATE_CHECK_FAIL_TTL_MS - 1 })
    expect(m).toBe(1)
    await getUpdateCheckResult({ fetchJson: fetchFail, now: T0 + UPDATE_CHECK_FAIL_TTL_MS })
    expect(m).toBe(2)
  })
})

/* ── Č2 — disk kontrakt: ruta, ssrf-guard, UI, i18n, dokumenti ─────────────── */

describe('v1.216.0 — Č2: ruta /api/update-check', () => {
  const route = read('src/app/api/update-check/route.ts')

  it('varovalka requireAuth (route-coverage a) + rate limit 30/min po uporabniku', () => {
    expect(route).toContain('requireAuth(')
    expect(route).toContain('rateLimitShared(')
    expect(route).toContain('updchk:')
    expect(route).toContain(', 30, 60_000')
  })

  it('SAMO GET handler; odgovor 200 fail-soft + no-store', () => {
    expect(route).toContain('export async function GET(')
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE|HEAD)\(/)
    expect(route).toContain("'Cache-Control': 'no-store'")
    expect(route).toContain('429')
  })

  it('ruta kliče strežniški sloj (ena pot — NE svoje primerjave)', () => {
    expect(route).toContain('getUpdateCheckResult()')
  })
})

describe('v1.216.0 — Č2: ssrf-guard ssrfSafeJson (ena resnica o pinningu)', () => {
  const guard = read('src/lib/ssrf-guard.ts')

  it('ssrfSafeJson izvožena z omejenim branjem telesa (maxBytes, privzeto 16 KiB)', () => {
    expect(guard).toContain('export async function ssrfSafeJson(')
    expect(guard).toContain('init.maxBytes ?? 16_384')
    expect(guard).toContain('too_large')
    expect(guard).toContain('bad_json')
    expect(guard).toContain('bad_status')
  })

  it('skupni pinnedTargetFor uporabljata OBEMA bralcu (drift med njima je nemogoč)', () => {
    const uses = guard.split('pinnedTargetFor(').length - 1
    expect(uses).toBeGreaterThanOrEqual(3) // definicija + ssrfSafeRequest + ssrfSafeJson
  })

  it('ssrfSafeJson NE sledi preusmeritvam (3xx = bad_status) in NE pošilja telesa', () => {
    const fn = guard.slice(guard.indexOf('export async function ssrfSafeJson'))
    expect(fn.slice(0, 2400)).toContain("errorCategory: 'bad_status'")
    expect(fn.slice(0, 2400)).not.toContain('req.write(')
  })

  it('ssrfSafeRequest ostaja nebralka telesa (regresija v1.156.0 discipline)', () => {
    const fn = guard.slice(guard.indexOf('export async function ssrfSafeRequest'), guard.indexOf('/* ────────────────── varni JSON klic'))
    expect(fn).toContain('res.destroy()')
    expect(fn).not.toContain('JSON.parse')
  })
})

describe('v1.216.0 — Č2: dashboard ožičenje (kartica O sistemu)', () => {
  const dash = read('src/app/dashboard/page.tsx')

  it('klic /api/update-check enkrat ob mountu (async IIFE + cancelled guard)', () => {
    expect(dash).toContain("api<UpdateCheckT>('/api/update-check')")
    expect(dash).toContain('void (async () => {')
    expect(dash).toContain('cancelled = true')
  })

  it('jantarna vrstica SAMO ob updateAvailable; ostalo tiho sivo; i18n ključi', () => {
    expect(dash).toContain("updCheck.updateAvailable && (")
    expect(dash).toContain("text-amber-700")
    expect(dash).toContain("t('sys.updAvailable', { v: updCheck.latest ?? '' })")
    expect(dash).toContain("t('sys.updHint')")
    expect(dash).toContain("t('sys.updOk')")
    expect(dash).toContain("t('sys.updDisabled')")
    expect(dash).toContain("t('sys.updInvalid')")
    expect(dash).toContain("t('sys.updUnreachable')")
    // izklopljeno/napačno/nedosegljivo so tiho sivo — NE v jantarni veji
    const disabledLine = dash.slice(dash.indexOf("updCheck.reason === 'off'") - 60, dash.indexOf("updCheck.reason === 'off'") + 120)
    expect(disabledLine).toContain('text-stone-400')
  })

  it('NEGATIVNO: klient NE uvaža strežniškega sloja (client bundle higiena v1.124.0)', () => {
    expect(dash).not.toContain("from '@/lib/update-check-server'")
    expect(dash).not.toContain("from '@/lib/ssrf-guard'")
    expect(dash).toContain('interface UpdateCheckT')
  })

  it('NEGATIVNO: footer in gostovske površine NE spreminjajo (kamnito)', () => {
    // vrstica živi SAMO v kartici O sistemu (settings) — ne v footerju
    const footerIdx = dash.indexOf("t('dash.footer')")
    const updIdx = dash.indexOf("t('sys.updAvailable'")
    expect(footerIdx).toBeGreaterThan(0)
    expect(updIdx).toBeGreaterThan(0)
    expect(dash.indexOf("t('sys.version'")).toBeLessThan(updIdx) // znotraj sistemske kartice
  })
})

describe('v1.216.0 — Č2: i18n + dokumenti + 0 DDL', () => {
  it('6 novih ključev sys.upd* v OBEH slovarjih — polna pariteta', () => {
    const keys = ['sys.updOk', 'sys.updAvailable', 'sys.updHint', 'sys.updUnreachable', 'sys.updDisabled', 'sys.updInvalid']
    for (const k of keys) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
    // števca slovarjev: 3731 → 3737 (6 novih v vsakem)
    expect(Object.keys(sl).length).toBe(4231)
    expect(Object.keys(hr).length).toBe(4231)
  })

  it('.env.example dokumentira UPDATE_CHECK_URL (privzeto/izklopljeno/napačno)', () => {
    const env = read('.env.example')
    expect(env).toContain('UPDATE_CHECK_URL')
    expect(env).toContain('R4b-1')
  })

  it('LOKALNI-ZAGON: odstavek o preverjanju posodobljen (ne trdi več »ne preverja«)', () => {
    const doc = read('docs/LOKALNI-ZAGON.md')
    expect(doc).toContain('samo preverja, ali je nova različica izšla')
    expect(doc).toContain('UPDATE_CHECK_URL')
    expect(doc).toContain('R4b del 1, v1.216.0')
    // stara (neprehodna) trditev ne sme ostati
    expect(doc).not.toContain('Aplikacija sama ne preverja, ali je nova različica izšla')
  })

  it('PRD-LOKALNA-BAZA: vrstica R4b nosi IZVEDENO @ v1.216.0 dokaz', () => {
    const doc = read('docs/PRD-LOKALNA-BAZA.md')
    expect(doc).toContain('Preverjanje novih različic IZVEDENO @ v1.216.0')
    expect(doc).toContain('UPDATE_CHECK_URL')
    // §13 odprta odločitev: odprt ostane SAMO podpisani paket
    expect(doc).toContain('Preverjanje novih različic je izvedeno v v1.216.0 (R4b del 1); odprt ostaja podpisani paket')
    expect(doc).not.toContain('Odprta ostajata preverjanje novih različic in podpisani paket')
  })

  it('0 DDL dokaz: shemi NE poznata pojma; migracijski register nedotaknjen', () => {
    for (const p of ['prisma/schema.prisma', 'prisma/schema.sqlite.prisma']) {
      const s = read(p)
      expect(s).not.toContain('UpdateCheck')
      expect(s).not.toContain('update_check')
    }
    const reg = read('src/lib/schema-migrations.ts')
    expect(reg).not.toContain('update-check')
    expect(reg).not.toContain('UpdateCheck')
  })

  it('NEGATIVNO: ruta NI javna — openapi spec (javna površina, OSS-5) je ne nosi', () => {
    const spec = read('src/app/api/openapi/route.ts')
    expect(spec).not.toContain('/api/update-check')
  })
})

/* ── Č3 — registri ─────────────────────────────────────────────────────────── */

describe('v1.216.0 — Č3: registri', () => {
  it('verzija 1.238.0 (toBe + ubežen regex)', () => {
    expect(APP_VERSION).toBe('1.269.0')
    expect(read('src/lib/version.ts')).toMatch(/APP_VERSION = '1\.269\.0'/)
  })

  it('compose oznaka slike ↔ APP_VERSION (selfhost pogodba)', () => {
    const compose = read('deploy/docker-compose.yml')
    expect(compose).toContain(`image: restaurantos:${APP_VERSION}`)
  })

  it('AUDIT §8: števec 3738 + POSODOBITEV nota', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('4231 ključev SL in 4231 HR')
    expect(audit).toContain('**POSODOBITEV (v1.216.0):**')
    expect(audit).toContain('sys.upd*')
  })

  it('worklog nosi vnos tega vala na vrhu', () => {
    const wl = read('worklog.md')
    expect(wl.indexOf('Task ID: v1.216.0-update-check')).toBeLessThan(wl.indexOf('Task ID: v1.215.0-ci-alarm-lifecycle'))
    // v1.263.0 §37 finalna-verifikacija: okno povečano (novejši vnosi glave potiskajo R4b globlje)
    expect(wl.slice(0, 44000)).toContain('R4b') // v1.268.0 QA-val: okno povečano 34000 → 44000 (novi vnosi glave potiskajo R4b globlje; vzorec v263/v264/v265/v267)
  })
})
