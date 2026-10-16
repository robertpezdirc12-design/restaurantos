# POS Readiness — matrika pripravljenosti (issue #3, P1)

> **Stanje (v1.120.0, issue #3):** vsa P0/P1 popravka iz Faze 0 inventure (3-design)
> sta IMPLEMENTIRANI in TESTIRANI (dead-letter vrsta, poštenost tiska, fiskalni audit,
> flush obeh mobilnih površin, Stripe verify varovalka, monitoring filter).
> **SIMULACIJA ≠ DOKAZ O PRODUKCIJI** — simulator FURS/CIS, terminal SIM- in print
> simulator so jasno ločeni načini; za go-live so potrebni LASTNIKOVI vnosi
> (certifikati, terminal, tiskalniki — glej §4).

## 1. Matrika po področjih (A–H iz Faze 0 inventure, v1.119.1)

| Področje | Status | Dokaz (datoteka:vrstica) |
|---|---|---|
| A — Offline vrsta: dead-letter | **IMPLEMENTIRANO+TESTIRANO** | `src/lib/offline-queue.ts` (markOpAttempt → status 'dead', poročilo /api/sync/drop); `src/app/api/sync/drop/route.ts` (AuditLog SYNC_OP_DROPPED); `tests/issue3-pos-readiness.test.ts` |
| A — Offline vrsta: replajabilne mutacije, idempotenca R7 | IMPLEMENTIRANO+TESTIRANO (predhodno) | `src/app/api/sync/route.ts` (claim CAS + replay); `tests/race-fixes.test.ts`, `tests/issue56-57-65-replay-scope.test.ts` |
| A — flush površin | **IMPLEMENTIRANO+TESTIRANO** (source-pin) | dashboard: startup+online+gumb; handheld: online **+ zagon (issue #3 §D)**; tablica: **online + zagon (issue #3 §D — prej NI flushala)** |
| B — Fiskalizacija: EOR/JIR SOAP | IMPLEMENTIRANO+TESTIRANO | `src/lib/furs/client.ts` (mTLS), `src/lib/cis/client.ts` (1-way TLS); `tests/furs-client.test.ts` (16), `tests/cis-client.test.ts` (26) |
| B — Fiskalizacija: napaka izdaje | **IMPLEMENTIRANO+TESTIRANO** | račun ostane `fiscalStatus='pending'` + AuditLog `FISCAL_SUBMIT_FAILED` (`src/lib/furs/issue.ts` ~:849 FURS / ~:902 CIS) |
| B — Fiskalizacija: fail-closed profil | IMPLEMENTIRANO+TESTIRANO (issue #53) | `src/lib/fiscal-profile.ts`; `tests/issue53-54-fiscal-po-scope.test.ts` |
| B — Stripe verify varovalka | **IMPLEMENTIRANO+TESTIRANO** (source-pin) | `src/app/api/public/pay/[token]/route.ts` ~:306 → 502 s POŠTENIM sporočilom (prej surov 500) |
| C — Tisk: poštenost statusov | **IMPLEMENTIRANO+TESTIRANO** | `src/lib/print.ts` PRINT_STATUSES + 'sent'; `src/lib/devices/print.ts` agent → 'sent'; `tests/print-ack.test.ts` + issue3 testi |
| C — Tisk: evidenca poskusov | IMPLEMENTIRANO+TESTIRANO (issue #10) | PrintJob vrstica + PRINT_FAILED audit (`src/app/api/print/ack/route.ts`); pregled `GET /api/print/jobs` |
| C — Tisk: DLE status tiskalnika | **BLOKIRANO** (runbook naloga) | print-agent NE bere statusa tiskalnika (samo dostava do vtičnice) → 'sent', nikoli 'printed' za agent pot |
| E — Terminal na POS | **DELNO** (načini none/simulator/manual — klient; glej docs/TERMINAL-PROVIDERS.md) | `src/lib/devices/terminal.ts`, `src/lib/payments-policy.ts` (profili dokazovanja); PRAVA integracija = BLOKIRANO na odločitev lastnika |
| F — Integracije | DELNO | webhook Glovo/Wolt: IMPLEMENTIRANO+TESTIRANO (`tests/delivery.test.ts`); Stripe Checkout: IMPLEMENTIRANO+TESTIRANO (`tests/paylink-flow.test.ts`); channel-sync izhodni push: MOCK-ONLY (ponudnik ni potrjen — #9); SMS Twilio: adapter fail-soft |
| G/H — Monitoring/dokumentacija | **IMPLEMENTIRANO+TESTIRANO** | `GET /api/monitoring/errors` zdaj vključuje PRINT_FAILED / FISCAL_SUBMIT_FAILED / SYNC_OP_DROPPED (`src/app/api/monitoring/errors/route.ts` ~:28); ta dokument + 5 novih runbookov |

**BLOKIRANO brez človeškega vnosa** (po pravilu „nikoli ne laširaj integracije"):
DLE tiskalniški status, pravi terminalni ponudnik, FURS/CIS produkcijski certifikat,
channel-sync izhodni push (Glovo/Wolt API poverilnice).

## 2. Matrika okoljskih spremenljivk

| Env | Pomen | Privzeto / fail-closed |
|---|---|---|
| `FURS_ENVIRONMENT` | production / test / simulation (globalno > Location.fursEnvironment) | produkcija BREZ vrednosti → 503 (issue #53) |
| `FURS_CERT_P12_B64` + `FURS_CERT_PASSWORD` | SI kvalificirani certifikat (base64 P12) | manjka → 'pending' (brez lažnega verified) |
| `FURS_ENDPOINT_URL` | override SOAP endpointa | NASTAVLJENO SAMO za mock teste |
| `FURS_ALLOW_SIMULATION` / `FURS_PRODUCTION_TEST_MODE` | zastavici simulacije | v produkciji zavrnjeni (fail-closed) |
| `FURS_HR_ENVIRONMENT`, `FURS_HR_CERT_P12_B64`, `FURS_HR_CERT_PASSWORD`, `FURS_HR_CA_PEM`, `FURS_HR_ENDPOINT_URL` | HR CIS (Fiskalizacija 2.0) | isti vzorec kot SI |
| `PAYMENTS_ALLOW_MANUAL_ATTESTATION` | `false` = ročna potrditev terminala onemogočena | nezastavljeno = dovoljena (audit vedno piše profil) |
| `STRIPE_SECRET_KEY` | plačilne povezave prek Stripe Checkout | manjka → simulator (vidno označen) |
| `PRINT_AGENT_TOKEN`, `PRINT_AGENT_HOST`, `PRINT_AGENT_ALLOWED_HOSTS`, `PRINT_AGENT_ALLOWED_PORTS` | print-agent (port 3031) | ne-lookback bind BREZ žetona = zavrne zagon (fail-closed) |
| `APP_SECRET`, `PIN_LOOKUP_SALT`, `CRON_SECRET`, `BOOTSTRAP_ADMIN_*` | varnostni skrivnosti | glej `.env.example` |
| `UPSTASH_REDIS_REST_URL/TOKEN` | deljeni rate-limit | brez env dormant |

## 3. Kaj SIMULACIJA dokaže (in česa NE)

- Dokaže: tok, idempotenca, audit sled, QR, storno, ZOI/ZKI/EOR/JIR izračun,
  dead-letter obnašanje, print evidence.
- NE dokaže: mTLS zazihtev FURS, FINA CA verige, terminala ponudnika, fizičnega
  tiska (print-agent 'sent' = dostava do vtičnice), Stripe živega plačila.
- Povzetek: **vsak 'verified' status iz simulacije je v audit označen**
  (`fursEnvironment`, `simulation` polje) — poročila razločijo testno od produkcijskega.

## 4. Go-live checklist (ODLOČITVE LASTNIKA)

1. **Terminal ponudnik** — izbira + podatki (glej docs/TERMINAL-PROVIDERS.md §4):
   merchant račun, SDK/ključi, testna naprava. BREZ ponudnika kartično plačilo na
   POS ostaja manual_attestation (ali izklopljeno z `PAYMENTS_ALLOW_MANUAL_ATTESTATION=false`).
2. **FURS certifikat (SI) + CIS certifikat (HR)** — kvalificirana potrdila, prijava
   poslovnih prostorov (docs/FURS-CERT-RUNBOOK.md koraki 1–5).
3. **Tiskalniki** — modeli s TCP 9100 + ESC/POS cp852 (docs/HARDWARE-MATRIX.md §1);
   potrditi izris SL znakov (ČŠŽ), rez, QR na etiketah.
4. **Print-agent** — naprava v LAN, `PRINT_AGENT_TOKEN` + `PRINT_AGENT_ALLOWED_HOSTS`
   (docs/HARDWARE-MATRIX.md §4).
5. **Stripe** — produkcijski `STRIPE_SECRET_KEY` + preizkus žive povezave 0,01 EUR.
6. **Restore drill** — izvedi dokazano obnovo (docs/BACKUP-RESTORE.md §3 — še NI
   izvedena, dokazališče je na voljo).
7. **Rollback načrt** — DEPLOYMENT-RESILIENCE.md tabela + INCIDENT-RUNBOOK.md §6.

## 5. Referenca

- Faza 0 inventura: worklog 3-design (A–H z dokazi)
- P0/P1 implementacija: worklog 3-backend; testi `tests/issue3-pos-readiness.test.ts`
- Sorodni dokumenti: `FURS-CERT-RUNBOOK.md`, `TERMINAL-PROVIDERS.md`,
  `HARDWARE-MATRIX.md`, `OFFLINE-CAPABILITY.md`, `BACKUP-RESTORE.md`,
  `INCIDENT-RUNBOOK.md`, `DEPLOYMENT-RESILIENCE.md`
