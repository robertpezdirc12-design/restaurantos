/**
 * ISSUE #75 — VAROVALKA T: test ruta × metoda za VSE route.ts.
 *
 * Presoja = vsak izvoženi HTTP handler (GET/POST/PUT/PATCH/DELETE/HEAD) mora:
 *   a) v svojem telesu klicati prepoznano varovalko (seja/naprava/podpis), ALI
 *   b) biti izrecno vpisan v PUBLIC_API_ROUTES z utemeljitvijo (javni namen).
 *
 * Test pade, če katerikoli route.ts ostane brez presoje — nov endpoint brez
 * varovalke je ODMAH rdeč (ne tiho javen). To je varovalka za VSE nadaljnje
 * korake iz #75 (regresija katere koli rute se vidi takoj).
 *
 * Prepoznane varovalke (sklad s src/lib/api.ts + naprave + webhooki):
 *   - requireAuth( / requirePermission( / requireAuthWithPerms(
 *   - requireAnyPermission( / requireCentralRole( / requireUserLocation(
 *   - deviceFromToken( / deviceFromTokenLite( / posIdentity( — naprave (x-device-token)
 *   - verifyWebhookSignature(                — dostava/e-računi webhook (HMAC)
 *   - bearerMatches( / CRON_SECRET           — Vercel cron (timing-safe Bearer)
 *   - issueFursReceipt(                      — delegirana varovalka (orders.pay)
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const API_ROOT = join(import.meta.dir, '..', 'src', 'app', 'api')

/** Prepoznane varovalke — besedilo, ki se mora pojaviti v telesu handlerja. */
const GUARDS = [
  'requireAuth(',
  'requirePermission(',
  'requireAuthWithPerms(',
  'requireAnyPermission(',
  'requireCentralRole(',
  'requireUserLocation(',
  'deviceFromToken(',
  // v1.156.0 (CFD pogojni polling): lahka različica bere ista avtentikacijska
  // polja (deviceId/type/revokedAt/pairedToDeviceId), le brez displayPayload in
  // lokacije — enaka meja kot deviceFromToken, zato je priznana varovalka.
  'deviceFromTokenLite(',
  'posIdentity(',
  // v1.157.0 (Stripe webhook): javni endpoint nima seje — avtentikacija je
  // HMAC podpis Stripe-Signature (timing-safe, toleranca 300 s), preverjen
  // PRED branjem dogodka (enako načelo kot verifyWebhookSignature pri dostavi).
  'verifyStripeSignature(',
  'verifyWebhookSignature(',
  'bearerMatches(',
  'issueFursReceipt(',
]

/**
 * Izrecni register JAVNIH endpointov (metoda × pot → utemeljitev).
 * Vsak vnos je ZAVEDNA odločitev, ne opuščena. Nova javna ruta zahteva vnos
 * sem — sicer test pade.
 */
const PUBLIC_API_ROUTES: { methods: string[]; path: string; why: string }[] = [
  { methods: ['GET'], path: '/api/health', why: 'liveness probe — brez podatkov' },
  { methods: ['GET'], path: '/api/setup/status', why: 'status namestitve (bootstrap) — brez skrivnosti' },
  // v1.180.0 R3: prevzem prve namestitve. Javna JE PO NAMENU (poklic je iz brskalnika
  // na stroju, kjer še ni uporabnika — seja torej ne more obstajati). Varovalka ni
  // seja ampak petpogojna ograja (`setup-claim.ts`): lokalni profil + dokaz fronte +
  // naslov v zanki + limit 5/min/IP + prazna baza. Brez fronte (HTTPS) je zavrnjena.
  { methods: ['POST'], path: '/api/setup/claim', why: 'prevzem prve namestitve — samo lokalni profil, samo prek HTTPS fronte (x-local-front), samo zanko, 5/min/IP in samo dokler je baza prazna' },
  { methods: ['POST'], path: '/api/auth/login', why: 'prijava — rate-limit 10/min po IP' },
  { methods: ['GET', 'POST'], path: '/api/auth/demo-login', why: 'demo prijava — env DEMO_LOGIN_EMAIL pin + rate-limit 10/min po IP; GET vrne samo stanje vrat (brez imen/računov), zapre se z DEMO_LOGIN_ENABLED=0 ali DEMO_LOGIN_EXPIRES_AT (audit #7)' },
  { methods: ['GET'], path: '/api/auth/locations', why: 'izbira lokacije pred prijavo — samo imena aktivnih lokacij, rate-limit 30/min po IP + no-store (audit #9)' },
  // Vercel cron: Authorization: Bearer CRON_SECRET (timing-safe, v handle());
  // brez skrivnosti (dev) pusti le sejo admin/manager — varovalka v isti datoteki.
  { methods: ['GET', 'POST'], path: '/api/cron/daily', why: 'cron — Bearer CRON_SECRET (timing-safe) ali seja; varovalka v handle()' },
  // Webhook »ready« sonda (GET) ne izda nič; POST preveri HMAC podpis v skupnem
  // jedru delivery-webhook.ts (v1.159.0) — stara pot z več integracijami
  // zahteva enolično ujemanje podpisa, sicer 409.
  { methods: ['GET', 'POST'], path: '/api/delivery/webhook/[provider]', why: 'webhook — GET ready brez podatkov; POST = HMAC v jedru (verifyWebhookSignature) + rate-limit' },
  { methods: ['GET', 'POST'], path: '/api/delivery/webhook/[provider]/[integration]', why: 'webhook per-integration — HMAC v jedru; GET = ready sonda brez podatkov' },
  { methods: ['GET'], path: '/api/einvoices/webhook/[provider]', why: 'webhook pripravljenost — brez podatkov; POST = HMAC podpis' },
  { methods: ['PUT'], path: '/api/devices/enroll', why: 'unovčenje enrollment kode — 15-min koda, enkraten claim, lokacija server-side' },
  { methods: ['GET', 'POST'], path: '/api/public/crm/unsubscribe', why: 'javna odjava — žeton v URL (PII brez seje)' },
  { methods: ['POST'], path: '/api/public/feedback', why: 'javni povratni vmesnik (widget) — rate-limit' },
  { methods: ['GET'], path: '/api/public/label-status', why: 'javni status etikete (QR) — žeton' },
  { methods: ['GET'], path: '/api/public/orders/status', why: 'javno sledenje naročila — žeton' },
  { methods: ['GET', 'POST'], path: '/api/public/pay/[token]', why: 'plačilni link — paylink žeton' },
  { methods: ['GET', 'POST'], path: '/api/public/reservations', why: 'rezervacijski widget — javni obrazec, rate-limit' },
  // P1 #8 (v1.190.0): spletni portal za naročila — token JE skrivnost (32 hex,
  // rotacija), lokacija/cene/politika se rešijo strežniško, rate-limit na obeh
  // rutah; sledenje statusa zaščiti HMAC trackKey (brez njega 404).
  { methods: ['GET', 'POST'], path: '/api/public/web-portal', why: 'spletni portal za naročila — žeton portala (skrivnost), rate-limit 60/10 na min, cene iz DB' },
  { methods: ['GET'], path: '/api/public/web-portal/status', why: 'javno sledenje spletnega naročila — žeton + HMAC trackKey (brez skrivnosti 404)' },
]

// ── rekurziven sprehod po src/app/api — zbiranje vseh route.ts ──
function walkRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkRouteFiles(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/** Telo posameznega handlerja (od deklaracije do naslednjega export-a). */
function handlerSegments(src: string): { method: string; body: string }[] {
  const segs: { method: string; body: string }[] = []
  const re = /export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g
  const matches = [...src.matchAll(re)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = m.index! + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : src.length
    segs.push({ method: m[1], body: src.slice(start, end) })
  }
  return segs
}

const routeFiles = walkRouteFiles(API_ROOT)

/** Datoteka → javna pot rute. Windows `relative()` vrne `\` ločila, zato MORA
 * normalizacija priti PRED obe odstranitvi (sicer je na Windowsu pot
 * `/api/health/route.ts` → varovalka lažno javi neobstoječe javne rute). */
const toApiPath = (file: string): string =>
  '/' + relative(join(API_ROOT, '..'), file).replace(/\\/g, '/').replace(/^app\//, '').replace(/\/route\.ts$/, '')

function isPublic(method: string, apiPath: string): boolean {
  return PUBLIC_API_ROUTES.some(
    (r) => r.path === apiPath && r.methods.includes(method),
  )
}

describe('ISSUE #75 — varovalka T: rute × metode (vse route.ts imajo presojo)', () => {
  test('sprehod najde VSE route.ts (≥ 226 — števec proti tihi preskoki)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(226)
  })

  test('vsak izvoženi handler je varovan (seja/naprava/podpis) ALI javno vpisan', () => {
    const unassessed: string[] = []
    for (const file of routeFiles) {
      const apiPath = toApiPath(file)
      const src = readFileSync(file, 'utf-8')
      for (const { method, body } of handlerSegments(src)) {
        // CORS preflight ne izdaja podatkov — preskoči
        if (method === 'OPTIONS') continue
        const guarded = GUARDS.some((g) => body.includes(g))
        if (!guarded && !isPublic(method, apiPath)) {
          unassessed.push(`${apiPath} — ${method}`)
        }
      }
    }
    expect(unassessed).toEqual([]) // prazen = vse presoje
  })

  test('register javnih rut vsebuje SAMO obstoječe poti (brez mrtvih vnosov)', () => {
    const allPaths = new Set(routeFiles.map(toApiPath))
    const dead = PUBLIC_API_ROUTES.filter((r) => !allPaths.has(r.path))
    expect(dead.map((d) => d.path)).toEqual([])
  })

  test('vsak javni vnos ima utemeljitev (register je dokumentacija, ne seznam)', () => {
    for (const r of PUBLIC_API_ROUTES) {
      expect(r.why.length).toBeGreaterThan(10)
      expect(r.methods.length).toBeGreaterThan(0)
    }
  })
})
