/**
 * Guest-a11y gate — pomožno orodje testov v1.177.0 (`tests/v177-guest-a11y.test.ts`).
 *
 * NI produkcijska koda: živi v `tests/helpers/` (isto kot `fixture-sweep.ts` in
 * `workflow.ts`) in se izvaja samo med testiranjem.
 *
 * Datoteke se parsirajo z TypeScriptovim JSX parserjem, ne z regexi, da pravila
 * berejo resnično drevo (starši, otroci, `aria-hidden` poddrevesa).
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export type A11yRule = 'name' | 'label' | 'group' | 'keyboard' | 'target' | 'contrast' | 'status' | 'dialog' | 'cascade'

/**
 * Pravila, ki berejo JSX. Seznam je del dogovora: novo pravilo mora imeti svoj
 * fixture, preden ga dodamo sem. `cascade` NI na tem seznamu, ker ne bere
 * komponent ampak kaskado stylesheeta (`lintGuestCss`).
 */
export const RULES: A11yRule[] = ['name', 'label', 'group', 'keyboard', 'target', 'contrast', 'status', 'dialog']

export interface GuestA11yViolation {
  rule: A11yRule
  /** WCAG oziroma EN točka, ki jo kršitev prizadene (za sporočilo in za dokumentacijo). */
  wcag: string
  file: string
  line: number
  message: string
}

/** Interaktivni elementi, ki morajo biti razumljivi z imenom (4.1.2). */
const NAMED_CONTROLS = new Set(['button', 'Button', 'Checkbox'])
/** Vnosne kontrole — zanje 3.3.2 zahteva programsko določen naslov, ne samo imena. */
const FORM_CONTROLS = new Set(['Input', 'input', 'textarea', 'Textarea', 'Select', 'select'])

interface Ctx {
  file: string
  out: GuestA11yViolation[]
  /** Vrednosti `htmlFor` vseh `<label>` v datoteki (asociacija je lahko tudi vzdolžna). */
  labelTargets: Set<string>
  /** Vsi `id` v datoteki — za preverjanje `aria-labelledby` povezav. */
  ids: Set<string>
}

/** Atributi odprte oznake kot mapa ime → vrednost (string literal ali izraz). */
function attrMap(open: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Map<string, ts.Expression | string | null> {
  const m = new Map<string, ts.Expression | string | null>()
  for (const p of open.attributes.properties) {
    if (ts.isJsxSpreadAttribute(p)) continue
    const name = p.name.getText().replace(/^jsxs?:/, '')
    if (!p.initializer) m.set(name, null)
    else if (ts.isStringLiteral(p.initializer)) m.set(name, p.initializer.text)
    else m.set(name, (p.initializer as ts.JsxExpression).expression ?? null)
  }
  return m
}

function tagName(open: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return open.tagName.getText()
}

function explicit(a: Map<string, ts.Expression | string | null>, k: string): boolean {
  const v = a.get(k)
  return v !== undefined && v !== null && v !== ''
}

/**
 * Ali poddrevo izriše besedilo, ki je na voljo kot ime. Podrovesa z
 * `aria-hidden="true"` se ne štejejo — bralni zaslon jih preskoči.
 */
function rendersText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0
  if (ts.isJsxExpression(node)) return node.expression ? exprYieldsText(node.expression) : false
  if (ts.isJsxElement(node)) {
    if (isHidden(node.openingElement)) return false
    return node.children.some(rendersText)
  }
  if (ts.isJsxFragment(node)) return node.children.some(rendersText)
  return false
}

function isHidden(open: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return attrMap(open).get('aria-hidden') === 'true'
}

/** Izraz v `{…}`: šteje kot besedilo, razen če je (samo) vrnjen element brez besedila. */
function exprYieldsText(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return exprYieldsText(e.expression)
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return true
  if (ts.isIdentifier(e) || ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return true
  if (ts.isConditionalExpression(e)) return exprYieldsText(e.whenTrue) || exprYieldsText(e.whenFalse)
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) {
      return exprYieldsText(e.right)
    }
    return true
  }
  if (ts.isJsxElement(e)) return e.children.some(rendersText)
  if (ts.isJsxFragment(e)) return e.children.some(rendersText)
  if (ts.isJsxSelfClosingElement(e)) return false
  return false
}

/** Komponente med neposrednimi otroki (za sporočilo: katere ikone so v gumbu). */
function childComponentTags(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): string[] {
  const kids = ts.isJsxSelfClosingElement(node) ? [] : node.children
  const out: string[] = []
  const push = (t: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void => {
    const name = tagName(t)
    if (/^[A-Z]/.test(name)) out.push(name)
  }
  for (const k of kids) {
    if (ts.isJsxExpression(k) && k.expression) {
      const e = k.expression
      if (ts.isJsxSelfClosingElement(e)) push(e)
      else if (ts.isJsxElement(e)) push(e.openingElement)
    } else if (ts.isJsxElement(k)) push(k.openingElement)
    else if (ts.isJsxSelfClosingElement(k)) push(k)
  }
  return out
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function checkName(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  const tag = tagName(open)
  if (!NAMED_CONTROLS.has(tag)) return
  const a = attrMap(open)
  if (explicit(a, 'aria-label') || explicit(a, 'aria-labelledby')) return
  const explicitTitle = a.has('title') && a.get('title') !== null && a.get('title') !== ''
  if (ts.isJsxElement(node) && node.children.some(rendersText)) return
  const icons = ts.isJsxElement(node) ? childComponentTags(node) : []
  const what = icons.length ? `vsebina so ikone (${icons.map((i) => `<${i}>`).join(' ')})` : 'vsebina je prazna'
  ctx.out.push({
    rule: 'name',
    wcag: '4.1.2 (A)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `<${tag}> brez dostopnega imena — ${what}${explicitTitle ? ', naslon samo na `title` (hišna zahtevnost: na dotični napravi nikoli viden)' : ''}. Dodaj aria-label.`,
  })
}

/**
 * 3.3.2 / 1.3.1: vnosna kontrola mora imeti NASLOV, ne samo imena.
 * Veljajo: `aria-label`, `aria-labelledby`, `id` + `<label htmlFor>` in
 * implicitna asociacija (kontrola je otrok `<label>`). `placeholder` sam
 * NI naslov — WCAG ga izrecno našteva med napakami 3.3.2, ker izgine, ko
 * gost začne tipkati.
 */
function checkLabel(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement, ancestors: Anc[]): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  const tag = tagName(open)
  if (!FORM_CONTROLS.has(tag)) return
  const a = attrMap(open)
  if (explicit(a, 'aria-label') || explicit(a, 'aria-labelledby')) return
  const id = a.get('id')
  if (typeof id === 'string' && ctx.labelTargets.has(id)) return
  if (ancestors.some((x) => x.tag === 'label')) return
  const ph = a.get('placeholder')
  const phText = typeof ph === 'string'
    ? ` — ima samo placeholder "${ph}"`
    : ph !== undefined && ph !== null ? ' — ima samo placeholder' : ''
  ctx.out.push({
    rule: 'label',
    wcag: '3.3.2 (A)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `<${tag}> brez programske določenega naslova${phText}. Dodaj label+htmlFor/id ali aria-label.`,
  })
}

// ── pravilo "group" ──────────────────────────────────────────────────────────

const CONTROL_TAGS = new Set(['button', 'Button', 'Checkbox', 'Input', 'input', 'textarea'])
const CAPTION_TAGS = new Set(['p', 'span', 'label', 'h2', 'h3', 'h4', 'strong', 'legend'])

interface Anc {
  tag: string
  attrs: Map<string, ts.Expression | string | null>
  node: ts.Node
}

/**
 * Ali v poddrevesu obstaja `.map()`, ki izriše kontrole — generator skupine.
 * Isče se po celem poddrevesu, da najde mapo tudi v veji
 * `{a ? (<p/>) : (<div>{x.map(…)}</div>)}` (pravi `/r/<token>:245`).
 */
function mappedControls(node: ts.Node): boolean {
  let found = false
  const probe = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'map') {
      if (rendersControlInside(n)) found = true
    }
    n.forEachChild(probe)
  }
  probe(node)
  return found
}

function rendersControlInside(n: ts.Node): boolean {
  if (ts.isJsxElement(n) && CONTROL_TAGS.has(tagName(n.openingElement))) return true
  if (ts.isJsxSelfClosingElement(n) && CONTROL_TAGS.has(tagName(n))) return true
  let hit = false
  n.forEachChild((c) => { if (rendersControlInside(c)) hit = true })
  return hit
}

/** Ali element (ali njegov edini vsebinski otrok) izriše samo besedilo — napis skupine. */
function isCaption(el: ts.JsxElement): boolean {
  const tag = tagName(el.openingElement)
  if (tag.endsWith('Title')) return true // `<SectionTitle …/>`-tip sestavine napisa
  if (!CAPTION_TAGS.has(tag)) return false
  const a = attrMap(el.openingElement)
  if (CONTROL_TAGS.has(tag) || explicit(a, 'aria-hidden')) return false
  return el.children.some(rendersText) && !rendersControlInside(el)
}

/**
 * Ali ima grupa že programsko ime. Šteje:
 * - `aria-label`,
 * - `aria-labelledby` na id, ki v datoteki res obstaja (sicer povezava ni nobena),
 * - `aria-labelledby` z izrazom (npr. `` `grp-${g.id}` ``) — identifikatorja ni
 *   mogoče razrešiti statično, a zapis je nedvoumna namera povezave,
 * - znotraj `<fieldset>` (legend ga poimenuje po HTML pravilih, ne po našem
 *   branju razredov).
 */
function groupIsNamed(self: Anc, ancestors: Anc[], ids: Set<string>): boolean {
  if (explicit(self.attrs, 'aria-label')) return true
  const lb = self.attrs.get('aria-labelledby')
  if (typeof lb === 'string') return ids.has(lb)
  if (lb !== undefined && lb !== null) return true
  return ancestors.some((x) => x.tag === 'fieldset')
}

/** Kateri otrok je napis skupine (vidni tekst brez kontrol)? */
function isCaptionChild(k: ts.Node): boolean {
  if (ts.isJsxElement(k)) return isCaption(k)
  if (ts.isJsxSelfClosingElement(k)) return !isHidden(k) && tagName(k).endsWith('Title')
  return false
}

/**
 * 1.3.1: skupina kontrol, generirana iz sezname, mora biti programsko povezana
 * s svojim napisom.
 *
 * Napis NI znotraj grupe — v obeh dejanskih primerih (`/kiosk:494`, `/r:244`,
 * `/pay:320`) je njegov brat, grupa pa je naslednji sorojen element ali kar
 * starš, kadar mapa stoji neposredno v njem. Zato se vzorec išče v seznamu
 * otrok STARŠA: napis, nato element (ali izraz) s kontrolnim `map()`.
 */
function checkGroup(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement, ancestors: Anc[]): void {
  const kids = node.children.filter((k) => !(ts.isJsxText(k) && k.text.trim() === ''))
  const captionIdx = kids.findIndex((k) => isCaptionChild(k))
  if (captionIdx < 0) return
  const caption = kids[captionIdx]
  // <legend> neposredno v <fieldset> je nativna asociacija
  if (ts.isJsxElement(caption) && tagName(caption.openingElement) === 'legend' && tagName(node.openingElement) === 'fieldset') return
  for (let i = captionIdx + 1; i < kids.length; i++) {
    const k = kids[i]
    let open: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null
    if (ts.isJsxElement(k) && mappedControls(k)) open = k.openingElement
    else if (ts.isJsxSelfClosingElement(k) && mappedControls(k)) open = k
    else if (ts.isJsxExpression(k) && k.expression && mappedControls(k.expression)) open = node.openingElement
    if (!open) continue
    if (groupIsNamed({ tag: tagName(open), attrs: attrMap(open) }, ancestors, ctx.ids)) return
    ctx.out.push({
      rule: 'group',
      wcag: '1.3.1 (A)',
      file: ctx.file,
      line: lineOf(sf, open),
      message: 'skupina kontrol se generira z map() za napisom, a ni programsko povezana z njim (napis ostane bran samo vizualno). Uporabi fieldset+legend ali role="group" z aria-labelledby.',
    })
    return
  }
}

// ── pravilo "target" (EN 301 549 točka 5.6 / WCAG 2.5.5) ─────────────────────

/** Izvirna Tailwind v4 paleta — edini vir barv za pravilo "contrast". */
const THEME_CSS = 'node_modules/tailwindcss/theme.css'

const TARGET_CONTROLS = new Set(['button', 'Button', 'Checkbox', 'Input', 'input', 'textarea'])
export const MIN_TARGET_PX = 44
/** Tailwind v4 razmik: `--spacing: .25rem` → `h-11` = 44 px. */
const SPACING_PX = 4
/** Osnovne višine skupne komponente — vir `src/components/ui/button.tsx` (pin §B2). */
const BUTTON_PX: Record<string, number> = { sm: 32, default: 36, lg: 40, icon: 36 }
/** `src/components/ui/input.tsx`: `flex h-9`. */
const INPUT_PX = 36
/** `src/components/ui/checkbox.tsx`: `size-4`; meri se njen klikljivi `<label>`. */
const CHECKBOX_PX = 16
/** Privzeta višina besedilne vrstice pri 16 px pisavi (osnova za oceno `<label>`). */
const LINE_BOX_PX = 20

/** Vsi razredi atributa `className` — tudi znotraj conditional/template. */
function classText(a: Map<string, ts.Expression | string | null>, key = 'className'): string {
  const v = a.get(key)
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  return v.getText()
}

/** Razredi kot seznam žetonov (template in conditional prispevajo vse veje). */
function tokens(text: string): string[] {
  return text.split(/[\s`'"{}[\]()]+/).filter(Boolean)
}

/** `11` → 44 px; `[44px]` → 44; `[2.75rem]` → 44; sicer null. */
function numPx(v: string): number | null {
  const ar = /^\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(v)
  if (ar) return Number(ar[1]) * (ar[2] === 'rem' ? 16 : 1)
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v) * SPACING_PX
  return null
}

/**
 * Razložljiva skrinjica iz razredov. Kadar je dimenzija podana večkrat
 * (conditional po stanju), se vzame MIN — element lahko izriše tudi tisto
 * manjšo vrednost, zato je trditev "pod 44 px" drži v vsakem stanju.
 */
function boxFromClasses(text: string): { h?: number; w?: number; padY?: number; padX?: number } {
  let h: number | undefined
  let w: number | undefined
  let padY: number | undefined
  let padX: number | undefined
  const min = (cur: number | undefined, v: number) => (cur === undefined ? v : Math.min(cur, v))
  const max = (cur: number | undefined, v: number) => (cur === undefined ? v : Math.max(cur, v))
  for (const tok of tokens(text)) {
    let m: RegExpExecArray | null
    if ((m = /^(?:min-)?h-(.+)$/.exec(tok))) { const px = numPx(m[1]); if (px !== null) h = min(h, px); continue }
    if ((m = /^(?:min-)?w-(.+)$/.exec(tok))) { const px = numPx(m[1]); if (px !== null) w = min(w, px); continue }
    if ((m = /^size-(.+)$/.exec(tok))) { const px = numPx(m[1]); if (px !== null) { h = min(h, px); w = min(w, px) } continue }
    if ((m = /^p-(.+)$/.exec(tok)) || (m = /^py-(.+)$/.exec(tok))) { const px = numPx(m[1]); if (px !== null) padY = max(padY, px) }
    if ((m = /^p-(.+)$/.exec(tok)) || (m = /^px-(.+)$/.exec(tok))) { const px = numPx(m[1]); if (px !== null) padX = max(padX, px) }
  }
  return { h, w, padY, padX }
}

/** Ali ima kakšen otrok (vključno z ikono) določljivo fiksno višino? */
function hasSizedElementChild(node: ts.Node): boolean {
  let hit = false
  const probe = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const b = boxFromClasses(classText(attrMap(n)))
      if (b.h !== undefined) hit = true
    }
    n.forEachChild(probe)
  }
  node.forEachChild(probe)
  return hit
}

/**
 * Vsebina native gumba, kadar višine ni podano z razredom: `<button>` nima
 * fiksne osnove kot `<Button>`, njegovo skrinjico sestavita padding in
 * neposredna vsebina. Besedilni otrok prispeva vrstico (20 px), element
 * prispeva svojo določljivo mero. Nekateremu elementu mere določiti ne
 * morem (`<CustomIcon />` brez razredov) ali pa je gumb prazen — vrnem null
 * in pravilo ne javi ničesar, namesto da bi javilo izmišljeno število.
 * Širina se šteje samo pri ikonskih gumbih: besedila brez metrik pisave ne
 * moremo oceniti.
 */
function buttonContent(node: ts.JsxElement): { h: number; w: number | null } | null {
  const kids = node.children.filter((k) => !(ts.isJsxText(k) && k.text.trim() === ''))
  if (kids.length === 0) return null
  let h = 0
  let w: number | null = 0
  for (const k of kids) {
    if (ts.isJsxText(k) || (ts.isJsxExpression(k) && rendersText(k))) {
      h = Math.max(h, LINE_BOX_PX)
      w = null
      continue
    }
    const open = ts.isJsxElement(k) ? k.openingElement : ts.isJsxSelfClosingElement(k) ? k : null
    if (!open || isHidden(open)) continue
    const b = boxFromClasses(classText(attrMap(open)))
    if (b.h === undefined) return null
    h = Math.max(h, b.h)
    if (w !== null) w = Math.max(w, b.w ?? b.h)
  }
  return { h, w }
}

function checkTarget(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement, ancestors: Anc[]): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  const tag = tagName(open)
  if (!TARGET_CONTROLS.has(tag)) return
  const a = attrMap(open)
  const box = boxFromClasses(classText(a))
  let h = box.h
  let w = box.w

  if (tag === 'Checkbox') {
    // Radix osnova je 16 px, a dejanska ciljna površina je `<label>`, ki ga
    // obdaja. Če ga ni, se meri kar kontrola sama.
    const lab = ancestors.filter((x) => x.tag === 'label').pop()
    if (h === undefined && w === undefined && lab) {
      const lb = boxFromClasses(classText(lab.attrs))
      if (lb.h !== undefined) { h = lb.h; w = undefined }
      else if (lb.padY !== undefined && !hasSizedElementChild(lab.node)) { h = lb.padY * 2 + LINE_BOX_PX; w = undefined }
      else return // mere ni mogoče določiti — ne trdim nečesa, česar ne morem izračunati
    } else if (h === undefined && w === undefined) {
      h = CHECKBOX_PX
      w = CHECKBOX_PX
    }
  } else if (h === undefined && w === undefined) {
    if (tag === 'Button') {
      const size = typeof a.get('size') === 'string' ? String(a.get('size')) : 'default'
      h = BUTTON_PX[size] ?? BUTTON_PX.default
      if (size === 'icon') w = h
    } else if (tag === 'Input') {
      h = INPUT_PX
    } else if (tag === 'button' && (box.padY !== undefined || box.padX !== undefined) && ts.isJsxElement(node)) {
      // native gumb brez `h-`/`w-`: skrinjico sestavita padding in vsebina
      const content = buttonContent(node)
      if (!content) return
      if (box.padY !== undefined) h = box.padY * 2 + content.h
      if (box.padX !== undefined && content.w !== null) w = box.padX * 2 + content.w
    }
    // `button` / `input` / `textarea` brez razredov: višine ni mogoče
    // določiti (odvisna je od vsebine in privzetih stilov brskalnika) — se ne meri.
    else return
  }

  const under = (v: number | undefined, dim: string) =>
    v !== undefined && v < MIN_TARGET_PX ? `${dim} ${v} px` : null
  const bad = [under(h, 'višina'), under(w, 'širina')].filter(Boolean)
  if (!bad.length) return
  ctx.out.push({
    rule: 'target',
    wcag: 'EN 301 549 5.6 / 2.5.5',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `<${tag}>: ciljna velikost je ${bad.join(' in ')} — pod 44 × 44 px. Dodaj min-h-11 (oz. h-11 w-11 pri ikoni).`,
  })
}

// ── pravilo "contrast" (WCAG 1.4.3 AA) ───────────────────────────────────────

/**
 * Paleta se bere iz `node_modules/tailwindcss/theme.css` — iz `oklch()` vrednosti,
 * ki jih Tailwind v4 dejansko izdaja, ne iz predpostavljenih hex tabel.
 * Razred, ki ga v paleti ni (`text-foreground`, `text-[#123456]`), je
 * nedoločljiv in pravilo zanj ne javi ničesar.
 */
let paletteCache: Map<string, number> | null = null

function oklchToLuminance(l: number, c: number, hDeg: number): number {
  const hr = (hDeg * Math.PI) / 180
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638528358 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const [lr, mg, sb] = [l_ ** 3, m_ ** 3, s_ ** 3]
  const R = 4.0767416621 * lr - 3.3077115913 * mg + 0.2309699292 * sb
  const G = -1.2684380046 * lr + 2.6097574011 * mg - 0.3413193965 * sb
  const B = -0.0041960863 * lr - 0.7034186147 * mg + 1.707614701 * sb
  // relativna svetlost se računa iz LINEARNIH vrednosti (brez gamma kode)
  return 0.2126 * clamp01(R) + 0.7152 * clamp01(G) + 0.0722 * clamp01(B)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hexToLuminance(hex: string): number | null {
  const m = /^#(?:([0-9a-f]{3}|[0-9a-f]{6}))$/i.exec(hex)
  if (!m) return null
  let s = m[1]
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  const chan = (i: number) => parseInt(s.slice(i, i + 2), 16) / 255
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(chan(0)) + 0.7152 * lin(chan(2)) + 0.0722 * lin(chan(4))
}

function palette(): Map<string, number> {
  if (paletteCache) return paletteCache
  const out = new Map<string, number>()
  const css = readFileSync(THEME_CSS, 'utf8')
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) {
    const value = m[2].trim()
    const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
    if (ok) { out.set(m[1], oklchToLuminance(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3]))); continue }
    const lum = hexToLuminance(value)
    if (lum !== null) out.set(m[1], lum)
  }
  paletteCache = out
  return out
}

/** Razmerje med dvema razrednima barvnima žetonoma (`stone-400`, `white`). */
export function contrastRatio(fg: string, bg: string): number | null {
  const p = palette()
  const f = p.get(fg)
  const b = p.get(bg)
  if (f === undefined || b === undefined) return null
  const [hi, lo] = f > b ? [f, b] : [b, f]
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_PX: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 }

/**
 * Najbližji barvni razred v verigi (`text-…` ali `bg-…`). Žeton, ki ga v
 * paleti ni (`text-foreground`, `bg-transparent`), ni barva in se preskoči;
 * mešana prosovnost (`bg-white/95`) vrne null — usklajene barve ni mogoče
 * izračunati in nočem trditi razmerja, ki ga ni.
 */
function nearestColor(chain: string[], kind: 'text' | 'bg'): string | null {
  const p = palette()
  const re = new RegExp(`^${kind}-(.+)$`)
  for (const cls of chain) {
    for (const tok of tokens(cls)) {
      if (tok.includes(':')) continue
      const m = re.exec(tok)
      if (!m) continue
      if (m[1].includes('/')) return null
      if (p.has(m[1])) return m[1]
    }
  }
  return null
}

/** WCAG "veliki tekst": ≥ 24 px ali ≥ 18.66 px krepko (za njega zadostuje 3:1). */
function isLargeText(px: number, bold: boolean): boolean {
  return px >= 24 || (px >= 18.66 && bold)
}

const OPACITY_EXEMPT = /^opacity-(?:0|10|20|30|40|50)$/

/**
 * Ali razred SAM vedno potemni element. Pogojni zapis (`${ok ? '' : 'opacity-50'}`)
 * lahko izriše tudi brez potemnitve — takrat element NI neaktivna komponenta,
 * zato izvzetje 1.4.3 ne velja.
 */
function alwaysFaded(cls: string): boolean {
  if (!tokens(cls).some((t) => OPACITY_EXEMPT.test(t))) return false
  return !/[?$]/.test(cls)
}

const WEIGHT_TOKENS = /^(?:font)-(bold|extrabold|black|semibold|medium|normal|light)$/
const BOLD_WEIGHTS = new Set(['bold', 'extrabold', 'black'])

function firstToken(chain: string[], re: RegExp): RegExpExecArray | null {
  for (const cls of chain) {
    for (const tok of tokens(cls)) {
      if (tok.includes(':')) continue
      const m = re.exec(tok)
      if (m) return m
    }
  }
  return null
}

/** Ali element SAM izriše besedilo (neposredni otrok), ne samo prek potomcev. */
function hasOwnText(node: ts.JsxElement): boolean {
  return node.children.some((k) =>
    ts.isJsxText(k) ? k.text.trim().length > 0 : ts.isJsxExpression(k) && k.expression ? exprYieldsText(k.expression) : false
  )
}

/**
 * 1.4.3: besedilo, ki ga element izriše neposredno. Barva, velikost in
 * debelina se podedujejo po starših, kot v CSS — velja NAJBLIŽJI zapis. Če
 * katere koli strani enačbe ni mogoče določiti, se ne javi ničesar.
 */
function checkContrast(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement, ancestors: Anc[]): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  if (attrMap(open).get('aria-hidden') === 'true') return
  if (attrMap(open).has('disabled')) return
  // veriga: najprej sam element, nato starši od najbližjega navzven
  const chain = [classText(attrMap(open)), ...ancestors.slice().reverse().map((x) => classText(x.attrs))]
  if (chain.some((cls) => alwaysFaded(cls))) return
  if (!ts.isJsxElement(node) || !hasOwnText(node)) return

  const fg = nearestColor(chain, 'text')
  const bg = nearestColor(chain, 'bg')
  if (!fg || !bg) return
  const ratio = contrastRatio(fg, bg)
  if (ratio === null) return
  const size = firstToken(chain, /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)$/)
  const weight = firstToken(chain, WEIGHT_TOKENS)
  const px = size ? TEXT_PX[size[1]] : 16
  const bold = weight ? BOLD_WEIGHTS.has(weight[1]) : false
  const need = isLargeText(px, bold) ? 3 : 4.5
  if (ratio >= need) return
  ctx.out.push({
    rule: 'contrast',
    wcag: '1.4.3 (AA)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `text-${fg} na bg-${bg}: razmerje ${ratio.toFixed(2)}:1 pod ${need}:1 (${px} px${bold ? ', krepko' : ''}). Uporabi temnejši odtenek (stone-600 / red-600).`,
  })
}

// ── pravilo "status" (WCAG 4.1.3) ────────────────────────────────────────────

/** Panelni markerji, ki v teh poteh kodirajo izid (napaka / potrditev). */
const OUTCOME_PANELS = ['bg-red-50', 'bg-red-100', 'bg-green-50', 'bg-green-100']
const ANNOUNCED_ROLES = new Set(['alert', 'status', 'log', 'alertdialog'])

function checkStatus(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement): void {
  const open = node.openingElement
  const tag = tagName(open)
  if (!['div', 'section'].includes(tag)) return
  const cls = tokens(classText(attrMap(open)))
  if (!cls.some((t) => OUTCOME_PANELS.includes(t))) return
  if (cls.some((t) => t === 'rounded-full' || t.startsWith('rounded-2xl-full'))) return // oznaka (badge), ne panel
  if (!node.children.some(rendersText)) return
  const a = attrMap(open)
  const role = a.get('role')
  if (typeof role === 'string' && ANNOUNCED_ROLES.has(role)) return
  if (explicit(a, 'aria-live') || explicit(a, 'role')) return
  ctx.out.push({
    rule: 'status',
    wcag: '4.1.3 (AA)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: 'panel, ki sporoča izid (napaka ali potrditev), ni live-regija — bralni zaslon ga ob zaznani spremembi ne pove. Dodaj role="alert" (napaka) ali role="status" (potrditev).',
  })
}


// ── pravilo "dialog" (WCAG 4.1.2) ────────────────────────────────────────────

/**
 * Overlay komponenti, ki jima Radix sam doda `aria-describedby`. Imena so
 * končnice, ker ju rute uvažajo pod različnimi imeni (`DialogContent`,
 * `DialogPrimitive.Content`).
 */
const OVERLAY_TAGS = ['DialogContent', 'SheetContent']
/** Komponenti, ki v notranjosti overlaya štejeta kot opis. */
const DESCRIPTION_TAGS = ['DialogDescription', 'SheetDescription']

const isOverlayTag = (tag: string): boolean => OVERLAY_TAGS.some((t) => tag.endsWith(t))
const isDescriptionTag = (tag: string): boolean => DESCRIPTION_TAGS.some((t) => tag.endsWith(t))

/**
 * Ali overlay v svoji vsebini izriše opis. V gnezdenem overlayu se ne
 * ogleduje: opis notranjega okna ni opis zunanjega.
 */
function rendersDescription(node: ts.JsxElement): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const open = ts.isJsxElement(n) ? n.openingElement : n
      const tag = tagName(open)
      if (isOverlayTag(tag)) return
      if (isDescriptionTag(tag)) { found = true; return }
    }
    n.forEachChild(visit)
  }
  node.children.forEach(visit)
  return found
}

/**
 * `DialogContent` in `SheetContent` (sheet je Radix-ov dialog) na `role="dialog"`
 * VEDNO zapišeta `aria-describedby={context.descriptionId}`, ne glede na to, ali
 * `Description` sploh obstaja. Brez njega torej atribut kaže na id, ki ga v DOM
 * ni, bralni zaslon kliče opis, ki ga ni, Radix pa v konzoli javi opozorilo.
 * Odprava je ali opis v notranjosti ali izrecna napoved brez-opisa z
 * `aria-describedby={undefined}` — to drugo je dokumentirana Radix-ova pot.
 */
function checkDialog(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  const tag = tagName(open)
  if (!isOverlayTag(tag)) return
  if (attrMap(open).has('aria-describedby')) return
  if (ts.isJsxElement(node) && rendersDescription(node)) return
  ctx.out.push({
    rule: 'dialog',
    wcag: '4.1.2 (A)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `<${tag}> izriše "aria-describedby", a v notranjosti ni <DialogDescription>/<SheetDescription> — kazalec kaže na vozlišče, ki ga ni (bralni zaslon kliče opis, ki ne obstaja). Dodaj opis ali izrecno "aria-describedby={undefined}".`,
  })
}

// ── pravilo "keyboard" ───────────────────────────────────────────────────────

const POINTER_ONLY = ['onDoubleClick', 'onContextMenu', 'onMouseDown', 'onMouseUp']
const KEYBOARD_OK = ['onClick', 'onKeyDown', 'onKeyUp', 'onKeyPress']
const NON_INTERACTIVE = new Set(['div', 'span', 'p', 'li', 'img', 'tr', 'td', 'section', 'article', 'td', 'ul', 'ol'])

function checkKeyboard(sf: ts.SourceFile, ctx: Ctx, node: ts.JsxElement | ts.JsxSelfClosingElement): void {
  const open = ts.isJsxElement(node) ? node.openingElement : node
  const tag = tagName(open)
  const a = attrMap(open)
  const interactive = NAMED_CONTROLS.has(tag) || tag === 'a' || tag === 'Button'
  if (interactive) {
    const pointer = POINTER_ONLY.filter((p) => a.has(p))
    if (!pointer.length) return
    if (KEYBOARD_OK.some((k) => a.has(k))) return
    ctx.out.push({
      rule: 'keyboard',
      wcag: '2.1.1 (A)',
      file: ctx.file,
      line: lineOf(sf, open),
      message: `<${tag}> se aktivira samo z ${pointer.map((p) => `"${p}"`).join(' / ')} — tipkovnica te poti nima (Enter ne sproži dvoklika).`,
    })
    return
  }
  if (!NON_INTERACTIVE.has(tag)) return
  if (!a.has('onClick') && !a.has('onMouseDown')) return
  if (explicit(a, 'role') || explicit(a, 'tabIndex')) return
  ctx.out.push({
    rule: 'keyboard',
    wcag: '2.1.1 (A)',
    file: ctx.file,
    line: lineOf(sf, open),
    message: `<${tag}> ima "onClick", a ni interaktiven element — ni fokusabilen in tipkovnica ga ne doseže. Uporabi <button> ali dodaj vlogo + tipkovno obravnavo.`,
  })
}

function walk(sf: ts.SourceFile, ctx: Ctx, node: ts.Node, ancestors: Anc[]): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const open = ts.isJsxElement(node) ? node.openingElement : node
    checkName(sf, ctx, node)
    checkLabel(sf, ctx, node, ancestors)
    checkKeyboard(sf, ctx, node)
    checkTarget(sf, ctx, node, ancestors)
    checkContrast(sf, ctx, node, ancestors)
    checkDialog(sf, ctx, node)
    if (ts.isJsxElement(node)) {
      checkGroup(sf, ctx, node, ancestors)
      checkStatus(sf, ctx, node)
    }
    ancestors = ancestors.concat({ tag: tagName(open), attrs: attrMap(open), node })
  }
  node.forEachChild((c) => walk(sf, ctx, c, ancestors))
}

/** Predhodni hod: `htmlFor` in `id`, ker je lahko povezava drugje v drevesu. */
function collectRefs(node: ts.Node, ctx: Pick<Ctx, 'labelTargets' | 'ids'>): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const open = ts.isJsxElement(node) ? node.openingElement : node
    const a = attrMap(open)
    if (tagName(open) === 'label') {
      const forr = a.get('htmlFor')
      if (typeof forr === 'string') ctx.labelTargets.add(forr)
    }
    const id = a.get('id')
    if (typeof id === 'string') ctx.ids.add(id)
  }
  node.forEachChild((c) => collectRefs(c, ctx))
}

function lintSource(code: string, file: string): GuestA11yViolation[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const ctx: Ctx = { file, out: [], labelTargets: new Set(), ids: new Set() }
  collectRefs(sf, ctx)
  walk(sf, ctx, sf, [])
  return ctx.out
}

/**
 * Fixture testov: surov JSX se ovije v komponento, da je sintaktično veljavno
 * TSX gradivo. Vrstične številke ostanejo poravnane, ker se vsebina začne na
 * prvi vrstici ovitega vira.
 */
export function lintJsxString(code: string, opts?: { file?: string }): GuestA11yViolation[] {
  return lintSource(`const __f = () => (<>${code}</>)`, opts?.file ?? 'fixture.tsx')
}

/**
 * Javne gostove rute — seznam je del dogovora: dodati peto rut pomeni dodati
 * jo sem in s tem razširiti merjenje (in ne tiho vzmetiti treh).
 * `label` je pot, pod katero poroča kršitve.
 */
export const GUEST_ROUTES: { path: string; label: string }[] = [
  { path: 'src/app/m/[token]/page.tsx', label: '/m/<token> (QR meni)' },
  { path: 'src/app/kiosk/page.tsx', label: '/kiosk (terminal)' },
  { path: 'src/app/pay/[token]/page.tsx', label: '/pay/<token> (plačilna povezava)' },
  { path: 'src/app/r/[token]/page.tsx', label: '/r/<token> (rezervacija)' },
]

/** Celotna datoteka (gostova ruta v `src/`). */
export function lintGuestFile(path: string, label = basename(path)): GuestA11yViolation[] {
  return lintSource(readFileSync(path, 'utf8'), label)
}

/** Vse štiri javne gostove rute. */
export function lintGuestRoutes(root = process.cwd()): GuestA11yViolation[] {
  const out: GuestA11yViolation[] = []
  for (const r of GUEST_ROUTES) out.push(...lintGuestFile(`${root}/${r.path}`, r.label))
  return out
}

// ── pravilo "cascade" (EN 301 549 5.6 skozi kaskado) ─────────────────────────

/**
 * Gostovi zasloni. `data-screen` je sidro, s katerim `globals.css` posebej
 * oblikuje javne strani; seznam ostane poravnan z `GUEST_ROUTES` ( `/pay` in
 * `/r` svojega zaslona nimata, zato zanju kaskada ne more skriti razreda).
 */
export const GUEST_SCREENS = ['qr-menu', 'kiosk-pos', 'kiosk-activation']

/** Stylesheet, v katerem ležijo regionalna pravila gostovih zaslonov. */
export const GUEST_STYLESHEET = 'src/app/globals.css'

/**
 * Edini lastnosti, ki lahko znižata dejansko ciljno površino: `min-height`
 * prepreči, da bi bil cilj manjši, `max-height` pa ga stropi. Navaden `height`
 * ni merjen, ker ga `min-height` iz utility plasti vseeno dvigne navzgor.
 */
const CASCADE_PROPS = new Set(['min-height', 'max-height'])

/** `px` in `rem` sta merljivi; vse ostalo (calc, em, env) je nedoločljivo. */
function pxValue(raw: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(raw)
  if (!m) return null
  return Math.round(parseFloat(m[1]) * (m[2] === 'rem' ? 16 : 1) * 100) / 100
}

interface CssFrame {
  kind: 'rule' | 'block'
  /** Ali deklaracijo ovija `@layer` — znotraj plasti jo utility razred premaga. */
  layer: boolean
  sel: string
}

/**
 * Kaskadna plast gate-a. `target` bere `className`, izriše pa se kaskada:
 * Tailwind v4 utility položi v `@layer utilities`, pravilo ZUNAJ katerekoli
 * plasti pa ima prednost pred celo plastjo. Deklaracija na gostovem zaslonu,
 * ki je ni mogoče uvrstiti v plast, zato lahko tiho zniži cilj, ki ga je
 * popravka dotaknil z razredom — in gate bi to stanje napovedal kot čist.
 */
export function lintGuestCss(css: string, file = 'globals.css'): GuestA11yViolation[] {
  const out: GuestA11yViolation[] = []
  // Komentarji lahko vsebujejo oklepaje in podpičja; izpraznijo se, vrstice ostanejo.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const stack: CssFrame[] = []
  let buf = ''
  let line = 1

  const guestScreenIn = (sel: string): string | null => {
    for (const s of GUEST_SCREENS) {
      if (sel.includes(`[data-screen="${s}"]`) || sel.includes(`[data-screen='${s}']`) || sel.includes(`[data-screen=${s}]`)) return s
    }
    return null
  }

  const flush = (endLine: number): void => {
    const top = stack[stack.length - 1]
    const decl = buf
    buf = ''
    if (!top || top.kind !== 'rule') return
    const sep = decl.indexOf(':')
    if (sep < 0) return
    const prop = decl.slice(0, sep).trim().toLowerCase()
    if (!CASCADE_PROPS.has(prop)) return
    const value = decl.slice(sep + 1).trim().replace(/!important$/i, '').trim()
    const px = pxValue(value)
    if (px === null || px >= MIN_TARGET_PX) return
    const screen = guestScreenIn(top.sel)
    if (!screen || top.layer) return
    const body = decl.trim()
    const startLine = endLine - (body.match(/\n/g) ?? []).length
    out.push({
      rule: 'cascade',
      wcag: 'EN 301 549 5.6 (kaskada)',
      file,
      line: startLine,
      message: `Pravilo zunaj plasti nastavi ${prop}: ${value} na zaslonu «${screen}» (${top.sel}), v kaskadi pa premaga utility razred — cilj se izriše pri ${px} px. Daj pravilo v plast (@layer) ali ga dvigni na vsaj ${MIN_TARGET_PX} px.`,
    })
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\n') { line++; buf += ch; continue }
    if (ch === '{') {
      const prelude = buf.trim()
      buf = ''
      const outer = stack.length ? stack[stack.length - 1].layer : false
      if (/^@layer\b/i.test(prelude)) stack.push({ kind: 'block', layer: true, sel: prelude })
      else if (prelude.startsWith('@')) stack.push({ kind: 'block', layer: outer, sel: prelude })
      else stack.push({ kind: 'rule', layer: outer, sel: prelude })
      continue
    }
    if (ch === '}') { flush(line); stack.pop(); buf = ''; continue }
    if (ch === ';') { flush(line); buf = ''; continue }
    buf += ch
  }
  return out
}

/** Dejanski stylesheet gostovih zaslonov (vrata). */
export function lintGuestStylesheet(path = GUEST_STYLESHEET): GuestA11yViolation[] {
  return lintGuestCss(readFileSync(path, 'utf8'), path)
}

// ── zaporni gumbi skupnih overlay komponent (EN 301 549 5.6) ─────────────────

/**
 * `dialog.tsx` in `sheet.tsx` se uporabljata hkrati na gostovih straneh in pri
 * osebju. Njun zaporni gumb ni native `<button>` ampak Radix ovojnica
 * (`<DialogPrimitive.Close>` / `<SheetPrimitive.Close>`), ki jo pravilo "target"
 * ne pozna — v DOM-u pa je pravi gumb in gostje ga tipkajo. Zato se njegova
 * skrinjica meri posebej.
 */
export const OVERLAY_COMPONENTS = ['src/components/ui/dialog.tsx', 'src/components/ui/sheet.tsx']

/** Zaporni gumbi se prepoznavajo po ikoni, ki v njem sedi. */
const CLOSE_ICON = /<XIcon\b/g

/** `className="…"` ali `className={cn(…)}`; brez razredov vrne prazno. */
function classAttrOf(openTag: string): string {
  const m = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(openTag)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

/**
 * Skrinjica zapornega gumba se meri samo iz njegovih LASTNIH razredov. Ikona
 * (`size-4`) ostane 16 px — to je vizualni znak, ne ciljna površina. Če razredi
 * skrinjice ne določajo, je to kršitev: pri teh dveh poznanih komponentah se
 * eksplicitna mera zahteva, namesto da bi ugibali, kaj izriše brskalnik.
 */
export function lintCloseTargets(code: string, file = 'dialog.tsx'): GuestA11yViolation[] {
  const out: GuestA11yViolation[] = []
  for (const m of code.matchAll(CLOSE_ICON)) {
    const lt = code.lastIndexOf('<', m.index - 1)
    if (lt < 0) continue
    const openTag = code.slice(lt, m.index).replace(/\s+$/, '').replace(/>$/, '')
    if (openTag.indexOf('<', 1) >= 0) continue // ikona ne sedi v elementu (zapiralna oznaka, fragment)
    const name = /^<([A-Za-z][\w.]*)/.exec(openTag)?.[1]
    if (!name) continue
    const box = boxFromClasses(classAttrOf(openTag))
    const bad = [
      box.h !== undefined && box.h < MIN_TARGET_PX ? `višina ${box.h} px` : null,
      box.w !== undefined && box.w < MIN_TARGET_PX ? `širina ${box.w} px` : null,
    ].filter(Boolean)
    if (box.h === undefined || box.w === undefined) bad.push('mere ni mogoče določiti iz razredov')
    if (!bad.length) continue
    out.push({
      rule: 'target',
      wcag: 'EN 301 549 5.6 / 2.5.5',
      file,
      line: code.slice(0, lt).split('\n').length,
      message:
        `<${name}>: zaporna površina — ${bad.join(' in ')}. Pod 44 × 44 px. ` +
        `Gumb naj ima svojo skrinjico size-11 (44 px), ikona naj ostane 16 px, na sredini (grid place-items-center).`,
    })
  }
  return out
}

/** Dejanski skupni komponenti (vrata). */
export function lintOverlayCloseTargets(files = OVERLAY_COMPONENTS): GuestA11yViolation[] {
  const out: GuestA11yViolation[] = []
  for (const f of files) out.push(...lintCloseTargets(readFileSync(f, 'utf8'), f))
  return out
}
