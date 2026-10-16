# Task 5 — UI za issue #24 (etikete za pripravljeno hrano, v1.114.0)

Agent: full-stack-developer (UI podagent)
Datum: 2026-10-16
Status: ZAKLJUČENO

## Naloga

Issue #24, UI del (backend + javna stran /label/[token] sta že obstajala iz Task 4-a/4-b):
LabelDialog (izdaja + tisk + QR + razveljavitev), gumbi "Etiketa" v BatchesCard/BatchPrepCard,
nastavitvena kartica LabelRulesCard (potrjena pravila roka), lbl.* i18n SL/HR/EN.

## Ustvarjene / urejene datoteke

| Datoteka | Sprememba |
|---|---|
| `src/components/label-dialog.tsx` | NOVA — dialog izdaje etikete (izven i18n sken družine, angleški komentarji) |
| `src/components/tabs/ops-cards.tsx` | urejena — Tag ikonski gumb v BatchesCard vrsticah + gumb na COMPLETED pripravah v BatchPrepCard + LabelDialog render (lokalno stanje `labelFor`) |
| `src/components/tabs/label-rules-card.tsx` | NOVA — nastavitvena kartica (render gate inventory.manage + OWNER/ADMIN/MANAGER fallback) |
| `src/components/dashboard-tabs.tsx` | barrel export LabelRulesCard |
| `src/app/dashboard/page.tsx` | import + `<LabelRulesCard />` pred `<PrepStationsCard />` v nastavitvenem zavihku |
| `src/lib/i18n/sl.ts` | +75 ključev `lbl.*` (blok po `bat.tr.csv`) |
| `src/lib/i18n/hr.ts` | +75 ključev `lbl.*` (identičen nabor, pravi hrvaški prevodi) |
| `src/lib/i18n/en.ts` | +15 ključev `lbl.public.*` (javna statusna stran — vzorec resv.public/pay) |
| `src/lib/i18n/index.ts` | EN_GUEST_PREFIXES + 'lbl.public.' + posodobljen komentar |

## Ključne odločitve

1. **raw fetch + Bearer za POST rute** (vzorec manager-calls-card `patchCall`): `api()` požre HTTP
   status, dialog pa RABI ločiti 201 (uspeh) od 409 (blokada tiska — karantena/odpoklic/poteklo/
   izčrpano) in 400 (validacija) — strežniško sporočilo gre v destruktiven toast. GET /api/labels
   (zadnje etikete) gre prek `api()` helperja.
2. **Isti tok tiska za novo etiketo in ponovni tisk**: POST /api/labels → (201) → POST /api/labels/
   [id]/print → `buildLabelLines()` (čisti motor, locale iz useI18n hook) → `printLabelDocument()`
   (browser/agent/simulator, ctx kind='label' refId za ACK evidenco). needsReview → amber banner
   role="status" (izrecno "potreben pregled", nikoli navidezno veljaven datum).
3. **Zadnje etikete lazy** (Collapsible, prvo odprtje naloži GET /api/labels?batchId=/preparationId=):
   scanStatus badge z ISTO barvno paleto kot javna stran (ok=emerald, alert=amber,
   expired/quarantined/recalled=rose, exhausted/void=stone, review=amber outline), printCount
   indikator (🖨 ×N z aria-label), Ponovni tisk (enak tok), Razveljavi (samo canManage, AlertDialog
   z obveznim razlogom ≥ 3 znaki — server validira).
4. **BatchesCard gumb NI gate-iran na canManage** — POST /api/labels zahteva samo requireAuth
   (kuhinja tiska etikete); blokirane serije server zavrne z 409 → toast. BatchPrepCard izračuna
   canManage lokalno (getUser() + inventory.manage/vloge — vzorec PrepStationsCard), ker kartica
   nima canManage propa.
5. **LabelRulesCard brez pollinga** (vzorec ManagerCallSettingsCard — nastavitvene kartice ne
   pollajo): load ob mount, reload po vsaki akciji; `load()` vrne svež seznam za re-sync obrazca.
   Picker artiklov = GET /api/inventory (isti vir kot zaloga tab), obstoječa pravila kot badge
   "48 h" na izboru. Validacije klient-stran: prazno/ne-celo število/izven 0–8760 →
   `lbl.rules.hoursRange` (server je razsodnik — 400 pride v inline error/toast).
6. **EN pokritost javne strani**: 'lbl.public.' dodan v EN_GUEST_PREFIXES (enGuestGaps test
   zahteva 100 % pokritost) — 15 EN ključev dodanih v en.ts po vzorcu resv.public (#13).
   Dashboard/osebje lbl.* ključi ostanejo SL/HR (EN fallback na SL — isti varovalni vzorec).
7. **HR varovalka sloSpecific**: nobena HR lbl.* vrednost ni enaka SL-specifičnim nizom
   ('Shrani', 'Prekliči', 'Nalagam…', …) — preizkušeno z i18n testom (45/45 zeleni).

## Testni izidi

- `DATABASE_URL="file:./db/dev.db" bunx tsc --noEmit` → 0 napak
- `bun run lint` (eslint .) → 0 napak/opozoril
- `bun test tests/i18n.test.ts tests/i18n-guest.test.ts` → 45 pass / 0 fail (695 expect)
  — pariteta slovarjev + enGuestGaps (lbl.public. pokritost) + sloSpecific varovalka
- `bun test tests/tenant-org-list.test.ts` → 7 pass / 0 fail (36 expect)
- Live smoke (dev :3007, dev.db): / 200, /dashboard 200 (kompilacija vseh novih modulov),
  /label/<token> 200 s SSR "Nalagam" (ključi se res razrešijo), login admin@restaurantos.app OK,
  GET /api/labels/rules {rules:[]} 200, PUT pravila 48h → GET pokaže pravilo (itemName/unit/
  confirmedByName/At — DTO se ujema z RuleRowT v kartici) → PUT null → removed:true, POST
  /api/labels z neobstoječo serijo → 404 {"error"} (error pot labelFetch+serverMsg deluje)
- Pariteta ključev: SL 75 = HR 75 (diff IDENTICAL), EN 15 (lbl.public.*)

## Odstopanja od spec

- Brez pomembnih odstopanj. Malosti: printCount v vrstici "zadnjih etiket" je ikonski indikator
  (🖨 ×N) z aria-label namesto besedilnega ključa (niz "×N" je univerzalen; ni v spec seznamu
  ključev). `lbl.subtitle` je uporabljen kot naslov read-only bloka "Podatki zapisa", podnaslov
  dialoga je context.itemName (po spec). RK odstranitve dev-serverja: port 3007 se v tem sandboxu
  sam pobije med ukazi — dimenzija projekta NE vpliva (my-project :3000 nedotaknjen, zagnan od
  sistema).

## Naslednji korak (za glavnega agenta)

- bun test celotnega suite-a (števci migrations-console za DDL + fixture-sweep 'i24-' so že iz
  Task 4-b), push, E2E na živi DB s serijo (dashboard → Zaloge → Serije → Etiketa).
