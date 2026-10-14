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
| `/api/auth/locations` | samo id/name/code lokacij za izbiro prijave |
| `/api/public/menu` | samo javni meni lokacije (iz qrToken/device) |
| `/api/public/orders` | lokacija+miza rešeni SERVER-SIDE; cene iz DB; idempotencija; rate limit 10/min; audit `GUEST_ORDER_CREATED` |
| `/api/public/orders/status` | samo statusi vidni gostu (mapiranje) |
| `/api/delivery/webhook/[provider]` | HMAC `sha256=` (timingSafeEqual); brez secret → 503 fail-closed; idempotencija `platform:orderId`; rate limit 30/min |
| `/api/devices/enroll` | enkratna koda; claim → device token + lokacijska vezava; replay claim → 404 |

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
  **PAN/CVV/track data se NE shranjujejo** nikjer v shemi (116/116 modelov).
- Terminal: `src/lib/devices/terminal.ts` — POS pošlje znesek, terminal vrne
  kodo odobritve → `Payment.authorizationCode` (sledljivost brez kartice).
- Idempotencija: `Payment.idempotencyKey` (unique) — dvojni klik/duplikat →
  eno plačilo.
- Webhook verifikacija: delivery webhooki HMAC fail-closed (503 brez secret).
- Neznano stanje: `Payment.status` (default `completed`) + `refundAmount`;
  provider transakcijski ID/timeout/unknown-state tok = **issue #7**
  (payment orchestration) — ta issue ga ne duplicira (§9).
- Logi: IntegrationLog/request shranjuje payloadi platform (brez kartičnih
  podatkov, ker jih POS sploh ne vidi); javni odgovori ne vsebujejo
  zaposlenih/PIN (maskiranje telefona `maskPhone`).

## Testi

`tests/mfa.test.ts` (24): RFC 6238 vektorji, okno, fail-closed, base32,
recovery poraba/replay, vloge. `tests/tenant.test.ts` (15): cross-org deny,
forged ID-ji, legacy passthrough. `tests/session.test.ts` (4): revokacija.
`tests/delivery.test.ts` (16): HMAC/idempotencija/rate limit.
