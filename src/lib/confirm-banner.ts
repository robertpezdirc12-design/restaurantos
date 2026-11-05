/**
 * v1.255.0 — CONFIRMATION BANNER (docs/PRIMERJAVA-VMESNIKOV-2026 §29;
 * Lightspeed »Order view confirmation banner« — What's New hub, november 2026).
 *
 * Merjena situacija: pet dejanj v NaročiloSheetu in plačilnem dialogu je
 * uspelo TIHO — pošiljanje dodatka obstoječemu naročilu (sendSheetItems),
 * streljanje vseh pending postavk (fireSheetAll), streljanje posameznega
 * tečaja (fireCourse), dodelitev postavke h tečaju (assignCourse) in ročni
 * popust pod pragom (applyManualDiscount, direktna pot). Napake se seveda
 * prikažejo (toast destructive), uspeh pa NE — osebje vodi izmeno »na
 * slepo« in ne ve, ali je kuhinja sploh dobila tek. Lightspeed je to
 * izmeril želeti: »The order view now has a confirmation banner at the top
 * of the screen when a task is complete. Every discount added, sequence
 * completed or course fired will be clear so staff can manage their shifts
 * with confidence.«
 *
 * Ta lib je ČIST SLOJ modela potrditve (0 uvozov iz db/api — enaka
 * disciplina kot live-check/report-views): builderji sestavijo model
 * ConfirmBanner, ki ga ConfirmBanner komponenta izriše na vrhu pogleda.
 * Zapis dejanja se NE spremeni — banner je čisti POVRATNI odziv po
 * uspešnem strežniškem odgovoru (avtoriteta ostaja API + revizije).
 *
 * Defenzivna disciplina: vsi vhodi se normalizirajo (števila ≥ 0 celo,
 * zneski r2 ≥ 0, imena trim + kap dolžine); manjkajoči podatek pomeni
 * IZPUSTEN detail, ne lažni ničli. Nov banner vedno zamenja starega
 * (eno-mestni povratni odziv — zastoj vrst ni zaščitni znak POS).
 */
// ── Model ──

/** Vrsta potrjenega dejanja (določa i18n ključ naslova). */
export type ConfirmBannerKind =
  | 'fire-all' // streljanje VSEH pending postavk naročila (sheet.fire)
  | 'fire-course' // streljanje posameznega tečaja (samo te tekme gijo v kuhinjo)
  | 'course-assign' // dodelitev postavke h tečaju (coursing)
  | 'add-items' // dodatek obstoječemu naročilu (PATCH addItems)
  | 'discount' // ročni popust uporabljen (direktna pot, pod pragom izjem)

/** Model ene potrditve (zamenja morebitno prejšnjo). */
export interface ConfirmBanner {
  /** vrsta dejanja → cb.<kind> naslov */
  kind: ConfirmBannerKind
  /** število postavk (fire-all / add-items); ≥ 0 celo */
  count?: number
  /** zaporedna številka tečaja (fire-course / course-assign); ≥ 1 */
  courseNumber?: number
  /** ime tečaja (fire-course / course-assign); trim, kap 60 */
  courseName?: string
  /** ime popusta (discount); trim, kap 60 */
  discountName?: string
  /** znesek popusta v EUR (discount); r2 ≥ 0 */
  amount?: number
  /** čas potrditve (epoch ms) — izpis HH:MM:SS v komponenti */
  at: number
}

/** Avto-odpad bannerja (ms). 6 s — dovolj za dve vrstici, ne zadržuje pogleda. */
export const CONFIRM_BANNER_MS = 6000

/** Kap dolžine imen (tečaj/popust) v bannerju — enak prag kot Course ime (60). */
const NAME_CAP = 60

/** Defenzivni celoštevilski count ≥ 0 (NaN/negativno/necelo → 0). */
function normCount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.floor(v)
}

/** Defenzivna r2 vsota ≥ 0 (NaN/negativno → 0; sicer round na 2 decimalki). */
function normAmount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.round(v * 100) / 100
}

/** Defenzivno ime: trim + kap; prazno → undefined (detail se čisto izpusti). */
function normName(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined
  const t = s.trim()
  if (!t) return undefined
  return t.length > NAME_CAP ? t.slice(0, NAME_CAP - 1) + '…' : t
}

/** Defenzivna številka tečaja ≥ 1 (NaN/<1 → undefined; detail brez številke). */
function normCourseNumber(n: unknown): number | undefined {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v < 1) return undefined
  return Math.floor(v)
}

// ── Builderji ──

/** Streljanje vseh pending postavk: »Poslano v kuhinjo · N postavk«. */
export function fireAllBanner(count: unknown): ConfirmBanner {
  return { kind: 'fire-all', count: normCount(count), at: Date.now() }
}

/** Streljanje posameznega tečaja: »Tek poslan · Tek št. N · ime«. */
export function fireCourseBanner(courseNumber: unknown, courseName: unknown): ConfirmBanner {
  const num = normCourseNumber(courseNumber)
  const name = normName(courseName)
  if (num === undefined && name === undefined) {
    // brez številke IN imena ni poštenega detaila — banner z golim naslovom
    return { kind: 'fire-course', at: Date.now() }
  }
  return { kind: 'fire-course', ...(num !== undefined ? { courseNumber: num } : {}), ...(name !== undefined ? { courseName: name } : {}), at: Date.now() }
}

/** Dodelitev postavke h tečaju: »Dodeljeno h tečaju · Tečaj št. N · ime«. */
export function courseAssignBanner(courseNumber: unknown, courseName: unknown): ConfirmBanner {
  const num = normCourseNumber(courseNumber)
  const name = normName(courseName)
  if (num === undefined && name === undefined) {
    return { kind: 'course-assign', at: Date.now() }
  }
  return { kind: 'course-assign', ...(num !== undefined ? { courseNumber: num } : {}), ...(name !== undefined ? { courseName: name } : {}), at: Date.now() }
}

/** Dodatek obstoječemu naročilu: »Dodatek zapisan · N novih postavk«. */
export function addItemsBanner(count: unknown): ConfirmBanner {
  return { kind: 'add-items', count: normCount(count), at: Date.now() }
}

/** Ročni popust uporabljen: »Popust uporabljen · ime · −znesek«. */
export function discountBanner(discountName: unknown, amount: unknown): ConfirmBanner {
  const name = normName(discountName)
  const amt = normAmount(amount)
  return { kind: 'discount', ...(name !== undefined ? { discountName: name } : {}), ...(amt > 0 ? { amount: amt } : {}), at: Date.now() }
}

// ── i18n preslikava (ključi cb.* v sl/hr slovarjih) ──

/** Naslov bannerja po vrsti dejanja (cb.<kind>). */
export function bannerTitleKey(b: ConfirmBanner): string {
  return `cb.${b.kind}`
}

/**
 * Parametri detail vrstice po vrsti dejanja (ključ cb.<kind>Detail;
 * parametri so ŽE normalizirani v builderju — tukaj samo preslikava).
 */
export function bannerDetailParams(b: ConfirmBanner): Record<string, string | number> {
  switch (b.kind) {
    case 'fire-all':
    case 'add-items':
      return { n: b.count ?? 0 }
    case 'fire-course':
    case 'course-assign':
      return { n: b.courseNumber ?? 0, name: b.courseName ?? '' }
    case 'discount':
      return { name: b.discountName ?? '', amount: (b.amount ?? 0).toFixed(2).replace('.', ',') }
  }
}

/** Ali banner nosi detail vrstico (false → samo naslov, brez prazne vrstice). */
export function hasBannerDetail(b: ConfirmBanner): boolean {
  switch (b.kind) {
    case 'fire-all':
    case 'add-items':
      return true // count je vedno definiran (≥ 0); N=0 je iskrena informacija
    case 'fire-course':
    case 'course-assign':
      return b.courseNumber !== undefined || b.courseName !== undefined
    case 'discount':
      return b.discountName !== undefined || (b.amount ?? 0) > 0
  }
}
