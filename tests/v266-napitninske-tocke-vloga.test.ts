/**
 * v1.266.0 — NAPITNINSKE TOČKE PO VLOGI
 * (docs/PRIMERJAVA-VMESNIKOV-2026 §40; Square Vol 16 | 5. 11. 2026 | v7.32
 * »Split pooled tips by points assigned to each role« — zadnji A-kandidat
 * §37, odložen kot NIZKO: jedro pokrito, delta = predpolnitev po vlogi).
 *
 * Merjena semantika (Square dobesedno, §37 izmera): točke so pripisane
 * VLOGI (enkrat nastavljeno, član sledi svoji vlogi), delitev bazena pa
 * teče po točkah. Naša določitev Ž11: Job.tipPoints INTEGER NOT NULL
 * DEFAULT 0 (vloga = delovno mesto; 0 = brez predpolnitve, vnos ročen);
 * vloga dneva per zaposleni = TimeEntry jobId z največ minutami → primarna
 * EmployeeJob; vnos točk v predogledu delitve (UI luknja: 'po točkah' je
 * bil označen »kmalu« in POST nikoli ni poslal points — GET predogled je
 * trdo klical methodWeights z {} = tiho enakovredno!); POST sanitizira
 * points na VHODU (prej je Infinity šel skozi do splitTips → neobdelan
 * 500); 0 točk = izrecna obramba (gumb zaključka dan onemogočen, dokler
 * uporabnik ne vpiše točke ali izbere drugo osnovo — odkrivanje TIHE
 * enakovredne delitve po zaključku dneva je prepozno).
 *
 *  Č1 · ČISTI SLOJ (sanitizeTipPointsRecord + parseJobTipPoints):
 *    veljavni celi 0..999 ostanejo; NaN/Infinity/negativ/decimal/niz/
 *    Polje/Array izpadejo; meji 0 in 999; DEFAULT 0.
 *  Č2 · API + DDL + MONTAŽA: GET points param + predogled usklajen s
 *    predpolnitvijo (previewPoints = vnešene ?? jobTipPoints — SINHRON
 *    z UI tokom; POST pa IZKLJUČNO prejete, brez tihega vpliva vloge na
 *    denarno pot); POST sanitizacija + revizija pointsSum; izpeljava
 *    vloge dneva (TimeEntry jobId z največ minutami → primarna
 *    EmployeeJob); job-tip-points sloj (pre-DDL read {} / write napaka s
 *    potjo konzole); DDL ruta + register 44 + konzola; PATCH /api/jobs/[id]
 *    (400 validacija NAJPREJ, 503 DDL vrata šele nato, revizija
 *    JOB_TIP_POINTS before/after, sveža vrednost); jobs GET/POST (per
 *    vrstica tipPoints + tipPointsDdlActive, POST DDL-gated); UI
 *    NapitnineTab (vnosna polja točk + aria + predpolnitev + debounce
 *    refetch s points v query + vsota + zero-guard + closeDay pošlje
 *    points + stolpec vloge); JobsCard (DDL-gated urejanje, shrani SAMO
 *    ob spremembi); dashboard posreduje tipPointsDdlActive.
 *  Ž · REGISTRI: verzija 1.267.0, mirror DA / main NE, drift matcher
 *    dvosmerno strogo SAMO Job.tipPoints, i18n pariteta 4320/4320
 *    (+15 ključev), dokument §40 + AUDIT POSODOBITEV, worklog Task ID.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  sanitizeTipPointsRecord, splitTips, TIP_POINTS_MAX,
} from '../src/lib/tips'
import {
  parseJobTipPoints, jobTipPointsAvailable, jobTipPointsFor, writeJobTipPoints,
  resetJobTipPointsProbe, JOB_TIP_POINTS_MAX, DEFAULT_JOB_TIP_POINTS,
} from '../src/lib/job-tip-points'
import { APP_VERSION } from '../src/lib/version'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { isJobTipPointsStatement } from '../scripts/drift-check'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) ČISTI SLOJ (tips.ts sanitize + job-tip-points parse) ──

describe('v1.266.0 Č1 — sanitizeTipPointsRecord + parseJobTipPoints (čisti sloj)', () => {
  test('Č1a: veljavni CELOŠTEVILSKI vnosi 0..999 ostanejo', () => {
    expect(sanitizeTipPointsRecord({ a: 0, b: 1, c: 999, d: 42 })).toEqual({ a: 0, b: 1, c: 999, d: 42 })
  })

  test('Č1b: NaN/Infinity/negativ/decimal/niz/Polje/Array izpadejo (0 je lažje kot 500)', () => {
    // prej: Math.max(0, Number(x) || 0) v methodWeights je spustil Infinity
    // do splitTips → vrgel 'Uteži morajo biti ne-negativna števila.' (neobdelan 500)
    expect(sanitizeTipPointsRecord({
      inf: Number.POSITIVE_INFINITY, nan: Number.NaN, neg: -5, dec: 1.5,
      str: '3', tooBig: 1000, ok: 7,
    })).toEqual({ ok: 7 })
    expect(sanitizeTipPointsRecord(null)).toEqual({})
    expect(sanitizeTipPointsRecord('napaka')).toEqual({})
    expect(sanitizeTipPointsRecord([1, 2])).toEqual({})
    expect(sanitizeTipPointsRecord(42)).toEqual({})
  })

  test('Č1c: prazni/nepopolni ključi izpadejo (employeeId mora biti ne-prazen niz)', () => {
    expect(sanitizeTipPointsRecord({ '': 5, ' ': 5, x: 3 })).toEqual({ x: 3 })
  })

  test('Č1d: parseJobTipPoints — celo 0..999 veljavno, ostalo null', () => {
    expect(parseJobTipPoints(0)).toBe(0)
    expect(parseJobTipPoints(999)).toBe(999)
    expect(parseJobTipPoints(-1)).toBeNull()
    expect(parseJobTipPoints(1000)).toBeNull()
    expect(parseJobTipPoints(2.5)).toBeNull()
    expect(parseJobTipPoints('3')).toBeNull()
    expect(parseJobTipPoints(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseJobTipPoints(null)).toBeNull()
  })

  test('Č1e: konstanti — meja 999 (oba sloja), privzetek vloge 0', () => {
    expect(TIP_POINTS_MAX).toBe(999)
    expect(JOB_TIP_POINTS_MAX).toBe(999)
    expect(DEFAULT_JOB_TIP_POINTS).toBe(0)
  })

  test('Č1f: splitTips vsota-uteži 0 = ENAKOVREDNA delitev (E2E najdba: [1,1] pri 30,00 € je tiho vrglo 29,98 € proč — invarianta vsote zdaj drži)', () => {
    // prej: base [0,0], ostanek 3000, zanka ++ PO EN Vrstni red → [1,1], 2998 centov IZGINILO
    expect(splitTips(3000, [0, 0])).toEqual([1500, 1500])
    expect(splitTips(3000, [0, 0, 0])).toEqual([1000, 1000, 1000])
    // ostanek pri neenakem n: floor + po indeksu (deterministično)
    expect(splitTips(1001, [0, 0])).toEqual([501, 500])
    expect(splitTips(7, [0, 0, 0])).toEqual([3, 2, 2])
    // delne ničle ostanejo nič (utež 0 NISO enakovredne — samo PRAZNA poraba)
    expect(splitTips(3000, [0, 2])).toEqual([0, 3000])
    // invarianta vsote po novem za vsota-0 drži vedno
    for (const [tot, n] of [[3000, 2], [999, 3], [1, 5], [0, 4]] as const) {
      const parts = splitTips(tot, new Array<number>(n).fill(0))
      expect(parts.reduce((a, b) => a + b, 0)).toBe(tot)
    }
  })
})

// ── Č2) API + DDL + MONTAŽA ──

describe('v1.266.0 Č2 — API točk + DDL + UI montaža', () => {
  test('Č2a: GET /api/tips — points param (sanitiziran) + predogled usklajen s predpolnitvijo', () => {
    const route = read('src/app/api/tips/route.ts')
    // opcijsen points=<JSON> query — sanitiziran na VHODU
    expect(route).toContain("url.searchParams.get('points')")
    expect(route).toContain('sanitizeTipPointsRecord(JSON.parse(rawPoints))')
    expect(route).toContain('points mora biti veljaven JSON')
    // predogled: vnešene ?? predpolnitev vloge (SINHRON z UI tokom)
    expect(route).toContain('enteredPoints[r.employeeId] ?? r.jobTipPoints')
    // POST pa IZKLJUČNO prejete (brez tihega vpliva vloge na denarno pot)
    expect(route).toContain('sanitizeTipPointsRecord(body?.points)')
    // odgovor nosi vir predpolnitve + per zaposleni vlogo
    expect(route).toContain('tipPointsDdlActive: await jobTipPointsAvailable()')
    expect(route).toContain('enteredPoints: enteredPoints[r.employeeId] ?? r.jobTipPoints')
  })

  test('Č2b: POST /api/tips — revizija TIP_POOL_CLOSE nosi pointsSum/pointsEntered (iskren zapis uteži)', () => {
    const route = read('src/app/api/tips/route.ts')
    expect(route).toContain("method === 'points' ? { pointsSum")
    expect(route).toContain('pointsEntered: Object.keys(points).length')
  })

  test('Č2c: izpeljava vloge dneva — TimeEntry jobId z največ minutami → primarna EmployeeJob', () => {
    const route = read('src/app/api/tips/route.ts')
    // akumulacija minut per (employee, job)
    expect(route).toContain('const jobMinutes = new Map<string, Map<string, number>>()')
    // izenačeno → prvi po jobId (deterministično)
    expect(route).toContain('(mins === best.mins && jobId < best.jobId)')
    // brez TimeEntry jobId → primarna EmployeeJob (issue #22)
    expect(route).toContain('isPrimary: true')
    // imena + točke vlog DDL-gated
    expect(route).toContain('jobTipPointsFor(jobIds)')
  })

  test('Č2d: job-tip-points sloj — pre-DDL read {} / write napaka s potjo konzole (nikoli tiha odpoved)', async () => {
    resetJobTipPointsProbe(false)
    const map = await jobTipPointsFor(['job-1', 'job-2'])
    expect(map).toEqual({})
    const err = await writeJobTipPoints('job-1', 5)
    expect(typeof err).toBe('string')
    expect(err).toContain('job-tip-points')
    // integer-only validacija (napaka VALIDACIJE se loči od DDL vrat — PATCH vrne 400)
    const bad = await writeJobTipPoints('job-1', 1.5)
    expect(typeof bad).toBe('string')
    expect(bad).toContain('0..999')
    // probe override ostane dokler ga test ne počisti (izolacija naslednjih)
    resetJobTipPointsProbe()
    await expect(jobTipPointsAvailable()).resolves.toBeTruthy()
  })

  test('Č2e: DDL ruta + register SCHEMA_MIGRATIONS 43 → 44 (job-tip-points) + konzola HANDLERS', () => {
    const route = read('src/app/api/admin/migrate-job-tip-points/route.ts')
    expect(route).toContain('ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "tipPoints" INTEGER NOT NULL DEFAULT 0')
    expect(route).toContain('requireCentralRole')
    expect(route).toContain('SCHEMA_MIGRATION_JOB_TIP_POINTS')
    expect(route).toContain('alreadyApplied')
    expect(route).toContain('Tabela Job ne obstaja')

    expect(SCHEMA_MIGRATIONS).toHaveLength(44)
    const m = SCHEMA_MIGRATIONS.find((x) => x.id === 'job-tip-points')
    expect(m).toBeTruthy()
    expect(m!.endpoint).toBe('/api/admin/migrate-job-tip-points')
    expect(m!.descKey).toBe('mig.jobTipPoints.desc')
    const last = SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]
    expect(last.id).toBe('job-tip-points')
    const consoleRoute = read('src/app/api/admin/migrations/route.ts')
    expect(consoleRoute).toContain("import { POST as jobTipPointsPOST } from '../migrate-job-tip-points/route'")
    expect(consoleRoute).toContain("'job-tip-points': jobTipPointsPOST")
  })

  test('Č2f: PATCH /api/jobs/[id] — 400 validacija NAJPREJ, 503 DDL vrata šele nato, revizija', () => {
    const route = read('src/app/api/jobs/[id]/route.ts')
    expect(route).toContain("requirePermission(req, 'settings.manage')")
    expect(route).toContain('Delovno mesto ne obstaja.', 404)
    expect(route).toContain('tipPoints mora biti celo število 0..999.')
    expect(route).toContain('return fail(err, 503)')
    expect(route).toContain('JOB_TIP_POINTS')
    // revizija nosi staro/nova vrednost (dokazljiva sled spremembe uteži delitve)
    expect(route).toContain('jobName: job.name, before, after')
    // odgovor nosi svežo vrednost iz baze
    expect(route).toContain('tipPoints: after')
  })

  test('Č2g: jobs GET/POST — per vrstica tipPoints + tipPointsDdlActive; POST DDL-gated', () => {
    const route = read('src/app/api/jobs/route.ts')
    expect(route).toContain('tipPointsDdlActive: ddlActive')
    expect(route).toContain('tipPoints: points[r.id] ?? 0')
    // POST: tipPoints > 0 pred-DDL → 503 s potjo konzole
    expect(route).toContain('Napitninske točke po vlogi čakajo DDL korak')
    expect(route).toContain('writeJobTipPoints(job.id, rawPoints)')
  })

  test('Č2h: NapitnineTab — vnosna polja točk, predpolnitev, debounce refetch, zero-guard, closeDay', () => {
    const tab = read('src/components/tabs/backoffice-tab.tsx')
    // vnosno polje per zaposleni z ario + samo-cifer omejitvijo (0..999)
    expect(tab).toContain("t('tips.pointsColAria', { name: e.employeeName })")
    expect(tab).toContain("ev.target.value.replace(/\\D/g, '').slice(0, 3)")
    // predpolnitev iz odgovora SAMO dokler uporabnik ni spreminjal
    expect(tab).toContain('e.enteredPoints ?? e.jobTipPoints ?? 0')
    expect(tab).toContain('setPointsDirty(true)')
    // refetch nosi points v query (strežniška matematika — en vir resnice)
    // ptsSig PODPIS namesto objekta v odvisnostih — predpolnitveni init ustvari
    // novo identiteto ob vsakem odgovoru; objekt v deps bi zanko init → refetch →
    // init … neskončno vrtel (E2E najdba: gumb ujet v busy)
    expect(tab).toContain('const ptsSig = method === \'points\' && pointsDirty ? JSON.stringify(pointsInput) : \'\'')
    expect(tab).toContain('encodeURIComponent(ptsSig)')
    expect(tab).toContain('}, [date, locId, method, locations.length, ptsSig])')
    // closeDay pošlje points pri točkovni osnovi
    expect(tab).toContain('if (method === \'points\') body.points = pointsInput')
    // stolpec vloge + em-dash brez vloge
    expect(tab).toContain("t('tips.roleCol')")
    expect(tab).toContain("t('tips.pointsNoRole')")
    // vsota točk + zero-guard (iskrena obramba pred TIHO enakovredno delitvijo)
    expect(tab).toContain("tN('tips.pointsSum', 'tocka'")
    expect(tab).toContain("t('tips.pointsZero')")
    expect(tab).toContain("!(method === 'points' && Object.values(pointsInput).every((v) => !Number(v)))")
    // namig predpolnitve po vlogi
    expect(tab).toContain("t('tips.pointsRoleHint')")
  })

  test('Č2i: JobsCard — DDL-gated urejanje točk, shrani SAMO ob spremembi, aria', () => {
    const tab = read('src/components/tabs/nastavitve-tab.tsx')
    // urejanje vidno SAMO po DDL (graceful pre-DDL)
    expect(tab).toContain('tipPointsDdlActive && canManage')
    // shrani SAMO ob spremembi (migrBox vzorec §39)
    expect(tab).toContain('if (v === (j.tipPoints ?? 0)) return')
    // PATCH pot + toast
    expect(tab).toContain('`/api/jobs/${j.id}`')
    expect(tab).toContain("t('jobs.tipPointsSaved', { job: j.title, n: v })")
    // a11y
    expect(tab).toContain("t('jobs.tipPointsAria', { job: j.title })")
    // nov vnos (create) nosi opcijsene točke
    expect(tab).toContain('body.tipPoints = tp')
  })

  test('Č2j: dashboard posreduje tipPointsDdlActive (JobsCard ve, kdaj pokaže urejanje)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain('tipPointsDdlActive?: boolean')
    expect(page).toContain('setJobsTipDdl(jb.tipPointsDdlActive === true)')
    expect(page).toContain('tipPointsDdlActive={jobsTipDdl}')
  })

  test('Č2k: delitev sama NESPREMENJENA — splitTips/methodWeights brez novih poti (matematika Issue #1)', () => {
    const lib = read('src/lib/tips.ts')
    expect(lib).toContain('export function splitTips(')
    expect(lib).not.toContain('export function splitTipsByRole')
    const route = read('src/app/api/tips/route.ts')
    expect(route).toContain('methodWeights(method, rows, previewPoints)')
    expect(route).toContain('methodWeights(method, rows, points)')
  })
})

// ── Ž) REGISTRI ──

describe('v1.266.0 Ž — registri', () => {
  test('Ž1: verzija 1.267.0 (version.ts + compose)', () => {
    expect(APP_VERSION).toBe('1.307.0')
    expect(read('src/lib/version.ts')).toContain("'1.307.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.307.0')
  })

  test('Ž2: i18n pariteta SL/HR 4320/4320 (+15 ključev vala)', () => {
    for (const k of [
      'tips.roleCol', 'tips.pointsCol', 'tips.pointsColAria', 'tips.pointsRoleHint',
      'tips.pointsNoRole', 'tips.pointsZero', 'tips.pointsSum',
      'jobs.tipPoints', 'jobs.tipPointsShort', 'jobs.tipPointsHint',
      'jobs.tipPointsSave', 'jobs.tipPointsSaved', 'jobs.tipPointsInvalid',
      'jobs.tipPointsAria',
      'mig.jobTipPoints.desc',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
    // 'kmalu' je odšlo — osnova je ZDAJ po vlogi (luknja §40 zapečatena)
    expect(sl['tips.basisPoints']).not.toContain('kmalu')
    expect(hr['tips.basisPoints']).not.toContain('uskoro')
  })

  test('Ž3: SQLite mirror nosi stolpec, MAIN shema GA NE (P2022 disciplina)', () => {
    expect(read('prisma/schema.sqlite.prisma')).toContain('tipPoints    Int           @default(0)')
    const main = read('prisma/schema.prisma')
    expect(main).not.toContain('tipPoints')
  })

  test('Ž4: drift matcher — dvosmerno strogo SAMO Job.tipPoints', () => {
    expect(isJobTipPointsStatement('ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "tipPoints" INTEGER NOT NULL DEFAULT 0')).toBe(true)
    expect(isJobTipPointsStatement('ALTER TABLE "Job" DROP COLUMN "tipPoints"')).toBe(true)
    // tuji stolpec na Job = hard fail (kamuflaža izključena)
    expect(isJobTipPointsStatement('ALTER TABLE "Job" ADD COLUMN "priority" INTEGER')).toBe(false)
    expect(isJobTipPointsStatement('ALTER TABLE "Job" ADD COLUMN "tipPoints", ADD COLUMN "notes2" TEXT')).toBe(false)
    // druga tabela = ni ta vnos
    expect(isJobTipPointsStatement('ALTER TABLE "Employee" ADD COLUMN "tipPoints" INTEGER')).toBe(false)
    expect(isJobTipPointsStatement('ALTER TABLE "Location" ADD COLUMN "kdsExpoFireEnabled" BOOLEAN')).toBe(false)
  })

  test('Ž5: dokument §40 + AUDIT POSODOBITEV v1.266.0', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 40.')
    expect(doc).toContain('NAPITNINSKE TOČKE PO VLOGI v1.266.0')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('POSODOBITEV (v1.266.0, PRIMERJAVA-VMESNIKOV-2026 §40)')
  })

  test('Ž6: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.307.0-nadzorni-val-stabilnosti-viii')
  })
})
