# Offline Capability — kaj dela brez omrežja (issue #3 §A)

> **Stanje (v1.120.0):** POS površine (dashboard, handheld, tablica) so
> offline-first za REPLAJABILNE mutacije (naročila/kuhinja) z localStorage vrsto
> + dead-letter po 10 poskusih. **Plačila in fiskalizacija NIKOLI ne grejo offline**
> (po zasnovi) — denar/transakcije zahtevajo strežnik.

## 1. Kaj dela offline, po površini

| Površina | Dela offline | Mehanizem |
|---|---|---|
| Dashboard (glavni POS) | order.create / order.addItems / kitchen.status | localStorage vrsta (`ro_offline_queue`) + flush: zagon + `online` dogodek + gumb |
| Handheld | enako kot dashboard | vrsta + flush: `online` dogodek **+ zagon** (issue #3 §D) |
| Tablica | enako kot dashboard | vrsta + flush: `online` dogodek **+ zagon** (issue #3 §D — prej NI flushala) |
| QR meni / kiosk | **NE** (javne rute zahtevajo strežnik) | fail-closed — naročilo NI oddano, dokler ni povezave |
| Customer display | **NE** (prejme push/poll) | prikaže zadnje znane podatke + „povezava izgubljena“ |
| Print (agent) | da — SAMO LAN | print-agent ↔ tiskalnik po TCP; POS brskalnik mora doseči agenta (LAN) |

## 2. Semantika vrste (src/lib/offline-queue.ts)

- Samo **replajabilne mutacije**: `order.create`, `order.addItems`,
  `kitchen.status` — vsaka z UUID `clientOperationId` (idempotenca strežnika:
  `DeviceSyncOperation` unique (deviceId, clientOperationId), claim CAS
  'processing' → 'applied'/'failed' — `src/app/api/sync/route.ts`).
- **NE** gredo v vrsto: plačila (denar zahteva strežniški FURS tok), fiskalna
  izdaja, popusti, mize — namerno (denar/transakcije niso replajabilne brez
  strežniške resnice).
- Persistenca: localStorage preživi ponovni zagon brskalnika/PWA; vrsta je
  VEZANA na napravo (device id v `ro_device_id`), ne na uporabnika.

## 3. Dead-letter (issue #3 §A, P0)

- Neuspešen poskus → `attempts += 1` (+ zadnja napaka, ≤200 znakov).
- **10 neuspelih poskusih → status `dead`** (NE izbris!): operacija OSTANE v
  localStorage, flush jo PRESKOČI, prehod sproži poročilo na `POST /api/sync/drop`
  (AuditLog `SYNC_OP_DROPPED` — vidno v /api/monitoring/errors; telo vsebuje SAMO
  clientOperationId/kind/attempts/lastError, NIKOLI vsebino payload).
- Okrevanje: `resetDeadOp` (attempts=0, status='queued') — ponovni poskus;
  `clearDeadOps` — zavrzi vse mrtve; `getDeadOps` — seznam za UI (badge
  `header.netDead`, gumbi `sync.dead*`).
- Rationale: prej je vrsta po 10 poskusih operacijo TIHO izvrgla — podatkovna
  izguba brez sledi. Naprave s slabim signalom (gostilniški vrt) so to dejansko
  sprožile.

## 4. Pot okrevanja sinhronizacije

1. Omrežje se povrne → dogodek `online` (ali ponovni zagon strani — issue #3 §D)
   → `flushQueue()` pošlje VSE žive operacije na `/api/sync`.
2. Strežnik aplicira idempotentno (replay vrne obstoječe objekte — brez dvojnikov).
3. Trajno zavrnjene operacije (npr. artikel medtem umaknjen) po 10 poskusih padejo
   v dead-letter → **intervencija po runbooku** (docs/INCIDENT-RUNBOOK.md §2):
   badge → pregled → retry (resetDeadOp) ali export + zavrzi.

## 5. 401 / odjava in vrsta

- Odjava (UX) in 401 NE počistita vrste — vrsta je sredstvo NAPRAVE, ne seje.
- Po ponovni prijavi flush pošlje z novim žetonom; operacije, ki zahtevajo
  dovoljenja, se strežniško pregledajo na NOVI seji (`/api/sync` vrata:
  orders.create / kitchen.update glede na vsebino serije).
- Sprememba PIN-a / deaktivacija (sessionVersion) → stari žetoni so mrtvi, a
  vrsta ostane na napravi — naslednja PRIJAVLJENA seja jo pošlje pod svojim
  akterjem.

## 6. Referenca

- Vrsta + dead-letter: `src/lib/offline-queue.ts`; ruta poročila:
  `src/app/api/sync/drop/route.ts`
- Sync jedro: `src/app/api/sync/route.ts` (R7 idempotenca)
- Testi: `tests/race-fixes.test.ts` (R7), `tests/handheld-flow.test.ts`
  (replay pogodba), `tests/issue56-57-65-replay-scope.test.ts` (#57),
  `tests/guest-offline.test.ts` (javne površine NE), `tests/issue3-pos-readiness.test.ts`
  (dead-letter enote + ruta + source-pin flush)
