/**
 * v1.273.0 — DIAKRITIKE II: IZVOZNI API + TISKALNIŠKI NASLOVI
 * (nadaljevanje diakritične teme po v1.272 — ta val pokriva površino,
 *  ki je v1.272 ostala IZVEN obsega: slovarska metoda je pokrila
 *  ključe shifts.csv ter rcpt.csv in 4 backend datoteke; rekonos tega
 *  vala je sistematično pregleval VSE izvozne končne točke (9 API rut
 *  + documents.ts) in tiskalne naslove.)
 *
 *  NAJDENIH IN POPRAVLJENIH 26 mest (uporabniško vidnih):
 *    · `/api/reports/export/route.ts` — 23 mest:
 *      – 6 naslovov odsekov: X/Z POSLOVNO POROCILO → POROČILO,
 *        ODPRTI RACUNI (se odprta narocila, neplacano) → ODPRTI RAČUNI
 *        (še odprta naročila, neplačano), ODPRTI RACUNI;IZKLOPLJENO →
 *        RAČUNI, PLACILA PO NACINIH → PLAČILA PO NAČINIH,
 *        LABOR STROSKI → LABOR STROŠKI, RACUNOVODSKI IZVOZ →
 *        RAČUNOVODSKI IZVOZ (+ PRIMERJAVA S PREJSNJIM → PREJŠNJIM);
 *      – 17 glav/vrstic: Storno - stevilo → število, Vkljuceni →
 *        Vključeni, Stevilo odprtih → Število, Nacin;Znesek → Način,
 *        St. racunov ×3 → St. računov, Povprecni racun ×3 → Povprečni
 *        račun, Povprecna velikost druzbe → Povprečna velikost družbe,
 *        prejsnje obdobje ×2 → prejšnje obdobje, Narocila;Povprecni ×2 →
 *        Naročila;Povprečni, Strosek (EUR) ×2 → Strošek (EUR),
 *        Stevilka racuna;Datum/cas;…Nacin placila → Številka računa;
 *        Datum/čas;…Način plačila.
 *    · dashboard `page.tsx` — 3 tiskalniški naslovi:
 *      `Narocilo #` ×2 (kuhinjski/bar list ponatis + KDS tisk) →
 *      `Naročilo #`, `Racun ${…}` (ponatis računa) → `Račun ${…}`.
 *
 *  VARNO STIKAŠ (2 neodvisnosti, preverjeni pred popravki):
 *    · UTF-8 BOM: VSEH 8 CSV odsekov route nosi '\uFEFF' pred join —
 *      diakritike so Excel-varne (ista higiena kot downloadCSV v1.272);
 *    · ESC/POS CP852: print-agent ima vgrajeno tabelo CP852_SLO
 *      (čšžČŠŽđĐćĆ) — tiskalniški naslovi z diakritiki so varni;
 *      inferKindFromTitle preverja OBE obliki ('RAČUN' || 'RACUN') —
 *      sklepanje vrste dokumenta se ne zlomi.
 *
 *  POŠTENI NEGATIVNI KONTROLI (NEVDNI — ostanejo ravninski):
 *    · tab ID-ji: 'narocila'/'racuni'/'stroski'/'obracun' (mesto
 *      ključa v TabsContent/nav-groups/tab-permissions — ne vrednost);
 *    · URL parametri: '?tab=racuni' (furs/submit), '?tab=stroski'
 *      (push), '?tab=narocila' (web-portal) — se morajo ujemati s tab ID;
 *    · imena datotek ASCII NAMERNO: xz-porocilo_, haccp-porocilo-,
 *      obracun-, racuni-, porocilo-, stroski- (prenosljivost);
 *    · `<tns:Racun>` v cis/client.ts — SOAP protokol FURS
 *      (zunanja pogodba, enaka kot DavcnaStevilka v v1.272);
 *    · nounKey 'narocilo' v tN() klicu — mesto ključa, ne vrednost;
 *    · spremenljivke: davcna (setup), zacetek/cisti (local-*).
 *
 *  Č1 · VSEBINA ROUTE: vseh 23 mest živo v izvorni datoteki + starih
 *    ravninskih oblik NI več (natančni nizi, ne substringi).
 *  Č2 · NEGATIVNI KONTROLI: NEVDNI ostanejo (tab ID, URL parametri,
 *    imena datotek, SOAP, nounKey) — prevez v1.273 jih NI smel doseči.
 *  Č3 · MONTAŽA/VARNOST: BOM ×6 v route, Content-Type charset=utf-8,
 *    inferKindFromTitle OBE obliki, CP852_SLO v print-agentu,
 *    tiskalniški naslovi na dashboardu živi.
 *  Ž · REGISTRI: verzija 1.273.0 (version.ts + compose + APP_VERSION
 *    vsebina), worklog vrh Task ID, AUDIT POSODOBITEV v1.273.0.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// 23 mest v route: [nova pravilna oblika (živa)]
const ROUTE_FIXES: string[] = [
  'X/Z POSLOVNO POROČILO - RestaurantOS',
  'Storno - število;',
  'ODPRTI RAČUNI (še odprta naročila, neplačano)',
  'Vključeni v dnevni promet;DA',
  'Število odprtih;',
  'ODPRTI RAČUNI;IZKLOPLJENO',
  'PLAČILA PO NAČINIH',
  'Način;Znesek (EUR)',
  'St. računov (covers);',
  'Povprečni račun;',
  'Povprečna velikost družbe;',
  'PRIMERJAVA S PREJŠNJIM OBDOBJEM',
  'Neto prodaja prejšnje obdobje;',
  'St. računov prejšnje obdobje;',
  'Ura;Prodaja;Naročila;Povprečni račun',
  'LABOR STROŠKI - RestaurantOS',
  'Datum;Minute;Strošek (EUR);Neto prodaja (EUR);Labor %',
  'Vloga;Minute;Strošek (EUR)',
  'Številka računa;Datum/čas;Storno;Storno od;Način plačila;',
  'Datum;St. računov;Neto;DDV;Bruto (EUR)',
  'RAČUNOVODSKI IZVOZ - RestaurantOS',
  'Datum;St. računov;Neto (brez DDV);',
]

// starih ravninskih oblik NI več (natančni nizi; imena datotek so legitimno ASCII)
const ROUTE_FLAT_GONE: string[] = [
  'X/Z POSLOVNO POROCILO',
  'Storno - stevilo',
  'ODPRTI RACUNI (se odprta narocila, neplacano)',
  'Vkljuceni v dnevni promet',
  'Stevilo odprtih',
  'ODPRTI RACUNI;IZKLOPLJENO',
  'PLACILA PO NACINIH',
  'Nacin;Znesek',
  'St. racunov (covers)',
  'Povprecni racun',
  'Povprecna velikost druzbe',
  'PRIMERJAVA S PREJSNJIM',
  'prejsnje obdobje',
  'Ura;Prodaja;Narocila',
  'LABOR STROSKI',
  'Strosek (EUR)',
  'Stevilka racuna',
  'Datum/cas;',
  'Nacin placila',
  'RACUNOVODSKI',
]

// ── Č1) VSEBINA ROUTE — 23 mest živih, ravninskih ni več ──
describe('v1.273.0 Č1 — izvozni API: 23 mest z diakritikami', () => {
  test('vseh 22 pravilnih nizov živo v reports/export/route.ts (23 mest — Ura;Prodaja ×2)', () => {
    const src = read('src/app/api/reports/export/route.ts')
    for (const s of ROUTE_FIXES) {
      expect(src).toContain(s)
    }
  })

  test('starih ravninskih oblik NI več v route (glave in naslovi odsekov)', () => {
    const src = read('src/app/api/reports/export/route.ts')
    for (const s of ROUTE_FLAT_GONE) {
      expect(src).not.toContain(s)
    }
  })

  test('Povprečni račun se pojavi 3× (gostje + prodaja po urah ×2)', () => {
    const src = read('src/app/api/reports/export/route.ts')
    const n = src.split('Povprečni račun').length - 1
    expect(n).toBe(3)
  })

  test('St. računov se pojavi 3× (covers + prejšnje + DDV po dnevih) in računovodski izvoz še 1×', () => {
    const src = read('src/app/api/reports/export/route.ts')
    const n = src.split('St. računov').length - 1
    expect(n).toBe(4)
  })

  test('Ura;Prodaja;Naročila;Povprečni račun se pojavi 2× (skupno + po dnevih)', () => {
    const src = read('src/app/api/reports/export/route.ts')
    const n = src.split('Ura;Prodaja;Naročila;Povprečni račun').length - 1
    expect(n).toBe(2)
  })

  test('komentar, ki citira banner, posodobljen (živi opis, ne zgodovina)', () => {
    const src = read('src/app/api/reports/export/route.ts')
    expect(src).toContain('// »Vključeni v dnevni promet;DA« (Square')
  })
})

// ── Č2) NEGATIVNI KONTROLI — NEVDNI ostanejo ravninski ──
describe('v1.273.0 Č2 — negativni kontroli (veljavne ravninske oblike)', () => {
  test('tab ID-ji ostanejo ravninski (mesto ključa, ne vrednost)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page).toContain("['narocila', ClipboardList]")
    expect(page).toContain("['racuni', ReceiptText]")
    expect(page).toContain("['stroski', Wallet]")
    expect(page).toContain("['obracun', ReceiptText]")
    const nav = read('src/lib/nav-groups.ts')
    expect(nav).toContain("racuni: 'finance'")
    expect(nav).toContain("obracun: 'finance'")
  })

  test('URL parametri ?tab=* ostanejo ravninski (ujemanje s tab ID)', () => {
    expect(read('src/lib/furs/submit.ts')).toContain("'/dashboard?tab=racuni'")
    expect(read('src/lib/push.ts')).toContain("'/dashboard?tab=stroski'")
    expect(read('src/app/api/public/web-portal/route.ts')).toContain("'/dashboard?tab=narocila'")
  })

  test('imena datotek izvozov ostanejo ASCII NAMERNO (prenosljivost)', () => {
    const route = read('src/app/api/reports/export/route.ts')
    expect(route).toContain('xz-porocilo_')
    expect(read('src/app/api/haccp/report/route.ts')).toContain('haccp-porocilo-')
    expect(read('src/app/api/payroll/[id]/export/route.ts')).toContain('obracun-')
    expect(read('src/app/dashboard/page.tsx')).toContain('racuni-')
    expect(read('src/components/tabs/finance-tab.tsx')).toContain('porocilo-')
    expect(read('src/components/tabs/finance-tab.tsx')).toContain('stroski-')
  })

  test('SOAP protokol FURS <tns:Racun> nedotaknjen (zunanja pogodba)', () => {
    const cis = read('src/lib/cis/client.ts')
    expect(cis).toContain('<tns:Racun>')
    expect(cis).toContain('</tns:Racun>')
  })

  test('nounKey klic tN(loc.today, narocilo) ostane ravninski (ključ, ne vrednost)', () => {
    expect(read('src/app/dashboard/page.tsx')).toContain("tN('loc.today', 'narocilo', st.todayOrders)")
  })

  test('vsi ostali izvozni endpointi čisti (0 ravninskih mest vsebine)', () => {
    const files = [
      'src/app/api/haccp/report/route.ts',
      'src/app/api/payroll/[id]/export/route.ts',
      'src/app/api/crm/guests/export/route.ts',
      'src/app/api/shifts/movements/route.ts',
      'src/app/api/reports/food-cost/route.ts',
      'src/app/api/reports/exceptions/route.ts',
      'src/app/api/inventory/batches/[id]/trace/route.ts',
      'src/lib/documents.ts',
    ]
    const flatContent = [
      'POROCILO', 'RACUNI;', 'Nacin;', 'Strosek', 'stevilo;', 'Stevilka',
      'Povprecni', 'prejsnje', 'Vkljuceni', 'Narocila;',
    ]
    for (const f of files) {
      const src = read(f)
      const violations: string[] = []
      for (const flat of flatContent) {
        // imena datotek v Content-Disposition so legitimno ASCII — preskoči vrstice z filename
        const bodyLines = src.split('\n').filter((l) => !l.includes('filename='))
        const body = bodyLines.join('\n')
        if (body.includes(flat)) violations.push(flat)
      }
      expect(violations).toEqual([])
    }
  })
})

// ── Č3) MONTAŽA/VARNOST — BOM, kodiranje, sklepanje vrste ──
describe('v1.273.0 Č3 — montaža in varnost stiš', () => {
  test('UTF-8 BOM pred VSEMI CSV odseki route (Excel varnost) — 8×', () => {
    const src = read('src/app/api/reports/export/route.ts')
    const n = src.split("'\\uFEFF' +").length - 1
    expect(n).toBe(8)
    expect(src).toContain("const csv4 = '\\uFEFF' + L4.join('\\r\\n')")
  })

  test('Content-Type charset=utf-8 na vseh CSV odgovorih', () => {
    const src = read('src/app/api/reports/export/route.ts')
    expect(src.split("'text/csv; charset=utf-8'").length - 1).toBeGreaterThanOrEqual(6)
  })

  test('inferKindFromTitle preverja OBE obliki (RAČUN in RACUN) — sklep vrste se ne zlomi', () => {
    const dev = read('src/lib/devices/print.ts')
    expect(dev).toContain("t.includes('RAČUN') || t.includes('RACUN')")
    const lib = read('src/lib/print.ts')
    expect(lib).toContain("t.includes('RAČUN') || t.includes('RACUN')")
  })

  test('print-agent nosi CP852_SLO tabelo (čšž ESC/POS varnost)', () => {
    const agent = read('mini-services/print-agent/index.ts')
    expect(agent).toContain('CP852_SLO')
    expect(agent).toContain('čšžČŠŽđĐćĆ')
  })

  test('tiskalniški naslovi na dashboardu živi (Naročilo # ×2, Račun ×1)', () => {
    const page = read('src/app/dashboard/page.tsx')
    expect(page.split('printLines(`Naročilo #').length - 1).toBe(2)
    expect(page).toContain('printLines(`Račun ${r.invoiceNumber}`')
    expect(page).not.toContain('printLines(`Narocilo #')
    expect(page).not.toContain('printLines(`Racun ${')
  })
})

// ── Ž) REGISTRI ──
describe('v1.273.0 Ž — registri', () => {
  test('verzija 1.273.0 (version.ts + compose + APP_VERSION vsebina)', () => {
    expect(APP_VERSION).toBe('1.293.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.293.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.293.0')
  })

  test('worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.293.0-demo-real-auditlog-pisatelji')
  })

  test('AUDIT doc-truth: POSODOBITEV (v1.273.0, diakritike II — izvozni API + tisk)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.273.0, diakritike II — izvozni API + tisk)')
    // prejšnji vnos ostaja (zgodovinska veriga doc-truth)
    expect(audit).toContain('POSODOBITEV (v1.272.0, diakritike I — CSV glave)')
  })

  test('v253 pini prevezani na diakritični banner (regresija preveza)', () => {
    const v253 = read('tests/v253-odprti-racuni.test.ts')
    expect(v253).toContain("toContain('ODPRTI RAČUNI;IZKLOPLJENO')")
    expect(v253).toContain("toContain('Vključeni v dnevni promet;DA')")
    expect(v253).not.toContain("'Vkljuceni v dnevni promet'")
    expect(v253).toContain("toContain('Število odprtih;2')")
  })
})
