# Incident Runbook — operativni incidenti in okrevanje (issue #3 §G/H)

> **Stanje (v1.120.0):** vsaka napaka iz P0/P1 popravkov je ZVIDNA
> (AuditLog + /api/monitoring/errors: `PRINT_FAILED`, `FISCAL_SUBMIT_FAILED`,
> `SYNC_OP_DROPPED`, `ERROR_REPORT`) in ima okrevanje spodaj. Koraki, ki
> zahtevajo ČLOVEŠKO odločitev, so označeni z ⚠.

## 1. Fiskalizacija je padla (račun ostane 'pending')

**Simptom:** AuditLog `FISCAL_SUBMIT_FAILED` (provider FURS/CIS), račun
`fiscalStatus='pending'` (plačilo je UREJENO), push RECEIPT_FAILED, dnevni
prod-smoke poroča rastoči pending števec.

**Zakaj je to varno:** SOAP klic teče PO DB transakciji — plačilo/zaloga/račun
so zapisani; neuspešen EOR/JIR NE razveljavi izdaje. NE spreminjaj statusa
ročno (pending je POŠTEN dokler SubsequentSubmit ne uspe).

**Okrevanje (docs/FURS-CERT-RUNBOOK.md korak 5/6):**
1. Določi vzrok (omrežje? certifikat potekel? FURS/CIS izpad?): `FISCAL_SUBMIT_FAILED`
   details nosijo `error` (≤200 znakov), `receiptNumber`, `orderId`, `provider`.
2. ⚠ Odločitev: če je certifikat potekel → obnova certifikata (lastnik), potem
   ponovna fiskalizacija prek **SubsequentSubmit** (`subsequentSubmit: true` —
   polje je v SOAP pripravljeni, vodi ga ročni admin poziv; poznejši UI = runbook naloga).
3. Preveri izid: EOR/JIR na računu (UI računi / DB `Receipt.eor`, `cisJir`) +
   prijavljen račun na FURS/ePorezna portalu.
4. Dokumentiraj incident (čas, vzrok, št. računov).

⚠ Če SubsequentSubmit ZAVRNE (npr. podvojen zahtevek) — NE silite z novim
računom; reši skupaj s FURS/CIS podporo (fiskalna številka je že izdana).

## 2. Offline dead-letter (operacija padla po 10 poskusih)

**Simptom:** badge v glavi (`header.netDead` — „Zahteva posredovanje: N“),
AuditLog `SYNC_OP_DROPPED` (details: kind, attempts, lastError, clientOperationId).

**Okrevanje:**
1. Odpri pregled dead operacij (UI badge → seznam; API strani:
   `getDeadOps()` na napravi, `GET /api/monitoring/errors` na strežniku).
2. Za vsako operacijo: preberi `lastError` —
   - prehoden vzrok (omrežje, 409 zaradi stanja) → **Ponovno pošlji**
     (`resetDeadOp` → attempts=0 → naslednji flush);
   - strukturni vzrok (artikel umaknjen, naročilo plačano) → ⚠ odločitev
     natakarja/menedžerja: **Izvozi** (dokaz za ročni vnos) + **Zavrzi**
     (`clearDeadOps`).
3. Preveri, da strežniška `DeviceSyncOperation` vrstica (deviceId +
   clientOperationId) ni 'applied' — če JE, je operacija že uspela (klient je
   samo izgubil odgovor) → varno zavrzi.

## 3. Tisk ni šel skozi (triage)

**Simptom:** AuditLog `PRINT_FAILED` / gost/osebje nima računa-lista.

1. `GET /api/print/jobs` (diagnostika — status/kind filter): preveri zadnje
   poskuse (`sent` = dostavljeno do vtičnice, `failed` = napaka z razlogom).
2. `failed` → preveri: print-agent živi? (`curl http://<agent-host>:3031/`),
   tiskalnik prižgan/papir, host/port v Nastavitvah, host allowlist agenta.
3. `sent` a ni tiska → ⚠ tiskalnik je prejel bajte brez napake, fizičnega tiska
   agent NE more potrditi (BLOKIRANO: DLE polling — HARDWARE-MATRIX.md §1):
   preveri papir/zaklep, natisni ponovno (nov poskus = nova PrintJob vrstica).
4. Reprint: etikete DA (gumb, `printCount++` + 409 blokade), račun → POS
   „natisni znova“ na računih (nov poskus); kopija računa (isCopy) še NI v UI.
5. Vsebina napačna (ČŠZ?) → cp852 preslikava je v agentu; pošlji vzorčni
   dokument iz Nastavitev (testni postopek HARDWARE-MATRIX.md §5).

## 4. Rotacija webhook podpisa (Glovo/Wolt)

**Simptom:** dostave zavrnjene (401/403 v IntegrationLog), sum izpostavljenega
skrivnega ključa.

1. ⚠ Pridobi NOV skrivni ključ pri ponudniku (portal).
2. Posodobi v integracijah (UI) → preveri prvo dostavo (IntegrationLog +
   `DELIVERY_*` audit).
3. Stari ključ preneha veljati pri ponudniku (ponudnik ga razveljavi) —
   podpis je timing-safe (`HMAC-SHA256` + `timingSafeEqual` PRED zapisom),
   replay idempotenten (`Order.idempotencyKey` `glovo:`/`wolt:`).

## 5. Stripe verify ni dosegljiv

**Simptom:** gost vidi „Preverjanje plačila trenutno ni dosegljivo.
Poskusite znova.“ (502 — issue #3 §B). Povezava OSTA odprta — plačilo NI
potrjeno, ponovni poskus je varen.

1. Preveri Stripe status page + `STRIPE_SECRET_KEY` veljavnost.
2. Gost klikne POTRDI ponovno (seja ostane vezana #37 — CAS preprečuje dvojni
   obračun); po okrevaju se potrditev uspe.
3. Če je bila seja PLAČANA a potrditev spodletela → naslednji POST z istim
   zneskom ponovno uporabi obstoječo plačano sejo (idempotentna pot
   `src/app/api/public/pay/[token]/route.ts` ~:345).

## 6. Rollback / obnova (sklic)

- **Aplikacija:** Vercel Promote prejšnjega immutable deploya — tabela v
  docs/DEPLOYMENT-RESILIENCE.md („Rollback“).
- **Baza:** NIKOLI brez ⚠ lastnikove odločitve — restore drill postopek v
  docs/BACKUP-RESTORE.md §3 (efemerni branch, validacijske poizvedbe).
- **Kombinacija:** 1) promote stare kode 2) smoke (`scripts/smoke-test.sh`)
  3) revert commit 4) naslednji deploy.

## 7. Kateri koraki zahtevajo ČLOVEKA (⚠)

- SubsequentSubmit fiskalizacije (fiskalna odgovornost — #1/§4).
- Zavrzi/izvozi dead operacijo s poslovnim vplivom (§2).
- Obnova baze / rollback na starejši deployment (§6).
- Rotacija webhook/payment skrivnosti (§4, #5) — lastnik priskrbi nove ključe.
- Terminal način po lokaciji (TERMINAL-PROVIDERS.md — nikoli ne laširaj
  verified_provider).
