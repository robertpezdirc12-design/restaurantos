/**
 * v1.170.0 — omejitev offline vrste (PRD docs/PRD-LOKALNA-BAZA.md, R2b).
 *
 * Merilo sprejema R2b: „vrsta se ne podvoji in ne raste neomejeno". Trenutno
 * `enqueueOp` nima ne stožca ne starosti: `setQueue` zapiše CELoten seznam,
 * zato ob prekoračitvi kvote `localStorage` vrže sredi pisanja, operacija pa
 * ostane samo v spominu klica — na POS-u izgleda kot oddano naročilo.
 *
 * Testi so OBNAŠALNI (pravi modul, pravi `localStorage` stub), ne statični
 * pini: stožec in starost se da pokvariti na desetine načinov, beseda v
 * datoteki pa tega ne ustreli. Klici strani so pinani statično (vzorec
 * `guest-offline.test.ts`), ker zahtevajo brskalnik.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterAll } from 'bun:test'

const QUEUE_KEY = 'ro_offline_queue'

type Sled = { url: string; body: unknown }

let store: Map<string, string>
let kvota: boolean
let poslano: Sled[]

function namestiDOM(): void {
  store = new Map()
  kvota = false
  poslano = []
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        if (k === QUEUE_KEY && kvota) throw new Error('QuotaExceededError: polna kvota')
        store.set(k, String(v))
      },
      removeItem: (k: string) => { store.delete(k) },
    },
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (url: string, init?: { body?: string }) => {
      poslano.push({ url, body: init?.body ? JSON.parse(init.body) : null })
      return { ok: true, status: 200, json: async () => ({ results: [] }) }
    },
  })
}

namestiDOM()
const q = await import('../src/lib/offline-queue')

/**
 * v1.171.0 — DOM se MORA vrniti. Stub `fetch` zgoraj vrne `{ results: [] }` (brez
 * polja `result`) in je bil doslej najdaljši živi v procesu: vsaka kasnejša
 * datotela, ki meri pravi omrežni promet, je namesto napake dobila HTTP 200 z
 * neujemanjočim telesom.
 *
 * Skupaj z drugim uhajanjem — `tests/rate-limit.test.ts` je RESTAURANTOS-ovo
 * okolje pustil nastavljeno (`UPSTASH_REDIS_REST_URL=https://test-rest.upstash.io`
 * + token, `{ url, token }` sta absolutna http(s), torej UPORABNA po №28) — je
 * to dalo točno verigo osmih „Expected: 429, Received: 200" odpovedi v CI-ju (run
 * 39905677431): limiter izbere upstashStore → INCR gre na stub → 200 brez
 * `result` → `Number(null) === 0` → `0 <= limit` → NIKOLI 429. Dokaz (merjeno, ne
 * sklepano): HEAD-različici obeh datotek + `auth-demo-login.test.ts` v tem vrstnem
 * redu, in ob reverzu popravka `src/lib/rate-limit.ts` pade točno tisti test
 * (`rate limit: 11. klic z istim IP v minuti → 429`) z isto differentrico.
 */
const IZVIRNI = {
  fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
}

function povrniDOM(): void {
  for (const kljuc of ['fetch', 'localStorage', 'window'] as const) {
    const d = IZVIRNI[kljuc]
    if (d) Object.defineProperty(globalThis, kljuc, d)
    else Reflect.deleteProperty(globalThis, kljuc)
  }
}

afterAll(povrniDOM)

const URA = 60 * 60 * 1000
const USTANI = (star: number) => new Date(Date.now() - star).toISOString()

/** Neposredno zapiše vrsto, da test nadzira `createdAt` in `status`. */
function zapiši(ops: unknown[]): void {
  store.set(QUEUE_KEY, JSON.stringify(ops))
}

function operacija(over: string, createdAt: string, status?: string) {
  return {
    clientOperationId: over,
    kind: 'order.create',
    payload: { tableId: 'miza-1' },
    createdAt,
    attempts: 0,
    ...(status ? { status } : {}),
  }
}

function napolni(n: number, prefix = 'op'): void {
  for (let i = 0; i < n; i++) {
    try {
      q.enqueueOp('order.create', { tableId: `miza-${i}`, i }, `${prefix}-${i}`)
    } catch (err) {
      // napolni sme biti klican čez stožec — zavrnitev je tu pričakovana
      if (!q.isQueueFullError(err)) throw err
    }
  }
}

beforeEach(() => namestiDOM())

describe('v1.170.0 — vrsta se ne podvoji', () => {
  it('isti clientOperationId vrne obstoječo operacijo in ne doda druge kopije', () => {
    const prva = q.enqueueOp('order.create', { tableId: 'miza-9' }, 'idem-1')
    const druga = q.enqueueOp('order.create', { tableId: 'miza-9' }, 'idem-1')
    expect(q.getQueue()).toHaveLength(1)
    expect(druga.clientOperationId).toBe(prva.clientOperationId)
  })

  it('brez clientOperationId vsak pritisk doda novo operacijo (idempotenca ne sme požreti naročil)', () => {
    q.enqueueOp('order.create', { tableId: 'miza-1' })
    q.enqueueOp('order.create', { tableId: 'miza-2' })
    expect(q.getQueue()).toHaveLength(2)
  })
})

describe('v1.170.0 — vrsta ne raste neomejeno', () => {
  it('stožec je izrecna, izvožena konstanta in razumen za izmeno', () => {
    expect(typeof q.MAX_QUEUE_OPS).toBe('number')
    expect(q.MAX_QUEUE_OPS).toBeGreaterThanOrEqual(50)
    expect(q.MAX_QUEUE_OPS).toBeLessThanOrEqual(2000)
  })

  it('zadnjo prostoro operacijo sprejme, naslednjo zavrne z QueueFullError', () => {
    napolni(q.MAX_QUEUE_OPS)
    expect(q.getQueue()).toHaveLength(q.MAX_QUEUE_OPS)
    expect(q.queueHeadroom()).toBe(0)
    let napaka: unknown
    try {
      q.enqueueOp('order.create', { tableId: 'miza-preveč' })
    } catch (err) {
      napaka = err
    }
    expect(q.isQueueFullError(napaka)).toBe(true)
  })

  it('zavrnitev NE poseže v obstoječo vrsto — nobena operacija ne izgine', () => {
    napolni(q.MAX_QUEUE_OPS)
    const pred = JSON.stringify(q.getQueue())
    try {
      q.enqueueOp('order.create', { tableId: 'miza-preveč' })
      throw new Error('moralo bi biti zavrnjeno')
    } catch (err) {
      expect(q.isQueueFullError(err) || (err as Error).message === 'moralo bi biti zavrnjeno').toBe(true)
    }
    expect(JSON.stringify(q.getQueue())).toBe(pred)
  })

  it('headroom pade z vsako operacijo in nikoli ne postane negativen', () => {
    expect(q.queueHeadroom()).toBe(q.MAX_QUEUE_OPS)
    q.enqueueOp('order.create', { tableId: 'miza-a' })
    expect(q.queueHeadroom()).toBe(q.MAX_QUEUE_OPS - 1)
    napolni(q.MAX_QUEUE_OPS + 5)
    expect(q.queueHeadroom()).toBe(0)
  })

  it('stožec šteje samo žive: dead-letter operacije ne zasedejo prostora za nova naročila', () => {
    zapiši(Array.from({ length: q.MAX_QUEUE_OPS }, (_, i) => operacija(`mrtva-${i}`, USTANI(URA), 'dead')))
    expect(q.getQueue()).toHaveLength(q.MAX_QUEUE_OPS)
    expect(q.queueHeadroom()).toBe(q.MAX_QUEUE_OPS)
    q.enqueueOp('order.create', { tableId: 'miza-nova' })
    expect(q.getQueue().filter((o: { status?: string }) => o.status !== 'dead')).toHaveLength(1)
  })
})

describe('v1.170.0 — starost vrste', () => {
  it('starostna meja je izrecna konstanta v urah, ne v neskončnosti', () => {
    expect(typeof q.MAX_QUEUE_AGE_MS).toBe('number')
    expect(q.MAX_QUEUE_AGE_MS).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000)
    expect(q.MAX_QUEUE_AGE_MS).toBeLessThanOrEqual(72 * 60 * 60 * 1000)
  })

  it('zastarela operacija ob flushu NE gre na strežnik, ampak v dead-letter', async () => {
    zapiši([operacija('zastarela', USTANI(q.MAX_QUEUE_AGE_MS + URA))])
    store.set('ro_token', 'žeton')
    const rezultat = await q.flushQueue()
    expect(poslano.map((p) => p.url)).not.toContain('/api/sync')
    expect(rezultat.flushed).toBe(0)
    expect(q.getDeadOps().map((o: { clientOperationId: string }) => o.clientOperationId)).toContain('zastarela')
  })

  it('prehod zaradi starosti je poročen na /api/sync/drop, da ostane sled', async () => {
    zapiši([operacija('zastarela-2', USTANI(q.MAX_QUEUE_AGE_MS + URA))])
    store.set('ro_token', 'žeton')
    await q.flushQueue()
    expect(poslano.map((p) => p.url)).toContain('/api/sync/drop')
  })

  it('mlajša operacija ostane živa in gre na strežnik', async () => {
    zapiši([operacija('mlada', USTANI(URA))])
    store.set('ro_token', 'žeton')
    const rezultat = await q.flushQueue()
    const sync = poslano.find((p) => p.url === '/api/sync')
    expect(sync).toBeDefined()
    expect((sync!.body as { ops: unknown[] }).ops).toHaveLength(1)
    expect(rezultat.dead).toBe(0)
  })

  it('zastarela operacija se NE izbriše tiho — ostane vidna in ponovno pošiljna', async () => {
    zapiši([operacija('ohrani-me', USTANI(q.MAX_QUEUE_AGE_MS + 5 * URA))])
    store.set('ro_token', 'žeton')
    await q.flushQueue()
    expect(q.getQueue().map((o: { clientOperationId: string }) => o.clientOperationId)).toContain('ohrani-me')
    expect(q.resetDeadOp('ohrani-me')).toBe(true)
    expect(q.getQueue()[0].status).toBe('queued')
  })

  it('resetDeadOp osveži uro operacije — ročni poskus ni takoj spet zastarel', () => {
    zapiši([operacija('rocni-poskus', USTANI(q.MAX_QUEUE_AGE_MS + 2 * URA))])
    expect(q.sweepExpired().map((o: { clientOperationId: string }) => o.clientOperationId)).toEqual(['rocni-poskus'])
    expect(q.resetDeadOp('rocni-poskus')).toBe(true)
    expect(q.sweepExpired()).toHaveLength(0)
    expect(q.getQueue()[0].status).toBe('queued')
  })

  it('sweepExpired ne posega v mlajše in je idempotenten', () => {
    zapiši([operacija('mlada', USTANI(URA)), operacija('stara', USTANI(q.MAX_QUEUE_AGE_MS + URA))])
    const prvi = q.sweepExpired()
    expect(prvi.map((o: { clientOperationId: string }) => o.clientOperationId)).toEqual(['stara'])
    expect(q.sweepExpired()).toHaveLength(0)
    expect(q.getQueue().find((o: { clientOperationId: string }) => o.clientOperationId === 'mlada').status).not.toBe('dead')
  })
})

describe('v1.170.0 — kvota brskalnika', () => {
  it('ob odpovedi localStorage enqueueOp javi QueueFullError, prejšnja vrsta pa ostane', () => {
    q.enqueueOp('order.create', { tableId: 'miza-prva' })
    const stanje = JSON.stringify(q.getQueue())
    kvota = true
    let napaka: unknown
    try {
      q.enqueueOp('order.create', { tableId: 'miza-druga' })
    } catch (err) {
      napaka = err
    }
    expect(q.isQueueFullError(napaka)).toBe(true)
    expect(JSON.stringify(q.getQueue())).toBe(stanje)
  })
})

describe('v1.170.0 — tryEnqueueOp: zavrnitev je rezultat, ne izjema', () => {
  it('uspešen vpis vrne ok in operacijo', () => {
    const rezultat = q.tryEnqueueOp('order.create', { tableId: 'miza-1' }, 'try-1')
    expect(rezultat.ok).toBe(true)
    expect(rezultat.op.clientOperationId).toBe('try-1')
  })

  it('polna vrsta vrne reason queue_full in NE vrže', () => {
    napolni(q.MAX_QUEUE_OPS)
    let rezultat: { ok?: boolean; reason?: string } | undefined
    let met = false
    try {
      rezultat = q.tryEnqueueOp('order.create', { tableId: 'miza-preveč' })
    } catch {
      met = true
    }
    expect(met).toBe(false)
    expect(rezultat!.ok).toBe(false)
    expect(rezultat!.reason).toBe('queue_full')
  })

  it('kvota brskalnika vrne enak reason, da klicatelj ne ločuje dveh polnih vrst', () => {
    kvota = true
    const rezultat = q.tryEnqueueOp('order.create', { tableId: 'miza-1' })
    expect(rezultat.ok).toBe(false)
    expect(rezultat.reason).toBe('queue_full')
  })
})

/**
 * Klici strani so pinani statično (vzorec `guest-offline.test.ts`): zahtevajo
 * brskalnik, njihov pomen pa je vrstni red v eni veji — če se košarica izprazni
 * pred uspešnim vpisom, naročilo izgine brez sledu.
 *
 * `between`/`ureditev` namerno vrneta majhen objekt: ob rdečem testu je izpis
 * lahko berljiv, ne da bi vdisal celotno `page.tsx` v dnevnik.
 */
const between = (koda: string, od: string, doKoda: string): string => {
  const z = koda.indexOf(od)
  const k = koda.indexOf(doKoda)
  if (z === -1 || k === -1 || k <= z) return ''
  return koda.slice(z, k)
}
/**
 * Veja, ki jo sme dokazovati test: od `isNetworkError` do `finally`. Uspešna
 * pot prav tako vsebuje `setCart({})`, pa je pomeni — tam je naročilo že na
 * strežniku. Merilo je izjema ZNOTRAJ offline veje.
 */
const offlineVeja = (koda: string, od: string, doKoda: string): string =>
  between(between(koda, od, doKoda), 'if (isNetworkError(err)) {', '} else')
const ureditev = (blok: string): { sporočilo: boolean; zavrnitevPredIzpraznitvijo: boolean } => {
  const zavrnitev = blok.indexOf('if (!rezultat.ok)')
  return {
    sporočilo: blok.includes("t('net.queueFull')"),
    zavrnitevPredIzpraznitvijo: zavrnitev > -1 && zavrnitev < blok.indexOf('setCart({})'),
  }
}
describe('v1.170.0 — klici: košarica se izprazni šele, ko operacija res obstaja', () => {
  const ROOT = join(import.meta.dir, '..')
  const src = (pot: string) => readFileSync(join(ROOT, pot), 'utf-8')

  it('nobena stran ne kliče barem `enqueueOp` — samo tryEnqueueOp', () => {
    for (const pot of ['src/app/handheld/page.tsx', 'src/app/tablica/page.tsx', 'src/app/dashboard/page.tsx']) {
      const koda = src(pot)
      expect({ pot, tryEnqueueOp: koda.includes('tryEnqueueOp('), barem: /(?<!try)enqueueOp\(/.test(koda) })
        .toEqual({ pot, tryEnqueueOp: true, barem: false })
    }
  })

  it('handheld: ob zavrnitvi sporoči polno vrsto, preden se košarica izprazni', () => {
    const pošlji = offlineVeja(src('src/app/handheld/page.tsx'), 'async function submitCreate', 'async function submitAdd')
    expect(ureditev(pošlji)).toEqual({ sporočilo: true, zavrnitevPredIzpraznitvijo: true })
  })

  it('tablica: enaka vrsta reda kot pri handheldu', () => {
    const pošlji = offlineVeja(src('src/app/tablica/page.tsx'), 'async function submitCreate', 'async function submitAdd')
    expect(ureditev(pošlji)).toEqual({ sporočilo: true, zavrnitevPredIzpraznitvijo: true })
  })

  it('dashboard: nova naročila in kuhinjski status ne obvestita o čakanju ob zavrnitvi', () => {
    const koda = src('src/app/dashboard/page.tsx')
    expect(koda.includes("t('net.queueFull')")).toBe(true)
    const naročilo = koda.slice(koda.indexOf("tryEnqueueOp('order.create'"))
    expect(naročilo.indexOf('if (!rezultat.ok)')).toBeLessThan(naročilo.indexOf("t('net.offlineOrderQueued')"))
  })

  it('bumpWholeTicket: delno odbita serija ne trdi, da je bila vsa sprejeta', () => {
    const koda = src('src/app/dashboard/page.tsx')
    const blok = koda.slice(koda.indexOf('async function bumpWholeTicket'))
    expect({ odbite: blok.includes('let odbite = 0'), preverjeno: /odbite > 0/.test(blok), sporočilo: blok.includes("t('net.queuePartial')") })
      .toEqual({ odbite: true, preverjeno: true, sporočilo: true })
  })

  it('i18n: net.queueFull obstaja v obeh slovarjih in pove, kaj narediti', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    const ključ = 'net.queueFull' as keyof typeof sl
    expect(String(sl[ključ]).length).toBeGreaterThan(20)
    expect(String(hr[ključ as keyof typeof hr]).length).toBeGreaterThan(20)
    expect(String(sl[ključ])).toContain('vrst')
  })
})
