# FURS / Fiskalizacija (SI + HR) — Runbook za aktivacijo produkcije

> **Stanje (2026-10-10, Task 38):** fiskalni modul je funkcionalno končan v **simulaciji**
> (ZOI/ZKI/EOR/JIR izračun, QR, storno, veriženje Z-reporot, audit). Produkcija čaka
> **dva človeška vhoda**: (1) kvalificiran certifikat, (2) potrditev poslovnih podatkov.
> **SOAP odjemalca za OBÉ državi sta ŽE implementirana** — SI: `src/lib/furs/client.ts`
> (Task 36), HR: `src/lib/cis/client.ts` (Task 38). Ob prihodu certifikata ostane SAMO
> nastavitev env + validacija v testnem okolju.

## 1. Kaj je treba pridobiti (človek)

### Slovenija — FURS
- **Kvalificirano potrdilo za fiskalizacijo** (Potrdilo za elektronsko podpisovanje
  FURS) — izdajatelji: **CERTIPOST, Originata, SIGEN-CA, Tris-S** (letna članarina,
  obnova vsako leto).
- Certifikat pride kot **.p12 / .pfx** (ali PEM par) z geslom.
- Za **testno okolje** FURS ponuja tudi testno potrdilo (zahtevek na furs.gov.si) —
  priporočeno najprej testno okolje, nato produkcija.

### Hrvaška — Porezna uprava / CIS (specifikacija v2.7, 21.07.2026)
- **Napredni (advanced) certifikat, ki vsebuje OIB** — izdan po eIDAS uredbi od
  ponudnika s pouzdanog popisa (ETSI EN 319 412-3), ali obstoječi Fiskal certifikat
  (FINA) — za fiskalizacijo brezplačen pri FINA.
- Za **testno okolje**: DEMO certifikat istih izdajateljev (ali produkcijski cert
  za izdajatelje izven RH — z najavo na `fiskalizacija.help@apis-it.hr` vsaj mesec dni
  vnaprej).
- Prijava poslovnega prostora (JOPPD / ePorezna).
- **Pomembno (timeline iz spec v2.7):** RSA-SHA1 potpisivanje je v testnem okolju
  zavrnjeno od 01.07.2026, v produkciji od 01.01.2027 — naš odjemalec uporablja
  **RSA-SHA256 od prvega dne**, nič ni treba menjati.
- TLS: strežniški certifikat podpisujeta **FINA RDC CA** (prod) / **FINA DEMO CA**
  (test) — ki nista v privzetih Node trust store-ih → verigo (PEM) dodaj kot env
  `FURS_HR_CA_PEM` (korak 2). Brez nje je TLS fail-closed (račun ostane 'pending').

## 2. Vercel env (ko pride certifikat)

### SI (FURS) — obstoječe (Task 36)
- `FURS_CERT_P12_B64` (base64 .p12) + `FURS_CERT_PASSWORD`
- `FURS_ENVIRONMENT=production` (ali `test` najprej) — globalno ali per-location
  (`Location.fursEnvironment`)
- `FURS_ALLOW_SIMULATION=false` (produkcija: simulacija prepovedana)

### HR (CIS) — novo (Task 38, `src/lib/cis/client.ts`)
- `FURS_HR_CERT_P12_B64` + `FURS_HR_CERT_PASSWORD` (napredni certifikat z OIB)
- `FURS_HR_ENVIRONMENT=test` → nato `production` (fallback: `FURS_ENVIRONMENT`)
- `FURS_HR_CA_PEM` — veriga FINA RDC CA (prod) / FINA DEMO CA (test), PEM ali base64
- `FURS_HR_ENDPOINT_URL` — NIZABODENO nastavljen (privzeti sta uradni: test
  `https://cistest.apis-it.hr:8449/FiskalizacijaServiceTest`, prod
  `https://cis.porezna-uprava.hr:8449/FiskalizacijaService`); override samo za mock
- Endpointi/transport so **1-way TLS** (klient NE pošilja certifikata v TLS — samo v
  XML-DSig podpisu), SOAP 1.1 document-literal

## 3. Kaj se dogaja DO aktivacije (trenutno vedenje — varno)

- Fiskalni izračun vrne prazne kode → račun shranjen z `fiscalStatus='pending'`
  (SI) oz. `cisStatus='pending'` (HR) — ni lažiranih kod v produkciji.
- Simulacijski režim (dev): testne kode z oznako `simulated: true` — nikoli ne lažirajo
  produkcije.
- Vsi računi popolnoma revizirani (INVOICE_ISSUE + chainHash), storno deluje.
- Dnevni prod-smoke workflow poroča `Receipt fiscalStatus pending` (mehki kazalec).

## 4. Aktivacija po korakih (ko pride certifikat)

1. ~~Implementiram SOAP odjemalca~~ — **KONČANO (Task 36 SI + Task 38 HR):**
   - SI `src/lib/furs/client.ts`: ZOI = RSA-SHA256 podpis MD5 digesta, XML-DSig
     (BinarySecurityToken v SOAP header), **mTLS**, echo/invoices. 16 testov.
   - HR `src/lib/cis/client.ts`: ZKI = MD5hex(RSA-SHA256(podpis kanoničnega niza)) po
     **uradni specifikaciji v2.7 pogl. 12** (OIB + dd.MM.yyyy HH:mm:ss + BrOznRac +
     OznPosPr + OznNapUr + iznos s piko), enveloped XML-DSig (Signature ZNOTRAJ
     RacunZahtjev, exc-c14n, sha256), **1-way TLS**, echo/RacunZahtjev → JIR.
     26 testov (in-memory P12 + mock CIS strežnik).
2. Certifikat na Vercel (env, šifrirano) — Vercel API ali dashboard (§2).
3. **Testno okolje najprej:** SI `FURS_ENVIRONMENT=test` + HR `FURS_HR_ENVIRONMENT=test`
   → fiskaliziram testne račune → preverim odgovore (EOR/JIR) + prijavljene račune na
   FURS/ePorezna portalu. HR: uporabi DEMO certifikat + FINA DEMO CA verigo;
   rekomendacija spec: min. 2 dneva stabilnega rada v testnem okolju.
4. Prijavim poslovne prostore (premiseId) — če še niso (UI: nastavitve lokacije).
   HR lokacija: `premisesId` = oznaka poslovnog prostora (alnum), `registerNumber` =
   številka naplatnega uređaja (Samo številke! npr. '1', '12' — sanitizacija v kodi ima
   varne privzetke, a prave vrednosti so obvezne za točno evidentiranje).
5. `FURS_ENVIRONMENT=production` / `FURS_HR_ENVIRONMENT=production` per lokacija →
   živi računi → preverim EOR/JIR + ZOI/ZKI na računih (QR: porezna.gov.hr/rn za HR).
6. Fail-safe: SOAP klic teče PO DB transakciji; ob napaki račun ostane 'pending'
   (plačilo je urejeno) — poznejša fiskalizacija prek SubsequentSubmit/NakDost=true
   (v kodni pripravi: polje `subsequentSubmit`, za nadaljevanje UI orodje, če se pojavi
   v praksi).

## 5. Referenca

- Adapterji: `src/lib/fiscal/index.ts` (SI MD5-ZOI regresijski vektor: `tests/fiscal.test.ts`;
  HR testni ZKI/QR: `computeHrTestZki`, `hrQrContent`)
- Odjemalec SI: `src/lib/furs/client.ts` + `tests/furs-client.test.ts` (16)
- Odjemalec HR: `src/lib/cis/client.ts` + `tests/cis-client.test.ts` (26) —
  **viri: uradna specifikacija v2.7 (21.07.2026)** `porezna-uprava.gov.hr
  /UserDocsImages/Fiskalizacija/Tehničke specifikacije/Fiskalizacija - Tehnicka
  specifikacija za korisnike_v2.7 (21.07.2026).pdf` (pogl. 12 = ZKI algoritem str. 208,
  §6.1 = endpointi, §7 = XML-DSig)
- Fiskalni tok: `src/app/api/furs/route.ts` (idempotenten replay, CAS, audit, storno
  `src/app/api/receipts/[id]/storno/route.ts`; Task 37: terminalna stanja fail-closed)
- Audit kontekst: `docs/RESTAURANTOS-AUDIT.md` §13 "Blokade, ki zahtevajo človeka"
