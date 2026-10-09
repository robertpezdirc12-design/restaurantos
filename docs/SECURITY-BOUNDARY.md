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
| Tenant scope | org meja INLINE v enterprise rutah (GET filtrira org, POST cross-org → 403); `assertTenantScope` (src/lib/tenant.ts) definiran, **še ni povezan v rute** (rezerva — glej TENANT-ISOLATION.md) | enterprise rute (`/api/enterprise`) |
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

## MFA (issue #12 §3, v1.35.0)

- TOTP (RFC 6238) — `src/lib/mfa.ts`, node crypto, brez novih odvisnosti;
  6-mestne kode, ±1 korak; združljivo z Google Authenticator (otpauth URI + QR).
- Potek: `/api/auth/mfa/enroll` → skrivnost + URI; `/enable` (koda) → aktivacija
  + 8 recovery kod (plain ENKRAT; v DB SHA-256 hashi); `/disable` (koda ALI
  recovery); `/status` za UI.
- Prijava: račun z `mfaEnabled` zahteva `mfaCode` (ali `mfaRecoveryCode`) —
  sicer 401 + `mfaRequired:true` (brez uhajanja, da je MFA vklopljena).
  Recovery poraba je atomična (hashi se odstranijo ob uspehu) + auditira
  (`MFA_RECOVERY_USED`).
- Privilegirane vloge (owner/admin/group_owner/org_admin/property_manager)
  brez MFA: prijava NE blokira (migracijsko varno), odgovor nosi
  `mfaMandatory:true` → UI nagovori enroll; status poroča `mandatory`.
- **Bootstrap admin ostane break-glass** (brez DB vrstice → MFA na njem ni
  mogoča) — obnova dostopa prek env; auditirana prijava (2 h žeton).
- PIN prijava operativnih vlog ostane nespremenjena (POS hitrost, §18).
- Audit dogodki: `MFA_ENROLL_STARTED`, `MFA_ENABLED`, `MFA_DISABLED`,
  `MFA_LOGIN_SUCCESS`, `MFA_LOGIN_FAILED`, `MFA_RECOVERY_USED`.

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
