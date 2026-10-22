# ZAČASNI demo dostop (`bun run demo`)

**Različica:** v1.166.0 · **Nastanek:** 21. 10. 2026 · **Status: ZAČASNO**

> Navodilo lastnika: «nadaljuj z zasloni, najprej samo naredi demo dostop, da ne
> vpisujem gesel za testiranje — potem odstranimo in nadaljuj.»
> Dokument je zato hkrati navodilo za uporabo **in** seznam za odstranitev (§4).

## 1. Kaj dobite

```bash
bun run demo            # zaden 3000; --port 3001, --days 7, --reset
```

Ukaz naredi tri stvari:

1. ustvari **lastno** bazo `prisma/db/demo.db` (mapa `prisma/db/` je gitignirana);
2. naloži demo podatke: lokacija, meni s ~30 artikli, postaji Kuhinja in Šank,
   mize v tlorisu, naročila, stara 2 / 8 / 20 / 35 minut (vse barve KDS ure);
3. zažene dev strežnik na `http://localhost:3000` z **odprtim demo vstopom**,
   pripetim na `admin@restaurantos.app`, z **rokom 14 dni**.

Prijava: odprite naslov in na uvodnem zaslonu kliknite **«Prijava v demo»**.
E-pošte in PIN-a ni treba vpisovati; seja je v piškotku, zato so `/dashboard`,
`/dashboard?view=kds`, `/handheld` in tloris dosegljivi z neposredno potjo.
Nadzorni PIN za potrdila (npr. storno) je `1234`.

## 2. Kaj demo profil NAMENOMA ne naredi

| Meja | Zakaj |
|---|---|
| Ne dotakne se `prisma/db/dev.db` | to je testna baza, skup z njo je en sam izvajalec (pravilo P-10); demo ima svoj `demo.db` |
| Ne odpre vrat v izdanem lokalnem profilu | `bun run local` ostane `DEMO_LOGIN_ENABLED=0`, ker posluša na `0.0.0.0` in je viden celemu omrežju; varuje ga `tests/v166-demo-access.test.ts` D6 |
| Nikoli nima neomejenih vrat | `demoEnv()` vedno zapiše `DEMO_LOGIN_EXPIRES_AT`; `--days 0` ali negativno je zavrnjen (D3) |
| Ne obide MFA | `demoGate()` pripeti račun zavrne, če ima MFA (issue #7 / v1.148.0) |
| Ne piše v oblačno bazo | Neon je do 1. 11. 2026 pavžiran; `DATABASE_URL` je lahko samo `file:` (D4) |

Vsak vstop se zabeleži v revizijski zapis z opombo `DEMO_LOGIN`, zato je bilo
mogoče ločiti demo sej od navadnih prijav.

## 3. Težave

| Simptom | Ukrep |
|---|---|
| `403 Demo prijava ni na voljo (pripet račun ne obstaja …)` | sejak ni tekel: `bun run demo --reset` |
| Zasloni so prazni | `--reset` znova seed-a mize in naročila |
| `Vrata so bila odprta brez roka` v logih | to ni demo profil: pokrivajo se `DEMO_LOGIN_*` iz `.env`; launcher jih vedno prepiše |
| Port 3000 je zaseden | `bun run demo --port 3001` |

## 4. Odstranitev (ko zasloni niso več delo)

1. izbriši `src/lib/demo-runtime.ts`, `scripts/demo-start.ts` in `tests/v166-demo-access.test.ts`;
2. iz `package.json` izbriši vrstico `"demo": "bun scripts/demo-start.ts"`;
3. izbriši ta dokument;
4. po želji izbriši bazo: `rm -rf prisma/db/demo.db*`;
5. zaženi `bun test tests/auth-demo-login.test.ts` — obstoječi testi G0.x/G1.x
   ostanejo veljavni, ker demo **vrata** (`/api/auth/demo-login`) niso del
   odstranitve; odstranjen je samo **zagon** z odprtimi vrati;
6. `bun run typecheck` (manjkajoči uvoz bi sicer ostal v `scripts/`).

Če bi hoteli ukiniti tudi vrata, je to posebej potrjen poseg v `main` — glej
`docs/AUDIT-VARNOST.md` issue #7.
