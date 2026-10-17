# CRM gostov in kampanje — SI/HR (v1.126.0, issue #11)

> **NI PRAVNO MNENJE.** Ta dokument opisuje izključno tehnično implementacijo v
> tej kodi. Pred produkcijskim trženjem je obvezen pregled lokalnih pravil o
> elektronskem neposrednem trženju (SI: ZVOP-1/SPS — pravila o (ne)zahtevnosti
> soglasja za e-poštno trženje pravnim osebam; HR: Zakon o elektroničkim
> komunikacijama) in morebitna prilagoditev politike soglasja. GDPR je
> implementacijski okvir (člen 7 — dokazljivost privolitve), ne končni vir
> obveznosti.

## §0 — Inventura obstoječe kode (pred kodiranjem, issue DoD #1)

| Obstoječe | Lokacija | Ponovno uporabljeno |
|---|---|---|
| `Guest` (kanonični profil: obiski/poraba/VIP/kontakt) | `prisma/schema*.prisma` | DA — izhodišče segmentacije; 0 sprememb obstoječih polj |
| `LoyaltyAccount`/`LoyaltyTransaction` | ista shema | DA — segment "člani zvestobe" + dedupe lojalnost (obje strani → ročna razrešitev) |
| SMTP iz nastavitev | `src/lib/reminders.ts:smtpTransportForLocation` | DA — privzeti email sendFn |
| SMS adapter (Integrations type='sms') | `src/lib/reminders.ts:sendSms` | DA — privzeti sms sendFn |
| Cron okvir + idempotenca (marker) | `src/app/api/cron/daily/route.ts` | DA — nov korak 3e `campaigns` |
| Rate limiter (bounded memory) | `src/lib/rate-limit.ts` | DA — javna odjava 10/min/IP |
| RBAC + tenant obseg | `src/lib/api.ts`, `src/lib/tenant.ts` | DA — settings.manage/reports.view + locationScope/guardResource |
| Audit z verigo | `src/lib/audit-chain.ts:writeAudit` | DA — `crmAudit` brez PII |
| Integracije kot zero-DDL hramba | `Integration` (cron-daily-state vzorec) | DA — dismissed duplikat pari (`crm-dup-dismissed`) |
| `ScheduledEmailLog` | dnevni digest | NE za kampanje — CampaignSend je nova domenska evidenca (issue: "implementiraj samo manjkajočo domensko evidenco"); log ostane za operativna poročila |

**Potrjeno manjkajoče** (0 zadetkov za soglasje/kampanje/segment/odjava v src):
sled soglasja, segmentacija, kampanjski življenjski cikel, javna odjava,
merjenje — vse zgrajeno v v1.126.0.

## §1 — Soglasje (GDPR člen 7)

**Implementacija:** `GuestConsent` — append-only sled; kanonično stanje =
NAJNOVEJŠA vrstica po (guestId, channel, purpose='marketing').

| Zahteva issue | Implementirano | Dokaz (koda + test) |
|---|---|---|
| Soglasje s namenom, kanalom, datumom, virom, različico besedila, dokazom | `recordConsent` (channel email/sms, purpose, source, textVersion `crm-consent-v1`, proof, recordedBy, actedAt) | `src/lib/crm.ts`; `tests/issue11-crm-core.test.ts` A3 |
| Dokaz izrecnega dejanja | grant ZAVRNJEN brez proof ≥ 3 znaki | A2 |
| Privzeto = ni soglasja; vnos kontakta pri rezervaciji ≠ soglasje | rezervacija/route NE piše v GuestConsent (statična varovalka: edini pisec je crm.ts) | A1, A7 |
| Odjava takoj učinkovita, preživi retry | send-time re-check v `dispatchCampaign` (izloči tudi 'queued' vrstice) | E1 |
| Email ≠ SMS (ločena kanala) | stanje po kanalu neodvisno | A4, E3 |
| Transakcijska ≠ marketing | rezervacijski opomniki (reminders.ts) so NEodvisni od CRM; marketing gre SAMO skozi consent-gated dispatch | dokumentirano; reminders.ts nedotaknjen |
| Brez alergenov za segmentacijo | `segmentWhere` bere IZKLJUČNO poslovne podatke | B2 (dva gosta z istimi poslovnimi podatki, različnimi alergeni → isti segment) |
| RBAC + tenant + audit brez PII | settings.manage + guardResource + locationScope; audit = id/kanal/števci | A6, F, D4 (admin) |

**Javna enklik odjava:** `/api/public/crm/unsubscribe?token=<32-hex>&lang=sl|hr|en`
— GET izvede odjava + vrne samostojno HTML stran (SL/HR/EN, robots noindex,
brez razkritja podatka o gostu). Token je enkraten in neuganjiv
(`crypto.randomBytes(16)`), nanizan v nogi vsake pošiljke + `List-Unsubscribe`
glava. Idempotentno (ponoven klik = "že odjavljeni", 0 novih vrstic).

## §2 — Segmenti (razložljivi, iz poslovnih podatkov)

`segmentWhere(type, periodDays, now, scope)` — čisti Prisma where:

| Segment | Kriterij |
|---|---|
| all | vsi gosti v obsegu |
| vip | isVip = true |
| loyalty | loyaltyAccountId ≠ null |
| frequent | totalVisits ≥ 3 (FREQUENT_MIN_VISITS, izpostavljen v UI) |
| new | firstVisitAt ≥ (now − periodDays) |
| inactive | totalVisits > 0 ∧ lastVisitAt < (now − periodDays) |

UI: CRM zavihek (tabs.crm, TAB_PERM reports.view) s karticami po segmentu —
kriterij (i18n), obdobje (30/90/365) in št. gostov + upravičeni (soglasje +
kontakt). Alergeni/prehranjevalne preference se NE uporabijo (dokaz B2).

**Dedupe:** `findDuplicateGuests` — normaliziran email (lowercase/trim) ali
telefon (števke, vodilna '00' odstranjena). Kanonični predlog = več obiskov.
Razrešitev: MERGE (transakcijsko preveže Order/GuestVisit/GuestFeedback/
GuestConsent/CampaignSend, agregati = MAX ne vsota — nakupi/točke se NE
podvojijo; obje loyalty → 409 ročna razrešitev; loyalty enostransko →
prenos po sprostitvi unikatne vez) ali DISMISS (Integration marker
`crm-dup-dismissed`, cron-daily-state vzorec — zero DDL).

## §3 — Kampanje (življenjski cikel, pošiljanje, meritve)

**Cikel:** draft → (preview) → approved → scheduled(≥ zdaj) → sending →
sent/failed | cancelled. Vsak prehod je eksplicitna akcija
(`/api/crm/campaigns/[id]/actions`) z auditom.

**Publika:** segment + **trenutno** soglasje + kontakt. Kampanja je vezana na
lokacijo; gostje te lokacije so edini naslovniki (staff meja; NULL-lokacijski
gosti niso naslovniki — fail-closed). Predogled vrne: total / consentGranted /
suppressed / missingContact / eligible.

**Pošiljanje — varna iteracija:**
- snapshot publike OB PRVEM dispatchu (CampaignSend `@@unique(campaignId+guestId)`);
- batch limit (CRM_BATCH_LIMIT=25/klic; cron max 3 kampanje/klic);
- send-time re-check soglasja (odjava izloči tudi že načrtovane vrstice → 'skipped');
- max 3 poskusi na vrstico;
- števci se PREŠTEJEJO iz vrstic (retry ne more podvojiti);
- vsebina: bodySl/bodyHr OBAVEZNI (issue: SL/HR), pošiljatelj iz SMTP
  nastavitev, noga z odjavo se doda SAMODEJNO.

**Statusi (DOKAZOVANI — issue: "brez ponudnikove potrditve ne označi
dostave"):**

| Status | Dokaz |
|---|---|
| queued | vrstica ustvarjena, še ni poslana |
| sent_to_provider | SMTP 250 (sprejem pri ponudniku) — **NI dostava** |
| failed | napaka ponudnika (errorMessage, clank 250) |
| skipped | soglasje umaknjeno ob pošiljki |
| unsubscribed | enklik odjava prek žetona |

'delivered'/'bounced' se NE zapisujeta — SMTP ne daje dokaza o dostavi
(trenutni ponudnik). Webhook za DSN/webhook potrditve je pripravljen kot
prihodnja razširitev (CampaignSend.providerMessageId + statusno polje), a NI
vgrajen — dokumentirana vrzel, ne tiha domneva.

**Testni prejemnik/simulator:** akcija send-test pošlje SAMO na testni naslov
(označen `[TEST]`), brez gostov in brez CampaignSend vrstic; brez SMTP
konfiguracije → jasna zavrnitev (issue: "brez veljavne konfiguracije ne
pošiljaj resničnim gostom").

**Meritve (dokazovane):** `campaignPerformance` — ponovni nakupi = naročila
prejemnikov (po guestId VEZ ali normalizirani e-pošti) v oknu 14 dni po
prvi pošiljki. Kliki NISO implementirani (ni utemeljene infrastrukture —
odprta odločitev lastnika, gl. §4). Brez izmišljenih delivery podatkov.

**Cron:** korak 3e v `/api/cron/daily` (`dispatchDueCampaigns`) — zapadle
scheduled + retry sending; idempotentno prek dnevnega markerja in vrstičnih
statusov.

## §4 — Vrzel / odločitve lastnika (odprte, NE blokirajoče)

1. **Ponudnik dostave/bounce/DSN:** statusi 'delivered'/'bounced' čakajo
   ponudnika s webhookom (npr. SES/SNS, Postmark). Ni ga → se ne zapisujeta.
2. **Kliki:** brez sledenja (utemeljitev: Shortlink + event tabela bi bila
   posebna odločitev o obdelavi osebnih podatkov — GDPR člen 5(1)(c)).
3. **SMS inbound STOP:** odjava SMS trenutno samo prek javne povezave;
   avtomatski odgovor na STOP zahteva inbound webhook ponudnika.
4. **Pravni pregled:** politika besedila soglasja (različica
   `crm-consent-v1`) naj lastnik potrdi pred prvim pravim pošiljanjem;
   dvig različice = nov `textVersion` v novih grantih.
5. **Uvoz seznamov gostov:** ni poti vnosa (issue ne zahteva); ko nastane,
   MORA upoštevati trenutno stanje GuestConsent (odjavljeni se ne sme
   vzkrisiti — pošiljanje itak preverja stanje ob pošiljki).

## §5 — DDL in runtime pot (produkcija)

- NOVE tabele: `GuestConsent`, `Campaign`, `CampaignSend` (skalarne vezave
  brez FK — EventLog vzorec; 0 sprememb obstoječih tabel).
- Register: `crm-campaigns` = **30. vnos** (`src/lib/schema-migrations.ts`),
  probe `tablesAll(['GuestConsent','Campaign','CampaignSend'])`.
- Admin ruta: `POST /api/admin/migrate-crm-campaigns` (requireCentralRole,
  idempotentno, IF NOT EXISTS, SQLite DATETIME / PG TIMESTAMP(3)).
- Do DDL: /api/crm* rute vračajo P2021 napake (klient diagnostika); po DDL
  vse deluje. Drift: `KNOWN_DRIFTS: crm-campaigns` (drift-check matcher).

## §6 — Testi (dokazi)

- `tests/issue11-crm-core.test.ts` (33 testov): A soglasje (privzeto, dokaz,
  kanala, preklic, RBAC, statična varovalka pisca), B segmenti
  (determinizem, alergeni, razložljivost, RBAC), C cikel/publika/statusi,
  D idempotenca/batch/failed, E odjava (preklic med pošiljanjem, javna
  enklik, kanalnost, rate limit), F tenant izolacija/PII maskiranje/izvoz
  CSV z auditom brez PII, G meritve + cron, H vsebina.
- `tests/issue11-crm-admin.test.ts` (17 testov): A DDL register/i18n/konzola/
  sqlite_master/RBAC, B dedupe (zaznava, merge MAX-ne-vsota, 409 obje
  loyalty, dismiss), C testno pošiljanje + lifecycle varovalke, D cron
  povezava + javna varovanja + audit brez vsebine.
- 0 omrežja (vbrizgan sendFn), 0 pravih poverilnic, 0 izmišljenih delivery
  podatkov. Fiksturna predpona `i11-`/`i11a-` (TEST_PREFIXES) +
  LOCATION_CHILD_SWEEP (guestConsent/campaign/campaignSend).

Sprejet 17. 10. 2026; skladno z APP_VERSION 1.126.0.
