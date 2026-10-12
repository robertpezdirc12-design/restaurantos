# OPS-10 Plan — Analitika + Front-of-house + Nabava (P2/P3 iz OPS-9)

Baza: v1.76.0 @ 8b21ef1 | 892/892 testov | zero DDL konvencija | i18n SL/HR pariteta

## Vhodi

- **OPS-10-a inventar** (agent Explore): vsi podatki že v DB — Order.paidAt/createdAt, TimeEntry.totalPay/totalMinutes + payRate snapshot, PrepStation.avgPrepTime (neuporabljen!), MenuItem.image (API vrača, kiosk ne rendra). BatchPreparation = schema-only (brez API/UI). eSLOG priloga: brez attachment polja (zero-DDL: Integration config base64, praktična meja). Push matrika ima 12 tipov.
- **OPS-10-b research** (agent web): Toast/Lightspeed/Square best practices — labor% = Σpunch×wage/netSales (benchmark 25–35 %); sales-by-hour 1h granularnost MVP (Toast dela 15-min, Lightspeed gross+orders+covers per uro); KDS 3-barvna lestvica (zelena <100 % targeta, rumena 100–125 %, rdeča >125 %; tipični targeti: grill ~8, bar ~5, cold ~4 min); kiosk upsell dvigne AOV 10–30 % (1–3 predlogi per artikel, en tap); display promo carousel 15 s rotacijo v idle; **eSLOG hramba = 10 let (ZDavP-2), ne 8**; priloga = `cac:Attachment/cbc:EmbeddedDocumentBinaryObject` (base64 PDF v XML); recurring reminder = banner + digest email, NE cron; batch prep = BOM flattenDeduction × plannedQty, napoved = povprečje zadnjih 4 istih dni tedna.

## Val 1 — ANALITIKA (v1.77.0)

| # | Funkcija | Izvedba (zero DDL) |
|---|----------|-------------------|
| 1.1 | Sales-by-hour heatmap | `src/lib/sales-by-hour.ts` (čista f-ja: bucketi hour 0–23 × dan; metriki revenue/covers/avgCheck iz Order.paidAt, paid=true; kvantili 5 razredov) + `GET /api/reports/sales-by-hour?days=7` + section=sbh v /api/reports/export (CSV) + UI kartica "Prodaja po urah" v Pregledu (recharts že uvožen — bar/heatmap tabela) |
| 1.2 | Labor cost % | `src/lib/labor-cost.ts` (laborByDay: Σ TimeEntry.totalPay per dan; laborPct = totalPay/netSales×100; per-vloga prek jobId→Job.name; overtime min prek type='overtime') + `GET /api/reports/labor-cost?days=7` + UI kartica "Labor stroški" v Pregledu (dan %: labor€, net sales, labor %, target 32 % default barvno) |
| 1.3 | KDS per-postaja targeti | kds-stats.ts: target iz PrepStation.avgPrepTime (BAR default 5, KITCHEN 10 fallback); per-station razčlenba v /api/kitchen/stats (count/avg/min/max/onTime vs target); 3-barvno kodiranje (100 %/125 % pragov); UI: razčlenba v "Statistika priprave" + urejanje targetov per postaja (mala input vrsta) |

## Val 2 — FRONT-OF-HOUSE (v1.78.0)

| # | Funkcija | Izvedba (zero DDL) |
|---|----------|-------------------|
| 2.1 | Kiosk upsell | Integration config `kiosk-upsell` `{[menuItemId]: string[]}` (1–3 predlogi); razširitev `/api/public/menu` odgovora z `upsells` (samo dostopne artikle); kiosk UI: košarica "Dodaj še…" kartica z enim tapom; konfiguracija v Meni tabu (per-artikel dialog izbira predlogov) |
| 2.2 | /display promocije | Integration config `display-promos` `{ads:[{imageUrl, durationSec, active}]}`; `/api/devices/display/state` vrača `promos` v idle stanju (back-compat: opcionalni ključ); display page: carousel rotacija prek ConfigurableInterval; konfiguracija v Nastavitvah (dodaj/odstrani sliko URL, trajanje, aktivno) |

## Val 3 — NABAVA + BATCH (v1.79.0)

| # | Funkcija | Izvedba (zero DDL) |
|---|----------|-------------------|
| 3.1 | eSLOG priloga | eslog.ts: tolerantno izlušči `cac:Attachment/cbc:EmbeddedDocumentBinaryObject` (base64 + mimeCode; če manjka → brez priloge, ne faila); shrani v Integration config `ap-attachments` `{apNumber: {mime, filename, dataBase64, savedAt}}` (meja ~1.5 MB b64; večje → samo metapodatki + opomba); UI Računi tab: badge "priloga" + dialog "Poglej prilogo" (PDF inline / download); dokumentiraj 10 let hrambe (ZDavP-2) |
| 3.2 | Recurring reminder | pravilo `remindMinutesBefore` (default 60); GET /api/recurring-po vrača `upcoming` (due v <X min); banner v Nabava tab: "Zapade ob HH:MM (čez ~1 h) — Zaženi zdaj"; dnevni digest email (daily-email.ts): nova sekcija "Naročilnice za zagon danes" (pravila due danes) |
| 3.3 | BatchPreparation | `GET/POST /api/batch-preparations` (create DRAFT+lines; complete: input StockTransaction −, output +, outputCostPerUnit=totalInputCost/outputQuantity, FEFO serije; cancel) + UI kartica "Priprava po serijah" v Zalogah (napoved = avg prodaja zadnjih 4 istih dni tedna; stanja DRAFT→COMPLETED/CANCELLED; odštevanje prek flattenDeduction BOM kernela) |

## Implementacijska pravila (iz OPS-8/9)

- ZERO DDL — brez schema.prisma sprememb; persistenca prek Integration config (JSON.stringify, tolerantno branje jparse)
- Radix Select: nikoli value="" — uporabi 'ALL' ali 'NONE' sentinel
- i18n: novi ključi v OBAH slovarjih (sl.ts + hr.ts); komentarji v kodi angleško
- pushEvent vedno fire-and-forget `void pushEvent(...)`
- version bump: minor +1 v src/lib/version.ts; client uvaža iz @/lib/version
- Testi: nova čista logika → tests/ops10-*.test.ts; cilj ≥900 skupaj; `bun test`, tsc 0, lint 0
- Commit avtor: robertpezdirc12-design <249648337+robertpezdirc12-design@users.noreply.github.com>; push: `git push github`
- E2E po vsakem valu: login vodja@ (dev PIN 4567) → preveri nove kartice → 0 console errors
