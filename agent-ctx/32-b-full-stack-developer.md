# Task 32-b — P2 RBAC N1/N2/N7/N8 + loyalty PII

Agent: full-stack-developer
Status: KONČANO (testi/tsc/lint zeleni)

## Kontekst, ki sem ga podedoval
- Repo snapshot je bil pri tasku 26-main (v1.45.0) — worklog vnosov 29–31 še NI bilo v datoteki, tests/receipt-storno.test.ts še ni obstajal, docs/RESTAURANTOS-AUDIT.md ne obstaja. Delo sem opravil iz navodil naloge + inspekcije kode. Vzorci 31-b (requirePermission konverzije, isCentralRole v src/lib/api.ts) so že bili v kodi (menus, employees GET, orders POST, bill, discount …) in sem jih uporabil kot vzorec.
- Med sejo je vzporedni agent dodal tests/furs-post.test.ts in tests/permissions-core.test.ts (N5/furs) — nisem jih stikal (file ownership).

## Narejeno (po N-št.)

### N1 — mize (OWNER 403 → sme; staff 403 ostaja)
- `src/app/api/tables/route.ts` POST: `canAccessModule('tables', true) + role!=='MANAGER'` → **requirePermission('menu.manage')** (isti vzorec kot menus POST po 31-b).
- `src/app/api/tables/[id]/route.ts` DELETE: `role!=='ADMIN'` → **requirePermission('menu.manage')**.
- ODLOČITEV: menu.manage, ker ROLE_DEFAULTS daje CANONICAL_PERMISSIONS (vključno menu.manage) owner/admin/manager; staff/waiter/bar/chef/kitchen je nimajo → 403. PATCH ostaja `orders.create` (premik/status mize = natakarjska akcija, izven N1 obsega »kreiranje miz«). Lokacijska vrata (requireUserLocation / assertResourceLocation) ostanejo. Trade-off: bootstrap admin (brez Employee vrstice) je pri requirePermission rutah 403 — enako kot menus/categories že od 31-b (usklajeno, dokumentirano).

### N2 — ročni override PAID/CANCELLED + DELETE naročila
- `src/app/api/orders/[id]/route.ts` PATCH (status PAID|CANCELLED) in DELETE: `role!=='ADMIN' && role!=='MANAGER'` → **`!isCentralRole(user) && user.role!=='MANAGER'`** → OWNER/ADMIN/MANAGER. Ostalo nedotaknjeno: addItems gate (orders.create), kitchen.update pot, lokacijski gate, publishEvent(PaymentCompleted/OrderCancelled). Bill/discount rut nisem stikal (njihovi plačilni guardi 409 ostanejo). V tem snapshotu ni bilo Task-29 audit eventov (ORDER_STATUS_*_OVERRIDE) ali R5/R10 CAS guardov v tej datoteki — kaj je obstajalo, to ostaja.

### N7 — dodeljevanje vlog v employees/[id]
- `src/app/api/employees/[id]/route.ts` PATCH role: BELI_SEZNAM = BASE (ADMIN, MANAGER, WAITER, BAR, KITCHEN, OWNER) + **ENTERPRISE (GROUP_OWNER, ORG_ADMIN, PROPERTY_MANAGER, WAREHOUSE, ACCOUNTING** — kanonični seznam iz ROLE_DEFAULTS §issue #11). Enterprise vlogo sme dodeliti SAMO centralni akter (isCentralRole → OWNER/ADMIN; bootstrap admin je ADMIN → pokrit). MANAGER: ne sme ADMIN (obstoječ rule), ne OWNER (obstoječ rule), ne enterprise (novo). Vse ostale protekcije ostanejo: MANAGER ne ureja ADMIN target-a, OWNER target protekcije, sessionVersion bump (deaktivacija/PIN/lokacija), EMPLOYEE_SENSITIVE_UPDATE revizija (test verificira). Zunanja vrata PATCH ostajo `['OWNER','ADMIN','MANAGER']` (minimalen diff; ORG_ADMIN-akter kot vir prihodnjega popravka — dokumentirano kot rezidual).

### N8 — tab permission fail-closed
- NOVO `src/lib/tab-permissions.ts`: `TAB_PERM` (23 zavihkov, vsak IZRECEN vnos) + `tabHasPerm(tabId, { canManage, perms })` — undefined/neznan/manjkajoč vnos → **false**. Marker `'*'` = zavihek za vse avtenticirane (pregled — GET /api/dashboard je requireAuth; delovnicas — »ura za VSE zaposlene«; odpiralnicas — GET /api/opening-hours je requireAuth po namenu, urejanje ostane settings.manage gating notri).
- `src/app/dashboard/page.tsx`: inline TAB_PERM odstranjen (selitev v lib), filter `.filter(([v]) => tabHasPerm(v, { canManage, perms }))`, `hasPerm` fail-closed (`!!p && …`) — vsi ostali call-site-i hasPerm podajajo literale (brez vedenjske spremembe). Vnosi zaposleni/nastavitve so v snapshotu že obstajali — potrjena in testoma zaklenjena.
- Regresijski test bere page.tsx in uveljavlja: vsak id iz TabsList ima vnos v TAB_PERM.

### Loyalty PII
- `src/app/api/loyalty/route.ts` GET: telefoni VEDNO maskirani prek NOVEGA `src/lib/pii.ts` `maskPhone()` (`+386 *** 567` — državna predpona + zadnjih 3 števk; <4 števk → `***`). Nezakriti pogled: `?full=1` zahteva **requirePermission('settings.manage')** (owner/admin/manager), sicer 403 — izbran query-param variant (minimalen diff, brez nove rute). Maskiranje velja za vse (tudi MANAGER) v seznamu. REZIDUAL (izven ownership-a): `/api/loyalty/lookup` (orders.pay) vrača polni telefon za identifikacijo gosta v plačilnem dialogu — funkcionalna potreba (potrditev ujemanja), dokumentirano za ločeno odločitev.

## Testi (tests/rbac-p2.test.ts — 26)
- DB-backed nad dev SQLite (db/custom.db), unikatna predpona `rbac-p2-` + RUN (^Date.now().toString(36)), unikatni PIN-i (časovna baza + zaporedna), cleanup v afterAll v OBRATNI smeri FK (eventLog/auditLog → order → table → loyaltyAccount → employee → location); preverjeno: 0 preostalih vrstic.
- N1: OWNER POST 201, MANAGER 201, WAITER 403, OWNER DELETE 200, WAITER DELETE 403.
- N2: OWNER PAID override 200 (DB paid), WAITER 403, OWNER DELETE storno 200 (DB cancelled + cancelledById), WAITER 403, WAITER navaden status → 403 prek kitchen.update.
- N7: OWNER dodeli ORG_ADMIN → 200 (DB org_admin + revizija), MANAGER ORG_ADMIN 403 (nespremenjen), MANAGER→ADMIN 403, MANAGER ureja ADMIN target 403, WAITER 403.
- N8 (unit): undefined/null/''/neznan → false; zaposleni brez employees.manage → false / s pravico → true / canManage → true; '*' tabi za vse; override preklopi vidnost; vsi TAB_PERM vnosi so veljavni kanonični permission-i ali '*'; vsi TabsList id-ji imajo vnos.
- PII: maskPhone enote; GET list MANAGER/WAITER maskiran (poln št. nikoli v odgovoru); ?full=1 WAITER 403; ?full=1 MANAGER nezakrito.

## Verifikacija
- `bun test` → **437 pass / 0 fail** (baseline 371 + 26 mojih + 40 vzporednega agenta: furs-post 12 + permissions-core 28). Opomba: naloga je pričakovala 380 obstoječih (Task 29–31 testi) — snapshot jih ni imel; enkratno flaky faljenje furs-post v skupnem runu (nič v moji lasti; v izolaciji + ponovljenih runih 0 fail).
- `bunx tsc --noEmit` → EXIT 0. `bun run lint` → EXIT 0.
- dev.log: GET / 200, GET /dashboard 200 (kompilacija čista).

## Datoteke (moje)
M: src/app/api/tables/route.ts · src/app/api/tables/[id]/route.ts · src/app/api/orders/[id]/route.ts · src/app/api/employees/[id]/route.ts · src/app/api/loyalty/route.ts · src/app/dashboard/page.tsx (samo tab-permission koda)
N: src/lib/tab-permissions.ts · src/lib/pii.ts · tests/rbac-p2.test.ts
NISSEM stikal (ownership): sync/tips/shifts/expenses/haccp/giftcards/furs/public/admin api, src/lib/permissions.ts, src/lib/api.ts, prisma/**, i18n, tuji testi.

## Za naslednjega
- Če nekdo prevaja employees/[id] na requirePermission('employees.manage') (N3 stil), naj ohrani enterprise-role pravila (ENTERPRISE_ROLES + isCentralRole akter) in MANAGER blokade.
- Bootstrap admin je na requirePermission rutah 403 (po 31-b vzorcu) — če se to centralno popravlja, popravi v src/lib/api.ts requirePermission (fast-path za sub='bootstrap'), ne po rutah.
- TAB_PERM: nov zavihek v page.tsx TabsList MORA dobiti vnos v src/lib/tab-permissions.ts (test to uveljavlja).
