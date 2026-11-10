import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { APP_VERSION } from '../src/lib/version'
import { slNoun, slCount, SL_NOUNS } from '../src/lib/fmt'
import { canRedeem, validateTopUpCents, validateIssueCents, GC_TOPUP_MAX_CENTS, type GcCardShape } from '../src/lib/giftcards'
import { validatePriceOverrideInput, MAX_PRICE_OVERRIDE_EUR } from '../src/lib/price-override'
import { bookingConfirmationText, reminderText, type ReminderTarget } from '../src/lib/reminders'
import { validateSlot, WIDGET_POLICY_DEFAULTS, type WidgetPolicy, type DayHoursInput } from '../src/lib/reservation-slots'

/**
 * v1.278.0 — LIB NIZI: zneski v sl-SI obliki + slovenske množinske oblike v
 * UPORABNIŠKO VIDNIH nizih sloja src/lib (doktrina issue #71 — slepa pega MED
 * obsegom v1.276 (src/components + src/app brez api/) in v1.277 (src/app/api/):
 * sporočila čistih knjižnic so izpisovala zneske s SUROVO PIKO (»5.00 €«) in
 * trdo kodirane rodilnike (»1 oseb«, »1 dni«) — ista družina nedoslednosti.
 *
 * REKONOS (svež pregled, 3 kandidati): (A) mini-services (print-agent,
 * sync-service) — 0 uporabniško vidnih zneskov (raw ESC/POS most; edini
 * toFixed je tehnični dnevnik joba) → ne vrzel; (B) uporabniško vidni nizi v
 * src/lib — ZADETEK: 19 mest zneskov/števil s surovo piko (giftcards ×3,
 * price-override, einvoice-validate ×3, ap-match ×6, furs/issue ×1 (5 zneskov),
 * push ×2, delivery-webhook, terminal, ap-attachments) + 6 mest trdo kodiranih
 * množin (delivery-webhook postavk, reminders oseb ×2 SMS, stock-transfer
 * postavk, reservation-slots dni — ŽIVA NAPAKA pri maxAdvanceDays 1/2,
 * payroll dni) + NOV backend samostalnik 'dan' v SL_NOUNS; (C) lokalni
 * vejico-helperji (payroll eur, receipt money, timeclock, menu-dup,
 * confirm-banner, app strani fmt) — PRAVILNA oblika (vejica), izven greha →
 * negativno pripeti v Č3 (družina v1.276 »tisk/gost helperji vejico že«).
 *
 * ARHITEKTURA: isti čisti sloj src/lib/fmt.ts (v1.277) — fmtEUR za zneske z €,
 * fmtFixedSI za enotsko-proste zneske z ohranjeno semantiko decimaln,
 * fmtNumSI za količine/stopnje, slCount za števnike z besedo. e-poštni sloj
 * (daily-email/hourly-email) ostaja NEDOTIČN (dokumentirana pika+EUR, pin
 * v277 Č3); CSV izvozi pika (v1.276); strojne oblike (FURS/CIS XML, ZOI,
 * eslog xsd:decimal, settle details) ostajajo s piko — vse allowlist v Č3.
 *
 *  · Č1 — vedenje čistih funkcij: slNoun/slCount 'dan' (NOV), canRedeem
 *    razlog z vejico + NBSP, validateTopUpCents/validateIssueCents,
 *    validatePriceOverrideInput meja, reminders SMS množice 1/2/5,
 *    validateSlot maxAdvanceDays 1/2/30 (živa napaka »1 dni« popravljena)
 *  · Č2 — pini vseh spremenjenih mest (13 datotek: fmt/giftcards/
 *    price-override/einvoice-validate/ap-match/furs-issue/push/
 *    delivery-webhook/terminal/ap-attachments/reminders/stock-transfer/
 *    reservation-slots/payroll)
 *  · Č3 — negativni sken src/lib (surovi toFixed v predlogah + trdo kodirane
 *    množine) + poštene izjeme natanko naštete (allowlist)
 *  · Ž · REGISTRI: verzija 1.278.0, worklog vrh Task ID, AUDIT POSODOBITEV,
 *    i18n števci 4320/4320, 0 DDL, fmt.ts čisti sloj 0 uvozov + 6 samostalnikov
 */

const ROOT = process.cwd()
const NBSP = ' ' // U+00A0 — fmtEUR NBSP pred € (lekcija v276/v277)

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8')
}

// ── Č1) VEDENJE — čiste funkcije ──

describe('v1.278.0 Č1 — vedenje: dan množina + lib sporočila z vejico', () => {
  test('slNoun dan: 4 oblike (1 dan / 2 dneva / 3 dni / 5 dni; 3/4 in 5+ oblika isti »dni«)', () => {
    expect([1, 2, 3, 4, 5].map((n) => slNoun(n, 'dan'))).toEqual(['dan', 'dneva', 'dni', 'dni', 'dni'])
    expect(slNoun(0, 'dan')).toBe('dni')
    expect(slNoun(21, 'dan')).toBe('dni') // le 1 ima ednino (vzorec pluralForm .n)
  })

  test('slCount dan: 1 dan / 2 dneva / 30 dni (reservation-slots sporočilo)', () => {
    expect(slCount(1, 'dan')).toBe('1 dan')
    expect(slCount(2, 'dan')).toBe('2 dneva')
    expect(slCount(30, 'dan')).toBe('30 dni')
  })

  test('SL_NOUNS: dan je BACKEND samostalnik (v slovarjih NE obstaja — kot kos; doc-truth inverz)', () => {
    expect(Object.keys(SL_NOUNS)).toContain('dan')
    const sl = read('src/lib/i18n/sl.ts')
    expect(sl).not.toContain("'noun.dan.")
  })

  test('canRedeem premalo salda: razlog z vejico + NBSP (ne surova pika)', () => {
    const card: GcCardShape = { cardNumber: 'GC-20260101-000001', status: 'active', balanceCents: 500, expiresAt: '2030-01-01' }
    const r = canRedeem(card, 3000, new Date('2026-01-02T12:00:00Z'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain(`samo 5,00${NBSP}€`)
      expect(r.reason).toContain(`manjka 25,00${NBSP}€`)
      expect(r.reason).not.toContain('5.00')
    }
  })

  test('validateTopUpCents/validateIssueCents meja: 5.000,00 € z vejico (>1000 ICU tolerantno)', () => {
    expect(validateTopUpCents(GC_TOPUP_MAX_CENTS + 1)).toMatch(/^Največje polnjenje je 5.?000,00 €\.$/)
    expect(validateIssueCents(GC_TOPUP_MAX_CENTS + 1, null, new Date())).toMatch(/^Največji začetni saldo je 5.?000,00 €\.$/)
  })

  test('validatePriceOverrideInput meja: 99.999,99 € z vejico (>1000 ICU tolerantno; EUR → € uskladitev s push telesom v1.277)', () => {
    const r = validatePriceOverrideInput({ price: MAX_PRICE_OVERRIDE_EUR + 1, reason: 'test' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^Cena presega zgornjo mejo 9.?9.?999,99 €\.$/)
  })

  test('reminders SMS množine: oklepajni nominativ (1 oseba / 2 osebi / 5 oseb — »za« zahteva akuzativ, vzorec preoblikbe v1.277 storno)', () => {
    const t = (partySize: number): ReminderTarget => ({
      guestName: 'Ana Horvat', restaurantName: 'Gostilna Pri Lipi', when: new Date('2026-11-20T18:00:00Z'), partySize,
    })
    expect(bookingConfirmationText(t(1), 'sl').sms).toContain('(1 oseba).')
    expect(bookingConfirmationText(t(2), 'sl').sms).toContain('(2 osebi).')
    expect(bookingConfirmationText(t(5), 'sl').sms).toContain('(5 oseb).')
    expect(reminderText(t(1), 'sl').sms).toContain('(1 oseba).')
    expect(reminderText(t(3), 'sl').sms).toContain('(3 osebe).')
    // HR ostaja nedotaknen (»os.« okrajšava, izven obsega — vzorec v1.277)
    expect(bookingConfirmationText(t(2), 'hr').sms).toContain('za 2 os.')
  })

  test('validateSlot maxAdvanceDays: 1 dan / 2 dneva / 30 dni (ŽIVA NAPAKA »1 dni« popravljena)', () => {
    const hours: DayHoursInput = {
      rows: Array.from({ length: 7 }, (_, dow) => ({
        dayOfWeek: dow, openTime: '10:00', closeTime: '22:00', breakStart: '', breakEnd: '', isClosed: false,
      })),
      specials: [],
    }
    const check = (maxAdvanceDays: number) => validateSlot(
      { ...WIDGET_POLICY_DEFAULTS, maxAdvanceDays } as WidgetPolicy, hours, '2026-12-15', '19:00', 2,
      new Date('2026-11-09T10:00:00Z'), [], 10, 'Europe/Ljubljana',
    )
    const r1 = check(1)
    expect(r1.ok).toBe(false)
    if (!r1.ok) {
      expect(r1.code).toBe('date_out_of_range')
      expect(r1.message).toBe('Rezervacije so možne največ 1 dan vnaprej.')
    }
    const r2 = check(2)
    if (!r2.ok) expect(r2.message).toContain('največ 2 dneva vnaprej')
    const r30 = check(30)
    if (!r30.ok) expect(r30.message).toContain('največ 30 dni vnaprej')
  })
})

// ── Č2) PINI — vsa spremenjena mesta ──

describe('v1.278.0 Č2 — pini mest: 13 datotek lib sloja', () => {
  test('fmt.ts: SL_NOUNS ima 6 samostalnikov (dan dodan, racun/vrstica/postavka/oseba ostanejo ≡ slovarjem)', () => {
    const s = read('src/lib/fmt.ts')
    expect(s).toContain("dan: ['dan', 'dneva', 'dni', 'dni'],")
    expect(Object.keys(SL_NOUNS).length).toBe(6)
  })

  test('giftcards.ts: fmtEUR ×4 (samo/manjka/polnjenje/saldo) — ne surovi toFixed', () => {
    const s = read('src/lib/giftcards.ts')
    expect(s).toContain('`Na kartici je samo ${fmtEUR(card.balanceCents / 100)} — manjka ${fmtEUR((amountCents - card.balanceCents) / 100)}.`')
    expect(s).toContain('`Največje polnjenje je ${fmtEUR(GC_TOPUP_MAX_CENTS / 100)}.`')
    expect(s).toContain('`Največji začetni saldo je ${fmtEUR(GC_TOPUP_MAX_CENTS / 100)}.`')
    expect(s).not.toContain('.toFixed(2)} €')
  })

  test('price-override.ts: fmtEUR meja (EUR → €, usklajeno s push telesom v1.277)', () => {
    const s = read('src/lib/price-override.ts')
    expect(s).toContain('`Cena presega zgornjo mejo ${fmtEUR(MAX_PRICE_OVERRIDE_EUR)}.`')
    expect(s).not.toContain('EUR.`')
  })

  test('einvoice-validate.ts: fmtFixedSI ×3 sporočila (DDV vrstica, neto glava, DDV glava — ohranjena semantika 2 decimalk)', () => {
    const s = read('src/lib/einvoice-validate.ts')
    expect(s).toContain('`Vrstica ${n}: DDV ${fmtFixedSI(declared, 2)} ne ustreza osnova × stopnja (${fmtFixedSI(byRate, 2)}).`')
    expect(s).toContain('`Vsota vrstic (neto ${fmtFixedSI(linesNet, 2)}) se ne ujema z glavo (${fmtFixedSI(r2(Number(header.subtotal)), 2)}).`')
    expect(s).toContain('`Vsota DDV vrstic (${fmtFixedSI(linesVat, 2)}) se ne ujema z glavo (${fmtFixedSI(r2(Number(header.vatAmount)), 2)}).`')
    expect(s).not.toContain('declared.toFixed(2)')
  })

  test('ap-match.ts: fmtNumSI količine max:3 + cene max:4 + DDV max:1; fmtFixedSI zneski ×4 (ohranjena semantika)', () => {
    const s = read('src/lib/ap-match.ts')
    expect(s).toContain('`Kumulativno fakturirano (${fmtNumSI(cum, { max: 3 })}) presega naročeno (${fmtNumSI(ordered, { max: 3 })}) več kot dovoljena toleranca.`')
    expect(s).toContain('`Fakturirano (${fmtNumSI(cum, { max: 3 })}) presega dejansko sprejeto količino (${fmtNumSI(received, { max: 3 })}) — blago še ni prevzeto.`')
    expect(s).toContain('`Cena na enoto (${fmtNumSI(unitPrice, { max: 4 })}) odstopa od dogovorjene (${fmtNumSI(poPrice, { max: 4 })}).`')
    expect(s).toContain('`DDV stopnja (${fmtNumSI(vatRate, { max: 1 })} %) se ne ujema z dogovorjeno (${fmtNumSI(poVat, { max: 1 })} %).`')
    expect(s).toContain('`Znesek vrstice (${fmtFixedSI(lineTotal, 2)}) ne ustreza količini × ceni × DDV (${fmtFixedSI(recomputed, 2)}).`')
    expect(s).toContain('`Vsota vrstic (${fmtFixedSI(linesGrossSum, 2)}) se ne ujema z glavo računa (${fmtFixedSI(Math.abs(headTotal), 2)}).`')
    expect(s).not.toContain('cum.toFixed(3)')
  })

  test('furs/issue.ts: Vsota delov plačila fmtEUR ×5 (blagajna — največji zneskovni niz vala)', () => {
    const s = read('src/lib/furs/issue.ts')
    expect(s).toContain('`Vsota delov plačila (${fmtEUR(partsSum)})${redeemValue ? ` + točke (${fmtEUR(redeemValue)})` : \'\'} mora biti enaka znesku za plačanje (${fmtEUR(total)})')
    expect(s).toContain('je že bilo pobranih ${fmtEUR(linkPaidTotal)} (plačajte le preostanek)')
    expect(s).not.toContain('partsSum.toFixed(2)')
  })

  test('push.ts: AP_NEW + AP_OVERDUE telesi fmtEUR (vejica + NBSP v push obvestilu)', () => {
    const s = read('src/lib/push.ts')
    expect(s).toContain('body: `${data.apNumber} · ${data.supplierName} · ${fmtEUR(data.amount)}${due}`')
    expect(s).toContain('body: `${data.apNumber} · ${data.supplierName} · ${fmtEUR(data.amount)} · zapadlo ${days} ${dayWord}`')
    expect(s).not.toContain('data.amount.toFixed(2)} €')
  })

  test('delivery-webhook.ts: slCount postavka + fmtEUR(total) (ne »postavk« + surova Decimal interpolacija)', () => {
    const s = read('src/lib/delivery-webhook.ts')
    expect(s).toContain("${slCount(mapped.items.length, 'postavka')} · ${order.total != null ? fmtEUR(Number(order.total)) : ''}")
    expect(s).not.toContain('} postavk · ${order.total ?? \'\'} €')
  })

  test('devices/terminal.ts: AVTORIZACIJA prompt fmtEUR (ne »12.50 EUR«)', () => {
    const s = read('src/lib/devices/terminal.ts')
    expect(s).toContain('`Terminal: AVTORIZACIJA ${fmtEUR(amount)}')
    expect(s).not.toContain('AVTORIZACIJA ${amount.toFixed(2)}')
  })

  test('ap-attachments.ts: oversizeNote fmtFixedSI(mb, 1, \' MB\') — vejica v AP.zapisu', () => {
    const s = read('src/lib/ap-attachments.ts')
    expect(s).toContain('`(priloga ${fmtFixedSI(mb, 1, \' MB\')} prevelika za arhiv v nastavitvah)`')
    expect(s).not.toContain('${mb.toFixed(1)} MB')
  })

  test('reminders.ts: SMS ×2 slCount oseba v oklepajnem nominativu (»za« zahteva akuzativ — preoblikba po vzorcu v1.277 storno)', () => {
    const s = read('src/lib/reminders.ts')
    expect(s).toContain('`Potrditev: rezervacija ${t.restaurantName}, ${when} (${slCount(t.partySize, \'oseba\')}).`')
    expect(s).toContain('`Opomnik: rezervacija ${t.restaurantName}, ${when} (${slCount(t.partySize, \'oseba\')}).`')
    expect(s).not.toContain('} oseb.`')
  })

  test('stock-transfer.ts + payroll.ts: slCount meje (konstanti 50/62 — defenzivno, doktrina ena funkcija = ena oblika)', () => {
    expect(read('src/lib/stock-transfer.ts')).toContain("`Prenos lahko vsebuje največ ${slCount(TRF_MAX_LINES, 'postavka')}.`")
    expect(read('src/lib/payroll.ts')).toContain('`Obdobje je predolgo (največ ${slCount(MAX_PERIOD_DAYS, \'dan\')}).`')
  })

  test('reservation-slots.ts: slCount(maxAdvanceDays, \'dan\') — defenzivno floor kot sosednji maxDate izračun', () => {
    const s = read('src/lib/reservation-slots.ts')
    expect(s).toContain('`Rezervacije so možne največ ${slCount(Math.max(0, Math.floor(policy.maxAdvanceDays)), \'dan\')} vnaprej.`')
    expect(s).not.toContain('} dni vnaprej')
  })
})

// ── Č3) NEGATIVNI SKEN — regresijski var za prihodnje valove ──

describe('v1.278.0 Č3 — negativni sken src/lib + poštene izjeme', () => {
  function walkTs(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) out.push(...walkTs(p))
      else if (/\.ts$/.test(name)) out.push(p)
    }
    return out
  }
  const LIB = join(ROOT, 'src/lib')

  // Datoteke z DOCUMENTIRANO napiko v predlogah (allowlist — vsako novo surovo
  // toFixed v predlogi katerekoli DRUGE datoteke src/lib pada pod sken):
  const ALLOW = new Set([
    'daily-email.ts', 'hourly-email.ts', // e-poštna konvencija pika+EUR (dokumentirana namera — pin v277 Č3)
    'client.ts', // furs/client.ts + cis/client.ts — FURS/CIS XML strojne oblike (xsd:decimal)
    'index.ts', // fiscal/index.ts — ZOI/MDC podpis (strojna oblika, dot je spec)
    'settle.ts', // paylink/settle.ts details — tehnični dnevnik poravnave
    'documents.ts', // velikosti kB/MB — v1.276 ohranjena semantika (.replace(/\.0$/,''))
    'payroll.ts', 'receipt.ts', 'timeclock.ts', 'menu-dup.ts', 'confirm-banner.ts', // vejico-helperji (.replace('.',',') — pravilna oblika)
  ])

  test('0 surovih toFixed v predložnih nizih src/lib (allowlist = 10 datotek dokumentiranih izjem)', () => {
    const offenders: string[] = []
    for (const file of walkTs(LIB)) {
      const rel = file.replace(ROOT + '/', '')
      const base = rel.split('/').pop() ?? ''
      const src = readFileSync(file, 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        if (!line.includes('.toFixed(') || !line.includes('`') || !line.includes('${')) continue
        const trimmed = line.trimStart()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue // komentarji (fmt.ts dokumentacija)
        if (line.includes('console.')) continue // tehnični dnevnik (terminal.ts:55)
        if (ALLOW.has(base)) continue
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 70)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('0 trdo kodiranih množin za števnike v src/lib (»${n} postavk/računov/oseb/vrst/kos/dni«)', () => {
    const offenders: string[] = []
    const re = /\$\{[^}`]+\}\s(postavk|računov|oseb|vrst|kos|dni)(`|'|"|\s|$|\.|,)/
    for (const file of walkTs(LIB)) {
      const src = readFileSync(file, 'utf8')
      const m = src.match(re)
      if (m) offenders.push(`${file.replace(ROOT + '/', '')} → \${…} ${m[1]}`)
    }
    expect(offenders).toEqual([])
  })

  test('POŠTENE IZJEME — ostanki s piko OSTAJAJO (strojne oblike / namera, natanko naštele)', () => {
    // e-poštni sloj (dokumentirana pika+EUR — doslednost znotraj sporočila):
    expect(read('src/lib/daily-email.ts')).toContain('const eur = (v: number): string => `${(Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2)} EUR`')
    // tehnični dnevnik poravnave plačilne povezave (strojna oblika):
    expect(read('src/lib/paylink/settle.ts')).toContain('share=${share.toFixed(2)}')
    // CSV izvoz premikov (pika po računovodski konvenciji v1.276):
    expect(read('src/lib/cash-movements.ts')).toContain('num(m.amount).toFixed(2),')
    // eslog xsd:decimal (strojna oblika izvoza):
    expect(read('src/lib/eslog-export.ts')).toContain('return r2(v).toFixed(2)')
    // terminal simulator console.info (tehnični dnevnik — EUR oblika):
    expect(read('src/lib/devices/terminal.ts')).toContain('console.info(`[TERMINAL SIMULATOR] odobritev ${amount.toFixed(2)} EUR')
    // vejico-helperji (pravilna oblika — družina v1.276):
    expect(read('src/lib/receipt.ts')).toContain("const money = (n: number) => `${n.toFixed(2).replace('.', ',')} €`")
    // humanSize (DTO pomožna velikost — UI ima lastnega humanSizeUI s fmtFixedSI od v1.276; pini v203):
    expect(read('src/lib/documents.ts')).toContain("if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1).replace(/\\.0$/, '')} kB`")
  })
})

// ── Ž) REGISTRI ──

describe('v1.278.0 Ž — registri', () => {
  test('Ž1: verzija 1.278.0 (version.ts + compose + APP_VERSION)', () => {
    expect(APP_VERSION).toBe('1.298.0')
    expect(read('src/lib/version.ts')).toContain("APP_VERSION = '1.298.0'")
    expect(read('deploy/docker-compose.yml')).toContain('restaurantos:1.298.0')
  })

  test('Ž2: worklog vrh nosi Task ID tega vala', () => {
    const wl = read('worklog.md')
    expect(wl.slice(0, 400)).toContain('Task ID: v1.298.0-nadzorni-val-okenski-dvig')
  })

  test('Ž3: AUDIT doc-truth: POSODOBITEV (v1.278.0) + zgodovinska veriga (v1.277 pin ostaja)', () => {
    const audit = read('docs/RESTAURANTOS-AUDIT.md')
    expect(audit).toContain('POSODOBITEV (v1.278.0, lib nizi — zneski sl-SI + množine v src/lib)')
    expect(audit).toContain('POSODOBITEV (v1.277.0, backend nizi — zneski sl-SI + množine v api/)')
  })

  test('Ž4: i18n števci NESPREMENJENI 4320/4320 — dan je kodna tabela, 0 novih ključev', async () => {
    const { sl } = await import('../src/lib/i18n/sl')
    const { hr } = await import('../src/lib/i18n/hr')
    expect(Object.keys(sl).length).toBe(4324)
    expect(Object.keys(hr).length).toBe(4324)
  })

  test('Ž5: 0 DDL — shema nedotaknjena (čisti formatirni val, brez novih modelov)', () => {
    const schema = read('prisma/schema.prisma')
    expect(schema).not.toContain('LibNizi')
    expect(schema).not.toContain('model NounDan')
  })

  test('Ž6: fmt.ts ostaja ČISTI SLOJ (0 uvozov) + javni API re-izvozov ohranjen', () => {
    const fmt = read('src/lib/fmt.ts')
    expect(fmt).not.toMatch(/^import /m)
    expect(fmt).not.toMatch(/^} from /m)
    expect(read('src/lib/client.ts')).toContain("export { fmtEUR, fmtNumSI, fmtFixedSI, fmtStampSI } from './fmt'") // v1.279.0: pogodba razširjena (fmtStampSI — časovni žig, ista družina formatirnikov)
    expect(read('src/lib/i18n/index.ts')).toContain("export { pluralForm } from '../fmt'")
  })
})
