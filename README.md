# RestavrantOS

> Celovit restavrični sistem: **POS · kiosk · QR gost · dostava · fiskalizacija (FURS SI / FINA HR)** — dvojezično (SL/HR), večlokacijsko, več-najemniško.

[![CI — quality gate](https://github.com/robertpezdirc12-design/restaurantos/actions/workflows/ci.yml/badge.svg)](https://github.com/robertpezdirc12-design/restaurantos/actions/workflows/ci.yml)

## Status

| | |
|---|---|
| Produkcija | https://restaurantos-theta.vercel.app |
| Health | `/api/health` → `{"status","version","commit","database"}` |
| Deploy | Vercel **Git integration** — push na `main` → samodejni produkcijski build (~30 s) |
| CI | GitHub Actions quality gate: Neon Postgres drift-smoke + tsc/lint/cel testni suite |
| Koda | 100 % zaprta (proprietary) — vse točke zunanjih revizij zaprte, P1–P4 (gl. `docs/RESTAURANTOS-AUDIT.md` + dodatek v1.82.x) |

## Funkcije

- **POS** — odprti računi, tečaji, KDS kuhinja z 86 ploščo (razprodano + nadomestki), waiter klici, stornacija z revizijo, /handheld enoročni PWA tok (mize → naroči → fire → plačaj pri mizi, offline vrsta), plačilna povezava /pay/<token> (QR položnica: gost plača na svojem telefonu — Stripe Checkout ali simulator, FURS zaključek)
- **Kiosk** — samopostrežni terminal z vplačilom in kupončnim tiskanjem
- **QR gost** — jedilnik, naročanje, klic natakarja, feedback, položnica
- **Dostava** — naročila, dostavljalec, zone, spremljanje statusov
- **Fiskalizacija** — FURS SI (invoicing, BusinessPremise, ZOI/JIR) + FINA HR (pripravljeno na certifikat)
- **Zaloge & nabava** — odšteti ob prodaji, inventura, odpadki, dobavitelji, naročila
- **Zaposleni** — urniki, terminske kartice (timeclock), MFA, RBAC s fino razdeljenimi dovoljenji
- **Analitika** — dnevni obračun, X/Z poročila, DDV po stopnjah, tipi, darilni kuponi, billing

## Tehnološki sklad

- **Next.js 16 (App Router) + TypeScript 5** — API routes (`/api/**`), strežniška validacija
- **Tailwind CSS 4 + shadcn/ui (New York)** — odziven UI, svetla/temna tema
- **Prisma ORM** — produkcijska baza **Neon Postgres**, razvoj/testi **SQLite** (dvema sinhroniziranima shemama)
- **bun test** — 1000+ testov (enote, integracijski, race, E2E API)
- **GitHub Actions** — quality gate na vsak push na `main`

## Hitri začetek

```bash
bun install
cp .env.example .env        # DATABASE_URL=file:./db/dev.db + APP_SECRET (glej .env.example)
bun run db:push             # SQLite shema
bun run dev                 # http://localhost:3000
```

## Testiranje

```bash
bun run typecheck           # tsc --noEmit
bun run lint                # eslint
bun test                    # cel testni suite na sveži SQLite
```

Disciplina pusha: lokalno zeleno (tsc + lint + testi) → push → CI potrdi na čistem okolju.

## Deployment & rollback

- **Deploy**: push na `main` → Vercel Git integration build → produkcija. Health pokaže polni commit SHA.
- **Rollback**: Vercel dashboard → Deployments → prejšnji **READY** → **Promote**.
- **CI gate**: `neon-smoke` (shema na resničnem Postgresu; znani pending drifti dovoljeni z opozorilom — gl. `scripts/drift-check.ts`) + `tests`.
- Detajli in runbook: `docs/DEPLOYMENT-RESILIENCE.md`.

## Dokumentacija

| Dokument | Vsebina |
|---|---|
| `docs/RESTAURANTOS-AUDIT.md` | popoln audit: status, incidenti, runbooki, odprta kriticna pot |
| `docs/ARCHITECTURE.md` | arhitektura sistema in sloji |
| `docs/SECURITY-BOUNDARY.md` | varnostna meja, avtentikacija, seje |
| `docs/TENANT-ISOLATION.md` | več-najemniška izolacija (tenant guard, testi) |
| `docs/DEPLOYMENT-RESILIENCE.md` | odpornost deployev, incidenti, rollback |
| `docs/FURS-CERT-RUNBOOK.md` | namestitev FURS SI / FINA HR certifikatov (env + koraki) |

## Licenca

Zaprta koda — lastništvo in uporaba po dogovoru. Razmnoževanje in distribucija nista dovoljena.
