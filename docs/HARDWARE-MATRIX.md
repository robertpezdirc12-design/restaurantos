# Hardware Matrix — naprave, cilji in poštenost dokazov (issue #3 §C/§E)

> **Stanje (v1.120.0):** tiskalniška pot dela prek dveh ciljev (brskalnik/agent),
> terminal ima tri POŠTENE načine (brez ponudnika), QR/kiosk/display naprave so
> registrirane. Ključna poštenost: **'sent' ≠ 'printed'** — print-agent dostavi
> bajte do tiskalnikove vtičnice in NE prebere statusa tiskalnika.

## 1. Tiskalniki

| Cilj | Transport | Kaj DOKAŽE | PrintJob status |
|---|---|---|---|
| `browser` | 80mm HTML okno + `window.print` (gonilnik/OS ali Shrani kot PDF) | dokument je IZRISAN v tiskalniško pogovorno okno | `printed` |
| `agent` | print-agent → ESC/POS **cp852** po **TCP 9100** | bajti zapisani na vtičnico BREZ napake („delivered-to-kernel“) | **`sent`** (issue #3 §C) |
| `simulator` | console.info | nič — jasno ločena simulacija | `simulated` |
| (napaka) | — | dostava/izris ni uspela | `failed` + AuditLog `PRINT_FAILED` |

Vsak poskus tiska = ENA vrstica `PrintJob` (fire-and-forget ACK na
`/api/print/ack`, issue #10) — diagnostika: `GET /api/print/jobs?status=sent`.
**Omejitev (BLOKIRANO na runbook nalogo):** agent NE izvaja DLE statusnega
anketiranja tiskalnika → 'sent' nikoli ne trdi fizičnega tiska; izpad papirja se
ne vidi v statusu. Naloga: DLE (ESC/POS `DLE EOT 1`) polling v print-agentu +
preslikava v nov potrjevalni status.

Konfiguracija: per-device localStorage (`ro_print_config` — target/host/port,
privzeto host `192.168.1.100`, port 9100); UI v Nastavitvah.

## 2. Plačilni terminal

Načini `none` / `simulator` / `manual` (localStorage `ro_terminal_config`) —
pregled pogodbe za PRAVO integracijo in profile dokazovanja:
**docs/TERMINAL-PROVIDERS.md** (nikoli ne laširaj `verified_provider`;
SIM- konvencija; timeout NI odobritev).

## 3. QR / kiosk / display naprave

| Razred | Identiteta | Preverjan |
|---|---|---|
| QR meni (miza) | javni QR žeton | `GET /api/public/menu/availability` (60/min, ETag 304 — #9) |
| Kiosk (samopostrežba) | vpisna koda (enkratna) | `/api/public/orders` + `kioskUpsell` |
| Customer display | pairing koda | `deviceRegistry` + `/api/devices/display/state` |

Dostava: 86 (razpoložljivost) se v QR/kiosku osveži v ≤30 s brez reload (polling +
visibilitychange, #9). Offline: display/kiosk NISTA offline-vrstna (dokaz
`tests/guest-offline.test.ts`) — javne povezave zahtevajo strežnik.

## 4. Print-agent namestitev (mini-services/print-agent)

- Vrata: **3031** (hardcoded per spec; bind `PRINT_AGENT_HOST`, privzeto 127.0.0.1).
- Avtentikacija: `PRINT_AGENT_TOKEN` → vsak POST zahteva glavo `x-agent-token`
  (timing-safe). **Fail-closed**: ne-lookback bind BREZ žetona = zavrne zagon.
- Dovoljeni gostje tiskalnikov: `PRINT_AGENT_ALLOWED_HOSTS` (privzeto zasebni
  razponi + `*.local`; 169.254/16 VEDNO zavrnjen; metapodatkovni IP-ji zavrnjeni
  tudi če so eksplicitno dovoljeni).
- Dovoljena vrata: `PRINT_AGENT_ALLOWED_PORTS` (privzeto `9100,9101,9102`).
- Zagon: `bun mini-services/print-agent/index.ts` na LAN napravi (npr. mini-PC
  pri blagajni); POS brskalnik kaže na `http://<host>:3031` (proxy pot
  `/layout?XTransformPort=3031` / `/label?XTransformPort=3031`).
- Logiranje: SAMO metapodatki (cilj, dolžina, čas, koda napake) — nikoli
  vsebina dokumenta, nikoli žeton.

## 5. Testni postopek po razredu naprave

| Razred | Postopek | Uspeh |
|---|---|---|
| Tiskalnik (browser) | Nastavitve → target browser → natisni račun | okno print, PrintJob `printed` |
| Tiskalnik (agent) | target agent + host/port; natisni račun + kuhinjski list + etiketo z QR | agent vrne `ok:true, note:'delivered-to-kernel'`; PrintJob **`sent`**; SL znaki ČŠŽ pravilni (cp852); rez deluje; QR berljiv |
| Tiskalnik (agent, napaka) | izklopi tiskalnik / napačen host | PrintJob `failed` + AuditLog `PRINT_FAILED` (vidno v /api/monitoring/errors) |
| Terminal (manual) | način manual → plačilo kartico | prompt za kodo; Payment.authorizationCode zapisan; audit `manual_attestation` |
| Terminal (simulator) | način simulator | koda `SIM-…`; v produkciji 402 (fail-closed) |
| QR/kiosk/display | pari napravo, spremeni 86 artikla | sprememba vidna ≤30 s brez reload |

## 6. Referenca

- Statusna poštenost: `src/lib/print.ts` (PRINT_STATUSES dokumentacija),
  `src/lib/devices/print.ts` (agent → `ackStatus: 'sent'`)
- Print-agent: `mini-services/print-agent/index.ts` (sendRaw ~:472,
  odgovor `note: 'delivered-to-kernel'` ~:680)
- Evidenca: `src/app/api/print/ack/route.ts`, `src/app/api/print/jobs/route.ts`
- Testi: `tests/print-ack.test.ts`, `tests/issue3-pos-readiness.test.ts`
