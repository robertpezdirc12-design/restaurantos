# Primerjava vmesnikov z najboljšimi POS programi + načrt izboljšav (OPS-7)

Datum: v1.67.0 → načrt za v1.68.0–1.70.0. Viri: spletna raziskava (Toast, Lightspeed K-Series,
Square for Restaurants, Loyverse, Sapaad, Restroworks, Eats365, 7shifts, OpenTable) +
inventar lastnih UI tokov (Explore agent, celoten popis dashboarda /tablica KDS plačilnih dialogov).

---

## 1. Najboljše prakse iz raziskave (kaj imajo najboljši)

### Toast POS (vodilni v ZDA)
- **Klik na mizo → urejevalnik naročila** (NE plačilo): postavke, +dodaj, seat/kursi, fire,
  move/merge, popusti, plačaj kot AKCIJE znotraj pogleda naročila.
- **Split check**: by seat, by item, split evenly — vsak check je neodvisen plačilni entitet
  (lasten račun, lastno plačilo). Check = "izstavek".
- **Coursing**: Fire vse / Fire tečaj (appetizers → mains → desserts), KDS vidi tečaje.

### Lightspeed K-Series
- **Order Anywhere** (tablica): mize → naročilo → tečaji → tisk per postaja (kuhinja/bar ločeno).
- **KDS**: barvne kartice po starosti, filtri postaj, bump (zapotrdi/serviraj) per postavka ALI
  cela kartica, prikaz prep-time.
- **Otvoritev/zaključek blagajne (izmena)** z X/Z poročilom na koncu — Z poročilo se POKAŽE.

### Square for Restaurants
- **Floor plan** s tlorisom, klik na mizo → order editor, seat management.
- **KDS**: bump cela kartica, izloči served iz vrste.

### 7shifts (urnik)
- Teden grid (dnevi × zaposleni), klik na celico → nov shift (vloga, ura, break),
  drag/duplikat, zahteve za prostost (time-off) z odobritvijo, potrditev shifta s strani delavca.

### OpenTable / rezervacije
- Avtomatski e-mail/SMS opomniki X ur pred prihodom (configurable), status poslane pošte na rezervaciji.

### KDS skupne prakse (Restroworks/Sapaad/Eats365)
- Barvna eskalacija po starosti, zvok, postaje, prep-time statistika, bump.

---

## 2. Naše stanje (v1.67.0) — kaj je, kaj manjka

| Vmesnik | Ima | Manjka (vrzel) |
|---|---|---|
| Mize | grid, tloris (drag), QR, statusi | klik na zasedeno mizo gre NAROJKO v plačilo — manjka urejevalnik naročila (add/fire/move/merge/split) |
| Plačilni dialog | split-evenly parts (2–5), darilne, zvestoba, FURS | split po postavkah/izstavnih (Check) |
| KDS | filtri postaj, zvok, časovniki, 86, fullscreen, print | SERVED (bump), tečaji |
| Hitra prodaja | grid → košarica → TAKEOUT → plačilo | (popolno) |
| Izmene | otvoritev/zaključek, X/Z izračun, CSV | Z poročilo se ne pokaže po zaključku |
| Naročila | fire/move/merge | status filtri |
| Tablica PWA | mize → naroči/dodaj → pošlji, offline | (popolno) |
| Coursing | shema Course + fire endpoint | UI (dodeljevanje tečajev, fire per tečaj) |
| Urnik | shema StaffShift/TimeOffRequest | vse (API + UI) |
| Opomniki | reminderSent polja | SMTP/SMS pošiljanje, UI |
| Push | PushSubscription model, SW | web-push, VAPID, subscribe UI, dispatcher |
| Knjigovodstvo | financial + export summary CSV/JSON | dnevnik prodaje po računih, DDV po stopnjah |

**Arhitekturno ugotovljeno**: modela Check + OrderItem.checkId + Payment.checkId ŽE obstajajo
(Toast-vzor), StaffShift/TimeOffRequest/PushSubscription/Course tudi — celoten P1/P2 je
implementabilen BREZ DDL (migracije ni treba).

---

## 3. Odločene izboljšave (implementirano po valovih)

### VAL 1 — v1.68.0: NaročiloSheet + split po postavkah + coursing
1. **NaročiloSheet** (Toast vzorec): klik na zasedeno mizo → urejevalnik naročila
   (postavke + tečaji, + dodaj artikle, fire, tečaj pošlji, premakni, združi, razdeli, plačaj).
2. **Split po postavkah (Check)**: /api/orders/[id]/checks (GET/POST/DELETE),
   bill?checkId= (proporcionalni popusti, zadnji izstavek absorbira ostanek),
   POST /api/furs {checkId} (CAS per check,Receipt per check, zaloga per check items),
   UI v plačilnem dialogu.
3. **Coursing**: /api/orders/[id]/courses (dodeli postavke tečaju), fire {courseId},
   UI v Sheetu, badge na KDS.

### VAL 2 — v1.69.0: Urnik + opomniki
4. **Urnik (StaffShift)**: /api/staff-shifts + /api/time-off, tab "Urnik" (teden grid,
   dialog shifta, zahteve za prostost, odobritve; edit gate timeclock.manage).
5. **Opomniki**: nodemailer (SMTP iz RestaurantSettings — polja že obstajajo),
   SMS adapter prek Integrations (type='sms', config JSON — Twilio REST),
   /api/reservations/[id]/reminder + /run batch, UI gumbi + badge, audit RESERVATION_REMINDER.

### VAL 3 — v1.70.0: Push + knjigovodstvo + KDS/izmene/naročila
6. **Push**: web-push, VAPID (auto-generate, shranjeno v Integrations config — brez env),
   /api/push/subscribe|key|test, sw.js push handler, dispatch hooks (nova naročila → KDS,
   pripravljeno → natakar), zvonček v glavi.
7. **Knjigovodstvo**: /api/reports/export section=dnevnik (račun po račun: neto, DDV 22/9.5,
   popust, napitnina, bruto, EOR, storno) + section=ddv; UI selector v Računi.
8. **KDS**: SERVED gumb per postavka (bump), tečaj badge. **Izmene**: Z poročilo dialog
   po zaključku. **Naročila**: status filter chips.
