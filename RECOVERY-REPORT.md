# RestavrantOS — Poročilo o obnovi (Recovery Report)

> Datum: 2026-10-06 | Sestavil: Z.ai ob pomoči Vercel API
> Vzrok: hakiran GitHub račun (markec12345678) — dostop do izvornega repozitorija izgubljen

## 1. Kaj je VARNÓ ✅

| Sredstvo | Status | Kje |
|---|---|---|
| **Produkcijska baza (Postgres/Neon)** | ✅ Varno — neodvisna od GitHub | glej `vercel-env-variables.json` → `DATABASE_URL`, `NEON_PROJECT_ID` |
| **Živa aplikacija na Vercelu** | ✅ Deluje (HTTP 200) | https://restaurantos-theta.vercel.app |
| **Okoljske spremenljivke (32)** | ✅ Pridobljene iz Vercel API | `vercel-env-variables.json` (SEKRETNO!) |
| **Nastavitve projekta** | ✅ Pridobljene | `vercel-project-settings.json` |
| **Zgodovina deploymentov (15)** | ✅ Pridobljena | `vercel-deployments.json` |
| **Domena** | ✅ `restaurantos-theta.vercel.app` (verified); `restaurantos.app` + www (niverificirana) | Vercel |

## 2. Kaj MANJKA ❌

- **Izvorna koda** — Vercel ne hrani vira za git-deploymente (vseh 15 deploymentov je bilo narejenih prek GitHub integracije; zadnji: `39ca69b`, commit sporočilo "R268 #159 §14 korak 11 — COMMAND PALETTE ACTIONS…", avtor "Z User").
- **Git zgodovina** — samo na (hakiranem) GitHub računu.

## 3. Poti do izvorne kode (po prioriteti)

### A. Originalni Z.ai sandbox (NAJHITREJŠA)
Commite je ustvaril "Z User <z@container>" → projekt je bil razvit v **drugem Z.ai pogovoru/sandboxu**.
Odpri Z.ai → zgodovina pogovorov → poišči pogovor, kjer je nastajal RestavrantOS →
tam je cela koda + git zgodovina → iz njega pošlji na GitLab:
```bash
cd <projekt> && git init && git add -A && git commit -m "RestavrantOS recovery"
git remote add gitlab https://gitlab.com/robert.pezdirc12/restaurantos.git
git push gitlab main --force
```

### B. Obnovitev GitHub računa
- https://github.com/account_recovery oz. GitHub Support (račun hakiran!)
- Najprej zavaruj e-poštni račun, povezan z GitHub
- Po obnovi: preveri repozitorij `restaurantos` (repoId 1240745867), nato push na GitLab
- ⚠️ OPOMBA: na Vercelu vidim, da so bili številni projekti ponovno povezani na sumljive repozitorije
  (discord-mass-dm, gta5-mod-menu-online, spotify-playlist-downloader …) — to je znak vdora.
  PO OBNOVI GitHub dostopa na Vercelu preveri GitHub integracije in jih ponovno poveži pravilno.

### C. Ponovna izgradva od začetka (fallback)
Z.ai laho aplikacijo zgradi na novo v tem sandboxu (Next.js + Prisma + Neon baza + enaki env
spremenljivki) in jo razvrsti direktno na ta Vercel projekt prek REST API (`POST /v13/deployments`).
- Baza in podatki ostajata ista (Neon)
- Videz/strukture: rekonstruirana po živem streženem outputu (snapshot priložen)
- NI identična originalni kodi — gre za novo implementacijo istega produkta

## 4. Nujna varnostna opravila (takoj!) 🚨

1. **Vercel**: [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens) →
   razveljavi vse žetone (vključno z `vcp_...`, ki je bil deljen v klepetu)
2. **GitLab**: razveljavi žeton `glpat-...` (deljen v klepetu) → ustvari novega
3. **Neon**: zamenjaj geslo baze (`POSTGRES_PASSWORD`) — je bilo v env, ki je bil na GitHub/Vercel povezavi
4. **NextAuth**: po obnovi zamenjaj `NEXTAUTH_SECRET` (odjavi vse seje)
5. **GitHub**: ko bo račun obnovljen — 2FA, pregled SSH ključev, PAT žetonov, OAuth aplikacij

## 5. Priložene datoteke

| Datoteka | Vsebina |
|---|---|
| `vercel-env-variables.json` | ⚠️ SEKRETNO — vse 32 env spremenljivk z vrednostmi |
| `vercel-project-settings.json` | nastavitve projekta (framework, build ukaz, node verzija) |
| `vercel-deployments.json` | 15 deploymentov (UID-ji, commit-i, časi) |
| `deployed-site-snapshot.html` | snapshot žive strani (rekonstrukcijsko gradivo) |

## 6. Ključne tehnične lastnosti projekta (iz build nastavitev + env)

- **Framework**: Next.js (App Router), Node 24.x
- **Build**: prilagojen build ukaz (standalone fix), 4GB heap
- **Baza**: Neon Postgres (pooling + unpooled URL-i, Prisma URL)
- **Auth**: NextAuth (`NEXTAUTH_SECRET`)
- **Fiskalizacija**: FURS integracija (`FURS_ENVIRONMENT`, `FURS_ALLOW_SIMULATION`) 🇸🇮
- **Ostalo**: Sentry (napake), WebSocket broadcast (`WS_BROADCAST_SECRET`), cron (`CRON_SECRET`),
  računi z žetoni (`RECEIPT_TOKEN_SECRET`), previzualizacija build outputa
