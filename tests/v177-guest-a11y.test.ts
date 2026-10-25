/**
 * v1.177.0 — WCAG GATE GOSTOVIH STRANI (4.1.2, 3.3.2, 1.3.1, 2.1.1, 2.5.5, 1.4.3, 4.1.3)
 *
 * Zakaj: od 28. 6. 2025 zavezuje ZDPSI (izvedba direktive (EU) 2019/882) in
 * zajema storitve e-trgovine — za to aplikacijo javni del: QR meni `/m/<token>`,
 * samopostrežni terminal `/kiosk`, plačilna povezava `/pay/<token>` in
 * rezervacijska povezava `/r/<token>`. v1.176.0 je popravil samo jezik dokumenta;
 * celoten pregled gostovih zaslonov je ostal neizmerjen (worklog v1.176.0,
 * AKCIJA ZA LASTNIKA (c)). Ta datoteka ga izmeri.
 *
 * Kako je merjeno: gate ni regex. Datoteke bere pravi TypeScriptov JSX
 * parser (`typescript`, ista različica kot v `bun run typecheck`), pravila pa
 * nato berejo drevo — starše, otroke in `aria-hidden` poddrevesa.
 *
 * Hišna zahtevnost (izrecno nad minimalno zahtevo WCAG, da je ni mogoče
 * zaobiti z nizkim standardom):
 * - `title` SAM na gumbu šteje kot kršitev 4.1.2. Specifikacija accname ga
 *   dopušča kot zadnji rezervni vir, a na napravi nikoli ni viden,
 *   bralni zasloni ga obdelujejo različno. Popravek je `aria-label`, zato
 *   pravilo raje meri cilj kot izjemo.
 * - Radix `Checkbox` se izriše kot `<button role="checkbox">`. HTML našteva
 *   `button` med labelable elementi, a brskalniška izvedba povezave z
 *   zunanjo `<label>` brez `for` ni enotna. Namesto da bi stavila na
 *   negotovo obnašanje, pravilo zahteva izrecno ime (`aria-label` /
 *   `aria-labelledby`) — rešitev, ki je noben brskalnik ne more pokvariti.
 * - Ciljna velikost se meri po EN 301 549 točki 5.6 (44 × 44 CSS px), ki jo
 *   EAA pravzaprav citira, in ne po mehkejši WCAG 2.5.8 (24 px).
 *   Repozitorij ta standard že upošteva: jezikovni preklopniki (`74dcfd5`) in
 *   alergenski čipi v `/m` (`min-h-11`).
 * - Overlay okno se javi tudi brez opisa, četudi WCAG 4.1.2 zahteva samo ime.
 *   Radix na `role="dialog"` vedno zapiše `aria-describedby` na id svojega
 *   `Description`; če `Description` ne obstaja, atribut kaže na vozlišče, ki ga
 *   v DOM ni, in Radix v konzoli javi opozorilo. Pravilo torej zahteva ali
 *   `<DialogDescription>` v notranjosti ali izrecen `aria-describedby={undefined}`.
 *
 * Kontrast (1.4.3) se ne računa iz zapisanih hex-vrednosti. Paleta se prebere
 * iz `node_modules/tailwindcss/theme.css` — `oklch()` vrednosti, ki jih
 * Tailwind v4 dejansko uporabi — in pretvori v relativno svetlost.
 * Če ozadja ni mogoče zanesljivo določiti, pravilo ne javi ničesar: lažna
 * trditev je slabša od neizmerjenega.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { lintJsxString, lintGuestRoutes, contrastRatio, GUEST_ROUTES, RULES, MIN_TARGET_PX, lintGuestCss, lintGuestStylesheet, lintCloseTargets, lintOverlayCloseTargets, type GuestA11yViolation } from './helpers/guest-a11y'

/** Kratka oblika za primerjavo: samo imena pravil, brez vrstice in sporočila. */
const rules = (vs: GuestA11yViolation[]): string[] => vs.map((v) => v.rule)

// ═══ A — dokaz, da gate zazna (mutacijski del: fixture z napako MORA pasti) ═══
describe('v1.177.0 §A1 — pravilo "name": vsak interaktiven element ima ime (4.1.2)', () => {
  it('gumb, ki ima samo ikono in brez aria-label, JAVI kršitev', () => {
    const vs = lintJsxString('<button onClick={f}><Minus className="h-4 w-4" /></button>')
    expect(rules(vs)).toEqual(['name'])
    expect(vs[0].message).toContain('Minus')
  })
  it('isti gumb z aria-label je čist', () => {
    const vs = lintJsxString('<button aria-label={t("x.manj")} onClick={f}><Minus className="h-4 w-4" /></button>')
    expect(vs).toEqual([])
  })
  it('gumb z besedilnim otrokom je čist (ime je vsebina)', () => {
    const vs = lintJsxString('<button onClick={f}>Podaj</button>')
    expect(vs).toEqual([])
  })
  it('gumb z besedilom in aria-hidden ikono je čist', () => {
    const vs = lintJsxString('<button onClick={f}><span aria-hidden="true"><Plus className="h-4 w-4" /></span>{it.name}</button>')
    expect(vs).toEqual([])
  })
  it('gumb, ki se opira samo na `title`, JAVI kršitev (hišna zahteva, strožje od 4.1.2)', () => {
    const vs = lintJsxString('<button title="Zakleni" onClick={f}><Lock className="h-5 w-5" /></button>')
    expect(rules(vs)).toEqual(['name'])
    expect(vs[0].message).toContain('title')
  })
  it('`title` kot IZRAZ (title={t("…")}) je prepoznan enako', () => {
    // /kiosk:343 ima prav to obliko — brez tega primera bi gate spregledal
    // zaklepni gumb in kršitev bi ostala neizmerjena. Gumb ima v fixture-u
    // (in v /kiosk) tudi samo dvoklikno aktivacijo, zato sta kršitvi dve.
    const vs = lintJsxString('<button title={t("guest.kiosk.lockTitle")} onDoubleClick={f}><Lock className="h-5 w-5" /></button>')
    expect(rules(vs)).toEqual(['name', 'keyboard'])
    expect(vs[0].message).toContain('title')
  })
  it('ConditionalExpression v oklepajih ne sme javiti lažnega pozitivnega', () => {
    // /pay/<token>:369 — `{paying ? (<><Loader2/>{t("pay.paying")}</>) : (…)}`.
    // Brez odvrtja oklepaja bi gate trdil, da ima plačilni gumb brez imena.
    const vs = lintJsxString('<Button className="h-14 w-full" onClick={f}>{paying ? (<><Loader2 className="h-5 w-5" />{t("pay.paying")}</>) : (<><CreditCard />{t("pay.pay")}</>)}</Button>')
    expect(vs).toEqual([])
  })
  it('Checkbox brez izrecnega imena JAVI kršitev', () => {
    const vs = lintJsxString('<label><span><Checkbox checked={c} onCheckedChange={g} /> Si</span></label>')
    expect(rules(vs)).toEqual(['name'])
  })
  it('Checkbox z aria-label je čist', () => {
    const vs = lintJsxString('<label><span><Checkbox aria-label={o.name} checked={c} onCheckedChange={g} /> {o.name}</span></label>')
    expect(vs).toEqual([])
  })
  it('kršitev sporoči pravilno vrstico fixture-a', () => {
    const vs = lintJsxString('<div>\n  <button onClick={f}><Minus /></button>\n</div>')
    expect(vs.length).toBe(1)
    expect(vs[0].line).toBe(2)
  })
})

describe('v1.177.0 §A2 — pravilo "label": vnosna polja imajo programsko določen naslov (3.3.2, 1.3.1)', () => {
  // Vsi primeri tu imajo min-h-11: pravila se morajo testirati ločeno, sicer
  // bi vsak `Input` javil še `target` in fixture ne bi več govoril o 3.3.2.
  it('Input samo s placeholder JAVI kršitev', () => {
    const vs = lintJsxString('<Input className="min-h-11" placeholder="Ime (neobvezno)" value={v} onChange={f} />')
    expect(rules(vs)).toEqual(['label'])
    expect(vs[0].message).toContain('placeholder')
  })
  it('Input z aria-label je čist', () => {
    const vs = lintJsxString('<Input className="min-h-11" aria-label={t("pay.tipCustom")} inputMode="decimal" value={v} onChange={f} />')
    expect(vs).toEqual([])
  })
  it('Input, ovit z <label>, je čist (implicitna asociacija šteje)', () => {
    const vs = lintJsxString('<label>Ime<Input className="min-h-11" value={v} onChange={f} /></label>')
    expect(vs).toEqual([])
  })
  it('Input z id in sosednjim <label htmlFor> je čist', () => {
    const vs = lintJsxString('<div><label htmlFor="resv-name">Ime</label><Input id="resv-name" className="min-h-11" value={v} onChange={f} /></div>')
    expect(vs).toEqual([])
  })
  it('vidni <label> BREZ htmlFor in Input BREZ id JAVI kršitev (pravi /m:583)', () => {
    // Besedilo je vidno, a programsko ni povezano — bralni zaslon ga pri
    // tipkovanju ne pove. To je točno ta napaka v /m in /kiosk.
    const vs = lintJsxString('<div><label className="text-xs font-medium">Opomba</label><Input className="min-h-11" value={v} onChange={f} /></div>')
    expect(rules(vs)).toEqual(['label'])
  })
  it('textarea samo s placeholder JAVI kršitev', () => {
    const vs = lintJsxString('<textarea placeholder="Komentar" rows={3} value={c} onChange={f} />')
    expect(rules(vs)).toEqual(['label'])
  })
  it('Checkbox ima svoje pravilo (name), ne podvoji se kot label', () => {
    const vs = lintJsxString('<label className="flex min-h-11 items-center"><Checkbox aria-label={o.name} checked={c} onCheckedChange={g} /> {o.name}</label>')
    expect(rules(vs).filter((r) => r === 'label')).toEqual([])
  })
})

describe('v1.177.0 §A3 — pravilo "group": skupina izbir je programsko povezana s svojim napisom (1.3.1, 3.3.2)', () => {
  it('napis <p> + mapa prek Checkbox-ov brez asociacije JAVI kršitev (pravi /kiosk:495)', () => {
    const vs = lintJsxString('<div><p className="font-semibold">{g.name}</p><div className="grid grid-cols-2">{g.options.map((o) => <label className="flex min-h-11 items-center gap-2"><Checkbox aria-label={o.name} checked={c} /><span>{o.name}</span></label>)}</div></div>')
    expect(rules(vs)).toEqual(['group'])
    expect(vs[0].message).toContain('napis')
  })
  it('isti par z fieldset/legend je čist', () => {
    const vs = lintJsxString('<fieldset><legend>{g.name}</legend><div className="grid">{g.options.map((o) => <Checkbox aria-label={o.name} checked={c} />)}</div></fieldset>')
    expect(rules(vs).filter((r) => r === 'group')).toEqual([])
  })
  it('isti par z aria-labelledby na napis je čist', () => {
    const vs = lintJsxString('<div><p id="grp1">{g.name}</p><div role="group" aria-labelledby="grp1">{g.options.map((o) => <Checkbox aria-label={o.name} checked={c} />)}</div></div>')
    expect(rules(vs).filter((r) => r === 'group')).toEqual([])
  })
  it('napis + grupa z aria-label (brez napisne povezave) je čist', () => {
    const vs = lintJsxString('<div><p>{g.name}</p><div role="group" aria-label={g.name}>{g.options.map((o) => <Checkbox aria-label={o.name} checked={c} />)}</div></div>')
    expect(rules(vs).filter((r) => r === 'group')).toEqual([])
  })
  it('napis, zapisan s komponento (`<SectionTitle/>`), se prepozna kot napis (pravi /r:244)', () => {
    const vs = lintJsxString('<section><SectionTitle icon={<Clock />} text={t("resv.public.pickTime")} /><div className="grid">{s.slots.map((x) => <button aria-pressed={a}>{x.time}</button>)}</div></section>')
    expect(rules(vs)).toEqual(['group'])
  })
  it('skupina BREZ napisa ni javljena (kategorije menija so navigacija, ne izbira)', () => {
    const vs = lintJsxString('<nav className="flex gap-2">{menu.categories.map((c) => <button onClick={f}>{c.name}</button>)}</nav>')
    expect(rules(vs).filter((r) => r === 'group')).toEqual([])
  })
})

describe('v1.177.0 §A4 — pravilo "keyboard": aktivacija je dostopna s tipkovnico (2.1.1)', () => {
  it('gumb, ki se aktivira samo z dvoklikom, JAVI kršitev (pravi /kiosk:343)', () => {
    const vs = lintJsxString('<button aria-label={t("k.lock")} onDoubleClick={f}><Lock /></button>')
    expect(rules(vs)).toEqual(['keyboard'])
    expect(vs[0].message).toContain('onDoubleClick')
  })
  it('enoklik + dvoklik je čist (tipkovnica dobi enoklik)', () => {
    const vs = lintJsxString('<button aria-label={t("k.lock")} onClick={f} onDoubleClick={f}><Lock /></button>')
    expect(rules(vs)).toEqual([])
  })
  it('klikljiv <div> JAVI kršitev (ni fokusabilen)', () => {
    const vs = lintJsxString('<div onClick={f}>Vsebina</div>')
    expect(rules(vs)).toEqual(['keyboard'])
  })
  it('klikljiv <button> je čist', () => {
    const vs = lintJsxString('<button onClick={f}>Vsebina</button>')
    expect(vs).toEqual([])
  })
  it('desniklik-samo kontekstni meni JAVI kršitev', () => {
    const vs = lintJsxString('<button aria-label="možnosti" onContextMenu={f}><More /></button>')
    expect(rules(vs)).toEqual(['keyboard'])
  })
})

describe('v1.177.0 §A5 — pravilo "target": ciljna velikost ≥ 44 × 44 px (EN 301 549 5.6)', () => {
  it('<Button> brez ownega razreda je star 36 px in JAVI kršitev', () => {
    // Osnova skupne komponente je `h-9` (src/components/ui/button.tsx:25) —
    // toutga se ne vidi v razredu gostove rute, a je dejanska velikost.
    const vs = lintJsxString('<Button onClick={f}>Plačaj</Button>')
    expect(rules(vs)).toEqual(['target'])
    expect(vs[0].message).toContain('36 px')
  })
  it('ikoni <Button size="icon"> JAVI kršitev (36 × 36 px)', () => {
    const vs = lintJsxString('<Button size="icon" onClick={f}><Plus className="h-4 w-4" /></Button>')
    expect(rules(vs)).toEqual(['name', 'target'])
    expect(vs[1].message).toContain('36 px')
  })
  it('ista ikona z h-11 w-11 je čista', () => {
    const vs = lintJsxString('<button aria-label={t("k.vec")} onClick={f} className="h-11 w-11"><Plus className="h-4 w-4" /></button>')
    expect(vs).toEqual([])
  })
  it('<Input> osnovne komponente (36 px) JAVI kršitev', () => {
    const vs = lintJsxString('<Input aria-label={t("k.token")} value={v} onChange={f} />')
    expect(rules(vs)).toEqual(['target'])
  })
  it('<Input> z min-h-11 je čist', () => {
    const vs = lintJsxString('<Input aria-label={t("k.token")} className="min-h-11" value={v} onChange={f} />')
    expect(vs).toEqual([])
  })
  it('conditional razred vzame MANJŠO vejo (element lahko izriše tudi tako)', () => {
    const vs = lintJsxString('<button aria-label={t("k.x")} onClick={f} className={a ? "h-11" : "h-8"}><Plus /></button>')
    expect(rules(vs)).toEqual(['target'])
    expect(vs[0].message).toContain('32 px')
  })
  // Checkbox se meri po `<label>`, ki ga obdaja — to je dejanski klikljivi cilj.
  it('Checkbox v `<label>` s py-2.5 JAVI kršitev (dejanski cilj je 40 px)', () => {
    const vs = lintJsxString('<label className="flex items-center gap-2 px-3 py-2.5"><Checkbox aria-label={o.name} checked={c} onCheckedChange={g} /> {o.name}</label>')
    expect(rules(vs)).toEqual(['target'])
    expect(vs[0].message).toContain('40 px')
  })
  it('isti label z min-h-11 je čist', () => {
    const vs = lintJsxString('<label className="flex min-h-11 items-center gap-2 px-3"><Checkbox aria-label={o.name} checked={c} onCheckedChange={g} /> {o.name}</label>')
    expect(vs).toEqual([])
  })
  // Native gumb nima fiksne višine iz komponente — meri se po paddingu in vsebini.
  it('native gumb z ikono se meri po paddingu + ikoni (p-2 in h-5 = 36 px)', () => {
    const vs = lintJsxString('<button type="button" aria-label={t("k.more")} onClick={f} className="p-2"><Plus className="h-5 w-5" /></button>')
    expect(rules(vs)).toEqual(['target'])
    expect(vs[0].message).toContain('višina 36 px')
    expect(vs[0].message).toContain('širina 36 px')
  })
  it('native gumb z besedilom se meri po paddingu + vrstici (py-1.5 = 32 px)', () => {
    const vs = lintJsxString('<button type="button" onClick={f} className="px-3 py-1.5">Sladice</button>')
    expect(rules(vs)).toEqual(['target'])
    expect(vs[0].message).toContain('višina 32 px')
    // širine besedila ni mogoče izmeriti — gate ne sme trditi česa, česar ne more izmeriti
    expect(vs[0].message).not.toContain('širina')
  })
  it('padding + velika ikona je lahko nad 44 px (p-2 in h-10 = 56 px)', () => {
    const vs = lintJsxString('<button type="button" aria-label={t("k.more")} onClick={f} className="p-2"><Plus className="h-10 w-10" /></button>')
    expect(vs).toEqual([])
  })
  it('explicitna višina ima prednost pred paddingom', () => {
    const vs = lintJsxString('<button type="button" aria-label={t("k.more")} onClick={f} className="min-h-11 p-2"><Plus className="h-5 w-5" /></button>')
    expect(vs).toEqual([])
  })
  it('dveh elementov z neznano mero ne ugibamo', () => {
    const vs = lintJsxString('<button type="button" aria-label={t("k.more")} onClick={f} className="p-2"><CustomIcon /></button>')
    expect(vs).toEqual([])
  })
  it('textarea se NE meri po paddingu — višino mu daje `rows`', () => {
    // /m:409 ima `rows={3}` in py-2: iz paddinga bi izšlo 36 px, v brskalniku je
    // visok tri vrstice. Lažna trditev je slabša od neizmerjenega.
    const vs = lintJsxString('<textarea id="c" aria-label={t("k.comment")} rows={3} className="px-3 py-2 text-sm" />')
    expect(vs).toEqual([])
  })
  it('gumb brez razredov (višine ni mogoče določiti) se NE meri', () => {
    // poštenje gate-a: raje neizmerjeno kot izmišljeno število
    const vs = lintJsxString('<button onClick={f}>{it.name}</button>')
    expect(vs).toEqual([])
  })
})

describe('v1.177.0 §A6 — pravilo "contrast": besedilo ima razmerje ≥ 4.5:1 (1.4.3 AA)', () => {
  it('računa iz dejanske palete: črna na beli = 21:1', () => {
    expect(contrastRatio('black', 'white')).toBeCloseTo(21, 1)
  })
  it('stone-400 na beli (2.59:1) JAVI kršitev', () => {
    const vs = lintJsxString('<div className="bg-white"><p className="text-stone-400">Alergeni</p></div>')
    expect(rules(vs)).toEqual(['contrast'])
    expect(vs[0].message).toContain('2.59')
  })
  it('stone-600 na beli (7.64:1) je čist', () => {
    const vs = lintJsxString('<div className="bg-white"><p className="text-stone-600">Alergeni</p></div>')
    expect(vs).toEqual([])
  })
  it('temna tema: stone-600 na stone-900 (2.29:1) JAVI kršitev (pravi /kiosk:343)', () => {
    const vs = lintJsxString('<div className="bg-stone-900"><p className="text-stone-600">Zakleni</p></div>')
    expect(rules(vs)).toEqual(['contrast'])
  })
  it('brez določljivega ozadja se NE javi (ne trdim, česar ne morem izračunati)', () => {
    const vs = lintJsxString('<p className="text-stone-400">Samostojni napis</p>')
    expect(vs).toEqual([])
  })
  it('mešano prosojno ozadje (bg-white/95) je nedoločljivo in se NE javi', () => {
    const vs = lintJsxString('<div className="bg-white/95"><p className="text-stone-400">x</p></div>')
    expect(vs).toEqual([])
  })
  it('veliko besedilo (≥ 24 px) šteje po 3:1', () => {
    const bad = lintJsxString('<div className="bg-white"><p className="text-red-500 text-lg">24 % popust</p></div>')
    const ok = lintJsxString('<div className="bg-white"><p className="text-red-500 text-2xl">24 % popust</p></div>')
    expect(rules(bad)).toEqual(['contrast'])
    expect(ok).toEqual([])
  })
  it('inaktivna komponenta (opacity-40) je izvzeta — WCAG 1.4.3 ne velja zanje', () => {
    const vs = lintJsxString('<div className="bg-stone-900"><button disabled className="opacity-40"><span className="text-stone-400">Razprodano</span></button></div>')
    expect(rules(vs).filter((r) => r === 'contrast')).toEqual([])
  })
  it('pogojno potemnjen starš NE izvzme besedila — element se izriše tudi brez potemnitve (pravi /m kartica jedi)', () => {
    const vs = lintJsxString('<div className="bg-white"><div className={`p-4 ${ok ? "" : "opacity-50 cursor-not-allowed"}`}><p className="text-xs text-stone-400">Alergeni</p></div></div>')
    expect(rules(vs)).toEqual(['contrast'])
  })
  it('izrecno vedno potemnjen starš pa besedilo izvzme', () => {
    const vs = lintJsxString('<div className="bg-white opacity-50"><p className="text-xs text-stone-400">Alergeni</p></div>')
    expect(rules(vs).filter((r) => r === 'contrast')).toEqual([])
  })
  it('barva se podeduje po starših, kot v CSS', () => {
    const vs = lintJsxString('<div className="bg-white text-stone-400"><p>Razpoložljivost</p></div>')
    expect(rules(vs)).toEqual(['contrast'])
  })
})

describe('v1.177.0 §A7 — pravilo "status": sporočilo o izidu je live-regija (4.1.3 AA)', () => {
  it('rdeč panel napake brez `role` JAVI kršitev', () => {
    const vs = lintJsxString('<div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">Napaka pri plačilu</div>')
    expect(rules(vs)).toEqual(['status'])
  })
  it('isti panel z role="alert" je čist', () => {
    const vs = lintJsxString('<div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">Napaka pri plačilu</div>')
    expect(vs).toEqual([])
  })
  it('zelen panel potrditve brez `role` JAVI kršitev (pravi /pay:219)', () => {
    const vs = lintJsxString('<div className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center"><h2>Hvala za plačilo</h2></div>')
    expect(rules(vs)).toEqual(['status'])
  })
  it('isti panel z role="status" je čist', () => {
    const vs = lintJsxString('<div role="status" className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center"><h2>Hvala za plačilo</h2></div>')
    expect(vs).toEqual([])
  })
  it('Badge (rounded-full) ni sporočilo o izidu in se ne javi', () => {
    const vs = lintJsxString('<div className="bg-white"><Badge className="rounded-full bg-green-100">Plačano</Badge></div>')
    expect(vs).toEqual([])
  })
})

describe('v1.177.0 §A8 — pravilo "dialog": overlay okno ima opis ali izrecno napoved brez-opisa (4.1.2)', () => {
  // Radix `DialogContent` na `role="dialog"` vedno zapiše
  // `aria-describedby={context.descriptionId}`, ne glede na to, ali `Description`
  // sploh obstaja. Brez njega atribut kaže na id, ki ga v DOM ni — bralni zaslon
  // kliče opis, ki ga ni, v produkciji pa Radix javi opozorilo (izmerjeno
  // 25. 10. 2026 v konzoli: 2× "Missing `Description` or `aria-describedby={undefined}`").
  it('overlay brez opisa in brez opt-outa je javljen', () => {
    const vs = lintJsxString('<DialogContent><DialogHeader><DialogTitle>Burek</DialogTitle></DialogHeader><p>Domač burek</p></DialogContent>')
    expect(rules(vs)).toEqual(['dialog'])
  })
  it('<DialogDescription> v notranjosti je čist (opis obstaja)', () => {
    const vs = lintJsxString('<DialogContent><DialogHeader><DialogTitle>Burek</DialogTitle><DialogDescription>Domač burek</DialogDescription></DialogHeader></DialogContent>')
    expect(vs).toEqual([])
  })
  it('aria-describedby={undefined} je izrecna napoved brez-opisa in je čist', () => {
    const vs = lintJsxString('<DialogContent aria-describedby={undefined}><DialogTitle>Burek</DialogTitle></DialogContent>')
    expect(vs).toEqual([])
  })
  it('aria-describedby="id" je povezava na tuje vozlišče in je čist', () => {
    const vs = lintJsxString('<DialogContent aria-describedby="article-note"><DialogTitle>Burek</DialogTitle></DialogContent>')
    expect(vs).toEqual([])
  })
  it('SheetContent brez opisa je javljen — to je gostov voziček', () => {
    const vs = lintJsxString('<SheetContent side="bottom"><SheetHeader><SheetTitle>Tvoja košarica</SheetTitle></SheetHeader><div>postavke</div></SheetContent>')
    expect(rules(vs)).toEqual(['dialog'])
  })
  it('navaden <div> ni overlay in se ne javi (brez lažnih javljanj)', () => {
    const vs = lintJsxString('<div className="rounded-xl p-4"><h2>Naslov</h2><p>Besedilo</p></div>')
    expect(vs).toEqual([])
  })
  it('opis v GNEZDENEM overlayu ne šteje za opis zunanjega overlaya', () => {
    const vs = lintJsxString('<SheetContent><SheetTitle>Košarica</SheetTitle><Dialog><DialogContent><DialogDescription>opis notranjega okna</DialogDescription></DialogContent></Dialog></SheetContent>')
    expect(rules(vs)).toEqual(['dialog'])
  })
  it('vrstica poročila je vrstica overlaya, ne otroka', () => {
    const vs = lintJsxString('<div>\n  <DialogContent>\n    <DialogTitle>Burek</DialogTitle>\n  </DialogContent>\n</div>')
    expect(vs.length).toBe(1)
    expect(vs[0].line).toBe(2)
  })
})

// ═══ B — vrata: merjenje na dejanski izvorni kodi ═══

describe('v1.177.0 §B — vrata gostovih strani', () => {
  it('štiri javne gostove rute so brez kršitev (vseh osem pravil)', () => {
    const vs = lintGuestRoutes()
    expect(vs.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.wcag}: ${v.message}`)).toEqual([])
  })

  it('imena merjenih pravil so zaklenjena (nov pravil mora biti najprej najavljen)', () => {
    expect(RULES).toEqual(['name', 'label', 'group', 'keyboard', 'target', 'contrast', 'status', 'dialog'])
  })

  it('vsaka gostova ruta ima vsaj eno live-regijo (4.1.3)', () => {
    const brez = GUEST_ROUTES.map((r) => ({
      ruta: r.label,
      regij: (readFileSync(r.path, 'utf8').match(/role="(alert|status)"|aria-live=/g) ?? []).length,
    })).filter((x) => x.regij < 1)
    expect(brez).toEqual([])
  })

  it('merjene osnovne mere skupnih komponent se niso spremenile (pin)', () => {
    // Pravilo "target" pozna osnovne velikosti komponent. Če se spreminjajo tu,
    // se morajo spreminjati tudi tam — sicer gate meri napačno število.
    const btn = readFileSync('src/components/ui/button.tsx', 'utf8')
    expect(btn).toContain('default: "h-9')
    expect(btn).toContain('sm: "h-8')
    expect(btn).toContain('lg: "h-10')
    expect(btn).toContain('icon: "size-9')
    expect(readFileSync('src/components/ui/input.tsx', 'utf8')).toContain('h-9')
    expect(readFileSync('src/components/ui/checkbox.tsx', 'utf8')).toContain('size-4')
    expect(MIN_TARGET_PX).toBe(44)
  })

  // — zaporna gumba skupnih overlay komponent (merjeno v brskalniku 25. 10. 2026) —
  // Gostove strani zapirata gumba z ikono X. Sta v `src/components/ui/`, ne na
  // rutah, zato ju pravilo "target" na rutah ne vidi. V brskalniku je bila
  // ciljna površina obeh 16 × 16 px — pod EN 301 549 5.6.

  it('gumb brez merljive skrinjice je javljen — pin ni prazen', () => {
    const vs = lintCloseTargets(
      '<DialogPrimitive.Close className="absolute top-4 right-4">\n  <XIcon className="size-4" />\n</DialogPrimitive.Close>\n'
    )
    expect(vs.map((v) => v.rule)).toEqual(['target'])
    expect(vs[0].message).toContain('mere ni mogoče določiti')
  })

  it('zaporni gumb 16 px je javljen z mero', () => {
    const vs = lintCloseTargets(
      '<SheetPrimitive.Close className="absolute top-4 right-4 size-4">\n  <XIcon className="size-4" />\n</SheetPrimitive.Close>'
    )
    expect(vs.length).toBe(1)
    expect(vs[0].message).toContain('16 px')
  })

  it('size-11 (44 px) je čist — ikona je lahko še vedno 16 px', () => {
    expect(
      lintCloseTargets(
        '<DialogPrimitive.Close className="absolute top-0.5 right-0.5 grid size-11 place-items-center">\n  <XIcon className="size-4" />\n</DialogPrimitive.Close>'
      )
    ).toEqual([])
  })

  it('44 × 24 px: javi se samo širina, ker je višina na meji', () => {
    const vs = lintCloseTargets('<DialogPrimitive.Close className="h-11 w-6">\n  <XIcon className="size-4" />\n</DialogPrimitive.Close>')
    expect(vs.length).toBe(1)
    expect(vs[0].message).toContain('širina 24 px')
    expect(vs[0].message).not.toContain('višina')
  })

  it('ikona, ki ne sedi v elementu, se NE javi — ne ugibamo o namenu', () => {
    expect(lintCloseTargets('<div>ločeno</div>\n<XIcon className="size-4" />')).toEqual([])
  })

  it('vrstica poročila je vrstica ovojnice, ne ikone', () => {
    const vs = lintCloseTargets('\n\n<DialogPrimitive.Close className="size-4">\n  <XIcon />\n</DialogPrimitive.Close>')
    expect(vs.length).toBe(1)
    expect(vs[0].line).toBe(3)
  })

  it('skupna zaporna gumba (dialog, sheet) imata dejansko ciljno površino ≥ 44 px (VRATA)', () => {
    const vs = lintOverlayCloseTargets()
    expect(vs.map((v) => `${v.file}:${v.line} ${v.message}`)).toEqual([])
  })
})

// ═══ C — kaskada: razred v JSX ni tisto, kar brskalnik izriše ═══

/**
 * Zakaj ta del obstaja: pravilo "target" bere `className`, kaskado pa razreši
 * brskalnik. Tailwind v4 utility razrede položi v `@layer utilities`, pravilo
 * ZUNAJ katerekoli plasti pa ima v kaskadi vedno prednost pred celotno plastjo
 * — torej pred `min-h-11`. V to se je zaletela meritev v brskalniku
 * (25. 10. 2026): `[data-screen="qr-menu"] … button { min-height: 2.5rem }` je
 * razred `min-h-11` (44 px) tiho znižal na 40 px, gate pa je to stanje napovedal
 * kot čist. Brez te varovalke bi bil vsak popravek ciljne površine, ki se naslanja
 * na razred, lahko neučinkovit in neopazen.
 *
 * Meri se samo `min-height` in `max-height`: prva prepreči, da bi bil cilj manjši,
 * druga ga stropi. Navaden `height` ni javljen, ker ga `min-height` iz utility
 * plasti vseeno prekliče (navzgor).
 */
describe('v1.177.0 §C — pravilo "cascade": ne-layered pravilo ne sme znižati gostovega cilja', () => {
  it('min-height 40 px zunaj plasti na gostovem zaslonu JAVI kršitev (pravi globals.css:653)', () => {
    const vs = lintGuestCss('[data-screen="qr-menu"] [data-region="qr-menu-categories"] button {\n  min-height: 2.5rem;\n}\n')
    expect(vs.map((v) => v.rule)).toEqual(['cascade'])
    expect(vs[0].message).toContain('40 px')
  })

  it('isto pravilo ZNOTRAJ plasti se NE javi — utility plast ga premaga', () => {
    const vs = lintGuestCss('@layer base {\n  [data-screen="qr-menu"] button { min-height: 2.5rem; }\n}\n')
    expect(vs).toEqual([])
  })

  it('44 px je meja: 2.75rem se ne javi, 2.7rem pač', () => {
    expect(lintGuestCss('[data-screen="qr-menu"] button {\n  min-height: 2.75rem;\n}\n')).toEqual([])
    expect(lintGuestCss('[data-screen="qr-menu"] button {\n  min-height: 2.7rem;\n}\n').length).toBe(1)
  })

  it('max-height 40 px JAVI kršitev — strop zniža cilj ne glede na min-height', () => {
    const vs = lintGuestCss('[data-screen="kiosk-pos"] button {\n  max-height: 40px;\n}\n')
    expect(vs.map((v) => v.rule)).toEqual(['cascade'])
  })

  it('navaden height se NE javi (min-height iz utility ga prekliče navzgor)', () => {
    expect(lintGuestCss('[data-screen="qr-menu"] button {\n  height: 2.5rem;\n}\n')).toEqual([])
  })

  it('mere, ki je ni mogoče pretvoriti v px (calc, env), se NE javijo — ne ugibamo', () => {
    expect(lintGuestCss('[data-screen="qr-menu"] button {\n  min-height: calc(var(--spacing) * 2);\n}\n')).toEqual([])
  })

  it('pravilo na ne-gostovem zaslonu (dashboard) ni v obsegu', () => {
    expect(lintGuestCss('[data-screen="dashboard"] [role="tab"] {\n  min-height: 2.125rem;\n}\n')).toEqual([])
  })

  it('pravilo znotraj @media na gostovem zaslonu JAVI kršitev (velja na ozkem ekranu)', () => {
    const vs = lintGuestCss('@media (max-width: 640px) {\n  [data-screen="kiosk-activation"] button {\n    min-height: 2rem;\n  }\n}\n')
    expect(vs.map((v) => v.rule)).toEqual(['cascade'])
  })

  it('kršitev sporoči pravilno vrstico', () => {
    const vs = lintGuestCss('a { color: red; }\n\n[data-screen="qr-menu"] button {\n  min-height: 2rem;\n}\n')
    expect(vs[0].line).toBe(4)
  })

  it('stylesheet gostovih zaslonov je brez kršitev kaskade (VRATA)', () => {
    const vs = lintGuestStylesheet()
    expect(vs.map((v) => `${v.file}:${v.line}: ${v.message}`)).toEqual([])
  })
})
