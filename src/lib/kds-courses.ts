/**
 * v1.232.0 (PRIMERJAVA-VMESNIKOV-2026 §3, Toast/Square KDS »course grouping«) —
 * GRUPIRANJE POSTAVK LISTKA PO TEČAJIH na KDS.
 *
 * Prej je listek kazal RAVEN seznam postavk z badge-om tečaja pri vsaki posebej
 * (kuhinja vidi tečaj, ne pa SKUPINE) — Toast/Square KDS postavke istega tečaja
 * združita pod eno glavo, da kuhar na prvi pogled ve, kaj gre SKUPAJ na mizo
 * (coursing: »pošlji predjedi skupaj«). To je ČISTA preslikava brez stanja:
 * skupine se izračunajo ob vsakem izrisu iz že naloženih podatkov (0 novih
 * backend poti za klienta — tečaji prihajajo aditivno na GET /api/kitchen).
 *
 * Disciplina vrstnega reda:
 *  - postavke BREZ tečaja (courseId = null) ostanejo NA ZAČETKU v obstoječem
 *    vrstnem redu (velja ne-coursing naročila: ena skupina, 0 glav → NIČ se
 *    vizualno ne spremeni — ničelna regresija za 99 % naročil brez tečajev);
 *  - tečaji sledijo po courseNumber naraščajoče (1 = predjed, 2 = glavna …);
 *  - tečaj, ki ga seznam courses ne pozna (zgodovinske/sirote), dobi glavo
 *    »Tečaj {prva števka id-ja}« — iskren prikaz, ne tiha izguba postavk.
 */

export interface KdsCourseLite {
  id: string
  courseNumber: number
  name: string
  status: string
  firedAt?: string | null
}

export interface KdsCourseGroup<T> {
  /** null = skupina postavk brez tečaja (brez glave v izrisu) */
  courseId: string | null
  /** ime tečaja (prazno za skupino brez tečaja) */
  label: string
  courseNumber: number
  /** tečaj je že poslan v pripravo (🔥 na glavi skupine) */
  fired: boolean
  items: T[]
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PRIMERJAVA §39 (v1.265.0, Square Vol 16 »Fire held courses from an Expo
 * KDS«) — EXPO POŽIG ZADRŽANIH TEČAJEV S KDS: dvotapna potrditev z
 * ODŠTEVANJEM na glavah zadržanih (pending) tečajev. Prvi tap glavo
 * OBOROŽI (jantrobna, odštevanje), drugi tap PREKLIČE, potek pa pošlje
 * POST /api/orders/[id]/fire {courseId}. Čisti client-safe deli živijo
 * TUKAJ (0 uvozov — dashboard jih deli s testi).
 * ═══════════════════════════════════════════════════════════════════════ */

/** Dolžina odštevanja potrditve (ms) — dovolj dolgo za drugi tap, dovolj
 *  kratko, da ekspeditor ne čaka. Square semantike ne narekuje števila. */
export const KDS_EXPO_FIRE_COUNTDOWN_MS = 3_000

/** Interval osveževanja prikaza odštevanja (ms) — 4× na sekundo. */
export const KDS_EXPO_FIRE_TICK_MS = 250

/**
 * Preostanek odštevanja v CELIH sekundah (3 → 2 → 1). Defenzivno (§36
 * disciplina): ne-številčen/potrjen rok → 0 (nulo nikoli ne prikažemo
 * kot »še čas« — potek poti ura ticks v dashboard učinku).
 */
export function expoFireCountdownSeconds(until: number, now: number): number {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return 0
  const remain = until - now
  if (remain <= 0) return 0
  return Math.ceil(remain / 1000)
}

/**
 * Postavke listka združi v skupine po tečaju. Če NOBENA postavka nima tečaja,
 * vrne NATANKO eno skupino (courseId = null) z vsemi postavkami v obstoječem
 * vrstnem redu — izris je potem identičen flat seznamu (brez glav).
 */
export function groupKdsItemsByCourse<T extends { courseId?: string | null }>(
  items: T[],
  courses: KdsCourseLite[],
): KdsCourseGroup<T>[] {
  if (items.length === 0) return []
  const courseById = new Map<string, KdsCourseLite>()
  for (const c of courses) courseById.set(c.id, c)
  const uncoursed: T[] = []
  const byCourseId = new Map<string, T[]>()
  for (const it of items) {
    const cid = it.courseId ?? null
    if (!cid) { uncoursed.push(it); continue }
    const bucket = byCourseId.get(cid) ?? []
    bucket.push(it)
    byCourseId.set(cid, bucket)
  }
  const groups: KdsCourseGroup<T>[] = []
  if (uncoursed.length > 0) {
    groups.push({ courseId: null, label: '', courseNumber: 0, fired: false, items: uncoursed })
  }
  // tečaji po številki; sirota (courseId brez definicije) dobi pošteno glavo
  const known = [...byCourseId.keys()]
    .map((cid) => courseById.get(cid) ?? null)
    .filter((c): c is KdsCourseLite => !!c)
    .sort((a, b) => a.courseNumber - b.courseNumber)
  for (const c of known) {
    groups.push({
      courseId: c.id,
      label: c.name || `Tečaj ${c.courseNumber}`,
      courseNumber: c.courseNumber,
      fired: c.status === 'fired' || !!c.firedAt,
      items: byCourseId.get(c.id) ?? [],
    })
  }
  // sirote: courseId, ki ga seznam tečajev ne pozna (zgodovinski podatki)
  for (const cid of byCourseId.keys()) {
    if (courseById.has(cid)) continue
    const orphans = byCourseId.get(cid) ?? []
    if (orphans.length > 0) {
      groups.push({ courseId: cid, label: `Tečaj ${cid.replace(/\D/g, '').slice(0, 3) || '?'}`, courseNumber: Number.MAX_SAFE_INTEGER, fired: false, items: orphans })
    }
  }
  return groups
}
