/**
 * Issue #31 (P1) — STREŽNIŠKO uveljavljanje MFA za privilegirane vloge:
 * enforcement (MFA_ENFORCE_AFTER) → enrollment-only žeton (1 h) + requireAuth
 * 401 + dovoljenjski sloj 403; migracijsko obdobje = mfaMandatory zastavica;
 * manager izrecno privilegiran; vloga/MFA stanje vedno iz DB.
 * Issue #32 (P1) — distribuirana/večdimenzionalna zaščita prijave:
 * store-aware limiter (Upstash aktiven samo z env; izpad → memory fallback +
 * glasen console.error), IP limit, ACCOUNT limit (burst + progresivno okno),
 * platforma IP signal (x-vercel-forwarded-for), namenski MFA limit.
 * Issue #33 (P1) — step-up (svež PIN) za enroll/enable/disable + revokacija
 * vseh ostalih sej (sessionVersion +1) + nadaljevalni žeton; audit brez
 * skrivnosti/kod; sočasen enroll → CAS 409.
 * Issue #34 (P1) — bootstrap break-glass VEDNO ločena identiteta
 * (sub='bootstrap', 2 h) — nikoli seja pod employee.id (tudi ob napačnem
 * PIN-u obstoječega zaposlenega; MFA se ne more obiti); lastna audit
 * dogodka; LOGIN_FAILED ni končni zapis break-glass poti.
 * Issue #35 (P1) — ATOMARNA poraba recovery kode (CAS na mfaRecoveryVersion):
 * sočasna ista koda → točno ena zmagovalka; ostale kode ostanejo; različne
 * kode sočasno lahko obe uspeta (re-iteracija po svežem stanju).
 * Issue #36 (P1) — RFC 6238 §5.2 TOTP replay: uspešen korak atomarno zapisan
 * (mfaLastTotpCounter); ista koda (zaporedno ali sočasno) zavrnjena; naslednji
 * korak sprejet; prejšnji korak po novejšem zavrnjen.
 *
 * Vzorec: direktni uvoz route handlerjev (furs-post / pi49); fiksature s
 * predpono `i31-` + RUN; sweep beforeAll/afterAll. Login klici nosijo
 * unikaten x-forwarded-for (ločeni IP bucketi). DETERMINIZEM TOTP: vsak test
 * neposredno nastavi mfaLastTotpCounter fiksno (±1 okno potem vedno sprejme
 * kodo lastnega koraka — drift 0/−1), zato replay/monotonost preverjata
 * NATANKO politiko, ne urno mejo.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '../src/lib/db'
import { sweepTestFixtures } from './helpers/fixture-sweep'
import { createToken, verifyToken, employeePinFields } from '../src/lib/auth'
import { generateSecret, hotp, generateRecoveryCodes, recoveryHashesToStore, roleRequiresMfa, mfaEnforcementActive } from '../src/lib/mfa'
import { mfaAttemptRateLimited } from '../src/lib/mfa-stepup'
import { __resetRateLimitForTests, __resetStoreForTests, rateLimitSharedAsync } from '../src/lib/rate-limit'
import { jstr } from '../src/lib/map'
import { POST as loginPOST } from '../src/app/api/auth/login/route'
import { POST as enrollPOST } from '../src/app/api/auth/mfa/enroll/route'
import { POST as enablePOST } from '../src/app/api/auth/mfa/enable/route'
import { POST as disablePOST } from '../src/app/api/auth/mfa/disable/route'
import { GET as mfaStatusGET } from '../src/app/api/auth/mfa/status/route'
import { GET as settingsGET } from '../src/app/api/settings/route'
import { GET as meGET } from '../src/app/api/auth/me/route'

const PREFIX = 'i31-'
const RUN = Date.now().toString(36)

/* ── fiksature ── */
let pinSeq = 0
/** unikaten PIN na fiksuro (pinLookup je UNIQUE — isti PIN = isti HMAC indeks) */
const uniqPin = () => String(310000 + (++pinSeq % 699999))
let ipSeq = 0
const uniqIp = () => `10.7.${++ipSeq}.${(ipSeq % 250) + 1}`

interface Emp {
  id: string; email: string; name: string; role: string; pin: string
  secret?: string; recoveryCodes?: string[]; enrolled?: string
}
const mk = (name: string, role: string, opts: { mfa?: boolean; recoveryCount?: number } = {}): Emp => {
  const email = `${name}-${RUN}@i31.test`
  const secret = opts.mfa === true ? generateSecret() : undefined
  const recoveryCodes = opts.recoveryCount ? generateRecoveryCodes(opts.recoveryCount) : undefined
  return { id: `${PREFIX}${name}-${RUN}`, email, name, role, pin: uniqPin(), secret, recoveryCodes }
}

const BOOT_PIN = '998877'
let mfaEmp: Emp           // #35/#36 — MFA aktivna (TOTP + recovery)
let recEmp: Emp           // #35 — recovery fokus
let stepEmp: Emp          // #33 — step-up/enable/disable
let adminEmp: Emp         // #31/#34/#32 — admin brez MFA
let bootEmp: Emp          // #34 — MFA aktivni admin na bootstrap e-pošti
let staffEmp: Emp         // #31 — operativna vloga (neprednostna)
let inactiveEmp: Emp      // #34 — deaktiviran račun + break-glass

async function createEmp(e: Emp, opts: { mfaEnabled?: boolean; status?: string; recovery?: string[]; secret?: string } = {}) {
  const fields = employeePinFields(e.pin, e.email)
  await db.employee.create({
    data: {
      id: e.id, name: e.name, email: e.email, role: e.role, status: opts.status || 'active',
      pin: fields.pin, pinLookup: fields.pinLookup, locationId: null, sessionVersion: 0,
      mfaSecret: opts.secret ?? null,
      mfaEnabled: opts.mfaEnabled ?? false,
      mfaRecoveryCodes: jstr(opts.recovery ? recoveryHashesToStore(opts.recovery) : []),
    },
  })
}

beforeAll(async () => {
  await sweepTestFixtures(db, [PREFIX])
  mfaEmp = mk('mfa', 'admin', { mfa: true })
  recEmp = mk('rec', 'manager', { mfa: true, recoveryCount: 5 })
  stepEmp = mk('step', 'staff')
  adminEmp = mk('adm', 'admin')
  bootEmp = mk('boot', 'admin', { mfa: true })
  staffEmp = mk('stf', 'waiter')
  inactiveEmp = mk('ina', 'admin')
  await createEmp(mfaEmp, { mfaEnabled: true, secret: mfaEmp.secret })
  await createEmp(recEmp, { mfaEnabled: true, secret: recEmp.secret, recovery: recEmp.recoveryCodes })
  await createEmp(stepEmp)
  await createEmp(adminEmp)
  await createEmp(bootEmp, { mfaEnabled: true, secret: bootEmp.secret })
  await createEmp(staffEmp)
  await createEmp(inactiveEmp, { status: 'inactive' })
})

afterAll(async () => {
  delete process.env.MFA_ENFORCE_AFTER
  delete process.env.BOOTSTRAP_ADMIN_EMAIL
  delete process.env.BOOTSTRAP_ADMIN_PIN
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  __resetStoreForTests()
  __resetRateLimitForTests()
  await sweepTestFixtures(db, [PREFIX])
})

/* ── helperji ── */
function loginReq(e: { email: string }, pin: string, extra: Record<string, unknown> = {}, ip = uniqIp()): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: e.email, pin, ...extra }),
  })
}
/** trenutni TOTP korak (30 s) */
const curCounter = () => Math.floor(Date.now() / 1000 / 30)
const codeFor = (secret: string, counter = curCounter()) => hotp(secret, counter, 6)!
/** deterministični reset zadnjega sprejetega koraka (fiksna vrednost) */
const setLastCounter = (id: string, counter: number | null) =>
  db.employee.update({ where: { id }, data: { mfaLastTotpCounter: counter } })
const tokReq = (url: string, token: string, method = 'GET', body?: unknown): NextRequest =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
async function call(r: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = (await (r as Promise<unknown> | Response)) as Response
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}
const login = (e: { email: string }, pin: string, extra: Record<string, unknown> = {}, ip?: string) =>
  call(loginPOST(loginReq(e, pin, extra, ip)))

/* ══════════ #34 — bootstrap break-glass: VEDNO ločena identiteta ══════════ */

describe('#34 bootstrap break-glass — ločena identiteta (nikoli employee.id)', () => {
  it('neobstoječa e-pošta + veljavna bootstrap poverilnica → sub=bootstrap (2 h)', async () => {
    // bootstrap env BREZ Employee vrstice — čista break-glass obnova dostopa
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'ghost@i31.test'
    process.env.BOOTSTRAP_ADMIN_PIN = BOOT_PIN
    const { code, body } = await login({ email: 'ghost@i31.test' }, BOOT_PIN)
    expect(code).toBe(200)
    expect(body.bootstrap).toBe(true)
    const payload = verifyToken(String(body.token))
    expect(payload?.sub).toBe('bootstrap')
    expect(payload?.role).toBe('ADMIN')
    expect(Number(payload?.exp) - Date.now()).toBeGreaterThan(1.9 * 3600_000) // 2 h
    expect((body.employee as Record<string, unknown>).id).toBe('bootstrap')
    const audit = await db.auditLog.findFirst({
      where: { action: 'LOGIN_BOOTSTRAP_USED', entityId: 'ghost@i31.test' },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
  })

  it('AKTIVNI zaposleni (MFA vklopljena!) + NAPAČEN PIN + bootstrap → sub=bootstrap (NE employee.id — MFA se ne obide)', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = bootEmp.email // bootstrap e-pošta USTRAJA obstoječemu zaposlenemu
    const { code, body } = await login(bootEmp, BOOT_PIN)
    expect(code).toBe(200)
    const payload = verifyToken(String(body.token))
    expect(payload?.sub).toBe('bootstrap')
    expect(payload?.sub).not.toBe(bootEmp.id)
    expect(body.bootstrap).toBe(true)
    const brk = await db.auditLog.findFirst({
      where: { action: 'LOGIN_BOOTSTRAP_BREAKGLASS', entityId: bootEmp.id },
      orderBy: { timestamp: 'desc' },
    })
    expect(brk).not.toBeNull()
    // LOGIN_FAILED NI končni zapis break-glass poti (ni ga PO break-glass dogodku)
    const failAfter = await db.auditLog.findFirst({
      where: { action: 'LOGIN_FAILED', entityId: bootEmp.id, timestamp: { gt: brk!.timestamp } },
      orderBy: { timestamp: 'desc' },
    })
    expect(failAfter).toBeNull()
  })

  it('DEAKTIVIRAN zaposleni + bootstrap → break-glass obnova dostopa (sub=bootstrap)', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = inactiveEmp.email // obnova ZAKLENJENEGA računa — edina pot
    const { code, body } = await login(inactiveEmp, BOOT_PIN)
    expect(code).toBe(200)
    expect(verifyToken(String(body.token))?.sub).toBe('bootstrap')
  })

  it('napačna bootstrap poverilnica na obstoječem računu → 401 + LOGIN_FAILED', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = bootEmp.email
    const { code } = await login(bootEmp, '000000')
    expect(code).toBe(401)
    const audit = await db.auditLog.findFirst({
      where: { action: 'LOGIN_FAILED', entityId: bootEmp.id },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
  })

  it('bootstrap žeton nima sv (break-glass fast-path) in preide dovoljenjski sloj', async () => {
    const token = createToken({ sub: 'bootstrap', name: 'Bootstrap Admin', role: 'ADMIN', loc: null }, 2)
    expect(typeof verifyToken(token)?.sv).toBe('undefined')
    const { code } = await call(settingsGET(tokReq('/api/settings', token)))
    expect(code).toBe(200)
  })
})

/* ══════════ #35 — atomarna poraba recovery kode ══════════ */

describe('#35 recovery koda — atomarna (CAS) poraba', () => {
  it('zaporedna uporaba iste kode: prva 200, druga 401 — koda FIZIČNO odstranjena', async () => {
    const first = await login(recEmp, recEmp.pin, { mfaRecoveryCode: recEmp.recoveryCodes![0] })
    expect(first.code).toBe(200)
    const second = await login(recEmp, recEmp.pin, { mfaRecoveryCode: recEmp.recoveryCodes![0] })
    expect(second.code).toBe(401)
    expect(second.body.mfaRequired).toBe(true)
    const emp = await db.employee.findUnique({ where: { id: recEmp.id }, select: { mfaRecoveryCodes: true } })
    expect(JSON.parse(String(emp!.mfaRecoveryCodes))).toHaveLength(recEmp.recoveryCodes!.length - 1)
  })

  it('SOČASNA uporaba iste kode → NATANKO ENA uspe (druga 401 BREZ žetona)', async () => {
    const code = recEmp.recoveryCodes![1]
    const [a, b] = await Promise.all([
      login(recEmp, recEmp.pin, { mfaRecoveryCode: code }, uniqIp()),
      login(recEmp, recEmp.pin, { mfaRecoveryCode: code }, uniqIp()),
    ])
    expect([a, b].filter((r) => r.code === 200)).toHaveLength(1)
    expect([a, b].filter((r) => r.code === 401)).toHaveLength(1)
    const loser = [a, b].find((r) => r.code === 401)!
    expect(loser.body.token).toBeUndefined()
    // poražena zahteva NE povozi zmagovalkinega zapisa (seznam se skrči SAMO enkrat)
    const emp = await db.employee.findUnique({ where: { id: recEmp.id }, select: { mfaRecoveryCodes: true, mfaRecoveryVersion: true } })
    expect(JSON.parse(String(emp!.mfaRecoveryCodes))).toHaveLength(recEmp.recoveryCodes!.length - 2)
    expect(Number(emp!.mfaRecoveryVersion)).toBeGreaterThanOrEqual(2)
  })

  it('SOČASNA uporaba DVEH RAZLIČNIH kod → obe uspeta (sveža re-iteracija po CAS)', async () => {
    const [a, b] = await Promise.all([
      login(recEmp, recEmp.pin, { mfaRecoveryCode: recEmp.recoveryCodes![2] }, uniqIp()),
      login(recEmp, recEmp.pin, { mfaRecoveryCode: recEmp.recoveryCodes![3] }, uniqIp()),
    ])
    expect(a.code).toBe(200)
    expect(b.code).toBe(200)
    const emp = await db.employee.findUnique({ where: { id: recEmp.id }, select: { mfaRecoveryCodes: true } })
    expect(JSON.parse(String(emp!.mfaRecoveryCodes))).toHaveLength(recEmp.recoveryCodes!.length - 4)
  })

  it('neznana koda → 401, seznam NESPREMENJEN (fail-closed)', async () => {
    const before = await db.employee.findUnique({ where: { id: recEmp.id }, select: { mfaRecoveryCodes: true } })
    const { code } = await login(recEmp, recEmp.pin, { mfaRecoveryCode: 'XXXX-XXXX' })
    expect(code).toBe(401)
    const after = await db.employee.findUnique({ where: { id: recEmp.id }, select: { mfaRecoveryCodes: true } })
    expect(String(after!.mfaRecoveryCodes)).toBe(String(before!.mfaRecoveryCodes))
  })

  it('uspešna recovery prijava: žeton izdan, MFA_RECOVERY_USED audit BREZ kode', async () => {
    const { code, body } = await login(recEmp, recEmp.pin, { mfaRecoveryCode: recEmp.recoveryCodes![4] })
    expect(code).toBe(200)
    expect(typeof body.token).toBe('string')
    const audit = await db.auditLog.findFirst({
      where: { action: 'MFA_RECOVERY_USED', entityId: recEmp.id },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(String(audit!.details)).not.toContain(recEmp.recoveryCodes![4])
  })
})

/* ══════════ #36 — TOTP replay zaščita (RFC 6238 §5.2) ══════════ */

describe('#36 TOTP — atomarna zahteva koraka (replay zavrnjen)', () => {
  beforeEach(async () => {
    // determinizem: zadnji sprejeti korak fiksno NULL pred vsakim testom
    await setLastCounter(mfaEmp.id, null)
  })

  it('veljavna koda trenutnega koraka → 200, točno TA korak zapisan v DB', async () => {
    const c = curCounter()
    const { code, body } = await login(mfaEmp, mfaEmp.pin, { mfaCode: codeFor(mfaEmp.secret!, c) })
    expect(code).toBe(200)
    expect(typeof body.token).toBe('string')
    const emp = await db.employee.findUnique({ where: { id: mfaEmp.id }, select: { mfaLastTotpCounter: true } })
    expect(Number(emp!.mfaLastTotpCounter)).toBe(c)
  })

  it('ISTA koda znova (isti korak) → 401 brez žetona (RFC 6238 §5.2)', async () => {
    const c = curCounter()
    const first = await login(mfaEmp, mfaEmp.pin, { mfaCode: codeFor(mfaEmp.secret!, c) })
    expect(first.code).toBe(200)
    const second = await login(mfaEmp, mfaEmp.pin, { mfaCode: codeFor(mfaEmp.secret!, c) })
    expect(second.code).toBe(401)
    expect(second.body.mfaRequired).toBe(true)
    expect(second.body.token).toBeUndefined()
  })

  it('SOČASNI klic iste kode → natanko ENA prijava uspe', async () => {
    const c = curCounter()
    const code = codeFor(mfaEmp.secret!, c)
    const [a, b] = await Promise.all([
      login(mfaEmp, mfaEmp.pin, { mfaCode: code }, uniqIp()),
      login(mfaEmp, mfaEmp.pin, { mfaCode: code }, uniqIp()),
    ])
    expect([a, b].filter((r) => r.code === 200)).toHaveLength(1)
    expect([a, b].filter((r) => r.code === 401)).toHaveLength(1)
  })

  it('koda NASLEDNJEga koraka po porabi prejšnjega → sprejeta (monotona rast)', async () => {
    const c = curCounter()
    await setLastCounter(mfaEmp.id, c - 1) // prejšnji korak porabljen
    const { code, body } = await login(mfaEmp, mfaEmp.pin, { mfaCode: codeFor(mfaEmp.secret!, c) })
    expect(code).toBe(200)
    const emp = await db.employee.findUnique({ where: { id: mfaEmp.id }, select: { mfaLastTotpCounter: true } })
    expect(Number(emp!.mfaLastTotpCounter)).toBe(c)
    expect(typeof body.token).toBe('string')
  })

  it('koda PREJŠNJEGA koraka, ko je bil porabljen NOVEJŠI → 401 (striktna monotonost)', async () => {
    const c = curCounter()
    await setLastCounter(mfaEmp.id, c + 1) // novejši korak porabljen
    const { code, body } = await login(mfaEmp, mfaEmp.pin, { mfaCode: codeFor(mfaEmp.secret!, c) })
    expect(code).toBe(401) // CAS: c ≤ c+1 → zavrnjeno (politika, ne zgolj okno)
    expect(body.token).toBeUndefined()
  })

  it('neveljavna koda → 401 (fail-closed, MFA_LOGIN_FAILED)', async () => {
    const { code } = await login(mfaEmp, mfaEmp.pin, { mfaCode: '000000' })
    expect(code).toBe(401)
    const audit = await db.auditLog.findFirst({
      where: { action: 'MFA_LOGIN_FAILED', entityId: mfaEmp.id },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
  })
})

/* ══════════ #33 — step-up PIN + revokacija sej ob MFA spremembi ══════════ */

describe('#33 MFA spremembe — svež PIN step-up + sessionVersion revokacija', () => {
  const tok = (sv = 0) => createToken({ sub: stepEmp.id, name: stepEmp.name, role: 'WAITER', loc: null, sv })

  it('enroll BREZ PIN-a → 401, mfaSecret NEspremenjen', async () => {
    const { code } = await call(enrollPOST(tokReq('/api/auth/mfa/enroll', tok(), 'POST', {})))
    expect(code).toBe(401)
    const emp = await db.employee.findUnique({ where: { id: stepEmp.id }, select: { mfaSecret: true } })
    expect(emp!.mfaSecret).toBeNull()
  })

  it('enroll z NAPAČNIM PIN-om → 401 + MFA_STEPUP_FAILED audit (brez PIN vrednosti)', async () => {
    const { code } = await call(enrollPOST(tokReq('/api/auth/mfa/enroll', tok(), 'POST', { pin: '111111' })))
    expect(code).toBe(401)
    const audit = await db.auditLog.findFirst({
      where: { action: 'MFA_STEPUP_FAILED', entityId: stepEmp.id },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(String(audit!.details)).not.toContain('111111')
  })

  it('enroll s PRAVIM PIN-om → 201 + skrivnost/otpauth/QR; zapis v DB', async () => {
    const { code, body } = await call(enrollPOST(tokReq('/api/auth/mfa/enroll', tok(), 'POST', { pin: stepEmp.pin })))
    expect(code).toBe(201)
    expect(typeof body.secret).toBe('string')
    expect(String(body.otpauthUri)).toContain('otpauth://totp/')
    expect(String(body.qrDataUrl)).toContain('data:image/png;base64,')
    const emp = await db.employee.findUnique({ where: { id: stepEmp.id }, select: { mfaSecret: true, mfaEnabled: true } })
    expect(emp!.mfaSecret).toBe(body.secret)
    expect(emp!.mfaEnabled).toBe(false)
    stepEmp.enrolled = String(body.secret)
  })

  it('SOČASEN drugi enroll (oba s pravim PIN) → točno en 201, drugi 409 (CAS konflikt)', async () => {
    const [a, b] = await Promise.all([
      call(enrollPOST(tokReq('/api/auth/mfa/enroll', tok(), 'POST', { pin: stepEmp.pin }))),
      call(enrollPOST(tokReq('/api/auth/mfa/enroll', tok(), 'POST', { pin: stepEmp.pin }))),
    ])
    expect([a.code, b.code].sort()).toEqual([201, 409])
    const emp = await db.employee.findUnique({ where: { id: stepEmp.id }, select: { mfaSecret: true } })
    const winner = [a, b].find((r) => r.code === 201)!
    expect(emp!.mfaSecret).toBe(winner.body.secret) // najnovejši zapis ≙ odziv
    stepEmp.enrolled = String(winner.body.secret)
  })

  it('enable BREZ PIN-a (samo koda) → 401 — ukraden žeton NE more aktivirati MFA', async () => {
    const { code } = await call(enablePOST(tokReq('/api/auth/mfa/enable', tok(), 'POST', { code: codeFor(stepEmp.enrolled!) })))
    expect(code).toBe(401)
    const emp = await db.employee.findUnique({ where: { id: stepEmp.id }, select: { mfaEnabled: true } })
    expect(emp!.mfaEnabled).toBe(false)
  })

  it('enable s PIN + veljavno kodo → 200: MFA aktivna, sv+1 (stare seje MRTVE), 8 recovery hash-ev, nadaljevalni žeton DELA', async () => {
    const { code, body } = await call(enablePOST(tokReq('/api/auth/mfa/enable', tok(), 'POST', { pin: stepEmp.pin, code: codeFor(stepEmp.enrolled!) })))
    expect(code).toBe(200)
    expect((body.recoveryCodes as string[]).length).toBe(8)
    const emp = await db.employee.findUnique({
      where: { id: stepEmp.id },
      select: { mfaEnabled: true, sessionVersion: true, mfaLastTotpCounter: true, mfaRecoveryCodes: true },
    })
    expect(emp!.mfaEnabled).toBe(true)
    expect(Number(emp!.sessionVersion)).toBe(1)
    expect(emp!.mfaLastTotpCounter).toBeNull() // nova skrivnost — števci resetirani
    expect(JSON.parse(String(emp!.mfaRecoveryCodes))).toHaveLength(8)
    // STARI žeton (sv=0) → 401 (revokacija!); NADALJEVALNI (sv=1) → 200
    expect((await call(meGET(tokReq('/api/auth/me', tok())))).code).toBe(401)
    expect((await call(meGET(tokReq('/api/auth/me', String(body.token))))).code).toBe(200)
  })

  it('disable BREZ PIN-a (samo TOTP koda) → 401 — MFA ostaja aktivna', async () => {
    const { code } = await call(disablePOST(tokReq('/api/auth/mfa/disable', tok(1), 'POST', { code: codeFor(stepEmp.enrolled!) })))
    expect(code).toBe(401)
    const emp = await db.employee.findUnique({ where: { id: stepEmp.id }, select: { mfaEnabled: true } })
    expect(emp!.mfaEnabled).toBe(true)
  })

  it('disable s PIN + TOTP kodo → 200: MFA izklopljena, sv+2, skrivnost/števci počiščeni, nadaljevalni žeton', async () => {
    const { code, body } = await call(disablePOST(tokReq('/api/auth/mfa/disable', tok(1), 'POST', { pin: stepEmp.pin, code: codeFor(stepEmp.enrolled!) })))
    expect(code).toBe(200)
    const emp = await db.employee.findUnique({
      where: { id: stepEmp.id },
      select: { mfaEnabled: true, mfaSecret: true, sessionVersion: true, mfaRecoveryCodes: true, mfaLastTotpCounter: true },
    })
    expect(emp!.mfaEnabled).toBe(false)
    expect(emp!.mfaSecret).toBeNull()
    expect(Number(emp!.sessionVersion)).toBe(2)
    expect(JSON.parse(String(emp!.mfaRecoveryCodes))).toHaveLength(0)
    expect(emp!.mfaLastTotpCounter).toBeNull()
    expect(typeof body.token).toBe('string') // nadaljevalni žeton (sv=2)
  })

  it('audit HIGIENA: noben zapis ne vsebuje skrivnosti, otpauth URI-ja ali PIN-a', async () => {
    const rows = await db.auditLog.findMany({ where: { entityId: stepEmp.id } })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const text = `${r.action} ${r.details || ''}`
      expect(text).not.toContain(stepEmp.enrolled!)
      expect(text).not.toContain('otpauth://')
      expect(text).not.toContain(stepEmp.pin)
    }
  })
})

/* ══════════ #31 — strežniško uveljavljanje MFA (enforcement) ══════════ */

describe('#31 enforcement — MFA_ENFORCE_AFTER strežniško uveljavljanje', () => {
  it('roleRequiresMfa: manager ZAHTEVA MFA (izrecna odločitev — enak obseg pravic kot admin)', () => {
    expect(roleRequiresMfa('manager')).toBe(true)
    expect(roleRequiresMfa('MANAGER')).toBe(true)
    expect(roleRequiresMfa('owner')).toBe(true)
    expect(roleRequiresMfa('waiter')).toBe(false)
  })

  it('mfaEnforcementActive: unset → false; pretekli ISO/epoch → true; prihodnji/neveljaven → false', () => {
    const keep = process.env.MFA_ENFORCE_AFTER
    delete process.env.MFA_ENFORCE_AFTER
    expect(mfaEnforcementActive()).toBe(false)
    process.env.MFA_ENFORCE_AFTER = new Date(Date.now() - 1000).toISOString()
    expect(mfaEnforcementActive()).toBe(true)
    process.env.MFA_ENFORCE_AFTER = String(Date.now() - 1000)
    expect(mfaEnforcementActive()).toBe(true)
    process.env.MFA_ENFORCE_AFTER = new Date(Date.now() + 86_400_000).toISOString()
    expect(mfaEnforcementActive()).toBe(false)
    process.env.MFA_ENFORCE_AFTER = 'ni-veljavno'
    expect(mfaEnforcementActive()).toBe(false)
    if (keep === undefined) delete process.env.MFA_ENFORCE_AFTER
    else process.env.MFA_ENFORCE_AFTER = keep
  })

  it('MIGRACIJSKO obdobje (brez env): admin brez MFA → POLN žeton + mfaMandatory UI zastavica', async () => {
    delete process.env.MFA_ENFORCE_AFTER
    const { code, body } = await login(adminEmp, adminEmp.pin)
    expect(code).toBe(200)
    expect(body.mfaMandatory).toBe(true)
    expect(body.mfaEnrollmentRequired).toBeUndefined()
    const payload = verifyToken(String(body.token))
    expect(payload?.mfaEnrollOnly).toBeUndefined()
    // občutljiv API dostopen (mehka politika — UI nagovor, ne blokada)
    expect((await call(settingsGET(tokReq('/api/settings', String(body.token))))).code).toBe(200)
  })

  describe('enforcement AKTIVEN', () => {
    beforeAll(() => { process.env.MFA_ENFORCE_AFTER = new Date(Date.now() - 1000).toISOString() })
    afterAll(() => { delete process.env.MFA_ENFORCE_AFTER })

    it('admin brez MFA → SAMO enrollment-only žeton (mfaEnrollOnly, 1 h) + mfaEnrollmentRequired', async () => {
      const { code, body } = await login(adminEmp, adminEmp.pin)
      expect(code).toBe(200)
      expect(body.mfaEnrollmentRequired).toBe(true)
      expect(body.mfaMandatory).toBe(true)
      const payload = verifyToken(String(body.token))
      expect(payload?.mfaEnrollOnly).toBe(true)
      expect(Number(payload?.exp) - Date.now()).toBeLessThanOrEqual(3600_000) // 1 h
      // enrollment-only žeton NE gre v dashboard API (dovoljenjski sloj 403)
      expect((await call(settingsGET(tokReq('/api/settings', String(body.token))))).code).toBe(403)
      // /api/auth/me (začetek vpisa) pa DELA
      expect((await call(meGET(tokReq('/api/auth/me', String(body.token))))).code).toBe(200)
    })

    it('STARI POLN žeton (veljaven sv) ob aktivnem enforcementu → 401 mfaRequired (CENTRALNO v requireAuth)', async () => {
      const oldFull = createToken({ sub: adminEmp.id, name: adminEmp.name, role: 'ADMIN', loc: null, sv: 0 })
      const { code, body } = await call(settingsGET(tokReq('/api/settings', oldFull)))
      expect(code).toBe(401)
      expect(body.mfaRequired).toBe(true)
      expect(body.mfaEnrollmentRequired).toBe(true)
    })

    it('celotna pot: prijava (enrollment-only) → enroll (PIN) → enable (PIN+koda) → poln dostop + re-login z MFA', async () => {
      const login1 = await login(adminEmp, adminEmp.pin)
      const enrollToken = String(login1.body.token)
      const en = await call(enrollPOST(tokReq('/api/auth/mfa/enroll', enrollToken, 'POST', { pin: adminEmp.pin })))
      expect(en.code).toBe(201)
      const secret = String(en.body.secret)
      const enableRes = await call(enablePOST(tokReq('/api/auth/mfa/enable', enrollToken, 'POST', { pin: adminEmp.pin, code: codeFor(secret) })))
      expect(enableRes.code).toBe(200)
      // nadaljevalni žeton ima POLN dostop
      expect((await call(settingsGET(tokReq('/api/settings', String(enableRes.body.token))))).code).toBe(200)
      // STARI enroll-only žeton je MRTV (sv+1)
      expect((await call(meGET(tokReq('/api/auth/me', enrollToken)))).code).toBe(401)
      // ponovna prijava zdaj zahteva MFA kodo — polna seja brez omejitev
      const relogin = await login(adminEmp, adminEmp.pin, { mfaCode: codeFor(secret) })
      expect(relogin.code).toBe(200)
      expect(relogin.body.mfaEnrollmentRequired).toBeUndefined()
      expect(verifyToken(String(relogin.body.token))?.mfaEnrollOnly).toBeUndefined()
    })

    it('OPERATIVNA vloga (waiter) NI prizadeta — poln žeton brez enrollment omejitve', async () => {
      const { code, body } = await login(staffEmp, staffEmp.pin)
      expect(code).toBe(200)
      expect(body.mfaEnrollmentRequired).toBeUndefined()
      expect(body.mfaMandatory).toBe(false)
      expect(verifyToken(String(body.token))?.mfaEnrollOnly).toBeUndefined()
      expect((await call(meGET(tokReq('/api/auth/me', String(body.token))))).code).toBe(200)
    })
  })

  it('status ruta poroča enforcementActive (brez skrivnosti)', async () => {
    process.env.MFA_ENFORCE_AFTER = new Date(Date.now() - 1000).toISOString()
    const emp = await db.employee.findUnique({ where: { id: adminEmp.id }, select: { sessionVersion: true } })
    const token = createToken({ sub: adminEmp.id, name: adminEmp.name, role: 'ADMIN', loc: null, sv: Number(emp!.sessionVersion) })
    const { code, body } = await call(mfaStatusGET(tokReq('/api/auth/mfa/status', token)))
    expect(code).toBe(200)
    expect(body.enforcementActive).toBe(true)
    expect(body.enabled).toBe(true) // prejšnji test je aktiviral MFA na adminEmp
    delete process.env.MFA_ENFORCE_AFTER
  })
})

/* ══════════ #32 — distribuirana + računovodska zaščita prijave ══════════ */

describe('#32 rate limiting — IP in ACCOUNT dimenzija + fallback', () => {
  beforeEach(() => { __resetRateLimitForTests(); __resetStoreForTests() })

  it('11. poskus istega IP → 429 + audit LOGIN_RATE_LIMITED (10/min, brez PIN-a v auditu)', async () => {
    const ip = '192.0.2.7'
    let last = 0
    for (let i = 0; i < 11; i++) {
      const r = await login(adminEmp, i === 10 ? adminEmp.pin : '000000', {}, ip)
      last = r.code
    }
    expect(last).toBe(429)
    const audit = await db.auditLog.findFirst({
      where: { action: 'LOGIN_RATE_LIMITED', entityId: adminEmp.email },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(audit!.ipAddress).toBe(ip)
    expect(String(audit!.details)).not.toContain('000000')
  })

  it('ACCOUNT limit: 11. poskus z RAZLIČNIH IP-jev na isti e-pošti → 429 (dimenzija po računu)', async () => {
    const email = { email: `${PREFIX}burst-${RUN}@i31.test` }
    let last = 0
    for (let i = 0; i < 11; i++) {
      const r = await login(email, '000000', {}, `198.51.100.${i + 1}`)
      last = r.code
    }
    expect(last).toBe(429) // IP-ji se razlikujejo → zavrnitev iz ACCOUNT bucket-a
  })

  it('napačen PIN/neznan račun/deaktiviran → ISTA javna napaka (brez naštevanja računov)', async () => {
    const a = await login({ email: 'nonexistent@i31.test' }, '000000')
    const b = await login(inactiveEmp, '000000')
    const c = await login(adminEmp, '000000')
    expect(a.body.error).toBe(b.body.error)
    expect(b.body.error).toBe(c.body.error)
  })

  it('x-vercel-forwarded-for ima prednost pred x-forwarded-for (platformski IP signal)', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-forwarded-for': '6.6.6.6',
      },
      body: JSON.stringify({ email: 'forged@i31.test', pin: '000000' }),
    })
    await call(loginPOST(req))
    const audit = await db.auditLog.findFirst({
      where: { action: 'LOGIN_FAILED', entityId: 'forged@i31.test' },
      orderBy: { timestamp: 'desc' },
    })
    expect(audit!.ipAddress).toBe('203.0.113.9') // vercel header, NE ponarejen 6.6.6.6
  })

  it('izpad Upstash → GLASEN console.error + DETERMINISTIČEN memory fallback (deluje, ni globalna meja)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.invalid'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
    __resetStoreForTests()
    const originalFetch = globalThis.fetch
    const errors: string[] = []
    const originalErr = console.error
    console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
    globalThis.fetch = (async () => { throw new Error('upstash down (test)') }) as typeof fetch
    try {
      const r1 = await rateLimitSharedAsync('test-fallback', 2, 60_000)
      const r2 = await rateLimitSharedAsync('test-fallback', 2, 60_000)
      const r3 = await rateLimitSharedAsync('test-fallback', 2, 60_000)
      expect(r1.allowed).toBe(true)
      expect(r2.allowed).toBe(true)
      expect(r3.allowed).toBe(false) // memory fallback NADALJUJE omejevanje (per-proces)
      expect(errors.some((e) => e.includes('upstash'))).toBe(true) // viden preklop
    } finally {
      globalThis.fetch = originalFetch
      console.error = originalErr
      delete process.env.UPSTASH_REDIS_REST_URL
      delete process.env.UPSTASH_REDIS_REST_TOKEN
      __resetStoreForTests()
    }
  })

  it('namenski MFA limit po računu (mfa-acct): 10 poskusov, 11. zavrnjen — IP limit ga NE nadomešča', async () => {
    const key = `route:${PREFIX}mfa-limit-${RUN}`
    for (let i = 0; i < 10; i++) {
      expect(await mfaAttemptRateLimited(key)).toBe(false)
    }
    expect(await mfaAttemptRateLimited(key)).toBe(true)
  })
})
