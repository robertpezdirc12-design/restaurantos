# RestavrantOS — status obnovitve (2026-10-06)

## ✅ PAT C DOKONČAN — aplikacija obnovljena in živa

**Živa stran:** https://restaurantos-theta.vercel.app (produkcija, prava Neon baza)

### Kaj je bilo obnovljeno
1. **Izvorna koda** (edino, kar je manjkalo — DB, env, nastavitve so preživeli):
   - Next.js 16 App Router aplikacija (UI: prijava, pregled, mize, naročila, kuhinja KDS, meni, zaposleni, nastavitve)
   - 35+ API rut na **točni produkcijski shemi** (110 modelov, 20 enumov — prisma db pull iz Neon)
   - FURS potek: Check → Payment → Receipt (ZOI/EOR, simulacija kot v originalu — FURS_ALLOW_SIMULATION=true)
   - Mapper sloj (UI ↔ produkcijska polja), auth (PIN scrypt + pinLookup HMAC + bootstrap)
2. **GitLab:** robert.pezdirc12/restaurantos — branch `reconstruction` (celotna koda), branch `main` (arhiv)
3. **Deploy na Vercel:** projekt `restaurantos` (isti kot original), produkcija, env podedovan

### Živa verifikacija (agent-browser)
- /api/health: `ok, database: connected`
- Originalna lokacija `RestaurantOS Ljubljana` (cmqih3e9e000aay5xf0nq6poh) ✓
- 15 miz po conah (bar/main/patio/private), 437 artiklov, 39 kategorij, 8 zaposlenih ✓
- Današnji promet 16,87 € — realni podatki tečejo skozi obnovljeno aplikacijo ✓
- Meni: originalne kategorije ("Penine in Šampanjci", "Hladne predjedi", "Bela Vina"...) ✓

### Prijava (bootstrap)
Originalni PIN-i zaposlenih so bili v neznani originalni shemi → na Vercel sta dodana:
- `BOOTSTRAP_ADMIN_EMAIL` = info@restaurantos.app
- `BOOTSTRAP_ADMIN_PIN` = (vrednost v poklonjenem sporočilu; zapiši si jo!)
Prijava s tema podatkom da 2-urni token z vlogo po bazi. Ko nastaviš PIN-e zaposlenim
(`POST /api/employees` kot ADMIN, polja email/name/pin/role), env odstrani.

### 🔴 Varnost (NUJNO)
1. **Rotiraj Vercel token** (vcp_...— bil v klepetu)
2. **Rotiraj GitLab token** (glpat-...— bil v klepetu)
3. **Rotiraj Neon credentiale** (DATABASE_URL gesla) + NEXTAUTH_SECRET
4. Nadaljuj obnovitev GitHub računa (markec12345678)
5. Preveri na Vercelu sumljive repozitorije (discord-mass-dm, gta5-mod-menu-online, spotify-playlist-downloader)
