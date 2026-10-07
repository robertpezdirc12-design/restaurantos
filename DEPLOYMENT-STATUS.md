# RestavrantOS — status obnovitve (2026-10-06)

## ✅ PAT C DOKONČAN — aplikacija obnovljena in živa

**Živa stran:** https://restaurantos-theta.vercel.app (produkcija, prava Neon baza)

### Kaj je bilo obnovljeno
1. **Izvorna koda** (edino, kar je manjkalo — DB, env, nastavitve so preživeli):
   - Next.js 16 App Router aplikacija (UI: prijava, pregled, mize, naročila, kuhinja KDS, meni, zaposleni, nastavitve)
   - 35+ API rut na **točni produkcijski shemi** (110 modelov, 20 enumov — prisma db pull iz Neon)
   - FURS potek: Check → Payment → Receipt (ZOI/EOR, simulacija kot v originalu — FURS_ALLOW_SIMULATION=true)
   - Mapper sloj (UI ↔ produkcijska polja), auth (PIN scrypt + pinLookup HMAC + bootstrap)
2. **GitLab:** robert.pezdirc12/restaurantos — branch `main` = **celotna koda + recovery arhiv** (finalna konsolidacija), branch `reconstruction` = zgodovinska Kopija kode
3. **Deploy na Vercel:** projekt `restaurantos` (isti kot original), produkcija, env podedovan

### Živa verifikacija (agent-browser)
- /api/health: `ok, database: connected`
- Originalna lokacija `RestaurantOS Ljubljana` (cmqih3e9e000aay5xf0nq6poh) ✓
- 15 miz po conah (bar/main/patio/private), 437 artiklov, 39 kategorij, 8 zaposlenih ✓
- Današnji promet 16,87 € — realni podatki tečejo skozi obnovljeno aplikacijo ✓
- Meni: originalne kategorije ("Penine in Šampanjci", "Hladne predjedi", "Bela Vina"...) ✓

### Prijava (trajna — bootstrap umaknjen, 2026-10-07)
- **Prijava:** info@restaurantos.app / PIN 729153 → trajen ADMIN profil **Robert Pezdirc** v bazi (12-urni token).
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PIN` env sta **izbrisana** s Vercela (deploy dpl_4FkPjoW4u9CSiKG2JDbe68pmSYH2) — fallback prijava ni več mogoča.
- Vaja PIN-ov v UI: Zaposleni tab med bootstrap sejo prikaže opozorilo (ustvarjanje profila / reset PIN-a v Control Centerju, gumb za naključni PIN). Zaposlenim nastavi PIN v Control Centerju (Zaposleni → klikni profil → Ponastavi PIN); vsak reset poveča `sessionVersion` in se zapiše v revijo.
- Originalni zaposleni (ana@restaurant.com, eva@restaurant.com, ...) imajo še PIN-e v stari, neznani shemi → prijava zanje, dokler jim admin ne nastavi novega PIN-a, ni mogoča (namerno).

### 🔴 Varnost (NUJNO)
1. **Rotiraj Vercel token** (vcp_...— bil v klepetu)
2. **Rotiraj GitLab token** (glpat-...— bil v klepetu)
3. **Rotiraj Neon credentiale** (DATABASE_URL gesla) + NEXTAUTH_SECRET
4. Nadaljuj obnovitev GitHub računa (markec12345678)
5. Preveri na Vercelu sumljive repozitorije (discord-mass-dm, gta5-mod-menu-online, spotify-playlist-downloader)
