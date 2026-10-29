# Security Boundary (issue #12 §2 + §4 + §8)

## Ciljna linija (realizirana)

```
Client → Auth/API Security Layer → Domain API → Database
```

Ni ločenega "API gateway" procesa — varnostni sloj je **knjižnica v aplikaciji**
(src/lib/api.ts + auth.ts + tenant.ts + rate-limit.ts), skozi katero gredo VSE
route. To je namerna arhitektura za Next.js monodeploy (enostavnost > ločeni
sistem, issue #12 §5: "ne uvajaj kompleksnosti").

## Standardizirane funkcije sloja

| Funkcija | Mekanizem | Kje je obvezen |
|---|---|---|
| Authentication | Bearer HMAC žeton; exp 12 h; `requireAuth` | vsaka zaščitena ruta |
| Session revokacija | `sessionVersion` v DB; PIN reset/deaktivacija → takojšen preklic vseh žetonov (fail-closed tudi za stare žetone brez `sv`) | `requireAuth` |
| Authorization | RBAC kanonična dovoljenja (`requirePermission`) + per-employee `permissionOverrides` | rutine z obsegi |
| Location scope | `assertResourceLocation` (posamezen vir), `locationScope` (seznami), `requireUserLocation` (create) | vse lokacijske rute |
| Tenant scope | org meja ŽIVO povezana (v1.53.0, Task 52): `guardResource` (lokacijski + org sloj) v točkovnih rutah, `assertOrgScope` na CREATE mestih; enterprise rute ohranijo inline org filter | enterprise rute + vse točkovne rute (glej TENANT-ISOLATION.md §3) |
| Rate limit | `RateLimitStore` (memory; Upstash env-ready); delivery 30/min, javni naročilni 10/min | delivery, public/* |
| Audit | `AuditLog` (+ `EventLog` #11) | ob pomembnih akcijah |
| Input validacija | ročna per ruta (`typeof`, `.slice()` cap-i); delivery `validateMapped` | vse rute |
| Error handling | centralna `ok()`/`fail()`; javne rute ne uhajajo stack trace | vse rute |

## Javni endpointi (brez obhoda avtorizacije)

| Endpoint | Varnost |
|---|---|
| `/api/health` | samo status/version/baza — brez PII |
| `/api/auth/login` | email+PIN (scrypt + `pinLookup` HMAC); MFA druga stopnja; bootstrap break-glass prek env |
| `/api/auth/demo-login` | Razvozna vrata brez gesla (izrecna lastnikova zahteva): POST prijavi NAJSTAREJŠI aktivni vodstveni račun BREZ MFA (rate limit 10/min po IP, vsak vstop zapiše audit `DEMO_LOGIN`, MFA-zavarovan račun nikoli ni izbran). **Zapora (v1.148.0, audit #7)**: `DEMO_LOGIN_ENABLED=0` zapre takoj, `DEMO_LOGIN_EXPIRES_AT=<ISO>` zapre po roku — neveljaven datum zapre (fail-closed); GET na isti poti vrne SAMO stanje vrat (`enabled`/`code`/`expiresAt`, brez imen, e-pošt in ID-jev) + `Cache-Control: no-store`, da prijavni zaslon gumb skrije in ne obeta nečesa, kar je zaprto. Pred javno objavo: nastaviti rok ali zapreti. |
| `/api/auth/locations` | samo id/name aktivnih lokacij za izbiro prijave; rate limit 30/min po IP + `Cache-Control: no-store` (v1.147.0, audit #9 — kopija imenika ne sme ostati v brskalniku/CDN/proxy-ju) |
| `/api/public/menu` | samo javni meni lokacije (iz qrToken/device) |
| `/api/public/orders` | lokacija+miza rešeni SERVER-SIDE; cene iz DB; idempotencija; rate limit 10/min; audit `GUEST_ORDER_CREATED` |
| `/api/public/orders/status` | samo statusi vidni gostu (mapiranje) |
| `/api/delivery/webhook/[provider]` | HMAC `sha256=` (timingSafeEqual); brez secret → 503 fail-closed; idempotencija `platform:orderId`; rate limit 30/min |
| `/api/devices/enroll` | enkratna koda; claim → device token + lokacijska vezava; replay claim → 404 |
| `/api/setup/status` | samo binarne zastavice in profil (`isInitialized`/`mode`/`has*`, `counts: null`, `databaseUrl` je `configured`/`missing`); rate limit 30/min po IP (v1.82.1, audit — prej je vsak klic neavtentikirano pognal tri DB COUNT poizvedbe) |
| `/api/setup/claim` | **POST prevzem prve namestitve (v1.180.0, R3). Javna je PO NAMENU:** klic prihaja iz brskalnika na stroju, kjer uporabnik še ne obstaja — seja torej ne more obstajati, zato je varovalka petpogojna ograja (`setup-claim.ts`): lokalni profil + `x-local-front` dokaz fronte (HMAC iz `APP_SECRET`, `timingSafeEqual`) + klientov naslov v zanki + limit 5/min/IP + baza brez zaposlenih. Brez HTTPS fronte je pot vedno zavrnjena; glavo `x-forwarded-for` fronta prepiše iz lastnega soketa, zato tuja trditev o IP-ju do aplikacije ne potuje naprej. Notranjost ne uhaja (500 je generičen). Na oblaku ograja zavrne, zato se čarovnik na javni namestitvi ne more pojaviti. |

## MFA (issue #12 §3, v1.35.0 — utrjeno v1.94.0, issue #31–#36)

- TOTP (RFC 6238) — `src/lib/mfa.ts`, node crypto, brez novih odvisnosti;
  6-mestne kode, ±1 korak; združljivo z Google Authenticator (otpauth URI + QR).
- Potek: `/api/auth/mfa/enroll` → skrivnost + URI + QR; `/enable` (koda) →
  aktivacija + 8 recovery kod (plain ENKRAT; v DB SHA-256 hashi); `/disable`
  (koda ALI recovery); `/status` za UI.
- **Step-up (v1.94.0, #33)**: vsaka sprememba MFA (enroll/enable/disable)
  zahteva SVEŽ PIN v telesu zahteve (`pinStepUpOk` — ista scrypt/pinLookup
  disciplina kot prijava). Žeton sam po sebi NE zadostuje (ukradena dolgotrajna
  seja ne more nastaviti/izklopiti MFA). Sočasen enroll je CAS-zaščiten (409).
- **Revokacija sej (v1.94.0, #33)**: ob enable/disable se `sessionVersion`
  poviša → VSI drugi žetoni so TAKOJ preklicani; trenutni klient dobi
  nadaljevalni žeton v odgovoru (dokumentirana politika — brez prisilne
  ponovne prijave trenutne seje).
- Prijava: račun z `mfaEnabled` zahteva `mfaCode` (ali `mfaRecoveryCode`) —
  sicer 401 + `mfaRequired:true` (brez uhajanja, da je MFA vklopljena).
  - **TOTP replay (v1.94.0, #36, RFC 6238 §5.2)**: uspešno sprejet korak se
    ATOMARNO zapiše (`mfaLastTotpCounter`); enak/starejši korak (ponovna
    uporaba iste kode ali sočasnost) → zavrnjen. Politika prejšnjega koraka:
    koda iz koraka N-1 je sprejeta SAMO dokler ni bil porabljen novejši korak
    (striktna monotona rast — RFC priporočilo). TOTP poraba velja v LOGIN
    poti; disable s TOTP kodo je step-up (PIN + koda), ne prijavni zapis.
  - **Recovery poraba (v1.94.0, #35)**: ATOMARNA CAS transakcija nad
    `mfaRecoveryVersion` — sočasna uporaba iste kode pomeni TOČNO ENO
    zmagovalko (druga → 401); ostale kode ostanejo nedotaknjene.
  - **MFA poskusi (v1.94.0, #32)**: namenski limit 10/5 min po računu
    (`mfa-acct:`) — IP login limit ga NE nadomešča.
- **Enforcement (v1.94.0, #31)**: `MFA_ENFORCE_AFTER` env (ISO/epoch) določa
  prehod iz mehke politike v STROGO. Po tem trenutku privilegiran račun brez
  `mfaEnabled` pri prijavi dobi SAMO omejen **mfa-enrollment-only žeton**
  (1 h, `mfaEnrollOnly:true` — velja izključno za `/api/auth/mfa/**` + `/me`);
  `requireAuth` takoj zavrne navadne žetone (401 `mfaRequired`), vsi
  dovoljenjski vnosi (requirePermission/WithPerms/CentralRole) zavrnejo
  enrollment-only žetone (403). Vloga/MFA stanje se izpelje IZKLJUČNO iz DB
  (nikoli iz klienta) — sprememba vloge zaposlenega prekliče seje (sv bump) →
  naslednja prijava pade pod politiko. **Privzeto (brez env) vlada
  migracijsko obdobje** (mehka politika + `mfaMandatory:true` UI nagovor) —
  obstoječi računi se ne zaklenejo nenapovedano; operater nastavi datum, ko
  so računi vpisali MFA.
- **Zahtevane vloge (v1.94.0, #31 — izrecna odločitev)**:
  owner/admin/**manager**/group_owner/org_admin/property_manager. MANAGER je
  vključen, ker permissions.ts dodeli vlogi VSA kanonična dovoljenja (enak
  obseg kot owner/admin). Operativne vloge (staff/waiter/bar/chef/kitchen/
  warehouse/accounting) ostajajo na PIN prijavi.
- **Bootstrap break-glass (v1.94.0, #34)**: veljavna BOOTSTRAP_ADMIN_EMAIL/PIN
  poverilnica IZDA SAMO ločeno `sub='bootstrap'` identiteto (2 h, ADMIN,
  audit `LOGIN_BOOTSTRAP_USED`/`LOGIN_BOOTSTRAP_BREAKGLASS`) — NIKOLI sejo pod
  `employee.id` (niti ob napačnem PIN-u obstoječega zaposlenega z istim
  e-poštnim naslovom; prej je ta pot obšla MFA). Break-glass uspeh ni
  zabeležen kot `LOGIN_FAILED`. Brez Employee vrstice MFA na bootstrapu ni
  mogoča (namerno).
- **Login rate limiting (v1.94.0, #32)**: IP limit 10/min (store-aware:
  Upstash REST, če je konfiguriran — vse instance delijo števec; izpad →
  bounded-memory fallback + glasen `console.error`, fallback NI globalna
  meja) + ACCOUNT dimenzija po normaliziranem e-poštnem naslovu (10/min +
  30/15 min — časovno omejeno okence, NE trajen zaklep). IP signal:
  `x-vercel-forwarded-for` (platforma ga nastavi/prepiše — neponareljiv) >
  `x-forwarded-for` > `unknown`. Javne napake ostanejo enake za vse vzroke
  (brez naštevanja računov); zavrnitve zapišejo audit `LOGIN_RATE_LIMITED`
  (brez PIN-ov/kod).
- PIN prijava operativnih vlog ostane nespremenjena (POS hitrost, §18).
- Audit dogodki: `MFA_ENROLL_STARTED`, `MFA_ENABLED`, `MFA_DISABLED`,
  `MFA_LOGIN_SUCCESS`, `MFA_LOGIN_FAILED`, `MFA_RECOVERY_USED`,
  `MFA_STEPUP_FAILED`, `MFA_RATE_LIMITED`, `LOGIN_MFA_ENROLLMENT_REQUIRED`,
  `LOGIN_RATE_LIMITED`, `LOGIN_BOOTSTRAP_USED`, `LOGIN_BOOTSTRAP_BREAKGLASS`.
  Audit NIKOLI ne vsebuje PIN-ov, TOTP/recovery kod, skrivnosti, otpauth
  URI-jev ali žetonov.

## Payment boundary (issue #12 §4 — preverjeno, NI novega sistema)

- Shema: `Payment.cardType` + `Payment.cardLast4` + `authorizationCode` —
  **PAN/CVV/track data se NE shranjujejo** nikjer v shemi
  (137/137 modelov, re-verificirano v1.194.0; prvotna trditev 116/116).
- Terminal: `src/lib/devices/terminal.ts` — POS pošlje znesek, terminal vrne
  kodo odobritve → `Payment.authorizationCode` (sledljivost brez kartice).
- Idempotencija: `Payment.idempotencyKey` (unique) — dvojni klik/duplikat →
  eno plačilo.
- Webhook verifikacija: delivery webhooki HMAC fail-closed (503 brez secret).
- Neznano stanje: `Payment.status` (default `completed`) + `refundAmount`;
  provider transakcijski ID/timeout/unknown-state tok = **issue #7**
  (payment orchestration) — ta issue ga ne duplicira (§9).
- Logi: IntegrationLog hrani SAMO operativne reference (platformski ID naročila,
  število artiklov, host integracije, idempotency ključe) — surov payload
  platforme z osebnimi podatki gosta (ime, telefon, naslov, opombe) se NE
  zapisuje (v1.163.0); javni odgovori ne vsebujejo zaposlenih/PIN (maskiranje
  telefona `maskPhone`).

## PCI DSS v4.0 — SAQ-A pristop (v1.194.0, dokumentacija; gl. TRZNA-VRZELI §5)

**Klasifikacija:** RestaurantOS je povezan ponudnik storitev, ki kartične podatke
(PAN, track data, CVV/CVC, PIN) **nikoli ne sprejme, ne obdela, ne
shranjuje in ne prenaša** — vsi plačilni tokovi so povsem outsourcing na
PCI DSS potrjene ponudnike. To je tehnična drža za samopreverjanje
**SAQ A** (povsem outsourced e-commerce, v4.0); polnjenje vprašalnika,
AOC in kvartalni ASV sken so URAVNI postopki lastnika — koda te drže
ne more zamenjati, dokument pa je njena podlaga.

**Tri poti plačila in kje se kartični podatki pojavijo:**

1. **PayLink `/pay/<token>` (Stripe Checkout, redirect)** — gost vnese
   kartico NA STRIPE DOMENI (`src/lib/paylink/core.ts`: „kartica se
   vnese na Stripe domeni — PCI SAQ-A drža“); RestaurantOS ustvari sejo
   (znesek ZAKLEPAN, v1.98.0), prejme samo status seje in zapiše poravnavo
   (`settleStripeSession`). Vezava seje na konkretno povezavo: issue #37
   (SSRF/paylink binding), test `tests/issue30-37-ssrf-paylink-binding.test.ts`.
2. **Fizični terminal** (`src/lib/devices/terminal.ts`) — POS pošlje
   ZNESEK, terminal vrne kodo odobritve → `Payment.authorizationCode`.
   Terminal je v obsegu svojega ponudnika (PCI PTS); RestaurantOS vidi
   samo ne-kartično kodo. Profili dokazovanja (`src/lib/payments-policy.ts`,
   issue #49): `verified_provider` (REZERVIRAN za pravo strežniško
   integracijo — klient ga ne more zahtevati), `manual_attestation`
   (ročna zabeležba, izklopljiva `PAYMENTS_ALLOW_MANUAL_ATTESTATION=false`),
   `simulator` (SIM- predpona, SAMO v testnem/fiskalnem simulacijskem
   okolju — produkcija 402). Test: `tests/issue49-51-64-payments.test.ts`.
3. **Denarnice** (`WalletPayment`) — `paymentToken`/`tokenType` so
   ponudniški ŽETONI, ne PAN; `cardBrand` + `cardLast4` so izpeljanke,
   ki jih vrne ponudnik.

**Shema kot dokaz:** `Payment` nosi `cardType` + `cardLast4` +
`authorizationCode` (koda odobritve, ne kartica); `WalletPayment` nosi
`cardBrand` + `cardLast4` + `paymentToken`. PAN/CVV/track data NIKJER v
shemi (137/137 modelov — besedilno iskanje `pan|cvv|track` naleti samo na
komentarje politike). **Omejitev obsega:** `GiftCard.cardNumber` je
interna identifikacija LASTNE darilne kartice (izdana v sistemu, ni
plačilna kartica) — ni v PCI obsegu; v reviziji je treba to povedati,
ker ime kolidira z laičnim branjem.

**Posledica za obseg:** ker CHD nikoli ne vstopi v sistem, se Vercel
namestitev, aplikacija in baza NE štejejo za CHD okolje — segmentacija
je trivialna (nič za segmentirati), obseg vprašalnika se ustavi pri
izrecno dokumentiranih vmesnikih (Checkout redirect, terminal koda,
žeton denarnice). **Meje države:** (a) uvedba lastnega vnosa kartice na
naši domeni ali strežniška obdelava PAN bi obseg spremenila v SAQ A-EP
ali D — to se NAREKUJE z zgoraj omenjenimi profili; `verified_provider`
profil je oblikovan tako, da prava ponudniška integracija prinese SAMO
rezultat (kodo/status/žeton), ne CHD; (b) sprememba ponudnika plačil
(izbira e-poti/PEPPOL za B2B, P2-11) ne vpliva na SAQ-A, dokler nova
e-pot spet ne prenaša CHD skozi sistem.

## Površina odvisnosti (v1.154.0 — OSV pregled 20. 10. 2026)

Te meje niso naša koda, ampak koda, ki jo dobavimo — zato so zapisane kot test
(`tests/dependency-advisories.test.ts`, skupine A–D), ne le kot namera. Vercel
in oba CI-ja nameščata z `bun install --frozen-lockfile`, torej različica med
buildom ne more „uplavati“: kar je v `bun.lock`, gre v produkcijo.

| Paket | Prej | Zdaj | Razlog |
|---|---|---|---|
| next | 16.1.3 (38 najdb) | 16.4.2 (meja **16.3.8**) | GHSA-2xp9-vwfh-vxw4 in GHSA-p293-qw3h-jr36 — dve CRITICAL neavtenticirani RCE (optimizacija slik/AVIF; strežniki na Windowsih) + vrsta SSRF/DoS/CSRF popravkov |
| sharp | 0.34.5 | **0.35.5** | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w (libvips/libheif/librsvg) |
| next-auth | 4.24.13 | odstranjen | GHSA-7rqj-j65f-68wh (CRITICAL homoglyph obhod); paket ni bil uvožen v `src/` |
| next-intl | 4.7.0 | odstranjen | GHSA-8f24-v5vv-gm5j (odprta preusmeritev); ni bil uvožen v `src/` |
| uuid | 11.1.0 | odstranjen | GHSA-w5hq-g745-h8pq; ni bil uvožen v `src/` |
| js-yaml (tranzitivno) | 4.1.1 | **4.3.2** (override) | GHSA-2883-xcg3-v3hh, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-h67p-54hq-rp68 |
| eslint-plugin-react-hooks | 7.1.1 | **7.0.1** (override) | ni varnostna najdba: 7.1.1 vklopi React Compiler pravila → 73 napak lint-a; refaktor je ločena izdaja, gate pa do takrat ostane merljiv |

### Preostale najdbe (sprejete, z razlogom)

OSV po nadgradnji (827 nameščenih paketov): 4 paketi s po eno HIGH najdbo.
Vse štiri so nedosegljive na naši poti izvajanja ali nimajo popravka:

- **braces 3.0.3** — GHSA-vfj7-8cjw-p6xm, popravka ni. Tranzitivno prek
  micromatch (lint/build); vhod odjemalca ne pride do vzorca.
- **deepmerge-ts 7.1.5** — GHSA-ggr8-5vv4-36mx, popravek 8.0.0.
  `@prisma/config` ga pripne točno; teče samo v Prisma CLI ob generate/build,
  nikoli v strežniku. Nadgradnja na Prisma 7 je ločena izdaja.
- **effect 3.18.4** — GHSA-38f7-945m-qr2g, popravek 3.20.0. Enak exact pin
  `@prisma/config`; napaka zahteva sočasni Effect RPC promet, ki ga v CLI ni.
- **node-forge 1.4.0** — GHSA-86w9-cpqp-85rv, popravka ni. Edina uporaba je
  branje PKCS#12 v `src/lib/furs/client.ts` (`pkcs12FromAsn1` + pretvorbe v
  PEM). Podpisovanje in preverjanje tečeta prek `node:crypto`
  (`createSign('RSA-SHA256')`), zato ranljiva pot preverjanja podpisa ni
  dosegljiva. Ko bo popravek objavljen, se ocena ponovi.

## Testi

`tests/mfa.test.ts` (24): RFC 6238 vektorji, okno, fail-closed, base32,
recovery poraba/replay, vloge. `tests/tenant.test.ts` (15): cross-org deny,
forged ID-ji, legacy passthrough. `tests/session.test.ts` (4): revokacija.
`tests/delivery.test.ts` (16): HMAC/idempotencija/rate limit.
`tests/dependency-advisories.test.ts` (17): spodnje meje next/sharp, lockfile
proti package.json, nameščeno stanje proti lockfile-u, dokumentirana ocena
preostalih najdb in dosegljivost node-forge.
