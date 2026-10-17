# E-računi SI/HR — razmejitev tokov, matrika skladnosti in transport (v1.125.0, issue #4)

> **NI PRAVNO MNENJE.** Ta dokument opisuje implementirano stanje in odprte odvisnosti.
> Pred produkcijsko aktivacijo morata **lastnik in računovodja** potrditi pravno uporabo,
> izbrano pot izmenjave in profilne oznake. Noben simulator/mock NI dokaz produkcijske
> dostave. Zadnja revizija uradnih virov: **2026-10-17**.

---

## 1. Razmejitev treh NEODVISNIH tokov

Implementacija izrecno loči tri tokove, ki jih zakonodaja in davčna logika obravnavajo
ločeno. **Vsak račun iz blagajne NI avtomatsko B2B e-račun in uspešna POS fiskalizacija
NE pomeni dostavljeno izmenjavo.**

| Tok | Kaj je | Koda (vhodna točka) | Status |
| --- | --- | --- | --- |
| **1) POS fiskalizacija** | davčno potrjevanje maloprodajnega računa (FURS SI / CIS HR — EOR/JIR) | `src/lib/furs/issue.ts`, `src/lib/furs/client.ts`, `src/lib/cis/client.ts`, `src/app/api/furs/route.ts` | [PRODUKCIJA — obstoječi tok, issue #4 ga NE spreminja] |
| **2) Prejeti eSLOG dobavitelja** | uvoz strukturiranega XML dobaviteljevega računa v obveznosti (AccountsPayable) | `POST /api/ap/import-eslog` (`src/app/api/ap/import-eslog/route.ts`), parser `src/lib/eslog.ts` | [PRODUKCIJA — uvoz + idempotenca #65 + tristransko ujemanje #18; issue #4 DODA opozorila `validateIncoming`] |
| **3) Odhodni B2B e-račun** | izdaja + prenos + statusi izmenjave terjatve (AccountsReceivable → EInvoiceOutbox) | `POST /api/einvoices/issue`, `/send`, `/retry`, webhook `/api/einvoices/webhook/[provider]` | [MOCK-TESTIRANO — glej §2 matriko] |

POS prodaja ostaja v `Receipt` toku; B2B terjatve nastanejo IZKLJUČNO prek
`/api/einvoices/issue` (nova `AccountsReceivable` vrstica) — **BREZ prekrivanja**
dvojno štetje v izvozu ni možno (ločena bloka `receivablesByStatus` /
`einvoicesByStatus`, prodaja še vedno iz `Receipt`).

---

## 2. Primerjalna matrika SI/HR (datirana, z dokazi)

Stanja: **MOCK-TESTIRANO** (testi na mock adapterju, 0 omrežja) · **SANDBOX NEPOTRJEN**
(uradno testno okolje ponudnika še ni priključeno) · **PRODUKCIJA NEPOTRJEN**.

| Zahteva | Uradni vir (preverjeno 2026-10-17) | Implementirano stanje | Dokaz (koda + test) | Vrzel |
| --- | --- | --- | --- | --- |
| SI: obvezna izmenjava e-računov med podjetji od **1. 1. 2028** (ZIERDED sprejet) | GOV.SI novice 2025-10-23: <https://www.gov.si/novice/2025-10-23-drzavni-zbor-sprejel-zakon-o-izmenjavi-elektronskih-racunov-in-drugih-elektronskih-dokumentov/> | Format/življenjski cikel pripravljen; transport BLOKIRAN do izbire poti | `src/lib/eslog-export.ts` + `tests/issue4-einvoices.test.ts` sklop A | Izvedbeni pravilnik + e-pot ponudniki — odločitev lastnika |
| SI: izmenjava s proračunskimi uporabniki (UJP) | <https://www.gov.si/teme/izmenjava-e-racunov-s-proracunskimi-uporabniki/> | Izven obsega tega vala (B2B tok) | — | Poseben eSLOG profil za javni sektor — čaka pravilnik |
| SI: format = strukturiran XML (eSLOG 2.0 / EN 16931 UBL) | isto (ZIERDED + UJP) | Generator UBL 2.1 z eSLOG 2.0 profilno oznako | `generateEslogXml` + round-trip testi | Profilna oznaka (`CustomizationID`) čaka lastnikovo potrditev |
| SI: davčna številka prejemnika (8 števk, mod 11-10) | davčna zakonodaja (obstoječe DURS pravilo) | Validacija checksum | `validateSiTaxId` + testi sklop B | — |
| HR: eRačun obveza za PDV zavezance od **1. 1. 2026** (domače transakcije) | Porezna uprava: <https://porezna.gov.hr/fiskalizacija/bezgotovinski-racuni/eracun> | Format/življenjski cikel pripravljen; transport BLOKIRAN | `src/app/api/einvoices/issue` (profil `ubl-2.1-hr`) | Maloprodajna (gotovinska) prodaja ostaja v CIS toku — eRačun za B2B |
| HR: UBL 2.1 tehnična dokumentacija (objava 15. 4. 2026) | <https://porezna.gov.hr/fiskalizacija/bezgotovinski-racuni/bezgotovinski-racuni-novosti/o/verzija-tehnicke-dokumentacije-eracun> | Generator UBL 2.1 (EN 16931 core) | `generateEslogXml({profile:'ubl-2.1-hr'})` + testi | Točna profilna oznaka in schema CI čaka uraden validator |
| HR: KPD 2025 — **šestmestna** oznaka na postavkah | isto + novosti: <https://porezna.gov.hr/fiskalizacija/bezgotovinski-racuni/bezgotovinski-racuni-novosti/1> | `kpdCode` polje (obvezno za HR profil, 6 števk) | `validateOutgoing` (HR) + testi sklop B | Katalog kod NE pride z aplikacijo (glej §4) |
| HR: OIB prejemnika (11 števk, mod 11-10) | Uprava za javne nabavke — OIB standard | Validacija checksum | `validateHrOib` + testi sklop B | — |
| Statusi izmenjave (sent ≠ delivered ≠ accepted ≠ paid) | issue #4 §P1-A | 9-statusni forward-only cikel | `src/lib/einvoice-lifecycle.ts` + testi sklop D | — |
| Idempotenca pošiljanja/retry | issue #4 §P1-C | `idempotencyKey` unique + ISTI ključ pri retry | send/retry rute + testi sklop E | — |
| Webhook statusov (HMAC, dedup, meje) | issue #4 varnostni sklop | Podpisan webhook + eventId dedup | `/api/einvoices/webhook/[provider]` + testi sklop F | Pravi podpis ponudnika — sandbox |
| Prejeti eSLOG: opozorila (valuta, vsote, datum) | issue #4 §P1-B | `validateIncoming` opozorja v odgovoru uvoza | `import-eslog` rute + testi sklop H | XSD (glej §5) |
| Računovodski izvoz brez dvojnega štetja | issue #4 §F | `receivablesByStatus` + `einvoicesByStatus` bloka | `src/app/api/reports/export/route.ts` | — |

**Vsaka integracija je označena** — nobena koda ali simulator se ne šteje za dokaz
produkcijske dostave.

---

## 3. Transport — primerjalna tabela (izbira je LASTNIKOVA)

Restavracija mora za SI (od 2028) in HR (od 2026) izbrati POT IZMENJAVE. Mi **ne
izbiramo plačljive storitve, ne sklepamo pogodb in ne izmišljujemo poverilnic**.
Register adapterjev (`src/lib/einvoice-adapter.ts`) je ključavnica: neregistriran
ponudnik = BLOKIRANO pošiljanje (409, nikoli lažni »poslano«).

| Pot | Zahteve | Registracija | Odvisnosti | Stroški | Koraki za lastnika |
| --- | --- | --- | --- | --- | --- |
| **Ponudnik e-poti / pooblaščeni informacijski posrednik (SI)** | pogodba s ponudnikom, davčna št. podjetja | pri ponudniku | poverilnice API v `Integration` (type `einvoice`, nikoli v source) | NEZNANI — pri ponudniku | 1) povpraševanje pri več ponudnikih, 2) pogodba, 3) vnos poverilnic v Integracije, 4) registracija adapterja v prihodnjem valu |
| **PEPPOL dostopna točka (SI/HR)** | članstvo omrežja (npr. 4-corner model), identifikator udeleženca | pri dostopni točki | poverilnice + nastavitev SMP | NEZNANI — pri dostopni točki | enako kot zgoraj + preverba pokritosti za HR |
| **Neposredna izmenjava (SI/HR, kjer predpisi dovoljujejo)** | lastna infrastruktura, dogovor s partnerjem, eDelivery/AS4 | odvisno od partnerja | protokol NE smemo pisati na pamet — IZKLJUČNO z uradno specifikacijo | interni | zahteva uradno specifikacijo + registracije — ni privzeta pot |
| **Mock (testni)** | nič (0 omrežja) | samodejno | `simulate: deliver\|reject\|timeout` v `Integration.config` | 0 | samo za razvoj/teste — NI produkcijska pot |

**Priporočilo:** pred 1. 1. 2026 (HR) oz. 1. 1. 2028 (SI) pridobi ponudniške
ponudbe za OBE državi (skupna e-pot / PEPPOL), preveri skladnost s Kontakt-bazo
e-pot pri UJP/Finance in potrditev računovodske procesne integracije.

---

## 4. KPD klasifikacijske oznake (HR)

Aplikacija **NE vsebuje kataloga KPD 2025 kod in jih NE izmišljuje** (nobenih
privzetih kod za artikle). Vir koda je **lastnik/prejemnik/uradni katalog**
(Porezna uprava). Vnos poteka prek polja `kpdCode` na vrstici:

- API: `POST /api/einvoices/issue` → `lines[].kpdCode` (6 števk; HR profil zahteva);
- uvoz: parser izlušči `Item/CommodityClassification/ItemClassificationCode`
  (`listID="KPD"`) v `lines[].kpdCode`;
- izvoz: element se zapiše **SAMO** ko je koda prisotna (`generateEslogXml`).

---

## 5. XSD validacija — pošteno stanje

Trenutno imamo:
- **strukturno validacijo** parserja (toleranten eSLOG 1.6/2.0/UBL parse, XXE-varen);
- **poslovne validacije** (`validateOutgoing` / `validateIncoming`): davčne
  številke (checksum), ≥1 vrstica, količine/cene/stopnje 0–30 %, Σ vrstic ≈ glava,
  datumi, valuta, KPD (HR), 64 KB/2 MB meje.

**Manjka: validacija proti uradni XSD shemi.** Ta korak čaka uraden validator
profilov (eSLOG 2.0 SI / HR eRačun UBL 2.1) — pred produkcijo ga dodamo kot ločen
korak pred pošiljanjem (ne v parserju). Round-trip test (parse(generate(x)) ≈ x)
je strukturni dokaz konsistentnosti NAŠEGA generatorja, ne skladnosti s shemo.

---

## 6. Webhook pogodba (statusni dogodki)

`POST /api/einvoices/webhook/[provider]` — provider ∈ `mock` | `sandbox`
(neznan → 404). BREZ seje — HMAC:

```
Telo (JSON):
{
  "eventId":     "≤128 znakov — enolični ID dogodka (dedup)",
  "externalRef": "≤64 znakov — zunanja referenca dokumenta",
  "status":      "draft|validated|queued|sent|delivered|accepted|rejected|failed|needs_review",
  "reason":      "≤200 znakov (opcijsko)",
  "occurredAt":  "ISO 8601 (opcijsko)"
}
Glava: x-einvoice-signature: sha256=<HMAC-SHA256(skrivnost, raw body) (hex)>
```

- skrivnost = `Integration.apiSecret` (provider, type `einvoice`) ali env
  `EINVOICE_WEBHOOK_SECRET`; brez skrivnosti → 503 (endpoint NE deluje);
- isti `eventId` → `200 {duplicate:true}` — EN prehod na dogodek
  (`processedEvents`, zadnjih 50);
- no-op/terminal (npr. `accepted` + webhook `rejected`) → `200 {ignored:true}`
  — **brez regresije** statusa;
- neznan `externalRef` → 404 brez razkritja;
- vsak prehod = `EINVOICE_STATUS` audit (origin `webhook`, correlationId eventId).

---

## 7. Varnostne meje

| Meja | Implementacija |
| --- | --- |
| HMAC pred parsiranjem | `verifyWebhookSignature` (timingSafeEqual) na RAW telesu, pred JSON |
| Velikost telesa | 64 KB webhook (glava + dejanska dolžina → 413); uvoz eSLOG 2 MB |
| Rate limit | 30/min po provider+IP (isti helper kot dostavni webhook) |
| Dedup | eventId v `processedEvents`; idempotencyKey pri send/retry (ISTI dokument) |
| XXE | `fast-xml-parser` brez zunanjih resolucij; DOCTYPE z entitetami ostane literalen |
| Scope | `locationScope` na vseh rutah — uporabnik ene lokacije NE vidi/pošilja tujih |
| Dokaz poslane vsebine | `xmlPayload` + `xmlHash` (sha256) + glava `X-EInvoice-Hash` pri prenosu |
| Ključavnica transporta | neregistriran ponudnik → 409 `blocked` (nikoli lažni »poslano«) |
| PII v logih | IntegrationLog/audit nosijo samo reference in razloge, ne vsebine XML |

---

## 8. Pravno

Ta dokument in implementacija **nista pravno mnenje**. Obveznosti izhajajo iz
ZIERDED (SI) in odlokb Porezne uprave (HR) za konkretnega zavezancev — pred
produkcijo potrdita pravno uporabo in izbrano pot **lastnik ter računovodja**.
Vsaka trditev o skladnosti v tem dokumentu je omejena na implementirano stanje
kode in testov (MOCK-TESTIRANO, razen kjer je označeno drugače).

---

## 9. Tehnični dodatki (za razvijalce)

- Nov model: `EInvoiceOutbox` (DDL register #29 — `/api/admin/migrate-einvoice-outbox`,
  konzola Enterprise → Shema migracije);
- Statusni cikel: `src/lib/einvoice-lifecycle.ts` (forward-only, terminal
  accepted/rejected, retry poti failed/rejected/needs_review → queued);
- DDV konvencija: odhodni račun = **neto osnova + DDV**; iz POS naročila se neto
  izpelje iz končne cene (`netFromGross`/`vatFromGross`, v1.124.0 pravilo);
- Testi: `tests/issue4-einvoices.test.ts` (predpona fiksur `i4-`).
