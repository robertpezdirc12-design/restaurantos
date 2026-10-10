# FURS / Fiskalizacija 2.0 — Runbook za aktivacijo produkcije

> **Stanje (2026-10-10):** fiskalni modul je funkcionalno končan v **simulaciji**
> (ZOI/ZKI/EOR/JIR izračun, QR, storno, veriženje Z-reporot, audit). Produkcija
> čaka **dva človeška vhoda**: (1) kvalificiran certifikat, (2) potrditev
> poslovnih podatkov. Ta dokument opiše točen postopek ob prihodu certifikata.

## 1. Kaj je treba pridobiti (človek)

### Slovenija — FURS
- **Kvalificirano potrdilo za fiskalizacijo** (Potrdilo za elektronsko podpisovanje
  FURS) — izdajatelji: **CERTIPOST, Originata, SIGEN-CA, Tris-S** (letna članarina,
  obnova vsako leto).
- Certifikat pride kot **.p12 / .pfx** (ali PEM par) z geslom.
- Za **testno okolje** FURS ponuja tudi testno potrdilo (zahtevek na furs.gov.si) —
  priporočeno najprej testno okolje, nato produkcija.

### Hrvaška — Porezna (Fiskalizacija 2.0, obvezna od 1. 1. 2026)
- **Certifikat za fiskalizaciju** (FINA) — trenutno brezplačen za fiskalizacijo.
- Nastanitev na Porezna portalu (ePorezna) + prijava poslovnega prostora.

## 2. Kaj pripravim (kodeksko) takoj, ko je certifikat tu

> **Task 36 (2026-10-10): odjemalec je ŽE implementiran** — `src/lib/furs/client.ts`
> (P12 via node-forge, ZOI = RSA-SHA256 podpis MD5 digesta, XML-DSig SOAP envelope,
> echo + invoices, mTLS https, fail-safe integracija v /api/furs — 16 testov z
> in-memory samopodpisanim P12). Ob prihodu certifikata ostane SAMO nastavitev env.

1. ~~**SOAP odjemalec**~~ — **KONČANO (Task 36):** `src/lib/furs/client.ts` —
   `loadCertMaterial` (P12→PEM), `signZoi` (kanonični niz byte-identičen simulaciji),
   `buildSoapEnvelope` (XML-DSig exclusive C14N + SHA256 + BinarySecurityToken),
   `buildEchoRequestXml`/`buildInvoiceRequestXml`, `parseEchoResponse`/`parseInvoiceResponse`,
   `soapPost` (mTLS, timeout, ca), `fursEcho`/`fursInvoice`, `certFromEnv`.
   Testi: `tests/furs-client.test.ts` (16). **Validacija C14N točnosti v FURS testnem
   okolju obvezna pred produkcijo** (glej korak 3).
2. **Vercel env** (dobim vrednosti od tebe, ali sam posodobim prek Vercel API-ja, če mi
   daš datoteki):
   - `FURS_CERT_P12_B64` (base64 .p12) + `FURS_CERT_PASSWORD`
   - `FURS_ENVIRONMENT=production` (ali `test` najprej) — globalno ali per-location
     (`Location.fursEnvironment`)
   - `FURS_ALLOW_SIMULATION=false` (produkcija: simulacija prepovedana)
   - HR: `FINA_CERT_*` analogno (ločeno per lokacija glede na `Location.country`) —
     HR adapter še NI implementiran (Task 36 je SI SOAP; HR sledi po validaciji SI)

## 3. Kaj se dogaja DO aktivacije (trenutno vedenje — varno)

- Fiskalni izračun vrne prazne kode → račun shranjen z `fiscalStatus='pending'`
  (produkcija: `FURS_ENVIRONMENT` ni `simulation/test` in `FURS_ALLOW_SIMULATION≠true`
  → ni lažiranih kod).
- Simulacijski režim (dev): testne kode z oznako `simulated: true` — nikoli ne lažirajo
  produkcije.
- Vsi računi popolnoma revizirani (INVOICE_ISSUE + chainHash), storno deluje.
- Dnevni prod-smoke workflow poroča `Receipt fiscalStatus pending` (mehki kazalec).

## 4. Aktivacija po korakih (ko pride certifikat)

1. Implementiram SOAP/REST odjemalca + teste z mock certifikatom (1 seja).
2. Certifikat na Vercel (env, šifrirano) — Vercel API ali dashboard.
3. `FURS_ENVIRONMENT=test` → fiskaliziram testni račun → preverim na FURS portalu.
4. Prijavim poslovne prostore (premiseId) — če še niso (UI: nastavitve lokacije).
5. `FURS_ENVIRONMENT=production` per lokacija → živi računi → preverim EOR/JIR.
6. HR lokacije enako prek FINA poteka (ločen adapter, že pripravljen v `src/lib/fiscal/`).

## 5. Referenca

- Adapterji: `src/lib/fiscal/index.ts` (SI MD5-ZOI regresijski vektor: `tests/fiscal.test.ts`)
- Fiskalni tok: `src/app/api/furs/route.ts` (idempotenten replay, CAS, audit, storno
  `src/app/api/receipts/[id]/storno/route.ts`)
- Audit kontekst: `docs/RESTAURANTOS-AUDIT.md` §13 "Blokade, ki zahtevajo človeka"
