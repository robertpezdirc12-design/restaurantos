/**
 * Issue #69 (P2 — vizualni QA) — 2. val: gostota KDS + segmentacija dolgih strani
 * (v1.122.0+ del #69, ostanki iz žive QA lastnika @ 390 px):
 *
 *  A. KDS GOSTOTA: listek z dolgim seznamom postavk mora biti berljiv "na en
 *     pogled" — glava v dveh vrsticah (identiteta + PRIMARNI STATUS listka,
 *     nato ČASOVNIK + tiskanje), kompaktne vrstice postavk (ime/qty levo, starost
 *     desno, čipi postaje + ALERGENOV (jantorna tint, ≥ 12 px) + opomba v lastni
 *     vrstici, dejanja na dnu s ciljem na dotik 44 px). Vrsta: OBA prikaza
 *     (dashboard legacy + kds-station-board) — data-region markerji so testni
 *     sidri. Zastareli listki (> 8 h, v1.121.0) ohranijo VRSTNI RED (konec vrste),
 *     sivo/črtkano obliko in ZASTARELO oznako — spremenjen je IZKLJUČNO izris.
 *  B. MENI (~17.758 px @1440): lepljiva vrstica hitrega skoka (čisti sidrski
 *     href="#cat-<slug>" → id na razdelku, BREZ stanja/JS), lepljive glave
 *     kategorij, gostejša mreža (≥768 px).
 *  C. NASTAVITVE (~6.190 px @1440): vizualni razdelki s naslovi + hitri skok
 *     (#set-…); vsebine kartic in kontrolniki NEDOTAKNJENI; mobilni overflow
 *     fix iz v1.122.0 (1 kolona < 768 px) sme ostati.
 *  D. SKUPNI CSS: os-quickjump-track (skrit drsnik), podlage/blur, temni način,
 *     prefers-reduced-motion varovalka ostaja.
 *  E. i18n: novi ključi menu.jumpAria / menu.catCount / settings.* obstajajo v
 *     OBEH slovarjih (SL + HR) — brez prevajalske logike.
 *  F. 0 DDL: SCHEMA_MIGRATIONS.length nespremenjen (28) + migrations/ ima samo
 *     init migracijo; datotečna množica sprememb = izključno izris (CSS/Tailwind/
 *     dekorativni DOM/data-*).
 *
 * Čisto source-pin + i18n testi (vzorec issue70): brez DB fiksur, brez API klicev.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_MIGRATIONS } from '../src/lib/schema-migrations'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'
import { t } from '../src/lib/i18n'
import { KDS_STALE_THRESHOLD_MIN } from '../src/lib/kds-delays'

const src = (p: string): string => readFileSync(join(process.cwd(), 'src', p), 'utf8')

const dash = (): string => src('app/dashboard/page.tsx')
const board = (): string => src('components/kds-station-board.tsx')
const css = (): string => src('app/globals.css')

// ═══ §A — KDS gostota listka (dashboard legacy vrsta + postajna plošča) ═══

describe('§A KDS gostota — struktura listka (data-region markerji)', () => {
  it('dashboard legacy vrsta: listek ima markerje kds-ticket/-header/-timer/-items/-item', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-ticket"')
    expect(d).toContain('data-region="kds-ticket-header"')
    expect(d).toContain('data-region="kds-ticket-timer"')
    expect(d).toContain('data-region="kds-ticket-items"')
    expect(d).toContain('data-region="kds-ticket-item"')
  })

  it('glava listka: PRIMARNI STATUS iz obstoječega statusnega slovarja (stL + statusColors)', () => {
    const d = dash()
    // dominantna oznaka stanja naročila — obstoječa preslikava, samo izris.
    // v1.129.0 (Toast/Square benchmark): status v glavi KDS listka je NEVTRALEN
    // (stone/emerald obrobe po fazah) — RDEČA je rezervirana izključno za ZAMUDO
    // (starost listka); prej je polnjena statusna barva odvzela pomen alarmu.
    expect(d).toContain("o.status === 'SENT' ? 'border-stone-300 bg-stone-50 text-stone-700'")
    expect(d).toContain("o.status === 'PREPARED' || o.status === 'READY' ? 'border-emerald-300 bg-emerald-50 text-emerald-800'")
    expect(d).toContain('{stL(o.status)}')
  })

  it('glava listka: ČASOVNIK dominanten (tabular-nums, ekstra bold) na fiksni legi', () => {
    const d = dash()
    // svež in zastarel primer (oba izrišta časovnik v isti dominantni obliki)
    expect(d).toContain('data-region="kds-ticket-timer" className={`text-sm font-extrabold tabular-nums px-2.5 py-1 rounded-full border')
    expect(d).toMatch(/data-region="kds-ticket-timer"\s*\n\s*className="text-sm font-extrabold tabular-nums px-2\.5 py-1 rounded-full border bg-stone-100/)
  })

  it('glava listka: identiteta + # + čas dovolita ovijanje (flex-wrap) — brez rezanja imena', () => {
    const d = dash()
    expect(d).toContain('flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0')
    expect(d).toContain('font-bold truncate max-w-full min-w-0')
  })

  it('postavke: ime/qty levo + starost desno (osnova za hitro skeniranje)', () => {
    const d = dash()
    expect(d).toContain('flex items-baseline justify-between gap-2 min-w-0')
    expect(d).toMatch(/<p className="text-sm sm:text-base font-semibold truncate min-w-0">\{it.qty\}× \{it.name\}<\/p>/)
  })

  it('postavke: ALERGENI kot vidni jantorni čipi (ločena vrstica, ≥ 12 px besedilo)', () => {
    const d = dash()
    expect(d).toContain('data-region="kds-allergen-chip"')
    expect(d).toMatch(/data-region="kds-allergen-chip"[^/]*title=\{t\('kds\.allergenCodes'\)\}/)
    expect(d).toContain('border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800')
    // rdeče izrecno opozorilo (issue #7) ostane vidno kot čip
    expect(d).toContain('border-red-300 bg-red-50 px-2 py-0.5 text-xs font-bold text-red-800')
  })

  it('postavke: dejanja v lastni vrstici s ciljem na dotik 44 px na mobilnem', () => {
    const d = dash()
    expect(d).toContain('flex items-center gap-1.5 flex-wrap justify-end min-w-0')
    // v1.129.0 (Toast/Square): cilj ≥ 44 px VEČ ne samo na mobilnem — KDS JE dotik
    // tudi na namizju (sm:h-8 krčil gumb na 32 px tam, kjer je kuhinja/dotik).
    expect(d).toContain('className="h-11 text-sm font-semibold bg-emerald-700 hover:bg-emerald-800"')
    expect(d).toContain('className="h-11 px-2 text-xs gap-1 text-stone-500 hover:text-red-700"')
    expect(d).not.toContain('sm:h-8 bg-emerald-700')
  })

  it('gostota: Card ploščata (py-3 sm:py-4, gap-2), strnjena vsebina (space-y-1.5)', () => {
    const d = dash()
    expect(d).toContain('min-w-0 gap-2 py-3 sm:py-4')
    expect(d).toContain('space-y-1.5 px-4 pb-1 sm:px-6 sm:pb-2')
  })

  it('zastareli listki: sortiranje konec-vrste + oznaka/namig OHRANJENA (v1.121.0)', () => {
    const d = dash()
    // vrstni red: aktivni prvi, zastareli konec — logika NEDOTAKNJENA
    expect(d).toContain('.sort((a, b) => Number(isStaleKdsTicket(kdsMinutes(a.createdAt))) - Number(isStaleKdsTicket(kdsMinutes(b.createdAt))))')
    expect(d).toContain("stale ? 'border-dashed border-stone-300 border-l-stone-300 bg-stone-50'")
    // v1.129.0 (Toast/Square): starost → BARVNI LEVI ROB listka (5′ jantorn / 10′ rdeč;
    // Toast glava listka, Square timer) — semantika zamende ločena od statičnega statusa.
    // VRSTNI RED: celovit border-{color} MORA priti PRED border-l-{color} — cn()
    // (tailwind-merge) sicer odstrani stransko-specifičen barvni razred.
    expect(d).toContain("ageMin >= 10 ? 'border-stone-200 border-l-red-500'")
    expect(d).toContain("ageMin >= 5 ? 'border-stone-200 border-l-amber-500'")
    expect(d).toContain("{t('kds.stale')}: {t('kds.staleHours', { h: staleTicketHours(ageMin) })}")
    expect(d).toContain("{t('kds.staleHint')}")
    // prag ostaja 8 h (480 min) — vizualna sprememba ne sme premakniti semantike
    expect(KDS_STALE_THRESHOLD_MIN).toBe(480)
  })

  it('kds-station-board: ista hierarhija (dve vrstici glave + markerji + h-11 dejanja)', () => {
    const b = board()
    expect(b).toContain('data-region="kds-ticket"')
    expect(b).toContain('data-region="kds-ticket-header"')
    expect(b).toContain('data-region="kds-ticket-identity"')
    expect(b).toContain('data-region="kds-ticket-timer-row"')
    expect(b).toContain('data-region="kds-ticket-timer"')
    expect(b).toContain('data-region="kds-ticket-item-group"')
    expect(b).toContain('data-region="kds-ticket-item"')
    expect(b).toContain('text-sm font-extrabold tabular-nums px-2.5 py-1 rounded-full border')
    expect(b).toContain('className="h-11 bg-emerald-700 hover:bg-emerald-800"')
    expect(b).toContain('className="h-11 gap-1 bg-emerald-700 hover:bg-emerald-800"')
    // zastareli na konec (staleLast) ostaja v komponenti
    expect(b).toContain('const staleLast = (groups: TaskGroupT[]): TaskGroupT[] =>')
  })
})

// ═══ §B — Meni: segmentacija + hitri skok po kategorijah ═══

describe('§B Meni — segmentacija dolge strani (statična sidra, brez stanja)', () => {
  it('catAnchor: determinističen slug (#cat-<slug>) — čista preslikava niza', () => {
    const d = dash()
    expect(d).toContain('const catAnchor = (id: string): string => `cat-${id.toLowerCase().replace(/[^a-z0-9]+/g, \'-\')}`')
  })

  it('hitri skok: lepljiva vrstica čipov s sidrskimi href-i (#cat-…)', () => {
    const d = dash()
    expect(d).toContain('data-region="menu-quickjump"')
    expect(d).toContain("aria-label={t('menu.jumpAria')}")
    expect(d).toContain('href={`#${catAnchor(g.cat.id)}`}')
    expect(d).toContain('sticky top-14 z-20 rounded-xl border border-stone-200 p-1.5 shadow-sm')
    expect(d).toContain('os-quickjump-track flex gap-1 overflow-x-auto')
  })

  it('čipi hitrega skoka: cilj na dotik 44 px + števec postavk kategorije', () => {
    const d = dash()
    expect(d).toContain('shrink-0 min-h-11 inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-700')
    expect(d).toContain('{t(\'menu.catCount\', { n: g.items.length })}')
  })

  it('razdelki: id sidra + scroll-mt + lepljiva glava kategorije', () => {
    const d = dash()
    expect(d).toContain('id={catAnchor(g.cat.id)} data-region="menu-category"')
    expect(d).toContain('className="space-y-2 scroll-mt-40"')
    expect(d).toContain('data-region="menu-category-header"')
    expect(d).toContain('sticky top-[7.125rem] z-10 py-1.5 border-b border-stone-200 bg-stone-50/95 backdrop-blur')
  })

  it('gostejša mreža na ≥768 px (4 stolpci na xl, strnjene vrstice)', () => {
    const d = dash()
    expect(d).toContain('grid grid-cols-1 gap-2 md:gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4')
    expect(d).toContain('bg-white p-3 md:p-2.5 flex items-center justify-between gap-2')
  })

  it('kartica artikla ostaja pri obstoječih dejanjih (alergeni/zaloga) — brez logike', () => {
    const d = dash()
    expect(d).toContain("onClick={() => setAllergenDlg({ id: m.id, name: m.name })}")
    expect(d).toContain('onClick={() => toggleAvailable(m)}')
  })
})

// ═══ §C — Nastavitve: vizualni razdelki + hitri skok ═══

describe('§C Nastavitve — razdelki s naslovi (vsebina kartic nedotaknjena)', () => {
  it('SettingsSection: dekorativna lupina (id #set-…, scroll-mt, naslov razdelka)', () => {
    const d = dash()
    expect(d).toContain('function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode })')
    expect(d).toContain('data-region="settings-section"')
    expect(d).toContain('className="space-y-3 scroll-mt-40"')
    expect(d).toContain('data-region="settings-section-header"')
  })

  it('hitri skok: 7 razdelkov s sidrskimi čipi (#set-…)', () => {
    const d = dash()
    expect(d).toContain('data-region="settings-quickjump"')
    expect(d).toContain("aria-label={t('settings.jumpAria')}")
    expect(d).toContain('href={`#set-${id}`}')
    for (const id of ['general', 'ops', 'security', 'notifications', 'devices', 'logs', 'system']) {
      expect(d).toContain(`<SettingsSection id="${id}"`)
    }
  })

  it('vse obstoječe kartice ostajajo izrisane (isti vrstni red, isti kontrolniki)', () => {
    const d = dash()
    for (const pin of [
      '<SettingsEditor settings={settings} canManage={canManage} onReload={load} />',
      '<ReservationWidgetCard />',
      '<ManagerCallSettingsCard />',
      '<LabelRulesCard />',
      '<PrepStationsCard />',
      '<MfaCard />',
      '<NotificationsCard />',
      '<DisplayPromosCard />',
      '<DevicesCard devices={devices} locations={locStats.map((l) => ({ id: l.id, name: l.name }))} onChanged={load} />',
      "{t('print.deviceTitle')}",       // tiskalnik + terminal (ista naprava)
      "{t('loc.title')}",               // mreža lokacij/integracij/webhookov
      "{t('integ.webhooks')}",
      "{t('errlog.title')}",            // dnevniki napak
      "{t('audit.title')}",             // revizijski dnevnik
      "{t('sys.title')}",               // sistem
    ]) {
      expect(d).toContain(pin)
    }
  })

  it('mobilni overflow fix iz v1.122.0 ostaja (1 kolona < 768 px + word-break)', () => {
    const c = css()
    expect(c).toContain('[role="tabpanel"][id$="-content-nastavitve"]')
    expect(c).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(c).toContain('overflow-wrap: anywhere;')
  })
})

// ═══ §D — skupni vizualni sistem (globals.css) ═══

describe('§D CSS — skupna plast #69 (drsnik, podlage, temni način, reduced-motion)', () => {
  it('os-quickjump-track: vodoravno drsenje brez vidnega drsnika + varovalka', () => {
    const c = css()
    expect(c).toContain('.os-quickjump-track {')
    expect(c).toContain('scrollbar-width: none;')
    expect(c).toContain('.os-quickjump-track::-webkit-scrollbar {')
  })

  it('lepljive vrstice hitrega skoka: podloga + zameglitev + temne različice', () => {
    const c = css()
    expect(c).toContain('[data-region="menu-quickjump"],')
    expect(c).toContain('[data-region="settings-quickjump"]')
    expect(c).toContain('backdrop-filter: blur(12px);')
    expect(c).toContain('.dark [data-region="menu-quickjump"],')
    expect(c).toContain('.dark [data-region="settings-quickjump"]')
    expect(c).toContain('.dark [data-region="menu-category-header"]')
  })

  it('prefers-reduced-motion varovalka ostaja (ni novih animacij mimo nje)', () => {
    const c = css()
    expect(c).toContain('@media (prefers-reduced-motion: reduce)')
    // #69 plast ne dodaja keyframes/animacij
    expect(c).not.toMatch(/@keyframes[^\n]*\n[^\n]*69/)
  })
})

// ═══ §E — i18n pariteta novih ključev (SL + HR) ═══

describe('§E i18n — novi ključi #69 obstajajo v OBEH slovarjih', () => {
  const KEYS = [
    'menu.jumpAria', 'menu.catCount',
    'settings.jumpAria',
    'settings.secGeneral', 'settings.secOps', 'settings.secSecurity',
    'settings.secNotifications', 'settings.secDevices', 'settings.secLogs',
    'settings.secSystem',
  ] as const

  it('vsak ključ je v SL in HR slovarju z neprazno vsebino', () => {
    for (const k of KEYS) {
      expect(sl[k]).toBeTruthy()
      expect(hr[k]).toBeTruthy()
    }
  })

  it('t() razreši ključe v obeh jezikih (padajo v obstoječo prevajalno logiko)', () => {
    for (const k of KEYS) {
      expect(t('sl', k)).not.toBe(k)
      expect(t('hr', k)).not.toBe(k)
    }
    expect(t('sl', 'menu.catCount', { n: 8 })).toContain('8')
    expect(t('hr', 'menu.catCount', { n: 8 })).toContain('8')
  })

  it('HR prevodi niso slovenske kopije (vsaj splošen/varnost razdelka se razlikujeta)', () => {
    expect(hr['settings.secGeneral']).not.toBe(sl['settings.secGeneral'])
    expect(hr['settings.secSystem']).not.toBe(sl['settings.secSystem'])
    expect(hr['settings.jumpAria']).not.toBe(sl['settings.jumpAria'])
  })
})

// ═══ §F — 0 DDL + registri ═══

describe('§F 0 DDL — vizualna sprememba brez sheme', () => {
  it('SCHEMA_MIGRATIONS.length (29 — dvignil #4 val; #69 val sam 0 DDL)', () => {
    expect(SCHEMA_MIGRATIONS.length).toBe(30) // v1.125.0: +einvoice-outbox (#4) — #69 val dodal 0
  })

  it('prisma/migrations ima samo init migracijo (ni novih SQL datotek)', () => {
    const dirs = readdirSync(join(process.cwd(), 'prisma/migrations')).filter((x) => !x.startsWith('.'))
    expect(dirs).toHaveLength(2)
    expect(dirs).toContain('00000000000000_init')
    expect(dirs).toContain('migration_lock.toml')
  })

  it('viri ne omenjajo novih entitet #69 (quickjump/segmentation) v shemi', () => {
    const sqlite = readFileSync(join(process.cwd(), 'prisma/schema.sqlite.prisma'), 'utf8')
    const pg = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    for (const schema of [sqlite, pg]) {
      expect(schema).not.toContain('QuickJump')
      expect(schema).not.toContain('MenuCategoryAnchor')
      expect(schema).not.toContain('SettingsSection')
    }
  })
})
