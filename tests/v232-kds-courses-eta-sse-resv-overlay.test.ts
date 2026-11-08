import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_VERSION } from '../src/lib/version'
import { groupKdsItemsByCourse, type KdsCourseLite } from '../src/lib/kds-courses'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

/**
 * v1.232.0 — ZAPRTJE C-SEZNAMA BENCHMARK VALA 4 (docs/PRIMERJAVA-VMESNIKOV-2026.md):
 *
 * 1. REZERVACIJE NA TLORISU (§4 — restavracija 21/22; Toast/TouchBistro
 *    »reservations on floor plan«): naslednja prihajajoča potrjena rezervacija
 *    po mizi — vrstica na ploščici mreže, 🕒 ura na obliki v tlorisu.
 * 2. KDS GRUPIRANJE PO TEČAJIH (§3; Toast/Square »course grouping«): postavke
 *    istega tečaja pod eno glavo; brez tečajev = identičen flat seznam.
 * 3. KDS ETA (§3; Lightspeed »Prep ETA«): obetana ura priprave listka
 *    (ura naročila + cilj najzahtevnejše postaje) v glavi listka.
 * 4. KDS SSE PRETOK (§3 »Push (ne polling)«): /api/kitchen/stream — podpis
 *    MAX(updatedAt) → dogodek changed → takojšnji load('hot'); polling 15 s
 *    ostaja fallback; LIVE oznaka samo ob živi povezavi.
 * 5. P2 POPRAVEK: Select tečaja v NaročiloSheetu pošilja ID (ne courseNumber)
 *    — prej je izbira obstoječega tečaja vrnila 404. P3: mirror množičnega
 *    opomnika primerja UI obliko statusa ('CONFIRMED').
 */

const read = (p: string) => readFileSync(p, 'utf8')
const dash = read('src/app/dashboard/page.tsx')
const kitchenRoute = read('src/app/api/kitchen/route.ts')
const streamRoute = read('src/app/api/kitchen/stream/route.ts')
const kdsCoursesLib = read('src/lib/kds-courses.ts')
const slSrc = read('src/lib/i18n/sl.ts')
const hrSrc = read('src/lib/i18n/hr.ts')
const wl = read('worklog.md')
const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
const prd = read('docs/PRD-LOKALNA-BAZA.md')
const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')

describe('v1.232.0 A — KDS grupiranje po tečajih (lib + ruta + izris)', () => {
  test('A1: groupKdsItemsByCourse — brez tečajev vrne ENO skupino brez glave (ničelna regresija)', () => {
    const items = [
      { id: 'i1', name: 'Juha', courseId: null },
      { id: 'i2', name: 'Zrezek', courseId: null },
    ]
    const groups = groupKdsItemsByCourse(items, [])
    expect(groups.length).toBe(1)
    expect(groups[0].courseId).toBeNull()
    expect(groups[0].items.length).toBe(2)
    expect(groups[0].fired).toBe(false)
  })

  test('A2: groupKdsItemsByCourse — skupine po courseNumber, breztečajne naprej, fired oznaka', () => {
    const courses: KdsCourseLite[] = [
      { id: 'c2', courseNumber: 2, name: 'Glavna jed', status: 'fired', firedAt: '2026-11-02T10:00:00Z' },
      { id: 'c1', courseNumber: 1, name: 'Predjed', status: 'pending', firedAt: null },
    ]
    const items = [
      { id: 'i3', name: 'Zrezek', courseId: 'c2' },
      { id: 'i1', name: 'Juha', courseId: null },
      { id: 'i2', name: 'Solata', courseId: 'c1' },
    ]
    const groups = groupKdsItemsByCourse(items, courses)
    expect(groups.length).toBe(3)
    // breztečajne postavke NA ZAČETKU v obstoječem vrstnem redu
    expect(groups[0].courseId).toBeNull()
    expect(groups[0].items[0].id).toBe('i1')
    // tečaji po courseNumber (1 predjed pred 2 glavno) — NE po vrstnem redu prihoda
    expect(groups[1].courseId).toBe('c1')
    expect(groups[1].label).toBe('Predjed')
    expect(groups[1].fired).toBe(false)
    expect(groups[2].courseId).toBe('c2')
    expect(groups[2].fired).toBe(true)
    expect(groups[2].items[0].id).toBe('i3')
  })

  test('A3: groupKdsItemsByCourse — sirota courseId (neznan tečaj) dobe pošteno glavo, ne izgine', () => {
    const groups = groupKdsItemsByCourse([{ id: 'x', name: 'X', courseId: 'ghost1' }], [])
    expect(groups.length).toBe(1)
    expect(groups[0].courseId).toBe('ghost1')
    expect(groups[0].label).toContain('Tečaj')
    expect(groups[0].items.length).toBe(1)
  })

  test('A4: groupKdsItemsByCourse — prazen seznam = 0 skupin', () => {
    expect(groupKdsItemsByCourse([], []).length).toBe(0)
  })

  test('A5: GET /api/kitchen vključuje Course in vrača aditivno polje courses (sort po številki)', () => {
    expect(kitchenRoute).toContain('Course: true')
    expect(kitchenRoute).toContain('courses: [...o.Course].sort((a, b) => a.courseNumber - b.courseNumber)')
    expect(kitchenRoute).toContain('firedAt: c.firedAt ?? null')
  })

  test('A6: dashboard — OrderT.courses tip + izris skupin z glavo data-region kds-course-group', () => {
    expect(dash).toContain('courses?: CourseT[]')
    expect(dash).toContain("groupKdsItemsByCourse(items, o.courses ?? [])")
    expect(dash).toContain('data-region="kds-course-group"')
    expect(dash).toContain("key={g.courseId ?? 'no-course'}")
  })
})

describe('v1.232.0 B — KDS ETA obljuba (dashboard izris)', () => {
  test('B1: ETA čip na vrstici časovnika — data-region kds-ticket-eta', () => {
    expect(dash).toContain('data-region="kds-ticket-eta"')
  })

  test('B2: ETA = ura naročila + cilj najzahtevnejše postaje (kdsTargetOf — isti vir kot prag zamude)', () => {
    expect(dash).toContain('const tt = Math.max(0, ...items.map((it) => kdsTargetOf(it) ?? 0))')
    expect(dash).toContain('const etaMs = new Date(o.createdAt).getTime() + tt * 60000')
  })

  test('B3: brez cilja postaje ETA iskreno IZOSTANE (ne izmišljujemo obljub) + zamujena obljuba je rdeča', () => {
    expect(dash).toContain('if (tt <= 0 || stale) return null')
    expect(dash).toContain("etaOver ? 'border-red-300 bg-red-50 text-red-800'")
  })

  test('B4: i18n ključi kds.eta / kds.etaTitle v SL in HR', () => {
    expect(slSrc).toContain("'kds.eta':")
    expect(slSrc).toContain("'kds.etaTitle':")
    expect(hrSrc).toContain("'kds.eta':")
    expect(hrSrc).toContain("'kds.etaTitle':")
  })
})

describe('v1.232.0 C — KDS SSE pretok (ruta + klient + LIVE)', () => {
  test('C1: ruta /api/kitchen/stream — text/event-stream, force-dynamic, prag kitchen.update', () => {
    expect(streamRoute).toContain("export const dynamic = 'force-dynamic'")
    expect(streamRoute).toContain("requirePermission(req, 'kitchen.update')")
    expect(streamRoute).toContain('text/event-stream; charset=utf-8')
    expect(streamRoute).toContain("'X-Accel-Buffering': 'no'")
  })

  test('C2: podpis = MAX(updatedAt) aktivnih naročil + postavk + postajnih nalog (ISTI aktivni statusi kot vrsta; Postgres enum cast kot v glavni ruti)', () => {
    expect(streamRoute).toContain("const ORDER_ACTIVE_PRISMA = ORDER_ACTIVE_DB as ('open' | 'sent' | 'prepared')[]")
    expect(streamRoute).toContain('const ITEM_ACTIVE_PRISMA = ITEM_ACTIVE_DB as OrderItemStatus[]')
    expect(streamRoute).toContain('status: { in: ORDER_ACTIVE_PRISMA }')
    expect(streamRoute).toContain('status: { in: ITEM_ACTIVE_PRISMA }')
    expect(streamRoute).toContain("['waiting', 'pending', 'preparing', 'ready']")
    expect(streamRoute).toContain("orderBy: { updatedAt: 'desc' }")
  })

  test('C3: življenjska doba toka je omejena (serverless varnost) + retry hint', () => {
    expect(streamRoute).toContain('MAX_LIFETIME_MS = 55_000')
    expect(streamRoute).toContain('retry: 5000')
  })

  test('C4: abort/ping disciplína — req.signal zapre tok, ping drži povezavo', () => {
    expect(streamRoute).toContain("req.signal.addEventListener('abort', onAbort)")
    expect(streamRoute).toContain(': ping\\n\\n')
  })

  test('C5: klient — EventSource SAMO na zavihku kuhinja + tabHasPerm (brez 403 kroga); odvisnost efekta je IZPELJANI BOOLEAN, ne array perms', () => {
    expect(dash).toContain("new EventSource('/api/kitchen/stream')")
    expect(dash).toContain("const kdsSseOpen = activeTab === 'kuhinja' && tabHasPerm('kuhinja', { canManage, perms })")
    expect(dash).toContain('if (!kdsSseOpen) return')
    // E2E najdba (close/open krog vsakih ~1,6 s): setPerms v load() ustvari novo
    // referenco arraya na vsakem pollu — deps [perms] bi razstrelil identiteto.
    expect(dash).toContain('}, [kdsSseOpen, load])')
    expect(dash).not.toContain('}, [activeTab, canManage, perms, load])')
  })

  test('C6: dogodek changed sproži load(hot) z dušenjem (2,5 s) — polling ostaja fallback', () => {
    expect(dash).toContain("es.addEventListener('changed', () => {")
    expect(dash).toContain('if (now - lastTrig < 2500) return')
    expect(dash).toContain("void load('hot')")
  })

  test('C6b: PRVI podpis ob povezavi je BAZNA ČRTA (event baseline, brez changed) — ponovna povezava NE sproži odvečnega load(hot)', () => {
    expect(streamRoute).toContain("let lastSig: string | null = null // null = prvi odčitek (bazna črta, brez changed)")
    expect(streamRoute).toContain("if (lastSig !== null && sig !== lastSig) {")
    expect(streamRoute).toContain("send('baseline', sig)")
    expect(streamRoute).not.toContain("let lastSig = ''")
  })

  test('C7: LIVE oznaka samo ob živi povezavi (hello/open vključi, error izključi)', () => {
    expect(dash).toContain('data-region="kds-live"')
    expect(dash).toContain("es.addEventListener('hello', () => setKdsLive(true))")
    expect(dash).toContain('es.onerror = () => setKdsLive(false)')
  })

  test('C8: i18n ključi kds.live / kds.liveTitle v SL in HR', () => {
    expect(slSrc).toContain("'kds.live':")
    expect(slSrc).toContain("'kds.liveTitle':")
    expect(hrSrc).toContain("'kds.live':")
    expect(hrSrc).toContain("'kds.liveTitle':")
  })
})

describe('v1.232.0 D — rezervacije na tlorisu (overlay) + P3 mirror popravek', () => {
  test('D1: memo nextResvByTable — samo CONFIRMED s tableId in prihodnjim terminom, najzgodnejša', () => {
    expect(dash).toContain('const nextResvByTable = useMemo(() => {')
    expect(dash).toContain("if (r.status !== 'CONFIRMED' || !r.tableId) continue")
    expect(dash).toContain('if (!Number.isFinite(at) || at < now) continue')
  })

  test('D2: ploščica mreže — vrstica rezervacije (data-region tile-resv) samo brez aktivnega naročila', () => {
    expect(dash).toContain('data-region="tile-resv"')
    expect(dash).toContain('if (!rv || tb.activeOrder) return null')
  })

  test('D3: zasedena miza — kompaktna rezervacija v nogi (data-region tile-resv-compact)', () => {
    expect(dash).toContain('data-region="tile-resv-compact"')
    expect(dash).toContain('tb.activeOrder && (() => {')
  })

  test('D4: tloris — 🕒 ura na obliki mize (data-region plan-resv) + rezervacija v aria-label/title', () => {
    expect(dash).toContain('data-region="plan-resv"')
    expect(dash).toContain('t(\'tables.resvNext\')')
  })

  test('D5: i18n ključ tables.resvNext v SL in HR', () => {
    expect(slSrc).toContain("'tables.resvNext':")
    expect(hrSrc).toContain("'tables.resvNext':")
  })

  test('D6: P3 popravek — mirror množičnega opomnika primerja UI obliko CONFIRMED (ne DB maločrkovno)', () => {
    expect(dash).toContain("r.status !== 'CONFIRMED'")
    expect(dash).not.toContain("r.status !== 'confirmed'")
  })
})

describe('v1.232.0 E — P2 popravek Selecta tečaja (NaročiloSheet)', () => {
  test('E1: vrednost opcije obstoječega tečaja je ID (ne courseNumber) — 404 »Tečaj ne obstaja« je odpravljen', () => {
    expect(dash).toContain('<SelectItem key={c.id} value={c.id}>{c.courseNumber}. {c.name}</SelectItem>')
    expect(dash).not.toContain('value={String(c.courseNumber)}')
  })

  test('E2: assignCourse še vedno pošilja courseId v PATCH (nespremenjena pogodba rute)', () => {
    expect(dash).toContain('JSON.stringify({ courseId: v, itemIds: [itemId] })')
  })
})

describe('v1.232.0 Ž — verzija + dokumenti + registri', () => {
  test('Ž1: verzija je dvignjena na 1.238.0 (version.ts + compose oznaka)', () => {
    expect(APP_VERSION).toBe('1.281.0')
    expect(read('src/lib/version.ts')).toContain("'1.281.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.281.0')
  })

  test('Ž2: dokument PRIMERJAVA nosi val v1.233.0 (KDS 17/18, restavracija 22/22)', () => {
    expect(doc).toContain('Val v1.233.0')
    expect(doc).toContain('| Kuhinja (KDS) | 17/18 |')
    /* ZAVESTNA SPREMEMBA PINA (v1.233.0): dokument je ŽIV sledilnik — seštevek
       restavracije je 21/22 → 22/22 z valom v1.233.0 (urejevalnik con, §11);
       zgodovina vala v1.232 (§10) ostaja nedotaknjena. */
    expect(doc).toContain('| Restavracija | 22/22 |')
    expect(doc).toContain('**v1.232**')
  })

  test('Ž3: PRD §8 R4b nosi BENCHMARK-VAL v1.233.0 vrstico (doc-truth)', () => {
    expect(prd).toContain('BENCHMARK-VAL v1.233.0')
    expect(prd).toContain('REZERVACIJE NA TLORISU')
    expect(prd).toContain('KDS SSE')
  })

  test('Ž4: worklog vrh nosi Task ID v1.235.0 nad prejšnjim valom', () => {
    expect(wl.slice(0, 400)).toContain('Task ID: v1.281.0-oss-potrditev')
    expect(wl.indexOf('Task ID: v1.239.0')).toBeLessThan(wl.indexOf('Task ID: v1.231.0'))
  })

  test('Ž5: i18n števci + novi ključi SL/HR (3846/3846, +5)', () => {
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    for (const k of ['kds.eta', 'kds.etaTitle', 'kds.live', 'kds.liveTitle', 'tables.resvNext']) {
      expect(typeof (sl as Record<string, string>)[k]).toBe('string')
      expect(typeof (hr as Record<string, string>)[k]).toBe('string')
    }
    // RESTAURANTOS-AUDIT števec usklajen
    expect(auditDoc).toContain('4324 ključev SL in 4324 HR')
    expect(auditDoc).toContain('POSODOBITEV (v1.233.0')
  })
})
