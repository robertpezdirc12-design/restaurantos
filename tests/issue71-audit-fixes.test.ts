/**
 * Issue #71 — UX revizija produkcije v1.130.0: 34 najdb (4 blocker / 24 major / 6 minor).
 * Regresijski testi za popravke, integrirane v v1.132.0.
 *
 * Sledi vzorcu projekta: strukturni sken vira (data-region markerji, razredi,
 * odsotnost surovih enumov), ne render testi — hitro in odpor na refaktorje.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fmtNumSI } from '../src/lib/client'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const dash = () => readFileSync(join(import.meta.dir, '../src/app/dashboard/page.tsx'), 'utf-8')
const slSrc = () => readFileSync(join(import.meta.dir, '../src/lib/i18n/sl.ts'), 'utf-8')

/* ── audit-1 (blocker): KDS loči aktivno izmeno od zastarelega ── */
describe('issue #71 audit-1 — KDS: dve loci (aktivna izmena / zastarelo)', () => {
  test('zastareli listki so v LOČNEM odseku, privzeto zloženemu (števec viden)', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-section-stale"')
    expect(d).toContain('kdsStaleOpen')
    expect(d).toContain("useState(false)")
    expect(d).toContain("t('kds.staleSection')")
  })
  test('aktivna izmena ima lastno glavo s števcem', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-section-active"')
    expect(d).toContain("t('kds.activeShift')")
  })
})

/* ── audit-14 (blocker): alergeni — resnični alarm rdeč, manjkajoči = zbirnik ── */
describe('issue #71 audit-14 — alergenska hierarhija resnosti', () => {
  test('resnična alergijska opozorila = RDEČ PAS na vrhu listka (ne rumeni čip enake teže)', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-ticket-allergies"')
    expect(d).toContain('role="alert"')
    expect(d).toContain('border-l-4 border-red-600')
  })
  test('manjkajoči alergenski podatki = EN sivi zbirnik na listek (ne 24+ rumenih čipov)', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-ticket-allergen-unconfirmed"')
    expect(d).toContain("t('kds.unconfirmedAllergens'")
    // per-item rumeni »niso potrjeni« čip je ODSTRANJEN (utišal je pravi alarm)
    expect(d).not.toMatch(/allergenStatus.*allergenUnconfirmed/)
  })
})

/* ── audit-2 (major): listek pove, katera miza + kdo je naročil ── */
describe('issue #71 audit-2 — identiteta listka = miza, ne surovi enum', () => {
  test('naslov nikoli več gol o.type (DINE_IN) — vedno orderTypeL()', () => {
    const d = dash()
    expect(d).not.toContain('o.table?.name || o.type')
    expect(d).toContain('orderTypeL(o.type)')
    expect(d).toContain("t(`order.type.${ty}`)")
  })
  test('KDS podnaslov: ura brez sekund + število oseb + natakar', () => {
    const d = dash()
    expect(d).toContain("hour: '2-digit', minute: '2-digit'")
    expect(d).toContain("t('kds.guestsShort', { n: o.guests })")
    expect(d).toContain('o.employee?.name')
  })
  test('tip naročila je ZNAČKA ob naslovu, ne naslov', () => {
    const d = dash()
    expect(d).toContain("inline-flex shrink-0 items-center rounded-full border border-stone-300")
  })
})

/* ── audit-18 (blocker): množični opomnik zahteva potrditev ── */
describe('issue #71 audit-18 — potrditveno okno pred pošiljanjem opomnikov', () => {
  test('gumb NE kliče sendAll neposredno — odpre potrditev', () => {
    const d = dash()
    expect(d).not.toContain("onClick={() => void sendAllReservationReminders()}")
    expect(d).toContain('setReminderConfirmOpen(true)')
  })
  test('okno kaže število + predogled + nedvoumno »ni mogoče razveljaviti«', () => {
    const d = dash()
    expect(d).toContain('reminderConfirmOpen')
    expect(d).toContain("t('resv.reminderConfirmBody', { n: reminderCandidates.length })")
    expect(d).toContain('reminderCandidates.length === 0')
  })
  test('kandidati zrcalijo strežniško logiko (confirmed + 24 h + brez opomnika)', () => {
    const d = dash()
    expect(d).toContain("r.reminderSent || r.status !== 'confirmed'")
    expect(d).toContain('24 * 3600 * 1000')
  })
})

/* ── audit-9 (blocker): čistilna vzdrževalna ruta ── */
describe('issue #71 audit-9 — cleanup-demo vzdrževalna ruta', () => {
  const route = readFileSync(join(import.meta.dir, '../src/app/api/admin/cleanup-demo/route.ts'), 'utf-8')
  test('scan (privzeto) ne spreminja nič; purge zahteva potrditveno besedilo', () => {
    expect(route).toContain("const purge = body.mode === 'purge'")
    expect(route).toContain("body.confirm !== CONFIRM_PHRASE")
    expect(route).toContain("if (!purge)")
  })
  test('zastareli listki se NE brišejo (fiskalna sled) — zaključijo se kot preklicani', () => {
    expect(route).toContain("status: 'cancelled'")
    expect(route).not.toContain('db.order.delete')
  })
  test('poseg se zapiše v revizijski dnevnik', () => {
    expect(route).toContain('AUDIT_DEMO_CLEANUP')
  })
})

/* ── audit-3 (major): KPI = izpeljano stanje, en vir resnice ── */
describe('issue #71 audit-3 — KPI zasedene mize = aktivna naročila (kot tloris)', () => {
  const route = readFileSync(join(import.meta.dir, '../src/app/api/dashboard/route.ts'), 'utf-8')
  test('števec ne šteje več surovega DB statusa occupied', () => {
    expect(route).not.toContain("status: 'occupied'")
    expect(route).toContain('Order: { some: { status: { in: ORDER_ACTIVE_DB }')
  })
})

/* ── audit-4 (major): widget pošlje locationId + človeška napaka ── */
describe('issue #71 audit-4 — rezervacijski widget', () => {
  const card = readFileSync(join(import.meta.dir, '../src/components/tabs/reservation-widget-card.tsx'), 'utf-8')
  test('GET pošlje locationId iz profila', () => {
    expect(card).toContain('locationId=${encodeURIComponent(user.locationId)')
  })
  test('napaka je prevedena v človeško sporočilo z akcijo', () => {
    expect(card).toContain("resv.wid.errNoLocation")
    expect(card).toContain('errGeneric')
  })
})

/* ── audit-6 (major): printBarTitle obstaja v obeh slovarjih ── */
describe('issue #71 audit-6 — manjkajoči i18n ključi', () => {
  test('kitchen.printBarTitle obstaja v SL in HR', () => {
    expect(sl['kitchen.printBarTitle']).toBeTruthy()
    expect(hr['kitchen.printBarTitle']).toBeTruthy()
  })
  test('acct.preview obstaja (ujel ga je novi test uporabljenih ključev)', () => {
    expect(sl['acct.preview']).toBeTruthy()
    expect(hr['acct.preview']).toBeTruthy()
  })
})

/* ── audit-7/8/13 (major/hitro): jezikovne napake ── */
describe('issue #71 audit-7/8/13 — prevodi v jeziku gostilne', () => {
  test('ni več »za prostost« (prostost ≠ dopust)', () => {
    const src = slSrc()
    expect(src).not.toContain('za prostost')
    expect(src).toContain('za dopust')
  })
  test('ORDER_FIRE ni več »Tečaj« (hod, ne jezikovni tečaj)', () => {
    expect(sl['notif.event.ORDER_FIRE']).not.toContain('Tečaj')
    expect(sl['notif.event.ORDER_FIRE']).toContain('hod')
  })
  test('»Pošlji v kuhinjo« (ne na kuhinjo)', () => {
    expect(sl['mmv.fire']).toBe('Pošlji v kuhinjo')
  })
  test('»načrtovanih terminov« (ne načrtovih)', () => {
    expect(sl['haccp.board.none']).toContain('načrtovanih')
  })
})

/* ── audit-12 (major): enotno sl-SI oblikovanje števil ── */
describe('issue #71 audit-12 — fmtNumSI (decimalna vejica)', () => {
  test('4.2 → »4,2« (HACCP temperature, DDV stopnje, recepture)', () => {
    expect(fmtNumSI(4.2, { unit: '°' })).toBe('4,2°')
    expect(fmtNumSI(9.5, { max: 1 })).toBe('9,5')
    expect(fmtNumSI(0.08, { max: 3 })).toBe('0,08')
    expect(fmtNumSI(5)).toBe('5')
  })
})

/* ── audit-5 (blocker) + audit-28: jezik vloge, združene napake ── */
describe('issue #71 audit-5/28 — enumi v jeziku vloge + združene napake', () => {
  test('revizijski dogodki imajo človeške oznake + olepševalca neznanega', () => {
    const d = dash()
    expect(d).toContain('auditActionL(a.action)')
    expect(d).toContain('auditEntityL(a.entityType)')
    expect(d).toContain('DEMO_LOGIN: ')
    expect(d).toContain('SCHEMA_MIGRATION_')
  })
  test('vloge: dodane manjkajoče (STAFF/CHEF/WAREHOUSE/…)', () => {
    const d = dash()
    expect(d).toContain("STAFF: 'Natakar'")
    expect(d).toContain("WAREHOUSE: 'Skladiščnik'")
  })
  test('dnevnik napak: združevanje po podpisu (×N + zadnji), payload skrit', () => {
    const d = dash()
    expect(d).toContain('errlog.occurrences')
    expect(d).toContain("t('errlog.details')")
    expect(d).toContain('auditActionL(l.action)')
  })
})

/* ── audit-23 (hitro): zgoščene postavke naročila ── */
describe('issue #71 audit-23 — 3 postavke + »＋ N ostalih«', () => {
  test('privzeto 3 + razširitveni gumb (44 px)', () => {
    const d = dash()
    expect(d).toContain('o.items.slice(0, 3)')
    expect(d).toContain("t('orders.moreItems', { n: rest })")
    expect(d).toContain('expandedOrderItems')
  })
})

/* ── audit-27 (hitro): neznan zavihek ── */
describe('issue #71 audit-27 — neznan ?tab= ne pusti prazne plošče', () => {
  test('validacija proti TAB_PERM + toast + preusmeritev na pregled', () => {
    const d = dash()
    expect(d).toContain('!TAB_PERM[tabParam]')
    expect(d).toContain("t('tabs.unknown')")
    expect(d).toContain("t('tabs.noPerm')")
  })
})

/* ── audit-32/16 (major): hitra prodaja ── */
describe('issue #71 audit-16/32 — hitra prodaja: privzeta kategorija + 86 na ploščici', () => {
  test('privzeta izbira = prva kategorija (ne Vse = 436 ploščic)', () => {
    const d = dash()
    expect(d).toContain('saleCatTouched')
    expect(d).toContain('setSaleCat(categories[0].id)')
  })
  test('razprodan artikel: rdeča ploščica + 86 trak + razlog v aria', () => {
    const d = dash()
    expect(d).toContain('border-red-200 bg-red-50/70')
    expect(d).toContain('uppercase tracking-wider text-red-800 shadow-sm">86</span>')
    expect(d).toContain("t('sale.soldOut')")
  })
})

/* ── audit-21 (hitro): rezervirana miza berljiva ── */
describe('issue #71 audit-21 — rezervirana miza: lastni akcent + besedilo statusa', () => {
  test('REZERVIRANA = prekinjen rob + temno besedilo (ne stone-200 z nizkim kontrastom)', () => {
    const d = dash()
    expect(d).toContain('RESERVED: ')
    expect(d).not.toContain("RESERVED: 'bg-stone-200 text-stone-800 hover:bg-stone-300'")
  })
  test('status mize je BESEDILO na ploščici (ne samo barva)', () => {
    expect(dash()).toContain('{stL(tb.status)}')
  })
})

/* ── audit-24/25 (major): zaloge in zaposleni dobita iskalnike ── */
describe('issue #71 audit-24/25 — iskalniki in filtri', () => {
  test('zaloge: iskanje + Vsi/pod-minimumom/zmanjkalo + 0 označen rdeče', () => {
    const z = readFileSync(join(import.meta.dir, '../src/components/tabs/zaloga-tab.tsx'), 'utf-8')
    expect(z).toContain('invSearch')
    expect(z).toContain("invFilter === 'OUT'")
    expect(z).toContain('border-red-300 bg-red-50/50')
    expect(z).toContain('fmtNumSI(i.qty)')
  })
  test('zaposleni: iskalnik + gumb Nov zaposleni + dialog', () => {
    const d = dash()
    expect(d).toContain('empSearch')
    expect(d).toContain("t('emp.new')")
    expect(d).toContain('newEmpDlg')
    expect(d).toContain("'/api/employees'")
  })
})

/* ── audit-34 (minor): prazna stanja z razlogom ── */
describe('issue #71 audit-34 — mrtva prazna stanja dobi razlog + naslednji korak', () => {
  test('rezervacije in klici razložijo, zakaj je prazno in kaj storiti', () => {
    expect(sl['resv.empty']).toContain('Ustvari')
    expect(sl['callv.card.empty']).toContain('ekipa')
  })
})

/* ── audit-2 (backend): KDS vključi natakarja ── */
describe('issue #71 audit-2 — kitchen API vključi zaposlenega', () => {
  const route = readFileSync(join(import.meta.dir, '../src/app/api/kitchen/route.ts'), 'utf-8')
  test('Employee relacija je v include', () => {
    expect(route).toContain('Employee_Order_employeeIdToEmployee: { select: { name: true } }')
    expect(route).not.toContain('employee: null')
  })
})

/* ── v1.132.1: hidratacijska varnost useInViewOnce (React #418 v produkciji) ── */
describe('v1.132.1 — useInViewOnce ne sme razlikovati SSR od prvega izrisa klienta', () => {
  const ops = readFileSync(join(import.meta.dir, '../src/components/tabs/ops-cards.tsx'), 'utf-8')
  test('inicializator NE prebere typeof IntersectionObserver (SSR≠klient → React #418)', () => {
    // prej: useState(() => typeof IntersectionObserver === 'undefined')
    // SSR (Node): true → »Ni podatkov.« izrisan; klient prvi izris: false → NI izrisan
    // → strukturno neujemanje → strežniško drevo zavrženo, celoten UI izrisan na novo
    expect(ops).not.toContain('useState(() => typeof IntersectionObserver')
  })
  test('inicialno stanje je konstanta false; IO podpora preverjena v effectu (asinhrono)', () => {
    expect(ops).toContain('const [inView, setInView] = useState(false)')
    expect(ops).toContain("if (typeof IntersectionObserver === 'undefined') {")
    expect(ops).toContain('setTimeout(() => setInView(true), 0)')
    // asinhrona nastavitev — react-hooks/set-state-in-effect prepoveduje synchroni klic
    expect(ops).not.toContain("{ setInView(true); return }")
  })
})
