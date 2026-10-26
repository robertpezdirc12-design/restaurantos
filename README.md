# RestaurantOS

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

## Prijava in obnova administratorskega dostopa

- Privzeti računi iz `prisma/seed.ts` veljajo samo za podatkovno bazo, na kateri je bil seed dejansko izveden; niso zagotovljeni na Vercel/Neon okolju.
- Za lokalni razvoj najprej izvedi `bun run db:seed` po `bun run db:push`.
- Za izgubljen dostop na Vercelu uporabi začasna `BOOTSTRAP_ADMIN_EMAIL` in `BOOTSTRAP_ADMIN_PIN` iz `.env.example` samo v ustreznem okolju, prijavi se, nato v zavihku **Zaposleni** ustvari ali obnovi trajni račun. Takoj zatem odstrani obe bootstrap spremenljivki in ponovno sproži deployment. Ne uporabljaj demo PIN-a kot produkcijskega gesla.

## Funkcije

- **POS** — odprti računi, tečaji, KDS kuhinja z 86 ploščo (razprodano + nadomestki), waiter klici, stornacija z revizijo, /handheld enoročni PWA tok (mize → naroči → fire → plačaj pri mizi, offline vrsta), plačilna povezava /pay/<token> (QR položnica: gost plača na svojem telefonu — Stripe Checkout ali simulator, FURS zaključek); javne strani v SL/HR/EN (P1-5: QR meni, kiosk, display, plačilo — angleški turist samodejno vidi EN, API napake prevedene)
- **Kiosk** — samopostrežni terminal z vplačilom in kupončnim tiskanjem
- **QR gost** — jedilnik, naročanje, klic natakarja, feedback, položnica
- **Dostava** — naročila, dostavljalec, zone, spremljanje statusov
- **Fiskalizacija** — FURS SI (invoicing, BusinessPremise, ZOI/JIR) + FINA HR (pripravljeno na certifikat)
- **Zaloge & nabava** — odšteti ob prodaji, inventura, odpadki, dobavitelji, naročila
- **Zaposleni** — urniki, terminske kartice (timeclock), MFA, RBAC s fino razdeljenimi dovoljenji (fail-closed: terminalni statusi naročil, prazna dovoljenja ne odprejo panelov, plačilo samo prek kanonične fiskalne poti)
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
bun run db:seed             # začetni lokalni demo podatki in testni računi
bun run dev                 # http://localhost:3000
```

## Lokalna namestitev — brez oblaka (v1.165.0)

RestaurantOS se lahko v obratu zažene z lokalno bazo SQLite, brez Neon računa in
brez ročnega urejanja `.env`:

```bash
bun install
bun run local               # prvi zagon pripravi bazo, zgradi in zažene aplikacijo
```

- Baza in skrivnosti nastaneta v podatkovni mapi **zunaj repozitorija**
  (`%LOCALAPPDATA%\RestaurantOS` na Windows, `~/Library/Application Support/RestaurantOS`
  na macOS, `$XDG_DATA_HOME/restaurantos` na Linuxu); pot prepiše `RESTAURANTOS_DATA_DIR`.
- Prvi zagon ustvari lastnika z naključnim 6-mestnim PIN-om; poverilnice zapiše v
  `PRVIC-ZAGON.txt` (datoteki sta berljivi samo lastniku računa — `0600` na
  macOS/Linux, NTFS ACL na Windows). Demo računi iz `prisma/seed.ts` se **ne** naložijo.
- Ponovni zagon ohrani bazo in skrivnosti; pred vsako posodobitvijo sheme nastane
  kopija v `backups/pre-push-*.db`.
- Aplikacija posluša na `0.0.0.0`, zato jo terminali v istem omrežju odprejo na
  izpisanem naslovu `http://<IP>:3000`.

**Vercel ne vidi lokalne baze.** To sta dva profila iste kode: lokalni
(`DATABASE_URL=file:...`) in oblačni (`postgresql://...`). Omejitve R1 (HTTP v
lokalnem omrežju, ročne kopije, brez čarovnika) in vrstni red izdaj R2–R5 so v
`docs/PRD-LOKALNA-BAZA.md`; operativni runbook je `docs/LOKALNI-ZAGON.md`.

## Testiranje

```bash
bun run typecheck           # tsc --noEmit
bun run lint                # eslint
bun run test                # cel testni suite na sveži SQLite (--timeout 20000)
```

`bun run test` in ne `bun test`: privzeti 5 s proračun na klic je premalo za
`beforeAll`/`afterAll` hooke, ker ~135 testnih datotek čisti svoje fiksature
prek ENega SQLite dokumenata in sočasnost (20 datotek) vsak DELETE postavi v
vrsto za zapis. Proračun je zato en sam vir v `package.json`, CI (GitHub in
GitLab) pa uporabita isti ukaz (v1.148.0).

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
| `docs/PRD-LOKALNA-BAZA.md` | lokalna baza: zahteve, merila sprejema, izdaje R1–R5 |
| `docs/LOKALNI-ZAGON.md` | runbook lokalne namestitve (zagon, kopije, odpravljanje težav) |
| `docs/FURS-CERT-RUNBOOK.md` | namestitev FURS SI / FINA HR certifikatov (env + koraki) |

## Licenca

Zaprta koda — lastništvo in uporaba po dogovoru. Razmnoževanje in distribucija nista dovoljena.
