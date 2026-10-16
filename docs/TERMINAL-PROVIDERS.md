# Terminal Providers — pogodba za integracijo plačilnega terminala (issue #3 §E)

> **Stanje (v1.120.0):** POS nima PRAVE integracije s terminalnim ponudnikom — in
> tega NE pretvarja. Na voljo so tri POŠTENI načini (klient, localStorage) in en
> REZERVIRAN profil za prihodnjo integracijo. Pravilo: **NIKOLI ne laširaj
> `verified_provider`** — dokaz kartičnega plačila izključno iz strežniško
> preverjenega vira.

## 1. Trenutni načini (src/lib/devices/terminal.ts — 'use client')

| Način | Vedenje | Kje živi |
|---|---|---|
| `none` | brez terminala — gotovina/druge metode | localStorage `ro_terminal_config` |
| `simulator` | avtomatska odobritev po 700 ms s kodo `SIM-XXXXXX` + console oznaka | klient (brskalnik) |
| `manual` | kasir potrdi NA FIZIČNEM terminalu in prepiše kodo odobritve (window.prompt) | klient |

Terminal MODE se NE shranjuje na Payment — shranjen je SAMO
`Payment.authorizationCode` (koda odobritve, ≤40 znakov) + profil dokazovanja v
audit `INVOICE_ISSUE` (glej §2).

## 2. Profili dokazovanja (src/lib/payments-policy.ts — STREŽNIK odloča)

| Profil | Kako nastane | Veljavnost |
|---|---|---|
| `simulator` | odobritvena koda s predpono `SIM-` | SAMO v fiskalnem simulacijskem okolju (`FURS_ENVIRONMENT`/`Location.fursEnvironment`); v produkciji → **402** |
| `manual_attestation` | vsaka druga ne-prazna koda (ročni prepis zaposlenega) | privzeto dovoljena; lastnik jo izklopi z `PAYMENTS_ALLOW_MANUAL_ATTESTATION=false` → 402 |
| `verified_provider` | **REZERVIRANO** — SAMO iz strežniško preverjenega vira ponudnika | NOBEN klient danes ne more zahtevati tega profila |

SIM- konvencija: brskalniški simulator vedno generira `SIM-` predpono — strežnik
jo prepozna NEODVISNO od klienta (klasifikacija `approvalAttestationProfile`).
PAN/CVV se NIKOLI ne shranjujeta.

## 3. Kaj PRAVA integracija MORA implementirati (pogodba)

Integracija terminala se NE sme pretvarjati kot „verified“ preden izpolni vse
točke — vsaka točka je varovalka pred dvojnimi/izmišljenimi plačili:

1. **Operacije**: authorize (avtorizacija zneska), capture, void, refund, status
   (poizvedba izida) — vsaka z idempotenčno zaščito.
2. **Reconciliation neznanega izida** (ključna točka): izpad omrežja med
   authorize → NE SME pomeniti „approved“ niti „failed“ — tok mora zahtevati
   `status` poizvedbo po izidu in vezati izid na transakcijski ID ponudnika.
   Timeout NIKOLI ni odobritev.
3. **Stabilni interni idempotencyKey** (`Payment.idempotencyKey` vzorec obstaja:
   `key#p{i}`/`#loyalty` v `src/lib/furs/issue.ts` ~:658) — ponovljen POS gumb
   = ENA transakcija pri ponudniku.
4. **Referenca ponudnika** (provider transaction ID) se zapiše ob
   `authorizationCode` — revizijska sled poveže plačilo do dokaza pri ponudniku.
5. **Strežniško razrešitev profila** `verified_provider` — profil se dodeli
   SAMO iz strežniško preverjenega odgovora (vezava na znesek/valuto/merchant/
   lokacijo + edinstven transakcijski ID); klient nikoli ne pošlje profila.
6. **Zrcaljenje na PayLink pot** (Stripe vzorec, `src/lib/paylink/core.ts`):
   vezi seje na povezavo (metadata + CAS), atomarno poravnano stanje — isti
   vzorec velja za terminalne seje, če ponudnik ponuja.

## 4. Potrebni LASTNIKOVI podatki (za integracijo)

- merchant račun pri ponudniku (POS terminal pogodba),
- SDK/dokumentacija + API ključi (sandbox NAJPREJ),
- fizična testna naprava (testna kartica),
- odločitev: ali `manual_attestation` ostaja vklopljena v prehodnem obdobju
  (`PAYMENTS_ALLOW_MANUAL_ATTESTATION`).

## 5. Referenca

- Politika + klasifikacija: `src/lib/payments-policy.ts` (testi:
  `tests/issue49-51-64-payments.test.ts`)
- Terminal adapter (klient): `src/lib/devices/terminal.ts`
- Fiskalni tok (kjer profil velja): `src/lib/furs/issue.ts` (parts + attestation)
- Stripe kot VZORČNA strežniška integracija: `src/lib/paylink/core.ts`,
  `src/app/api/public/pay/[token]/route.ts` (#37 vezava seje)
