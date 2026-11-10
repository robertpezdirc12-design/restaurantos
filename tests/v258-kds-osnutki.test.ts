/**
 * v1.258.0 — KDS OSNUTKI LISTKOV (docs/PRIMERJAVA-VMESNIKOV-2026 §32;
 * Square Vol 13, 24. 9. 2026 »KDS draft tickets« — »preview tickets
 * as items are rung in«).
 *
 * Merjene vrzeli: (1) listek brez enega samega požiga je bil vizualno
 * enak živemu (ODPRTO ≈ POSLANO, obe nevtralni kamniti piluli — kuhar
 * ob steni ni mogel presoditi, ali je listek ŽE poslan k njim);
 * (2) odbrojevalnik/ETA/rdeča eskalacija so tekli od createdAt tudi
 * za nedotaknjene osnutke — lažni alarm med vnašanjem; (3) VRSTA pas
 * v1.233.0 je kazal samo pilule, ne pa postavk/opcij/alergenov za
 * predpripravo (prav to omogoča Square predogled).
 *
 *  A · MONTAŽA VIRA: OSNUTKI oddelek (zložljiv; privzeto ZLOŽEN =
 *    pilule v1.233.0 — kds-start-queue regija ohranjena, ničelna
 *    regresija gostote), draft veja listka (amber črtkan obroč,
 *    značka OSNUTEK namesto statusne pilule, BREZ odbrojevalnika/ETA/
 *    bump-vse, nevtralna starost postavk), izločitve iz aktivne
 *    vrste/praznega stanja/all-day vrstice, deljeni predikat
 *    kdsIsDraftOrder + kdsDraftIdSet na ravni komponente.
 *  Ž · REGISTRI: verzija 1.258.0 + compose, i18n pariteta
 *    4099/4099 (+6 kds.draft*), dokumenta §32 + AUDIT,
 *    0 DDL dokaz, 0 strežniških sprememb, worklog.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { sl } from '../src/lib/i18n/sl'
import { hr } from '../src/lib/i18n/hr'

const ROOT = process.cwd()

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

const pageSrc = read('src/app/dashboard/page.tsx')

// ── A) MONTAŽA VIRA ──

describe('v1.258.0 A1 — OSNUTKI oddelek (zložljiv, dostopnost)', () => {
  test('A1a: stanje kdsDraftsOpen, privzeto ZLOŽEN (vzorec kdsStaleOpen)', () => {
    expect(pageSrc).toContain('const [kdsDraftsOpen, setKdsDraftsOpen] = useState(false)')
  })

  test('A1b: oddelek z lastno regijo + aria-label na skupini', () => {
    expect(pageSrc).toContain('data-region="kds-drafts"')
    expect(pageSrc).toContain("aria-label={t('kds.draftSection')}")
  })

  test('A1c: preklop 44 px z aria-expanded/controls + polni opis v aria-label', () => {
    expect(pageSrc).toContain('aria-expanded={kdsDraftsOpen}')
    expect(pageSrc).toContain('aria-controls="kds-drafts-content"')
    expect(pageSrc).toContain("aria-label={t('kds.draftSectionHint')}")
    expect(pageSrc).toContain('id="kds-drafts-content"')
    // min-h-11 (44 px) na preklopu — enaka geometrija kot ZASTARELO
    const idx = pageSrc.indexOf('aria-controls="kds-drafts-content"')
    expect(idx).toBeGreaterThan(0)
    const seg = pageSrc.slice(idx, idx + 400)
    expect(seg).toContain('min-h-11')
  })

  test('A1d: števec osnutkov v glavi oddelka (isti ključ števca kot ZASTARELO)', () => {
    expect(pageSrc).toContain("tN('kds.staleCount', 'listek', kdsDraftIdSet.size)")
  })
})

describe('v1.258.0 A2 — zloženo = pilule v1.233.0 (ničelna regresija gostote)', () => {
  test('A2a: kds-start-queue regija ostaja v viru (samo v zloženem stanju)', () => {
    expect(pageSrc).toContain('data-region="kds-start-queue"')
    expect(pageSrc).toContain('{!kdsDraftsOpen && (')
  })

  test('A2b: razprto = POLNI osnutek listki — renderKdsTicket(o, true)', () => {
    expect(pageSrc).toContain('{kdsDraftsOpen && kdsIncoming.filter((o) => !isStaleKdsTicket(kdsMinutes(o.createdAt))).map((o) => renderKdsTicket(o, true))}')
  })

  test('A2c: pilule ohranjajo isti vir barvnih razredov in vsebino (v1.233.0 C3)', () => {
    expect(pageSrc).toContain('kdsAgePillCls(kdsAgeCls(qAge))')
    expect(pageSrc).toContain('qItems.reduce((s, it) => s + (it.qty || 0), 0)')
  })
})

describe('v1.258.0 A3 — draft veja listka (značka, brez lažnega časovnika)', () => {
  test('A3a: podpis renderKdsTicket nosi draft zastavico (privzeto false)', () => {
    // v1.264.0 §38: podpis aditivno razširjen s manualIdx (ročno zaporedje — ročaj/tipke)
    expect(pageSrc).toContain('const renderKdsTicket = (o: (typeof viewKitchen)[number], draft = false, manualIdx = -1) => {')
  })

  test('A3b: amber ČRTKAN obroč + bledlo (ločeno od zastarelega kamna in žive starosti)', () => {
    expect(pageSrc).toContain("draft ? 'border-dashed border-amber-300 border-l-amber-400 bg-amber-50/40'")
  })

  test('A3c: značka OSNUTEK namesto statusne pilule — ikona peska + polni namig', () => {
    expect(pageSrc).toContain('data-region="kds-draft-badge"')
    expect(pageSrc).toContain("title={t('kds.draftHint')}")
    expect(pageSrc).toContain("aria-hidden /> {t('kds.draftBadge')}")
    expect(pageSrc).toMatch(/<Hourglass className="w-3\.5 h-3\.5 shrink-0"/)
  })

  test('A3d: BREZ odbrojevalnika — pasivna amber starost vnosa namesto MM:SS obljube', () => {
    expect(pageSrc).toContain('data-region="kds-draft-age"')
    expect(pageSrc).toContain("title={t('kds.draftWaiting')}")
    expect(pageSrc).toContain("t('kds.draftAge', { m: ageMin })")
    // odbrojevalnik živi SAMO v ne-draft veji (ternary za pasivnim čipom)
    const idx = pageSrc.indexOf('data-region="kds-draft-age"')
    const seg = pageSrc.slice(idx, idx + 900)
    expect(seg).toContain(') : (')
    expect(seg).toContain('<KdsCountdownPill')
  })

  test('A3e: BREZ ETA — obljuba priprave se začne s pošiljanjem, ne z vpisom', () => {
    const idx = pageSrc.indexOf('data-region="kds-ticket-eta"')
    expect(idx).toBeGreaterThan(0)
    const before = pageSrc.slice(Math.max(0, idx - 700), idx)
    expect(before).toContain('if (draft) return null')
  })

  test('A3f: BREZ bump-vse — osnutek je predogled, ne dejanje (posamezne tap-karte ostanejo)', () => {
    const idx = pageSrc.indexOf('data-region="kds-bump-all"')
    expect(idx).toBeGreaterThan(0)
    const before = pageSrc.slice(Math.max(0, idx - 700), idx)
    expect(before).toContain('if (draft) return null')
  })

  test('A3g: starost postavke v draft veji NEVTRALNA (brez rdeče eskalacije)', () => {
    expect(pageSrc).toContain("draft ? 'bg-amber-50 text-amber-800 border-amber-300'")
  })
})

describe('v1.258.0 A4 — izločitve + deljeni predikat (en vir resnice)', () => {
  test('A4a: predikat kdsIsDraftOrder na ravni komponente — per pogled postaje, vsi PENDING', () => {
    expect(pageSrc).toContain('const kdsIsDraftOrder = (o: (typeof viewKitchen)[number]): boolean => {')
    expect(pageSrc).toContain("its.every((it) => it.status === 'PENDING')")
  })

  test('A4b: množica id-jev izloči zastarele osnutke (ZASTARELO ostane revizijska veja)', () => {
    expect(pageSrc).toContain('viewKitchen.filter((o) => kdsIsDraftOrder(o) && !isStaleKdsTicket(kdsMinutes(o.createdAt))).map((o) => o.id)')
  })

  test('A4c: aktivna vrsta šteje SAMO kuhanje — kdsActiveLive izloči osnutke', () => {
    expect(pageSrc).toContain('const kdsActiveLive = kdsActive.filter((o) => !kdsDraftIdSet.has(o.id))')
    // v1.264.0 §38: izris teče iz kdsManualList (default način = kdsActiveLive ISTA referenca;
    //    manual = applyManualTicketOrder nad ISTO množico — osnutki ostanejo izločeni)
    expect(pageSrc).toContain('const kdsManualList = kdsTicketOrder === \'manual\'')
    expect(pageSrc).toContain('renderKdsTicket(o, false, i)')
  })

  test('A4d: prazno stanje »kuhinja čista« ne šteje osnutkov', () => {
    expect(pageSrc).toContain('!kdsDraftIdSet.has(o.id)).length === 0 && (')
  })

  test('A4e: all-day vrstica šteje samo DELO (živi + mešani + zastareli)', () => {
    expect(pageSrc).toContain('.filter((o) => !kdsDraftIdSet.has(o.id) && o.items.some((it) => !it.voided')
  })
})

// ── Ž) REGISTRI ──

describe('v1.258.0 Ž — registri', () => {
  test('Ž1: verzija 1.258.0 + compose oznaka', () => {
    expect(APP_VERSION).toBe('1.293.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.293.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.293.0')
  })

  test('Ž2: i18n pariteta SL/HR 4099/4099 (+6 kds.draft*)', () => {
    for (const k of [
      'kds.draftSection', 'kds.draftSectionHint', 'kds.draftBadge',
      'kds.draftHint', 'kds.draftWaiting', 'kds.draftAge',
    ]) {
      expect(sl[k as keyof typeof sl]).toBeTruthy()
      expect(hr[k as keyof typeof hr]).toBeTruthy()
    }
    const slCount = Object.keys(sl).length
    const hrCount = Object.keys(hr).length
    expect(slCount).toBe(4324)
    expect(hrCount).toBe(4324)
  })

  test('Ž3: dokumenta — PRIMERJAVA §32 + AUDIT POSODOBITEV + števci', () => {
    const doc = read('docs/PRIMERJAVA-VMESNIKOV-2026.md')
    expect(doc).toContain('## 32.')
    expect(doc).toContain('KDS OSNUTNI LISTKI')
    expect(doc).toContain('draft tickets')
    const auditDoc = read('docs/RESTAURANTOS-AUDIT.md')
    expect(auditDoc).toContain('v1.258.0')
    expect(auditDoc).toContain('- 4324 ključev SL in 4324 HR')
  })

  test('Ž4: 0 DDL + 0 strežniških sprememb — čista klientna plast nad obstoječo cevjo', () => {
    const schema = read('prisma/schema.prisma')
    // 0 DDL dokaz: noben nosilec osnutka v shemi (»draft« kot statusna vrednost
    // nabave/kampanj je PREDZGODOVINSKA in ni nosilec tega vala — vzorec §31 Ž4:
    // ciljno ime polja, ne beseda)
    expect(schema).not.toContain('draftTicket')
    expect(schema).not.toContain('DraftTicket')
    expect(schema).not.toContain('isDraft')
    // kuhinjska vrsta ŽE nosi pending postavke (ITEM_ACTIVE_DB) — val ne doda
    // strežniških polj: ruta /api/kitchen ostaja brez pojma osnutka
    const kitchenRoute = read('src/app/api/kitchen/route.ts')
    expect(kitchenRoute).not.toContain('osnutek')
    expect(kitchenRoute).not.toContain('OSNUTEK')
    expect(kitchenRoute).not.toContain('kdsDraft')
    // oddelek je čisti izris nad viewKitchen (isti SSE/polling vir kot doslej)
    expect(pageSrc).toContain('viewKitchen.filter((o) => kdsIsDraftOrder(o)')
  })

  test('Ž5: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.293.0-demo-real-auditlog-pisatelji')
  })
})
