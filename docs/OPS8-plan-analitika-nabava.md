# OPS-8 — Raziskava runda 2 + načrt nadgradenj (nabava, analitika, DURS, push)

Vir: OPS-8-a (inventar kode) + OPS-8-b (spletna raziskava: Lightspeed K/O-Series, Loyverse, MarketMan,
MenuSpy, POSMena, RoxPos, 7shifts, ddv.inetis.com, FURS seznami). Detailni viri v worklog.md (OPS-8-b).

## 1. Ugotovljene vrzeli (inventar v1.70.0)

| Območje | Stanje | Vzelka |
|---|---|---|
| Nabava | PO/GRN/Supplier/Stocktake/Waste/Recipe DELUJE | ReorderRule mrtav, ni predlogov, AP most prazen, brez nizke-zaloge push |
| Menu engineering | **NE OBSTAJA** (recharts instaliran, 0 uvozov, 0 grafov) | Kvadrant popularnost×CM manjka |
| KDS prep-time | firedAt+readyAt obstajata; ni agregacije | Ni avg/min/max per artikel, heatmap, on-time % |
| DURS | **NIČ** | Preverjanje DDV zavezancev (Supplier, Nastavitve) |
| Push | 2 dogodka (novo naročilo, vse pripravljeno) | Ni matrike (RoxPos), ni fire/dostava/rezervacije/PO/urnik/low-stock |
| Analitika | Tabelarno, brez grafov/trendov | Ni X/Z poslovnega poročila, covers, primerjav |
| Rezervacije | Delovno, tanko | UI ne izpostavi tableId/source/email, ni NO_SHOW gumba |
| Dostava | Polna vertikala | Voznik = prosti tekst (driverEmployeeId neuporabljen) |
| GL | Modeli JournalEntry/JournalLine/ChartOfAccount neuporabljeni | Ni dnevnega obračuna |

## 2. Best-practice pravila (iz raziskave)

- **Menu engineering (Kasavana-Smith)**: osi = POPULARNOST × CM (NI food cost %); CM = cena − strošek
  sestavin (RecipeItem × costPerUnit); pragi = povprečje ZNOTRAJ kategorije; obdobje 30/60/90 dni;
  kvadranti: Stars (zaščiti) / Plowhorses (dvigni ceno) / Puzzles (promocij) / Dogs (86).
- **KDS statistika (Lightspeed KDS 2.0)**: per artikel — št. izdelanih, avg/min/max prep; heatmap po
  30-min intervalih; on-time % (eskalacija 5/10 min = prag); live avg fulfillment (Toast pattern).
- **Nizka zaloga (RoxPos)**: push ENKRAT per artikel; re-arm šele ob prilivu (PO/prevzem/inventura);
  več artiklov = eno skupinsko obvestilo; server-side filtriranje prek matrike.
- **Notifikacijska matrika (RoxPos)**: tip × {Everyone | Selected roles | Off}; brez pravila = privzeto
  vedenje; permission-aware.
- **DURS**: `GET https://ddv.inetis.com/iskalnik3.aspx?isci=<davčna|naziv|matična|TRR>` (brez ključa;
  200+[] ni zadetkov; 400 <3 znaki; 429 preveč) → { DavcnaStevilka, Naziv, ZavezanecZaDDV, TRR[] };
  vir FURS (dnevno). Fallback: dnevni FURS CSV ZIP seznami zavezancev.
- **Reorder (Lightspeed)**: predlog = PAR − zaloga − incoming (odprti PO); PAR = reorderPoint || minQty;
  grupiranje po dobavitelju → "Ustvari PO".
- **X/Z (Lightspeed Business Report)**: gross, net takings, DDV po stopnjah, plačila, popusti, storna,
  kalo, covers, avg check, avg party size + primerjava s prejšnjim obdobjem.
- **PO→AP**: ob prevzemu (GRN) nastane AccountsPayable (zapadlost = paymentTerms dni dobavitelja).

## 3. Valovi implementacije (ZERO DDL — vse prek obstoječih modelov + Integration.config JSON)

### VAL 1 → v1.71.0 — ANALITIKA
1. `GET /api/menu-engineering?days=30|60|90` → per menuItem: kategorija, qtySold (ne-voided postavke
   plačanih naročil v obdobju), prihodek, cost (RecipeItem×costPerUnit; fallback costPerServing; sicer
   costKnown=false), CM, FC%, popularnost %, kvadrant (pragi = povprečji kategorije), akcija.
2. Tab `inzeniring` (reports.view): recharts ScatterChart (x=popularnost %, y=CM, barva kvadranta,
   referenčni črti = pragi) + tabela z badge-i + CSV izvoz + opomba o kakovosti podatkov.
3. `GET /api/kitchen/stats?days=7|14|30&station=` → per artikel avg/min/max/št.; bucketi 30 min
   (heatmap); on-time % (≤5 ok, 5–10 opoz., >10 pozno); danes avg fulfillment.
4. Kuhinja tab: sekcija "Statistika" (KPI + tabela + heatmap + CSV).
5. APP_VERSION 1.71.0; i18n SL/HR; testi za matematiko.

### VAL 2 → v1.72.0 — NABAVA + PUSH + DURS
1. Notifikacijska matrika: Integration (name='notification-rules') config JSON
   {rules: {EVENT: {mode:'everyone'|'roles'|'off', roles:[]}}}; helper v lib/push.ts — server-side
   filtriranje; privzeto brez pravila = obstoječe vedenje. UI: Nastavitve → kartica "Obvestila"
   (settings.manage).
2. Novi hooki (fire-and-forget prek matrike): ORDER_FIRE, DELIVERY_NEW (webhook), RESERVATION_NEW,
   LOW_STOCK, PO_APPROVED, PO_RECEIVED, TIME_OFF_STATUS, RECEIPT_FAILED (FURS), Z_CLOSED.
3. Nizka zaloga: ob odštevu če qty ≤ (reorderPoint||minQty) → stanje v Integration 'low-stock-state'
   {itemId: lastAlertedAt}; re-arm ob prilivu (StockTransaction type purchase/count-adjust po
   lastAlertedAt); grupirano eno obvestilo → manager+warehouse (prek matrike).
4. DURS: `GET /api/durs/check?q=` (proxy ddv.inetis.com, timeout 6s, in-memory cache 24h, 429/400
   mapiranje); UI gumb "Preveri DDV" v dobavitelju + nastavitvah → badge Zavezanec ✓ + auto-naziv.
5. Predlogi naročil: `GET /api/purchase-orders/suggestions` (PAR − zaloga − incoming po odprtem PO,
   grupirano po dobavitelju prek SupplierItem) + kartica v NabavaTab "Predlogi za naročilo" →
   "Ustvari PO" predfila obstoječ kreator.
6. AP most: ob GRN prevzemu ustvari AccountsPayable (apNumber AP-YYYY-NNNN, dueDate = paymentTerms,
   vrstice iz PO postavk; idempotentno per GRN).
7. InventoryBatch UI: kartica "Serije / rok uporabe" (FEFO seznam, badge "poteče ≤7 dni").
8. APP_VERSION 1.72.0; i18n; testi (rules resolvar, sugestije, DURS parse, AP).

### VAL 3 → v1.73.0 — POROČILA + UI DOPOLNITVE
1. `GET /api/reports/export?section=zz&from&to` → X/Z poslovno poročilo: gross/net, DDV po stopnjah,
   plačila, popusti, storna, kalo vrednost, covers, avg check, avg party size + primerjava s prejšnjim
   enakim obdobjem (%). UI: AccountingExportCard opcija + predogled dialog.
2. Dnevni summary email ob zaključku izmene (SMTP obstoječi; ScheduledEmailLog zapis; fire-and-forget).
3. Rezervacije: dialog + miza (select), vir, e-pošta, trajanje, posebne zahteve; NO_SHOW gumb; filtri
   statusov; dnevno grupiranje.
4. Dostava: voznik = dropdown zaposlenih (driverEmployeeId) prikaz imena v zgodovini.
5. GL dnevnik: ChartOfAccount seed (SI konti: 101, 204, 221, 401, 402) + `GET /api/reports/gl?from&to`
   → dnevni JournalEntry (debit 101 gotovina / 204 kartice, kredit 401 neto + 221 DDV), idempotentno
   per dan; UI: branje v racunovodskem predelu ("orientacijsko, ne nadomešča knjigovodje").
6. APP_VERSION 1.73.0; i18n; testi.

## 4. Pravila za implementacijo
- ZERO DDL (ni sprememb schema.prisma) → produkcijska DB takoj kompatibilna.
- dashboard-tabs.tsx je 6281 vrstic — Grep + ciljna branja, ne celotno branje.
- i18n: src/lib/i18n/{sl,hr}.ts — pariteta obvezna (regresijski test lovi tudi komentarje!).
- Testi: bun test 761/761 mora ostati zeleno; dodaj enote za matematiko.
- Bunx tsc --noEmit + bun run lint = 0 napak pred commitom.
- Commit avtor: robertpezdirc12-design <249648337+robertpezdirc12-design@users.noreply.github.com>.
