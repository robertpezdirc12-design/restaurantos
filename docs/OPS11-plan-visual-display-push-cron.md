# OPS-11 Plan — Front-of-house vizual + Display urnik + Push AP + Vercel cron (P3 iz OPS-10)

Baza: v1.79.0 @ 4c94176 | 966/966 testov | zero DDL | i18n SL/HR pariteta

## Vhodi (inventar potrjen)

- Kiosk rendra slike SAMO v upsell traku (h-16, l.379-381); glavni meni grid + QR /m/[token] BREZ slik (API image že vrača)
- KDS_DELAY_THRESHOLD_MIN=10 fiksno (kds-delays.ts:17) — prag ne upošteva PrepStation.avgPrepTime
- display-promos: brez startDate/endDate urnika (research T5: kampanje od/do = standard)
- PUSH_EVENT_TYPES: 12 tipov, ni AP_NEW (eSLOG import obstaja, push ne)
- NO vercel.json — recurring/digest = lazy-only (mount trigger); pravi cron manjka

## Val 1 — VIZUAL + KDS PRAG (v1.80.0)

| # | Funkcija | Izvedba |
|---|----------|---------|
| 1.1 | Kiosk glavni meni slike | item card: 80×80 rounded thumb levo (object-cover, lazy, fallback če ni slike = trenutni tile) — grid enakomernost ohranjena; sla slik: bg-stone-700 |
| 1.2 | QR /m/[token] slike | isti thumb vzorec na QR meni artiklih (guest stran, tolerant) |
| 1.3 | KDS delay prag per postaja | kds-delays.ts: `delayThresholdForTarget(target)` = max(10, ceil(target×1.25)) (fallback 10); kitchen route bump + live timer UI rabi postajo artikla (MenuItem.prepStationId→PrepStation.avgPrepTime, stationOf bucket) — če postaja ni, 10 |

## Val 2 — DISPLAY URNIK + AP PUSH (v1.81.0)

| # | Funkcija | Izvedba (zero DDL) |
|---|----------|-------------------|
| 2.1 | Display urnik kampanj | DisplayPromo + startDate/endDate (ISO 'YYYY-MM-DD', opcionalno); activeAds(ads, now) filtrira okno (vključno); sanitizePromos validira format; Nastavitve kartica + date inputa; display state nespremenjen ( že filtrira) |
| 2.2 | AP_NEW push | PUSH_EVENT_TYPES + 'AP_NEW' (matrika rendra avtomatsko); import-eslog: void pushEvent('AP_NEW', {apNumber, supplierName, amount, dueDate}) fire-and-forget; tudi ročni AP create če obstaja route |

## Val 3 — VERCEL CRON + AP OPOMNIKI (v1.82.0)

| # | Funkcija | Izvedba (zero DDL) |
|---|----------|-------------------|
| 3.1 | /api/cron/daily | GET: auth Bearer CRON_SECRET (env; fallback admin session za dev) → (a) zaženi due recurring pravila (reuse run-recurring core, extract čista f-ja iz route), (b) sestavi+pošlji digest email (daily-email, recurringToday že obstaja), (c) zapadle AP (open, dueDate<today): sekcija v digestu + push AP_OVERDUE (nov tip); audit CRON_DAILY_RAN {steps} |
| 3.2 | vercel.json | crons: [{path:"/api/cron/daily", schedule:"0 5 * * *"}] (05:00 UTC = 06:00 CET/07:00 CEST); produkcija brez ročnih korakov |
| 3.3 | AP_OVERDUE push | PUSH_EVENT_TYPES + 'AP_OVERDUE'; samo iz cron poti (1×/dan, ni spama) |

## Pravila (nespremenjena iz OPS-8/9/10)

- ZERO DDL; Integration config JSON.stringify + tolerantno branje; Radix Select 'ALL'/'NONE' sentinel (nikoli value='')
- i18n ključi v OBAH slovarjih; komentarji angleško; pushEvent fire-and-forget void
- version bump minor v src/lib/version.ts; testi za čisto logiko v tests/ops11-valN.test.ts; `bun test` vse zeleno + tsc 0 + lint 0
- Commit avtor robertpezdirc12-design; push `git push github`; browser E2E po vsakem valu (dev PIN 4567, produkcija [PIN ODSTRANJEN — ROTACIJA OBVEZNA])
